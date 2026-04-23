// Promise-based SFTP wrapper. Uses `ssh2-sftp-client` under the hood
// but exposes only the surface our sync jobs need:
//
//   - connect() / end()
//   - exists(), list(), mkdirp()
//   - download(), upload()          (single files, with progress)
//   - mirror()                      (recursive, with glob filtering)
//   - readFile(), writeFile()       (small utf8 payloads)
//
// Progress is reported as byte-level events so the pull/push UI can
// render a meaningful status line. Errors are normalised through
// `classifySftpError`.

import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import Ssh2SftpClient from 'ssh2-sftp-client';
import {
  RemoteError,
  SftpFailed,
  SftpNotFound,
  classifySftpError,
} from './errors';
import { GlobMatcher } from './glob';

export type SftpConnectConfig = {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: Buffer | string;
  passphrase?: string;
  readyTimeoutMs?: number;
  /** Abort a transfer if no bytes are received for this long.
   * Set to 0 to disable. Default: 120_000 (2 min). */
  stallTimeoutMs?: number;
  /** Max wall-clock time for a single metadata RPC (list/stat/mkdir/
   * exists/end). If the server stops responding between files the
   * whole mirror would otherwise hang forever. Set to 0 to disable.
   * Default: 60_000 (60 s). */
  rpcTimeoutMs?: number;
};

export type ProgressEvent = {
  /** Remote path of the file currently transferring. */
  remotePath: string;
  localPath: string;
  /** Bytes transferred since this file started. */
  bytesTransferred: number;
  /** Total size of this file, if known (may be undefined for uploads). */
  totalBytes?: number;
};

export type TransferOptions = {
  onProgress?: (e: ProgressEvent) => void;
};

export type MirrorOptions = TransferOptions & {
  /** Glob patterns relative to `remotePath`, POSIX-style. */
  include?: string[];
  exclude?: string[];
  /** Called once per transferred file, after the transfer finishes. */
  onFile?: (remotePath: string, localPath: string) => void;
};

export type RemoteEntry = {
  name: string;
  type: 'file' | 'directory' | 'link' | 'other';
  size: number;
  modifyTime: number;
};

/** Small surface of ssh2-sftp-client we depend on. Simplifies
 * mocking in unit tests. */
export interface Ssh2SftpClientLike {
  connect(config: Record<string, unknown>): Promise<unknown>;
  end(): Promise<void>;
  exists(remotePath: string): Promise<false | 'd' | '-' | 'l'>;
  list(remotePath: string): Promise<Array<{ name: string; type: string; size: number; modifyTime: number }>>;
  mkdir(remotePath: string, recursive?: boolean): Promise<string>;
  stat(remotePath: string): Promise<{ size: number; modifyTime: number; isDirectory: boolean; isFile: boolean }>;
  get(remotePath: string, localPath: string | NodeJS.WritableStream): Promise<unknown>;
  put(local: string | NodeJS.ReadableStream | Buffer, remotePath: string): Promise<unknown>;
  on(event: string, cb: (...args: unknown[]) => void): this;
  off?(event: string, cb: (...args: unknown[]) => void): this;
}

export type SftpClientOptions = {
  /** Inject a client factory for tests. */
  clientFactory?: () => Ssh2SftpClientLike;
};

const DEFAULT_READY_TIMEOUT = 20_000;
const DEFAULT_STALL_TIMEOUT = 120_000;
const DEFAULT_RPC_TIMEOUT = 60_000;

export class SftpClient {
  private readonly config: SftpConnectConfig;
  private readonly makeClient: () => Ssh2SftpClientLike;
  private readonly stallTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private client: Ssh2SftpClientLike | undefined;
  private ready = false;

  constructor(config: SftpConnectConfig, opts: SftpClientOptions = {}) {
    this.config = config;
    this.stallTimeoutMs = config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT;
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT;
    this.makeClient =
      opts.clientFactory ??
      (() => new Ssh2SftpClient() as unknown as Ssh2SftpClientLike);
  }

  /** Race a pending ssh2-sftp-client RPC against a timeout. When the
   * remote end stops answering between files (common against rate-
   * limited shared hosts), the underlying library will wait forever;
   * this guard makes the call fail fast so the whole job doesn't hang
   * at an arbitrary file boundary. */
  private withRpcTimeout<T>(op: string, p: Promise<T>): Promise<T> {
    const ms = this.rpcTimeoutMs;
    if (ms <= 0) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new RemoteError('SFTP_FAILED', `SFTP ${op} timed out after ${Math.round(ms / 1000)}s`, {
            retriable: true,
            detail: { op, timeoutMs: ms },
          }),
        );
      }, ms);
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  get connected(): boolean {
    return this.ready;
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    const client = this.makeClient();
    this.client = client;
    try {
      await client.connect({
        host: this.config.host,
        port: this.config.port ?? 22,
        username: this.config.username,
        ...(this.config.password ? { password: this.config.password } : {}),
        ...(this.config.privateKey ? { privateKey: this.config.privateKey } : {}),
        ...(this.config.passphrase ? { passphrase: this.config.passphrase } : {}),
        readyTimeout: this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT,
      });
      this.ready = true;
    } catch (err) {
      this.client = undefined;
      throw classifySftpError('connect', err);
    }
  }

  async end(): Promise<void> {
    if (!this.client) return;
    try {
      await this.withRpcTimeout('end', this.client.end());
    } catch {
      /* best-effort — we still drop our handle below */
    }
    this.client = undefined;
    this.ready = false;
  }

  private require(): Ssh2SftpClientLike {
    if (!this.client || !this.ready) {
      throw SftpFailed('connect', new Error('SftpClient used before connect().'));
    }
    return this.client;
  }

  async exists(remotePath: string): Promise<false | 'd' | '-' | 'l'> {
    try {
      return await this.withRpcTimeout('exists', this.require().exists(remotePath));
    } catch (err) {
      throw classifySftpError('exists', err);
    }
  }

  async list(remotePath: string): Promise<RemoteEntry[]> {
    try {
      const raw = await this.withRpcTimeout('list', this.require().list(remotePath));
      return raw.map((e) => ({
        name: e.name,
        type: mapType(e.type),
        size: e.size,
        modifyTime: e.modifyTime,
      }));
    } catch (err) {
      throw classifySftpError('list', err);
    }
  }

  async mkdirp(remotePath: string): Promise<void> {
    try {
      await this.withRpcTimeout('mkdir', this.require().mkdir(remotePath, true));
    } catch (err) {
      throw classifySftpError('mkdir', err);
    }
  }

  async stat(remotePath: string): Promise<{ size: number; modifyTime: number; isDirectory: boolean; isFile: boolean }> {
    try {
      return await this.withRpcTimeout('stat', this.require().stat(remotePath));
    } catch (err) {
      throw classifySftpError('stat', err);
    }
  }

  /** Download a single file. Emits byte-level progress. */
  async download(
    remotePath: string,
    localPath: string,
    opts: TransferOptions = {},
  ): Promise<void> {
    const client = this.require();
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

    let total: number | undefined;
    try {
      const st = await this.withRpcTimeout('stat', client.stat(remotePath));
      total = st.size;
    } catch (err) {
      throw classifySftpError('download', err);
    }

    const writeStream = fs.createWriteStream(localPath);

    // Progress + stall detection via writeStream.bytesWritten polling.
    // This is far more reliable than ssh2-sftp-client's 'download'
    // event which silently fails to fire on many server/version combos
    // (path resolution mismatches, event not wired, etc.).
    let lastBytesWritten = 0;
    let lastProgressAt = Date.now();
    let stallReason: string | undefined;
    const stallMs = this.stallTimeoutMs;
    const POLL_MS = 3_000;

    opts.onProgress?.({ remotePath, localPath, bytesTransferred: 0, totalBytes: total });

    const pollTimer =
      stallMs > 0
        ? setInterval(() => {
            const current = writeStream.bytesWritten;
            if (current > lastBytesWritten) {
              lastBytesWritten = current;
              lastProgressAt = Date.now();
              opts.onProgress?.({
                remotePath,
                localPath,
                bytesTransferred: current,
                totalBytes: total,
              });
            } else if (Date.now() - lastProgressAt >= stallMs) {
              stallReason = `SFTP transfer stalled (no bytes for ${Math.round(stallMs / 1000)}s): ${remotePath}`;
              clearInterval(pollTimer as NodeJS.Timeout);
              writeStream.destroy(new Error(stallReason));
              setTimeout(() => {
                if (this.client) {
                  this.ready = false;
                  this.client.end().catch(() => undefined);
                }
              }, 10_000).unref?.();
            }
          }, POLL_MS)
        : undefined;

    try {
      await client.get(remotePath, writeStream);
      const finalBytes = writeStream.bytesWritten;
      opts.onProgress?.({
        remotePath,
        localPath,
        bytesTransferred: total ?? finalBytes,
        totalBytes: total,
      });
    } catch (err) {
      if (stallReason) {
        throw new RemoteError('SFTP_FAILED', stallReason, {
          retriable: true,
          detail: { remotePath, bytesTransferred: writeStream.bytesWritten, totalBytes: total },
        });
      }
      throw classifySftpError('download', err);
    } finally {
      if (pollTimer) clearInterval(pollTimer);
    }
  }

  /** Upload a single local file. Uses a read-stream with bytesRead
   * polling for progress — the ssh2-sftp-client `'upload'` event is
   * unreliable on many Cloudways server configurations. When all bytes
   * have been read and `put()` still hasn't resolved after a grace
   * period, we treat the upload as complete (the underlying stream
   * 'close' event sometimes never fires). */
  async upload(
    localPath: string,
    remotePath: string,
    opts: TransferOptions = {},
  ): Promise<void> {
    const client = this.require();
    let total: number;
    try {
      const st = await fs.promises.stat(localPath);
      total = st.size;
    } catch {
      throw SftpNotFound(localPath);
    }

    // Ensure remote directory exists.
    const remoteDir = posixDirname(remotePath);
    if (remoteDir && remoteDir !== '.') {
      try {
        await client.mkdir(remoteDir, true);
      } catch {
        /* best-effort */
      }
    }

    opts.onProgress?.({ remotePath, localPath, bytesTransferred: 0, totalBytes: total });

    const readStream = fs.createReadStream(localPath);
    let lastBytesRead = 0;
    let lastProgressAt = Date.now();
    let stallReason: string | undefined;
    const stallMs = this.stallTimeoutMs;
    const POLL_MS = 3_000;
    // Grace period after all bytes read before we force-resolve.
    const DONE_GRACE_MS = 30_000;
    let doneAt: number | undefined;
    let forceResolve: (() => void) | undefined;

    const pollTimer = setInterval(() => {
      const current = readStream.bytesRead;
      if (current > lastBytesRead) {
        lastBytesRead = current;
        lastProgressAt = Date.now();
        opts.onProgress?.({
          remotePath,
          localPath,
          bytesTransferred: current,
          totalBytes: total,
        });
      }

      // All bytes have been read from the local file
      if (current >= total) {
        if (!doneAt) doneAt = Date.now();
        // If put() still hasn't resolved after grace period, force-resolve
        if (Date.now() - doneAt >= DONE_GRACE_MS) {
          clearInterval(pollTimer);
          forceResolve?.();
          return;
        }
      } else if (stallMs > 0 && Date.now() - lastProgressAt >= stallMs) {
        // No progress at all for stallMs
        stallReason = `SFTP upload stalled (no bytes for ${Math.round(stallMs / 1000)}s): ${remotePath}`;
        clearInterval(pollTimer);
        readStream.destroy(new Error(stallReason));
      }
    }, POLL_MS);

    try {
      await Promise.race([
        client.put(readStream as unknown as NodeJS.ReadableStream, remotePath),
        new Promise<void>((resolve) => { forceResolve = resolve; }),
      ]);
      opts.onProgress?.({
        remotePath,
        localPath,
        bytesTransferred: total,
        totalBytes: total,
      });
    } catch (err) {
      if (stallReason) {
        throw new RemoteError('SFTP_FAILED', stallReason, {
          retriable: true,
          detail: { remotePath, bytesTransferred: readStream.bytesRead, totalBytes: total },
        });
      }
      throw classifySftpError('upload', err);
    } finally {
      clearInterval(pollTimer);
    }
  }

  /** Recursively download `remotePath` into `localPath`, filtering by
   * glob include/exclude relative to the source root. Creates local
   * directories as needed. */
  async mirror(
    remotePath: string,
    localPath: string,
    opts: MirrorOptions = {},
  ): Promise<void> {
    const matcher = new GlobMatcher(opts.include, opts.exclude);
    await fs.promises.mkdir(localPath, { recursive: true });
    await this.walkAndTransfer(remotePath, localPath, '', matcher, opts);
  }

  private async walkAndTransfer(
    remoteRoot: string,
    localRoot: string,
    rel: string,
    matcher: GlobMatcher,
    opts: MirrorOptions,
  ): Promise<void> {
    const here = rel ? posixJoin(remoteRoot, rel) : remoteRoot;
    let entries: RemoteEntry[];
    try {
      entries = await this.list(here);
    } catch (err) {
      if (err instanceof RemoteError && err.code === 'SFTP_NOT_FOUND') return;
      throw err;
    }

    for (const entry of entries) {
      const childRel = rel ? posixJoin(rel, entry.name) : entry.name;
      const remoteChild = posixJoin(remoteRoot, childRel);
      const localChild = path.join(localRoot, childRel);

      if (entry.type === 'directory') {
        if (!matcher.shouldDescend(childRel + '/')) continue;
        await fs.promises.mkdir(localChild, { recursive: true });
        await this.walkAndTransfer(remoteRoot, localRoot, childRel, matcher, opts);
      } else if (entry.type === 'file') {
        if (!matcher.match(childRel)) continue;
        await this.download(remoteChild, localChild, {
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        });
        opts.onFile?.(remoteChild, localChild);
      }
      // Symlinks / others: skip silently.
    }
  }

  /** Read a small remote file as a utf8 string. */
  async readFile(remotePath: string): Promise<string> {
    const client = this.require();
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk: Buffer, _enc, cb): void {
        chunks.push(chunk);
        cb();
      },
    });
    try {
      await client.get(remotePath, writable);
    } catch (err) {
      throw classifySftpError('readFile', err);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

function mapType(t: string): RemoteEntry['type'] {
  if (t === 'd' || t === 'directory') return 'directory';
  if (t === '-' || t === 'file') return 'file';
  if (t === 'l' || t === 'link') return 'link';
  return 'other';
}

function posixJoin(...parts: string[]): string {
  const out = parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/+/g, '/');
  return out;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '';
  return p.slice(0, i);
}
