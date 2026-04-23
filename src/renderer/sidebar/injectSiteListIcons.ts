// Injects a small Cloudways icon next to site names in Local's sidebar
// site list for sites that are linked to a Cloudways app via CloudwaysSync.
//
// Uses a MutationObserver to handle dynamic site list changes (accordion
// expand/collapse, drag-reorder, site creation/deletion).

import { ipcClient } from '../ipcClient';

// Compact 14x14 version of the Cloudways glyph for inline use.
const CW_BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 512 512"
  fill="#51bb7b" fill-rule="evenodd" clip-rule="evenodd"
  stroke-linejoin="round" stroke-miterlimit="2" aria-hidden="true">
  <path d="M171.296 275.979H18.344C11.654 275.979 6 270.407 6 263.87c0-6.56 5.653-12.107 12.344-12.107h162.364c7.034-12.345 16.943-22.892 28.838-30.775H84.38c-6.666 0-12.336-5.572-12.336-12.108 0-6.544 5.67-12.107 12.336-12.107h152.495c3.815-11.241 9.55-21.625 16.813-30.775H108.07c-6.69 0-12.344-5.539-12.344-12.107 0-6.536 5.653-12.108 12.344-12.108h172.951c16.193-9.959 35.342-15.71 55.856-15.71 51.167 0 93.828 35.767 103.42 83.208 37.98 11.004 65.7 45.488 65.7 86.328 0 49.737-41.06 90.021-91.72 90.021h-.32v.294H94.396c-6.682 0-12.328-5.522-12.328-12.099 0-6.544 5.646-12.115 12.328-12.115h104.163c-9.411-8.546-17-19.003-22.115-30.75l-19.68.007c-3.996 0-7.01-2.957-7.01-6.887v-10.138c0-3.922 3.006-6.87 7.01-6.87h13.079a88.563 88.563 0 01-.735-11.463c0-6.74.751-13.316 2.19-19.631zm-60.235 54.99H21.988c-3.995 0-6.985-2.958-6.985-6.888v-10.138c0-3.922 2.99-6.87 6.985-6.87h88.747c3.995 0 7.01 2.948 7.01 6.87v10.138c.318 3.62-3.015 6.887-6.684 6.887z"/>
</svg>`;

const BADGE_ATTR = 'data-cws-linked';

let linkedSiteIds = new Set<string>();

async function refreshMappings(): Promise<void> {
  try {
    const { mappings } = await ipcClient.listMappings();
    linkedSiteIds = new Set(mappings.map((m) => m.localSiteId));
  } catch {
    // Non-fatal — keep using whatever we had.
  }
}

function injectBadges(): void {
  const siteLinks = document.querySelectorAll<HTMLAnchorElement>('a.TID_SiteListSite[data-site-id]');
  for (const link of siteLinks) {
    const siteId = link.getAttribute('data-site-id');
    if (!siteId) continue;

    const isLinked = linkedSiteIds.has(siteId);
    const hasBadge = link.hasAttribute(BADGE_ATTR);

    if (isLinked && !hasBadge) {
      const badge = document.createElement('span');
      badge.innerHTML = CW_BADGE_SVG;
      badge.title = 'Linked to Cloudways';
      badge.style.cssText = 'display:inline-flex;align-items:center;margin-left:auto;flex-shrink:0;opacity:0.8;';
      link.appendChild(badge);
      link.setAttribute(BADGE_ATTR, '1');
    } else if (!isLinked && hasBadge) {
      const badge = link.querySelector(`[title="Linked to Cloudways"]`);
      badge?.remove();
      link.removeAttribute(BADGE_ATTR);
    }
  }
}

/** Refresh mappings from disk and update badges. Exported so callers
 *  (e.g. after mapSite / unmapSite) can trigger an immediate update. */
export function refreshSiteListIcons(): void {
  refreshMappings().then(injectBadges);
}

/**
 * Start observing the site list and inject Cloudways icons for linked sites.
 * Call once from the renderer entry point.
 */
export function startSiteListIcons(): void {
  // Initial load.
  refreshSiteListIcons();

  // Watch for DOM changes in the site list (accordion, drag, new sites).
  const observer = new MutationObserver(() => {
    injectBadges();
  });

  const tryObserve = () => {
    const siteList = document.getElementById('SiteList');
    if (siteList) {
      observer.observe(siteList, { childList: true, subtree: true });
      injectBadges();
      return true;
    }
    return false;
  };

  if (!tryObserve()) {
    // Site list might not be in DOM yet — wait for it.
    const boot = new MutationObserver(() => {
      if (tryObserve()) boot.disconnect();
    });
    boot.observe(document.body, { childList: true, subtree: true });
  }
}
