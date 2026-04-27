// Global sync progress modal. Rendered as a portal so it persists
// regardless of Local's page navigation. Blocks all UI interaction
// while a push/pull is running, showing real-time step progress.
//
// On success, the modal auto-dismisses — the SiteToolsPanel's success
// Banner surfaces the completion message ("Pull completed — site
// updated from Cloudways"). On failure, the modal stays open with a
// dismissible error block so the user always sees what went wrong.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Banner } from './components/ui';
import { subscribeJobDone, subscribeJobProgress } from './ipcClient';
import type { JobDoneEvent, JobProgressEvent } from '../shared/ipcTypes';

// ---- Step labels (shared with SiteToolsPanel) ----

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

// ---- Global state ----

type SyncMode = 'push' | 'pull' | 'undo' | 'confirm';

type RunningState = {
  phase: 'running';
  mode: SyncMode;
  appLabel: string;
  stepId?: string;
  percent?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  detail?: string;
};

type ModalState =
  | { phase: 'idle' }
  | RunningState
  | { phase: 'done'; mode: SyncMode; appLabel: string }
  | { phase: 'error'; mode: SyncMode; appLabel: string; error: string };

let globalState: ModalState = { phase: 'idle' };
let listeners: Array<(s: ModalState) => void> = [];

function setState(next: ModalState) {
  globalState = next;
  for (const fn of listeners) fn(next);
}

function useModalState(): ModalState {
  const [state, setLocal] = useState(globalState);
  useEffect(() => {
    listeners.push(setLocal);
    return () => { listeners = listeners.filter((fn) => fn !== setLocal); };
  }, []);
  return state;
}

// ---- Public API ----

/** Call before starting a push/pull to show the modal. */
export function showSyncModal(mode: SyncMode, appLabel: string): void {
  setState({ phase: 'running', mode, appLabel });
}

/** Call if planPull/planPush or runJob throws. */
export function failSyncModal(error: string): void {
  if (globalState.phase === 'idle') return;
  setState({
    phase: 'error',
    mode: globalState.mode,
    appLabel: globalState.appLabel,
    error,
  });
}

/** Dismiss the modal (used by the Close button on failures). */
export function dismissSyncModal(): void {
  setState({ phase: 'idle' });
}

// ---- IPC subscription (started once) ----

let subscribed = false;

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;

  subscribeJobProgress((event: JobProgressEvent) => {
    if (globalState.phase !== 'running') return;
    const percent =
      typeof event.totalBytes === 'number' &&
      event.totalBytes > 0 &&
      typeof event.bytesTransferred === 'number'
        ? Math.min(100, Math.round((event.bytesTransferred / event.totalBytes) * 100))
        : undefined;

    setState({
      ...globalState,
      phase: 'running',
      stepId: event.stepId,
      percent,
      bytesTransferred: event.bytesTransferred,
      totalBytes: event.totalBytes,
      detail: event.detail,
    });
  });

  subscribeJobDone((event: JobDoneEvent) => {
    if (globalState.phase !== 'running') return;
    if (event.status === 'success') {
      setState({
        phase: 'done',
        mode: globalState.mode,
        appLabel: globalState.appLabel,
      });
    } else {
      setState({
        phase: 'error',
        mode: globalState.mode,
        appLabel: globalState.appLabel,
        error: `Sync ${event.status}.`,
      });
    }
  });
}

// ---- Helpers ----

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

// ---- Modal component ----

function SyncModalContent(): React.ReactElement | null {
  const state = useModalState();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Block keyboard shortcuts / tab navigation to elements behind
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') e.stopPropagation();
    if (e.key === 'Tab') e.preventDefault();
  }, []);

  // Prevent the Electron window from closing while a sync is running.
  useEffect(() => {
    if (state.phase !== 'running') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Electron requires returnValue to be set for the dialog to show.
      e.returnValue = 'A sync operation is in progress. Closing now may leave your site in a broken state.';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state.phase]);

  if (state.phase === 'idle') return null;

  const MODE_LABELS: Record<SyncMode, { running: string; done: string; failed: string; success: string }> = {
    push: {
      running: 'Pushing to Cloudways',
      done: 'Push complete',
      failed: 'Push failed',
      success: 'Successfully pushed to Cloudways.',
    },
    pull: {
      running: 'Pulling from Cloudways',
      done: 'Pull complete',
      failed: 'Pull failed',
      success: 'Pull completed — site updated from Cloudways.',
    },
    undo: {
      running: 'Restoring from snapshot',
      done: 'Restore complete',
      failed: 'Restore failed',
      success: 'Remote site restored to pre-push state.',
    },
    confirm: {
      running: 'Confirming push',
      done: 'Push confirmed',
      failed: 'Cleanup failed',
      success: 'Snapshot cleaned from server.',
    },
  };
  const ml = MODE_LABELS[state.mode];
  const labels = state.mode === 'push' ? PUSH_STEP_LABELS : PULL_STEP_LABELS;
  const isRunning = state.phase === 'running';
  const headerTitle =
    state.phase === 'running' ? ml.running :
    state.phase === 'done' ? ml.done :
    ml.failed;
  const successMsg = ml.success;

  const hasBytes =
    isRunning &&
    typeof state.bytesTransferred === 'number' &&
    typeof state.totalBytes === 'number' &&
    state.totalBytes > 0;

  return (
    <div ref={overlayRef} style={styles.overlay} onKeyDown={handleKeyDown}>
      <style>{MODAL_CSS}</style>
      <div style={styles.stack}>
        <div style={styles.modal}>
          {/* Header */}
          <div style={styles.header}>
            <span style={styles.cwIcon} dangerouslySetInnerHTML={{ __html: CW_ICON }} />
            <div style={styles.headerText}>
              <div style={styles.headerTitle}>{headerTitle}</div>
              <div style={styles.headerSubtitle}>{state.appLabel}</div>
            </div>
          </div>

          {isRunning && (
            <>
              {/* Step + percent */}
              <div style={styles.stepRow}>
                <span className="cws-modal-spinner" />
                <span style={styles.stepLabel}>
                  {state.stepId ? (labels[state.stepId] ?? state.stepId) : 'Starting…'}
                </span>
                {hasBytes && (
                  <span style={styles.percent}>{state.percent}%</span>
                )}
              </div>

              {/* Progress bar — only during byte-tracked transfers */}
              {hasBytes && (
                <>
                  <div style={styles.progressTrack}>
                    <div
                      style={{
                        ...styles.progressFill,
                        width: `${typeof state.percent === 'number' ? state.percent : 0}%`,
                      }}
                    />
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.detail}>{state.detail || '\u00A0'}</span>
                    <span style={styles.bytesText}>
                      {formatBytes(state.bytesTransferred)} / {formatBytes(state.totalBytes)}
                    </span>
                  </div>
                </>
              )}

              {/* Detail only (no progress bar) */}
              {!hasBytes && state.detail && (
                <div style={styles.detailOnly}>{state.detail}</div>
              )}
            </>
          )}

          {state.phase === 'done' && (
            <>
              <div style={styles.bannerSlot}>
                <Banner variant="success">{successMsg}</Banner>
              </div>
              <button type="button" style={styles.dismissBtn} onClick={dismissSyncModal}>
                Close
              </button>
            </>
          )}

          {state.phase === 'error' && (
            <>
              <div style={styles.bannerSlot}>
                <Banner variant="error">{state.error}</Banner>
              </div>
              <button type="button" style={styles.dismissBtn} onClick={dismissSyncModal}>
                Close
              </button>
            </>
          )}
        </div>

        {/* Warning — lives OUTSIDE the modal card, on the overlay */}
        {isRunning && (
          <div style={styles.outsideWarning}>
            Do not close Local or navigate away while syncing.
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Mount once as a portal ----

let mounted = false;

export function mountSyncModal(): void {
  if (mounted) return;
  mounted = true;
  ensureSubscribed();

  const host = document.createElement('div');
  host.id = 'CloudwaysSync-SyncModal';
  document.body.appendChild(host);

  // Legacy ReactDOM.render for React 16.14 compat with Local.
  ReactDOM.render(React.createElement(SyncModalContent), host);
}

// ---- Compact CW icon ----
const CW_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 512 512"
  fill="#51bb7b" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
  <path d="M171.296 275.979H18.344C11.654 275.979 6 270.407 6 263.87c0-6.56 5.653-12.107 12.344-12.107h162.364c7.034-12.345 16.943-22.892 28.838-30.775H84.38c-6.666 0-12.336-5.572-12.336-12.108 0-6.544 5.67-12.107 12.336-12.107h152.495c3.815-11.241 9.55-21.625 16.813-30.775H108.07c-6.69 0-12.344-5.539-12.344-12.107 0-6.536 5.653-12.108 12.344-12.108h172.951c16.193-9.959 35.342-15.71 55.856-15.71 51.167 0 93.828 35.767 103.42 83.208 37.98 11.004 65.7 45.488 65.7 86.328 0 49.737-41.06 90.021-91.72 90.021h-.32v.294H94.396c-6.682 0-12.328-5.522-12.328-12.099 0-6.544 5.646-12.115 12.328-12.115h104.163c-9.411-8.546-17-19.003-22.115-30.75l-19.68.007c-3.996 0-7.01-2.957-7.01-6.887v-10.138c0-3.922 3.006-6.87 7.01-6.87h13.079a88.563 88.563 0 01-.735-11.463c0-6.74.751-13.316 2.19-19.631zm-60.235 54.99H21.988c-3.995 0-6.985-2.958-6.985-6.888v-10.138c0-3.922 2.99-6.87 6.985-6.87h88.747c3.995 0 7.01 2.948 7.01 6.87v10.138c.318 3.62-3.015 6.887-6.684 6.887z"/>
</svg>`;

// Self-contained spinner CSS (the modal renders outside SiteToolsPanel).
const MODAL_CSS = `
  @keyframes cws-modal-spin { to { transform: rotate(360deg); } }
  .cws-modal-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(81,187,123,0.2);
    border-top-color: #51bb7b;
    border-radius: 50%;
    animation: cws-modal-spin 0.7s linear infinite;
    flex-shrink: 0;
  }
`;

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 99999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.7)',
    backdropFilter: 'blur(3px)',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 14,
    width: 460,
    maxWidth: 'calc(100vw - 40px)',
  },
  modal: {
    width: '100%',
    boxSizing: 'border-box' as const,
    background: '#1e1f1f',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.1)',
    padding: '22px 26px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  cwIcon: {
    display: 'inline-flex',
    flexShrink: 0,
  },
  headerText: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#fff',
    lineHeight: 1.2,
  },
  headerSubtitle: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  stepLabel: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.85)',
    flex: 1,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  percent: {
    fontSize: 12,
    fontWeight: 600,
    color: '#51bb7b',
    fontVariantNumeric: 'tabular-nums' as const,
    flexShrink: 0,
  },
  progressTrack: {
    height: 8,
    borderRadius: 0,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.08)',
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #51bb7b 0%, #74d79a 100%)',
    transition: 'width 0.3s ease',
  },
  infoRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 16,
  },
  detail: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    flex: 1,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  detailOnly: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    marginTop: 4,
    marginLeft: 26,
    lineHeight: 1.5,
  },
  bytesText: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.7)',
    fontVariantNumeric: 'tabular-nums' as const,
    flexShrink: 0,
  },
  outsideWarning: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center' as const,
    fontStyle: 'italic',
    padding: '2px 12px',
  },
  bannerSlot: {
    marginBottom: 16,
  },
  dismissBtn: {
    display: 'block',
    width: '100%',
    padding: '10px 0',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 6,
    background: 'transparent',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
};
