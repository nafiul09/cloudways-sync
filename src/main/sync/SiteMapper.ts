import fs from 'node:fs';
import path from 'node:path';
import type { SiteMapping } from '../../shared/ipcTypes';

/**
 * Persists site mappings (Local site ID -> Cloudways app) to a JSON
 * file so subsequent pushes default to Mode A. The mapper is keyed by
 * `localSiteId`; a site can only be mapped to one remote app at a time.
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
      return Array.isArray(parsed) ? parsed : [];
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
