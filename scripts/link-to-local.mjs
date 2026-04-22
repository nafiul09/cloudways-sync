#!/usr/bin/env node
// Cross-platform: symlink this repo into Local's add-ons directory so
// Local picks it up on next restart. Safe to run multiple times.
//
// Usage:  node scripts/link-to-local.mjs
//         node scripts/link-to-local.mjs --name=cloudsync

import { mkdir, lstat, unlink, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function addonsDir() {
  const plat = platform();
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Local', 'addons');
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Local', 'addons');
  }
  // linux + others
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(xdg, 'Local', 'addons');
}

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  const linkName = parseArg('name', 'local-addon-cloudwayssync');
  const target = addonsDir();
  const linkPath = join(target, linkName);

  if (!existsSync(target)) {
    await mkdir(target, { recursive: true });
  }

  // Local loads the add-on directory as-is. Symlink the repo root
  // (not just `lib/`) because Local needs to read `package.json`.
  if (existsSync(linkPath)) {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      await unlink(linkPath).catch(async () => {
        // On Windows, junctions may need directory removal instead.
        const { rm } = await import('node:fs/promises');
        await rm(linkPath, { recursive: true, force: true });
      });
    }
  }

  // Windows: use 'junction' so admin rights aren't required.
  const symlinkType = platform() === 'win32' ? 'junction' : 'dir';
  await symlink(repoRoot, linkPath, symlinkType);

  console.log(`Linked: ${linkPath} -> ${repoRoot}`);
  console.log('Now restart Local (or toggle the add-on) to load CloudwaysSync.');
}

main().catch((err) => {
  console.error('link-to-local failed:', err.message);
  process.exit(1);
});
