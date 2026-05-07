// Cross-platform path utilities.
// Expands tilde, normalises separators, and provides gzip/tar
// operations using Node.js built-ins so we don't depend on system
// executables that may not exist on Windows.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

/**
 * Expand leading `~` or `~/` to the user's home directory and
 * normalise path separators for the current platform.
 */
export function resolvePath(p: string): string {
  let resolved = p;
  if (resolved.startsWith('~/') || resolved.startsWith('~\\') || resolved === '~') {
    resolved = path.join(os.homedir(), resolved.slice(2));
  }
  return path.normalize(resolved);
}

/**
 * Gzip a single file in-place (replaces `file` with `file.gz`).
 * Equivalent to `gzip -f <file>`.
 */
export async function gzipFile(filePath: string): Promise<void> {
  const dest = `${filePath}.gz`;
  const readStream = fs.createReadStream(filePath);
  const writeStream = fs.createWriteStream(dest);
  const gzip = createGzip({ level: 6 });
  await pipeline(readStream, gzip, writeStream);
  await fsp.unlink(filePath);
}

/**
 * Gunzip a `.gz` file in-place (replaces `file.gz` with `file`).
 * Equivalent to `gunzip -f <file>`.
 */
export async function gunzipFile(filePath: string): Promise<void> {
  if (!filePath.endsWith('.gz')) throw new Error(`Expected .gz file: ${filePath}`);
  const dest = filePath.slice(0, -3);
  const readStream = fs.createReadStream(filePath);
  const writeStream = fs.createWriteStream(dest);
  const gunzip = createGunzip();
  await pipeline(readStream, gunzip, writeStream);
  await fsp.unlink(filePath);
}

/**
 * Create a .tar.gz archive of a directory.
 * Equivalent to `tar czf <archive> --exclude=<p> ... -C <cwd> <entries...>`.
 *
 * @param archive  Output .tar.gz path
 * @param cwd      Base directory (the `-C` argument)
 * @param entries  Relative paths inside `cwd` to include
 * @param excludePatterns  Patterns to exclude, matching tar's --exclude
 *   semantics: `cache` matches any path component named "cache",
 *   `plugins/breeze` matches that subpath, `*.log` matches filenames
 *   ending in .log, `backup*` matches names starting with "backup".
 */
export async function createTarGz(
  archive: string,
  cwd: string,
  entries: string[],
  excludePatterns: string[] = [],
): Promise<void> {
  const filter = excludePatterns.length > 0
    ? (entryPath: string) => {
        // Normalise to forward slashes for matching
        const p = entryPath.replace(/\\/g, '/');
        for (const pattern of excludePatterns) {
          if (matchExclude(p, pattern)) return false;
        }
        return true;
      }
    : undefined;

  await tar.create(
    {
      gzip: true,
      file: archive,
      cwd,
      filter,
      portable: true,
    },
    entries,
  );
}

/** Match a path against a tar-style --exclude pattern. */
function matchExclude(entryPath: string, pattern: string): boolean {
  // entryPath is like "wp-content/uploads/cache/foo.txt"
  // pattern is like "cache", "uploads/cache", "*.log", "backup*", "plugins/breeze"
  const segments = entryPath.split('/');
  const fileName = segments[segments.length - 1] ?? '';

  if (pattern.includes('*')) {
    // Glob pattern — convert to regex and test against each path segment.
    // Escape regex-special chars (especially `.`) before converting `*`.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
    // Test against filename for patterns like *.log
    if (re.test(fileName)) return true;
    // Test against each segment for patterns like backup*
    return segments.some((seg) => re.test(seg));
  }

  if (pattern.includes('/')) {
    // Multi-segment pattern — match as a subpath
    return entryPath === pattern
      || entryPath.startsWith(`${pattern}/`)
      || entryPath.includes(`/${pattern}/`)
      || entryPath.endsWith(`/${pattern}`);
  }

  // Simple name — match any path component
  return segments.includes(pattern);
}

/**
 * Extract a .tar.gz archive into a directory.
 * Equivalent to `tar xzf <archive> -C <cwd>`.
 *
 * @param archive  Input .tar.gz path
 * @param cwd      Directory to extract into
 * @param stripComponents  Number of leading path components to strip (like --strip-components)
 */
export async function extractTarGz(
  archive: string,
  cwd: string,
  stripComponents = 0,
): Promise<void> {
  await tar.extract({
    file: archive,
    cwd,
    strip: stripComponents,
  });
}
