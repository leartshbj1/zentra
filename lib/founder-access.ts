import { database } from './runtime';
import { AccountPublicError } from './account-security';
import {
  accessExpiry,
  grantEmail,
  SOLO_PLAN,
  type FounderAction,
} from './founder-access-policy';
import { planByLicense } from './plans';

export type AccessIdentity = {
  userId: string;
  email: string;
  displayName: string;
  provider: string;
  emailConfirmed: boolean;
};
export type GrantRow = {
  email: string;
  grant_id: string;
  user_id: string | null;
  organization_id: string | null;
  valid_until: number;
  revoked_at: number | null;
  revision: number;
  note: string;
  created_at: number;
  updated_at: number;
  last_operation_id: string;
};
const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function readGrant(email: string): Promise<GrantRow | null> {
  return database()
    .prepare('SELECT * FROM founder_access_grants WHERE email=? LIMIT 1')
    .bind(email)
    .first<GrantRow>();
}

export async function grantForAccount(
  subscriptionId: string,
  userId: string | null | undefined,
) {
  if (!userId) return null;
  return database()
    .prepare(
      `SELECT g.valid_until,s.customer_name,s.entitlement_valid_until,s.last_paid_invoice_id,s.entitlement_plan_id,s.seat_limit
       FROM founder_access_grants g
       JOIN organizations o ON o.organization_id=g.organization_id
       JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=g.user_id
       JOIN subscriptions s ON s.subscription_id=o.subscription_id
      WHERE o.subscription_id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.valid_until>?
        AND m.revoked_at IS NULL AND m.role='owner' AND o.created_by_user_id=g.user_id LIMIT 1`,
    )
    .bind(subscriptionId, userId, nowSeconds())
    .first<{
      valid_until: number;
      customer_name: string | null;
      entitlement_valid_until: number;
      last_paid_invoice_id: string | null;
      entitlement_plan_id: string;
      seat_limit: number | null;
    }>();
}

export async function offeredLicenseEntitlement(
  subscriptionId: string,
  userId: string | null | undefined,
) {
  const grant = await grantForAccount(subscriptionId, userId);
  if (!grant) return null;
  const paidPlan = planByLicense(grant.entitlement_plan_id);
  const paid =
    grant.last_paid_invoice_id &&
    grant.entitlement_valid_until >= nowSeconds() &&
    paidPlan &&
    grant.seat_limit === paidPlan.seats;
  return {
    customer_name: grant.customer_name,
    entitlement_valid_until: Math.max(
      grant.valid_until,
      paid ? grant.entitlement_valid_until : 0,
    ),
    entitlement_plan_id: paid ? grant.entitlement_plan_id : SOLO_PLAN,
    seat_limit: paid ? grant.seat_limit : 1,
  };
}

export async function effectiveAccountUntil(
  subscriptionId: string,
  userId: string,
  paidUntil: number,
) {
  if (paidUntil >= nowSeconds()) return paidUntil;
  const {transitionLicense}=await import('@/lib/complete/bridge');
  const transition=await transitionLicense(subscriptionId,userId);
  if(transition)return transition.entitlement_valid_until;
  return Math.max(
    paidUntil,
    (await grantForAccount(subscriptionId, userId))?.valid_until ?? 0,
  );
}

export async function offerForOrganization(organizationId: string) {
  return database()
    .prepare(
      `SELECT g.valid_until FROM founder_access_grants g
       JOIN organizations o ON o.organization_id=g.organization_id AND o.created_by_user_id=g.user_id
       JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=g.user_id AND m.role='owner' AND m.revoked_at IS NULL
      WHERE g.organization_id=? AND g.revoked_at IS NULL AND g.valid_until>? LIMIT 1`,
    )
    .bind(organizationId, nowSeconds())
    .first<{ valid_until: number }>();
}

export async function registerAccessIdentity(
  user: AccessIdentity,
): Promise<void> {
  if (!user.emailConfirmed || !user.userId || user.userId.length > 255) return;
  let email: string;
  try {
    email = grantEmail(user.email);
  } catch {
    return;
  }
  const now = nowSeconds();
  const identityWrite = await database()
    .prepare(
      `INSERT INTO founder_account_identities(user_id,email,display_name,provider,last_seen_at) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,provider=excluded.provider,last_seen_at=excluded.last_seen_at
     WHERE founder_account_identities.email<>excluded.email OR founder_account_identities.last_seen_at<?`,
    )
    .bind(
      user.userId,
      email,
      user.displayName.slice(0, 160),
      user.provider,
      now,
      now - 300,
    )
    .run();
  if ((identityWrite?.meta?.changes ?? 0) > 0) {
    await database().prepare('UPDATE organization_members SET email=?,display_name=? WHERE user_id=? AND (email<>? OR display_name<>?)')
      .bind(email,user.displayName.slice(0,160),user.userId,email,user.displayName.slice(0,160)).run();
  }
  const grant = await readGrant(email);
  if (
    !grant ||
    grant.revoked_at !== null ||
    grant.valid_until <= now ||
    (grant.user_id !== null && grant.user_id !== user.userId)
  )
    return;
  const alreadyBound = await database()
    .prepare(
      'SELECT email FROM founder_access_grants WHERE user_id=? AND email<>?',
    )
    .bind(user.userId, email)
    .first();
  if (alreadyBound) return;
  await attachGrant(grant, user);
}

async function attachGrant(
  grant: GrantRow,
  user: AccessIdentity,
): Promise<void> {
  if (grant.organization_id && grant.user_id === user.userId) return;
  const db = database();
  const now = nowSeconds();
  const owned = await db
    .prepare(
      `SELECT o.organization_id FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
      WHERE o.created_by_user_id=? AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL ORDER BY o.created_at,o.organization_id LIMIT 2`,
    )
    .bind(user.userId, user.userId)
    .all<{ organization_id: string }>();
  // A unique existing company keeps its identity and data. Otherwise a separate
  // personal workspace avoids choosing an unrelated company's data silently.
  const organizationId =
    grant.organization_id ??
    (owned.results.length === 1
      ? owned.results[0].organization_id
      : `org_${grant.grant_id.slice(4)}`);
  const newOrganization = !grant.organization_id && owned.results.length !== 1;
  const subscriptionId = `manual_${grant.grant_id.slice(4).replaceAll('-', '')}`;
  const name = (
    user.displayName && user.displayName !== user.email
      ? `Espace de ${user.displayName}`
      : 'Mon entreprise'
  ).slice(0, 160);
  const condition = `SELECT 1 FROM founder_access_grants WHERE email=? AND user_id=? AND revoked_at IS NULL AND valid_until>?`;
  const writes = [
    db
      .prepare(
        `UPDATE founder_access_grants SET user_id=? WHERE email=? AND (user_id IS NULL OR user_id=?) AND revoked_at IS NULL AND valid_until>?`,
      )
      .bind(user.userId, grant.email, user.userId, now),
  ];
  if (newOrganization) {
    writes.push(
      db
        .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_email,customer_name,price_id,plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
        SELECT ?,?,?,?,?,?,?,1,'manual',0,0,0,? WHERE EXISTS(${condition}) ON CONFLICT(subscription_id) DO NOTHING`)
        .bind(
          subscriptionId,
          `manual_${grant.grant_id}`,
          grant.email,
          name,
          'manual_access',
          SOLO_PLAN,
          SOLO_PLAN,
          now,
          grant.email,
          user.userId,
          now,
        ),
      db
        .prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS(${condition}) ON CONFLICT(organization_id) DO NOTHING`)
        .bind(
          organizationId,
          name,
          subscriptionId,
          user.userId,
          now,
          now,
          grant.email,
          user.userId,
          now,
        ),
      db
        .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
        SELECT ?,?,?,?,?,'owner',? WHERE EXISTS(${condition}) ON CONFLICT(organization_id,user_id) DO NOTHING`)
        .bind(
          `mem_${grant.grant_id.slice(4)}`,
          organizationId,
          user.userId,
          grant.email,
          user.displayName.slice(0, 160),
          now,
          grant.email,
          user.userId,
          now,
        ),
    );
  }
  writes.push(
    db
      .prepare(`UPDATE founder_access_grants SET organization_id=?
    WHERE email=? AND user_id=? AND organization_id IS NULL AND revoked_at IS NULL AND valid_until>?`)
      .bind(organizationId, grant.email, user.userId, now),
  );
  await db.batch(writes);
}

function present(row: GrantRow | null) {
  if (!row) return null;
  return {
    email: row.email,
    revision: row.revision,
    expiresAt: new Date(row.valid_until * 1000).toISOString(),
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    note: row.note,
    accountLinked: row.user_id !== null && row.organization_id !== null,
    status:
      row.revoked_at !== null
        ? 'revoked'
        : row.valid_until <= nowSeconds()
          ? 'expired'
          : row.organization_id
            ? 'active'
            : 'pending',
  };
}

async function knownIdentity(email: string) {
  const identities = await database()
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
  return identities.results.length === 1 ? identities.results[0] : null;
}

export async function lookupAccess(email: string) {
  const [grant, identity] = await Promise.all([
    readGrant(email),
    knownIdentity(email),
  ]);
  return {
    email,
    record: present(grant),
    accountKnown: identity !== null,
    accountName: identity?.display_name ?? null,
    serverTime: new Date().toISOString(),
  };
}

export async function listAccess() {
  const result = await database()
    .prepare(
      'SELECT * FROM founder_access_grants ORDER BY updated_at DESC,email LIMIT 100',
    )
    .all<GrantRow>();
  return {
    records: result.results.map(present),
    limit: 100,
    serverTime: new Date().toISOString(),
  };
}

async function actionHash(action: FounderAction) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(action)),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function changeAccess(action: FounderAction) {
  const db = database();
  const now = nowSeconds();
  const email = action.email!;
  const hash = await actionHash(action);
  const previous = await db
    .prepare(
      'SELECT email,action_hash FROM founder_access_events WHERE operation_id=?',
    )
    .bind(action.operationId)
    .first<{ email: string; action_hash: string }>();
  if (previous) {
    if (previous.email !== email || previous.action_hash !== hash)
      throw new AccountPublicError(
        'Cette référence a déjà servi à une autre modification.',
        409,
      );
    return { ...(await lookupAccess(email)), replayed: true };
  }
  const current = await readGrant(email);
  if ((current?.revision ?? 0) !== action.expectedRevision)
    throw new AccountPublicError(
      'Cet accès a changé. Actualisez le compte avant de confirmer.',
      409,
    );
  if (action.operation === 'revoke' && !current)
    throw new AccountPublicError('Aucun accès offert à retirer.', 404);
  const extensionStart =
    action.duration !== 'custom' && current?.revoked_at === null
      ? Math.max(now, current.valid_until)
      : now;
  const expires =
    action.operation === 'grant'
      ? accessExpiry(action.duration, action.customDate, extensionStart)
      : current!.valid_until;
  const grantId = current?.grant_id ?? `fgr_${crypto.randomUUID()}`;
  const revoked = action.operation === 'revoke' ? now : null;
  const result = await db.batch([
    db
      .prepare(`INSERT INTO founder_access_grants(email,grant_id,valid_until,revoked_at,revision,note,created_at,updated_at,last_operation_id)
      SELECT ?,?,?,?,1,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM founder_access_grants WHERE email=? AND revision=?)
      ON CONFLICT(email) DO UPDATE SET valid_until=excluded.valid_until,revoked_at=excluded.revoked_at,revision=founder_access_grants.revision+1,
        note=excluded.note,updated_at=excluded.updated_at,last_operation_id=excluded.last_operation_id
      WHERE founder_access_grants.revision=? AND ?>0`)
      .bind(
        email,
        grantId,
        expires,
        revoked,
        action.note,
        now,
        now,
        action.operationId,
        action.expectedRevision,
        email,
        action.expectedRevision,
        action.expectedRevision,
        action.expectedRevision,
      ),
    db
      .prepare(`INSERT INTO founder_access_events(operation_id,email,action_hash,operation,valid_until,created_at,revision)
      SELECT ?,?,?,?,?,?,revision FROM founder_access_grants WHERE email=? AND last_operation_id=? AND revision=?`)
      .bind(
        action.operationId,
        email,
        hash,
        action.operation,
        expires,
        now,
        email,
        action.operationId,
        action.expectedRevision! + 1,
      ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1)
    throw new AccountPublicError(
      'Cet accès a changé. Actualisez le compte avant de confirmer.',
      409,
    );
  if (action.operation === 'grant') {
    const identity = await knownIdentity(email);
    if (identity)
      await registerAccessIdentity({
        userId: identity.user_id,
        email: identity.email,
        displayName: identity.display_name,
        provider: identity.provider,
        emailConfirmed: true,
      });
  }
  return { ...(await lookupAccess(email)), replayed: false };
}
