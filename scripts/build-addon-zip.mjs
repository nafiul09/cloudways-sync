#!/usr/bin/env node
// Builds a distributable zip for the Local Add-on Library.
// Usage: node scripts/build-addon-zip.mjs

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const outName = `${pkg.name}-${pkg.version}.zip`;
const outPath = path.join(ROOT, 'dist', outName);

// 1. Clean build
console.log('Building\u2026');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

// 2. Create dist/ and zip
console.log(`Packaging ${outName}\u2026`);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

const output = createWriteStream(outPath);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.pipe(output);

// Compiled output
archive.directory(path.join(ROOT, 'lib'), 'lib');

// Manifest
archive.file(path.join(ROOT, 'package.json'), { name: 'package.json' });

// Icon (if present)
const iconPath = path.join(ROOT, 'icon.svg');
if (fs.existsSync(iconPath)) {
  archive.file(iconPath, { name: 'icon.svg' });
}

// Production node_modules
archive.directory(path.join(ROOT, 'node_modules'), 'node_modules');

await new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
  archive.finalize();
});

const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`Done: ${outPath} (${sizeMb} MB)`);
