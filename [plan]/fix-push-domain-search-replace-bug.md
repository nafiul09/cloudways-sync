# Fix Push Domain Search-Replace Bug

## Context

When pushing a Local WP site to Cloudways, the remote site becomes inaccessible — the homepage tries to access `localhost` resources, and `/wp-admin` redirects to `localhost:PORT/wp-login.php`. The root cause: the `wp search-replace` step uses the wrong local URL, produces zero replacements silently, and leaves the remote database full of local URLs.

**Why it happens:** The local URL is guessed in the renderer as `site.url || 'http://${site.domain}'`. This often doesn't match what's actually in the local WordPress database (e.g., the DB contains `https://localhost:10075` but we search for `http://mysite.local`). `wp search-replace` exits 0 even with zero matches, so the push appears successful.

## Changes

### 1. Read real local URL from DB before push (`syncHandlers.ts`)

**File:** `src/main/ipc/syncHandlers.ts` — inside `PLAN_PUSH` handler (lines 146-179)

After validation (line 176), before `jobs.createPushPlan(payload)` (line 177), add:

```typescript
try {
  const site = services.siteData.getSite(payload.localSiteId);
  if (site) {
    if (!services.siteProcessManager.hasRunningProcess(site)) {
      await services.siteProcessManager.start(site);
    }
    await services.siteDatabase.waitForDB(site);
    const dbHome = await services.wpCli.getOption(site, 'home');
    if (dbHome?.trim()) {
      payload.localUrl = dbHome.trim();
    }
  }
} catch {
  // Non-fatal: fall back to the renderer-supplied localUrl
}
```

**Why here:** This handler already has `services` in scope. The site needs to be running for `localDbDump` anyway (line 351-358 shows the same pattern). Local's `services.wpCli.getOption(site, 'home')` returns `Promise<string | null>` — exactly what we need.

### 2. Protocol-variant search-replace + safety net (`PushOrchestrator.ts`)

**File:** `src/main/sync/PushOrchestrator.ts` — Step 9 (lines 284-298)

Replace the single `wp search-replace` with:

1. **Primary search-replace:** `plan.localUrl` → `metadata.homeUrl` (same as today)
2. **Protocol-flipped pass:** If local URL is `https://`, also search for `http://` variant (and vice versa). This catches mixed-protocol references in the DB.
3. **Safety net `wp option update`:** After search-replace, explicitly set `home` and `siteurl` to the correct remote values. This guarantees the two most critical options are correct even if search-replace missed some edge case.

Add two helper functions (module-level in PushOrchestrator.ts):

```typescript
function flipProtocol(url: string): string {
  if (url.startsWith('https://')) return 'http://' + url.slice(8);
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

function parseReplacementCount(stdout: string): number {
  const match = stdout.match(/Made\s+(\d+)\s+replacement/i);
  return match ? parseInt(match[1], 10) : -1;
}
```

### 3. Update tests (`PushOrchestrator.test.ts`)

- Update `FakeSsh.exec` to return realistic `wp search-replace` stdout (e.g., `"Success: Made 42 replacements."`)
- Add handler for `option update` commands
- Add test: protocol-flipped variant runs when protocols differ
- Add test: `wp option update home` and `wp option update siteurl` are called after search-replace

## Files to modify

| File | Change |
|------|--------|
| `src/main/ipc/syncHandlers.ts` | Read local `home` from DB before creating push plan |
| `src/main/sync/PushOrchestrator.ts` | Protocol-variant search-replace + wp option update safety net |
| `test/unit/PushOrchestrator.test.ts` | Update fake SSH, add new test cases |

## What stays unchanged

- **Renderer** (`SiteToolsPanel.tsx`) — still sends `site.url || 'http://${site.domain}'` as fallback; main process overrides it
- **Types** (`types.ts`, `ipcTypes.ts`) — `PushPlan.localUrl` field unchanged
- **Pull flow** (`LocalSiteImporter.ts`) — works correctly, untouched
- **Undo** — `sourceUrl: plan.localUrl` at line 331 will now correctly store the real URL

## Verification

1. `npm run typecheck` — no type errors
2. `npm test` — existing + new tests pass
3. **Manual test:** Push a Local site (localhost router mode with port) to Cloudways → verify remote site loads with correct domain, admin panel accessible
4. **Manual test:** Push a Local site (custom `.local` domain) → verify same
