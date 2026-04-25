import { describe, expect, it } from 'vitest';
import { probeSftp } from '../../src/main/connection/sftpProbe';
import type { SshClient } from '../../src/main/remote/SshClient';
import { RemoteError } from '../../src/main/remote/errors';

// A scripted fake SshClient: each test sets up a queue of (cmd → result)
// matchers and the fake `exec` walks the queue.

type Scripted = {
  connectError?: RemoteError;
  responses: Array<
    | { match: RegExp; code: number; stdout: string; stderr?: string }
    | { match: RegExp; throw: RemoteError }
  >;
};

function fakeSsh(scripted: Scripted): SshClient {
  return {
    async connect() {
      if (scripted.connectError) throw scripted.connectError;
    },
    async exec(cmd: string) {
      for (const r of scripted.responses) {
        if (r.match.test(cmd)) {
          if ('throw' in r) throw r.throw;
          return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? '' };
        }
      }
      return { code: 1, stdout: '', stderr: 'unmatched: ' + cmd };
    },
    async end() {
      /* noop */
    },
  } as unknown as SshClient;
}

const INPUT = { host: '203.0.113.10', port: 22, username: 'master', password: 'pw' };

describe('probeSftp', () => {
  it('returns SSH_AUTH_FAILED when connect throws an auth error', async () => {
    const ssh = fakeSsh({
      connectError: new RemoteError('SSH_AUTH_FAILED', 'bad password'),
      responses: [],
    });
    const res = await probeSftp(INPUT, { sshFactory: () => ssh });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('SSH_AUTH_FAILED');
    }
  });

  it('returns SSH_NETWORK on network errors', async () => {
    const ssh = fakeSsh({
      connectError: new RemoteError('SSH_NETWORK', 'ECONNREFUSED', { retriable: true }),
      responses: [],
    });
    const res = await probeSftp(INPUT, { sshFactory: () => ssh });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('SSH_NETWORK');
  });

  it('returns WP_NOT_FOUND when no candidates are detected', async () => {
    const ssh = fakeSsh({
      responses: [
        { match: /applications\/\*\/public_html/, code: 0, stdout: '\n' },
        { match: /\/public_html\/wp-config\.php/, code: 0, stdout: '\n' },
      ],
    });
    const res = await probeSftp(INPUT, { sshFactory: () => ssh });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('WP_NOT_FOUND');
  });

  it('auto-picks the single discovered app and returns ok', async () => {
    const ssh = fakeSsh({
      responses: [
        {
          match: /applications\/\*\/public_html/,
          code: 0,
          stdout: '/home/master/applications/abcdef/public_html\n',
        },
        { match: /^php -v/, code: 0, stdout: 'PHP 8.2.10 (cli)\n' },
        { match: /wp --info/, code: 0, stdout: 'WP-CLI 2.10' },
        { match: /wp option get siteurl/, code: 0, stdout: 'https://example.com\n' },
      ],
    });
    const res = await probeSftp(INPUT, { sshFactory: () => ssh });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sysUser).toBe('abcdef');
      expect(res.webRoot).toBe('/home/master/applications/abcdef/public_html');
      expect(res.wpCliAvailable).toBe(true);
      expect(res.detectedSiteUrl).toBe('https://example.com');
      expect(res.phpVersion).toBe('8.2.10');
      expect(res.candidates).toHaveLength(1);
    }
  });

  it('returns SFTP_MULTIPLE_APPS when more than one candidate is found', async () => {
    const ssh = fakeSsh({
      responses: [
        {
          match: /applications\/\*\/public_html/,
          code: 0,
          stdout:
            '/home/master/applications/abcdef/public_html\n' +
            '/home/master/applications/zyxwvu/public_html\n',
        },
      ],
    });
    const res = await probeSftp(INPUT, { sshFactory: () => ssh });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('SFTP_MULTIPLE_APPS');
      expect(res.candidates?.map((c) => c.sysUser)).toEqual(['abcdef', 'zyxwvu']);
    }
  });

  it('honors pickedSysUser to select among multiple candidates', async () => {
    const ssh = fakeSsh({
      responses: [
        {
          match: /applications\/\*\/public_html/,
          code: 0,
          stdout:
            '/home/master/applications/abcdef/public_html\n' +
            '/home/master/applications/zyxwvu/public_html\n',
        },
        { match: /^php -v/, code: 0, stdout: 'PHP 8.1.0\n' },
        { match: /wp --info/, code: 1, stdout: '', stderr: 'wp: not found' },
      ],
    });
    const res = await probeSftp(INPUT, {
      sshFactory: () => ssh,
      pickedSysUser: 'zyxwvu',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sysUser).toBe('zyxwvu');
      expect(res.wpCliAvailable).toBe(false);
      expect(res.detectedSiteUrl).toBeNull();
    }
  });

  it('reports wpCliAvailable=false when wp --info exits non-zero', async () => {
    const ssh = fakeSsh({
      responses: [
        {
          match: /applications\/\*\/public_html/,
          code: 0,
          stdout: '/home/master/applications/abcdef/public_html\n',
        },
        { match: /^php -v/, code: 0, stdout: 'PHP 7.4.0\n' },
        { match: /wp --info/, code: 127, stdout: '', stderr: 'wp: command not found' },
      ],
    });
    const res = await probeSftp(INPUT, { sshFactory: () => ssh });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.wpCliAvailable).toBe(false);
      expect(res.detectedSiteUrl).toBeNull();
    }
  });

  it('dedupes two paths to the same physical app and prefers the applications/ form', async () => {
    // Cloudways exposes each app via both the master's applications/ tree
    // and a domain-named home dir; the same physical directory shows up
    // under two paths. We stat each candidate and dedupe by device:inode.
    const ssh = fakeSsh({
      responses: [
        {
          match: /^for d in "\$HOME"\/applications/,
          code: 0,
          stdout: '/home/123.cloudwaysapps.com/hxkzz/public_html\n',
        },
        {
          match: /^for d in \/home\/master\/applications/,
          code: 0,
          stdout: '/home/master/applications/hxkzz/public_html\n',
        },
        // Both stats hit the same dev:inode -> one logical app.
        { match: /^stat -c.+applications\/hxkzz\/public_html/, code: 0, stdout: '64768:9000001\n' },
        { match: /^stat -c.+cloudwaysapps\.com\/hxkzz\/public_html/, code: 0, stdout: '64768:9000001\n' },
        { match: /^php -v/, code: 0, stdout: 'PHP 8.2.0\n' },
        { match: /wp --info/, code: 0, stdout: 'WP-CLI 2.10' },
        { match: /wp option get siteurl/, code: 0, stdout: 'https://example.com\n' },
      ],
    });
    const res = await probeSftp(
      { ...INPUT, username: 'cwsy_user2121' },
      { sshFactory: () => ssh },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidates).toHaveLength(1);
      expect(res.sysUser).toBe('hxkzz');
      expect(res.webRoot).toBe('/home/master/applications/hxkzz/public_html');
    }
  });

  it('keeps both candidates when their inodes differ (truly distinct apps)', async () => {
    const ssh = fakeSsh({
      responses: [
        {
          match: /applications\/\*\/public_html/,
          code: 0,
          stdout:
            '/home/master/applications/abcdef/public_html\n' +
            '/home/master/applications/zyxwvu/public_html\n',
        },
        { match: /^stat -c.+abcdef\/public_html/, code: 0, stdout: '64768:1111\n' },
        { match: /^stat -c.+zyxwvu\/public_html/, code: 0, stdout: '64768:2222\n' },
      ],
    });
    const res = await probeSftp(INPUT, { sshFactory: () => ssh });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('SFTP_MULTIPLE_APPS');
      expect(res.candidates?.map((c) => c.sysUser).sort()).toEqual(['abcdef', 'zyxwvu']);
    }
  });

  it('discovers an app under the user home (non-master sys_user layout)', async () => {
    const ssh = fakeSsh({
      responses: [
        // No master-style apps.
        { match: /applications\/\*\/public_html/, code: 0, stdout: '\n' },
        // But the user home has a public_html with wp-config.
        {
          match: /\/public_html\/wp-config\.php/,
          code: 0,
          stdout: '/home/abcdef/public_html\n',
        },
        { match: /^php -v/, code: 0, stdout: 'PHP 8.0.0\n' },
        { match: /wp --info/, code: 1, stdout: '', stderr: '' },
      ],
    });
    const res = await probeSftp(
      { ...INPUT, username: 'abcdef' },
      { sshFactory: () => ssh },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sysUser).toBe('abcdef');
      expect(res.webRoot).toBe('/home/abcdef/public_html');
    }
  });
});
