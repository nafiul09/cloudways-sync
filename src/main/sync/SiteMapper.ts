import fs from 'node:fs';
import path from 'node:path';
import { isApiMapping, type ApiSiteMapping, type SiteMapping } from '../../shared/ipcTypes';

/**
 * Persists site mappings (Local site ID -> Cloudways app or SFTP-only
 * link) to a JSON file. The mapper is keyed by `localSiteId`; a site
 * can only be mapped to one remote at a time.
 *
 * Mappings carry a `linkMode` discriminator: 'api' mappings hold a
 * serverId/appId pair, 'sftp' mappings hold direct SSH/SFTP coordinates.
 * Legacy records written before the field existed are migrated to
 * `linkMode: 'api'` on read so existing addons keep working unchanged.
 */
export class SiteMapper {
  private readonly filePath: string;
  private mappings: SiteMapping[] | undefined;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'cloudwayssync', 'site-mappings.json');
  }

  async get(localSiteId: string): Promise<SiteMapping | null> {
    const mappings = await this.list();
    return mappings.find((m) => m.localSiteId === localSiteId) ?? null;
  }

  /**
   * Find the API-mode mapping for a given Cloudways serverId/appId pair.
   * SFTP-mode mappings are skipped because they have no serverId/appId.
   */
  async getByApp(serverId: number, appId: number): Promise<ApiSiteMapping | null> {
    const mappings = await this.list();
    const found = mappings.find(
      (m): m is ApiSiteMapping =>
        isApiMapping(m) && m.serverId === serverId && m.appId === appId,
    );
    return found ?? null;
  }

  async set(mapping: SiteMapping): Promise<void> {
    const mappings = await this.list();
    const idx = mappings.findIndex((m) => m.localSiteId === mapping.localSiteId);
    if (idx >= 0) {
      mappings[idx] = mapping;
    } else {
      mappings.push(mapping);
    }
    await this.save(mappings);
  }

  /**
   * Delete a mapping by localSiteId. The optional `expected` filter
   * is only meaningful for API-mode mappings — it lets a caller assert
   * the mapping they're removing still points at the same Cloudways
   * app (defends against a race where the user re-linked elsewhere).
   * SFTP-mode mappings always pass the filter (they have no serverId).
   */
  async delete(
    localSiteId: string,
    expected?: { serverId?: number; appId?: number },
  ): Promise<boolean> {
    const mappings = await this.list();
    const next = mappings.filter((m) => {
      if (m.localSiteId !== localSiteId) return true;
      if (isApiMapping(m)) {
        if (expected?.serverId !== undefined && m.serverId !== expected.serverId) return true;
        if (expected?.appId !== undefined && m.appId !== expected.appId) return true;
      }
      return false;
    });
    if (next.length === mappings.length) return false;
    await this.save(next);
    return true;
  }

  async list(): Promise<SiteMapping[]> {
    if (!this.mappings) {
      this.mappings = await this.load();
    }
    return this.mappings;
  }

  private async load(): Promise<SiteMapping[]> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Migrate legacy records that lack `linkMode` — they were always
      // API-mode by definition (no other mode existed).
      return parsed
        .map((m): SiteMapping | null => migrateLegacy(m))
        .filter((m): m is SiteMapping => m !== null);
    } catch {
      return [];
    }
  }

  private async save(mappings: SiteMapping[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(this.filePath, JSON.stringify(mappings, null, 2) + '\n', 'utf8');
    this.mappings = mappings;
  }
}

/**
 * Backfill `linkMode` on legacy records. Anything we can't recognise
 * is dropped silently — better to lose a malformed entry than to crash
 * the addon at boot.
 */
function migrateLegacy(raw: unknown): SiteMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.localSiteId !== 'string') return null;

  if (m.linkMode === 'sftp') {
    return raw as SiteMapping;
  }
  // Treat everything else as API mode (legacy default + explicit 'api').
  if (typeof m.serverId !== 'number' || typeof m.appId !== 'number') return null;
  return { ...(raw as object), linkMode: 'api' } as SiteMapping;
}
