import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { database } from '@/lib/runtime';
import { PublicError, randomBase64Url, sha256 } from '@/lib/stripe';
import { automationStripe } from '@/lib/automation/billing';
import { buildZentraCheckoutParams } from '@/lib/stripe-checkout';
import {
  COMPLETE_PRODUCT,
  COMPLETE_TERMS_VERSION,
  type CompletePlan,
} from './plans';
import { ensureCompletePrice } from './stripe';

type Attempt = {
  user_id: string;
  nonce: string;
  plan_id: string;
  parameters: string;
  expires_at: number;
  session_id: string | null;
  session_url: string | null;
};
export async function assertCompleteEligible(userId: string) {
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
    AND NOT EXISTS(SELECT 1 FROM complete_checkouts c WHERE c.session_id=a.checkout_session_id) LIMIT 20`)
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
  if(await database().prepare("SELECT 1 FROM complete_plan_changes WHERE user_id=? AND state IN ('preparing','scheduled')").bind(userId).first())throw new PublicError('Un changement vers Zentra Complet est déjà prévu. Retrouvez-le dans Compte → Abonnement.',409);
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
    .prepare('SELECT session_id FROM complete_checkouts WHERE user_id=?')
    .bind(userId)
    .first<{ session_id: string | null }>();
  if (row)
    throw new PublicError(
      'Vous avez choisi Zentra Complet. Retrouvez ou annulez ce paiement dans la page du pack avant de souscrire un produit séparé.',
      409,
    );
}
function attempt(userId: string) {
  return database()
    .prepare('SELECT * FROM complete_checkouts WHERE user_id=?')
    .bind(userId)
    .first<Attempt>();
}
async function resolveSession(row: Attempt) {
  const stripe = automationStripe();
  if (row.session_id) return stripe.checkout.sessions.retrieve(row.session_id);
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    // Recover an API response lost before persisting the session id. Never create
    // another checkout after Stripe's idempotency window may have elapsed.
    const list = await stripe.checkout.sessions.list({
      created: { gte: row.expires_at - 3600, lte: row.expires_at },
      limit: 100,
    });
    const session = list.data.find(
      (s) =>
        s.metadata?.activation_claim_hash === row.nonce &&
        s.metadata.account_user_id === row.user_id &&
        s.metadata.service === COMPLETE_PRODUCT,
    );
    if (session) return session;
    if (list.has_more)
      throw new PublicError(
        'Cette tentative doit être vérifiée. Contactez info@zentraapp.ch ; aucun second paiement ne sera créé.',
        409,
      );
    return { id: '', status: 'expired', url: null } as Stripe.Checkout.Session;
  }
  return stripe.checkout.sessions.create(
    JSON.parse(row.parameters) as Stripe.Checkout.SessionCreateParams,
    { idempotencyKey: `zentra_complete_${row.nonce}` },
  );
}
export async function completeCheckout(
  user: ZentraUser,
  plan: CompletePlan,
  origin: string,
  automaticTax: boolean,
) {
  await assertCompleteEligible(user.userId);
  let row = await attempt(user.userId);
  const db = database(),
    now = Math.floor(Date.now() / 1000);
  if (!row) {
    const price = await ensureCompletePrice(plan),
      nonce = await sha256(randomBase64Url());
    const params = buildZentraCheckoutParams({
      origin,
      claimHash: nonce,
      priceId: price.id,
      plan: plan.licensePlan,
      accountUserId: user.userId,
      accountEmail: user.email,
      automaticTax,
    });
    params.metadata = {
      ...params.metadata,
      service: COMPLETE_PRODUCT,
      bundle_plan: plan.id,
    };
    params.subscription_data!.metadata = {
      ...params.subscription_data!.metadata,
      service: COMPLETE_PRODUCT,
      bundle_plan: plan.id,
    };
    params.subscription_data!.description = `Zentra Complet ${plan.name} · Gestion, Support et Automation`;
    params.cancel_url = `${origin}/complet/abonnement?formule=${plan.id}&paiement=annule`;
    params.expires_at = now + 3600;
    await db
      .prepare(
        'INSERT INTO complete_checkouts(user_id,nonce,plan_id,parameters,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING',
      )
      .bind(
        user.userId,
        nonce,
        plan.id,
        JSON.stringify(params),
        params.expires_at,
      )
      .run();
    row = await attempt(user.userId);
  }
  if (!row)
    throw new PublicError(
      'Le paiement n’a pas pu être préparé. Réessayez.',
      503,
    );
  if (row.plan_id !== plan.id)
    throw new PublicError(
      'Un autre pack est déjà en cours de paiement. Annulez la tentative ci-dessous avant de changer de formule.',
      409,
    );
  const session = await resolveSession(row);
  if (session.status === 'complete')
    throw new PublicError(
      'Le paiement est terminé. Ouvrez votre compte pour retrouver votre entreprise.',
      409,
    );
  if (session.status !== 'open' || !session.url)
    throw new PublicError(
      'Ce lien de paiement a expiré. Annulez la tentative ci-dessous puis recommencez.',
      409,
    );
  await db.batch([
    db
      .prepare(
        'UPDATE complete_checkouts SET session_id=?,session_url=? WHERE user_id=? AND nonce=?',
      )
      .bind(session.id, session.url, user.userId, row.nonce),
    db
      .prepare(
        'INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at,account_user_id,account_email,account_name) VALUES(?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
      )
      .bind(
        row.nonce,
        session.id,
        now,
        now + 365 * 86400,
        user.userId,
        user.email,
        user.displayName,
      ),
    db
      .prepare(
        'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
      )
      .bind(
        crypto.randomUUID(),
        user.userId,
        COMPLETE_TERMS_VERSION,
        'complete_checkout_requested',
        plan.id,
        session.id,
        origin,
        new Date().toISOString(),
      ),
  ]);
  return { url: session.url };
}
export async function cancelCompleteCheckout(user: ZentraUser) {
  const row = await attempt(user.userId);
  if (!row) return { cancelled: true };
  const session = await resolveSession(row);
  if (session.status === 'complete')
    throw new PublicError(
      'Ce paiement est déjà terminé. Gérez votre abonnement depuis votre compte.',
      409,
    );
  if (session.status === 'open')
    await automationStripe().checkout.sessions.expire(session.id);
  await database()
    .prepare('DELETE FROM complete_checkouts WHERE user_id=? AND nonce=?')
    .bind(user.userId, row.nonce)
    .run();
  return { cancelled: true };
}
