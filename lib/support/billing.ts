import Stripe from 'stripe';
import { completeSupportSubscription } from '@/lib/complete/access';
import { completePlan } from '@/lib/complete/plans';
import { completePortal } from '@/lib/complete/stripe';
import { database, runtimeValue, stripeConfiguration } from '@/lib/runtime';
import {
  STRIPE_API_VERSION,
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
} from '@/lib/stripe';
import {
  stripeSecretKeyLivemode,
  stripeReferenceId,
  subscriptionIdFromStripeEvent,
} from '@/lib/stripe-event';
import { stripeTestAccessAllowed } from '@/lib/stripe-test-access';
import type { ZentraUser } from '@/app/zentra-auth';
import { digest } from './crypto';
import { SupportError, type Workspace } from './types';
import { supportGrant } from './founder-access';
import {
  SUPPORT_PRODUCT,
  SUPPORT_LEGAL_VERSION,
  SUPPORT_PLANS,
  supportPlan,
  type SupportPlanId,
  type SupportBillingState,
} from './plans';

type BillingConfig = {
  productId: string;
  prices: Record<SupportPlanId, string>;
  portalId: string;
  livemode: boolean;
  keyBinding: string;
};
export type SubscriptionRow = {
  workspace_id: string;
  subscription_id: string;
  customer_id: string;
  plan_id: string;
  status: string;
  paid_from: number;
  paid_until: number;
  paid_plan_id: string | null;
  last_paid_invoice_id: string | null;
  cancel_at_period_end: number;
  livemode: number;
  updated_at: number;
};
const now = () => Math.floor(Date.now() / 1000);
const ref = (value: unknown) =>
  stripeReferenceId(value as string | { id: string } | null);
function client() {
  const key = runtimeValue('STRIPE_SECRET_KEY');
  if (stripeSecretKeyLivemode(key) === null)
    throw new SupportError(
      'Le paiement est en cours de configuration par Zentra.',
      503,
    );
  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    timeout: 20000,
  });
}
async function configuration(): Promise<BillingConfig | null> {
  const row = await database()
    .prepare(
      "SELECT configuration FROM support_billing_config WHERE id='stripe'",
    )
    .first<{ configuration: string }>();
  if (!row) return null;
  const config = JSON.parse(row.configuration) as BillingConfig;
  if (
    config.keyBinding !== (await digest(runtimeValue('STRIPE_SECRET_KEY'))) ||
    config.livemode !==
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'))
  )
    return null;
  return config;
}
export async function rememberSupportOwner(user: ZentraUser) {
  const email = runtimeValue('ZENTRA_OWNER_EMAIL').toLowerCase();
  if (
    user.provider === 'supabase' &&
    user.emailConfirmed &&
    email &&
    user.email.toLowerCase() === email
  )
    await database()
      .prepare(
        'INSERT INTO support_billing_config(id,configuration,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,updated_at=excluded.updated_at',
      )
      .bind(`owner:${user.userId}`, await digest(email), now())
      .run();
}
export async function isSupportOwner(workspace: Pick<Workspace, 'owner_id'>) {
  if (
    runtimeValue('OWNER_ACCOUNT_USER_ID') &&
    workspace.owner_id === runtimeValue('OWNER_ACCOUNT_USER_ID')
  )
    return true;
  const email = runtimeValue('ZENTRA_OWNER_EMAIL').toLowerCase();
  if (!email) return false;
  const row = await database()
    .prepare('SELECT configuration FROM support_billing_config WHERE id=?')
    .bind(`owner:${workspace.owner_id}`)
    .first<{ configuration: string }>();
  return row?.configuration === (await digest(email));
}
async function subscriptionRow(workspaceId: string) {
  const bundle = await completeSupportSubscription(workspaceId);
  if (bundle) return { workspace_id: workspaceId, subscription_id: bundle.subscription_id, customer_id: bundle.customer_id, plan_id: completePlan(bundle.plan_id)!.support, paid_plan_id: completePlan(bundle.paid_plan_id)?.support ?? null, status: bundle.status, paid_from: bundle.paid_from, paid_until: bundle.refunded ? 0 : Math.min(bundle.paid_until, bundle.entitlement_valid_until), last_paid_invoice_id: bundle.last_paid_invoice_id, cancel_at_period_end: bundle.cancel_at_period_end, livemode: bundle.livemode, updated_at: 0, bundlePlan: completePlan(bundle.paid_plan_id ?? bundle.plan_id)?.name };
  return database()
    .prepare('SELECT * FROM support_subscriptions WHERE workspace_id=?')
    .bind(workspaceId)
    .first<SubscriptionRow>();
}
export function paidAccess(
  row: SubscriptionRow | null,
  live: boolean | null,
  time = now(),
) {
  return (
    !!row &&
    live !== null &&
    row.livemode === (live ? 1 : 0) &&
    !!supportPlan(row.paid_plan_id) &&
    row.paid_from <= time &&
    row.paid_until > time &&
    ['active', 'past_due'].includes(row.status)
  );
}
export async function billingState(
  workspace: Pick<Workspace, 'id' | 'owner_id'>,
): Promise<SupportBillingState> {
  const config = await configuration(),
    row = await subscriptionRow(workspace.id),
    ownerAccess = await isSupportOwner(workspace),
    paid = paidAccess(
      row,
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    ),
    offered = !ownerAccess && !paid ? await supportGrant(workspace) : null,
    plan = offered?.plan ?? supportPlan(row?.paid_plan_id);
  const usage = offered
    ? await database()
        .prepare(
          "SELECT COUNT(*) AS used FROM founder_support_usage WHERE workspace_id=? AND period_start=? AND state='charged'",
        )
        .bind(workspace.id, offered.start)
        .first<{ used: number }>()
    : row
      ? await database()
          .prepare(
            "SELECT COUNT(*) AS used FROM support_analysis_usage WHERE workspace_id=? AND period_start=? AND state='charged'",
          )
          .bind(workspace.id, row.paid_from)
          .first<{ used: number }>()
      : null;
  return {
    active: ownerAccess || paid || !!offered,
    bundlePlan: row && 'bundlePlan' in row ? row.bundlePlan : undefined,
    ownerAccess,
    offeredAccess: !!offered,
    offeredUntil: offered?.expiresAt ?? null,
    ready: !!config,
    testMode: config?.livemode === false,
    plan: plan?.id ?? null,
    status: offered ? 'offered' : (row?.status ?? 'none'),
    used: usage?.used ?? 0,
    limit: plan?.analyses ?? 0,
    periodEnd: offered?.end ?? (row?.paid_until || null),
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
    hasSubscription:
      !!row && !['canceled', 'incomplete_expired'].includes(row.status),
  };
}
export async function requireSupportSubscription(
  workspace: Pick<Workspace, 'id' | 'owner_id'>,
) {
  if (await isSupportOwner(workspace)) return;
  const row = await subscriptionRow(workspace.id);
  if (
    !paidAccess(
      row,
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    ) &&
    !(await supportGrant(workspace))
  )
    throw new SupportError(
      'Activez un abonnement dans Abonnement pour utiliser le tri et le routage. Vos tickets restent dans votre logiciel de support.',
      402,
    );
}
export async function reserveAnalysis(
  workspace: Workspace,
  ticketId: string,
  lease: string,
) {
  if (await isSupportOwner(workspace)) return null;
  await requireSupportSubscription(workspace);
  const row = await subscriptionRow(workspace.id),
    offered = !paidAccess(
      row,
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    )
      ? await supportGrant(workspace)
      : null,
    plan = offered?.plan ?? supportPlan(row?.paid_plan_id);
  if (offered) {
    const time = now();
    const result = await database()
      .prepare(`INSERT INTO founder_support_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at)
      SELECT ?,?,?,?,'reserved',?,? WHERE EXISTS(SELECT 1 FROM founder_support_grants WHERE workspace_id=? AND user_id=? AND revision=? AND revoked_at IS NULL AND valid_until>?)
      AND (SELECT COUNT(*) FROM founder_support_usage WHERE workspace_id=? AND period_start=? AND (state='charged' OR (state='reserved' AND expires_at>?)))<?`)
      .bind(
        lease,
        workspace.id,
        offered.start,
        ticketId,
        time + 180,
        time,
        workspace.id,
        workspace.owner_id,
        offered.revision,
        time,
        workspace.id,
        offered.start,
        time,
        offered.plan.analyses,
      )
      .run();
    if (!result.meta.changes)
      throw new SupportError(
        'Le volume d’analyses offert est atteint ou l’accès a changé. Actualisez votre espace. Aucun supplément ne sera facturé.',
        402,
      );
    return 'founder:' + lease;
  }
  if (
    !row ||
    !plan ||
    !paidAccess(row, stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')))
  )
    throw new SupportError('L’abonnement doit être actualisé.', 402);
  const time = now();
  const result = await database()
    .prepare(
      `INSERT INTO support_analysis_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at) SELECT ?,?,?,?,'reserved',?,? WHERE (SELECT COUNT(*) FROM support_analysis_usage WHERE workspace_id=? AND period_start=? AND (state='charged' OR (state='reserved' AND expires_at>?)))<?`,
    )
    .bind(
      lease,
      workspace.id,
      row.paid_from,
      ticketId,
      time + 180,
      time,
      workspace.id,
      row.paid_from,
      time,
      plan.analyses,
    )
    .run();
  if (!result.meta.changes)
    throw new SupportError(
      'Le volume mensuel d’analyses est atteint. Aucun supplément ne sera facturé. Vos nouveaux tickets restent dans votre outil jusqu’au renouvellement.',
      402,
    );
  return lease;
}
export async function finishAnalysis(
  reservation: string | null,
  success: boolean,
) {
  if (reservation)
    await database()
      .prepare(
        `UPDATE ${reservation.startsWith('founder:') ? 'founder_support_usage' : 'support_analysis_usage'} SET state=? WHERE id=? AND state='reserved'`,
      )
      .bind(
        success ? 'charged' : 'released',
        reservation.startsWith('founder:') ? reservation.slice(8) : reservation,
      )
      .run();
}

function validPrice(price: Stripe.Price, planId: SupportPlanId, live: boolean) {
  const plan = supportPlan(planId)!;
  return (
    price.active &&
    price.livemode === live &&
    price.currency === 'chf' &&
    price.unit_amount === plan.priceChfCents &&
    price.type === 'recurring' &&
    price.recurring?.interval === 'month' &&
    price.recurring.interval_count === 1 &&
    price.tax_behavior === 'inclusive' &&
    price.metadata.service === SUPPORT_PRODUCT &&
    price.metadata.plan === planId
  );
}
export async function provisionSupportBilling() {
  const stripe = client(),
    live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'))!;
  const account = await stripe.accounts.retrieve(null);
  if (live && (!account.charges_enabled || !account.details_submitted))
    throw new SupportError(
      'Terminez l’activation du compte vendeur Stripe avant d’ouvrir les abonnements.',
      503,
    );
  const webhookId = runtimeValue('STRIPE_WEBHOOK_ENDPOINT_ID');
  const hook = await stripe.webhookEndpoints.retrieve(webhookId);
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
    throw new SupportError(
      'Le webhook de paiement Zentra doit être actif et recevoir les événements d’abonnement.',
      503,
    );
  const previous = await configuration();
  const product = previous
    ? await stripe.products.retrieve(previous.productId)
    : await stripe.products
        .create(
          {
            id: 'zentra_support_20260919',
            name: 'Zentra Support',
            description:
              'Tri et routage des tickets support. Abonnement mensuel par entreprise.',
            metadata: { service: SUPPORT_PRODUCT },
          },
          { idempotencyKey: 'zentra-support-product-v1' },
        )
        .catch(async (error) => {
          if ((error as { code?: string }).code === 'resource_already_exists')
            return stripe.products.retrieve('zentra_support_20260919');
          throw error;
        });
  if (
    !product.active ||
    product.metadata.service !== SUPPORT_PRODUCT ||
    product.livemode !== live
  )
    throw new SupportError('Le produit Stripe Support doit être vérifié.', 503);
  const prices = {} as BillingConfig['prices'];
  for (const plan of SUPPORT_PLANS) {
    const lookup = `zentra-support-${plan.id}-chf-${plan.priceChfCents}-v1`;
    const existing = await stripe.prices.list({
      lookup_keys: [lookup],
      limit: 2,
    });
    if (existing.data.length > 1)
      throw new SupportError(
        'Plusieurs tarifs Stripe correspondent à cette formule.',
        503,
      );
    const price =
      existing.data[0] ??
      (await stripe.prices.create(
        {
          product: product.id,
          currency: 'chf',
          unit_amount: plan.priceChfCents,
          recurring: { interval: 'month' },
          tax_behavior: 'inclusive',
          lookup_key: lookup,
          nickname: `${plan.name} · ${plan.analyses} analyses`,
          metadata: {
            service: SUPPORT_PRODUCT,
            plan: plan.id,
            analyses: String(plan.analyses),
          },
        },
        { idempotencyKey: lookup },
      ));
    if (!validPrice(price, plan.id, live) || ref(price.product) !== product.id)
      throw new SupportError(
        'Le tarif Stripe ne correspond pas à l’offre affichée.',
        503,
      );
    prices[plan.id] = price.id;
  }
  const portal = previous
    ? await stripe.billingPortal.configurations.retrieve(previous.portalId)
    : await stripe.billingPortal.configurations.create(
        {
          business_profile: {
            headline: 'Gérer Zentra Support',
            privacy_policy_url:
              runtimeValue('PUBLIC_SITE_URL') + '/confidentialite',
            terms_of_service_url:
              runtimeValue('PUBLIC_SITE_URL') + '/support/conditions',
          },
          features: {
            customer_update: {
              enabled: true,
              allowed_updates: ['email', 'name', 'address'],
            },
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: 'at_period_end' },
            subscription_update: { enabled: false },
          },
          metadata: { service: SUPPORT_PRODUCT },
        },
        { idempotencyKey: 'zentra-support-portal-v1' },
      );
  const config: BillingConfig = {
    productId: product.id,
    prices,
    portalId: portal.id,
    livemode: live,
    keyBinding: await digest(runtimeValue('STRIPE_SECRET_KEY')),
  };
  await database()
    .prepare(
      "INSERT INTO support_billing_config(id,configuration,updated_at) VALUES('stripe',?,?) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,updated_at=excluded.updated_at",
    )
    .bind(JSON.stringify(config), now())
    .run();
  return { ready: true, livemode: live, plans: SUPPORT_PLANS };
}
export async function supportBillingAdminState() {
  const config = await configuration();
  return {
    ready: !!config,
    livemode:
      config?.livemode ??
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    plans: SUPPORT_PLANS,
  };
}

// Private operational check: create then expire each checkout, without customer,
// subscription, consent, payment or entitlement. Never return a payable URL.
export async function verifySupportBilling() {
  const config = await configuration();
  if (!config)
    throw new SupportError('Configurez d’abord les formules Stripe.', 503);
  const stripe = client(),
    results: { plan: string; amount: number; expired: boolean }[] = [];
  for (const plan of SUPPORT_PLANS) {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      locale: 'fr',
      billing_address_collection: 'required',
      payment_method_types: ['card'],
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      line_items: [{ price: config.prices[plan.id], quantity: 1 }],
      metadata: { service: 'zentra-support-preview' },
      subscription_data: {
        metadata: { service: 'zentra-support-preview' },
        billing_mode: { type: 'flexible' },
      },
      success_url: runtimeValue('PUBLIC_SITE_URL') + '/support/admin',
      cancel_url: runtimeValue('PUBLIC_SITE_URL') + '/support/admin',
      expires_at: now() + 1860,
      custom_text: {
        submit: { message: 'Vérification interne Zentra. Ne pas payer.' },
      },
    });
    let validationError: unknown;
    try {
      if (
        !session.url ||
        session.livemode !== config.livemode ||
        session.amount_total !== plan.priceChfCents ||
        session.currency !== 'chf' ||
        session.mode !== 'subscription'
      )
        throw new SupportError(
          'Le paiement Stripe ne correspond pas à la formule.',
          503,
        );
      const page = await fetch(session.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      if (!page.ok)
        throw new SupportError('La page Stripe ne s’ouvre pas.', 503);
    } catch (error) {
      validationError = error;
    }
    const expired = await stripe.checkout.sessions.expire(session.id);
    if (expired.status !== 'expired')
      throw new SupportError(
        'Le paiement de vérification doit être fermé dans Stripe.',
        503,
      );
    if (validationError) throw validationError;
    results.push({ plan: plan.id, amount: plan.priceChfCents, expired: true });
  }
  return {
    verified: true,
    livemode: config.livemode,
    checkouts: results,
    paymentTaken: false,
  };
}

// Entitlements come only from a complete, paid invoice for our exact Price.
export function paidSupportPeriod(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  config: BillingConfig,
) {
  const line = invoice.lines.data[0];
  const priceId = ref(line?.pricing?.price_details?.price),
    plan = SUPPORT_PLANS.find((p) => config.prices[p.id] === priceId);
  if (
    !plan ||
    invoice.status !== 'paid' ||
    invoice.livemode !== config.livemode ||
    invoice.currency !== 'chf' ||
    invoice.amount_paid !== plan.priceChfCents ||
    invoice.amount_due !== plan.priceChfCents ||
    invoice.total !== plan.priceChfCents ||
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1 ||
    ref(invoice.customer) !== ref(subscription.customer) ||
    invoice.parent?.type !== 'subscription_details' ||
    ref(invoice.parent.subscription_details?.subscription) !==
      subscription.id ||
    !['subscription_create', 'subscription_cycle'].includes(
      invoice.billing_reason || '',
    ) ||
    line.parent?.type !== 'subscription_item_details' ||
    line.parent.subscription_item_details?.proration !== false ||
    line.parent.subscription_item_details.subscription !== subscription.id ||
    line.currency !== 'chf' ||
    line.quantity !== 1 ||
    line.subtotal !== plan.priceChfCents ||
    !Number.isSafeInteger(line.period.start) ||
    !Number.isSafeInteger(line.period.end) ||
    line.period.end <= line.period.start ||
    line.period.end - line.period.start > 32 * 86400 ||
    line.period.start > now() + 300
  )
    return null;
  return {
    plan: plan.id,
    start: line.period.start,
    end: line.period.end,
    invoiceId: invoice.id,
  };
}
async function reconcileSubscription(
  subscription: Stripe.Subscription,
  invoice?: Stripe.Invoice | null,
) {
  const config = await configuration();
  if (!config || subscription.metadata.service !== SUPPORT_PRODUCT)
    return false;
  if (subscription.livemode !== config.livemode)
    throw new SupportError('Mode du paiement incohérent.', 503);
  const workspace = await database()
    .prepare('SELECT * FROM support_workspaces WHERE id=?')
    .bind(subscription.metadata.workspace_id || '')
    .first<Workspace>();
  if (!workspace || subscription.metadata.owner_id !== workspace.owner_id)
    throw new SupportError('Le paiement ne correspond pas à cet espace.', 409);
  const plan = supportPlan(subscription.metadata.plan),
    item = subscription.items.data[0];
  if (
    !plan ||
    subscription.items.data.length !== 1 ||
    item.quantity !== 1 ||
    item.price.id !== config.prices[plan.id] ||
    !validPrice(item.price, plan.id, config.livemode)
  )
    throw new SupportError('La formule du paiement doit être vérifiée.', 503);
  const existing = await subscriptionRow(workspace.id);
  if (
    existing &&
    existing.subscription_id !== subscription.id &&
    (existing.paid_until > now() ||
      !['canceled', 'incomplete_expired'].includes(existing.status))
  )
    throw new SupportError('Un abonnement existe déjà pour cet espace.', 409);
  const paid = invoice
    ? paidSupportPeriod(invoice, subscription, config)
    : null;
  if (invoice?.status === 'paid' && !paid)
    throw new SupportError(
      'Le paiement ne correspond pas à la formule attendue.',
      503,
    );
  // Never move a paid period backwards when Stripe retries an older event.
  await database()
    .prepare(
      `INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,status,paid_from,paid_until,paid_plan_id,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,plan_id=excluded.plan_id,status=excluded.status,paid_from=CASE WHEN excluded.paid_until>support_subscriptions.paid_until THEN excluded.paid_from ELSE support_subscriptions.paid_from END,paid_until=MAX(excluded.paid_until,support_subscriptions.paid_until),paid_plan_id=CASE WHEN excluded.paid_until>support_subscriptions.paid_until THEN excluded.paid_plan_id ELSE support_subscriptions.paid_plan_id END,last_paid_invoice_id=CASE WHEN excluded.paid_until>support_subscriptions.paid_until THEN excluded.last_paid_invoice_id ELSE support_subscriptions.last_paid_invoice_id END,cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,updated_at=excluded.updated_at`,
    )
    .bind(
      workspace.id,
      subscription.id,
      ref(subscription.customer),
      plan.id,
      subscription.status,
      paid?.start ?? 0,
      paid?.end ?? 0,
      paid?.plan ?? null,
      paid?.invoiceId ?? null,
      subscription.cancel_at_period_end ? 1 : 0,
      config.livemode ? 1 : 0,
      now(),
    )
    .run();
  return true;
}
export async function persistSupportStripeEvent(event: Stripe.Event) {
  const id = subscriptionIdFromStripeEvent(event);
  if (!id) return false;
  const object = event.data.object as unknown as {
    metadata?: Record<string, string>;
    parent?: { subscription_details?: { metadata?: Record<string, string> } };
  };
  const metadata =
    object.metadata?.service === SUPPORT_PRODUCT ||
    object.parent?.subscription_details?.metadata?.service === SUPPORT_PRODUCT;
  const known = await database()
    .prepare(
      'SELECT workspace_id FROM support_subscriptions WHERE subscription_id=?',
    )
    .bind(id)
    .first();
  if (!metadata && !known) return false;
  const stripe = client(),
    subscription = await stripe.subscriptions.retrieve(id);
  if (subscription.metadata.service !== SUPPORT_PRODUCT) return false;
  const invoice =
    event.type === 'invoice.paid'
      ? await stripe.invoices.retrieve((event.data.object as Stripe.Invoice).id)
      : null;
  return reconcileSubscription(subscription, invoice);
}
export async function createSupportCheckout(
  workspace: Workspace,
  user: ZentraUser,
  body: Record<string, unknown>,
) {
  if (workspace.owner_id !== user.userId)
    throw new SupportError('Le titulaire de l’espace gère l’abonnement.', 403);
  if (!stripeTestAccessAllowed(stripeConfiguration(), user))
    throw new SupportError(
      'Le paiement n’est pas encore ouvert aux clients.',
      503,
    );
  const plan = supportPlan(body.plan),
    config = await configuration();
  if (!plan || !config)
    throw new SupportError('Choisissez une formule disponible.', 503);
  if (body.acceptTerms !== true || body.legalVersion !== SUPPORT_LEGAL_VERSION)
    throw new SupportError(
      'Acceptez les conditions de Zentra Support avant de continuer.',
    );
  const state = await billingState(workspace);
  if (await database().prepare('SELECT 1 FROM complete_checkouts WHERE user_id=?').bind(user.userId).first()) throw new SupportError('Un pack Zentra Complet est déjà choisi. Retrouvez ou annulez ce paiement sur la page du pack.', 409);
  if (state.hasSubscription || (!state.ownerAccess && state.active))
    throw new SupportError(
      'Un abonnement existe déjà. Ouvrez Gérer mon abonnement.',
      409,
    );
  const stripe = client(),
    price = await stripe.prices.retrieve(config.prices[plan.id], {
      expand: ['product'],
    });
  if (
    !validPrice(price, plan.id, config.livemode) ||
    ref(price.product) !== config.productId ||
    typeof price.product === 'string' ||
    price.product.deleted ||
    !price.product.active
  )
    throw new SupportError('Ce tarif n’est pas disponible.', 503);
  const time = now(),
    nonce = crypto.randomUUID(),
    db = database();
  await db
    .prepare(
      `INSERT INTO support_checkouts(workspace_id,nonce,plan_id,expires_at,owner_id,accepted_version,accepted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET nonce=excluded.nonce,plan_id=excluded.plan_id,session_id=NULL,session_url=NULL,expires_at=excluded.expires_at,owner_id=excluded.owner_id,accepted_version=excluded.accepted_version,accepted_at=excluded.accepted_at WHERE support_checkouts.expires_at<=?`,
    )
    .bind(
      workspace.id,
      nonce,
      plan.id,
      time + 86400,
      user.userId,
      SUPPORT_LEGAL_VERSION,
      time,
      time,
    )
    .run();
  const attempt = await db
    .prepare('SELECT * FROM support_checkouts WHERE workspace_id=?')
    .bind(workspace.id)
    .first<{
      nonce: string;
      plan_id: SupportPlanId;
      session_id: string | null;
      session_url: string | null;
      expires_at: number;
      accepted_at: number;
      accepted_version: string;
      owner_id: string;
    }>();
  if (!attempt)
    throw new SupportError('Impossible de préparer le paiement.', 503);
  if (attempt.plan_id !== plan.id)
    throw new SupportError(
      'Un paiement est déjà ouvert pour une autre formule. Terminez-le ou annulez ce paiement pour choisir une autre formule.',
      409,
    );
  const recordAcceptance = async (sessionId: string) => {
    // Persist the original consent before exposing a payable URL. Repeating
    // this also repairs links prepared before an interrupted storage write.
    await db
      .prepare(
        'INSERT INTO support_checkout_acceptances(session_id,workspace_id,owner_id,plan_id,legal_version,accepted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING',
      )
      .bind(
        sessionId,
        workspace.id,
        attempt.owner_id,
        attempt.plan_id,
        attempt.accepted_version,
        attempt.accepted_at,
      )
      .run();
  };
  if (attempt.session_id) {
    const session = await stripe.checkout.sessions.retrieve(attempt.session_id);
    if (session.status === 'open' && session.url) {
      await recordAcceptance(session.id);
      return { url: session.url };
    }
    if (session.status === 'complete') {
      await recordAcceptance(session.id);
      await refreshSupportPayment(workspace, user, session.id);
      return {
        url: `/support/espace?workspace=${workspace.id}&section=billing`,
      };
    }
    await db
      .prepare(
        'UPDATE support_checkouts SET expires_at=0 WHERE workspace_id=? AND nonce=?',
      )
      .bind(workspace.id, attempt.nonce)
      .run();
    throw new SupportError(
      'Le lien précédent a expiré. Choisissez à nouveau votre formule.',
      409,
    );
  }
  const origin = runtimeValue('PUBLIC_SITE_URL'),
    meta = {
      service: SUPPORT_PRODUCT,
      workspace_id: workspace.id,
      owner_id: user.userId,
      plan: plan.id,
    };
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      locale: 'fr',
      client_reference_id: workspace.id,
      customer_email: user.email,
      billing_address_collection: 'required',
      payment_method_types: ['card'],
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      line_items: [{ price: config.prices[plan.id], quantity: 1 }],
      metadata: meta,
      subscription_data: {
        metadata: meta,
        description: `Zentra Support ${plan.name} · ${plan.analyses} analyses/mois`,
        billing_mode: { type: 'flexible' },
      },
      expires_at: attempt.expires_at - 30,
      success_url: `${origin}/support/espace?workspace=${workspace.id}&section=billing&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/support/espace?workspace=${workspace.id}&section=billing&paiement=annule`,
    },
    { idempotencyKey: `support-checkout-${attempt.nonce}` },
  );
  if (!session.url || session.livemode !== config.livemode)
    throw new SupportError('Le lien de paiement n’a pas pu être préparé.', 503);
  await recordAcceptance(session.id);
  await db
    .prepare(
      'UPDATE support_checkouts SET session_id=?,session_url=? WHERE workspace_id=? AND nonce=?',
    )
    .bind(session.id, session.url, workspace.id, attempt.nonce)
    .run();
  return { url: session.url };
}
export async function cancelSupportCheckout(
  workspace: Workspace,
  user: ZentraUser,
) {
  if (workspace.owner_id !== user.userId)
    throw new SupportError('Seul le titulaire peut modifier le paiement.', 403);
  const attempt = await database()
    .prepare(
      'SELECT nonce,session_id FROM support_checkouts WHERE workspace_id=?',
    )
    .bind(workspace.id)
    .first<{ nonce: string; session_id: string | null }>();
  if (!attempt) return { canceled: true };
  if (!attempt.session_id)
    throw new SupportError(
      'Le lien se prépare encore. Réessayez dans quelques secondes.',
      409,
    );
  const stripe = client(),
    session = await stripe.checkout.sessions.retrieve(attempt.session_id);
  if (session.status === 'complete')
    throw new SupportError(
      'Ce paiement est terminé. Actualisez le paiement.',
      409,
    );
  if (session.status === 'open')
    await stripe.checkout.sessions.expire(session.id);
  await database()
    .prepare(
      'UPDATE support_checkouts SET expires_at=0 WHERE workspace_id=? AND nonce=?',
    )
    .bind(workspace.id, attempt.nonce)
    .run();
  return { canceled: true };
}
export async function refreshSupportPayment(
  workspace: Workspace,
  user: ZentraUser,
  sessionId?: string,
) {
  if (workspace.owner_id !== user.userId)
    throw new SupportError(
      'Seul le titulaire peut actualiser le paiement.',
      403,
    );
  if (await completeSupportSubscription(workspace.id)) return { updated: false };
  const stripe = client(),
    config = await configuration();
  if (!config)
    throw new SupportError('Le paiement est en cours de configuration.', 503);
  let id = (await subscriptionRow(workspace.id))?.subscription_id;
  if (sessionId) {
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId))
      throw new SupportError('Lien de paiement invalide.');
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.metadata?.service !== SUPPORT_PRODUCT ||
      session.metadata.workspace_id !== workspace.id ||
      session.metadata.owner_id !== user.userId ||
      session.client_reference_id !== workspace.id ||
      session.livemode !== config.livemode
    )
      throw new SupportError('Ce paiement appartient à un autre espace.', 403);
    if (session.status !== 'complete' || session.payment_status !== 'paid')
      throw new SupportError(
        'Le paiement n’est pas encore confirmé. Votre accès s’activera après confirmation.',
        409,
      );
    id = ref(session.subscription);
  }
  if (!id) return { updated: false };
  const subscription = await stripe.subscriptions.retrieve(id);
  if (
    subscription.metadata.workspace_id !== workspace.id ||
    subscription.metadata.owner_id !== user.userId
  )
    throw new SupportError('Abonnement non autorisé.', 403);
  const invoice = ref(subscription.latest_invoice)
    ? await stripe.invoices.retrieve(ref(subscription.latest_invoice))
    : null;
  await reconcileSubscription(
    subscription,
    invoice?.status === 'paid' ? invoice : null,
  );
  return { updated: true };
}
export async function createSupportPortal(
  workspace: Workspace,
  user: ZentraUser,
) {
  if (workspace.owner_id !== user.userId)
    throw new SupportError('Le titulaire de l’espace gère l’abonnement.', 403);
  const row = await subscriptionRow(workspace.id),
    config = await configuration();
  if (row && 'bundlePlan' in row) return completePortal(row.customer_id, `${runtimeValue('PUBLIC_SITE_URL')}/support/espace?section=billing`);
  if (!row || !config || row.livemode !== (config.livemode ? 1 : 0))
    throw new SupportError('Aucun abonnement à gérer pour cet espace.', 404);
  const session = await client().billingPortal.sessions.create({
    customer: row.customer_id,
    ...('bundlePlan' in row ? {} : { configuration: config.portalId }),
    return_url: `${runtimeValue('PUBLIC_SITE_URL')}/support/espace?workspace=${workspace.id}&section=billing`,
  });
  return { url: session.url };
}
