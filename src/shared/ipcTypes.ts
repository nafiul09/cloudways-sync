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

  // Site mapping
  MAP_SITE: 'cs:mapSite',
  GET_MAPPING: 'cs:getMapping',
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

export type SmokeAppRequest = { serverId: number; appId: number };
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
  serverId: number;
  appId: number;
  destinationName: string;
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
  manifestPath?: string;
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
