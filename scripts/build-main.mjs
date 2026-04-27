// Bundle the main-process code into a single CJS file with esbuild.
// All npm dependencies (ssh2, undici, zod, etc.) are inlined so the
// final addon ships without node_modules.

import fs from 'node:fs';
import { build } from 'esbuild';

// Clean previous output so stale tsc files don't linger.
fs.rmSync('lib/main', { recursive: true, force: true });
fs.rmSync('lib/shared', { recursive: true, force: true });

/** Packages provided by Local / Electron at runtime — must NOT be bundled. */
const external = [
  // Electron itself
  'electron',
  // Local's addon APIs (resolved by Local's module loader at runtime)
  '@getflywheel/local',
  '@getflywheel/local/main',
  '@getflywheel/local/renderer',
  '@getflywheel/local-components',
  // Optional native addons that ssh2 and cpu-features try to load
  // inside try/catch blocks. They gracefully fall back to pure JS
  // when missing, so we exclude them from the bundle.
  '*.node',
];

await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'lib/main/index.js',
  sourcemap: true,
  minify: false,               // keep readable for debugging in Local
  external,
  // Node built-ins (fs, path, crypto, …) are NOT bundled — esbuild's
  // platform:'node' handles this automatically.
  logLevel: 'info',
});
