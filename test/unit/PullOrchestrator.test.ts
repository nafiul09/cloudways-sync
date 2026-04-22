import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PullOrchestrator } from '../../src/main/sync/PullOrchestrator';
import type { PullPlan, SiteImporter } from '../../src/main/sync/types';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-pull-test-'));
  tmpRoots.push(dir);
  return dir;
}

function makePlan(overrides?: Partial<PullPlan>): PullPlan {
  return {
    id: 'pull_test',
    serverId: 1,
    appId: 10,
    destinationName: 'Pulled Site',
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
    if (command.includes('db export')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('gzip -f')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('tar czf')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('rm -f')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }

  async end(): Promise<void> {
    this.connected = false;
  }
}

/** Create a real tar.gz containing wp-content/themes/twentytwentyfour/style.css
 * so the orchestrator's `tar xzf` extraction works in the test. */
function createWpContentTarGz(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-tar-'));
  tmpRoots.push(dir);
  const wpContent = path.join(dir, 'wp-content', 'themes', 'twentytwentyfour');
  fs.mkdirSync(wpContent, { recursive: true });
  fs.writeFileSync(path.join(wpContent, 'style.css'), 'theme');
  const tarPath = path.join(dir, 'content.tar.gz');
  execFileSync('tar', ['czf', tarPath, '-C', dir, 'wp-content']);
  return fs.readFileSync(tarPath);
}

class FakeSftp {
  constructor(
    private readonly sqlGzBody: Buffer,
    private readonly wpContentTarGzBody: Buffer,
  ) {}
  connected = false;
  downloads: Array<{ remotePath: string; localPath: string }> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    this.downloads.push({ remotePath, localPath });
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    const body = remotePath.includes('wpcontent.tar.gz')
      ? this.wpContentTarGzBody
      : this.sqlGzBody;
    await fs.promises.writeFile(localPath, body);
  }

  async end(): Promise<void> {
    this.connected = false;
  }
}

describe('PullOrchestrator', () => {
  it('runs the Phase 5 pull sequence and writes a manifest', async () => {
    const userDataDir = tmpDir();
    const fakeSsh = new FakeSsh();
    const fakeSftp = new FakeSftp(
      zlib.gzipSync('CREATE TABLE wp_options (id int);'),
      createWpContentTarGz(),
    );
    const importer: SiteImporter = {
      importPulledSite: vi.fn(async (input) => {
        expect(input.siteName).toBe('Pulled Site');
        expect(input.sourceUrl).toBe('https://example.com');
        expect(input.dbDumpPath.endsWith('.sql.gz')).toBe(true);
        expect(fs.existsSync(path.join(input.wpContentPath, 'themes', 'twentytwentyfour', 'style.css'))).toBe(true);
        expect(fs.existsSync(input.manifestPath)).toBe(true);
        return { localSiteId: 'local-1', localUrl: 'http://pulled-site.local', webRootPath: '/tmp/sites/pulled-site/app/public' };
      }),
    };
    const progress: string[] = [];
    const orchestrator = new PullOrchestrator({
      client: makeClient(),
      importer,
      userDataDir,
      sshFactory: () => fakeSsh as unknown as SshClient,
      sftpFactory: () => fakeSftp as unknown as SftpClient,
      emitProgress: (event) => progress.push(`${event.stepId}:${event.status}`),
    });

    const result = await orchestrator.run(makePlan());

    expect(result).toMatchObject({
      status: 'success',
      localSiteId: 'local-1',
      localUrl: 'http://pulled-site.local',
    });
    expect(fakeSsh.commands.some((cmd) => cmd.includes('db export'))).toBe(true);
    expect(fakeSsh.commands.some((cmd) => cmd.startsWith('gzip -f'))).toBe(true);
    expect(fakeSftp.downloads).toHaveLength(2);
    expect(fakeSftp.downloads[0]?.remotePath).toBe('private_html/cws-job_pull_test.sql.gz');
    expect(fakeSftp.downloads[1]?.remotePath).toBe('private_html/cws-job_pull_test-wpcontent.tar.gz');
    expect(importer.importPulledSite).toHaveBeenCalledOnce();
    expect(progress).toContain('validate:success');
    expect(progress).toContain('local-site:success');

    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath as string, 'utf8')) as {
      sourceUrl: string;
      appId: number;
    };
    expect(manifest.sourceUrl).toBe('https://example.com');
    expect(manifest.appId).toBe(10);
  });

  it('skips DB steps when database is unchecked', async () => {
    const userDataDir = tmpDir();
    const fakeSsh = new FakeSsh();
    const fakeSftp = new FakeSftp(
      zlib.gzipSync('unused'),
      createWpContentTarGz(),
    );
    const importer: SiteImporter = {
      importPulledSite: vi.fn(async (input) => {
        expect(input.importDatabase).toBe(false);
        expect(input.importWpContent).toBe(true);
        return { localSiteId: 'local-2', localUrl: 'http://content-only.local', webRootPath: '/tmp/sites/content-only/app/public' };
      }),
    };
    const progress: string[] = [];
    const orchestrator = new PullOrchestrator({
      client: makeClient(),
      importer,
      userDataDir,
      sshFactory: () => fakeSsh as unknown as SshClient,
      sftpFactory: () => fakeSftp as unknown as SftpClient,
      emitProgress: (event) => progress.push(`${event.stepId}:${event.status}`),
    });

    const plan = makePlan({
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
    expect(progress).toContain('db-export:skipped');
    expect(progress).toContain('download-db:skipped');
    expect(fakeSsh.commands.every((cmd) => !cmd.includes('db export'))).toBe(true);
    // Content steps should still run
    expect(fakeSftp.downloads).toHaveLength(1);
    expect(fakeSftp.downloads[0]?.remotePath).toBe('private_html/cws-job_pull_test-wpcontent.tar.gz');
    expect(progress).toContain('download-content:success');
  });

  it('skips wp-content when wpContent is unchecked', async () => {
    const userDataDir = tmpDir();
    const fakeSsh = new FakeSsh();
    const fakeSftp = new FakeSftp(
      zlib.gzipSync('CREATE TABLE t (id int);'),
      Buffer.alloc(0),
    );
    const importer: SiteImporter = {
      importPulledSite: vi.fn(async (input) => {
        expect(input.importDatabase).toBe(true);
        expect(input.importWpContent).toBe(false);
        return { localSiteId: 'local-3', localUrl: 'http://db-only.local', webRootPath: '/tmp/sites/db-only/app/public' };
      }),
    };
    const progress: string[] = [];
    const orchestrator = new PullOrchestrator({
      client: makeClient(),
      importer,
      userDataDir,
      sshFactory: () => fakeSsh as unknown as SshClient,
      sftpFactory: () => fakeSftp as unknown as SftpClient,
      emitProgress: (event) => progress.push(`${event.stepId}:${event.status}`),
    });

    const plan = makePlan({
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
    expect(progress).toContain('download-content:skipped');
    // DB should still run
    expect(progress).toContain('db-export:success');
    expect(progress).toContain('download-db:success');
    expect(fakeSsh.commands.some((cmd) => cmd.includes('db export'))).toBe(true);
    // No tar command should have run
    expect(fakeSsh.commands.every((cmd) => !cmd.startsWith('tar czf'))).toBe(true);
  });
});
