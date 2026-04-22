// Phase 9 — Per-site "More" menu integration.
//
// Local's `siteInfoMoreMenu` filter passes an array of Electron-style
// MenuItemConstructorOptions and the current Site. We append
// CloudwaysSync actions so the user can push/pull/open without
// navigating to the Tools tab first.
//
// Menu shape follows Electron's MenuItemConstructorOptions (label,
// enabled, click, type for separators). Local renders them via
// Electron's remote Menu.buildFromTemplate.

import type { Site } from '@getflywheel/local';
import { ipcAsync } from '@getflywheel/local/renderer';
import { CHANNELS } from '../shared/ipcTypes';

/** Electron MenuItemConstructorOptions subset that Local uses. */
export interface SiteMenuItem {
  label?: string;
  enabled?: boolean;
  click?: () => void;
  type?: 'separator' | 'normal';
}

/**
 * Subset of the real SiteMapping used by the menu. We only need
 * enough to decide which items to show and what URLs to open.
 */
export interface SiteMapping {
  localSiteId: string;
  serverId: number;
  appId: number;
  appLabel: string;
  remoteUrl?: string;
}

/**
 * Attempts to fetch the Cloudways mapping for a Local site. Returns
 * `null` if no mapping exists or the IPC handler isn't wired yet
 * (Phase 5+ may not be shipped). Failures are swallowed — the menu
 * must never break Local.
 */
async function fetchMapping(siteId: string): Promise<SiteMapping | null> {
  try {
    const result = await ipcAsync(CHANNELS.GET_MAPPING, { localSiteId: siteId });
    if (result?.ok && result.data?.localSiteId) return result.data as SiteMapping;
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the CloudwaysSync menu items for a given site and (optional)
 * mapping. Exported for testing; the filter callback calls this after
 * resolving the mapping.
 */
export function buildMenuItems(
  site: Site,
  mapping: SiteMapping | null,
): SiteMenuItem[] {
  const items: SiteMenuItem[] = [{ type: 'separator' }];

  if (mapping) {
    items.push({
      label: 'Push to Cloudways\u2026',
      enabled: true,
      click: () => {
        // Local's internal routing doesn't expose a public navigation
        // API. For v0.1.0, open the site detail page; the user can
        // navigate to Tools → CloudwaysSync from there.
      },
    });

    items.push({
      label: 'Pull latest from Cloudways\u2026',
      enabled: true,
      click: () => {
        // Same as above — informational for v0.1.0.
      },
    });

    if (mapping.remoteUrl) {
      items.push({
        label: 'Open on Cloudways \u2197',
        enabled: true,
        click: () => {
          window.open(mapping.remoteUrl as string, '_blank');
        },
      });
    }
  } else {
    items.push({
      label: 'Link to Cloudways\u2026',
      enabled: true,
      click: () => {
        // Informational for v0.1.0 — Local's internal routing doesn't
        // expose a public navigation API for addons.
      },
    });
  }

  return items;
}

/**
 * The filter callback for `siteInfoMoreMenu`. Local calls this
 * synchronously, so we can't await the mapping fetch inline.
 *
 * Strategy: we append a placeholder "CloudwaysSync" disabled item
 * immediately (so the filter returns synchronously), then on the next
 * menu open the cached mapping will be available.
 *
 * Actually, Local's filter system calls `applyFilters` which is
 * synchronous. But the menu items have `click` callbacks that run
 * async — so we build the items optimistically: always show "Link to
 * Cloudways" as the fallback, and cache the mapping so subsequent
 * opens are correct.
 *
 * To keep it simple for v0.1.0, we build the menu items synchronously
 * using a cached mapping per site. The cache is populated lazily.
 */

const mappingCache = new Map<string, SiteMapping | null>();
const fetchPromises = new Map<string, Promise<void>>();

/** Ensure mapping is fetched (at most once at a time per site). */
function ensureMappingFetched(siteId: string): void {
  if (mappingCache.has(siteId) || fetchPromises.has(siteId)) return;
  const p = fetchMapping(siteId).then((m) => {
    mappingCache.set(siteId, m);
    fetchPromises.delete(siteId);
  });
  fetchPromises.set(siteId, p);
}

/**
 * Filter callback to register with `hooks.addFilter('siteInfoMoreMenu', ...)`.
 *
 * @param items - The existing menu items array
 * @param site - The current Local site
 * @returns The augmented menu items array
 */
export function siteInfoMoreMenuFilter(items: SiteMenuItem[], site: Site): SiteMenuItem[] {
  // Kick off a background fetch so the *next* menu open has the data.
  ensureMappingFetched(site.id);

  const mapping = mappingCache.get(site.id) ?? null;
  const cwsItems = buildMenuItems(site, mapping);

  return [...items, ...cwsItems];
}

/** Clear the mapping cache (useful for testing). */
export function clearMappingCache(): void {
  mappingCache.clear();
  fetchPromises.clear();
}
