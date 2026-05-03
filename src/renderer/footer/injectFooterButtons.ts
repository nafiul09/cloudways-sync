// Self-sufficient overlay of Local's #SiteInfoConnect footer (which
// holds the native Pull/Push buttons) for sites that are linked to
// Cloudways. Native content is NEVER destroyed — we side-by-side our
// own row and toggle visibility via a CSS attribute, so unlinking or
// switching to a non-linked site cleanly reveals the originals.
//
// Key behaviour:
//   * Detects the current site from data-location on the root <Window>
//     div (path is /main/site-info/<siteId>/...).
//   * Caches all linked mappings via ipcClient.listMappings(); refreshed
//     periodically and on-demand.
//   * If the current site is linked AND #SiteInfoConnect exists:
//       - append our row (data-cws-fb="root") if not already present;
//       - set data-cws-active="1" on the container so our CSS rule
//         hides every other child (the natives).
//   * If the current site is NOT linked:
//       - remove data-cws-active so natives re-appear immediately;
//       - remove our row so it doesn't linger invisibly.
//   * A MutationObserver watches document.body so:
//       - navigating to a different site updates the footer instantly;
//       - if Local's React reconciliation removes our extra row, we
//         re-append it.
//   * Click handlers look up the cached mapping and the local site
//     (via ipcClient.getLocalSite) to build a full WizardLaunchContext,
//     then call the onLaunch callback supplied by the caller.

import { ipcClient } from '../ipcClient';
import type { SiteMapping } from '../../shared/ipcTypes';

const MARKER = 'data-cws-fb';
const ROOT_MARK = `[${MARKER}="root"]`;

// Cloud-with-down-arrow (download → Pull) and cloud-with-up-arrow (upload → Push).
// Stroke icons inherit the button's currentColor so they recolor on hover.
// Tray + arrow icons (download = arrow into tray, upload = arrow out of tray).
// Push reuses the same paths but rotates the arrow 180° around its center
// (12, 9.355) so the tray stays at the bottom while the arrow points up.
const TRAY_PATH = `<path d="M2.24994 19.2501V16.7501C2.24994 16.1978 2.69765 15.7501 3.24994 15.7501C3.80222 15.7501 4.24994 16.1978 4.24994 16.7501V19.2501C4.24994 19.5262 4.4738 19.7501 4.74994 19.7501H19.2499C19.5261 19.7501 19.7499 19.5262 19.7499 19.2501V16.7501C19.7499 16.1978 20.1977 15.7501 20.7499 15.7501C21.3022 15.7501 21.7499 16.1978 21.7499 16.7501V19.2501C21.7499 20.5444 20.7663 21.6092 19.5058 21.7374L19.2499 21.7501H4.74994C3.36923 21.7501 2.24994 20.6308 2.24994 19.2501Z" fill="currentColor"/>`;
const ARROW_PATH = `<path d="M11 3.25006C11 2.69778 11.4477 2.25006 12 2.25006C12.5522 2.25006 13 2.69778 13 3.25006V13.336L15.7929 10.543C16.1834 10.1525 16.8165 10.1525 17.207 10.543C17.5975 10.9336 17.5975 11.5666 17.207 11.9571L12.707 16.4571C12.3165 16.8476 11.6834 16.8476 11.2929 16.4571L6.79292 11.9571C6.4024 11.5666 6.4024 10.9336 6.79292 10.543C7.15904 10.1769 7.73804 10.1543 8.13081 10.4747L8.20699 10.543L11 13.336V3.25006Z" fill="currentColor"/>`;
const PULL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">${TRAY_PATH}${ARROW_PATH}</svg>`;
const PUSH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">${TRAY_PATH}<g transform="rotate(180 12 9.355)">${ARROW_PATH}</g></svg>`;
const STYLES = `
  /* When the site is linked, hide all native children of #SiteInfoConnect
     except our injected row. When not linked, attribute is absent so
     everything renders normally. */
  #SiteInfoConnect[data-cws-active="1"] > *:not([${MARKER}="root"]) {
    display: none !important;
  }
  .cws-fb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
  }
  /* Mirrors the <Button> component in components/ui.tsx — green
     outline pill, hover fills green. */
  .cws-fb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: transparent;
    border: 2px solid #51bb7b;
    border-radius: 500px;
    color: #51bb7b;
    font-size: 13px;
    font-weight: 700;
    font-family: inherit;
    line-height: 1.3;
    cursor: pointer !important;
    text-transform: none;
    white-space: nowrap;
    transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease, transform 0.1s ease;
  }
  .cws-fb-btn:hover {
    background: #51bb7b;
    color: #ffffff;
    border-color: #51bb7b;
  }
  .cws-fb-btn:active {
    background: #419564;
    border-color: #419564;
    color: #ffffff;
    transform: scale(0.98);
  }
  .cws-fb-btn:disabled {
    color: var(--cws-text-tertiary);
    border-color: var(--cws-text-tertiary);
    background: transparent;
    cursor: not-allowed !important;
  }
  .cws-fb-btn,
  .cws-fb-btn * {
    cursor: pointer !important;
  }
  .cws-fb-btn:disabled,
  .cws-fb-btn:disabled * {
    cursor: not-allowed !important;
  }
  .cws-fb-btn svg,
  .cws-fb-btn span { pointer-events: none; }
`;

function buildReplacementHTML(): string {
  return `
    <div class="cws-fb-row" ${MARKER}="root">
      <button type="button" class="cws-fb-btn" ${MARKER}="pull">
        ${PULL_ICON_SVG}
        <span>Pull from Cloudways</span>
      </button>
      <button type="button" class="cws-fb-btn" ${MARKER}="push">
        ${PUSH_ICON_SVG}
        <span>Push to Cloudways</span>
      </button>
    </div>
  `;
}

/** Read the current site id from <div data-location="/main/site-info/<id>/..."> */
function getCurrentSiteId(): string | null {
  const root = document.querySelector('[data-location]');
  if (!root) return null;
  const loc = root.getAttribute('data-location') ?? '';
  const match = loc.match(/\/main\/site-info\/([^/]+)/);
  return match && match[1] ? match[1] : null;
}

export type WizardLaunchContext = {
  mode: 'push' | 'pull';
  appLabel: string;
  siteId: string;
  localUrl: string;
  webRootPath: string;
  remoteUrl?: string;
  linkMode: 'api' | 'sftp';
  serverId?: number;
  appId?: number;
};

export type FooterInjectionHandle = {
  dispose: () => void;
  /** Force-refresh the linked-mappings cache (call after map/unmap). */
  refresh: () => void;
};

export function injectFooterButtons(opts: {
  onLaunch: (ctx: WizardLaunchContext) => void;
}): FooterInjectionHandle {
  let disposed = false;
  let pending = false;
  let observer: MutationObserver | null = null;
  const mappingsBySiteId = new Map<string, SiteMapping>();
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Inject our styles once into <head> (out of React's reach)
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-cloudwayssync', 'footer');
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);

  async function refreshMappings(): Promise<void> {
    try {
      const { mappings } = await ipcClient.listMappings();
      mappingsBySiteId.clear();
      for (const m of mappings) mappingsBySiteId.set(m.localSiteId, m);
      applyState();
    } catch {
      // non-fatal — keep using whatever we had
    }
  }

  async function launch(mode: 'push' | 'pull'): Promise<void> {
    const siteId = getCurrentSiteId();
    if (!siteId) return;
    const mapping = mappingsBySiteId.get(siteId);
    if (!mapping) return;

    let localUrl = '';
    let webRootPath = '';
    try {
      const { site } = await ipcClient.getLocalSite({ localSiteId: siteId });
      if (site) {
        localUrl = site.url;
        webRootPath = site.webRootPath;
      }
    } catch {
      // best-effort
    }

    const ctx: WizardLaunchContext = mapping.linkMode === 'api'
      ? {
          mode,
          appLabel: mapping.appLabel,
          siteId,
          localUrl,
          webRootPath,
          remoteUrl: mapping.remoteUrl,
          linkMode: 'api',
          serverId: mapping.serverId,
          appId: mapping.appId,
        }
      : {
          mode,
          appLabel: mapping.appLabel,
          siteId,
          localUrl,
          webRootPath,
          remoteUrl: mapping.remoteUrl,
          linkMode: 'sftp',
        };

    opts.onLaunch(ctx);
  }

  function attachHandlers(container: HTMLElement) {
    const pullBtn = container.querySelector<HTMLButtonElement>(`[${MARKER}="pull"]`);
    const pushBtn = container.querySelector<HTMLButtonElement>(`[${MARKER}="push"]`);
    pullBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void launch('pull');
    });
    pushBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void launch('push');
    });
  }

  function applyState() {
    if (disposed) return;

    const container = document.querySelector<HTMLElement>('#SiteInfoConnect');
    if (!container) return;

    const siteId = getCurrentSiteId();
    const linked = !!siteId && mappingsBySiteId.has(siteId);

    if (linked) {
      // Side-by-side strategy:
      //   1. Append our row alongside (not replacing) Local's native
      //      pull/push buttons.
      //   2. Set [data-cws-active="1"] so our CSS hides the natives.
      // We never destroy native content — toggling the attribute is
      // enough to swap visibility, and a later un-link cleanly reveals
      // the original buttons (which still have their React handlers).
      if (!container.querySelector(ROOT_MARK)) {
        const tmp = document.createElement('div');
        tmp.innerHTML = buildReplacementHTML();
        const row = tmp.firstElementChild;
        if (row) {
          container.appendChild(row);
          attachHandlers(container);
        }
      }
      container.setAttribute('data-cws-active', '1');
    } else {
      // Not linked: drop the active flag so native buttons show again,
      // and remove our row so it doesn't sit there invisibly.
      container.removeAttribute('data-cws-active');
      container.querySelector(ROOT_MARK)?.remove();
    }
  }

  function startObserving() {
    if (observer || disposed) return;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        applyState();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Initial: load mappings, then start observing
  void refreshMappings();
  startObserving();
  // Periodic safety refresh in case mappings change in another window/process
  refreshTimer = setInterval(refreshMappings, 10_000);

  return {
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      observer = null;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      styleEl.remove();
      document.querySelectorAll(ROOT_MARK).forEach((el) => el.remove());
    },
    refresh: () => { void refreshMappings(); },
  };
}
