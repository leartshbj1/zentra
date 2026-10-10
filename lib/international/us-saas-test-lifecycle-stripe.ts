import Stripe from 'stripe';
import { snapshotPrivateJson } from './private-json';
import { assertStripeTaxSdkMetadata, extractStripeTaxSdkBody } from './stripe-tax-sdk-body';
import { canonicalCreationJson } from './workspace-creation';
import { verifyServerStripePrice, type ServerStripePrice } from './subscriptions';
import { UsTestBillingError, usTestStripeApiVersion, type UsTestPurchase } from './us-saas-test-contract';
import {
  validateUsTestLifecycleBinding, validateUsTestLifecycleLocator, verifiedUsTestLifecycleObservation,
  type UsTestLifecycleBinding, type UsTestLifecycleGateway, type UsTestLifecycleLocator, type UsTestLifecycleObservation,
} from './us-saas-test-lifecycle-contract';

type Body = Record<string, unknown>;
const options = Object.freeze({ apiVersion: usTestStripeApiVersion, maxNetworkRetries: 0, timeout: 20_000 });
const mismatch = (): never => { throw new UsTestBillingError('lifecycle_mismatch', 422); };
const unsupported = (): never => { throw new UsTestBillingError('unsupported_lifecycle', 422); };
function requireFact(condition: unknown): asserts condition { if (!condition) mismatch(); }
function object(value: unknown): Body { if (!value || typeof value !== 'object' || Array.isArray(value)) return mismatch(); return value as Body; }
function id(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || value.length > 128 || !new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value)) return mismatch();
  return value;
}
function reference(value: unknown, prefix: string): string { return id(typeof value === 'string' ? value : object(value).id, prefix); }
function seconds(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return mismatch(); return value as number; }
function empty(value: unknown): boolean { return value === null || Array.isArray(value) && value.length === 0; }

// Kept identical to the initial gateway's SDK22.6 boundary. No response-owned
// getter or method runs; an SDK upgrade requires both real-SDK transport tests.
const decimalPrototype = Object.getPrototypeOf(Stripe.Decimal.zero) as object;
const decimalString = Object.getOwnPropertyDescriptor(decimalPrototype, 'toString')!.value as (this: Stripe.Decimal) => string;
const decimalCoefficientLimit = BigInt('100000000000000000000000000000000');
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
      } else { requireFact(descriptor.enumerable); result[key] = copy(descriptor.value, [...path, key]); }
    }
    return result;
  }
  return copy(input, []);
}
function body(value: unknown, accountId?: string): Body {
  const extracted = extractStripeTaxSdkBody(sdkJson(value));
  if (accountId) assertStripeTaxSdkMetadata(extracted.metadata, { accountId, apiVersion: usTestStripeApiVersion, idempotencyKey: 'us-test-read' });
  else if (extracted.metadata.apiVersion !== undefined && extracted.metadata.apiVersion !== usTestStripeApiVersion) return mismatch();
  return object(extracted.body);
}
function page(value: unknown, url: string, accountId?: string): Body[] {
  const result = body(value, accountId);
  requireFact(result.object === 'list' && result.url === url && Array.isArray(result.data) && result.data.length <= 100);
  if (result.has_more !== false) return unsupported();
  return result.data.map(object);
}
function invoiceScope(value: Body, subscriptionId?: string, customerId?: string): string {
  requireFact(value.object === 'invoice' && value.livemode === false); id(value.id, 'in');
  const parent = object(value.parent); requireFact(parent.type === 'subscription_details');
  const actual = reference(object(parent.subscription_details).subscription, 'sub');
  if (subscriptionId) requireFact(actual === subscriptionId);
  if (customerId) requireFact(reference(value.customer, 'cus') === customerId);
  return actual;
}
function subscriptionScope(value: Body, subscriptionId: string, customerId?: string): void {
  requireFact(value.object === 'subscription' && value.id === subscriptionId && value.livemode === false);
  if (customerId) requireFact(reference(value.customer, 'cus') === customerId);
  if (!['active', 'past_due', 'canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'trialing'].includes(String(value.status))) return unsupported();
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
interface PaymentGraph { invoice: Body; payment: Body; paymentIntent: Body; charge: Body }

/** Dedicated read-only TEST lifecycle transport. Event payloads locate actual
 * resources; durable ownership comes exclusively from the admitted binding. */
export function stripeUsTestLifecycleGateway(client: Stripe, now: () => number): UsTestLifecycleGateway {
  function clock(): number { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new UsTestBillingError('provider_unavailable', 503); return value; }
  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) { if (error instanceof UsTestBillingError) throw error; throw new UsTestBillingError('provider_unavailable', 503); }
  }
  async function account(accountId: string): Promise<void> {
    const actual = body(await client.accounts.retrieveCurrent({}, options), accountId);
    requireFact(actual.object === 'account' && actual.id === accountId);
    const balance = body(await client.balance.retrieve({}, options), accountId);
    requireFact(balance.object === 'balance' && balance.livemode === false);
  }
  async function invoiceRead(invoiceId: string, accountId?: string): Promise<Body> {
    const invoice = body(await client.invoices.retrieve(invoiceId, {}, options), accountId);
    requireFact(invoice.id === invoiceId); invoiceScope(invoice); return invoice;
  }
  async function chargeRead(chargeId: string, accountId?: string): Promise<Body> {
    const charge = body(await client.charges.retrieve(chargeId, {}, options), accountId);
    requireFact(charge.object === 'charge' && charge.id === chargeId && charge.livemode === false);
    return charge;
  }
  async function chargeInvoice(charge: Body, accountId?: string): Promise<PaymentGraph> {
    const paymentIntentId = reference(charge.payment_intent, 'pi');
    const paymentIntent = body(await client.paymentIntents.retrieve(paymentIntentId, {}, options), accountId);
    requireFact(paymentIntent.object === 'payment_intent' && paymentIntent.id === paymentIntentId && paymentIntent.livemode === false
      && reference(paymentIntent.latest_charge, 'ch') === charge.id);
    const payments = page(await client.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, status: 'paid', limit: 100 }, options), '/v1/invoice_payments', accountId);
    // Multiple invoices per PI exist upstream. This pilot never selects one
    // arbitrarily, even when two invoices happen to name the same subscription.
    if (payments.length !== 1) return unsupported();
    const payment = payments[0], details = object(payment.payment);
    requireFact(payment.object === 'invoice_payment' && payment.livemode === false && payment.status === 'paid'
      && details.type === 'payment_intent' && reference(details.payment_intent, 'pi') === paymentIntentId);
    const invoice = await invoiceRead(reference(payment.invoice, 'in'), accountId);
    return { invoice, payment, paymentIntent, charge };
  }
  async function invoicePayment(invoice: Body, binding: UsTestLifecycleBinding): Promise<PaymentGraph> {
    const accountId = binding.purchase.providerAccountId, invoiceId = id(invoice.id, 'in');
    const payments = page(await client.invoicePayments.list({ invoice: invoiceId, limit: 2 }, options), '/v1/invoice_payments', accountId);
    if (payments.length !== 1) return unsupported();
    const payment = payments[0], details = object(payment.payment);
    if (details.type !== 'payment_intent') return unsupported();
    requireFact(payment.object === 'invoice_payment' && payment.livemode === false && payment.status === 'paid' && reference(payment.invoice, 'in') === invoiceId);
    const paymentIntentId = reference(details.payment_intent, 'pi');
    const paymentIntent = body(await client.paymentIntents.retrieve(paymentIntentId, {}, options), accountId);
    requireFact(paymentIntent.object === 'payment_intent' && paymentIntent.id === paymentIntentId && paymentIntent.livemode === false);
    const charge = await chargeRead(reference(paymentIntent.latest_charge, 'ch'), accountId);
    const reverse = await chargeInvoice(charge, accountId);
    requireFact(reverse.invoice.id === invoiceId && reverse.payment.id === payment.id && canonicalCreationJson(reverse.paymentIntent) === canonicalCreationJson(paymentIntent));
    return { invoice, payment, paymentIntent, charge };
  }
  function boundGraph(graph: PaymentGraph, binding: UsTestLifecycleBinding): void {
    const { invoice, payment, paymentIntent, charge } = graph;
    invoiceScope(invoice, binding.subscriptionId, binding.customerId);
    id(payment.id, 'inpay');
    requireFact(invoice.status === 'paid' && invoice.currency === 'usd' && payment.currency === 'usd' && reference(payment.invoice, 'in') === invoice.id
      && paymentIntent.currency === 'usd' && charge.currency === 'usd' && paymentIntent.status === 'succeeded'
      && charge.status === 'succeeded' && charge.paid === true && charge.captured === true
      && seconds(charge.amount) > 0 && charge.amount_captured === charge.amount && paymentIntent.amount === charge.amount && paymentIntent.amount_received === charge.amount
      && paymentIntent.amount_capturable === 0 && seconds(payment.amount_paid) > 0 && seconds(payment.amount_paid) <= seconds(charge.amount)
      && seconds(payment.amount_requested) >= seconds(payment.amount_paid) && seconds(invoice.amount_paid) >= seconds(payment.amount_paid)
      && reference(paymentIntent.customer, 'cus') === binding.customerId && reference(charge.customer, 'cus') === binding.customerId
      && reference(charge.payment_intent, 'pi') === paymentIntent.id && reference(paymentIntent.latest_charge, 'ch') === charge.id
      && seconds(paymentIntent.created) >= binding.purchase.createdAt && seconds(charge.created) >= binding.purchase.createdAt
      && seconds(paymentIntent.created) <= clock() && seconds(charge.created) <= clock()
      && paymentIntent.application === null && paymentIntent.on_behalf_of === null && paymentIntent.transfer_data === null
      && charge.application === null && charge.application_fee_amount === null && charge.on_behalf_of === null && charge.transfer_data === null && charge.source_transfer === null);
  }
  async function risk(graph: PaymentGraph, binding: UsTestLifecycleBinding): Promise<'refunded' | 'disputed' | null> {
    boundGraph(graph, binding);
    const charge = graph.charge, chargeId = id(charge.id, 'ch'), amount = seconds(charge.amount), refunded = seconds(charge.amount_refunded);
    requireFact(amount > 0 && refunded <= amount && typeof charge.refunded === 'boolean' && typeof charge.disputed === 'boolean');
    if (refunded > 0) return 'refunded';
    requireFact(charge.refunded === false);
    const disputes = page(await client.disputes.list({ charge: chargeId, limit: 100 }, options), '/v1/disputes', binding.purchase.providerAccountId);
    let unsupportedDispute = false, actualDispute = false;
    const disputeIds = new Set<string>();
    for (const dispute of disputes) {
      requireFact(dispute.object === 'dispute' && dispute.livemode === false && reference(dispute.charge, 'ch') === chargeId
        && (dispute.payment_intent === null || reference(dispute.payment_intent, 'pi') === graph.paymentIntent.id)
        && dispute.currency === 'usd' && seconds(dispute.amount) > 0 && seconds(dispute.amount) <= amount
        && seconds(dispute.created) >= binding.purchase.createdAt && seconds(dispute.created) <= clock());
      const disputeId = id(dispute.id, 'dp'); requireFact(!disputeIds.has(disputeId)); disputeIds.add(disputeId);
      // Conservative TEST business policy: a real dispute, including a won
      // dispute, latches manual review. Warning/prevented never grant access.
      if (['needs_response', 'under_review', 'won', 'lost'].includes(String(dispute.status))) actualDispute = true;
      else unsupportedDispute = true;
    }
    if (actualDispute) return 'disputed';
    if (charge.disputed === true) return unsupported();
    if (unsupportedDispute) return unsupported();
    const refunds = page(await client.refunds.list({ charge: chargeId, limit: 100 }, options), '/v1/refunds', binding.purchase.providerAccountId);
    let pending = false, succeeded = false;
    const refundIds = new Set<string>();
    for (const refund of refunds) {
      requireFact(refund.object === 'refund' && reference(refund.charge, 'ch') === chargeId
        && (refund.payment_intent === null || reference(refund.payment_intent, 'pi') === graph.paymentIntent.id)
        && refund.currency === 'usd' && seconds(refund.amount) > 0 && seconds(refund.amount) <= amount
        && seconds(refund.created) >= binding.purchase.createdAt && seconds(refund.created) <= clock());
      const refundId = id(refund.id, 're'); requireFact(!refundIds.has(refundId)); refundIds.add(refundId);
      if (refund.status === 'succeeded') succeeded = true;
      else if (['pending', 'requires_action'].includes(String(refund.status))) pending = true;
      else if (!['failed', 'canceled'].includes(String(refund.status))) return unsupported();
    }
    if (succeeded) return 'refunded';
    if (pending) throw new UsTestBillingError('payment_unconfirmed', 409);
    return null;
  }
  return {
    locate(input) {
      return guarded(async () => {
        const event = object(snapshotPrivateJson(input));
        requireFact(event.object === 'event' && event.livemode === false && event.api_version === usTestStripeApiVersion
          && (event.account === undefined || event.account === null) && (event.context === undefined || event.context === null));
        const eventId = id(event.id, 'evt'), type = String(event.type);
        const types = ['invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'refund.created', 'refund.updated', 'refund.failed'];
        if (!types.includes(type)) return null;
        const source = object(object(event.data).object);
        let sourceType: UsTestLifecycleLocator['sourceType'], sourceId: string, subscriptionId: string;
        if (type.startsWith('invoice.')) {
          requireFact(source.object === 'invoice'); sourceType = 'invoice'; sourceId = id(source.id, 'in');
          subscriptionId = invoiceScope(await invoiceRead(sourceId));
        } else if (type.startsWith('customer.subscription.')) {
          requireFact(source.object === 'subscription'); sourceType = 'subscription'; sourceId = id(source.id, 'sub');
          const subscription = body(await client.subscriptions.retrieve(sourceId, {}, options)); subscriptionScope(subscription, sourceId); subscriptionId = sourceId;
        } else {
          let chargeId: string;
          if (type.startsWith('charge.dispute.')) {
            requireFact(source.object === 'dispute'); sourceType = 'dispute'; sourceId = id(source.id, 'dp');
            const dispute = body(await client.disputes.retrieve(sourceId, {}, options));
            requireFact(dispute.object === 'dispute' && dispute.id === sourceId && dispute.livemode === false); chargeId = reference(dispute.charge, 'ch');
          } else if (type.startsWith('refund.')) {
            requireFact(source.object === 'refund');
            const refundId = id(source.id, 're'), refund = body(await client.refunds.retrieve(refundId, {}, options));
            requireFact(refund.object === 'refund' && refund.id === refundId); chargeId = reference(refund.charge, 'ch'); sourceType = 'charge'; sourceId = chargeId;
          } else { requireFact(source.object === 'charge'); sourceType = 'charge'; sourceId = id(source.id, 'ch'); chargeId = sourceId; }
          subscriptionId = invoiceScope((await chargeInvoice(await chargeRead(chargeId))).invoice);
        }
        return validateUsTestLifecycleLocator({ eventId, subscriptionId, sourceType, sourceId });
      });
    },
    observe(input, inputLocator) {
      return guarded(async () => {
        const binding = validateUsTestLifecycleBinding(input), locator = validateUsTestLifecycleLocator(inputLocator), beganAt = clock();
        requireFact(locator.subscriptionId === binding.subscriptionId && beganAt >= binding.purchase.createdAt);
        const accountId = binding.purchase.providerAccountId;
        await account(accountId);
        async function finish(action: UsTestLifecycleObservation['action'], reason: UsTestLifecycleObservation['reason'], invoiceId: string | null, paid?: Pick<UsTestLifecycleObservation, 'authority' | 'serverPrice'>): Promise<UsTestLifecycleObservation> {
          await account(accountId); const observedAt = clock();
          if (observedAt < beganAt || observedAt - beganAt > 30) throw new UsTestBillingError('provider_unavailable', 503);
          return verifiedUsTestLifecycleObservation(binding, { ...locator, purchaseId: binding.purchase.purchaseId, organizationId: binding.purchase.organizationId,
            customerId: binding.customerId, providerAccountId: accountId, observedAt, action, reason, invoiceId, authority: paid?.authority ?? null, serverPrice: paid?.serverPrice ?? null });
        }
        if (locator.sourceType === 'charge' || locator.sourceType === 'dispute') {
          let chargeId = locator.sourceId, directDispute: Body | null = null;
          if (locator.sourceType === 'dispute') {
            directDispute = body(await client.disputes.retrieve(locator.sourceId, {}, options), accountId);
            requireFact(directDispute.object === 'dispute' && directDispute.id === locator.sourceId && directDispute.livemode === false);
            chargeId = reference(directDispute.charge, 'ch');
          }
          const graph = await chargeInvoice(await chargeRead(chargeId, accountId), accountId); boundGraph(graph, binding);
          if (directDispute) {
            requireFact((directDispute.payment_intent === null || reference(directDispute.payment_intent, 'pi') === graph.paymentIntent.id)
              && directDispute.currency === 'usd' && seconds(directDispute.amount) > 0 && seconds(directDispute.amount) <= seconds(graph.charge.amount)
              && seconds(directDispute.created) >= binding.purchase.createdAt && seconds(directDispute.created) <= clock());
            if (['needs_response', 'under_review', 'won', 'lost'].includes(String(directDispute.status))) return finish('revoke', 'disputed', id(graph.invoice.id, 'in'));
            return unsupported();
          }
          const reason = await risk(graph, binding);
          return finish(reason ? 'revoke' : 'observe', reason ?? 'payment_pending', id(graph.invoice.id, 'in'));
        }
        const subscription = body(await client.subscriptions.retrieve(binding.subscriptionId, { expand: ['items.data.price'] }, options), accountId);
        subscriptionScope(subscription, binding.subscriptionId, binding.customerId);
        if (locator.sourceType === 'subscription') {
          requireFact(locator.sourceId === binding.subscriptionId);
          if (subscription.status !== 'active') return finish('observe', subscription.status === 'canceled' ? 'canceled_paid_through' : 'payment_pending', null);
        }
        const invoiceId = locator.sourceType === 'invoice' ? locator.sourceId : reference(subscription.latest_invoice, 'in');
        const invoice = await invoiceRead(invoiceId, accountId); invoiceScope(invoice, binding.subscriptionId, binding.customerId);
        if (invoice.status !== 'paid') return finish('observe', subscription.status === 'canceled' ? 'canceled_paid_through' : 'payment_pending', invoiceId);
        const graph = await invoicePayment(invoice, binding), initialRisk = await risk(graph, binding);
        if (initialRisk) return finish('revoke', initialRisk, invoiceId);
        if (subscription.status !== 'active') return finish('observe', subscription.status === 'canceled' ? 'canceled_paid_through' : 'payment_pending', invoiceId);
        if (!['subscription_create', 'subscription_cycle'].includes(String(invoice.billing_reason))) return unsupported();
        const amount = Number(binding.purchase.offer.unitAmountMinor);
        requireFact(subscription.collection_method === 'charge_automatically' && object(subscription.automatic_tax).enabled === false
          && empty(subscription.discounts) && (subscription.default_tax_rates === undefined || empty(subscription.default_tax_rates))
          && subscription.trial_start === null && subscription.trial_end === null && subscription.schedule === null && subscription.pending_update === null
          && subscription.pause_collection === null && subscription.application === null && subscription.on_behalf_of === null && subscription.transfer_data === null);
        const items = object(subscription.items); requireFact(items.object === 'list' && items.has_more === false && Array.isArray(items.data) && items.data.length === 1);
        const item = object(items.data[0]);
        requireFact(item.object === 'subscription_item' && item.quantity === 1 && reference(item.price, 'price') === binding.purchase.offer.priceId && empty(item.discounts) && empty(item.tax_rates));
        id(item.id, 'si');
        requireFact(invoice.collection_method === 'charge_automatically' && invoice.amount_due === amount && invoice.amount_paid === amount && invoice.amount_paid_off_stripe === 0
          && invoice.amount_remaining === 0 && invoice.amount_overpaid === 0 && invoice.subtotal === amount && invoice.total === amount
          && invoice.starting_balance === 0 && invoice.ending_balance === 0 && invoice.pre_payment_credit_notes_amount === 0 && invoice.post_payment_credit_notes_amount === 0
          && empty(invoice.discounts) && empty(invoice.total_discount_amounts) && empty(invoice.total_taxes) && empty(invoice.default_tax_rates)
          && object(invoice.automatic_tax).enabled === false && invoice.application === null && invoice.on_behalf_of === null
          && (invoice.transfer_data === undefined || invoice.transfer_data === null) && object(invoice.issuer).type === 'self');
        const lines = object(invoice.lines); requireFact(lines.object === 'list' && lines.has_more === false && Array.isArray(lines.data) && lines.data.length === 1);
        const line = object(lines.data[0]), lineParent = object(line.parent), details = object(lineParent.subscription_item_details), pricing = object(line.pricing), priceDetails = object(pricing.price_details);
        requireFact(line.object === 'line_item' && line.livemode === false && line.invoice === invoiceId && line.amount === amount && line.subtotal === amount
          && line.currency === 'usd' && line.quantity === 1 && (line.quantity_decimal === undefined || line.quantity_decimal === null || line.quantity_decimal === '1')
          && empty(line.discounts) && empty(line.discount_amounts) && empty(line.taxes) && empty(line.pretax_credit_amounts)
          && lineParent.type === 'subscription_item_details' && details.proration === false && reference(details.subscription, 'sub') === binding.subscriptionId && details.subscription_item === item.id
          && pricing.type === 'price_details' && reference(priceDetails.price, 'price') === binding.purchase.offer.priceId && reference(priceDetails.product, 'prod') === binding.purchase.offer.productId
          && pricing.unit_amount_decimal === binding.purchase.offer.unitAmountMinor);
        const period = object(line.period), startsAt = seconds(period.start), endsAt = seconds(period.end);
        requireFact(startsAt >= binding.purchase.createdAt && endsAt > startsAt);
        // Custom cancellation dates/schedules can introduce truncated periods
        // and prorations. Only the usual paid-through cancellation is supported.
        if (subscription.cancel_at !== null && subscription.cancel_at !== endsAt) return unsupported();
        // Delayed old events acknowledge a historical fact without regressing or
        // inventing the current period. The store preserves its existing proof.
        if (startsAt > clock() || endsAt <= clock()) return finish('observe', 'payment_pending', invoiceId);
        requireFact(item.current_period_start === startsAt && item.current_period_end === endsAt);
        const { payment, paymentIntent, charge } = graph;
        requireFact(payment.amount_paid === amount && payment.amount_requested === amount && payment.is_default === true
          && paymentIntent.amount === amount && paymentIntent.amount_received === amount && paymentIntent.amount_capturable === 0
          && charge.amount === amount && charge.amount_captured === amount && object(charge.payment_method_details).type === 'card');
        const price = serverPrice(binding.purchase, body(await client.prices.retrieve(binding.purchase.offer.priceId, { expand: ['product'] }, options), accountId));
        const finalCharge = await chargeRead(id(charge.id, 'ch'), accountId), finalRisk = await risk({ ...graph, charge: finalCharge }, binding);
        if (finalRisk) return finish('revoke', finalRisk, invoiceId);
        requireFact(canonicalCreationJson(finalCharge) === canonicalCreationJson(charge));
        const freshSubscription = body(await client.subscriptions.retrieve(binding.subscriptionId, { expand: ['items.data.price'] }, options), accountId);
        requireFact(canonicalCreationJson(freshSubscription) === canonicalCreationJson(subscription));
        const freshInvoice = await invoiceRead(invoiceId, accountId); requireFact(canonicalCreationJson(freshInvoice) === canonicalCreationJson(invoice));
        const checkedAt = clock();
        requireFact(seconds(object(invoice.status_transitions).paid_at) >= binding.purchase.createdAt && seconds(object(invoice.status_transitions).paid_at) <= checkedAt
          && seconds(object(payment.status_transitions).paid_at) >= binding.purchase.createdAt && seconds(object(payment.status_transitions).paid_at) <= checkedAt
          && seconds(paymentIntent.created) <= checkedAt && seconds(charge.created) <= checkedAt);
        return finish('paid_period', 'paid', invoiceId, { serverPrice: price, authority: {
          kind: 'saas_subscription_authority', organizationId: binding.purchase.organizationId, subscriptionId: binding.subscriptionId, offer: binding.purchase.offer, status: 'active',
          evidence: { kind: 'verified_payment', referenceId: invoiceId, organizationId: binding.purchase.organizationId, subscriptionId: binding.subscriptionId,
            environment: 'TEST', catalogVersion: binding.purchase.offer.catalogVersion, priceId: binding.purchase.offer.priceId, currency: 'USD', startsAt, endsAt, revoked: false },
        } });
      });
    },
  };
}
