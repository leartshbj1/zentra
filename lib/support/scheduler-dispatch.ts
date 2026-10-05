import { database } from '@/lib/runtime';
import { MAIL_BATCH_CONCURRENCY, readMailBacklog } from './mail-sync-batch';

export const SCHEDULER_WORKER_CAPACITY = 8;
// Mirrors the existing unscoped runDueWorkflows selection, not a time guarantee.
export const SCHEDULER_WORKFLOW_SELECTION_LIMIT = 20;
export const SCHEDULER_PLAN_PROTOCOL = 'zentra-scheduler-demand';
export const SCHEDULER_PLAN_MAX_AGE_SECONDS = 90;

export type WorkflowBacklog = { due: number; expired: number; active: number };
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Read-only aggregate; never selects ticket/mail content, identities or secrets.
 * Counts do not grant execution rights. The original worker checks subscription,
 * delegation, quota, revision and lease afresh before performing each effect.
 */
export async function readWorkflowBacklog(): Promise<WorkflowBacklog> {
  const time = Math.floor(Date.now() / 1000);
  const row = await database().prepare(`SELECT
    COALESCE(SUM(state IN ('queued','waiting') AND due_at<=? AND lease_until<=?),0) AS due,
    COALESCE(SUM(state='running' AND lease_until<=?),0) AS expired,
    COALESCE(SUM(state='running' AND lease_until>?),0) AS active
    FROM automation_workflow_runs WHERE state IN ('queued','waiting','running')`)
    .bind(time,time,time,time).first<WorkflowBacklog>();
  if (!row || ![row.due,row.expired,row.active].every(count))
    throw new Error('Workflow backlog unavailable');
  return { due: row.due, expired: row.expired, active: row.active };
}

export function schedulerWorkerDemand(mailboxesDue: number, workflowsDue: number, expiredWorkflows: number): number {
  if (![mailboxesDue,workflowsDue,expiredWorkflows].every(count))
    throw new Error('Scheduler demand unavailable');
  return Math.min(SCHEDULER_WORKER_CAPACITY, Math.max(
    Math.ceil(mailboxesDue / MAIL_BATCH_CONCURRENCY),
    Math.ceil(workflowsDue / SCHEDULER_WORKFLOW_SELECTION_LIMIT),
    expiredWorkflows > 0 ? 1 : 0,
  ));
}

export async function readSchedulerDemand() {
  const [mailboxes, workflows] = await Promise.all([readMailBacklog(), readWorkflowBacklog()]);
  const observedAt = Math.floor(Date.now() / 1000);
  return { mailboxes, workflows, plan: {
    protocol: SCHEDULER_PLAN_PROTOCOL,
    version: 1,
    observedAt,
    desiredWorkers: schedulerWorkerDemand(mailboxes.due,workflows.due,workflows.expired),
    mailboxesDue: mailboxes.due,
    workflowsDue: workflows.due,
    expiredWorkflows: workflows.expired,
    activeMailboxes: mailboxes.active,
    activeWorkflows: workflows.active,
  } };
}
