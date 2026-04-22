#!/usr/bin/env node
// Phase 1 acceptance smoke test. Hits the real Cloudways API using the
// creds in .env.local and prints a summary of servers + apps. Never
// committed creds — .env.local is gitignored.
//
// Usage:
//   cp .env.example .env.local && edit .env.local
//   npm run build:main
//   node scripts/smoke-cloudways.mjs
//
// This imports the compiled CJS output so we don't need an extra ts
// runner. Exit code is non-zero on any failure so CI / you can spot it.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// Minimal .env loader — just KEY=value lines, no fancy escaping.
function loadEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv(path.join(repo, '.env.local'));
loadEnv(path.join(repo, '.env'));

const email = process.env.CLOUDWAYS_EMAIL;
const apiKey = process.env.CLOUDWAYS_API_KEY;
if (!email || !apiKey) {
  console.error('Missing CLOUDWAYS_EMAIL or CLOUDWAYS_API_KEY. Copy .env.example → .env.local and fill in.');
  process.exit(2);
}

const compiled = path.join(repo, 'lib', 'main', 'cloudways', 'ApiClient.js');
if (!existsSync(compiled)) {
  console.error(`Compiled client missing at ${compiled}. Run: npm run build:main`);
  process.exit(2);
}

// eslint-disable-next-line import/no-dynamic-require
const { ApiClient } = await import(compiled);

const client = new ApiClient({
  email,
  apiKey,
  onRetry: (err, attempt, delayMs) => {
    console.warn(`[retry ${attempt}] ${err?.code ?? err?.name ?? 'Error'} — waiting ${delayMs}ms`);
  },
});

const start = Date.now();
console.log(`→ Verifying credentials for ${email} …`);
const token = await client.verifyCredentials();
console.log(`  ✓ got token (expires in ${token.expires_in}s)`);

console.log('→ Listing servers …');
const servers = await client.listServers();
console.log(`  ✓ ${servers.length} server(s)`);

for (const s of servers) {
  const apps = s.apps ?? [];
  console.log(`    • server #${s.id} "${s.label}" [${s.cloud}${s.region ? `/${s.region}` : ''}] — ${apps.length} app(s)`);
  for (const a of apps) {
    console.log(`        - app #${a.id} "${a.label}" (${a.application}) fqdn=${a.app_fqdn ?? '-'}`);
  }
}

const elapsed = Math.round((Date.now() - start) / 10) / 100;
console.log(`Done in ${elapsed}s.`);
