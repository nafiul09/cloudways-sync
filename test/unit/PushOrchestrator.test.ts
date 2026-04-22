import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushOrchestrator, type ExecLocalFn } from '../../src/main/sync/PushOrchestrator';
import { UndoLedger } from '../../src/main/sync/UndoLedger';
import type { PushPlan } from '../../src/main/sync/types';
import type { ApiClient } from '../../src/main/cloudways/ApiClient';
import type { SftpClient } from '../../src/main/remote/SftpClient';
import type { SshClient } from '../../src/main/remote/SshClient';

const tmpRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpRoots.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-push-test-'));
  tmpRoots.push(dir);
  return dir;
}

function makePlan(overrides?: Partial<PushPlan>): PushPlan {
  return {
    id: 'push_test',
    serverId: 1,
    appId: 10,
    localSiteId: 'local-1',
    localUrl: 'http://mysite.local',
    webRootPath: '/tmp/fake-webroot', // overridden in tests
    includes: {
      database: true,
      wpContent: true,
      uploads: true,
      plugins: true,
      themes: true,
      muPlugins: true,
      languages: true,
    },
    createdAt: new Date().toISOString(),
    steps: [],
    ...overrides,
  };
}

function makeClient(): ApiClient {
  return {
    listServers: vi.fn(async () => [
      {
        id: 1,
        label: 'Server',
        cloud: 'do',
        public_ip: '203.0.113.10',
        apps: [
          {
            id: 10,
            label: 'Remote WP',
            application: 'wordpress',
            app_user: 'appabc',
            sys_user: 'appabc',
          },
        ],
      },
    ]),
    getAppCreds: vi.fn(async () => [{ id: 1, sys_user: 'appabc', password: 'secret' }]),
    triggerAppBackup: vi.fn(async () => 123),
    waitForOperation: vi.fn(async () => ({
      id: 123,
      status: 'Completed',
      is_completed: 1,
    })),
    purgeVarnish: vi.fn(async () => undefined),
  } as unknown as ApiClient;
}

class FakeSsh {
  readonly commands: string[] = [];
  connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    this.commands.push(command);
    if (command.includes('option get home')) return { code: 0, stdout: 'https://example.com\n', stderr: '' };
    if (command.includes('option get siteurl')) return { code: 0, stdout: 'https://example.com\n', stderr: '' };
    if (command.includes('core version')) return { code: 0, stdout: '6.5.0\n', stderr: '' };
    if (command.includes('core is-installed --network')) return { code: 1, stdout: '', stderr: '' };
    if (command.startsWith('gzip -df')) return { code: 0, stdout: '', stderr: '' };
    if (command.includes('db import')) return { code: 0, stdout: '', stderr: '' };
    if (command.includes('search-replace')) return { code: 0, stdout: '', stderr: '' };
    if (command.includes('cache flush')) return { code: 0, stdout: '', stderr: '' };
    if (command.includes('rewrite flush')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('tar xzf')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('rm -f')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }

  async end(): Promise<void> {
    this.connected = false;
  }
}

class FakeSftp {
  connected = false;
  uploads: Array<{ localPath: string; remotePath: string }> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath });
  }

  async end(): Promise<void> {
    this.connected = false;
  }
}

/** Fake execLocal that creates the expected output files instead of
 * running real wp-cli/tar/gzip commands. */
function fakeExecLocal(): ExecLocalFn {
  return async (cmd: string, args: string[]) => {
    if (cmd === 'wp' && args.includes('db') && args.includes('export')) {
      // Create a fake SQL file at the output path
      const outPath = args[2] as string;
      await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
      await fs.promises.writeFile(outPath, 'CREATE TABLE wp_options (id int);');
    } else if (cmd === 'gzip' && args.includes('-f')) {
      // Gzip the file in-place
      const filePath = args[1] as string;
      const content = await fs.promises.readFile(filePath);
      await fs.promises.writeFile(filePath + '.gz', zlib.gzipSync(content));
      await fs.promises.unlink(filePath);
    } else if (cmd === 'tar' && args.includes('czf')) {
      // Create a fake tar.gz at the output path
      const outPath = args[1] as string;
      await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
      await fs.promises.writeFile(outPath, zlib.gzipSync('fake-archive'));
    }
    return { stdout: '', stderr: '' };
  };
}

/** Create a local webroot with wp-content and a SQL dump for push tests. */
function createLocalWebroot(): string {
  const dir = tmpDir();
  const wpContent = path.join(dir, 'wp-content', 'themes', 'twentytwentyfour');
  fs.mkdirSync(wpContent, { recursive: true });
  fs.writeFileSync(path.join(wpContent, 'style.css'), 'theme');
  fs.mkdirSync(path.join(dir, 'wp-content', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wp-content', 'plugins', 'hello.php'), '<?php // Hello');
  return dir;
}

describe('PushOrchestrator', () => {
  it('runs the push sequence and records an undo entry', async () => {
    const userDataDir = tmpDir();
    const webRootPath = createLocalWebroot();
    const fakeSsh = new FakeSsh();
    const fakeSftp = new FakeSftp();
    const undoLedger = new UndoLedger(userDataDir);
    const progress: string[] = [];

    const orchestrator = new PushOrchestrator({
      client: makeClient(),
      undoLedger,
      userDataDir,
      sshFactory: () => fakeSsh as unknown as SshClient,
      sftpFactory: () => fakeSftp as unknown as SftpClient,
      execLocal: fakeExecLocal(),
      emitProgress: (event) => progress.push(`${event.stepId}:${event.status}`),
    });

    const result = await orchestrator.run(makePlan({ webRootPath }));

    expect(result).toMatchObject({ status: 'success' });

    // Verify SSH commands ran correctly
    expect(fakeSsh.commands.some((cmd) => cmd.includes('option get home'))).toBe(true);
    // DB-related: gunzip + db import + search-replace ran
    expect(fakeSsh.commands.some((cmd) => cmd.startsWith('gzip -df'))).toBe(true);
    expect(fakeSsh.commands.some((cmd) => cmd.includes('db import'))).toBe(true);
    expect(fakeSsh.commands.some((cmd) => cmd.includes('search-replace'))).toBe(true);
    // wp-content tar extraction ran on server
    expect(fakeSsh.commands.some((cmd) => cmd.startsWith('tar xzf'))).toBe(true);
    // Cache flush ran
    expect(fakeSsh.commands.some((cmd) => cmd.includes('cache flush'))).toBe(true);
    // Cleanup ran
    expect(fakeSsh.commands.some((cmd) => cmd.startsWith('rm -f'))).toBe(true);

    // SFTP uploaded DB dump + wp-content archive
    expect(fakeSftp.uploads).toHaveLength(2);
    expect(fakeSftp.uploads[0]?.remotePath).toContain('.sql.gz');
    expect(fakeSftp.uploads[1]?.remotePath).toContain('wpcontent.tar.gz');

    // Progress events were emitted
    expect(progress).toContain('validate:success');
    expect(progress).toContain('remote-backup:success');
    expect(progress).toContain('ssh:success');
    expect(progress).toContain('upload-db:success');
    expect(progress).toContain('upload-content:success');
    expect(progress).toContain('remote-db-import:success');
    expect(progress).toContain('search-replace:success');
    expect(progress).toContain('cache-flush:success');
    expect(progress).toContain('cleanup:success');

    // Undo record was persisted
    const records = await undoLedger.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.appId).toBe(10);
    expect(records[0]?.targetUrl).toBe('https://example.com');
    expect(records[0]?.sourceUrl).toBe('http://mysite.local');
  });

  it('skips DB steps when database is unchecked', async () => {
    const userDataDir = tmpDir();
    const webRootPath = createLocalWebroot();
    const fakeSsh = new FakeSsh();
    const fakeSftp = new FakeSftp();
    const undoLedger = new UndoLedger(userDataDir);
    const progress: string[] = [];

    const orchestrator = new PushOrchestrator({
      client: makeClient(),
      undoLedger,
      userDataDir,
      sshFactory: () => fakeSsh as unknown as SshClient,
      sftpFactory: () => fakeSftp as unknown as SftpClient,
      execLocal: fakeExecLocal(),
      emitProgress: (event) => progress.push(`${event.stepId}:${event.status}`),
    });

    const plan = makePlan({
      webRootPath,
      includes: {
        database: false,
        wpContent: true,
        uploads: true,
        plugins: true,
        themes: true,
        muPlugins: true,
        languages: true,
      },
    });
    const result = await orchestrator.run(plan);

    expect(result.status).toBe('success');
    // DB steps should be skipped
    expect(progress).toContain('local-export-db:skipped');
    expect(progress).toContain('upload-db:skipped');
    expect(progress).toContain('remote-db-import:skipped');
    expect(progress).toContain('search-replace:skipped');
    // No db import or search-replace commands on SSH
    expect(fakeSsh.commands.every((cmd) => !cmd.includes('db import'))).toBe(true);
    expect(fakeSsh.commands.every((cmd) => !cmd.includes('search-replace'))).toBe(true);
    // wp-content should still be uploaded
    expect(fakeSftp.uploads).toHaveLength(1);
    expect(fakeSftp.uploads[0]?.remotePath).toContain('wpcontent.tar.gz');
    expect(progress).toContain('upload-content:success');
  });

  it('skips wp-content when wpContent is unchecked', async () => {
    const userDataDir = tmpDir();
    const webRootPath = createLocalWebroot();
    const fakeSsh = new FakeSsh();
    const fakeSftp = new FakeSftp();
    const undoLedger = new UndoLedger(userDataDir);
    const progress: string[] = [];

    const orchestrator = new PushOrchestrator({
      client: makeClient(),
      undoLedger,
      userDataDir,
      sshFactory: () => fakeSsh as unknown as SshClient,
      sftpFactory: () => fakeSftp as unknown as SftpClient,
      execLocal: fakeExecLocal(),
      emitProgress: (event) => progress.push(`${event.stepId}:${event.status}`),
    });

    const plan = makePlan({
      webRootPath,
      includes: {
        database: true,
        wpContent: false,
        uploads: false,
        plugins: false,
        themes: false,
        muPlugins: false,
        languages: false,
      },
    });
    const result = await orchestrator.run(plan);

    expect(result.status).toBe('success');
    expect(progress).toContain('upload-content:skipped');
    // DB should still run
    expect(progress).toContain('upload-db:success');
    expect(progress).toContain('remote-db-import:success');
    // No tar extraction should have run on server
    expect(fakeSsh.commands.every((cmd) => !cmd.startsWith('tar xzf'))).toBe(true);
    // Only DB dump uploaded, no content archive
    expect(fakeSftp.uploads).toHaveLength(1);
    expect(fakeSftp.uploads[0]?.remotePath).toContain('.sql.gz');
  });
});
