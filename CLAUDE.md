# Cloudways Sync for Local WP — Project Guidelines

## Build & Test

```bash
npm run build          # Build main (esbuild) + renderer (Vite)
npm run build && npm run link   # Build and symlink into Local for testing
npm run typecheck      # TypeScript validation (main + renderer)
npm run lint           # oxlint
npm run test           # vitest
npm run package        # Build + create .tgz in dist/
```

Always run `npm run build && npm run link` after editing files under `src/` — the user tests in Local and gets blocked otherwise.

## Architecture

- **Main process**: `src/main/` — esbuild CJS bundle, Node.js APIs, IPC handlers, Cloudways API client, SSH/SFTP, sync orchestrators
- **Renderer**: `src/renderer/` — Vite React bundle (React 18), UI components, IPC client
- **Shared**: `src/shared/` — TypeScript types shared between main and renderer
- **UI components**: `src/renderer/components/ui.tsx` — custom `Button`, `TextButton`, `PrimaryButton`, `Title`, `Text`, `Banner`, `Checkbox`, `Spinner`, `Divider`, `BasicInput`, `InputPasswordToggle`
- **Color tokens**: green=#51bb7b, greenDark50=#419564, red=#ef4e65, sidebar bg=#262727

## GitHub Releases

Every release **must** include:

1. **Title format**: `Cloudways Sync for Local WP — v{version}`
2. **Body structure** (in this order):
   - Highlights of changes, new features, and updates
   - Install section (copy from below)
   - Requirements section (copy from below)
   - Development section (clone + npm install + npm run link)
   - Link to full CHANGELOG.md

3. **Standard Install section** (always include):
   ```
   ### Install

   1. Download `local-addon-cloudwayssync-{version}.tgz` below
   2. Open Local WP → **Add-ons** → **Installed** → **Install from disk**
   3. Select the `.tgz` file and restart Local (Cmd+Q / Alt+F4, then reopen)
   4. Open any site's **Tools** tab → **Cloudways Sync** to get started
   ```

4. **Standard Requirements section** (always include):
   ```
   ### Requirements

   - Local WP >= 6.7.0
   - A Cloudways account with API access (email + API key) or SSH/SFTP credentials
   ```

5. **Standard Development section** (always include):
   ```
   ### Development

   git clone https://github.com/nafiul09/cloudways-sync.git
   cd cloudways-sync
   npm install
   npm run build && npm run link
   # Restart Local WP to load the add-on
   ```

6. **Release status**: Use full release (not pre-release) unless explicitly told otherwise.
7. **Attach**: The `.tgz` package from `dist/`.

## Conventions

- Pull-first, push-second button order everywhere
- Never auto-commit or push — wait for explicit user approval
- Avoid "AI-overdone" UI: no excessive dividers, borders, or boxy cards inside Local's already-framed panels
