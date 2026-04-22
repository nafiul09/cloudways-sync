# Local WP Add-on ↔ Cloudways Bidirectional Sync — Research

> Research date: 2026-04-22
> Scope: Can we build a **Local WP add-on** that (a) one-click pulls a
> Cloudways app down into a new Local site, and (b) one-click pushes a
> Local site up to a Cloudways server, with selective file/DB options
> and safety backups on both sides?
> Status: **Feasibility report + architecture plan.** Not tied to
> BuildPress; intended as a separate standalone Local add-on project.

## 1. Feasibility — short answer

**Yes, fully feasible.** Local WP exposes a well-documented Electron
add-on API with:

- Scaffolding (`npx create-local-addon`)
- Hook system (WordPress-style `addFilter` / `addAction` / `addContent`)
- Main-process service container that can **create**, **start/stop**,
  **import**, **export**, and **run WP-CLI** against any site
- Renderer-side React with access to Local's component library
- Unrestricted `fs` / `child_process` access (it's just an Electron app,
  not a sandboxed store app)

That's everything we need. No Local-side permission walls block the
Cloudways integration we want.

## 2. Local WP add-on architecture

### 2.1 What an add-on actually is

An add-on is a plain Node.js/TypeScript package dropped into Local's
add-ons directory:

| Platform | Path |
|---|---|
| macOS   | `~/Library/Application Support/Local/addons/` |
| Windows | `%APPDATA%\Local\addons\` (i.e. `C:\Users\<u>\AppData\Roaming\Local\addons\`) |
| Linux   | `~/.config/Local/addons/` |

Local scans that folder on startup and loads every package that has a
proper `package.json` with Local's expected entry fields.

### 2.2 Two entry points per add-on

- **`main.js`** — runs in Local's Electron **main process**. This is
  where you get full `fs`, `child_process`, and the `LocalMain` service
  container. All "do something to a site" logic lives here.
- **`renderer.jsx`** — runs in the **renderer process**. Handles UI,
  React components, hooks that inject menu items and routes.

The two talk to each other over Electron IPC. The boilerplate generator
wires this up for you.

### 2.3 Key packages

- `@getflywheel/local` — TypeScript type definitions for the entire
  add-on API surface (`LocalMain`, `LocalRenderer`, `LocalGraphQL`).
- `@getflywheel/local-components` — React component library
  (buttons, forms, tables, modals) so your add-on looks native.
- `create-local-addon` — the Yeoman-style generator:
  `npx create-local-addon` scaffolds the full structure, symlinks it
  into the add-ons directory, and enables it.

### 2.4 Hook system (WordPress-style)

Add-ons register behavior by calling `hooks.addFilter` / `addAction` /
`addContent`. Examples verified from existing add-ons and docs:

| Hook | Where | Purpose |
|---|---|---|
| `siteInfoMoreMenu` | renderer filter | Inject items into the per-site "More" menu |
| `routesSiteInfo` | renderer content | Add React-Router routes under `/site-info/:siteID/...` |
| `siteInfoToolsMenu` | renderer filter | Inject items into the Tools tab |
| `routesSiteInfoTools` | renderer content | Add routes under the Tools tab |
| `sidebar::items` | renderer filter | Add top-level sidebar entries |
| `siteAdded` | main action | Fires when a site is created — great for post-create provisioning |
| `siteStarted` / `siteStopped` | main action | Lifecycle events |
| `main/start` | main action | Fires once Local's main process is ready |

### 2.5 Service container (`LocalMain.getServiceContainer().cradle`)

This is the single most powerful thing in the API. Relevant services:

| Service | What it does |
|---|---|
| `siteData` | Read/write the site database (`.local/local-sites-v2.json`); `getSite(id)`, `addSite(site)`, `updateSite(id, patch)`, `getSites()` |
| `siteProcessManager` | `start(site)`, `stop(site)`, `restart(site)` |
| `wpCli` | `run(site, args)` → runs WP-CLI inside the site, returns stdout/stderr (Promise) |
| `localLogger` | Structured logging that lands in Local's log file |
| `localImage` / `lightningServices` | PHP/MySQL/NGINX version management per site |
| `ipcMain` | Register IPC handlers so the renderer can trigger main-process work |

The `siteData.addSite` call is the piece that lets us **programmatically
create a new Local site from a directory we just populated with files
and a database dump**.

### 2.6 Running WP-CLI from an add-on

Confirmed pattern for Local 5.x+:

```js
const site = LocalMain.getServiceContainer().cradle.siteData.getSite(siteId);
await LocalMain.getServiceContainer()
  .cradle.wpCli.run(site, ['db', 'import', '/tmp/dump.sql']);
```

This runs inside the site's container (Lightning Services or Docker,
depending on Local's runtime selection), using the site's PHP + MySQL.
No manual Docker plumbing needed for the happy path.

Fallback when we need something WP-CLI can't express: spawn a
`child_process` directly using `context.environment.dockerPath` or
Lightning Services binaries. The Image Optimizer add-on is the
canonical precedent.

### 2.7 File system access

Add-ons run in the main Electron process with the user's full
permissions. Reading/writing anywhere is just `fs.promises.*` —
including inside a site's folder at `site.paths.webRoot` and
`site.paths.mysql`, and into any SFTP download we've staged.

## 3. How Local WP imports and exports sites

### 3.1 Import format (native)

Local accepts a **standard ZIP archive**. Required contents:

```
my-site.zip
├── database.sql            (or any *.sql — a mysqldump of the site DB)
└── <files-folder>/
    └── wp-content/
        ├── plugins/
        ├── themes/
        └── uploads/
```

That's it. Local's importer:

1. Asks for site name + domain + folder location
2. Creates a blank site at the chosen path
3. Moves `wp-content/` into place
4. Runs `wp db import <the .sql>` inside the new site
5. Runs `wp search-replace` to swap the old domain for the new `.local`
   domain (handling serialized data correctly)

**Not supported natively:** ServMask's `.wpress`, Duplicator's
`.daf`, UpdraftPlus archives. These need intermediate conversion (or
their respective plugins on the source).

**Supported with hints:** the WP Migrate `.zip` format adds a
`wpmigrate-export.json` manifest at the root that Local reads to
auto-match PHP version, web server (NGINX/Apache), and MySQL/MariaDB.
We should adopt the same manifest convention for our own archives.

### 3.2 Programmatic import (what we need for "one-click pull")

Two paths, both verified by existing add-ons in the wild:

**Path A — invoke the built-in importer with a pre-built zip.** Less
work, consistent UX. Flow:

1. Write the zip to a tmp location.
2. Send an IPC event the renderer picks up — `LocalRenderer.sendIPCEvent`
   — that routes to the UI equivalent of "File → Import site" with the
   zip path pre-filled.

**Path B — bypass the UI and drive `siteData.addSite` directly.**
More control, skippable prompts. Flow:

1. Pick a destination path (e.g. `~/Local Sites/<name>`).
2. `fs.promises.mkdir`, drop `wp-content/` + `database.sql` into place,
   generate a site config (hostname, PHP version, web server, MySQL).
3. `cradle.siteData.addSite(siteConfig)` to register it.
4. `cradle.siteProcessManager.start(site)` to boot it.
5. `cradle.wpCli.run(site, ['db', 'import', 'database.sql'])`.
6. `cradle.wpCli.run(site, ['search-replace', oldUrl, newUrl, '--all-tables'])`.
7. `cradle.wpCli.run(site, ['cache', 'flush'])`.
8. Show a success toast using `@getflywheel/local-components`.

Path B is the right choice for this add-on because we want full
control over defaults (PHP version, HTTPS, site label) inferred from
the Cloudways app config.

### 3.3 Programmatic export

Local's built-in "Export" produces the same zip shape. The add-on
equivalent we'd reproduce ourselves for "push to Cloudways":

1. `cradle.siteProcessManager.start(site)` if not running.
2. `cradle.wpCli.run(site, ['db', 'export', '/tmp/xxx.sql', '--add-drop-table'])`.
3. Zip `site.paths.webRoot/wp-content/` + the `.sql`.
4. Add our own `buildpress-export.json` manifest with: source URL, PHP
   version, WP version, export timestamp, optional "includes" flags
   (db-only, uploads-only, plugins-only, etc.).

## 4. Cloudways side — re-used from our earlier research

See `cloudways-api-capabilities-research.md` in this directory. The
relevant pieces for this add-on:

- **Platform API OAuth** (email + API key → 1h bearer) for server/app
  discovery and orchestration.
- **SFTP** for raw file transfer (we already know how to do this in
  BuildPress; same code applies).
- **WP-CLI over SSH** for clean DB export / import and
  `wp search-replace`.
- **`backup_server`** before any push (safety net).
- **`restore_app`** point-in-time restore as "Undo push".
- **`sync_app`** between staging and prod (if user wants us to push to
  staging first, then promote).
- **`update_whitelisted_ips`** if the user wants direct MySQL access
  from the local machine (option B below).

## 5. End-to-end flows

### 5.1 One-click "Pull from Cloudways → new Local site"

```
┌─────────── Local WP add-on ──────────┐     ┌───── Cloudways ─────┐
│ 1. User: New site → "From Cloudways" │     │                     │
│ 2. OAuth exchange                    │────▶│ POST /oauth/...     │
│ 3. List servers + apps               │◀────│ GET  /server        │
│ 4. User picks app                    │     │                     │
│ 5. Trigger app backup (safety)       │────▶│ POST /backup (srv)  │
│    Wait for operation_id             │◀────│ GET  /operation/{id}│
│ 6. SSH: wp db export /tmp/dump.sql   │────▶│ SSH + WP-CLI        │
│ 7. SFTP pull wp-content/ + dump.sql  │◀────│ SFTP                │
│ 8. Build local zip + manifest        │     │                     │
│ 9. siteData.addSite() (Path B)       │     │                     │
│10. siteProcessManager.start()        │     │                     │
│11. wp db import /tmp/dump.sql        │     │                     │
│12. wp search-replace prod→local      │     │                     │
│13. wp cache flush                    │     │                     │
│14. Show "Open site" button           │     │                     │
└──────────────────────────────────────┘     └─────────────────────┘
```

Time budget: the expensive steps are (5) wait-for-backup, (7) SFTP
pull, (11) DB import. Everything else is sub-second. Stream progress
to the UI via IPC events (same pattern as BuildPress's SFTP sync).

### 5.2 One-click "Push local site → Cloudways"

Two modes — user picks in a modal before push:

**Mode A: Push to existing app.**
```
1. Pre-flight: snapshot check (wp-content size, DB size, PHP versions match)
2. Cloudways: backup_server (SAFETY) → wait
3. Local: wp db export → produce dump
4. SFTP push wp-content/ (selective — see §6)
5. SFTP push dump.sql to ~/applications/<app>/private_html/
6. SSH: wp db import dump.sql
7. SSH: wp search-replace local→prod --all-tables
8. SSH: wp cache flush
9. Optional: invalidate CloudwaysCDN (API call)
10. Show "Undo: restore point-in-time" button (restore_app endpoint)
```

**Mode B: Create a brand-new Cloudways app from this local site.**
```
1. User picks server (list via GET /server), provides app label
2. POST create app (application=wordpress)
3. Poll operation_id until app is ready
4. Fetch new app's SFTP + DB creds from access-details
5. Proceed as Mode A from step 3 onward, but target the new app
```

### 5.3 Selective sync modes

Exposed as checkboxes in the push/pull modal:

| Include | Push effect | Pull effect |
|---|---|---|
| DB | `wp db export/import` + search-replace | same, reverse |
| Uploads (`wp-content/uploads`) | SFTP-sync folder only | same, reverse |
| Plugins (all) | SFTP-sync `wp-content/plugins` | same, reverse |
| Themes (all) | SFTP-sync `wp-content/themes` | same, reverse |
| Specific plugin/theme | SFTP-sync single folder | same, reverse |
| `mu-plugins` | SFTP-sync folder | same, reverse |
| WP core files | usually skipped (Cloudways manages) | optional |
| `wp-config.php` | **never** (local + prod differ) | **never** |

Use the same rsync-over-SFTP strategy BuildPress already has, with
`--delete` gated behind a confirmation.

### 5.4 Safety rails (non-negotiable)

- Before any mutating push: **`backup_server`** on Cloudways and
  **`wp db export` to a tarball in `~/Local Sites/.buildpress-backups/`**
  locally.
- Expose "Undo last push" that uses `restore_app` (Cloudways) for the
  remote side.
- Expose "Restore from pre-push snapshot" for the local side.
- Require typed-confirmation on: pushing to prod, overwriting DB,
  `--delete` file sync.
- Never sync `wp-config.php`. Maintain a local-only `.env` / config
  shim mechanism.
- Pause Cloudways backups briefly during push? — not needed; their
  backups are consistent via filesystem snapshot.

## 6. Architecture for the add-on itself

### 6.1 Directory layout (from `create-local-addon` scaffold)

```
cloudways-sync-addon/
├── package.json              (name, version, main, renderer fields)
├── src/
│   ├── main.ts               (Local main-process entry)
│   ├── renderer.tsx          (Local renderer entry)
│   ├── ui/
│   │   ├── ConnectModal.tsx
│   │   ├── AppPicker.tsx
│   │   ├── PullModal.tsx
│   │   ├── PushModal.tsx
│   │   └── SelectiveSync.tsx
│   ├── cloudways/
│   │   ├── api.ts            (OAuth + REST client)
│   │   ├── sftp.ts           (ssh2-sftp-client wrapper)
│   │   ├── ssh.ts            (wp-cli over ssh2 exec)
│   │   └── types.ts
│   ├── local/
│   │   ├── importer.ts       (Path B: addSite + start + wp-cli import)
│   │   ├── exporter.ts       (wp db export + zip wp-content)
│   │   └── manifest.ts       (buildpress-export.json)
│   └── ipc.ts                (channel names shared between main/renderer)
├── lib/                      (compiled output — symlinked by Local)
└── tsconfig.json
```

### 6.2 Where UI attaches

- **Sidebar item** via `sidebar::items` → Cloudways dashboard (servers,
  apps, quick actions).
- **Per-site "More" menu** via `siteInfoMoreMenu` → "Push to
  Cloudways…", "Pull from Cloudways…", "Take snapshot".
- **New Site flow** — intercept via `sidebar::items` or a dedicated
  route; offer "Create from Cloudways" as an alternative to the
  built-in blank/Blueprint flow.

### 6.3 Credential storage

Local doesn't ship a keychain service, but we can use Electron's
`safeStorage` API (available in Electron 15+, which Local uses).
Store `{ email, apiKey }` encrypted at rest. Bearer token kept in
memory only, 1h TTL.

### 6.4 Distribution

- **Sideload-first:** zip the compiled `lib/` + `package.json`, user
  drops into the add-ons directory. Good for internal testing.
- **Add-on Library listing:** Local's marketplace at
  <https://localwp.com/add-ons/> accepts submissions; approval is
  manual but free.
- **Auto-update:** implement ourselves via GitHub Releases + a small
  main-process check; Local has no built-in add-on auto-update at
  time of writing.

## 7. Relationship to BuildPress

Per the user's note: **this is intentionally not tied to BuildPress.**
The add-on stands alone and ships as its own product. That said, there
are three potential integration points for the future:

1. **Shared Cloudways API client** — if both projects need an OAuth +
   REST + SFTP + SSH client, lift it to a shared package (could be
   published to npm as `@ourorg/cloudways-client`). Both BuildPress
   and the Local add-on consume it.
2. **Shared manifest format** — if BuildPress grows its own
   push/pull flow, reuse the `buildpress-export.json` manifest shape
   so archives are interchangeable.
3. **Delegated push/pull** — BuildPress could *call* the Local add-on
   via localhost IPC to trigger a sync while the user is editing in
   Local. This is a speculative future; start without it.

For now, the hard rule from the user holds: the Local add-on is its
own repo, own release cycle, own UX.

## 8. Risks and open questions

- **Local API stability.** Local's add-on API is not semver-versioned
  against a formal contract. A Local major update can (and has)
  broken add-ons in the past. Mitigation: lock to a known `@getflywheel/local`
  version range, test against Local nightly via GitHub Actions.
- **WP-CLI runtime differences.** The `cradle.wpCli.run` signature
  changed between Local 5 and 6; verify against the installed Local
  version at runtime and fall back to `child_process` + bundled
  `wp.phar`.
- **Large DB transfers.** Anything over ~500 MB should stream through
  `mysqldump | gzip` over SSH rather than writing to disk twice.
  Needs chunked progress in the UI.
- **Serialized data search-replace.** Always use `wp search-replace`,
  never raw SQL `UPDATE`. We learned this in the DB research doc.
- **Cloudways API key scope.** Full-scope only (see the auth research
  doc §2.2). Same warning UX as BuildPress: prominent banner,
  destructive-action confirmation.
- **Local Multisite import.** Supported in Local but the import path
  has known rough edges; we should detect multisite (`is_multisite()`
  via wp-cli) and warn the user before attempting.
- **Site path with spaces / non-ASCII.** Both Local and Cloudways
  handle these, but WP-CLI over SSH can trip on unquoted paths — wrap
  every path argument explicitly.
- **Concurrency.** A user could push while a Cloudways backup or
  scheduled cron is running. Check `get_operation_status` before
  starting; retry after a short wait if an operation is in flight.

## 9. Minimum viable scope (what to ship first)

1. Connect-Cloudways-account flow (email + API key → token).
2. Sidebar panel: list servers + apps, with "Pull to Local" button.
3. Full pull (DB + wp-content, search-replace, start site).
4. Per-site menu: "Push to Cloudways" with mode A (existing app) only.
5. Safety backup on both sides before any push.
6. Selective-sync checkboxes (DB, uploads, plugins, themes).
7. Progress streaming + error recovery.

Mode B (create new Cloudways app from Local), CDN purge, Redis/object
cache toggles, and WP Multisite support can wait for v2.

## 10. Sources

- [Build an add-on for Local — localwp.com](https://localwp.com/get-involved/build/)
- [Local Add-on Documentation Hub (build.localwp.com)](https://build.localwp.com/)
- [Local TypeScript API reference](https://getflywheel.github.io/local-addon-api/)
- [`getflywheel/create-local-addon` (generator)](https://github.com/getflywheel/create-local-addon)
- [`getflywheel/local-addon-boilerplate`](https://github.com/getflywheel/local-addon-boilerplate)
- [`getflywheel/local-components` (React UI)](https://github.com/getflywheel/local-components)
- [`getflywheel/local-docs-addon-api` (archived but linked)](https://github.com/getflywheel/local-docs-addon-api)
- [Creating a Custom Addon for Local — Delicious Brains](https://deliciousbrains.com/creating-custom-addon-local-flywheel/)
- [How to Create an Addon for Local — WebDevStudios](https://webdevstudios.com/2020/09/01/addon-for-local-by-flywheel/)
- [Access shell from addon (WP-CLI) — Local Community thread](https://community.localwp.com/t/access-shell-from-addon-wp-cli/17618)
- [Import/Export a WordPress Site — Local WP help](https://localwp.com/help-docs/getting-started/how-to-import-a-wordpress-site-into-local/)
- [Import a WordPress Site to Local — WP Migrate docs](https://deliciousbrains.com/wp-migrate-db-pro/doc/importing-wordpress-local-development-environment/)
- [WP-CLI handbook](https://wp-cli.org/)
- Companion research: `cloudways-api-capabilities-research.md` in this directory.
