import React, { useEffect, useState } from 'react';
import {
  Banner,
  PrimaryButton,
  TextButton,
  Title,
  Text,
  BasicInput,
  InputPasswordToggle,
  Spinner,
  Divider,
} from '@getflywheel/local-components';
import { ipcClient, IpcCallError } from '../ipcClient';
import type { ConnectionStatusPayload } from '../../shared/ipcTypes';
import { FleetBrowser } from './fleet/FleetBrowser';

// Full-page CloudwaysSync dashboard, mounted in the overlay portal
// when the user clicks the sidebar icon. Layout mirrors Local's own
// site-info pane: a TitleBar across the top, then a content body
// with cards and form rows.

export function GlobalDashboard(): React.ReactElement {
  const [status, setStatus] = useState<ConnectionStatusPayload | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    ipcClient
      .getConnection()
      .then((res) => {
        if (!cancelled) setStatus(res);
      })
      .catch((err: IpcCallError) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={styles.pane}>
      {/* Mirrors Local's own PageTitleBar pattern on Blueprints/Add-ons:
          XL title, short caption directly below, then a 2px Divider. */}
      <header style={styles.header}>
        <Title size="xl" tag="h1" style={styles.headerTitle}>
          CloudwaysSync
        </Title>
        <Text size="caption" style={styles.headerSub}>
          One-click sync between Cloudways apps and your Local sites.
        </Text>
      </header>
      <Divider />

      <div style={styles.body}>
        {loadError ? (
          <Banner variant="error">Could not read connection status: {loadError}</Banner>
        ) : status === undefined ? (
          <div style={styles.center}>
            <Spinner />
          </div>
        ) : status.connected ? (
          <ConnectedView status={status} onChange={setStatus} />
        ) : (
          <DisconnectedView onChange={setStatus} />
        )}
      </div>
    </div>
  );
}

// --- Connected ---

function ConnectedView({
  status,
  onChange,
}: {
  status: Extract<ConnectionStatusPayload, { connected: true }>;
  onChange: (s: ConnectionStatusPayload) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const disconnect = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await ipcClient.disconnect();
      onChange({ connected: false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.connectedPane}>
      <style>{BANNER_COMPACT_CSS}</style>
      <Banner variant="success" className="cws-connected-banner">
        <div style={styles.bannerBody}>
          <span>
            Connected as <strong>{status.email}</strong>
          </span>
          <button
            type="button"
            className="cws-danger-btn"
            onClick={disconnect}
            disabled={busy}
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </Banner>

      {err && (
        <div style={styles.row}>
          <Banner variant="error">{err}</Banner>
        </div>
      )}

      <FleetBrowser />
    </div>
  );
}

// --- Disconnected ---

// Cloudways icon for the login card (48px, brand purple)
const CW_LOGO = (
  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 512 512"
       fill="#2f39bf" fillRule="evenodd" clipRule="evenodd"
       strokeLinejoin="round" strokeMiterlimit={2} aria-hidden="true">
    <path d="M171.296 275.979H18.344C11.654 275.979 6 270.407 6 263.87c0-6.56 5.653-12.107 12.344-12.107h162.364c7.034-12.345 16.943-22.892 28.838-30.775H84.38c-6.666 0-12.336-5.572-12.336-12.108 0-6.544 5.67-12.107 12.336-12.107h152.495c3.815-11.241 9.55-21.625 16.813-30.775H108.07c-6.69 0-12.344-5.539-12.344-12.107 0-6.536 5.653-12.108 12.344-12.108h172.951c16.193-9.959 35.342-15.71 55.856-15.71 51.167 0 93.828 35.767 103.42 83.208 37.98 11.004 65.7 45.488 65.7 86.328 0 49.737-41.06 90.021-91.72 90.021h-.32v.294H94.396c-6.682 0-12.328-5.522-12.328-12.099 0-6.544 5.646-12.115 12.328-12.115h104.163c-9.411-8.546-17-19.003-22.115-30.75l-19.68.007c-3.996 0-7.01-2.957-7.01-6.887v-10.138c0-3.922 3.006-6.87 7.01-6.87h13.079a88.563 88.563 0 01-.735-11.463c0-6.74.751-13.316 2.19-19.631zm-60.235 54.99H21.988c-3.995 0-6.985-2.958-6.985-6.888v-10.138c0-3.922 2.99-6.87 6.985-6.87h88.747c3.995 0 7.01 2.948 7.01 6.87v10.138c.318 3.62-3.015 6.887-6.684 6.887z"/>
  </svg>
);

const LOGIN_CSS = `
  .cws-login-card {
    background: #262727;
    border-radius: 8px;
    padding: 32px 32px 28px;
    width: 100%;
    max-width: 400px;
  }
  .cws-login-card input {
    cursor: text;
  }
  .cws-login-card button[type="submit"] {
    width: 100%;
    cursor: pointer;
  }
  .cws-login-hint {
    text-align: center;
    margin-top: 16px;
  }
  .cws-login-hint a,
  .cws-login-hint button {
    cursor: pointer;
    display: inline-block;
    margin-top: 4px;
  }
`;

function DisconnectedView({
  onChange,
}: {
  onChange: (s: ConnectionStatusPayload) => void;
}): React.ReactElement {
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      const res = await ipcClient.connect({ email: email.trim(), apiKey: apiKey.trim() });
      onChange(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = email.trim().length > 0 && apiKey.trim().length > 0 && !busy;

  return (
    <div style={styles.loginWrapper}>
      <style>{LOGIN_CSS}</style>

      <div className="cws-login-card">
        <div style={styles.loginLogo}>{CW_LOGO}</div>

        <Title size="l" tag="h2" style={styles.loginTitle}>
          Connect to Cloudways
        </Title>
        <Text style={styles.loginSub}>
          Enter your API credentials to get started. We verify them before saving, and store
          the key encrypted in your OS keychain.
        </Text>

        <form onSubmit={submit} style={styles.loginForm}>
          <Field label="Cloudways account email">
            <BasicInput
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>

          <Field label="API key">
            <InputPasswordToggle
              value={apiKey}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
            />
          </Field>

          {err && (
            <div style={styles.loginErr}>
              <Banner variant="error">{err}</Banner>
            </div>
          )}

          <div style={styles.loginSubmit}>
            <PrimaryButton type="submit" disabled={!canSubmit}>
              {busy ? 'Verifying…' : 'Connect'}
            </PrimaryButton>
          </div>
        </form>
      </div>

      <div className="cws-login-hint">
        <Text size="caption" style={{ opacity: 0.5, display: 'block' }}>
          Find your API key in Cloudways → Account → API Keys.
        </Text>
        <TextButton
          onClick={() => {
            window.open('https://platform.cloudways.com/api', '_blank');
          }}
        >
          Open Cloudways API page
        </TextButton>
      </div>
    </div>
  );
}

// --- Building blocks ---

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label style={styles.field}>
      <Text size="caption" style={styles.fieldLabel}>
        {label}
      </Text>
      {children}
    </label>
  );
}

// Scoped overrides for the "Connected as …" banner. Attribute-substring
// selectors match Banner's CSS-module hashed class names (`Content_*`,
// `Icon_Wrapper_*`) so we don't have to import a brittle class name.
// Compact banner + custom danger pill button.
//
// Replicates Local's ButtonBase exactly (extracted from scoped.css):
//   - ::after pseudo for the 2px border (not `border` on the element)
//   - border-radius 500px (pill), padding 10px 20px
//   - font-size 1.4rem, font-weight 700, letter-spacing .005em
//   - transition on transform/bg/color 0.1s
//   - Outline variant: transparent bg, border+text colored, hover fills
//     bg and hides border (transparent), text turns white
//   - Red color tokens: #ef4e65 (dark), hover fill #ba3e51, active #8c2738
const BANNER_COMPACT_CSS = `
  .cws-connected-banner [class*="Icon_Wrapper_"] { padding: 10px 14px; }
  .cws-connected-banner [class*="Content_"] { padding: 8px 14px; flex: 1; }
  .cws-connected-banner [class*="Left_Wrapper_"] { flex: 1; }
  .cws-connected-banner [class*="Content_"] button { text-decoration: none !important; }

  .cws-danger-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    background: transparent;
    border: none;
    border-radius: 500px;
    padding: 10px 20px;
    font-family: inherit;
    font-size: 1.4rem;
    font-weight: 700;
    letter-spacing: .005em;
    text-transform: none;
    text-decoration: none;
    color: #ef4e65;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: transform .1s ease 0s, background .1s ease 0s, color .1s ease 0s;
  }
  .cws-danger-btn::after {
    content: "";
    position: absolute;
    top: 0; right: 0; bottom: 0; left: 0;
    border: 2px solid #ef4e65;
    border-radius: 500px;
    transition: border .1s ease 0s;
  }
  .cws-danger-btn:hover {
    background: #ef4e65;
    color: #fff;
  }
  .cws-danger-btn:hover::after {
    border-color: transparent;
  }
  .cws-danger-btn:active {
    background: #ba3e51;
    color: #fff;
  }
  .cws-danger-btn:active::after {
    border-color: transparent;
  }
  .cws-danger-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    background: transparent;
    color: #ef4e65;
  }
  .cws-danger-btn:disabled::after {
    border-color: #9f9c9c;
  }
  .cws-danger-btn:disabled:hover {
    background: transparent;
    color: #ef4e65;
  }
`;

const styles: Record<string, React.CSSProperties> = {
  pane: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  header: {
    // Matches Local's PageTitleBar horizontal rhythm (30px) and gives
    // the XL title some breathing room before the divider.
    padding: '24px 30px 18px',
  },
  headerTitle: {
    margin: 0,
  },
  headerSub: {
    display: 'block',
    marginTop: 6,
    opacity: 0.7,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    padding: '24px 30px',
  },
  connectedPane: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    height: '100%',
    minHeight: 0,
  },
  bannerBody: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    width: '100%',
  },
  row: {
    marginTop: 16,
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: 24,
    rowGap: 8,
    marginTop: 12,
  },
  form: {
    marginTop: 8,
    display: 'flex',
    flexDirection: 'column',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    marginTop: 14,
  },
  fieldLabel: {
    marginBottom: 5,
    fontSize: 13,
    fontWeight: 600,
    color: '#e0dede',
  },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  // --- Login / Disconnected view ---
  loginWrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    minHeight: 0,
    padding: '32px 30px',
  },
  loginLogo: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 16,
  },
  loginTitle: {
    margin: 0,
    textAlign: 'center',
  },
  loginSub: {
    display: 'block',
    textAlign: 'center',
    marginTop: 6,
    opacity: 0.5,
    fontSize: 12.5,
    lineHeight: 1.55,
    maxWidth: 300,
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  loginForm: {
    marginTop: 20,
    display: 'flex',
    flexDirection: 'column',
  },
  loginErr: {
    marginTop: 14,
  },
  loginSubmit: {
    marginTop: 22,
  },
};
