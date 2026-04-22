import React from 'react';
import type { AddonRendererContext } from '@getflywheel/local/renderer';
import type { AddonSettingsItem, PreferencesSection } from '@getflywheel/local/renderer';
import type { Site } from '@getflywheel/local';
import { SiteToolsPanel } from './screens/SiteToolsPanel';
import { GlobalPreferencesPanel } from './screens/GlobalPreferencesPanel';

// Shape of a Local Tools-tab item, derived from the working contract
// used by @getflywheel/local-addon-backups (Cloud Backups).
type SiteToolsItem = {
  path: string;
  menuItem: string;
  render: (props: { site: Site }) => React.ReactElement;
};

// Registers every renderer-side hook exactly once.
//
// Local v10 exposes two surfaces we care about:
//   - `preferencesMenuItems`   → global CloudwaysSync tab in Local's
//     Preferences. Account-level "connect to Cloudways" lives here.
//   - `siteInfoToolsItem`      → per-site Tools tab. Surfaces site
//     status + (Phase 3+) the Cloudways-app mapping and pull/push.
export function registerHooks(context: AddonRendererContext): void {
  const { hooks } = context;

  hooks.addFilter('siteInfoToolsItem', (items: SiteToolsItem[]) => {
    return [
      ...items,
      {
        path: '/cloudwayssync',
        menuItem: 'CloudwaysSync',
        render: ({ site }: { site: Site }) => <SiteToolsPanel site={site} />,
      },
    ];
  });

  hooks.addFilter('preferencesMenuItems', (items: AddonSettingsItem[]) => {
    // Local expects either an FC or an array of PreferencesSections.
    // We render a single full-width section whose only row is our
    // panel; `name` is required on a row but hidden by setting it
    // empty so the panel gets the whole width.
    const sections: PreferencesSection[] = [
      {
        rows: {
          name: '',
          component: GlobalPreferencesPanel,
        },
      },
    ];
    return [
      ...items,
      {
        path: 'cloudwayssync',
        displayName: 'CloudwaysSync',
        sections,
        // The panel drives its own connect/disconnect — nothing to
        // apply in a batch. Local still renders the Apply button;
        // we make it harmless.
        onApply: () => {},
      },
    ];
  });
}
