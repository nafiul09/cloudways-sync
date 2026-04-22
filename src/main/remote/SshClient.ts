// Thin, promise-based wrapper around node-ssh2's `Client`.
//
// Owns exactly one underlying ssh2.Client. Consumers get:
//   - `connect()` — resolves once the server emits `ready`.
//   - `exec(command)` — runs one command, captures stdout / stderr,
//     resolves to `{ code, stdout, stderr }`.
//   - `end()` — closes the socket; safe to call twice.
//
// Errors are normalized through `classifySshError` so callers can
// match on `RemoteError.code` without depending on ssh2 internals.

import { Client as Ssh2Client, type ConnectConfig as Ssh2Config } from 'ssh2';
import {
  RemoteError,
  SshClosed,
  SshCommandFailed,
  SshTimeout,
  classifySshError,
} from './errors';

export type SshConnectConfig = {
  host: string;
  port?: number;
  username: string;
  /** Password-auth. One of password / privateKey is required. */
  password?: string;
  /** PEM-encoded private key, optionally with passphrase. */
  privateKey?: Buffer | string;
  passphrase?: string;
  /** Handshake timeout (default 20s). */
  readyTimeoutMs?: number;
  /** TCP keepalive interval to keep long-running SFTP jobs alive (default 10s). */
  keepaliveIntervalMs?: number;
};

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ExecOptions = {
  /** Cap on captured stdout+stderr, in bytes. Default 8 MiB. */
  maxBuffer?: number;
  /** Per-command timeout. Default none. */
  timeoutMs?: number;
  /** Optional stdin payload. */
  stdin?: string | Buffer;
};

export type SshClientOptions = {
  /** Inject a Client factory for tests. Defaults to real ssh2 Client. */
  clientFactory?: () => Ssh2ClientLike;
};

/** Subset of ssh2.Client we actually use. Simplifies mocking. */
export interface Ssh2ClientLike {
  on(event: 'ready', cb: () => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  on(event: 'close', cb: () => void): this;
  on(event: 'end', cb: () => void): this;
  connect(config: Ssh2Config): this;
  end(): this;
  exec(
    command: string,
    cb: (
      err: Error | undefined,
      channel: Ssh2ChannelLike,
    ) => void,
  ): boolean;
  destroy?(): this;
}

export interface Ssh2ChannelStderr {
  on(event: 'data', cb: (chunk: Buffer) => void): Ssh2ChannelStderr;
}

export interface Ssh2ChannelLike {
  on(event: 'close', cb: (code: number | null, signal?: string) => void): this;
  on(event: 'data', cb: (chunk: Buffer) => void): this;
  stderr: Ssh2ChannelStderr;
  end(data?: string | Buffer): this;
}

const DEFAULT_READY_TIMEOUT = 20_000;
const DEFAULT_KEEPALIVE = 10_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024; // 8 MiB

export class SshClient {
  private readonly config: SshConnectConfig;
  private readonly makeClient: () => Ssh2ClientLike;
  private client: Ssh2ClientLike | undefined;
  private ready = false;
  private ending = false;
  private pendingReady?: Promise<void>;

  constructor(config: SshConnectConfig, opts: SshClientOptions = {}) {
    this.config = config;
    this.makeClient = opts.clientFactory ?? (() => new Ssh2Client() as unknown as Ssh2ClientLike);
  }

  get connected(): boolean {
    return this.ready && !this.ending;
  }

  /** Open the SSH connection. Idempotent: returns the in-flight
   * promise if called twice before `ready`. */
  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.pendingReady) return this.pendingReady;

    const readyTimeout = this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT;
    const client = this.makeClient();
    this.client = client;

    this.pendingReady = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.destroy?.() ?? client.end();
        } catch {
          /* ignore */
        }
        reject(SshTimeout(readyTimeout));
      }, readyTimeout);

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        resolve();
      });
      client.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = false;
        reject(classifySshError(err));
      });
      client.on('close', () => {
        this.ready = false;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(SshClosed());
        }
      });

      try {
        const ssh2Config: Ssh2Config = {
          host: this.config.host,
          port: this.config.port ?? 22,
          username: this.config.username,
          readyTimeout,
          keepaliveInterval:
            this.config.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE,
        };
        if (this.config.password) ssh2Config.password = this.config.password;
        if (this.config.privateKey) ssh2Config.privateKey = this.config.privateKey;
        if (this.config.passphrase) ssh2Config.passphrase = this.config.passphrase;
        client.connect(ssh2Config);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(classifySshError(err));
      }
    }).finally(() => {
      this.pendingReady = undefined;
    });

    return this.pendingReady;
  }

  /** Run one command; resolves to `{ code, stdout, stderr }`.
   * Throws `SshCommandFailed` only if `throwOnNonZero` is true. */
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.ready || !this.client) {
      throw SshClosed('SshClient.exec called before connect().');
    }
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const timeoutMs = opts.timeoutMs;
    const client = this.client;

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(
              new RemoteError('SSH_TIMEOUT', `Command timed out after ${timeoutMs}ms.`, {
                retriable: true,
                detail: { command, timeoutMs },
              }),
            );
          }, timeoutMs)
        : undefined;

      const done = (result: ExecResult | Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      const ok = client.exec(command, (err, channel) => {
        if (err) {
          done(classifySshError(err));
          return;
        }

        let stdoutLen = 0;
        let stderrLen = 0;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let overflowed = false;

        const pushChunk = (target: Buffer[], chunk: Buffer, isStdout: boolean) => {
          if (overflowed) return;
          const newLen = (isStdout ? stdoutLen : stderrLen) + chunk.length;
          if (stdoutLen + stderrLen + chunk.length > maxBuffer) {
            overflowed = true;
            done(
              new RemoteError(
                'SSH_COMMAND_FAILED',
                `Command output exceeded maxBuffer (${maxBuffer} bytes).`,
                { retriable: false, detail: { command, maxBuffer } },
              ),
            );
            return;
          }
          target.push(chunk);
          if (isStdout) stdoutLen = newLen;
          else stderrLen = newLen;
        };

        channel.on('data', (chunk: Buffer) => pushChunk(stdoutChunks, chunk, true));
        channel.stderr.on('data', (chunk: Buffer) => pushChunk(stderrChunks, chunk, false));
        channel.on('close', (code: number | null) => {
          if (overflowed) return;
          done({
            code: code ?? 0,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
          });
        });

        if (opts.stdin != null) {
          channel.end(opts.stdin);
        }
      });
      if (!ok) {
        // Backpressure — treat as transient network issue.
        done(classifySshError(new Error('ssh2 exec returned false (backpressure).')));
      }
    });
  }

  /** Convenience: run a command, throw if exit code is non-zero. */
  async execOrThrow(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const res = await this.exec(command, opts);
    if (res.code !== 0) throw SshCommandFailed(command, res.code, res.stderr);
    return res;
  }

  /** Close the connection. Idempotent. */
  async end(): Promise<void> {
    if (!this.client || this.ending) {
      this.ready = false;
      return;
    }
    this.ending = true;
    const client = this.client;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      client.on('close', done);
      client.on('end', done);
      try {
        client.end();
      } catch {
        done();
      }
      // Safety net: don't hang forever if server never ACKs.
      setTimeout(done, 2_000);
    });

    this.ready = false;
    this.ending = false;
    this.client = undefined;
  }
}
