import React, { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  BasicInput,
  Button,
  InputPasswordToggle,
  PrimaryButton,
  Title,
  Text,
} from '../components/ui';
import { ipcClient, IpcCallError } from '../ipcClient';
import { MaskedEmail } from '../components/MaskedEmail';
import type { ConnectionStatusPayload } from '../../shared/ipcTypes';

// Root of Cloudways Sync's entry in Local → Preferences. This is the
// *global* connect-to-Cloudways surface — once connected here, every
// site's per-site Tools tab can map to a Cloudways app without
// re-entering creds.
export function GlobalPreferencesPanel(): React.ReactElement {
  const [status, setStatus] = useState<ConnectionStatusPayload | undefined>();
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const next = await ipcClient.getConnection();
      setStatus(next);
      setLoadError(undefined);
    } catch (err) {
      setLoadError(err instanceof IpcCallError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleConnect() {
    setBusy(true);
    setError(undefined);
    try {
      const next = await ipcClient.connect({ email, apiKey });
      setStatus(next);
      setEmail('');
      setApiKey('');
    } catch (err) {
      setError(err instanceof IpcCallError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(undefined);
    try {
      const next = await ipcClient.disconnect();
      setStatus(next);
    } catch (err) {
      setError(err instanceof IpcCallError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div style={styles.wrap}>
        <Banner variant="error">Could not load connection status: {loadError}</Banner>
      </div>
    );
  }

  if (status === undefined) {
    return (
      <div style={styles.wrap}>
        <Text>Loading…</Text>
      </div>
    );
  }

  if (status.connected) {
    return (
      <div style={styles.wrap}>
        <Title size="m" tag="h2">
          Connected to Cloudways
        </Title>
        <div style={styles.row}>
          <Text>
            Account: <MaskedEmail email={status.email} bold />
          </Text>
        </div>
        <div style={styles.row}>
          <Text size="caption">Connected {new Date(status.connectedAt).toLocaleString()}</Text>
        </div>
        <div style={styles.actions}>
          <Button onClick={handleDisconnect} disabled={busy}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
        {error && (
          <div style={styles.row}>
            <Banner variant="error">{error}</Banner>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <Title size="m" tag="h2">
        Connect to Cloudways
      </Title>
      <div style={styles.row}>
        <Text>
          Create an API key in Cloudways → Account → API. Cloudways Sync stores it encrypted in your
          OS keychain — it never leaves this machine. Once connected here, every Local site can map
          to a Cloudways app from its own Tools tab.
        </Text>
      </div>
      <div style={styles.field}>
        <label htmlFor="cws-email" style={styles.label}>
          <Text size="caption">Email</Text>
        </label>
        <BasicInput
          id="cws-email"
          value={email}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
          placeholder="you@example.com"
          disabled={busy}
        />
      </div>
      <div style={styles.field}>
        <label htmlFor="cws-api-key" style={styles.label}>
          <Text size="caption">API key</Text>
        </label>
        <InputPasswordToggle
          id="cws-api-key"
          value={apiKey}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
        />
      </div>
      <div style={styles.actions}>
        <PrimaryButton onClick={handleConnect} disabled={busy || !email || !apiKey}>
          {busy ? 'Connecting…' : 'Connect'}
        </PrimaryButton>
      </div>
      {error && (
        <div style={styles.row}>
          <Banner variant="error">{error}</Banner>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { padding: 24, maxWidth: 560 },
  row: { marginTop: 12 },
  field: { marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 },
  label: { display: 'block' },
  actions: { marginTop: 20 },
};
