# Cloudways Sync for Local WP

> Cloudways ↔ Local, one click.

A Local WP add-on that connects your Local installation to a
Cloudways account so you can clone any Cloudways WordPress app into
Local, push local changes back, and selectively sync DB / uploads /
plugins / themes — with safety backups on both sides and an "Undo
push" button.

**Status:** v0.1.0 alpha. Public functionality shipped; expect rough
edges. See [CHANGELOG.md](./CHANGELOG.md) for the full release notes.

## Features

- **Connect once** — API key stored encrypted via Electron
  `safeStorage`; surfaced everywhere as a masked email with an
  eye-icon reveal for screen-share privacy.
- **Two linking modes** — connect via Cloudways API for the full
  experience (servers/apps picker, remote backups, restore-app undo),
  or link directly via SSH/SFTP credentials when you don't have API
  access (e.g. invited team members). Both modes can coexist on the
  same Local install.
- **Pull** any Cloudways WordPress app into a new or existing Local
  site. Archive-based transfer (tar on server → one download) with a
  pre-pull Cloudways backup (API mode).
- **Push** a Local site back to a linked Cloudways app. Pre-push
  remote backup, optional Breeze re-activation, and one-click undo.
- **Selective sync** — per-subdir checkboxes (database, uploads,
  plugins, themes, mu-plugins, languages). Unselected subdirs on the
  destination stay untouched; deletions inside selected subdirs
  propagate correctly.
- **Live progress modal** with step labels, bytes transferred, and
  percentage — blocks UI while a sync runs so you can't accidentally
  close Local mid-transfer.
- **Humanized errors** — every failure path has a user-facing message
  with the underlying code exposed for support.

## Linking modes

| Capability | API mode | SFTP mode |
| --- | --- | --- |
| Browse Cloudways servers & apps in Local | ✅ | — |
| Pre-sync Cloudways backup | ✅ | — |
| Pre-push safety snapshot on the server | ✅ | ✅ (tar of `wp-content` + `wp db export`) |
| Push from Local → Cloudways | ✅ | ✅ |
| Pull from Cloudways → Local | ✅ | ✅ |
| Undo last push | ✅ (Cloudways `restoreApp`) | ✅ (re-applies the local-tar snapshot) |
| Mode B (provision a new Cloudways app from Local) | ✅ | — |

API mode requires your Cloudways email + API key from
*My Profile → API Keys*. SFTP mode only needs the SSH/SFTP
credentials shown under *Application Settings → SSH/SFTP* — useful
for invited team members who don't have access to the account's API
key. Open any site's **Tools → Cloudways Sync** tab to link it via
either mode.

## Requirements

- Node.js 20 or 22
- Local WP (latest stable, >= 6.7.0)
- A Cloudways account with API access (email + API key)

## Install

This alpha is developer-install only — clone, build, link into Local.
A one-click install via the Local Add-on Library will come once the
addon is submitted there.

```bash
git clone https://github.com/nafiul09/cloudways-sync.git
cd cloudways-sync
npm install
npm run build
npm run link   # copies into Local's add-ons directory
```

Then **fully quit Local** (Cmd+Q / Alt+F4 — not just close the window)
and reopen. In Local, open any site's Tools tab and click
**Cloudways Sync**, or click the Cloudways Sync icon in Local's sidebar,
and paste your Cloudways email + API key.

`npm run unlink` removes it again.

## Development

```bash
# Install dependencies
npm install

# Build main + renderer
npm run build

# Watch mode
npm run dev

# Copy into Local's add-ons directory
npm run link

# Remove it again
npm run unlink

# Lint / typecheck / test
npm run lint
npm run typecheck
npm test
```

After `npm run link`, **fully quit Local** (Cmd+Q, not just close the
window) and reopen. Then `Settings → Add-ons → Installed` — you
should see Cloudways Sync listed.

## Project layout

```
src/
├── main/       Electron main-process code (IPC handlers, Cloudways
│               client, SSH/SFTP, sync orchestrators)
├── renderer/   React UI (sidebar, tools panel, modals, progress)
└── shared/     Types imported by both processes

scripts/
├── link-to-local.mjs     Copy into Local's add-ons dir
├── unlink-from-local.mjs Remove it
└── smoke-cloudways.mjs   Live Cloudways API sanity check
```

See the implementation plan in `[plan]/` for the full engineering
breakdown.

## License

MIT — see [LICENSE](./LICENSE).
