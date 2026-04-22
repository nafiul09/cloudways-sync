import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionService } from '../../src/main/connection/service';
import { CredentialStore, type SafeStorage } from '../../src/main/credentials';
import { CloudwaysError } from '../../src/main/cloudways/errors';

function fakeSafeStorage(): SafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC:${s}`),
    decryptString: (b) => b.toString('utf8').slice(4),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cws-conn-'));
});

function makeStore() {
  return new CredentialStore({ dir, safeStorage: fakeSafeStorage() });
}

function clientFactory(behavior: 'ok' | 'fail' = 'ok') {
  return vi.fn(() => {
    // ConnectionService only uses `verifyCredentials`, so this shape
    // is enough for unit tests.
    return {
      verifyCredentials: vi.fn(async () => {
        if (behavior === 'fail') {
          throw new CloudwaysError('AUTH_INVALID', 'bad creds', { retriable: false });
        }
        return { access_token: 't', expires_in: 3600, token_type: 'Bearer' };
      }),
    } as unknown as never;
  });
}

describe('ConnectionService', () => {
  it('reports disconnected when nothing is persisted', async () => {
    const svc = new ConnectionService({
      store: makeStore(),
      clientFactory: clientFactory() as never,
    });
    await svc.hydrate();
    expect(svc.status()).toEqual({ connected: false });
  });

  it('persists creds on a successful connect and reports connected', async () => {
    const store = makeStore();
    const svc = new ConnectionService({
      store,
      clientFactory: clientFactory() as never,
      now: () => new Date('2026-04-22T10:00:00Z'),
    });

    const status = await svc.connect('alice@x.io', 'key-1');
    expect(status).toEqual({
      connected: true,
      email: 'alice@x.io',
      connectedAt: '2026-04-22T10:00:00.000Z',
    });

    // Stored creds round-trip through the real store.
    const stored = await store.read();
    expect(stored?.apiKey).toBe('key-1');
  });

  it('does NOT persist creds when verifyCredentials fails', async () => {
    const store = makeStore();
    const svc = new ConnectionService({ store, clientFactory: clientFactory('fail') as never });

    await expect(svc.connect('bad@x.io', 'nope')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(svc.status()).toEqual({ connected: false });
    expect(await store.has()).toBe(false);
  });

  it('hydrate() restores status from a previous connect', async () => {
    const store = makeStore();
    const first = new ConnectionService({
      store,
      clientFactory: clientFactory() as never,
      now: () => new Date('2026-04-22T10:00:00Z'),
    });
    await first.connect('alice@x.io', 'key-1');

    const second = new ConnectionService({ store, clientFactory: clientFactory() as never });
    await second.hydrate();
    expect(second.status()).toEqual({
      connected: true,
      email: 'alice@x.io',
      connectedAt: '2026-04-22T10:00:00.000Z',
    });
  });

  it('disconnect() clears persisted creds and in-memory state', async () => {
    const store = makeStore();
    const svc = new ConnectionService({ store, clientFactory: clientFactory() as never });
    await svc.connect('alice@x.io', 'key-1');

    await svc.disconnect();
    expect(svc.status()).toEqual({ connected: false });
    expect(await store.has()).toBe(false);
  });

  it('requireClient() throws AUTH_INVALID when not connected', () => {
    const svc = new ConnectionService({ store: makeStore(), clientFactory: clientFactory() as never });
    expect(() => svc.requireClient()).toThrow(CloudwaysError);
  });
});
