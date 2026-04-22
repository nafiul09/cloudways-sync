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

function makePlan(): PullPlan {
  return {
    id: 'pull_test',
    serverId: 1,
    appId: 10,
    destinationName: 'Pulled Site',
    includes: { database: true, wpContent: true },
    createdAt: new Date().toISOString(),
    steps: [],
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
    if (command.startsWith('rm -f')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }

  async end(): Promise<void> {
    this.connected = false;
  }
}

class FakeSftp {
  constructor(private readonly gzipBody: Buffer) {}
  connected = false;
  downloads: Array<{ remotePath: string; localPath: string }> = [];
  mirrors: Array<{ remotePath: string; localPath: string }> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    this.downloads.push({ remotePath, localPath });
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await fs.promises.writeFile(localPath, this.gzipBody);
  }

  async mirror(remotePath: string, localPath: string): Promise<void> {
    this.mirrors.push({ remotePath, localPath });
    await fs.promises.mkdir(path.join(localPath, 'themes', 'twentytwentyfour'), { recursive: true });
    await fs.promises.writeFile(path.join(localPath, 'themes', 'twentytwentyfour', 'style.css'), 'theme');
  }

  async end(): Promise<void> {
    this.connected = false;
  }
}

describe('PullOrchestrator', () => {
  it('runs the Phase 5 pull sequence and writes a manifest', async () => {
    const userDataDir = tmpDir();
    const fakeSsh = new FakeSsh();
    const fakeSftp = new FakeSftp(zlib.gzipSync('CREATE TABLE wp_options (id int);'));
    const importer: SiteImporter = {
      importPulledSite: vi.fn(async (input) => {
        expect(input.siteName).toBe('Pulled Site');
        expect(input.sourceUrl).toBe('https://example.com');
        expect(input.dbDumpPath.endsWith('.sql.gz')).toBe(true);
        expect(fs.existsSync(path.join(input.wpContentPath, 'themes', 'twentytwentyfour', 'style.css'))).toBe(true);
        expect(fs.existsSync(input.manifestPath)).toBe(true);
        return { localSiteId: 'local-1', localUrl: 'http://pulled-site.local' };
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
    expect(fakeSftp.downloads).toHaveLength(1);
    expect(fakeSftp.downloads[0]?.remotePath).toBe('private_html/cws-job_pull_test.sql.gz');
    expect(fakeSftp.mirrors).toHaveLength(1);
    expect(fakeSftp.mirrors[0]?.remotePath).toBe('public_html/wp-content');
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
});
