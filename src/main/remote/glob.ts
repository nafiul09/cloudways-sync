// Tiny glob matcher sufficient for Phase 4 / Phase 6 selective sync.
//
// Supports:
//   *     — any characters except `/`
//   **    — any characters, including `/`  (matches zero or more path segments)
//   ?     — any single character except `/`
//   **/foo — matches `foo` at any depth
//   foo/**/bar — matches any path that starts with foo/ and ends with bar
//
// All comparisons are POSIX-style: paths use `/` separators. On
// callers, always convert to POSIX before matching.

function globToRegex(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — may also eat a trailing slash so that "foo/**"
        // matches both "foo" and "foo/bar".
        out += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '.' || c === '+' || c === '(' || c === ')' || c === '|' || c === '^' || c === '$' || c === '{' || c === '}' || c === '[' || c === ']' || c === '\\') {
      out += '\\' + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out);
}

export class GlobMatcher {
  private readonly includes: RegExp[];
  private readonly excludes: RegExp[];

  constructor(include?: string[], exclude?: string[]) {
    this.includes = (include ?? []).map(globToRegex);
    this.excludes = (exclude ?? []).map(globToRegex);
  }

  /** True if `path` should be kept: matches at least one include
   * (or no includes specified) AND no exclude. Path is POSIX. */
  match(path: string): boolean {
    if (this.excludes.some((r) => r.test(path))) return false;
    if (this.includes.length === 0) return true;
    return this.includes.some((r) => r.test(path));
  }

  /** True if recursing into `dirPath` (POSIX) might yield any match.
   * Conservative: returns true unless every include is rooted at a
   * different top-level prefix. Useful for pruning large trees. */
  shouldDescend(dirPath: string): boolean {
    // Never descend into a directory that is fully excluded.
    if (this.excludes.some((r) => r.test(dirPath))) return false;
    // If there are no includes, descend everything.
    return true;
  }
}
