// Phase 4 IPC handler: remote smoke test.
//
// Opens an SSH connection to the Cloudways app using the master
// credentials we already know from `cs:getApp`, runs
// `wp option get home` via wp-cli, and returns the result.
//
// This handler intentionally builds its own SshClient rather than
// re-using a pool: Phase 4 jobs are short-lived, and the pool only
// pays off when an orchestrator holds a connection across steps
// (Phase 5 +).

import { CloudwaysError } from '../cloudways/errors';
import type { ConnectionService } from '../connection/service';
import {
  CHANNELS,
  type CreateAppCredentialRequest,
  type CreateAppCredentialResponse,
  type DetectBreezeRequest,
  type DetectBreezeResponse,
  type IpcResult,
  type SerializedError,
  type SmokeAppRequest,
  type SmokeAppResponse,
} from '../../shared/ipcTypes';
import { AppPasswordStore, EncryptionUnavailableError } from '../credentials';
import { RemoteError } from '../remote/errors';
import { SshClient } from '../remote/SshClient';
import { cloudwaysAppPublicPath, detectBreezePlugin, wpCli } from '../remote/wpCli';
import type { AddIpcAsyncListener } from './handlers';

function isShellAccessDisabled(err: unknown): boolean {
  if (!(err instanceof RemoteError)) return false;
  const detail = err.detail;
  const stderr =
    typeof detail === 'object' && detail !== null && 'stderr' in detail
      ? String((detail as { stderr?: unknown }).stderr ?? '')
      : '';
  return /shell access is disabled/i.test(`${err.message}\n${stderr}`);
}

function shellAccessDisabledError(): RemoteError {
  return new RemoteError(
    'WPCLI_FAILED',
    'SSH shell access is disabled on Cloudways for this app. Cloudways Sync tried to enable it through the API; wait a minute and retry, or enable SSH access in Cloudways > Application > SSH/SFTP.',
    { retriable: true },
  );
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof RemoteError) {
    return { code: err.code, message: err.message, retriable: err.retriable, detail: err.detail };
  }
  if (err instanceof CloudwaysError) {
    return { code: err.code, message: err.message, retriable: err.retriable, detail: err.detail };
  }
  if (err instanceof EncryptionUnavailableError) {
    return { code: 'ENCRYPTION_UNAVAILABLE', message: err.message, retriable: false };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, retriable: false };
  }
  return { code: 'UNKNOWN', message: String(err), retriable: false };
}

async function runHandler<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

export type RegisterRemoteOptions = {
  addIpcAsyncListener: AddIpcAsyncListener;
  connection: ConnectionService;
  appPasswords?: AppPasswordStore;
};

export function registerRemoteHandlers({
  addIpcAsyncListener,
  connection,
  appPasswords,
}: RegisterRemoteOptions): void {
  addIpcAsyncListener(CHANNELS.CREATE_APP_CREDENTIAL, (...args: unknown[]) => {
    const payload = args[0] as CreateAppCredentialRequest | undefined;
    return runHandler<CreateAppCredentialResponse>(async () => {
      if (!payload || typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
        throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required.', { retriable: false });
      }
      if (!appPasswords) {
        throw new EncryptionUnavailableError();
      }

      const client = connection.requireClient();
      const servers = await client.listServers();
      const server = servers.find((s) => s.id === payload.serverId);
      if (!server) {
        throw new CloudwaysError('OPERATION_FAILED', `Server ${payload.serverId} not found.`, {
          retriable: false,
        });
      }
      const app = server.apps.find((a) => a.id === payload.appId);
      if (!app) {
        throw new CloudwaysError('OPERATION_FAILED', `App ${payload.appId} not found on server.`, {
          retriable: false,
        });
      }

      const created = await client.createAppCredential(server.id, app.id);
      await client.ensureAppSshAccess(server.id, app.id);
      if (!created.password) {
        throw new CloudwaysError('OPERATION_FAILED', 'Cloudways created app credentials without returning a password.', {
          retriable: false,
        });
      }
      await appPasswords.set(server.id, app.id, created.password);

      return {
        sftp: {
          host: server.public_ip ?? server.server_fqdn ?? '',
          user: created.sys_user,
          password: created.password,
        },
      };
    });
  });

  addIpcAsyncListener(CHANNELS.SMOKE_APP, (...args: unknown[]) => {
    const payload = args[0] as SmokeAppRequest | undefined;
    return runHandler<SmokeAppResponse>(async () => {
      if (!payload || typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
        throw new RemoteError('SSH_COMMAND_FAILED', 'serverId and appId are required.', {
          retriable: false,
        });
      }

      // Reuse the same credential path the renderer's AppDetail pane
      // uses so the smoke test verifies exactly the flow an orchestrator
      // would take. We read: server info, app info, and master creds.
      const client = connection.requireClient();
      const servers = await client.listServers();
      const server = servers.find((s) => s.id === payload.serverId);
      if (!server) {
        throw new RemoteError('SSH_COMMAND_FAILED', `Server ${payload.serverId} not found.`, {
          retriable: false,
        });
      }
      const app = server.apps.find((a) => a.id === payload.appId);
      if (!app) {
        throw new RemoteError('SSH_COMMAND_FAILED', `App ${payload.appId} not found.`, {
          retriable: false,
        });
      }
      await client.ensureAppSshAccess(server.id, app.id);
      let creds = await client.getAppCreds(server.id, app.id);
      let primary = creds[0];

      // Re-fetch once after enabling shell access; Cloudways may expose
      // app passwords only after the toggle has propagated.
      if (!primary?.password) {
        creds = await client.getAppCreds(server.id, app.id);
        primary = creds[0];
      }

      const host = server.public_ip ?? server.server_fqdn;
      const username = primary?.sys_user ?? app.sys_user;
      const providedPassword = payload.sftpPassword?.trim();
      const storedPassword = appPasswords ? await appPasswords.get(server.id, app.id) : undefined;
      const password = providedPassword || primary?.password || storedPassword;
      const appUser = app.sys_user ?? primary?.sys_user;

      if (!host) {
        throw new RemoteError('SSH_NETWORK', 'Cloudways did not return a server address.', {
          retriable: false,
        });
      }
      if (!username) {
        throw new RemoteError('SSH_AUTH_FAILED', 'No SSH user available for this app.', {
          retriable: false,
        });
      }
      if (!password) {
        throw new RemoteError(
          'SSH_AUTH_FAILED',
          'No SSH/SFTP password available. Enter the Cloudways application password, then try again.',
          { retriable: false },
        );
      }
      if (!appUser) {
        throw new RemoteError(
          'SSH_COMMAND_FAILED',
          'App is missing sys_user; cannot locate public_html.',
          { retriable: false },
        );
      }

      const appPublicPath = cloudwaysAppPublicPath(appUser);
      const ssh = new SshClient({ host, username, password });
      const started = Date.now();
      try {
        await ssh.connect();
        let res;
        try {
          res = await wpCli({ ssh, appPublicPath }, ['option', 'get', 'home']);
        } catch (err) {
          if (isShellAccessDisabled(err)) {
            await client.ensureAppSshAccess(server.id, app.id);
            throw shellAccessDisabledError();
          }
          throw err;
        }
        if (providedPassword && appPasswords) {
          await appPasswords.set(server.id, app.id, providedPassword);
        }
        return {
          appPublicPath,
          home: res.stdout.trimEnd(),
          stderr: res.stderr.trimEnd(),
          elapsedMs: Date.now() - started,
        };
      } finally {
        await ssh.end();
      }
    });
  });

  addIpcAsyncListener(CHANNELS.DETECT_BREEZE, (...args: unknown[]) => {
    const payload = args[0] as DetectBreezeRequest | undefined;
    return runHandler<DetectBreezeResponse>(async () => {
      if (!payload || typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
        throw new RemoteError('SSH_COMMAND_FAILED', 'serverId and appId are required.', {
          retriable: false,
        });
      }

      const client = connection.requireClient();
      const servers = await client.listServers();
      const server = servers.find((s) => s.id === payload.serverId);
      if (!server) {
        throw new RemoteError('SSH_COMMAND_FAILED', `Server ${payload.serverId} not found.`, { retriable: false });
      }
      const app = server.apps.find((a) => a.id === payload.appId);
      if (!app) {
        throw new RemoteError('SSH_COMMAND_FAILED', `App ${payload.appId} not found.`, { retriable: false });
      }

      let creds = await client.getAppCreds(server.id, app.id);
      let primary = creds[0];
      if (!primary?.password) {
        creds = await client.getAppCreds(server.id, app.id);
        primary = creds[0];
      }

      const host = server.public_ip ?? server.server_fqdn;
      const username = primary?.sys_user ?? app.sys_user;
      const storedPassword = appPasswords ? await appPasswords.get(server.id, app.id) : undefined;
      const password = primary?.password || storedPassword;
      const appUser = app.sys_user ?? primary?.sys_user;

      if (!host || !username || !password || !appUser) {
        throw new RemoteError('SSH_AUTH_FAILED', 'Missing SSH credentials for Breeze detection.', { retriable: false });
      }

      const appPublicPath = cloudwaysAppPublicPath(appUser);
      const ssh = new SshClient({ host, username, password });
      try {
        await ssh.connect();
        const breezeStatus = await detectBreezePlugin({ ssh, appPublicPath });
        return { breezeStatus };
      } finally {
        await ssh.end();
      }
    });
  });
}
