// Human-readable error messages for the CloudwaysSync UI.
//
// Every error thrown by the main process carries a stable `code` string
// (see `cloudways/errors.ts` and `remote/errors.ts`). This module maps
// those codes to concise, jargon-free titles + bodies the renderer can
// surface directly in banners and toasts.

export type HumanError = {
  title: string;
  body: string;
  retriable: boolean;
};

const ERROR_MAP: Record<string, Omit<HumanError, 'retriable'>> = {
  // --- Cloudways API ---
  AUTH_INVALID: {
    title: "Couldn't authenticate",
    body: 'The API key or email is incorrect. Double-check your Cloudways API credentials.',
  },
  AUTH_EXPIRED: {
    title: 'Session expired',
    body: 'Your Cloudways session expired. Reconnecting automatically\u2026',
  },
  RATE_LIMITED: {
    title: 'Too many requests',
    body: 'Cloudways rate-limited this request. Retrying automatically\u2026',
  },
  NETWORK: {
    title: "Couldn't reach Cloudways",
    body: 'A network error occurred while contacting Cloudways. Check your connection and try again.',
  },
  HTTP_5XX: {
    title: 'Cloudways server error',
    body: 'Cloudways returned a server error. This is usually temporary \u2014 try again in a moment.',
  },
  HTTP_4XX: {
    title: 'Request rejected',
    body: 'Cloudways rejected the request. The parameters may be invalid.',
  },
  OPERATION_FAILED: {
    title: 'Cloudways operation failed',
    body: 'The requested operation failed on Cloudways. Check the Cloudways dashboard for details.',
  },
  OPERATION_TIMEOUT: {
    title: 'Operation timed out',
    body: 'The Cloudways operation took too long. Try again or check the Cloudways dashboard.',
  },
  SCHEMA_INVALID: {
    title: 'Unexpected response',
    body: 'Cloudways returned data in an unexpected format. The API may have changed.',
  },

  // --- SSH / SFTP / WP-CLI ---
  SSH_NETWORK: {
    title: "Couldn't connect to server",
    body: 'Unable to reach the server. Check that SSH is enabled and your IP is whitelisted.',
  },
  SSH_AUTH_FAILED: {
    title: 'SSH authentication failed',
    body: 'The SSH credentials were rejected. Verify the password in Cloudways.',
  },
  SSH_TIMEOUT: {
    title: 'SSH connection timed out',
    body: 'The server took too long to respond. Try again or check your network.',
  },
  SSH_COMMAND_FAILED: {
    title: 'Remote command failed',
    body: 'A command on the server failed unexpectedly.',
  },
  SSH_CLOSED: {
    title: 'SSH connection lost',
    body: 'The SSH connection was closed unexpectedly. Try again.',
  },
  SFTP_FAILED: {
    title: 'File transfer failed',
    body: 'The SFTP transfer encountered an error. The connection may have dropped.',
  },
  SFTP_NOT_FOUND: {
    title: 'File not found',
    body: 'The requested file was not found on the remote server.',
  },
  SFTP_PERMISSION: {
    title: 'Permission denied',
    body: 'The server denied access to a file or directory. Check SFTP user permissions.',
  },
  WPCLI_NOT_INSTALLED: {
    title: 'WP-CLI not available',
    body: 'WP-CLI is not installed on the server. Contact Cloudways support.',
  },
  WPCLI_FAILED: {
    title: 'WordPress command failed',
    body: 'A wp-cli command failed on the remote server.',
  },

  // --- Credential storage ---
  ENCRYPTION_UNAVAILABLE: {
    title: 'Secure storage unavailable',
    body: "Your system's keychain is not available. Credentials cannot be stored securely.",
  },

  // --- Catch-all ---
  UNKNOWN: {
    title: 'Unexpected error',
    body: 'Something went wrong. Try again or check the logs.',
  },
};

/**
 * Convert an error code + raw message into a user-friendly title + body.
 *
 * If the code is recognised in `ERROR_MAP`, the mapped title/body are
 * used. Otherwise the caller-provided `message` is passed through as
 * the body with a generic title.
 */
export function humanizeError(
  code: string,
  message: string,
  retriable: boolean,
): HumanError {
  const mapped = ERROR_MAP[code];
  if (mapped) return { ...mapped, retriable };
  return { title: 'Error', body: message, retriable };
}
