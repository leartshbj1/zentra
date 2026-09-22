import { database } from '@/lib/runtime';
import type { AutomationActor } from './access';
export async function workflowDaily(
  actor: AutomationActor,
  from: number,
  until: number,
) {
  const privileged = ['owner', 'admin', 'accountant'].includes(actor.role)
    ? 1
    : 0;
  const [items, runs] = await Promise.all([
    database()
      .prepare(`SELECT
      COALESCE(SUM(CASE WHEN i.created_at>=? AND i.created_at<? AND i.kind='task' THEN 1 ELSE 0 END),0) AS tasks,
      COALESCE(SUM(CASE WHEN i.created_at>=? AND i.created_at<? AND i.kind='reply_draft' THEN 1 ELSE 0 END),0) AS drafts,
      COALESCE(SUM(CASE WHEN i.created_at>=? AND i.created_at<? AND i.kind='summary' THEN 1 ELSE 0 END),0) AS summaries,
      COALESCE(SUM(CASE WHEN i.state='open' THEN 1 ELSE 0 END),0) AS open
      FROM automation_work_items i JOIN automation_workflow_runs r ON r.id=i.run_id AND r.organization_id=i.organization_id
      WHERE i.organization_id=? AND r.state<>'undone'
      AND (?=1 OR COALESCE(json_extract(r.result,'$.category'),'')<>'human_resources')
      AND (?=1 OR i.assigned_to IS NULL OR i.assigned_to=?)`)
      .bind(
        from,
        until,
        from,
        until,
        from,
        until,
        actor.organizationId,
        privileged,
        privileged,
        actor.userId,
      )
      .first<{
        tasks: number;
        drafts: number;
        summaries: number;
        open: number;
      }>(),
    database()
      .prepare(`SELECT
      COALESCE(SUM(CASE WHEN state IN ('review','failed') THEN 1 ELSE 0 END),0) AS review,
      COALESCE(SUM(CASE WHEN state='observed' AND finished_at>=? AND finished_at<? THEN 1 ELSE 0 END),0) AS observed
      FROM automation_workflow_runs WHERE organization_id=?
      AND (?=1 OR COALESCE(json_extract(result,'$.category'),'')<>'human_resources')`)
      .bind(from, until, actor.organizationId, privileged)
      .first<{ review: number; observed: number }>(),
  ]);
  return {
    ...(items ?? { tasks: 0, drafts: 0, summaries: 0, open: 0 }),
    ...(runs ?? { review: 0, observed: 0 }),
  };
}
