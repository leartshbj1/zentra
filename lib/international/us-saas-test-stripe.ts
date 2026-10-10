import Stripe from 'stripe';
import { snapshotPrivateJson } from './private-json';
import { assertStripeTaxSdkMetadata, extractStripeTaxSdkBody } from './stripe-tax-sdk-body';
import { verifyServerStripePrice, type ServerStripePrice } from './subscriptions';
import {
  UsTestBillingError, usTestProviderIdempotencyKey,
  usTestStripeApiVersion, validateUsTestPurchase, validatedUsTestCheckoutUrl,
  verifiedUsTestPaidProof, verifiedUsTestSession,
  type UsTestGateway, type UsTestPurchase, type UsTestSession,
} from './us-saas-test-contract';

type Body = Record<string, unknown>;
const options = Object.freeze({ apiVersion: usTestStripeApiVersion, maxNetworkRetries: 0, timeout: 20_000 });
const mismatch = (): never => { throw new UsTestBillingError('provider_mismatch', 422); };
const unsupported = (): never => { throw new UsTestBillingError('unsupported_payment', 422); };
function requireFact(condition: unknown): asserts condition { if (!condition) mismatch(); }
function object(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return mismatch();
  return value as Body;
}
function id(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || value.length > 160 || !new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value)) return mismatch();
  return value;
}
function reference(value: unknown, prefix: string): string { return id(typeof value === 'string' ? value : object(value).id, prefix); }
function seconds(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return mismatch(); return value as number; }
function empty(value: unknown): boolean { return value === null || Array.isArray(value) && value.length === 0; }
function body(value: unknown, accountId?: string, idempotencyKey = 'us-test-read'): Body {
  const extracted = extractStripeTaxSdkBody(sdkJson(value));
  if (accountId) assertStripeTaxSdkMetadata(extracted.metadata, { accountId, apiVersion: usTestStripeApiVersion, idempotencyKey });
  else if (extracted.metadata.apiVersion !== undefined && extracted.metadata.apiVersion !== usTestStripeApiVersion) return mismatch();
  return object(extracted.body);
}
const decimalPrototype = Object.getPrototypeOf(Stripe.Decimal.zero) as object;
const decimalString = Object.getOwnPropertyDescriptor(decimalPrototype, 'toString')!.value as (this: Stripe.Decimal) => string;
const decimalCoefficientLimit = BigInt('100000000000000000000000000000000');
/** SDK22.6 hydrates these documented decimal-string fields. Normalize its
 * exact frozen Decimal representation without invoking a response-owned method
 * or accessor; every other foreign value still fails the JSON boundary. */
function sdkJson(input: unknown): unknown {
  let nodes = 0;
  function copy(value: unknown, path: readonly string[]): unknown {
    if (++nodes > 50_000 || path.length > 20) return mismatch();
    if (value === null || typeof value !== 'object') return value;
    if (Object.getPrototypeOf(value) === decimalPrototype) {
      requireFact(path.length > 0 && ['unit_amount_decimal', 'quantity_decimal', 'amount_decimal', 'flat_amount_decimal'].includes(path[path.length - 1]));
      const keys = Reflect.ownKeys(value), coefficient = Object.getOwnPropertyDescriptor(value, '_coefficient'), exponent = Object.getOwnPropertyDescriptor(value, '_exponent');
      requireFact(Object.isFrozen(value) && keys.length === 2 && keys.includes('_coefficient') && keys.includes('_exponent')
        && coefficient && 'value' in coefficient && coefficient.enumerable && typeof coefficient.value === 'bigint' && coefficient.value >= BigInt(0) && coefficient.value < decimalCoefficientLimit
        && exponent && 'value' in exponent && exponent.enumerable && Number.isSafeInteger(exponent.value) && exponent.value >= -12 && exponent.value <= 16);
      return decimalString.call(value as Stripe.Decimal);
    }
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      requireFact(Object.getPrototypeOf(value) === Array.prototype && value.length <= 1000 && keys.length === value.length + 1);
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        requireFact(descriptor && 'value' in descriptor && descriptor.enumerable);
        return copy(descriptor.value, [...path, String(index)]);
      });
    }
    requireFact([Object.prototype, null].includes(Object.getPrototypeOf(value)) && keys.length <= 50_001);
    const result: Body = Object.create(null);
    for (const key of keys) {
      requireFact(typeof key === 'string' && key.length <= 524_288);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireFact(descriptor && 'value' in descriptor);
      if (path.length === 0 && key === 'lastResponse') {
        requireFact(!descriptor.enumerable && !descriptor.writable && !descriptor.configurable);
        Object.defineProperty(result, key, descriptor);
      } else {
        requireFact(descriptor.enumerable);
        result[key] = copy(descriptor.value, [...path, key]);
      }
    }
    return result;
  }
  return copy(input, []);
}
function page(value: unknown, url: string, accountId?: string): Body[] {
  const result = body(value, accountId);
  requireFact(result.object === 'list' && result.url === url && result.has_more === false && Array.isArray(result.data) && result.data.length <= 100);
  return result.data.map(object);
}
function metadata(purchase: UsTestPurchase): Record<string, string> {
  return {
    zentra_us_purchase_id: purchase.purchaseId, creation_id: purchase.creationId,
    organization_id: purchase.organizationId, actor_user_id: purchase.actorUserId,
    request_id: purchase.requestId, configuration_fingerprint: purchase.configurationFingerprint,
    catalog_version: purchase.offer.catalogVersion, provider_account_id: purchase.providerAccountId,
  };
}
function matchingMetadata(value: unknown, purchase: UsTestPurchase): void {
  const actual = object(value), expected = metadata(purchase);
  requireFact(Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value));
}
function checkoutParameters(purchase: UsTestPurchase): Stripe.Checkout.SessionCreateParams {
  const path = `${purchase.siteOrigin}/compte/espaces/us/nouveau?requestId=${purchase.requestId}`;
  return {
    mode: 'subscription', ui_mode: 'hosted', integration_identifier: purchase.integrationIdentifier,
    billing_address_collection: 'required',
    automatic_tax: { enabled: false }, tax_id_collection: { enabled: false },
    allow_promotion_codes: false, discounts: [],
    line_items: [{ price: purchase.offer.priceId, quantity: 1 }],
    client_reference_id: purchase.purchaseId, metadata: metadata(purchase),
    subscription_data: {
      billing_mode: { type: 'flexible' }, metadata: metadata(purchase),
      description: 'Zentra US TEST initial activation', default_tax_rates: [],
      invoice_settings: { issuer: { type: 'self' } },
    },
    expires_at: purchase.expiresAt,
    success_url: `${path}&checkout=returned`, cancel_url: `${path}&checkout=canceled`,
  };
}
function sessionFacts(purchase: UsTestPurchase, result: Body): UsTestSession {
  requireFact(result.object === 'checkout.session' && result.livemode === false && result.mode === 'subscription'
    && result.client_reference_id === purchase.purchaseId && result.integration_identifier === purchase.integrationIdentifier
    && result.expires_at === purchase.expiresAt && result.allow_promotion_codes === false
    && object(result.automatic_tax).enabled === false && Array.isArray(result.payment_method_types)
    && result.payment_method_types.length >= 1 && result.payment_method_types.length <= 100
    && result.payment_method_types.every(method => typeof method === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(method))
    && ['open', 'complete', 'expired'].includes(String(result.status)));
  matchingMetadata(result.metadata, purchase);
  return verifiedUsTestSession(purchase, {
    purchaseId: purchase.purchaseId, sessionId: id(result.id, 'cs_test'),
    customerId: result.customer === null ? null : reference(result.customer, 'cus'),
    subscriptionId: result.subscription === null ? null : reference(result.subscription, 'sub'),
    createdAt: seconds(result.created), expiresAt: seconds(result.expires_at),
  });
}
function serverPrice(purchase: UsTestPurchase, value: Body): ServerStripePrice {
  const product = object(value.product), recurring = object(value.recurring);
  requireFact(value.object === 'price' && product.object === 'product' && product.livemode === false
    && (value.unit_amount_decimal === undefined || value.unit_amount_decimal === null || value.unit_amount_decimal === purchase.offer.unitAmountMinor));
  const projected: ServerStripePrice = {
    id: id(value.id, 'price'), active: value.active as boolean, livemode: value.livemode as boolean,
    currency: value.currency as string, unit_amount: value.unit_amount as number | null,
    type: value.type as 'recurring' | 'one_time', tax_behavior: value.tax_behavior as ServerStripePrice['tax_behavior'],
    recurring: { interval: recurring.interval as string, interval_count: recurring.interval_count as number, usage_type: recurring.usage_type as string },
    product: { id: id(product.id, 'prod'), active: product.active as boolean, ...(product.deleted === undefined ? {} : { deleted: product.deleted as boolean }) },
  };
  try { verifyServerStripePrice(purchase.offer, projected); } catch { return mismatch(); }
  return projected;
}
/** Dedicated Stripe22.6 TEST transport. No key lookup, shared CHF client,
 * Connect header, licence, runtime flag or browser authority is selected here.
 * The caller admits configuration/Auth around awaits and verifies signatures
 * before locate; a locator never proves ownership or a payment. */
export function stripeUsTestGateway(client: Stripe, now: () => number): UsTestGateway {
  function clock(): number { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new UsTestBillingError('provider_unavailable', 503); return value; }
  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof UsTestBillingError) throw error; throw new UsTestBillingError('provider_unavailable', 503); }
  }
  async function account(accountId: string): Promise<void> {
    const actual = body(await client.accounts.retrieveCurrent({}, options), accountId);
    requireFact(actual.object === 'account' && actual.id === accountId);
    // Account objects have no livemode field. The authenticated balance and
    // every financial object independently establish the TEST namespace.
    const balance = body(await client.balance.retrieve({}, options), accountId);
    requireFact(balance.object === 'balance' && balance.livemode === false);
  }
  async function price(purchase: UsTestPurchase): Promise<ServerStripePrice> {
    return serverPrice(purchase, body(await client.prices.retrieve(purchase.offer.priceId, { expand: ['product'] }, options), purchase.providerAccountId));
  }
  async function lines(purchase: UsTestPurchase, sessionId: string): Promise<void> {
    const rows = page(await client.checkout.sessions.listLineItems(sessionId, { limit: 2 }, options), `/v1/checkout/sessions/${sessionId}/line_items`, purchase.providerAccountId);
    requireFact(rows.length === 1 && rows[0].object === 'item' && rows[0].quantity === 1 && rows[0].currency === 'usd'
      && reference(rows[0].price, 'price') === purchase.offer.priceId
      && rows[0].amount_subtotal === Number(purchase.offer.unitAmountMinor) && rows[0].amount_total === Number(purchase.offer.unitAmountMinor)
      && rows[0].amount_discount === 0 && rows[0].amount_tax === 0);
  }
  return {
    create(input) {
      return guarded(async () => {
        const purchase = validateUsTestPurchase(input), time = clock();
        requireFact(time >= purchase.createdAt);
        await account(purchase.providerAccountId); await price(purchase);
        let result: Body;
        if (clock() <= purchase.expiresAt - 1800) {
          result = body(await client.checkout.sessions.create(checkoutParameters(purchase), { ...options, idempotencyKey: usTestProviderIdempotencyKey(purchase) }), purchase.providerAccountId, usTestProviderIdempotencyKey(purchase));
        } else {
          // Once Stripe's fixed expiry is too close, only read. Never rebuild
          // parameters or generate another idempotency key after uncertainty.
          const rows = page(await client.checkout.sessions.list({ created: { gte: purchase.createdAt, lte: purchase.expiresAt }, limit: 100 }, options), '/v1/checkout/sessions', purchase.providerAccountId);
          const matches = rows.filter(row => row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata) && object(row.metadata).zentra_us_purchase_id === purchase.purchaseId);
          if (matches.length !== 1) throw new UsTestBillingError('checkout_recovery_required', 409);
          result = body(await client.checkout.sessions.retrieve(id(matches[0].id, 'cs_test'), {}, options), purchase.providerAccountId);
        }
        const session = sessionFacts(purchase, result);
        await lines(purchase, session.sessionId); await account(purchase.providerAccountId);
        if (result.status === 'expired') throw new UsTestBillingError('checkout_expired', 409);
        requireFact(result.url === null || typeof result.url === 'string');
        const url = validatedUsTestCheckoutUrl(result.url);
        requireFact(result.status !== 'open' || url !== null);
        if (url !== null) requireFact([`/c/pay/${session.sessionId}`, `/pay/${session.sessionId}`].includes(new URL(url).pathname));
        return { session, url };
      });
    },
    locate(input) {
      return guarded(async () => {
        const event = object(snapshotPrivateJson(input));
        requireFact(event.object === 'event' && event.livemode === false && event.api_version === usTestStripeApiVersion && (event.account === undefined || event.account === null));
        const eventId = id(event.id, 'evt');
        if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'invoice.paid'].includes(String(event.type))) return null;
        const source = object(object(event.data).object);
        if (event.type !== 'invoice.paid') {
          requireFact(source.object === 'checkout.session');
          const session = body(await client.checkout.sessions.retrieve(id(source.id, 'cs_test'), {}, options));
          requireFact(session.id === source.id && session.object === 'checkout.session' && session.livemode === false && session.mode === 'subscription');
          return { sessionId: id(session.id, 'cs_test'), eventId };
        }
        requireFact(source.object === 'invoice');
        const invoice = body(await client.invoices.retrieve(id(source.id, 'in'), {}, options));
        requireFact(invoice.id === source.id && invoice.object === 'invoice' && invoice.livemode === false);
        if (invoice.billing_reason !== 'subscription_create') return unsupported();
        const parent = object(invoice.parent); requireFact(parent.type === 'subscription_details');
        const subscriptionId = reference(object(parent.subscription_details).subscription, 'sub');
        const subscription = body(await client.subscriptions.retrieve(subscriptionId, {}, options));
        requireFact(subscription.id === subscriptionId && subscription.object === 'subscription' && subscription.livemode === false);
        const sessions = page(await client.checkout.sessions.list({ subscription: subscriptionId, limit: 2 }, options), '/v1/checkout/sessions');
        requireFact(sessions.length === 1 && sessions[0].object === 'checkout.session' && sessions[0].livemode === false
          && sessions[0].mode === 'subscription' && reference(sessions[0].subscription, 'sub') === subscriptionId
          && reference(sessions[0].invoice, 'in') === invoice.id && reference(sessions[0].customer, 'cus') === reference(invoice.customer, 'cus'));
        return { sessionId: id(sessions[0].id, 'cs_test'), eventId };
      });
    },
    verify(input, inputSession, eventId) {
      return guarded(async () => {
        const purchase = validateUsTestPurchase(input), captured = object(snapshotPrivateJson(inputSession));
        requireFact(Object.keys(captured).length === 6 && ['purchaseId', 'sessionId', 'customerId', 'subscriptionId', 'createdAt', 'expiresAt'].every(key => Object.hasOwn(captured, key))
          && captured.purchaseId === purchase.purchaseId && /^(evt_[A-Za-z0-9_]+|recovery)$/.test(eventId));
        verifiedUsTestSession(purchase, captured as unknown as UsTestSession);
        await account(purchase.providerAccountId); const verifiedPrice = await price(purchase);
        const actual = body(await client.checkout.sessions.retrieve(id(captured.sessionId, 'cs_test'), {}, options), purchase.providerAccountId);
        const session = sessionFacts(purchase, actual);
        requireFact(session.sessionId === captured.sessionId && session.createdAt === captured.createdAt && session.expiresAt === captured.expiresAt
          && (captured.customerId === null || captured.customerId === session.customerId)
          && (captured.subscriptionId === null || captured.subscriptionId === session.subscriptionId));
        if (actual.status !== 'complete' || actual.payment_status !== 'paid') throw new UsTestBillingError('payment_unconfirmed', 409);
        const amount = Number(purchase.offer.unitAmountMinor), details = object(actual.total_details);
        requireFact(actual.currency === 'usd' && actual.amount_subtotal === amount && actual.amount_total === amount
          && details.amount_discount === 0 && details.amount_tax === 0 && details.amount_shipping === 0);
        await lines(purchase, session.sessionId);
        const customerId = id(session.customerId, 'cus'), subscriptionId = id(session.subscriptionId, 'sub'), invoiceId = reference(actual.invoice, 'in');
        const subscription = body(await client.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] }, options), purchase.providerAccountId);
        requireFact(subscription.id === subscriptionId && subscription.object === 'subscription' && subscription.livemode === false && subscription.status === 'active'
          && reference(subscription.customer, 'cus') === customerId && reference(subscription.latest_invoice, 'in') === invoiceId
          && subscription.collection_method === 'charge_automatically' && object(subscription.automatic_tax).enabled === false
          && empty(subscription.discounts) && (subscription.default_tax_rates === undefined || empty(subscription.default_tax_rates)) && subscription.trial_start === null && subscription.trial_end === null
          && subscription.schedule === null && subscription.pending_update === null && subscription.pause_collection === null && subscription.application === null
          && subscription.on_behalf_of === null && subscription.transfer_data === null);
        matchingMetadata(subscription.metadata, purchase);
        const items = object(subscription.items); requireFact(items.object === 'list' && items.has_more === false && Array.isArray(items.data) && items.data.length === 1);
        const item = object(items.data[0]); requireFact(item.object === 'subscription_item' && item.quantity === 1
          && reference(item.price, 'price') === purchase.offer.priceId && empty(item.discounts) && empty(item.tax_rates));
        const invoice = body(await client.invoices.retrieve(invoiceId, {}, options), purchase.providerAccountId);
        if (invoice.billing_reason !== 'subscription_create') return unsupported();
        requireFact(invoice.id === invoiceId && invoice.object === 'invoice' && invoice.livemode === false && invoice.status === 'paid'
          && invoice.currency === 'usd' && reference(invoice.customer, 'cus') === customerId && invoice.collection_method === 'charge_automatically'
          && invoice.amount_due === amount && invoice.amount_paid === amount && invoice.amount_paid_off_stripe === 0 && invoice.amount_remaining === 0 && invoice.amount_overpaid === 0
          && invoice.subtotal === amount && invoice.total === amount && invoice.starting_balance === 0 && invoice.ending_balance === 0
          && invoice.pre_payment_credit_notes_amount === 0 && invoice.post_payment_credit_notes_amount === 0
          && empty(invoice.discounts) && empty(invoice.total_discount_amounts) && empty(invoice.total_taxes)
          && empty(invoice.default_tax_rates) && object(invoice.automatic_tax).enabled === false
          && invoice.application === null && invoice.on_behalf_of === null && (invoice.transfer_data === undefined || invoice.transfer_data === null)
          && object(invoice.issuer).type === 'self');
        const parent = object(invoice.parent); requireFact(parent.type === 'subscription_details' && reference(object(parent.subscription_details).subscription, 'sub') === subscriptionId);
        const invoiceLines = object(invoice.lines); requireFact(invoiceLines.object === 'list' && invoiceLines.has_more === false && Array.isArray(invoiceLines.data) && invoiceLines.data.length === 1);
        const line = object(invoiceLines.data[0]), lineParent = object(line.parent), pricing = object(line.pricing);
        requireFact(line.object === 'line_item' && line.livemode === false && line.invoice === invoiceId && line.amount === amount
          && empty(line.discounts) && empty(line.discount_amounts) && empty(line.taxes) && empty(line.pretax_credit_amounts)
          && lineParent.type === 'subscription_item_details' && object(lineParent.subscription_item_details).proration === false
          && object(lineParent.subscription_item_details).subscription === subscriptionId && object(lineParent.subscription_item_details).subscription_item === item.id
          && pricing.type === 'price_details' && reference(object(pricing.price_details).price, 'price') === purchase.offer.priceId
          && pricing.unit_amount_decimal === purchase.offer.unitAmountMinor && line.quantity === 1
          && (line.quantity_decimal === undefined || line.quantity_decimal === null || line.quantity_decimal === '1')
          && line.currency === 'usd' && line.subtotal === amount);
        const period = object(line.period), startsAt = seconds(period.start), endsAt = seconds(period.end);
        requireFact(startsAt >= purchase.createdAt && startsAt < purchase.expiresAt && endsAt > startsAt
          && item.current_period_start === startsAt && item.current_period_end === endsAt);
        const payments = page(await client.invoicePayments.list({ invoice: invoiceId, limit: 2 }, options), '/v1/invoice_payments', purchase.providerAccountId);
        requireFact(payments.length === 1);
        const payment = payments[0], paymentDetails = object(payment.payment);
        if (paymentDetails.type !== 'payment_intent') return unsupported();
        requireFact(payment.object === 'invoice_payment' && payment.status === 'paid' && payment.livemode === false && payment.currency === 'usd'
          && reference(payment.invoice, 'in') === invoiceId && payment.amount_paid === amount && payment.amount_requested === amount && payment.is_default === true);
        const paymentIntentId = reference(paymentDetails.payment_intent, 'pi');
        const paymentIntent = body(await client.paymentIntents.retrieve(paymentIntentId, {}, options), purchase.providerAccountId);
        requireFact(paymentIntent.id === paymentIntentId && paymentIntent.object === 'payment_intent' && paymentIntent.livemode === false && paymentIntent.status === 'succeeded'
          && paymentIntent.currency === 'usd' && paymentIntent.amount === amount && paymentIntent.amount_received === amount && paymentIntent.amount_capturable === 0
          && reference(paymentIntent.customer, 'cus') === customerId && seconds(paymentIntent.created) >= purchase.createdAt
          && paymentIntent.application === null && paymentIntent.on_behalf_of === null && paymentIntent.transfer_data === null);
        const chargeId = reference(paymentIntent.latest_charge, 'ch');
        const charge = body(await client.charges.retrieve(chargeId, {}, options), purchase.providerAccountId);
        requireFact(charge.id === chargeId && charge.object === 'charge' && charge.livemode === false && charge.status === 'succeeded' && charge.paid === true && charge.captured === true
          && charge.currency === 'usd' && charge.amount === amount && charge.amount_captured === amount && charge.amount_refunded === 0 && charge.refunded === false && charge.disputed === false
          && reference(charge.customer, 'cus') === customerId && reference(charge.payment_intent, 'pi') === paymentIntentId
          && seconds(charge.created) >= purchase.createdAt && object(charge.payment_method_details).type === 'card'
          && charge.application === null && charge.application_fee_amount === null && charge.on_behalf_of === null && charge.transfer_data === null && charge.source_transfer === null);
        if (charge.refunds !== undefined && charge.refunds !== null) { const refunds = object(charge.refunds); requireFact(refunds.has_more === false && Array.isArray(refunds.data) && refunds.data.length === 0); }
        await account(purchase.providerAccountId); const verifiedAt = clock();
        requireFact(startsAt <= verifiedAt && endsAt > verifiedAt && seconds(object(invoice.status_transitions).paid_at) >= purchase.createdAt
          && seconds(object(invoice.status_transitions).paid_at) <= verifiedAt && seconds(object(payment.status_transitions).paid_at) >= purchase.createdAt
          && seconds(object(payment.status_transitions).paid_at) <= verifiedAt && seconds(paymentIntent.created) <= verifiedAt && seconds(charge.created) <= verifiedAt);
        return verifiedUsTestPaidProof(purchase, {
          purchaseId: purchase.purchaseId, sessionId: session.sessionId, customerId, subscriptionId, invoiceId, eventId,
          providerAccountId: purchase.providerAccountId, serverPrice: verifiedPrice, verifiedAt,
          authority: { kind: 'saas_subscription_authority', organizationId: purchase.organizationId, subscriptionId,
            offer: purchase.offer, status: 'active', evidence: { kind: 'verified_payment', referenceId: invoiceId,
              organizationId: purchase.organizationId, subscriptionId, environment: 'TEST', catalogVersion: purchase.offer.catalogVersion,
              priceId: purchase.offer.priceId, currency: 'USD', startsAt, endsAt, revoked: false } },
        });
      });
    },
  };
}
