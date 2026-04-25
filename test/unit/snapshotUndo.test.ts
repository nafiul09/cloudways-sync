import { describe, expect, it } from 'vitest';
import { restoreFromLocalSnapshot } from '../../src/main/sync/snapshotUndo';
import type { AppLink, ResolvedAppContext } from '../../src/main/sync/AppLink';
import type { SftpSiteMapping, UndoSnapshot } from '../../src/shared/ipcTypes';
import type { SshClient } from '../../src/main/remote/SshClient';
import type { SftpClient } from '../../src/main/remote/SftpClient';

type Exec = (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

function fakeSsh(handler: Exec): SshClient {
  return {
    async connect() { /* noop */ },
    async end() { /* noop */ },
    exec: handler,
    connected: true,
  } as unknown as SshClient;
}

function fakeSftp(): SftpClient {
  return {
    async connect() { /* noop */ },
    async end() { /* noop */ },
    async upload() { /* noop */ },
  } as unknown as SftpClient;
}

const MAPPING: SftpSiteMapping = {
  linkMode: 'sftp',
  localSiteId: 'local-1',
  appLabel: 'cw',
  host: '203.0.113.10',
  port: 22,
  username: 'master',
  webRoot: '/home/master/applications/abc/public_html',
  createdAt: '2026-04-25',
};

function makeLink(ssh: SshClient): AppLink {
  return {
    mode: 'sftp',
    mapping: MAPPING,
    async resolve(): Promise<ResolvedAppContext> {
      return {
        auth: { host: MAPPING.host, port: MAPPING.port, username: MAPPING.username, password: 'pw' },
        webRoot: MAPPING.webRoot as string,
        remoteUrl: null,
      };
    },
  };
}

describe('restoreFromLocalSnapshot', () => {
  it('extracts the snapshot tar over the live web root and re-imports the DB when wp-cli works', async () => {
    const commands: string[] = [];
    const handler: Exec = async (cmd) => {
      commands.push(cmd);
      // Simulate snapshot exists on remote.
      if (cmd.startsWith('test -s')) return { code: 0, stdout: '', stderr: '' };
      if (cmd.includes('stat -c %s')) return { code: 0, stdout: '1024\n', stderr: '' };
      // wp-cli db export pre-undo dump succeeds.
      if (cmd.includes('db export')) return { code: 0, stdout: '', stderr: '' };
      if (cmd.includes('db import')) return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const ssh = fakeSsh(handler);
    const link = makeLink(ssh);
    const snapshot: UndoSnapshot = {
      kind: 'local-tar',
      remoteContentTarPath: '/home/master/applications/abc/private_html/.cwsync-snapshots/snap-job_1.tar.gz',
      remoteSqlGzPath: '/home/master/applications/abc/private_html/.cwsync-snapshots/snap-job_1.sql.gz',
    };
    const events: string[] = [];
    await restoreFromLocalSnapshot({
      link,
      snapshot,
      jobId: 'job_1',
      sshFactory: () => ssh,
      sftpFactory: () => fakeSftp(),
      emitProgress: (e) => events.push(`${e.stepId}:${e.status}`),
    });
    // Wp-content was wiped + extracted.
    expect(commands.some((c) => c.startsWith('rm -rf') && c.includes('/wp-content'))).toBe(true);
    expect(commands.some((c) => c.startsWith('tar -xzf'))).toBe(true);
    // DB restore path: gunzip + db import via wp-cli.
    expect(commands.some((c) => c.startsWith('gunzip -c'))).toBe(true);
    expect(commands.some((c) => c.includes('db import'))).toBe(true);
    expect(events).toContain('undo-restore:success');
  });

  it('skips the DB restore when the snapshot DB dump is empty', async () => {
    const commands: string[] = [];
    const handler: Exec = async (cmd) => {
      commands.push(cmd);
      if (cmd.startsWith('test -s')) return { code: 0, stdout: '', stderr: '' };
      if (cmd.includes('stat -c %s')) return { code: 0, stdout: '0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const ssh = fakeSsh(handler);
    const link = makeLink(ssh);
    const events: string[] = [];
    await restoreFromLocalSnapshot({
      link,
      snapshot: {
        kind: 'local-tar',
        remoteContentTarPath: '/h/private_html/.cwsync-snapshots/snap.tar.gz',
        remoteSqlGzPath: '/h/private_html/.cwsync-snapshots/snap.sql.gz',
      },
      jobId: 'job_2',
      sshFactory: () => ssh,
      sftpFactory: () => fakeSftp(),
      emitProgress: (e) => events.push(`${e.stepId}:${e.status}`),
    });
    expect(commands.every((c) => !c.includes('db import'))).toBe(true);
    expect(events).toContain('undo-restore-db:skipped');
  });

  it('throws when the tar restore command fails on the server', async () => {
    const handler: Exec = async (cmd) => {
      if (cmd.startsWith('test -s')) return { code: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('tar -xzf')) {
        return { code: 2, stdout: '', stderr: 'permission denied' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const ssh = fakeSsh(handler);
    const link = makeLink(ssh);
    await expect(
      restoreFromLocalSnapshot({
        link,
        snapshot: {
          kind: 'local-tar',
          remoteContentTarPath: '/h/private_html/.cwsync-snapshots/snap.tar.gz',
          remoteSqlGzPath: '/h/private_html/.cwsync-snapshots/snap.sql.gz',
        },
        jobId: 'job_3',
        sshFactory: () => ssh,
        sftpFactory: () => fakeSftp(),
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
