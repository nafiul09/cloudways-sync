// Reusable push/pull checkbox panel for selecting which parts of the
// WordPress site to sync (database, wp-content subdirectories).

import React from 'react';
import { Checkbox, Text } from './ui';
import type { PullIncludes, PushIncludes } from '../../shared/ipcTypes';

export type SyncIncludes = PushIncludes | PullIncludes;

const WP_CONTENT_OPTIONS: Array<{ key: keyof SyncIncludes; label: string }> = [
  { key: 'uploads', label: 'Uploads (media)' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'themes', label: 'Themes' },
  { key: 'muPlugins', label: 'MU-Plugins' },
  { key: 'languages', label: 'Languages' },
];

export function SelectivePanel({
  heading,
  includes,
  onChange,
}: {
  heading: string;
  includes: SyncIncludes;
  onChange: (next: SyncIncludes) => void;
}): React.ReactElement {
  const toggle = (key: keyof SyncIncludes) => {
    const next = { ...includes, [key]: !includes[key] };
    const anySubOn = WP_CONTENT_OPTIONS.some((o) => next[o.key]);
    next.wpContent = anySubOn;
    onChange(next);
  };

  const toggleWpContent = () => {
    const next = { ...includes };
    const newVal = !includes.wpContent;
    next.wpContent = newVal;
    for (const o of WP_CONTENT_OPTIONS) {
      next[o.key] = newVal;
    }
    onChange(next);
  };

  return (
    <div style={selectiveStyles.panel}>
      <Text style={selectiveStyles.heading}>{heading}</Text>
      <div style={selectiveStyles.grid}>
        <label style={selectiveStyles.item}>
          <Checkbox checked={includes.database} onChange={() => toggle('database')} />
          <span style={selectiveStyles.label}>Database</span>
        </label>
        <label style={selectiveStyles.item}>
          <Checkbox checked={includes.wpContent} onChange={toggleWpContent} />
          <span style={selectiveStyles.label}>wp-content (all)</span>
        </label>
        {includes.wpContent && (
          <div style={selectiveStyles.subGroup}>
            {WP_CONTENT_OPTIONS.map((opt) => (
              <label key={opt.key} style={selectiveStyles.item}>
                <Checkbox
                  checked={includes[opt.key] as boolean}
                  onChange={() => toggle(opt.key)}
                />
                <span style={selectiveStyles.label}>{opt.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const selectiveStyles: Record<string, React.CSSProperties> = {
  panel: {
    marginBottom: 16,
    padding: '12px 16px',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
  },
  heading: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    opacity: 0.6,
    marginBottom: 8,
  },
  grid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  subGroup: {
    paddingLeft: 24,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontSize: 13,
  },
  label: {
    userSelect: 'none' as const,
  },
};
