// Cloudways Sync — Local add-on main-process entry.
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
import { AppPasswordStore, CredentialStore, SftpCredentialStore } from './credentials';
import { registerConnectionHandlers } from './ipc/handlers';
import { registerFleetHandlers } from './ipc/fleetHandlers';
import { registerRemoteHandlers } from './ipc/remoteHandlers';
import { registerSyncHandlers } from './ipc/syncHandlers';
import { PING_CHANNEL, type PingRequest, type PingResponse } from '../shared/ipcTypes';
import { sweepLocalSnapshots, sweepStaleJobs } from './sync/cleanup';

export default function register(context: AddonMainContext): void {
  const { ipcMain } = context.electron;

  // Where we persist the encrypted API key and metadata. Lives under
  // Local's own userData dir to keep add-on data co-located with the
  // host app.
  const dir = path.join(app.getPath('userData'), 'cloudwayssync');
  const store = new CredentialStore({ dir, safeStorage });
  const appPasswords = new AppPasswordStore({ dir, safeStorage });
  const sftpCreds = new SftpCredentialStore({ dir, safeStorage });
  const connection = new ConnectionService({ store });

  // Fire and forget; if hydration fails (e.g. missing keychain) the
  // UI will see `connected: false` and prompt the user to reconnect.
  connection.hydrate().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[Cloudways Sync] credential hydration failed:', err);
  });

  // Sweep leftover staging dirs and local snapshot caches from any
  // previous run that crashed before its finally block could clean up.
  // Remote files are cleaned at the start of each job (needs SSH).
  const userDataDir = app.getPath('userData');
  Promise.all([
    sweepStaleJobs(userDataDir),
    sweepLocalSnapshots(userDataDir),
  ]).catch(() => undefined);

  registerConnectionHandlers({ addIpcAsyncListener, connection, appPasswords });
  registerFleetHandlers({ addIpcAsyncListener, connection, appPasswords });
  registerRemoteHandlers({ addIpcAsyncListener, connection, appPasswords });
  const services = getServiceContainer().cradle;
  registerSyncHandlers({
    addIpcAsyncListener,
    connection,
    services,
    userDataDir: app.getPath('userData'),
    sendIPCEvent,
    appPasswords,
    sftpCreds,
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
