// AppLink adapter: a single object that answers "how do I reach this
// app?" for the orchestrators. ApiAppLink fetches connection details
// via the Cloudways API and the AppPasswordStore. SftpAppLink reads
// them straight off the SiteMapping + the SftpCredentialStore (no
// Cloudways API involvement).
//
// Operations that only the API can perform (remote backup, restoreApp,
// IP whitelisting, etc.) are *optional* members on the interface.
// Callers branch with `if (link.triggerRemoteBackup)` so SFTP mode
// silently skips.

import type { ApiClient } from '../cloudways/ApiClient';
import type { App, Server } from '../cloudways/schemas';
import type { AppPasswordStore, SftpCredentialStore } from '../credentials';
import { RemoteError } from '../remote/errors';
import type { SshConnectConfig } from '../remote/SshClient';
import type { SftpConnectConfig } from '../remote/SftpClient';
import {
  isApiMapping,
  isSftpMapping,
  type ApiSiteMapping,
  type SftpSiteMapping,
  type SiteMapping,
} from '../../shared/ipcTypes';

export type SshAuth = SshConnectConfig & SftpConnectConfig;

/**
 * Resolved connection info plus, for API mode, the live Server/App
 * records so callers that need the canonical app metadata
 * (`app.sys_user`, `server.public_ip`, etc.) can pull it from one
 * place.
 */
export type ResolvedAppContext = {
  auth: SshAuth;
  /** Absolute remote path to the WordPress install (e.g. .../public_html). */
  webRoot: string;
  /** Best-effort home URL of the app, used for "Open on Cloudways" links. */
  remoteUrl: string | null;
  /** Present only when this link is API-backed. */
  api?: { server: Server; app: App };
};

export interface AppLink {
  readonly mode: 'api' | 'sftp';
  readonly mapping: SiteMapping;
  /** Resolve everything an orchestrator needs to open SSH/SFTP. */
  resolve(): Promise<ResolvedAppContext>;
  /**
   * Trigger a remote backup on Cloudways. Only present in API mode.
   * SFTP-mode pushes use the local-snapshot fallback in PushOrchestrator.
   */
  triggerRemoteBackup?: () => Promise<{ operationId: number }>;
  /**
   * Restore the app to its last Cloudways backup. Only present in API
   * mode (Cloudways `/restore` endpoint requires API access).
   */
  restoreFromRemoteBackup?: () => Promise<{ operationId: number }>;
  /** Best-effort cache purge after a push. Only present in API mode. */
  purgeVarnish?: () => Promise<unknown>;
}

// ----- ApiAppLink ------------------------------------------------------

export class ApiAppLink implements AppLink {
  readonly mode = 'api' as const;

  constructor(
    readonly mapping: ApiSiteMapping,
    private readonly client: ApiClient,
    private readonly appPasswords?: AppPasswordStore,
  ) {}

  async resolve(): Promise<ResolvedAppContext> {
    const servers = await this.client.listServers();
    const server = servers.find((s) => s.id === this.mapping.serverId);
    if (!server) {
      throw new RemoteError(
        'SSH_COMMAND_FAILED',
        `Server ${this.mapping.serverId} not found.`,
        { retriable: false },
      );
    }
    const app = server.apps.find((a) => a.id === this.mapping.appId);
    if (!app) {
      throw new RemoteError(
        'SSH_COMMAND_FAILED',
        `App ${this.mapping.appId} not found on server.`,
        { retriable: false },
      );
    }

    let creds = await this.client.getAppCreds(server.id, app.id);
    let primary = creds[0];
    if (!primary?.password) {
      creds = await this.client.getAppCreds(server.id, app.id);
      primary = creds[0];
    }

    const host = server.public_ip ?? server.server_fqdn;
    const username = primary?.sys_user ?? app.sys_user;
    const stored = this.appPasswords ? await this.appPasswords.get(server.id, app.id) : undefined;
    const password = primary?.password || stored;
    if (!host) {
      throw new RemoteError('SSH_NETWORK', 'Cloudways did not return a server address.', {
        retriable: false,
      });
    }
    if (!username) {
      throw new RemoteError('SSH_AUTH_FAILED', 'No SSH user available for this app.', {
        retriable: false,
      });
    }
    if (!password) {
      throw new RemoteError(
        'SSH_AUTH_FAILED',
        'No SSH/SFTP password available. Enter the Cloudways application password in the link step, then try again.',
        { retriable: false },
      );
    }

    if (!app.sys_user) {
      throw new RemoteError('SSH_COMMAND_FAILED', 'Cloudways app is missing sys_user.', {
        retriable: false,
      });
    }

    return {
      auth: { host, username, password },
      webRoot: `/home/master/applications/${app.sys_user}/public_html`,
      remoteUrl: this.mapping.remoteUrl || null,
      api: { server, app },
    };
  }

  async triggerRemoteBackup(): Promise<{ operationId: number }> {
    const operationId = await this.client.triggerAppBackup(this.mapping.serverId, this.mapping.appId);
    return { operationId };
  }

  async restoreFromRemoteBackup(): Promise<{ operationId: number }> {
    const operationId = await this.client.restoreApp(this.mapping.serverId, this.mapping.appId);
    return { operationId };
  }

  async purgeVarnish(): Promise<unknown> {
    return this.client.purgeVarnish(this.mapping.serverId);
  }
}

// ----- SftpAppLink -----------------------------------------------------

export class SftpAppLink implements AppLink {
  readonly mode = 'sftp' as const;

  constructor(
    readonly mapping: SftpSiteMapping,
    private readonly sftpCreds: SftpCredentialStore,
  ) {}

  async resolve(): Promise<ResolvedAppContext> {
    const password = await this.sftpCreds.get(this.mapping.localSiteId);
    if (!password) {
      throw new RemoteError(
        'SSH_AUTH_FAILED',
        'No SFTP password is stored for this site. Re-link via SFTP and re-enter the password.',
        { retriable: false },
      );
    }
    if (!this.mapping.webRoot) {
      // The probe writes webRoot during the link step. If a mapping
      // somehow lacks it, fail loudly rather than guessing.
      throw new RemoteError(
        'SSH_COMMAND_FAILED',
        'This SFTP-linked site has no detected web root. Unlink and re-link via SFTP to re-detect.',
        { retriable: false },
      );
    }
    return {
      auth: {
        host: this.mapping.host,
        port: this.mapping.port,
        username: this.mapping.username,
        password,
      },
      webRoot: this.mapping.webRoot,
      remoteUrl: this.mapping.remoteUrl ?? null,
    };
  }
}

// ----- Factory ---------------------------------------------------------

export type AppLinkFactoryDeps = {
  client?: ApiClient;
  appPasswords?: AppPasswordStore;
  sftpCreds?: SftpCredentialStore;
};

/**
 * Build the right `AppLink` for a given mapping. Throws if the
 * dependency for the chosen mode wasn't provided.
 */
export function appLinkFor(mapping: SiteMapping, deps: AppLinkFactoryDeps): AppLink {
  if (isApiMapping(mapping)) {
    if (!deps.client) {
      throw new RemoteError(
        'SSH_COMMAND_FAILED',
        'API client is required for API-mode mappings but was not provided.',
        { retriable: false },
      );
    }
    return new ApiAppLink(mapping, deps.client, deps.appPasswords);
  }
  if (isSftpMapping(mapping)) {
    if (!deps.sftpCreds) {
      throw new RemoteError(
        'SSH_COMMAND_FAILED',
        'SFTP credential store is required for SFTP-mode mappings but was not provided.',
        { retriable: false },
      );
    }
    return new SftpAppLink(mapping, deps.sftpCreds);
  }
  // Exhaustiveness guard.
  const _exhaustive: never = mapping;
  throw new RemoteError('SSH_COMMAND_FAILED', `Unknown linkMode on mapping: ${JSON.stringify(_exhaustive)}`, {
    retriable: false,
  });
}
