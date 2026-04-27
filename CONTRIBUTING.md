# Contributing to Cloudways Sync for Local WP

Thanks for your interest in contributing! Here's how to get started.

## Development setup

```bash
git clone https://github.com/nafiul09/cloudways-sync.git
cd cloudways-sync
npm install
npm run build
npm run link   # symlinks into Local's add-ons directory
```

Restart Local after linking. See [README.md](./README.md) for full details.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Make your changes — keep PRs focused on a single concern.
3. Run the checks before pushing:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```
4. Open a pull request against `main`.

## Code style

- TypeScript strict mode is enabled for both main and renderer.
- Linting is handled by [oxlint](https://oxc.rs/).
- No manual formatting rules — just follow what's already in the codebase.

## Architecture

- `src/main/` — Electron main-process code (IPC handlers, API/SFTP clients, sync orchestrators).
- `src/renderer/` — React UI (hooks, screens, components).
- `src/shared/` — Types shared between both processes.

See [docs/sync-architecture.md](./docs/sync-architecture.md) for the full design.

## Reporting bugs

Open an issue at [github.com/nafiul09/cloudways-sync/issues](https://github.com/nafiul09/cloudways-sync/issues) with:

- Local WP version
- OS and version
- Steps to reproduce
- Error messages or screenshots

## Security

If you find a security vulnerability, please email nafiul09 directly instead of opening a public issue. See [docs/security.md](./docs/security.md) for the security architecture.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
