import fs from 'node:fs';
import path from 'node:path';
import type { SshClient } from '../remote/SshClient';

/**
 * Remove all job directories under `<userDataDir>/cloudwayssync/jobs/`.
 *
 * Called after every push/pull completes (success or failure) so that
 * leftover staging data from crashed or interrupted runs never piles
 * up. Each invocation wipes every `job_*` directory it finds — the
 * current job's own directory is already deleted by the orchestrator
 * before this runs, so only genuinely stale dirs remain.
 */
export async function sweepStaleJobs(userDataDir: string): Promise<void> {
  const jobsRoot = path.join(userDataDir, 'cloudwayssync', 'jobs');
  let entries: string[];
  try {
    entries = await fs.promises.readdir(jobsRoot);
  } catch {
    return; // directory doesn't exist yet — nothing to sweep
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith('job_'))
      .map((name) =>
        fs.promises.rm(path.join(jobsRoot, name), { recursive: true, force: true }).catch(() => undefined),
      ),
  );
}

/**
 * Remove orphaned `cws-job_*` temp files from the remote server's
 * `private_html/` directory. These are left behind when the app
 * crashes or SSH drops mid-transfer. Safe to call at the start of
 * every job — each job has a unique ID so we won't delete files
 * belonging to the current run.
 */
export async function sweepRemoteTempFiles(
  ssh: SshClient,
  appRootPath: string,
): Promise<void> {
  const dir = `${appRootPath}/private_html`;
  await ssh.exec(
    `find ${dir} -maxdepth 1 -name 'cws-job_*' -mmin +30 -delete 2>/dev/null; true`,
  ).catch(() => undefined);
}

/**
 * Prune remote `.cwsync-snapshots/` to keep only the N most recent
 * snapshots. Each snapshot consists of a `snap-*.tar.gz` and
 * `snap-*.sql.gz` pair; we sort by modification time and remove
 * everything older than the newest `keep` pairs. Pre-undo dirs are
 * also cleaned since they're only needed during the undo operation.
 */
export async function pruneRemoteSnapshots(
  ssh: SshClient,
  appRootPath: string,
  keep = 3,
): Promise<void> {
  const dir = `${appRootPath}/private_html/.cwsync-snapshots`;
  // Remove any leftover pre-undo dirs (legacy or from interrupted undos).
  await ssh.exec(
    `rm -rf ${dir}/pre-undo-* 2>/dev/null; true`,
  ).catch(() => undefined);
  // List snap-*.tar.gz sorted newest-first; remove all but the keep newest.
  // The matching .sql.gz is removed alongside each .tar.gz.
  const tailN = keep + 1;
  await ssh.exec(
    `ls -t ${dir}/snap-*.tar.gz 2>/dev/null | tail -n +${tailN} | while read f; do ` +
      'rm -f "$f" "${f%.tar.gz}.sql.gz"; done; true',
  ).catch(() => undefined);
  // Remove the dir itself if empty.
  await ssh.exec(`rmdir ${dir} 2>/dev/null; true`).catch(() => undefined);
}

/**
 * Remove local snapshot mirrors older than the newest `keep` entries
 * per site. Lives under `<userDataDir>/cloudwayssync/snapshots/<siteId>/`.
 */
export async function sweepLocalSnapshots(
  userDataDir: string,
  keep = 3,
): Promise<void> {
  const snapshotsRoot = path.join(userDataDir, 'cloudwayssync', 'snapshots');
  let siteIds: string[];
  try {
    siteIds = await fs.promises.readdir(snapshotsRoot);
  } catch {
    return;
  }
  for (const siteId of siteIds) {
    const siteDir = path.join(snapshotsRoot, siteId);
    let jobs: string[];
    try {
      jobs = await fs.promises.readdir(siteDir);
    } catch {
      continue;
    }
    // Sort by directory mtime, newest first.
    const withMtime = await Promise.all(
      jobs.map(async (name) => {
        const full = path.join(siteDir, name);
        const st = await fs.promises.stat(full).catch(() => null);
        return { name, mtime: st?.mtimeMs ?? 0 };
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const stale = withMtime.slice(keep);
    await Promise.all(
      stale.map((s) =>
        fs.promises.rm(path.join(siteDir, s.name), { recursive: true, force: true }).catch(() => undefined),
      ),
    );
    // Remove the site dir itself if now empty.
    try {
      await fs.promises.rmdir(siteDir);
    } catch {
      /* not empty — fine */
    }
  }
}
