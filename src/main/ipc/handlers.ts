// Registers every main-process IPC handler against a live
// ConnectionService. Kept separate from `main/index.ts` so tests can
// call this directly with a fake listener registrar + service.
//
// Handlers are registered via Local's `addIpcAsyncListener` bridge
// (which maps to `ipcRenderer.invoke` on the renderer side). Each
// handler always resolves with an `IpcResult<T>` so renderers never
// see a thrown error.

import { CloudwaysError } from '../cloudways/errors';
import { EncryptionUnavailableError } from '../credentials';
import type { ConnectionService } from '../connection/service';
import {
  CHANNELS,
  type ConnectRequest,
  type ConnectResponse,
  type DisconnectResponse,
  type GetConnectionResponse,
  type IpcResult,
  type SerializedError,
} from '../../shared/ipcTypes';

// Shape of Local's `addIpcAsyncListener`. Narrowed from its `any`
// signature so tests can type a fake.
export type AddIpcAsyncListener = (
  channel: string,
  callback: (...args: unknown[]) => unknown,
) => void;

export function serializeError(err: unknown): SerializedError {
  if (err instanceof CloudwaysError) {
    return {
      code: err.code,
      message: err.message,
      retriable: err.retriable,
      detail: err.detail,
    };
  }
  if (err instanceof EncryptionUnavailableError) {
    return {
      code: 'ENCRYPTION_UNAVAILABLE',
      message: err.message,
      retriable: false,
    };
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

export type RegisterOptions = {
  addIpcAsyncListener: AddIpcAsyncListener;
  connection: ConnectionService;
};

export function registerConnectionHandlers({ addIpcAsyncListener, connection }: RegisterOptions): void {
  const handlers: Array<readonly [string, (...args: unknown[]) => Promise<IpcResult<unknown>>]> = [
    [
      CHANNELS.CONNECT,
      (...args: unknown[]) => {
        const payload = args[0] as ConnectRequest | undefined;
        return runHandler<ConnectResponse>(async () => {
          if (!payload?.email || !payload?.apiKey) {
            throw new CloudwaysError('AUTH_INVALID', 'Email and API key are both required.', {
              retriable: false,
            });
          }
          return connection.connect(payload.email.trim(), payload.apiKey.trim());
        });
      },
    ],
    [
      CHANNELS.DISCONNECT,
      () =>
        runHandler<DisconnectResponse>(async () => {
          await connection.disconnect();
          return { connected: false };
        }),
    ],
    [
      CHANNELS.GET_CONNECTION,
      () => runHandler<GetConnectionResponse>(async () => connection.status()),
    ],
  ];

  for (const [channel, handler] of handlers) {
    addIpcAsyncListener(channel, handler);
  }
}
