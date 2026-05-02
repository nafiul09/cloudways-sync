import React, { useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  FlySelect,
  Spinner,
  Text,
  TextButton,
  Title,
} from '../components/ui';
import type { Site } from '@getflywheel/local';
import { ipcClient, IpcCallError, subscribeJobProgress } from '../ipcClient';
import { refreshSiteListIcons } from '../sidebar/injectSiteListIcons';
import { showSyncModal, dismissSyncModal, failSyncModal, showPostPushModal, onPostPushAction } from '../SyncModal';
import { MaskedEmail } from '../components/MaskedEmail';
import { LinkViaSftpDialog } from './LinkViaSftpDialog';
import type {
  ApiSiteMapping,
  AppDetail,
  AppSummary,
  BreezeStatus,
  ConnectionStatusPayload,
  JobProgressEvent,
  PullIncludes,
  PushIncludes,
  ServerSummary,
  SftpSiteMapping,
  SiteMapping,
  SmokeAppResponse,
} from '../../shared/ipcTypes';
import { isApiMapping } from '../../shared/ipcTypes';

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
  'breeze-reactivate': 'Re-activating Breeze',
  cleanup: 'Cleaning up',
};

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

const CWS_CSS = `
  @keyframes cws-spin {
    to { transform: rotate(360deg); }
  }
  .cws-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.15);
    border-top-color: rgba(255,255,255,0.6);
    border-radius: 50%;
    animation: cws-spin 0.7s linear infinite;
    flex-shrink: 0;
  }
`;

const LOCAL_FLY_SELECT_CSS = `
  .cws-local-select.FlySelect {
    box-sizing: border-box;
    display: inline-block;
    height: 30px;
    min-width: 146px;
    max-width: 100%;
    padding: 0 35px 0 10px;
    position: relative;
    color: #d9d9d9;
    background: #252626;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 300;
    line-height: 30px;
    user-select: none;
    vertical-align: middle;
  }

  .cws-local-select.FlySelect[disabled] {
    cursor: default;
    filter: grayscale(100%);
    opacity: 0.58;
    pointer-events: none;
  }

  .cws-local-select.FlySelect:not(.FlySelect__Open).FlySelect__Focus,
  .cws-local-select.FlySelect:not(.FlySelect__Open):focus {
    outline: none;
    box-shadow: 0 0 0 2px #51bb7b;
  }

  .cws-local-select.FlySelect.FlySelect__Open {
    z-index: 10000;
  }

  .cws-local-select.FlySelect > svg {
    position: absolute;
    right: 9px;
    top: 50%;
    width: 14px;
    height: 6px;
    margin: -3px 0 0;
  }

  .cws-local-select.FlySelect svg path {
    fill: #51bb7b;
  }

  .cws-local-select.FlySelect:hover > svg path {
    fill: #74d79a;
  }

  .cws-local-select .CurrentValue,
  .cws-local-select .FlySelect_Option {
    display: flex;
    align-items: center;
    height: 30px;
    cursor: pointer;
    line-height: 30px;
  }

  .cws-local-select .CurrentValue * {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cws-local-select .CurrentValue_Placeholder {
    color: rgba(217, 217, 217, 0.65);
  }

  .cws-local-select .FlySelect__Right {
    display: flex;
    align-items: center;
    margin-left: auto;
  }

  .cws-local-select .FlySelect_Options {
    display: none;
    width: auto;
    position: fixed;
    background: #2b2c2c;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }

  .cws-local-select.FlySelect__Open .FlySelect_Options {
    display: block;
  }

  .cws-local-select .FlySelect_OptionsContainer {
    max-height: inherit;
    overflow: auto;
  }

  .cws-local-select .FlySelect_Option {
    box-sizing: border-box;
    min-width: 100%;
    padding: 0 10px;
    color: #d9d9d9;
  }

  .cws-local-select .FlySelect_Option:hover,
  .cws-local-select .FlySelect_Option:focus {
    color: #fff;
    background: #2f8f55;
    outline: none;
  }

  .cws-local-select .FlySelect_Option:hover span,
  .cws-local-select .FlySelect_Option:focus span,
  .cws-local-select .FlySelect_Option:hover svg path,
  .cws-local-select .FlySelect_Option:focus svg path {
    color: #fff;
    fill: #fff;
  }

  .cws-local-select .FlySelect__Check {
    width: 12px;
    height: 10px;
    margin-left: 10px;
  }
`;

export function SiteToolsPanel({ site }: { site: Site }): React.ReactElement {
  const [status, setStatus] = useState<ConnectionStatusPayload | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [mapping, setMapping] = useState<SiteMapping | null | undefined>(undefined);
  const [unlinkError, setUnlinkError] = useState<string | undefined>();

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
        if (cancelled) return;
        const m = res.mapping;
        // Backfill serverLabel for API mappings created before that field
        // existed. SFTP mappings are linked locally — there is no remote
        // server label to fetch.
        if (m && isApiMapping(m) && !m.serverLabel) {
          try {
            const servers = await ipcClient.listServers();
            const server = servers.servers.find((s) => s.id === m.serverId);
            if (server) {
              m.serverLabel = server.label;
              // Persist so we don't need to fetch again.
              ipcClient.mapSite({
                localSiteId: m.localSiteId,
                serverId: m.serverId,
                appId: m.appId,
                appLabel: m.appLabel,
                serverLabel: server.label,
                remoteUrl: m.remoteUrl,
              }).catch(() => { /* non-fatal */ });
            }
          } catch { /* non-fatal */ }
        }
        if (!cancelled) setMapping(m);
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
      <style>{CWS_CSS}{LOCAL_FLY_SELECT_CSS}</style>
      <header style={styles.header}>
        <Title size="l" tag="h1">
          Cloudways Sync
        </Title>
        <Text size="caption">Site: {site?.name ?? 'unknown'}</Text>
      </header>

      {loadError ? (
        <Banner variant="error">Could not read connection status: {loadError}</Banner>
      ) : status === undefined || mapping === undefined ? (
        <div style={styles.center}><Spinner /></div>
      ) : mapping ? (
        <>
          {unlinkError && <div style={styles.banner}><Banner variant="error">{unlinkError}</Banner></div>}
          {isApiMapping(mapping) ? (
            status.connected ? (
              <LinkedState
                site={site}
                email={status.email}
                mapping={mapping}
                onUnlink={() => {
                  const previous = mapping;
                  setUnlinkError(undefined);
                  setMapping(null);
                  ipcClient.unmapSite({
                    localSiteId: site.id,
                    serverId: previous.serverId,
                    appId: previous.appId,
                  }).then(() => {
                    refreshSiteListIcons();
                  }).catch((err) => {
                    setMapping(previous);
                    setUnlinkError(err instanceof IpcCallError ? err.message : String(err));
                  });
                }}
              />
            ) : (
              // API-linked but the user disconnected. Show the badge but
              // explain they need to reconnect to push/pull.
              <ApiLinkedDisconnected mapping={mapping} />
            )
          ) : (
            <SftpLinkedState
              site={site}
              mapping={mapping}
              onUnlink={() => {
                const previous = mapping;
                setUnlinkError(undefined);
                setMapping(null);
                ipcClient.unmapSite({ localSiteId: site.id })
                  .then(() => { refreshSiteListIcons(); })
                  .catch((err) => {
                    setMapping(previous);
                    setUnlinkError(err instanceof IpcCallError ? err.message : String(err));
                  });
              }}
            />
          )}
        </>
      ) : (
        <UnlinkedState
          site={site}
          email={status.connected ? status.email : undefined}
          onLinked={(m) => { setMapping(m); refreshSiteListIcons(); }}
        />
      )}
    </div>
  );
}

// --- Connected + Mapped: Push & Pull controls ---

type SyncStep = { stepId: string; percent?: number; detail?: string };

const DEFAULT_INCLUDES = {
  database: true,
  wpContent: true,
  uploads: true,
  plugins: true,
  themes: true,
  muPlugins: true,
  languages: true,
};

function LinkedState({
  site,
  email,
  mapping,
  onUnlink,
}: {
  site: Site;
  email: string;
  mapping: ApiSiteMapping;
  onUnlink: () => void;
}): React.ReactElement {
  const [mode, setMode] = useState<'push' | 'pull'>('push');

  // --- Push state ---
  const [pushBusy, setPushBusy] = useState(false);
  const [pushStep, setPushStep] = useState<SyncStep | undefined>();
  const [pushIncludes, setPushIncludes] = useState<PushIncludes>({ ...DEFAULT_INCLUDES });
  const [lastPushUndoId, setLastPushUndoId] = useState<string | undefined>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoResult, setUndoResult] = useState<string | undefined>();
  const [undoErr, setUndoErr] = useState<string | undefined>();

  // --- Pull state ---
  const [pullBusy, setPullBusy] = useState(false);
  const [pullStep, setPullStep] = useState<SyncStep | undefined>();
  const [pullIncludes, setPullIncludes] = useState<PullIncludes>({ ...DEFAULT_INCLUDES });
  const [appDetail, setAppDetail] = useState<AppDetail | undefined>();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | undefined>();

  // --- Breeze state ---
  const [breezeStatus, setBreezeStatus] = useState<BreezeStatus | undefined>();
  const [reactivateBreeze, setReactivateBreeze] = useState(true);

  const busy = pushBusy || pullBusy || credentialBusy;
  const canSync = Boolean(appDetail?.sftp.password);

  // Hydrate undo state from ledger on mount so the button survives restarts.
  useEffect(() => {
    let cancelled = false;
    ipcClient.listUndo()
      .then((res) => {
        if (cancelled) return;
        const latest = res.records.find(
          (r) => r.appId === mapping.appId && !r.undoneAt && !r.dismissedAt,
        );
        if (latest) setLastPushUndoId(latest.id);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [mapping.appId]);

  // Listen for undo/confirm actions from the post-push modal
  useEffect(() => {
    return onPostPushAction(() => setLastPushUndoId(undefined));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAppDetail(undefined);
    setCredentialError(undefined);
    ipcClient.getApp({ serverId: mapping.serverId, appId: mapping.appId })
      .then((res) => { if (!cancelled) setAppDetail(res.app); })
      .catch((e) => { if (!cancelled) setCredentialError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [mapping.serverId, mapping.appId]);

  // Detect Breeze plugin on the remote once app details are loaded.
  useEffect(() => {
    if (!appDetail?.sftp.password) return;
    let cancelled = false;
    setBreezeStatus(undefined);
    ipcClient.detectBreeze({ serverId: mapping.serverId, appId: mapping.appId })
      .then((res) => { if (!cancelled) setBreezeStatus(res.breezeStatus); })
      .catch(() => { if (!cancelled) setBreezeStatus({ installed: false, active: false }); });
    return () => { cancelled = true; };
  }, [appDetail?.sftp.password, mapping.serverId, mapping.appId]);

  // Subscribe to job progress for whichever operation is running.
  useEffect(() => {
    const unsubscribe = subscribeJobProgress((event: JobProgressEvent) => {
      if (!pushBusy && !pullBusy) return;
      const percent =
        typeof event.totalBytes === 'number' &&
        event.totalBytes > 0 &&
        typeof event.bytesTransferred === 'number'
          ? Math.min(100, Math.round((event.bytesTransferred / event.totalBytes) * 100))
          : undefined;
      const step: SyncStep = { stepId: event.stepId, percent, detail: event.detail };
      if (event.status === 'running') {
        if (pushBusy) setPushStep(step);
        if (pullBusy) setPullStep(step);
      } else if (event.status === 'success' || event.status === 'failed') {
        setPushStep(undefined);
        setPullStep(undefined);
      }
    });
    return unsubscribe;
  }, [pushBusy, pullBusy]);

  // Prevent Electron from closing while any operation is in flight.
  useEffect(() => {
    if (!pushBusy && !pullBusy && !undoBusy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'A sync operation is in progress. Closing now may leave your site in a broken state.';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pushBusy, pullBusy, undoBusy]);

  // --- Push handler ---
  const runPush = async () => {
    setPushBusy(true);
    setPushStep(undefined);
    setLastPushUndoId(undefined);
    showSyncModal('push', mapping.appLabel);
    try {
      const plan = await ipcClient.planPush({
        serverId: mapping.serverId,
        appId: mapping.appId,
        localSiteId: site.id,
        localUrl: site.url || `http://${site.domain}`,
        webRootPath: site.paths?.webRoot || `${site.path}/app/public`,
        includes: pushIncludes,
        reactivateBreeze: breezeStatus?.active ? reactivateBreeze : false,
      });
      await ipcClient.runJob({ planId: plan.planId });
      // Push succeeded — show post-push modal with undo/confirm
      try {
        const undos = await ipcClient.listUndo();
        const latest = undos.records.find(
          (r) => r.appId === mapping.appId && !r.undoneAt && !r.dismissedAt,
        );
        if (latest) {
          setLastPushUndoId(latest.id);
          showPostPushModal(mapping.appLabel, latest.id);
        }
      } catch { /* non-fatal — modal will show generic done */ }
    } catch (e) {
      failSyncModal(e instanceof Error ? e.message : String(e));
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
    showSyncModal('undo', mapping.appLabel);
    try {
      await ipcClient.undoPush({ recordId: lastPushUndoId });
      setUndoResult('Undo completed — remote site restored to pre-push state.');
      setLastPushUndoId(undefined);
      dismissSyncModal();
    } catch (e) {
      setUndoErr(e instanceof Error ? e.message : String(e));
      failSyncModal(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoBusy(false);
    }
  };

  const dismissUndo = async () => {
    if (!lastPushUndoId) return;
    setUndoBusy(true);
    setUndoErr(undefined);
    setUndoResult(undefined);
    showSyncModal('confirm', mapping.appLabel);
    try {
      await ipcClient.dismissUndo({ recordId: lastPushUndoId });
      setUndoResult('Push confirmed — snapshot cleaned.');
      setLastPushUndoId(undefined);
      dismissSyncModal();
    } catch (e) {
      setUndoErr(e instanceof Error ? e.message : String(e));
      failSyncModal(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoBusy(false);
    }
  };

  // --- Pull handler ---
  const runPull = async () => {
    setPullBusy(true);
    setPullStep(undefined);
    showSyncModal('pull', mapping.appLabel);
    try {
      const plan = await ipcClient.planPull({
        serverId: mapping.serverId,
        appId: mapping.appId,
        destinationName: mapping.appLabel,
        serverLabel: mapping.serverLabel,
        localSiteId: site.id,
        includes: pullIncludes,
      });
      await ipcClient.runJob({ planId: plan.planId });
    } catch (e) {
      failSyncModal(e instanceof Error ? e.message : String(e));
    } finally {
      setPullBusy(false);
      setPullStep(undefined);
    }
  };

  const createCredentials = async () => {
    setCredentialBusy(true);
    setCredentialError(undefined);
    try {
      const res = await ipcClient.createAppCredential({ serverId: mapping.serverId, appId: mapping.appId });
      setAppDetail((prev) => prev
        ? { ...prev, sftp: res.sftp, db: { ...prev.db, password: res.sftp.password } }
        : prev);
    } catch (e) {
      setCredentialError(e instanceof Error ? e.message : String(e));
    } finally {
      setCredentialBusy(false);
    }
  };

  // --- Labels ---
  const pushLabel = (() => {
    if (!pushBusy) return 'Push to Cloudways';
    if (!pushStep) return 'Pushing…';
    const label = PUSH_STEP_LABELS[pushStep.stepId] ?? pushStep.stepId;
    return pushStep.percent != null
      ? `Pushing — ${label} (${pushStep.percent}%)`
      : `Pushing — ${label}`;
  })();

  const pullLabel = (() => {
    if (!pullBusy) return 'Pull from Cloudways';
    if (!pullStep) return 'Pulling…';
    const label = PULL_STEP_LABELS[pullStep.stepId] ?? pullStep.stepId;
    return pullStep.percent != null
      ? `Pulling — ${label} (${pullStep.percent}%)`
      : `Pulling — ${label}`;
  })();

  return (
    <section>
      <Banner variant="success">
        Connected as <MaskedEmail email={email} bold />
      </Banner>

      <div style={styles.linkedInfo}>
        <div style={styles.linkedHeader}>
          <Text style={styles.linkedHeading}>Linked Cloudways App</Text>
          <TextButton onClick={onUnlink} style={styles.unlinkBtn}>Unlink</TextButton>
        </div>
        <div style={styles.linkedGrid}>
          <Text size="caption" style={styles.linkedLabel}>App</Text>
          <Text style={styles.linkedValue}>{mapping.appLabel}</Text>
          <Text size="caption" style={styles.linkedLabel}>Server</Text>
          <Text style={styles.linkedValue}>{mapping.serverLabel ?? `ID ${mapping.serverId}`}</Text>
          {mapping.remoteUrl ? (
            <>
              <Text size="caption" style={styles.linkedLabel}>URL</Text>
              <a
                href={mapping.remoteUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...styles.linkedValue, color: '#51bb7b', textDecoration: 'none' }}
                onClick={(e) => {
                  e.preventDefault();
                  try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
                    const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };
                    shell.openExternal(mapping.remoteUrl);
                  } catch {
                    window.open(mapping.remoteUrl, '_blank');
                  }
                }}
              >
                {mapping.remoteUrl}
              </a>
            </>
          ) : null}
        </div>
      </div>

      {appDetail && !appDetail.sftp.password && (
        <div style={styles.credentialsNotice}>
          <div>
            <Text style={styles.credentialsTitle}>SSH/SFTP access is missing for this app</Text>
            <Text size="caption" style={styles.credentialsCopy}>
              Create app-level credentials and enable SSH shell access before testing, pulling, or pushing this WordPress site.
            </Text>
          </div>
          <Button onClick={createCredentials} disabled={busy}>
            {credentialBusy ? 'Creating…' : 'Create SSH/SFTP + shell access'}
          </Button>
          {credentialError && (
            <div style={styles.credentialsError}>
              <Banner variant="error">{credentialError}</Banner>
            </div>
          )}
        </div>
      )}

      {/* Push / Pull tab switcher */}
      <div style={styles.tabs}>
        <button
          type="button"
          style={mode === 'push' ? styles.tabActive : styles.tab}
          onClick={() => setMode('push')}
          disabled={busy}
        >
          Push
        </button>
        <button
          type="button"
          style={mode === 'pull' ? styles.tabActive : styles.tab}
          onClick={() => setMode('pull')}
          disabled={busy}
        >
          Pull
        </button>
      </div>

      {mode === 'push' ? (
        <>
          {pushBusy && pushStep?.detail && (
            <div style={{ marginBottom: 8, fontSize: 11, opacity: 0.65 }}>
              {pushStep.detail}
            </div>
          )}
          {!pushBusy && (
            <>
              <SelectivePanel heading="Include in push" includes={pushIncludes} onChange={setPushIncludes} />
              {breezeStatus?.active && (
                <div style={styles.breezeNotice}>
                  <div style={styles.breezeHeader}>
                    <Checkbox
                      checked={reactivateBreeze}
                      onChange={() => setReactivateBreeze(!reactivateBreeze)}
                    />
                    <div>
                      <Text style={styles.breezeTitle}>Breeze caching plugin detected</Text>
                      <Text size="caption" style={styles.breezeDesc}>
                        Re-activate Breeze on Cloudways after push. The plugin is excluded
                        from sync because it requires Cloudways server configuration to function.
                      </Text>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          {undoErr && <div style={styles.banner}><Banner variant="error">{undoErr}</Banner></div>}
          {undoResult && <div style={styles.banner}><Banner variant="success">{undoResult}</Banner></div>}
          <div style={styles.actionBar}>
            <Button onClick={runPush} disabled={busy || !canSync}>
              {pushLabel}
            </Button>
            {lastPushUndoId && !pushBusy && (
              <>
                <Button onClick={runUndo} disabled={undoBusy} style={{ marginLeft: 8 }}>
                  {undoBusy ? 'Restoring…' : 'Undo last push'}
                </Button>
                <Button onClick={dismissUndo} disabled={undoBusy} style={{ marginLeft: 8 }}>
                  Confirm push
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {pullBusy && pullStep?.detail && (
            <div style={{ marginBottom: 8, fontSize: 11, opacity: 0.65 }}>
              {pullStep.detail}
            </div>
          )}
          {!pullBusy && (
            <SelectivePanel heading="Include in pull" includes={pullIncludes} onChange={setPullIncludes} />
          )}
          <div style={styles.actionBar}>
            <Button onClick={runPull} disabled={busy || !canSync}>
              {pullLabel}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// --- Linked via SFTP-only mode (Phase 1 placeholder) ---
//
// The full Push / Pull UI for SFTP mappings is wired up in later phases.
// For Phase 1 we ship the type plumbing and a minimal "linked" view so
// existing API-mode users see no regressions while the rest of the
// feature lands behind the scenes.

function SftpLinkedState({
  site,
  mapping,
  onUnlink,
}: {
  site: Site;
  mapping: SftpSiteMapping;
  onUnlink: () => void;
}): React.ReactElement {
  // SFTP mode supports push + undo + pull (read-only) as of Phase 4.
  const [mode, setMode] = useState<'push' | 'pull'>('push');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushStep, setPushStep] = useState<SyncStep | undefined>();
  const [pushIncludes, setPushIncludes] = useState<PushIncludes>({ ...DEFAULT_INCLUDES });
  const [lastPushUndoId, setLastPushUndoId] = useState<string | undefined>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoResult, setUndoResult] = useState<string | undefined>();
  const [undoErr, setUndoErr] = useState<string | undefined>();

  // --- Pull state ---
  const [pullBusy, setPullBusy] = useState(false);
  const [pullStep, setPullStep] = useState<SyncStep | undefined>();
  const [pullIncludes, setPullIncludes] = useState<PullIncludes>({ ...DEFAULT_INCLUDES });

  const busy = pushBusy || pullBusy || undoBusy;

  useEffect(() => {
    const unsubscribe = subscribeJobProgress((event: JobProgressEvent) => {
      if (!pushBusy && !pullBusy) return;
      const percent =
        typeof event.totalBytes === 'number' &&
        event.totalBytes > 0 &&
        typeof event.bytesTransferred === 'number'
          ? Math.min(100, Math.round((event.bytesTransferred / event.totalBytes) * 100))
          : undefined;
      const step: SyncStep = { stepId: event.stepId, percent, detail: event.detail };
      if (event.status === 'running') {
        if (pushBusy) setPushStep(step);
        if (pullBusy) setPullStep(step);
      } else if (event.status === 'success' || event.status === 'failed') {
        setPushStep(undefined);
        setPullStep(undefined);
      }
    });
    return unsubscribe;
  }, [pushBusy, pullBusy]);

  // Hydrate undo state from ledger on mount so the button survives restarts.
  useEffect(() => {
    let cancelled = false;
    ipcClient.listUndo()
      .then((res) => {
        if (cancelled) return;
        const latest = res.records.find(
          (r) => r.localSiteId === site.id && !r.undoneAt && !r.dismissedAt,
        );
        if (latest) setLastPushUndoId(latest.id);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [site.id]);

  // Listen for undo/confirm actions from the post-push modal
  useEffect(() => {
    return onPostPushAction(() => setLastPushUndoId(undefined));
  }, []);

  // Prevent Electron from closing while any operation is in flight.
  useEffect(() => {
    if (!pushBusy && !pullBusy && !undoBusy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'A sync operation is in progress. Closing now may leave your site in a broken state.';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pushBusy, pullBusy, undoBusy]);

  const runPush = async () => {
    setPushBusy(true);
    setPushStep(undefined);
    setLastPushUndoId(undefined);
    setUndoErr(undefined);
    setUndoResult(undefined);
    showSyncModal('push', mapping.appLabel);
    try {
      const plan = await ipcClient.planPush({
        linkMode: 'sftp',
        localSiteId: site.id,
        localUrl: site.url || `http://${site.domain}`,
        webRootPath: site.paths?.webRoot || `${site.path}/app/public`,
        includes: pushIncludes,
      });
      await ipcClient.runJob({ planId: plan.planId });
      // Push succeeded — show post-push modal with undo/confirm
      try {
        const undos = await ipcClient.listUndo();
        const latest = undos.records.find(
          (r) => r.localSiteId === site.id && !r.undoneAt && !r.dismissedAt,
        );
        if (latest) {
          setLastPushUndoId(latest.id);
          showPostPushModal(mapping.appLabel, latest.id);
        }
      } catch { /* non-fatal — modal will show generic done */ }
    } catch (e) {
      failSyncModal(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
      setPushStep(undefined);
    }
  };

  const runUndo = async () => {
    if (!lastPushUndoId) return;
    setUndoBusy(true);
    setUndoErr(undefined);
    setUndoResult(undefined);
    showSyncModal('undo', mapping.appLabel);
    try {
      await ipcClient.undoPush({ recordId: lastPushUndoId });
      setUndoResult('Undo completed — remote site restored from local snapshot.');
      setLastPushUndoId(undefined);
      dismissSyncModal();
    } catch (e) {
      setUndoErr(e instanceof Error ? e.message : String(e));
      failSyncModal(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoBusy(false);
    }
  };

  const dismissUndo = async () => {
    if (!lastPushUndoId) return;
    setUndoBusy(true);
    setUndoErr(undefined);
    setUndoResult(undefined);
    showSyncModal('confirm', mapping.appLabel);
    try {
      await ipcClient.dismissUndo({ recordId: lastPushUndoId });
      setUndoResult('Push confirmed — snapshot cleaned from server.');
      setLastPushUndoId(undefined);
      dismissSyncModal();
    } catch (e) {
      setUndoErr(e instanceof Error ? e.message : String(e));
      failSyncModal(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoBusy(false);
    }
  };

  const runPull = async () => {
    setPullBusy(true);
    setPullStep(undefined);
    showSyncModal('pull', mapping.appLabel);
    try {
      const plan = await ipcClient.planPull({
        linkMode: 'sftp',
        destinationName: mapping.appLabel,
        localSiteId: site.id,
        includes: pullIncludes,
      });
      await ipcClient.runJob({ planId: plan.planId });
    } catch (e) {
      failSyncModal(e instanceof Error ? e.message : String(e));
    } finally {
      setPullBusy(false);
      setPullStep(undefined);
    }
  };

  const pushLabel = (() => {
    if (!pushBusy) return 'Push to Cloudways (SFTP)';
    if (!pushStep) return 'Pushing…';
    const label = PUSH_STEP_LABELS[pushStep.stepId] ?? pushStep.stepId;
    return pushStep.percent != null
      ? `Pushing — ${label} (${pushStep.percent}%)`
      : `Pushing — ${label}`;
  })();

  const pullLabel = (() => {
    if (!pullBusy) return 'Pull from Cloudways (SFTP)';
    if (!pullStep) return 'Pulling…';
    const label = PULL_STEP_LABELS[pullStep.stepId] ?? pullStep.stepId;
    return pullStep.percent != null
      ? `Pulling — ${label} (${pullStep.percent}%)`
      : `Pulling — ${label}`;
  })();

  return (
    <section>
      <Banner variant="success">
        <strong>Linked via SFTP</strong> — this site syncs through SSH/SFTP credentials, not the Cloudways API.
      </Banner>
      <div style={styles.linkedInfo}>
        <div style={styles.linkedHeader}>
          <Text style={styles.linkedHeading}>Linked via SFTP</Text>
          <TextButton onClick={onUnlink} style={styles.unlinkBtn}>Unlink</TextButton>
        </div>
        <div style={styles.linkedGrid}>
          <Text size="caption" style={styles.linkedLabel}>App</Text>
          <Text style={styles.linkedValue}>{mapping.appLabel}</Text>
          <Text size="caption" style={styles.linkedLabel}>Host</Text>
          <Text style={styles.linkedValue}>{mapping.username}@{mapping.host}:{mapping.port}</Text>
          {mapping.remoteUrl ? (
            <>
              <Text size="caption" style={styles.linkedLabel}>URL</Text>
              <a
                href={mapping.remoteUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...styles.linkedValue, color: '#51bb7b', textDecoration: 'none' }}
                onClick={(e) => {
                  e.preventDefault();
                  const url = mapping.remoteUrl!;
                  try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
                    const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };
                    shell.openExternal(url);
                  } catch {
                    window.open(url, '_blank');
                  }
                }}
              >
                {mapping.remoteUrl}
              </a>
            </>
          ) : null}
          {mapping.webRoot && (
            <>
              <Text size="caption" style={styles.linkedLabel}>Path</Text>
              <Text style={styles.linkedValue}>{mapping.webRoot}</Text>
            </>
          )}
        </div>
      </div>

      {/* Push / Pull tab switcher */}
      <div style={styles.tabs}>
        <button
          type="button"
          style={mode === 'push' ? styles.tabActive : styles.tab}
          onClick={() => setMode('push')}
          disabled={busy}
        >
          Push
        </button>
        <button
          type="button"
          style={mode === 'pull' ? styles.tabActive : styles.tab}
          onClick={() => setMode('pull')}
          disabled={busy}
        >
          Pull
        </button>
      </div>

      {mode === 'push' ? (
        <>
          {!pushBusy && (
            <div style={{ ...styles.banner, marginBottom: 16 }}>
              <Banner variant="neutral">
                <strong>SFTP mode can&rsquo;t trigger a Cloudways API backup.</strong>{' '}
                Cloudways Sync still snapshots the remote <code>wp-content</code> + database
                into <code>private_html/.cwsync-snapshots/</code> before pushing (and mirrors
                it locally if &lt;500 MB), so <em>Undo last push</em> can roll back. For full
                safety, take a manual backup from <strong>Cloudways → Application → Backups</strong>{' '}
                first.
              </Banner>
            </div>
          )}
          {pushBusy && pushStep?.detail && (
            <div style={{ marginBottom: 8, fontSize: 11, opacity: 0.65 }}>
              {pushStep.detail}
            </div>
          )}
          {!pushBusy && (
            <SelectivePanel heading="Include in push" includes={pushIncludes} onChange={setPushIncludes} />
          )}
          {undoErr && <div style={styles.banner}><Banner variant="error">{undoErr}</Banner></div>}
          {undoResult && <div style={styles.banner}><Banner variant="success">{undoResult}</Banner></div>}
          <div style={styles.actionBar}>
            <Button onClick={runPush} disabled={busy}>
              {pushLabel}
            </Button>
            {lastPushUndoId && !pushBusy && (
              <>
                <Button onClick={runUndo} disabled={undoBusy} style={{ marginLeft: 8 }}>
                  {undoBusy ? 'Restoring…' : 'Undo last push'}
                </Button>
                <Button onClick={dismissUndo} disabled={undoBusy} style={{ marginLeft: 8 }}>
                  Confirm push
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {!pullBusy && (
            <div style={{ ...styles.banner, marginBottom: 16 }}>
              <Banner variant="neutral">
                <strong>Pulls overwrite your Local site.</strong> The selected{' '}
                <code>wp-content</code> subdirs and database will be replaced from the remote.
                Cloudways stays untouched (pulls are read-only on the server). If you have
                unsaved local changes, export the site first via{' '}
                <strong>Local → right-click site → Export…</strong>.
              </Banner>
            </div>
          )}
          {pullBusy && pullStep?.detail && (
            <div style={{ marginBottom: 8, fontSize: 11, opacity: 0.65 }}>
              {pullStep.detail}
            </div>
          )}
          {!pullBusy && (
            <SelectivePanel heading="Include in pull" includes={pullIncludes} onChange={setPullIncludes} />
          )}
          <div style={styles.actionBar}>
            <Button onClick={runPull} disabled={busy}>
              {pullLabel}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// Placeholder for API-linked sites when the user disconnects from
// Cloudways. We keep showing the link metadata but disable sync until
// they reconnect.
function ApiLinkedDisconnected({ mapping }: { mapping: ApiSiteMapping }): React.ReactElement {
  return (
    <section>
      <Banner variant="warning">
        This site is linked to Cloudways via API, but Cloudways Sync isn't
        currently connected. Open the sidebar and connect to push or pull.
      </Banner>
      <div style={styles.linkedInfo}>
        <div style={styles.linkedHeader}>
          <Text style={styles.linkedHeading}>Linked via API</Text>
        </div>
        <div style={styles.linkedGrid}>
          <Text size="caption" style={styles.linkedLabel}>App</Text>
          <Text style={styles.linkedValue}>{mapping.appLabel}</Text>
          {mapping.serverLabel && (
            <>
              <Text size="caption" style={styles.linkedLabel}>Server</Text>
              <Text style={styles.linkedValue}>{mapping.serverLabel}</Text>
            </>
          )}
          {mapping.remoteUrl && (
            <>
              <Text size="caption" style={styles.linkedLabel}>URL</Text>
              <Text style={{ ...styles.linkedValue, color: '#51bb7b' }}>{mapping.remoteUrl}</Text>
            </>
          )}
        </div>
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
  email?: string;
  onLinked: (mapping: SiteMapping) => void;
}): React.ReactElement {
  // The unlinked screen is split into two tabs: link via Cloudways API
  // (the original flow) or link via SFTP (manual credentials). Default
  // to whichever mode is usable — API if connected, SFTP otherwise.
  const [mode, setMode] = useState<'api' | 'sftp'>(email ? 'api' : 'sftp');
  const [servers, setServers] = useState<ServerSummary[] | undefined>();
  const [apps, setApps] = useState<AppSummary[] | undefined>();
  const [selectedServerId, setSelectedServerId] = useState<number | undefined>();
  const [selectedAppId, setSelectedAppId] = useState<number | undefined>();
  const [appDetail, setAppDetail] = useState<AppDetail | undefined>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [smokeResult, setSmokeResult] = useState<SmokeAppResponse | undefined>();
  const [smokeBusy, setSmokeBusy] = useState(false);
  const [smokeError, setSmokeError] = useState<string | undefined>();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | undefined>();
  const [linkBusy, setLinkBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const busy = linkBusy || smokeBusy || credentialBusy;
  const canLink = Boolean(appDetail?.sftp.password && smokeResult);

  useEffect(() => {
    if (!email) return; // SFTP-only path: skip API calls.
    let cancelled = false;
    ipcClient.listServers()
      .then((res) => { if (!cancelled) setServers(res.servers); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [email]);

  useEffect(() => {
    if (!selectedServerId) { setApps(undefined); return; }
    let cancelled = false;
    setApps(undefined);
    setSelectedAppId(undefined);
    setAppDetail(undefined);
    setSmokeResult(undefined);
    setSmokeError(undefined);
    setCredentialError(undefined);
    ipcClient.listApps({ serverId: selectedServerId })
      .then((res) => { if (!cancelled) setApps(res.apps); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [selectedServerId]);

  // Fetch app details when an app is selected
  useEffect(() => {
    if (!selectedServerId || !selectedAppId) {
      setAppDetail(undefined);
      setSmokeResult(undefined);
      setSmokeError(undefined);
      setCredentialError(undefined);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setAppDetail(undefined);
    setSmokeResult(undefined);
    setSmokeError(undefined);
    setCredentialError(undefined);
    ipcClient.getApp({ serverId: selectedServerId, appId: selectedAppId })
      .then((res) => { if (!cancelled) setAppDetail(res.app); })
      .catch(() => { /* non-fatal — we still have the summary */ })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedServerId, selectedAppId]);

  const runSmoke = async () => {
    if (!selectedServerId || !selectedAppId) return;
    setSmokeBusy(true);
    setSmokeResult(undefined);
    setSmokeError(undefined);
    try {
      const res = await ipcClient.smokeApp({
        serverId: selectedServerId,
        appId: selectedAppId,
      });
      setSmokeResult(res);
    } catch (e) {
      setSmokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setSmokeBusy(false);
    }
  };

  const link = async () => {
    if (!selectedServerId || !selectedAppId) return;
    const app = apps?.find((a) => a.id === selectedAppId);
    setLinkBusy(true);
    setError(undefined);
    try {
      const server = servers?.find((s) => s.id === selectedServerId);
      const fqdn = appDetail?.cname || app?.cname || appDetail?.appFqdn || app?.appFqdn;
      const remoteUrl = fqdn ? `https://${fqdn}` : '';
      const res = await ipcClient.mapSite({
        localSiteId: site.id,
        serverId: selectedServerId,
        appId: selectedAppId,
        appLabel: app?.label ?? `App ${selectedAppId}`,
        serverLabel: server?.label,
        remoteUrl,
      });
      onLinked(res.mapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLinkBusy(false);
    }
  };

  const createCredentials = async () => {
    if (!selectedServerId || !selectedAppId) return;
    setCredentialBusy(true);
    setCredentialError(undefined);
    try {
      const res = await ipcClient.createAppCredential({ serverId: selectedServerId, appId: selectedAppId });
      setAppDetail((prev) => prev
        ? { ...prev, sftp: res.sftp, db: { ...prev.db, password: res.sftp.password } }
        : prev);
      setSmokeResult(undefined);
      setSmokeError(undefined);
    } catch (e) {
      setCredentialError(e instanceof Error ? e.message : String(e));
    } finally {
      setCredentialBusy(false);
    }
  };

  const selectedApp = apps?.find((a) => a.id === selectedAppId);
  const serverOptions: Record<string, string> = {};
  servers?.forEach((s) => { serverOptions[String(s.id)] = s.label; });
  const appOptions: Record<string, string> = {};
  apps?.filter((a) => a.isWordPress).forEach((a) => { appOptions[String(a.id)] = a.label; });

  return (
    <section>
      <div style={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'api'}
          onClick={() => setMode('api')}
          style={mode === 'api' ? styles.tabActive : styles.tab}
        >
          Cloudways API
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'sftp'}
          onClick={() => setMode('sftp')}
          style={mode === 'sftp' ? styles.tabActive : styles.tab}
        >
          SFTP credentials
        </button>
      </div>

      {mode === 'sftp' && (
        <LinkViaSftpDialog
          localSiteId={site.id}
          defaultLabel={site.name}
          onLinked={(mapping) => onLinked(mapping)}
        />
      )}

      {mode === 'api' && !email && (
        <>
          <Banner variant="warning">
            Cloudways Sync isn&rsquo;t connected to a Cloudways account, so the
            server / app picker is unavailable. Open the Cloudways Sync sidebar
            to connect with an API key, or switch to the <strong>SFTP
            credentials</strong> tab if you don&rsquo;t have API access.
          </Banner>
        </>
      )}

      {mode === 'api' && email && (
      <>
      <Banner variant="success">
        Connected as <MaskedEmail email={email} bold />
      </Banner>

      <div style={styles.row}>
        <Title size="s" tag="h2">Link to a Cloudways app</Title>
      </div>
      <div style={styles.row}>
        <Text>
          Pick the Cloudways app this Local site should sync with.
          Once linked, you can push and pull with one click.
        </Text>
      </div>

      <div style={styles.row}>
        <FlySelect
          id="CloudwaysSync_ServerSelect"
          className="cws-local-select"
          style={styles.localSelect}
          value={selectedServerId ? String(selectedServerId) : undefined}
          onChange={(val: string) => setSelectedServerId(val ? Number(val) : undefined)}
          options={serverOptions}
          placeholder={servers ? 'Select a server…' : 'Loading servers…'}
          emptyPlaceholder={servers ? 'No servers found' : 'Loading servers…'}
          disabled={!servers || busy}
        />
      </div>

      {selectedServerId && (
        <div style={styles.row}>
          <FlySelect
            id="CloudwaysSync_AppSelect"
            className="cws-local-select"
            style={styles.localSelect}
            value={selectedAppId ? String(selectedAppId) : undefined}
            onChange={(val: string) => setSelectedAppId(val ? Number(val) : undefined)}
            options={appOptions}
            placeholder={apps ? 'Select an app…' : 'Loading apps…'}
            emptyPlaceholder={apps ? 'No WordPress apps found' : 'Loading apps…'}
            disabled={!apps || busy}
          />
        </div>
      )}

      {selectedAppId && selectedApp && (
        <>
          <div style={styles.linkedInfo}>
            <Text style={styles.linkedHeading}>App Details</Text>
            {detailLoading ? (
              <div style={styles.loadingRow}>
                <span className="cws-spinner" />
                <Text size="caption" style={{ opacity: 0.6 }}>Loading app details…</Text>
              </div>
            ) : (
              <div style={styles.linkedGrid}>
                <Text size="caption" style={styles.linkedLabel}>App</Text>
                <Text style={styles.linkedValue}>{selectedApp.label}</Text>

                {(appDetail?.cname || selectedApp.cname || appDetail?.appFqdn || selectedApp.appFqdn) && (
                  <>
                    <Text size="caption" style={styles.linkedLabel}>URL</Text>
                    <Text style={{ ...styles.linkedValue, color: '#51bb7b' }}>
                      https://{appDetail?.cname || selectedApp.cname || appDetail?.appFqdn || selectedApp.appFqdn}
                    </Text>
                  </>
                )}

                <Text size="caption" style={styles.linkedLabel}>Type</Text>
                <Text style={styles.linkedValue}>{selectedApp.application}</Text>

                {(appDetail?.appVersion || selectedApp.appVersion) && (
                  <>
                    <Text size="caption" style={styles.linkedLabel}>WP</Text>
                    <Text style={styles.linkedValue}>
                      {appDetail?.appVersion ?? selectedApp.appVersion}
                    </Text>
                  </>
                )}

                {appDetail?.sftp.password && (
                  <>
                    <Text size="caption" style={styles.linkedLabel}>SFTP</Text>
                    <Text style={styles.linkedValue}>
                      {appDetail.sftp.user}@{appDetail.sftp.host}
                    </Text>
                  </>
                )}

                {appDetail?.sftp.password && (
                  <>
                    <Text size="caption" style={styles.linkedLabel}>Shell</Text>
                    <Text style={{
                      ...styles.linkedValue,
                      color: smokeResult ? '#51bb7b' : 'rgba(255,255,255,0.4)',
                    }}>
                      {smokeResult ? 'Verified' : 'Run test to verify'}
                    </Text>
                  </>
                )}
              </div>
            )}
          </div>

          {!detailLoading && !appDetail?.sftp.password && (
            <div style={styles.credentialsNotice}>
              <div>
                <Text style={styles.credentialsTitle}>SSH/SFTP access is missing for this app</Text>
                <Text size="caption" style={styles.credentialsCopy}>
                  Create app-level credentials and enable SSH shell access before linking, testing, pulling, or pushing this WordPress site.
                </Text>
              </div>
              <Button onClick={createCredentials} disabled={busy}>
                {credentialBusy ? 'Creating…' : 'Create SSH/SFTP + shell access'}
              </Button>
              {credentialError && (
                <div style={styles.credentialsError}>
                  <Banner variant="error">{credentialError}</Banner>
                </div>
              )}
            </div>
          )}

          {!detailLoading && appDetail?.sftp.password && (
            <div style={styles.row}>
              <Text style={styles.linkedHeading}>Connection test</Text>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <Button onClick={runSmoke} disabled={busy}>
                  {smokeBusy ? 'Testing…' : 'Test WP-CLI over SSH'}
                </Button>
              </div>
              {smokeResult && (
                <Banner variant="success" style={{ marginTop: 8 }}>
                  Connected — {smokeResult.home} ({smokeResult.elapsedMs}ms)
                </Banner>
              )}
              {smokeError && (
                <Banner variant="error" style={{ marginTop: 8 }}>{smokeError}</Banner>
              )}
            </div>
          )}

          {canLink && (
            <div style={styles.row}>
              <Button onClick={link} disabled={busy}>
                {linkBusy ? 'Linking…' : 'Link this app'}
              </Button>
            </div>
          )}
        </>
      )}

      {error && <div style={styles.banner}><Banner variant="error">{error}</Banner></div>}
      </>
      )}
    </section>
  );
}

// --- Selective sync panel (shared by push & pull) ---

type SyncIncludes = PushIncludes | PullIncludes;

const WP_CONTENT_OPTIONS: Array<{ key: keyof SyncIncludes; label: string }> = [
  { key: 'uploads', label: 'Uploads (media)' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'themes', label: 'Themes' },
  { key: 'muPlugins', label: 'MU-Plugins' },
  { key: 'languages', label: 'Languages' },
];

function SelectivePanel({
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

const styles: Record<string, React.CSSProperties> = {
  wrap: { padding: 24 },
  header: { marginBottom: 24 },
  row: { marginTop: 12 },
  banner: { marginTop: 12 },
  localSelect: {
    width: 180,
  },
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
  linkedHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  linkedHeading: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    opacity: 0.5,
    margin: 0,
  },
  unlinkBtn: {
    fontSize: 11,
    color: '#d94f4f',
  },
  loadingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '16px 0 8px',
  },
  linkedGrid: {
    display: 'grid',
    gridTemplateColumns: '50px 1fr',
    gap: '6px 12px',
    alignItems: 'baseline',
  },
  linkedLabel: {
    opacity: 0.5,
    fontSize: 12,
  },
  linkedValue: {
    fontWeight: 500,
    fontSize: 13,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  credentialsNotice: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
    padding: '12px 14px',
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
  tabs: {
    display: 'flex',
    gap: 0,
    marginBottom: 16,
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },
  tab: {
    padding: '8px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'rgba(255,255,255,0.5)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  tabActive: {
    padding: '8px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid #51bb7b',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 8,
  },
  breezeNotice: {
    marginBottom: 12,
    padding: '12px 14px',
    background: 'rgba(81,187,123,0.06)',
    border: '1px solid rgba(81,187,123,0.18)',
    borderRadius: 6,
  },
  breezeHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    cursor: 'pointer',
  },
  breezeTitle: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 3,
  },
  breezeDesc: {
    display: 'block',
    opacity: 0.55,
    lineHeight: 1.4,
  },
};
