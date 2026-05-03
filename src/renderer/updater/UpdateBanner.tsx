// Update notification banner shown at the top of GlobalDashboard
// and SiteToolsPanel when a newer version is available on GitHub.

import React, { useEffect, useState } from 'react';
import { Banner, Button, TextButton } from '../components/ui';
import { ipcClient, subscribeUpdateAvailable, subscribeUpdateProgress, subscribeUpdateInstalled } from '../ipcClient';
import type { UpdateAvailableEvent, UpdateProgressEvent } from '../../shared/ipcTypes';

type State =
  | { kind: 'idle' }
  | { kind: 'available'; version: string; htmlUrl?: string; tgzUrl?: string }
  | { kind: 'downloading'; version: string; bytesTransferred: number; totalBytes: number }
  | { kind: 'installed'; version: string }
  | { kind: 'error'; version: string; tgzUrl?: string; message: string };

export function UpdateBanner(): React.ReactElement | null {
  const [state, setState] = useState<State>({ kind: 'idle' });

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      subscribeUpdateAvailable((event: UpdateAvailableEvent) => {
        setState((prev) => {
          if (prev.kind === 'downloading' || prev.kind === 'installed') return prev;
          return { kind: 'available', version: event.version, htmlUrl: event.htmlUrl, tgzUrl: event.tgzUrl };
        });
      }),
    );

    unsubs.push(
      subscribeUpdateProgress((event: UpdateProgressEvent) => {
        setState((prev) => {
          if (prev.kind !== 'downloading' && prev.kind !== 'available') return prev;
          const version = prev.version;
          return { kind: 'downloading', version, bytesTransferred: event.bytesTransferred, totalBytes: event.totalBytes };
        });
      }),
    );

    unsubs.push(
      subscribeUpdateInstalled((event) => {
        setState({ kind: 'installed', version: event.version });
      }),
    );

    // The UPDATE_AVAILABLE event may have fired before this component
    // mounted (e.g. SiteToolsPanel opens after startup). Poll the main
    // process for the cached result so we don't miss it.
    ipcClient.checkUpdate().then((res) => {
      if (res.available && res.version) {
        setState((prev) => {
          if (prev.kind !== 'idle') return prev;
          return { kind: 'available', version: res.version!, htmlUrl: res.htmlUrl, tgzUrl: res.tgzUrl };
        });
      }
    }).catch(() => { /* non-fatal */ });

    return () => unsubs.forEach((fn) => fn());
  }, []);

  const handleUpdate = async (tgzUrl: string, version: string) => {
    setState({ kind: 'downloading', version, bytesTransferred: 0, totalBytes: 0 });
    try {
      await ipcClient.installUpdate({ tgzUrl, version });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setState({ kind: 'error', version, tgzUrl, message });
    }
  };

  const openReleaseNotes = (url: string) => {
    try {
      require('electron').shell.openExternal(url);
    } catch {
      // Fallback: do nothing
    }
  };

  if (state.kind === 'idle') return null;

  if (state.kind === 'available') {
    return (
      <div style={styles.wrap}>
        <Banner variant="success">
          <div style={styles.row}>
            <span>
              Update available: <strong>v{state.version}</strong>
            </span>
            <div style={styles.actions}>
              {state.htmlUrl && (
                <TextButton onClick={() => openReleaseNotes(state.htmlUrl!)} style={styles.link}>
                  Release Notes
                </TextButton>
              )}
              {state.tgzUrl && (
                <Button onClick={() => handleUpdate(state.tgzUrl!, state.version)}>
                  Update Now
                </Button>
              )}
            </div>
          </div>
        </Banner>
      </div>
    );
  }

  if (state.kind === 'downloading') {
    const pct = state.totalBytes > 0
      ? Math.round((state.bytesTransferred / state.totalBytes) * 100)
      : null;
    return (
      <div style={styles.wrap}>
        <Banner variant="success">
          <div style={styles.row}>
            <span>
              Downloading v{state.version}...{pct !== null ? ` ${pct}%` : ''}
            </span>
            {state.totalBytes > 0 && (
              <div style={styles.progressTrack}>
                <div style={{ ...styles.progressBar, width: `${pct}%` }} />
              </div>
            )}
          </div>
        </Banner>
      </div>
    );
  }

  if (state.kind === 'installed') {
    return (
      <div style={styles.wrap}>
        <Banner variant="success">
          <span>
            Update to <strong>v{state.version}</strong> installed! Restart Local WP to activate.
          </span>
        </Banner>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div style={styles.wrap}>
        <Banner variant="error">
          <div style={styles.row}>
            <span>Update failed: {state.message}</span>
            {state.tgzUrl && (
              <Button onClick={() => handleUpdate(state.tgzUrl!, state.version)}>
                Retry
              </Button>
            )}
          </div>
        </Banner>
      </div>
    );
  }

  return null;
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    marginBottom: 4,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    width: '100%',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  link: {
    fontSize: 12,
  },
  progressTrack: {
    flex: 1,
    maxWidth: 120,
    height: 6,
    borderRadius: 3,
    background: 'var(--cws-progress-track)',
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 3,
    background: 'var(--cws-accent)',
    transition: 'width 0.2s ease',
  },
};
