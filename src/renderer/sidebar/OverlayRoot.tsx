import React from 'react';
import ReactDOM from 'react-dom';

// Full-page content overlay for the Cloudways Sync dashboard.
//
// Positioned fixed to the right of Local's 70px sidebar rail, on top
// of the main content area. Visibility is driven by explicit
// show()/hide() calls — NOT by hash routing, because Local's router
// rejects unknown hashes with an "Invalid Route" dialog.
//
// Z-index strategy: our overlay uses a low z-index (5) and we
// inject a one-time stylesheet that boosts `#Sidebar` above us so
// that hover tooltips on Local's sidebar icons render *over* our
// overlay instead of being clipped underneath it.
//
// Local ships React 16.14 at runtime, so we use the legacy
// `ReactDOM.render` API (not `createRoot` from `react-dom/client`).

export type OverlayOptions = {
  /** Width of Local's primary sidebar in pixels (rail). */
  sidebarWidth?: number;
  render: () => React.ReactElement;
};

export type OverlayHandle = {
  show: () => void;
  hide: () => void;
  readonly visible: boolean;
  dispose: () => void;
};

const DEFAULT_SIDEBAR_WIDTH = 70;
const STYLE_ID = 'CloudwaysSync-OverlayStyle';

function injectStackingStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Boost the sidebar above our overlay so hover tooltips on sidebar
  // icons (rendered as descendants of #Sidebar) render over our
  // overlay instead of being clipped underneath.
  style.textContent = `
    #Sidebar { position: relative; z-index: 100; }
  `;
  document.head.appendChild(style);
}

export function mountOverlay(opts: OverlayOptions): OverlayHandle {
  injectStackingStyle();

  const host = document.createElement('div');
  host.id = 'CloudwaysSync-OverlayRoot';
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    // Shift 1px left (and therefore 1px wider overall) to cover a
    // hairline seam between Local's sidebar rail and our overlay.
    left: `${(opts.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH) - 1}px`,
    right: '0',
    bottom: '0',
    zIndex: '50',
    display: 'none',
    overflow: 'auto',
    // Main content surface color for Local's dark theme. Elevated
    // UI on top (cards, inner sidebars, etc.) uses #262727.
    background: '#303031',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(host);

  ReactDOM.render(React.createElement(React.Fragment, null, opts.render()), host);

  let isVisible = false;

  return {
    show() {
      host.style.display = 'block';
      isVisible = true;
    },
    hide() {
      host.style.display = 'none';
      isVisible = false;
    },
    get visible() {
      return isVisible;
    },
    dispose() {
      ReactDOM.unmountComponentAtNode(host);
      host.remove();
    },
  };
}
