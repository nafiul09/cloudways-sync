// "Link via SFTP…" form rendered inline on the Site Tools panel.
//
// Flow:
//   1. User fills host / port / username / password (+ optional label,
//      remote URL).
//   2. Clicks Test connection — runs PROBE_SFTP.
//      - If multiple WP installs are detected, shows a picker.
//      - If single WP install detected, advances to "Save".
//   3. Clicks Save — runs LINK_VIA_SFTP. The handler re-probes
//      defensively before persisting credentials + mapping.
//
// The form is intentionally a plain inline component (no <Dialog>
// portal) so we can fit it into the existing Tools panel real estate
// without touching Local's modal stack.

import React, { useMemo, useState } from 'react';
import { Banner, Button, Text, TextButton, Title } from '@getflywheel/local-components';
import { ipcClient, IpcCallError } from '../ipcClient';
import type {
  ProbeSftpResponse,
  ProbeSftpCandidate,
  SftpSiteMapping,
} from '../../shared/ipcTypes';

type Props = {
  localSiteId: string;
  defaultLabel?: string;
  onCancel: () => void;
  onLinked: (mapping: SftpSiteMapping) => void;
};

type ProbeOk = Extract<ProbeSftpResponse, { ok: true }>;

export function LinkViaSftpDialog({
  localSiteId,
  defaultLabel,
  onCancel,
  onLinked,
}: Props): React.ReactElement {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState(defaultLabel ?? '');
  const [remoteUrl, setRemoteUrl] = useState('');

  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ProbeOk | undefined>();
  const [candidates, setCandidates] = useState<ProbeSftpCandidate[] | undefined>();
  const [pickedSysUser, setPickedSysUser] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [errorCode, setErrorCode] = useState<string | undefined>();

  const portNum = useMemo(() => Number(port), [port]);
  const formValid = host.trim() && username.trim() && password && Number.isFinite(portNum) && portNum > 0;

  const resetProbe = () => {
    setProbe(undefined);
    setCandidates(undefined);
    setPickedSysUser(undefined);
    setError(undefined);
    setErrorCode(undefined);
  };

  const onAnyEdit = () => {
    if (probe || candidates) resetProbe();
  };

  const runProbe = async (sysUser?: string) => {
    if (!formValid) return;
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    try {
      const res = await ipcClient.probeSftp({
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        password,
        pickedSysUser: sysUser,
      });
      if (res.ok) {
        setProbe(res);
        setCandidates(res.candidates.length > 1 ? res.candidates : undefined);
        if (res.candidates.length > 1) setPickedSysUser(res.sysUser);
        if (!label.trim()) {
          setLabel(res.sysUser);
        }
      } else {
        if (res.code === 'SFTP_MULTIPLE_APPS' && res.candidates?.length) {
          setCandidates(res.candidates);
          setPickedSysUser(res.candidates[0]!.sysUser);
        }
        setError(res.message);
        setErrorCode(res.code);
      }
    } catch (e) {
      setError(e instanceof IpcCallError ? e.message : String(e));
      setErrorCode(e instanceof IpcCallError ? e.code : 'UNKNOWN');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!probe) return;
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    try {
      const res = await ipcClient.linkViaSftp({
        localSiteId,
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        password,
        appLabel: label.trim() || probe.sysUser,
        remoteUrl: remoteUrl.trim() || undefined,
        pickedSysUser,
      });
      onLinked(res.mapping);
    } catch (e) {
      setError(e instanceof IpcCallError ? e.message : String(e));
      setErrorCode(e instanceof IpcCallError ? e.code : 'UNKNOWN');
      setBusy(false);
    }
  };

  return (
    <section style={styles.wrap}>
      <Title size="s" tag="h2">Link via SFTP</Title>
      <Text size="caption" style={styles.help}>
        Use the SSH/SFTP credentials shown in your Cloudways dashboard
        (Application Settings → SSH/SFTP). Cloudways Sync will verify
        the connection before saving anything.
      </Text>

      <div style={styles.grid}>
        <Field label="Host" hint="e.g. 203.0.113.10 or your server's hostname">
          <input
            type="text"
            value={host}
            onChange={(e) => { onAnyEdit(); setHost(e.target.value); }}
            disabled={busy}
            style={styles.input}
            placeholder="203.0.113.10"
            autoComplete="off"
          />
        </Field>
        <Field label="Port">
          <input
            type="number"
            value={port}
            onChange={(e) => { onAnyEdit(); setPort(e.target.value); }}
            disabled={busy}
            style={{ ...styles.input, width: 96 }}
            min={1}
            max={65535}
          />
        </Field>
        <Field label="Username" hint="Cloudways app's master_xxx or sys_user">
          <input
            type="text"
            value={username}
            onChange={(e) => { onAnyEdit(); setUsername(e.target.value); }}
            disabled={busy}
            style={styles.input}
            placeholder="master_xxxxxx"
            autoComplete="off"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => { onAnyEdit(); setPassword(e.target.value); }}
            disabled={busy}
            style={styles.input}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Label" hint="Optional — shown in the Site Tools panel">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            style={styles.input}
            placeholder={probe?.sysUser ?? 'My Cloudways App'}
          />
        </Field>
        <Field label="Site URL" hint="Optional — used for the 'Open on web' link">
          <input
            type="text"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            disabled={busy}
            style={styles.input}
            placeholder={probe?.detectedSiteUrl ?? 'https://example.com'}
          />
        </Field>
      </div>

      {candidates && candidates.length > 1 && (
        <div style={styles.candidates}>
          <Text size="caption" style={styles.label}>
            Multiple WordPress apps detected for this user — pick one:
          </Text>
          {candidates.map((c) => (
            <label key={c.sysUser} style={styles.candidateRow}>
              <input
                type="radio"
                name="sftp-candidate"
                checked={pickedSysUser === c.sysUser}
                onChange={() => setPickedSysUser(c.sysUser)}
                disabled={busy}
              />
              <span>
                <strong>{c.sysUser}</strong> <span style={{ opacity: 0.55 }}>({c.webRoot})</span>
              </span>
            </label>
          ))}
        </div>
      )}

      {probe && (
        <Banner variant="success" style={styles.banner}>
          Verified: {probe.sysUser} at {probe.webRoot}
          {probe.wpCliAvailable ? ' (wp-cli available)' : ' (wp-cli not detected — push will use raw SQL)'}
          {probe.detectedSiteUrl ? ` — ${probe.detectedSiteUrl}` : ''}
        </Banner>
      )}

      {error && (
        <Banner variant="error" style={styles.banner}>
          {error}
          {errorCode === 'SSH_AUTH_FAILED' && (
            <div style={styles.coach}>
              <strong>How to fix this:</strong>
              <ol style={styles.coachList}>
                <li>Open Cloudways → Applications → your app.</li>
                <li>Application Settings → SSH/SFTP.</li>
                <li>Click <em>Set Password</em>, copy it, paste it here.</li>
                <li>Confirm your IP is whitelisted (Allow Public Access or add your IP).</li>
              </ol>
            </div>
          )}
          {errorCode === 'SSH_NETWORK' && (
            <div style={styles.coach}>
              Likely an IP-whitelist or firewall block. In Cloudways → Application
              Settings → SSH/SFTP, add your current IP or set it to "Allow all IPs".
            </div>
          )}
          {errorCode === 'WP_NOT_FOUND' && (
            <div style={styles.coach}>
              No <code>public_html/wp-config.php</code> was found. Confirm this
              user has access to a Cloudways WordPress app.
            </div>
          )}
          {(errorCode === 'SSH_TIMEOUT' || errorCode === 'SSH_CLOSED') && (
            <div style={styles.coach}>
              The server stopped responding mid-handshake. Most often this is
              an idle SSH session being dropped by Cloudways' firewall —
              re-test, or check your IP whitelist in Application Settings → SSH/SFTP.
            </div>
          )}
        </Banner>
      )}

      <div style={styles.actions}>
        <TextButton onClick={onCancel} disabled={busy}>Cancel</TextButton>
        <div style={{ flex: 1 }} />
        <Button onClick={() => runProbe(pickedSysUser)} disabled={!formValid || busy}>
          {busy && !probe ? 'Testing…' : probe ? 'Re-test' : 'Test connection'}
        </Button>
        <Button onClick={save} disabled={!probe || busy} style={{ marginLeft: 8 }}>
          {busy && probe ? 'Saving…' : 'Save link'}
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label style={styles.field}>
      <Text size="caption" style={styles.label}>{label}</Text>
      {children}
      {hint && <Text size="caption" style={styles.hint}>{hint}</Text>}
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    padding: 16,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
    marginTop: 16,
  },
  help: {
    display: 'block',
    opacity: 0.6,
    marginTop: 4,
    marginBottom: 12,
    lineHeight: 1.4,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px 16px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  label: {
    opacity: 0.6,
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  hint: {
    opacity: 0.45,
    fontSize: 11,
    marginTop: 2,
  },
  input: {
    background: '#252626',
    color: '#e7e7e7',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 13,
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  candidates: {
    marginTop: 12,
    padding: '10px 12px',
    background: 'rgba(81,187,123,0.06)',
    border: '1px solid rgba(81,187,123,0.18)',
    borderRadius: 6,
  },
  candidateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    padding: '4px 0',
    fontSize: 13,
  },
  banner: {
    marginTop: 12,
  },
  coach: {
    marginTop: 8,
    fontSize: 12,
    opacity: 0.85,
    lineHeight: 1.45,
  },
  coachList: {
    margin: '4px 0 0 18px',
    padding: 0,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    marginTop: 16,
    gap: 8,
  },
};
