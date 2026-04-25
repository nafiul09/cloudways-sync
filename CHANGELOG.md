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
