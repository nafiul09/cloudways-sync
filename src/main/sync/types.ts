import type { PullIncludes, PushIncludes, SyncStep } from '../../shared/ipcTypes';

export type PullPlan = {
  id: string;
  serverId: number;
  appId: number;
  destinationName: string;
  includes: PullIncludes;
  steps: SyncStep[];
  createdAt: string;
};

export type PushPlan = {
  id: string;
  serverId: number;
  appId: number;
  localSiteId: string;
  localUrl: string;
  webRootPath: string;
  includes: PushIncludes;
  steps: SyncStep[];
  createdAt: string;
  /** For Mode B: label for the new Cloudways app. Present when appId was originally 0. */
  newAppLabel?: string;
};

export type PullMetadata = {
  homeUrl: string;
  siteUrl: string;
  wpVersion?: string;
  isMultisite: boolean;
};

export type LocalImportInput = {
  siteName: string;
  sourceUrl: string;
  dbDumpPath: string;
  wpContentPath: string;
  manifestPath: string;
  metadata: PullMetadata;
  /** When false, skip DB import + search-replace (content-only pull). */
  importDatabase: boolean;
  /** When false, skip wp-content copy (DB-only pull). */
  importWpContent: boolean;
};

export type LocalImportResult = {
  localSiteId: string;
  localUrl: string;
};

export interface SiteImporter {
  importPulledSite(input: LocalImportInput): Promise<LocalImportResult>;
}
