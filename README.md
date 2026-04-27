# Cloudways Sync for Local WP

> Cloudways ↔ Local, one click.

A Local WP add-on that connects your Local installation to a
Cloudways account so you can clone any Cloudways WordPress app into
Local, push local changes back, and selectively sync DB / uploads /
plugins / themes — with safety backups on both sides and an "Undo
push" button.

**Status:** v0.1.0 Beta — public functionality shipped; expect rough edges.

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

### API mode

Requires your Cloudways email + API key. You can find it in the
Cloudways Platform under **My Profile → API Keys**.

### SFTP mode

Uses per-application SSH/SFTP credentials — useful for team members
who don't have access to the account's API key. Before connecting:

1. **Whitelist your IP** — in the Cloudways Platform, go to your
   server's **Security → SSH/SFTP** tab and add your public IP to
   the allowlist.
2. **Enable shell access** — go to **Application Settings → General →
   Application Credentials** and set Shell Access to **Enable**.
3. Use the SSH/SFTP credentials shown under **Application Settings →
   SSH/SFTP** (host, username, password) when linking in the add-on.

Open any site's **Tools → Cloudways Sync** tab to link via either mode.

## Requirements

- Local WP >= 6.7.0
- A Cloudways account with API access (email + API key) or SSH/SFTP credentials

## Install

1. Download the latest `.tgz` from [Releases](https://github.com/nafiul09/cloudways-sync/releases)
2. Open Local WP → click **Add-ons** in the sidebar → **Installed**
3. Click **Install from disk**, select the downloaded `.tgz` file, and open
4. Restart Local WP completely (Cmd+Q / Alt+F4, then reopen)
5. Open any site's **Tools** tab → **Cloudways Sync** to get started

![Installation walkthrough](https://github.com/nafiul09/cloudways-sync/releases/download/v0.1.0/cloudways-sync-installation.gif)

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development setup.

## License

MIT — see [LICENSE](./LICENSE).
