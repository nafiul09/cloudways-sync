// Global sync wizard modal. Rendered as a portal so it persists
// regardless of Local's page navigation. Provides a safety-first
// wizard flow: setup (warnings) → config (checkboxes) → running
// (progress) → done/post-push. Blocks all UI interaction while
// a push/pull is running.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Banner, Button, Checkbox, Text, Title } from './components/ui';
import { SelectivePanel } from './components/SelectivePanel';
import type { SyncIncludes } from './components/SelectivePanel';
import { ipcClient, subscribeJobDone, subscribeJobProgress } from './ipcClient';
import type { JobDoneEvent, JobProgressEvent, PushIncludes, PullIncludes } from '../shared/ipcTypes';

// ---- Step labels ----

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

// ---- Default includes ----

const DEFAULT_INCLUDES: PushIncludes = {
  database: true,
  wpContent: true,
  uploads: true,
  plugins: true,
  themes: true,
  muPlugins: true,
  languages: true,
};

// ---- Types ----

export type WizardContext = {
  mode: 'push' | 'pull';
  appLabel: string;
  siteId: string;
  localUrl: string;
  webRootPath: string;
  remoteUrl?: string;
  linkMode: 'api' | 'sftp';
  serverId?: number;
  appId?: number;
  breezeActive?: boolean;
  /** Fleet pull: create a new Local site (no existing siteId). */
  isFleetPull?: boolean;
};

type SyncMode = 'push' | 'pull' | 'fleet-pull' | 'undo' | 'confirm';

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
  | { phase: 'setup'; ctx: WizardContext }
  | { phase: 'config'; ctx: WizardContext }
  | RunningState
  | { phase: 'done'; mode: SyncMode; appLabel: string }
  | { phase: 'post-push'; appLabel: string; undoRecordId: string }
  | { phase: 'error'; mode: SyncMode; appLabel: string; error: string };

// ---- Stepper config ----
// Each wizard mode has a fixed sequence of steps the user moves through.
// Push has a Review step (post-push undo/confirm); pull just resolves to Done.
type WizardMode = 'push' | 'pull' | 'fleet-pull';
const WIZARD_STEPS: Record<WizardMode, string[]> = {
  push: ['Confirm', 'Configure', 'Pushing', 'Review'],
  pull: ['Confirm', 'Configure', 'Pulling', 'Done'],
  'fleet-pull': ['Confirm', 'Configure', 'Pulling', 'Done'],
};

function getWizardMode(state: ModalState): WizardMode | null {
  if (state.phase === 'setup' || state.phase === 'config') {
    return state.ctx.isFleetPull ? 'fleet-pull' : state.ctx.mode;
  }
  if (state.phase === 'post-push') return 'push';
  if (state.phase === 'running' || state.phase === 'done' || state.phase === 'error') {
    if (state.mode === 'fleet-pull') return 'fleet-pull';
    if (state.mode === 'push' || state.mode === 'pull') return state.mode;
    // confirm/undo only happen as part of a push wizard's Review step
    if (state.mode === 'confirm' || state.mode === 'undo') return 'push';
  }
  return null;
}

function getStepIndex(state: ModalState): number {
  if (state.phase === 'setup') return 0;
  if (state.phase === 'config') return 1;
  if (state.phase === 'running') {
    if (state.mode === 'confirm' || state.mode === 'undo') return 3;
    return 2;
  }
  if (state.phase === 'error') {
    if (state.mode === 'confirm' || state.mode === 'undo') return 3;
    return 2;
  }
  if (state.phase === 'post-push') return 3;
  if (state.phase === 'done') {
    if (state.mode === 'confirm' || state.mode === 'undo') return 4;
    return 3;
  }
  return 0;
}

// ---- Global state ----

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

/** Open the wizard with the safety-first flow. */
export function openWizard(ctx: WizardContext): void {
  setState({ phase: 'setup', ctx });
}

/** Legacy: start directly in running phase (used by undo/confirm from panel). */
export function showSyncModal(mode: SyncMode, appLabel: string): void {
  setState({ phase: 'running', mode, appLabel });
}

/** Call if planPull/planPush or runJob throws. */
export function failSyncModal(error: string): void {
  if (globalState.phase === 'idle') return;
  const mode = 'mode' in globalState ? globalState.mode : 'push';
  let appLabel = '';
  if ('appLabel' in globalState) appLabel = (globalState as { appLabel: string }).appLabel;
  else if ('ctx' in globalState) appLabel = (globalState as { ctx: WizardContext }).ctx.appLabel;
  setState({ phase: 'error', mode, appLabel, error });
}

/** Dismiss the modal (used by Close buttons). */
export function dismissSyncModal(): void {
  setState({ phase: 'idle' });
}

/** Show the post-push modal with undo/confirm actions and cache guidance. */
export function showPostPushModal(appLabel: string, undoRecordId: string): void {
  setState({ phase: 'post-push', appLabel, undoRecordId });
}

// ---- Panel notification callback ----
let postPushActionCallback: (() => void) | undefined;

export function onPostPushAction(cb: () => void): () => void {
  postPushActionCallback = cb;
  return () => { if (postPushActionCallback === cb) postPushActionCallback = undefined; };
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

// ---- Stepper ----
// Compact horizontal step indicator. Past steps show a checkmark, the
// current step is highlighted (red on error), future steps are muted.
function Stepper({
  mode,
  currentIndex,
  isError,
}: {
  mode: WizardMode;
  currentIndex: number;
  isError?: boolean;
}): React.ReactElement {
  const steps = WIZARD_STEPS[mode];
  return (
    <div style={stepperStyles.row}>
      {steps.map((label, i) => {
        const isPast = i < currentIndex;
        const isCurrent = i === currentIndex;
        const dotBg = isPast
          ? 'var(--cws-accent)'
          : isCurrent
            ? (isError ? '#e25151' : 'var(--cws-accent)')
            : 'transparent';
        const dotBorder = isPast || isCurrent
          ? (isError && isCurrent ? '#e25151' : 'var(--cws-accent)')
          : 'var(--cws-border-subtle)';
        const dotColor = isPast || isCurrent ? '#fff' : 'var(--cws-text-tertiary)';
        const labelColor = isCurrent
          ? 'var(--cws-text-primary)'
          : isPast
            ? 'var(--cws-text-secondary)'
            : 'var(--cws-text-tertiary)';
        return (
          <React.Fragment key={i}>
            <div style={stepperStyles.step}>
              <div
                style={{
                  ...stepperStyles.dot,
                  background: dotBg,
                  borderColor: dotBorder,
                  color: dotColor,
                }}
              >
                {isPast ? '\u2713' : i + 1}
              </div>
              <div style={{ ...stepperStyles.label, color: labelColor, fontWeight: isCurrent ? 700 : 500 }}>
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div
                style={{
                  ...stepperStyles.connector,
                  background: i < currentIndex ? 'var(--cws-accent)' : 'var(--cws-spinner-track)',
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---- Setup phase (safety warnings) ----

const WARN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

function SetupPhase({ ctx }: { ctx: WizardContext }): React.ReactElement {
  const isPush = ctx.mode === 'push';
  const isFleet = ctx.isFleetPull;
  const accent = '#e07a3b';
  const bg = 'rgba(224,122,59,0.08)';

  const warningTitle = isFleet
    ? 'This will create a new Local site'
    : isPush
      ? 'You are about to push to your live site'
      : 'You are about to overwrite your local site';

  const warningBody = isFleet
    ? `A new site will be created in Local from "${ctx.appLabel}". A Cloudways backup will be taken before downloading.`
    : isPush
      ? "This will overwrite your live site\u2019s database and wp-content with your local copy. A backup snapshot will be taken before pushing."
      : "This will overwrite your local site with the remote content. Your current local state will be replaced.";

  return (
    <>
      <div
        style={{
          marginBottom: 22,
          padding: '16px 18px',
          borderRadius: 8,
          background: bg,
          borderLeft: `3px solid ${accent}`,
          display: 'flex',
          gap: 14,
          alignItems: 'flex-start',
        }}
      >
        <span
          style={{ color: accent, flexShrink: 0, marginTop: 1 }}
          dangerouslySetInnerHTML={{ __html: WARN_ICON_SVG }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--cws-text-primary)', fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
            {warningTitle}
          </div>
          <div style={{ color: 'var(--cws-text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
            {warningBody}
          </div>
          {ctx.remoteUrl && (
            <div style={{ color: 'var(--cws-text-tertiary)', fontSize: 12, marginTop: 8 }}>
              Target: <span style={{ color: 'var(--cws-text-default)', fontWeight: 600 }}>{ctx.remoteUrl}</span>
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button onClick={dismissSyncModal} style={{ flex: 1 }}>
          Cancel
        </Button>
        <Button onClick={() => setState({ phase: 'config', ctx })} style={{ flex: 1 }}>
          Continue
        </Button>
      </div>
    </>
  );
}

// ---- Config phase (checkboxes + start button) ----

function ConfigPhase({ ctx }: { ctx: WizardContext }): React.ReactElement {
  const isPush = ctx.mode === 'push';
  const isFleet = ctx.isFleetPull;
  const [includes, setIncludes] = useState<SyncIncludes>({ ...DEFAULT_INCLUDES });
  const [reactivateBreeze, setReactivateBreeze] = useState(true);
  const [busy, setBusy] = useState(false);

  const handleStart = async () => {
    setBusy(true);
    const mode: SyncMode = isFleet ? 'fleet-pull' : ctx.mode;
    setState({ phase: 'running', mode, appLabel: ctx.appLabel });

    try {
      if (isPush) {
        const plan = await ipcClient.planPush({
          linkMode: ctx.linkMode,
          serverId: ctx.serverId,
          appId: ctx.appId,
          localSiteId: ctx.siteId,
          localUrl: ctx.localUrl,
          webRootPath: ctx.webRootPath,
          includes: includes as PushIncludes,
          reactivateBreeze: ctx.breezeActive ? reactivateBreeze : false,
        });
        await ipcClient.runJob({ planId: plan.planId });
        // Push succeeded — show post-push modal with undo/confirm
        try {
          const undos = await ipcClient.listUndo();
          const latest = undos.records.find(
            (r) => {
              if (ctx.linkMode === 'api') {
                return r.appId === ctx.appId && !r.undoneAt && !r.dismissedAt;
              }
              return r.localSiteId === ctx.siteId && !r.undoneAt && !r.dismissedAt;
            },
          );
          if (latest) {
            postPushActionCallback?.(); // clear any stale panel undo state
            showPostPushModal(ctx.appLabel, latest.id);
          }
        } catch { /* non-fatal — modal will show generic done */ }
      } else {
        const plan = await ipcClient.planPull({
          linkMode: isFleet ? 'api' : ctx.linkMode,
          serverId: ctx.serverId,
          appId: ctx.appId,
          destinationName: ctx.appLabel,
          localSiteId: isFleet ? undefined : ctx.siteId,
          includes: includes as PullIncludes,
        });
        await ipcClient.runJob({ planId: plan.planId });
      }
    } catch (e) {
      failSyncModal(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {/* Context note moved above the checkbox panel so the user reads
          mode-specific caveats before configuring includes. */}
      {ctx.linkMode === 'sftp' && isPush && (
        <div style={{ marginBottom: 16 }}>
          <Banner variant="neutral">
            SFTP mode takes a local snapshot before pushing (no Cloudways API backup).
            You can undo via this snapshot after push completes.
          </Banner>
        </div>
      )}
      <SelectivePanel
        heading={isPush ? 'Include in push' : 'Include in pull'}
        includes={includes}
        onChange={setIncludes}
      />
      {isPush && ctx.breezeActive && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <Checkbox checked={reactivateBreeze} onChange={() => setReactivateBreeze(!reactivateBreeze)} />
            <div>
              <Text style={{ fontWeight: 500 }}>Re-activate Breeze after push</Text>
              <Text size="caption" tag="div" style={{ marginTop: 2 }}>
                The caching plugin is excluded from sync because it requires Cloudways server configuration.
              </Text>
            </div>
          </label>
        </div>
      )}
      <div style={{ display: 'flex', gap: 10 }}>
        <Button onClick={() => setState({ phase: 'setup', ctx })} disabled={busy} style={{ flex: 1 }}>
          Back
        </Button>
        <Button onClick={handleStart} disabled={busy} style={{ flex: 1 }}>
          {busy ? 'Starting\u2026' : isPush ? 'Start Push' : 'Start Pull'}
        </Button>
      </div>
    </>
  );
}

// ---- Post-push actions component ----

function PostPushActions({ undoRecordId, appLabel }: { undoRecordId: string; appLabel: string }): React.ReactElement {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    setState({ phase: 'running', mode: 'confirm', appLabel });
    try {
      await ipcClient.dismissUndo({ recordId: undoRecordId });
      postPushActionCallback?.();
      setState({ phase: 'done', mode: 'confirm', appLabel });
    } catch (e) {
      setState({ phase: 'error', mode: 'confirm', appLabel, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleUndo = async () => {
    setBusy(true);
    setState({ phase: 'running', mode: 'undo', appLabel });
    try {
      await ipcClient.undoPush({ recordId: undoRecordId });
      postPushActionCallback?.();
      setState({ phase: 'done', mode: 'undo', appLabel });
    } catch (e) {
      setState({ phase: 'error', mode: 'undo', appLabel, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const checklist: Array<{ title: string; body: React.ReactNode }> = [
    {
      title: 'Purge the server cache',
      body: (
        <>
          On Cloudways, open <strong>Application Settings &rarr; Purge All Caches</strong>.
          This is required for new CSS, redirects, and content to appear.
        </>
      ),
    },
    {
      title: 'Open your live site and verify it',
      body: <>Make sure pages, links, and media load correctly.</>,
    },
    {
      title: 'Confirm or undo this push',
      body: (
        <>
          <strong>Confirm</strong> keeps the changes and removes the temporary backup from
          the server. <strong>Undo</strong> restores the previous version (you will need to
          purge cache again after undoing).
        </>
      ),
    },
  ];

  return (
    <>
      <div style={styles.bannerSlot}>
        <Banner variant="success">Successfully pushed to Cloudways.</Banner>
      </div>
      <div style={{ marginTop: 24, marginBottom: 22 }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ color: 'var(--cws-text-primary)', fontSize: 17, fontWeight: 700, letterSpacing: 0.1 }}>
            Verify and finalize
          </div>
          <div style={{ color: 'var(--cws-text-tertiary)', fontSize: 12, marginTop: 4 }}>
            Complete these steps before closing the wizard.
          </div>
        </div>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {checklist.map((item, i) => (
            <li
              key={i}
              style={{
                display: 'flex',
                gap: 14,
                padding: '10px 0',
              }}
            >
              <div
                style={{
                  flexShrink: 0,
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: 'var(--cws-accent-muted)',
                  color: 'var(--cws-accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  marginTop: 1,
                }}
              >
                {i + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'var(--cws-text-primary)', fontSize: 14, fontWeight: 600, marginBottom: 3 }}>
                  {item.title}
                </div>
                <div style={{ color: 'var(--cws-text-secondary)', fontSize: 12.5, lineHeight: 1.55 }}>
                  {item.body}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button onClick={handleUndo} disabled={busy} style={{ flex: 1 }}>
          Undo Push
        </Button>
        <Button onClick={handleConfirm} disabled={busy} style={{ flex: 1 }}>
          Confirm Push
        </Button>
      </div>
    </>
  );
}

// ---- Modal component ----

function SyncModalContent(): React.ReactElement | null {
  const state = useModalState();
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Block escape during running AND during the post-push Review step —
    // user must explicitly Undo or Confirm; we do not allow them to bail
    // out and leave a temporary backup orphaned on the server.
    if (e.key === 'Escape' && state.phase !== 'running' && state.phase !== 'post-push') {
      dismissSyncModal();
    }
    if (e.key === 'Tab') e.preventDefault();
  }, [state.phase]);

  // Prevent Electron window close while a sync is running.
  useEffect(() => {
    if (state.phase !== 'running') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'A sync operation is in progress. Closing now may leave your site in a broken state.';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state.phase]);

  if (state.phase === 'idle') return null;

  const wizardMode = getWizardMode(state);
  const stepIndex = getStepIndex(state);
  const stepperEl = wizardMode ? (
    <Stepper mode={wizardMode} currentIndex={stepIndex} isError={state.phase === 'error'} />
  ) : null;

  // Wizard setup/config phases
  if (state.phase === 'setup') {
    return (
      <div ref={overlayRef} style={styles.overlay} onKeyDown={handleKeyDown}>
        <style>{MODAL_CSS}</style>
        <div style={styles.stack}>
          <div style={styles.modal}>
            <div style={styles.header}>
              <span style={styles.cwIcon} dangerouslySetInnerHTML={{ __html: CW_ICON }} />
              <div style={styles.headerText}>
                <Title size="s">{state.ctx.isFleetPull ? 'Pull to Local as new site' : state.ctx.mode === 'push' ? 'Push to Cloudways' : 'Pull from Cloudways'}</Title>
                <Text size="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.ctx.appLabel}</Text>
              </div>
            </div>
            {stepperEl}
            <SetupPhase ctx={state.ctx} />
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === 'config') {
    return (
      <div ref={overlayRef} style={styles.overlay} onKeyDown={handleKeyDown}>
        <style>{MODAL_CSS}</style>
        <div style={styles.stack}>
          <div style={styles.modal}>
            <div style={styles.header}>
              <span style={styles.cwIcon} dangerouslySetInnerHTML={{ __html: CW_ICON }} />
              <div style={styles.headerText}>
                <Title size="s">{state.ctx.mode === 'push' ? 'Push to Cloudways' : 'Pull from Cloudways'}</Title>
                <Text size="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.ctx.appLabel}</Text>
              </div>
            </div>
            {stepperEl}
            <ConfigPhase ctx={state.ctx} />
          </div>
        </div>
      </div>
    );
  }

  // Post-push has its own layout
  const isPostPush = state.phase === 'post-push';

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
      success: 'Pull completed \u2014 site updated from Cloudways.',
    },
    'fleet-pull': {
      running: 'Pulling from Cloudways',
      done: 'Pull complete',
      failed: 'Pull failed',
      success: 'New Local site created from Cloudways.',
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
  const mode: SyncMode = isPostPush ? 'push' : (state as { mode: SyncMode }).mode;
  const ml = MODE_LABELS[mode];
  const labels = mode === 'push' ? PUSH_STEP_LABELS : PULL_STEP_LABELS;
  const isRunning = state.phase === 'running';
  const headerTitle =
    isPostPush ? 'Push Completed' :
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
              <Title size="s">{headerTitle}</Title>
              <Text size="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.appLabel}</Text>
            </div>
          </div>

          {stepperEl}

          {isRunning && (
            <>
              {/* Step + percent */}
              <div style={styles.stepRow}>
                <span className="cws-modal-spinner" />
                <span style={styles.stepLabel}>
                  {state.stepId ? (labels[state.stepId] ?? state.stepId) : 'Starting\u2026'}
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
              <Button onClick={dismissSyncModal} style={{ width: '100%' }}>
                Close
              </Button>
            </>
          )}

          {isPostPush && (
            <PostPushActions
              undoRecordId={state.undoRecordId}
              appLabel={state.appLabel}
            />
          )}

          {state.phase === 'error' && (
            <>
              <div style={styles.bannerSlot}>
                <Banner variant="error">{state.error}</Banner>
              </div>
              <Button onClick={dismissSyncModal} style={{ width: '100%' }}>
                Close
              </Button>
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
    background: 'var(--cws-bg-overlay)',
    backdropFilter: 'blur(3px)',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 14,
    width: 560,
    maxWidth: 'calc(100vw - 40px)',
  },
  modal: {
    width: '100%',
    boxSizing: 'border-box' as const,
    background: 'var(--cws-bg-modal)',
    borderRadius: 12,
    border: '1px solid var(--cws-border-subtle)',
    padding: '28px 32px',
    boxShadow: '0 20px 60px var(--cws-shadow)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginBottom: 22,
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
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  stepLabel: {
    fontSize: 13,
    color: 'var(--cws-text-default)',
    flex: 1,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  percent: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--cws-accent)',
    fontVariantNumeric: 'tabular-nums' as const,
    flexShrink: 0,
  },
  progressTrack: {
    height: 8,
    borderRadius: 0,
    background: 'var(--cws-progress-track)',
    border: '1px solid var(--cws-border-subtle)',
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, var(--cws-accent) 0%, #74d79a 100%)',
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
    color: 'var(--cws-text-tertiary)',
    flex: 1,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  detailOnly: {
    fontSize: 11,
    color: 'var(--cws-text-tertiary)',
    marginTop: 4,
    marginLeft: 26,
    lineHeight: 1.5,
  },
  bytesText: {
    fontSize: 11,
    color: 'var(--cws-text-secondary)',
    fontVariantNumeric: 'tabular-nums' as const,
    flexShrink: 0,
  },
  outsideWarning: {
    fontSize: 11,
    color: 'var(--cws-text-tertiary)',
    textAlign: 'center' as const,
    fontStyle: 'italic',
    padding: '2px 12px',
  },
  bannerSlot: {
    marginBottom: 16,
  },
};

const stepperStyles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 0,
    marginBottom: 24,
  },
  step: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    minWidth: 72,
  },
  dot: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: '2px solid',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums' as const,
    transition: 'background 0.2s ease, border-color 0.2s ease, color 0.2s ease',
  },
  label: {
    fontSize: 11,
    letterSpacing: 0.2,
    lineHeight: 1.2,
    textAlign: 'center' as const,
    transition: 'color 0.2s ease',
  },
  connector: {
    flex: 1,
    height: 2,
    marginTop: 13, // vertically center against the 28px dot
    minWidth: 16,
    borderRadius: 2,
    transition: 'background 0.2s ease',
  },
};

