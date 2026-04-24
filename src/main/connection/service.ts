// ConnectionService owns the one-and-only ApiClient instance and the
// user's credential state. It is the boundary the IPC layer calls
// into; the IPC layer itself stays thin.
//
// Lifecycle:
//   1. On startup, `hydrate()` tries to load saved creds. If present,
//      we spin up an ApiClient but do NOT pre-validate — the first
//      real call will trigger OAuth.
//   2. `connect({email, apiKey})` creates a transient ApiClient, calls
//      `verifyCredentials()` to prove the creds, and on success
//      persists them and installs the client as the active one.
//   3. `disconnect()` clears persisted creds and drops the client.

import { ApiClient, type ApiClientOptions } from '../cloudways/ApiClient';
import { CloudwaysError } from '../cloudways/errors';
import type { CredentialMeta, CredentialStore, StoredCredentials } from '../credentials';

export type ConnectionStatus =
  | { connected: false }
  | { connected: true; email: string; connectedAt: string };

export type ConnectionServiceOptions = {
  store: CredentialStore;
  /** Factory so tests can substitute a fake ApiClient. */
  clientFactory?: (opts: ApiClientOptions) => ApiClient;
  now?: () => Date;
};

export class ConnectionService {
  private readonly store: CredentialStore;
  private readonly clientFactory: (opts: ApiClientOptions) => ApiClient;
  private readonly now: () => Date;

  private client: ApiClient | undefined;
  private meta: CredentialMeta | undefined;

  constructor(opts: ConnectionServiceOptions) {
    this.store = opts.store;
    this.clientFactory = opts.clientFactory ?? ((o) => new ApiClient(o));
    this.now = opts.now ?? (() => new Date());
  }

  /** Load any persisted creds into memory. Safe to call multiple times. */
  async hydrate(): Promise<void> {
    const creds = await this.store.read().catch(() => undefined);
    if (!creds) return;
    this.client = this.clientFactory({ email: creds.email, apiKey: creds.apiKey });
    this.meta = { email: creds.email, connectedAt: creds.connectedAt };
  }

  status(): ConnectionStatus {
    if (!this.meta) return { connected: false };
    return { connected: true, email: this.meta.email, connectedAt: this.meta.connectedAt };
  }

  /**
   * Returns the active ApiClient. Throws a CloudwaysError with
   * AUTH_INVALID if nothing is connected — callers (IPC handlers)
   * serialise that into a clean error.
   */
  requireClient(): ApiClient {
    if (!this.client) {
      throw new CloudwaysError('AUTH_INVALID', 'Not connected to Cloudways. Connect from the Cloudways Sync panel first.', {
        retriable: false,
      });
    }
    return this.client;
  }

  async connect(email: string, apiKey: string): Promise<ConnectionStatus> {
    const candidate = this.clientFactory({ email, apiKey });
    // Force an OAuth round-trip up-front so bad creds fail fast.
    await candidate.verifyCredentials();

    const record: StoredCredentials = {
      email,
      apiKey,
      connectedAt: this.now().toISOString(),
    };
    await this.store.write(record);

    this.client = candidate;
    this.meta = { email: record.email, connectedAt: record.connectedAt };
    return this.status();
  }

  async disconnect(): Promise<void> {
    await this.store.clear();
    this.client = undefined;
    this.meta = undefined;
  }
}
