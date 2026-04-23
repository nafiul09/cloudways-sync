// Privacy-safe email display. Shows a masked form by default (so the
// full address isn't exposed in screenshots, screen recordings, or
// screen-shares) with an eye icon the user can click to reveal the
// full address when they need to confirm which account is connected.
//
// Masking rules:
//   local part  — keep first 3 chars, replace the rest with ***
//   domain name — keep last 3 chars (before the TLD), prefix with ***
//   TLD         — kept as-is
// Example: hosting@orviko.com  →  hos***@***iko.com

import React, { useState } from 'react';

export function maskEmail(email: string | undefined): string {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  if (at < 0) return email;

  const local = email.slice(0, at);
  const domainFull = email.slice(at + 1);

  const lastDot = domainFull.lastIndexOf('.');
  const domain = lastDot >= 0 ? domainFull.slice(0, lastDot) : domainFull;
  const tld = lastDot >= 0 ? domainFull.slice(lastDot) : '';

  const maskedLocal = local.length <= 3 ? local : `${local.slice(0, 3)}***`;
  const maskedDomain = domain.length <= 3 ? domain : `***${domain.slice(-3)}`;

  return `${maskedLocal}@${maskedDomain}${tld}`;
}

type Props = {
  email: string | undefined;
  /** Wrap the value in a <strong> tag (matches existing callsites). */
  bold?: boolean;
};

export function MaskedEmail({ email, bold = false }: Props): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  const display = revealed ? (email ?? '') : maskEmail(email);
  const ValueTag = bold ? 'strong' : 'span';

  return (
    <span style={styles.wrap}>
      <ValueTag style={styles.value}>{display}</ValueTag>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        style={styles.btn}
        title={revealed ? 'Hide email' : 'Show email'}
        aria-label={revealed ? 'Hide email' : 'Show email'}
        aria-pressed={revealed}
      >
        <span
          style={styles.icon}
          dangerouslySetInnerHTML={{ __html: revealed ? EYE_OFF_ICON : EYE_ICON }}
        />
      </button>
    </span>
  );
}

// Heroicons-style eye / eye-off, sized to align with inline text.
const EYE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;

const EYE_OFF_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C5 20 1 12 1 12a21.77 21.77 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.17 4.19M1 1l22 22"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/></svg>`;

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    verticalAlign: 'baseline',
  },
  value: {
    fontVariantNumeric: 'tabular-nums' as const,
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    padding: 0,
    margin: 0,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.55,
    cursor: 'pointer',
    lineHeight: 0,
  },
  icon: {
    display: 'block',
    width: 14,
    height: 14,
    lineHeight: 0,
  },
};
