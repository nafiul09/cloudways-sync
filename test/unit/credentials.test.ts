import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CredentialStore,
  EncryptionUnavailableError,
  type SafeStorage,
} from '../../src/main/credentials';

// A reversible "encryption" for tests — just base64-tags the plaintext
// so we can assert both that the secret was not written in the clear
// and that round-tripping works.
function fakeSafeStorage(available = true): SafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'),
    decryptString: (b) => {
      const raw = b.toString('utf8');
      if (!raw.startsWith('ENC:')) throw new Error('bad ciphertext');
      return raw.slice(4);
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cws-creds-'));
});

describe('CredentialStore', () => {
  it('reports no creds on a fresh dir', async () => {
    const store = new CredentialStore({ dir, safeStorage: fakeSafeStorage() });
    expect(await store.has()).toBe(false);
    expect(await store.read()).toBeUndefined();
  });

  it('round-trips write → read with encryption', async () => {
    const store = new CredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.write({ email: 'a@b.c', apiKey: 'k-123', connectedAt: '2026-04-22T00:00:00Z' });

    const blob = await readFile(path.join(dir, 'credentials.bin'), 'utf8');
    expect(blob).toBe('ENC:k-123'); // stored encrypted, not plaintext
    expect(blob.includes('k-123')).toBe(true); // sanity for the fake
    // And that the fake actually prefixes it — no plaintext-only copy.
    expect(blob.startsWith('ENC:')).toBe(true);

    expect(await store.has()).toBe(true);
    const read = await store.read();
    expect(read).toEqual({ email: 'a@b.c', apiKey: 'k-123', connectedAt: '2026-04-22T00:00:00Z' });
  });

  it('refuses to write when the OS keychain is unavailable', async () => {
    const store = new CredentialStore({ dir, safeStorage: fakeSafeStorage(false) });
    await expect(
      store.write({ email: 'a@b.c', apiKey: 'k', connectedAt: '2026-04-22T00:00:00Z' }),
    ).rejects.toBeInstanceOf(EncryptionUnavailableError);
  });

  it('refuses to read when the OS keychain is unavailable after an earlier successful write', async () => {
    const good = new CredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await good.write({ email: 'a@b.c', apiKey: 'k', connectedAt: '2026-04-22T00:00:00Z' });

    const broken = new CredentialStore({ dir, safeStorage: fakeSafeStorage(false) });
    await expect(broken.read()).rejects.toBeInstanceOf(EncryptionUnavailableError);
  });

  it('clear() removes both files', async () => {
    const store = new CredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.write({ email: 'a@b.c', apiKey: 'k', connectedAt: '2026-04-22T00:00:00Z' });
    await store.clear();
    expect(await store.has()).toBe(false);
  });

  it('returns undefined on a corrupt meta file', async () => {
    await writeFile(path.join(dir, 'credentials.meta.json'), 'not-json');
    const store = new CredentialStore({ dir, safeStorage: fakeSafeStorage() });
    expect(await store.readMeta()).toBeUndefined();
    expect(await store.has()).toBe(false);
  });
});
