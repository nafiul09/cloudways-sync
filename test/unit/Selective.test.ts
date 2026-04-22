import { describe, expect, it } from 'vitest';
import {
  shouldSkipStep,
  shouldSkipPushStep,
  tarExcludePatternsForIncludes,
  tarExcludeFlags,
} from '../../src/main/sync/Selective';
import type { PullIncludes } from '../../src/shared/ipcTypes';

const ALL_ON: PullIncludes = {
  database: true,
  wpContent: true,
  uploads: true,
  plugins: true,
  themes: true,
  muPlugins: true,
  languages: true,
};

describe('Selective resolver', () => {
  it('returns only always-excluded patterns when everything is on', () => {
    const patterns = tarExcludePatternsForIncludes(ALL_ON);
    expect(patterns).toContain('cache');
    expect(patterns).toContain('node_modules');
    expect(patterns).not.toContain('uploads');
    expect(patterns).not.toContain('plugins');
    expect(patterns).not.toContain('themes');
  });

  it('adds directory excludes when sub-options are off', () => {
    const includes: PullIncludes = {
      ...ALL_ON,
      plugins: false,
      languages: false,
    };
    const patterns = tarExcludePatternsForIncludes(includes);
    expect(patterns).toContain('plugins');
    expect(patterns).toContain('languages');
    expect(patterns).not.toContain('uploads');
    expect(patterns).not.toContain('themes');
  });

  it('tarExcludeFlags formats correctly', () => {
    const includes: PullIncludes = { ...ALL_ON, themes: false };
    const flags = tarExcludeFlags(includes);
    expect(flags).toContain("--exclude='themes'");
    expect(flags).toContain("--exclude='cache'");
  });

  it('shouldSkipStep skips DB steps when database is off', () => {
    const noDb = { ...ALL_ON, database: false };
    expect(shouldSkipStep('db-export', noDb)).toBe(true);
    expect(shouldSkipStep('download-db', noDb)).toBe(true);
    expect(shouldSkipStep('download-content', noDb)).toBe(false);
    expect(shouldSkipStep('validate', noDb)).toBe(false);
  });

  it('shouldSkipStep skips content steps when wpContent is off', () => {
    const noContent = { ...ALL_ON, wpContent: false };
    expect(shouldSkipStep('download-content', noContent)).toBe(true);
    expect(shouldSkipStep('db-export', noContent)).toBe(false);
  });

  it('shouldSkipPushStep skips DB steps when database is off', () => {
    const noDb = { ...ALL_ON, database: false };
    expect(shouldSkipPushStep('local-export-db', noDb)).toBe(true);
    expect(shouldSkipPushStep('upload-db', noDb)).toBe(true);
    expect(shouldSkipPushStep('remote-db-import', noDb)).toBe(true);
    expect(shouldSkipPushStep('search-replace', noDb)).toBe(true);
    expect(shouldSkipPushStep('upload-content', noDb)).toBe(false);
  });

  it('shouldSkipPushStep skips content when wpContent is off', () => {
    const noContent = { ...ALL_ON, wpContent: false };
    expect(shouldSkipPushStep('upload-content', noContent)).toBe(true);
    expect(shouldSkipPushStep('local-export-db', noContent)).toBe(false);
    expect(shouldSkipPushStep('upload-db', noContent)).toBe(false);
  });
});
