import React, { useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  Spinner,
  Text,
  TextButton,
  Title,
} from '@getflywheel/local-components';
import type { Site } from '@getflywheel/local';
import { ipcClient, IpcCallError, subscribeJobProgress } from '../ipcClient';
import type {
  AppSummary,
  ConnectionStatusPayload,
  JobProgressEvent,
  PushIncludes,
  ServerSummary,
  SiteMapping,
  UndoRecord,
} from '../../shared/ipcTypes';

const PUSH_STEP_LABELS: Record<string, string> = {
  validate: 'Validating',
  'remote-backup': 'Backing up remote',
  ssh: 'Connecting over SSH',
  metadata: 'Reading remote metadata',
  'local-export-db': 'Exporting local DB',
  'upload-db': 'Uploading database',
  'upload-content': 'Uploading wp-content',
  'remote-db-import': 'Importing DB on server',
  'search-replace': 'Rewriting URLs',
  'cache-flush': 'Flushing caches',
  cleanup: 'Cleaning up',
};

export function SiteToolsPanel({ site }: { site: Site }): React.ReactElement {
  const [status, setStatus] = useState<ConnectionStatusPayload | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [mapping, setMapping] = useState<SiteMapping | null | undefined>(undefined);

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
    // Check if this Local site is linked to a Cloudways app
    void (async () => {
      try {
        const res = await ipcClient.getMapping({ localSiteId: site.id });
        if (!cancelled) setMapping(res.mapping);
      } catch {
        if (!cancelled) setMapping(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [site.id]);

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
      ) : status === undefined || mapping === undefined ? (
        <div style={styles.center}><Spinner /></div>
      ) : status.connected ? (
        mapping ? (
          <LinkedState
            site={site}
            email={status.email}
            mapping={mapping}
            onUnlink={() => setMapping(null)}
          />
        ) : (
          <UnlinkedState
            site={site}
            email={status.email}
            onLinked={(m) => setMapping(m)}
          />
        )
      ) : (
        <DisconnectedState />
      )}
    </div>
  );
}

// --- Connected + Mapped: Push controls ---

function LinkedState({
  site,
  email,
  mapping,
  onUnlink,
}: {
  site: Site;
  email: string;
  mapping: SiteMapping;
  onUnlink: () => void;
}): React.ReactElement {
  const [pushBusy, setPushBusy] = useState(false);
  const [pushResult, setPushResult] = useState<string | undefined>();
  const [pushErr, setPushErr] = useState<string | undefined>();
  const [pushStep, setPushStep] = useState<
    { stepId: string; percent?: number; detail?: string } | undefined
  >();
  const [includes, setIncludes] = useState<PushIncludes>({
    database: true,
    wpContent: true,
    uploads: true,
    plugins: true,
    themes: true,
    muPlugins: true,
    languages: true,
  });
  const [lastPushUndoId, setLastPushUndoId] = useState<string | undefined>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoResult, setUndoResult] = useState<string | undefined>();
  const [undoErr, setUndoErr] = useState<string | undefined>();

  useEffect(() => {
    const unsubscribe = subscribeJobProgress((event: JobProgressEvent) => {
      if (!pushBusy) return;
      const percent =
        typeof event.totalBytes === 'number' &&
        event.totalBytes > 0 &&
        typeof event.bytesTransferred === 'number'
          ? Math.min(100, Math.round((event.bytesTransferred / event.totalBytes) * 100))
          : undefined;
      if (event.status === 'running') {
        setPushStep({ stepId: event.stepId, percent, detail: event.detail });
      } else if (event.status === 'success' || event.status === 'failed') {
        setPushStep(undefined);
      }
    });
    return unsubscribe;
  }, [pushBusy]);

  const runPush = async () => {
    setPushBusy(true);
    setPushResult(undefined);
    setPushErr(undefined);
    setPushStep(undefined);
    setLastPushUndoId(undefined);
    try {
      const plan = await ipcClient.planPush({
        serverId: mapping.serverId,
        appId: mapping.appId,
        localSiteId: site.id,
        localUrl: site.url || `http://${site.domain}`,
        webRootPath: site.paths.webRoot,
        includes,
      });
      const job = await ipcClient.runJob({ planId: plan.planId });
      setPushResult('Push completed successfully.');
      try {
        const undos = await ipcClient.listUndo();
        const latest = undos.records.find(
          (r) => r.appId === mapping.appId && !r.undoneAt,
        );
        if (latest) setLastPushUndoId(latest.id);
      } catch { /* non-fatal */ }
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
      setPushStep(undefined);
    }
  };

  const runUndo = async () => {
    if (!lastPushUndoId) return;
    setUndoBusy(true);
    setUndoResult(undefined);
    setUndoErr(undefined);
    try {
      await ipcClient.undoPush({ recordId: lastPushUndoId });
      setUndoResult('Undo completed — remote site restored to pre-push state.');
      setLastPushUndoId(undefined);
    } catch (e) {
      setUndoErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoBusy(false);
    }
  };

  const pushLabel = (() => {
    if (!pushBusy) return 'Push to Cloudways';
    if (!pushStep) return 'Pushing\u2026';
    const label = PUSH_STEP_LABELS[pushStep.stepId] ?? pushStep.stepId;
    return pushStep.percent != null
      ? `Pushing \u2014 ${label} (${pushStep.percent}%)`
      : `Pushing \u2014 ${label}`;
  })();

  return (
    <section>
      <Banner variant="success">
        Connected as <strong>{email}</strong>
      </Banner>

      <div style={styles.linkedInfo}>
        <Text style={{ fontWeight: 600 }}>
          Linked to: {mapping.appLabel}
        </Text>
        <Text size="caption" style={{ opacity: 0.6 }}>
          Server {mapping.serverId} &middot; App {mapping.appId}
        </Text>
      </div>

      <div style={styles.actionBar}>
        <Button onClick={runPush} disabled={pushBusy}>
          {pushLabel}
        </Button>
        {lastPushUndoId && !pushBusy && (
          <Button onClick={runUndo} disabled={undoBusy} style={{ marginLeft: 8 }}>
            {undoBusy ? 'Restoring\u2026' : 'Undo last push'}
          </Button>
        )}
      </div>

      {pushBusy && pushStep?.detail && (
        <div style={{ marginBottom: 8, fontSize: 11, opacity: 0.65 }}>
          {pushStep.detail}
        </div>
      )}

      {!pushBusy && (
        <SelectivePanel includes={includes} onChange={setIncludes} />
      )}

      {pushErr && <div style={styles.banner}><Banner variant="error">{pushErr}</Banner></div>}
      {pushResult && <div style={styles.banner}><Banner variant="success">{pushResult}</Banner></div>}
      {undoErr && <div style={styles.banner}><Banner variant="error">{undoErr}</Banner></div>}
      {undoResult && <div style={styles.banner}><Banner variant="success">{undoResult}</Banner></div>}

      <div style={styles.row}>
        <TextButton onClick={onUnlink}>Unlink this app</TextButton>
      </div>
    </section>
  );
}

// --- Connected + Not Mapped: Server/App picker to link ---

function UnlinkedState({
  site,
  email,
  onLinked,
}: {
  site: Site;
  email: string;
  onLinked: (mapping: SiteMapping) => void;
}): React.ReactElement {
  const [servers, setServers] = useState<ServerSummary[] | undefined>();
  const [apps, setApps] = useState<AppSummary[] | undefined>();
  const [selectedServerId, setSelectedServerId] = useState<number | undefined>();
  const [selectedAppId, setSelectedAppId] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    ipcClient.listServers()
      .then((res) => { if (!cancelled) setServers(res.servers); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedServerId) { setApps(undefined); return; }
    let cancelled = false;
    setApps(undefined);
    setSelectedAppId(undefined);
    ipcClient.listApps({ serverId: selectedServerId })
      .then((res) => { if (!cancelled) setApps(res.apps); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [selectedServerId]);

  const link = async () => {
    if (!selectedServerId || !selectedAppId) return;
    const app = apps?.find((a) => a.id === selectedAppId);
    setBusy(true);
    setError(undefined);
    try {
      const res = await ipcClient.mapSite({
        localSiteId: site.id,
        serverId: selectedServerId,
        appId: selectedAppId,
        appLabel: app?.label ?? `App ${selectedAppId}`,
        remoteUrl: app?.appFqdn ? `https://${app.appFqdn}` : '',
      });
      onLinked(res.mapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <Banner variant="success">
        Connected as <strong>{email}</strong>
      </Banner>

      <div style={styles.row}>
        <Title size="s" tag="h2">
          Link to a Cloudways app
        </Title>
      </div>
      <div style={styles.row}>
        <Text>
          Pick the Cloudways app this Local site should sync with. Once linked,
          you can push local changes with one click.
        </Text>
      </div>

      <div style={styles.pickerRow}>
        <label style={styles.pickerLabel}>
          <Text size="caption" style={{ marginBottom: 4 }}>Server</Text>
          <select
            style={styles.select}
            value={selectedServerId ?? ''}
            onChange={(e) => setSelectedServerId(e.target.value ? Number(e.target.value) : undefined)}
            disabled={!servers}
          >
            <option value="">{servers ? 'Select a server\u2026' : 'Loading\u2026'}</option>
            {servers?.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      {selectedServerId && (
        <div style={styles.pickerRow}>
          <label style={styles.pickerLabel}>
            <Text size="caption" style={{ marginBottom: 4 }}>App</Text>
            <select
              style={styles.select}
              value={selectedAppId ?? ''}
              onChange={(e) => setSelectedAppId(e.target.value ? Number(e.target.value) : undefined)}
              disabled={!apps}
            >
              <option value="">{apps ? 'Select an app\u2026' : 'Loading\u2026'}</option>
              {apps?.filter((a) => a.isWordPress).map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {selectedAppId && (
        <div style={styles.row}>
          <Button onClick={link} disabled={busy}>
            {busy ? 'Linking\u2026' : 'Link this app'}
          </Button>
        </div>
      )}

      {error && <div style={styles.banner}><Banner variant="error">{error}</Banner></div>}
    </section>
  );
}

// --- Disconnected ---

function DisconnectedState(): React.ReactElement {
  return (
    <section>
      <Banner variant="warning">CloudwaysSync isn&rsquo;t connected to a Cloudways account yet.</Banner>
      <div style={styles.row}>
        <Text>
          Open Local&rsquo;s <strong>Preferences</strong> and pick <strong>CloudwaysSync</strong> in the
          sidebar to connect your Cloudways API key.
        </Text>
      </div>
    </section>
  );
}

// --- Selective push panel ---

const WP_CONTENT_OPTIONS: Array<{ key: keyof PushIncludes; label: string }> = [
  { key: 'uploads', label: 'Uploads (media)' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'themes', label: 'Themes' },
  { key: 'muPlugins', label: 'MU-Plugins' },
  { key: 'languages', label: 'Languages' },
];

function SelectivePanel({
  includes,
  onChange,
}: {
  includes: PushIncludes;
  onChange: (next: PushIncludes) => void;
}): React.ReactElement {
  const toggle = (key: keyof PushIncludes) => {
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
      <Text style={selectiveStyles.heading}>Include in push</Text>
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

const styles: Record<string, React.CSSProperties> = {
  wrap: { padding: 24 },
  header: { marginBottom: 24 },
  row: { marginTop: 12 },
  banner: { marginTop: 12 },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  linkedInfo: {
    marginTop: 16,
    marginBottom: 16,
    padding: '12px 16px',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
  },
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: 16,
  },
  pickerRow: {
    marginTop: 12,
  },
  pickerLabel: {
    display: 'block',
  },
  select: {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 4,
    border: '1px solid rgba(255,255,255,0.15)',
    background: '#303031',
    color: '#fff',
    fontSize: 13,
    outline: 'none',
  },
};
