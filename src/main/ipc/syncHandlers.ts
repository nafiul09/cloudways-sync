import type { ServiceContainerServices } from '@getflywheel/local/main';
import { CloudwaysError } from '../cloudways/errors';
import { EncryptionUnavailableError } from '../credentials';
import { RemoteError } from '../remote/errors';
import type { ConnectionService } from '../connection/service';
import { JobStore } from '../sync/JobStore';
import { LocalSiteImporter } from '../sync/LocalSiteImporter';
import { PullOrchestrator } from '../sync/PullOrchestrator';
import {
  CHANNELS,
  type CancelJobRequest,
  type CancelJobResponse,
  type IpcResult,
  type JobDoneEvent,
  type JobProgressEvent,
  type PlanPullRequest,
  type PlanPullResponse,
  type RunJobRequest,
  type RunJobResponse,
  type SerializedError,
} from '../../shared/ipcTypes';
import type { AddIpcAsyncListener } from './handlers';

function serializeError(err: unknown): SerializedError {
  if (err instanceof RemoteError) {
    return { code: err.code, message: err.message, retriable: err.retriable, detail: err.detail };
  }
  if (err instanceof CloudwaysError) {
    return { code: err.code, message: err.message, retriable: err.retriable, detail: err.detail };
  }
  if (err instanceof EncryptionUnavailableError) {
    return { code: 'ENCRYPTION_UNAVAILABLE', message: err.message, retriable: false };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, retriable: false };
  }
  return { code: 'UNKNOWN', message: String(err), retriable: false };
}

async function runHandler<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

export type RegisterSyncOptions = {
  addIpcAsyncListener: AddIpcAsyncListener;
  connection: ConnectionService;
  services: Pick<
    ServiceContainerServices,
    'addSite' | 'siteProcessManager' | 'siteDatabase' | 'importSQLFile' | 'wpCli'
  >;
  userDataDir: string;
  sendIPCEvent: (channel: string, ...args: unknown[]) => void;
  jobs?: JobStore;
};

export function registerSyncHandlers({
  addIpcAsyncListener,
  connection,
  services,
  userDataDir,
  sendIPCEvent,
  jobs = new JobStore(),
}: RegisterSyncOptions): void {
  addIpcAsyncListener(CHANNELS.PLAN_PULL, (...args: unknown[]) => {
    const payload = args[0] as PlanPullRequest | undefined;
    return runHandler<PlanPullResponse>(async () => {
      if (!payload || typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
        throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required.', { retriable: false });
      }
      if (!payload.destinationName?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'destinationName is required.', { retriable: false });
      }
      const plan = jobs.createPullPlan(payload);
      return { planId: plan.id, steps: plan.steps };
    });
  });

  addIpcAsyncListener(CHANNELS.RUN_JOB, (...args: unknown[]) => {
    const payload = args[0] as RunJobRequest | undefined;
    return runHandler<RunJobResponse>(async () => {
      if (!payload?.planId) {
        throw new CloudwaysError('AUTH_INVALID', 'planId is required.', { retriable: false });
      }
      const plan = jobs.getPullPlan(payload.planId);
      if (!plan) {
        throw new CloudwaysError('OPERATION_FAILED', `Plan ${payload.planId} was not found.`, {
          retriable: false,
        });
      }
      const orchestrator = new PullOrchestrator({
        client: connection.requireClient(),
        importer: new LocalSiteImporter({ services }),
        userDataDir,
        isCancelled: (jobId) => jobs.isCancelled(jobId),
        emitProgress: (event: JobProgressEvent) => sendIPCEvent(CHANNELS.JOB_PROGRESS, event),
      });
      const result = await orchestrator.run(plan);
      sendIPCEvent(CHANNELS.JOB_DONE, result satisfies JobDoneEvent);
      return result;
    });
  });

  addIpcAsyncListener(CHANNELS.CANCEL_JOB, (...args: unknown[]) => {
    const payload = args[0] as CancelJobRequest | undefined;
    return runHandler<CancelJobResponse>(async () => {
      if (!payload?.jobId) {
        throw new CloudwaysError('AUTH_INVALID', 'jobId is required.', { retriable: false });
      }
      return { cancelled: jobs.cancel(payload.jobId) };
    });
  });
}
