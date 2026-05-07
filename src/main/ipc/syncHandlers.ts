import fs from 'node:fs';
import path from 'node:path';
import type { ServiceContainerServices } from '@getflywheel/local/main';
import { CloudwaysError } from '../cloudways/errors';
import { AppPasswordStore, EncryptionUnavailableError, SftpCredentialStore } from '../credentials';
import { RemoteError } from '../remote/errors';
import { probeSftp } from '../connection/sftpProbe';
import type { ConnectionService } from '../connection/service';
import { JobStore } from '../sync/JobStore';
import { LocalSiteImporter } from '../sync/LocalSiteImporter';
import { PullOrchestrator } from '../sync/PullOrchestrator';
import { PushOrchestrator } from '../sync/PushOrchestrator';
import { SiteMapper } from '../sync/SiteMapper';
import { UndoLedger } from '../sync/UndoLedger';
import { type AppLink, appLinkFor } from '../sync/AppLink';
import { SshClient } from '../remote/SshClient';
import { shellQuote } from '../remote/wpCli';
import { resolvePath } from '../sync/pathUtil';
import { SyncLogger } from '../sync/SyncLogger';
import { restoreFromLocalSnapshot } from '../sync/snapshotUndo';
import {
  CHANNELS,
  type CancelJobRequest,
  type CancelJobResponse,
  type DismissUndoRequest,
  type DismissUndoResponse,
  type GetLocalSiteRequest,
  type GetLocalSiteResponse,
  type GetMappingByAppRequest,
  type GetMappingByAppResponse,
  type GetMappingRequest,
  type GetMappingResponse,
  type IpcResult,
  type ListMappingsResponse,
  type JobDoneEvent,
  type JobProgressEvent,
  type ApiSiteMapping,
  type LinkViaSftpRequest,
  type LinkViaSftpResponse,
  type ListUndoResponse,
  type MapSiteRequest,
  type MapSiteResponse,
  type PlanPullRequest,
  type PlanPullResponse,
  type PlanPushRequest,
  type PlanPushResponse,
  type PreflightCheckRequest,
  type PreflightCheckResponse,
  type ProbeSftpRequest,
  type ProbeSftpResponse,
  type RunJobRequest,
  type RunJobResponse,
  type SerializedError,
  type SftpSiteMapping,
  type SiteMapping,
  type UnmapSiteRequest,
  type UnmapSiteResponse,
  type UndoPushRequest,
  type UndoPushResponse,
  type UpgradeRemoteWpRequest,
  type UpgradeRemoteWpResponse,
  type GetSyncLogsRequest,
  type GetSyncLogsResponse,
  type ExportSyncLogsRequest,
  type ExportSyncLogsResponse,
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
      if (!payload) {
        throw new CloudwaysError('AUTH_INVALID', 'Missing pull payload.', { retriable: false });
      }
      if (!payload.destinationName?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'destinationName is required.', { retriable: false });
      }
      const linkMode = payload.linkMode ?? 'api';
      if (linkMode === 'api') {
        if (typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
          throw new CloudwaysError(
            'AUTH_INVALID',
            'serverId and appId are required for API-mode pull.',
            { retriable: false },
          );
        }
        if (payload.sftpPassword?.trim()) {
          if (!appPasswords) {
            throw new EncryptionUnavailableError();
          }
          await appPasswords.set(payload.serverId, payload.appId, payload.sftpPassword);
        }
      } else {
        // SFTP-mode pull updates an existing linked site, so localSiteId
        // is mandatory and the SiteMapping carries the credentials.
        if (!payload.localSiteId?.trim()) {
          throw new CloudwaysError(
            'AUTH_INVALID',
            'localSiteId is required for SFTP-mode pull.',
            { retriable: false },
          );
        }
      }
      const plan = jobs.createPullPlan(payload);
      return { planId: plan.id, steps: plan.steps };
    });
  });

  addIpcAsyncListener(CHANNELS.PLAN_PUSH, (...args: unknown[]) => {
    const payload = args[0] as PlanPushRequest | undefined;
    return runHandler<PlanPushResponse>(async () => {
      if (!payload) {
        throw new CloudwaysError('AUTH_INVALID', 'Missing push payload.', { retriable: false });
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
      const linkMode = payload.linkMode ?? 'api';
      if (linkMode === 'api') {
        if (typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
          throw new CloudwaysError(
            'AUTH_INVALID',
            'serverId and appId are required for API-mode push.',
            { retriable: false },
          );
        }
        // Mode B: appId === 0 requires a newAppLabel
        if (payload.appId === 0 && !payload.newAppLabel?.trim()) {
          throw new CloudwaysError('AUTH_INVALID', 'newAppLabel is required when appId is 0 (Mode B).', {
            retriable: false,
          });
        }
      }

      // Resolve the real local URL from the WordPress database.
      // The renderer's guess (site.url || http://domain) may not match
      // what's actually stored in wp_options (e.g. https://localhost:10075).
      const rendererUrl = payload.localUrl;
      try {
        const site = services.siteData.getSite(payload.localSiteId);
        if (site) {
          if (!services.siteProcessManager.hasRunningProcess(site)) {
            await services.siteProcessManager.start(site);
          }
          await services.siteDatabase.waitForDB(site);
          const dbHome = await services.wpCli.getOption(site, 'home');
          console.log('[CWS Push] renderer localUrl=%s, DB home=%s', rendererUrl, dbHome);
          if (dbHome?.trim()) {
            payload.localUrl = dbHome.trim();
          }
        }
      } catch (err) {
        // Non-fatal: fall back to the renderer-supplied localUrl.
        console.warn('[CWS Push] Could not read local DB home, using renderer value:', rendererUrl, err);
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
        // Resolve the AppLink for this plan. SFTP-mode pulls require a
        // pre-existing mapping (the user must have linked via SFTP first);
        // API-mode pulls either reference an existing mapping or
        // synthesize one from the request fields.
        let link: AppLink;
        if (pullPlan.linkMode === 'sftp') {
          if (!pullPlan.localSiteId) {
            throw new CloudwaysError(
              'OPERATION_FAILED',
              'SFTP-mode pull plan is missing localSiteId.',
              { retriable: false },
            );
          }
          const mapping = await siteMapper.get(pullPlan.localSiteId);
          if (!mapping || mapping.linkMode !== 'sftp') {
            throw new CloudwaysError(
              'OPERATION_FAILED',
              'No SFTP mapping found for this site. Re-link via SFTP and try again.',
              { retriable: false },
            );
          }
          if (!sftpCreds) throw new EncryptionUnavailableError();
          link = appLinkFor(mapping, { sftpCreds });
        } else {
          if (typeof pullPlan.serverId !== 'number' || typeof pullPlan.appId !== 'number') {
            throw new CloudwaysError(
              'OPERATION_FAILED',
              'API-mode pull plan is missing serverId/appId.',
              { retriable: false },
            );
          }
          const apiMapping: ApiSiteMapping = {
            linkMode: 'api',
            localSiteId: pullPlan.localSiteId ?? '',
            serverId: pullPlan.serverId,
            appId: pullPlan.appId,
            appLabel: pullPlan.destinationName,
            serverLabel: pullPlan.serverLabel,
            remoteUrl: '',
            createdAt: new Date().toISOString(),
          };
          link = appLinkFor(apiMapping, { client: connection.requireClient(), appPasswords });
        }

        const pullLogger = pullPlan.localSiteId
          ? new SyncLogger(userDataDir, pullPlan.localSiteId)
          : undefined;
        const orchestrator = new PullOrchestrator({
          link,
          importer: new LocalSiteImporter({ services }),
          userDataDir,
          isCancelled: (jobId) => jobs.isCancelled(jobId),
          emitProgress: (event: JobProgressEvent) => sendIPCEvent(CHANNELS.JOB_PROGRESS, event),
          logger: pullLogger,
        });
        const result = await orchestrator.run(pullPlan);

        // After successful pull, save a mapping so push can find the local site.
        // For SFTP mode, the mapping already exists and may carry richer fields
        // (host/port/username/webRoot) — don't overwrite it.
        if (
          result.status === 'success' &&
          result.localSiteId &&
          pullPlan.linkMode !== 'sftp' &&
          typeof pullPlan.serverId === 'number' &&
          typeof pullPlan.appId === 'number'
        ) {
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
        // Resolve the AppLink for this plan. API-mode plans either
        // reference an existing mapping or (Mode B) provision a new
        // app on the fly. SFTP-mode plans must already have a mapping
        // saved by the Link via SFTP flow.
        let link: AppLink;
        let newlyCreatedAppId: number | undefined;

        if (pushPlan.linkMode === 'sftp') {
          const mapping = await siteMapper.get(pushPlan.localSiteId);
          if (!mapping || mapping.linkMode !== 'sftp') {
            throw new CloudwaysError(
              'OPERATION_FAILED',
              'No SFTP mapping found for this site. Re-link via SFTP and try again.',
              { retriable: false },
            );
          }
          if (!sftpCreds) {
            throw new EncryptionUnavailableError();
          }
          link = appLinkFor(mapping, { sftpCreds });
        } else {
          const client = connection.requireClient();

          // Mode B: provision a new app before running the push
          if (pushPlan.appId === 0) {
            const appLabel = pushPlan.newAppLabel;
            if (!appLabel) {
              throw new CloudwaysError('AUTH_INVALID', 'newAppLabel is required for Mode B push.', {
                retriable: false,
              });
            }

            // Create the app
            const createOpId = await client.createApp(pushPlan.serverId as number, appLabel);
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

          // Synthesize an ApiSiteMapping for the orchestrator. The
          // canonical mapping (with full label/remoteUrl) is written
          // only after Mode B success below.
          const apiMapping: ApiSiteMapping = {
            linkMode: 'api',
            localSiteId: pushPlan.localSiteId,
            serverId: pushPlan.serverId as number,
            appId: pushPlan.appId as number,
            appLabel: pushPlan.newAppLabel ?? '',
            remoteUrl: '',
            createdAt: new Date().toISOString(),
          };
          link = appLinkFor(apiMapping, { client, appPasswords });
        }

        const pushLogger = new SyncLogger(userDataDir, pushPlan.localSiteId);
        const orchestrator = new PushOrchestrator({
          link,
          undoLedger,
          userDataDir,
          logger: pushLogger,
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
            serverId: pushPlan.serverId as number,
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

      // SFTP-mode records carry a local-tar snapshot pointer instead
      // of a Cloudways backup id. Restore by reapplying the snapshot
      // through the AppLink built from the saved mapping.
      if (record.linkMode === 'sftp') {
        if (!record.snapshot) {
          throw new CloudwaysError(
            'OPERATION_FAILED',
            'This SFTP-mode push has no snapshot. Undo is unavailable.',
            { retriable: false },
          );
        }
        if (!record.localSiteId) {
          throw new CloudwaysError(
            'OPERATION_FAILED',
            'Undo record is missing localSiteId. Re-link the site and try again.',
            { retriable: false },
          );
        }
        const mapping = await siteMapper.get(record.localSiteId);
        if (!mapping || mapping.linkMode !== 'sftp') {
          throw new CloudwaysError(
            'OPERATION_FAILED',
            'No SFTP mapping found for this site. Re-link via SFTP to enable undo.',
            { retriable: false },
          );
        }
        if (!sftpCreds) throw new EncryptionUnavailableError();
        const link = appLinkFor(mapping, { sftpCreds });
        await restoreFromLocalSnapshot({
          link,
          snapshot: record.snapshot,
          jobId: record.jobId,
          emitProgress: (event) => sendIPCEvent(CHANNELS.JOB_PROGRESS, event),
        });
        await undoLedger.markUndone(record.id);
        // Clean up local snapshot mirror — no longer needed after undo.
        if (record.snapshot.localCachePath) {
          await fs.promises.rm(record.snapshot.localCachePath, { recursive: true, force: true }).catch(() => undefined);
        }
        return { restored: true };
      }

      // API-mode (default for legacy records).
      const client = connection.requireClient();
      if (typeof record.serverId !== 'number' || typeof record.appId !== 'number') {
        throw new CloudwaysError(
          'OPERATION_FAILED',
          'API-mode undo record is missing serverId/appId.',
          { retriable: false },
        );
      }
      const operationId = await client.restoreApp(record.serverId, record.appId);
      await client.waitForOperation(operationId);
      await undoLedger.markUndone(record.id);
      return { restored: true };
    });
  });

  // Dismiss undo — user confirms the push is good, clean up snapshot.
  addIpcAsyncListener(CHANNELS.DISMISS_UNDO, (...args: unknown[]) => {
    const payload = args[0] as DismissUndoRequest | undefined;
    return runHandler<DismissUndoResponse>(async () => {
      if (!payload?.recordId) {
        throw new CloudwaysError('AUTH_INVALID', 'recordId is required.', { retriable: false });
      }
      const record = await undoLedger.get(payload.recordId);
      if (!record) {
        throw new CloudwaysError('OPERATION_FAILED', `Undo record ${payload.recordId} not found.`, {
          retriable: false,
        });
      }

      // Clean remote snapshot files if SFTP-mode and snapshot exists.
      if (record.linkMode === 'sftp' && record.snapshot && record.localSiteId) {
        const mapping = await siteMapper.get(record.localSiteId);
        if (mapping && mapping.linkMode === 'sftp' && sftpCreds) {
          const link = appLinkFor(mapping, { sftpCreds });
          try {
            const ctx = await link.resolve();
            const appRootPath = ctx.webRoot.endsWith('/public_html')
              ? ctx.webRoot.slice(0, -'/public_html'.length)
              : ctx.webRoot.replace(/\/[^/]+$/, '');
            const snapshotDir = `${appRootPath}/private_html/.cwsync-snapshots`;
            const { SshClient } = await import('../remote/SshClient');
            const ssh = new SshClient(ctx.auth);
            await ssh.connect();
            // Remove the specific snap files + any pre-undo leftovers.
            await ssh.exec(
              `rm -f ${shellQuote(record.snapshot.remoteContentTarPath)} ` +
                `${shellQuote(record.snapshot.remoteSqlGzPath)}; ` +
                `rm -rf ${snapshotDir}/pre-undo-*; ` +
                `rmdir ${shellQuote(snapshotDir)} 2>/dev/null; true`,
            );
            await ssh.end();
          } catch {
            // Best-effort — even if remote cleanup fails, we still
            // dismiss locally so the button goes away.
          }
        }
        // Clean local mirror.
        if (record.snapshot.localCachePath) {
          await fs.promises.rm(record.snapshot.localCachePath, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      await undoLedger.markDismissed(record.id);
      return { dismissed: true };
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

  addIpcAsyncListener(CHANNELS.GET_LOCAL_SITE, (...args: unknown[]) => {
    const payload = args[0] as GetLocalSiteRequest | undefined;
    return runHandler<GetLocalSiteResponse>(async () => {
      const id = payload?.localSiteId?.trim();
      if (!id) return { site: null };
      const site = services.siteData.getSite(id);
      if (!site) return { site: null };
      const url = (site as { url?: string }).url
        || `http://${(site as { domain?: string }).domain ?? ''}`;
      const webRootPath = (site as { paths?: { webRoot?: string } }).paths?.webRoot
        || `${(site as { path?: string }).path ?? ''}/app/public`;
      return { site: { id: site.id, url, webRootPath } };
    });
  });

  // --- SFTP-only link mode handlers ---

  addIpcAsyncListener(CHANNELS.PROBE_SFTP, (...args: unknown[]) => {
    const payload = args[0] as ProbeSftpRequest | undefined;
    return runHandler<ProbeSftpResponse>(async () => {
      validateSftpProbePayload(payload);
      const result = await probeSftp(
        {
          host: payload!.host.trim(),
          port: payload!.port,
          username: payload!.username.trim(),
          password: payload!.password,
        },
        payload!.pickedSysUser ? { pickedSysUser: payload!.pickedSysUser } : {},
      );
      return result;
    });
  });

  addIpcAsyncListener(CHANNELS.LINK_VIA_SFTP, (...args: unknown[]) => {
    const payload = args[0] as LinkViaSftpRequest | undefined;
    return runHandler<LinkViaSftpResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      if (!payload.appLabel?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'appLabel is required.', { retriable: false });
      }
      validateSftpProbePayload(payload);
      if (!sftpCreds) {
        throw new EncryptionUnavailableError();
      }

      // Defence in depth: re-probe before persisting so we never write a
      // mapping that points at credentials we couldn't actually verify.
      const probe = await probeSftp(
        {
          host: payload.host.trim(),
          port: payload.port,
          username: payload.username.trim(),
          password: payload.password,
        },
        payload.pickedSysUser ? { pickedSysUser: payload.pickedSysUser } : {},
      );
      if (!probe.ok) {
        // Map probe codes that line up with RemoteError directly, then
        // fall back to a generic CloudwaysError so the message and the
        // probe's own code still reach the renderer via `detail`.
        switch (probe.code) {
          case 'SSH_AUTH_FAILED':
          case 'SSH_NETWORK':
          case 'SSH_TIMEOUT':
          case 'SSH_CLOSED':
            throw new RemoteError(probe.code, probe.message, {
              retriable: probe.code !== 'SSH_AUTH_FAILED',
              detail: { probeCode: probe.code, candidates: probe.candidates },
            });
          default:
            throw new CloudwaysError('OPERATION_FAILED', probe.message, {
              retriable: false,
              detail: { probeCode: probe.code, candidates: probe.candidates },
            });
        }
      }

      await sftpCreds.set(payload.localSiteId, payload.password);

      const mapping: SftpSiteMapping = {
        linkMode: 'sftp',
        localSiteId: payload.localSiteId,
        appLabel: payload.appLabel,
        host: payload.host.trim(),
        port: payload.port,
        username: payload.username.trim(),
        webRoot: probe.webRoot,
        detectedSiteUrl: probe.detectedSiteUrl ?? undefined,
        remoteUrl: payload.remoteUrl?.trim() || probe.detectedSiteUrl || undefined,
        createdAt: new Date().toISOString(),
      };
      await siteMapper.set(mapping);
      return { mapping };
    });
  });

  // --- Preflight compatibility check ---

  addIpcAsyncListener(CHANNELS.PREFLIGHT_CHECK, (...args: unknown[]) => {
    const payload = args[0] as PreflightCheckRequest | undefined;
    return runHandler<PreflightCheckResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      if (!payload.webRootPath?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'webRootPath is required.', { retriable: false });
      }

      // 1. Read local WP version from version.php
      let localWpVersion: string | null = null;
      try {
        const versionFile = path.join(resolvePath(payload.webRootPath), 'wp-includes', 'version.php');
        const content = await fs.promises.readFile(versionFile, 'utf8');
        const match = content.match(/\$wp_version\s*=\s*'([^']+)'/);
        localWpVersion = match?.[1] ?? null;
      } catch { /* non-fatal */ }

      // 2. Get local PHP version from Local's site object (services.php.version)
      let localPhpVersion: string | null = null;
      try {
        const site = services.siteData.getSite(payload.localSiteId);
        if (site) {
          const siteAny = site as { services?: Record<string, { version?: string }> };
          localPhpVersion = siteAny.services?.php?.version ?? null;
        }
      } catch { /* non-fatal */ }

      // 3. Resolve the AppLink and SSH to get remote versions
      const linkMode = payload.linkMode ?? 'api';
      let link: AppLink;
      if (linkMode === 'sftp') {
        const mapping = await siteMapper.get(payload.localSiteId);
        if (!mapping || mapping.linkMode !== 'sftp') {
          throw new CloudwaysError('OPERATION_FAILED', 'No SFTP mapping found for this site.', { retriable: false });
        }
        if (!sftpCreds) throw new EncryptionUnavailableError();
        link = appLinkFor(mapping, { sftpCreds });
      } else {
        if (typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
          throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required for API mode.', { retriable: false });
        }
        const apiMapping: ApiSiteMapping = {
          linkMode: 'api',
          localSiteId: payload.localSiteId,
          serverId: payload.serverId,
          appId: payload.appId,
          appLabel: '',
          remoteUrl: '',
          createdAt: new Date().toISOString(),
        };
        link = appLinkFor(apiMapping, { client: connection.requireClient(), appPasswords });
      }

      const ctx = await link.resolve();
      const ssh = new SshClient(ctx.auth);
      await ssh.connect();

      let remoteWpVersion: string | null = null;
      let remotePhpVersion: string | null = null;
      try {
        const wpOut = await ssh.exec(`wp core version --skip-plugins --skip-themes --path=${shellQuote(ctx.webRoot)}`);
        remoteWpVersion = wpOut.stdout?.trim() || null;
      } catch { /* non-fatal */ }
      try {
        const phpOut = await ssh.exec('php -v');
        const phpMatch = /^PHP\s+([\d.]+)/m.exec(phpOut.stdout ?? '');
        remotePhpVersion = phpMatch ? phpMatch[1]! : null;
      } catch { /* non-fatal */ }
      await ssh.end();

      return { localWpVersion, remoteWpVersion, localPhpVersion, remotePhpVersion };
    });
  });

  addIpcAsyncListener(CHANNELS.UPGRADE_REMOTE_WP, (...args: unknown[]) => {
    const payload = args[0] as UpgradeRemoteWpRequest | undefined;
    return runHandler<UpgradeRemoteWpResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      if (!payload.targetVersion?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'targetVersion is required.', { retriable: false });
      }

      const linkMode = payload.linkMode ?? 'api';
      let link: AppLink;
      if (linkMode === 'sftp') {
        const mapping = await siteMapper.get(payload.localSiteId);
        if (!mapping || mapping.linkMode !== 'sftp') {
          throw new CloudwaysError('OPERATION_FAILED', 'No SFTP mapping found for this site.', { retriable: false });
        }
        if (!sftpCreds) throw new EncryptionUnavailableError();
        link = appLinkFor(mapping, { sftpCreds });
      } else {
        if (typeof payload.serverId !== 'number' || typeof payload.appId !== 'number') {
          throw new CloudwaysError('AUTH_INVALID', 'serverId and appId are required for API mode.', { retriable: false });
        }
        const apiMapping: ApiSiteMapping = {
          linkMode: 'api',
          localSiteId: payload.localSiteId,
          serverId: payload.serverId,
          appId: payload.appId,
          appLabel: '',
          remoteUrl: '',
          createdAt: new Date().toISOString(),
        };
        link = appLinkFor(apiMapping, { client: connection.requireClient(), appPasswords });
      }

      const ctx = await link.resolve();
      const ssh = new SshClient(ctx.auth);
      await ssh.connect();

      try {
        const version = shellQuote(payload.targetVersion);
        await ssh.exec(
          `wp core update --version=${version} --force --skip-plugins --skip-themes --path=${shellQuote(ctx.webRoot)}`,
        );
        await ssh.exec(
          `wp core update-db --skip-plugins --skip-themes --path=${shellQuote(ctx.webRoot)}`,
        );
        // Verify the upgrade
        const verifyOut = await ssh.exec(
          `wp core version --skip-plugins --skip-themes --path=${shellQuote(ctx.webRoot)}`,
        );
        const newVersion = verifyOut.stdout?.trim() || undefined;
        return { success: true, newVersion };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        await ssh.end();
      }
    });
  });

  // --- Sync logs handlers ---

  addIpcAsyncListener(CHANNELS.GET_SYNC_LOGS, (...args: unknown[]) => {
    const payload = args[0] as GetSyncLogsRequest | undefined;
    return runHandler<GetSyncLogsResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      const logger = new SyncLogger(userDataDir, payload.localSiteId);
      const entries = await logger.tail(payload.maxLines ?? 200);
      return { entries };
    });
  });

  addIpcAsyncListener(CHANNELS.EXPORT_SYNC_LOGS, (...args: unknown[]) => {
    const payload = args[0] as ExportSyncLogsRequest | undefined;
    return runHandler<ExportSyncLogsResponse>(async () => {
      if (!payload?.localSiteId?.trim()) {
        throw new CloudwaysError('AUTH_INVALID', 'localSiteId is required.', { retriable: false });
      }
      const logger = new SyncLogger(userDataDir, payload.localSiteId);
      const content = await logger.export();
      return { content };
    });
  });

}

function validateSftpProbePayload(payload: ProbeSftpRequest | undefined): void {
  if (!payload) {
    throw new CloudwaysError('AUTH_INVALID', 'Probe payload is required.', { retriable: false });
  }
  if (!payload.host?.trim()) {
    throw new CloudwaysError('AUTH_INVALID', 'host is required.', { retriable: false });
  }
  if (typeof payload.port !== 'number' || !Number.isFinite(payload.port) || payload.port <= 0) {
    throw new CloudwaysError('AUTH_INVALID', 'port must be a positive number.', { retriable: false });
  }
  if (!payload.username?.trim()) {
    throw new CloudwaysError('AUTH_INVALID', 'username is required.', { retriable: false });
  }
  if (!payload.password) {
    throw new CloudwaysError('AUTH_INVALID', 'password is required.', { retriable: false });
  }
}
