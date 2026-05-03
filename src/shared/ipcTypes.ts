// Channel name constants + typed request/response shapes shared
// between main and renderer. Keep this file dependency-free so it
// can be imported from either process.

export const CHANNELS = {
  // Connection lifecycle
  CONNECT: 'cs:connect',
  DISCONNECT: 'cs:disconnect',
  GET_CONNECTION: 'cs:getConnection',

  // Discovery
  LIST_SERVERS: 'cs:listServers',
  LIST_APPS: 'cs:listApps',
  GET_APP: 'cs:getApp',

  // Remote diagnostics (Phase 4 smoke test)
  SMOKE_APP: 'cs:smokeApp',
  CREATE_APP_CREDENTIAL: 'cs:createAppCredential',

  // Planning + execution
  PLAN_PULL: 'cs:planPull',
  PLAN_PUSH: 'cs:planPush',
  RUN_JOB: 'cs:runJob',
  CANCEL_JOB: 'cs:cancelJob',

  // Streaming events (main → renderer)
  JOB_PROGRESS: 'cs:jobProgress',
  JOB_DONE: 'cs:jobDone',

  // Undo
  LIST_UNDO: 'cs:listUndo',
  UNDO_PUSH: 'cs:undoPush',
  DISMISS_UNDO: 'cs:dismissUndo',

  // Site mapping
  MAP_SITE: 'cs:mapSite',
  UNMAP_SITE: 'cs:unmapSite',
  GET_MAPPING: 'cs:getMapping',
  GET_MAPPING_BY_APP: 'cs:getMappingByApp',
  LIST_MAPPINGS: 'cs:listMappings',

  // Local site lookup (for footer buttons that need site context)
  GET_LOCAL_SITE: 'cs:getLocalSite',

  // SFTP-only link mode
  PROBE_SFTP: 'cs:probeSftp',
  LINK_VIA_SFTP: 'cs:linkViaSftp',

  // Breeze plugin detection
  DETECT_BREEZE: 'cs:detectBreeze',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

// Serializable error shape for IPC responses.
export type SerializedError = {
  code: string;
  message: string;
  retriable: boolean;
  detail?: unknown;
};

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

// --- Phase 0 placeholder: just a ping handler to prove IPC is wired. ---
export const PING_CHANNEL = 'cs:ping';
export type PingRequest = { message: string };
export type PingResponse = { echoed: string; addonVersion: string };

// --- Phase 2: connection lifecycle payloads ---
export type ConnectionStatusPayload =
  | { connected: false }
  | { connected: true; email: string; connectedAt: string };

export type ConnectRequest = { email: string; apiKey: string };
export type ConnectResponse = ConnectionStatusPayload;

export type DisconnectRequest = Record<string, never>;
export type DisconnectResponse = { connected: false };

export type GetConnectionRequest = Record<string, never>;
export type GetConnectionResponse = ConnectionStatusPayload;

// --- Phase 3: servers + apps browser ---
// Serialisable (IPC-safe) summaries of Cloudways resources. These are
// deliberately smaller than the raw zod schemas in main/cloudways — the
// renderer only needs what it actually displays, and keeping the shape
// flat makes future schema evolution cheap.

export type ServerSummary = {
  id: number;
  label: string;
  cloud: string;                // 'do' | 'vultr' | 'aws' | 'linode' | 'gce' | …
  region?: string;
  size?: string;
  publicIp?: string;
  serverFqdn?: string;
  masterUser?: string;
  status?: string;
  appCount: number;
};

export type AppSummary = {
  id: number;
  serverId: number;
  label: string;
  application: string;          // 'wordpress', 'phpstack', …
  isWordPress: boolean;
  appVersion?: string;
  appFqdn?: string;
  appUser?: string;
  sysUser?: string;
  cname?: string | null;
  mysqlDbName?: string;
  mysqlUser?: string;
  createdAt?: string;
};

/** Full app detail including credentials. Secrets are returned plain
 * over IPC; the renderer hides them behind a "Reveal" toggle. */
export type AppDetail = AppSummary & {
  server: ServerSummary;
  sftp: {
    host: string;               // usually server's public IP
    /** App master SFTP user. */
    user: string;
    /** App master SFTP password (may be empty if only ssh-key auth is set). */
    password?: string;
  };
  db: {
    name?: string;
    user?: string;
    /** Same master password as SFTP in Cloudways. */
    password?: string;
  };
};

export type ListServersRequest = Record<string, never>;
export type ListServersResponse = { servers: ServerSummary[] };

export type ListAppsRequest = { serverId: number };
export type ListAppsResponse = { apps: AppSummary[] };

export type GetAppRequest = { serverId: number; appId: number };
export type GetAppResponse = { app: AppDetail };

// --- Phase 4: remote smoke test ---
// One-shot "ping" against a Cloudways app: opens SSH, runs
// `wp option get home`, returns the result (or serialized error).
// Used by the renderer's App detail pane to verify SSH + wp-cli are
// wired up before a real Pull is attempted.

export type SmokeAppRequest = { serverId: number; appId: number; sftpPassword?: string };
export type SmokeAppResponse = {
  /** Public path we ran wp-cli in (for debugging). */
  appPublicPath: string;
  /** Captured stdout from `wp option get home`, trimmed. */
  home: string;
  /** Stderr, trimmed — usually empty on success. */
  stderr: string;
  /** Milliseconds elapsed for the whole round-trip. */
  elapsedMs: number;
};

export type CreateAppCredentialRequest = { serverId: number; appId: number };
export type CreateAppCredentialResponse = {
  sftp: {
    host: string;
    user: string;
    password: string;
  };
};

// --- Phase 5: Pull planning + execution ---

export type PullIncludes = {
  database: boolean;
  wpContent: boolean;
  /** Granular wp-content sub-sections. Only consulted when
   * `wpContent` is true — if `wpContent` is false the entire
   * wp-content dir is skipped regardless of these flags. */
  uploads: boolean;
  plugins: boolean;
  themes: boolean;
  muPlugins: boolean;
  languages: boolean;
};

export type PlanPullRequest = {
  /**
   * Discriminator between API-mode and SFTP-mode pulls. Defaults to
   * 'api' (legacy callers don't set it). SFTP-mode requests omit
   * serverId/appId; the handler resolves them via the SiteMapping
   * stored under `localSiteId`.
   */
  linkMode?: 'api' | 'sftp';
  /** Required for API mode. Omitted in SFTP mode. */
  serverId?: number;
  /** Required for API mode. Omitted in SFTP mode. */
  appId?: number;
  destinationName: string;
  /** Human-readable server name, persisted in SiteMapping after pull. */
  serverLabel?: string;
  /** Optional user-supplied app SSH/SFTP password. Stored encrypted by main. */
  sftpPassword?: string;
  /** When set, pull updates this existing Local site instead of creating a new one. */
  localSiteId?: string;
  includes?: Partial<PullIncludes>;
};

export type SyncStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export type SyncStep = {
  id: string;
  label: string;
  status: SyncStepStatus;
};

export type PlanPullResponse = {
  planId: string;
  steps: SyncStep[];
};

export type RunJobRequest = { planId: string };

export type RunJobResponse = {
  jobId: string;
  status: 'success' | 'failed' | 'cancelled';
  localSiteId?: string;
  localUrl?: string;
  webRootPath?: string;
};

export type CancelJobRequest = { jobId: string };
export type CancelJobResponse = { cancelled: boolean };

export type JobProgressEvent = {
  jobId: string;
  stepId: string;
  status: SyncStepStatus;
  detail?: string;
  bytesTransferred?: number;
  totalBytes?: number;
};

export type JobDoneEvent = RunJobResponse;

// --- Breeze plugin detection ---

export type BreezeStatus = {
  installed: boolean;
  active: boolean;
  version?: string;
};

export type DetectBreezeRequest = { serverId: number; appId: number };
export type DetectBreezeResponse = { breezeStatus: BreezeStatus };

// --- Phase 7: Push planning + execution ---

export type PushIncludes = PullIncludes; // same granularity for push

export type PlanPushRequest = {
  /**
   * Discriminator between API-mode and SFTP-mode pushes. Defaults to
   * 'api' (legacy callers don't set it). SFTP-mode requests omit
   * serverId/appId; the handler resolves them via the SiteMapping
   * stored under `localSiteId`.
   */
  linkMode?: 'api' | 'sftp';
  /** Required for API mode. Omitted in SFTP mode. */
  serverId?: number;
  /** Required for API mode. Set to 0 for Mode B. Omitted in SFTP mode. */
  appId?: number;
  /** The Local site ID (from Local's site registry). */
  localSiteId: string;
  /** The local site's URL (e.g. http://buildpress.local). */
  localUrl: string;
  /** Absolute path to the Local site's webRoot (app/public). */
  webRootPath: string;
  includes?: Partial<PushIncludes>;
  /** For Mode B: label for the new Cloudways app. Required when appId is 0. */
  newAppLabel?: string;
  /** When true, re-activate the Breeze caching plugin on the remote after push. */
  reactivateBreeze?: boolean;
};

export type PlanPushResponse = {
  planId: string;
  steps: SyncStep[];
};

// --- Phase 7: Undo ---

export type UndoSnapshot = {
  kind: 'local-tar';
  /** Remote path to the wp-content tar.gz captured before push. */
  remoteContentTarPath: string;
  /** Remote path to the gzipped DB dump captured before push. */
  remoteSqlGzPath: string;
  /** Optional path to a local mirror of the snapshot under userDataDir. */
  localCachePath?: string;
  /** Approximate total size (bytes) of the snapshot files. */
  sizeBytes?: number;
};

export type UndoRecord = {
  id: string;
  jobId: string;
  /**
   * Discriminator. Records written before this field existed are
   * treated as 'api' on read.
   */
  linkMode?: 'api' | 'sftp';
  /** Identifies the SiteMapping for SFTP-mode undo. */
  localSiteId?: string;
  /** Present in API mode. */
  serverId?: number;
  /** Present in API mode. */
  appId?: number;
  appLabel: string;
  /** Cloudways backup timestamp used for restore (API mode). */
  remoteBackupTimestamp?: string;
  /** Path to local safety snapshot (tar.gz). Legacy. Use `snapshot`. */
  localSnapshotPath?: string;
  /** Pre-push snapshot info (SFTP mode). */
  snapshot?: UndoSnapshot;
  /** Push source URL (local .local URL). */
  sourceUrl: string;
  /** Push target URL (remote production URL). */
  targetUrl: string;
  createdAt: string;
  undoneAt?: string;
  /** Set when the user confirms the push succeeded and dismisses the
   *  undo option — cleans up snapshot files from the server. */
  dismissedAt?: string;
};

export type ListUndoRequest = Record<string, never>;
export type ListUndoResponse = { records: UndoRecord[] };

export type UndoPushRequest = { recordId: string };
export type UndoPushResponse = { restored: boolean };

export type DismissUndoRequest = { recordId: string };
export type DismissUndoResponse = { dismissed: boolean };

// --- Phase 8: Site mapping ---

/**
 * Common fields shared by both link modes. `linkMode` is the
 * discriminator: 'api' mappings carry serverId/appId and route through
 * the Cloudways API client; 'sftp' mappings carry direct SSH/SFTP
 * connection details and bypass the API entirely.
 *
 * Legacy mappings (written before this field existed) are migrated
 * to `linkMode: 'api'` on read by SiteMapper.
 */
export type SiteMappingBase = {
  localSiteId: string;
  appLabel: string;
  /** Human-readable server name (e.g. "LiveServer"). */
  serverLabel?: string;
  /** Public URL of the remote site, when known. Optional in SFTP mode. */
  remoteUrl?: string;
  createdAt: string;
  /** Local site URL (e.g. http://my-site.local). Set after pull. */
  localUrl?: string;
  /** Absolute path to Local site's webRoot (e.g. .../app/public). Set after pull. */
  webRootPath?: string;
};

export type ApiSiteMapping = SiteMappingBase & {
  linkMode: 'api';
  serverId: number;
  appId: number;
  /** Always set in API mode (we know the canonical app URL). */
  remoteUrl: string;
};

export type SftpSiteMapping = SiteMappingBase & {
  linkMode: 'sftp';
  /** SFTP/SSH host (Cloudways server public IP, usually). */
  host: string;
  port: number;
  /** SFTP/SSH username (Cloudways app's `master_*` or app sys_user). */
  username: string;
  /**
   * Detected during the connection probe so push/pull don't have to
   * shell out again. Example: "/home/master/applications/abcdef/public_html".
   */
  webRoot?: string;
  /** Cached `wp option get siteurl` from probe time, if wp-cli was available. */
  detectedSiteUrl?: string;
};

export type SiteMapping = ApiSiteMapping | SftpSiteMapping;

/** Type guards for narrowing a SiteMapping in caller code. */
export function isApiMapping(m: SiteMapping): m is ApiSiteMapping {
  return m.linkMode === 'api';
}
export function isSftpMapping(m: SiteMapping): m is SftpSiteMapping {
  return m.linkMode === 'sftp';
}

export type MapSiteRequest = {
  localSiteId: string;
  serverId: number;
  appId: number;
  appLabel: string;
  serverLabel?: string;
  remoteUrl: string;
  /** Optional user-supplied app SSH/SFTP password. Stored encrypted by main. */
  sftpPassword?: string;
};
export type MapSiteResponse = { mapping: SiteMapping };

export type UnmapSiteRequest = { localSiteId: string; serverId?: number; appId?: number };
export type UnmapSiteResponse = { removed: boolean };

export type GetMappingRequest = { localSiteId: string };
export type GetMappingResponse = { mapping: SiteMapping | null };

export type GetMappingByAppRequest = { serverId: number; appId: number };
export type GetMappingByAppResponse = { mapping: SiteMapping | null };

export type ListMappingsResponse = { mappings: SiteMapping[] };

// --- Local site lookup (for footer wizard context) ---

export type GetLocalSiteRequest = { localSiteId: string };
export type GetLocalSiteResponse = {
  site: { id: string; url: string; webRootPath: string } | null;
};

// --- SFTP-only link mode: probe + link ---

export type ProbeSftpRequest = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** When the probe returned multiple candidates, ask again with a pick. */
  pickedSysUser?: string;
};

export type ProbeSftpCandidate = {
  sysUser: string;
  webRoot: string;
};

export type ProbeSftpErrorCode =
  | 'SSH_AUTH_FAILED'
  | 'SSH_NETWORK'
  | 'SSH_TIMEOUT'
  | 'SSH_CLOSED'
  | 'SFTP_MULTIPLE_APPS'
  | 'WP_NOT_FOUND'
  | 'UNKNOWN';

export type ProbeSftpResponse =
  | {
      ok: true;
      webRoot: string;
      sysUser: string;
      wpCliAvailable: boolean;
      detectedSiteUrl: string | null;
      phpVersion: string | null;
      candidates: ProbeSftpCandidate[];
    }
  | {
      ok: false;
      code: ProbeSftpErrorCode;
      message: string;
      candidates?: ProbeSftpCandidate[];
    };

/**
 * Re-runs the probe (defence-in-depth — the renderer can't be trusted
 * to have probed first), then writes both the encrypted password and
 * the SFTP mapping. Returns the persisted mapping.
 */
export type LinkViaSftpRequest = {
  localSiteId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** Human-friendly label shown in Site Tools panel. */
  appLabel: string;
  /** Optional; rendered as a link in Tools panel ("Open on web"). */
  remoteUrl?: string;
  /** Picked sys_user when the probe returned multiple candidates. */
  pickedSysUser?: string;
};

export type LinkViaSftpResponse = { mapping: SftpSiteMapping };
