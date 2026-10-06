import type { ZentraUser } from '@/app/zentra-auth';
import { database } from '@/lib/runtime';
import { PublicError } from '@/lib/stripe';
import { automationStripe } from '@/lib/automation/billing';
import type { CompletePlan } from './plans';
import { assertNoPrepaidAccountPurchase } from '@/lib/payments/prepaid-checkout-guard';

export async function assertCompleteEligible(userId: string) {
  await assertNoPrepaidAccountPurchase(userId);
  const db = database(),
    now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare(`SELECT 1 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
    WHERE o.created_by_user_id=? AND (s.subscription_id LIKE 'sub_%') AND (s.entitlement_valid_until>? OR s.status NOT IN ('canceled','incomplete_expired'))
    UNION ALL SELECT 1 FROM support_subscriptions s JOIN support_workspaces w ON w.id=s.workspace_id WHERE w.owner_id=? AND (s.paid_until>? OR s.status NOT IN ('canceled','incomplete_expired'))
    UNION ALL SELECT 1 FROM automation_subscriptions a JOIN organizations o ON o.organization_id=a.organization_id WHERE o.created_by_user_id=? AND (a.paid_until>? OR a.status NOT IN ('canceled','incomplete_expired')) LIMIT 1`)
    .bind(userId, now, userId, now, userId, now)
    .first();
  if (existing)
    throw new PublicError(
      'Vous avez déjà un abonnement Zentra. Dans Compte → Abonnement, choisissez « Changer de formule » pour conserver votre entreprise.',
      409,
    );
  const link = await db
    .prepare(`SELECT 1 FROM support_workspaces w JOIN support_gestion_links l ON l.workspace_id=w.id
    LEFT JOIN account_trials t ON t.organization_id=l.organization_id AND t.user_id=w.owner_id AND t.converted_subscription_id IS NULL
    WHERE w.owner_id=? AND t.user_id IS NULL LIMIT 1`)
    .bind(userId)
    .first();
  if (link)
    throw new PublicError(
      'Votre Support est déjà relié à une entreprise. Contactez info@zentraapp.ch pour réunir vos abonnements sans déplacer vos données.',
      409,
    );
  const pending = await db
    .prepare(`SELECT 1 FROM support_checkouts c JOIN support_workspaces w ON w.id=c.workspace_id WHERE w.owner_id=? AND c.expires_at>?
    UNION ALL SELECT 1 FROM automation_checkouts c JOIN organizations o ON o.organization_id=c.organization_id WHERE o.created_by_user_id=? AND c.expires_at>? LIMIT 1`)
    .bind(userId, now, userId, now)
    .first();
  if (pending)
    throw new PublicError(
      'Un paiement Support ou Automation est déjà en cours. Annulez-le depuis cet espace avant de choisir le pack.',
      409,
    );
  // An in-flight Gestion checkout must not become a second paid subscription.
  const attempts = await db
    .prepare(`SELECT a.checkout_session_id FROM checkout_attempts a WHERE a.account_user_id=? AND a.created_at>? AND a.checkout_session_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM complete_checkouts c WHERE c.session_id=a.checkout_session_id) AND NOT EXISTS(SELECT 1 FROM stripe_complete_purchase_requests r WHERE r.session_id=a.checkout_session_id) LIMIT 20`)
    .bind(userId, now - 86400)
    .all<{ checkout_session_id: string }>();
  for (const attempt of attempts.results) {
    const session = await automationStripe().checkout.sessions.retrieve(
      attempt.checkout_session_id,
    );
    if (session.status === 'open' || session.status === 'complete')
      throw new PublicError(
        'Un paiement Gestion est déjà en cours ou vient d’être terminé. Retrouvez-le dans votre compte avant de choisir un pack.',
        409,
      );
  }
}
export async function assertNoCompleteCheckout(userId: string) {
  await assertNoPrepaidAccountPurchase(userId);
  if (
    await database()
      .prepare(
        "SELECT 1 FROM complete_plan_changes WHERE user_id=? AND state IN ('preparing','scheduled')",
      )
      .bind(userId)
      .first()
  )
    throw new PublicError(
      'Un changement vers Zentra Complet est déjà prévu. Retrouvez-le dans Compte → Abonnement.',
      409,
    );
  const paid = await database()
    .prepare(
      `SELECT 1 FROM complete_subscriptions c JOIN subscriptions s ON s.subscription_id=c.subscription_id JOIN organizations o ON o.subscription_id=s.subscription_id WHERE o.created_by_user_id=? AND (s.entitlement_valid_until>? OR s.status NOT IN ('canceled','incomplete_expired')) LIMIT 1`,
    )
    .bind(userId, Math.floor(Date.now() / 1000))
    .first();
  if (paid)
    throw new PublicError(
      'Zentra Gestion est déjà inclus dans votre pack Complet. Gérez votre abonnement depuis votre compte.',
      409,
    );
  const row = await database()
    .prepare(
      'SELECT session_id FROM complete_checkouts WHERE user_id=? UNION ALL SELECT session_id FROM stripe_complete_purchase_requests WHERE owner_id=? AND closed_at IS NULL LIMIT 1',
    )
    .bind(userId, userId)
    .first<{ session_id: string | null }>();
  if (row)
    throw new PublicError(
      'Vous avez choisi Zentra Complet. Retrouvez ou annulez ce paiement dans la page du pack avant de souscrire un produit séparé.',
      409,
    );
}

export async function completeCheckout(
  user: ZentraUser,
  plan: CompletePlan,
  origin: string,
  automaticTax: boolean,
  organizationId?: unknown,
) {
  await assertCompleteEligible(user.userId);
  const { stripeCompleteController } =
    await import('@/lib/payments/stripe-complete-purchase');
  return stripeCompleteController().checkout({
    user,
    plan,
    origin,
    automaticTax,
    organizationId,
  });
}
export async function cancelCompleteCheckout(user: ZentraUser) {
  const { stripeCompleteController } =
    await import('@/lib/payments/stripe-complete-purchase');
  return stripeCompleteController().cancel(user);
}
