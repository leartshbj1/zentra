import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { stripeUsTestLifecycleGateway } from './us-saas-test-lifecycle-stripe';
import { usTestStripeApiVersion, type UsTestPurchase } from './us-saas-test-contract';
import { assertUsTestLifecycleObservation, type UsTestLifecycleBinding, type UsTestLifecycleLocator } from './us-saas-test-lifecycle-contract';

type Body = Record<string, unknown>;
const start = Date.parse('2026-10-10T12:00:00Z') / 1000;
const renewal = start + 31 * 86400;
const actor = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const organizationId = '33333333-3333-4333-8333-333333333333';
const creationId = '44444444-4444-4444-8444-444444444444';
const purchaseId = '55555555-5555-4555-8555-555555555555';
const fingerprint = 'a'.repeat(64);
const offer = { kind: 'saas_subscription', catalogVersion: 'us-test-v1', country: 'US', currency: 'USD', module: 'gestion', plan: 'monthly', priceId: 'price_UsTest', productId: 'prod_UsTest', environment: 'TEST', unitAmountMinor: '1500', interval: 'month', intervalCount: 1, taxBehavior: 'exclusive' } as const;
function purchase(): UsTestPurchase {
  const configuration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '10 Example St', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } } as const;
  return { purchaseId, creationId, organizationId, actorUserId: actor, requestId, configurationFingerprint: fingerprint, offer: { ...offer }, seatLimit: 3, providerAccountId: 'acct_Test', siteOrigin: 'https://staging.zentra.example', integrationIdentifier: 'zentra_us_test_abcdefgh', createdAt: start, expiresAt: start + 3600,
    receipt: { creationId, organizationId, actorUserId: actor, requestId, configurationFingerprint: fingerprint, configuration, revision: 1, updatedBy: actor, updatedAt: '2026-10-10T12:00:00Z', replayed: false } };
}
const list = <T>(url: string, data: T[]) => ({ object: 'list', url, has_more: false, data });
function fixtures() {
  const period = { start: renewal, end: renewal + 30 * 86400 };
  const price = { object: 'price', id: offer.priceId, active: true, livemode: false, currency: 'usd', unit_amount: 1500, type: 'recurring', tax_behavior: 'exclusive', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null }, product: { object: 'product', id: offer.productId, active: true, livemode: false } };
  const subscription = { object: 'subscription', id: 'sub_UsTest', livemode: false, status: 'active', customer: 'cus_UsTest', latest_invoice: 'in_Renewal', collection_method: 'charge_automatically', automatic_tax: { enabled: false }, discounts: [], default_tax_rates: [], trial_start: null, trial_end: null, schedule: null, pending_update: null, pause_collection: null, application: null, on_behalf_of: null, transfer_data: null, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, metadata: { organization_id: 'untrusted_metadata_is_ignored' }, items: { object: 'list', has_more: false, data: [{ object: 'subscription_item', id: 'si_UsTest', quantity: 1, discounts: [], tax_rates: [], price: offer.priceId, current_period_start: period.start, current_period_end: period.end }] } };
  const invoice = { object: 'invoice', id: 'in_Renewal', livemode: false, status: 'paid', billing_reason: 'subscription_cycle', customer: 'cus_UsTest', collection_method: 'charge_automatically', currency: 'usd', amount_due: 1500, amount_paid: 1500, amount_paid_off_stripe: 0, amount_remaining: 0, amount_overpaid: 0, subtotal: 1500, total: 1500, starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, discounts: [], total_discount_amounts: [], total_taxes: [], default_tax_rates: [], automatic_tax: { enabled: false }, application: null, on_behalf_of: null, issuer: { type: 'self' }, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_UsTest' } }, lines: { object: 'list', has_more: false, data: [{ object: 'line_item', id: 'il_Renewal', livemode: false, invoice: 'in_Renewal', amount: 1500, subtotal: 1500, quantity: 1, currency: 'usd', discounts: [], discount_amounts: [], taxes: [], pretax_credit_amounts: [], parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_UsTest', subscription_item: 'si_UsTest', proration: false } }, pricing: { type: 'price_details', price_details: { price: offer.priceId, product: offer.productId }, unit_amount_decimal: '1500' }, period }] }, status_transitions: { paid_at: renewal + 5 } };
  const payment = { object: 'invoice_payment', id: 'inpay_Renewal', livemode: false, status: 'paid', currency: 'usd', invoice: 'in_Renewal', amount_paid: 1500, amount_requested: 1500, is_default: true, payment: { type: 'payment_intent', payment_intent: 'pi_Renewal' }, status_transitions: { paid_at: renewal + 5 } };
  const paymentIntent = { object: 'payment_intent', id: 'pi_Renewal', livemode: false, status: 'succeeded', currency: 'usd', amount: 1500, amount_received: 1500, amount_capturable: 0, customer: 'cus_UsTest', latest_charge: 'ch_Renewal', created: renewal + 3, application: null, on_behalf_of: null, transfer_data: null };
  const charge = { object: 'charge', id: 'ch_Renewal', livemode: false, status: 'succeeded', paid: true, captured: true, currency: 'usd', amount: 1500, amount_captured: 1500, amount_refunded: 0, refunded: false, disputed: false, customer: 'cus_UsTest', payment_intent: 'pi_Renewal', created: renewal + 3, payment_method_details: { type: 'card' }, application: null, application_fee_amount: null, on_behalf_of: null, transfer_data: null, source_transfer: null };
  const dispute = { object: 'dispute', id: 'dp_Renewal', livemode: false, status: 'needs_response', currency: 'usd', amount: 1500, charge: 'ch_Renewal', payment_intent: 'pi_Renewal', created: renewal + 6 };
  const refund = { object: 'refund', id: 're_Renewal', status: 'succeeded', currency: 'usd', amount: 1, charge: 'ch_Renewal', payment_intent: 'pi_Renewal', created: renewal + 6 };
  return { account: { object: 'account', id: 'acct_Test' }, balance: { object: 'balance', livemode: false }, price, subscription, invoice, paymentIntent, charge, dispute, refund,
    payments: list('/v1/invoice_payments', [payment]), disputes: list<Body>('/v1/disputes', []), refunds: list<Body>('/v1/refunds', []) };
}
function binding(): UsTestLifecycleBinding {
  const input = purchase();
  return { purchase: input, session: { purchaseId, sessionId: 'cs_test_UsTest', customerId: null, subscriptionId: null, createdAt: start + 1, expiresAt: input.expiresAt }, customerId: 'cus_UsTest', subscriptionId: 'sub_UsTest', initialInvoiceId: 'in_Initial' };
}
function locator(sourceType: UsTestLifecycleLocator['sourceType'] = 'invoice'): UsTestLifecycleLocator {
  return { eventId: 'evt_Renewal', subscriptionId: 'sub_UsTest', sourceType, sourceId: { invoice: 'in_Renewal', subscription: 'sub_UsTest', charge: 'ch_Renewal', dispute: 'dp_Renewal' }[sourceType] };
}
function event(type = 'invoice.paid'): Body {
  const source = type.startsWith('customer.subscription.') ? ['subscription', 'sub_UsTest'] : type.startsWith('charge.dispute.') ? ['dispute', 'dp_Renewal'] : type.startsWith('charge.') ? ['charge', 'ch_Renewal'] : type.startsWith('refund.') ? ['refund', 're_Renewal'] : ['invoice', 'in_Renewal'];
  return { object: 'event', id: 'evt_Renewal', livemode: false, api_version: usTestStripeApiVersion, type, created: start, data: { object: { object: source[0], id: source[1], metadata: { organization_id: 'forged_ignored' } } } };
}
function setup() {
  const f = fixtures(); let time = renewal + 10;
  const read = <T>(value: () => T) => vi.fn(async (..._args: unknown[]) => structuredClone(value()));
  const sdk = { accounts: { retrieveCurrent: read(() => f.account) }, balance: { retrieve: read(() => f.balance) }, prices: { retrieve: read(() => f.price) },
    subscriptions: { retrieve: read(() => f.subscription) }, invoices: { retrieve: read(() => f.invoice) }, invoicePayments: { list: read(() => f.payments) }, paymentIntents: { retrieve: read(() => f.paymentIntent) }, charges: { retrieve: read(() => f.charge) }, disputes: { retrieve: read(() => f.dispute), list: read(() => f.disputes) }, refunds: { retrieve: read(() => f.refund), list: read(() => f.refunds) } };
  const input = binding();
  return { f, sdk, input, gateway: stripeUsTestLifecycleGateway(sdk as unknown as Stripe, () => time), setTime: (next: number) => { time = next; } };
}
function change(input: unknown, path: string, value: unknown): void {
  const keys = path.split('.'); let target = input as Body;
  for (const key of keys.slice(0, -1)) target = target[key] as Body;
  target[keys[keys.length - 1]] = value;
}

describe('US TEST lifecycle locators use the actual first-class graph', () => {
  it.each(['invoice.paid', 'invoice.payment_failed'])('locates %s without Checkout or metadata ownership', async type => { const t = setup(); await expect(t.gateway.locate(event(type))).resolves.toEqual(locator()); expect(t.sdk.invoices.retrieve).toHaveBeenCalledWith('in_Renewal', {}, expect.anything()); expect(t.sdk.prices.retrieve).not.toHaveBeenCalled(); });
  it.each(['customer.subscription.updated', 'customer.subscription.deleted'])('locates %s directly', async type => { const t = setup(); await expect(t.gateway.locate(event(type))).resolves.toEqual(locator('subscription')); });
  it.each(['charge.refunded', 'refund.created', 'refund.updated', 'refund.failed'])('locates %s through actual PI and InvoicePayments', async type => {
    const t = setup(); await expect(t.gateway.locate(event(type))).resolves.toEqual(locator('charge'));
    expect(t.sdk.invoicePayments.list).toHaveBeenCalledWith({ payment: { type: 'payment_intent', payment_intent: 'pi_Renewal' }, status: 'paid', limit: 100 }, expect.anything());
  });
  it.each(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'])('locates %s by its actual Charge', async type => { const t = setup(); await expect(t.gateway.locate(event(type))).resolves.toEqual(locator('dispute')); });
  it('ignores unrelated events without provider reads', async () => { const t = setup(); await expect(t.gateway.locate(event('customer.updated'))).resolves.toBeNull(); expect(t.sdk.invoices.retrieve).not.toHaveBeenCalled(); });
  it.each([['live', 'livemode', true], ['API version', 'api_version', '2020-08-27'], ['Connect', 'account', 'acct_Other'], ['context', 'context', 'org_Other']])('rejects event %s', async (_label, path, value) => {
    const t = setup(), input = event(); change(input, path as string, value); await expect(t.gateway.locate(input)).rejects.toMatchObject({ status: 422 });
  });
  it.each(['ambiguous', 'truncated', 'empty', 'wrong PI', 'wrong Charge', 'live invoice'])('refuses %s risk graph', async kind => {
    const t = setup(); if (kind === 'ambiguous') t.f.payments.data.push(structuredClone(t.f.payments.data[0]));
    if (kind === 'truncated') t.f.payments.has_more = true; if (kind === 'empty') t.f.payments.data = [];
    if (kind === 'wrong PI') t.f.payments.data[0].payment.payment_intent = 'pi_Other'; if (kind === 'wrong Charge') t.f.paymentIntent.latest_charge = 'ch_Other'; if (kind === 'live invoice') t.f.invoice.livemode = true;
    await expect(t.gateway.locate(event('charge.refunded'))).rejects.toMatchObject({ status: 422 });
  });
});

describe('current recurring TEST payment proof', () => {
  it('brands a fresh renewal after Checkout expiry with exact immutable offer and normalized price', async () => {
    const t = setup(), result = await t.gateway.observe(t.input, locator());
    expect(result).toMatchObject({ action: 'paid_period', reason: 'paid', purchaseId, invoiceId: 'in_Renewal', observedAt: renewal + 10, authority: { evidence: { startsAt: renewal, endsAt: renewal + 30 * 86400 } } });
    expect(() => assertUsTestLifecycleObservation(result)).not.toThrow(); expect(t.sdk.accounts.retrieveCurrent).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.serverPrice!)).toEqual(['id', 'active', 'livemode', 'currency', 'unit_amount', 'type', 'tax_behavior', 'recurring', 'product']);
  });
  it('reconciles a current paid invoice on subscription updates', async () => { const t = setup(); await expect(t.gateway.observe(t.input, locator('subscription'))).resolves.toMatchObject({ action: 'paid_period' }); });
  it('does not require the old Checkout invoice or a delayed event to equal latest_invoice', async () => { const t = setup(); t.f.subscription.latest_invoice = 'in_Next'; await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'paid_period', invoiceId: 'in_Renewal' }); });
  it.each(['past_due', 'canceled', 'unpaid', 'paused'])('never extends %s and does not consult current prices', async status => {
    const t = setup(); t.f.subscription.status = status; const observed = await t.gateway.observe(t.input, locator('subscription'));
    expect(observed).toMatchObject({ action: 'observe', reason: status === 'canceled' ? 'canceled_paid_through' : 'payment_pending', authority: null, serverPrice: null }); expect(t.sdk.prices.retrieve).not.toHaveBeenCalled();
  });
  it('keeps a period-end cancellation within the actually paid period', async () => { const t = setup(); t.f.subscription.cancel_at_period_end = true; await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'paid_period', authority: { evidence: { endsAt: renewal + 30 * 86400 } } }); });
  it('rejects custom cancellation dates outside the verified period end', async () => { const t = setup(); change(t.f.subscription, 'cancel_at', renewal + 20 * 86400); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'unsupported_lifecycle' }); });
  it('acknowledges an unpaid actual invoice without granting', async () => { const t = setup(); t.f.invoice.status = 'open'; await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'observe', reason: 'payment_pending' }); expect(t.sdk.invoicePayments.list).not.toHaveBeenCalled(); });
  it.each(['old', 'future'])('acknowledges %s paid period without granting or regression', async kind => { const t = setup(); t.setTime(kind === 'old' ? renewal + 31 * 86400 : renewal - 1); if (kind === 'future') { t.f.paymentIntent.created = renewal - 2; t.f.charge.created = renewal - 2; } await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'observe', authority: null }); });
  const frauds: [string, string, unknown][] = [
    ['account', 'account.id', 'acct_Other'], ['balance live', 'balance.livemode', true], ['subscription live', 'subscription.livemode', true], ['invoice live', 'invoice.livemode', true],
    ['price live', 'price.livemode', true], ['product live', 'price.product.livemode', true], ['inactive price', 'price.active', false], ['different price', 'price.id', 'price_Other'],
    ['sub customer', 'subscription.customer', 'cus_Other'], ['invoice customer', 'invoice.customer', 'cus_Other'], ['invoice sub', 'invoice.parent.subscription_details.subscription', 'sub_Other'],
    ['PI customer', 'paymentIntent.customer', 'cus_Other'], ['Charge customer', 'charge.customer', 'cus_Other'], ['Charge PI', 'charge.payment_intent', 'pi_Other'],
    ['line invoice', 'invoice.lines.data.0.invoice', 'in_Other'], ['line sub', 'invoice.lines.data.0.parent.subscription_item_details.subscription', 'sub_Other'], ['line item', 'invoice.lines.data.0.parent.subscription_item_details.subscription_item', 'si_Other'],
    ['line live', 'invoice.lines.data.0.livemode', true], ['line product', 'invoice.lines.data.0.pricing.price_details.product', 'prod_Other'], ['line quantity', 'invoice.lines.data.0.quantity', 2],
    ['line proration', 'invoice.lines.data.0.parent.subscription_item_details.proration', true], ['decimal mismatch', 'invoice.lines.data.0.pricing.unit_amount_decimal', '1500.01'],
    ['tax', 'invoice.automatic_tax.enabled', true], ['credit', 'invoice.starting_balance', -1500], ['off Stripe', 'invoice.amount_paid_off_stripe', 1500], ['credit note', 'invoice.post_payment_credit_notes_amount', 1],
    ['underpayment', 'invoice.amount_paid', 1499], ['invoice amount', 'invoice.total', 1499], ['payment amount', 'payments.data.0.amount_paid', 1499], ['PI amount', 'paymentIntent.amount_received', 1499],
    ['capture amount', 'charge.amount_captured', 1499], ['not captured', 'charge.captured', false], ['Connect', 'charge.transfer_data', { destination: 'acct_Other' }], ['noncard', 'charge.payment_method_details.type', 'sepa_debit'],
    ['item price', 'subscription.items.data.0.price', 'price_Other'], ['item quantity', 'subscription.items.data.0.quantity', 2], ['period mismatch', 'subscription.items.data.0.current_period_end', renewal + 99],
    ['collection paused', 'subscription.pause_collection', { behavior: 'void' }], ['trial', 'subscription.trial_end', renewal + 99], ['schedule', 'subscription.schedule', 'sub_sched_Other'], ['pending update', 'subscription.pending_update', {}],
    ['future paid timestamp', 'invoice.status_transitions.paid_at', renewal + 100], ['old PI', 'paymentIntent.created', start - 1],
  ];
  it.each(frauds)('rejects %s without a grant', async (_label, path, value) => { const t = setup(); change(t.f, path, value); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ status: 422 }); });
  it.each(['subscription_update', 'manual'])('rejects unsupported %s invoice', async reason => { const t = setup(); t.f.invoice.billing_reason = reason; await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'unsupported_lifecycle' }); });
  it.each(['payments', 'refunds', 'disputes', 'lines', 'items'])('refuses truncated %s collections', async collection => { const t = setup(); change(t.f, { payments: 'payments', refunds: 'refunds', disputes: 'disputes', lines: 'invoice.lines', items: 'subscription.items' }[collection] + '.has_more', true); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ status: 422 }); });
  it('never converts a payment record into a PI proof', async () => { const t = setup(); t.f.payments.data[0].payment.type = 'payment_record'; await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'unsupported_lifecycle' }); });
});

describe('terminal TEST risk policy is independent of current plan, status and invoice', () => {
  it.each([1, 1500])('revokes a historical invoice with a %i-cent refund', async amount => {
    const t = setup(); t.f.charge.amount_refunded = amount; t.f.charge.refunded = amount === 1500; t.f.subscription.status = 'canceled'; t.f.subscription.latest_invoice = 'in_Next'; t.f.price.active = false;
    const result = await t.gateway.observe(t.input, locator('charge')); expect(result).toMatchObject({ action: 'revoke', reason: 'refunded', invoiceId: 'in_Renewal', authority: null }); expect(t.sdk.prices.retrieve).not.toHaveBeenCalled(); expect(t.sdk.subscriptions.retrieve).not.toHaveBeenCalled();
  });
  it('rereads a succeeded refund even if the Charge counter has not caught up', async () => { const t = setup(); t.f.refunds.data.push(t.f.refund); await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'revoke', reason: 'refunded' }); });
  it.each(['pending', 'requires_action'])('does not grant or terminally revoke %s refunds', async status => { const t = setup(); t.f.refund.status = status; t.f.refunds.data.push(t.f.refund); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'payment_unconfirmed', status: 409 }); });
  it.each(['failed', 'canceled'])('does not revoke for %s refund', async status => { const t = setup(); t.f.refund.status = status; t.f.refunds.data.push(t.f.refund); await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'paid_period' }); });
  it.each(['needs_response', 'under_review', 'won', 'lost'])('latches actual %s disputes for manual review', async status => { const t = setup(); t.f.dispute.status = status; await expect(t.gateway.observe(t.input, locator('dispute'))).resolves.toMatchObject({ action: 'revoke', reason: 'disputed' }); expect(t.sdk.prices.retrieve).not.toHaveBeenCalled(); });
  it.each(['warning_needs_response', 'warning_under_review', 'warning_closed', 'prevented'])('does not grant or claim a real dispute for %s', async status => { const t = setup(); t.f.dispute.status = status; await expect(t.gateway.observe(t.input, locator('dispute'))).rejects.toMatchObject({ code: 'unsupported_lifecycle' }); });
  it('revokes current paid proof if the fresh dispute list contains a won historical dispute', async () => { const t = setup(); t.f.dispute.status = 'won'; t.f.disputes.data.push(t.f.dispute); await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'revoke', reason: 'disputed' }); });
  it('revokes a freshly disputed Charge with its actual dispute without requiring subscription status', async () => { const t = setup(); t.f.charge.disputed = true; t.f.disputes.data.push(t.f.dispute); await expect(t.gateway.observe(t.input, locator('charge'))).resolves.toMatchObject({ action: 'revoke', reason: 'disputed' }); });
  it('does not mistake an unresolved disputed flag or a warning for a real dispute', async () => { const t = setup(); t.f.charge.disputed = true; await expect(t.gateway.observe(t.input, locator('charge'))).rejects.toMatchObject({ code: 'unsupported_lifecycle' }); t.f.dispute.status = 'warning_under_review'; t.f.disputes.data.push(t.f.dispute); await expect(t.gateway.observe(t.input, locator('charge'))).rejects.toMatchObject({ code: 'unsupported_lifecycle' }); });
  it.each(['refunds', 'disputes'])('rejects duplicate %s rather than partially applying a list', async collection => { const t = setup(); const value = collection === 'refunds' ? t.f.refund : t.f.dispute; t.f[collection as 'refunds' | 'disputes'].data.push(value, structuredClone(value)); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'lifecycle_mismatch' }); });
  it('does not grant from a risk event whose actual Charge has no refund or dispute', async () => { const t = setup(); await expect(t.gateway.observe(t.input, locator('charge'))).resolves.toMatchObject({ action: 'observe', reason: 'payment_pending' }); });
  it('refuses a substituted actual invoice despite event and metadata asserting our subscription', async () => { const t = setup(); t.f.invoice.parent.subscription_details.subscription = 'sub_Other'; t.f.charge.amount_refunded = 1; await expect(t.gateway.observe(t.input, locator('charge'))).rejects.toMatchObject({ code: 'lifecycle_mismatch' }); });
  it('requires a real captured payment before revoking a linked risk', async () => { const t = setup(); t.f.charge.amount_refunded = 1; t.f.charge.amount_captured = 0; await expect(t.gateway.observe(t.input, locator('charge'))).rejects.toMatchObject({ code: 'lifecycle_mismatch' }); });
  it('checks risks before current-price restrictions on invoice events', async () => { const t = setup(); t.f.charge.amount_refunded = 1; t.f.price.active = false; t.f.subscription.status = 'past_due'; await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'revoke', reason: 'refunded' }); });
});

describe('freshness, immutable inputs and installed SDK boundary', () => {
  it('snapshots caller binding and locator before awaiting ports', async () => {
    const t = setup(), source = locator(); t.sdk.accounts.retrieveCurrent.mockImplementationOnce(async () => { change(t.input, 'purchase.providerAccountId', 'acct_Other'); change(t.input, 'customerId', 'cus_Other'); change(source, 'sourceId', 'in_Other'); return structuredClone(t.f.account); });
    await expect(t.gateway.observe(t.input, source)).resolves.toMatchObject({ providerAccountId: 'acct_Test', customerId: 'cus_UsTest', invoiceId: 'in_Renewal' });
  });
  it('refuses a late provider round', async () => { const t = setup(); t.sdk.accounts.retrieveCurrent.mockImplementationOnce(async () => { t.setTime(renewal + 41); return structuredClone(t.f.account); }); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'provider_unavailable' }); });
  it('sees a refund that arrives while collecting a paid proof', async () => { const t = setup(); t.sdk.charges.retrieve.mockResolvedValueOnce(structuredClone(t.f.charge)).mockResolvedValueOnce({ ...structuredClone(t.f.charge), amount_refunded: 1 }); await expect(t.gateway.observe(t.input, locator())).resolves.toMatchObject({ action: 'revoke', reason: 'refunded' }); });
  it('refuses a changed subscription at the final reread', async () => { const t = setup(); t.sdk.subscriptions.retrieve.mockResolvedValueOnce(structuredClone(t.f.subscription)).mockResolvedValueOnce({ ...structuredClone(t.f.subscription), status: 'canceled' }); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'lifecycle_mismatch' }); });
  it('refuses account changes at the final independent check', async () => { const t = setup(); t.sdk.accounts.retrieveCurrent.mockResolvedValueOnce(structuredClone(t.f.account)).mockResolvedValueOnce({ object: 'account', id: 'acct_Other' }); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'lifecycle_mismatch' }); });
  it.each(['apiVersion', 'stripeAccount', 'idempotencyKey'])('rejects unexpected SDK %s response metadata', async field => { const t = setup(); t.sdk.prices.retrieve.mockImplementationOnce(async () => Object.defineProperty(structuredClone(t.f.price), 'lastResponse', { value: { [field]: 'wrong' }, enumerable: false, configurable: false, writable: false })); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 }); });
  it('sanitizes provider failures and does not execute response accessors', async () => { const t = setup(); t.sdk.prices.retrieve.mockRejectedValueOnce(new Error('private provider detail')); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ code: 'provider_unavailable', message: 'provider_unavailable' }); const getter = vi.fn(); t.sdk.prices.retrieve.mockImplementationOnce(async () => Object.defineProperty({ ...t.f.price }, 'secret', { enumerable: true, get: getter })); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ status: 422 }); expect(getter).not.toHaveBeenCalled(); });
  it.each(['fractional', 'negative', 'huge exponent', 'wrong field'])('rejects unsafe Decimal %s', async kind => { const t = setup(); t.sdk.prices.retrieve.mockImplementationOnce(async () => ({ ...structuredClone(t.f.price), [kind === 'wrong field' ? 'private' : 'unit_amount_decimal']: Stripe.Decimal.from(kind === 'fractional' ? '1500.1' : kind === 'negative' ? '-1500' : kind === 'huge exponent' ? '1e100' : '1500') })); await expect(t.gateway.observe(t.input, locator())).rejects.toMatchObject({ status: 422 }); });
  it('uses real SDK22.6 Decimal hydration and GET-only paths against a local fake fetch', async () => {
    const f = fixtures(), calls: { path: string; method: string; headers: Headers }[] = [];
    const price = { ...f.price, unit_amount_decimal: '1500' }, subscription = { ...f.subscription, items: { ...f.subscription.items, data: [{ ...f.subscription.items.data[0], price }] } };
    const invoice = { ...f.invoice, lines: { ...f.invoice.lines, data: [{ ...f.invoice.lines.data[0], quantity_decimal: '1' }] } };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), headers = new Headers(init?.headers); calls.push({ path: url.pathname, method: init?.method ?? 'GET', headers });
      const bodies: Record<string, unknown> = { '/v1/account': f.account, '/v1/balance': f.balance, '/v1/prices/price_UsTest': price, '/v1/subscriptions/sub_UsTest': subscription, '/v1/invoices/in_Renewal': invoice, '/v1/invoice_payments': f.payments, '/v1/payment_intents/pi_Renewal': f.paymentIntent, '/v1/charges/ch_Renewal': f.charge, '/v1/disputes': f.disputes, '/v1/refunds': f.refunds };
      if (!Object.hasOwn(bodies, url.pathname)) throw new Error('Unexpected local-only transport path');
      return new Response(JSON.stringify(bodies[url.pathname]), { status: 200, headers: { 'content-type': 'application/json', 'stripe-version': usTestStripeApiVersion, 'stripe-account': 'acct_Test' } });
    };
    const sdk = new Stripe('rk_test_FictitiousLocalOnlyNeverSent', { apiVersion: usTestStripeApiVersion, maxNetworkRetries: 0, httpClient: Stripe.createFetchHttpClient(fetcher) });
    const gateway = stripeUsTestLifecycleGateway(sdk, () => renewal + 10); await expect(gateway.observe(binding(), locator())).resolves.toMatchObject({ action: 'paid_period' });
    expect(calls.every(call => call.method === 'GET' && call.headers.get('stripe-version') === usTestStripeApiVersion && !call.headers.has('stripe-account'))).toBe(true);
  });
});
