import { randomUUID } from 'node:crypto';
import type { PlanPullRequest, PullIncludes, SyncStep } from '../../shared/ipcTypes';
import type { PullPlan } from './types';

const DEFAULT_INCLUDES: PullIncludes = {
  database: true,
  wpContent: true,
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

export class JobStore {
  private readonly plans = new Map<string, PullPlan>();
  private readonly cancelled = new Set<string>();

  createPullPlan(req: PlanPullRequest): PullPlan {
    const now = new Date().toISOString();
    const plan: PullPlan = {
      id: `pull_${randomUUID()}`,
      serverId: req.serverId,
      appId: req.appId,
      destinationName: req.destinationName.trim(),
      includes: { ...DEFAULT_INCLUDES, ...req.includes },
      steps: PULL_STEPS.map((step) => ({ ...step, status: 'pending' })),
      createdAt: now,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  getPullPlan(planId: string): PullPlan | undefined {
    return this.plans.get(planId);
  }

  cancel(jobId: string): boolean {
    this.cancelled.add(jobId);
    return true;
  }

  isCancelled(jobId: string): boolean {
    return this.cancelled.has(jobId);
  }
}
