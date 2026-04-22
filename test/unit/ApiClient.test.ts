import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { ApiClient } from '../../src/main/cloudways/ApiClient';
import { CloudwaysError } from '../../src/main/cloudways/errors';
import {
  appCredsResponse,
  oauthTokenResponse,
  operationCompletedResponse,
  operationFailedResponse,
  operationProcessingResponse,
  operationTriggerResponse,
  serversResponse,
} from '../fixtures/cloudways';

// Build a minimal shape matching what ApiClient uses from the undici
// `request` result: { statusCode, headers, body.text() }.
function fakeResponse(statusCode: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    statusCode,
    headers,
    body: {
      text: async () => text,
      // undici ResponseData requires a stream, but ApiClient only uses .text()
      // so we provide a stub to satisfy structural typing in tests.
      [Symbol.asyncIterator]: () => Readable.from([text])[Symbol.asyncIterator](),
    },
  } as never;
}

type FetchCall = { url: string; method?: string; body?: string; headers?: Record<string, string> };

function makeFetchMock(responses: Array<(call: FetchCall) => ReturnType<typeof fakeResponse>>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const call: FetchCall = { url, method: init?.method, body: init?.body, headers: init?.headers };
    calls.push(call);
    const handler = responses[i++];
    if (!handler) throw new Error(`fetch mock: unexpected extra call to ${url}`);
    return handler(call);
  });
  return { impl, calls };
}

function makeClient(
  fetchImpl: ReturnType<typeof makeFetchMock>['impl'],
  overrides: Partial<Parameters<typeof ApiClient.prototype.constructor>[0]> = {},
) {
  return new ApiClient({
    email: 'alice@example.com',
    apiKey: 'key-123',
    fetchImpl: fetchImpl as never,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 10,
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ApiClient OAuth', () => {
  it('fetches a token once and reuses it across calls', async () => {
    const { impl, calls } = makeFetchMock([
      (c) => {
        expect(c.url).toContain('/oauth/access_token');
        expect(c.method).toBe('POST');
        expect(c.body).toContain('email=alice%40example.com');
        expect(c.body).toContain('api_key=key-123');
        return fakeResponse(200, oauthTokenResponse);
      },
      () => fakeResponse(200, serversResponse),
      () => fakeResponse(200, serversResponse),
    ]);
    const client = makeClient(impl);

    await client.listServers();
    await client.listServers();

    expect(calls).toHaveLength(3);
    // Second and third calls must include the bearer token.
    expect(calls[1]?.headers?.Authorization).toBe('Bearer test-access-token-abc123');
    expect(calls[2]?.headers?.Authorization).toBe('Bearer test-access-token-abc123');
  });

  it('surfaces a 401 on /oauth as AUTH_INVALID (non-retriable)', async () => {
    const { impl } = makeFetchMock([() => fakeResponse(401, { error: 'bad creds' })]);
    const client = makeClient(impl);
    await expect(client.verifyCredentials()).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      retriable: false,
    });
  });

  it('re-authenticates once on 401 for authed calls and replays', async () => {
    const { impl, calls } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse), // initial token
      () => fakeResponse(401, { error: 'token expired' }), // stale
      () => fakeResponse(200, { ...oauthTokenResponse, access_token: 'fresh' }), // refresh
      () => fakeResponse(200, serversResponse), // replay
    ]);
    const client = makeClient(impl);

    const servers = await client.listServers();
    expect(servers).toHaveLength(2);
    // Final call uses the refreshed token.
    expect(calls[3]?.headers?.Authorization).toBe('Bearer fresh');
  });
});

describe('ApiClient retries', () => {
  it('retries 5xx up to maxAttempts then throws HTTP_5XX', async () => {
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(502, 'bad gateway'),
      () => fakeResponse(503, 'unavailable'),
      () => fakeResponse(500, 'boom'),
    ]);
    const client = makeClient(impl);
    await expect(client.listServers()).rejects.toMatchObject({
      code: 'HTTP_5XX',
      retriable: true,
      status: 500,
    });
  });

  it('retries after a 429 and honours Retry-After seconds', async () => {
    const sleeps: number[] = [];
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(429, { error: 'slow down' }, { 'retry-after': '7' }),
      () => fakeResponse(200, serversResponse),
    ]);
    const client = makeClient(impl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    } as never);

    const servers = await client.listServers();
    expect(servers).toHaveLength(2);
    // Retry-After says 7s, which must dominate the tiny backoff cap.
    expect(sleeps.some((ms) => ms >= 7000)).toBe(true);
  });

  it('does not retry 4xx other than 401/429', async () => {
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(404, { error: 'not found' }),
    ]);
    const client = makeClient(impl);
    await expect(client.listServers()).rejects.toMatchObject({
      code: 'HTTP_4XX',
      retriable: false,
      status: 404,
    });
  });
});

describe('ApiClient schema validation', () => {
  it('throws SCHEMA_INVALID when the body does not match the schema', async () => {
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(200, { servers: [{ id: 'not-a-number' }] }),
    ]);
    const client = makeClient(impl);
    await expect(client.listServers()).rejects.toMatchObject({
      code: 'SCHEMA_INVALID',
    });
  });

  it('coerces numeric string ids into numbers', async () => {
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(200, serversResponse),
    ]);
    const client = makeClient(impl);
    const servers = await client.listServers();
    expect(servers[0]?.id).toBe(12345);
    expect(servers[0]?.apps[0]?.id).toBe(67890);
  });
});

describe('ApiClient app creds', () => {
  it('passes server_id and app_id as query string', async () => {
    const { impl, calls } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(200, appCredsResponse),
    ]);
    const client = makeClient(impl);
    const creds = await client.getAppCreds(12345, 67890);
    expect(creds[0]?.sys_user).toBe('app_user_xyz');
    expect(calls[1]?.url).toMatch(/server_id=12345/);
    expect(calls[1]?.url).toMatch(/app_id=67890/);
  });
});

describe('ApiClient operation polling', () => {
  it('polls until Completed and returns the operation', async () => {
    const ticks: string[] = [];
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(200, operationProcessingResponse),
      () => fakeResponse(200, operationProcessingResponse),
      () => fakeResponse(200, operationCompletedResponse),
    ]);
    const client = makeClient(impl);
    const op = await client.waitForOperation(555666, {
      pollIntervalMs: 0,
      onTick: (o) => ticks.push(String(o.status)),
    });
    expect(op.status).toBe('Completed');
    expect(ticks).toEqual(['Processing', 'Processing', 'Completed']);
  });

  it('throws OPERATION_FAILED on Failed status', async () => {
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(200, operationFailedResponse),
    ]);
    const client = makeClient(impl);
    await expect(client.waitForOperation(555666, { pollIntervalMs: 0 })).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
  });

  it('throws OPERATION_TIMEOUT when we run out of time', async () => {
    // Advance "now" past the timeout after the first poll.
    let t = 0;
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(200, operationProcessingResponse),
    ]);
    const client = makeClient(impl, {
      now: () => {
        const v = t;
        t += 60_000;
        return v;
      },
    } as never);
    await expect(
      client.waitForOperation(555666, { pollIntervalMs: 0, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('normalises both trigger response shapes into an operation id', async () => {
    const { impl } = makeFetchMock([
      () => fakeResponse(200, oauthTokenResponse),
      () => fakeResponse(200, operationTriggerResponse),
      () => fakeResponse(200, { operation: operationProcessingResponse.operation }),
    ]);
    const client = makeClient(impl);
    expect(await client.triggerAppBackup(12345, 67890)).toBe(555666);
    expect(await client.triggerAppBackup(12345, 67890)).toBe(555666);
  });
});

describe('ApiClient error shape', () => {
  it('always throws CloudwaysError on transport errors', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ENOTFOUND api.cloudways.com');
    }) as never;
    const client = makeClient(impl, { maxAttempts: 1 } as never);
    await expect(client.verifyCredentials()).rejects.toBeInstanceOf(CloudwaysError);
    await expect(client.verifyCredentials()).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
