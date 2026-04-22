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
 * Mapping stored by `cs:getMapping`. When a Local site is linked to a
 * Cloudways app, this record exists.
 */
export interface SiteMapping {
  siteId: string;
  serverId: number;
  appId: number;
  appFqdn?: string;
}

/**
 * Attempts to fetch the Cloudways mapping for a Local site. Returns
 * `null` if no mapping exists or the IPC handler isn't wired yet
 * (Phase 5+ may not be shipped). Failures are swallowed — the menu
 * must never break Local.
 */
async function fetchMapping(siteId: string): Promise<SiteMapping | null> {
  try {
    const result = await ipcAsync(CHANNELS.GET_MAPPING, { siteId });
    if (result?.ok && result.data) return result.data as SiteMapping;
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
        // Navigate to the site's CloudwaysSync Tools tab where the
        // push flow lives. For v0.1.0 this uses Local's hash router.
        window.location.hash = `#/site-info/${site.id}/tools/cloudwayssync`;
      },
    });

    items.push({
      label: 'Pull latest from Cloudways\u2026',
      enabled: true,
      click: () => {
        window.location.hash = `#/site-info/${site.id}/tools/cloudwayssync`;
      },
    });

    if (mapping.appFqdn) {
      items.push({
        label: 'Open on Cloudways \u2197',
        enabled: true,
        click: () => {
          const url = `https://${mapping.appFqdn}`;
          window.open(url, '_blank');
        },
      });
    }
  } else {
    items.push({
      label: 'Link to Cloudways\u2026',
      enabled: true,
      click: () => {
        // Open the per-site Tools → CloudwaysSync tab where the user
        // can pick a Cloudways app to link.
        window.location.hash = `#/site-info/${site.id}/tools/cloudwayssync`;
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
