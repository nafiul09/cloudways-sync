import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ApiClient } from '../cloudways/ApiClient';
import type { App, Server } from '../cloudways/schemas';
import { RemoteError } from '../remote/errors';
import { SftpClient, type SftpConnectConfig } from '../remote/SftpClient';
import { SshClient, type SshConnectConfig } from '../remote/SshClient';
import {
  buildWpCommand,
  cloudwaysAppPublicPath,
  shellQuote,
  wpCli,
  wpOptionGet,
} from '../remote/wpCli';
import type { JobProgressEvent, RunJobResponse, UndoRecord } from '../../shared/ipcTypes';
import { shouldSkipPushStep, tarExcludePatternsForIncludes } from './Selective';
import { sweepStaleJobs } from './cleanup';
import type { PullMetadata, PushPlan } from './types';
import type { UndoLedger } from './UndoLedger';

const execFileAsync = promisify(execFile);

export type ExecLocalFn = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

/** Dump a Local site's database to the given path using Local's bundled MySQL. */
export type LocalDbDumpFn = (localSiteId: string, destination: string) => Promise<string>;

export type PushOrchestratorOptions = {
  client: ApiClient;
  undoLedger: UndoLedger;
  userDataDir: string;
  sshFactory?: (config: SshConnectConfig) => SshClient;
  sftpFactory?: (config: SftpConnectConfig) => SftpClient;
  /** Override for local shell commands (tar, gzip). Defaults to execFile. */
  execLocal?: ExecLocalFn;
  /** Dump a Local site's DB via Local's SiteDatabase service. */
  localDbDump?: LocalDbDumpFn;
  getAppPassword?: (serverId: number, appId: number) => Promise<string | undefined>;
  emitProgress?: (event: JobProgressEvent) => void;
  isCancelled?: (jobId: string) => boolean;
};

const defaultExecLocal: ExecLocalFn = async (cmd, args, opts) => {
  return execFileAsync(cmd, args, { timeout: opts?.timeout });
};

export class PushOrchestrator {
  private readonly client: ApiClient;
  private readonly undoLedger: UndoLedger;
  private readonly userDataDir: string;
  private readonly sshFactory: (config: SshConnectConfig) => SshClient;
  private readonly sftpFactory: (config: SftpConnectConfig) => SftpClient;
  private readonly execLocal: ExecLocalFn;
  private readonly localDbDump?: LocalDbDumpFn;
  private readonly getAppPassword?: (serverId: number, appId: number) => Promise<string | undefined>;
  private readonly emitProgress?: (event: JobProgressEvent) => void;
  private readonly isCancelled?: (jobId: string) => boolean;

  constructor(opts: PushOrchestratorOptions) {
    this.client = opts.client;
    this.undoLedger = opts.undoLedger;
    this.userDataDir = opts.userDataDir;
    this.sshFactory = opts.sshFactory ?? ((config) => new SshClient(config));
    this.sftpFactory = opts.sftpFactory ?? ((config) => new SftpClient(config));
    this.execLocal = opts.execLocal ?? defaultExecLocal;
    this.localDbDump = opts.localDbDump;
    this.getAppPassword = opts.getAppPassword;
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

    await fs.promises.mkdir(stagingDir, { recursive: true });

    let ssh: SshClient | undefined;
    let sftp: SftpClient | undefined;
    try {
      this.assertNotCancelled(jobId);

      // Step 1: Validate the remote app
      const { server, app, auth } = await this.step(jobId, 'validate', async () => {
        const resolved = await this.resolveCloudwaysApp(plan.serverId, plan.appId);
        if (!resolved.app.application.toLowerCase().includes('wordpress')) {
          throw new RemoteError('SSH_COMMAND_FAILED', 'Only WordPress apps can be pushed to.', {
            retriable: false,
            detail: { application: resolved.app.application },
          });
        }
        // Verify local webroot exists
        const webRootStat = await fs.promises.stat(plan.webRootPath).catch(() => null);
        if (!webRootStat?.isDirectory()) {
          throw new RemoteError('SSH_COMMAND_FAILED', `Local web root not found: ${plan.webRootPath}`, {
            retriable: false,
          });
        }
        return resolved;
      });

      // Step 2: Remote backup for safety (undo support)
      await this.step(jobId, 'remote-backup', async () => {
        const operationId = await this.client.triggerAppBackup(server.id, app.id);
        await this.client.waitForOperation(operationId, {
          onTick: (op) => {
            this.progress(jobId, 'remote-backup', 'running', op.message || String(op.status));
          },
        });
      });

      const appPublicPath = cloudwaysAppPublicPath(app.sys_user as string);
      const appRootPath = cloudwaysAppRootPath(app.sys_user as string);
      remoteSql = `${appRootPath}/private_html/cws-${jobId}.sql`;
      remoteSqlGz = `${remoteSql}.gz`;
      const sftpSqlGz = `private_html/cws-${jobId}.sql.gz`;
      remoteContentTarGz = `${appRootPath}/private_html/cws-${jobId}-wpcontent.tar.gz`;
      const sftpContentTarGz = `private_html/cws-${jobId}-wpcontent.tar.gz`;

      // Step 3: SSH connect
      ssh = this.sshFactory(auth);
      sftp = this.sftpFactory(auth);
      await this.step(jobId, 'ssh', async () => {
        await ssh?.connect();
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
              `--path=${plan.webRootPath}`,
            ], { timeout: 10 * 60 * 1000 });
          }
          // Gzip locally
          await this.execLocal('gzip', ['-f', localSql], { timeout: 5 * 60 * 1000 });
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
          // Create local archive of wp-content
          this.progress(jobId, 'upload-content', 'running', 'Archiving local wp-content…');
          await this.execLocal('tar', [
            'czf', localContentTarGz,
            ...tarExcludeFlagsArray(plan.includes),
            '-C', plan.webRootPath,
            'wp-content',
          ], { timeout: 10 * 60 * 1000 });

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

          // Extract on server — replace remote wp-content
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

          // Import via wp db import
          this.progress(jobId, 'remote-db-import', 'running', 'Importing database…');
          await wpCli({ ssh: ssh as SshClient, appPublicPath }, [
            'db', 'import', remoteSql as string,
          ], { timeoutMs: 10 * 60 * 1000 });
        });
      }

      // Step 9: Search-replace URLs on the remote
      if (shouldSkipPushStep('search-replace', plan.includes)) {
        this.progress(jobId, 'search-replace', 'skipped');
      } else {
        await this.step(jobId, 'search-replace', async () => {
          await wpCli({ ssh: ssh as SshClient, appPublicPath }, [
            'search-replace',
            plan.localUrl,
            metadata.homeUrl,
            '--all-tables',
            '--skip-columns=guid',
          ], { timeoutMs: 10 * 60 * 1000 });
        });
      }

      // Step 10: Flush caches
      await this.step(jobId, 'cache-flush', async () => {
        // WP cache flush + rewrite flush on server
        await wpCli({ ssh: ssh as SshClient, appPublicPath }, ['cache', 'flush']).catch(() => undefined);
        await wpCli({ ssh: ssh as SshClient, appPublicPath }, ['rewrite', 'flush']).catch(() => undefined);
        // Varnish purge (best-effort)
        await this.client.purgeVarnish(server.id);
      });

      // Step 11: Cleanup remote temp files
      await this.step(jobId, 'cleanup', async () => {
        await cleanupRemote(ssh, remoteSql, remoteSqlGz, remoteContentTarGz);
      });

      // Record undo entry
      const undoRecord: UndoRecord = {
        id: `undo_${plan.id}`,
        jobId,
        serverId: server.id,
        appId: app.id,
        appLabel: app.label,
        sourceUrl: plan.localUrl,
        targetUrl: metadata.homeUrl,
        createdAt: new Date().toISOString(),
      };
      await this.undoLedger.add(undoRecord);

      return {
        jobId,
        status: 'success',
      };
    } finally {
      await sftp?.end();
      await ssh?.end();
      // Clean up local staging — no reason to keep exported archives
      await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
      // Sweep stale job dirs left by previous runs that didn't clean up
      await sweepStaleJobs(this.userDataDir).catch(() => undefined);
    }
  }

  private async resolveCloudwaysApp(
    serverId: number,
    appId: number,
  ): Promise<{ server: Server; app: App; auth: SshConnectConfig & SftpConnectConfig }> {
    const servers = await this.client.listServers();
    const server = servers.find((s) => s.id === serverId);
    if (!server) {
      throw new RemoteError('SSH_COMMAND_FAILED', `Server ${serverId} not found.`, { retriable: false });
    }
    const app = server.apps.find((candidate) => candidate.id === appId);
    if (!app) {
      throw new RemoteError('SSH_COMMAND_FAILED', `App ${appId} not found on server.`, { retriable: false });
    }
    await this.client.ensureAppSshAccess(server.id, app.id);
    let creds = await this.client.getAppCreds(server.id, app.id);
    let primary = creds[0];

    // Re-fetch once after enabling shell access; Cloudways may expose
    // app passwords only after the toggle has propagated.
    if (!primary?.password) {
      creds = await this.client.getAppCreds(server.id, app.id);
      primary = creds[0];
    }

    const host = server.public_ip ?? server.server_fqdn;
    const username = primary?.sys_user ?? app.sys_user;
    const storedPassword = this.getAppPassword ? await this.getAppPassword(server.id, app.id) : undefined;
    const password = primary?.password || storedPassword;
    if (!host) {
      throw new RemoteError('SSH_NETWORK', 'Cloudways did not return a server address.', { retriable: false });
    }
    if (!username) {
      throw new RemoteError('SSH_AUTH_FAILED', 'No SSH user available for this app.', { retriable: false });
    }
    if (!password) {
      throw new RemoteError(
        'SSH_AUTH_FAILED',
        'No SSH/SFTP password available. Enter the Cloudways application password in the link step, then try again.',
        { retriable: false },
      );
    }
    return {
      server,
      app,
      auth: { host, username, password },
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

function cloudwaysAppRootPath(appSystemUser: string): string {
  return `/home/master/applications/${appSystemUser}`;
}

async function collectMetadata(ssh: SshClient, appPublicPath: string): Promise<PullMetadata> {
  const [homeUrl, siteUrl, wpVersion] = await Promise.all([
    wpOptionGet({ ssh, appPublicPath }, 'home'),
    wpOptionGet({ ssh, appPublicPath }, 'siteurl'),
    wpCli({ ssh, appPublicPath }, ['core', 'version']).then((r) => r.stdout.trim()).catch(() => undefined),
  ]);
  const multisiteCheck = await ssh.exec(
    buildWpCommand(appPublicPath, ['core', 'is-installed', '--network']),
  );
  return {
    homeUrl,
    siteUrl,
    wpVersion,
    isMultisite: multisiteCheck.code === 0,
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

/** Return tar exclude flags as an array of args (for local tar via execFileAsync). */
function tarExcludeFlagsArray(includes: PushPlan['includes']): string[] {
  const patterns = tarExcludePatternsForIncludes(includes);
  return patterns.flatMap((p) => ['--exclude', p]);
}
