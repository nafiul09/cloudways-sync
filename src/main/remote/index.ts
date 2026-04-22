// Barrel export for the remote subsystem.
export { SshClient } from './SshClient';
export type {
  SshConnectConfig,
  ExecOptions,
  ExecResult,
} from './SshClient';
export { SftpClient } from './SftpClient';
export type {
  SftpConnectConfig,
  ProgressEvent,
  TransferOptions,
  MirrorOptions,
  RemoteEntry,
} from './SftpClient';
export { wpCli, wpCliJson, wpOptionGet, buildWpCommand, cloudwaysAppPublicPath, shellQuote } from './wpCli';
export type { WpCliContext } from './wpCli';
export {
  RemoteError,
  classifySshError,
  classifySftpError,
  SshAuthFailed,
  SshNetworkError,
  SshTimeout,
  SshClosed,
  SshCommandFailed,
  SftpNotFound,
  SftpPermission,
  SftpFailed,
  WpCliFailed,
  WpCliNotInstalled,
} from './errors';
export type { RemoteErrorCode } from './errors';
export { GlobMatcher } from './glob';
