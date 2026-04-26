// Typed wrapper around Local's `ipcAsync` renderer bridge. Every
// main-side handler returns an `IpcResult<T>`, so this helper
// unwraps the discriminated union into either `data` or a thrown
// Error carrying the serialized error shape.

import { ipcAsync } from '@getflywheel/local/renderer';
import {
  CHANNELS,
  type ConnectRequest,
  type ConnectResponse,
  type CreateAppCredentialRequest,
  type CreateAppCredentialResponse,
  type DetectBreezeRequest,
  type DetectBreezeResponse,
  type DisconnectResponse,
  type GetAppRequest,
  type GetAppResponse,
  type GetConnectionResponse,
  type GetMappingByAppRequest,
  type GetMappingByAppResponse,
  type GetMappingRequest,
  type GetMappingResponse,
  type IpcResult,
  type JobDoneEvent,
  type JobProgressEvent,
  type LinkViaSftpRequest,
  type LinkViaSftpResponse,
  type ListAppsRequest,
  type ListAppsResponse,
  type ListMappingsResponse,
  type ListServersResponse,
  type ListUndoResponse,
  type MapSiteRequest,
  type MapSiteResponse,
  type PlanPullRequest,
  type PlanPullResponse,
  type PlanPushRequest,
  type PlanPushResponse,
  type ProbeSftpRequest,
  type ProbeSftpResponse,
  type RunJobRequest,
  type RunJobResponse,
  type SerializedError,
  type SmokeAppRequest,
  type SmokeAppResponse,
  type UnmapSiteRequest,
  type UnmapSiteResponse,
  type DismissUndoRequest,
  type DismissUndoResponse,
  type UndoPushRequest,
  type UndoPushResponse,
} from '../shared/ipcTypes';

export class IpcCallError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly detail?: unknown;
  constructor(err: SerializedError) {
    super(err.message);
    this.name = 'IpcCallError';
    this.code = err.code;
    this.retriable = err.retriable;
    this.detail = err.detail;
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const raw = (await ipcAsync(channel, ...args)) as IpcResult<T> | undefined;
  if (!raw) throw new IpcCallError({ code: 'UNKNOWN', message: 'Empty IPC response.', retriable: false });
  if (raw.ok) return raw.data;
  throw new IpcCallError(raw.error);
}

export const ipcClient = {
  connect: (req: ConnectRequest) => invoke<ConnectResponse>(CHANNELS.CONNECT, req),
  disconnect: () => invoke<DisconnectResponse>(CHANNELS.DISCONNECT, {}),
  getConnection: () => invoke<GetConnectionResponse>(CHANNELS.GET_CONNECTION, {}),
  listServers: () => invoke<ListServersResponse>(CHANNELS.LIST_SERVERS, {}),
  listApps: (req: ListAppsRequest) => invoke<ListAppsResponse>(CHANNELS.LIST_APPS, req),
  getApp: (req: GetAppRequest) => invoke<GetAppResponse>(CHANNELS.GET_APP, req),
  createAppCredential: (req: CreateAppCredentialRequest) =>
    invoke<CreateAppCredentialResponse>(CHANNELS.CREATE_APP_CREDENTIAL, req),
  smokeApp: (req: SmokeAppRequest) => invoke<SmokeAppResponse>(CHANNELS.SMOKE_APP, req),
  planPull: (req: PlanPullRequest) => invoke<PlanPullResponse>(CHANNELS.PLAN_PULL, req),
  planPush: (req: PlanPushRequest) => invoke<PlanPushResponse>(CHANNELS.PLAN_PUSH, req),
  runJob: (req: RunJobRequest) => invoke<RunJobResponse>(CHANNELS.RUN_JOB, req),
  listUndo: () => invoke<ListUndoResponse>(CHANNELS.LIST_UNDO, {}),
  undoPush: (req: UndoPushRequest) => invoke<UndoPushResponse>(CHANNELS.UNDO_PUSH, req),
  dismissUndo: (req: DismissUndoRequest) => invoke<DismissUndoResponse>(CHANNELS.DISMISS_UNDO, req),
  mapSite: (req: MapSiteRequest) => invoke<MapSiteResponse>(CHANNELS.MAP_SITE, req),
  unmapSite: (req: UnmapSiteRequest) => invoke<UnmapSiteResponse>(CHANNELS.UNMAP_SITE, req),
  getMapping: (req: GetMappingRequest) => invoke<GetMappingResponse>(CHANNELS.GET_MAPPING, req),
  getMappingByApp: (req: GetMappingByAppRequest) => invoke<GetMappingByAppResponse>(CHANNELS.GET_MAPPING_BY_APP, req),
  listMappings: () => invoke<ListMappingsResponse>(CHANNELS.LIST_MAPPINGS, {}),
  detectBreeze: (req: DetectBreezeRequest) => invoke<DetectBreezeResponse>(CHANNELS.DETECT_BREEZE, req),
  probeSftp: (req: ProbeSftpRequest) => invoke<ProbeSftpResponse>(CHANNELS.PROBE_SFTP, req),
  linkViaSftp: (req: LinkViaSftpRequest) => invoke<LinkViaSftpResponse>(CHANNELS.LINK_VIA_SFTP, req),
};

// --- Streaming job events ----------------------------------------------
// The main process broadcasts CHANNELS.JOB_PROGRESS / CHANNELS.JOB_DONE
// via `sendIPCEvent`, which under the hood is `webContents.send(...)`.
// The renderer side reads these via Electron's ipcRenderer. Vite
// externalizes `electron`, so this require resolves to the runtime
// Electron module supplied by Local's renderer process.

type IpcRendererLike = {
  on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  off?: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  removeListener?: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ) => unknown;
};

function getIpcRenderer(): IpcRendererLike | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const mod = require('electron') as { ipcRenderer?: IpcRendererLike };
    return mod.ipcRenderer;
  } catch {
    return undefined;
  }
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const ipc = getIpcRenderer();
  if (!ipc) return () => undefined;
  const wrapped = (_event: unknown, ...args: unknown[]) => {
    handler(args[0] as T);
  };
  ipc.on(channel, wrapped);
  return () => {
    const remove = ipc.off ?? ipc.removeListener;
    remove?.call(ipc, channel, wrapped);
  };
}

/** Subscribe to per-step pull/push progress. Returns an unsubscribe fn. */
export function subscribeJobProgress(handler: (event: JobProgressEvent) => void): () => void {
  return subscribe<JobProgressEvent>(CHANNELS.JOB_PROGRESS, handler);
}

/** Subscribe to the terminal job-done event. Returns an unsubscribe fn. */
export function subscribeJobDone(handler: (event: JobDoneEvent) => void): () => void {
  return subscribe<JobDoneEvent>(CHANNELS.JOB_DONE, handler);
}
