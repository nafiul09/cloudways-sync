// Encrypted credential store for the user's Cloudways account.
//
// Storage model:
//   - Secret (api_key) → encrypted via Electron `safeStorage` and
//     written to `<userData>/cloudwayssync/credentials.bin`.
//   - Non-secret metadata (email, connectedAt) → plain JSON beside it
//     at `credentials.meta.json`.
//
// `safeStorage` uses the OS keychain (Keychain on macOS, DPAPI on
// Windows, libsecret on Linux) when available. On machines without
// a backing store we refuse to persist rather than silently writing
// plaintext — the caller can choose to keep creds in-memory only.
//
// This module is pure I/O + crypto; it holds no in-memory state.
// The `ConnectionService` is the stateful owner.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StoredCredentials = {
  email: string;
  apiKey: string;
  connectedAt: string; // ISO timestamp
};

export type CredentialMeta = {
  email: string;
  connectedAt: string;
};

// Abstracted so tests can provide a no-keychain fake.
export type SafeStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

export type CredentialStoreOptions = {
  /** Directory to read/write into. Usually Electron's userData path. */
  dir: string;
  safeStorage: SafeStorage;
};

const SECRET_FILE = 'credentials.bin';
const META_FILE = 'credentials.meta.json';

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'OS credential store is not available on this machine. CloudwaysSync refuses to persist your API key unencrypted.',
    );
    this.name = 'EncryptionUnavailableError';
  }
}

export class CredentialStore {
  private readonly dir: string;
  private readonly safeStorage: SafeStorage;

  constructor(opts: CredentialStoreOptions) {
    this.dir = opts.dir;
    this.safeStorage = opts.safeStorage;
  }

  private secretPath(): string {
    return path.join(this.dir, SECRET_FILE);
  }

  private metaPath(): string {
    return path.join(this.dir, META_FILE);
  }

  /** True iff both the metadata file and the encrypted secret exist. */
  async has(): Promise<boolean> {
    const meta = await this.readMeta();
    if (!meta) return false;
    try {
      await readFile(this.secretPath());
      return true;
    } catch {
      return false;
    }
  }

  async readMeta(): Promise<CredentialMeta | undefined> {
    try {
      const raw = await readFile(this.metaPath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CredentialMeta>;
      if (typeof parsed.email === 'string' && typeof parsed.connectedAt === 'string') {
        return { email: parsed.email, connectedAt: parsed.connectedAt };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Full read (meta + decrypted secret). Returns undefined if either
   * piece is missing. Throws `EncryptionUnavailableError` if the OS
   * keychain has since disappeared and decryption is impossible.
   */
  async read(): Promise<StoredCredentials | undefined> {
    const meta = await this.readMeta();
    if (!meta) return undefined;
    let blob: Buffer;
    try {
      blob = await readFile(this.secretPath());
    } catch {
      return undefined;
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }
    const apiKey = this.safeStorage.decryptString(blob);
    return { email: meta.email, apiKey, connectedAt: meta.connectedAt };
  }

  async write(creds: StoredCredentials): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }
    await mkdir(this.dir, { recursive: true });
    const encrypted = this.safeStorage.encryptString(creds.apiKey);
    // Write secret first; if meta write fails mid-crash we can detect
    // the inconsistency via `has()`.
    await writeFile(this.secretPath(), encrypted, { mode: 0o600 });
    const meta: CredentialMeta = { email: creds.email, connectedAt: creds.connectedAt };
    await writeFile(this.metaPath(), JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await Promise.allSettled([
      rm(this.secretPath(), { force: true }),
      rm(this.metaPath(), { force: true }),
    ]);
  }
}
