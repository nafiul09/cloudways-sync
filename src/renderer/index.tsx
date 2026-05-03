// Cloudways Sync — Local add-on renderer entry.
//
// 1. Register official hooks (Preferences tab, per-site Tools tab).
// 2. Progressive enhancement: inject a sidebar icon + overlay panel.
//    Uses click-based show/hide (NOT hash routing) because Local's
//    router rejects unknown hashes with "Invalid Route".

import React from 'react';
import type { AddonRendererContext } from '@getflywheel/local/renderer';
import { registerHooks } from './hooks';
import { injectNavItem } from './sidebar/injectNavItem';
import { mountOverlay } from './sidebar/OverlayRoot';
import { CLOUDWAYSSYNC_ICON_SVG } from './sidebar/icon';
import { startSiteListIcons } from './sidebar/injectSiteListIcons';
import { mountSyncModal, openWizard } from './SyncModal';
import { injectFooterButtons } from './footer/injectFooterButtons';
import { GlobalDashboard } from './screens/GlobalDashboard';

// Local's Add-ons detail page crashes for non-marketplace addons because
// the GraphQL query returns null and Local calls .toString() on undefined.
// Redirect clicks on our addon's card to external GitHub pages instead.
function patchAddonCardLinks(): void {
  const REPO_URL = 'https://github.com/nafiul09/cloudways-sync';
  const AUTHOR_URL = 'https://github.com/nafiul09';

  // 1. Intercept clicks on our addon card that would navigate to the
  //    broken marketplace detail page (title link, icon, header area).
  document.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const card = el.closest?.('article[class*="MarketplaceCard"]');
    if (!card) return;
    // Check this is OUR addon's card by looking for our name in it
    const title = card.querySelector('a');
    if (title?.textContent?.trim() !== 'Cloudways Sync') return;
    // Allow clicks on the On/Off switch and context menu (right side)
    const footer = el.closest?.('div[class*="Card_Footer"]');
    if (footer) return;
    // Allow clicks on the author link we injected
    if ((el as any).dataset?.cwsAuthor !== undefined) return;
    // Everything else (icon, header, title link) → open repo
    const anchor = el.closest?.('a');
    if (anchor || el.closest?.('div[class*="Card_Header"]')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      require('electron').shell.openExternal(REPO_URL);
    }
  }, true);

  // 2. Make "nafiul09" author text clickable → open profile in browser
  const observer = new MutationObserver(() => {
    const subs = document.querySelectorAll<HTMLElement>(
      'article[class*="MarketplaceCard"] div[class*="Card_Content_Sub"]',
    );
    for (const sub of subs) {
      if ((sub as any).__cws_patched) continue;
      if (!sub.textContent?.includes('nafiul09')) continue;
      (sub as any).__cws_patched = true;
      const html = sub.innerHTML.replace(
        'nafiul09',
        `<a style="color:#51bb7b;cursor:pointer;text-decoration:none" data-cws-author>nafiul09</a>`,
      );
      sub.innerHTML = html;
      const link = sub.querySelector('[data-cws-author]');
      link?.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        require('electron').shell.openExternal(AUTHOR_URL);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export default function register(context: AddonRendererContext): void {
  patchAddonCardLinks();
  registerHooks(context);

  // Progressive-enhancement sidebar icon. Wrapped in try/catch: any
  // failure here must NOT break the official Preferences entry.
  try {
    const overlay = mountOverlay({
      render: () => React.createElement(GlobalDashboard),
    });

    const nav = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: CLOUDWAYSSYNC_ICON_SVG,
      onClick: () => {
        if (overlay.visible) {
          overlay.hide();
          nav.setActive(false);
        } else {
          overlay.show();
          nav.setActive(true);
        }
      },
      onDeactivate: () => overlay.hide(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Cloudways Sync] sidebar injection failed — using Preferences entry only.', err);
  }

  // Show Cloudways badge on linked sites in the site list.
  try {
    startSiteListIcons();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Cloudways Sync] site list icon injection failed.', err);
  }

  // Inject Push/Pull buttons into the site detail bottom bar.
  // The footer is self-sufficient: it caches mappings, detects the
  // current site from the URL, and replaces native pull/push buttons
  // immediately when that site is linked — independent of which tab
  // (Overview / Database / Tools / etc.) the user is on.
  try {
    injectFooterButtons({
      onLaunch: (ctx) => openWizard(ctx),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Cloudways Sync] footer injection failed.', err);
  }

  // Global sync progress modal — persists across navigation.
  mountSyncModal();
}
