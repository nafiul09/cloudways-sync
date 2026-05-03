// Auto-update orchestrator: check GitHub → download → extract → swap.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'undici';
import { fetchLatestRelease, type ReleaseInfo } from './GitHubRelease';
import { isNewer } from './semver';
import { CHANNELS, type CheckUpdateResponse, type UpdateAvailableEvent, type UpdateProgressEvent, type UpdateInstalledEvent } from '../../shared/ipcTypes';

const execFileAsync = promisify(execFile);

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_FILE = 'update-check.json';
const ADDON_NAME = 'local-addon-cloudwayssync';

type CachedCheck = {
  lastCheckMs: number;
  version?: string;
  tgzUrl?: string;
  htmlUrl?: string;
  available: boolean;
};

export type UpdateServiceOpts = {
  addonDir: string;
  userDataDir: string;
  currentVersion: string;
  sendIPCEvent: (channel: string, ...args: unknown[]) => void;
};

export class UpdateService {
  private readonly addonDir: string;
  private readonly cacheDir: string;
  private readonly currentVersion: string;
  private readonly sendIPCEvent: (channel: string, ...args: unknown[]) => void;
  private cachedResult: CachedCheck | null = null;

  constructor(opts: UpdateServiceOpts) {
    this.addonDir = opts.addonDir;
    this.cacheDir = path.join(opts.userDataDir, 'cloudwayssync');
    this.currentVersion = opts.currentVersion;
    this.sendIPCEvent = opts.sendIPCEvent;
  }

  isSymlinkedInstall(): boolean {
    try {
      // Check the resolved addonDir itself.
      if (fs.lstatSync(this.addonDir).isSymbolicLink()) return true;
      // Also check the canonical Local addons path — the symlink lives
      // there, not at the resolved target. Without this check, `npm run
      // link` dev installs would pass the guard and get overwritten.
      const localAddonsDir = this.getLocalAddonsPath();
      if (localAddonsDir) {
        const addonLink = path.join(localAddonsDir, ADDON_NAME);
        try {
          if (fs.lstatSync(addonLink).isSymbolicLink()) return true;
        } catch { /* doesn't exist — not a linked install */ }
      }
      // Also check for telltale dev-install markers (.git dir, src/ dir)
      // as a final safety net.
      if (fs.existsSync(path.join(this.addonDir, '.git'))) return true;
      if (fs.existsSync(path.join(this.addonDir, 'src'))) return true;
      return false;
    } catch {
      return false;
    }
  }

  private getLocalAddonsPath(): string | null {
    try {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Local', 'addons');
      } else if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
        return path.join(appData, 'Local', 'addons');
      }
      // Linux
      const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
      return path.join(configHome, 'Local', 'addons');
    } catch {
      return null;
    }
  }

  async cleanupBackup(): Promise<void> {
    const parentDir = path.dirname(this.addonDir);
    const backupDir = path.join(parentDir, `${ADDON_NAME}.backup`);
    const updateDir = path.join(parentDir, `${ADDON_NAME}.update`);
    const updateTgz = path.join(parentDir, `${ADDON_NAME}.update.tgz`);

    await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(updateDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(updateTgz, { force: true }).catch(() => undefined);
  }

  async checkForUpdate(): Promise<CheckUpdateResponse> {
    // Try cached result first
    const cached = await this.readCache();
    if (cached && Date.now() - cached.lastCheckMs < CHECK_INTERVAL_MS) {
      if (cached.available) {
        this.emitAvailable(cached);
      }
      return {
        available: cached.available,
        version: cached.version,
        htmlUrl: cached.htmlUrl,
        tgzUrl: cached.tgzUrl,
      };
    }

    // Fetch from GitHub
    const release = await fetchLatestRelease('nafiul09', 'cloudways-sync');
    if (!release) {
      // Network issue or rate limited — use stale cache or report nothing
      const stale: CheckUpdateResponse = {
        available: cached?.available ?? false,
        version: cached?.version,
        htmlUrl: cached?.htmlUrl,
        tgzUrl: cached?.tgzUrl,
      };
      return stale;
    }

    const available = isNewer(this.currentVersion, release.version);
    const result: CachedCheck = {
      lastCheckMs: Date.now(),
      version: release.version,
      tgzUrl: release.tgzUrl,
      htmlUrl: release.htmlUrl,
      available,
    };

    await this.writeCache(result);
    this.cachedResult = result;

    if (available) {
      this.emitAvailable(result);
    }

    return {
      available,
      version: release.version,
      htmlUrl: release.htmlUrl,
      tgzUrl: release.tgzUrl,
    };
  }

  async downloadAndInstall(tgzUrl: string, version: string): Promise<void> {
    if (this.isSymlinkedInstall()) {
      throw new Error('Cannot auto-update a symlinked (development) install.');
    }

    const parentDir = path.dirname(this.addonDir);
    const tempTgz = path.join(parentDir, `${ADDON_NAME}.update.tgz`);
    const extractDir = path.join(parentDir, `${ADDON_NAME}.update`);
    const backupDir = path.join(parentDir, `${ADDON_NAME}.backup`);

    try {
      // Clean any leftover update artifacts
      await fsp.rm(tempTgz, { force: true });
      await fsp.rm(extractDir, { recursive: true, force: true });
      await fsp.rm(backupDir, { recursive: true, force: true });

      // Download with progress
      await this.downloadFile(tgzUrl, tempTgz);

      // Extract
      this.emitProgress({ bytesTransferred: 0, totalBytes: 0, phase: 'extract' });
      await fsp.mkdir(extractDir, { recursive: true });
      await execFileAsync('tar', ['xzf', tempTgz, '-C', extractDir, '--strip-components=1']);

      // Verify extraction produced a package.json
      const extractedPkg = path.join(extractDir, 'package.json');
      if (!fs.existsSync(extractedPkg)) {
        throw new Error('Extracted archive does not contain package.json');
      }

      // Atomic swap: current → backup, new → current
      await fsp.rename(this.addonDir, backupDir);
      try {
        await fsp.rename(extractDir, this.addonDir);
      } catch (err) {
        // Rollback: restore backup
        await fsp.rename(backupDir, this.addonDir).catch(() => undefined);
        throw err;
      }

      // Cleanup temp file (backup kept until next startup)
      await fsp.rm(tempTgz, { force: true });

      // Invalidate cache so we don't show "update available" after restart
      const updatedCache: CachedCheck = {
        lastCheckMs: Date.now(),
        version,
        tgzUrl,
        available: false,
      };
      await this.writeCache(updatedCache);

      // Notify renderer
      const event: UpdateInstalledEvent = { version };
      this.sendIPCEvent(CHANNELS.UPDATE_INSTALLED, event);
    } catch (err) {
      // Cleanup on failure
      await fsp.rm(tempTgz, { force: true }).catch(() => undefined);
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const res = await request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'local-addon-cloudwayssync' },
      maxRedirections: 5,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      throw new Error(`Download failed with status ${res.statusCode}`);
    }

    const contentLength = res.headers['content-length'];
    const totalBytes = contentLength ? parseInt(String(contentLength), 10) : 0;
    let bytesTransferred = 0;

    const writeStream = fs.createWriteStream(dest);

    for await (const chunk of res.body) {
      writeStream.write(chunk);
      bytesTransferred += (chunk as Buffer).length;
      this.emitProgress({ bytesTransferred, totalBytes, phase: 'download' });
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on('error', reject);
    });
  }

  private emitAvailable(result: { version?: string; htmlUrl?: string; tgzUrl?: string }): void {
    if (!result.version) return;
    const event: UpdateAvailableEvent = {
      version: result.version,
      htmlUrl: result.htmlUrl,
      tgzUrl: result.tgzUrl,
    };
    this.sendIPCEvent(CHANNELS.UPDATE_AVAILABLE, event);
  }

  private emitProgress(event: UpdateProgressEvent): void {
    this.sendIPCEvent(CHANNELS.UPDATE_PROGRESS, event);
  }

  private get cachePath(): string {
    return path.join(this.cacheDir, CACHE_FILE);
  }

  private async readCache(): Promise<CachedCheck | null> {
    if (this.cachedResult) return this.cachedResult;
    try {
      const raw = await fsp.readFile(this.cachePath, 'utf-8');
      this.cachedResult = JSON.parse(raw) as CachedCheck;
      return this.cachedResult;
    } catch {
      return null;
    }
  }

  private async writeCache(data: CachedCheck): Promise<void> {
    this.cachedResult = data;
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      await fsp.writeFile(this.cachePath, JSON.stringify(data, null, 2));
    } catch {
      // Non-fatal
    }
  }
}

/** Bootstrap the updater and check for updates in background. */
export function bootstrapUpdater(opts: UpdateServiceOpts): UpdateService {
  const updater = new UpdateService(opts);

  // Fire-and-forget startup tasks
  updater.cleanupBackup().catch(() => undefined);

  // Always check for updates (show the banner). The symlink guard
  // only blocks the actual install to protect dev source repos.
  updater.checkForUpdate().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[Cloudways Sync] update check failed:', err);
  });

  return updater;
}
