// CloudwaysSync — Local add-on main-process entry.
//
// Local loads this module and calls the default export once on
// startup, passing an `AddonMainContext`. All IPC wiring and
// service bootstrap hangs off that context.

import path from 'node:path';
import type { AddonMainContext } from '@getflywheel/local/main';
import { addIpcAsyncListener, getServiceContainer, sendIPCEvent } from '@getflywheel/local/main';
import type { IpcMainEvent } from 'electron';
import { app, safeStorage } from 'electron';
import { ConnectionService } from './connection/service';
import { CredentialStore } from './credentials';
import { registerConnectionHandlers } from './ipc/handlers';
import { registerFleetHandlers } from './ipc/fleetHandlers';
import { registerRemoteHandlers } from './ipc/remoteHandlers';
import { registerSyncHandlers } from './ipc/syncHandlers';
import { PING_CHANNEL, type PingRequest, type PingResponse } from '../shared/ipcTypes';

export default function register(context: AddonMainContext): void {
  const { ipcMain } = context.electron;

  // Where we persist the encrypted API key and metadata. Lives under
  // Local's own userData dir to keep add-on data co-located with the
  // host app.
  const dir = path.join(app.getPath('userData'), 'cloudwayssync');
  const store = new CredentialStore({ dir, safeStorage });
  const connection = new ConnectionService({ store });

  // Fire and forget; if hydration fails (e.g. missing keychain) the
  // UI will see `connected: false` and prompt the user to reconnect.
  connection.hydrate().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[CloudwaysSync] credential hydration failed:', err);
  });

  registerConnectionHandlers({ addIpcAsyncListener, connection });
  registerFleetHandlers({ addIpcAsyncListener, connection });
  registerRemoteHandlers({ addIpcAsyncListener, connection });
  const services = getServiceContainer().cradle;
  registerSyncHandlers({
    addIpcAsyncListener,
    connection,
    services,
    userDataDir: app.getPath('userData'),
    sendIPCEvent,
  });

  // Legacy Phase 0 ping — kept as a cheap smoke channel.
  ipcMain.on(PING_CHANNEL, (event: IpcMainEvent, payload: PingRequest) => {
    const response: PingResponse = {
      echoed: payload?.message ?? '',
      addonVersion: '0.1.0',
    };
    event.sender.send(`${PING_CHANNEL}:reply`, response);
  });
}
