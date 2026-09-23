import { database } from '@/lib/runtime';

export const COMPLETE_TRIAL_ANALYSES = 250;
export const COMPLETE_TRIAL_DAYS = 14;
export async function completeTrial(organizationId: string) {
  return database().prepare(`SELECT c.organization_id,t.started_at,t.ends_at,c.analyses,
    CASE WHEN t.ends_at>unixepoch() AND t.converted_subscription_id IS NULL AND o.subscription_id=t.subscription_id THEN 1 ELSE 0 END AS active
    FROM complete_trials c JOIN account_trials t ON t.user_id=c.user_id
    JOIN organizations o ON o.organization_id=c.organization_id WHERE c.organization_id=?`)
    .bind(organizationId).first<{organization_id:string;started_at:number;ends_at:number;analyses:number;active:number}>();
}
export async function supportCompleteTrial(workspaceId:string) {
  const row=await database().prepare('SELECT organization_id FROM support_gestion_links WHERE workspace_id=?').bind(workspaceId).first<{organization_id:string}>();
  return row ? completeTrial(row.organization_id) : null;
}
