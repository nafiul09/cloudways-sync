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
  type IpcResult,
  type SerializedError,
  type SmokeAppRequest,
  type SmokeAppResponse,
} from '../../shared/ipcTypes';
import { EncryptionUnavailableError } from '../credentials';
import { RemoteError } from '../remote/errors';
import { SshClient } from '../remote/SshClient';
import { cloudwaysAppPublicPath, wpCli } from '../remote/wpCli';
import type { AddIpcAsyncListener } from './handlers';

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
};

export function registerRemoteHandlers({
  addIpcAsyncListener,
  connection,
}: RegisterRemoteOptions): void {
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
      const creds = await client.getAppCreds(server.id, app.id);
      const primary = creds[0];
      const host = server.public_ip ?? server.server_fqdn;
      const username = primary?.sys_user ?? app.sys_user;
      const password = primary?.password;
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
          'No password available. This app may be ssh-key-only; the current smoke test needs password auth.',
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
        const res = await wpCli({ ssh, appPublicPath }, ['option', 'get', 'home']);
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
}
