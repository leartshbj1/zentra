import { database, runtimeValue } from '@/lib/runtime';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';
import { completePlan } from './plans';
import { AccountPublicError } from '@/lib/account-security';

export type CompleteSubscription = {
  subscription_id: string;
  organization_id: string;
  customer_id: string;
  plan_id: string;
  paid_plan_id: string | null;
  paid_from: number;
  paid_until: number;
  last_paid_invoice_id: string | null;
  status: string;
  livemode: number;
  cancel_at_period_end: number;
  entitlement_valid_until: number;
  refunded: number;
};
export function hasCompleteAccess(
  row: CompleteSubscription | null,
  live: boolean | null,
  now = Math.floor(Date.now() / 1000),
) {
  return (
    !!row &&
    live !== null &&
    row.livemode === Number(live) &&
    !!completePlan(row.paid_plan_id) &&
    !!row.last_paid_invoice_id &&
    !row.refunded &&
    row.paid_from <= now &&
    row.paid_until > now &&
    row.entitlement_valid_until > now &&
    ['active', 'past_due'].includes(row.status)
  );
}
export async function completeSubscription(organizationId: string) {
  return database()
    .prepare(`SELECT c.*,o.organization_id,s.customer_id,s.status,s.livemode,s.cancel_at_period_end,s.entitlement_valid_until,
    EXISTS(SELECT 1 FROM complete_refunds r WHERE r.invoice_id=c.last_paid_invoice_id AND r.customer_id=s.customer_id AND r.livemode=s.livemode) AS refunded
    FROM complete_subscriptions c JOIN subscriptions s ON s.subscription_id=c.subscription_id
    JOIN organizations o ON o.subscription_id=c.subscription_id WHERE o.organization_id=?`)
    .bind(organizationId)
    .first<CompleteSubscription>();
}
export async function completeAccess(organizationId: string) {
  const row = await completeSubscription(organizationId);
  return hasCompleteAccess(
    row,
    stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
  )
    ? row
    : null;
}
export async function completeSupportSubscription(workspaceId: string) {
  const link = await database()
    .prepare(
      'SELECT organization_id FROM support_gestion_links WHERE workspace_id=?',
    )
    .bind(workspaceId)
    .first<{ organization_id: string }>();
  return link ? completeSubscription(link.organization_id) : null;
}

// Same invoice period for all products. Status-only events never extend it.
export const UPSERT_COMPLETE_SQL = `INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id)
  VALUES(?,?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET plan_id=excluded.plan_id,
  paid_plan_id=CASE WHEN excluded.last_paid_invoice_id IS NOT NULL AND excluded.paid_until>complete_subscriptions.paid_until THEN excluded.paid_plan_id ELSE complete_subscriptions.paid_plan_id END,
  paid_from=CASE WHEN excluded.last_paid_invoice_id IS NOT NULL AND excluded.paid_until>complete_subscriptions.paid_until THEN excluded.paid_from ELSE complete_subscriptions.paid_from END,
  last_paid_invoice_id=CASE WHEN excluded.last_paid_invoice_id IS NOT NULL AND excluded.paid_until>complete_subscriptions.paid_until THEN excluded.last_paid_invoice_id ELSE complete_subscriptions.last_paid_invoice_id END,
  paid_until=MAX(complete_subscriptions.paid_until,excluded.paid_until)`;

/** Link products to the one company created by verified Gestion settlement. Never move an existing workspace. */
export async function provisionCompleteCompany(
  subscriptionId: string,
  organizationId: string,
  ownerId: string,
) {
  const bundle = await completeAccess(organizationId);
  if (!bundle || bundle.subscription_id !== subscriptionId) return;
  const db = database(),
    now = Math.floor(Date.now() / 1000);
  await db
    .prepare(`INSERT INTO support_workspaces(id,owner_id,name,mode,threshold,baseline_seconds,created_at,updated_at)
    SELECT ?,o.created_by_user_id,o.name,'review',85,60,?,? FROM organizations o WHERE o.organization_id=? AND o.created_by_user_id=?
    ON CONFLICT(owner_id) DO NOTHING`)
    .bind(crypto.randomUUID(), now, now, organizationId, ownerId)
    .run();
  await db
    .prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at)
    SELECT w.id,?,1,0,?,? FROM support_workspaces w WHERE w.owner_id=?
    AND NOT EXISTS(SELECT 1 FROM support_gestion_links l WHERE l.workspace_id=w.id OR l.organization_id=?)
    ON CONFLICT DO NOTHING`)
    .bind(organizationId, ownerId, now, ownerId, organizationId)
    .run();
  const linked = await db
    .prepare(
      'SELECT 1 FROM support_gestion_links l JOIN support_workspaces w ON w.id=l.workspace_id WHERE l.organization_id=? AND w.owner_id=?',
    )
    .bind(organizationId, ownerId)
    .first();
  if (!linked)
    throw new AccountPublicError(
      'Votre pack est payé, mais Support est relié à une autre entreprise. Contactez info@zentraapp.ch pour terminer la liaison sans déplacer vos données.',
      409,
    );
  await db
    .prepare(
      'DELETE FROM complete_checkouts WHERE user_id=? AND session_id=(SELECT checkout_session_id FROM subscriptions WHERE subscription_id=?)',
    )
    .bind(ownerId, subscriptionId)
    .run();
}
