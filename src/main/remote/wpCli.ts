// wp-cli runner. Runs commands inside a Cloudways app's public_html
// directory, which is the canonical WP-CLI workdir. Cloudways ships
// wp-cli on `PATH` for all managed apps, so we shell out to `wp`
// directly rather than downloading a phar.
//
// Conventions:
//   - App public path: /home/master/applications/<app_user>/public_html
//     (the app_user is the per-app sub-account, not the master SFTP user).
//   - Commands run with `--path=…` to pin the WP install directory;
//     this is more reliable than `cd …` across SFTP shells.
//   - We never pass shell metacharacters; args are shell-escaped.

import type { ExecOptions, ExecResult, SshClient } from './SshClient';
import { WpCliFailed, WpCliNotInstalled } from './errors';

export type WpCliContext = {
  ssh: SshClient;
  /** Absolute path to the app's public_html on the remote host. */
  appPublicPath: string;
};

/** Build the Cloudways canonical public_html path for an app. */
export function cloudwaysAppPublicPath(appUser: string): string {
  return `/home/master/applications/${appUser}/public_html`;
}

/** POSIX-safe single-arg escape. */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[a-zA-Z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** Build a full `wp …` command string with `--path=` and quoted args. */
export function buildWpCommand(appPublicPath: string, args: string[]): string {
  const parts = ['wp', `--path=${shellQuote(appPublicPath)}`, ...args.map(shellQuote)];
  return parts.join(' ');
}

/** Run one wp-cli command. Returns the raw ExecResult. Throws
 * `WpCliFailed` if exit code is non-zero.  Throws
 * `WpCliNotInstalled` if the server complains wp is not on PATH. */
export async function wpCli(
  ctx: WpCliContext,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const cmd = buildWpCommand(ctx.appPublicPath, args);
  const res = await ctx.ssh.exec(cmd, opts);
  if (res.code === 0) return res;
  // wp-cli missing: bash prints "command not found" on stderr with code 127.
  if (res.code === 127 && /not found/i.test(res.stderr)) {
    throw WpCliNotInstalled({ stderr: res.stderr });
  }
  throw WpCliFailed(args, res.code, res.stderr);
}

/** Run wp-cli and parse the stdout as JSON (command should include
 * `--format=json`). Returns typed payload. */
export async function wpCliJson<T = unknown>(
  ctx: WpCliContext,
  args: string[],
  opts: ExecOptions = {},
): Promise<T> {
  const res = await wpCli(ctx, args, opts);
  const trimmed = res.stdout.trim();
  if (!trimmed) return null as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw WpCliFailed(args, 0, `Invalid JSON from wp-cli: ${(err as Error).message}`);
  }
}

/** Convenience: `wp option get <name>`; returns the trimmed stdout. */
export async function wpOptionGet(ctx: WpCliContext, name: string): Promise<string> {
  const res = await wpCli(ctx, ['option', 'get', name]);
  return res.stdout.trimEnd();
}
