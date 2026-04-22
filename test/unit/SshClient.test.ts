import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SshClient, type Ssh2ChannelLike, type Ssh2ClientLike } from '@main/remote/SshClient';
import { RemoteError } from '@main/remote/errors';

// --- Fake ssh2 Client ------------------------------------------------

type Scripted = {
  /** Called in `connect` and delivered asynchronously. */
  onConnect?: 'ready' | 'error' | 'timeout';
  error?: Error;
  exec?: (cmd: string) => FakeChannel;
};

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  end(_?: string | Buffer): this {
    return this;
  }
  emitData(s: string): void {
    this.emit('data', Buffer.from(s, 'utf8'));
  }
  emitStderr(s: string): void {
    this.stderr.emit('data', Buffer.from(s, 'utf8'));
  }
  emitClose(code: number | null): void {
    this.emit('close', code);
  }
}

class FakeClient extends EventEmitter implements Ssh2ClientLike {
  destroyed = false;
  private exec_impl: ((cmd: string) => FakeChannel) | undefined;

  constructor(private readonly scripted: Scripted) {
    super();
    this.exec_impl = scripted.exec;
  }

  connect(_: unknown): this {
    if (this.scripted.onConnect === 'ready') {
      queueMicrotask(() => this.emit('ready'));
    } else if (this.scripted.onConnect === 'error') {
      queueMicrotask(() => this.emit('error', this.scripted.error ?? new Error('boom')));
    }
    // 'timeout' → emit nothing; SshClient should time out.
    return this;
  }

  end(): this {
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  exec(cmd: string, cb: (err: Error | undefined, ch: Ssh2ChannelLike) => void): boolean {
    if (!this.exec_impl) {
      cb(new Error('no exec'), undefined as unknown as Ssh2ChannelLike);
      return true;
    }
    const ch = this.exec_impl(cmd);
    // Attach listeners synchronously first; scripted emits are queued
    // via microtasks inside `exec_impl` and will fire after this
    // function returns.
    cb(undefined, ch as unknown as Ssh2ChannelLike);
    return true;
  }
}

function sshClient(scripted: Scripted): SshClient {
  return new SshClient(
    { host: '1.2.3.4', username: 'admin', password: 'x' },
    { clientFactory: () => new FakeClient(scripted) },
  );
}

// --- Tests -----------------------------------------------------------

describe('SshClient.connect', () => {
  it('resolves when ready is emitted', async () => {
    const c = sshClient({ onConnect: 'ready' });
    await c.connect();
    expect(c.connected).toBe(true);
    await c.end();
  });

  it('translates auth errors to SSH_AUTH_FAILED', async () => {
    const err = Object.assign(new Error('All authentication methods failed'), {
      level: 'client-authentication',
    });
    const c = sshClient({ onConnect: 'error', error: err });
    await expect(c.connect()).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('translates network errors to SSH_NETWORK', async () => {
    const c = sshClient({ onConnect: 'error', error: new Error('ECONNREFUSED') });
    await expect(c.connect()).rejects.toMatchObject({ code: 'SSH_NETWORK' });
  });

  it('times out when the server never emits ready', async () => {
    vi.useFakeTimers();
    const c = new SshClient(
      { host: 'h', username: 'u', password: 'p', readyTimeoutMs: 50 },
      { clientFactory: () => new FakeClient({ onConnect: 'timeout' }) },
    );
    const p = c.connect();
    // Attach the rejection matcher BEFORE advancing timers so the
    // rejection never goes through the "unhandled" state.
    const matcher = expect(p).rejects.toMatchObject({ code: 'SSH_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60);
    await matcher;
    vi.useRealTimers();
  });

  it('is idempotent — concurrent calls only trigger one underlying connect', async () => {
    let connectCount = 0;
    const c = new SshClient(
      { host: 'h', username: 'u', password: 'p' },
      {
        clientFactory: () => {
          const fc = new FakeClient({ onConnect: 'ready' });
          const orig = fc.connect.bind(fc);
          fc.connect = (cfg) => {
            connectCount++;
            return orig(cfg);
          };
          return fc;
        },
      },
    );
    await Promise.all([c.connect(), c.connect()]);
    expect(connectCount).toBe(1);
    expect(c.connected).toBe(true);
    await c.end();
  });
});

describe('SshClient.exec', () => {
  it('captures stdout + stderr + exit code', async () => {
    const ch = new FakeChannel();
    const c = sshClient({
      onConnect: 'ready',
      exec: () => {
        queueMicrotask(() => {
          ch.emitData('hello');
          ch.emitStderr('warn');
          ch.emitClose(0);
        });
        return ch;
      },
    });
    await c.connect();
    const res = await c.exec('echo hello');
    expect(res).toEqual({ code: 0, stdout: 'hello', stderr: 'warn' });
    await c.end();
  });

  it('exposes non-zero exit code without throwing', async () => {
    const ch = new FakeChannel();
    const c = sshClient({
      onConnect: 'ready',
      exec: () => {
        queueMicrotask(() => {
          ch.emitStderr('nope');
          ch.emitClose(2);
        });
        return ch;
      },
    });
    await c.connect();
    const res = await c.exec('false');
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('nope');
    await c.end();
  });

  it('execOrThrow raises SSH_COMMAND_FAILED on non-zero exit', async () => {
    const ch = new FakeChannel();
    const c = sshClient({
      onConnect: 'ready',
      exec: () => {
        queueMicrotask(() => {
          ch.emitStderr('nope');
          ch.emitClose(2);
        });
        return ch;
      },
    });
    await c.connect();
    await expect(c.execOrThrow('false')).rejects.toMatchObject({
      code: 'SSH_COMMAND_FAILED',
    });
    await c.end();
  });

  it('rejects with maxBuffer overflow', async () => {
    const ch = new FakeChannel();
    const c = sshClient({
      onConnect: 'ready',
      exec: () => {
        queueMicrotask(() => {
          ch.emitData('A'.repeat(200));
          ch.emitClose(0);
        });
        return ch;
      },
    });
    await c.connect();
    await expect(c.exec('noise', { maxBuffer: 100 })).rejects.toMatchObject({
      code: 'SSH_COMMAND_FAILED',
    });
    await c.end();
  });

  it('throws when called before connect()', async () => {
    const c = sshClient({ onConnect: 'ready' });
    await expect(c.exec('x')).rejects.toBeInstanceOf(RemoteError);
  });
});

describe('SshClient.end', () => {
  it('is idempotent', async () => {
    const c = sshClient({ onConnect: 'ready' });
    await c.connect();
    await c.end();
    await c.end(); // should not throw
    expect(c.connected).toBe(false);
  });
});
