import fs from 'node:fs';
import path from 'node:path';
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
import type { JobProgressEvent, RunJobResponse } from '../../shared/ipcTypes';
import type { PullMetadata, PullPlan, SiteImporter } from './types';

export type PullOrchestratorOptions = {
  client: ApiClient;
  importer: SiteImporter;
  userDataDir: string;
  sshFactory?: (config: SshConnectConfig) => SshClient;
  sftpFactory?: (config: SftpConnectConfig) => SftpClient;
  emitProgress?: (event: JobProgressEvent) => void;
  isCancelled?: (jobId: string) => boolean;
};

export class PullOrchestrator {
  private readonly client: ApiClient;
  private readonly importer: SiteImporter;
  private readonly userDataDir: string;
  private readonly sshFactory: (config: SshConnectConfig) => SshClient;
  private readonly sftpFactory: (config: SftpConnectConfig) => SftpClient;
  private readonly emitProgress?: (event: JobProgressEvent) => void;
  private readonly isCancelled?: (jobId: string) => boolean;

  constructor(opts: PullOrchestratorOptions) {
    this.client = opts.client;
    this.importer = opts.importer;
    this.userDataDir = opts.userDataDir;
    this.sshFactory = opts.sshFactory ?? ((config) => new SshClient(config));
    this.sftpFactory = opts.sftpFactory ?? ((config) => new SftpClient(config));
    this.emitProgress = opts.emitProgress;
    this.isCancelled = opts.isCancelled;
  }

  async run(plan: PullPlan): Promise<RunJobResponse> {
    const jobId = `job_${plan.id}`;
    const jobDir = path.join(this.userDataDir, 'cloudwayssync', 'jobs', jobId);
    const stagingDir = path.join(jobDir, 'staging');
    const wpContentDir = path.join(stagingDir, 'wp-content');
    let remoteSql: string | undefined;
    let remoteSqlGz: string | undefined;
    let sftpSqlGz: string | undefined;
    const localSqlGz = path.join(stagingDir, `cws-${jobId}.sql.gz`);
    const manifestPath = path.join(jobDir, 'manifest.json');

    await fs.promises.mkdir(stagingDir, { recursive: true });

    let ssh: SshClient | undefined;
    let sftp: SftpClient | undefined;
    try {
      this.assertNotCancelled(jobId);
      const { server, app, auth } = await this.step(jobId, 'validate', async () => {
        const resolved = await this.resolveCloudwaysApp(plan.serverId, plan.appId);
        if (!resolved.app.application.toLowerCase().includes('wordpress')) {
          throw new RemoteError('SSH_COMMAND_FAILED', 'Only WordPress apps can be pulled into Local.', {
            retriable: false,
            detail: { application: resolved.app.application },
          });
        }
        if (!resolved.app.sys_user) {
          throw new RemoteError('SSH_COMMAND_FAILED', 'Cloudways app is missing sys_user.', {
            retriable: false,
          });
        }
        return resolved;
      });

      await this.step(jobId, 'backup', async () => {
        const operationId = await this.client.triggerAppBackup(server.id, app.id);
        await this.client.waitForOperation(operationId, {
          onTick: (op) => {
            this.progress(jobId, 'backup', 'running', op.message || String(op.status));
          },
        });
      });

      const appPublicPath = cloudwaysAppPublicPath(app.sys_user as string);
      const appRootPath = cloudwaysAppRootPath(app.sys_user as string);
      remoteSql = `${appRootPath}/private_html/cws-${jobId}.sql`;
      remoteSqlGz = `${remoteSql}.gz`;
      sftpSqlGz = `private_html/cws-${jobId}.sql.gz`;
      ssh = this.sshFactory(auth);
      sftp = this.sftpFactory(auth);

      await this.step(jobId, 'ssh', async () => {
        await ssh?.connect();
      });

      const metadata = await this.step(jobId, 'metadata', async () =>
        collectMetadata(ssh as SshClient, appPublicPath),
      );
      if (metadata.isMultisite) {
        throw new RemoteError('SSH_COMMAND_FAILED', 'WordPress multisite is not supported in v1.', {
          retriable: false,
          detail: metadata,
        });
      }

      await this.step(jobId, 'db-export', async () => {
        await wpCli({ ssh: ssh as SshClient, appPublicPath }, [
          'db',
          'export',
          remoteSql as string,
          '--add-drop-table',
        ], { timeoutMs: 10 * 60 * 1000 });
        await execChecked(ssh as SshClient, `gzip -f ${shellQuote(remoteSql as string)}`);
      });

      await this.step(jobId, 'download-db', async () => {
        await sftp?.connect();
        await sftp?.download(sftpSqlGz as string, localSqlGz, {
          onProgress: (e) => {
            this.progress(jobId, 'download-db', 'running', e.remotePath, e.bytesTransferred, e.totalBytes);
          },
        });
      });

      await this.step(jobId, 'download-content', async () => {
        await sftp?.mirror('public_html/wp-content', wpContentDir, {
          exclude: [
            'cache/**',
            'uploads/cache/**',
            'backup*/**',
            '**/.git/**',
            '**/node_modules/**',
            '**/*.log',
            '**/error_log',
          ],
          onProgress: (e) => {
            this.progress(jobId, 'download-content', 'running', e.remotePath, e.bytesTransferred, e.totalBytes);
          },
        });
      });

      await this.step(jobId, 'manifest', async () => {
        await writeManifest(manifestPath, {
          jobId,
          planId: plan.id,
          serverId: server.id,
          appId: app.id,
          appLabel: app.label,
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
        }),
      );
      this.progress(jobId, 'local-content', 'success');
      this.progress(jobId, 'local-db', 'success');
      this.progress(jobId, 'search-replace', 'success');

      return {
        jobId,
        status: 'success',
        localSiteId: imported.localSiteId,
        localUrl: imported.localUrl,
        manifestPath,
      };
    } finally {
      await cleanupRemote(ssh, remoteSql, remoteSqlGz);
      await sftp?.end();
      await ssh?.end();
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
    const creds = await this.client.getAppCreds(server.id, app.id);
    const primary = creds[0];
    const host = server.public_ip ?? server.server_fqdn;
    const username = primary?.sys_user ?? app.sys_user;
    if (!host) {
      throw new RemoteError('SSH_NETWORK', 'Cloudways did not return a server address.', { retriable: false });
    }
    if (!username) {
      throw new RemoteError('SSH_AUTH_FAILED', 'No SSH user available for this app.', { retriable: false });
    }
    if (!primary?.password) {
      throw new RemoteError(
        'SSH_AUTH_FAILED',
        'No password available. This app may be ssh-key-only; Phase 5 password auth cannot continue yet.',
        { retriable: false },
      );
    }
    return {
      server,
      app,
      auth: {
        host,
        username,
        password: primary.password,
      },
    };
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
      throw new RemoteError('SSH_COMMAND_FAILED', 'Pull job was cancelled.', { retriable: false });
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
    throw new RemoteError('SSH_COMMAND_FAILED', `Remote command failed: ${command}`, {
      retriable: false,
      detail: { code: res.code, stderr: res.stderr },
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
