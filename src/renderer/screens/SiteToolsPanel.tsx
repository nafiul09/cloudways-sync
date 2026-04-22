import React, { useEffect, useState } from 'react';
import { Banner, Text, TextButton, Title } from '@getflywheel/local-components';
import type { Site } from '@getflywheel/local';
import { ipcClient, IpcCallError } from '../ipcClient';
import type { ConnectionStatusPayload } from '../../shared/ipcTypes';

// Per-site CloudwaysSync panel shown under Local's Tools tab.
//
// This surface is intentionally narrow: account-level configuration
// lives in Local → Preferences → CloudwaysSync (the global panel).
// Here we only surface status for this one site + (starting Phase 3)
// the Cloudways-app mapping and pull/push controls.
export function SiteToolsPanel({ site }: { site: Site }): React.ReactElement {
  const [status, setStatus] = useState<ConnectionStatusPayload | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await ipcClient.getConnection();
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof IpcCallError ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={styles.wrap}>
      <header style={styles.header}>
        <Title size="l" tag="h1">
          CloudwaysSync
        </Title>
        <Text size="caption">Site: {site?.name ?? 'unknown'}</Text>
      </header>

      {loadError ? (
        <Banner variant="error">Could not read connection status: {loadError}</Banner>
      ) : status === undefined ? (
        <Text>Loading…</Text>
      ) : status.connected ? (
        <ConnectedEmptyState email={status.email} />
      ) : (
        <DisconnectedEmptyState />
      )}
    </div>
  );
}

function ConnectedEmptyState({ email }: { email: string }): React.ReactElement {
  return (
    <section>
      <Banner variant="success">
        Connected as <strong>{email}</strong>
      </Banner>
      <div style={styles.row}>
        <Title size="s" tag="h2">
          No Cloudways app linked yet
        </Title>
      </div>
      <div style={styles.row}>
        <Text>
          Pick a Cloudways app to sync with this Local site. Once linked, you&rsquo;ll be able to
          pull its files + database down, or push local changes up with a one-click undo.
        </Text>
      </div>
      <div style={styles.row}>
        <Text size="caption">
          Coming in the next phase — the server/app picker is wired to the API but the mapping UI
          isn&rsquo;t shipped yet.
        </Text>
      </div>
    </section>
  );
}

function DisconnectedEmptyState(): React.ReactElement {
  return (
    <section>
      <Banner variant="warning">CloudwaysSync isn&rsquo;t connected to a Cloudways account yet.</Banner>
      <div style={styles.row}>
        <Text>
          Connect your Cloudways account once from Local&rsquo;s Preferences, then every site can
          link to a Cloudways app from this Tools tab without re-entering credentials.
        </Text>
      </div>
      <div style={styles.row}>
        <TextButton onClick={openPreferences}>Open Local Preferences →</TextButton>
      </div>
      <div style={styles.row}>
        <Text size="caption">
          If the Preferences button does nothing, open it manually from Local&rsquo;s top menu and
          pick <strong>CloudwaysSync</strong> in the sidebar.
        </Text>
      </div>
    </section>
  );
}

function openPreferences() {
  // Local exposes an imperative "open preferences" route via its
  // front-end router; rather than depend on that private API, we
  // fall back to a no-op + helper text that tells the user where to
  // go. Wiring the real navigation will ship alongside the server
  // picker in Phase 3.
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { padding: 24 },
  header: { marginBottom: 24 },
  row: { marginTop: 12 },
};
