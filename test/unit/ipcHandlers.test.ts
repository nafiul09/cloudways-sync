import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerConnectionHandlers } from '../../src/main/ipc/handlers';
import type { IpcResult } from '../../src/shared/ipcTypes';
import { CHANNELS } from '../../src/shared/ipcTypes';

// Minimal fake matching Local's `addIpcAsyncListener` signature.
function makeRegistrar() {
  const routes = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const addIpcAsyncListener = (channel: string, cb: (...args: unknown[]) => unknown) => {
    routes.set(channel, async (...args) => cb(...args));
  };
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> => {
    const h = routes.get(channel);
    if (!h) throw new Error(`no route: ${channel}`);
    return (await h(...args)) as IpcResult<T>;
  };
  return { addIpcAsyncListener, invoke };
}

type StatusResponse = { connected: false } | { connected: true; email: string; connectedAt: string };

function makeService(overrides: Partial<{
  connect: (e: string, k: string) => Promise<StatusResponse>;
  disconnect: () => Promise<void>;
  status: () => StatusResponse;
}> = {}) {
  return {
    connect: overrides.connect ?? (async () => ({ connected: true, email: 'a@b', connectedAt: 'x' })),
    disconnect: overrides.disconnect ?? (async () => {}),
    status: overrides.status ?? (() => ({ connected: false })),
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('IPC connection handlers', () => {
  it('CONNECT rejects a missing email/apiKey without calling the service', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const svc = makeService();
    const spy = vi.spyOn(svc, 'connect');
    registerConnectionHandlers({
      addIpcAsyncListener,
      connection: svc as never,
    });

    const res = await invoke<unknown>(CHANNELS.CONNECT, {});
    expect(res).toMatchObject({ ok: false, error: { code: 'AUTH_INVALID' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('CONNECT trims inputs and forwards them', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    const connect = vi.fn(async (email: string, key: string) => ({
      connected: true,
      email,
      connectedAt: '2026-04-22T00:00:00Z',
    }));
    registerConnectionHandlers({
      addIpcAsyncListener,
      connection: makeService({ connect }) as never,
    });

    const res = await invoke<unknown>(CHANNELS.CONNECT, {
      email: '  a@b.c  ',
      apiKey: '  k-1  ',
    });
    expect(res).toMatchObject({ ok: true, data: { connected: true, email: 'a@b.c' } });
    expect(connect).toHaveBeenCalledWith('a@b.c', 'k-1');
  });

  it('DISCONNECT returns connected:false', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    registerConnectionHandlers({
      addIpcAsyncListener,
      connection: makeService() as never,
    });

    const res = await invoke<unknown>(CHANNELS.DISCONNECT);
    expect(res).toMatchObject({ ok: true, data: { connected: false } });
  });

  it('GET_CONNECTION forwards the service status', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    registerConnectionHandlers({
      addIpcAsyncListener,
      connection: makeService({
        status: () => ({ connected: true, email: 'a@b', connectedAt: 'x' }),
      }) as never,
    });

    const res = await invoke<unknown>(CHANNELS.GET_CONNECTION);
    expect(res).toMatchObject({ ok: true, data: { connected: true, email: 'a@b' } });
  });

  it('serializes CloudwaysError thrown by the service', async () => {
    const { addIpcAsyncListener, invoke } = makeRegistrar();
    registerConnectionHandlers({
      addIpcAsyncListener,
      connection: makeService({
        connect: async () => {
          const { CloudwaysError } = await import('../../src/main/cloudways/errors');
          throw new CloudwaysError('AUTH_INVALID', 'bad creds', { retriable: false });
        },
      }) as never,
    });

    const res = await invoke<unknown>(CHANNELS.CONNECT, { email: 'a@b.c', apiKey: 'k' });
    expect(res).toMatchObject({ ok: false, error: { code: 'AUTH_INVALID', retriable: false } });
  });
});
