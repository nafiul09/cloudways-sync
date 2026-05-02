# Push Post-Completion Modal Redesign

## Context

Currently after a push completes, the modal shows a "success" screen with a Close button. The user closes it and returns to the panel where Undo/Confirm buttons appear alongside other push/pull controls. This is confusing for non-technical users because:

1. After push, there's often a **Cloudways Varnish cache issue** that causes CSS/domain problems. Users don't know what to do.
2. The undo/confirm buttons are buried in the panel alongside other controls.
3. The "Clear Remote Cache" button we added doesn't reliably solve the issue (Cloudways' built-in purge from App Settings is more reliable).

**Goal:** Keep the modal open after push with undo/confirm actions + cache guidance directly inside it. Remove the standalone "Clear Remote Cache" button entirely.

## Design

After a successful push, the modal transitions from "running" to a **new "post-push" phase** that shows:

1. Success message ("Push completed")
2. **Cache guidance text** — informational callout explaining:
   - If you see CSS issues or domain redirects, purge the site cache from Cloudways App Settings
   - If problems persist after cache purge, you can undo the push (but you'll still need to purge cache after undo)
   - Once everything looks good, confirm the push to clean up the temporary backup
3. **Two action buttons**: "Undo Push" and "Confirm Push"
4. The modal **stays open** until the user takes one of these actions (or explicitly closes it)

This applies to **both API and SFTP** push modes.

## Files to Modify

| File | Change |
|------|--------|
| `src/renderer/SyncModal.tsx` | Add `post-push` phase with undo/confirm buttons + cache info |
| `src/renderer/screens/SiteToolsPanel.tsx` | Remove "Clear Remote Cache" button/state from both LinkedState and SftpLinkedState; remove undo/confirm from panel (now in modal); simplify post-push panel state |
| `src/shared/ipcTypes.ts` | Remove `ClearCacheRequest`/`ClearCacheResponse` types and `CLEAR_CACHE` channel |
| `src/renderer/ipcClient.ts` | Remove `clearCache` method |
| `src/main/ipc/syncHandlers.ts` | Remove `CLEAR_CACHE` handler and `SshClient`/`wpCli` imports if no longer needed |
| `src/main/sync/JobStore.ts` | No changes needed |

## Implementation Steps

### Step 1: Remove Clear Cache feature

**`src/shared/ipcTypes.ts`:**
- Remove `CLEAR_CACHE: 'cs:clearCache'` from CHANNELS
- Remove `ClearCacheRequest` and `ClearCacheResponse` types

**`src/renderer/ipcClient.ts`:**
- Remove `ClearCacheRequest`/`ClearCacheResponse` imports
- Remove `clearCache` method from `ipcClient`

**`src/main/ipc/syncHandlers.ts`:**
- Remove the entire `CLEAR_CACHE` handler block
- Remove `SshClient` import (check if still needed for DISMISS_UNDO — it is, so keep it)
- `wpCli` import: check if still used elsewhere in this file (it's not — only used in CLEAR_CACHE handler). Remove it.

### Step 2: Update SyncModal to support post-push phase

**`src/renderer/SyncModal.tsx`:**

Add a new phase to `ModalState`:
```typescript
type ModalState =
  | { phase: 'idle' }
  | { phase: 'running'; ... }
  | { phase: 'done'; ... }
  | { phase: 'post-push'; appLabel: string; undoRecordId: string }
  | { phase: 'error'; ... }
```

Add a new public function:
```typescript
export function showPostPushModal(appLabel: string, undoRecordId: string): void {
  setState({ phase: 'post-push', appLabel, undoRecordId });
}
```

In the `SyncModalContent` component, add rendering for `phase === 'post-push'`:
- Header: Cloudways icon + "Push Completed" title + app label subtitle
- Success banner: "Successfully pushed to Cloudways."
- **Cache info section** (styled as a subtle notice/callout):
  - "If you notice any CSS issues or domain redirects on your site, go to **Cloudways → Application → Application Settings** and click **Purge All Caches**."
  - "If problems persist after purging cache, you can undo this push — note that you'll need to purge cache again after undoing."
  - "Once your site looks correct, confirm the push to clean up the temporary backup stored on your server."
- Two buttons: "Undo Push" (secondary/warning) and "Confirm Push" (primary)
- Optional: small "Close" link/button for users who want to dismiss without acting (but undo/confirm will still appear in the panel as fallback)

When user clicks "Undo Push" in the modal:
- Transition to `{ phase: 'running', mode: 'undo', appLabel }` — shows spinner
- Call `ipcClient.undoPush({ recordId })` 
- On success: transition to done state with undo success message, then dismiss
- On error: transition to error state

When user clicks "Confirm Push":
- Transition to `{ phase: 'running', mode: 'confirm', appLabel }` — shows spinner
- Call `ipcClient.dismissUndo({ recordId })`
- On success: dismiss modal
- On error: show error state

### Step 3: Update SiteToolsPanel push flow

**Both `LinkedState` (API) and `SftpLinkedState` (SFTP):**

Modify `runPush` completion logic:
- Currently: after `runJob` succeeds, fetches undo record and sets `lastPushUndoId` state, then modal shows generic "done" screen
- New: after `runJob` succeeds, fetch the undo record ID, then call `showPostPushModal(appLabel, undoRecordId)` instead of letting the default "done" phase show
- The modal's `subscribeJobDone` for `status === 'success'` with `mode === 'push'` should trigger the post-push phase instead of the generic "done" phase

**Remove from both components:**
- `cacheBusy`, `cacheResult` state variables
- `runClearCache` function
- The "Clear Remote Cache" button and its container div
- The `cacheResult` banner

**Keep in panel as fallback:**
- `lastPushUndoId` state and `runUndo`/`dismissUndo` handlers stay as fallback (in case user closes the modal without acting). But they should be simpler — no showSyncModal call from the panel buttons, or optionally re-show the post-push modal.

Actually, **simplification**: Remove undo/confirm buttons from the panel entirely. The modal is the ONLY place for these actions now. If the user closes the modal without choosing, the next time they open the push tab they'll see a reminder. Or better: keep the panel buttons as a safety net since the modal can be dismissed.

**Decision:** Keep the panel undo/confirm buttons as a fallback but make them minimal (they still work if modal is dismissed). The primary flow is through the modal.

### Step 4: Wire the post-push transition

The key change is in how `subscribeJobDone` handles push success. Currently (SyncModal.tsx line 137-153), when a job completes with `status === 'success'`, it unconditionally sets `phase: 'done'`.

**Option A:** Have `SiteToolsPanel` call `showPostPushModal()` after receiving the undo record ID. This means the modal briefly flashes "done" before transitioning to "post-push".

**Option B (better):** After `runJob` resolves successfully for a push, immediately call `showPostPushModal()` from SiteToolsPanel BEFORE `subscribeJobDone` fires the generic "done" transition. The modal's `subscribeJobDone` listener should NOT override if the state is already `post-push`.

**Implementation (Option B):**
- In `SyncModal.tsx`'s `subscribeJobDone` handler: if current state is `post-push`, don't transition to `done`
- In `SiteToolsPanel`'s `runPush`: after `await ipcClient.runJob(...)` returns, immediately list undo records, find the latest, then call `showPostPushModal(appLabel, undoRecordId)`
- Handle the race: `runJob` returns after the job completes (it's awaited), so `subscribeJobDone` may fire at roughly the same time. Add a guard in `subscribeJobDone`: `if (current.phase === 'post-push') return;`

### Step 5: Handle modal undo/confirm actions

In `SyncModal.tsx`, the post-push phase rendering includes click handlers:

```typescript
const handleUndo = async () => {
  const { appLabel, undoRecordId } = currentState; // captured from post-push state
  setState({ phase: 'running', mode: 'undo', appLabel });
  try {
    await ipcClient.undoPush({ recordId: undoRecordId });
    setState({ phase: 'done', mode: 'undo', appLabel });
  } catch (e) {
    setState({ phase: 'error', mode: 'undo', appLabel, error: e.message });
  }
};

const handleConfirm = async () => {
  const { appLabel, undoRecordId } = currentState;
  setState({ phase: 'running', mode: 'confirm', appLabel });
  try {
    await ipcClient.dismissUndo({ recordId: undoRecordId });
    setState({ phase: 'done', mode: 'confirm', appLabel });
  } catch (e) {
    setState({ phase: 'error', mode: 'confirm', appLabel, error: e.message });
  }
};
```

The modal needs access to `ipcClient` — it already imports from `../ipcClient` for subscriptions. Add the `undoPush` and `dismissUndo` calls.

After successful undo/confirm from the modal, notify the panel to clear `lastPushUndoId`. Options:
- Export a callback registration from SiteToolsPanel
- Use a shared event emitter
- **Simplest:** SiteToolsPanel's existing `listUndo` effect runs on mount / on certain deps. Add a listener for `JOB_DONE` events in the panel that re-checks undo state. Or: have the modal broadcast a custom event that SiteToolsPanel listens to.

**Simplest approach:** After modal undo/confirm success, when user clicks "Close" on the done screen, SiteToolsPanel re-fetches undo list on the next render (it already does this on mount). If the user doesn't navigate away, add a `useEffect` that polls or listens for modal state changes. Or even simpler: when the post-push modal successfully undoes/confirms, call a globally registered callback.

**Practical implementation:** Export a `onPostPushAction` callback setter from SyncModal. SiteToolsPanel registers it with a function that clears `lastPushUndoId`. The modal calls it after successful undo or confirm.

## Verification

1. `npm run typecheck` — no type errors
2. `npm test` — all tests pass (update any tests that reference clear cache)
3. **Manual test flow:**
   - Push to Cloudways (API or SFTP mode)
   - Modal stays open showing post-push screen with cache info + Undo/Confirm buttons
   - Click "Confirm Push" → modal shows spinner → success → close
   - Alternatively: Click "Undo Push" → modal shows spinner → success → close
   - Verify no "Clear Remote Cache" button anywhere in the UI
   - Verify panel undo/confirm buttons still work as fallback if modal is dismissed
