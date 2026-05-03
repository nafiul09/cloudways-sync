# Changelog

All notable changes to Cloudways Sync will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added — SFTP-only link mode

- Link any Local site to a Cloudways app using just SSH/SFTP
  credentials, without a Cloudways API key. Targets invited team
  members who have SFTP access but no API access.
- New "Link via SFTP…" inline form on the Site Tools panel: probes
  the connection, auto-detects the WordPress web root, picks the
  correct sys_user when multiple apps share a master user, and
  surfaces wp-cli + PHP version + detected site URL before saving.
- `SftpCredentialStore` persists the SFTP password encrypted via
  Electron `safeStorage`, keyed by Local site id (so unlinking
  cleanly removes credentials).
- `AppLink` adapter abstracts API vs SFTP differences for the
  push/pull orchestrators — API-only conveniences (Cloudways backup,
  `restoreApp`, Varnish purge) live behind optional methods that the
  SFTP path silently skips.
- Push from SFTP-linked sites: same flow as API-mode push, but the
  pre-push backup is a `tar -czf` of `wp-content` plus a
  `wp db export | gzip` dropped into
  `<appRoot>/private_html/.cwsync-snapshots/`. Snapshots under 500MB
  are mirrored to `userDataDir` as a safety net.
- Undo for SFTP-linked pushes: re-uploads mirrored snapshot files if
  the remote copies were cleaned up, captures a "pre-undo" snapshot
  for re-do, then untars `wp-content` + re-imports the SQL dump via
  wp-cli.
- Pull for SFTP-linked sites: skips the API-only pre-pull backup
  (pulls are read-only anyway) and reuses the existing
  tar-on-server + single-archive-download flow over SFTP.
- Coachmarks for `SSH_AUTH_FAILED`, `SSH_NETWORK`, `SSH_TIMEOUT`,
  `SSH_CLOSED`, and `WP_NOT_FOUND` probe failures, walking the user
  to the right Cloudways panel.

## 0.1.1-beta — 2026-05-03

Second release. Major UI overhaul, push domain-rewrite bugfix, wizard
modal redesign, and fleet browser improvements for a cleaner, more
polished experience.

### Fixed

- **Push domain rewrite** — `wp search-replace` now correctly rewrites
  the primary URL after push. Previously the rewrite could silently
  skip tables or fail on non-standard DB prefixes.

### Changed

#### Sync wizard modal
- Full wizard redesign with a **phase stepper** at the top (numbered
  dots with connectors showing progress through Confirm → Configure →
  Running → Review/Done).
- **Side-by-side action buttons** (`[Cancel] [Continue]`,
  `[Back] [Start Push/Pull]`) replace the old stacked layout.
- **Amber safety warning** with left-accent bar for both push and
  pull confirm phases (previously inconsistent styling).
- Post-push Review phase: **numbered checklist** (Purge cache → Verify
  site → Confirm or Undo) replaces the old plain-text instructions.
- **Escape blocked** during post-push Review — users must explicitly
  Confirm or Undo; prevents orphaned server backups.
- Modal width increased to 560px with refined padding and radius.

#### Site Tools panel (per-site push/pull)
- **Pull-first, push-second** button order everywhere (panel + footer).
- Custom directional icons (tray + arrow) for Pull/Push buttons,
  replacing the old generic cloud icons.
- **Footer button injection** — pull/push buttons injected alongside
  Local's native footer buttons using MutationObserver, with
  `cursor: pointer` forced on all descendants.
- Extracted `SelectivePanel` into a shared component reused by both
  the site panel and the wizard modal.

#### Fleet browser (Cloudways API dashboard)
- **WordPress-only filtering** — only WordPress apps are shown in the
  server/app browser (non-WP apps are filtered out).
- Renamed pull action to **"Pull to Local as new site"** for clarity.
- **"Test WP-CLI over SSH"** button moved to the top action bar with
  a dismissable result banner (auto-clears on app switch, close
  button).
- Fleet pull now opens the **full wizard modal** (Confirm → Configure
  → Pulling → Done) with the same stepper and include-checkboxes
  experience as single-site pulls.
- **SSH/SFTP gate**: when an app has no SSH credentials, the action
  bar (Pull + Test) and include panel are hidden; only the "Create
  SSH/SFTP + shell access" notice is shown.
- Removed the Database section from app details (incorrect/unnecessary
  data).

#### Global dashboard header
- Replaced the 80px-tall connected-state banner with a compact
  **connection pill** in the page header: green dot + masked email +
  hairline divider + Disconnect link — using the sidebar background
  color (#262727) for a clean, integrated look.
- Title + caption always shown in Local's PageTitleBar style.

#### UI polish
- `cursor: pointer` fixed across all interactive elements (Button
  component overlay span, footer injected buttons).
- Cleaner visual hierarchy: removed excessive dividers and borders
  flagged as "AI-overdone".

### Added

- `IPC: SMOKE_APP` endpoint for WP-CLI-over-SSH connection testing
  from the fleet browser.
- `IPC: CREATE_APP_CREDENTIAL` endpoint for provisioning SSH/SFTP
  credentials on apps that lack them.

## 0.1.0 — 2026-04-23 (alpha)

First public alpha release. Ships the full Cloudways ↔ Local sync
loop end-to-end: connect to Cloudways, browse servers/apps, pull a
remote WordPress site into Local, push local changes back, and undo
a push when something goes wrong.

### Added

#### Cloudways API + credentials
- Cloudways v2 API client with OAuth token cache, 401→re-auth replay,
  429 Retry-After handling, and 5xx/network retry with jittered
  exponential backoff.
- Operation poller (`waitForOperation`) for long-running Cloudways
  jobs (backups, app create/delete).
- `CredentialStore` persists the API key encrypted via Electron
  `safeStorage`; refuses to write when the OS keychain is unavailable
  rather than silently falling back to plaintext.
- `ConnectionService` owns the single `ApiClient` instance, hydrates
  saved creds on startup, and verifies creds via OAuth before
  persisting on connect.
- Per-app SSH/SFTP credential creation with auto-retry + smoke test.

#### Sync — pull
- Pull any Cloudways WordPress app into a new or existing Local site.
- Archive-based transfer: tar on server, single SFTP download, local
  extract — avoids the slow per-file SFTP mirror path.
- Pre-pull Cloudways app backup with retry (handles "operation in
  progress" 422s by waiting + retrying).
- Remote DB export + gzip, download, Local import, and `wp
  search-replace` URL rewrite.
- Selective pull: per-subdir checkboxes (database, uploads, plugins,
  themes, mu-plugins, languages) — only the selected subdirs are
  replaced on Local; unselected subdirs are left untouched.
- Breeze caching plugin handling: excluded from the archive and
  deactivated on Local after import (Breeze requires Cloudways
  server-side configuration and fatals in Local).
- Live progress UI with step labels, bytes transferred / total, and
  percentage.
- Manifest (`cloudsync-export.json`) written into every pulled site.

#### Sync — push
- Push Mode A: push a Local site into an existing linked Cloudways
  app.
- Push Mode B infrastructure: create a new Cloudways app from a Local
  site.
- Pre-push remote backup with the same retry strategy as pull.
- Selective push: only the selected wp-content subdirs are replaced
  on the remote; unselected subdirs on the remote stay untouched,
  and deletions inside selected subdirs propagate correctly.
- Optional re-activation of Breeze on the remote after push (UI
  notice + checkbox when Breeze is detected).
- Undo push: restore the remote site to the pre-push backup with one
  click.

#### UI
- `Cloudways Sync` tab under Local's per-site Tools view.
- Full-page Cloudways Sync dashboard mounted in Local's overlay portal
  from a sidebar nav-rail icon (tints match Local's own icons).
- Site-list icon injection to flag sites linked to a Cloudways app.
- Per-site action menu ("Push to Cloudways", "Pull from Cloudways",
  "Open on Cloudways").
- Global sync modal (portal) that blocks UI during a sync, shows
  step + progress + bytes, and surfaces success / failure with a
  Close button.
- `MaskedEmail` component: masks the connected email
  (`hos***@***iko.com`) with an eye-icon toggle for screen-share /
  recording privacy; applied to every "Connected as ..." banner.
- Selective-sync panel with grouped "wp-content (all)" toggle and
  per-subdir checkboxes.
- Humanized error messages for every tagged error code.

#### Infrastructure
- Monorepo scaffold: TypeScript, Vite for renderer, `tsc` for main,
  oxlint, vitest.
- Cross-platform link/unlink scripts for Local's add-ons directory
  (`npm run link` / `npm run unlink`).
- GitHub Actions CI across Ubuntu + macOS + Windows, Node 20 + 22
  (lint, typecheck, test, build).
- `npm run smoke:cloudways` hits the real Cloudways API via
  `.env.local` for a live servers/apps listing sanity check.

### Known limitations
- Push Mode B (create new Cloudways app from Local) ships the
  infrastructure but is not yet surfaced in the UI.
- Multisite sites are blocked at plan time (no multisite support in
  this alpha).
- No automated background scheduling — every sync is user-initiated.
- Not yet submitted to the Local Add-on Library; install is
  developer-only (clone + `npm install` + `npm run link`) for now.
