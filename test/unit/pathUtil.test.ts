import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTarGz, extractTarGz } from '../../src/main/sync/pathUtil';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cws-pathutil-'));
}

/**
 * Create a tree of files under `base`, then tar + extract with the
 * given exclude patterns and return which relative paths survived.
 */
async function roundTrip(
  files: string[],
  excludePatterns: string[],
): Promise<string[]> {
  const src = tmpDir();
  const dst = tmpDir();
  const archive = path.join(tmpDir(), 'test.tar.gz');

  // Create files
  for (const f of files) {
    const abs = path.join(src, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
  }

  await createTarGz(archive, src, ['wp-content'], excludePatterns);
  await extractTarGz(archive, dst);

  // Collect extracted files (relative paths)
  const result: string[] = [];
  function walk(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else result.push(rel);
    }
  }
  walk(dst, '');
  return result.sort();
}

describe('createTarGz exclude filter', () => {
  it('*.log excludes .log files but NOT directories named blog', async () => {
    const files = [
      'wp-content/debug.log',
      'wp-content/error.log',
      'wp-content/themes/astra/inc/blog/blog-config.php',
      'wp-content/themes/astra/inc/blog/blog.php',
      'wp-content/plugins/catalog/catalog.php',
      'wp-content/plugins/changelog/changelog.php',
    ];
    const result = await roundTrip(files, ['*.log']);

    // .log files excluded
    expect(result).not.toContainEqual(expect.stringContaining('debug.log'));
    expect(result).not.toContainEqual(expect.stringContaining('error.log'));

    // blog directory and its contents preserved
    expect(result).toContainEqual(expect.stringContaining('blog-config.php'));
    expect(result).toContainEqual(expect.stringContaining('blog.php'));

    // Other directories ending in "log" preserved
    expect(result).toContainEqual(expect.stringContaining('catalog.php'));
    expect(result).toContainEqual(expect.stringContaining('changelog.php'));
  });

  it('cache excludes directories named cache at any depth', async () => {
    const files = [
      'wp-content/cache/file.txt',
      'wp-content/uploads/cache/thumb.jpg',
      'wp-content/themes/theme/style.css',
    ];
    const result = await roundTrip(files, ['cache']);

    expect(result).not.toContainEqual(expect.stringContaining('cache'));
    expect(result).toContainEqual(expect.stringContaining('style.css'));
  });

  it('plugins/breeze excludes only the breeze plugin', async () => {
    const files = [
      'wp-content/plugins/breeze/breeze.php',
      'wp-content/plugins/akismet/akismet.php',
    ];
    const result = await roundTrip(files, ['plugins/breeze']);

    expect(result).not.toContainEqual(expect.stringContaining('breeze'));
    expect(result).toContainEqual(expect.stringContaining('akismet.php'));
  });

  it('backup* excludes dirs/files starting with backup', async () => {
    const files = [
      'wp-content/backup-2024/dump.sql',
      'wp-content/backups/old.zip',
      'wp-content/themes/theme/template.php',
    ];
    const result = await roundTrip(files, ['backup*']);

    expect(result).not.toContainEqual(expect.stringContaining('backup'));
    expect(result).toContainEqual(expect.stringContaining('template.php'));
  });
});
