import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { database, stripeConfiguration } from './runtime';
import { AccountPublicError } from './account-security';
import { requireBrowserMembership } from './account';
import { automationStripe } from './automation/billing';
import {
  stripeReferenceId,
  subscriptionIdFromStripeEvent,
} from './stripe-event';
import { planByLicense } from './plans';
const now = () => Math.floor(Date.now() / 1000);
const ref = (v: unknown) =>
  stripeReferenceId(v as string | { id: string } | null);
type Claim = {
  id: string;
  referrer_organization_id: string;
  referred_user_id: string;
  referred_organization_id: string | null;
  checkout_session_id: string | null;
  subscription_id: string | null;
  state: string;
  first_invoice_id: string | null;
  reward_coupon_id: string | null;
  reward_subscription_id: string | null;
  reward_invoice_id: string | null;
};
export async function referralState(organizationId: string, userId: string) {
  await requireBrowserMembership(userId, organizationId, ['owner', 'admin']);
  const db = database(),
    token =
      'ZT-' +
      Array.from(crypto.getRandomValues(new Uint8Array(8)), (v) =>
        v.toString(16).padStart(2, '0'),
      )
        .join('')
        .toUpperCase();
  await db
    .prepare(
      'INSERT INTO referral_codes(organization_id,code,created_at) VALUES(?,?,?) ON CONFLICT(organization_id) DO NOTHING',
    )
    .bind(organizationId, token, now())
    .run();
  const code = await db
    .prepare('SELECT code FROM referral_codes WHERE organization_id=?')
    .bind(organizationId)
    .first<{ code: string }>();
  const summary = await db
    .prepare(
      "SELECT SUM(state IN ('qualified','reward_applied','reward_used')) AS qualified,SUM(state='qualified') AS waiting,SUM(state='reward_applied') AS nextInvoice,SUM(state='reward_used') AS used FROM referral_claims WHERE referrer_organization_id=?",
    )
    .bind(organizationId)
    .first();
  return { code: code!.code, ...summary };
}
export async function prepareReferral(
  code: unknown,
  user: ZentraUser,
): Promise<{
  claimId: string;
  couponId: string;
  existingSessionId?: string;
  previousSessionId?: string;
} | null> {
  if (code === undefined || code === null || code === '') return null;
  if (
    typeof code !== 'string' ||
    !/^ZT-[A-F0-9]{16}$/.test(code.trim().toUpperCase())
  )
    throw new AccountPublicError('Le code de parrainage est invalide.');
  const db = database(),
    source = await db
      .prepare(
        `SELECT c.organization_id,o.created_by_user_id,s.entitlement_valid_until FROM referral_codes c JOIN organizations o ON o.organization_id=c.organization_id JOIN subscriptions s ON s.subscription_id=o.subscription_id WHERE c.code=?`,
      )
      .bind(code.trim().toUpperCase())
      .first<{
        organization_id: string;
        created_by_user_id: string;
        entitlement_valid_until: number;
      }>();
  if (!source || source.entitlement_valid_until <= now())
    throw new AccountPublicError('Ce code de parrainage n’est pas actif.');
  const existingMembership = await db
    .prepare(
      'SELECT membership_id FROM organization_members WHERE user_id=? AND revoked_at IS NULL LIMIT 1',
    )
    .bind(user.userId)
    .first();
  const previousPaid = await db
    .prepare(
      'SELECT o.organization_id FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id WHERE o.created_by_user_id=? AND s.last_paid_invoice_id IS NOT NULL LIMIT 1',
    )
    .bind(user.userId)
    .first();
  if (
    source.created_by_user_id === user.userId ||
    existingMembership ||
    previousPaid
  )
    throw new AccountPublicError(
      'Le parrainage est réservé à une nouvelle entreprise cliente, avec son propre compte.',
    );
  await db
    .prepare(
      "INSERT INTO referral_claims(id,referrer_organization_id,referred_user_id,state,created_at) VALUES(?,?,?,'pending',?) ON CONFLICT(referred_user_id) DO NOTHING",
    )
    .bind(crypto.randomUUID(), source.organization_id, user.userId, now())
    .run();
  const claim = (await db
    .prepare('SELECT * FROM referral_claims WHERE referred_user_id=?')
    .bind(user.userId)
    .first<Claim>())!;
  if (
    claim.referrer_organization_id !== source.organization_id ||
    claim.state !== 'pending'
  )
    throw new AccountPublicError(
      'Un parrainage a déjà été choisi pour ce compte.',
      409,
    );
  const stripe = automationStripe();
  if (claim.checkout_session_id) {
    const session = await stripe.checkout.sessions.retrieve(
      claim.checkout_session_id,
    );
    if (session.status === 'complete')
      throw new AccountPublicError(
        'Votre première commande a déjà été confirmée.',
        409,
      );
    if (session.status === 'open' && session.url)
      return {
        claimId: claim.id,
        couponId: `zr-first-${claim.id}`,
        existingSessionId: session.id,
      };
  }
  const configuration = stripeConfiguration(),
    products = new Set<string>();
  for (const priceId of Object.values(configuration.priceIds)) {
    const price = await stripe.prices.retrieve(priceId);
    if (
      price.active &&
      price.currency === 'chf' &&
      price.recurring?.interval === 'month'
    )
      products.add(ref(price.product));
  }
  if (!products.size)
    throw new AccountPublicError(
      'Le parrainage est en cours de préparation.',
      503,
    );
  const id = `zr-first-${claim.id}`;
  const coupon = await stripe.coupons
    .create(
      {
        id,
        name: 'Parrainage Zentra · 50 % sur le premier mois',
        percent_off: 50,
        duration: 'once',
        max_redemptions: 1,
        applies_to: { products: [...products] },
        metadata: {
          service: 'zentra-referral',
          claim_id: claim.id,
          kind: 'first_month',
        },
      },
      { idempotencyKey: id },
    )
    .catch(async (error) => {
      if ((error as { code?: string }).code === 'resource_already_exists')
        return stripe.coupons.retrieve(id);
      throw error;
    });
  if (
    coupon.percent_off !== 50 ||
    coupon.duration !== 'once' ||
    coupon.metadata?.claim_id !== claim.id
  )
    throw new AccountPublicError('La remise doit être vérifiée.', 503);
  return {
    claimId: claim.id,
    couponId: id,
    previousSessionId: claim.checkout_session_id ?? undefined,
  };
}
export async function referralCheckoutIdentity(input: {
  claimId: string;
  previousSessionId?: string;
  userId: string;
  planId: string;
  origin: string;
  email: string;
  candidateHash: string;
}) {
  const key = `referral-checkout:${input.claimId}:${input.previousSessionId ?? 'first'}`;
  const value = JSON.stringify({
    userId: input.userId,
    planId: input.planId,
    origin: input.origin,
    email: input.email,
    claimHash: input.candidateHash,
  });
  await database()
    .prepare(
      'INSERT INTO automation_platform(id,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
    )
    .bind(key, value, input.userId, now())
    .run();
  const saved = await database()
    .prepare('SELECT value FROM automation_platform WHERE id=?')
    .bind(key)
    .first<{ value: string }>();
  const stored = JSON.parse(saved!.value) as Record<string, string>;
  if (
    stored.userId !== input.userId ||
    stored.planId !== input.planId ||
    stored.origin !== input.origin ||
    stored.email !== input.email
  )
    throw new AccountPublicError(
      'Une page de paiement a déjà été préparée pour cette formule. Reprenez la formule initiale ou attendez l’expiration de cette page avant de la changer.',
      409,
    );
  return stored.claimHash;
}
export async function rememberReferralCheckout(
  claimId: string,
  sessionId: string,
  userId: string,
) {
  await database()
    .prepare(
      "UPDATE referral_claims SET checkout_session_id=? WHERE id=? AND referred_user_id=? AND state='pending'",
    )
    .bind(sessionId, claimId, userId)
    .run();
}

/** Authorizes only our recorded coupon and exact first/reward invoice; it never
 * relaxes validation just because a Stripe invoice happens to be discounted. */
export async function authorizedReferralDiscount(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
): Promise<number> {
  const amount = planByLicense(subscription.metadata.plan)?.priceChfCents;
  if (!amount || invoice.total === amount) return 0;
  const stripe = automationStripe();
  const expanded = await stripe.invoices.retrieve(invoice.id, {
    expand: ['discounts.source.coupon'],
  });
  if (
    expanded.total !== invoice.total ||
    expanded.discounts.length !== 1 ||
    expanded.lines.data.length !== 1 ||
    expanded.lines.has_more
  )
    return 0;
  const discount = expanded.discounts[0];
  if (
    typeof discount === 'string' ||
    discount.deleted ||
    discount.source.type !== 'coupon'
  )
    return 0;
  const coupon = discount.source.coupon;
  if (
    !coupon ||
    typeof coupon === 'string' ||
    coupon.metadata?.service !== 'zentra-referral' ||
    coupon.duration !== 'once'
  )
    return 0;
  const claim = await database()
    .prepare('SELECT * FROM referral_claims WHERE id=?')
    .bind(coupon.metadata.claim_id || '')
    .first<Claim>();
  if (!claim) return 0;
  const first =
    coupon.id === `zr-first-${claim.id}` &&
    coupon.percent_off === 50 &&
    invoice.billing_reason === 'subscription_create' &&
    claim.referred_user_id === subscription.metadata.account_user_id &&
    subscription.metadata.referral_claim === claim.id &&
    (!claim.subscription_id || claim.subscription_id === subscription.id) &&
    (!claim.first_invoice_id || claim.first_invoice_id === invoice.id);
  const reward =
    coupon.id === claim.reward_coupon_id &&
    coupon.percent_off === 25 &&
    claim.reward_subscription_id === subscription.id &&
    invoice.billing_reason === 'subscription_cycle' &&
    (!claim.reward_invoice_id || claim.reward_invoice_id === invoice.id);
  if (!first && !reward) return 0;
  const expected = Math.round(amount * (first ? 0.5 : 0.25)),
    discounts = expanded.total_discount_amounts || [];
  if (
    discounts.length !== 1 ||
    discounts[0].amount !== expected ||
    ref(discounts[0].discount) !== discount.id ||
    expanded.total !== amount - expected
  )
    return 0;
  return expected;
}
export async function applyNextReferralReward(organizationId: string) {
  const db = database(),
    organization = await db
      .prepare(
        'SELECT subscription_id FROM organizations WHERE organization_id=?',
      )
      .bind(organizationId)
      .first<{ subscription_id: string }>();
  if (!organization) return;
  const pending = await db
    .prepare(
      "SELECT * FROM referral_claims WHERE referrer_organization_id=? AND state='qualified' ORDER BY created_at,id LIMIT 1",
    )
    .bind(organizationId)
    .first<Claim>();
  if (!pending) return;
  const stripe = automationStripe(),
    subscription = await stripe.subscriptions.retrieve(
      organization.subscription_id,
      { expand: ['discounts'] },
    );
  if (
    subscription.status !== 'active' ||
    !planByLicense(subscription.metadata.plan) ||
    subscription.items.data.length !== 1
  )
    return;
  const existing = (subscription.discounts || []).filter(
    (d) => typeof d === 'string' || !d.deleted,
  );
  const couponId = `zr-reward-${pending.id}`;
  if (existing.length) {
    const same = existing.some(
      (d) => typeof d !== 'string' && ref(d.source.coupon) === couponId,
    );
    if (same)
      await db
        .prepare(
          "UPDATE referral_claims SET state='reward_applied',reward_applied_at=? WHERE id=? AND state='qualified'",
        )
        .bind(now(), pending.id)
        .run();
    return;
  }
  // A conditional lease serializes multiple referral webhooks for one referrer.
  const lock = await db
    .prepare(
      'INSERT INTO automation_platform(id,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE automation_platform.updated_at<?',
    )
    .bind(
      `referral-lock:${organizationId}`,
      pending.id,
      'referral',
      now(),
      now() - 120,
    )
    .run();
  if (!lock.meta.changes)
    throw new AccountPublicError('La remise est en cours de préparation.', 503);
  try {
    // The claim may have been consumed while this request was waiting for its lease.
    const stillPending = await db
      .prepare(
        "SELECT id FROM referral_claims WHERE id=? AND state='qualified'",
      )
      .bind(pending.id)
      .first();
    if (!stillPending) return;
    const product = ref(subscription.items.data[0].price.product);
    await stripe.coupons
      .create(
        {
          id: couponId,
          name: 'Parrainage Zentra · 25 % sur le prochain mois',
          percent_off: 25,
          duration: 'once',
          max_redemptions: 1,
          applies_to: { products: [product] },
          metadata: {
            service: 'zentra-referral',
            claim_id: pending.id,
            kind: 'reward',
          },
        },
        { idempotencyKey: couponId },
      )
      .catch(async (error) => {
        if ((error as { code?: string }).code === 'resource_already_exists')
          return stripe.coupons.retrieve(couponId);
        throw error;
      });
    await db
      .prepare(
        "UPDATE referral_claims SET reward_coupon_id=?,reward_subscription_id=? WHERE id=? AND state='qualified'",
      )
      .bind(couponId, subscription.id, pending.id)
      .run();
    // Re-read after the lease, preserve any externally added discount.
    const fresh = await stripe.subscriptions.retrieve(subscription.id);
    if (fresh.discounts.length) return;
    await stripe.subscriptions.update(
      subscription.id,
      { discounts: [{ coupon: couponId }], proration_behavior: 'none' },
      { idempotencyKey: `referral-award-${pending.id}` },
    );
    await db
      .prepare(
        "UPDATE referral_claims SET state='reward_applied',reward_applied_at=? WHERE id=? AND state='qualified'",
      )
      .bind(now(), pending.id)
      .run();
  } finally {
    await db
      .prepare('DELETE FROM automation_platform WHERE id=? AND value=?')
      .bind(`referral-lock:${organizationId}`, pending.id)
      .run();
  }
}
export async function reconcileReferralEvent(event: Stripe.Event) {
  const id = subscriptionIdFromStripeEvent(event);
  if (!id) return;
  const db = database(),
    stripe = automationStripe();
  const object = event.data.object as unknown as {
    metadata?: Record<string, string>;
    parent?: { subscription_details?: { metadata?: Record<string, string> } };
  };
  const claimId =
    object.metadata?.referral_claim ||
    object.parent?.subscription_details?.metadata?.referral_claim ||
    '';
  const claims = await db
    .prepare(
      'SELECT * FROM referral_claims WHERE subscription_id=? OR reward_subscription_id=? OR checkout_session_id=? OR id=?',
    )
    .bind(
      id,
      id,
      event.type.startsWith('checkout.session.')
        ? (event.data.object as { id: string }).id
        : '',
      claimId,
    )
    .all<Claim>();
  const subscription = await stripe.subscriptions.retrieve(id);
  const invoiceId =
    event.type === 'invoice.paid'
      ? (event.data.object as { id: string }).id
      : ref(subscription.latest_invoice);
  if (!invoiceId) return;
  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ['discounts.source.coupon'],
  });
  if (invoice.status !== 'paid' || invoice.amount_paid <= 0) return;
  for (const claim of claims.results) {
    const discount = invoice.discounts[0];
    const coupon =
      typeof discount === 'object' && discount && !discount.deleted
        ? discount.source.coupon
        : null;
    if (
      !coupon ||
      typeof coupon === 'string' ||
      coupon.metadata?.claim_id !== claim.id
    )
      continue;
    if (
      subscription.metadata.referral_claim === claim.id &&
      subscription.metadata.account_user_id === claim.referred_user_id &&
      invoice.billing_reason === 'subscription_create'
    ) {
      const org = await db
        .prepare(
          'SELECT organization_id FROM organizations WHERE subscription_id=? AND created_by_user_id=?',
        )
        .bind(id, claim.referred_user_id)
        .first<{ organization_id: string }>();
      if (
        org &&
        org.organization_id !== claim.referrer_organization_id &&
        (await authorizedReferralDiscount(invoice, subscription)) > 0
      ) {
        await db
          .prepare(
            "UPDATE referral_claims SET state=CASE WHEN state='pending' THEN 'qualified' ELSE state END,subscription_id=?,referred_organization_id=?,first_invoice_id=? WHERE id=? AND (first_invoice_id IS NULL OR first_invoice_id=?)",
          )
          .bind(id, org.organization_id, invoice.id, claim.id, invoice.id)
          .run();
        await applyNextReferralReward(claim.referrer_organization_id);
      }
    }
    if (
      claim.reward_subscription_id === id &&
      invoice.billing_reason === 'subscription_cycle' &&
      (await authorizedReferralDiscount(invoice, subscription)) > 0
    ) {
      await db
        .prepare(
          "UPDATE referral_claims SET state='reward_used',reward_invoice_id=? WHERE id=? AND state='reward_applied'",
        )
        .bind(invoice.id, claim.id)
        .run();
      await applyNextReferralReward(claim.referrer_organization_id);
    }
  }
  // A queued reward can become available after an unrelated coupon expires.
  if (
    event.type === 'invoice.paid' &&
    invoice.billing_reason === 'subscription_cycle'
  ) {
    const organization = await db
      .prepare(
        'SELECT organization_id FROM organizations WHERE subscription_id=?',
      )
      .bind(id)
      .first<{ organization_id: string }>();
    if (organization)
      await applyNextReferralReward(organization.organization_id);
  }
}
