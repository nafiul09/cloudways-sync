# Changelog

All notable changes to CloudwaysSync will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-04-23

### Added
- Cloudways API client with OAuth, retry, and rate-limiting
- Secure credential storage via Electron safeStorage
- Server and app browser with credential display
- SSH and SFTP clients with timeout and stall detection
- Pull: clone any Cloudways WordPress app to a new Local site
- Selective sync: checkboxes for database, uploads, plugins, themes, mu-plugins, languages
- Archive-based transfer (tar on server, single download, local extract)
- Push Mode A: push Local site changes to an existing Cloudways app
- Push Mode B infrastructure: create new Cloudways app from Local site
- Undo push: restore remote site to pre-push backup
- Per-site menu integration ("Push to Cloudways", "Pull from Cloudways")
- Live progress UI with step labels and percentage display
- Safety backups before every push operation
- Humanized error messages for all error codes (errorMessages.ts)
- Build script for Add-on Library zip distribution (scripts/build-addon-zip.mjs)

## [Unreleased]

### Added
- Phase 0 scaffold: TypeScript + Vite + oxlint + vitest toolchain.
- Placeholder per-site "CloudwaysSync" tab under Local's Tools view
  (via `siteInfoToolsItem` hook — the `sidebar::items` hook from the
  plan's research doc does not exist in Local v10).
- Cross-platform link/unlink scripts for Local's add-ons directory.
- GitHub Actions CI (Ubuntu + macOS + Windows; Node 20 + 22).
- Phase 1 Cloudways API client:
  - Tagged `CloudwaysError` with 9 error codes + factory helpers.
  - zod schemas for OAuth, servers/apps, app credentials, and
    operations (with `z.coerce.number()` for Cloudways' stringly-typed
    ids).
  - `retry()` utility with exponential backoff + jittered delays and
    a caller-provided `shouldRetry` predicate.
  - `ApiClient` with in-memory OAuth token cache (~55min TTL with
    skew), 401→re-auth-once replay, 429 Retry-After honouring,
    5xx/network retry with backoff, and an operation poller
    (`waitForOperation`).
  - 16 unit tests using a mocked `undici.request` cover OAuth reuse,
    401 replay, 5xx retries, 429 Retry-After, 4xx non-retry, schema
    coercion/validation, operation polling success/failure/timeout,
    and network errors.
  - `scripts/smoke-cloudways.mjs` (via `npm run smoke:cloudways`)
    hits the real Cloudways API using `.env.local` to verify live
    servers + apps listing.
- Phase 2 credentials + Connect flow:
  - `CredentialStore` persists an encrypted API key via Electron
    `safeStorage` + plain JSON metadata under
    `<userData>/cloudwayssync/`. Refuses to write when the OS
    keychain is unavailable rather than silently falling back to
    plaintext.
  - `ConnectionService` owns the single `ApiClient` instance, hydrates
    saved creds on startup, and verifies creds via OAuth before
    persisting on connect.
  - IPC handlers (`cs:connect`, `cs:disconnect`, `cs:getConnection`)
    registered through Local's `addIpcAsyncListener` bridge with a
    shared `IpcResult<T>` response shape + `serializeError()` for
    consistent renderer-side error handling.
  - Renderer `ipcClient` + `IpcCallError` thin wrapper around Local's
    `ipcAsync`.
  - `ConnectPanel` with email + API-key form, connect/disconnect, and
    error surface; mounted inside `SiteToolsPanel` under the per-site
    CloudwaysSync tab.
  - 19 new unit tests for credentials round-trip/encryption
    refusal/corrupt-meta handling, ConnectionService hydrate +
    connect + disconnect, and IPC handler input validation + error
    serialization.

### Changed
- Made Cloudways API v2 routing explicit with exported base URL and
  endpoint constants, plus a regression test that verifies every
  `ApiClient` request targets `/api/v2`.
- Updated the implementation plan's Cloudways endpoint table to match
  the v2 paths used by the client.
- Phase 5 pull foundation:
  - Added `cs:planPull`, `cs:runJob`, and `cs:cancelJob` IPC handlers.
  - Added `PullOrchestrator` for the full non-selective pull sequence:
    Cloudways app backup, SSH metadata, remote DB export/gzip, SFTP DB
    and `wp-content` download, manifest writing, and Local import.
  - Added `LocalSiteImporter` using Local's `addSite`,
    `siteProcessManager`, and `wpCli` services.
  - Added a WordPress app "Pull to Local" action in the fleet detail
    pane.
  - Added an orchestrator unit test covering the Phase 5 pull sequence
    with mocked Cloudways, SSH/SFTP, and Local importer boundaries.
