import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { SftpClient, type Ssh2SftpClientLike } from '@main/remote/SftpClient';

// --- In-memory fake remote filesystem --------------------------------
//
// A tree is described as nested objects: strings are file contents,
// objects are directories. This is enough for mirror/download tests.

type FileTree = { [name: string]: string | FileTree };

function isFile(v: string | FileTree): v is string {
  return typeof v === 'string';
}

function resolve(tree: FileTree, pathSegments: string[]): string | FileTree | undefined {
  let cur: string | FileTree = tree;
  for (const seg of pathSegments) {
    if (seg === '') continue;
    if (isFile(cur)) return undefined;
    if (!(seg in cur)) return undefined;
    cur = (cur as FileTree)[seg] as string | FileTree;
  }
  return cur;
}

class FakeSftp extends EventEmitter implements Ssh2SftpClientLike {
  constructor(private readonly tree: FileTree) {
    super();
  }
  async connect(): Promise<void> {
    return;
  }
  async end(): Promise<void> {
    return;
  }
  async exists(remotePath: string): Promise<false | 'd' | '-' | 'l'> {
    const n = resolve(this.tree, remotePath.split('/'));
    if (n === undefined) return false;
    return isFile(n) ? '-' : 'd';
  }
  async list(remotePath: string): Promise<Array<{ name: string; type: string; size: number; modifyTime: number }>> {
    const n = resolve(this.tree, remotePath.split('/'));
    if (!n || isFile(n)) throw new Error(`list: No such file: ${remotePath}`);
    return Object.entries(n).map(([name, v]) => ({
      name,
      type: isFile(v) ? '-' : 'd',
      size: isFile(v) ? v.length : 0,
      modifyTime: 0,
    }));
  }
  async mkdir(_remotePath: string, _recursive?: boolean): Promise<string> {
    return 'ok';
  }
  async stat(remotePath: string): Promise<{ size: number; modifyTime: number; isDirectory: boolean; isFile: boolean }> {
    const n = resolve(this.tree, remotePath.split('/'));
    if (n === undefined) throw new Error(`stat: No such file: ${remotePath}`);
    const file = isFile(n);
    return {
      size: file ? (n as string).length : 0,
      modifyTime: 0,
      isDirectory: !file,
      isFile: file,
    };
  }
  async get(remotePath: string, local: string | NodeJS.WritableStream): Promise<unknown> {
    const n = resolve(this.tree, remotePath.split('/'));
    if (n === undefined || !isFile(n)) throw new Error(`get: No such file: ${remotePath}`);
    if (typeof local === 'string') {
      await fs.promises.writeFile(local, n, 'utf8');
    } else {
      await new Promise<void>((res, rej) => {
        (local as Writable).write(Buffer.from(n, 'utf8'), (err) => (err ? rej(err) : res()));
      });
      (local as Writable).end?.();
    }
    return undefined;
  }
  async put(_local: unknown, _remotePath: string): Promise<unknown> {
    return undefined;
  }
  off(event: string, cb: (...args: unknown[]) => void): this {
    this.removeListener(event, cb);
    return this;
  }
}

function sftp(tree: FileTree): SftpClient {
  return new SftpClient(
    { host: 'h', username: 'u', password: 'p' },
    { clientFactory: () => new FakeSftp(tree) },
  );
}

// --- Tests -----------------------------------------------------------

describe('SftpClient', () => {
  it('connects + ends without error', async () => {
    const c = sftp({});
    await c.connect();
    expect(c.connected).toBe(true);
    await c.end();
    expect(c.connected).toBe(false);
  });

  it('exists() distinguishes file / dir / missing', async () => {
    const c = sftp({ app: { 'wp-config.php': 'contents' } });
    await c.connect();
    expect(await c.exists('app/wp-config.php')).toBe('-');
    expect(await c.exists('app')).toBe('d');
    expect(await c.exists('nope')).toBe(false);
  });

  it('list() returns entries with type + size', async () => {
    const c = sftp({ app: { 'a.txt': 'xx', 'b': {} } });
    await c.connect();
    const entries = await c.list('app');
    const aTxt = entries.find((e) => e.name === 'a.txt');
    const bDir = entries.find((e) => e.name === 'b');
    expect(aTxt).toMatchObject({ type: 'file', size: 2 });
    expect(bDir).toMatchObject({ type: 'directory' });
  });

  it('download() writes the file to disk', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-test-'));
    const c = sftp({ 'wp-config.php': 'define("DB", "x");' });
    await c.connect();
    const localPath = path.join(tmp, 'wp-config.php');
    await c.download('wp-config.php', localPath);
    const content = await fs.promises.readFile(localPath, 'utf8');
    expect(content).toBe('define("DB", "x");');
    await c.end();
    await fs.promises.rm(tmp, { recursive: true });
  });

  it('mirror() recursively copies a tree with glob filter', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-mirror-'));
    const c = sftp({
      'wp-content': {
        uploads: {
          '2024': {
            'photo.jpg': 'binarydata',
          },
        },
        plugins: {
          hello: {
            'hello.php': '<?php',
          },
        },
      },
    });
    await c.connect();
    await c.mirror('wp-content', tmp, { include: ['uploads/**'] });
    const uploaded = await fs.promises.readFile(
      path.join(tmp, 'uploads', '2024', 'photo.jpg'),
      'utf8',
    );
    expect(uploaded).toBe('binarydata');
    // plugins/ should be empty (no plugins matched the include filter)
    const pluginContent = await fs.promises.readdir(path.join(tmp, 'plugins', 'hello')).catch(() => []);
    expect(pluginContent).toEqual([]);
    await c.end();
    await fs.promises.rm(tmp, { recursive: true });
  });

  it('readFile() returns utf8 string', async () => {
    const c = sftp({ 'home.txt': 'https://example.com' });
    await c.connect();
    const s = await c.readFile('home.txt');
    expect(s).toBe('https://example.com');
    await c.end();
  });
});
