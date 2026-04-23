#!/usr/bin/env node
// Builds a distributable zip for the Local Add-on Library.
//
// The zip must be self-contained — Local does not run `npm install`
// after extraction — so we ship `node_modules/`. But only *production*
// dependencies are needed at runtime. Zipping the dev tree pulls in
// `electron` (~270 MB, transitively required by @getflywheel/local),
// TypeScript, Vite, Vitest, etc., bloating the zip to ~170 MB.
//
// Strategy:
//   1. Build (tsc for main, Vite for renderer) → `lib/`.
//   2. Copy only the files listed in package.json `files` into a
//      clean staging dir under `dist/staging/`.
//   3. Run `npm install --omit=dev` inside staging — this resolves
//      *only* the production dependencies (archiver, extract-zip,
//      pino, ssh2, ssh2-sftp-client, undici, zod, zustand) plus their
//      transitives.
//   4. Zip the staging dir at the archive root.
//
// Usage: node scripts/build-addon-zip.mjs

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const outName = `${pkg.name}-${pkg.version}.zip`;
const DIST = path.join(ROOT, 'dist');
const STAGING = path.join(DIST, 'staging');
const outPath = path.join(DIST, outName);

// 1. Clean build
console.log('Building…');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

// 2. Reset staging dir
console.log('Staging…');
fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });

// Copy compiled output, filtering OS cruft.
fs.cpSync(path.join(ROOT, 'lib'), path.join(STAGING, 'lib'), {
  recursive: true,
  filter: (src) => !src.endsWith('.DS_Store'),
});

// Copy manifest + docs + icon
for (const f of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'icon.svg']) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGING, f));
}

// 3. Install production deps into staging.
// `--omit=dev` skips devDependencies; `--no-audit`/`--no-fund` just
// keeps output quiet. We keep install scripts enabled so native
// modules (e.g. ssh2's optional cpu-features) resolve correctly.
console.log('Installing production dependencies…');
execSync('npm install --omit=dev --no-audit --no-fund', {
  cwd: STAGING,
  stdio: 'inherit',
});

// 4. Zip staging dir
console.log(`Packaging ${outName}…`);
const output = createWriteStream(outPath);
const archive = archiver('zip', { zlib: { level: 9 } });
archive.pipe(output);
archive.directory(STAGING, false);

await new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
  archive.finalize();
});

const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`Done: ${outPath} (${sizeMb} MB)`);
