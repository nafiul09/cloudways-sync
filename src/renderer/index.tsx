// CloudwaysSync — Local add-on renderer entry.
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
import { mountSyncModal } from './SyncModal';
import { GlobalDashboard } from './screens/GlobalDashboard';

export default function register(context: AddonRendererContext): void {
  registerHooks(context);

  // Progressive-enhancement sidebar icon. Wrapped in try/catch: any
  // failure here must NOT break the official Preferences entry.
  try {
    const overlay = mountOverlay({
      render: () => React.createElement(GlobalDashboard),
    });

    const nav = injectNavItem({
      label: 'CloudwaysSync',
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
    console.warn('[CloudwaysSync] sidebar injection failed — using Preferences entry only.', err);
  }

  // Show Cloudways badge on linked sites in the site list.
  try {
    startSiteListIcons();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[CloudwaysSync] site list icon injection failed.', err);
  }

  // Global sync progress modal — persists across navigation.
  mountSyncModal();
}
