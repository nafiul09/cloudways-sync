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

1. **Release title**: Just the version name (e.g. `v0.1.0 — Beta`, `v0.1.1-beta`). NOT the plugin name.
2. **Body structure** (in this order):
   - `## Cloudways Sync for Local WP — v{version}` heading
   - Short description of the release
   - Changes, new features, fixes
   - Install section
   - Requirements section
   - "For developers" section linking to CONTRIBUTING.md

3. **Standard Install section** (always include):
   ```
   ### Install

   1. Download `local-addon-cloudwayssync-{version}.tgz` from the Assets below
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

5. **For developers section** (always include):
   ```
   ### For developers

   See [CONTRIBUTING.md](https://github.com/nafiul09/cloudways-sync/blob/main/CONTRIBUTING.md) for the development setup.
   ```

6. **Do NOT include**: git clone instructions, full changelog links, development commands (`npm run build`, `npm install`, etc.), or any "Dev" / "Development" / "Getting Started" sections in the release body. The "For developers" section above is **only** a one-line link to CONTRIBUTING.md — nothing else.
7. **Release status**: Use full release (not pre-release) unless explicitly told otherwise.
8. **Attach**: The `.tgz` package from `dist/`.

## Conventions

- Pull-first, push-second button order everywhere
- Never auto-commit or push — wait for explicit user approval
- Avoid "AI-overdone" UI: no excessive dividers, borders, or boxy cards inside Local's already-framed panels
