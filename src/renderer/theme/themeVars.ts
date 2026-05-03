// Inject CSS custom properties for light/dark theme support.
//
// Local WP sets `.Theme__Dark` or `.Theme__Light` on `<html>`.
// By defining --cws-* variables under both selectors the addon
// auto-switches when the user changes Local's appearance — no JS
// listener needed.

const STYLE_ID = 'cws-theme-vars';

const VARS = `
  --cws-bg-app: #303031;
  --cws-bg-surface: #262727;
  --cws-bg-surface-alt: #303031;
  --cws-bg-inset: #252626;
  --cws-bg-overlay: rgba(0,0,0,0.7);
  --cws-bg-modal: #1e1f1f;
  --cws-border-subtle: rgba(255,255,255,0.08);
  --cws-border-default: rgba(255,255,255,0.18);
  --cws-text-primary: #ffffff;
  --cws-text-default: #e7e7e7;
  --cws-text-secondary: #c7c4c4;
  --cws-text-tertiary: #9f9c9c;
  --cws-text-disabled: #5d5e5e;
  --cws-accent: #51bb7b;
  --cws-accent-hover: #419564;
  --cws-accent-muted: rgba(81,187,123,0.15);
  --cws-red: #ef4e65;
  --cws-orange: #f47820;
  --cws-shadow: rgba(0,0,0,0.4);
  --cws-spinner-track: rgba(255,255,255,0.15);
  --cws-spinner-arc: rgba(255,255,255,0.6);
  --cws-divider: #434344;
  --cws-hover-bg: #434344;
  --cws-active-bg: #303031;
  --cws-progress-track: rgba(255,255,255,0.06);
`;

const CSS = `
  /* Fallback: if neither theme class is present, default to dark */
  :root { ${VARS} }
  .Theme__Dark { ${VARS} }
  .Theme__Light {
    --cws-bg-app: #f6f6f6;
    --cws-bg-surface: #ffffff;
    --cws-bg-surface-alt: #f0f0f0;
    --cws-bg-inset: #f4f4f4;
    --cws-bg-overlay: rgba(0,0,0,0.4);
    --cws-bg-modal: #ffffff;
    --cws-border-subtle: rgba(0,0,0,0.08);
    --cws-border-default: rgba(0,0,0,0.15);
    --cws-text-primary: #1a1a1a;
    --cws-text-default: #333333;
    --cws-text-secondary: #555555;
    --cws-text-tertiary: #888888;
    --cws-text-disabled: #aaaaaa;
    --cws-accent: #51bb7b;
    --cws-accent-hover: #419564;
    --cws-accent-muted: rgba(81,187,123,0.12);
    --cws-red: #d93848;
    --cws-orange: #e06820;
    --cws-shadow: rgba(0,0,0,0.12);
    --cws-spinner-track: rgba(0,0,0,0.08);
    --cws-spinner-arc: rgba(0,0,0,0.4);
    --cws-divider: #e0e0e0;
    --cws-hover-bg: #ebebeb;
    --cws-active-bg: #e0e0e0;
    --cws-progress-track: rgba(0,0,0,0.06);
  }
`;

export function injectThemeStylesheet(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
