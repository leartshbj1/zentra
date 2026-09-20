import { database } from '@/lib/runtime';
import { AccountPublicError } from '@/lib/account-security';
import {
  accessExpiry,
  grantEmail,
  type FounderAction,
} from '@/lib/founder-access-policy';
import type { AccessIdentity } from '@/lib/founder-access';
import { supportPlan, type SupportPlanId } from './plans';

type Grant = {
  email: string;
  grant_id: string;
  user_id: string | null;
  workspace_id: string | null;
  plan_id: SupportPlanId;
  valid_from: number;
  valid_until: number;
  revoked_at: number | null;
  revision: number;
  note: string;
  created_at: number;
  updated_at: number;
  last_operation_id: string;
};
const now = () => Math.floor(Date.now() / 1000);
const read = (email: string) =>
  database()
    .prepare('SELECT * FROM founder_support_grants WHERE email=?')
    .bind(email)
    .first<Grant>();
async function identity(email: string) {
  const rows = await database()
    .prepare(
      'SELECT user_id,email,display_name,provider FROM founder_account_identities WHERE email=? ORDER BY last_seen_at DESC LIMIT 2',
    )
    .bind(email)
    .all<{
      user_id: string;
      email: string;
      display_name: string;
      provider: string;
    }>();
  return rows.results.length === 1 ? rows.results[0] : null;
}
function present(g: Grant | null) {
  return g
    ? {
        email: g.email,
        product: 'support',
        plan: g.plan_id,
        revision: g.revision,
        note: g.note,
        expiresAt: new Date(g.valid_until * 1000).toISOString(),
        createdAt: new Date(g.created_at * 1000).toISOString(),
        updatedAt: new Date(g.updated_at * 1000).toISOString(),
        accountLinked: !!g.user_id && !!g.workspace_id,
        status:
          g.revoked_at !== null
            ? 'revoked'
            : g.valid_until <= now()
              ? 'expired'
              : g.workspace_id
                ? 'active'
                : 'pending',
      }
    : null;
}
export async function lookupSupportAccess(email: string) {
  const [grant, user] = await Promise.all([read(email), identity(email)]);
  return {
    email,
    product: 'support',
    record: present(grant),
    accountKnown: !!user,
    accountName: user?.display_name ?? null,
    serverTime: new Date().toISOString(),
  };
}
export async function listSupportAccess() {
  const rows = await database()
    .prepare(
      'SELECT * FROM founder_support_grants ORDER BY updated_at DESC,email LIMIT 100',
    )
    .all<Grant>();
  return {
    product: 'support',
    records: rows.results.map(present),
    limit: 100,
    serverTime: new Date().toISOString(),
  };
}
export async function attachSupportAccess(user: AccessIdentity) {
  if (!user.emailConfirmed || !user.userId || user.userId.length > 255) return;
  const email = grantEmail(user.email),
    grant = await read(email),
    time = now();
  if (
    !grant ||
    grant.revoked_at !== null ||
    grant.valid_until <= time ||
    (grant.user_id && grant.user_id !== user.userId) ||
    grant.workspace_id
  )
    return;
  const db = database();
  if (
    await db
      .prepare(
        'SELECT email FROM founder_support_grants WHERE user_id=? AND email<>?',
      )
      .bind(user.userId, email)
      .first()
  )
    return;
  // Resolve the unique owner workspace inside the transaction, including concurrent creation.
  const condition =
    'SELECT 1 FROM founder_support_grants WHERE email=? AND user_id=? AND revoked_at IS NULL AND valid_until>?';
  await db.batch([
    db
      .prepare(
        'UPDATE founder_support_grants SET user_id=? WHERE email=? AND (user_id IS NULL OR user_id=?) AND revoked_at IS NULL AND valid_until>?',
      )
      .bind(user.userId, email, user.userId, time),
    db
      .prepare(
        `INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) SELECT ?,?,?,'review',?,? WHERE EXISTS(${condition}) ON CONFLICT(owner_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        user.userId,
        `Espace de ${user.displayName || user.email}`.slice(0, 100),
        time,
        time,
        email,
        user.userId,
        time,
      ),
    db
      .prepare(
        `UPDATE founder_support_grants SET workspace_id=(SELECT id FROM support_workspaces WHERE owner_id=?) WHERE email=? AND user_id=? AND workspace_id IS NULL AND revoked_at IS NULL AND valid_until>?`,
      )
      .bind(user.userId, email, user.userId, time),
  ]);
}
async function attachKnown(email: string) {
  const user = await identity(email);
  if (user)
    await attachSupportAccess({
      userId: user.user_id,
      email: user.email,
      displayName: user.display_name,
      provider: user.provider,
      emailConfirmed: true,
    });
}
export async function changeSupportAccess(action: FounderAction) {
  if (
    action.product !== 'support' ||
    !['grant', 'revoke'].includes(action.operation)
  )
    throw new AccountPublicError('Commande Support invalide.');
  const db = database(),
    email = action.email!,
    time = now();
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(action)),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const previous = await db
    .prepare(
      'SELECT email,action_hash FROM founder_support_events WHERE operation_id=?',
    )
    .bind(action.operationId)
    .first<{ email: string; action_hash: string }>();
  if (previous) {
    if (previous.email !== email || previous.action_hash !== hash)
      throw new AccountPublicError(
        'Cette référence a déjà servi à une autre modification.',
        409,
      );
    await attachKnown(email);
    return { ...(await lookupSupportAccess(email)), replayed: true };
  }
  const current = await read(email);
  if ((current?.revision ?? 0) !== action.expectedRevision)
    throw new AccountPublicError(
      'Cet accès a changé. Actualisez le compte avant de confirmer.',
      409,
    );
  if (action.operation === 'revoke' && !current)
    throw new AccountPublicError('Aucun accès Support offert à retirer.', 404);
  const start =
    action.duration !== 'custom' && current?.revoked_at === null
      ? Math.max(time, current.valid_until)
      : time;
  const expires =
    action.operation === 'grant'
      ? accessExpiry(action.duration, action.customDate, start)
      : current!.valid_until;
  const plan =
    action.operation === 'grant'
      ? supportPlan(action.plan)?.id
      : current!.plan_id;
  if (!plan) throw new AccountPublicError('Formule Support invalide.');
  const result = await db.batch([
    db
      .prepare(`INSERT INTO founder_support_grants(email,grant_id,plan_id,valid_from,valid_until,revoked_at,revision,note,created_at,updated_at,last_operation_id)
      SELECT ?,?,?,?,?,?,1,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM founder_support_grants WHERE email=? AND revision=?)
      ON CONFLICT(email) DO UPDATE SET plan_id=excluded.plan_id,valid_until=excluded.valid_until,revoked_at=excluded.revoked_at,revision=founder_support_grants.revision+1,note=excluded.note,updated_at=excluded.updated_at,last_operation_id=excluded.last_operation_id
      WHERE founder_support_grants.revision=? AND ?>0`)
      .bind(
        email,
        current?.grant_id ?? `sgr_${crypto.randomUUID()}`,
        plan,
        current?.valid_from ?? time,
        expires,
        action.operation === 'revoke' ? time : null,
        action.note,
        time,
        time,
        action.operationId,
        action.expectedRevision,
        email,
        action.expectedRevision,
        action.expectedRevision,
        action.expectedRevision,
      ),
    db
      .prepare(`INSERT INTO founder_support_events(operation_id,email,action_hash,operation,valid_until,created_at,revision)
      SELECT ?,?,?,?,?,?,revision FROM founder_support_grants WHERE email=? AND last_operation_id=? AND revision=?`)
      .bind(
        action.operationId,
        email,
        hash,
        action.operation,
        expires,
        time,
        email,
        action.operationId,
        action.expectedRevision! + 1,
      ),
  ]);
  if (result[0].meta.changes !== 1)
    throw new AccountPublicError(
      'Cet accès a changé. Actualisez le compte avant de confirmer.',
      409,
    );
  if (action.operation === 'grant') await attachKnown(email);
  return { ...(await lookupSupportAccess(email)), replayed: false };
}
// Monthly periods stay anchored to the original grant; extension or plan changes do not reset usage.
export function supportGrantPeriod(anchor: number, time: number) {
  const original = new Date(anchor * 1000),
    current = new Date(time * 1000);
  let months = Math.max(
    0,
    (current.getUTCFullYear() - original.getUTCFullYear()) * 12 +
      current.getUTCMonth() -
      original.getUTCMonth(),
  );
  const boundary = (offset: number) => {
    const d = new Date(anchor * 1000);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + offset);
    const last = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(original.getUTCDate(), last));
    return Math.floor(d.getTime() / 1000);
  };
  if (boundary(months) > time && months > 0) months--;
  return { start: boundary(months), end: boundary(months + 1) };
}
export async function supportGrant(workspace: {
  id: string;
  owner_id: string;
}) {
  const time = now();
  const g = await database()
    .prepare(
      `SELECT g.* FROM founder_support_grants g JOIN support_workspaces w ON w.id=g.workspace_id AND w.owner_id=g.user_id WHERE g.workspace_id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.valid_from<=? AND g.valid_until>?`,
    )
    .bind(workspace.id, workspace.owner_id, time, time)
    .first<Grant>();
  if (!g || !supportPlan(g.plan_id)) return null;
  const period = supportGrantPeriod(g.valid_from, time);
  return {
    plan: supportPlan(g.plan_id)!,
    start: period.start,
    end: Math.min(period.end, g.valid_until),
    expiresAt: g.valid_until,
    revision: g.revision,
  };
}
