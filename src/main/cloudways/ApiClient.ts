// Thin, typed client for the Cloudways v2 REST API.
//
// Responsibilities:
//   - OAuth access-token lifecycle (in-memory only, ~55min TTL).
//   - JSON request/response with zod-validated responses.
//   - Retry policy: 429 honours Retry-After, 5xx/network up to N tries,
//     401 triggers a single re-auth + one replay.
//   - Operation polling for async endpoints.
//
// This file deliberately does NOT persist credentials — that is the
// job of `credentials.ts` (Phase 2).

import { request, type Dispatcher } from 'undici';
import { z, type ZodTypeAny } from 'zod';
import {
  AuthExpired,
  AuthInvalid,
  CloudwaysError,
  Http4xx,
  Http5xx,
  NetworkError,
  OperationFailed,
  OperationTimeout,
  RateLimited,
  SchemaInvalid,
} from './errors';
import {
  AppCredsResponseSchema,
  BackupTriggerResponseSchema,
  isSuccessfulOperation,
  isTerminalOperation,
  OAuthTokenSchema,
  OperationResponseSchema,
  OperationTriggerResponseSchema,
  ServersResponseSchema,
  type AppCredential,
  type OAuthToken,
  type Operation,
  type Server,
} from './schemas';

export type ApiClientOptions = {
  /** Cloudways account email. */
  email: string;
  /** Cloudways account API key (Settings → API). */
  apiKey: string;
  /** Defaults to https://api.cloudways.com/api/v2 */
  baseUrl?: string;
  /** Max retry attempts for retriable errors (total tries including first). */
  maxAttempts?: number;
  /** Initial backoff in ms (exponential). */
  baseDelayMs?: number;
  /** Cap on any single backoff delay in ms. */
  maxDelayMs?: number;
  /** Safety margin: refresh the token this many ms before `expires_in`. */
  tokenRefreshSkewMs?: number;
  /** Injection points for tests. */
  fetchImpl?: typeof request;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

type RequestOpts<S extends ZodTypeAny> = {
  method: Method;
  path: string;
  /** URL-encoded form body (Cloudways uses application/x-www-form-urlencoded). */
  form?: Record<string, string | number | boolean | undefined>;
  /** Query string params. */
  query?: Record<string, string | number | boolean | undefined>;
  /** zod schema for the response body. */
  schema: S;
  /** Set true to skip attaching the bearer token (used only by /oauth). */
  anonymous?: boolean;
};

export const CLOUDWAYS_API_V2_BASE_URL = 'https://api.cloudways.com/api/v2';
export const CLOUDWAYS_API_ENDPOINTS = {
  oauthAccessToken: '/oauth/access_token',
  listServers: '/server',
  appCredentials: '/app/creds',
  appBackup: '/app/manage/takeBackup',
  serverBackup: '/server/manage/takeBackup',
  operation: '/operation',
  whitelistedIp: '/security/whitelisted',
} as const;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 20_000;
// Cloudways tokens are valid for ~1h; refresh a little early to be safe.
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ApiClient {
  private readonly email: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly tokenRefreshSkewMs: number;
  private readonly fetchImpl: typeof request;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry?: (err: unknown, attempt: number, delayMs: number) => void;

  private tokenValue: string | undefined;
  private tokenExpiresAt = 0;
  private inflightAuth: Promise<string> | undefined;

  constructor(opts: ApiClientOptions) {
    this.email = opts.email;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? CLOUDWAYS_API_V2_BASE_URL).replace(/\/+$/, '');
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.tokenRefreshSkewMs = opts.tokenRefreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.fetchImpl = opts.fetchImpl ?? request;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.onRetry = opts.onRetry;
  }

  // -------- Public API --------

  /** Force a fresh OAuth round-trip; useful for a "Test connection" button. */
  async verifyCredentials(): Promise<OAuthToken> {
    return this.fetchToken();
  }

  async listServers(): Promise<Server[]> {
    const res = await this.call({
      method: 'GET',
      path: CLOUDWAYS_API_ENDPOINTS.listServers,
      schema: ServersResponseSchema,
    });
    return res.servers;
  }

  async getAppCreds(serverId: number, appId: number): Promise<AppCredential[]> {
    const res = await this.call({
      method: 'GET',
      path: CLOUDWAYS_API_ENDPOINTS.appCredentials,
      query: { server_id: serverId, app_id: appId },
      schema: AppCredsResponseSchema,
    });
    return res.app_creds;
  }

  /**
   * Trigger a backup for an app. Some Cloudways endpoints return a bare
   * `{ operation_id }` and others embed the operation inline — we
   * normalise to an operation id here.
   */
  async triggerAppBackup(serverId: number, appId: number): Promise<number> {
    const res = await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.appBackup,
      form: { server_id: serverId, app_id: appId },
      schema: BackupTriggerResponseSchema,
    });
    return 'operation_id' in res ? res.operation_id : res.operation.id;
  }

  async triggerServerBackup(serverId: number): Promise<number> {
    const res = await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.serverBackup,
      form: { server_id: serverId },
      schema: OperationTriggerResponseSchema,
    });
    return res.operation_id;
  }

  async getOperation(operationId: number): Promise<Operation> {
    const res = await this.call({
      method: 'GET',
      path: `${CLOUDWAYS_API_ENDPOINTS.operation}/${operationId}`,
      schema: OperationResponseSchema,
    });
    return res.operation;
  }

  /**
   * Poll `getOperation` until the status is terminal. Throws
   * `OperationTimeout` if we exceed `timeoutMs`, `OperationFailed` if
   * Cloudways reports Failed/Cancelled.
   */
  async waitForOperation(
    operationId: number,
    opts: { timeoutMs?: number; pollIntervalMs?: number; onTick?: (op: Operation) => void } = {},
  ): Promise<Operation> {
    const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000; // 20 min default
    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const start = this.now();
    while (true) {
      const op = await this.getOperation(operationId);
      opts.onTick?.(op);
      if (isTerminalOperation(op)) {
        if (!isSuccessfulOperation(op)) {
          throw OperationFailed(operationId, op.message ?? String(op.status), op);
        }
        return op;
      }
      const waited = this.now() - start;
      if (waited >= timeoutMs) {
        throw OperationTimeout(operationId, waited);
      }
      await this.sleep(pollIntervalMs);
    }
  }

  /** Whitelist an IP for SSH/SFTP on a server. */
  async whitelistIp(serverId: number, ip: string, label?: string): Promise<void> {
    await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.whitelistedIp,
      form: {
        server_id: serverId,
        tab: 'ssh',
        ip,
        label: label ?? 'CloudwaysSync',
      },
      // This endpoint just returns { status: true }; we don't care about shape.
      schema: z.unknown(),
    });
  }

  // -------- Internals --------

  private async getToken(): Promise<string> {
    const t = this.tokenValue;
    if (t && this.now() < this.tokenExpiresAt - this.tokenRefreshSkewMs) return t;
    if (!this.inflightAuth) {
      this.inflightAuth = this.fetchToken()
        .then((tok) => tok.access_token)
        .finally(() => {
          this.inflightAuth = undefined;
        });
    }
    return this.inflightAuth;
  }

  private async fetchToken(): Promise<OAuthToken> {
    const tok = await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.oauthAccessToken,
      form: { email: this.email, api_key: this.apiKey },
      schema: OAuthTokenSchema,
      anonymous: true,
    });
    this.tokenValue = tok.access_token;
    this.tokenExpiresAt = this.now() + tok.expires_in * 1000;
    return tok;
  }

  private buildUrl(path: string, query?: RequestOpts<ZodTypeAny>['query']): string {
    const base = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (!query) return base;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `${base}?${s}` : base;
  }

  private encodeForm(form: Record<string, string | number | boolean | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined) continue;
      qs.set(k, String(v));
    }
    return qs.toString();
  }

  private computeBackoffMs(attempt: number): number {
    const exp = this.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(this.maxDelayMs, exp);
    // Small jitter (±20%) to avoid thundering herd.
    const jitter = capped * (0.8 + Math.random() * 0.4);
    return Math.round(jitter);
  }

  /**
   * Core request/response with retry, auth refresh, and schema validation.
   * Errors that propagate out are always `CloudwaysError`.
   */
  private async call<S extends ZodTypeAny>(opts: RequestOpts<S>): Promise<z.infer<S>> {
    let attempt = 0;
    let reAuthed = false;
    while (true) {
      attempt++;
      let err: unknown;
      try {
        return await this.doOnce(opts);
      } catch (caught) {
        err = caught;
      }

      if (!(err instanceof CloudwaysError)) throw err;

      // 401 on an authed request: refresh token once and retry immediately.
      if (err.code === 'AUTH_EXPIRED' && !opts.anonymous && !reAuthed) {
        reAuthed = true;
        this.tokenValue = undefined;
        this.tokenExpiresAt = 0;
        continue;
      }

      if (!err.retriable || attempt >= this.maxAttempts) throw err;

      const defaultDelay = this.computeBackoffMs(attempt);
      const delay =
        err.code === 'RATE_LIMITED' && typeof (err.detail as { retryAfterSec?: number })?.retryAfterSec === 'number'
          ? Math.max(defaultDelay, (err.detail as { retryAfterSec: number }).retryAfterSec * 1000)
          : defaultDelay;
      this.onRetry?.(err, attempt, delay);
      await this.sleep(delay);
    }
  }

  private async doOnce<S extends ZodTypeAny>(opts: RequestOpts<S>): Promise<z.infer<S>> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (!opts.anonymous) {
      const tok = await this.getToken();
      headers.Authorization = `Bearer ${tok}`;
    }
    let body: string | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = this.encodeForm(opts.form);
    }

    let response: Dispatcher.ResponseData;
    try {
      response = await this.fetchImpl(url, { method: opts.method, headers, body });
    } catch (e) {
      throw NetworkError(e);
    }

    const status = response.statusCode;
    const rawText = await response.body.text();
    let parsedBody: unknown;
    if (rawText.length === 0) {
      parsedBody = {};
    } else {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = rawText;
      }
    }

    if (status >= 200 && status < 300) {
      const parsed = opts.schema.safeParse(parsedBody);
      if (!parsed.success) throw SchemaInvalid({ issues: parsed.error.issues, body: parsedBody });
      return parsed.data;
    }

    // Error mapping.
    if (status === 401) {
      // Distinguish invalid creds (seen on /oauth) vs. expired token.
      if (opts.anonymous) throw AuthInvalid(parsedBody);
      throw AuthExpired(parsedBody);
    }
    if (status === 429) {
      const header = response.headers['retry-after'];
      const retryAfterSec = typeof header === 'string' ? Number(header) : Array.isArray(header) ? Number(header[0]) : undefined;
      throw RateLimited(Number.isFinite(retryAfterSec) ? retryAfterSec : undefined);
    }
    if (status >= 500) throw Http5xx(status, parsedBody);
    throw Http4xx(status, parsedBody);
  }
}
