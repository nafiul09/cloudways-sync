// Global sync progress modal. Rendered as a portal so it persists
// regardless of Local's page navigation. Blocks all UI interaction
// while a push/pull is running, showing real-time step progress.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
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

type SyncMode = 'push' | 'pull';
type ModalState =
  | { phase: 'idle' }
  | { phase: 'running'; mode: SyncMode; appLabel: string; stepId?: string; percent?: number; detail?: string }
  | { phase: 'done'; mode: SyncMode; appLabel: string; result: JobDoneEvent; error?: string };

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

/** Call if the planPull/planPush itself fails before runJob. */
export function failSyncModal(error: string): void {
  if (globalState.phase !== 'running') return;
  setState({
    phase: 'done',
    mode: globalState.mode,
    appLabel: globalState.appLabel,
    result: { jobId: '', status: 'failed' },
    error,
  });
}

/** Dismiss the modal after completion. */
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
      detail: event.detail,
    });
  });

  subscribeJobDone((event: JobDoneEvent) => {
    if (globalState.phase !== 'running') return;
    setState({
      phase: 'done',
      mode: globalState.mode,
      appLabel: globalState.appLabel,
      result: event,
    });
  });
}

// ---- Modal component ----

function SyncModalContent(): React.ReactElement | null {
  const state = useModalState();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Block keyboard shortcuts / tab navigation to elements behind
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') e.stopPropagation();
    if (e.key === 'Tab') {
      // Keep focus inside the modal
      e.preventDefault();
    }
  }, []);

  if (state.phase === 'idle') return null;

  const labels = state.mode === 'push' ? PUSH_STEP_LABELS : PULL_STEP_LABELS;
  const modeLabel = state.mode === 'push' ? 'Pushing to' : 'Pulling from';

  return (
    <div ref={overlayRef} style={styles.overlay} onKeyDown={handleKeyDown}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.cwIcon} dangerouslySetInnerHTML={{ __html: CW_ICON }} />
          <span style={styles.headerText}>
            {state.phase === 'running'
              ? `${modeLabel} Cloudways`
              : state.result.status === 'success'
                ? `${state.mode === 'push' ? 'Push' : 'Pull'} complete`
                : `${state.mode === 'push' ? 'Push' : 'Pull'} failed`}
          </span>
        </div>

        {/* App name */}
        <div style={styles.appLabel}>{state.appLabel}</div>

        {/* Progress area */}
        {state.phase === 'running' && (
          <>
            {/* Spinner + step */}
            <div style={styles.stepRow}>
              <span className="cws-spinner" />
              <span style={styles.stepLabel}>
                {state.stepId ? (labels[state.stepId] ?? state.stepId) : 'Starting…'}
              </span>
            </div>

            {/* Progress bar */}
            {state.percent != null && (
              <div style={styles.progressTrack}>
                <div style={{ ...styles.progressFill, width: `${state.percent}%` }} />
              </div>
            )}

            {/* Detail text */}
            {state.detail && (
              <div style={styles.detail}>{state.detail}</div>
            )}

            <div style={styles.warning}>
              Do not close Local or navigate away while syncing.
            </div>
          </>
        )}

        {/* Done */}
        {state.phase === 'done' && (
          <>
            {state.result.status === 'success' ? (
              <div style={styles.successMsg}>
                {state.mode === 'push'
                  ? 'Successfully pushed to Cloudways.'
                  : 'Successfully pulled from Cloudways.'}
              </div>
            ) : (
              <div style={styles.errorMsg}>
                {state.error || `Sync ${state.result.status}.`}
              </div>
            )}
            <button type="button" style={styles.dismissBtn} onClick={dismissSyncModal}>
              Close
            </button>
          </>
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
const CW_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 512 512"
  fill="#51bb7b" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
  <path d="M171.296 275.979H18.344C11.654 275.979 6 270.407 6 263.87c0-6.56 5.653-12.107 12.344-12.107h162.364c7.034-12.345 16.943-22.892 28.838-30.775H84.38c-6.666 0-12.336-5.572-12.336-12.108 0-6.544 5.67-12.107 12.336-12.107h152.495c3.815-11.241 9.55-21.625 16.813-30.775H108.07c-6.69 0-12.344-5.539-12.344-12.107 0-6.536 5.653-12.108 12.344-12.108h172.951c16.193-9.959 35.342-15.71 55.856-15.71 51.167 0 93.828 35.767 103.42 83.208 37.98 11.004 65.7 45.488 65.7 86.328 0 49.737-41.06 90.021-91.72 90.021h-.32v.294H94.396c-6.682 0-12.328-5.522-12.328-12.099 0-6.544 5.646-12.115 12.328-12.115h104.163c-9.411-8.546-17-19.003-22.115-30.75l-19.68.007c-3.996 0-7.01-2.957-7.01-6.887v-10.138c0-3.922 3.006-6.87 7.01-6.87h13.079a88.563 88.563 0 01-.735-11.463c0-6.74.751-13.316 2.19-19.631zm-60.235 54.99H21.988c-3.995 0-6.985-2.958-6.985-6.888v-10.138c0-3.922 2.99-6.87 6.985-6.87h88.747c3.995 0 7.01 2.948 7.01 6.87v10.138c.318 3.62-3.015 6.887-6.684 6.887z"/>
</svg>`;

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 99999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.65)',
    backdropFilter: 'blur(2px)',
  },
  modal: {
    width: 420,
    background: '#1e1f1f',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.1)',
    padding: '28px 32px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  cwIcon: {
    display: 'inline-flex',
    flexShrink: 0,
  },
  headerText: {
    fontSize: 16,
    fontWeight: 600,
    color: '#fff',
  },
  appLabel: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    marginBottom: 20,
  },
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  stepLabel: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.8)',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    background: 'rgba(255,255,255,0.1)',
    marginBottom: 10,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    background: '#51bb7b',
    transition: 'width 0.3s ease',
  },
  detail: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    marginBottom: 8,
  },
  warning: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    marginTop: 16,
    textAlign: 'center' as const,
    fontStyle: 'italic',
  },
  successMsg: {
    fontSize: 14,
    color: '#51bb7b',
    marginBottom: 20,
    lineHeight: 1.5,
  },
  errorMsg: {
    fontSize: 13,
    color: '#d94f4f',
    marginBottom: 20,
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
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
