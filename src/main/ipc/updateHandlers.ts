// IPC handlers for the auto-update feature.

import { CHANNELS, type CheckUpdateResponse, type InstallUpdateRequest, type InstallUpdateResponse, type IpcResult } from '../../shared/ipcTypes';
import type { UpdateService } from '../updater/UpdateService';

function serializeError(err: unknown): { code: string; message: string; retriable: boolean } {
  if (err instanceof Error) {
    return { code: 'UPDATE_ERROR', message: err.message, retriable: true };
  }
  return { code: 'UPDATE_ERROR', message: String(err), retriable: true };
}

export function registerUpdateHandlers({
  addIpcAsyncListener,
  updater,
}: {
  addIpcAsyncListener: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => void;
  updater: UpdateService;
}): void {
  addIpcAsyncListener(CHANNELS.CHECK_UPDATE, async (): Promise<IpcResult<CheckUpdateResponse>> => {
    try {
      const result = await updater.checkForUpdate();
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });

  addIpcAsyncListener(CHANNELS.INSTALL_UPDATE, async (...args: unknown[]): Promise<IpcResult<InstallUpdateResponse>> => {
    try {
      const req = args[0] as InstallUpdateRequest;
      await updater.downloadAndInstall(req.tgzUrl, req.version);
      return { ok: true, data: { installed: true } };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });
}
