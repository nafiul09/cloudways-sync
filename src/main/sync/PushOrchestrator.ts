import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CloudwaysError } from '../cloudways/errors';
import { RemoteError } from '../remote/errors';
import { SftpClient, type SftpConnectConfig } from '../remote/SftpClient';
import { SshClient, type SshConnectConfig } from '../remote/SshClient';
import {
  buildWpCommand,
  detectBreezePlugin,
  shellQuote,
  wpCli,
  wpOptionGet,
} from '../remote/wpCli';
import type {
  JobProgressEvent,
  RunJobResponse,
  UndoRecord,
  UndoSnapshot,
} from '../../shared/ipcTypes';
import { selectedWpContentSubdirs, shouldSkipPushStep, tarExcludePatternsForIncludes } from './Selective';
import { pruneRemoteSnapshots, sweepLocalSnapshots, sweepRemoteTempFiles, sweepStaleJobs } from './cleanup';
import type { PullMetadata, PushPlan } from './types';
import type { UndoLedger } from './UndoLedger';
import type { AppLink } from './AppLink';
import { resolvePath, gzipFile, createTarGz } from './pathUtil';

const execFileAsync = promisify(execFile);

export type ExecLocalFn = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

/** Dump a Local site's database to the given path using Local's bundled MySQL. */
export type LocalDbDumpFn = (localSiteId: string, destination: string) => Promise<string>;

export type PushOrchestratorOptions = {
  /**
   * Adapter that hides API vs SFTP differences. The orchestrator
   * never touches ApiClient / AppPasswordStore / SftpCredentialStore
   * directly — it asks the link for SSH connection details and (when
   * available) API-only conveniences like remote backups.
   */
  link: AppLink;
  undoLedger: UndoLedger;
  userDataDir: string;
  sshFactory?: (config: SshConnectConfig) => SshClient;
  sftpFactory?: (config: SftpConnectConfig) => SftpClient;
  /** Override for local shell commands (tar, gzip). Defaults to execFile. */
  execLocal?: ExecLocalFn;
  /** Dump a Local site's DB via Local's SiteDatabase service. */
  localDbDump?: LocalDbDumpFn;
  emitProgress?: (event: JobProgressEvent) => void;
  isCancelled?: (jobId: string) => boolean;
};

const defaultExecLocal: ExecLocalFn = async (cmd, args, opts) => {
  return execFileAsync(cmd, args, { timeout: opts?.timeout });
};

export class PushOrchestrator {
  private readonly link: AppLink;
  private readonly undoLedger: UndoLedger;
  private readonly userDataDir: string;
  private readonly sshFactory: (config: SshConnectConfig) => SshClient;
  private readonly sftpFactory: (config: SftpConnectConfig) => SftpClient;
  private readonly execLocal: ExecLocalFn;
  private readonly localDbDump?: LocalDbDumpFn;
  private readonly emitProgress?: (event: JobProgressEvent) => void;
  private readonly isCancelled?: (jobId: string) => boolean;

  constructor(opts: PushOrchestratorOptions) {
    this.link = opts.link;
    this.undoLedger = opts.undoLedger;
    this.userDataDir = opts.userDataDir;
    this.sshFactory = opts.sshFactory ?? ((config) => new SshClient(config));
    this.sftpFactory = opts.sftpFactory ?? ((config) => new SftpClient(config));
    this.execLocal = opts.execLocal ?? defaultExecLocal;
    this.localDbDump = opts.localDbDump;
    this.emitProgress = opts.emitProgress;
    this.isCancelled = opts.isCancelled;
  }

  async run(plan: PushPlan): Promise<RunJobResponse> {
    const jobId = `job_${plan.id}`;
    const jobDir = path.join(this.userDataDir, 'cloudwayssync', 'jobs', jobId);
    const stagingDir = path.join(jobDir, 'staging');
    const localSqlGz = path.join(stagingDir, `cws-${jobId}.sql.gz`);
    const localContentTarGz = path.join(stagingDir, `cws-${jobId}-wpcontent.tar.gz`);
    let remoteSqlGz: string | undefined;
    let remoteSql: string | undefined;
    let remoteContentTarGz: string | undefined;
    let snapshot: UndoSnapshot | undefined;

    await fs.promises.mkdir(stagingDir, { recursive: true });

    let ssh: SshClient | undefined;
    let sftp: SftpClient | undefined;
    try {
      this.assertNotCancelled(jobId);

      // Step 1: Validate the remote app
      const ctx = await this.step(jobId, 'validate', async () => {
        const resolved = await this.link.resolve();
        if (resolved.api && !resolved.api.app.application.toLowerCase().includes('wordpress')) {
          throw new RemoteError('SSH_COMMAND_FAILED', 'Only WordPress apps can be pushed to.', {
            retriable: false,
            detail: { application: resolved.api.app.application },
          });
        }
        // Verify local webroot exists (expand ~ for Windows compatibility)
        const resolvedWebRoot = resolvePath(plan.webRootPath);
        const webRootStat = await fs.promises.stat(resolvedWebRoot).catch(() => null);
        if (!webRootStat?.isDirectory()) {
          throw new RemoteError('SSH_COMMAND_FAILED', `Local web root not found: ${resolvedWebRoot}`, {
            retriable: false,
          });
        }
        return resolved;
      });

      const appPublicPath = ctx.webRoot;
      const appRootPath = appPublicPath.endsWith('/public_html')
        ? appPublicPath.slice(0, -'/public_html'.length)
        : path.posix.dirname(appPublicPath);
      remoteSql = `${appRootPath}/private_html/cws-${jobId}.sql`;
      remoteSqlGz = `${remoteSql}.gz`;
      const sftpSqlGz = relativeToHome(remoteSqlGz);
      remoteContentTarGz = `${appRootPath}/private_html/cws-${jobId}-wpcontent.tar.gz`;
      const sftpContentTarGz = relativeToHome(remoteContentTarGz);

      // Step 3: SSH connect (early — we need it for either backup path)
      ssh = this.sshFactory(ctx.auth);
      sftp = this.sftpFactory(ctx.auth);
      await this.step(jobId, 'ssh', async () => {
        await ssh?.connect();
      });

      // Housekeeping: clean orphaned temp files from previous crashed
      // runs and prune old snapshots (remote + local).
      await Promise.all([
        sweepRemoteTempFiles(ssh, appRootPath),
        pruneRemoteSnapshots(ssh, appRootPath),
        sweepLocalSnapshots(this.userDataDir),
      ]);

      // Step 2: Backup. API mode triggers a Cloudways backup; SFTP
      // mode falls back to a local-tar snapshot on the server (and
      // optionally pulled into userDataDir as a safety mirror).
      await this.step(jobId, 'remote-backup', async () => {
        if (this.link.triggerRemoteBackup) {
          await this.runApiBackup(jobId);
          return;
        }
        snapshot = await this.captureLocalSnapshot({
          jobId,
          ssh: ssh as SshClient,
          sftp,
          appPublicPath,
          appRootPath,
          plan,
        });
      });

      // Step 4: Collect remote metadata (we need the remote URL for search-replace)
      const metadata = await this.step(jobId, 'metadata', async () =>
        collectMetadata(ssh as SshClient, appPublicPath),
      );
      if (metadata.isMultisite) {
        throw new RemoteError('SSH_COMMAND_FAILED', 'WordPress multisite is not supported in v1.', {
          retriable: false,
          detail: metadata,
        });
      }

      // Step 5: Export local DB
      if (shouldSkipPushStep('local-export-db', plan.includes)) {
        this.progress(jobId, 'local-export-db', 'skipped');
      } else {
        await this.step(jobId, 'local-export-db', async () => {
          this.progress(jobId, 'local-export-db', 'running', 'Exporting local database…');
          const localSql = path.join(stagingDir, `cws-${jobId}.sql`);
          if (this.localDbDump && plan.localSiteId) {
            // Use Local's SiteDatabase.dump which handles the site's MySQL socket/port
            await this.localDbDump(plan.localSiteId, localSql);
          } else {
            // Fallback: bare wp-cli (requires php on PATH)
            await this.execLocal('wp', [
              'db', 'export', localSql,
              '--add-drop-table',
              `--path=${resolvePath(plan.webRootPath)}`,
            ], { timeout: 10 * 60 * 1000 });
          }
          // Gzip locally (using Node.js zlib — no system gzip needed)
          await gzipFile(localSql);
        });
      }

      // Step 6: Upload DB dump
      if (shouldSkipPushStep('upload-db', plan.includes)) {
        this.progress(jobId, 'upload-db', 'skipped');
      } else {
        await this.step(jobId, 'upload-db', async () => {
          await sftp?.connect();
          this.progress(jobId, 'upload-db', 'running', 'Uploading database dump…');
          await this.runWithIdleWatchdog(sftp, 'upload-db', (mark) =>
            sftp!.upload(localSqlGz, sftpSqlGz, {
              onProgress: (e) => {
                mark();
                this.progress(jobId, 'upload-db', 'running', 'Uploading database dump…', e.bytesTransferred, e.totalBytes);
              },
            }),
          );
        });
      }

      // Step 7: Upload wp-content archive
      if (shouldSkipPushStep('upload-content', plan.includes)) {
        this.progress(jobId, 'upload-content', 'skipped');
      } else {
        await this.step(jobId, 'upload-content', async () => {
          // Create local archive of wp-content (using Node.js tar — no system tar needed)
          this.progress(jobId, 'upload-content', 'running', 'Archiving local wp-content…');
          const resolvedWebRootForTar = resolvePath(plan.webRootPath);
          await createTarGz(
            localContentTarGz,
            resolvedWebRootForTar,
            ['wp-content'],
            tarExcludePatternsForIncludes(plan.includes),
          );

          // Reconnect SFTP (may have gone stale during local archiving)
          await sftp?.end();
          await sftp?.connect();

          this.progress(jobId, 'upload-content', 'running', 'Uploading wp-content archive…');
          await this.runWithIdleWatchdog(sftp, 'upload-content', (mark) =>
            sftp!.upload(localContentTarGz, sftpContentTarGz, {
              onProgress: (e) => {
                mark();
                this.progress(jobId, 'upload-content', 'running', 'Uploading wp-content archive…', e.bytesTransferred, e.totalBytes);
              },
            }),
          );

          // Replace ONLY the selected wp-content subdirs on the remote.
          // Without this step, tar-extract just overlays files, so any
          // files the user deleted locally (e.g. an uninstalled plugin)
          // would linger on the remote. Unselected subdirs (uploads,
          // languages, etc. that the user didn't tick) remain untouched.
          const subdirs = selectedWpContentSubdirs(plan.includes);
          if (subdirs.length > 0) {
            const remoteWpContent = `${appPublicPath}/wp-content`;
            const rmCmd = subdirs
              .map((sub) => `rm -rf ${shellQuote(`${remoteWpContent}/${sub}`)}`)
              .join(' && ');
            this.progress(jobId, 'upload-content', 'running', 'Clearing selected wp-content subdirs on server…');
            await execChecked(ssh as SshClient, rmCmd);
          }

          // Extract archive — recreates the selected subdirs we just removed.
          this.progress(jobId, 'upload-content', 'running', 'Extracting archive on server…');
          await execChecked(
            ssh as SshClient,
            `tar xzf ${shellQuote(remoteContentTarGz as string)} -C ${shellQuote(appPublicPath)}`,
          );
        });
      }

      // Step 8: Import DB on server
      if (shouldSkipPushStep('remote-db-import', plan.includes)) {
        this.progress(jobId, 'remote-db-import', 'skipped');
      } else {
        await this.step(jobId, 'remote-db-import', async () => {
          // Gunzip the DB dump on the server
          this.progress(jobId, 'remote-db-import', 'running', 'Decompressing database on server…');
          await execChecked(ssh as SshClient, `gzip -df ${shellQuote(remoteSqlGz as string)}`);

          // Drop all existing tables before import. Without this, tables
          // from a previous site that don't exist in the local export
          // survive the import and leave stale URLs in the database.
          this.progress(jobId, 'remote-db-import', 'running', 'Resetting remote database…');
          await wpCli({ ssh: ssh as SshClient, appPublicPath }, [
            'db', 'reset', '--yes',
            '--skip-plugins', '--skip-themes',
          ], { timeoutMs: 2 * 60 * 1000 });

          // Import via wp db import
          this.progress(jobId, 'remote-db-import', 'running', 'Importing database…');
          await wpCli({ ssh: ssh as SshClient, appPublicPath }, [
            'db', 'import', remoteSql as string,
            '--skip-plugins', '--skip-themes',
          ], { timeoutMs: 10 * 60 * 1000 });
        });
      }

      // Step 9: Search-replace URLs on the remote
      if (shouldSkipPushStep('search-replace', plan.includes)) {
        this.progress(jobId, 'search-replace', 'skipped');
      } else {
        await this.step(jobId, 'search-replace', async () => {
          const wpCtx = { ssh: ssh as SshClient, appPublicPath };
          const srOpts = { timeoutMs: 10 * 60 * 1000 };

          // Use the mapping's remote URL (known-good) instead of reading
          // from the remote DB, which may already be corrupted from a
          // previous failed push.
          const targetUrl = ctx.remoteUrl || metadata.homeUrl;

          console.log('[CWS Push] search-replace: localUrl=%s → targetUrl=%s (mapping=%s, dbHome=%s)',
            plan.localUrl, targetUrl, ctx.remoteUrl, metadata.homeUrl);

          // Primary search-replace
          const primary = await wpCli(wpCtx, [
            'search-replace',
            plan.localUrl,
            targetUrl,
            '--all-tables',
            '--skip-columns=guid',
            '--skip-plugins', '--skip-themes',
          ], srOpts);
          console.log('[CWS Push] primary search-replace stdout: %s', primary.stdout.trim());

          // Protocol-flipped pass (http↔https) to catch mixed references
          const flipped = flipProtocol(plan.localUrl);
          if (flipped !== plan.localUrl) {
            const variant = await wpCli(wpCtx, [
              'search-replace',
              flipped,
              targetUrl,
              '--all-tables',
              '--skip-columns=guid',
              '--skip-plugins', '--skip-themes',
            ], srOpts);
            console.log('[CWS Push] flipped search-replace (%s) stdout: %s', flipped, variant.stdout.trim());
          }

          // Direct SQL safety net: force home and siteurl via raw SQL.
          // This bypasses wp-cli bootstrapping issues and guarantees the
          // two most critical options are always correct.
          const sqlUpdate = `UPDATE wp_options SET option_value = '${targetUrl.replace(/'/g, "\\'")}' WHERE option_name IN ('home', 'siteurl');`;
          console.log('[CWS Push] SQL safety net: %s', sqlUpdate);
          await wpCli(wpCtx, ['db', 'query', sqlUpdate, '--skip-plugins', '--skip-themes']);
        });
      }

      // Step 10: Re-activate Breeze BEFORE cache flush so its purge
      // commands are available (DB import leaves it deactivated).
      if (plan.reactivateBreeze) {
        await this.step(jobId, 'breeze-reactivate', async () => {
          await wpCli({ ssh: ssh as SshClient, appPublicPath }, ['plugin', 'activate', 'breeze']);
        });
      } else {
        this.progress(jobId, 'breeze-reactivate', 'skipped');
      }

      // Step 11: Flush caches
      await this.step(jobId, 'cache-flush', async () => {
        const wpCtx = { ssh: ssh as SshClient, appPublicPath };
        // WP object cache + rewrite flush
        await wpCli(wpCtx, ['cache', 'flush', '--skip-plugins', '--skip-themes']).catch(() => undefined);
        await wpCli(wpCtx, ['rewrite', 'flush', '--skip-plugins', '--skip-themes']).catch(() => undefined);
        // Varnish purge via Cloudways API (API mode only).
        await this.link.purgeVarnish?.().catch(() => undefined);
        // Breeze: purge Varnish + file-based page cache.
        // Breeze is now active (reactivated above), so these commands work.
        await wpCli(wpCtx, ['breeze', 'purge', '--varnish', '--skip-themes']).catch(() => undefined);
        await wpCli(wpCtx, ['breeze', 'purge', '--cache', '--skip-themes']).catch(() => undefined);
        // Direct varnish-admin purge (works even without Breeze).
        await (ssh as SshClient).exec('curl -s -X PURGE http://127.0.0.1/.*').catch(() => undefined);
        // Remove Breeze file cache directory as a final safety net.
        await (ssh as SshClient).exec(
          `rm -rf ${shellQuote(appPublicPath + '/wp-content/cache/breeze')}`,
        ).catch(() => undefined);
      });

      // Step 12: Cleanup remote temp files (snapshot files are kept
      // for undo — they're cleaned only after the user confirms).
      await this.step(jobId, 'cleanup', async () => {
        await cleanupRemote(ssh, remoteSql, remoteSqlGz, remoteContentTarGz);
      });

      // Record undo entry
      const undoRecord: UndoRecord = {
        id: `undo_${plan.id}`,
        jobId,
        linkMode: this.link.mode,
        localSiteId: plan.localSiteId,
        appLabel: this.link.mapping.appLabel,
        sourceUrl: plan.localUrl,
        targetUrl: metadata.homeUrl,
        createdAt: new Date().toISOString(),
        ...(ctx.api ? { serverId: ctx.api.server.id, appId: ctx.api.app.id } : {}),
        ...(snapshot ? { snapshot } : {}),
      };
      await this.undoLedger.add(undoRecord);

      return {
        jobId,
        status: 'success',
      };
    } finally {
      // Clean remote work-in-progress temp files (snapshot files are
      // intentionally kept for undo). This duplicates step 11 on the
      // success path but is the safety net for crashes / errors that
      // skip that step.
      await cleanupRemote(ssh, remoteSql, remoteSqlGz, remoteContentTarGz);
      await sftp?.end();
      await ssh?.end();
      // Clean up local staging — no reason to keep exported archives
      await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
      // Sweep stale job dirs left by previous runs that didn't clean up
      await sweepStaleJobs(this.userDataDir).catch(() => undefined);
    }
  }

  private async runApiBackup(jobId: string): Promise<void> {
    const trigger = this.link.triggerRemoteBackup;
    if (!trigger) return;
    const MAX_BACKUP_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 15_000;
    for (let attempt = 1; attempt <= MAX_BACKUP_ATTEMPTS; attempt++) {
      try {
        await trigger.call(this.link);
        return; // backup succeeded
      } catch (err) {
        if (!(err instanceof CloudwaysError && err.status === 422)) throw err;
        const isOperationBusy = /operation.*in progress/i.test(err.message);
        if (isOperationBusy && attempt < MAX_BACKUP_ATTEMPTS) {
          this.progress(
            jobId, 'remote-backup', 'running',
            `Server busy — retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s (attempt ${attempt}/${MAX_BACKUP_ATTEMPTS})…`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        this.progress(jobId, 'remote-backup', 'running', isOperationBusy
          ? 'Server busy — proceeding without new backup'
          : 'Skipped — recent backup exists');
      }
    }
  }

  /**
   * SFTP-mode safety net: tar wp-content + mysqldump on the server,
   * leave the artifacts under `<appRoot>/private_html/.cwsync-snapshots`
   * for `undoPush` to read back. Best-effort mirror to userDataDir
   * for snapshots under 500 MB so undo survives even if Cloudways
   * cleans /tmp-style paths.
   */
  private async captureLocalSnapshot(args: {
    jobId: string;
    ssh: SshClient;
    sftp: SftpClient | undefined;
    appPublicPath: string;
    appRootPath: string;
    plan: PushPlan;
  }): Promise<UndoSnapshot> {
    const { jobId, ssh, sftp, appPublicPath, appRootPath, plan } = args;
    const snapshotDir = `${appRootPath}/private_html/.cwsync-snapshots`;
    const remoteContentTar = `${snapshotDir}/snap-${jobId}.tar.gz`;
    const remoteSqlGz = `${snapshotDir}/snap-${jobId}.sql.gz`;

    this.progress(jobId, 'remote-backup', 'running', 'Creating local-tar safety snapshot on server…');
    await execChecked(ssh, `mkdir -p ${shellQuote(snapshotDir)}`);

    // Snapshot wp-content. Skip cache directories / vendor dirs that
    // are heavy and don't affect rollback semantics.
    await execChecked(
      ssh,
      `tar -czf ${shellQuote(remoteContentTar)} ` +
        `--exclude=cache --exclude=upgrade --exclude=*.log ` +
        `-C ${shellQuote(appPublicPath)} wp-content`,
    );

    // Snapshot DB via wp-cli when available; fall back to a no-op
    // marker so undo can still restore files even without a DB dump.
    try {
      const dumpCmd = buildWpCommand(appPublicPath, ['db', 'export', '-'], { skipPlugins: true });
      this.progress(jobId, 'remote-backup', 'running', 'Dumping current DB on server…');
      await execChecked(ssh, `${dumpCmd} | gzip > ${shellQuote(remoteSqlGz)}`);
    } catch (err) {
      // wp-cli unavailable — leave an empty marker so undo still finds the path.
      this.progress(jobId, 'remote-backup', 'running', 'wp-cli unavailable; DB snapshot skipped.');
      await ssh.exec(`: > ${shellQuote(remoteSqlGz)}`).catch(() => undefined);
    }

    // Try to mirror locally for snapshots under 500 MB.
    const sizeRes = await ssh.exec(
      `du -sb ${shellQuote(remoteContentTar)} ${shellQuote(remoteSqlGz)} | awk '{s+=$1} END {print s}'`,
    );
    const sizeBytes = Number(sizeRes.stdout.trim()) || 0;

    let localCachePath: string | undefined;
    if (sizeBytes > 0 && sizeBytes < 500 * 1024 * 1024 && sftp) {
      try {
        const localDir = path.join(
          this.userDataDir,
          'cloudwayssync',
          'snapshots',
          plan.localSiteId,
          jobId,
        );
        await fs.promises.mkdir(localDir, { recursive: true });
        await sftp.connect();
        await sftp.download(relativeToHome(remoteContentTar), path.join(localDir, 'wp-content.tar.gz'));
        await sftp.download(relativeToHome(remoteSqlGz), path.join(localDir, 'db.sql.gz'));
        localCachePath = localDir;
      } catch (err) {
        this.progress(jobId, 'remote-backup', 'running',
          'Local snapshot mirror failed; remote copy retained.');
      }
    }

    return {
      kind: 'local-tar',
      remoteContentTarPath: remoteContentTar,
      remoteSqlGzPath: remoteSqlGz,
      localCachePath,
      sizeBytes,
    };
  }

  private async runWithIdleWatchdog<T>(
    sftp: SftpClient | undefined,
    label: string,
    fn: (mark: () => void) => Promise<T>,
    idleTimeoutMs = 3 * 60 * 1000,
  ): Promise<T> {
    let lastActivity = Date.now();
    let aborted = false;
    const mark = () => {
      lastActivity = Date.now();
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity >= idleTimeoutMs) {
        aborted = true;
        clearInterval(watchdog);
        sftp?.end().catch(() => undefined);
      }
    }, Math.min(idleTimeoutMs, 15_000));
    (watchdog as unknown as { unref?: () => void }).unref?.();

    try {
      return await fn(mark);
    } catch (err) {
      if (aborted) {
        throw new RemoteError(
          'SFTP_FAILED',
          `SFTP ${label} stalled: no activity for ${Math.round(idleTimeoutMs / 1000)}s.`,
          { retriable: true, detail: { idleTimeoutMs } },
        );
      }
      throw err;
    } finally {
      clearInterval(watchdog);
    }
  }

  private async step<T>(jobId: string, stepId: string, fn: () => Promise<T>): Promise<T> {
    this.assertNotCancelled(jobId);
    this.progress(jobId, stepId, 'running');
    try {
      const result = await fn();
      this.assertNotCancelled(jobId);
      this.progress(jobId, stepId, 'success');
      return result;
    } catch (err) {
      this.progress(jobId, stepId, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private progress(
    jobId: string,
    stepId: string,
    status: JobProgressEvent['status'],
    detail?: string,
    bytesTransferred?: number,
    totalBytes?: number,
  ): void {
    this.emitProgress?.({ jobId, stepId, status, detail, bytesTransferred, totalBytes });
  }

  private assertNotCancelled(jobId: string): void {
    if (this.isCancelled?.(jobId)) {
      throw new RemoteError('SSH_COMMAND_FAILED', 'Push job was cancelled.', { retriable: false });
    }
  }
}

/** Swap http↔https in a URL. Returns the input unchanged if not http(s). */
function flipProtocol(url: string): string {
  if (url.startsWith('https://')) return 'http://' + url.slice(8);
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

/** Convert an absolute remote path under the SFTP user's home into the
 * relative form `ssh2-sftp-client.upload` expects. The library treats
 * absolute paths starting with `/home/...` as fine, but historically
 * the codebase has used `private_html/...` strings. Keep that. */
function relativeToHome(absPath: string): string {
  // /home/<user>/applications/<sys>/private_html/foo → private_html/foo
  // /home/<user>/private_html/foo → private_html/foo
  const idx = absPath.indexOf('/private_html/');
  if (idx >= 0) {
    return absPath.slice(idx + 1); // drop leading slash → 'private_html/...'
  }
  return absPath;
}

async function collectMetadata(ssh: SshClient, appPublicPath: string): Promise<PullMetadata> {
  const [homeUrl, siteUrl, wpVersion, breezeStatus] = await Promise.all([
    wpOptionGet({ ssh, appPublicPath }, 'home'),
    wpOptionGet({ ssh, appPublicPath }, 'siteurl'),
    wpCli({ ssh, appPublicPath }, ['core', 'version', '--skip-plugins', '--skip-themes']).then((r) => r.stdout.trim()).catch(() => undefined),
    detectBreezePlugin({ ssh, appPublicPath }),
  ]);
  const multisiteCheck = await ssh.exec(
    buildWpCommand(appPublicPath, ['core', 'is-installed', '--network'], { skipPlugins: true }),
  );
  return {
    homeUrl,
    siteUrl,
    wpVersion,
    isMultisite: multisiteCheck.code === 0,
    breezeStatus,
  };
}

async function execChecked(ssh: SshClient, command: string): Promise<void> {
  const res = await ssh.exec(command);
  if (res.code !== 0) {
    const stderr = res.stderr?.trim();
    const msg = stderr
      ? `Remote command failed (exit ${res.code}): ${stderr}`
      : `Remote command failed (exit ${res.code}): ${command}`;
    throw new RemoteError('SSH_COMMAND_FAILED', msg, {
      retriable: false,
      detail: { code: res.code, stderr: res.stderr, command },
    });
  }
}

async function cleanupRemote(ssh: SshClient | undefined, ...paths: Array<string | undefined>): Promise<void> {
  if (!ssh?.connected) return;
  const existingPaths = paths.filter((p): p is string => Boolean(p));
  const quoted = existingPaths.map(shellQuote).join(' ');
  if (!quoted) return;
  await ssh.exec(`rm -f ${quoted}`).catch(() => undefined);
}

