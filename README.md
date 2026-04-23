# CloudwaysSync for Local

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
- **Pull** any Cloudways WordPress app into a new or existing Local
  site. Archive-based transfer (tar on server → one download) with a
  pre-pull Cloudways backup.
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

## Requirements

- Node.js 20 or 22
- Local WP (latest stable, >= 6.7.0)
- A Cloudways account with API access (email + API key)

## Install

### From the release zip (recommended)

1. Download `local-addon-cloudwayssync-0.1.0.zip` from the
   [Releases page](https://github.com/nafiul09/cloudways-sync/releases).
2. Unzip into Local's add-ons directory:
   - **macOS:** `~/Library/Application Support/Local/addons/`
   - **Windows:** `%AppData%\Local\addons\`
   - **Linux:** `~/.config/Local/addons/`
3. Fully quit Local (Cmd+Q / Alt+F4 — not just close the window) and
   reopen.
4. In Local, open any site's Tools tab and click **CloudwaysSync**,
   or click the CloudwaysSync icon in Local's sidebar.
5. Paste your Cloudways email + API key to connect.

### From source (development)

```bash
npm install
npm run build
npm run link   # symlinks into Local's add-ons directory
```

Then fully quit and reopen Local.

## Development

```bash
# Install dependencies
npm install

# Build main + renderer
npm run build

# Watch mode
npm run dev

# Package a distributable zip into dist/
npm run package

# Symlink into Local's add-ons directory
npm run link

# Remove the symlink
npm run unlink

# Lint / typecheck / test
npm run lint
npm run typecheck
npm test
```

After `npm run link`, **fully quit Local** (Cmd+Q, not just close the
window) and reopen. Then `Settings → Add-ons → Installed` — you
should see CloudwaysSync listed.

## Project layout

```
src/
├── main/       Electron main-process code (IPC handlers, Cloudways
│               client, SSH/SFTP, sync orchestrators)
├── renderer/   React UI (sidebar, tools panel, modals, progress)
└── shared/     Types imported by both processes

scripts/
├── build-addon-zip.mjs   Package a release zip
├── link-to-local.mjs     Symlink into Local's add-ons dir
├── unlink-from-local.mjs Remove the symlink
└── smoke-cloudways.mjs   Live Cloudways API sanity check
```

See the implementation plan in `[plan]/` for the full engineering
breakdown.

## License

MIT — see [LICENSE](./LICENSE).
