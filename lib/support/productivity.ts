import { database } from '@/lib/runtime';
import { automationDay } from '@/lib/automation/activity';
import { automationEntitlement } from '@/lib/automation/entitlement';
import { senderPolicies } from './sender-policies';
import { followups, followupMembers } from './followups';
export async function productivityState(
  workspace: string,
  userId: string,
  manage: boolean,
  current?: { email: string; role: string },
) {
  const db = database(),
    day = automationDay();
  const [daily, health, policies, followupRows, members, linked] =
    await Promise.all([
      db
        .prepare(`SELECT COUNT(DISTINCT CASE WHEN kind IN ('routed','quiet') AND actor='Zentra Support' THEN ticket_id END) AS sorted,
      COUNT(DISTINCT CASE WHEN kind='quiet' AND actor='Zentra Support' THEN ticket_id END) AS quiet
      FROM support_events WHERE workspace_id=? AND created_at>=? AND created_at<?`)
        .bind(workspace, day.from, day.until)
        .first<{ sorted: number; quiet: number }>(),
      db
        .prepare(`SELECT c.id,c.label,c.provider,c.checked_at AS checkedAt,c.check_error AS checkError,
      m.last_sync_at AS lastSyncAt,m.last_error AS lastError,
      (SELECT MAX(t.created_at) FROM support_tickets t WHERE t.connection_id=c.id AND t.workspace_id=c.workspace_id) AS lastReceivedAt
      FROM support_connections c LEFT JOIN support_mailboxes m ON m.connection_id=c.id WHERE c.workspace_id=? AND c.active=1`)
        .bind(workspace)
        .all(),
      manage ? senderPolicies(workspace) : Promise.resolve([]),
      followups(workspace),
      followupMembers(workspace),
      db
        .prepare(
          `SELECT l.organization_id,m.role FROM support_gestion_links l JOIN organization_members m ON m.organization_id=l.organization_id AND m.user_id=? AND m.revoked_at IS NULL WHERE l.workspace_id=? AND l.enabled=1`,
        )
        .bind(userId, workspace)
        .first<{ organization_id: string; role: string }>(),
    ]);
  const pending = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM support_tickets WHERE workspace_id=? AND state IN ('review','error')",
    )
    .bind(workspace)
    .first<{ n: number }>();
  let gestion: null | {
      invoices: number;
      appointments: number;
      pending: number;
    } = null,
    canCreateGestion = false;
  if (
    linked &&
    (await automationEntitlement({
      organizationId: linked.organization_id,
      userId,
      role: linked.role,
      founder: false,
    }))
  ) {
    // Counts only; do not expose accounting or personnel documents through Support.
    const [invoices, appointments] = await Promise.all([
      db
        .prepare(
          "SELECT SUM(state='imported' AND imported_at>=? AND imported_at<?) AS n,SUM(state IN ('review','ready','processing')) AS pending FROM supplier_inbox WHERE organization_id=?",
        )
        .bind(day.from, day.until, linked.organization_id)
        .first<{ n: number; pending: number }>(),
      db
        .prepare(
          "SELECT SUM(state='imported' AND imported_at>=? AND imported_at<?) AS n,SUM(state IN ('review','ready','processing')) AS pending FROM automation_appointments WHERE organization_id=?",
        )
        .bind(day.from, day.until, linked.organization_id)
        .first<{ n: number; pending: number }>(),
    ]);
    gestion = {
      invoices: Number(invoices?.n || 0),
      appointments: Number(appointments?.n || 0),
      pending:
        Number(invoices?.pending || 0) + Number(appointments?.pending || 0),
    };
    canCreateGestion = linked.role !== 'read_only';
  }
  if (
    current &&
    current.role !== 'read_only' &&
    !members.some((m) => m.email.toLowerCase() === current.email.toLowerCase())
  )
    members.unshift(current);
  return {
    day: day.date,
    timeZone: day.timeZone,
    daily: {
      sorted: Number(daily?.sorted || 0),
      quiet: Number(daily?.quiet || 0),
      pending: pending?.n || 0,
      gestion,
    },
    health: health.results,
    policies,
    followups: followupRows,
    members,
    canCreateGestion,
  };
}
