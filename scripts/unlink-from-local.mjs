#!/usr/bin/env node
// Remove the CloudSync symlink from Local's add-ons directory.

import { existsSync } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

function addonsDir() {
  const plat = platform();
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Local', 'addons');
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Local', 'addons');
  }
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
  const linkPath = join(addonsDir(), linkName);

  if (!existsSync(linkPath)) {
    console.log(`Nothing to unlink at ${linkPath}`);
    return;
  }

  const stat = await lstat(linkPath);
  if (!stat.isSymbolicLink() && !stat.isDirectory()) {
    console.error(`Refusing to remove ${linkPath}: not a symlink or directory.`);
    process.exit(1);
  }

  await unlink(linkPath).catch(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(linkPath, { recursive: true, force: true });
  });

  console.log(`Unlinked: ${linkPath}`);
}

main().catch((err) => {
  console.error('unlink-from-local failed:', err.message);
  process.exit(1);
});
