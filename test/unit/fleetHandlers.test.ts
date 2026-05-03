import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerFleetHandlers } from '../../src/main/ipc/fleetHandlers';
import { CloudwaysError } from '../../src/main/cloudways/errors';
import type { IpcResult } from '../../src/shared/ipcTypes';
import { CHANNELS } from '../../src/shared/ipcTypes';
import type { App, Server } from '../../src/main/cloudways/schemas';

function makeRegistrar() {
  const routes = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const addIpcAsyncListener = (channel: string, cb: (...args: unknown[]) => unknown) => {
    routes.set(channel, async (...args) => cb(...args));
  };
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> => {
    const h = routes.get(channel);
    if (!h) throw new Error(`no route: ${channel}`);
    return (await h(...args)) as IpcResult<T>;
  };
  return { addIpcAsyncListener, invoke };
}

const APP_WP: App = {
  id: 101,
  label: 'Blog',
  application: 'wordpress',
  app_version: '6.5',
  app_fqdn: 'blog.cloudwaysapps.com',
  app_user: 'wpuser',
  sys_user: 'master_abc',
  cname: null,
  mysql_db_name: 'blog_db',
  mysql_user: 'blog_user',
};

const APP_PHP: App = {
  id: 102,
  label: 'API',
  application: 'phpstack',
  app_version: '8.2',
  cname: null,
};

const SERVER_DO: Server = {
  id: 1,
  label: 'do-prod-1',
  cloud: 'do',
  region: 'nyc3',
  public_ip: '1.2.3.4',
  master_user: 'master',
  apps: [APP_WP, APP_PHP],
};

const SERVER_VULTR: Server = {
  id: 2,
  label: 'vultr-dev',
  cloud: 'vultr',
  apps: [],
};

/** Build a ConnectionService test-double that hands out a fake ApiClient
 *  with just the methods the fleet handlers touch. */
function makeConnection(overrides: Partial<{
  servers: Server[];
  creds: (sid: number, aid: number) => Array<{ id: number; sys_user: string; password?: string }>;
  requireClientThrow: Error;
}> = {}) {
  const servers = overrides.servers ?? [SERVER_DO, SERVER_VULTR];
  const creds = overrides.creds ?? ((_s: number, _a: number) => [
    { id: 1, sys_user: 'master_abc', password: 'p@55w0rd' },
  ]);
  const apiClient = {
    listServers: vi.fn(async () => servers),
    getAppCreds: vi.fn(async (sid: number, aid: number) => creds(sid, aid)),
  };
  return {
    requireClient: () => {
      if (overrides.requireClientThrow) throw overrides.requireClientThrow;
      return apiClient as never;
    },
    _apiClient: apiClient,
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('IPC fleet handlers', () => {
  it('LIST_SERVERS returns flattened server summaries with app counts', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const conn = makeConnection();
    registerFleetHandlers({ addIpcAsyncListener, connection: conn as never });

    const res = await invoke<{ servers: Array<{ id: number; label: string; cloud: string; appCount: number }> }>(
      CHANNELS.LIST_SERVERS,
    );
    expect(res).toMatchObject({
      ok: true,
      data: {
        servers: [
          { id: 1, label: 'do-prod-1', cloud: 'do', appCount: 1, publicIp: '1.2.3.4' },
          { id: 2, label: 'vultr-dev', cloud: 'vultr', appCount: 0 },
        ],
      },
    });
  });

  it('LIST_SERVERS returns AUTH_INVALID when not connected', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const conn = makeConnection({
      requireClientThrow: new CloudwaysError('AUTH_INVALID', 'Not connected', { retriable: false }),
    });
    registerFleetHandlers({ addIpcAsyncListener, connection: conn as never });

    const res = await invoke<unknown>(CHANNELS.LIST_SERVERS);
    expect(res).toMatchObject({ ok: false, error: { code: 'AUTH_INVALID' } });
  });

  it('LIST_APPS validates serverId and returns app summaries', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const conn = makeConnection();
    registerFleetHandlers({ addIpcAsyncListener, connection: conn as never });

    const missing = await invoke<unknown>(CHANNELS.LIST_APPS, {});
    expect(missing).toMatchObject({ ok: false, error: { code: 'AUTH_INVALID' } });

    const notFound = await invoke<unknown>(CHANNELS.LIST_APPS, { serverId: 999 });
    expect(notFound).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });

    const ok = await invoke<{ apps: Array<{ id: number; label: string; isWordPress: boolean; serverId: number }> }>(
      CHANNELS.LIST_APPS,
      { serverId: 1 },
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      // Only WordPress apps are returned (non-WP apps are filtered out)
      expect(ok.data.apps).toEqual([
        expect.objectContaining({ id: 101, label: 'Blog', isWordPress: true, serverId: 1 }),
      ]);
    }
  });

  it('GET_APP projects SFTP + DB creds using the first app-creds record', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const conn = makeConnection();
    registerFleetHandlers({ addIpcAsyncListener, connection: conn as never });

    const res = await invoke<{
      app: {
        id: number;
        label: string;
        sftp: { host: string; user: string; password?: string };
        db: { name?: string; user?: string; password?: string };
        server: { id: number; cloud: string };
      };
    }>(CHANNELS.GET_APP, { serverId: 1, appId: 101 });

    expect(res).toMatchObject({
      ok: true,
      data: {
        app: {
          id: 101,
          label: 'Blog',
          sftp: { host: '1.2.3.4', user: 'master_abc', password: 'p@55w0rd' },
          db: { name: 'blog_db', user: 'blog_user', password: 'p@55w0rd' },
          server: { id: 1, cloud: 'do' },
        },
      },
    });
  });

  it('GET_APP tolerates empty app-creds (ssh-key-only apps)', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const conn = makeConnection({ creds: () => [] });
    registerFleetHandlers({ addIpcAsyncListener, connection: conn as never });

    const res = await invoke<{
      app: { sftp: { host: string; user: string; password?: string } };
    }>(CHANNELS.GET_APP, { serverId: 1, appId: 101 });

    if (!res.ok) throw new Error('expected ok');
    expect(res.data.app.sftp.password).toBeUndefined();
    expect(res.data.app.sftp.user).toBe('master_abc'); // falls back to App.sys_user
  });

  it('GET_APP returns OPERATION_FAILED for unknown ids', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const conn = makeConnection();
    registerFleetHandlers({ addIpcAsyncListener, connection: conn as never });

    const bad = await invoke<unknown>(CHANNELS.GET_APP, { serverId: 1, appId: 999 });
    expect(bad).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
  });
});
