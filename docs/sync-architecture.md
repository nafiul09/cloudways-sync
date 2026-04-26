# Sync Architecture

How CloudwaysSync moves data between a Local WP site and a live
Cloudways server. Covers both connection modes (API and SFTP), both
operations (push and pull), and the cleanup / undo safety nets around
them.

---

## Connection Modes

CloudwaysSync supports two ways to link a Local site to a Cloudways
app:

| | API mode | SFTP mode |
|---|---|---|
| **Credentials** | Cloudways API key + app password | SSH host/port/user/password |
| **Remote backup** | Cloudways API (`createBackup`) | Local-tar snapshot on server |
| **Undo** | Via Cloudways restore (external) | File-based restore from snapshot |
| **Cache purge** | Varnish purge via API | Not available |
| **Pull backup** | Cloudways API backup before pull | Skipped (read-only pull) |

Both modes use the same SSH/SFTP transport for the actual file
transfer. The difference is in what happens *around* the transfer
(backups, cache purging, credential resolution).

### Adapter pattern

The orchestrators never touch `ApiClient` or credentials directly.
They receive an `AppLink` — a thin adapter that hides the mode:

```
AppLink (interface)
  ├── ApiAppLink   → resolves via Cloudways API, has backup/purge methods
  └── SftpAppLink  → resolves from stored SFTP creds, no API methods
```

Both return the same `{ auth, webRoot, remoteUrl }` shape from
`link.resolve()`. Optional methods (`triggerRemoteBackup`,
`purgeVarnish`) are simply `undefined` on `SftpAppLink`, and the
orchestrators skip them with optional chaining.

---

## Push Operation

Uploads the Local site's database and wp-content to the live server.

### Steps (in order)

| # | Step | What happens |
|---|------|-------------|
| 1 | **validate** | Resolve link, confirm remote app is WordPress, verify local webroot exists |
| 2 | **ssh** | Open SSH connection |
| 3 | **housekeeping** | Sweep orphaned temp files, prune old snapshots (remote + local) |
| 4 | **remote-backup** | API mode: trigger Cloudways backup (3 retries). SFTP mode: `captureLocalSnapshot()` — tar wp-content + mysqldump on server |
| 5 | **metadata** | Collect remote `home`/`siteurl`, WP version, Breeze status, multisite check |
| 6 | **local-export-db** | `wp db export` locally → gzip |
| 7 | **upload-db** | SFTP upload `.sql.gz` to `private_html/` |
| 8 | **upload-content** | Local `tar czf` of wp-content → SFTP upload → `rm -rf` selected subdirs on remote → `tar xzf` on remote |
| 9 | **remote-db-import** | `gzip -df` + `wp db import` on server |
| 10 | **search-replace** | `wp search-replace <localUrl> <remoteUrl> --all-tables --skip-columns=guid` |
| 11 | **cache-flush** | `wp cache flush` + `wp rewrite flush` + Varnish purge (API mode) |
| 12 | **breeze** | Re-activate Breeze plugin if previously deactivated |
| 13 | **cleanup** | Remove work-in-progress temp files (snapshot files kept for undo) |

Steps 6–10 are individually skippable via the "includes" checkboxes
(database, wp-content, and individual subdirectories).

### Where archiving happens

| Data | Compressed | Decompressed |
|------|-----------|-------------|
| Database | Locally (`gzip -f`) | On server (`gzip -df`) |
| wp-content | Locally (`tar czf`) | On server (`tar xzf`) |

---

## Pull Operation

Downloads the live server's database and wp-content into Local.

### Steps (in order)

| # | Step | What happens |
|---|------|-------------|
| 1 | **validate** | Resolve link, confirm remote app is WordPress |
| 2 | **backup** | API mode: trigger Cloudways backup. SFTP mode: skipped |
| 3 | **ssh** | Open SSH connection |
| 4 | **housekeeping** | Sweep orphaned temp files, prune old snapshots (remote + local) |
| 5 | **metadata** | Collect remote home/siteurl, WP version, multisite check |
| 6 | **db-export** | `wp db export` on server → `gzip -f` on server |
| 7 | **download-db** | SFTP download `.sql.gz` to local staging |
| 8 | **download-content** | `tar czf` on server → SFTP download `.tar.gz` → `tar xzf` locally |
| 9 | **manifest** | Write `manifest.json` with metadata |
| 10 | **local-site** | Import into Local (create/update site, import DB, search-replace URLs) |

### Where archiving happens

| Data | Compressed | Decompressed |
|------|-----------|-------------|
| Database | On server (`gzip -f`) | Local importer handles it |
| wp-content | On server (`tar czf`) | Locally (`tar xzf`) |

---

## Temporary Files

Every job creates temp files both locally and on the remote server.
All paths use a unique `job_<planId>` identifier.

### Local staging

```
<userDataDir>/cloudwayssync/jobs/job_<planId>/
  └── staging/
      ├── cws-job_<planId>.sql.gz              ← DB dump (gzipped)
      ├── cws-job_<planId>-wpcontent.tar.gz    ← wp-content archive
      ├── wp-content/                          ← (pull only) extracted content
      └── manifest.json                        ← (pull only) job metadata
```

Deleted in the orchestrator's `finally` block every time — success or
failure. `sweepStaleJobs()` catches anything left from a previous
crashed run.

### Remote work-in-progress

```
<appRoot>/private_html/
  ├── cws-job_<planId>.sql          ← raw DB dump
  ├── cws-job_<planId>.sql.gz       ← gzipped DB dump
  └── cws-job_<planId>-wpcontent.tar.gz   ← wp-content archive
```

Cleaned at the end of the job (push step 13 + `finally` block, pull
`finally` block). `sweepRemoteTempFiles()` at the start of every job
catches orphans older than 30 minutes.

### Snapshot files (SFTP-mode push only)

```
<appRoot>/private_html/.cwsync-snapshots/
  ├── snap-job_<planId>.tar.gz      ← wp-content state before push
  └── snap-job_<planId>.sql.gz      ← DB state before push
```

Kept for undo. Cleaned when the user clicks "Undo last push" or
"Confirm push". Pruned to the 3 most recent pairs by
`pruneRemoteSnapshots()` at each job start.

### Local snapshot mirrors (SFTP-mode push only)

```
<userDataDir>/cloudwayssync/snapshots/<localSiteId>/job_<planId>/
  ├── wp-content.tar.gz
  └── db.sql.gz
```

Downloaded from the server if the snapshot is under 500 MB, so undo
works even if the remote files are lost. Pruned to the 3 most recent
per site by `sweepLocalSnapshots()`.

---

## Undo (SFTP mode)

Only available for SFTP-mode pushes that captured a snapshot.

1. **Connect** — SSH to server.
2. **Verify snapshot** — Check remote `snap-*` files exist. If
   missing, re-upload from local mirror.
3. **Restore wp-content** — `rm -rf` current, `tar xzf` snapshot.
4. **Restore database** — `gunzip` + `wp db import` (skipped if DB
   snapshot was empty / wp-cli was unavailable at push time).
5. **Cleanup** — Delete snapshot files from server + local mirror.
   Remove `.cwsync-snapshots/` dir if empty.

### Confirm push (dismiss undo)

If the user is happy with the push result and doesn't need undo, they
click "Confirm push". This:

1. SSHs to the server and deletes the snapshot files.
2. Removes the local mirror.
3. Marks the undo record as dismissed so the button disappears.

Either path (undo or confirm) cleans up the snapshot files.

API-mode pushes don't use this undo system — Cloudways backups are
managed separately through the Cloudways dashboard.

---

## Cleanup Strategy

Cleanup runs at three points in the lifecycle:

### 1. App startup (`index.ts`)

Fires and forgets on addon initialization — no SSH needed:

- `sweepStaleJobs()` — remove any leftover `jobs/job_*/` dirs
- `sweepLocalSnapshots()` — prune local snapshot mirrors (keep 3 per
  site)

### 2. Job start (after SSH connects)

Runs in parallel before the job's first real step:

- `sweepRemoteTempFiles(ssh, appRootPath)` — `find` and delete
  `cws-job_*` files older than 30 min in `private_html/`
- `pruneRemoteSnapshots(ssh, appRootPath)` — keep 3 newest snapshot
  pairs, remove stale `pre-undo-*` dirs older than 60 min
- `sweepLocalSnapshots(userDataDir)` — keep 3 newest mirrors per site

### 3. Job end (`finally` block)

Always runs, even on errors:

- `cleanupRemote(ssh, ...)` — remove this job's specific temp files
- `sftp.end()` / `ssh.end()` — close connections
- `fs.rm(jobDir)` — remove local staging directory
- `sweepStaleJobs()` — catch any other orphaned job dirs

### What if the app crashes mid-transfer?

| Left behind | Cleaned by |
|-------------|-----------|
| Local staging dirs | `sweepStaleJobs()` on next app startup |
| Local snapshot mirrors | `sweepLocalSnapshots()` on next startup or job |
| Remote `cws-job_*` temp files | `sweepRemoteTempFiles()` on next job (needs SSH) |
| Remote snapshots | `pruneRemoteSnapshots()` on next job (needs SSH) |

Remote files cannot be cleaned without SSH, so they wait until the
next push/pull to the same server.

---

## Selective Sync

Both push and pull support granular "includes" checkboxes:

### Available options

| Option | Controls |
|--------|---------|
| `database` | DB export/import and search-replace |
| `wpContent` | Entire wp-content transfer |
| `plugins` | `wp-content/plugins/` |
| `themes` | `wp-content/themes/` |
| `uploads` | `wp-content/uploads/` |
| `muPlugins` | `wp-content/mu-plugins/` |
| `languages` | `wp-content/languages/` |

### Always excluded (regardless of checkboxes)

- `cache`, `uploads/cache` — cache directories
- `backup*` — backup files
- `.git`, `node_modules`
- `*.log`, `error_log`
- `advanced-cache.php`, `object-cache.php`
- `plugins/breeze` — Cloudways-managed caching plugin (causes errors
  in Local)

### How selective push works

Only the **checked** wp-content subdirectories are replaced on the
remote server. The tar archive includes only selected subdirs; before
extraction, those specific dirs are `rm -rf`'d on the server so
deleted local files don't linger. Unchecked subdirs remain untouched.

---

## Transfer Performance

SFTP file transfer uses `fastGet` / `fastPut` from `ssh2-sftp-client`
for parallel chunked reads/writes:

- **Concurrency**: 64 chunks in flight
- **Chunk size**: 32 KiB
- **Result**: ~2 MiB in-flight data, saturating a typical TCP window

This matches the pipelining approach used by FileZilla and other
modern SFTP clients. The single-stream `get()`/`put()` fallback
(~200 kbps on high-RTT links) is retained for test fakes that don't
expose `fastGet`/`fastPut`.

A **stall watchdog** monitors both `fastGet` step callbacks and the
outer idle watchdog (3 min timeout). If no bytes flow for the
configured `stallTimeoutMs` (default 2 min), the transfer is aborted
and the error is marked as retriable.
