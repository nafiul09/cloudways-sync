import React, { useEffect, useState } from 'react';
import {
  Banner,
  Button,
  FlySelect,
  Spinner,
  Text,
  TextButton,
  Title,
} from '../components/ui';
import type { Site } from '@getflywheel/local';
import { ipcClient, IpcCallError } from '../ipcClient';
import { refreshSiteListIcons } from '../sidebar/injectSiteListIcons';
import { showSyncModal, dismissSyncModal, failSyncModal, onPostPushAction, openWizard } from '../SyncModal';
import type { WizardContext } from '../SyncModal';
import { MaskedEmail } from '../components/MaskedEmail';
import { LinkViaSftpDialog } from './LinkViaSftpDialog';
import type {
  ApiSiteMapping,
  AppDetail,
  AppSummary,
  BreezeStatus,
  ConnectionStatusPayload,
  ServerSummary,
  SftpSiteMapping,
  SiteMapping,
  SmokeAppResponse,
} from '../../shared/ipcTypes';
import { isApiMapping } from '../../shared/ipcTypes';


// Cloud-with-down-arrow (Pull) and cloud-with-up-arrow (Push). Inherits
// currentColor from the surrounding <Button>, so it recolors on hover.
// Tray + arrow icons. Push reuses the same arrow path but rotates it 180°
// around its center (12, 9.355) so the tray stays put while the arrow flips.
const TRAY_D = 'M2.24994 19.2501V16.7501C2.24994 16.1978 2.69765 15.7501 3.24994 15.7501C3.80222 15.7501 4.24994 16.1978 4.24994 16.7501V19.2501C4.24994 19.5262 4.4738 19.7501 4.74994 19.7501H19.2499C19.5261 19.7501 19.7499 19.5262 19.7499 19.2501V16.7501C19.7499 16.1978 20.1977 15.7501 20.7499 15.7501C21.3022 15.7501 21.7499 16.1978 21.7499 16.7501V19.2501C21.7499 20.5444 20.7663 21.6092 19.5058 21.7374L19.2499 21.7501H4.74994C3.36923 21.7501 2.24994 20.6308 2.24994 19.2501Z';
const ARROW_D = 'M11 3.25006C11 2.69778 11.4477 2.25006 12 2.25006C12.5522 2.25006 13 2.69778 13 3.25006V13.336L15.7929 10.543C16.1834 10.1525 16.8165 10.1525 17.207 10.543C17.5975 10.9336 17.5975 11.5666 17.207 11.9571L12.707 16.4571C12.3165 16.8476 11.6834 16.8476 11.2929 16.4571L6.79292 11.9571C6.4024 11.5666 6.4024 10.9336 6.79292 10.543C7.15904 10.1769 7.73804 10.1543 8.13081 10.4747L8.20699 10.543L11 13.336V3.25006Z';
function PullIcon(): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={18} height={18} fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path d={TRAY_D} fill="currentColor" />
      <path d={ARROW_D} fill="currentColor" />
    </svg>
  );
}
function PushIcon(): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={18} height={18} fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path d={TRAY_D} fill="currentColor" />
      <g transform="rotate(180 12 9.355)">
        <path d={ARROW_D} fill="currentColor" />
      </g>
    </svg>
  );
}

const CWS_CSS = `
  @keyframes cws-spin {
    to { transform: rotate(360deg); }
  }
  .cws-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--cws-spinner-track);
    border-top-color: var(--cws-spinner-arc);
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
    color: var(--cws-text-default);
    background: var(--cws-bg-inset);
    border: 1px solid var(--cws-border-default);
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
    color: var(--cws-text-tertiary);
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
    background: var(--cws-bg-inset);
    border: 1px solid var(--cws-border-default);
    border-radius: 4px;
    box-shadow: 0 10px 28px var(--cws-shadow);
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
    color: var(--cws-text-default);
  }

  .cws-local-select .FlySelect_Option:hover,
  .cws-local-select .FlySelect_Option:focus {
    color: #fff;
    background: var(--cws-accent-hover);
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

// --- Connected + Mapped: linked status + wizard trigger ---

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
  const [appDetail, setAppDetail] = useState<AppDetail | undefined>();
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | undefined>();
  const [breezeStatus, setBreezeStatus] = useState<BreezeStatus | undefined>();

  // Undo fallback (in case user dismisses the post-push modal)
  const [lastPushUndoId, setLastPushUndoId] = useState<string | undefined>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoResult, setUndoResult] = useState<string | undefined>();
  const [undoErr, setUndoErr] = useState<string | undefined>();

  const canSync = Boolean(appDetail?.sftp.password);

  // Hydrate undo state from ledger on mount.
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

  const wizardCtx = (mode: 'push' | 'pull'): WizardContext => ({
    mode,
    appLabel: mapping.appLabel,
    siteId: site.id,
    localUrl: site.url || `http://${site.domain}`,
    webRootPath: site.paths?.webRoot || `${site.path}/app/public`,
    remoteUrl: mapping.remoteUrl,
    linkMode: 'api',
    serverId: mapping.serverId,
    appId: mapping.appId,
    breezeActive: breezeStatus?.active,
  });

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

  const dismissUndoFn = async () => {
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
                style={{ ...styles.linkedValue, color: 'var(--cws-accent)', textDecoration: 'none' }}
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
          <Button onClick={createCredentials} disabled={credentialBusy}>
            {credentialBusy ? 'Creating…' : 'Create SSH/SFTP + shell access'}
          </Button>
          {credentialError && (
            <div style={styles.credentialsError}>
              <Banner variant="error">{credentialError}</Banner>
            </div>
          )}
        </div>
      )}

      {/* Pull / Push action buttons — open wizard modal */}
      <div style={styles.actionBar}>
        <Button onClick={() => openWizard(wizardCtx('pull'))} disabled={!canSync || undoBusy}>
          <PullIcon />
          Pull from Cloudways
        </Button>
        <Button onClick={() => openWizard(wizardCtx('push'))} disabled={!canSync || undoBusy} style={{ marginLeft: 8 }}>
          <PushIcon />
          Push to Cloudways
        </Button>
      </div>

      {/* Undo fallback — safety net if user closes post-push modal */}
      {undoErr && <div style={styles.banner}><Banner variant="error">{undoErr}</Banner></div>}
      {undoResult && <div style={styles.banner}><Banner variant="success">{undoResult}</Banner></div>}
      {lastPushUndoId && (
        <div style={{ ...styles.actionBar, marginTop: 12 }}>
          <Button onClick={runUndo} disabled={undoBusy} style={{ marginRight: 8 }}>
            {undoBusy ? 'Restoring…' : 'Undo last push'}
          </Button>
          <Button onClick={dismissUndoFn} disabled={undoBusy}>
            Confirm push
          </Button>
        </div>
      )}
    </section>
  );
}

// --- Linked via SFTP-only mode ---

function SftpLinkedState({
  site,
  mapping,
  onUnlink,
}: {
  site: Site;
  mapping: SftpSiteMapping;
  onUnlink: () => void;
}): React.ReactElement {
  // Undo fallback (in case user dismisses the post-push modal)
  const [lastPushUndoId, setLastPushUndoId] = useState<string | undefined>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoResult, setUndoResult] = useState<string | undefined>();
  const [undoErr, setUndoErr] = useState<string | undefined>();

  // Hydrate undo state from ledger on mount.
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

  const wizardCtx = (mode: 'push' | 'pull'): WizardContext => ({
    mode,
    appLabel: mapping.appLabel,
    siteId: site.id,
    localUrl: site.url || `http://${site.domain}`,
    webRootPath: site.paths?.webRoot || `${site.path}/app/public`,
    remoteUrl: mapping.remoteUrl,
    linkMode: 'sftp',
  });

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

  const dismissUndoFn = async () => {
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
                style={{ ...styles.linkedValue, color: 'var(--cws-accent)', textDecoration: 'none' }}
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

      {/* Pull / Push action buttons — open wizard modal */}
      <div style={styles.actionBar}>
        <Button onClick={() => openWizard(wizardCtx('pull'))} disabled={undoBusy}>
          <PullIcon />
          Pull from Cloudways
        </Button>
        <Button onClick={() => openWizard(wizardCtx('push'))} disabled={undoBusy} style={{ marginLeft: 8 }}>
          <PushIcon />
          Push to Cloudways
        </Button>
      </div>

      {/* Undo fallback — safety net if user closes post-push modal */}
      {undoErr && <div style={styles.banner}><Banner variant="error">{undoErr}</Banner></div>}
      {undoResult && <div style={styles.banner}><Banner variant="success">{undoResult}</Banner></div>}
      {lastPushUndoId && (
        <div style={{ ...styles.actionBar, marginTop: 12 }}>
          <Button onClick={runUndo} disabled={undoBusy} style={{ marginRight: 8 }}>
            {undoBusy ? 'Restoring…' : 'Undo last push'}
          </Button>
          <Button onClick={dismissUndoFn} disabled={undoBusy}>
            Confirm push
          </Button>
        </div>
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
              <Text style={{ ...styles.linkedValue, color: 'var(--cws-accent)' }}>{mapping.remoteUrl}</Text>
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
                    <Text style={{ ...styles.linkedValue, color: 'var(--cws-accent)' }}>
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
                      color: smokeResult ? 'var(--cws-accent)' : 'var(--cws-text-tertiary)',
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
    background: 'var(--cws-progress-track)',
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
    color: 'var(--cws-red)',
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
    background: 'var(--cws-progress-track)',
    border: '1px solid var(--cws-border-subtle)',
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
    borderBottom: '1px solid var(--cws-border-subtle)',
  },
  tab: {
    padding: '8px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--cws-text-tertiary)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  tabActive: {
    padding: '8px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid var(--cws-accent)',
    color: 'var(--cws-text-primary)',
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
};
