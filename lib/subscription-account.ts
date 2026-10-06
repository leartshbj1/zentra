import { database } from './runtime';
import { AccountPublicError, sha256Hex } from './account-security';
import { provisionCompleteCompany } from '@/lib/complete/access';

type Owner = { userId: string; email: string; displayName: string };
type Company = {
  organization_id: string;
  name: string;
  created_by_user_id: string;
};

type GestionBinding = {
  request_id: string;
  intent_id: string;
  owner_id: string;
  organization_id: string;
  claim_hash: string;
  session_id: string | null;
  subscription_id: string;
  last_paid_invoice_id: string;
  last_paid_at: number;
  entitlement_valid_until: number;
  price_id: string;
  entitlement_plan_id: string;
  livemode: number;
  current_period_end: number;
  seat_limit: number;
};
function activationPending() {
  return new AccountPublicError(
    'Le paiement est encore en cours de confirmation. Réessayez dans quelques instants.',
    402,
  );
}
/** This handoff reads only the existing validated paid-invoice watermark. An
 * open/complete Checkout response cannot project a company or release a slot. */
async function linkBoundGestion(subscriptionId: string, owner: Owner) {
  const db = database(),
    now = Math.floor(Date.now() / 1000);
  const request = await db
    .prepare(`SELECT r.* FROM gestion_purchase_requests r JOIN purchase_intents i ON i.intent_id=r.intent_id
    JOIN subscriptions s ON s.checkout_session_id=coalesce(r.session_id,i.provider_reference) WHERE s.subscription_id=?`)
    .bind(subscriptionId)
    .first<{
      request_id: string;
      intent_id: string;
      owner_id: string;
      organization_id: string;
      previous_subscription_id: string;
      closed_at: number | null;
    }>();
  if (!request) return null;
  if (request.owner_id !== owner.userId)
    throw new AccountPublicError(
      'Cet abonnement appartient déjà à un autre compte Zentra.',
      409,
    );
  const find = () =>
    db
      .prepare(
        'SELECT organization_id,name,created_by_user_id FROM organizations WHERE organization_id=? AND subscription_id=? AND created_by_user_id=?',
      )
      .bind(request.organization_id, subscriptionId, owner.userId)
      .first<Company>();
  // Subsequent renewals/plan changes do not replay the original initial-price
  // proof. This is only an already completed projection, never a new admission.
  if (request.closed_at !== null) {
    const existing = await find();
    const handed = await db
      .prepare(
        "SELECT 1 FROM purchase_intents i WHERE i.intent_id=? AND i.state='settled' AND NOT EXISTS(SELECT 1 FROM purchase_intent_footprints f WHERE f.intent_id=i.intent_id AND f.released_at IS NULL)",
      )
      .bind(request.intent_id)
      .first();
    if (!existing || !handed)
      throw new AccountPublicError(
        'Cette activation doit être vérifiée. Rechargez votre compte.',
        409,
      );
    return { id: existing.organization_id, name: existing.name };
  }
  const proof = await db
    .prepare(
      'SELECT * FROM gestion_paid_purchase_bindings WHERE request_id=? AND subscription_id=? AND owner_id=?',
    )
    .bind(request.request_id, subscriptionId, owner.userId)
    .first<GestionBinding>();
  if (!proof) throw activationPending();
  const evidence = await sha256Hex(
    JSON.stringify([
      'zentra-gestion-paid-handoff-v1',
      proof.request_id,
      proof.intent_id,
      proof.owner_id,
      proof.organization_id,
      proof.claim_hash,
      proof.subscription_id,
      proof.last_paid_invoice_id,
      proof.last_paid_at,
      proof.entitlement_valid_until,
      proof.price_id,
      proof.entitlement_plan_id,
      proof.livemode,
      proof.current_period_end,
      proof.seat_limit,
    ]),
  );
  const guard = `request_id=? AND subscription_id=? AND owner_id=? AND last_paid_invoice_id=? AND last_paid_at=? AND entitlement_valid_until=? AND price_id=? AND entitlement_plan_id=? AND livemode=? AND current_period_end=? AND seat_limit=?`;
  const values = [
    proof.request_id,
    subscriptionId,
    owner.userId,
    proof.last_paid_invoice_id,
    proof.last_paid_at,
    proof.entitlement_valid_until,
    proof.price_id,
    proof.entitlement_plan_id,
    proof.livemode,
    proof.current_period_end,
    proof.seat_limit,
  ];
  await db.batch([
    db
      .prepare(`UPDATE organizations SET subscription_id=?,updated_at=? WHERE organization_id=? AND subscription_id=? AND created_by_user_id=?
      AND EXISTS(SELECT 1 FROM gestion_paid_purchase_bindings WHERE ${guard})`)
      .bind(
        subscriptionId,
        now,
        request.organization_id,
        request.previous_subscription_id,
        owner.userId,
        ...values,
      ),
    db
      .prepare(`UPDATE account_trials SET converted_subscription_id=? WHERE user_id=? AND organization_id=? AND subscription_id=? AND converted_subscription_id IS NULL
      AND EXISTS(SELECT 1 FROM gestion_paid_purchase_projections WHERE ${guard})`)
      .bind(
        subscriptionId,
        owner.userId,
        request.organization_id,
        request.previous_subscription_id,
        ...values,
      ),
    db
      .prepare(
        `UPDATE license_activations SET subscription_id=? WHERE subscription_id=? AND EXISTS(SELECT 1 FROM gestion_paid_purchase_projections WHERE ${guard})`,
      )
      .bind(subscriptionId, request.previous_subscription_id, ...values),
    db
      .prepare(`UPDATE purchase_intents SET state='settled',finalized_at=?,evidence_fingerprint=? WHERE intent_id=? AND state IN ('dispatched','uncertain')
      AND EXISTS(SELECT 1 FROM gestion_paid_purchase_projections WHERE ${guard})`)
      .bind(now, evidence, request.intent_id, ...values),
    db
      .prepare(`UPDATE purchase_intent_footprints SET released_at=(SELECT finalized_at FROM purchase_intents WHERE intent_id=?) WHERE intent_id=? AND released_at IS NULL
      AND EXISTS(SELECT 1 FROM purchase_intents i JOIN gestion_paid_purchase_projections p ON p.intent_id=i.intent_id WHERE i.intent_id=? AND i.state='settled')`)
      .bind(request.intent_id, request.intent_id, request.intent_id),
    db
      .prepare(`UPDATE gestion_purchase_requests SET closed_at=(SELECT finalized_at FROM purchase_intents WHERE intent_id=?) WHERE request_id=? AND closed_at IS NULL
      AND EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=? AND i.state='settled' AND NOT EXISTS(SELECT 1 FROM purchase_intent_footprints f WHERE f.intent_id=i.intent_id AND f.released_at IS NULL))`)
      .bind(request.intent_id, request.request_id, request.intent_id),
  ]);
  const company = await find(),
    settled = await db
      .prepare(
        'SELECT 1 FROM gestion_purchase_requests WHERE request_id=? AND closed_at IS NOT NULL',
      )
      .bind(request.request_id)
      .first();
  if (!company || !settled)
    throw new AccountPublicError(
      'Une autre activation est en cours. Rechargez votre compte.',
      409,
    );
  return { id: company.organization_id, name: company.name };
}

/** Called only after verified Stripe settlement, with the account recorded by
 * the server before redirecting to Checkout. Email alone never grants access.
 */
export async function linkPaidCompany(subscriptionId: string, owner: Owner) {
  const db = database(),
    now = Math.floor(Date.now() / 1000);
  const paid = await db
    .prepare(`SELECT customer_name FROM subscriptions
    WHERE subscription_id=? AND last_paid_invoice_id IS NOT NULL AND entitlement_valid_until>?`)
    .bind(subscriptionId, now)
    .first<{ customer_name: string | null }>();
  if (!paid)
    throw new AccountPublicError(
      'Le paiement est encore en cours de confirmation. Réessayez dans quelques instants.',
      402,
    );
  const bound = await linkBoundGestion(subscriptionId, owner);
  if (bound) return bound;
  const find = () =>
    db
      .prepare(
        'SELECT organization_id,name,created_by_user_id FROM organizations WHERE subscription_id=? LIMIT 1',
      )
      .bind(subscriptionId)
      .first<Company>();
  const existing = await find();
  if (existing && existing.created_by_user_id !== owner.userId)
    throw new AccountPublicError(
      'Cet abonnement appartient déjà à un autre compte Zentra.',
      409,
    );
  if (existing) {
    await provisionCompleteCompany(
      subscriptionId,
      existing.organization_id,
      owner.userId,
    );
    return { id: existing.organization_id, name: existing.name };
  }
  // A verified purchase upgrades the existing trial workspace, preserving its documents.
  const trial = await db
    .prepare(`SELECT t.organization_id,t.subscription_id FROM account_trials t
    JOIN organizations o ON o.organization_id=t.organization_id AND o.subscription_id=t.subscription_id
    JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=t.user_id AND m.role='owner' AND m.revoked_at IS NULL
    WHERE t.user_id=? AND t.converted_subscription_id IS NULL`)
    .bind(owner.userId)
    .first<{ organization_id: string; subscription_id: string }>();
  if (trial) {
    await db.batch([
      db
        .prepare(
          'UPDATE organizations SET subscription_id=?,updated_at=? WHERE organization_id=? AND subscription_id=? AND created_by_user_id=?',
        )
        .bind(
          subscriptionId,
          now,
          trial.organization_id,
          trial.subscription_id,
          owner.userId,
        ),
      db
        .prepare(
          'UPDATE account_trials SET converted_subscription_id=? WHERE user_id=? AND converted_subscription_id IS NULL AND EXISTS(SELECT 1 FROM organizations WHERE organization_id=? AND subscription_id=?)',
        )
        .bind(
          subscriptionId,
          owner.userId,
          trial.organization_id,
          subscriptionId,
        ),
      db
        .prepare(
          'UPDATE license_activations SET subscription_id=? WHERE subscription_id=? AND EXISTS(SELECT 1 FROM organizations WHERE organization_id=? AND subscription_id=?)',
        )
        .bind(
          subscriptionId,
          trial.subscription_id,
          trial.organization_id,
          subscriptionId,
        ),
    ]);
    const upgraded = await find();
    if (!upgraded || upgraded.created_by_user_id !== owner.userId)
      throw new AccountPublicError(
        'Une autre activation est en cours. Rechargez votre compte.',
        409,
      );
    await provisionCompleteCompany(
      subscriptionId,
      upgraded.organization_id,
      owner.userId,
    );
    return { id: upgraded.organization_id, name: upgraded.name };
  }
  const name = (paid.customer_name || owner.displayName || 'Mon entreprise')
    .trim()
    .slice(0, 160);
  // Both statements use the unique subscription binding. Concurrent webhook,
  // return-page and account requests create exactly one company and owner.
  await db.batch([
    db
      .prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(subscription_id) DO NOTHING`)
      .bind(
        `org_${crypto.randomUUID()}`,
        name,
        subscriptionId,
        owner.userId,
        now,
        now,
      ),
    db
      .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
      SELECT ?,organization_id,?,?,?,'owner',? FROM organizations WHERE subscription_id=? AND created_by_user_id=?
      ON CONFLICT(organization_id,user_id) DO NOTHING`)
      .bind(
        `mem_${crypto.randomUUID()}`,
        owner.userId,
        owner.email.trim().toLowerCase(),
        owner.displayName.slice(0, 160),
        now,
        subscriptionId,
        owner.userId,
      ),
  ]);
  const company = await find();
  if (!company || company.created_by_user_id !== owner.userId)
    throw new AccountPublicError(
      'Cet abonnement appartient déjà à un autre compte Zentra.',
      409,
    );
  await provisionCompleteCompany(
    subscriptionId,
    company.organization_id,
    owner.userId,
  );
  return { id: company.organization_id, name: company.name };
}

export async function linkPaidCheckoutAccount(subscriptionId: string) {
  // Recover a response whose reservation/session binding was persisted but the
  // checkout receipt batch was lost. Ownership comes from the frozen request.
  const bound = await database()
    .prepare(`SELECT r.owner_id,r.account_email,r.account_name FROM subscriptions s
    JOIN purchase_intents i ON i.provider_reference=s.checkout_session_id JOIN gestion_purchase_requests r ON r.intent_id=i.intent_id
    WHERE s.subscription_id=? AND s.last_paid_invoice_id IS NOT NULL AND s.entitlement_valid_until>?`)
    .bind(subscriptionId, Math.floor(Date.now() / 1000))
    .first<{ owner_id: string; account_email: string; account_name: string }>();
  if (bound)
    return linkPaidCompany(subscriptionId, {
      userId: bound.owner_id,
      email: bound.account_email,
      displayName: bound.account_name,
    });
  const row = await database()
    .prepare(`SELECT attempt.account_user_id,attempt.account_email,attempt.account_name
    FROM subscriptions subscription JOIN checkout_attempts attempt ON attempt.checkout_session_id=subscription.checkout_session_id
    WHERE subscription.subscription_id=? AND subscription.last_paid_invoice_id IS NOT NULL
      AND subscription.entitlement_valid_until>? AND attempt.account_user_id IS NOT NULL AND attempt.account_email IS NOT NULL LIMIT 1`)
    .bind(subscriptionId, Math.floor(Date.now() / 1000))
    .first<{
      account_user_id: string;
      account_email: string;
      account_name: string | null;
    }>();
  if (!row) return null; // Pending payments and legacy checkouts do not create access.
  return linkPaidCompany(subscriptionId, {
    userId: row.account_user_id,
    email: row.account_email,
    displayName: row.account_name || row.account_email,
  });
}
