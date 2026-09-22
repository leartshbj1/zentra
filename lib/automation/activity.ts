import { database } from '@/lib/runtime';
import type { AutomationActor } from './access';
import { automationEntitlement } from './entitlement';
import { globalFlags, settingsFor } from './config';
import { FEATURES, type Feature } from './types';
import { inboxDaily } from '@/lib/supplier-inbox/service';
import { appointmentDaily } from '@/lib/appointments/service';

const zone = 'Europe/Zurich';
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
// Derive both midnights in the company's Swiss calendar (23/25-hour DST days).
export function automationDay(now = new Date()) {
  const parts = dateFormat.formatToParts(now);
  const value = (name: string) =>
    Number(parts.find((p) => p.type === name)!.value);
  const midnight = Date.UTC(value('year'), value('month') - 1, value('day'));
  const localMidnight = (utc: number) => {
    let candidate = utc;
    for (let i = 0; i < 3; i++) {
      const offset = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        timeZoneName: 'longOffset',
      })
        .formatToParts(candidate)
        .find((p) => p.type === 'timeZoneName')!.value;
      const match = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
      const seconds = match
        ? (Number(match[2]) * 3600 + Number(match[3]) * 60) *
          (match[1] === '+' ? 1 : -1)
        : 0;
      candidate = utc - seconds * 1000;
    }
    return candidate / 1000;
  };
  return {
    date: new Date(midnight).toISOString().slice(0, 10),
    timeZone: zone,
    from: localMidnight(midnight),
    until: localMidnight(midnight + 86400000),
  };
}

type Counts = {
  analyzed: number;
  suggestions: number;
  confirmed: number;
  needsReview: number;
  observed: number;
};
type ActivityRow = Counts & { feature: Feature };
const emptyCounts = (): Counts => ({
  analyzed: 0,
  suggestions: 0,
  confirmed: 0,
  needsReview: 0,
  observed: 0,
});

/** Shared, company-scoped totals only. No document contents, predictions, or colleague identities. */
async function companyActivity(actor: AutomationActor, now: Date) {
  const day = automationDay(now);
  const [rows, identity] = await Promise.all([
    database()
      .prepare(`SELECT feature,SUM(analyzed) AS analyzed,SUM(suggestions) AS suggestions,
      SUM(confirmed) AS confirmed,SUM(needsReview) AS needsReview,SUM(observed) AS observed FROM (
      SELECT feature,1 AS analyzed,
        CASE WHEN mode='suggest' AND json_extract(result,'$.status')='suggestion' THEN 1 ELSE 0 END AS suggestions,
        0 AS confirmed,
        CASE WHEN mode='suggest' AND feedback IS NULL AND json_extract(result,'$.status') IN ('suggestion','manual') THEN 1 ELSE 0 END AS needsReview,
        CASE WHEN mode='shadow' THEN 1 ELSE 0 END AS observed
      FROM automation_decisions WHERE organization_id=? AND state='completed' AND completed_at>=? AND completed_at<?
      UNION ALL
      SELECT feature,0,0,1,0,0 FROM automation_decisions
      WHERE organization_id=? AND state='completed' AND mode='suggest' AND feedback IN ('accepted','modified') AND reviewed_at>=? AND reviewed_at<?
    ) GROUP BY feature`)
      .bind(
        actor.organizationId,
        day.from,
        day.until,
        actor.organizationId,
        day.from,
        day.until,
      )
      .all<ActivityRow>(),
    database()
      .prepare(
        'SELECT display_name FROM organization_members WHERE user_id=? AND organization_id=? AND revoked_at IS NULL',
      )
      .bind(actor.userId, actor.organizationId)
      .first<{ display_name: string }>(),
  ]);
  const features = rows.results.filter((row) => FEATURES.includes(row.feature));
  const totals = features.reduce((sum, row) => {
    for (const key of Object.keys(sum) as (keyof Counts)[])
      sum[key] += Number(row[key]);
    return sum;
  }, emptyCounts());
  // A missing profile name remains a simple greeting, never an inferred name from an email.
  const name = identity?.display_name?.trim();
  return {
    date: day.date,
    timeZone: day.timeZone,
    updatedAt: Math.floor(now.getTime() / 1000),
    displayName: name && !name.includes('@') ? name.slice(0, 80) : null,
    totals,
    features,
    supplierInbox: await inboxDaily(actor.organizationId, day.from, day.until),
    appointments: await appointmentDaily(
      actor.organizationId,
      day.from,
      day.until,
    ),
    workflows: await workflowDaily(actor, day.from, day.until),
  };
}

export async function automationCompanyState(
  actor: AutomationActor,
  now = new Date(),
) {
  const [settings, available, active] = await Promise.all([
    settingsFor(actor.organizationId),
    globalFlags(),
    automationEntitlement(actor),
  ]);
  return {
    organizationId: actor.organizationId,
    active,
    settings,
    available,
    canManage: ['owner', 'admin'].includes(actor.role),
    activity: active ? await companyActivity(actor, now) : null,
  };
}

import { workflowDaily } from './workflow-activity';
