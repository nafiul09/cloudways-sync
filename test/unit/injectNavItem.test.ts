import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { injectNavItem } from '../../src/renderer/sidebar/injectNavItem';

// Minimal fixture that mimics Local's sidebar structure.
function buildSidebarFixture(): HTMLElement {
  const sidebar = document.createElement('div');
  sidebar.id = 'Sidebar';

  const makeItem = (href: string, label: string) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'FlyTooltip_Container_abc_v17-8-1';
    const tooltip = document.createElement('span');
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.textContent = label;
    wrapper.appendChild(tooltip);
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-original', label);
    a.appendChild(svg);
    wrapper.appendChild(a);
    return wrapper;
  };

  sidebar.appendChild(makeItem('#/main/local-sites', 'Local Sites'));
  sidebar.appendChild(makeItem('#/main/connect', 'Connect'));
  sidebar.appendChild(makeItem('#/main/blueprints', 'Blueprints'));
  sidebar.appendChild(makeItem('#/main/add-ons', 'Add-ons'));
  sidebar.appendChild(makeItem('#/main/support', 'Support'));
  return sidebar;
}

describe('injectNavItem', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clones the blueprints item, rewrites label/svg, and inserts before Support', () => {
    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);
    const onClick = vi.fn();

    const handle = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: '<svg data-new="cws"></svg>',
      onClick,
    });

    const marker = sidebar.querySelector('[data-cloudwayssync-nav]');
    expect(marker).not.toBeNull();

    const link = marker!.querySelector('a');
    expect(link?.getAttribute('aria-label')).toBe('Cloudways Sync');
    expect(link?.getAttribute('href')).toBe('#');

    const svg = link?.querySelector('svg');
    expect(svg?.getAttribute('data-new')).toBe('cws');
    // Original Blueprints SVG should NOT bleed into the clone.
    expect(svg?.getAttribute('data-original')).toBeNull();

    // Tooltip text swapped.
    const tooltip = marker!.querySelector('[aria-hidden="true"]');
    expect(tooltip?.textContent).toBe('Cloudways Sync');

    // Inserted directly before the Support wrapper.
    const supportWrapper = sidebar.querySelector('a[href^="#/main/support"]')!.closest('div')!;
    expect(marker?.nextElementSibling).toBe(supportWrapper);

    handle.dispose();
    expect(sidebar.querySelector('[data-cloudwayssync-nav]')).toBeNull();
  });

  it('calls onClick when the link is clicked, without navigating', () => {
    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);
    const onClick = vi.fn();

    const handle = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: '<svg></svg>',
      onClick,
    });

    const link = sidebar.querySelector('[data-cloudwayssync-nav] a') as HTMLAnchorElement;
    link.click();

    expect(onClick).toHaveBeenCalledOnce();
    // Hash should NOT have changed (we preventDefault + stopPropagation).
    expect(window.location.hash).toBe('');

    handle.dispose();
  });

  it('setActive toggles __Active class + aria-current', () => {
    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);

    const handle = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: '<svg></svg>',
      onClick: vi.fn(),
    });

    const link = sidebar.querySelector('[data-cloudwayssync-nav] a') as HTMLAnchorElement;
    expect(link.classList.contains('__Active')).toBe(false);

    handle.setActive(true);
    expect(link.classList.contains('__Active')).toBe(true);
    expect(link.getAttribute('aria-current')).toBe('page');

    handle.setActive(false);
    expect(link.classList.contains('__Active')).toBe(false);
    expect(link.getAttribute('aria-current')).toBeNull();

    handle.dispose();
  });

  it('deactivates + fires onDeactivate when a Local nav item is clicked', () => {
    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);
    const onDeactivate = vi.fn();

    const handle = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: '<svg></svg>',
      onClick: vi.fn(),
      onDeactivate,
    });

    handle.setActive(true);
    const ourLink = sidebar.querySelector('[data-cloudwayssync-nav] a') as HTMLAnchorElement;
    expect(ourLink.classList.contains('__Active')).toBe(true);

    // Click Local Sites (a real Local nav item).
    const localSites = sidebar.querySelector('a[href="#/main/local-sites"]') as HTMLAnchorElement;
    localSites.click();

    expect(ourLink.classList.contains('__Active')).toBe(false);
    expect(onDeactivate).toHaveBeenCalledOnce();
    // The clicked Local item should now be marked active (handles the
    // re-click case where hashchange wouldn't fire).
    expect(localSites.classList.contains('__Active')).toBe(true);
    expect(localSites.getAttribute('aria-current')).toBe('page');

    handle.dispose();
  });

  it('restores active class on re-click of the previously-active Local item', () => {
    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);
    // Simulate Local Sites being the currently-active route.
    const localSites = sidebar.querySelector('a[href="#/main/local-sites"]') as HTMLAnchorElement;
    localSites.classList.add('__Active');
    localSites.setAttribute('aria-current', 'page');

    const handle = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: '<svg></svg>',
      onClick: vi.fn(),
      onDeactivate: vi.fn(),
    });

    // Open Cloudways Sync — strips Local Sites's __Active.
    handle.setActive(true);
    expect(localSites.classList.contains('__Active')).toBe(false);

    // User re-clicks Local Sites (no hash change). Our delegate
    // should restore its __Active class.
    localSites.click();
    expect(localSites.classList.contains('__Active')).toBe(true);
    expect(localSites.getAttribute('aria-current')).toBe('page');

    handle.dispose();
  });

  it('restores the previously-active Local item when toggled off without clicking elsewhere', () => {
    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);
    const addOns = sidebar.querySelector('a[href="#/main/add-ons"]') as HTMLAnchorElement;
    addOns.classList.add('__Active');
    addOns.setAttribute('aria-current', 'page');

    const handle = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: '<svg></svg>',
      onClick: vi.fn(),
    });

    // Open Cloudways Sync — Add-ons gets stripped.
    handle.setActive(true);
    expect(addOns.classList.contains('__Active')).toBe(false);

    // Close Cloudways Sync by re-clicking our own icon (no other
    // sidebar link was clicked). Add-ons should be re-highlighted.
    handle.setActive(false);
    expect(addOns.classList.contains('__Active')).toBe(true);
    expect(addOns.getAttribute('aria-current')).toBe('page');

    handle.dispose();
  });

  it('is idempotent — a second call does not insert a duplicate', () => {
    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);

    const h1 = injectNavItem({ label: 'Cloudways Sync', iconSvg: '<svg></svg>', onClick: vi.fn() });
    const h2 = injectNavItem({ label: 'Cloudways Sync', iconSvg: '<svg></svg>', onClick: vi.fn() });

    expect(sidebar.querySelectorAll('[data-cloudwayssync-nav]').length).toBe(1);

    h1.dispose();
    h2.dispose();
  });

  it('waits for #Sidebar via MutationObserver when it appears later', async () => {
    const handle = injectNavItem({
      label: 'Cloudways Sync',
      iconSvg: '<svg></svg>',
      onClick: vi.fn(),
    });

    expect(document.querySelector('[data-cloudwayssync-nav]')).toBeNull();

    const sidebar = buildSidebarFixture();
    document.body.appendChild(sidebar);

    // Give the MutationObserver a microtask tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(sidebar.querySelector('[data-cloudwayssync-nav]')).not.toBeNull();
    handle.dispose();
  });
});
