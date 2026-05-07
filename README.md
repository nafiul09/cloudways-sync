# Cloudways Sync for Local WP

> Cloudways ↔ Local, one click.

A Local WP add-on that connects your Local installation to a
Cloudways account so you can clone any Cloudways WordPress app into
Local, push local changes back, and selectively sync DB / uploads /
plugins / themes — with safety backups on both sides and an "Undo
push" button.

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
  pre-pull Cloudways backup (API mode). Fleet browser lets you pull
  any app as a new Local site in one click.
- **Push** a Local site back to a linked Cloudways app. Pre-push
  remote backup, optional Breeze re-activation, and one-click undo.
  Post-push review checklist ensures you verify the live site before
  confirming or undoing.
- **Selective sync** — per-subdir checkboxes (database, uploads,
  plugins, themes, mu-plugins, languages). Unselected subdirs on the
  destination stay untouched; deletions inside selected subdirs
  propagate correctly.
- **Wizard modal** — stepped sync flow (Confirm → Configure → Running
  → Review/Done) with a visual phase stepper, safety warnings, and
  side-by-side action buttons. Escape is blocked during post-push
  review to prevent orphaned backups.
- **Live progress** with step labels, bytes transferred, and
  percentage — blocks UI while a sync runs so you can't accidentally
  close Local mid-transfer.
- **WP-CLI connection test** — test SSH connectivity and WP-CLI from
  the fleet browser before pulling.
- **Humanized errors** — every failure path has a user-facing message
  with the underlying code exposed for support.

## Requirements

- Local WP >= 9.0
- A Cloudways account with API access (email + API key) or SSH/SFTP credentials

## Install

1. Download the latest `.tgz` from [Releases](https://github.com/nafiul09/cloudways-sync/releases)
2. Open Local WP → click **Add-ons** in the sidebar → **Installed**
3. Click **Install from disk**, select the downloaded `.tgz` file, and open
4. Restart Local WP completely (Cmd+Q / Alt+F4, then reopen)
5. Open any site's **Tools** tab → **Cloudways Sync** to get started

![Installation walkthrough](https://github.com/nafiul09/cloudways-sync/releases/download/v0.1.0/cloudways-sync-installation.gif)

## Linking modes

| Capability | API mode | SFTP mode |
| --- | --- | --- |
| Browse Cloudways servers & apps in Local | ✅ | — |
| Pre-sync Cloudways backup | ✅ | — |
| Pre-push safety snapshot on the server | ✅ | ✅ (tar of `wp-content` + `wp db export`) |
| Push from Local → Cloudways | ✅ | ✅ |
| Pull from Cloudways → Local | ✅ | ✅ |
| Undo last push | ✅ (Cloudways `restoreApp`) | ✅ (re-applies the local-tar snapshot) |

### API mode

Requires your Cloudways email + API key. To set it up:

1. **Get your API key** — in the Cloudways Platform, click the
   nine-dot grid icon in the bottom-left corner and select
   **API → Integrations**, or go directly to
   [unified.cloudways.com/api](https://unified.cloudways.com/api). Create your first API key or
   regenerate an existing one.
2. **Whitelist your IP** — for each server you want to use with
   Cloudways Sync, go to **Servers → (your server) → Security →
   Shell Access** and add your IP address to the allowlist. If the server blocks all IPs
   except those on the allowlist, your IP must be added for the
   add-on to connect.
3. Enter your Cloudways email and API key in the add-on to link.

### SFTP mode

Uses per-application SSH/SFTP credentials — useful for team members
who don't have access to the account's API key. Before connecting:

1. **Whitelist your IP** — same as API mode: go to
   **Servers → (your server) → Security → Shell Access** and add your
   IP address to the allowlist.
2. **Enable shell access** — go to **Application Settings → General**
   tab, scroll to the bottom, and set Shell Access to **Enable**.
3. **Get SFTP credentials** — go to your app's **Application Settings**
   page and use the existing SFTP details or create new ones. Use
   these credentials (host, username, password) when linking in the
   add-on.

Open any site's **Tools → Cloudways Sync** tab to link via either mode.

## Pull (Cloudways → Local)

Pull clones a Cloudways app into a Local site. The wizard walks you
through four stages:

1. **Confirm** — review the source app, target site, and any safety
   warnings before starting.
2. **Configure** — choose what to pull: database, uploads, plugins,
   themes, mu-plugins, languages. Anything unchecked stays untouched
   locally. In API mode a Cloudways backup is taken automatically
   before pulling.
3. **Pulling** — the add-on archives the selected content on the
   server, downloads it in a single transfer, restores locally, and
   search-replaces URLs so the site works on your local domain.
4. **Done** — summary of what was pulled and any next steps.

<!-- TODO: add pull walkthrough GIF -->

## Push (Local → Cloudways)

Push sends your Local site back to the linked Cloudways app. Same
four-stage wizard, with an extra safety net at the end:

1. **Confirm** — review source and destination, see safety warnings.
2. **Configure** — choose what to push: database, uploads, plugins,
   themes, mu-plugins, languages. A pre-push snapshot is taken
   automatically (Cloudways backup in API mode; tar + DB export in
   SFTP mode).
3. **Pushing** — uploads the selected content, restores on the server,
   and search-replaces URLs to match the live domain.
4. **Review** — post-push checklist to verify the live site. From here
   you can **undo** the push with one click (API mode restores via
   Cloudways; SFTP mode re-applies the snapshot) or **confirm** to
   finalize.

<!-- TODO: add push walkthrough GIF -->

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development setup.

## License

MIT — see [LICENSE](./LICENSE).
