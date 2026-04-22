// Tagged error classes for the SSH / SFTP / WP-CLI surface.
//
// Mirrors the pattern in `cloudways/errors.ts`: stable `code` for UI
// mapping, `retriable` flag for retry policy. Remote errors use a
// different code namespace (`SSH_*`, `SFTP_*`, `WPCLI_*`) so the UI
// layer can tell an auth failure against Cloudways apart from an
// auth failure against a remote Cloudways server.

export type RemoteErrorCode =
  | 'SSH_AUTH_FAILED'
  | 'SSH_NETWORK'
  | 'SSH_TIMEOUT'
  | 'SSH_CLOSED'
  | 'SSH_COMMAND_FAILED'
  | 'SFTP_NOT_FOUND'
  | 'SFTP_PERMISSION'
  | 'SFTP_FAILED'
  | 'WPCLI_FAILED'
  | 'WPCLI_NOT_INSTALLED';

export class RemoteError extends Error {
  readonly code: RemoteErrorCode;
  readonly retriable: boolean;
  readonly detail?: unknown;

  constructor(
    code: RemoteErrorCode,
    message: string,
    opts: { retriable?: boolean; detail?: unknown } = {},
  ) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.retriable = opts.retriable ?? false;
    this.detail = opts.detail;
  }

  toSerialized(): {
    code: RemoteErrorCode;
    message: string;
    retriable: boolean;
    detail?: unknown;
  } {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      detail: this.detail,
    };
  }
}

// --- Factories ---------------------------------------------------------

export const SshAuthFailed = (detail?: unknown) =>
  new RemoteError(
    'SSH_AUTH_FAILED',
    'SSH server rejected the credentials.',
    { retriable: false, detail },
  );

export const SshNetworkError = (cause: unknown) =>
  new RemoteError('SSH_NETWORK', 'Network error talking to SSH server.', {
    retriable: true,
    detail: cause instanceof Error ? cause.message : cause,
  });

export const SshTimeout = (waitedMs: number) =>
  new RemoteError(
    'SSH_TIMEOUT',
    `SSH handshake did not complete within ${Math.round(waitedMs / 1000)}s.`,
    { retriable: true, detail: { waitedMs } },
  );

export const SshClosed = (reason?: string) =>
  new RemoteError(
    'SSH_CLOSED',
    reason ? `SSH connection closed: ${reason}` : 'SSH connection closed unexpectedly.',
    { retriable: true, detail: reason },
  );

export const SshCommandFailed = (
  command: string,
  code: number,
  stderr: string,
) =>
  new RemoteError(
    'SSH_COMMAND_FAILED',
    `Remote command exited with code ${code}.`,
    { retriable: false, detail: { command, code, stderr } },
  );

export const SftpNotFound = (remotePath: string) =>
  new RemoteError('SFTP_NOT_FOUND', `Remote path not found: ${remotePath}`, {
    retriable: false,
    detail: { remotePath },
  });

export const SftpPermission = (remotePath: string) =>
  new RemoteError('SFTP_PERMISSION', `Permission denied: ${remotePath}`, {
    retriable: false,
    detail: { remotePath },
  });

export const SftpFailed = (operation: string, cause: unknown) =>
  new RemoteError('SFTP_FAILED', `SFTP ${operation} failed.`, {
    retriable: true,
    detail: cause instanceof Error ? cause.message : cause,
  });

export const WpCliFailed = (args: string[], code: number, stderr: string) =>
  new RemoteError(
    'WPCLI_FAILED',
    `wp ${args.join(' ')} exited with code ${code}.`,
    { retriable: false, detail: { args, code, stderr } },
  );

export const WpCliNotInstalled = (detail?: unknown) =>
  new RemoteError(
    'WPCLI_NOT_INSTALLED',
    'WP-CLI is not available on the remote server.',
    { retriable: false, detail },
  );

/** Classify a low-level ssh2 / ssh2-sftp-client error into a RemoteError. */
export function classifySshError(err: unknown): RemoteError {
  if (err instanceof RemoteError) return err;
  if (err instanceof Error) {
    const msg = err.message ?? '';
    const level = (err as { level?: string }).level;
    if (level === 'client-authentication' || /authentication/i.test(msg)) {
      return SshAuthFailed(msg);
    }
    if (/timeout|timed out/i.test(msg)) return SshTimeout(0);
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/i.test(msg)) {
      return SshNetworkError(err);
    }
    if (/ended|closed/i.test(msg)) return SshClosed(msg);
    return SshNetworkError(err);
  }
  return SshNetworkError(String(err));
}

/** Classify an ssh2-sftp-client error into a RemoteError. */
export function classifySftpError(op: string, err: unknown): RemoteError {
  if (err instanceof RemoteError) return err;
  if (err instanceof Error) {
    const msg = err.message ?? '';
    // ssh2-sftp-client prefixes errors with the op name and code,
    // e.g. "get: No such file" or "get: Permission denied".
    if (/no such file|not found/i.test(msg)) {
      const match = /([^:]+)$/.exec(msg);
      return SftpNotFound(match?.[1]?.trim() ?? op);
    }
    if (/permission denied/i.test(msg)) {
      const match = /([^:]+)$/.exec(msg);
      return SftpPermission(match?.[1]?.trim() ?? op);
    }
  }
  return SftpFailed(op, err);
}
