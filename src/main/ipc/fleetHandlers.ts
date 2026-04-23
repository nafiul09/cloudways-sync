// Phase 3 IPC handlers: servers + apps browser.
//
// These read-only handlers project Cloudways API responses into the
// smaller, flatter shapes declared in `shared/ipcTypes.ts`. All four
// handlers require a live connection — on disconnect the
// `ConnectionService.requireClient()` throws AUTH_INVALID, which the
// `runHandler` wrapper in this module serialises back to the renderer.

import { CloudwaysError } from '../cloudways/errors';
import { AppPasswordStore, EncryptionUnavailableError } from '../credentials';
import type { ConnectionService } from '../connection/service';
import type { App, Server } from '../cloudways/schemas';
import {
  CHANNELS,
  type AppDetail,
  type AppSummary,
  type GetAppRequest,
  type GetAppResponse,
  type IpcResult,
  type ListAppsRequest,
  type ListAppsResponse,
  type ListServersResponse,
  type SerializedError,
  type ServerSummary,
} from '../../shared/ipcTypes';
import type { AddIpcAsyncListener } from './handlers';

function serializeError(err: unknown): SerializedError {
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

/** Map a zod-parsed Server into the IPC-safe summary. */
export function toServerSummary(s: Server): ServerSummary {
  return {
    id: s.id,
    label: s.label,
    cloud: s.cloud,
    region: s.region,
    size: s.size,
    publicIp: s.public_ip,
    serverFqdn: s.server_fqdn,
    masterUser: s.master_user,
    status: s.status,
    appCount: s.apps.length,
  };
}

/** Map a zod-parsed App into the IPC-safe summary. */
export function toAppSummary(a: App, serverId: number): AppSummary {
  return {
    id: a.id,
    serverId,
    label: a.label,
    application: a.application,
    isWordPress: a.application.toLowerCase().includes('wordpress'),
    appVersion: a.app_version,
    appFqdn: a.app_fqdn,
    appUser: a.app_user,
    sysUser: a.sys_user,
    cname: a.cname ?? null,
    mysqlDbName: a.mysql_db_name,
    mysqlUser: a.mysql_user,
    createdAt: a.created_at,
  };
}

export type RegisterFleetOptions = {
  addIpcAsyncListener: AddIpcAsyncListener;
  connection: ConnectionService;
  appPasswords?: AppPasswordStore;
};

export function registerFleetHandlers({ addIpcAsyncListener, connection, appPasswords }: RegisterFleetOptions): void {
  const handlers: Array<readonly [string, (...args: unknown[]) => Promise<IpcResult<unknown>>]> = [
    [
      CHANNELS.LIST_SERVERS,
      () =>
        runHandler<ListServersResponse>(async () => {
          const client = connection.requireClient();
          const servers = await client.listServers();
          return { servers: servers.map(toServerSummary) };
        }),
    ],
    [
      CHANNELS.LIST_APPS,
      (...args: unknown[]) => {
        const payload = args[0] as ListAppsRequest | undefined;
        return runHandler<ListAppsResponse>(async () => {
          if (!payload || typeof payload.serverId !== 'number') {
            throw new CloudwaysError('AUTH_INVALID', 'serverId is required.', { retriable: false });
          }
          const client = connection.requireClient();
          const servers = await client.listServers();
          const server = servers.find((s) => s.id === payload.serverId);
          if (!server) {
            throw new CloudwaysError('OPERATION_FAILED', `Server ${payload.serverId} not found.`, {
              retriable: false,
            });
          }
          return { apps: server.apps.map((a) => toAppSummary(a, server.id)) };
        });
      },
    ],
    [
      CHANNELS.GET_APP,
      (...args: unknown[]) => {
        const payload = args[0] as GetAppRequest | undefined;
        return runHandler<GetAppResponse>(async () => {
          if (!payload || typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
            throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required.', {
              retriable: false,
            });
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

          // Pull master creds. Some apps have no entries (e.g. only
          // ssh-key auth); treat that as "no password available" rather
          // than an error.
          const creds = await client.getAppCreds(server.id, app.id).catch((err) => {
            if (err instanceof CloudwaysError && !err.retriable) return [];
            throw err;
          });
          const primary = creds[0];
          const storedPassword = appPasswords ? await appPasswords.get(server.id, app.id) : undefined;
          const password = primary?.password || storedPassword;

          const detail: AppDetail = {
            ...toAppSummary(app, server.id),
            server: toServerSummary(server),
            sftp: {
              host: server.public_ip ?? server.server_fqdn ?? '',
              user: primary?.sys_user ?? app.sys_user ?? '',
              password,
            },
            db: {
              name: app.mysql_db_name,
              user: app.mysql_user,
              password,
            },
          };
          return { app: detail };
        });
      },
    ],
  ];

  for (const [channel, handler] of handlers) {
    addIpcAsyncListener(channel, handler);
  }
}
