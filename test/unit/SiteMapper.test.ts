import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SiteMapper } from '../../src/main/sync/SiteMapper';
import type { ApiSiteMapping, SftpSiteMapping, SiteMapping } from '../../src/shared/ipcTypes';

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-mapper-test-'));
  tmpRoots.push(dir);
  return dir;
}

function makeMapping(overrides?: Partial<ApiSiteMapping>): ApiSiteMapping {
  return {
    linkMode: 'api',
    localSiteId: 'local-1',
    serverId: 1,
    appId: 100,
    appLabel: 'My WP App',
    remoteUrl: 'https://example.com',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSftpMapping(overrides?: Partial<SftpSiteMapping>): SftpSiteMapping {
  return {
    linkMode: 'sftp',
    localSiteId: 'local-sftp-1',
    appLabel: 'SFTP App',
    host: '203.0.113.10',
    port: 22,
    username: 'master_xyz',
    webRoot: '/home/master/applications/abcdef/public_html',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mappingFile(dir: string): string {
  return path.join(dir, 'cloudwayssync', 'site-mappings.json');
}

describe('SiteMapper', () => {
  it('returns null for unknown localSiteId', async () => {
    const mapper = new SiteMapper(tmpDir());
    const result = await mapper.get('nonexistent');
    expect(result).toBeNull();
  });

  it('persists and retrieves a mapping', async () => {
    const dir = tmpDir();
    const mapper = new SiteMapper(dir);
    const mapping = makeMapping();

    await mapper.set(mapping);
    const retrieved = await mapper.get('local-1');

    expect(retrieved).toEqual(mapping);
  });

  it('overwrites mapping for same localSiteId', async () => {
    const dir = tmpDir();
    const mapper = new SiteMapper(dir);

    await mapper.set(makeMapping({ appId: 100, appLabel: 'First App' }));
    await mapper.set(makeMapping({ appId: 200, appLabel: 'Second App' }));

    const retrieved = await mapper.get('local-1');
    expect(retrieved?.appId).toBe(200);
    expect(retrieved?.appLabel).toBe('Second App');

    // Only one mapping should exist
    const all = await mapper.list();
    expect(all).toHaveLength(1);
  });

  it('stores multiple different localSiteId mappings', async () => {
    const dir = tmpDir();
    const mapper = new SiteMapper(dir);

    await mapper.set(makeMapping({ localSiteId: 'site-a', appId: 100 }));
    await mapper.set(makeMapping({ localSiteId: 'site-b', appId: 200 }));

    const a = await mapper.get('site-a');
    const b = await mapper.get('site-b');
    expect(a?.appId).toBe(100);
    expect(b?.appId).toBe(200);

    const all = await mapper.list();
    expect(all).toHaveLength(2);
  });

  it('survives a fresh instance reading the same file', async () => {
    const dir = tmpDir();
    const mapper1 = new SiteMapper(dir);
    await mapper1.set(makeMapping({ appLabel: 'Persisted' }));

    // Create a new instance that reads the same file
    const mapper2 = new SiteMapper(dir);
    const retrieved = await mapper2.get('local-1');
    expect(retrieved?.appLabel).toBe('Persisted');
  });

  // --- SFTP-mode link mode tests ---

  it('persists and retrieves an SFTP mapping with linkMode discriminator', async () => {
    const mapper = new SiteMapper(tmpDir());
    const sftp = makeSftpMapping();
    await mapper.set(sftp);
    const got = await mapper.get(sftp.localSiteId);
    expect(got).toEqual(sftp);
    expect(got?.linkMode).toBe('sftp');
  });

  it('getByApp skips SFTP mappings (they have no serverId/appId)', async () => {
    const mapper = new SiteMapper(tmpDir());
    await mapper.set(makeMapping({ localSiteId: 'api-1', serverId: 7, appId: 700 }));
    await mapper.set(makeSftpMapping({ localSiteId: 'sftp-1' }));

    const apiHit = await mapper.getByApp(7, 700);
    expect(apiHit?.localSiteId).toBe('api-1');

    // SFTP mapping has no serverId; getByApp must not return it.
    const noHit = await mapper.getByApp(0, 0);
    expect(noHit).toBeNull();
  });

  it('delete with expected serverId/appId still removes SFTP mappings (filter is API-only)', async () => {
    const mapper = new SiteMapper(tmpDir());
    await mapper.set(makeSftpMapping({ localSiteId: 'sftp-1' }));
    const removed = await mapper.delete('sftp-1', { serverId: 999, appId: 999 });
    expect(removed).toBe(true);
  });

  it('migrates legacy records (no linkMode) to linkMode: api on read', async () => {
    const dir = tmpDir();
    await fs.promises.mkdir(path.join(dir, 'cloudwayssync'), { recursive: true });
    // Hand-write a legacy file: no linkMode field at all.
    const legacy = [
      {
        localSiteId: 'legacy-1',
        serverId: 5,
        appId: 555,
        appLabel: 'Legacy WP',
        remoteUrl: 'https://legacy.example.com',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];
    await fs.promises.writeFile(mappingFile(dir), JSON.stringify(legacy, null, 2), 'utf8');

    const mapper = new SiteMapper(dir);
    const got = await mapper.get('legacy-1');
    expect(got).not.toBeNull();
    expect(got?.linkMode).toBe('api');
    if (got?.linkMode === 'api') {
      expect(got.serverId).toBe(5);
      expect(got.appId).toBe(555);
    }
  });

  it('drops malformed legacy records that lack required fields', async () => {
    const dir = tmpDir();
    await fs.promises.mkdir(path.join(dir, 'cloudwayssync'), { recursive: true });
    const garbage = [
      { localSiteId: 'bad-1' /* missing serverId/appId */ },
      null,
      'not-an-object',
      { serverId: 1, appId: 2 /* missing localSiteId */ },
    ];
    await fs.promises.writeFile(mappingFile(dir), JSON.stringify(garbage), 'utf8');

    const mapper = new SiteMapper(dir);
    const all = await mapper.list();
    expect(all).toHaveLength(0);
  });

  it('preserves explicit linkMode: sftp on round-trip through disk', async () => {
    const dir = tmpDir();
    const mapper1 = new SiteMapper(dir);
    await mapper1.set(makeSftpMapping({ localSiteId: 'sftp-x' }));

    // Re-read the raw file: linkMode should be persisted as 'sftp'.
    const raw = await fs.promises.readFile(mappingFile(dir), 'utf8');
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(parsed[0]?.linkMode).toBe('sftp');

    const mapper2 = new SiteMapper(dir);
    const got = await mapper2.get('sftp-x');
    expect(got?.linkMode).toBe('sftp');
  });
});
