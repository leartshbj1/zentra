import Stripe from 'stripe';
import { LICENSE_PLAN, LICENSE_PRICE_CHF_CENTS } from '@/lib/license-constants';
import { RequestBodyError } from '@/lib/request-body';
import { database, stripeConfiguration } from '@/lib/runtime';
import {
  stripeAccountReadinessProblem,
  stripePortalConfigurationIsReady,
} from '@/lib/stripe-account';
import { buildZentraCheckoutParams } from '@/lib/stripe-checkout';
import {
  CLAIM_STRIPE_EVENT_SQL,
  COMPLETE_STRIPE_EVENT_SQL,
  INSERT_STRIPE_EVENT_SQL,
  RELEASE_STRIPE_EVENT_SQL,
  UPSERT_SUBSCRIPTION_SQL,
} from '@/lib/stripe-sql';
import { constructVerifiedStripeEvent } from '@/lib/stripe-webhook';
import { UPSERT_STRIPE_WEBHOOK_PROOF_SQL } from '@/lib/stripe-webhook-proof';
import { stripeAutomaticTaxRequired } from '@/lib/stripe-test-access';
import {
  paidThroughFromInvoice,
  stripeReferenceId,
  stripeSecretKeyLivemode,
  subscriptionIdFromStripeEvent,
  type StripeReference,
} from '@/lib/stripe-event';

export { LICENSE_PLAN, LICENSE_PRICE_CHF_CENTS } from '@/lib/license-constants';
export const ACTIVATION_COOKIE = 'hc_activation_claim';
export const STRIPE_API_VERSION = '2026-08-26.dahlia';
export const STRIPE_PRICE_TAX_BEHAVIOR = 'inclusive';
export const REQUIRED_STRIPE_WEBHOOK_EVENTS = [
  'customer.created',
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.finalization_failed',
  'invoice.marked_uncollectible',
  'invoice.voided',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

export type StripeCheckoutSession = Stripe.Checkout.Session;
export type StripeSubscription = Stripe.Subscription;
type StripeEvent = Stripe.Event;

export class PublicError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function jsonError(reason: unknown) {
  const publicReason =
    reason instanceof PublicError || reason instanceof RequestBodyError;
  const status = publicReason ? reason.status : 500;
  const message = publicReason
    ? reason.message
    : 'Le service de paiement est momentanément indisponible.';
  return Response.json(
    { error: message },
    { status, headers: noStoreHeaders() },
  );
}

export function noStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  };
}

let stripeClient: Stripe | null = null;
let stripeClientKey = '';

function stripe() {
  const { secretKey } = stripeConfiguration();
  if (!secretKey)
    throw new PublicError(
      'Le compte marchand Stripe n’est pas encore configuré.',
      503,
    );
  if (!stripeClient || stripeClientKey !== secretKey) {
    stripeClient = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
      httpClient: Stripe.createFetchHttpClient(),
      maxNetworkRetries: 2,
      timeout: 20_000,
      typescript: true,
    });
    stripeClientKey = secretKey;
  }
  return stripeClient;
}

async function stripeOperation<T>(name: string, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const stripeError = error as {
      statusCode?: number;
      type?: string;
      code?: string;
    };
    console.error('Stripe API request failed', {
      operation: name,
      status: stripeError.statusCode,
      type: stripeError.type,
      code: stripeError.code,
    });
    throw new PublicError(
      (stripeError.statusCode ?? 500) >= 500
        ? 'Stripe est momentanément indisponible. Réessayez dans quelques instants.'
        : 'La configuration Stripe doit être vérifiée par le marchand.',
      502,
    );
  }
}

export async function createCheckoutSession(
  origin: string,
  claimHash: string,
  account: { userId: string; email: string },
) {
  const configuration = stripeConfiguration();
  const { priceId } = configuration;
  if (!/^price_[A-Za-z0-9_]+$/.test(priceId))
    throw new PublicError('Le prix Stripe Zentra n’est pas configuré.', 503);
  const session = await stripeOperation('checkout.sessions.create', () =>
    stripe().checkout.sessions.create(
      buildZentraCheckoutParams({
        origin,
        claimHash,
        priceId,
        plan: LICENSE_PLAN,
        accountUserId: account.userId,
        accountEmail: account.email,
        automaticTax: stripeAutomaticTaxRequired(configuration),
      }),
      { idempotencyKey: `hc_checkout_${claimHash}` },
    ),
  );
  if (!session.id || !session.url)
    throw new PublicError('Stripe n’a pas créé de page de paiement.', 502);
  return session;
}

export async function retrieveCheckoutSession(sessionId: string) {
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId))
    throw new PublicError('Référence de paiement invalide.');
  return stripeOperation('checkout.sessions.retrieve', () =>
    stripe().checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    }),
  );
}

export async function retrieveSubscription(subscriptionId: string) {
  if (!/^sub_[A-Za-z0-9_]+$/.test(subscriptionId))
    throw new PublicError('Référence d’abonnement invalide.');
  return stripeOperation('subscriptions.retrieve', () =>
    stripe().subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    }),
  );
}

export async function retrieveInvoice(invoiceId: string) {
  if (!/^in_[A-Za-z0-9_]+$/.test(invoiceId))
    throw new PublicError('Référence de facture Stripe invalide.');
  return stripeOperation('invoices.retrieve', () =>
    stripe().invoices.retrieve(invoiceId),
  );
}

async function defaultStripePortalConfiguration() {
  const configurations = await stripeOperation(
    'billingPortal.configurations.list',
    () =>
      stripe().billingPortal.configurations.list({
        active: true,
        is_default: true,
        limit: 1,
      }),
  );
  return configurations.data[0];
}

export async function assertConfiguredStripePortalLoginUrl() {
  const expectedLivemode = stripeSecretKeyLivemode(
    stripeConfiguration().secretKey,
  );
  if (expectedLivemode === null)
    throw new PublicError('La clé serveur Stripe est invalide.', 503);
  const portal = await defaultStripePortalConfiguration();
  if (!stripePortalConfigurationIsReady(portal, expectedLivemode)) {
    throw new PublicError(
      'Le portail client Stripe doit permettre la connexion par e-mail, les factures, le moyen de paiement et la résiliation en fin de période.',
      503,
    );
  }
  return portal!.login_page.url!;
}

export async function assertConfiguredStripeAccount() {
  const { priceId, secretKey, siteUrl, webhookEndpointId } =
    stripeConfiguration();
  const expectedLivemode = stripeSecretKeyLivemode(secretKey);
  if (expectedLivemode === null)
    throw new PublicError('La clé serveur Stripe est invalide.', 503);
  if (!/^price_[A-Za-z0-9_]+$/.test(priceId))
    throw new PublicError('Le prix Stripe Zentra n’est pas configuré.', 503);
  if (!/^we_[A-Za-z0-9_]+$/.test(webhookEndpointId))
    throw new PublicError(
      'L’endpoint webhook Stripe n’est pas configuré.',
      503,
    );

  const [price, taxSettings, portalConfigurations, webhook] = await Promise.all(
    [
      stripeOperation('prices.retrieve', () =>
        stripe().prices.retrieve(priceId, { expand: ['product'] }),
      ),
      stripeOperation('tax.settings.retrieve', () =>
        stripe().tax.settings.retrieve(),
      ),
      defaultStripePortalConfiguration(),
      stripeOperation('webhookEndpoints.retrieve', () =>
        stripe().webhookEndpoints.retrieve(webhookEndpointId),
      ),
    ],
  );
  const readinessProblem = stripeAccountReadinessProblem({
    price,
    taxSettings,
    portal: portalConfigurations,
    webhook,
    expectedLivemode,
    unitAmount: LICENSE_PRICE_CHF_CENTS,
    taxBehavior: STRIPE_PRICE_TAX_BEHAVIOR,
    expectedWebhookUrl: `${siteUrl.replace(/\/$/, '')}/api/stripe/webhook`,
    expectedApiVersion: STRIPE_API_VERSION,
    requiredWebhookEvents: REQUIRED_STRIPE_WEBHOOK_EVENTS,
    allowPendingTaxInTestMode:
      expectedLivemode === false &&
      stripeConfiguration().testMode === 'owner_only',
  });
  if (readinessProblem) {
    throw new PublicError(
      readinessProblem === 'tax'
        ? 'Stripe Tax n’est pas entièrement activé.'
        : readinessProblem === 'portal'
          ? 'Le portail client Stripe doit permettre la connexion par e-mail, les factures, le moyen de paiement et la résiliation en fin de période.'
          : readinessProblem === 'webhook'
            ? 'Le webhook Stripe doit être actif, lié à cette adresse Zentra, utiliser la version API attendue et recevoir tous les événements obligatoires.'
            : 'Le produit Stripe Zentra doit être actif, facturé 50 CHF par mois, taxe comprise, avec un code fiscal explicite.',
      503,
    );
  }
  return {
    portalLoginUrl: portalConfigurations!.login_page.url!,
  };
}

export async function createPortalSession(
  customerId: string,
  returnUrl: string,
) {
  if (!/^cus_[A-Za-z0-9_]+$/.test(customerId))
    throw new PublicError('Référence client invalide.');
  const portal = await stripeOperation('billingPortal.sessions.create', () =>
    stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    }),
  );
  if (!portal.url)
    throw new PublicError(
      'Le portail client Stripe n’est pas encore activé.',
      502,
    );
  return portal.url;
}

export function referenceId(value: StripeReference): string {
  return stripeReferenceId(value);
}

export function validatePaidSubscription(
  session: StripeCheckoutSession,
  subscription: StripeSubscription,
) {
  if (session.mode !== 'subscription' || session.status !== 'complete')
    throw new PublicError('Ce paiement n’est pas terminé.', 409);
  if (session.payment_status !== 'paid')
    throw new PublicError('Le premier paiement n’est pas confirmé.', 402);
  if (session.metadata?.plan !== LICENSE_PLAN) {
    throw new PublicError(
      'Cet abonnement ne correspond pas au produit Zentra.',
      403,
    );
  }
  return validateActiveZentraSubscription(subscription);
}

export function validateActiveZentraSubscription(
  subscription: StripeSubscription,
) {
  if (subscription.status !== 'active')
    throw new PublicError('L’abonnement Stripe n’est pas actif.', 402);
  const item = elykoSubscriptionItem(subscription);
  if (!item) {
    throw new PublicError(
      'L’abonnement ne correspond pas au plan Zentra à 50 CHF/mois.',
      403,
    );
  }
  return item;
}

function elykoSubscriptionItem(subscription: StripeSubscription) {
  if (subscription.metadata?.plan !== LICENSE_PLAN) {
    return null;
  }
  const item = subscription.items.data[0];
  const configuration = stripeConfiguration();
  const { priceId } = configuration;
  const expectedLivemode = stripeSecretKeyLivemode(configuration.secretKey);
  if (
    !item ||
    subscription.items.data.length !== 1 ||
    item.price.id !== priceId ||
    item.price.currency.toLowerCase() !== 'chf' ||
    item.price.unit_amount !== LICENSE_PRICE_CHF_CENTS ||
    item.price.recurring?.interval !== 'month' ||
    item.price.recurring.interval_count !== 1 ||
    item.price.recurring.usage_type !== 'licensed' ||
    item.price.tax_behavior !== STRIPE_PRICE_TAX_BEHAVIOR ||
    expectedLivemode === null ||
    subscription.livemode !== expectedLivemode
  ) {
    return null;
  }
  if (
    !subscription.automatic_tax.enabled &&
    stripeAutomaticTaxRequired(configuration)
  ) {
    return null;
  }
  return item.current_period_end ? item : null;
}

export function validatePaidZentraInvoice(
  invoice: Stripe.Invoice,
  subscription: StripeSubscription,
) {
  const item = elykoSubscriptionItem(subscription);
  if (!item) {
    throw new PublicError(
      'La facture ne correspond pas au produit Zentra.',
      403,
    );
  }
  const paidThrough = paidThroughFromInvoice(invoice, {
    subscriptionId: subscription.id,
    priceId: item.price.id,
    unitAmount: LICENSE_PRICE_CHF_CENTS,
    livemode: subscription.livemode,
    automaticTaxRequired: stripeAutomaticTaxRequired(stripeConfiguration()),
  });
  if (!paidThrough) {
    throw new PublicError(
      'La facture Stripe ne couvre pas une période Zentra payée valide.',
      402,
    );
  }
  return paidThrough;
}

export function requestOrigin(request: Request) {
  const configured = stripeConfiguration().siteUrl;
  const candidate = configured || new URL(request.url).origin;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new PublicError('Origine de paiement invalide.', 503);
  }
  const isLocalHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !isLocalHttp) ||
    url.username ||
    url.password
  ) {
    throw new PublicError('Origine de paiement refusée.', 403);
  }
  return url.origin;
}

export function requireSameOrigin(request: Request) {
  const expected = requestOrigin(request);
  const supplied = request.headers.get('Origin');
  if (supplied && supplied !== expected)
    throw new PublicError('Requête intersite refusée.', 403);
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite))
    throw new PublicError('Requête intersite refusée.', 403);
  return expected;
}

export function randomBase64Url(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(value);
}

export function base64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function fromBase64Url(value: string) {
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value: string) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  );
}

export async function assertActivationClaim(
  session: StripeCheckoutSession,
  claim: string,
) {
  const claimHash = await sha256(claim);
  if (
    !session.metadata?.activation_claim_hash ||
    claimHash !== session.metadata.activation_claim_hash
  )
    throw new PublicError(
      'Cette session de paiement ne vous appartient pas.',
      403,
    );
  const attempt = await database()
    .prepare(
      'SELECT checkout_session_id,expires_at FROM checkout_attempts WHERE claim_hash=? LIMIT 1',
    )
    .bind(claimHash)
    .first<{ checkout_session_id: string | null; expires_at: number }>();
  if (
    attempt?.checkout_session_id !== session.id ||
    attempt.expires_at < Math.floor(Date.now() / 1000)
  ) {
    throw new PublicError(
      'Cette demande d’activation a expiré. Contactez le support Zentra.',
      401,
    );
  }
}

export function assertCheckoutAccount(
  session: StripeCheckoutSession,
  account: { userId: string; emailConfirmed: boolean } | null,
) {
  if (!account) {
    throw new PublicError(
      'Connectez-vous au compte Zentra utilisé pour ce paiement.',
      401,
    );
  }
  if (!account.emailConfirmed) {
    throw new PublicError(
      'Confirmez votre adresse e-mail avant d’activer Zentra.',
      403,
    );
  }
  if (
    !session.metadata?.account_user_id ||
    session.metadata.account_user_id !== account.userId
  ) {
    throw new PublicError(
      'Ce paiement appartient à un autre compte Zentra.',
      403,
    );
  }
}

export function activationCookieName(sessionId: string) {
  return `${ACTIVATION_COOKIE}_${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`;
}

export async function enforceCheckoutRateLimit(request: Request) {
  const address =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown';
  const { signingKey } = stripeConfiguration();
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3_600);
  const rateKey = await sha256(
    `checkout:${hour}:${address}:${signingKey.slice(0, 24)}`,
  );
  const db = database();
  await db
    .prepare('DELETE FROM checkout_rate_limits WHERE expires_at<?')
    .bind(now)
    .run();
  await db
    .prepare(`INSERT INTO checkout_rate_limits(rate_key,count,window_started_at,expires_at) VALUES(?,1,?,?)
      ON CONFLICT(rate_key) DO UPDATE SET count=checkout_rate_limits.count+1`)
    .bind(rateKey, hour * 3_600, (hour + 2) * 3_600)
    .run();
  const row = await db
    .prepare('SELECT count FROM checkout_rate_limits WHERE rate_key=?')
    .bind(rateKey)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > 5)
    throw new PublicError(
      'Trop de tentatives de paiement. Réessayez dans une heure.',
      429,
    );
}

export async function enforceLicenseRefreshRateLimit(
  request: Request,
  credential: string,
) {
  const address =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown';
  const { signingKey } = stripeConfiguration();
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3_600);
  const credentialHash = await sha256(credential);
  const secretFragment = signingKey.slice(0, 24);
  const addressKey = await sha256(
    `license-refresh-address:${hour}:${address}:${secretFragment}`,
  );
  const credentialKey = await sha256(
    `license-refresh-credential:${hour}:${address}:${credentialHash}:${secretFragment}`,
  );
  const db = database();
  await db
    .prepare('DELETE FROM checkout_rate_limits WHERE expires_at<?')
    .bind(now)
    .run();
  const increment = async (rateKey: string) => {
    await db
      .prepare(`INSERT INTO checkout_rate_limits(rate_key,count,window_started_at,expires_at) VALUES(?,1,?,?)
        ON CONFLICT(rate_key) DO UPDATE SET count=checkout_rate_limits.count+1`)
      .bind(rateKey, hour * 3_600, (hour + 2) * 3_600)
      .run();
    return db
      .prepare('SELECT count FROM checkout_rate_limits WHERE rate_key=?')
      .bind(rateKey)
      .first<{ count: number }>();
  };
  const [addressRow, credentialRow] = await Promise.all([
    increment(addressKey),
    increment(credentialKey),
  ]);
  if ((addressRow?.count ?? 0) > 30 || (credentialRow?.count ?? 0) > 12) {
    throw new PublicError(
      'Trop de tentatives de renouvellement. Réessayez dans une heure.',
      429,
    );
  }
}

export async function verifyStripeEvent(
  rawBody: string,
  signatureHeader: string,
): Promise<StripeEvent> {
  const { webhookSecret } = stripeConfiguration();
  if (!webhookSecret)
    throw new PublicError('Le webhook Stripe n’est pas configuré.', 503);
  try {
    const expectedLivemode = stripeSecretKeyLivemode(
      stripeConfiguration().secretKey,
    );
    if (expectedLivemode === null)
      throw new Error('Stripe server key mode unavailable');
    return await constructVerifiedStripeEvent({
      client: stripe(),
      rawBody,
      signatureHeader,
      webhookSecret,
      toleranceSeconds: 300,
      expectedLivemode,
      expectedApiVersion: STRIPE_API_VERSION,
    });
  } catch {
    throw new PublicError('Signature Stripe invalide ou expirée.', 400);
  }
}

export async function recordVerifiedStripeWebhook(event: StripeEvent) {
  const { secretKey, webhookSecret, webhookEndpointId } = stripeConfiguration();
  const expectedLivemode = stripeSecretKeyLivemode(secretKey);
  if (
    expectedLivemode === null ||
    event.livemode !== expectedLivemode ||
    event.api_version !== STRIPE_API_VERSION ||
    !/^evt_[A-Za-z0-9_]+$/.test(event.id) ||
    !/^we_[A-Za-z0-9_]+$/.test(webhookEndpointId) ||
    !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)
  ) {
    throw new PublicError('La preuve du webhook Stripe est invalide.', 503);
  }
  await database()
    .prepare(UPSERT_STRIPE_WEBHOOK_PROOF_SQL)
    .bind(
      webhookEndpointId,
      await sha256(webhookSecret),
      expectedLivemode ? 1 : 0,
      STRIPE_API_VERSION,
      event.id,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

export async function upsertSubscription(
  subscription: StripeSubscription,
  session: StripeCheckoutSession | null = null,
  settlement: {
    paidInvoiceId?: string;
    paidThrough?: number;
    paidAt?: number;
    failedInvoiceId?: string;
    failedAt?: number;
  } = {},
) {
  const item = elykoSubscriptionItem(subscription);
  if (!item)
    throw new PublicError(
      'Cet abonnement ne correspond pas au produit Zentra.',
      403,
    );
  await database()
    .prepare(UPSERT_SUBSCRIPTION_SQL)
    .bind(
      subscription.id,
      referenceId(subscription.customer),
      session?.id ?? null,
      session?.customer_details?.email ?? null,
      session?.customer_details?.business_name ??
        session?.customer_details?.name ??
        null,
      item.price.id,
      subscription.status,
      item.current_period_end,
      subscription.cancel_at_period_end ? 1 : 0,
      subscription.livemode ? 1 : 0,
      settlement.paidThrough ?? 0,
      settlement.paidInvoiceId ?? null,
      settlement.paidAt ?? null,
      settlement.failedInvoiceId ?? null,
      settlement.failedAt ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

export async function paidEntitlementForSubscription(subscriptionId: string) {
  if (!/^sub_[A-Za-z0-9_]+$/.test(subscriptionId))
    throw new PublicError('Référence d’abonnement invalide.');
  const entitlement = await database()
    .prepare(
      `SELECT customer_name,entitlement_valid_until,last_paid_invoice_id
       FROM subscriptions WHERE subscription_id=? LIMIT 1`,
    )
    .bind(subscriptionId)
    .first<{
      customer_name: string | null;
      entitlement_valid_until: number;
      last_paid_invoice_id: string | null;
    }>();
  if (
    !entitlement?.last_paid_invoice_id ||
    !Number.isSafeInteger(entitlement.entitlement_valid_until) ||
    entitlement.entitlement_valid_until <= 0
  ) {
    throw new PublicError(
      'Aucune facture Stripe payée ne permet d’activer cette licence.',
      402,
    );
  }
  return entitlement;
}

export async function persistStripeEvent(event: StripeEvent) {
  const db = database();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(INSERT_STRIPE_EVENT_SQL)
    .bind(event.id, event.type, event.livemode ? 1 : 0, event.created, now)
    .run();
  const claimed = await db
    .prepare(CLAIM_STRIPE_EVENT_SQL)
    .bind(now, event.id, now - 5 * 60)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) {
    const state = await db
      .prepare('SELECT processed_at FROM stripe_events WHERE event_id=?')
      .bind(event.id)
      .first<{ processed_at: number | null }>();
    if (state?.processed_at) return;
    throw new PublicError(
      'Un traitement Stripe identique est déjà en cours.',
      503,
    );
  }
  try {
    const subscriptionId = subscriptionIdFromStripeEvent(event);
    if (subscriptionId) {
      const subscription = await retrieveSubscription(subscriptionId);
      const item = elykoSubscriptionItem(subscription);
      if (!item) {
        await db.prepare(COMPLETE_STRIPE_EVENT_SQL).bind(now, event.id).run();
        return;
      }
      const session =
        event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded'
          ? (event.data.object as unknown as StripeCheckoutSession)
          : null;
      const invoice = event.type.startsWith('invoice.')
        ? (event.data.object as Stripe.Invoice)
        : null;
      const paidThrough =
        event.type === 'invoice.paid' && invoice
          ? validatePaidZentraInvoice(invoice, subscription)
          : undefined;
      const paidInvoiceId = paidThrough ? invoice?.id : undefined;
      const isFailure = [
        'invoice.payment_failed',
        'invoice.payment_action_required',
        'invoice.finalization_failed',
        'invoice.marked_uncollectible',
        'invoice.voided',
      ].includes(event.type);
      await upsertSubscription(subscription, session, {
        paidInvoiceId,
        paidThrough,
        paidAt: paidInvoiceId
          ? (invoice?.status_transitions?.paid_at ?? now)
          : undefined,
        failedInvoiceId: isFailure ? invoice?.id : undefined,
        failedAt: isFailure ? event.created : undefined,
      });
    }
    await db.prepare(COMPLETE_STRIPE_EVENT_SQL).bind(now, event.id).run();
  } catch (error) {
    await db.prepare(RELEASE_STRIPE_EVENT_SQL).bind(event.id).run();
    throw error;
  }
}
