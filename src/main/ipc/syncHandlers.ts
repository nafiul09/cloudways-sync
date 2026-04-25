import type { ServiceContainerServices } from '@getflywheel/local/main';
import { CloudwaysError } from '../cloudways/errors';
import { AppPasswordStore, EncryptionUnavailableError, SftpCredentialStore } from '../credentials';
import { RemoteError } from '../remote/errors';
import type { ConnectionService } from '../connection/service';
import { JobStore } from '../sync/JobStore';
import { LocalSiteImporter } from '../sync/LocalSiteImporter';
import { PullOrchestrator } from '../sync/PullOrchestrator';
import { PushOrchestrator } from '../sync/PushOrchestrator';
import { SiteMapper } from '../sync/SiteMapper';
import { UndoLedger } from '../sync/UndoLedger';
import {
  CHANNELS,
  type CancelJobRequest,
  type CancelJobResponse,
  type GetMappingByAppRequest,
  type GetMappingByAppResponse,
  type GetMappingRequest,
  type GetMappingResponse,
  type IpcResult,
  type ListMappingsResponse,
  type JobDoneEvent,
  type JobProgressEvent,
  type ListUndoResponse,
  type MapSiteRequest,
  type MapSiteResponse,
  type PlanPullRequest,
  type PlanPullResponse,
  type PlanPushRequest,
  type PlanPushResponse,
  type RunJobRequest,
  type RunJobResponse,
  type SerializedError,
  type SiteMapping,
  type UnmapSiteRequest,
  type UnmapSiteResponse,
  type UndoPushRequest,
  type UndoPushResponse,
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
    'addSite' | 'siteData' | 'siteProcessManager' | 'siteDatabase' | 'importSQLFile' | 'wpCli'
  >;
  userDataDir: string;
  sendIPCEvent: (channel: string, ...args: unknown[]) => void;
  jobs?: JobStore;
  appPasswords?: AppPasswordStore;
  sftpCreds?: SftpCredentialStore;
};

export function registerSyncHandlers({
  addIpcAsyncListener,
  connection,
  services,
  userDataDir,
  sendIPCEvent,
  jobs = new JobStore(),
  appPasswords,
  sftpCreds,
}: RegisterSyncOptions): void {
  const undoLedger = new UndoLedger(userDataDir);
  const siteMapper = new SiteMapper(userDataDir);

  addIpcAsyncListener(CHANNELS.PLAN_PULL, (...args: unknown[]) => {
    const payload = args[0] as PlanPullRequest | undefined;
    return runHandler<PlanPullResponse>(async () => {
      if (!payload || typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
        throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required.', { retriable: false });
      }
      if (!payload.destinationName?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'destinationName is required.', { retriable: false });
      }
      if (payload.sftpPassword?.trim()) {
        if (!appPasswords) {
          throw new EncryptionUnavailableError();
        }
        await appPasswords.set(payload.serverId, payload.appId, payload.sftpPassword);
      }
      const plan = jobs.createPullPlan(payload);
      return { planId: plan.id, steps: plan.steps };
    });
  });

  addIpcAsyncListener(CHANNELS.PLAN_PUSH, (...args: unknown[]) => {
    const payload = args[0] as PlanPushRequest | undefined;
    return runHandler<PlanPushResponse>(async () => {
      if (!payload || typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
        throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required.', { retriable: false });
      }
      if (!payload.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      if (!payload.localUrl?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localUrl is required.', { retriable: false });
      }
      if (!payload.webRootPath?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'webRootPath is required.', { retriable: false });
      }
      // Mode B: appId === 0 requires a newAppLabel
      if (payload.appId === 0 && !payload.newAppLabel?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'newAppLabel is required when appId is 0 (Mode B).', {
          retriable: false,
        });
      }
      const plan = jobs.createPushPlan(payload);
      return { planId: plan.id, steps: plan.steps };
    });
  });

  addIpcAsyncListener(CHANNELS.RUN_JOB, (...args: unknown[]) => {
    const payload = args[0] as RunJobRequest | undefined;
    return runHandler<RunJobResponse>(async () => {
      if (!payload?.planId) {
        throw new CloudwaysError('AUTH_INVALID', 'planId is required.', { retriable: false });
      }

      // Try pull plan first, then push plan
      const pullPlan = jobs.getPullPlan(payload.planId);
      if (pullPlan) {
        const orchestrator = new PullOrchestrator({
          client: connection.requireClient(),
          importer: new LocalSiteImporter({ services }),
          userDataDir,
          getAppPassword: appPasswords ? (serverId, appId) => appPasswords.get(serverId, appId) : undefined,
          isCancelled: (jobId) => jobs.isCancelled(jobId),
          emitProgress: (event: JobProgressEvent) => sendIPCEvent(CHANNELS.JOB_PROGRESS, event),
        });
        const result = await orchestrator.run(pullPlan);

        // After successful pull, save a mapping so push can find the local site
        if (result.status === 'success' && result.localSiteId) {
          await siteMapper.set({
            linkMode: 'api',
            localSiteId: result.localSiteId,
            serverId: pullPlan.serverId,
            appId: pullPlan.appId,
            appLabel: pullPlan.destinationName,
            serverLabel: pullPlan.serverLabel,
            remoteUrl: '',
            localUrl: result.localUrl ?? '',
            webRootPath: result.webRootPath ?? '',
            createdAt: new Date().toISOString(),
          });
        }

        sendIPCEvent(CHANNELS.JOB_DONE, result satisfies JobDoneEvent);
        return result;
      }

      const pushPlan = jobs.getPushPlan(payload.planId);
      if (pushPlan) {
        const client = connection.requireClient();

        // Mode B: provision a new app before running the push
        let newlyCreatedAppId: number | undefined;
        if (pushPlan.appId === 0) {
          const appLabel = pushPlan.newAppLabel;
          if (!appLabel) {
            throw new CloudwaysError('AUTH_INVALID', 'newAppLabel is required for Mode B push.', {
              retriable: false,
            });
          }

          // Create the app
          const createOpId = await client.createApp(pushPlan.serverId, appLabel);
          await client.waitForOperation(createOpId);

          // Re-fetch servers to find the newly-created app
          const servers = await client.listServers();
          const server = servers.find((s) => s.id === pushPlan.serverId);
          if (!server) {
            throw new CloudwaysError('OPERATION_FAILED', `Server ${pushPlan.serverId} not found after app creation.`, {
              retriable: false,
            });
          }
          // The new app is the one whose label matches and wasn't in the plan
          const newApp = server.apps.find((a) => a.label === appLabel);
          if (!newApp) {
            throw new CloudwaysError('OPERATION_FAILED', `Newly created app "${appLabel}" not found on server.`, {
              retriable: false,
            });
          }

          // Update the plan's appId with the real value
          pushPlan.appId = newApp.id;
          newlyCreatedAppId = newApp.id;
        }

        const orchestrator = new PushOrchestrator({
          client,
          undoLedger,
          userDataDir,
          getAppPassword: appPasswords ? (serverId, appId) => appPasswords.get(serverId, appId) : undefined,
          localDbDump: async (localSiteId, destination) => {
            const site = services.siteData.getSite(localSiteId);
            if (!site) throw new Error(`Local site "${localSiteId}" not found.`);
            if (!services.siteProcessManager.hasRunningProcess(site)) {
              await services.siteProcessManager.start(site);
            }
            await services.siteDatabase.waitForDB(site);
            return services.siteDatabase.dump(site, destination);
          },
          isCancelled: (jobId) => jobs.isCancelled(jobId),
          emitProgress: (event: JobProgressEvent) => sendIPCEvent(CHANNELS.JOB_PROGRESS, event),
        });

        let result: RunJobResponse;
        try {
          result = await orchestrator.run(pushPlan);
        } catch (err) {
          // On failure after app creation, expose the new app ID so the
          // caller can offer to delete it. We never auto-delete.
          if (newlyCreatedAppId !== undefined) {
            const detail =
              err instanceof Error
                ? { message: err.message, newlyCreatedAppId, serverId: pushPlan.serverId }
                : { message: String(err), newlyCreatedAppId, serverId: pushPlan.serverId };
            throw new CloudwaysError(
              'OPERATION_FAILED',
              `Push failed after app creation. The new app (id=${newlyCreatedAppId}) was NOT auto-deleted.`,
              { retriable: false, detail },
            );
          }
          throw err;
        }

        // On success for Mode B, save a site mapping
        if (newlyCreatedAppId !== undefined) {
          const mapping: SiteMapping = {
            linkMode: 'api',
            localSiteId: pushPlan.localSiteId,
            serverId: pushPlan.serverId,
            appId: newlyCreatedAppId,
            appLabel: pushPlan.newAppLabel as string,
            remoteUrl: result.localUrl ?? '',
            createdAt: new Date().toISOString(),
          };
          await siteMapper.set(mapping);
        }

        sendIPCEvent(CHANNELS.JOB_DONE, result satisfies JobDoneEvent);
        return result;
      }

      throw new CloudwaysError('OPERATION_FAILED', `Plan ${payload.planId} was not found.`, {
        retriable: false,
      });
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

  addIpcAsyncListener(CHANNELS.LIST_UNDO, () => {
    return runHandler<ListUndoResponse>(async () => {
      const records = await undoLedger.list();
      return { records };
    });
  });

  addIpcAsyncListener(CHANNELS.UNDO_PUSH, (...args: unknown[]) => {
    const payload = args[0] as UndoPushRequest | undefined;
    return runHandler<UndoPushResponse>(async () => {
      if (!payload?.recordId) {
        throw new CloudwaysError('AUTH_INVALID', 'recordId is required.', { retriable: false });
      }
      const record = await undoLedger.get(payload.recordId);
      if (!record) {
        throw new CloudwaysError('OPERATION_FAILED', `Undo record ${payload.recordId} not found.`, {
          retriable: false,
        });
      }
      if (record.undoneAt) {
        throw new CloudwaysError('OPERATION_FAILED', 'This push has already been undone.', {
          retriable: false,
        });
      }
      const client = connection.requireClient();
      const operationId = await client.restoreApp(record.serverId, record.appId);
      await client.waitForOperation(operationId);
      await undoLedger.markUndone(record.id);
      return { restored: true };
    });
  });

  // --- Phase 8: Site mapping handlers ---

  addIpcAsyncListener(CHANNELS.MAP_SITE, (...args: unknown[]) => {
    const payload = args[0] as MapSiteRequest | undefined;
    return runHandler<MapSiteResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      if (typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
        throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required.', { retriable: false });
      }
      if (!payload.appLabel?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'appLabel is required.', { retriable: false });
      }
      const mapping: SiteMapping = {
        linkMode: 'api',
        localSiteId: payload.localSiteId,
        serverId: payload.serverId,
        appId: payload.appId,
        appLabel: payload.appLabel,
        serverLabel: payload.serverLabel,
        remoteUrl: payload.remoteUrl ?? '',
        createdAt: new Date().toISOString(),
      };
      if (payload.sftpPassword?.trim()) {
        if (!appPasswords) {
          throw new EncryptionUnavailableError();
        }
        await appPasswords.set(payload.serverId, payload.appId, payload.sftpPassword);
      }
      await siteMapper.set(mapping);
      return { mapping };
    });
  });

  addIpcAsyncListener(CHANNELS.UNMAP_SITE, (...args: unknown[]) => {
    const payload = args[0] as UnmapSiteRequest | undefined;
    return runHandler<UnmapSiteResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      // Look up first so we can clean up SFTP credentials before
      // forgetting the mapping. (Without the mapping we'd have no
      // record that this site ever had SFTP creds stored.)
      const existing = await siteMapper.get(payload.localSiteId);
      const removed = await siteMapper.delete(payload.localSiteId, {
        serverId: payload.serverId,
        appId: payload.appId,
      });
      if (removed && existing?.linkMode === 'sftp' && sftpCreds) {
        await sftpCreds.delete(existing.localSiteId).catch(() => undefined);
      }
      return { removed };
    });
  });

  addIpcAsyncListener(CHANNELS.GET_MAPPING, (...args: unknown[]) => {
    const payload = args[0] as GetMappingRequest | undefined;
    return runHandler<GetMappingResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      const mapping = await siteMapper.get(payload.localSiteId);
      return { mapping };
    });
  });

  addIpcAsyncListener(CHANNELS.GET_MAPPING_BY_APP, (...args: unknown[]) => {
    const payload = args[0] as GetMappingByAppRequest | undefined;
    return runHandler<GetMappingByAppResponse>(async () => {
      if (typeof payload?.serverId !== 'number' || typeof payload?.appId !== 'number') {
        throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required.', { retriable: false });
      }
      const mapping = await siteMapper.getByApp(payload.serverId, payload.appId);
      return { mapping };
    });
  });

  addIpcAsyncListener(CHANNELS.LIST_MAPPINGS, () => {
    return runHandler<ListMappingsResponse>(async () => {
      const mappings = await siteMapper.list();
      return { mappings };
    });
  });
}
