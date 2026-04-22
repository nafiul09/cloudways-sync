import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { MultiSite } from '@getflywheel/local';
import type { ServiceContainerServices } from '@getflywheel/local/main';
import type { LocalImportInput, LocalImportResult, SiteImporter } from './types';

const gunzip = promisify(zlib.gunzip);

type LocalServices = Pick<
  ServiceContainerServices,
  'addSite' | 'siteProcessManager' | 'siteDatabase' | 'importSQLFile' | 'wpCli'
>;

export type LocalSiteImporterOptions = {
  services: LocalServices;
  sitesRoot?: string;
};

export class LocalSiteImporter implements SiteImporter {
  private readonly services: LocalServices;
  private readonly sitesRoot: string;

  constructor(opts: LocalSiteImporterOptions) {
    this.services = opts.services;
    this.sitesRoot = opts.sitesRoot ?? path.join(os.homedir(), 'Local Sites');
  }

  async importPulledSite(input: LocalImportInput): Promise<LocalImportResult> {
    const slug = await uniqueSlug(toSiteSlug(input.siteName), this.sitesRoot);
    const sitePath = path.join(this.sitesRoot, slug);
    const siteDomain = `${slug}.local`;
    const sqlPath = input.importDatabase ? await ensureSqlDump(input.dbDumpPath) : undefined;

    const site = await this.services.addSite.addSite({
      newSiteInfo: {
        siteName: input.siteName,
        sitePath,
        siteDomain,
        multiSite: MultiSite.No,
        environment: 'custom',
        database: 'mysql',
      },
      wpCredentials: {
        adminUsername: 'cloudwayssync',
        adminPassword: randomPassword(),
        adminEmail: 'cloudwayssync@example.local',
      },
      goToSite: false,
      installWP: true,
    });

    await this.services.siteProcessManager.start(site);
    await this.services.siteDatabase.waitForDB(site);

    if (input.importWpContent) {
      const targetWpContent = path.join(site.paths.webRoot, 'wp-content');
      await fs.promises.rm(targetWpContent, { recursive: true, force: true });
      await fs.promises.cp(input.wpContentPath, targetWpContent, { recursive: true });
    }

    const localUrl = site.url || `http://${siteDomain}`;

    if (input.importDatabase && sqlPath) {
      await this.services.importSQLFile(site, sqlPath);
      await this.services.wpCli.run(site, [
        'search-replace',
        input.sourceUrl,
        localUrl,
        '--all-tables',
        '--skip-columns=guid',
      ]);
    }

    await this.services.wpCli.run(site, ['cache', 'flush'], { ignoreErrors: true });
    await this.services.wpCli.run(site, ['rewrite', 'flush'], { ignoreErrors: true });

    return {
      localSiteId: site.id,
      localUrl,
    };
  }
}

async function ensureSqlDump(filePath: string): Promise<string> {
  if (!filePath.endsWith('.gz')) return filePath;
  const out = filePath.slice(0, -3);
  const compressed = await fs.promises.readFile(filePath);
  await fs.promises.writeFile(out, await gunzip(compressed));
  return out;
}

export function toSiteSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'cloudways-site';
}

/** If the target directory already exists (e.g. from a previous pull),
 * append -2, -3, … until we find a free slot. */
async function uniqueSlug(base: string, sitesRoot: string): Promise<string> {
  let candidate = base;
  let n = 1;
  while (true) {
    try {
      await fs.promises.access(path.join(sitesRoot, candidate));
      // exists — try next
      n++;
      candidate = `${base}-${n}`;
    } catch {
      return candidate;
    }
  }
}

function randomPassword(): string {
  return `Cws-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
