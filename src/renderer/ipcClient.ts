// Typed wrapper around Local's `ipcAsync` renderer bridge. Every
// main-side handler returns an `IpcResult<T>`, so this helper
// unwraps the discriminated union into either `data` or a thrown
// Error carrying the serialized error shape.

import { ipcAsync } from '@getflywheel/local/renderer';
import {
  CHANNELS,
  type ConnectRequest,
  type ConnectResponse,
  type DisconnectResponse,
  type GetAppRequest,
  type GetAppResponse,
  type GetConnectionResponse,
  type IpcResult,
  type ListAppsRequest,
  type ListAppsResponse,
  type ListServersResponse,
  type PlanPullRequest,
  type PlanPullResponse,
  type RunJobRequest,
  type RunJobResponse,
  type SerializedError,
  type SmokeAppRequest,
  type SmokeAppResponse,
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
  smokeApp: (req: SmokeAppRequest) => invoke<SmokeAppResponse>(CHANNELS.SMOKE_APP, req),
  planPull: (req: PlanPullRequest) => invoke<PlanPullResponse>(CHANNELS.PLAN_PULL, req),
  runJob: (req: RunJobRequest) => invoke<RunJobResponse>(CHANNELS.RUN_JOB, req),
};
