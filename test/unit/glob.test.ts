import { describe, expect, it } from 'vitest';
import { GlobMatcher } from '@main/remote/glob';

describe('GlobMatcher', () => {
  it('matches everything with no patterns', () => {
    const m = new GlobMatcher();
    expect(m.match('wp-content/plugins/foo.php')).toBe(true);
    expect(m.match('anything')).toBe(true);
  });

  it('respects include-only patterns', () => {
    const m = new GlobMatcher(['wp-content/uploads/**']);
    expect(m.match('wp-content/uploads/2024/01/photo.jpg')).toBe(true);
    expect(m.match('wp-content/plugins/foo.php')).toBe(false);
  });

  it('respects exclude patterns', () => {
    const m = new GlobMatcher(undefined, ['**/.DS_Store', '**/node_modules/**']);
    expect(m.match('wp-content/.DS_Store')).toBe(false);
    expect(m.match('wp-content/plugins/node_modules/x.js')).toBe(false);
    expect(m.match('wp-content/plugins/foo.php')).toBe(true);
  });

  it('combines include + exclude (exclude wins)', () => {
    const m = new GlobMatcher(['wp-content/uploads/**'], ['**/*.tmp']);
    expect(m.match('wp-content/uploads/foo.jpg')).toBe(true);
    expect(m.match('wp-content/uploads/bar.tmp')).toBe(false);
  });

  it('supports single-star (no slash)', () => {
    const m = new GlobMatcher(['*.php']);
    expect(m.match('foo.php')).toBe(true);
    expect(m.match('sub/foo.php')).toBe(false);
  });

  it('shouldDescend returns false for fully-excluded directories', () => {
    const m = new GlobMatcher(undefined, ['wp-content/cache/**']);
    expect(m.shouldDescend('wp-content/cache/')).toBe(false);
    expect(m.shouldDescend('wp-content/')).toBe(true);
  });
});
