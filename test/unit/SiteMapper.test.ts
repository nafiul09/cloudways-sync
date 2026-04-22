import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SiteMapper } from '../../src/main/sync/SiteMapper';
import type { SiteMapping } from '../../src/shared/ipcTypes';

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

function makeMapping(overrides?: Partial<SiteMapping>): SiteMapping {
  return {
    localSiteId: 'local-1',
    serverId: 1,
    appId: 100,
    appLabel: 'My WP App',
    remoteUrl: 'https://example.com',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
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
});
