// Lightweight semver comparison. Handles pre-release tags per SemVer 2.0:
// pre-release has lower precedence than the associated release.
// e.g. 0.1.1-beta < 0.1.1 < 0.2.0

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
};

export function parseSemver(str: string): SemVer | null {
  const s = str.startsWith('v') ? str.slice(1) : str;
  const dashIdx = s.indexOf('-');
  const core = dashIdx === -1 ? s : s.slice(0, dashIdx);
  const prerelease = dashIdx === -1 ? undefined : s.slice(dashIdx + 1);
  const parts = core.split('.');
  if (parts.length !== 3) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
  return { major, minor, patch, pre: prerelease ? prerelease.split('.') : [] };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = Number(a);
  const bNum = Number(b);
  const aIsNum = !Number.isNaN(aNum);
  const bIsNum = !Number.isNaN(bNum);
  if (aIsNum && bIsNum) return aNum - bNum;
  if (aIsNum) return -1; // numeric < string
  if (bIsNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  const d = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (d !== 0) return d;
  // No pre-release → higher precedence than pre-release
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  // Compare pre-release identifiers left-to-right
  const len = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifiers(a.pre[i]!, b.pre[i]!);
    if (c !== 0) return c;
  }
  return a.pre.length - b.pre.length;
}

/** Returns true if `candidate` is strictly newer than `current`. */
export function isNewer(current: string, candidate: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  return compareSemver(b, a) > 0;
}
