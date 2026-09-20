import { database, runtimeValue } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import {
  accessExpiry,
  grantEmail,
  type FounderAction,
} from '@/lib/founder-access-policy';
import {
  offerForOrganization,
  type AccessIdentity,
} from '@/lib/founder-access';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';

type Grant = {
  email: string;
  grant_id: string;
  user_id: string | null;
  organization_id: string | null;
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
    .prepare('SELECT * FROM founder_automation_grants WHERE email=?')
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
async function owned(userId: string) {
  const rows = await database()
    .prepare(
      `SELECT o.organization_id AS id,o.name FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=o.created_by_user_id WHERE o.created_by_user_id=? AND m.role='owner' AND m.revoked_at IS NULL ORDER BY o.created_at,o.organization_id`,
    )
    .bind(userId)
    .all<{ id: string; name: string }>();
  return rows.results;
}
export async function automationBaseActive(organizationId: string) {
  const row = await database()
    .prepare(
      'SELECT s.entitlement_valid_until,s.livemode FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id WHERE o.organization_id=?',
    )
    .bind(organizationId)
    .first<{ entitlement_valid_until: number; livemode: number }>();
  const live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
  return (
    !!row &&
    ((live !== null &&
      row.livemode === Number(live) &&
      row.entitlement_valid_until > now()) ||
      !!(await offerForOrganization(organizationId)))
  );
}
function present(g: Grant | null) {
  return g
    ? {
        email: g.email,
        product: 'automation' as const,
        organizationId: g.organization_id,
        revision: g.revision,
        note: g.note,
        expiresAt: new Date(g.valid_until * 1000).toISOString(),
        createdAt: new Date(g.created_at * 1000).toISOString(),
        updatedAt: new Date(g.updated_at * 1000).toISOString(),
        accountLinked: !!g.user_id && !!g.organization_id,
        status:
          g.revoked_at !== null
            ? 'revoked'
            : g.valid_until <= now()
              ? 'expired'
              : g.organization_id
                ? 'active'
                : 'pending',
      }
    : null;
}
export async function lookupAutomationAccess(email: string) {
  await attachKnown(email);
  const [grant, user] = await Promise.all([read(email), identity(email)]);
  const organizations =
    user && (!grant?.user_id || grant.user_id === user.user_id)
      ? await owned(user.user_id)
      : [];
  const selected =
    grant?.organization_id ||
    (organizations.length === 1 ? organizations[0].id : null);
  const available = selected && organizations.some((o) => o.id === selected);
  return {
    email,
    product: 'automation',
    record: present(grant),
    accountKnown: !!user,
    accountName: user?.display_name ?? null,
    organizations,
    availability: !user
      ? 'account_required'
      : !available
        ? organizations.length > 1
          ? 'organization_ambiguous'
          : 'organization_required'
        : (await automationBaseActive(selected!))
          ? 'ready'
          : 'gestion_required',
    serverTime: new Date().toISOString(),
  };
}
export async function listAutomationAccess() {
  const rows = await database()
    .prepare(
      'SELECT * FROM founder_automation_grants ORDER BY updated_at DESC,email LIMIT 100',
    )
    .all<Grant>();
  return {
    product: 'automation',
    records: rows.results.map(present),
    limit: 100,
    serverTime: new Date().toISOString(),
  };
}
export async function attachAutomationAccess(
  user: AccessIdentity,
  selectedOrganization?: string,
) {
  if (!user.emailConfirmed || !user.userId || user.userId.length > 255) return;
  const email = grantEmail(user.email),
    grant = await read(email),
    time = now();
  if (
    !grant ||
    grant.revoked_at !== null ||
    grant.valid_until <= time ||
    (grant.user_id && grant.user_id !== user.userId) ||
    grant.organization_id
  )
    return;
  const db = database();
  if (
    await db
      .prepare(
        'SELECT email FROM founder_automation_grants WHERE user_id=? AND email<>?',
      )
      .bind(user.userId, email)
      .first()
  )
    return;
  const organizations = await owned(user.userId);
  const organization = selectedOrganization
    ? organizations.find((o) => o.id === selectedOrganization)
    : organizations.length === 1
      ? organizations[0]
      : null;
  // Reserve the verified identity even before a company exists. Never create a
  // Gestion subscription or choose one of several companies on the user's behalf.
  await db
    .prepare(
      'UPDATE founder_automation_grants SET user_id=? WHERE email=? AND (user_id IS NULL OR user_id=?) AND revoked_at IS NULL AND valid_until>?',
    )
    .bind(user.userId, email, user.userId, time)
    .run();
  if (organization)
    await db
      .prepare(
        `UPDATE founder_automation_grants SET organization_id=? WHERE email=? AND user_id=? AND organization_id IS NULL AND revoked_at IS NULL AND valid_until>? AND EXISTS(SELECT 1 FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=o.created_by_user_id WHERE o.organization_id=? AND o.created_by_user_id=? AND m.role='owner' AND m.revoked_at IS NULL)`,
      )
      .bind(
        organization.id,
        email,
        user.userId,
        time,
        organization.id,
        user.userId,
      )
      .run();
}
async function attachKnown(email: string, organizationId?: string) {
  const user = await identity(email);
  if (user)
    await attachAutomationAccess(
      {
        userId: user.user_id,
        email: user.email,
        displayName: user.display_name,
        provider: user.provider,
        emailConfirmed: true,
      },
      organizationId,
    );
}
export async function changeAutomationAccess(action: FounderAction) {
  if (
    action.product !== 'automation' ||
    !['grant', 'revoke'].includes(action.operation)
  )
    throw new AccountPublicError('Commande Automation invalide.');
  const db = database(),
    email = action.email!,
    time = now(),
    hash = await sha256Hex(JSON.stringify(action));
  const previous = await db
    .prepare(
      'SELECT email,action_hash FROM founder_automation_events WHERE operation_id=?',
    )
    .bind(action.operationId)
    .first<{ email: string; action_hash: string }>();
  if (previous) {
    if (previous.email !== email || previous.action_hash !== hash)
      throw new AccountPublicError(
        'Cette référence a déjà servi à une autre modification.',
        409,
      );
    await attachKnown(email, action.organizationId);
    return { ...(await lookupAutomationAccess(email)), replayed: true };
  }
  const current = await read(email);
  if ((current?.revision ?? 0) !== action.expectedRevision)
    throw new AccountPublicError(
      'Cet accès a changé. Actualisez le compte avant de confirmer.',
      409,
    );
  if (action.operation === 'revoke' && !current)
    throw new AccountPublicError(
      'Aucun accès Automation offert à retirer.',
      404,
    );
  let organizationId: string | null = current?.organization_id ?? null;
  let userId: string | null = current?.user_id ?? null;
  if (action.operation === 'grant') {
    const user = await identity(email);
    if (current?.user_id && user?.user_id !== current.user_id)
      throw new AccountPublicError(
        'Cette adresse n’est plus liée au compte bénéficiaire initial.',
        409,
      );
    const organizations = user ? await owned(user.user_id) : [];
    if (
      action.organizationId &&
      (!organizations.some((o) => o.id === action.organizationId) ||
        (organizationId && organizationId !== action.organizationId))
    )
      throw new AccountPublicError(
        'Cette entreprise n’appartient pas à ce bénéficiaire ou cet accès est déjà lié à une autre entreprise.',
        409,
      );
    if (!organizationId && organizations.length > 1 && !action.organizationId)
      throw new AccountPublicError(
        'Choisissez l’entreprise à laquelle offrir Automation.',
        409,
      );
    organizationId ||=
      action.organizationId ||
      (organizations.length === 1 ? organizations[0].id : null);
    userId ||= user?.user_id ?? null;
    if (
      userId &&
      (await db
        .prepare(
          'SELECT email FROM founder_automation_grants WHERE user_id=? AND email<>?',
        )
        .bind(userId, email)
        .first())
    )
      throw new AccountPublicError(
        'Ce compte possède déjà un accès Automation sous une autre adresse.',
        409,
      );
  }
  const start =
    action.duration !== 'custom' && current?.revoked_at === null
      ? Math.max(time, current.valid_until)
      : time;
  const expires =
    action.operation === 'grant'
      ? accessExpiry(action.duration, action.customDate, start)
      : current!.valid_until;
  const result = await db.batch([
    db
      .prepare(`INSERT INTO founder_automation_grants(email,grant_id,user_id,organization_id,valid_from,valid_until,revoked_at,revision,note,created_at,updated_at,last_operation_id)
      SELECT ?,?,?,?,?,?,?,1,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM founder_automation_grants WHERE email=? AND revision=?)
      ON CONFLICT(email) DO UPDATE SET user_id=COALESCE(founder_automation_grants.user_id,excluded.user_id),organization_id=COALESCE(founder_automation_grants.organization_id,excluded.organization_id),valid_until=excluded.valid_until,revoked_at=excluded.revoked_at,revision=founder_automation_grants.revision+1,note=excluded.note,updated_at=excluded.updated_at,last_operation_id=excluded.last_operation_id WHERE founder_automation_grants.revision=? AND ?>0`)
      .bind(
        email,
        current?.grant_id ?? `agr_${crypto.randomUUID()}`,
        userId,
        organizationId,
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
      .prepare(
        `INSERT INTO founder_automation_events(operation_id,email,action_hash,operation,valid_until,created_at,revision) SELECT ?,?,?,?,?,?,revision FROM founder_automation_grants WHERE email=? AND last_operation_id=? AND revision=?`,
      )
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
  return { ...(await lookupAutomationAccess(email)), replayed: false };
}
export async function automationGrant(organizationId: string) {
  // Device sessions may already be open when the founder grants an email.
  const owner = await database()
    .prepare(
      'SELECT i.email FROM organizations o JOIN founder_account_identities i ON i.user_id=o.created_by_user_id WHERE o.organization_id=?',
    )
    .bind(organizationId)
    .first<{ email: string }>();
  if (owner) await attachKnown(owner.email);
  const time = now();
  const grant = await database()
    .prepare(
      `SELECT g.* FROM founder_automation_grants g JOIN organizations o ON o.organization_id=g.organization_id AND o.created_by_user_id=g.user_id JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=g.user_id AND m.role='owner' AND m.revoked_at IS NULL WHERE g.organization_id=? AND g.revoked_at IS NULL AND g.valid_from<=? AND g.valid_until>?`,
    )
    .bind(organizationId, time, time)
    .first<Grant>();
  return grant && (await automationBaseActive(organizationId)) ? grant : null;
}
