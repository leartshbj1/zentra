import { database } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { planById } from '@/lib/plans';
import { COMPLETE_TRIAL_ANALYSES } from '@/lib/complete/trial';
import { linkCompleteProducts } from '@/lib/complete/access';
export const TRIAL_DAYS = 14;
type Trial = {
  user_id: string;
  organization_id: string;
  subscription_id: string;
  started_at: number;
  ends_at: number;
  converted_subscription_id: string | null;
};
// Only the first, untouched Gestion draft can become a first trial. Closed
// Checkout history remains immutable; unknown or paid financial work never
// becomes permission to start a free period. Reuse this predicate inside the
// atomic batch as well, since ownership/payment can change after the read.
const UNUSED_GESTION_DRAFT = `FROM gestion_purchase_drafts d
  JOIN organizations o ON o.organization_id=d.organization_id AND o.subscription_id=d.original_subscription_id AND o.created_by_user_id=d.owner_id
  JOIN subscriptions s ON s.subscription_id=d.original_subscription_id
  JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=d.owner_id AND m.role='owner' AND m.revoked_at IS NULL
  JOIN gestion_purchase_requests r ON r.request_id=(SELECT latest.request_id FROM gestion_purchase_requests latest WHERE latest.organization_id=o.organization_id ORDER BY latest.created_at DESC,latest.request_id DESC LIMIT 1)
  JOIN purchase_intents i ON i.intent_id=r.intent_id
  WHERE d.owner_id=? AND (
    (EXISTS(SELECT 1 WHERE
      substr(s.subscription_id,1,6)='draft_' AND s.price_id='draft-no-paid-price'
      AND s.status='incomplete' AND s.current_period_end=0 AND s.entitlement_valid_until=0
      AND s.last_paid_invoice_id IS NULL AND s.last_paid_at IS NULL AND s.checkout_session_id IS NULL
      AND (SELECT COUNT(*) FROM organizations other WHERE other.created_by_user_id=d.owner_id)=1
      AND (SELECT COUNT(*) FROM organization_members other WHERE other.user_id=d.owner_id)=1
      AND (SELECT COUNT(*) FROM organization_members other WHERE other.organization_id=o.organization_id)=1)
    AND EXISTS(SELECT 1 WHERE
      r.owner_id=d.owner_id AND r.previous_subscription_id=d.original_subscription_id AND r.environment=d.environment
      AND r.closed_at IS NOT NULL AND r.closed_at>=i.finalized_at AND r.closed_at<=unixepoch()
      AND i.owner_id=d.owner_id AND i.organization_id=o.organization_id AND i.workspace_id IS NULL
      AND i.provider='stripe' AND i.product='gestion' AND i.environment=r.environment AND i.provider_scope=r.provider_scope AND i.plan_id=r.plan_id
      AND i.state IN ('released','expired','canceled') AND i.finalized_at IS NOT NULL AND i.finalized_at<=unixepoch()
      AND ((i.state='released' AND i.provider_reference IS NULL AND r.session_id IS NULL)
        OR (i.state IN ('expired','canceled') AND i.provider_reference IS NOT NULL AND r.session_id=i.provider_reference))))
    AND (
      (NOT EXISTS(SELECT 1 FROM purchase_occupied_entitlements p WHERE p.scope_kind='organization' AND p.scope_id=o.organization_id)
      AND NOT EXISTS(SELECT 1 FROM purchase_pending_changes p WHERE p.organization_id=o.organization_id))
      AND (EXISTS(SELECT 1 WHERE
        NOT EXISTS(SELECT 1 FROM gestion_purchase_requests pending WHERE pending.owner_id=d.owner_id AND pending.closed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM purchase_intents pending WHERE (pending.owner_id=d.owner_id OR pending.organization_id=o.organization_id) AND pending.state IN ('reserved','dispatched','uncertain','settled'))
        AND NOT EXISTS(SELECT 1 FROM purchase_intent_footprints f JOIN purchase_intents p ON p.intent_id=f.intent_id WHERE f.released_at IS NULL AND (p.owner_id=d.owner_id OR p.organization_id=o.organization_id OR (f.scope_kind='organization' AND f.scope_id=o.organization_id)))
        AND NOT EXISTS(SELECT 1 FROM complete_checkouts pending WHERE pending.user_id=d.owner_id)
        AND NOT EXISTS(SELECT 1 FROM complete_trials t WHERE t.user_id=d.owner_id OR t.organization_id=o.organization_id)
        AND NOT EXISTS(SELECT 1 FROM prepaid_contracts p WHERE p.owner_id=d.owner_id OR p.organization_id=o.organization_id)
        AND NOT EXISTS(SELECT 1 FROM automation_subscriptions a WHERE a.organization_id=o.organization_id)
        AND NOT EXISTS(SELECT 1 FROM complete_subscriptions c WHERE c.subscription_id=s.subscription_id))
      AND EXISTS(SELECT 1 WHERE
        NOT EXISTS(SELECT 1 FROM founder_access_grants g WHERE g.user_id=d.owner_id OR g.organization_id=o.organization_id)
        AND NOT EXISTS(SELECT 1 FROM device_sessions device WHERE device.organization_id=o.organization_id)
        AND NOT EXISTS(SELECT 1 FROM license_activations licence WHERE licence.subscription_id=s.subscription_id)
        AND NOT EXISTS(SELECT 1 FROM subscriptions paid JOIN gestion_purchase_requests history ON history.session_id=paid.checkout_session_id WHERE history.owner_id=d.owner_id)
        AND NOT EXISTS(SELECT 1 FROM checkout_attempts a WHERE a.account_user_id=d.owner_id AND NOT EXISTS(
          SELECT 1 FROM gestion_purchase_requests history JOIN purchase_intents terminal ON terminal.intent_id=history.intent_id
          WHERE history.owner_id=d.owner_id AND history.organization_id=o.organization_id AND history.closed_at IS NOT NULL
          AND terminal.state IN ('expired','canceled') AND terminal.provider_reference=a.checkout_session_id
          AND history.session_id=a.checkout_session_id AND history.claim_hash=a.claim_hash))))
    ))`;

async function trialFromCanceledGestionDraft(
  user: { userId: string; email: string; displayName: string },
  complete: boolean,
): Promise<Trial> {
  const db = database(),
    now = Math.floor(Date.now() / 1000),
    until = now + TRIAL_DAYS * 86400;
  const noHistory =
    'AND NOT EXISTS(SELECT 1 FROM account_trials history WHERE history.user_id=d.owner_id OR history.organization_id=o.organization_id)';
  const draft = await db
    .prepare(
      `SELECT o.organization_id,d.original_subscription_id ${UNUSED_GESTION_DRAFT} ${noHistory}`,
    )
    .bind(user.userId)
    .first<{ organization_id: string; original_subscription_id: string }>();
  if (!draft)
    throw new AccountPublicError(
      'Votre compte possède déjà une entreprise. Retrouvez-la dans vos paramètres.',
      409,
    );
  const fingerprint = await sha256Hex(user.userId),
    emailHash = await sha256Hex(user.email.trim().toLowerCase());
  const sub = `trial_${fingerprint.slice(0, 32)}`,
    org = draft.organization_id,
    plan = planById(complete ? 'start' : 'solo')!;
  await db.batch([
    db
      .prepare(`INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at)
      SELECT ?,?,o.organization_id,?,?,? ${UNUSED_GESTION_DRAFT} ${noHistory} AND o.organization_id=? ON CONFLICT DO NOTHING`)
      .bind(user.userId, emailHash, sub, now, until, user.userId, org),
    db
      .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_name,customer_email,price_id,plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
      SELECT ?,?,o.name,?,'free_trial',?,?,?,'trialing',t.ends_at,t.ends_at,0,?
      FROM account_trials t JOIN organizations o ON o.organization_id=t.organization_id
      WHERE t.user_id=? AND t.subscription_id=? AND t.organization_id=? AND o.subscription_id=?
      ON CONFLICT(subscription_id) DO NOTHING`)
      .bind(
        sub,
        sub,
        user.email,
        plan.licensePlan,
        plan.licensePlan,
        plan.seats,
        now,
        user.userId,
        sub,
        org,
        draft.original_subscription_id,
      ),
    db
      .prepare(`UPDATE organizations SET subscription_id=?,updated_at=? WHERE organization_id=? AND subscription_id=?
      AND EXISTS(SELECT 1 ${UNUSED_GESTION_DRAFT} AND o.organization_id=organizations.organization_id)
      AND EXISTS(SELECT 1 FROM account_trials t WHERE t.user_id=? AND t.organization_id=organizations.organization_id AND t.subscription_id=? AND t.started_at=? AND t.ends_at=? AND t.converted_subscription_id IS NULL)`)
      .bind(
        sub,
        now,
        org,
        draft.original_subscription_id,
        user.userId,
        user.userId,
        sub,
        now,
        until,
      ),
    // If a guard ever fails after this batch inserted the trial (for example a
    // database trigger changes the target), abort the whole transaction rather
    // than consume a trial without attaching it to its original company.
    db
      .prepare(`INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at)
      SELECT user_id,email_hash,organization_id,subscription_id,started_at,ends_at FROM account_trials t
      WHERE t.user_id=? AND t.organization_id=? AND t.subscription_id=? AND t.started_at=? AND t.ends_at=?
      AND NOT EXISTS(SELECT 1 FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
        WHERE o.organization_id=t.organization_id AND o.subscription_id=t.subscription_id AND o.created_by_user_id=t.user_id
        AND m.user_id=t.user_id AND m.role='owner' AND m.revoked_at IS NULL)`)
      .bind(user.userId, org, sub, now, until),
  ]);
  const created = await trialForUser(user.userId);
  if (
    !created ||
    created.organization_id !== org ||
    created.subscription_id !== sub
  )
    throw new AccountPublicError(
      'Un essai a déjà été utilisé avec cette adresse. Choisissez une formule pour continuer.',
      409,
    );
  if (complete) {
    // Reuse the existing Complete upgrade/provisioning path. A simultaneous
    // Gestion trial cannot accidentally create Complete quotas with solo seats.
    return startAccountTrial(user, 'Mon entreprise', true);
  }
  return created;
}
export async function trialForUser(userId: string) {
  return database()
    .prepare('SELECT * FROM account_trials WHERE user_id=?')
    .bind(userId)
    .first<Trial>();
}
export async function startAccountTrial(
  user: { userId: string; email: string; displayName: string },
  name: string,
  complete = false,
) {
  const previous = await trialForUser(user.userId);
  if (previous) {
    if (complete) {
      const existing = await database()
        .prepare('SELECT 1 FROM complete_trials WHERE user_id=?')
        .bind(user.userId)
        .first();
      if (!existing) {
        const time = Math.floor(Date.now() / 1000),
          plan = planById('start')!;
        if (previous.converted_subscription_id || previous.ends_at <= time)
          throw new AccountPublicError(
            'Votre essai est terminé. Choisissez une formule pour continuer.',
            409,
          );
        await database().batch([
          database()
            .prepare(
              'INSERT INTO complete_trials(user_id,organization_id,analyses) SELECT user_id,organization_id,? FROM account_trials WHERE user_id=? AND converted_subscription_id IS NULL AND ends_at>? ON CONFLICT DO NOTHING',
            )
            .bind(COMPLETE_TRIAL_ANALYSES, user.userId, time),
          database()
            .prepare(
              'UPDATE subscriptions SET plan_id=?,entitlement_plan_id=?,seat_limit=?,updated_at=? WHERE subscription_id=? AND EXISTS(SELECT 1 FROM account_trials WHERE user_id=? AND converted_subscription_id IS NULL AND ends_at>?)',
            )
            .bind(
              plan.licensePlan,
              plan.licensePlan,
              plan.seats,
              time,
              previous.subscription_id,
              user.userId,
              time,
            ),
        ]);
      }
      await linkCompleteProducts(previous.organization_id, user.userId);
    }
    return previous; // Retries never restart or extend a trial.
  }
  if (!name.trim() || name.trim().length > 120)
    throw new AccountPublicError(
      'Indiquez le nom de votre entreprise (120 caractères maximum).',
    );
  const db = database();
  const owned = await db
    .prepare(
      'SELECT organization_id FROM organizations WHERE created_by_user_id=? LIMIT 1',
    )
    .bind(user.userId)
    .first();
  // A moved/revoked draft must not fall through and create a second company.
  if (
    owned ||
    (await db
      .prepare('SELECT 1 FROM gestion_purchase_drafts WHERE owner_id=? LIMIT 1')
      .bind(user.userId)
      .first())
  )
    return trialFromCanceledGestionDraft(user, complete);
  const now = Math.floor(Date.now() / 1000),
    until = now + TRIAL_DAYS * 86400;
  const fingerprint = await sha256Hex(user.userId),
    emailHash = await sha256Hex(user.email.trim().toLowerCase());
  const sub = `trial_${fingerprint.slice(0, 32)}`,
    org = `org_trial_${fingerprint.slice(0, 32)}`,
    plan = planById(complete ? 'start' : 'solo')!;
  await db.batch([
    db
      .prepare(
        'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(user.userId, emailHash, org, sub, now, until),
    ...(complete
      ? [
          db
            .prepare(
              'INSERT INTO complete_trials(user_id,organization_id,analyses) SELECT user_id,organization_id,? FROM account_trials WHERE user_id=? AND subscription_id=? ON CONFLICT DO NOTHING',
            )
            .bind(COMPLETE_TRIAL_ANALYSES, user.userId, sub),
        ]
      : []),
    db
      .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_name,customer_email,price_id,plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
      SELECT ?,?,?,?,'free_trial',?,?,?,'trialing',ends_at,ends_at,0,? FROM account_trials WHERE user_id=? AND subscription_id=? ON CONFLICT(subscription_id) DO NOTHING`)
      .bind(
        sub,
        sub,
        name.trim(),
        user.email,
        plan.licensePlan,
        plan.licensePlan,
        plan.seats,
        now,
        user.userId,
        sub,
      ),
    db
      .prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
      SELECT ?,?,?,?, ?,? FROM account_trials WHERE user_id=? AND subscription_id=? ON CONFLICT(subscription_id) DO NOTHING`)
      .bind(org, name.trim(), sub, user.userId, now, now, user.userId, sub),
    db
      .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
      SELECT ?,?,?,?,?, 'owner',? FROM account_trials t WHERE user_id=? AND subscription_id=?
      AND NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=t.organization_id AND m.user_id=t.user_id)
      ON CONFLICT(organization_id,user_id) DO NOTHING`)
      .bind(
        `mem_${fingerprint.slice(0, 32)}`,
        org,
        user.userId,
        user.email,
        user.displayName,
        now,
        user.userId,
        sub,
      ),
  ]);
  const created = await trialForUser(user.userId);
  if (!created)
    throw new AccountPublicError(
      'Un essai a déjà été utilisé avec cette adresse. Choisissez une formule pour continuer.',
      409,
    );
  if (complete) {
    await linkCompleteProducts(created.organization_id, user.userId);
  }
  return created;
}
export async function trialLicenseEntitlement(
  subscriptionId: string,
  userId: string | null | undefined,
) {
  if (!userId || !subscriptionId.startsWith('trial_')) return null;
  const row = await database()
    .prepare(`SELECT s.customer_name,s.entitlement_plan_id,s.seat_limit,t.ends_at AS entitlement_valid_until
    FROM account_trials t JOIN subscriptions s ON s.subscription_id=t.subscription_id
    JOIN organizations o ON o.organization_id=t.organization_id AND o.subscription_id=t.subscription_id
    JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=? AND m.revoked_at IS NULL
    WHERE t.subscription_id=? AND t.ends_at>? AND t.converted_subscription_id IS NULL`)
    .bind(userId, subscriptionId, Math.floor(Date.now() / 1000))
    .first<{
      customer_name: string;
      entitlement_plan_id: string;
      seat_limit: number;
      entitlement_valid_until: number;
    }>();
  return row;
}
