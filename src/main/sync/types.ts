import type { BreezeStatus, PullIncludes, PushIncludes, SyncStep } from '../../shared/ipcTypes';

export type PullPlan = {
  id: string;
  serverId: number;
  appId: number;
  destinationName: string;
  serverLabel?: string;
  /** When set, pull updates this existing Local site instead of creating a new one. */
  localSiteId?: string;
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
  /** When true, re-activate Breeze on the remote after push. */
  reactivateBreeze?: boolean;
};

export type PullMetadata = {
  homeUrl: string;
  siteUrl: string;
  wpVersion?: string;
  isMultisite: boolean;
  /** Breeze caching plugin status on the remote site. */
  breezeStatus?: BreezeStatus;
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
  /**
   * Names of wp-content subdirs the user selected (e.g. ['plugins',
   * 'themes']). Only these subdirs are replaced on the Local site;
   * unselected subdirs stay untouched. When undefined, the caller
   * didn't narrow the selection — fall back to a full wp-content
   * replace for back-compat with older plans.
   */
  wpContentSubdirs?: string[];
  /** When set, update this existing Local site instead of creating a new one. */
  existingSiteId?: string;
};

export type LocalImportResult = {
  localSiteId: string;
  localUrl: string;
  webRootPath: string;
};

export interface SiteImporter {
  importPulledSite(input: LocalImportInput): Promise<LocalImportResult>;
}
