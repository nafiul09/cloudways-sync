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
import { randomBytes } from 'node:crypto';
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
  CreateAppCredsResponseSchema,
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
  appSshPerms: '/app/getAppSshPerms',
  updateAppSshPerms: '/app/updateAppSshPerms',
  appBackup: '/app/manage/takeBackup',
  serverBackup: '/server/manage/takeBackup',
  operation: '/operation',
  restoreApp: '/app/manage/restore',
  varnishPurge: '/service/varnish',
  whitelistedIp: '/security/whitelisted',
  createApp: '/app',
  deleteApp: '/app',
} as const;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 20_000;
// Cloudways tokens are valid for ~1h; refresh a little early to be safe.
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function generatedAppCredential(): { username: string; password: string } {
  const suffix = randomBytes(4).toString('hex');
  const password = [
    randomBytes(9).toString('base64url'),
    'A7',
    randomBytes(4).toString('hex'),
    'z!',
  ].join('');
  return { username: `cwsync_${suffix}`, password };
}

const TRUTHY_API_VALUES = new Set(['1', 'true', 'enable', 'enabled', 'on', 'yes']);
const FALSY_API_VALUES = new Set(['0', 'false', 'disable', 'disabled', 'off', 'no']);

function coerceApiBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUTHY_API_VALUES.has(normalized)) return true;
    if (FALSY_API_VALUES.has(normalized)) return false;
  }
  return undefined;
}

function findSshAccessFlag(value: unknown, depth = 0): boolean | undefined {
  if (!value || depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const flag = findSshAccessFlag(item, depth + 1);
      if (flag !== undefined) return flag;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;

  // Match keys that relate to SSH/shell permissions. Exclude generic
  // keys like bare "status" or "access" that cause false positives.
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hasSshOrShell = k.includes('ssh') || k.includes('shell');
    const isSshKey = hasSshOrShell && (
      k.includes('access') ||
      k.includes('perm') ||
      k.includes('enabled') ||
      k.includes('status') ||
      k === 'ssh' ||
      k === 'shell'
    );
    const flag = coerceApiBoolean(child);
    if (isSshKey && flag !== undefined) return flag;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    const flag = findSshAccessFlag(child, depth + 1);
    if (flag !== undefined) return flag;
  }
  return undefined;
}

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

  async createAppCredential(serverId: number, appId: number): Promise<AppCredential> {
    const generated = generatedAppCredential();
    const create = async (fields: { userField: string; passwordField: string }) => {
      const res = await this.call({
        method: 'POST',
        path: CLOUDWAYS_API_ENDPOINTS.appCredentials,
        form: {
          server_id: serverId,
          app_id: appId,
          [fields.userField]: generated.username,
          [fields.passwordField]: generated.password,
        },
        schema: CreateAppCredsResponseSchema,
      });
      const record = res.app_creds?.[0] ?? res.app_cred ?? res.credential ?? {
        id: res.id ?? Date.now(),
        sys_user: res.sys_user ?? res.username ?? generated.username,
        password: res.password ?? res.sys_password ?? generated.password,
      };
      return {
        ...record,
        sys_user: record.sys_user || generated.username,
        password: record.password || generated.password,
      };
    };

    try {
      return await create({ userField: 'username', passwordField: 'password' });
    } catch (err) {
      if (!(err instanceof CloudwaysError) || err.code !== 'HTTP_4XX') throw err;
      return create({ userField: 'sys_user', passwordField: 'sys_password' });
    }
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

  /** Restore a Cloudways app from a backup. Used for "undo push". */
  async restoreApp(serverId: number, appId: number): Promise<number> {
    const res = await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.restoreApp,
      form: { server_id: serverId, app_id: appId },
      schema: OperationTriggerResponseSchema,
    });
    return res.operation_id;
  }

  /** Purge Varnish cache for a server (best-effort post-push). */
  async purgeVarnish(serverId: number): Promise<void> {
    await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.varnishPurge,
      form: { server_id: serverId, action: 'purge' },
      schema: z.unknown(),
    }).catch(() => undefined); // best-effort
  }

  /** Create a new WordPress app on a Cloudways server. Returns an operation_id to poll. */
  async createApp(serverId: number, appLabel: string, application = 'wordpress'): Promise<number> {
    const res = await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.createApp,
      form: { server_id: serverId, application, app_label: appLabel },
      schema: OperationTriggerResponseSchema,
    });
    return res.operation_id;
  }

  /** Delete a Cloudways app. Returns an operation_id to poll. */
  async deleteApp(serverId: number, appId: number): Promise<number> {
    const res = await this.call({
      method: 'DELETE',
      path: `${CLOUDWAYS_API_ENDPOINTS.deleteApp}/${appId}`,
      form: { server_id: serverId, app_id: appId },
      schema: OperationTriggerResponseSchema,
    });
    return res.operation_id;
  }

  /** Check whether SSH access is enabled for an app. */
  async getAppSshAccess(serverId: number, appId: number): Promise<boolean> {
    const res = await this.call({
      method: 'GET',
      path: CLOUDWAYS_API_ENDPOINTS.appSshPerms,
      query: { server_id: serverId, app_id: appId },
      schema: z.unknown(),
    });
    return findSshAccessFlag(res) ?? false;
  }

  /** Enable SSH access for an app via the Cloudways API. */
  async enableAppSsh(serverId: number, appId: number): Promise<void> {
    await this.call({
      method: 'POST',
      path: CLOUDWAYS_API_ENDPOINTS.updateAppSshPerms,
      form: { server_id: serverId, app_id: appId, update_perms_action: 'enable' },
      schema: z.unknown(),
    });
  }

  /** Ensure SSH access is enabled for an app. Checks current status and
   * enables if needed. Waits briefly for the change to propagate. */
  async ensureAppSshAccess(serverId: number, appId: number): Promise<void> {
    let enabled = false;
    try {
      enabled = await this.getAppSshAccess(serverId, appId);
    } catch {
      // If the status check fails (e.g. endpoint not available in v2),
      // try enabling anyway — worst case it's a no-op.
    }

    if (!enabled) {
      await this.enableAppSsh(serverId, appId);
      await this.sleep(5_000);
      return;
    }

    try {
      await this.enableAppSsh(serverId, appId);
    } catch {
      // Some accounts respond with an error when the toggle is already on.
      // The status check said enabled, so keep going and let the SSH command
      // surface any real platform-side problem.
    }
    // Brief wait for the SSH toggle to propagate on the Cloudways side.
    await this.sleep(3_000);
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
