// Phase 3 — Servers + Apps browser.
//
// Left rail mirrors Local's own SiteList sidebar (extracted from
// app.css): collapsible server groups with 40px headers, 36px app
// rows, 4px border-radius, exact dark-theme colors (#303031 base,
// #262727 selected, #434344 hover), 8x8 circle dot indicator.
//
// Right pane shows selected app detail with flat TableList rows.

import React, { useEffect, useState } from 'react';
import {
  Banner,
  Checkbox,
  Spinner,
  TextButton,
  Title,
  Text,
  Button,
} from '@getflywheel/local-components';
import { ipcClient, IpcCallError, subscribeJobProgress } from '../../ipcClient';
import type {
  AppDetail as AppDetailPayload,
  AppSummary,
  JobProgressEvent,
  PullIncludes,
  ServerSummary,
} from '../../../shared/ipcTypes';

// Short human labels for the pull steps the orchestrator emits.
// Kept here (not imported from JobStore) because JobStore lives in
// main/ and must not be pulled into the renderer bundle.
const PULL_STEP_LABELS: Record<string, string> = {
  validate: 'Validating',
  backup: 'Taking Cloudways backup',
  ssh: 'Connecting over SSH',
  metadata: 'Reading WordPress metadata',
  'db-export': 'Exporting remote DB',
  'download-db': 'Downloading DB dump',
  'download-content': 'Downloading wp-content',
  'local-site': 'Importing into Local',
  'local-content': 'Installing wp-content',
  'local-db': 'Importing DB into Local',
  'search-replace': 'Rewriting URLs',
  manifest: 'Writing manifest',
};

const PROVIDER_LABELS: Record<string, string> = {
  do: 'DigitalOcean',
  vultr: 'Vultr',
  aws: 'Amazon AWS',
  linode: 'Linode',
  gce: 'Google Cloud',
};

function providerLabel(cloud: string): string {
  return PROVIDER_LABELS[cloud.toLowerCase()] ?? cloud.toUpperCase();
}

type SelectedApp = { serverId: number; appId: number } | null;

// CSS injected once for hover/active states that can't be done inline.
// All values extracted from Local's app.css SiteList classes.
const RAIL_CSS = `
  .cws-server-header {
    display: flex;
    flex-direction: row;
    align-items: center;
    height: 40px;
    background: transparent;
    border-radius: 4px;
    padding: 0 10px;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: 1.4rem;
    font-weight: 500;
    width: 100%;
    text-align: left;
    transition: background 100ms;
  }
  .cws-server-header:hover { background: #434344; }
  .cws-server-header-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    line-height: 40px;
  }
  .cws-server-header-toggle {
    margin-left: 10px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    color: inherit;
  }

  .cws-app-item {
    display: flex;
    align-items: center;
    height: 36px;
    line-height: 36px;
    text-decoration: none;
    padding: 0 5px;
    color: #c7c4c4;
    background: transparent;
    border-radius: 4px;
    overflow: hidden;
    white-space: nowrap;
    border: none;
    font: inherit;
    font-size: 1.4rem;
    width: 100%;
    text-align: left;
    cursor: pointer;
    position: relative;
  }
  .cws-app-item:not(.cws-app-item--active):hover {
    background: #434344;
  }
  .cws-app-item--active {
    background: #303031;
    color: #fff;
    font-weight: 700;
  }
  .cws-app-item--adjacent-active {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  .cws-app-dot {
    float: left;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    width: 20px;
    height: 36px;
    margin: 0 5px 0 0;
    flex-shrink: 0;
  }
  .cws-app-dot svg { width: 10px; }
  .cws-app-dot svg circle { fill: #434344; }
  .cws-app-item:not(.cws-app-item--active):hover .cws-app-dot svg circle { fill: #51bb7b; }
  .cws-app-item--active .cws-app-dot svg circle { fill: #51bb7b; }

  .cws-app-name {
    flex-grow: 1;
    line-height: 37px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cws-fleet a,
  .cws-fleet button,
  .cws-fleet [role="button"] {
    cursor: pointer;
  }

  .cws-app-badge {
    flex-shrink: 0;
    margin-left: 6px;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: .03em;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    color: #9f9c9c;
    opacity: 0.7;
  }
  .cws-app-item--active .cws-app-badge {
    background: rgba(255, 255, 255, 0.12);
    color: #c7c4c4;
    opacity: 1;
  }
`;

export function FleetBrowser(): React.ReactElement {
  const [servers, setServers] = useState<ServerSummary[] | undefined>();
  const [loadErr, setLoadErr] = useState<string | undefined>();
  const [apps, setApps] = useState<Record<number, AppSummary[]>>({});
  const [selected, setSelected] = useState<SelectedApp>(null);

  useEffect(() => {
    let cancelled = false;
    ipcClient
      .listServers()
      .then((res) => {
        if (!cancelled) setServers(res.servers);
      })
      .catch((err: IpcCallError) => {
        if (!cancelled) setLoadErr(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadApps = async (serverId: number): Promise<void> => {
    if (apps[serverId]) return;
    try {
      const res = await ipcClient.listApps({ serverId });
      setApps((prev) => ({ ...prev, [serverId]: res.apps }));
    } catch (err) {
      setApps((prev) => ({ ...prev, [serverId]: [] }));
      setLoadErr(err instanceof Error ? err.message : String(err));
    }
  };

  if (loadErr && !servers) {
    return <Banner variant="error">Couldn't load servers: {loadErr}</Banner>;
  }
  if (!servers) {
    return (
      <div style={styles.center}>
        <Spinner />
      </div>
    );
  }
  if (servers.length === 0) {
    return (
      <Banner variant="neutral">
        No Cloudways servers found on this account. Provision one in the Cloudways dashboard, then refresh here.
      </Banner>
    );
  }

  const sorted = [...servers].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="cws-fleet" style={styles.split}>
      <style>{RAIL_CSS}</style>
      <aside style={styles.rail}>
        {sorted.map((server) => (
          <ServerGroup
            key={server.id}
            server={server}
            apps={apps[server.id]}
            loadApps={() => loadApps(server.id)}
            selected={selected}
            onSelect={setSelected}
          />
        ))}
      </aside>

      <section style={styles.detail}>
        {selected ? (
          <AppDetailView
            key={`${selected.serverId}:${selected.appId}`}
            serverId={selected.serverId}
            appId={selected.appId}
          />
        ) : (
          <EmptyDetail />
        )}
      </section>
    </div>
  );
}

// --- Left rail: server group (like Local's SiteListGroup) ---

// Green minus/collapse icon (matches Local's AccordionItem_Summary_Action)
const COLLAPSE_ICON = (
  <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
    <rect x="1" y="4" width="8" height="2" rx="1" fill="#51bb7b" />
  </svg>
);
const EXPAND_ICON = (
  <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
    <rect x="1" y="4" width="8" height="2" rx="1" fill="#51bb7b" />
    <rect x="4" y="1" width="2" height="8" rx="1" fill="#51bb7b" />
  </svg>
);

function ServerGroup({
  server,
  apps,
  loadApps,
  selected,
  onSelect,
}: {
  server: ServerSummary;
  apps: AppSummary[] | undefined;
  loadApps: () => Promise<void>;
  selected: SelectedApp;
  onSelect: (s: SelectedApp) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (open && !apps) void loadApps();
  }, [open, apps, loadApps]);

  return (
    <div style={styles.group}>
      <div style={styles.groupInner}>
        <button
          type="button"
          className="cws-server-header"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="cws-server-header-name">{server.label}</span>
          <span className="cws-server-header-toggle">
            {open ? COLLAPSE_ICON : EXPAND_ICON}
          </span>
        </button>

        {open && (
          <div style={styles.appList}>
            {!apps && (
              <div style={styles.appListStatus}>
                <Spinner />
              </div>
            )}
            {apps && apps.length === 0 && (
              <div style={styles.appListEmpty}>No apps</div>
            )}
            {apps?.map((app) => {
              const isActive = selected?.serverId === server.id && selected?.appId === app.id;
              return (
                <button
                  key={app.id}
                  type="button"
                  className={'cws-app-item' + (isActive ? ' cws-app-item--active' : '')}
                  onClick={() => onSelect({ serverId: server.id, appId: app.id })}
                >
                  <span className="cws-app-dot">
                    <svg viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="4" cy="4" r="4" />
                    </svg>
                  </span>
                  <span className="cws-app-name">{app.label}</span>
                  {app.isWordPress && <span className="cws-app-badge">WP</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Detail panel ---

function EmptyDetail(): React.ReactElement {
  return (
    <div style={styles.emptyDetail}>
      <Title size="m" tag="h2">
        Select an app
      </Title>
      <Text style={styles.emptyBody}>
        Pick any Cloudways app on the left to view its credentials and sync options.
      </Text>
    </div>
  );
}

function AppDetailView({
  serverId,
  appId,
}: {
  serverId: number;
  appId: number;
}): React.ReactElement {
  const [detail, setDetail] = useState<AppDetailPayload | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [reveal, setReveal] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);
  const [pullResult, setPullResult] = useState<string | undefined>();
  const [pullErr, setPullErr] = useState<string | undefined>();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialErr, setCredentialErr] = useState<string | undefined>();
  const [pullStep, setPullStep] = useState<
    { stepId: string; percent?: number; detail?: string } | undefined
  >();
  const [includes, setIncludes] = useState<PullIncludes>({
    database: true,
    wpContent: true,
    uploads: true,
    plugins: true,
    themes: true,
    muPlugins: true,
    languages: true,
  });

  // Subscribe to JOB_PROGRESS so the pull button can surface which step
  // is currently running.
  useEffect(() => {
    const unsubscribe = subscribeJobProgress((event: JobProgressEvent) => {
      const percent =
        typeof event.totalBytes === 'number' &&
        event.totalBytes > 0 &&
        typeof event.bytesTransferred === 'number'
          ? Math.min(100, Math.round((event.bytesTransferred / event.totalBytes) * 100))
          : undefined;
      if (event.status === 'running') {
        setPullStep({ stepId: event.stepId, percent, detail: event.detail });
      } else if (event.status === 'success' || event.status === 'failed') {
        setPullStep(undefined);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setErr(undefined);
    setReveal(false);
    setPullResult(undefined);
    setPullErr(undefined);
    setCredentialErr(undefined);
    ipcClient
      .getApp({ serverId, appId })
      .then((res) => {
        if (!cancelled) setDetail(res.app);
      })
      .catch((e: IpcCallError) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, appId]);

  if (err) return <Banner variant="error">{err}</Banner>;
  if (!detail) {
    return (
      <div style={styles.center}>
        <Spinner />
      </div>
    );
  }

  const primaryUrl = detail.appFqdn ? `https://${detail.appFqdn}` : null;
  const runPull = async () => {
    setPullBusy(true);
    setPullResult(undefined);
    setPullErr(undefined);
    setPullStep(undefined);
    try {
      const plan = await ipcClient.planPull({
        serverId: detail.serverId,
        appId: detail.id,
        destinationName: detail.label,
        serverLabel: detail.server.label,
        includes,
      });
      const job = await ipcClient.runJob({ planId: plan.planId });
      setPullResult(job.localUrl ? `Pulled into Local: ${job.localUrl}` : 'Pull completed.');
    } catch (e) {
      setPullErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPullBusy(false);
      setPullStep(undefined);
    }
  };

  const pullLabel = (() => {
    if (!pullBusy) return 'Pull to Local';
    if (!pullStep) return 'Pulling…';
    const label = PULL_STEP_LABELS[pullStep.stepId] ?? pullStep.stepId;
    return pullStep.percent != null
      ? `Pulling — ${label} (${pullStep.percent}%)`
      : `Pulling — ${label}`;
  })();
  // The orchestrator sends the current file path in `detail` during
  // wp-content mirroring. Surfacing it as a secondary line makes
  // stalls on individual files obvious, even when the per-file
  // percent jumps straight to 100%.
  const pullSubLabel =
    pullBusy && pullStep?.detail && (pullStep.stepId === 'download-content' || pullStep.stepId === 'download-db')
      ? pullStep.detail
      : undefined;
  const createCredentials = async () => {
    setCredentialBusy(true);
    setCredentialErr(undefined);
    try {
      const res = await ipcClient.createAppCredential({ serverId: detail.serverId, appId: detail.id });
      setDetail({
        ...detail,
        sftp: res.sftp,
        db: { ...detail.db, password: res.sftp.password },
      });
    } catch (e) {
      setCredentialErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCredentialBusy(false);
    }
  };

  return (
    <div>
      <div style={styles.detailHeading}>
        <Title size="xl" tag="h2" style={{ margin: 0 }}>
          {detail.label}
        </Title>
        <div style={styles.detailCrumbs}>
          {providerLabel(detail.server.cloud)} · {detail.server.label}
          {detail.server.region ? ` · ${detail.server.region}` : ''}
        </div>
      </div>

      {detail.isWordPress && (
        <>
          <div style={styles.actionBar}>
            <Button onClick={runPull} disabled={pullBusy || !detail.sftp.password}>
              {pullLabel}
            </Button>
            {pullSubLabel && (
              <div style={{ marginTop: 6, fontSize: 11, opacity: 0.65 }}>
                {pullSubLabel}
              </div>
            )}
          </div>
          {!pullBusy && (
            <SelectivePanel
              heading="Include in pull"
              includes={includes}
              onChange={setIncludes}
            />
          )}
        </>
      )}
      {pullErr && (
        <div style={styles.banner}>
          <Banner variant="error">{pullErr}</Banner>
        </div>
      )}
      {pullResult && (
        <div style={styles.banner}>
          <Banner variant="success">{pullResult}</Banner>
        </div>
      )}
      {detail.isWordPress && !detail.sftp.password && (
        <CredentialsMissingNotice
          busy={credentialBusy}
          error={credentialErr}
          onCreate={createCredentials}
        />
      )}

      {!detail.isWordPress && (
        <div style={styles.banner}>
          <Banner variant="warning">
            This app is <strong>{detail.application}</strong>, not WordPress. CloudwaysSync only syncs WordPress apps
            in v1.
          </Banner>
        </div>
      )}

      <SectionHeader title="App" />
      <ul className="TableList">
        <Row label="Primary URL">
          {primaryUrl ? (
            <>
              <TextButton onClick={() => window.open(primaryUrl, '_blank')}>{primaryUrl}</TextButton>
              <CopyButton value={primaryUrl} />
            </>
          ) : (
            <Text>—</Text>
          )}
        </Row>
        <Row label="App ID">
          <ValueWithCopy value={String(detail.id)} />
        </Row>
        {detail.appVersion && (
          <Row label="WordPress">
            <Text>{detail.appVersion}</Text>
          </Row>
        )}
        {detail.createdAt && (
          <Row label="Created">
            <Text>{new Date(detail.createdAt).toLocaleString()}</Text>
          </Row>
        )}
      </ul>

      <SectionHeader
        title="SFTP"
        action={
          <Button onClick={() => setReveal((r) => !r)}>
            {reveal ? 'Hide secrets' : 'Reveal secrets'}
          </Button>
        }
      />
      <ul className="TableList">
        <Row label="Host">
          <ValueWithCopy value={detail.sftp.host || '—'} mono />
        </Row>
        <Row label="User">
          <ValueWithCopy value={detail.sftp.user || '—'} mono />
        </Row>
        <Row label="Password">
          <Secret reveal={reveal} value={detail.sftp.password} />
        </Row>
      </ul>

      <SectionHeader title="Database" />
      <ul className="TableList">
        <Row label="Name">
          <ValueWithCopy value={detail.db.name || '—'} mono />
        </Row>
        <Row label="User">
          <ValueWithCopy value={detail.db.user || '—'} mono />
        </Row>
        <Row label="Password">
          <Secret reveal={reveal} value={detail.db.password} />
        </Row>
      </ul>

      {detail.isWordPress && (
        <SmokeTestSection
          serverId={detail.serverId}
          appId={detail.id}
          hasApiPassword={Boolean(detail.sftp.password)}
        />
      )}
    </div>
  );
}

// Small Phase 4 diagnostic: opens SSH, runs `wp option get home`,
// shows the raw stdout so the user can verify their credentials,
// network path, and wp-cli are all wired up before attempting a pull.
function SmokeTestSection({
  serverId,
  appId,
  hasApiPassword,
}: {
  serverId: number;
  appId: number;
  hasApiPassword: boolean;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ home: string; stderr: string; elapsedMs: number } | undefined>();
  const [error, setError] = useState<string | undefined>();

  const run = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const res = await ipcClient.smokeApp({
        serverId,
        appId,
      });
      setResult({ home: res.home, stderr: res.stderr, elapsedMs: res.elapsedMs });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Connection test"
        action={
          <Button onClick={run} disabled={busy || !hasApiPassword}>
            {busy ? 'Testing…' : 'Test WP-CLI over SSH'}
          </Button>
        }
      />
      {error && (
        <div style={styles.banner}>
          <Banner variant="error">{error}</Banner>
        </div>
      )}
      {result && (
        <ul className="TableList">
          <Row label="home">
            <ValueWithCopy value={result.home || '—'} mono />
          </Row>
          <Row label="elapsed">
            <Text>{result.elapsedMs} ms</Text>
          </Row>
          {result.stderr && (
            <Row label="stderr">
              <span style={styles.monoValue}>{result.stderr}</span>
            </Row>
          )}
        </ul>
      )}
    </>
  );
}

function CredentialsMissingNotice({
  busy,
  error,
  onCreate,
}: {
  busy: boolean;
  error?: string;
  onCreate: () => void;
}): React.ReactElement {
  return (
    <div style={styles.credentialsNotice}>
      <div>
        <Text style={styles.credentialsTitle}>SSH/SFTP access is missing for this app</Text>
        <Text size="caption" style={styles.credentialsCopy}>
          CloudwaysSync needs app-level SSH/SFTP credentials and SSH shell access before it can test, pull, or push this WordPress site.
        </Text>
      </div>
      <Button onClick={onCreate} disabled={busy}>
        {busy ? 'Creating…' : 'Create SSH/SFTP + shell access'}
      </Button>
      {error && (
        <div style={styles.credentialsError}>
          <Banner variant="error">{error}</Banner>
        </div>
      )}
    </div>
  );
}

// --- Selective pull panel ---

type SelectivePanelProps = {
  heading?: string;
  includes: PullIncludes;
  onChange: (next: PullIncludes) => void;
};

const WP_CONTENT_OPTIONS: Array<{ key: keyof PullIncludes; label: string }> = [
  { key: 'uploads', label: 'Uploads (media)' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'themes', label: 'Themes' },
  { key: 'muPlugins', label: 'MU-Plugins' },
  { key: 'languages', label: 'Languages' },
];

function SelectivePanel({ heading = 'Include in sync', includes, onChange }: SelectivePanelProps): React.ReactElement {
  const toggle = (key: keyof PullIncludes) => {
    const next = { ...includes, [key]: !includes[key] };
    // If all wp-content sub-options are off, turn off wpContent too.
    // If any sub-option is on, ensure wpContent is on.
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
          <Checkbox
            checked={includes.database}
            onChange={() => toggle('database')}
          />
          <span style={selectiveStyles.label}>Database</span>
        </label>
        <label style={selectiveStyles.item}>
          <Checkbox
            checked={includes.wpContent}
            onChange={toggleWpContent}
          />
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

// --- Small building blocks ---

function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={styles.sectionHeader}>
      <Title size="m" tag="h3" style={{ margin: 0 }}>
        {title}
      </Title>
      {action}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <li>
      <strong>{label}</strong>
      <div style={styles.cellValue}>{children}</div>
    </li>
  );
}

function ValueWithCopy({ value, mono = false }: { value: string; mono?: boolean }): React.ReactElement {
  return (
    <>
      <span style={mono ? styles.monoValue : undefined}>{value}</span>
      {value && value !== '—' && <CopyButton value={value} />}
    </>
  );
}

function Secret({
  value,
  reveal,
}: {
  value: string | undefined;
  reveal: boolean;
}): React.ReactElement {
  if (!value) return <Text>—</Text>;
  if (!reveal) return <span style={styles.monoValue}>{'•'.repeat(Math.min(value.length, 12))}</span>;
  return (
    <>
      <span style={styles.monoValue}>{value}</span>
      <CopyButton value={value} />
    </>
  );
}

function CopyButton({ value }: { value: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; non-fatal */
    }
  };
  return (
    <button type="button" onClick={onClick} style={styles.copyBtn} aria-label={copied ? 'Copied' : 'Copy'}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// --- Styles ---

const RAIL_WIDTH = 260;

const styles: Record<string, React.CSSProperties> = {
  split: {
    display: 'grid',
    gridTemplateColumns: `${RAIL_WIDTH}px 1fr`,
    alignItems: 'stretch',
    gap: 0,
    flex: 1,
    minHeight: 0,
  },
  rail: {
    background: '#262727',
    padding: '6px 10px',
    overflowY: 'auto',
  },
  group: {
    paddingBottom: 12,
  },
  groupInner: {
    marginTop: 5,
  },
  appList: {
    marginTop: 5,
  },
  appListStatus: {
    padding: '6px 5px 6px 25px',
  },
  appListEmpty: {
    padding: '6px 5px 6px 25px',
    fontSize: '1.4rem',
    opacity: 0.55,
  },
  // Right detail pane — scrollable independently
  detail: {
    padding: '8px 30px 32px 32px',
    minWidth: 0,
    overflowY: 'auto',
  },
  detailHeading: {
    marginBottom: 16,
  },
  detailCrumbs: {
    marginTop: 6,
    fontSize: 12.5,
    opacity: 0.6,
  },
  actionBar: {
    display: 'flex',
    justifyContent: 'flex-start',
    marginBottom: 16,
  },
  banner: {
    marginBottom: 16,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    margin: '24px 0 6px',
  },
  cellValue: {
    display: 'table-cell',
    verticalAlign: 'middle',
    padding: '0 30px 0 0',
    lineHeight: '48px',
  },
  monoValue: {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
  },
  credentialsNotice: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: 16,
    marginBottom: 16,
    padding: '14px 16px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
  },
  credentialsTitle: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 4,
  },
  credentialsCopy: {
    display: 'block',
    opacity: 0.62,
  },
  credentialsError: {
    gridColumn: '1 / -1',
  },
  copyBtn: {
    marginLeft: 12,
    border: '1px solid rgba(255, 255, 255, 0.18)',
    background: 'transparent',
    color: 'inherit',
    padding: '2px 10px',
    borderRadius: 3,
    fontSize: 11,
    cursor: 'pointer',
    verticalAlign: 'middle',
  },
  emptyDetail: {
    padding: '80px 20px',
    textAlign: 'center',
    opacity: 0.8,
  },
  emptyBody: {
    display: 'block',
    marginTop: 10,
    opacity: 0.7,
  },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 60,
  },
};
