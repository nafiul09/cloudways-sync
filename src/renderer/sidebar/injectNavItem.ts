// Runtime DOM injection of a Cloudways Sync nav item into Local's
// primary left-rail sidebar.
//
// Important: Local v10 does NOT expose an official hook for adding
// items to its primary sidebar. This module monkey-patches the DOM:
//
//   1. Wait for `#Sidebar` to appear.
//   2. Clone an existing nav item so we inherit Local's hashed
//      CSS-module class names verbatim.
//   3. Mutate the clone: swap tooltip text, aria-label, icon.
//   4. Insert into the nav at a stable anchor (before the Support item).
//   5. Wire a click handler — we do NOT use hash routing because
//      Local's router rejects unknown hashes with "Invalid Route".
//
// If any step fails we log a warning. The caller falls back to
// the Preferences menu which always works.

export type SidebarInjectionHandle = {
  element: HTMLElement;
  /** Mark the icon as visually active (like a selected sidebar item). */
  setActive: (active: boolean) => void;
  dispose: () => void;
};

export type InjectNavItemOptions = {
  /** Tooltip text + aria-label shown on hover. */
  label: string;
  /** Raw <svg>…</svg> markup used as the icon. */
  iconSvg: string;
  /** Called when the user clicks our nav item. */
  onClick: () => void;
  /**
   * Called when the user clicks any *other* sidebar nav item
   * (including re-clicking the previously-active one). Use this to
   * hide the overlay panel since hashchange may not fire for
   * same-route clicks.
   */
  onDeactivate?: () => void;
  /**
   * CSS selector (inside `#Sidebar`) of the nav item to clone for
   * styling. Its parent FlyTooltip_Container wrapper is cloned.
   */
  templateSelector?: string;
  /**
   * CSS selector (inside `#Sidebar`) of the item we want to insert
   * *before*. Defaults to the Support link.
   */
  insertBeforeSelector?: string;
};

const DEFAULT_TEMPLATE = 'a[href^="#/main/blueprints"]';
const DEFAULT_ANCHOR = 'a[href^="#/main/support"]';
const MARKER_ATTR = 'data-cloudwayssync-nav';

/**
 * Tries to inject the nav item immediately; if the sidebar isn't in
 * the DOM yet, sets up a MutationObserver that retries until it
 * succeeds or `dispose()` is called.
 */
export function injectNavItem(opts: InjectNavItemOptions): SidebarInjectionHandle & { dispose: () => void } {
  let handle: SidebarInjectionHandle | null = null;
  let observer: MutationObserver | null = null;
  let sidebarClickListener: ((e: Event) => void) | null = null;
  let attachedSidebar: HTMLElement | null = null;

  const tryInject = (): boolean => {
    if (handle) return true;
    handle = doInject(opts);
    if (!handle) return false;

    // Click delegation on #Sidebar: any click on a non-Cloudways-Sync
    // sidebar link should deactivate our icon. We can't rely on
    // hashchange because re-clicking the *same* Local route doesn't
    // emit one — yet the user expects the visible active state to
    // jump back to that item.
    const sidebar = document.getElementById('Sidebar');
    if (sidebar) {
      sidebarClickListener = (e: Event) => {
        const target = e.target as HTMLElement | null;
        const link = target?.closest('a');
        if (!link) return;
        // Ignore clicks on our own item — its dedicated handler does
        // the show/hide toggle.
        if (link.closest(`[${MARKER_ATTR}]`)) return;
        // The user clicked a real Local nav item. Deactivate ours,
        // notify the caller (so it can hide the overlay), and
        // visually restore the clicked item as active.
        handle?.setActive(false);
        opts.onDeactivate?.();
        // Repaint Local's __Active class on the clicked link in case
        // hashchange won't fire (re-click of same route).
        sidebar.querySelectorAll('a.__Active').forEach((el) => {
          if (el !== link) {
            el.classList.remove('__Active');
            el.removeAttribute('aria-current');
          }
        });
        link.classList.add('__Active');
        link.setAttribute('aria-current', 'page');
      };
      sidebar.addEventListener('click', sidebarClickListener, true);
      attachedSidebar = sidebar;
    }

    return true;
  };

  if (!tryInject()) {
    observer = new MutationObserver(() => {
      if (tryInject() && observer) {
        observer.disconnect();
        observer = null;
      }
    });
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  return {
    get element(): HTMLElement {
      return handle?.element ?? document.createElement('div');
    },
    setActive(active: boolean) {
      handle?.setActive(active);
    },
    dispose() {
      observer?.disconnect();
      observer = null;
      if (sidebarClickListener && attachedSidebar) {
        attachedSidebar.removeEventListener('click', sidebarClickListener, true);
      }
      sidebarClickListener = null;
      attachedSidebar = null;
      handle?.dispose();
      handle = null;
    },
  };
}

function doInject(opts: InjectNavItemOptions): SidebarInjectionHandle | null {
  const sidebar = document.getElementById('Sidebar');
  if (!sidebar) return null;

  // Don't double-inject.
  if (sidebar.querySelector(`[${MARKER_ATTR}]`)) return null;

  const templateSelector = opts.templateSelector ?? DEFAULT_TEMPLATE;
  const templateLink = sidebar.querySelector(templateSelector);
  const templateWrapper = templateLink?.closest('div');
  if (!templateWrapper || !(templateWrapper instanceof HTMLElement)) {
    // eslint-disable-next-line no-console
    console.warn('[Cloudways Sync] sidebar template not found — falling back to Preferences entry.');
    return null;
  }

  const clone = templateWrapper.cloneNode(true) as HTMLElement;
  clone.setAttribute(MARKER_ATTR, 'true');

  // Update tooltip text.
  const tooltipNode = clone.querySelector('[aria-hidden="true"]');
  if (tooltipNode) tooltipNode.textContent = opts.label;

  // Update the anchor.
  const cloneLink = clone.querySelector('a');
  if (!cloneLink) return null;
  cloneLink.setAttribute('aria-label', opts.label);
  // Use '#' as href but prevent navigation — we handle visibility
  // ourselves via the onClick callback so Local's router never sees
  // an unknown route.
  cloneLink.setAttribute('href', '#');
  cloneLink.classList.remove('__Active');
  cloneLink.removeAttribute('aria-current');

  cloneLink.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    opts.onClick();
  });

  // Replace icon SVG.
  const oldSvg = cloneLink.querySelector('svg');
  if (oldSvg) {
    oldSvg.outerHTML = opts.iconSvg;
  }

  // Insert before anchor element, or append to end.
  const anchorSelector = opts.insertBeforeSelector ?? DEFAULT_ANCHOR;
  const anchorLink = sidebar.querySelector(anchorSelector);
  const anchorWrapper = anchorLink?.closest('div');
  if (anchorWrapper && anchorWrapper.parentElement === sidebar) {
    sidebar.insertBefore(clone, anchorWrapper);
  } else {
    sidebar.appendChild(clone);
  }

  // When we mark ourselves active, we strip __Active from the
  // previously-active Local nav item. If the user closes our overlay
  // without clicking another route, nothing else restores that
  // highlight — the sidebar ends up with NO active item even though
  // Local's router is still on the old route. Stash the stripped
  // element here so setActive(false) can put the highlight back.
  let stashedActive: HTMLElement | null = null;

  const setActive = (active: boolean) => {
    cloneLink.classList.toggle('__Active', active);
    if (active) {
      cloneLink.setAttribute('aria-current', 'page');
      // Visually deactivate every OTHER Local sidebar item so our
      // icon is the only active one. Remember the first stripped
      // link so we can restore it on toggle-off.
      stashedActive = null;
      sidebar.querySelectorAll('a.__Active').forEach((el) => {
        if (el !== cloneLink) {
          if (!stashedActive && el instanceof HTMLElement) {
            stashedActive = el;
          }
          el.classList.remove('__Active');
          el.removeAttribute('aria-current');
        }
      });
    } else {
      cloneLink.removeAttribute('aria-current');
      // Restore the previously-active Local nav item so the sidebar
      // reflects the actual current route again. Guard against the
      // element having been removed by a router re-render.
      if (stashedActive && sidebar.contains(stashedActive)) {
        stashedActive.classList.add('__Active');
        stashedActive.setAttribute('aria-current', 'page');
      }
      stashedActive = null;
    }
  };

  return {
    element: clone,
    setActive,
    dispose: () => {
      clone.remove();
    },
  };
}
