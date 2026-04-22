# CloudwaysSync for Local

> Cloudways ↔ Local, one click.

A Local WP add-on that connects your Local installation to a Cloudways
account so you can clone any Cloudways WordPress app into Local, push
local changes back, and selectively sync DB / uploads / plugins /
themes — with safety backups on both sides and an "Undo push" button.

**Status:** Phase 0 scaffold. Not yet functional.

See [`[plan]/cloudsync-addon-implementation-plan.md`](./[plan]/cloudsync-addon-implementation-plan.md)
for the full engineering plan.

## Requirements

- Node.js 20 or 22
- Local WP (latest stable, >= 6.7.0)
- A Cloudways account with API access (email + API key)

## Development

```bash
# Install dependencies
npm install

# Build main + renderer
npm run build

# Watch mode
npm run dev

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
window) and reopen. Then `Settings → Add-ons → Installed` — you should
see CloudwaysSync listed.

## Project layout

```
src/
├── main/       Electron main-process code (IPC handlers, Cloudways client, sync engine)
├── renderer/   React UI (sidebar, modals, progress)
└── shared/     Types imported by both processes
```

See the plan's §3 for the full directory breakdown.

## License

MIT — see [LICENSE](./LICENSE).
