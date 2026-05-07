import { randomUUID } from 'node:crypto';
import type { PlanPullRequest, PlanPushRequest, PullIncludes, PushIncludes, SyncStep } from '../../shared/ipcTypes';
import type { PullPlan, PushPlan } from './types';

const DEFAULT_INCLUDES: PullIncludes = {
  database: true,
  wpContent: true,
  uploads: true,
  plugins: true,
  themes: true,
  muPlugins: true,
  languages: true,
};

export const PULL_STEPS: Array<Omit<SyncStep, 'status'>> = [
  { id: 'validate', label: 'Validate Cloudways app' },
  { id: 'backup', label: 'Take Cloudways app backup' },
  { id: 'ssh', label: 'Connect over SSH' },
  { id: 'metadata', label: 'Collect WordPress metadata' },
  { id: 'db-export', label: 'Export remote database' },
  { id: 'download-db', label: 'Download database dump' },
  { id: 'download-content', label: 'Download wp-content' },
  { id: 'local-site', label: 'Create Local site' },
  { id: 'local-content', label: 'Install wp-content locally' },
  { id: 'local-db', label: 'Import database locally' },
  { id: 'search-replace', label: 'Rewrite URLs for Local' },
  { id: 'manifest', label: 'Write pull manifest' },
];

export const PUSH_STEPS: Array<Omit<SyncStep, 'status'>> = [
  { id: 'validate', label: 'Validate remote app' },
  { id: 'remote-backup', label: 'Backup remote app' },
  { id: 'ssh', label: 'Connect over SSH' },
  { id: 'metadata', label: 'Read remote WordPress metadata' },
  { id: 'local-export-db', label: 'Export local database' },
  { id: 'upload-db', label: 'Upload database' },
  { id: 'upload-content', label: 'Upload wp-content' },
  { id: 'remote-db-import', label: 'Import database on server' },
  { id: 'search-replace', label: 'Rewrite URLs on server' },
  { id: 'wp-core-update', label: 'Update WordPress core on server' },
  { id: 'breeze-reactivate', label: 'Re-activate Breeze plugin' },
  { id: 'cache-flush', label: 'Flush caches' },
  { id: 'health-check', label: 'Check site health' },
  { id: 'cleanup', label: 'Clean up temporary files' },
];

export class JobStore {
  private readonly pullPlans = new Map<string, PullPlan>();
  private readonly pushPlans = new Map<string, PushPlan>();
  private readonly cancelled = new Set<string>();

  createPullPlan(req: PlanPullRequest): PullPlan {
    const now = new Date().toISOString();
    const plan: PullPlan = {
      id: `pull_${randomUUID()}`,
      linkMode: req.linkMode ?? 'api',
      serverId: req.serverId,
      appId: req.appId,
      destinationName: req.destinationName.trim(),
      serverLabel: req.serverLabel,
      localSiteId: req.localSiteId,
      includes: { ...DEFAULT_INCLUDES, ...req.includes },
      steps: PULL_STEPS.map((step) => ({ ...step, status: 'pending' })),
      createdAt: now,
    };
    this.pullPlans.set(plan.id, plan);
    return plan;
  }

  getPullPlan(planId: string): PullPlan | undefined {
    return this.pullPlans.get(planId);
  }

  createPushPlan(req: PlanPushRequest): PushPlan {
    const now = new Date().toISOString();
    const includes: PushIncludes = { ...DEFAULT_INCLUDES, ...req.includes };
    const plan: PushPlan = {
      id: `push_${randomUUID()}`,
      linkMode: req.linkMode ?? 'api',
      serverId: req.serverId,
      appId: req.appId,
      localSiteId: req.localSiteId,
      localUrl: req.localUrl,
      webRootPath: req.webRootPath,
      includes,
      steps: PUSH_STEPS.map((step) => ({ ...step, status: 'pending' })),
      createdAt: now,
      newAppLabel: req.newAppLabel,
      reactivateBreeze: req.reactivateBreeze,
    };
    this.pushPlans.set(plan.id, plan);
    return plan;
  }

  getPushPlan(planId: string): PushPlan | undefined {
    return this.pushPlans.get(planId);
  }

  cancel(jobId: string): boolean {
    this.cancelled.add(jobId);
    return true;
  }

  isCancelled(jobId: string): boolean {
    return this.cancelled.has(jobId);
  }
}
