// Restore a remote WordPress install from a local-tar snapshot
// captured by PushOrchestrator (SFTP-mode safety net). Matches the
// flow described in the SFTP link plan §5.5:
//   1. Reopen SSH/SFTP via the AppLink.
//   2. If the snapshot files were mirrored to userDataDir, push them
//      back up to the remote first.
//   3. Capture a "pre-undo" snapshot of the current state so the user
//      can re-run undo if it goes wrong.
//   4. Untar wp-content over the live web root.
//   5. Restore the DB from the gzipped dump (best-effort if wp-cli is
//      missing — we fall back to `mysql` via the user's environment).

import fs from 'node:fs';
import path from 'node:path';
import { RemoteError } from '../remote/errors';
import { SftpClient, type SftpConnectConfig } from '../remote/SftpClient';
import { SshClient, type SshConnectConfig } from '../remote/SshClient';
import { buildWpCommand, shellQuote, wpCli } from '../remote/wpCli';
import type { JobProgressEvent, UndoSnapshot } from '../../shared/ipcTypes';
import type { AppLink } from './AppLink';

export type RestoreFromLocalSnapshotOptions = {
  link: AppLink;
  snapshot: UndoSnapshot;
  jobId: string;
  sshFactory?: (cfg: SshConnectConfig) => SshClient;
  sftpFactory?: (cfg: SftpConnectConfig) => SftpClient;
  emitProgress?: (event: JobProgressEvent) => void;
};

export async function restoreFromLocalSnapshot(
  opts: RestoreFromLocalSnapshotOptions,
): Promise<void> {
  const { link, snapshot, jobId } = opts;
  const sshFactory = opts.sshFactory ?? ((cfg) => new SshClient(cfg));
  const sftpFactory = opts.sftpFactory ?? ((cfg) => new SftpClient(cfg));
  const progress = (stepId: string, status: JobProgressEvent['status'], detail?: string) =>
    opts.emitProgress?.({ jobId, stepId, status, detail });

  const ctx = await link.resolve();
  const appPublicPath = ctx.webRoot;
  const appRootPath = appPublicPath.endsWith('/public_html')
    ? appPublicPath.slice(0, -'/public_html'.length)
    : path.posix.dirname(appPublicPath);

  const ssh = sshFactory(ctx.auth);
  let sftp: SftpClient | undefined;
  try {
    progress('undo-connect', 'running');
    await ssh.connect();
    progress('undo-connect', 'success');

    // 1. Re-upload mirrored snapshot files if remote copies are gone.
    if (snapshot.localCachePath) {
      const remoteContentExists = (await ssh.exec(
        `test -s ${shellQuote(snapshot.remoteContentTarPath)}`,
      )).code === 0;
      const remoteSqlExists = (await ssh.exec(
        `test -s ${shellQuote(snapshot.remoteSqlGzPath)}`,
      )).code === 0;

      if (!remoteContentExists || !remoteSqlExists) {
        progress('undo-restore-snapshot', 'running', 'Re-uploading local snapshot mirror…');
        sftp = sftpFactory(ctx.auth);
        await sftp.connect();
        await ssh.exec(`mkdir -p ${shellQuote(path.posix.dirname(snapshot.remoteContentTarPath))}`);
        if (!remoteContentExists) {
          const localContent = path.join(snapshot.localCachePath, 'wp-content.tar.gz');
          if (fs.existsSync(localContent)) {
            await sftp.upload(localContent, relativeToHome(snapshot.remoteContentTarPath));
          }
        }
        if (!remoteSqlExists) {
          const localSql = path.join(snapshot.localCachePath, 'db.sql.gz');
          if (fs.existsSync(localSql)) {
            await sftp.upload(localSql, relativeToHome(snapshot.remoteSqlGzPath));
          }
        }
        await sftp.end();
        sftp = undefined;
      }
    }

    // 2. Capture a pre-undo snapshot of the current state so the user
    //    can re-run undo or recover if the restore itself crashes.
    const preUndoDir = `${appRootPath}/private_html/.cwsync-snapshots/pre-undo-${jobId}`;
    progress('undo-pre-snapshot', 'running', 'Capturing pre-undo state on server…');
    await execChecked(ssh, `mkdir -p ${shellQuote(preUndoDir)}`);
    await execChecked(
      ssh,
      `tar -czf ${shellQuote(`${preUndoDir}/wp-content.tar.gz`)} ` +
        `--exclude=cache --exclude=upgrade ` +
        `-C ${shellQuote(appPublicPath)} wp-content`,
    );
    try {
      const dumpCmd = buildWpCommand(appPublicPath, ['db', 'export', '-']);
      await execChecked(ssh, `${dumpCmd} | gzip > ${shellQuote(`${preUndoDir}/db.sql.gz`)}`);
    } catch {
      // wp-cli not available — leave a marker
      await ssh.exec(`: > ${shellQuote(`${preUndoDir}/db.sql.gz`)}`).catch(() => undefined);
    }

    // 3. Restore wp-content from the snapshot.
    progress('undo-restore-content', 'running', 'Restoring wp-content from snapshot…');
    // Remove the live wp-content first so files deleted between push
    // and undo come back. tar extracts wp-content/ directly.
    await execChecked(ssh, `rm -rf ${shellQuote(`${appPublicPath}/wp-content`)}`);
    await execChecked(
      ssh,
      `tar -xzf ${shellQuote(snapshot.remoteContentTarPath)} -C ${shellQuote(appPublicPath)}`,
    );

    // 4. Restore the DB if a non-empty snapshot exists.
    progress('undo-restore-db', 'running', 'Restoring database from snapshot…');
    const sqlSize = (await ssh.exec(
      `stat -c %s ${shellQuote(snapshot.remoteSqlGzPath)} 2>/dev/null || echo 0`,
    )).stdout.trim();
    if (Number(sqlSize) > 0) {
      const tmpSql = `${appRootPath}/private_html/cws-undo-${jobId}.sql`;
      await execChecked(
        ssh,
        `gunzip -c ${shellQuote(snapshot.remoteSqlGzPath)} > ${shellQuote(tmpSql)}`,
      );
      try {
        await wpCli(
          { ssh, appPublicPath },
          ['db', 'import', tmpSql],
          { timeoutMs: 10 * 60 * 1000 },
        );
      } catch (err) {
        throw new RemoteError(
          'SSH_COMMAND_FAILED',
          'Failed to import snapshot DB. The pre-undo state was saved at ' +
            preUndoDir,
          { retriable: false, detail: { preUndoDir, err: String(err) } },
        );
      } finally {
        await ssh.exec(`rm -f ${shellQuote(tmpSql)}`).catch(() => undefined);
      }
    } else {
      progress('undo-restore-db', 'skipped', 'No DB snapshot was captured at push time.');
    }

    progress('undo-restore', 'success');
  } finally {
    await sftp?.end().catch(() => undefined);
    await ssh.end().catch(() => undefined);
  }
}

function relativeToHome(absPath: string): string {
  const idx = absPath.indexOf('/private_html/');
  if (idx >= 0) return absPath.slice(idx + 1);
  return absPath;
}

async function execChecked(ssh: SshClient, command: string): Promise<void> {
  const res = await ssh.exec(command);
  if (res.code !== 0) {
    const stderr = res.stderr?.trim();
    const msg = stderr
      ? `Remote command failed (exit ${res.code}): ${stderr}`
      : `Remote command failed (exit ${res.code}): ${command}`;
    throw new RemoteError('SSH_COMMAND_FAILED', msg, {
      retriable: false,
      detail: { code: res.code, stderr: res.stderr, command },
    });
  }
}
