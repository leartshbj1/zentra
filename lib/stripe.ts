import { database, stripeConfiguration } from '@/lib/runtime';

export const LICENSE_PLAN = 'helvichantier-monthly-50-chf';
export const LICENSE_PRICE_CHF_CENTS = 5_000;
export const ACTIVATION_COOKIE = 'hc_activation_claim';
export const STRIPE_API_VERSION = '2025-03-31.basil';

type StripeReference = string | { id: string } | null;

export type StripeCheckoutSession = {
  id: string;
  mode: string;
  status: string | null;
  payment_status: string;
  customer: StripeReference;
  subscription: StripeReference;
  customer_details?: {
    email?: string | null;
    name?: string | null;
    business_name?: string | null;
  } | null;
  metadata?: Record<string, string> | null;
  url?: string | null;
};

export type StripeSubscription = {
  id: string;
  customer: StripeReference;
  status: string;
  cancel_at_period_end: boolean;
  livemode: boolean;
  metadata?: Record<string, string> | null;
  items: {
    data: Array<{
      current_period_end?: number;
      price: {
        id: string;
        currency: string;
        unit_amount: number | null;
        recurring?: { interval?: string } | null;
      };
    }>;
  };
};

type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

export class PublicError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function jsonError(reason: unknown) {
  const status = reason instanceof PublicError ? reason.status : 500;
  const message =
    reason instanceof PublicError
      ? reason.message
      : 'Le service de paiement est momentanément indisponible.';
  return Response.json({ error: message }, { status, headers: noStoreHeaders() });
}

export function noStoreHeaders(): HeadersInit {
  return { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };
}

function formBody(entries: Array<[string, string]>) {
  const body = new URLSearchParams();
  for (const [key, value] of entries) body.append(key, value);
  return body;
}

async function stripeRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { secretKey } = stripeConfiguration();
  if (!secretKey) throw new PublicError('Le compte marchand Stripe n’est pas encore configuré.', 503);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${secretKey}`);
  headers.set('Stripe-Version', STRIPE_API_VERSION);
  if (init.body) headers.set('Content-Type', 'application/x-www-form-urlencoded');
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: init.method,
    body: init.body,
    cache: init.cache,
    redirect: init.redirect,
    headers,
  });
  const payload = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    console.error('Stripe API request failed', { path, status: response.status });
    throw new PublicError(
      response.status >= 500
        ? 'Stripe est momentanément indisponible. Réessayez dans quelques instants.'
        : 'La configuration Stripe doit être vérifiée par le marchand.',
      502,
    );
  }
  return payload;
}

export async function createCheckoutSession(origin: string, claimHash: string) {
  const session = await stripeRequest<StripeCheckoutSession>('/checkout/sessions', {
    method: 'POST',
    headers: { 'Idempotency-Key': `hc_checkout_${claimHash}` },
    body: formBody([
      ['mode', 'subscription'],
      ['locale', 'fr'],
      ['billing_address_collection', 'required'],
      ['tax_id_collection[enabled]', 'true'],
      ['allow_promotion_codes', 'false'],
      ['line_items[0][quantity]', '1'],
      ['line_items[0][price_data][currency]', 'chf'],
      ['line_items[0][price_data][unit_amount]', String(LICENSE_PRICE_CHF_CENTS)],
      ['line_items[0][price_data][recurring][interval]', 'month'],
      ['line_items[0][price_data][product_data][name]', 'HelviChantier'],
      ['line_items[0][price_data][product_data][description]', 'Licence Windows multisectorielle · données métier locales'],
      ['metadata[plan]', LICENSE_PLAN],
      ['metadata[activation_claim_hash]', claimHash],
      ['subscription_data[metadata][plan]', LICENSE_PLAN],
      ['success_url', `${origin}/paiement/succes?session_id={CHECKOUT_SESSION_ID}`],
      ['cancel_url', `${origin}/?paiement=annule#tarif`],
    ]),
  });
  if (!session.id || !session.url) throw new PublicError('Stripe n’a pas créé de page de paiement.', 502);
  return session;
}

export async function retrieveCheckoutSession(sessionId: string) {
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) throw new PublicError('Référence de paiement invalide.');
  return stripeRequest<StripeCheckoutSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`);
}

export async function retrieveSubscription(subscriptionId: string) {
  if (!/^sub_[A-Za-z0-9_]+$/.test(subscriptionId)) throw new PublicError('Référence d’abonnement invalide.');
  return stripeRequest<StripeSubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=items.data.price`);
}

export async function createPortalSession(customerId: string, returnUrl: string) {
  if (!/^cus_[A-Za-z0-9_]+$/.test(customerId)) throw new PublicError('Référence client invalide.');
  const portal = await stripeRequest<{ url?: string }>('/billing_portal/sessions', {
    method: 'POST',
    body: formBody([
      ['customer', customerId],
      ['return_url', returnUrl],
    ]),
  });
  if (!portal.url) throw new PublicError('Le portail client Stripe n’est pas encore activé.', 502);
  return portal.url;
}

export function referenceId(value: StripeReference): string {
  return typeof value === 'string' ? value : value?.id ?? '';
}

export function validatePaidSubscription(session: StripeCheckoutSession, subscription: StripeSubscription) {
  if (session.mode !== 'subscription' || session.status !== 'complete') throw new PublicError('Ce paiement n’est pas terminé.', 409);
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') throw new PublicError('Le premier paiement n’est pas confirmé.', 402);
  if (!['active', 'trialing'].includes(subscription.status)) throw new PublicError('L’abonnement Stripe n’est pas actif.', 402);
  if (session.metadata?.plan !== LICENSE_PLAN || subscription.metadata?.plan !== LICENSE_PLAN) {
    throw new PublicError('Cet abonnement ne correspond pas au produit HelviChantier.', 403);
  }
  const item = subscription.items.data[0];
  if (
    !item ||
    item.price.currency.toLowerCase() !== 'chf' ||
    item.price.unit_amount !== LICENSE_PRICE_CHF_CENTS ||
    item.price.recurring?.interval !== 'month'
  ) {
    throw new PublicError('L’abonnement ne correspond pas au plan HelviChantier à 50 CHF/mois.', 403);
  }
  if (!item.current_period_end) throw new PublicError('La période de licence Stripe est absente.', 502);
  return item;
}

export function requestOrigin(request: Request) {
  const configured = stripeConfiguration().siteUrl;
  if (configured) return new URL(configured).origin;
  const origin = new URL(request.url).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    throw new PublicError('Origine de paiement refusée.', 403);
  }
  return origin;
}

export function requireSameOrigin(request: Request) {
  const expected = requestOrigin(request);
  const supplied = request.headers.get('Origin');
  if (supplied && supplied !== expected) throw new PublicError('Requête intersite refusée.', 403);
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw new PublicError('Requête intersite refusée.', 403);
  return expected;
}

export function randomBase64Url(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(value);
}

export function base64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64Url(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export function activationCookieName(sessionId: string) {
  return `${ACTIVATION_COOKIE}_${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`;
}

export async function enforceCheckoutRateLimit(request: Request) {
  const address = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  const { signingKey } = stripeConfiguration();
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3_600);
  const rateKey = await sha256(`checkout:${hour}:${address}:${signingKey.slice(0, 24)}`);
  const db = database();
  await db
    .prepare(`INSERT INTO checkout_rate_limits(rate_key,count,window_started_at,expires_at) VALUES(?,1,?,?)
      ON CONFLICT(rate_key) DO UPDATE SET count=checkout_rate_limits.count+1`)
    .bind(rateKey, hour * 3_600, (hour + 2) * 3_600)
    .run();
  const row = await db.prepare('SELECT count FROM checkout_rate_limits WHERE rate_key=?').bind(rateKey).first<{ count: number }>();
  if ((row?.count ?? 0) > 5) throw new PublicError('Trop de tentatives de paiement. Réessayez dans une heure.', 429);
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function verifyStripeEvent(rawBody: string, signatureHeader: string): Promise<StripeEvent> {
  const { webhookSecret } = stripeConfiguration();
  if (!webhookSecret) throw new PublicError('Le webhook Stripe n’est pas configuré.', 503);
  const parts = signatureHeader.split(',').map((part) => part.trim().split('=', 2));
  const timestampText = parts.find(([key]) => key === 't')?.[1] ?? '';
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) {
    throw new PublicError('Signature Stripe expirée.', 400);
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestampText}.${rawBody}`)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!signatures.some((signature) => constantTimeEqual(signature, expected))) throw new PublicError('Signature Stripe invalide.', 400);
  const event = JSON.parse(rawBody) as StripeEvent;
  if (!event.id || !event.type || !event.data?.object) throw new PublicError('Événement Stripe invalide.', 400);
  return event;
}

function subscriptionIdFromEvent(event: StripeEvent) {
  if (event.type.startsWith('customer.subscription.')) {
    return typeof event.data.object.id === 'string' ? event.data.object.id : '';
  }
  if (event.type.startsWith('invoice.')) return referenceId(event.data.object.subscription as StripeReference);
  if (event.type === 'checkout.session.completed') return referenceId(event.data.object.subscription as StripeReference);
  return '';
}

export async function upsertSubscription(subscription: StripeSubscription, session: StripeCheckoutSession | null = null) {
  const item = subscription.items.data[0];
  if (!item?.current_period_end) throw new PublicError('La période Stripe de l’abonnement est absente.', 502);
  await database()
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,checkout_session_id,customer_email,customer_name,price_id,status,current_period_end,cancel_at_period_end,livemode,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(subscription_id) DO UPDATE SET customer_id=excluded.customer_id,checkout_session_id=COALESCE(excluded.checkout_session_id,subscriptions.checkout_session_id),customer_email=COALESCE(excluded.customer_email,subscriptions.customer_email),customer_name=COALESCE(excluded.customer_name,subscriptions.customer_name),price_id=excluded.price_id,status=excluded.status,current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,updated_at=excluded.updated_at`)
    .bind(
      subscription.id,
      referenceId(subscription.customer),
      session?.id ?? null,
      session?.customer_details?.email ?? null,
      session?.customer_details?.business_name ?? session?.customer_details?.name ?? null,
      item.price.id,
      subscription.status,
      item.current_period_end,
      subscription.cancel_at_period_end ? 1 : 0,
      subscription.livemode ? 1 : 0,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

export async function persistStripeEvent(event: StripeEvent) {
  const db = database();
  const now = Math.floor(Date.now() / 1000);
  const inserted = await db
    .prepare('INSERT OR IGNORE INTO stripe_events(event_id,event_type,livemode,received_at,processed_at) VALUES(?,?,?,?,NULL)')
    .bind(event.id, event.type, event.livemode ? 1 : 0, now)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return;
  try {
    const subscriptionId = subscriptionIdFromEvent(event);
    if (subscriptionId) {
      const subscription = await retrieveSubscription(subscriptionId);
      const session = event.type === 'checkout.session.completed' ? (event.data.object as unknown as StripeCheckoutSession) : null;
      await upsertSubscription(subscription, session);
    }
    await db.prepare('UPDATE stripe_events SET processed_at=? WHERE event_id=?').bind(now, event.id).run();
  } catch (error) {
    await db.prepare('DELETE FROM stripe_events WHERE event_id=? AND processed_at IS NULL').bind(event.id).run();
    throw error;
  }
}
