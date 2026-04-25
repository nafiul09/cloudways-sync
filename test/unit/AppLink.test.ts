import { describe, it, expect } from 'vitest';
import {
  ApiAppLink,
  SftpAppLink,
  appLinkFor,
  type AppLink,
} from '../../src/main/sync/AppLink';
import type { ApiClient } from '../../src/main/cloudways/ApiClient';
import type { Server, App } from '../../src/main/cloudways/schemas';
import type { AppPasswordStore, SftpCredentialStore } from '../../src/main/credentials';
import { RemoteError } from '../../src/main/remote/errors';
import type { ApiSiteMapping, SftpSiteMapping } from '../../src/shared/ipcTypes';

// --- Fixtures -----------------------------------------------------------

const TEST_SERVER: Server = {
  id: 1,
  label: 'TestServer',
  cloud: 'do',
  public_ip: '203.0.113.10',
  server_fqdn: 'cw-test.cloudwaysapps.com',
  master_user: 'master',
  apps: [],
  // Other fields the schema may carry are tolerated by the type cast.
} as unknown as Server;

const TEST_APP: App = {
  id: 100,
  label: 'WP App',
  application: 'wordpress',
  app_version: '6.4',
  app_fqdn: 'wp-100.cloudwaysapps.com',
  sys_user: 'abcdef',
  cname: null,
  mysql_db_name: 'db_abcdef',
  mysql_user: 'user_abcdef',
} as unknown as App;

function apiMapping(overrides: Partial<ApiSiteMapping> = {}): ApiSiteMapping {
  return {
    linkMode: 'api',
    localSiteId: 'local-1',
    serverId: 1,
    appId: 100,
    appLabel: 'WP App',
    remoteUrl: 'https://wp.example.com',
    createdAt: '2026-04-25T00:00:00Z',
    ...overrides,
  };
}

function sftpMapping(overrides: Partial<SftpSiteMapping> = {}): SftpSiteMapping {
  return {
    linkMode: 'sftp',
    localSiteId: 'local-2',
    appLabel: 'SFTP WP App',
    host: '203.0.113.20',
    port: 22,
    username: 'master_xyz',
    webRoot: '/home/master/applications/zzz/public_html',
    createdAt: '2026-04-25T00:00:00Z',
    ...overrides,
  };
}

// --- ApiAppLink ---------------------------------------------------------

function fakeClient(opts: {
  servers?: Server[];
  appCreds?: Array<{ sys_user: string; password: string }>;
} = {}): ApiClient {
  const servers = opts.servers ?? [{ ...TEST_SERVER, apps: [TEST_APP] } as Server];
  const creds = opts.appCreds ?? [{ sys_user: 'abcdef', password: 'secret-pw' }];
  return {
    listServers: async () => servers,
    getAppCreds: async () => creds,
    triggerAppBackup: async () => 12345,
    restoreApp: async () => 67890,
    purgeVarnish: async () => ({ ok: true }),
  } as unknown as ApiClient;
}

describe('ApiAppLink', () => {
  it('resolve() returns auth + webRoot from server/app/creds', async () => {
    const link = new ApiAppLink(apiMapping(), fakeClient());
    const ctx = await link.resolve();
    expect(ctx.auth.host).toBe('203.0.113.10');
    expect(ctx.auth.username).toBe('abcdef');
    expect(ctx.auth.password).toBe('secret-pw');
    expect(ctx.webRoot).toBe('/home/master/applications/abcdef/public_html');
    expect(ctx.api?.app.id).toBe(100);
  });

  it('falls back to AppPasswordStore when API returns no password', async () => {
    const client = fakeClient({ appCreds: [{ sys_user: 'abcdef', password: '' }] });
    const store: Pick<AppPasswordStore, 'get'> = {
      get: async () => 'stored-pw',
    };
    const link = new ApiAppLink(apiMapping(), client, store as AppPasswordStore);
    const ctx = await link.resolve();
    expect(ctx.auth.password).toBe('stored-pw');
  });

  it('throws SSH_AUTH_FAILED when no password is available anywhere', async () => {
    const client = fakeClient({ appCreds: [{ sys_user: 'abcdef', password: '' }] });
    const link = new ApiAppLink(apiMapping(), client);
    await expect(link.resolve()).rejects.toBeInstanceOf(RemoteError);
    await expect(link.resolve()).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('throws SSH_COMMAND_FAILED when serverId is unknown', async () => {
    const link = new ApiAppLink(
      apiMapping({ serverId: 999 }),
      fakeClient(),
    );
    await expect(link.resolve()).rejects.toMatchObject({ code: 'SSH_COMMAND_FAILED' });
  });

  it('exposes triggerRemoteBackup / restoreFromRemoteBackup / purgeVarnish in API mode', () => {
    const link = new ApiAppLink(apiMapping(), fakeClient());
    expect(typeof link.triggerRemoteBackup).toBe('function');
    expect(typeof link.restoreFromRemoteBackup).toBe('function');
    expect(typeof link.purgeVarnish).toBe('function');
  });

  it('triggerRemoteBackup returns the operation id from the API client', async () => {
    const link = new ApiAppLink(apiMapping(), fakeClient());
    const out = await link.triggerRemoteBackup();
    expect(out.operationId).toBe(12345);
  });
});

// --- SftpAppLink --------------------------------------------------------

function fakeSftpStore(password: string | undefined): SftpCredentialStore {
  return {
    get: async () => password,
  } as unknown as SftpCredentialStore;
}

describe('SftpAppLink', () => {
  it('resolve() returns auth + webRoot pulled straight from the mapping', async () => {
    const link = new SftpAppLink(sftpMapping(), fakeSftpStore('sftp-pw'));
    const ctx = await link.resolve();
    expect(ctx.auth.host).toBe('203.0.113.20');
    expect(ctx.auth.port).toBe(22);
    expect(ctx.auth.username).toBe('master_xyz');
    expect(ctx.auth.password).toBe('sftp-pw');
    expect(ctx.webRoot).toBe('/home/master/applications/zzz/public_html');
    expect(ctx.api).toBeUndefined();
  });

  it('throws SSH_AUTH_FAILED when no password is stored', async () => {
    const link = new SftpAppLink(sftpMapping(), fakeSftpStore(undefined));
    await expect(link.resolve()).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('throws SSH_COMMAND_FAILED when the mapping has no webRoot', async () => {
    const link = new SftpAppLink(sftpMapping({ webRoot: undefined }), fakeSftpStore('pw'));
    await expect(link.resolve()).rejects.toMatchObject({ code: 'SSH_COMMAND_FAILED' });
  });

  it('does NOT expose API-only methods (so callers branch off cleanly)', () => {
    const link: AppLink = new SftpAppLink(sftpMapping(), fakeSftpStore('pw'));
    expect(link.triggerRemoteBackup).toBeUndefined();
    expect(link.restoreFromRemoteBackup).toBeUndefined();
    expect(link.purgeVarnish).toBeUndefined();
  });
});

// --- Factory dispatch ---------------------------------------------------

describe('appLinkFor', () => {
  it('returns ApiAppLink for API mappings (when client provided)', () => {
    const link = appLinkFor(apiMapping(), { client: fakeClient() });
    expect(link.mode).toBe('api');
    expect(link).toBeInstanceOf(ApiAppLink);
  });

  it('returns SftpAppLink for SFTP mappings (when sftpCreds provided)', () => {
    const link = appLinkFor(sftpMapping(), { sftpCreds: fakeSftpStore('pw') });
    expect(link.mode).toBe('sftp');
    expect(link).toBeInstanceOf(SftpAppLink);
  });

  it('throws when API mapping is given but no client was provided', () => {
    expect(() => appLinkFor(apiMapping(), {})).toThrow(/API client is required/);
  });

  it('throws when SFTP mapping is given but no sftpCreds were provided', () => {
    expect(() => appLinkFor(sftpMapping(), {})).toThrow(/SFTP credential store is required/);
  });
});
