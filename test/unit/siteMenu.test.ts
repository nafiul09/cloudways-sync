import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Site } from '@getflywheel/local';
import {
  buildMenuItems,
  clearMappingCache,
  siteInfoMoreMenuFilter,
  type SiteMapping,
  type SiteMenuItem,
} from '../../src/renderer/siteMenu';

// ipcAsync is stubbed via the test alias in vite.config.ts — see
// test/fixtures/localRendererMock.ts.

/** Minimal Site stub sufficient for menu generation. */
function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 'site-abc-123',
    name: 'My Test Site',
    domain: 'mytestsite.local',
    path: '/tmp/sites/my-test-site',
    ...overrides,
  } as Site;
}

function makeMapping(site: Site, overrides?: Partial<SiteMapping>): SiteMapping {
  return {
    localSiteId: site.id,
    serverId: 100,
    appId: 200,
    appLabel: 'My App',
    ...overrides,
  };
}

describe('buildMenuItems', () => {
  it('returns a separator + "Link to Cloudways" when no mapping exists', () => {
    const site = makeSite();
    const items = buildMenuItems(site, null);

    expect(items.length).toBe(2);
    expect(items[0]!.type).toBe('separator');
    expect(items[1]!.label).toBe('Link to Cloudways\u2026');
    expect(items[1]!.enabled).toBe(true);
  });

  it('returns push + pull items when mapped', () => {
    const site = makeSite();
    const items = buildMenuItems(site, makeMapping(site));

    const labels = items.map((i) => i.label).filter(Boolean);
    expect(labels).toContain('Push to Cloudways\u2026');
    expect(labels).toContain('Pull latest from Cloudways\u2026');
  });

  it('includes "Open on Cloudways" when mapping has remoteUrl', () => {
    const site = makeSite();
    const items = buildMenuItems(site, makeMapping(site, {
      remoteUrl: 'https://myapp-123456.cloudwaysapps.com',
    }));

    const openItem = items.find((i) => i.label?.includes('Open on Cloudways'));
    expect(openItem).toBeDefined();
    expect(openItem!.enabled).toBe(true);
  });

  it('omits "Open on Cloudways" when mapping has no remoteUrl', () => {
    const site = makeSite();
    const items = buildMenuItems(site, makeMapping(site));

    const openItem = items.find((i) => i.label?.includes('Open on Cloudways'));
    expect(openItem).toBeUndefined();
  });

  it('"Link to Cloudways" click handler does not throw', () => {
    const site = makeSite({ id: 'site-xyz' });
    const items = buildMenuItems(site, null);
    const linkItem = items.find((i) => i.label?.includes('Link to Cloudways'));

    expect(() => linkItem!.click!()).not.toThrow();
  });

  it('"Push to Cloudways" click handler does not throw', () => {
    const site = makeSite({ id: 'site-push' });
    const items = buildMenuItems(site, makeMapping(makeSite({ id: 'site-push' })));
    const pushItem = items.find((i) => i.label?.includes('Push to Cloudways'));

    expect(() => pushItem!.click!()).not.toThrow();
  });

  it('"Open on Cloudways" click opens the app URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const site = makeSite();
    const items = buildMenuItems(site, makeMapping(site, {
      remoteUrl: 'https://example.cloudwaysapps.com',
    }));
    const openItem = items.find((i) => i.label?.includes('Open on Cloudways'));

    openItem!.click!();
    expect(openSpy).toHaveBeenCalledWith('https://example.cloudwaysapps.com', '_blank');
    openSpy.mockRestore();
  });

  it('always starts with a separator', () => {
    const site = makeSite();

    const unmapped = buildMenuItems(site, null);
    expect(unmapped[0]!.type).toBe('separator');

    const mapped = buildMenuItems(site, makeMapping(site));
    expect(mapped[0]!.type).toBe('separator');
  });
});

describe('siteInfoMoreMenuFilter', () => {
  beforeEach(() => {
    clearMappingCache();
  });

  afterEach(() => {
    clearMappingCache();
  });

  it('appends items to the existing menu array', () => {
    const existing: SiteMenuItem[] = [
      { label: 'Open Site', enabled: true },
      { label: 'Delete', enabled: true },
    ];
    const site = makeSite();

    const result = siteInfoMoreMenuFilter(existing, site);

    // Original items are preserved.
    expect(result[0]!.label).toBe('Open Site');
    expect(result[1]!.label).toBe('Delete');
    // Cloudways Sync items appended after.
    expect(result.length).toBeGreaterThan(2);
    // First CWS item is a separator.
    expect(result[2]!.type).toBe('separator');
  });

  it('does not mutate the original array', () => {
    const existing: SiteMenuItem[] = [{ label: 'Existing' }];
    const site = makeSite();

    const result = siteInfoMoreMenuFilter(existing, site);

    expect(result).not.toBe(existing);
    expect(existing.length).toBe(1);
  });

  it('shows fallback "Link to Cloudways" when mapping cache is empty', () => {
    const site = makeSite();
    const result = siteInfoMoreMenuFilter([], site);

    const linkItem = result.find((i) => i.label?.includes('Link to Cloudways'));
    expect(linkItem).toBeDefined();
  });
});
