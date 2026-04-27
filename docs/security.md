# Security

How CloudwaysSync protects your credentials, connections, and data.
This document covers credential storage, authentication flows,
transport security, and the IPC boundary between processes.

---

## Credential Storage

All secrets are encrypted at rest using **Electron's `safeStorage`
API**, which delegates to the operating system's native credential
store:

| OS | Backend |
|---|---|
| macOS | Keychain |
| Windows | DPAPI (Data Protection API) |
| Linux | libsecret (GNOME Keyring / KWallet) |

If the OS credential store is unavailable, the addon **refuses to
persist** any secret and throws an `EncryptionUnavailableError`. It
will never silently fall back to plaintext storage.

### What is stored and where

CloudwaysSync maintains three encrypted stores, all under the Local WP
`userData` directory (`<userData>/cloudwayssync/`):

| Store | File | Keyed by | Contents |
|---|---|---|---|
| **CredentialStore** | `credentials.bin` + `credentials.meta.json` | Single account | Cloudways API key (encrypted binary) |
| **AppPasswordStore** | `app-passwords.bin` | `serverId:appId` | Per-app SFTP passwords generated through the Cloudways API |
| **SftpCredentialStore** | `sftp-creds.bin` | `localSiteId` | User-provided SFTP passwords for SFTP-only linked sites |

**File permissions:** Every encrypted `.bin` file and the metadata JSON
are written with mode `0o600` (owner read/write only).

**Metadata:** `credentials.meta.json` stores the account email and
connection timestamp in plaintext. It contains no secrets.

### What is NOT stored on disk

- **OAuth bearer tokens** — held in memory only, never persisted.
- **SSH sessions / SFTP handles** — ephemeral, created per-operation
  and destroyed in `finally` blocks.

---

## Authentication Flows

### Cloudways API (API mode)

1. The user enters their **Cloudways account email** and **API key**
   (from Cloudways Settings > API) in the addon UI.
2. The addon sends these to the main process over Electron IPC.
3. The main process calls the Cloudways OAuth endpoint
   (`POST /oauth/access_token`) with the email and API key.
4. Cloudways returns a **bearer token** with approximately a 1-hour
   TTL.
5. The API key is encrypted via `safeStorage` and written to
   `credentials.bin` so the user stays logged in across app restarts.
6. The bearer token is cached **in memory only** — it is never written
   to disk.

**Token refresh:** The addon checks token expiry before every API call.
If the token is within 5 minutes of expiring, it automatically
re-authenticates. Concurrent requests share a single refresh promise to
avoid duplicate OAuth calls.

**401 handling:** If a request returns HTTP 401, the addon discards the
current token, re-authenticates once, and replays the request. A flag
prevents infinite retry loops.

**Rate limiting:** HTTP 429 responses are handled with exponential
backoff (500 ms base, up to 20 s cap, with 20% jitter). The
`Retry-After` header is honoured when present. Up to 4 attempts per
request.

### SFTP-Only Mode

1. The user enters **host, port, username, and password** in the Link
   via SFTP dialog.
2. The addon probes the remote server over SFTP to verify the
   credentials are valid.
3. On success, the password is encrypted via `safeStorage` and stored
   in `sftp-creds.bin`. The connection mapping (host, port, username,
   web root) is stored separately — **the mapping never contains the
   password**.
4. On each sync operation, the password is decrypted from the store
   just before opening the SSH/SFTP connection.

### App-Generated Passwords (API mode)

When linking via the Cloudways API, the addon may call
`createAppCredential()` to generate a dedicated SFTP user and password
for the app. This password is encrypted and stored in
`app-passwords.bin`, keyed by server and app ID.

---

## Transport Security

All file transfers (push and pull) happen over **SSH/SFTP** using the
`ssh2` library. Connections use the same encrypted channel regardless
of whether the link was created via the API or SFTP-only mode.

**Connection settings:**

| Setting | Value |
|---|---|
| Protocol | SSH 2.0 (via `ssh2` library) |
| Auth methods | Password or private key + passphrase |
| Keepalive | 10-second interval (prevents idle disconnects) |
| Handshake timeout | 20 seconds |
| Transfer method | `fastGet` / `fastPut` with 64-way concurrency |

**Stall detection:** SFTP transfers are monitored by an idle watchdog.
If no file activity is observed for 3 minutes, the connection is
force-closed and the operation fails with a clear error rather than
hanging indefinitely.

**Connection lifecycle:** SSH and SFTP connections are created per
operation (push, pull, undo, confirm) and always closed in a `finally`
block, even if the operation fails or is cancelled.

---

## IPC Security (Main ↔ Renderer)

CloudwaysSync runs inside Local WP's Electron environment. The renderer
process (UI) communicates with the main process (backend) through
Electron's IPC bridge.

### How credentials flow

```
  Renderer (UI form)
      │
      ▼  ipcRenderer.invoke(channel, payload)
  ─────────────── IPC boundary ───────────────
      │
      ▼  Main process handler
  Validate → Encrypt via safeStorage → Write to .bin file
```

- Credentials are sent as typed JSON payloads over IPC.
- The main process encrypts and persists them immediately on receipt.
- The renderer does not store passwords — it sends them once and
  discards them.

### Error sanitization

All errors returned to the renderer are serialized through a
`serializeError()` function that extracts only `code`, `message`,
`retriable`, and a structured `detail` object. Credentials never
appear in error messages or detail payloads.

### No credential logging

The addon does not log passwords, API keys, or tokens to the console
at any point. The only credential-adjacent log is a generic warning
when startup hydration fails:

```
[Cloudways Sync] credential hydration failed: <error object>
```

This logs the error (e.g. "keychain unavailable"), not the credential
itself.

---

## Credential Lifecycle

### On connect (API mode)

| Action | What happens |
|---|---|
| User submits email + API key | Validated against Cloudways OAuth |
| Validation succeeds | API key encrypted and persisted to `credentials.bin` |
| App restarts | `credentials.bin` decrypted and API client re-hydrated |

### On link (SFTP mode)

| Action | What happens |
|---|---|
| User submits SFTP credentials | Probe validates them against remote server |
| Probe succeeds | Password encrypted to `sftp-creds.bin`; mapping stored separately |
| App restarts | Password decrypted on demand when a sync operation starts |

### On disconnect

| Action | What happens |
|---|---|
| User clicks Disconnect | `credentials.bin` deleted, `app-passwords.bin` cleared |
| SFTP passwords | **Not cleared** — they are independent of the API account |
| Unlinking a site | SFTP password for that site is deleted from `sftp-creds.bin` |

### In memory

- OAuth tokens live for ~55 minutes and are automatically refreshed.
- Passwords are decrypted into memory only when needed (to open an SSH
  connection) and are not cached beyond the operation.
- Disconnecting or unlinking drops all in-memory references.

---

## Environment Variables

The `.env.local` file is used **only for development and testing** — it
feeds the `scripts/smoke-cloudways.mjs` smoke test. The addon **never
loads `.env` at runtime**; no `dotenv` or `process.env` usage exists in
the production source code.

`.env.local` is gitignored. Only `.env.example` (with placeholder
values) is committed to version control.

---

## Summary

| Concern | How it is handled |
|---|---|
| Secrets at rest | Encrypted via OS keychain (`safeStorage`), `0o600` file permissions |
| Secrets in transit (IPC) | Typed JSON payloads, encrypted on receipt, no logging |
| Secrets in transit (network) | SSH 2.0 encrypted channel for all transfers |
| Token management | In-memory only, ~55 min TTL, auto-refresh, no disk persistence |
| Unavailable keychain | Refuses to persist, throws clear error, app degrades gracefully |
| Credential cleanup | Disconnect wipes API key + app passwords; unlink wipes SFTP password |
| Error exposure | Serialized errors never contain credentials |
| Source control | `.env.*` gitignored, only `.env.example` committed |
