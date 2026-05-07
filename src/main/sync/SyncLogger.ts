// Per-site sync logger. Writes structured log entries to a JSONL file
// per site under <userDataDir>/cloudwayssync/logs/<localSiteId>/sync.log.
// Each entry is a single JSON line with timestamp, level, and message.
//
// Logs are rotated when they exceed MAX_LOG_SIZE_BYTES — the current
// file is renamed to sync.log.1 and a fresh file is started.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type LogEntry = {
  ts: string;
  level: LogLevel;
  jobId?: string;
  step?: string;
  msg: string;
  detail?: unknown;
};

const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB per site
const MAX_LOG_AGE_DAYS = 30;

export class SyncLogger {
  private readonly logsDir: string;
  private readonly logFile: string;
  private readonly rotatedFile: string;
  private initialized = false;

  constructor(userDataDir: string, localSiteId: string) {
    this.logsDir = path.join(userDataDir, 'cloudwayssync', 'logs', localSiteId);
    this.logFile = path.join(this.logsDir, 'sync.log');
    this.rotatedFile = path.join(this.logsDir, 'sync.log.1');
  }

  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await fsp.mkdir(this.logsDir, { recursive: true });
    this.initialized = true;
  }

  async log(level: LogLevel, msg: string, extra?: { jobId?: string; step?: string; detail?: unknown }): Promise<void> {
    await this.ensureDir();
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...extra,
    };
    const line = JSON.stringify(entry) + '\n';
    await fsp.appendFile(this.logFile, line, 'utf8');
    await this.rotateIfNeeded();
  }

  info(msg: string, extra?: { jobId?: string; step?: string; detail?: unknown }): Promise<void> {
    return this.log('info', msg, extra);
  }

  warn(msg: string, extra?: { jobId?: string; step?: string; detail?: unknown }): Promise<void> {
    return this.log('warn', msg, extra);
  }

  error(msg: string, extra?: { jobId?: string; step?: string; detail?: unknown }): Promise<void> {
    return this.log('error', msg, extra);
  }

  debug(msg: string, extra?: { jobId?: string; step?: string; detail?: unknown }): Promise<void> {
    return this.log('debug', msg, extra);
  }

  /** Read the last N lines from the log (most recent first). */
  async tail(maxLines = 200): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    for (const file of [this.logFile, this.rotatedFile]) {
      try {
        const content = await fsp.readFile(file, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line) as LogEntry);
          } catch { /* skip malformed lines */ }
        }
      } catch { /* file doesn't exist */ }
    }
    // Sort by timestamp descending (most recent first)
    entries.sort((a, b) => b.ts.localeCompare(a.ts));
    return entries.slice(0, maxLines);
  }

  /** Export the full log as a single string (for users to send to support). */
  async export(): Promise<string> {
    const parts: string[] = [];
    // Include rotated log first (older entries)
    for (const file of [this.rotatedFile, this.logFile]) {
      try {
        parts.push(await fsp.readFile(file, 'utf8'));
      } catch { /* file doesn't exist */ }
    }
    return parts.join('');
  }

  /** Get the path to the log directory (for "Open in Finder/Explorer"). */
  get directory(): string {
    return this.logsDir;
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fsp.stat(this.logFile);
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        // Overwrite rotated file with current
        await fsp.rename(this.logFile, this.rotatedFile);
      }
    } catch { /* non-fatal */ }
  }

  /** Clean up log files older than MAX_LOG_AGE_DAYS. */
  static async sweepStale(userDataDir: string): Promise<void> {
    const logsRoot = path.join(userDataDir, 'cloudwayssync', 'logs');
    let siteDirs: string[];
    try {
      siteDirs = await fsp.readdir(logsRoot);
    } catch {
      return; // no logs dir yet
    }
    const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const siteDir of siteDirs) {
      const dirPath = path.join(logsRoot, siteDir);
      try {
        const stat = await fsp.stat(dirPath);
        if (!stat.isDirectory()) continue;
        const logFile = path.join(dirPath, 'sync.log');
        try {
          const logStat = await fsp.stat(logFile);
          if (logStat.mtimeMs < cutoff) {
            await fsp.rm(dirPath, { recursive: true, force: true });
          }
        } catch {
          // No log file — check if rotated file exists and is old
          const rotated = path.join(dirPath, 'sync.log.1');
          try {
            const rotStat = await fsp.stat(rotated);
            if (rotStat.mtimeMs < cutoff) {
              await fsp.rm(dirPath, { recursive: true, force: true });
            }
          } catch {
            // Empty dir — clean up
            await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      } catch { /* non-fatal */ }
    }
  }
}
