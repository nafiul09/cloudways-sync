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
import type { JobProgressEvent, RunJobResponse } from '../../shared/ipcTypes';
import { selectedWpContentSubdirs, shouldSkipStep, tarExcludeFlags } from './Selective';
import { pruneRemoteSnapshots, sweepLocalSnapshots, sweepRemoteTempFiles, sweepStaleJobs } from './cleanup';
import type { PullMetadata, PullPlan, SiteImporter } from './types';
import type { AppLink } from './AppLink';
import { extractTarGz } from './pathUtil';
import type { SyncLogger } from './SyncLogger';

const execFileAsync = promisify(execFile);

export type PullOrchestratorOptions = {
  /**
   * Adapter that hides API vs SFTP differences. The orchestrator
   * never touches ApiClient directly — it asks the link for SSH
   * connection details and (when available) for remote backup.
   */
  link: AppLink;
  importer: SiteImporter;
  userDataDir: string;
  sshFactory?: (config: SshConnectConfig) => SshClient;
  sftpFactory?: (config: SftpConnectConfig) => SftpClient;
  emitProgress?: (event: JobProgressEvent) => void;
  isCancelled?: (jobId: string) => boolean;
  logger?: SyncLogger;
};

export class PullOrchestrator {
  private readonly link: AppLink;
  private readonly importer: SiteImporter;
  private readonly userDataDir: string;
  private readonly sshFactory: (config: SshConnectConfig) => SshClient;
  private readonly sftpFactory: (config: SftpConnectConfig) => SftpClient;
  private readonly emitProgress?: (event: JobProgressEvent) => void;
  private readonly isCancelled?: (jobId: string) => boolean;
  private readonly logger?: SyncLogger;

  constructor(opts: PullOrchestratorOptions) {
    this.link = opts.link;
    this.importer = opts.importer;
    this.userDataDir = opts.userDataDir;
    this.sshFactory = opts.sshFactory ?? ((config) => new SshClient(config));
    this.sftpFactory = opts.sftpFactory ?? ((config) => new SftpClient(config));
    this.emitProgress = opts.emitProgress;
    this.isCancelled = opts.isCancelled;
    this.logger = opts.logger;
  }

  async run(plan: PullPlan): Promise<RunJobResponse> {
    const jobId = `job_${plan.id}`;
    const jobDir = path.join(this.userDataDir, 'cloudwayssync', 'jobs', jobId);
    const stagingDir = path.join(jobDir, 'staging');
    const wpContentDir = path.join(stagingDir, 'wp-content');
    let remoteSql: string | undefined;
    let remoteSqlGz: string | undefined;
    let sftpSqlGz: string | undefined;
    let remoteContentTarGz: string | undefined;
    const localSqlGz = path.join(stagingDir, `cws-${jobId}.sql.gz`);
    const localContentTarGz = path.join(stagingDir, `cws-${jobId}-wpcontent.tar.gz`);
    const manifestPath = path.join(jobDir, 'manifest.json');

    await fs.promises.mkdir(stagingDir, { recursive: true });

    this.logger?.info(`Pull started`, {
      jobId,
      detail: {
        linkMode: this.link.mode,
        destinationName: plan.destinationName,
        includes: plan.includes,
      },
    });

    let ssh: SshClient | undefined;
    let sftp: SftpClient | undefined;
    try {
      this.assertNotCancelled(jobId);
      const ctx = await this.step(jobId, 'validate', async () => {
        const resolved = await this.link.resolve();
        if (resolved.api && !resolved.api.app.application.toLowerCase().includes('wordpress')) {
          throw new RemoteError('SSH_COMMAND_FAILED', 'Only WordPress apps can be pulled into Local.', {
            retriable: false,
            detail: { application: resolved.api.app.application },
          });
        }
        return resolved;
      });

      await this.step(jobId, 'backup', async () => {
        if (!this.link.triggerRemoteBackup) {
          // SFTP mode: read-only pull, no Cloudways API access for backup.
          this.progress(jobId, 'backup', 'skipped', 'SFTP-mode pull — remote backup is unavailable');
          return;
        }
        await this.runApiBackup(jobId);
      });

      const appPublicPath = ctx.webRoot;
      const appRootPath = appPublicPath.endsWith('/public_html')
        ? appPublicPath.slice(0, -'/public_html'.length)
        : path.posix.dirname(appPublicPath);
      remoteSql = `${appRootPath}/private_html/cws-${jobId}.sql`;
      remoteSqlGz = `${remoteSql}.gz`;
      sftpSqlGz = relativeToHome(remoteSqlGz);
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

      const metadata = await this.step(jobId, 'metadata', async () =>
        collectMetadata(ssh as SshClient, appPublicPath),
      );
      if (metadata.isMultisite) {
        throw new RemoteError('SSH_COMMAND_FAILED', 'WordPress multisite is not supported in v1.', {
          retriable: false,
          detail: metadata,
        });
      }

      if (shouldSkipStep('db-export', plan.includes)) {
        this.progress(jobId, 'db-export', 'skipped');
        this.progress(jobId, 'download-db', 'skipped');
      } else {
        await this.step(jobId, 'db-export', async () => {
          await wpCli({ ssh: ssh as SshClient, appPublicPath }, [
            'db',
            'export',
            remoteSql as string,
            '--add-drop-table',
            '--skip-plugins', '--skip-themes',
          ], { timeoutMs: 10 * 60 * 1000 });
          await execChecked(ssh as SshClient, `gzip -f ${shellQuote(remoteSql as string)}`);
        });

        await this.step(jobId, 'download-db', async () => {
          await sftp?.connect();
          await this.runWithIdleWatchdog(sftp, 'download-db', (mark) =>
            sftp!.download(sftpSqlGz as string, localSqlGz, {
              onProgress: (e) => {
                mark();
                this.progress(jobId, 'download-db', 'running', e.remotePath, e.bytesTransferred, e.totalBytes);
              },
            }),
          );
        });
      }

      if (shouldSkipStep('download-content', plan.includes)) {
        this.progress(jobId, 'download-content', 'skipped');
      } else {
        await this.step(jobId, 'download-content', async () => {
          remoteContentTarGz = `${appRootPath}/private_html/cws-${jobId}-wpcontent.tar.gz`;
          const sftpContentTarGz = relativeToHome(remoteContentTarGz);

          this.progress(jobId, 'download-content', 'running', 'Archiving wp-content on server…');
          await execChecked(
            ssh as SshClient,
            `tar czf ${shellQuote(remoteContentTarGz)} ` +
              `${tarExcludeFlags(plan.includes)} ` +
              `-C ${shellQuote(appPublicPath)} wp-content`,
          );

          await sftp?.end();
          await sftp?.connect();

          this.progress(jobId, 'download-content', 'running', 'Downloading archive…');
          await this.runWithIdleWatchdog(sftp, 'download-content', (mark) =>
            sftp!.download(sftpContentTarGz, localContentTarGz, {
              onProgress: (e) => {
                mark();
                this.progress(jobId, 'download-content', 'running', 'Downloading archive…', e.bytesTransferred, e.totalBytes);
              },
            }),
          );

          this.progress(jobId, 'download-content', 'running', 'Extracting archive…');
          await extractTarGz(localContentTarGz, stagingDir);
        });
      }

      await this.step(jobId, 'manifest', async () => {
        await writeManifest(manifestPath, {
          jobId,
          planId: plan.id,
          linkMode: this.link.mode,
          serverId: ctx.api?.server.id,
          appId: ctx.api?.app.id,
          appLabel: ctx.api?.app.label ?? this.link.mapping.appLabel,
          sourceUrl: metadata.homeUrl,
          destinationName: plan.destinationName,
          metadata,
          pulledAt: new Date().toISOString(),
        });
      });

      const imported = await this.step(jobId, 'local-site', async () =>
        this.importer.importPulledSite({
          siteName: plan.destinationName,
          sourceUrl: metadata.homeUrl,
          dbDumpPath: localSqlGz,
          wpContentPath: wpContentDir,
          manifestPath,
          metadata,
          importDatabase: plan.includes.database,
          importWpContent: plan.includes.wpContent,
          wpContentSubdirs: selectedWpContentSubdirs(plan.includes),
          existingSiteId: plan.localSiteId,
        }),
      );
      // NOTE: local-content / local-db / search-replace are sub-phases
      // of importPulledSite that aren't independently instrumented
      // yet — don't emit fake success for them; the UI should treat
      // them as covered by local-site.

      this.logger?.info(`Pull completed successfully`, { jobId, detail: { localSiteId: imported.localSiteId } });
      return {
        jobId,
        status: 'success',
        localSiteId: imported.localSiteId,
        localUrl: imported.localUrl,
        webRootPath: imported.webRootPath,
      };
    } finally {
      await cleanupRemote(ssh, remoteSql, remoteSqlGz, remoteContentTarGz);
      await sftp?.end();
      await ssh?.end();
      // Clean up local staging — no reason to keep downloaded archives
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

        // Distinguish "operation in progress" from "recent backup exists"
        const isOperationBusy = /operation.*in progress/i.test(err.message);
        if (isOperationBusy && attempt < MAX_BACKUP_ATTEMPTS) {
          this.progress(
            jobId, 'backup', 'running',
            `Server busy — retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s (attempt ${attempt}/${MAX_BACKUP_ATTEMPTS})…`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        // Either a genuine "recent backup" 422, or exhausted retries
        this.progress(jobId, 'backup', 'running', isOperationBusy
          ? 'Server busy — proceeding without new backup'
          : 'Skipped — recent backup exists');
        return;
      }
    }
  }

  /** Run an SFTP operation with an idle watchdog. If the caller-
   * supplied `mark()` function isn't called for `idleTimeoutMs`, we
   * force-close the SFTP connection, which causes any in-flight RPC
   * inside the operation to reject. This is the safety net that
   * catches hangs the per-RPC SFTP timeouts miss (e.g., an SSH
   * session that keeps the TCP socket alive via keepalive but stops
   * delivering packets between files). */
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
        // Force-close the SFTP socket so the pending RPC rejects.
        // Best-effort: we swallow any error here because we're about
        // to throw our own.
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
          `SFTP ${label} stalled: no file activity for ${Math.round(idleTimeoutMs / 1000)}s. The remote server stopped responding.`,
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
      const msg = err instanceof Error ? err.message : String(err);
      this.progress(jobId, stepId, 'failed', msg);
      this.logger?.error(`Step ${stepId} failed: ${msg}`, { jobId, step: stepId, detail: err instanceof Error ? err.stack : undefined });
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
    if (status === 'success' || status === 'failed' || status === 'skipped') {
      this.logger?.info(`[pull] ${stepId}: ${status}${detail ? ` — ${detail}` : ''}`, { jobId, step: stepId });
    }
  }

  private assertNotCancelled(jobId: string): void {
    if (this.isCancelled?.(jobId)) {
      throw new RemoteError('SSH_COMMAND_FAILED', 'Pull job was cancelled.', { retriable: false });
    }
  }
}

/** Convert an absolute remote path under the SFTP user's home into the
 * relative form `ssh2-sftp-client.download` expects. */
function relativeToHome(absPath: string): string {
  const idx = absPath.indexOf('/private_html/');
  if (idx >= 0) {
    return absPath.slice(idx + 1);
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

async function writeManifest(manifestPath: string, body: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}
