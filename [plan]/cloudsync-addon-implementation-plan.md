# CloudSync — Local WP Add-on for Cloudways ↔ Local Bidirectional Sync

> Plan date: 2026-04-22
> Purpose: Complete, actionable engineering plan to build the add-on from
> scratch. Designed to be handed to a fresh Claude Code session in a new
> repository outside the BuildPress directory.
> Companion docs (in this same `[plan]/` directory):
> - `cloudways-api-capabilities-research.md`
> - `local-wp-addon-cloudways-sync-research.md`

---

## 0. Name & branding

**Primary name: `CloudSync`**
Full product name: **CloudSync for Local** — "Cloudways ↔ Local, one click."

Alternative names considered (keep as fallbacks in case of trademark
collision during submission to the Local Add-on Library):
- **Portway** — port + Cloudways pun, available as npm name
- **LaunchBridge** — evokes staging↔local bridge
- **Ferry for Local** — cute, transport metaphor

npm package name: `local-addon-cloudsync`
Display name inside Local's add-on library: `CloudSync`
Short tagline: "Clone any Cloudways app to Local in one click. Push back
when ready. Safe by default."

---

## 1. Mission and scope

### 1.1 What CloudSync does
1. Connects a Local WP installation to a Cloudways account (OAuth via
   email + API key).
2. Lets the user browse their Cloudways servers and apps from inside Local.
3. **Pull:** one-click clone of any Cloudways WordPress app into a new
   Local site — DB, `wp-content/`, PHP version, HTTPS, domain — with
   automatic search-replace.
4. **Push:** one-click push of any Local site to either an existing
   Cloudways app (Mode A) or a brand-new app provisioned on the fly
   (Mode B).
5. **Selective sync:** checkbox-driven partial sync — DB only, uploads
   only, a single plugin/theme, etc.
6. **Safety rails:** always-on backup (Cloudways `backup_server` remote,
   local `wp db export` + `wp-content` tarball) before any mutating push.
   "Undo last push" via Cloudways `restore_app`.

### 1.2 What CloudSync explicitly does **not** do (v1)
- Not a general WP migration tool — Cloudways-specific.
- No WPEngine / Kinsta / SiteGround / shared-host support (future).
- No WP Multisite support in v1 (warn and block).
- No scheduled / cron-driven sync (manual trigger only).
- Not tied to BuildPress. Separate repo, separate release cadence.
  (Optional future: share a `@ourorg/cloudways-client` npm package.)

### 1.3 Success metrics
- Pull a 500 MB WordPress app into Local in under 5 minutes on a 100
  Mbps connection.
- Push back the same app in under 5 minutes, with zero data loss and
  search-replace handling serialized PHP data correctly.
- Zero credentials written to disk unencrypted, ever.
- "Undo last push" restores the remote site to its pre-push state
  within 3 minutes.

---

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Type-safety across main/renderer/IPC; matches Local's own API types |
| Local SDK | `@getflywheel/local` (types), `@getflywheel/local-components` (UI) | Official, required for visual consistency |
| Scaffold | `npx create-local-addon` | Official generator — gives us package.json, main, renderer, symlink setup |
| UI | React 18 + Local components + Tailwind (optional, scoped) | React is mandatory (Local uses it); Tailwind via `prefix: 'cs-'` to avoid collisions |
| State (renderer) | Zustand | Small, simple, works inside an iframe-ish add-on context |
| SSH | `ssh2` (npm) | Battle-tested, pure-JS, no native deps |
| SFTP | `ssh2-sftp-client` | Wraps `ssh2`, exposes clean `put/get/fastPut/fastGet` |
| HTTP | `undici` | Native HTTP/1.1 + HTTP/2, streams well for SFTP-less fallback |
| Schemas / validation | `zod` | Runtime validation for API responses + IPC payloads |
| Archiving | `archiver` (create), `extract-zip` (read) | Standard Node picks |
| Progress streams | Node `EventEmitter` + Electron IPC events | Matches BuildPress patterns |
| Credential storage | Electron `safeStorage` API + plain-text index file | OS keychain via Electron; no extra native deps |
| Logging | `pino` → file under Local's log dir | Structured, cheap, streams JSON lines |
| Tests | `vitest` + `@testing-library/react` | Fast ESM-first; mirrors BuildPress |
| Build | `tsc` (main) + `vite` (renderer) | Matches Local SDK expectations |
| Lint/format | `oxlint` + `oxfmt` | Matches BuildPress; fast |
| CI | GitHub Actions | Matrix: macOS + Windows + Linux, Local stable + nightly |

**Versions to pin at project start:**
- Node: 20.x (Local's bundled runtime at time of writing)
- Electron: inherited from Local (do not bundle our own)
- `@getflywheel/local`: latest stable + caret range

---

## 3. Repository layout

```
cloudsync-addon/
├── README.md
├── LICENSE                              (MIT recommended)
├── CHANGELOG.md
├── package.json
├── tsconfig.json
├── tsconfig.main.json                   (extends; CommonJS output)
├── tsconfig.renderer.json               (extends; ESM output)
├── vite.config.ts                       (renderer only)
├── .oxlintrc.json
├── .oxfmtrc.json
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml                       (build + lint + test matrix)
│       └── release.yml                  (tag → build → GitHub Release)
├── src/
│   ├── main/                            Electron main-process code
│   │   ├── index.ts                     Entry: registers hooks, IPC handlers
│   │   ├── ipc/
│   │   │   ├── channels.ts              Channel name constants (shared w/ renderer)
│   │   │   ├── registerHandlers.ts      Wires every handler
│   │   │   └── handlers/
│   │   │       ├── connect.ts
│   │   │       ├── listServers.ts
│   │   │       ├── listApps.ts
│   │   │       ├── pull.ts
│   │   │       ├── push.ts
│   │   │       ├── selectiveSync.ts
│   │   │       └── undoPush.ts
│   │   ├── cloudways/
│   │   │   ├── ApiClient.ts             OAuth + REST + operation polling
│   │   │   ├── SftpClient.ts            Download / upload / mirror
│   │   │   ├── SshClient.ts             exec WP-CLI / mysqldump over SSH
│   │   │   ├── schemas.ts               zod schemas for every response
│   │   │   └── errors.ts                Tagged errors (Auth, RateLimit, Operation, …)
│   │   ├── local/
│   │   │   ├── SiteImporter.ts          addSite → start → wp db import → search-replace
│   │   │   ├── SiteExporter.ts          wp db export + zip wp-content + manifest
│   │   │   ├── SiteResolver.ts          Match Cloudways app ↔ Local site by mapping
│   │   │   └── ManifestV1.ts            zod schema for `cloudsync-export.json`
│   │   ├── sync/
│   │   │   ├── PullOrchestrator.ts      The 14-step pull flow
│   │   │   ├── PushOrchestrator.ts      The push flow (Mode A + B)
│   │   │   ├── Selective.ts             Plan which paths to sync based on checkboxes
│   │   │   └── Progress.ts              Typed progress event bus
│   │   ├── safety/
│   │   │   ├── RemoteBackup.ts          Call Cloudways backup, wait, track ID
│   │   │   ├── LocalSnapshot.ts         Tar + gzip wp-content + db dump
│   │   │   └── UndoLedger.ts            Persist "last safe state" JSON
│   │   ├── storage/
│   │   │   ├── CredentialStore.ts       safeStorage-backed
│   │   │   ├── SiteMapping.ts           { localSiteId → { serverId, appId } }
│   │   │   └── PreferencesStore.ts      electron-store style, file per add-on
│   │   ├── logging/Logger.ts            pino → file
│   │   └── util/
│   │       ├── retry.ts                 Exponential backoff helper
│   │       ├── humanBytes.ts
│   │       └── tmp.ts                   Temp dir under Local's userData
│   ├── renderer/                        React UI
│   │   ├── index.tsx                    Entry: register hooks
│   │   ├── hooks.tsx                    All `hooks.addFilter`/`addContent` calls
│   │   ├── ipc/
│   │   │   └── bridge.ts                Typed wrapper over IPC calls
│   │   ├── store/
│   │   │   ├── useConnectionStore.ts
│   │   │   ├── useServersStore.ts
│   │   │   └── useSyncJobStore.ts
│   │   ├── screens/
│   │   │   ├── SidebarPanel.tsx         Top-level "CloudSync" sidebar entry
│   │   │   ├── ConnectModal.tsx
│   │   │   ├── ServersList.tsx
│   │   │   ├── AppDetail.tsx
│   │   │   ├── PullModal.tsx
│   │   │   ├── PushModal.tsx
│   │   │   ├── SelectiveSyncPanel.tsx
│   │   │   ├── ProgressDialog.tsx
│   │   │   └── UndoConfirmDialog.tsx
│   │   ├── siteMenu/
│   │   │   └── PerSiteMenuItems.tsx     Injects "Push to Cloudways" etc.
│   │   ├── components/                  Local-specific wrappers / composites
│   │   │   ├── CloudwaysLogo.tsx
│   │   │   ├── AppCard.tsx
│   │   │   ├── SyncStepList.tsx
│   │   │   └── DangerBanner.tsx
│   │   ├── styles/
│   │   │   └── tailwind.css             Prefixed tw styles
│   │   └── lib/format.ts
│   └── shared/                          Types imported by both main + renderer
│       ├── ipcTypes.ts                  Channel → request/response type map
│       ├── syncTypes.ts                 Pull/Push job state machine types
│       └── errors.ts                    Serializable error shapes
├── test/
│   ├── unit/
│   ├── integration/                     Spins up a temp Local site
│   └── fixtures/                        Sample Cloudways JSON responses
├── assets/
│   ├── icon-128.png
│   └── icon-512.png
└── scripts/
    ├── link-to-local.mjs                Symlink into Local's addons dir
    ├── unlink-from-local.mjs
    └── build-addon-zip.mjs              For distribution
```

---

## 4. Data model

All stored under Local's userData (per-OS), scoped to this add-on.

### 4.1 Credential store (keychain-backed)
One record per connected account. Only ever one active account in v1.
```ts
type CloudwaysCredentials = {
  email: string;
  apiKey: string;           // encrypted via safeStorage
  connectedAt: string;      // ISO
};
```
- Access token is **never** persisted — derived in memory, cached 55 min
  TTL, rotated on 401.

### 4.2 Site mapping
```ts
type SiteMapping = {
  localSiteId: string;      // Local's internal UUID
  cloudwaysServerId: number;
  cloudwaysAppId: number;
  cloudwaysAppLabel: string;
  cloudwaysUrl: string;     // Primary domain
  lastPulledAt: string | null;
  lastPushedAt: string | null;
};
```

### 4.3 Undo ledger
```ts
type UndoRecord = {
  id: string;               // UUID
  kind: 'push' | 'pull';
  localSiteId: string;
  cloudwaysServerId: number;
  cloudwaysAppId: number;
  createdAt: string;
  // Cloudways side
  remoteBackupOperationId: number | null;
  remoteBackupTimestamp: string | null;  // Parsable by restore_app
  // Local side
  localSnapshotPath: string | null;      // absolute path to tarball
  // Metadata
  includedDb: boolean;
  includedFiles: boolean;
  fileScopes: string[];     // ['uploads', 'themes', ...]
};
```

### 4.4 Sync job (in-memory + event-log persisted)
```ts
type SyncJob = {
  id: string;
  direction: 'pull' | 'push';
  mode: 'existing-app' | 'new-app';
  localSiteId: string | null;   // null during pull-to-new-site
  cloudwaysServerId: number;
  cloudwaysAppId: number | null; // null during push mode 'new-app' until provisioned
  steps: SyncStep[];             // immutable once job starts
  currentStepIndex: number;
  status: 'planned' | 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  undoRecordId: string | null;
};

type SyncStep = {
  id: string;
  label: string;
  kind: 'backup' | 'export-db' | 'zip' | 'sftp-upload' | 'sftp-download'
      | 'wp-cli' | 'api-call' | 'create-site' | 'start-site'
      | 'search-replace' | 'extract' | 'verify';
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  startedAt: string | null;
  finishedAt: string | null;
  bytesTransferred?: number;
  totalBytes?: number;
  detail: string;   // human-readable; updated as the step runs
};
```

### 4.5 Export manifest (`cloudsync-export.json`)
Dropped into the root of every zip CloudSync produces.
```ts
type CloudSyncManifestV1 = {
  manifestVersion: 1;
  source: {
    kind: 'local' | 'cloudways';
    siteName: string;
    primaryUrl: string;
    createdAt: string;
    cloudways?: { serverId: number; appId: number };
  };
  environment: {
    phpVersion: string;
    mysqlVariant: 'mysql' | 'mariadb';
    mysqlVersion: string;
    wordpressVersion: string;
    isMultisite: boolean;
    webServer: 'nginx' | 'apache' | 'auto';
  };
  contents: {
    database: { file: string; sizeBytes: number; gzipped: boolean } | null;
    files: { root: string; includes: string[]; excludes: string[] };
  };
  cloudsyncAddonVersion: string;
};
```

---

## 5. IPC contract (main ↔ renderer)

Channel names are constants in `src/main/ipc/channels.ts` re-exported
from `src/shared/ipcTypes.ts`. Every call is typed end-to-end.

| Channel | Direction | Request | Response / Stream |
|---|---|---|---|
| `cs:connect` | R→M | `{ email, apiKey }` | `{ ok: true, user: {...} }` \| typed error |
| `cs:disconnect` | R→M | `{}` | `{ ok: true }` |
| `cs:getConnection` | R→M | `{}` | `{ connected: boolean, email?: string }` |
| `cs:listServers` | R→M | `{}` | `{ servers: Server[] }` |
| `cs:listApps` | R→M | `{ serverId }` | `{ apps: App[] }` |
| `cs:getApp` | R→M | `{ serverId, appId }` | Full app detail including SFTP creds |
| `cs:planPull` | R→M | `{ serverId, appId, includes, destinationName }` | `{ planId, steps }` |
| `cs:planPush` | R→M | `{ localSiteId, serverId?, appId?, mode, includes }` | `{ planId, steps }` |
| `cs:runJob` | R→M | `{ planId }` | **streaming** — `cs:jobProgress` events until `cs:jobDone` |
| `cs:cancelJob` | R→M | `{ jobId }` | `{ cancelled: boolean }` |
| `cs:jobProgress` | M→R event | — | `{ jobId, stepId, status, bytesTransferred?, detail }` |
| `cs:jobDone` | M→R event | — | `{ jobId, status: 'success'\|'failed', undoRecordId? }` |
| `cs:listUndo` | R→M | `{ localSiteId }` | `{ records: UndoRecord[] }` |
| `cs:undoPush` | R→M | `{ undoRecordId }` | Streams progress like `runJob` |
| `cs:mapSite` | R→M | `{ localSiteId, serverId, appId }` | `{ ok: true }` |
| `cs:getMapping` | R→M | `{ localSiteId }` | `{ mapping: SiteMapping \| null }` |

Every handler validates its request via zod. Errors serialize to
`{ code: string, message: string, retriable: boolean, detail?: unknown }`.

---

## 6. Cloudways API client — required endpoints

Only the endpoints CloudSync needs. All v2. Full catalogue in the
companion research doc.

| Action | Verb + path | Used in |
|---|---|---|
| OAuth token | `POST /oauth/access_token` | Connect |
| List servers | `GET /server` | Dashboard |
| Get server detail (incl. apps) | included in `/server` list | App picker |
| Get app access details (SFTP, DB) | `GET /app/creds?server_id={server_id}&app_id={app_id}` | Pull + Push setup |
| Trigger app backup | `POST /app/manage/takeBackup` | Safety (pull) |
| Trigger server backup | `POST /server/manage/takeBackup` | Safety (push) |
| Poll operation | `GET /operation/{operation_id}` | Every async call |
| Restore app (point-in-time) | `POST /app/restore` | Undo push |
| Whitelist IP for SSH | `POST /security/whitelisted` (`tab=ssh`) | If needed for SSH from a new IP |
| Create app | `POST /app` (Mode B) | New-app push |
| Delete app | `DELETE /app` | Rollback failed Mode B push |
| Update DB password | `POST /app/creds` (update) | Only if needed during troubleshooting |

Retry rules: 429 → exponential backoff (starts 2 s, caps 60 s, max 8
tries). 401 → re-auth once, retry once. 5xx → backoff 3 tries. All
others → surface to user.

---

## 7. The two flows, step-by-step

### 7.1 Pull — Cloudways app → new Local site

Happy path is 14 discrete `SyncStep`s. Each updates `SyncJob` state and
emits progress.

1. **Validate plan** — app still exists, SSH+SFTP creds present.
2. **Whitelist IP** (conditional) — if Cloudways SSH whitelist is
   enabled, add local public IP via API. Record so we can revoke on
   completion.
3. **Trigger Cloudways app backup** — safety net for the *source*,
   even though we're reading. `POST /app/manage/takeBackup` then
   poll `GET /operation/{operation_id}`.
4. **SSH connect** — open persistent SSH session using master SSH key
   (or credentials returned by API).
5. **Collect source metadata** via WP-CLI:
   - `wp core version --path=<webroot>`
   - `wp option get home` / `siteurl`
   - `wp core is-installed --network` (detect multisite → abort with
     warning if true in v1).
6. **`wp db export /tmp/cs-<jobId>.sql --add-drop-table --path=<webroot>`**
7. **gzip the dump** server-side: `gzip -f /tmp/cs-<jobId>.sql`.
8. **SFTP download** `cs-<jobId>.sql.gz` to a staging tmp dir under
   Local's userData.
9. **SFTP mirror** `wp-content/` (respecting selective checkboxes) with
   streamed progress. Skip `wp-content/cache/`, `uploads/cache/`,
   `backup*`.
10. **Build site config** — choose Local site name (user input earlier),
    destination path under `~/Local Sites/<name>`, PHP version matched
    from server metadata, HTTPS enabled, MariaDB by default.
11. **`cradle.siteData.addSite(config)`** then
    **`cradle.siteProcessManager.start(site)`**. Wait for ready.
12. **Extract** downloaded `wp-content/` into `<site>/app/public/wp-content`.
13. **`cradle.wpCli.run(site, ['db', 'import', '/tmp/cs-<jobId>.sql'])`**
    (after gunzipping locally).
14. **`wp search-replace`** old URL → new `.local` URL, `--all-tables`
    `--skip-columns=guid`. Then `wp cache flush` and
    `wp rewrite flush`.
15. **Revoke IP whitelist** (if we added one in step 2).
16. **Record UndoRecord** (kind `pull`; only `localSnapshotPath` set —
    we can "undo the pull" by restoring the local snapshot from before
    we created the site — i.e. just delete the site).
17. **Success event** with link "Open site in Local".

Failure handling: on any step failure, mark job `failed`, preserve
artifacts for retry, **leave any partially-created Local site but flag
it** so the user can choose delete or keep for inspection.

### 7.2 Push — Local site → Cloudways (Mode A: existing app)

1. **Pre-flight checks:**
   - Mapping exists (or user picked target app in modal).
   - Local site is started; if not, start it.
   - PHP major versions match (warn on mismatch; hard-block on
     WordPress major mismatch).
   - Disk space on remote `/home/master/applications/<app>/` > 2× local
     export size.
2. **Remote safety backup** — `POST /server/manage/takeBackup`, poll, record
   `operationId` and timestamp → `UndoRecord.remoteBackupTimestamp`.
3. **Local safety snapshot** — tar + gzip `site.paths.webRoot` + a
   fresh `wp db export` into
   `~/Local Sites/.cloudsync-backups/<siteId>-<timestamp>.tar.gz`.
   Record path → `UndoRecord.localSnapshotPath`.
4. **Local DB export** — `wp db export /tmp/cs-<jobId>.sql
   --add-drop-table --path=<webroot>`; gzip.
5. **SFTP upload** of `wp-content/` (selective), using the same rsync-
   like flow BuildPress already has. `--delete` disabled by default;
   enabled only if user ticked the "Mirror (delete extras)" checkbox.
6. **SFTP upload** DB dump to
   `/home/master/applications/<app>/private_html/cs-<jobId>.sql.gz`.
7. **SSH:** gunzip it on the server.
8. **SSH `wp db import`** with `--path=<server webroot>`.
9. **SSH `wp search-replace`** `.local` → production URL, all-tables,
   skip guid.
10. **SSH `wp cache flush`** + **`wp rewrite flush`**.
11. **Cloudways API:** if app has Varnish enabled, `POST /server/services/varnish`
    purge. If CloudwaysCDN attached, `purge_assets_from_cw_cdn`.
12. **Cleanup** — delete the remote SQL dump in `private_html/`.
13. **Finalize UndoRecord** — mark ready; persist.
14. **Success event** with link "View site" and "Undo push" buttons.

### 7.3 Push — Mode B (new app)

Identical to Mode A except inserted at the top:

0a. **Create Cloudways app:** `POST /app` with `application=wordpress`,
   `app_label=<user input>`, target `server_id`. Poll operation.
0b. **Fetch new app creds:** SFTP host, username, password, SSH key,
   DB name, DB user, DB password.
0c. **Store mapping:** add a new `SiteMapping` record so subsequent
   pushes default to Mode A.

Failure rollback for Mode B: if any step 1–11 fails after app creation,
**offer to delete the freshly-created Cloudways app** (since it contains
no data the user cares about yet). Never auto-delete — always confirm.

### 7.4 Undo push

1. Load `UndoRecord` by id.
2. Require typed confirmation ("type RESTORE to confirm").
3. **Call Cloudways `restore_app`** with `remoteBackupTimestamp` as
   the target. Poll operation.
4. Show completion toast. Record timestamp of undo.

Undo does **not** touch the local site — by design. User may want to
keep their local changes while rolling back prod.

### 7.5 Selective sync resolver

Checkbox → resolved include/exclude glob set.

| Checkbox | Includes | Excludes |
|---|---|---|
| DB | `*.sql` step only | — |
| Uploads | `wp-content/uploads/**` | `wp-content/uploads/cache/**` |
| All plugins | `wp-content/plugins/**` | `wp-content/plugins/*/node_modules/**`, `**/.git/**`, `**/*.log` |
| All themes | `wp-content/themes/**` | `**/node_modules/**`, `**/.git/**` |
| Specific plugin `<slug>` | `wp-content/plugins/<slug>/**` | `**/node_modules/**`, `**/.git/**` |
| Specific theme `<slug>` | `wp-content/themes/<slug>/**` | same |
| mu-plugins | `wp-content/mu-plugins/**` | `**/.git/**` |
| languages | `wp-content/languages/**` | — |

Never-synced in either direction, no override:
- `wp-config.php`
- `.htaccess` (Cloudways-managed)
- `wp-content/advanced-cache.php` (varies per host)
- `wp-content/object-cache.php`
- `*.log`, `error_log`
- `wp-content/cache/`

---

## 8. Phases — ship in this order

Each phase is independently demoable. Don't merge phase N+1 until phase
N's acceptance tests pass.

### Phase 0 — Project bootstrap (½ day of work)
Goal: an empty add-on loads in Local and shows "Hello from CloudSync".
- Run `npx create-local-addon cloudsync-addon`.
- Strip generator boilerplate to just sidebar item + placeholder screen.
- Configure TS strict, oxlint, oxfmt, vitest, vite.
- Add `scripts/link-to-local.mjs` that symlinks `lib/` into Local's
  add-ons dir cross-platform.
- Wire GitHub Actions: lint + typecheck + test.
- **Acceptance:** open Local, enable add-on, see a sidebar entry,
  click it, see a blank screen titled "CloudSync".

### Phase 1 — Cloudways API client (1–2 days)
Goal: can authenticate and list servers/apps from a CLI test script.
- `ApiClient.ts` with OAuth + token rotation + zod-validated responses.
- `GET /server`, `GET /app/creds/...`.
- Operation poller util (`waitForOperation(id, { timeout, interval })`).
- Unit tests against fixtures (mocked `undici`).
- **Acceptance:** `bun test` green; manual `node scripts/smoke.mjs`
  using a real API key lists real servers.

### Phase 2 — Credential storage + Connect UI (1 day)
Goal: user can connect and disconnect an account from the sidebar.
- `CredentialStore` using `safeStorage`.
- `ConnectModal` with email + API key fields, "Where do I find this?"
  link, full-scope warning banner.
- IPC: `cs:connect`, `cs:disconnect`, `cs:getConnection`.
- Persistent connection badge in sidebar ("Connected as `<email>`").
- **Acceptance:** quit Local, reopen, badge still shows connected;
  `rm` the keychain entry manually → badge reflects disconnected.

### Phase 3 — Servers + Apps browser (1 day)
Goal: user sees their Cloudways fleet inside Local.
- `ServersList` grouped by cloud (DO, Vultr, AWS, Linode).
- `AppDetail` view showing app label, primary URL, PHP version, SFTP
  host, DB name. Hide secrets behind "Reveal" click.
- Copy-to-clipboard buttons on SFTP host/user, DB host/user/name.
- **Acceptance:** data matches the Cloudways web UI for the same
  account.

### Phase 4 — SFTP + SSH clients + WP-CLI runner (2 days)
Goal: can open a session, run `wp option get home`, download one file.
- `SftpClient` (download, upload, mirror with progress, glob).
- `SshClient` (`.exec(command)` returning `{ code, stdout, stderr }`).
- `wpCli(remoteApp, args)` helper that builds `wp ... --path=<webroot>`.
- Connection pooling so we reuse one SSH session per job.
- **Acceptance:** integration test against a disposable Cloudways
  sandbox app successfully pulls and parses `wp option get home`.

### Phase 5 — Pull (full, non-selective) (3 days)
Goal: click "Pull", get a working Local site for a real Cloudways WP app.
- `PullOrchestrator` with all 17 steps.
- `SiteImporter` using `cradle.siteData.addSite` + start + import.
- Progress streaming to a `ProgressDialog`.
- Manifest writing.
- **Acceptance:** pull a real WordPress site from Cloudways; browsing
  the Local site shows the same homepage (search-replace verified).

### Phase 6 — Selective sync resolver + Pull filters (1 day)
Goal: checkboxes in the Pull modal actually work.
- `SelectivePanel` UI.
- `Selective.ts` plan builder.
- Wire include/exclude into `SftpClient.mirror`.
- **Acceptance:** pull with only "uploads" checked — site boots with
  default plugins/themes but real media.

### Phase 7 — Push (Mode A) with safety rails (3 days)
Goal: push local changes to an existing Cloudways app; undo works.
- Remote backup + local snapshot steps.
- `PushOrchestrator`.
- Post-push Varnish/CDN purge.
- `UndoLedger` + `cs:undoPush` handler that calls `restore_app`.
- **Acceptance:** make a visible change locally (add a post), push,
  verify on prod. Undo push. Verify prod no longer shows the post.

### Phase 8 — Push Mode B (new app) (2 days)
Goal: provision a new Cloudways app from a Local site.
- `POST /app` + operation wait.
- Rollback dialog on failure.
- **Acceptance:** create a blank Local site, push to a new Cloudways
  app, visit the assigned URL and see the site.

### Phase 9 — Per-site menu integration (½ day)
Goal: actions are discoverable from the site's "More" menu inside Local.
- `siteInfoMoreMenu` filter.
- "Push to Cloudways…" / "Pull latest from Cloudways…" / "Open on
  Cloudways ↗".
- **Acceptance:** actions show only when site has a mapping (or
  always, with an "unlinked → open Connect modal" fallback).

### Phase 10 — Polish + distribution (2 days)
- Error messages humanized per `errors.ts` mapping.
- Icon + add-on description.
- README with screenshots.
- `scripts/build-addon-zip.mjs` for Add-on Library submission.
- CHANGELOG entry for 1.0.0.
- **Acceptance:** installable from zip on a fresh Local install on all
  three OSes.

### Phase 11 — v1.0 release
- Tag `v1.0.0`.
- GitHub Release with zipped add-on.
- Submit to Local Add-on Library.

---

## 9. Error model

Every user-facing error surfaces with three fields:

- **Title** (short) — "Couldn't reach Cloudways"
- **Body** (one sentence) — "The API returned 502 after 3 retries. Try
  again in a minute, or check <https://status.cloudways.com>."
- **Action** — retry button + "Copy error details" for support.

Error codes (mapped from internal tagged errors):

| Code | Cause | Retriable? |
|---|---|---|
| `AUTH_INVALID` | Bad API key / email | No — prompt re-enter |
| `AUTH_EXPIRED` | Token refresh failed | Yes — auto once |
| `RATE_LIMITED` | 429 | Yes — backoff |
| `OPERATION_FAILED` | Cloudways op returned error | No — show Cloudways detail |
| `SFTP_CONNECT_FAILED` | TCP / auth | Yes once |
| `SFTP_TRANSFER_FAILED` | Partial transfer | Yes — resumable where possible |
| `SSH_EXEC_NONZERO` | Remote command exit code > 0 | No — show stderr |
| `WPCLI_NOT_FOUND` | `wp` missing on server | No — log & link to Cloudways docs |
| `LOCAL_SITE_START_FAILED` | Local couldn't boot site | No — user action needed |
| `DB_IMPORT_FAILED` | SQL error during import | No — surface SQL error |
| `SEARCH_REPLACE_FAILED` | wp-cli non-zero | No |
| `DISK_FULL` | Local or remote | No |
| `MULTISITE_UNSUPPORTED` | v1 limitation | No — feature-flag in v2 |

---

## 10. Security checklist

- [ ] API key stored only via `safeStorage.encryptString` — never in
      plain JSON.
- [ ] Access token in memory only; cleared on app quit and on 401.
- [ ] All API requests over HTTPS (undici enforces).
- [ ] SFTP / SSH: verify host key on first connect and pin it
      (Trust-On-First-Use); store pins alongside credentials.
- [ ] No remote command concatenates user-supplied strings without
      shell-escaping; prefer argument arrays to `ssh2.exec`.
- [ ] Destructive actions (push to prod, undo, delete new Mode-B app
      on rollback) require typed confirmation.
- [ ] Full-scope API key warning shown prominently on Connect.
- [ ] `wp-config.php` never touched, never read, never logged.
- [ ] Log files scrub API key, passwords, and DB credentials.
- [ ] Backup retention: local snapshots pruned after 30 days (config-
      urable); never auto-delete under 7 days.
- [ ] Add `.gitignore` covering any `.env`, `*.log`, keys.

---

## 11. Observability

- Log file at `<localUserData>/Logs/cloudsync.log` (JSON lines via pino).
- Redact known secret fields with a pino redactor.
- "Export diagnostics" button in settings: zips last-500-lines log +
  addon version + OS + Local version + connection status (no secrets)
  for support tickets.
- Opt-in anonymous telemetry (**disabled by default**): counts of
  pull/push/undo events, duration buckets, failure codes. Nothing
  identifying. Pointed at our own endpoint when/if we build one; not
  a launch blocker.

---

## 12. Open questions to answer before starting

1. **Repo location & owner:** which GitHub org hosts it? Which
   directory on disk? Suggestion: `~/Developer/personal-projects/cloudsync-addon/`.
2. **License:** MIT default unless the product will be commercial.
3. **Branding:** logo/icon — do we have one, or do we need to design?
4. **Testing Cloudways sandbox:** which account do we use for
   integration tests? Needs a dedicated throwaway server.
5. **Minimum Local version supported:** pin to whatever's current as
   "latest stable" at project start; document.
6. **Release channel:** private until v1.0, then Local Add-on Library?
   Or open from day 1 on GitHub?

---

## 13. Manual testing plan

All manual tests assume:
- A Cloudways account with at least one WordPress app on a DO 1 GB
  server.
- Local WP installed, **version pinned at start of project** (capture
  in `test/fixtures/local-version.txt` after first successful run).
- Fresh state before each test (disconnect, no mappings, no snapshots).
- Timer ready for the "under 5 minutes" target tests.

### 13.1 Smoke — add-on loads
1. Build: `bun run build`.
2. Link: `bun run link`.
3. Restart Local. Open Settings → Add-ons.
4. **Expect:** `CloudSync` appears, enabled.
5. **Expect:** sidebar shows "CloudSync" entry.

### 13.2 Connect / disconnect
1. Click sidebar → "Connect account".
2. Enter a **wrong** API key + real email. **Expect:** clear error
   "Couldn't authenticate with Cloudways". No crash.
3. Enter a **right** email + API key. **Expect:** connected banner with
   email shown.
4. Quit Local. Reopen. **Expect:** still connected (keychain persisted).
5. Click "Disconnect". **Expect:** back to "Not connected" state.
6. Delete the add-on's entry from system keychain manually. Restart
   Local. **Expect:** add-on reports disconnected, no crash.

### 13.3 Browse fleet
1. Connect. Wait for servers list.
2. **Expect:** every server you see in Cloudways web UI is listed,
   grouped by provider.
3. Click a server. **Expect:** apps list with WordPress apps marked.
4. Click an app. **Expect:** details match Cloudways web UI: primary
   URL, PHP version, SFTP host.
5. Click "Reveal DB password". **Expect:** shown; "Copy" button works.

### 13.4 Full pull — small site
1. Target app: a WordPress site < 100 MB.
2. Right-click app → "Pull to Local…".
3. Leave all checkboxes on defaults. Destination name: `cs-test-1`.
4. Click "Start pull".
5. **Expect:** progress dialog shows each of the 17 steps turning green.
6. **Expect:** within 2 minutes, "Open site" button appears.
7. Click "Open site". Browser opens `https://cs-test-1.local`.
8. **Expect:** homepage loads identical to prod (same post title,
   hero image, menu).
9. Log into `/wp-admin` with the same admin credentials as prod.
   **Expect:** works.

### 13.5 Full pull — medium site (500 MB)
Same as 13.4 with a larger app. **Expect:** finishes under 5 minutes
on a 100 Mbps line.

### 13.6 Selective pull — uploads only
1. Right-click app → "Pull to Local…".
2. Uncheck everything except "Uploads".
3. Set destination name: `cs-test-uploads`.
4. Run.
5. **Expect:** new Local site boots with default WP installation
   (Hello World post), but `wp-content/uploads/` contains prod media.

### 13.7 Selective pull — DB only
1. Pick an existing mapped Local site (from 13.4). Modify a post locally.
2. Right-click → "Pull latest from Cloudways…" → DB only.
3. Run.
4. **Expect:** the local post edit is overwritten by prod state.
5. **Expect:** `wp-content/` untouched.

### 13.8 Push — Mode A happy path
1. Use the site from 13.4.
2. Create a new post locally: title "CloudSync push test".
3. Right-click → "Push to Cloudways…".
4. All defaults. Typed confirmation "PUSH" required.
5. **Expect:** backup step runs first (visible in progress UI).
6. **Expect:** finishes in under 3 minutes for the small site.
7. Visit prod URL in a browser. **Expect:** new post visible.

### 13.9 Undo push
1. From 13.8's success dialog, click "Undo push".
2. Typed confirmation "RESTORE".
3. **Expect:** progress dialog, then success within 3 minutes.
4. Refresh prod. **Expect:** the "CloudSync push test" post is gone.
5. Local site: still has the post. (Undo only touches remote.)

### 13.10 Push — Mode B (new app)
1. Create a blank Local site manually: `fresh-wp-1.local`.
2. Sidebar → "Push to Cloudways…" from the *site's* menu.
3. Pick "Create new app" mode. Choose target server. Label:
   `cs-new-1`.
4. **Expect:** new app appears in Cloudways dashboard.
5. **Expect:** push proceeds and finishes.
6. Visit the assigned IP / `.cloudwaysapps.com` URL. **Expect:** the
   site content is there.
7. Visit sidebar → app list. **Expect:** `cs-new-1` now listed.

### 13.11 Push — Mode B failure rollback
1. Deliberately break push mid-flight (kill Wi-Fi after step 3 of 11).
2. **Expect:** failure dialog lists exactly which step failed.
3. **Expect:** offers "Delete the half-provisioned app on Cloudways?"
4. Click Yes. **Expect:** the `cs-new-*` app is gone from Cloudways
   dashboard.

### 13.12 Selective push — single plugin
1. Existing mapped site.
2. Modify one plugin locally: e.g. edit `hello.php` to change
   a string.
3. Right-click → "Push to Cloudways…" → "Specific plugin" → `hello`.
4. **Expect:** only the `hello/` directory transfers; DB untouched,
   other plugins untouched.
5. Verify the change on prod via SSH: `cat hello.php | head`.

### 13.13 Selective push — DB only
1. Modify a WP option locally (`wp option update blogname "Changed"`).
2. Push → DB only.
3. Visit prod. **Expect:** site title changed.
4. Verify `wp-content/` on prod unchanged (check a file timestamp).

### 13.14 Error handling — wrong API key mid-session
1. Connect successfully.
2. On Cloudways, regenerate the API key.
3. In CloudSync, trigger any action (e.g. refresh apps).
4. **Expect:** clear error message, re-auth prompt. No hang.

### 13.15 Error handling — network drop during pull
1. Start a pull of a 500 MB site.
2. At ~50% SFTP progress, disconnect network.
3. **Expect:** error dialog within 30 seconds with retry button.
4. Reconnect network, click retry.
5. **Expect:** job resumes or restarts cleanly; no partial site left
   running.

### 13.16 Error handling — disk full
1. Fill local disk to < 500 MB free.
2. Try to pull a 1 GB site.
3. **Expect:** pre-flight check blocks with clear message; no
   partial files written.

### 13.17 Concurrent pulls
1. Start a pull (large site).
2. While running, try to start another pull.
3. **Expect:** second attempt blocked with "A sync is already in
   progress" banner.

### 13.18 Multisite guard
1. Target a WP Multisite app.
2. Attempt pull.
3. **Expect:** pre-flight blocks with "Multisite not supported in v1";
   link to docs.

### 13.19 wp-config / .htaccess guard
1. Use an SFTP client to verify after push: `wp-config.php`
   modification time on prod is unchanged from before push. Same for
   `.htaccess`.
2. **Expect:** unchanged.

### 13.20 Persistence across restarts
1. Connect, pull a site, push a change, complete an undo.
2. Quit Local entirely.
3. Reopen.
4. **Expect:** connection intact, mapping intact, undo history visible
   in the site's sidebar panel.

### 13.21 Keychain revocation
1. On macOS: Keychain Access → delete the CloudSync entry.
2. Reopen Local.
3. **Expect:** add-on shows disconnected; stored mappings remain but
   show "unauthenticated" badge until user reconnects.

### 13.22 Upgrade path
1. Install v0.9.0 of CloudSync (pre-release build).
2. Connect, create a mapping, run a pull.
3. Upgrade to v1.0.0 (replace add-on folder).
4. Reopen Local.
5. **Expect:** mapping + connection intact; no data migration
   prompts required.

### 13.23 OS matrix
Run tests 13.1, 13.4, 13.8 on:
- macOS 14+ (Intel and Apple Silicon)
- Windows 11
- Ubuntu 22.04

---

## 14. Pre-session quick-start (read this first in the new session)

When you open a new Claude Code session to build CloudSync:

### 14.1 One-line starter prompt
> "Read
> `/Users/nafiulislam/Developer/personal-projects/buildpress-app/[plan]/cloudsync-addon-implementation-plan.md`
> and its two companion docs
> (`cloudways-api-capabilities-research.md`,
> `local-wp-addon-cloudways-sync-research.md`) in the same folder,
> then start **Phase 0** of the plan in a **new repository** at
> `/Users/nafiulislam/Developer/personal-projects/cloudsync-addon/`.
> Confirm the directory doesn't already exist before creating."

### 14.2 Before the new session, I (the human) should:
- [ ] Decide final name (`CloudSync` or alternative).
- [ ] Decide license (MIT or other).
- [ ] Create a Cloudways throwaway test account + API key.
- [ ] Provision a test DO 1 GB server with one WordPress app on it.
- [ ] Pick a Local WP version and note it down.
- [ ] Have `bun` + Node 20 available.
- [ ] Confirm `~/Developer/personal-projects/cloudsync-addon/` does
      not exist.

### 14.3 Guardrails for the new session
- Don't touch the BuildPress repo.
- Don't copy code from BuildPress into CloudSync unless we've
  explicitly factored it into a shared npm package — keep concerns
  separate.
- Stop after each phase for a demo before moving on.
- Never commit API keys, server IPs, or passwords. Use `.env.local`
  for test credentials and gitignore it.
- When blocked on a real Cloudways or Local quirk: write the question
  down in `NOTES.md` in the CloudSync repo and ask before workarounds.

### 14.4 First five commits (suggested)
1. `chore: scaffold add-on via create-local-addon` (Phase 0 start)
2. `chore: configure tsconfig, oxlint, vitest` (Phase 0)
3. `feat: sidebar "CloudSync" entry with placeholder screen` (Phase 0 end)
4. `feat(cloudways): OAuth + typed API client + operation poller` (Phase 1)
5. `feat: connect/disconnect UI + safeStorage credential persistence` (Phase 2)

---

## 15. Appendix — command snippets you'll want ready

### Scaffold
```bash
cd ~/Developer/personal-projects
npx create-local-addon cloudsync-addon
cd cloudsync-addon
```

### Link into Local (macOS path shown)
```bash
ln -s "$(pwd)/lib" "$HOME/Library/Application Support/Local/addons/cloudsync"
```

### Cloudways OAuth sanity check
```bash
curl --request POST \
  --url "https://api.cloudways.com/api/v2/oauth/access_token" \
  --data "email=$CW_EMAIL&api_key=$CW_API_KEY"
```

### Quick WP-CLI over SSH sanity check
```bash
ssh -i ~/.ssh/cloudways_key master_user@<server-ip> \
  "wp --path=applications/<app>/public_html option get home"
```

### Local add-on rebuild + reload
```bash
bun run build
# then in Local: Cmd+R (or Ctrl+R) in the dev tools of the add-on
```
