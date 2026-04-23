import fs from 'node:fs';
import path from 'node:path';

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
