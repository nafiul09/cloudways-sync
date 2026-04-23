// Phase 6 — Selective sync resolver.
//
// Maps a PullIncludes checkbox state to tar --exclude flags for the
// archive-based wp-content download. The orchestrator calls
// `tarExcludesForIncludes()` to build the tar command, and
// `shouldSkipStep()` to conditionally skip entire steps (e.g., DB
// export when database is unchecked).

import type { PullIncludes } from '../../shared/ipcTypes';

/** Directories inside wp-content that map to each checkbox. */
const WP_CONTENT_DIRS: Record<string, string> = {
  uploads: 'uploads',
  plugins: 'plugins',
  themes: 'themes',
  muPlugins: 'mu-plugins',
  languages: 'languages',
};

/**
 * Return the list of wp-content subdir names the user selected.
 * Example: { plugins: true, themes: true, uploads: false, ... }
 *   → ['plugins', 'themes']
 *
 * Used by the pull importer and push orchestrator so each target
 * replaces ONLY the selected subdirs, leaving the rest untouched.
 * Previously both sides would wipe the whole wp-content tree, which
 * destroyed unselected dirs on the destination.
 */
export function selectedWpContentSubdirs(includes: PullIncludes): string[] {
  const out: string[] = [];
  for (const [key, dir] of Object.entries(WP_CONTENT_DIRS)) {
    if (includes[key as keyof PullIncludes]) out.push(dir);
  }
  return out;
}

/** Files that should never be synced regardless of checkbox state. */
const ALWAYS_EXCLUDE = [
  'cache',
  'uploads/cache',
  'backup*',
  '.git',
  'node_modules',
  '*.log',
  'error_log',
  'advanced-cache.php',
  'object-cache.php',
  // Breeze is a Cloudways server-managed caching plugin that causes
  // fatal errors when pulled into Local (missing server-side configs).
  // On push, excluding it preserves the remote's Breeze installation.
  'plugins/breeze',
];

/**
 * Given the resolved PullIncludes, return tar --exclude flags that
 * should be passed BEFORE the source dir in the tar command. Each
 * entry is a bare pattern (no `--exclude=` prefix).
 *
 * When `wpContent` is false the entire download-content step is
 * skipped, so this function is only called when `wpContent` is true.
 */
export function tarExcludePatternsForIncludes(includes: PullIncludes): string[] {
  const excludes = [...ALWAYS_EXCLUDE];

  for (const [key, dir] of Object.entries(WP_CONTENT_DIRS)) {
    if (!includes[key as keyof PullIncludes]) {
      excludes.push(dir);
    }
  }

  return excludes;
}

/** Build the `--exclude='...'` portion of a tar command. */
export function tarExcludeFlags(includes: PullIncludes): string {
  return tarExcludePatternsForIncludes(includes)
    .map((p) => `--exclude='${p}'`)
    .join(' ');
}

/** Whether a given pull orchestrator step should be skipped entirely. */
export function shouldSkipStep(stepId: string, includes: PullIncludes): boolean {
  switch (stepId) {
    case 'db-export':
    case 'download-db':
      return !includes.database;
    case 'download-content':
      return !includes.wpContent;
    case 'local-content':
      return !includes.wpContent;
    case 'local-db':
      return !includes.database;
    case 'search-replace':
      return !includes.database;
    default:
      return false;
  }
}

/** Whether a given push orchestrator step should be skipped entirely. */
export function shouldSkipPushStep(stepId: string, includes: PullIncludes): boolean {
  switch (stepId) {
    case 'local-export-db':
    case 'upload-db':
    case 'remote-db-import':
    case 'search-replace':
      return !includes.database;
    case 'upload-content':
      return !includes.wpContent;
    default:
      return false;
  }
}
