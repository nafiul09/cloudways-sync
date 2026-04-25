# Cloudways Sync — SFTP-only Link Mode

> Plan date: 2026-04-25
> Status: Design proposal. No code changes yet.
> Companion docs:
> - `cloudsync-addon-implementation-plan.md` (original architecture)
> - `local-wp-addon-cloudways-sync-research.md`

---

## 1. Motivation

Today, every link between a Local site and a Cloudways app is gated by a
Cloudways API connection. The user supplies email + API key once on the
Connect screen, the addon hits `/api/v1/oauth/access_token`, lists
servers/apps, and from there everything (pull, push, undo) routes
through `ApiClient` plus an SSH/SFTP layer whose credentials were
either auto-generated via `createAppCredential` or stored after the
first manual entry.

In practice many Cloudways users **never get an API key**:

- They are an _invited team member_ on someone else's account.
- The account owner restricts API access (Cloudways treats API keys as
  per-account, not per-app, so an owner who hands out the key gives
  full account access).
- Their role only includes "Application access" — the dashboard
  exposes the SSH/SFTP tab for that one app, but the API endpoint is
  not available to them.

For these users the current addon is unusable end-to-end. They have
every credential they need to pull/push a single app (host, port,
username, password) — they just don't have an API key.

This plan introduces a second link mode — **SFTP-only / per-app** —
that lives alongside the existing API mode. The user picks per Local
site which mode to link in. Existing API-linked sites are untouched.

---

## 2. Scope

### 2.1 In scope

- Per-site "Link via SFTP" flow on the Site Tools panel.
- A new mapping subtype that carries `host/port/username` (no
  `serverId`/`appId`) and references SFTP credentials in the keychain.
- Connection probe that validates SFTP login, SSH shell, WordPress
  detection, and wp-cli availability before completing the link.
- Pull and Push working end-to-end against an SFTP-only mapping.
- Undo via local pre-push tar snapshot (since `restoreApp` requires
  API).
- Error guidance directing users to manual Cloudways UI steps for
  things the API would normally automate.
- Coexistence: a Local install can have some sites linked via API and
  others linked via SFTP at the same time. The Connect screen remains
  optional.

### 2.2 Out of scope (v1 of this feature)

- Auto-detecting `serverId`/`appId` from SFTP-only context.
  Server/app discovery requires the API.
- Mode B push (provision a brand-new Cloudways app from a Local site).
  Provisioning needs `createApp`, which is API-only.
- Cloudways-side scheduled backup before push. The user gets a local
  snapshot only.
- IP-whitelist automation. The user is told what to do in the
  Cloudways UI.
- Migrating an SFTP-only mapping into an API mapping later (or vice
  versa). It's possible but not v1; user can unlink + relink.
- Multisite support in SFTP mode (same v1 limitation as API mode).

### 2.3 Non-goals / explicit "we lose this in SFTP mode"

Document these prominently in the UI so expectations are correct.

| Capability                          | API mode | SFTP mode |
| ----------------------------------- | :------: | :-------: |
| Pull DB + files                     |   yes    |    yes    |
| Push DB + files                     |   yes    |    yes    |
| Selective sync (uploads / DB / etc.)|   yes    |    yes    |
| Pre-push **remote** backup          |   yes    | no — local snapshot only |
| Undo last push (`restoreApp`)       |   yes    | no — restore from local snapshot |
| Auto-create SFTP credentials        |   yes    | no — user creates in CW UI |
| Auto IP whitelist                   |   yes    | no — user enables in CW UI |
| Discover servers/apps               |   yes    | no — user supplies host directly |
| Provision new app (Mode B push)     |   yes    | no |
| "Open on Cloudways" deep link       |   yes    | partial (host only) |

---

## 3. User-facing flows

### 3.1 First-time linking — three entry points

A site can be linked via three paths. All three end in a `SiteMapping`
record stored on disk.

1. **API → pull** _(unchanged)_. User connects on the Connect screen,
   picks a server + app, clicks Pull. Mapping is created automatically
   when the new Local site lands.

2. **API → manual link of an existing Local site** _(unchanged)_. From
   Site Tools panel, when API is connected, "Link to Cloudways…" lets
   the user pick the matching server/app from a dropdown.

3. **SFTP → manual link of an existing Local site** _(new)_. From Site
   Tools panel, "Link via SFTP…" opens a form requesting:
   - Host (e.g. `123.45.67.89`)
   - Port (default 22)
   - SFTP username (e.g. `master_xxxx`)
   - Password
   - Optional: human label ("My App on LiveServer")
   - Optional: remote URL for the "Open on web" link

   Form validates by running the connection probe (§5.2). On success,
   the mapping is written and the Tools panel switches to the linked
   state.

The new "Link via SFTP…" entry is always visible in the Tools panel,
regardless of whether API is connected, since the two modes are
independent.

### 3.2 Site Tools panel after linking

The existing tool list (push / pull / open on web / unlink) is
identical in both modes. The only differences are:

- A small badge "Linked via SFTP" vs "Linked via API" near the title.
- "Open on Cloudways" is hidden if the mapping has no `remoteUrl`.
- "Undo last push" is labelled "Undo last push (local snapshot)" in
  SFTP mode, with hover text explaining it restores from a local tar.

### 3.3 Connect screen behavior

- Unchanged for users who have an API key.
- A new note under the form: _"Don't have an API key? You can still
  link individual sites via SFTP from each site's Tools panel."_ —
  links to a docs section explaining the trade-offs.

---

## 4. Data model

### 4.1 SiteMapping becomes a discriminated union

`src/shared/ipcTypes.ts:296-309` currently:

```ts
export type SiteMapping = {
  localSiteId: string;
  serverId: number;
  appId: number;
  appLabel: string;
  serverLabel?: string;
  remoteUrl: string;
  createdAt: string;
  localUrl?: string;
  webRootPath?: string;
};
```

Evolves to:

```ts
type SiteMappingBase = {
  localSiteId: string;
  appLabel: string;
  serverLabel?: string;
  remoteUrl?: string;     // optional in SFTP mode
  createdAt: string;
  localUrl?: string;
  webRootPath?: string;
};

export type ApiSiteMapping = SiteMappingBase & {
  linkMode: 'api';
  serverId: number;
  appId: number;
  // remoteUrl required in api mode for parity with current behavior
  remoteUrl: string;
};

export type SftpSiteMapping = SiteMappingBase & {
  linkMode: 'sftp';
  /** SFTP host. */
  host: string;
  port: number;
  username: string;
  /**
   * Detected during the connection probe so push/pull don't have to
   * shell out again. Examples: "applications/abcdef/public_html".
   */
  webRoot?: string;
  /**
   * Cached output of `wp option get siteurl` (or null if wp-cli was
   * unavailable at probe time).
   */
  detectedSiteUrl?: string;
};

export type SiteMapping = ApiSiteMapping | SftpSiteMapping;
```

Migration: existing mappings on disk lack `linkMode`. `SiteMapper.list`
treats `linkMode === undefined` as `'api'` and rewrites on next
`set()`. No destructive migration.

### 4.2 SFTP credential storage

`src/main/credentials.ts:141-207` (`AppPasswordStore`) is keyed by
`${serverId}:${appId}`. SFTP mode has no `serverId/appId`. Two options
were considered:

- **(A) Reuse `AppPasswordStore` with a synthetic key** like
  `sftp:<localSiteId>`. Simple, but pollutes the API-keyed store and
  invites accidental conflation in code paths that look up by site.
- **(B) New `SftpCredentialStore`** keyed by `localSiteId`. Cleaner
  separation; the lookup key matches the mapping's primary key.

**Choice: (B).** Each store remains single-purpose. New file
`src/main/credentials/SftpCredentialStore.ts`:

```ts
export interface SftpCredentialStore {
  set(localSiteId: string, password: string): Promise<void>;
  get(localSiteId: string): Promise<string | null>;
  delete(localSiteId: string): Promise<void>;
}
```

Implementation mirrors `AppPasswordStore`: encrypts with Electron
`safeStorage` and writes to
`<userDataDir>/cloudwayssync/sftp-creds.json`. Same
`ENCRYPTION_UNAVAILABLE` error code on fallback.

### 4.3 Where mode is observed

```
SiteMapper.list()           → caller branches on linkMode
PushOrchestrator.run()      → reads mapping, picks AppLink impl (§5.1)
PullOrchestrator.run()      → ditto
syncHandlers UNDO_PUSH      → branches on linkMode
SiteToolsPanel              → renders mode badge + correct "Link…" CTA
sidebar/injectSiteListIcons → already mode-agnostic; no change
```

---

## 5. Architecture

### 5.1 `AppLink` adapter

The orchestrators need a single object that answers _"how do I reach
this app?"_ Currently `PullOrchestrator.resolveCloudwaysApp()`
(`src/main/sync/PullOrchestrator.ts:262-314`) calls
`client.listServers()` to fetch `server.public_ip`, `app.sys_user`,
`app.sys_password` (or pulls password from `AppPasswordStore`). That
flow is API-only.

Introduce an interface that hides the difference:

```ts
// src/main/sync/AppLink.ts
export interface AppLink {
  readonly mode: 'api' | 'sftp';
  /** Connection details ready to feed into SshClient. */
  resolveSsh(): Promise<{
    host: string;
    port: number;
    username: string;
    password: string;
  }>;
  /** Absolute path to the WP install on the server. */
  resolveWebRoot(): Promise<string>;
  /** Best-effort URL for "Open on Cloudways" buttons. May be null. */
  remoteUrl(): string | null;
  /** Fired once the orchestrator confirms the actual web root. */
  rememberWebRoot(path: string): Promise<void>;

  // API-only operations. SFTP impl throws OPERATION_NOT_AVAILABLE.
  triggerRemoteBackup?(): Promise<{ operationId: number }>;
  restoreFromRemoteBackup?(backupId: number): Promise<void>;
}

export class ApiAppLink implements AppLink { /* wraps ApiClient */ }
export class SftpAppLink implements AppLink { /* wraps SiteMapping + SftpCredentialStore */ }

export async function appLinkFor(mapping: SiteMapping): Promise<AppLink>;
```

Touch points (all become "use the link object", instead of branching):

- `PullOrchestrator.resolveCloudwaysApp` collapses into a single
  `appLinkFor(mapping).resolveSsh()`.
- `PushOrchestrator.run` ditto.
- `triggerAppBackup()` calls become `link.triggerRemoteBackup?.()` —
  guarded by `if (link.triggerRemoteBackup)` so SFTP link silently
  skips. The "always-on backup" guarantee is upheld by the local
  snapshot step (§5.4).
- `ensureAppSshAccess` / `whitelistIp` calls — already deliberately
  skipped per existing comments in the codebase, no change.

### 5.2 Connection probe

Used by the Link-via-SFTP form before persisting credentials. Pure
function, no side effects on disk.

```ts
// src/main/connection/sftpProbe.ts
export type ProbeInput = {
  host: string; port: number; username: string; password: string;
};
export type ProbeResult = {
  ok: true;
  webRoot: string;
  wpCliAvailable: boolean;
  detectedSiteUrl: string | null;
  phpVersion: string | null;
} | {
  ok: false;
  code: 'SSH_AUTH_FAILED' | 'SSH_NETWORK' | 'SSH_TIMEOUT'
      | 'WP_NOT_FOUND' | 'WPCLI_NOT_AVAILABLE' | 'UNKNOWN';
  message: string;
};

export async function probeSftp(input: ProbeInput): Promise<ProbeResult>;
```

Steps:

1. Open SSH connection via existing `SshClient` (it already exposes
   the typed errors we want — `SshClient.ts:21-34`).
2. List home directory; assert `applications/` exists. Find the first
   subdir containing `public_html/wp-config.php`. If multiple
   `applications/*/public_html` exist, prompt the user (Cloudways
   master users can have many apps). v1: if exactly one → auto-pick;
   if multiple → return them and let the form ask the user to choose;
   if zero → `WP_NOT_FOUND`.
3. Run `php -v` — capture php version (cosmetic).
4. Run `wp --info --path=<webRoot>` to verify wp-cli. If absent,
   succeed but return `wpCliAvailable: false` and surface a warning
   in the form ("Push will work; DB import on the remote will use
   `mysql` directly").
5. Run `wp option get siteurl --path=<webRoot>` if wp-cli is present
   — cache as `detectedSiteUrl`.
6. Disconnect.

The form blocks "Save" until the probe is `ok`, then writes the
mapping + credential.

### 5.3 Pull flow in SFTP mode

`PullOrchestrator.run` already does:

1. Resolve app → SSH config.
2. Create new Local site via `LocalSiteService.createSite`.
3. Tar the remote `wp-content` (per the active `feedback_pull_archive`
   memory).
4. Stream tar back via SFTP.
5. Extract locally, dump remote DB through SSH, import locally,
   search-replace.
6. Persist mapping.

In SFTP mode the only differences are:

- Step 1 returns the user-supplied host/port/username/password instead
  of API-derived values.
- The `appLabel` shown during pull comes from the form's "label" field
  (or defaults to the detected `applications/<slug>` directory name).
- No pre-pull API call to `triggerAppBackup` (Cloudways pulls don't
  trigger one today either — pulls are read-only — so no behavioral
  change).
- The `SiteMapping` written at the end has `linkMode: 'sftp'`.

Note: for the "pull when not yet linked" case (today's primary entry
on the Connect screen), the flow stays API-only in v1. If a user
without an API key wants to pull, they need to (a) create a blank
Local site themselves, then (b) link via SFTP, then (c) push — or
(c) we can ship a "pull into a new Local site" variant of the
SFTP-link wizard later. Out of scope for v1.

### 5.4 Push flow in SFTP mode

`PushOrchestrator.run` flow:

1. Pre-check: WP installed locally, mapping resolves, link reachable.
2. **Backup** — currently `client.triggerAppBackup` + wait. In SFTP
   mode replace with:
   - SSH into the server.
   - `tar -czf /tmp/cwsync-snapshot-<ts>.tgz -C <webRoot> .` excluding
     the usual ignore set.
   - `mysqldump` to `/tmp/cwsync-snapshot-<ts>.sql.gz`.
   - Record path + timestamp on the new `UndoRecord` (see §5.5).
   - Optionally also `sftp get` the snapshot files down to
     `<userData>/cloudwayssync/snapshots/<localSiteId>/<ts>/` so the
     undo works even if `/tmp` gets cleaned. Default: yes if total
     size < 500 MB, otherwise leave on the remote and warn.
3. Upload new files via SFTP (unchanged).
4. Run search-replace via wp-cli (or fall back to manual SQL if
   `wpCliAvailable === false`).
5. Persist undo record.

### 5.5 Undo in SFTP mode

`src/main/ipc/syncHandlers.ts:293-316` (`UNDO_PUSH`) currently calls
`client.restoreApp()` + `waitForOperation()`. SFTP mode branches:

```ts
const link = await appLinkFor(mapping);
if (link.mode === 'api' && link.restoreFromRemoteBackup) {
  await link.restoreFromRemoteBackup(record.backupId);
} else {
  await restoreFromLocalSnapshot(link, record.snapshot);
}
```

`restoreFromLocalSnapshot`:

1. Re-open SSH.
2. If snapshot files were saved locally, SFTP-put them back to
   `/tmp/`.
3. `tar -xzf` over the web root (after backing up the now-current
   state to `/tmp/cwsync-pre-undo-<ts>.tgz` so undo is itself
   reversible).
4. Restore DB from `*.sql.gz`.
5. Mark `UndoRecord.undoneAt`.

Tradeoff: `restoreApp` on Cloudways is atomic; our local-snapshot
undo is best-effort and slower. Document in the UI text.

The `UndoRecord` shape grows an optional snapshot pointer:

```ts
type UndoRecord = {
  // ... existing fields ...
  snapshot?: {
    kind: 'local-tar';
    remoteTarPath: string;       // /tmp/cwsync-snapshot-...
    remoteSqlPath: string;
    localCachePath?: string;     // <userData>/cloudwayssync/snapshots/...
    sizeBytes: number;
  };
};
```

API-mode records keep `backupId` on the operation result as today.
The two are mutually exclusive.

---

## 6. UI changes

### 6.1 Site Tools panel — `SiteToolsPanel.tsx:207-310`

Today three states: `DisconnectedState`, `UnlinkedState`,
`LinkedState`. Restructure:

- `UnlinkedState` always renders two buttons:
  - **Link to Cloudways via API…** — disabled with tooltip "Connect on
    the Cloudways Sync sidebar first" if API not connected; otherwise
    opens existing dropdown picker.
  - **Link via SFTP…** — always enabled; opens the new form.
- `DisconnectedState` is removed; its message becomes a small note
  inside the API button's disabled tooltip.
- `LinkedState` reads `mapping.linkMode` and renders the badge +
  conditional "Open on Cloudways" + the right undo label.

### 6.2 New form: `LinkViaSftpDialog`

`src/renderer/screens/LinkViaSftpDialog.tsx`. Plain Local
`<Dialog>` with the fields from §3.1, a "Test connection" button that
runs the probe (§5.2) and shows inline status, and a "Save" button
enabled only after a successful probe. Multiple-app disambiguation
shows a `<select>` of the detected `applications/*` directories.

### 6.3 Connect screen note

`ConnectScreen.tsx` gets a small `<p>` under the form:

> Don't have a Cloudways API key? You can still link individual sites
> via SFTP — open any Local site's Tools panel and choose
> **Link via SFTP**.

### 6.4 Error guidance copy

New entries in `src/shared/errorMessages.ts`:

```ts
SFTP_MULTIPLE_APPS: {
  title: 'Multiple apps found',
  body: 'This SFTP user has access to more than one app. Pick which one to link.',
},
SFTP_WP_NOT_FOUND: {
  title: 'No WordPress install detected',
  body: 'No public_html/wp-config.php was found under any applications/* directory. Confirm this is a Cloudways WordPress app.',
},
SFTP_NEEDS_MANUAL_SETUP: {
  title: 'Cloudways setup required',
  body: 'In the Cloudways dashboard, open Application Settings → SSH/SFTP and create credentials, then try again.',
},
WPCLI_NOT_INSTALLED_SFTP: {
  title: 'wp-cli not available',
  body: 'wp-cli was not found on the server. Push will use raw SQL imports — search-replace may be slower.',
},
SFTP_IP_NOT_WHITELISTED: {
  title: 'IP not whitelisted',
  body: 'Cloudways may have rejected this connection because your IP isn\'t whitelisted on the app. Open the Application → SSH/SFTP page and add your IP, or set the app to "Allow all IPs".',
},
```

### 6.5 Manual-step inline coachmarks

When the probe returns `SSH_AUTH_FAILED`, show a small expandable
"How to fix this" block listing literal Cloudways UI steps:

> 1. Log in to Cloudways → Applications → _your app_.
> 2. Application Settings → SSH/SFTP.
> 3. Click **Set Password**, copy it, paste it here.
> 4. Scroll to **Allow Public Access** or add your IP to the
>    whitelist.

Same pattern for `SSH_NETWORK` (whitelist) and `WP_NOT_FOUND`
(check this is the right app).

---

## 7. IPC changes

### 7.1 New channels

```ts
CHANNELS.PROBE_SFTP            request: ProbeInput        response: ProbeResult
CHANNELS.LINK_VIA_SFTP         request: SftpLinkRequest   response: { mapping: SftpSiteMapping }
```

`SftpLinkRequest` is `ProbeInput & { localSiteId; appLabel?; webRoot; remoteUrl? }`.
The handler:

1. Re-runs the probe (defence in depth — UI can't be trusted).
2. Writes credential via `SftpCredentialStore.set`.
3. Writes mapping via `SiteMapper.set` with `linkMode: 'sftp'`.
4. Returns the new mapping.

### 7.2 Existing channels gain mode-awareness

- `CHANNELS.MAP_SITE` request grows `linkMode?: 'api' | 'sftp'`
  (default `'api'`). Required when `'sftp'`: `host/port/username/sftpPassword`.
- `CHANNELS.UNLINK_SITE` — same handler; additionally calls
  `SftpCredentialStore.delete` if the mapping was SFTP-mode.
- `CHANNELS.LIST_MAPPINGS` response is unchanged shape (the union is
  already in `SiteMapping`).

---

## 8. Testing plan

### 8.1 Unit

- `SftpCredentialStore` round-trip with `safeStorage` mock.
- `SiteMapper` migration: legacy mapping without `linkMode` reads as
  `'api'`; rewrites carry `linkMode` after `set()`.
- `appLinkFor` returns the right impl for each mode.
- `ApiAppLink.triggerRemoteBackup` defined; `SftpAppLink` not defined
  on the prototype (so `if (link.triggerRemoteBackup)` works).
- Error code mapping for the new SFTP-only codes.
- `siteMenu.test.ts` — extend so menu generation works for both modes
  (currently only API-shape mapping; add `linkMode: 'sftp'` cases for
  "Open on Cloudways" omission).

### 8.2 Integration / smoke

- A new `scripts/smoke-sftp-link.mjs` mirrors
  `scripts/smoke-cloudways.mjs` but takes host/port/user/pass env
  vars, runs the probe, asserts the expected web root. Run on a
  throw-away Cloudways app whose credentials sit in
  `.env.smoke.local`.
- Manual end-to-end pass:
  1. Fresh Local install, no Cloudways API connection.
  2. Create empty Local site.
  3. Link via SFTP to a known app — assert mapping appears, sidebar
     badge appears, "Linked via SFTP" badge appears in Tools panel.
  4. Push uploads-only — assert remote files updated, `/tmp/cwsync-*`
     snapshot exists.
  5. Push DB — assert search-replace ran.
  6. Undo — assert files + DB restored.
  7. Unlink — assert credential file no longer contains the entry.
  8. Repeat steps 4–7 with API mode mapping present on a different
     site, to confirm the two coexist.

### 8.3 Failure-mode coverage

Manually trigger and verify the right human error surfaces:

- Wrong password → `SSH_AUTH_FAILED` + coachmark.
- Wrong host → `SSH_NETWORK`.
- App with `applications/*/public_html/` missing wp-config →
  `SFTP_WP_NOT_FOUND`.
- Master user with multiple apps → `SFTP_MULTIPLE_APPS` (form should
  show selector).
- `wp` not on PATH on the server → push works, search-replace falls
  back to SQL, warning shown.

---

## 9. Phased rollout

Five small, independently shippable phases. Each ends with green
tests + a manual smoke pass.

**Phase 1 — Foundation.**
- Discriminated-union `SiteMapping`.
- `SftpCredentialStore`.
- `appLinkFor` + `ApiAppLink` (no behavior change yet — orchestrators
  keep their current code paths but route through `appLinkFor` for
  API mappings).
- `SiteMapper` migration.
- Tests for the new units.

Acceptance: existing addon behavior identical to today; mappings
written after this phase carry `linkMode: 'api'`.

**Phase 2 — Probe + IPC + form.**
- `probeSftp` implementation.
- `PROBE_SFTP` and `LINK_VIA_SFTP` IPC handlers.
- `LinkViaSftpDialog` UI (no integration with push/pull yet —
  mappings created here will fail at push/pull time, by design;
  guard the buttons with a "coming soon" toast keyed off mode).

Acceptance: a user can complete the link form, the mapping appears
on disk, the sidebar badge shows, the Tools panel shows the linked
state with the "SFTP" badge.

**Phase 3 — Push works in SFTP mode.**
- `SftpAppLink` complete.
- `PushOrchestrator` routes through `appLinkFor` for both modes.
- Local snapshot pre-push step + `UndoRecord.snapshot`.
- `restoreFromLocalSnapshot` for `UNDO_PUSH`.
- Remove the "coming soon" toast on the Push button for SFTP
  mappings.

Acceptance: full push + undo cycle on a real Cloudways app linked
via SFTP only.

**Phase 4 — Pull works in SFTP mode (link-then-pull).**
- `PullOrchestrator` routes through `appLinkFor`.
- The pull entry-point on the Tools panel works for SFTP mappings.
  (Pulling into a brand-new Local site without a prior link stays
  API-only this phase — see §5.3 closing note.)

Acceptance: pull from a known SFTP-linked app reproduces the same
result an API-linked pull would.

**Phase 5 — Polish & docs.**
- Coachmark error blocks for the common probe failures.
- Connect-screen note about SFTP mode.
- Update `README.md` "Linking modes" section.
- Update `CHANGELOG.md`.
- Optional: pull-into-new-site SFTP wizard (was deferred from §5.3).

---

## 10. Known limitations / open questions

1. **Selecting the right app for master users.** A master SFTP user
   sees every app on the server. v1 lets the user pick; v2 could let
   them link several apps to several Local sites in one wizard.
2. **Snapshot location.** Storing snapshots in `/tmp` is fragile —
   Cloudways periodically cleans `/tmp`. The local-cache fallback
   (§5.4) covers small sites; large sites either accept the risk or
   the user chooses to keep snapshots remote in
   `~/private_html/.cwsync-snapshots/` (writable by master/app
   users). v1: `/tmp` + local cache. v1.1: configurable path.
3. **No remote operation history.** Without `restoreApp`, we can't
   verify the snapshot was applied atomically. If `tar -xzf` crashes
   midway, the remote site is left half-restored. Mitigation: the
   pre-undo snapshot (so re-running undo is recoverable). Document
   this.
4. **Cloudways UI changes.** The coachmark text references specific
   Cloudways dashboard menu paths. If Cloudways changes the menu, our
   text drifts. Keep the copy in one place and easy to update.
5. **Mode B push (provision new app) stays API-only.** No path here
   for SFTP-only users to create new apps. That requires asking the
   account owner to create the app and share SFTP creds — outside
   the addon's reach.
6. **Migrating mode after-the-fact.** A user who later gets an API
   key can today only "unlink + relink via API". Future work: a
   one-click "Upgrade this link to API mode" once
   `serverId/appId` can be discovered from the `host`. Cloudways has
   `/app/manage/getapp_credentials_by_appid` but it requires
   `appId` already, so we'd need either user input or a fuzzy match
   on `app.app_fqdn` against the host. Not in v1.
7. **Rate-limit / brute-force concerns.** The probe sends one auth
   attempt per "Test" click. If users hammer it with wrong passwords,
   Cloudways may block their IP at the server's `fail2ban` layer.
   Probe form should debounce (no auto-retry on failure) and surface
   the IP-whitelist coachmark.

---

## 11. Files touched (summary)

New:
- `src/main/credentials/SftpCredentialStore.ts`
- `src/main/connection/sftpProbe.ts`
- `src/main/sync/AppLink.ts` (with `ApiAppLink`, `SftpAppLink`,
  `appLinkFor`)
- `src/renderer/screens/LinkViaSftpDialog.tsx`
- `scripts/smoke-sftp-link.mjs`
- `test/unit/sftpCredentialStore.test.ts`
- `test/unit/appLink.test.ts`
- `test/unit/sftpProbe.test.ts` (with mocked SshClient)

Modified:
- `src/shared/ipcTypes.ts` — discriminated-union `SiteMapping`,
  new `ProbeInput/Result`, new IPC channel constants.
- `src/main/sync/SiteMapper.ts` — migration; same-shape API.
- `src/main/sync/PushOrchestrator.ts` — route via `appLinkFor`,
  add local-snapshot step.
- `src/main/sync/PullOrchestrator.ts` — route via `appLinkFor`.
- `src/main/ipc/syncHandlers.ts` — new `PROBE_SFTP` /
  `LINK_VIA_SFTP` handlers; branch `UNDO_PUSH` on link mode.
- `src/renderer/screens/SiteToolsPanel.tsx` — restructure
  Disconnected/Unlinked, render badge + correct CTAs.
- `src/renderer/screens/ConnectScreen.tsx` — note about SFTP mode.
- `src/renderer/siteMenu.ts` + `test/unit/siteMenu.test.ts` —
  mode-aware "Open on Cloudways" omission.
- `src/shared/errorMessages.ts` — new SFTP-only codes.
- `README.md`, `CHANGELOG.md`.

Untouched:
- `src/main/cloudways/ApiClient.ts` — no API additions needed.
- `src/main/connection/service.ts` — API-key flow is independent.
- `src/main/remote/SshClient.ts` — already has every config field
  SFTP mode needs.
- `src/renderer/sidebar/injectSiteListIcons.ts` — already
  mode-agnostic via `listMappings()`.
