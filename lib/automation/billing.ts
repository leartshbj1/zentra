import Stripe from 'stripe';
import { database, runtimeValue, stripeConfiguration } from '@/lib/runtime';
import {
  STRIPE_API_VERSION,
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
} from '@/lib/stripe';
import {
  stripeSecretKeyLivemode,
  stripeReferenceId,
  subscriptionIdFromStripeEvent,
  paidThroughFromInvoice,
} from '@/lib/stripe-event';
import {
  stripeTestAccessAllowed,
  stripeAutomaticTaxRequired,
} from '@/lib/stripe-test-access';
import { AccountPublicError } from '@/lib/account-security';
import type { ZentraUser } from '@/app/zentra-auth';
import { requireBrowserMembership } from '@/lib/account';
import { digest } from '@/lib/support/crypto';
import { AUTOMATION_PRODUCT, AUTOMATION_PRICE_CENTS } from './types';
import { AUTOMATION_CONSENT_VERSION } from './config';

export const AUTOMATION_TERMS_VERSION = 'automation-2026-09-20';
type Config = {
  productId: string;
  priceId: string;
  portalId: string;
  livemode: boolean;
  keyBinding: string;
};
const now = () => Math.floor(Date.now() / 1000);
const ref = (v: unknown) =>
  stripeReferenceId(v as string | { id: string } | null);
export function automationStripe() {
  const key = runtimeValue('STRIPE_SECRET_KEY');
  if (stripeSecretKeyLivemode(key) === null)
    throw new AccountPublicError('Le paiement est indisponible.', 503);
  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    timeout: 20000,
  });
}
export async function automationBillingConfig(): Promise<Config | null> {
  const row = await database()
    .prepare("SELECT value FROM automation_platform WHERE id='billing'")
    .first<{ value: string }>();
  if (!row) return null;
  const config = JSON.parse(row.value) as Config;
  return config.livemode ===
    stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')) &&
    config.keyBinding === (await digest(runtimeValue('STRIPE_SECRET_KEY')))
    ? config
    : null;
}
export function validAutomationPrice(
  price: Stripe.Price,
  config: Pick<Config, 'productId' | 'livemode'>,
) {
  return (
    price.active &&
    price.livemode === config.livemode &&
    ref(price.product) === config.productId &&
    price.currency === 'chf' &&
    price.unit_amount === AUTOMATION_PRICE_CENTS &&
    price.type === 'recurring' &&
    price.recurring?.interval === 'month' &&
    price.recurring.interval_count === 1 &&
    price.recurring.usage_type === 'licensed' &&
    price.tax_behavior === 'inclusive' &&
    price.metadata.service === AUTOMATION_PRODUCT
  );
}
export async function provisionAutomationBilling(actor: string) {
  const stripe = automationStripe(),
    live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'))!;
  const account = await stripe.accounts.retrieve(null);
  if (live && (!account.charges_enabled || !account.details_submitted))
    throw new AccountPublicError(
      'Terminez l’activation du compte vendeur Stripe.',
      503,
    );
  const hook = await stripe.webhookEndpoints.retrieve(
    runtimeValue('STRIPE_WEBHOOK_ENDPOINT_ID'),
  );
  if (
    hook.status !== 'enabled' ||
    hook.livemode !== live ||
    hook.api_version !== STRIPE_API_VERSION ||
    hook.url !== runtimeValue('PUBLIC_SITE_URL') + '/api/stripe/webhook' ||
    !REQUIRED_STRIPE_WEBHOOK_EVENTS.every(
      (e) =>
        hook.enabled_events.includes('*') || hook.enabled_events.includes(e),
    )
  )
    throw new AccountPublicError(
      'La réception des paiements doit être configurée avant l’ouverture.',
      503,
    );
  const productId = 'zentra_automation_15chf_20260920';
  const product = await stripe.products
    .create(
      {
        id: productId,
        name: 'Zentra Automation',
        description:
          'Suggestions et classement dans Zentra Gestion. Option mensuelle par entreprise.',
        metadata: { service: AUTOMATION_PRODUCT },
      },
      { idempotencyKey: productId },
    )
    .catch(async (error) => {
      if ((error as { code?: string }).code === 'resource_already_exists')
        return stripe.products.retrieve(productId);
      throw error;
    });
  if (
    !product.active ||
    product.livemode !== live ||
    product.metadata.service !== AUTOMATION_PRODUCT
  )
    throw new AccountPublicError('Le produit Stripe doit être vérifié.', 503);
  const lookup = 'zentra-automation-chf-1500-monthly-v1',
    list = await stripe.prices.list({ lookup_keys: [lookup], limit: 2 });
  if (list.data.length > 1)
    throw new AccountPublicError('Le tarif Stripe est ambigu.', 503);
  const price =
    list.data[0] ??
    (await stripe.prices.create(
      {
        product: productId,
        currency: 'chf',
        unit_amount: AUTOMATION_PRICE_CENTS,
        recurring: { interval: 'month' },
        tax_behavior: 'inclusive',
        lookup_key: lookup,
        metadata: { service: AUTOMATION_PRODUCT },
      },
      { idempotencyKey: lookup },
    ));
  if (!validAutomationPrice(price, { productId, livemode: live }))
    throw new AccountPublicError(
      'Le tarif ne correspond pas à 15 CHF par mois.',
      503,
    );
  const previous = await automationBillingConfig();
  const portal = previous
    ? await stripe.billingPortal.configurations.retrieve(previous.portalId)
    : await stripe.billingPortal.configurations.create(
        {
          business_profile: {
            headline: 'Gérer Zentra Automation',
            privacy_policy_url:
              runtimeValue('PUBLIC_SITE_URL') + '/confidentialite',
            terms_of_service_url:
              runtimeValue('PUBLIC_SITE_URL') + '/automation/conditions',
          },
          features: {
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: 'at_period_end' },
            subscription_update: { enabled: false },
          },
          metadata: { service: AUTOMATION_PRODUCT },
        },
        { idempotencyKey: 'zentra-automation-portal-v1' },
      );
  const config = {
    productId,
    priceId: price.id,
    portalId: portal.id,
    livemode: live,
    keyBinding: await digest(runtimeValue('STRIPE_SECRET_KEY')),
  };
  await database()
    .prepare(
      "INSERT INTO automation_platform(id,value,updated_by,updated_at) VALUES('billing',?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
    )
    .bind(JSON.stringify(config), actor, now())
    .run();
  return { ready: true, priceChfCents: AUTOMATION_PRICE_CENTS, livemode: live };
}
export async function automationBillingState(organizationId: string) {
  const [config, row] = await Promise.all([
    automationBillingConfig(),
    database()
      .prepare(
        'SELECT status,paid_until,cancel_at_period_end FROM automation_subscriptions WHERE organization_id=?',
      )
      .bind(organizationId)
      .first<{
        status: string;
        paid_until: number;
        cancel_at_period_end: number;
      }>(),
  ]);
  return {
    ready: !!config,
    priceChfCents: AUTOMATION_PRICE_CENTS,
    status: row?.status ?? 'none',
    periodEnd: row?.paid_until ?? null,
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
    hasSubscription:
      !!row && !['canceled', 'incomplete_expired'].includes(row.status),
  };
}
export async function createAutomationCheckout(
  organizationId: string,
  user: ZentraUser,
  body: Record<string, unknown>,
  origin: string,
) {
  const membership = await requireBrowserMembership(
    user.userId,
    organizationId,
    ['owner'],
  );
  if (!stripeTestAccessAllowed(stripeConfiguration(), user))
    throw new AccountPublicError('Le paiement est encore en test privé.', 403);
  if (
    body.acceptTerms !== true ||
    body.legalVersion !== AUTOMATION_TERMS_VERSION ||
    body.consentVersion !== AUTOMATION_CONSENT_VERSION
  )
    throw new AccountPublicError(
      'Acceptez les conditions de l’option et le traitement des extraits nécessaires.',
    );
  const [config, billing, base] = await Promise.all([
    automationBillingConfig(),
    automationBillingState(organizationId),
    database()
      .prepare(
        'SELECT customer_id,entitlement_valid_until FROM subscriptions WHERE subscription_id=?',
      )
      .bind(membership.subscriptionId)
      .first<{ customer_id: string; entitlement_valid_until: number }>(),
  ]);
  if (!config)
    throw new AccountPublicError(
      'L’option sera disponible après la configuration du paiement.',
      503,
    );
  if (!base || base.entitlement_valid_until < now())
    throw new AccountPublicError(
      'Un abonnement Zentra Gestion actif est nécessaire.',
      402,
    );
  if (billing.hasSubscription)
    throw new AccountPublicError(
      'L’option possède déjà un abonnement. Ouvrez Gérer mon abonnement.',
      409,
    );
  const stripe = automationStripe(),
    price = await stripe.prices.retrieve(config.priceId);
  if (!validAutomationPrice(price, config))
    throw new AccountPublicError('Le tarif a changé. Contactez Zentra.', 503);
  const previous = await database()
    .prepare(
      'SELECT attempt_id,session_id,expires_at,request_json,user_id FROM automation_checkouts WHERE organization_id=?',
    )
    .bind(organizationId)
    .first<{
      attempt_id: string;
      request_json: string | null;
      user_id: string;
      session_id: string | null;
      expires_at: number;
    }>();
  const resumable =
    previous &&
    previous.expires_at > now() &&
    !previous.session_id &&
    previous.request_json &&
    previous.user_id === user.userId;
  if (previous && previous.expires_at > now() && !resumable) {
    if (!previous.session_id)
      throw new AccountPublicError(
        'Une page de paiement est en préparation. Réessayez dans un instant.',
        409,
      );
    const session = await stripe.checkout.sessions.retrieve(
      previous.session_id,
    );
    if (session.status === 'open' && session.url) return { url: session.url };
    if (session.status === 'complete')
      throw new AccountPublicError(
        'Votre paiement est en cours de confirmation. Actualisez l’état de l’option.',
        409,
      );
    if (session.status === 'expired')
      await database()
        .prepare(
          'UPDATE automation_checkouts SET expires_at=? WHERE organization_id=? AND attempt_id=? AND session_id=?',
        )
        .bind(now(), organizationId, previous.attempt_id, session.id)
        .run();
  }
  const attempt = resumable ? previous!.attempt_id : crypto.randomUUID();
  const lease = resumable
    ? { meta: { changes: 1 } }
    : await database()
        .prepare(
          `INSERT INTO automation_checkouts(organization_id,attempt_id,user_id,expires_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET attempt_id=excluded.attempt_id,session_id=NULL,request_json=NULL,user_id=excluded.user_id,expires_at=excluded.expires_at,created_at=excluded.created_at WHERE automation_checkouts.expires_at<=?`,
        )
        .bind(organizationId, attempt, user.userId, now() + 3600, now(), now())
        .run();
  if (!lease.meta.changes)
    throw new AccountPublicError(
      'Une demande de paiement existe déjà. Réessayez après son expiration.',
      409,
    );
  // An uncertain network failure retains the lease. Never open a second paid subscription.
  const parameters: Stripe.Checkout.SessionCreateParams = resumable
    ? JSON.parse(previous!.request_json!)
    : {
        mode: 'subscription',
        locale: 'fr',
        customer: base.customer_id,
        line_items: [{ price: config.priceId, quantity: 1 }],
        automatic_tax: {
          enabled: stripeAutomaticTaxRequired(stripeConfiguration()),
        },
        allow_promotion_codes: false,
        expires_at: now() + 3500,
        metadata: {
          service: AUTOMATION_PRODUCT,
          organization_id: organizationId,
          owner_id: user.userId,
          attempt_id: attempt,
        },
        subscription_data: {
          description: 'Zentra Automation · 15 CHF/mois',
          metadata: {
            service: AUTOMATION_PRODUCT,
            organization_id: organizationId,
            owner_id: user.userId,
          },
        },
        success_url: `${origin}/compte/automation?entreprise=${encodeURIComponent(organizationId)}&paiement=retour`,
        cancel_url: `${origin}/compte/automation?entreprise=${encodeURIComponent(organizationId)}&paiement=annule`,
      };
  if (!resumable)
    await database()
      .prepare(
        'UPDATE automation_checkouts SET request_json=? WHERE organization_id=? AND attempt_id=?',
      )
      .bind(JSON.stringify(parameters), organizationId, attempt)
      .run();
  const session = await stripe.checkout.sessions.create(parameters, {
    idempotencyKey: `automation-checkout-${attempt}`,
  });
  await database()
    .prepare(
      'UPDATE automation_checkouts SET session_id=?,expires_at=? WHERE organization_id=? AND attempt_id=?',
    )
    .bind(session.id, session.expires_at, organizationId, attempt)
    .run();
  await database()
    .prepare(
      'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
    )
    .bind(
      crypto.randomUUID(),
      user.userId,
      AUTOMATION_TERMS_VERSION,
      'automation_checkout',
      AUTOMATION_PRODUCT,
      session.id,
      origin,
      new Date().toISOString(),
    )
    .run();
  if (!session.url)
    throw new AccountPublicError(
      'La page de paiement n’a pas été retournée.',
      502,
    );
  return { url: session.url };
}
export async function automationPortal(
  organizationId: string,
  user: ZentraUser,
  origin: string,
) {
  await requireBrowserMembership(user.userId, organizationId, ['owner']);
  const [config, row] = await Promise.all([
    automationBillingConfig(),
    database()
      .prepare(
        'SELECT customer_id FROM automation_subscriptions WHERE organization_id=?',
      )
      .bind(organizationId)
      .first<{ customer_id: string }>(),
  ]);
  if (!config || !row)
    throw new AccountPublicError('Aucun abonnement Automation à gérer.');
  const portal = await automationStripe().billingPortal.sessions.create({
    customer: row.customer_id,
    configuration: config.portalId,
    return_url: origin + '/compte/automation',
  });
  return { url: portal.url };
}

export function paidAutomationPeriod(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  config: Config,
) {
  const end = paidThroughFromInvoice(invoice, {
    subscriptionId: subscription.id,
    priceId: config.priceId,
    unitAmount: AUTOMATION_PRICE_CENTS,
    livemode: config.livemode,
    automaticTaxRequired: stripeAutomaticTaxRequired(stripeConfiguration()),
  });
  const line = invoice.lines.data[0];
  if (
    !end ||
    invoice.lines.data.length !== 1 ||
    ref(invoice.customer) !== ref(subscription.customer) ||
    invoice.amount_due !== AUTOMATION_PRICE_CENTS ||
    invoice.amount_paid !== AUTOMATION_PRICE_CENTS ||
    line.period.start > now() + 300 ||
    end - line.period.start > 32 * 86400
  )
    return null;
  return { start: line.period.start, end, invoiceId: invoice.id };
}
async function reconcile(
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice | null,
) {
  const config = await automationBillingConfig();
  if (!config || subscription.metadata.service !== AUTOMATION_PRODUCT)
    return false;
  const org = await database()
    .prepare(
      'SELECT organization_id,created_by_user_id FROM organizations WHERE organization_id=?',
    )
    .bind(subscription.metadata.organization_id)
    .first<{ organization_id: string; created_by_user_id: string }>();
  const item = subscription.items.data[0];
  if (
    !org ||
    org.created_by_user_id !== subscription.metadata.owner_id ||
    subscription.livemode !== config.livemode ||
    subscription.items.data.length !== 1 ||
    item.quantity !== 1 ||
    item.price.id !== config.priceId ||
    !validAutomationPrice(item.price, config)
  )
    throw new AccountPublicError(
      'Ce paiement ne correspond pas à cette entreprise.',
      409,
    );
  const previous = await database()
    .prepare(
      'SELECT subscription_id,status,paid_until FROM automation_subscriptions WHERE organization_id=?',
    )
    .bind(org.organization_id)
    .first<{ subscription_id: string; status: string; paid_until: number }>();
  if (
    previous &&
    previous.subscription_id !== subscription.id &&
    (previous.paid_until > now() ||
      !['canceled', 'incomplete_expired'].includes(previous.status))
  )
    throw new AccountPublicError('Un autre abonnement est déjà actif.', 409);
  const paid = invoice
    ? paidAutomationPeriod(invoice, subscription, config)
    : null;
  if (invoice?.status === 'paid' && !paid)
    throw new AccountPublicError(
      'La facture Automation doit être vérifiée.',
      503,
    );
  await database()
    .prepare(
      `INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,status=excluded.status,paid_from=CASE WHEN excluded.paid_until>automation_subscriptions.paid_until THEN excluded.paid_from ELSE automation_subscriptions.paid_from END,paid_until=MAX(excluded.paid_until,automation_subscriptions.paid_until),last_paid_invoice_id=CASE WHEN excluded.paid_until>automation_subscriptions.paid_until THEN excluded.last_paid_invoice_id ELSE automation_subscriptions.last_paid_invoice_id END,cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,updated_at=excluded.updated_at`,
    )
    .bind(
      org.organization_id,
      subscription.id,
      ref(subscription.customer),
      subscription.status,
      paid?.start ?? 0,
      paid?.end ?? 0,
      paid?.invoiceId ?? null,
      subscription.cancel_at_period_end ? 1 : 0,
      config.livemode ? 1 : 0,
      now(),
    )
    .run();
  return true;
}
export async function persistAutomationStripeEvent(event: Stripe.Event) {
  const id = subscriptionIdFromStripeEvent(event);
  if (!id) return false;
  const object = event.data.object as unknown as {
    metadata?: Record<string, string>;
    parent?: { subscription_details?: { metadata?: Record<string, string> } };
  };
  const known = await database()
    .prepare(
      'SELECT organization_id FROM automation_subscriptions WHERE subscription_id=?',
    )
    .bind(id)
    .first();
  if (
    !known &&
    object.metadata?.service !== AUTOMATION_PRODUCT &&
    object.parent?.subscription_details?.metadata?.service !==
      AUTOMATION_PRODUCT
  )
    return false;
  const stripe = automationStripe(),
    subscription = await stripe.subscriptions.retrieve(id);
  const invoice =
    event.type === 'invoice.paid'
      ? await stripe.invoices.retrieve((event.data.object as Stripe.Invoice).id)
      : null;
  return reconcile(subscription, invoice);
}
export async function refreshAutomationPayment(
  organizationId: string,
  user: ZentraUser,
) {
  await requireBrowserMembership(user.userId, organizationId, ['owner']);
  const row = await database()
    .prepare(
      'SELECT session_id FROM automation_checkouts WHERE organization_id=? AND user_id=?',
    )
    .bind(organizationId, user.userId)
    .first<{ session_id: string | null }>();
  if (!row?.session_id) return automationBillingState(organizationId);
  const stripe = automationStripe(),
    session = await stripe.checkout.sessions.retrieve(row.session_id);
  if (
    session.status === 'complete' &&
    session.payment_status === 'paid' &&
    session.metadata?.organization_id === organizationId &&
    session.metadata.owner_id === user.userId
  ) {
    const subscription = await stripe.subscriptions.retrieve(
        ref(session.subscription),
      ),
      invoice = await stripe.invoices.retrieve(ref(session.invoice));
    await reconcile(subscription, invoice);
  }
  return automationBillingState(organizationId);
}
