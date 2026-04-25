// SFTP/SSH probe for the "Link via SFTP" form. Validates that we can:
//   1. Open an SSH connection with the user's host/port/username/password.
//   2. Find a Cloudways-style applications/<sys>/public_html/wp-config.php.
//   3. (Best-effort) check whether wp-cli is available and capture
//      `wp option get siteurl` for display.
//
// The probe is read-only — it does not write anything to the server or
// to disk. The IPC handler is responsible for persisting credentials
// and the mapping after a successful probe.

import { SshClient } from '../remote/SshClient';
import { RemoteError } from '../remote/errors';

export type ProbeInput = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type ProbeAppCandidate = {
  /** Application slug (the Cloudways `sys_user`). */
  sysUser: string;
  /** Absolute path to the WP install for this app. */
  webRoot: string;
};

export type ProbeOk = {
  ok: true;
  /** Picked candidate. Only populated when exactly one app was found. */
  webRoot: string;
  sysUser: string;
  wpCliAvailable: boolean;
  detectedSiteUrl: string | null;
  phpVersion: string | null;
  /**
   * All candidates discovered. When `length > 1` the form must surface
   * a picker; the caller can then re-run the probe with `pickedSysUser`
   * (or just use the picked entry directly without re-probing).
   */
  candidates: ProbeAppCandidate[];
};

export type ProbeErrorCode =
  | 'SSH_AUTH_FAILED'
  | 'SSH_NETWORK'
  | 'SSH_TIMEOUT'
  | 'SSH_CLOSED'
  | 'SFTP_MULTIPLE_APPS'
  | 'WP_NOT_FOUND'
  | 'UNKNOWN';

export type ProbeError = {
  ok: false;
  code: ProbeErrorCode;
  message: string;
  /** Only set when `code === 'SFTP_MULTIPLE_APPS'`. */
  candidates?: ProbeAppCandidate[];
};

export type ProbeResult = ProbeOk | ProbeError;

export type ProbeOptions = {
  /** Inject a custom SshClient factory for tests. */
  sshFactory?: (input: ProbeInput) => SshClient;
  /** Pre-pick one of the discovered candidates by sys_user. */
  pickedSysUser?: string;
  /** Override the SSH ready-timeout (default uses SshClient default). */
  readyTimeoutMs?: number;
};

const DEFAULT_READY_TIMEOUT_MS = 15_000;

export async function probeSftp(
  input: ProbeInput,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const ssh = opts.sshFactory
    ? opts.sshFactory(input)
    : new SshClient({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      });

  try {
    try {
      await ssh.connect();
    } catch (err) {
      return classifyProbeError(err);
    }

    // Discover candidate apps. Cloudways layouts:
    //   master user → /home/master/applications/<sys>/public_html
    //   app sys_user → /home/<sys>/public_html
    let candidates: ProbeAppCandidate[];
    try {
      candidates = await discoverCandidates(ssh, input.username);
    } catch (err) {
      return classifyProbeError(err);
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        code: 'WP_NOT_FOUND',
        message:
          'No WordPress install was found. Looked under applications/*/public_html/wp-config.php and ~/public_html/wp-config.php.',
      };
    }

    let picked: ProbeAppCandidate;
    if (opts.pickedSysUser) {
      const match = candidates.find((c) => c.sysUser === opts.pickedSysUser);
      if (!match) {
        return {
          ok: false,
          code: 'WP_NOT_FOUND',
          message: `Picked app "${opts.pickedSysUser}" was not found among the user's apps.`,
          candidates,
        };
      }
      picked = match;
    } else if (candidates.length > 1) {
      return {
        ok: false,
        code: 'SFTP_MULTIPLE_APPS',
        message:
          'This SFTP user has access to more than one WordPress app. Pick which one to link.',
        candidates,
      };
    } else {
      picked = candidates[0]!;
    }

    const phpVersion = await safeCapture(ssh, 'php -v');
    const wpCliCheck = await ssh.exec('wp --info --path=' + shellQuote(picked.webRoot)).catch(
      (err) => err,
    );

    let wpCliAvailable = false;
    let detectedSiteUrl: string | null = null;
    if (wpCliCheck && typeof wpCliCheck === 'object' && 'code' in wpCliCheck) {
      wpCliAvailable = (wpCliCheck as { code: number }).code === 0;
    }
    if (wpCliAvailable) {
      const siteUrlOut = await safeCapture(
        ssh,
        `wp option get siteurl --skip-themes --skip-plugins --path=${shellQuote(picked.webRoot)}`,
      );
      detectedSiteUrl = siteUrlOut?.trim() || null;
    }

    return {
      ok: true,
      webRoot: picked.webRoot,
      sysUser: picked.sysUser,
      wpCliAvailable,
      detectedSiteUrl,
      phpVersion: parsePhpVersion(phpVersion ?? ''),
      candidates,
    };
  } finally {
    try {
      await ssh.end();
    } catch {
      /* ignore */
    }
  }
}

// --- helpers ----------------------------------------------------------

async function discoverCandidates(
  ssh: SshClient,
  username: string,
): Promise<ProbeAppCandidate[]> {
  // We try a small set of well-known layouts. Each command prints zero
  // or more matched paths, one per line.
  const homeDir = username === 'master' ? '/home/master' : `/home/${username}`;
  const masterApps = `for d in ${homeDir}/applications/*/public_html; do [ -f "$d/wp-config.php" ] && echo "$d"; done`;
  const appUserHome = `[ -f ${homeDir}/public_html/wp-config.php ] && echo ${homeDir}/public_html || true`;

  const masterRes = await ssh.exec(masterApps).catch(() => null);
  const userRes = await ssh.exec(appUserHome).catch(() => null);

  const lines: string[] = [];
  if (masterRes && masterRes.code === 0) lines.push(...masterRes.stdout.split(/\r?\n/));
  if (userRes && userRes.code === 0) lines.push(...userRes.stdout.split(/\r?\n/));

  const out: ProbeAppCandidate[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.endsWith('/public_html')) continue;
    const sysMatch = /\/applications\/([^/]+)\/public_html$/.exec(line);
    const sysUser = sysMatch ? sysMatch[1]! : username;
    if (out.find((c) => c.webRoot === line)) continue;
    out.push({ webRoot: line, sysUser });
  }
  return out;
}

async function safeCapture(ssh: SshClient, cmd: string): Promise<string | null> {
  try {
    const res = await ssh.exec(cmd, { timeoutMs: 10_000 });
    if (res.code !== 0) return null;
    return res.stdout;
  } catch {
    return null;
  }
}

function parsePhpVersion(stdout: string): string | null {
  const match = /^PHP\s+([\d.]+)/m.exec(stdout);
  return match ? match[1]! : null;
}

function shellQuote(s: string): string {
  // POSIX-safe single-quote escape. Sufficient for the absolute paths
  // we discover (no embedded single quotes expected, but we handle them
  // anyway).
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function classifyProbeError(err: unknown): ProbeError {
  if (err instanceof RemoteError) {
    if (err.code === 'SSH_AUTH_FAILED' || err.code === 'SSH_NETWORK' ||
        err.code === 'SSH_TIMEOUT' || err.code === 'SSH_CLOSED') {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: 'UNKNOWN', message: err.message };
  }
  if (err instanceof Error) {
    return { ok: false, code: 'UNKNOWN', message: err.message };
  }
  return { ok: false, code: 'UNKNOWN', message: String(err) };
}
