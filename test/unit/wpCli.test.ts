import { describe, expect, it } from 'vitest';
import {
  buildWpCommand,
  cloudwaysAppPublicPath,
  shellQuote,
  wpCli,
  wpCliJson,
  wpOptionGet,
} from '@main/remote/wpCli';
import type { SshClient, ExecResult } from '@main/remote/SshClient';
import { RemoteError } from '@main/remote/errors';

// A minimal SshClient stub we can feed scripted exec results.
function fakeSsh(exec: (cmd: string) => ExecResult | Promise<ExecResult>): SshClient {
  return {
    async exec(cmd: string): Promise<ExecResult> {
      return Promise.resolve(exec(cmd));
    },
  } as unknown as SshClient;
}

describe('shellQuote', () => {
  it('leaves safe strings untouched', () => {
    expect(shellQuote('foo')).toBe('foo');
    expect(shellQuote('foo/bar_baz.php')).toBe('foo/bar_baz.php');
  });
  it('quotes strings with shell metacharacters', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
    expect(shellQuote(';rm -rf /')).toBe("';rm -rf /'");
  });
  it('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('cloudwaysAppPublicPath', () => {
  it('formats the canonical path', () => {
    expect(cloudwaysAppPublicPath('abcdef')).toBe(
      '/home/master/applications/abcdef/public_html',
    );
  });
});

describe('buildWpCommand', () => {
  it('cds into the install path and runs wp with --path=.', () => {
    const cmd = buildWpCommand('/home/master/applications/u/public_html', ['option', 'get', 'home']);
    expect(cmd).toBe(
      "cd /home/master/applications/u/public_html && wp --path=. option get home",
    );
  });

  it('escapes args containing spaces', () => {
    const cmd = buildWpCommand('/app', ['search-replace', 'foo bar', 'baz qux']);
    expect(cmd).toBe(
      "cd /app && wp --path=. search-replace 'foo bar' 'baz qux'",
    );
  });
});

describe('wpCli', () => {
  it('returns ExecResult on zero exit', async () => {
    const ssh = fakeSsh(() => ({ code: 0, stdout: 'https://example.com\n', stderr: '' }));
    const res = await wpCli({ ssh, appPublicPath: '/app' }, ['option', 'get', 'home']);
    expect(res.stdout).toBe('https://example.com\n');
  });

  it('throws WPCLI_FAILED on non-zero exit', async () => {
    const ssh = fakeSsh(() => ({ code: 1, stdout: '', stderr: 'error: not installed' }));
    await expect(
      wpCli({ ssh, appPublicPath: '/app' }, ['option', 'get', 'home']),
    ).rejects.toMatchObject({ code: 'WPCLI_FAILED' });
  });

  it('throws WPCLI_NOT_INSTALLED when shell reports command not found', async () => {
    const ssh = fakeSsh(() => ({ code: 127, stdout: '', stderr: 'bash: wp: command not found' }));
    await expect(
      wpCli({ ssh, appPublicPath: '/app' }, ['--info']),
    ).rejects.toMatchObject({ code: 'WPCLI_NOT_INSTALLED' });
  });
});

describe('wpCliJson', () => {
  it('parses stdout as JSON', async () => {
    const ssh = fakeSsh(() => ({
      code: 0,
      stdout: '{"siteurl":"https://ex.com","home":"https://ex.com"}\n',
      stderr: '',
    }));
    const json = await wpCliJson<{ siteurl: string; home: string }>(
      { ssh, appPublicPath: '/app' },
      ['option', 'list', '--format=json'],
    );
    expect(json.siteurl).toBe('https://ex.com');
  });

  it('throws on invalid JSON', async () => {
    const ssh = fakeSsh(() => ({ code: 0, stdout: 'not json', stderr: '' }));
    await expect(
      wpCliJson({ ssh, appPublicPath: '/app' }, ['option', 'get', 'x']),
    ).rejects.toBeInstanceOf(RemoteError);
  });
});

describe('wpOptionGet', () => {
  it('returns trimmed stdout', async () => {
    const ssh = fakeSsh((cmd) => {
      expect(cmd).toContain('option get home');
      return { code: 0, stdout: 'https://blog.example/\n', stderr: '' };
    });
    const home = await wpOptionGet({ ssh, appPublicPath: '/app' }, 'home');
    expect(home).toBe('https://blog.example/');
  });
});
