// Tagged error classes for the Cloudways API surface. Each error
// carries a stable `code` for UI mapping (see plan §9) and a
// `retriable` flag that drives the retry policy in `ApiClient`.

export type CloudwaysErrorCode =
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'HTTP_5XX'
  | 'HTTP_4XX'
  | 'OPERATION_FAILED'
  | 'OPERATION_TIMEOUT'
  | 'SCHEMA_INVALID';

export class CloudwaysError extends Error {
  readonly code: CloudwaysErrorCode;
  readonly retriable: boolean;
  readonly status?: number;
  readonly detail?: unknown;

  constructor(
    code: CloudwaysErrorCode,
    message: string,
    opts: { retriable?: boolean; status?: number; detail?: unknown } = {},
  ) {
    super(message);
    this.name = 'CloudwaysError';
    this.code = code;
    this.retriable = opts.retriable ?? false;
    this.status = opts.status;
    this.detail = opts.detail;
  }

  toSerialized(): {
    code: CloudwaysErrorCode;
    message: string;
    retriable: boolean;
    status?: number;
    detail?: unknown;
  } {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      status: this.status,
      detail: this.detail,
    };
  }
}

// Factory helpers — keep call sites readable.
export const AuthInvalid = (detail?: unknown) =>
  new CloudwaysError('AUTH_INVALID', 'Cloudways rejected the email + API key.', {
    retriable: false,
    status: 401,
    detail,
  });

export const AuthExpired = (detail?: unknown) =>
  new CloudwaysError('AUTH_EXPIRED', 'Cloudways access token expired.', {
    retriable: true,
    status: 401,
    detail,
  });

export const RateLimited = (retryAfterSec?: number) =>
  new CloudwaysError(
    'RATE_LIMITED',
    retryAfterSec != null
      ? `Cloudways rate-limited the request (retry after ${retryAfterSec}s).`
      : 'Cloudways rate-limited the request.',
    { retriable: true, status: 429, detail: { retryAfterSec } },
  );

export const NetworkError = (cause: unknown) =>
  new CloudwaysError('NETWORK', 'Network error talking to Cloudways.', {
    retriable: true,
    detail: cause instanceof Error ? cause.message : cause,
  });

export const Http5xx = (status: number, body?: unknown) =>
  new CloudwaysError('HTTP_5XX', `Cloudways returned ${status}.`, {
    retriable: true,
    status,
    detail: body,
  });

export const Http4xx = (status: number, body?: unknown) =>
  new CloudwaysError('HTTP_4XX', `Cloudways returned ${status}.`, {
    retriable: false,
    status,
    detail: body,
  });

export const OperationFailed = (operationId: number, message: string, detail?: unknown) =>
  new CloudwaysError('OPERATION_FAILED', `Operation ${operationId} failed: ${message}`, {
    retriable: false,
    detail,
  });

export const OperationTimeout = (operationId: number, waitedMs: number) =>
  new CloudwaysError(
    'OPERATION_TIMEOUT',
    `Operation ${operationId} did not finish within ${Math.round(waitedMs / 1000)}s.`,
    { retriable: false, detail: { operationId, waitedMs } },
  );

export const SchemaInvalid = (detail: unknown) =>
  new CloudwaysError('SCHEMA_INVALID', schemaInvalidMessage(detail), {
    retriable: false,
    detail,
  });

function schemaInvalidMessage(detail: unknown): string {
  const firstIssue = (detail as { issues?: Array<{ path?: Array<string | number>; message?: string }> })?.issues?.[0];
  if (!firstIssue) return 'Cloudways response did not match expected schema.';
  const path = firstIssue.path?.length ? firstIssue.path.join('.') : 'response';
  return `Cloudways response did not match expected schema at ${path}: ${firstIssue.message ?? 'invalid value'}.`;
}
