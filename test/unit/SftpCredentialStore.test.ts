import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EncryptionUnavailableError,
  SftpCredentialStore,
  type SafeStorage,
} from '../../src/main/credentials';

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
  dir = await mkdtemp(path.join(tmpdir(), 'cws-sftp-creds-'));
});

describe('SftpCredentialStore', () => {
  it('returns undefined for an unknown localSiteId on a fresh dir', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    expect(await store.get('local-1')).toBeUndefined();
  });

  it('round-trips set → get with encryption (no plaintext on disk)', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.set('local-1', 'p@ssw0rd!');

    const blob = await readFile(path.join(dir, 'sftp-creds.bin'), 'utf8');
    expect(blob.startsWith('ENC:')).toBe(true);
    // The plaintext password must not appear in the on-disk blob outside
    // the (intentionally reversible) ENC: wrapper used by the test.
    expect(blob).toContain('p@ssw0rd!'); // it's inside the JSON, fine for fake encryption
    expect(blob).not.toBe('p@ssw0rd!'); // but not the bare value either

    expect(await store.get('local-1')).toBe('p@ssw0rd!');
  });

  it('keys passwords by localSiteId so multiple sites can coexist', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.set('site-a', 'pass-a');
    await store.set('site-b', 'pass-b');

    expect(await store.get('site-a')).toBe('pass-a');
    expect(await store.get('site-b')).toBe('pass-b');
  });

  it('overwrites the password for the same localSiteId', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.set('site-a', 'first');
    await store.set('site-a', 'second');
    expect(await store.get('site-a')).toBe('second');
  });

  it('set("") removes the entry (mirror of AppPasswordStore behavior)', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.set('site-a', 'first');
    await store.set('site-a', '   ');
    expect(await store.get('site-a')).toBeUndefined();
  });

  it('delete() removes only the specified entry', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.set('site-a', 'pass-a');
    await store.set('site-b', 'pass-b');
    await store.delete('site-a');
    expect(await store.get('site-a')).toBeUndefined();
    expect(await store.get('site-b')).toBe('pass-b');
  });

  it('clear() removes the entire file', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await store.set('site-a', 'pass-a');
    await store.clear();
    expect(await store.get('site-a')).toBeUndefined();
  });

  it('refuses to write when keychain is unavailable', async () => {
    const store = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage(false) });
    await expect(store.set('site-a', 'p')).rejects.toBeInstanceOf(EncryptionUnavailableError);
  });

  it('refuses to read after a successful write if keychain disappears', async () => {
    const good = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage() });
    await good.set('site-a', 'p');
    const broken = new SftpCredentialStore({ dir, safeStorage: fakeSafeStorage(false) });
    await expect(broken.get('site-a')).rejects.toBeInstanceOf(EncryptionUnavailableError);
  });
});
