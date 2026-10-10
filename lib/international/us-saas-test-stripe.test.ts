import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { stripeUsTestGateway } from './us-saas-test-stripe';
import { assertUsTestPaidProof, assertUsTestSession, usTestProviderIdempotencyKey, usTestStripeApiVersion, verifiedUsTestSession, type UsTestPurchase } from './us-saas-test-contract';

const start = Date.parse('2026-10-10T12:00:00Z') / 1000;
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
function metadata() { return { zentra_us_purchase_id: purchaseId, creation_id: creationId, organization_id: organizationId, actor_user_id: actor, request_id: requestId, configuration_fingerprint: fingerprint, catalog_version: offer.catalogVersion, provider_account_id: 'acct_Test' }; }
function fixtures() {
  const period = { start: start + 2, end: start + 31 * 86400 };
  const session = { object: 'checkout.session', id: 'cs_test_UsTest', livemode: false, mode: 'subscription', client_reference_id: purchaseId, integration_identifier: 'zentra_us_test_abcdefgh', expires_at: start + 3600, allow_promotion_codes: false, automatic_tax: { enabled: false }, payment_method_types: ['card'], status: 'complete', payment_status: 'paid', metadata: metadata(), customer: 'cus_UsTest', subscription: 'sub_UsTest', invoice: 'in_UsTest', created: start + 1, url: null as string | null, currency: 'usd', amount_subtotal: 1500, amount_total: 1500, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 } };
  const price = { object: 'price', id: offer.priceId, active: true, livemode: false, currency: 'usd', unit_amount: 1500, type: 'recurring', tax_behavior: 'exclusive', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null }, product: { object: 'product', id: offer.productId, active: true, livemode: false, name: 'Internal provider label', metadata: { private: 'not persisted' } } };
  const subscription = { object: 'subscription', id: 'sub_UsTest', livemode: false, status: 'active', customer: 'cus_UsTest', latest_invoice: 'in_UsTest', collection_method: 'charge_automatically', automatic_tax: { enabled: false }, discounts: [], default_tax_rates: [], trial_start: null, trial_end: null, schedule: null, pending_update: null, pause_collection: null, application: null, on_behalf_of: null, transfer_data: null, metadata: metadata(), items: { object: 'list', has_more: false, data: [{ object: 'subscription_item', id: 'si_UsTest', quantity: 1, discounts: [], tax_rates: [], price: offer.priceId, current_period_start: period.start, current_period_end: period.end }] } };
  const invoice = { object: 'invoice', id: 'in_UsTest', livemode: false, status: 'paid', billing_reason: 'subscription_create', customer: 'cus_UsTest', collection_method: 'charge_automatically', currency: 'usd', amount_due: 1500, amount_paid: 1500, amount_paid_off_stripe: 0, amount_remaining: 0, amount_overpaid: 0, subtotal: 1500, total: 1500, starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, discounts: [], total_discount_amounts: [], total_taxes: [], default_tax_rates: [], automatic_tax: { enabled: false }, application: null, on_behalf_of: null, issuer: { type: 'self' }, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_UsTest' } }, lines: { object: 'list', has_more: false, data: [{ object: 'line_item', id: 'il_UsTest', livemode: false, invoice: 'in_UsTest', amount: 1500, subtotal: 1500, quantity: 1, currency: 'usd', discounts: [], discount_amounts: [], taxes: [], pretax_credit_amounts: [], parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_UsTest', subscription_item: 'si_UsTest', proration: false } }, pricing: { type: 'price_details', price_details: { price: offer.priceId, product: offer.productId }, unit_amount_decimal: '1500' }, period }] }, status_transitions: { paid_at: start + 5 } };
  const invoicePayment = { object: 'invoice_payment', id: 'inpay_UsTest', livemode: false, status: 'paid', currency: 'usd', invoice: 'in_UsTest', amount_paid: 1500, amount_requested: 1500, is_default: true, payment: { type: 'payment_intent', payment_intent: 'pi_UsTest' }, status_transitions: { paid_at: start + 5 } };
  const paymentIntent = { object: 'payment_intent', id: 'pi_UsTest', livemode: false, status: 'succeeded', currency: 'usd', amount: 1500, amount_received: 1500, amount_capturable: 0, customer: 'cus_UsTest', latest_charge: 'ch_UsTest', created: start + 3, application: null, on_behalf_of: null, transfer_data: null };
  const charge = { object: 'charge', id: 'ch_UsTest', livemode: false, status: 'succeeded', paid: true, captured: true, currency: 'usd', amount: 1500, amount_captured: 1500, amount_refunded: 0, refunded: false, disputed: false, customer: 'cus_UsTest', payment_intent: 'pi_UsTest', created: start + 3, payment_method_details: { type: 'card' }, application: null, application_fee_amount: null, on_behalf_of: null, transfer_data: null, source_transfer: null, refunds: { object: 'list', has_more: false, data: [] } };
  const list = <T>(url: string, data: T[]) => ({ object: 'list', url, has_more: false, data });
  return { account: { object: 'account', id: 'acct_Test' }, balance: { object: 'balance', livemode: false }, price, session, subscription, invoice, paymentIntent, charge,
    sessions: list('/v1/checkout/sessions', [session]), lineItems: list('/v1/checkout/sessions/cs_test_UsTest/line_items', [{ object: 'item', quantity: 1, price: offer.priceId, currency: 'usd', amount_subtotal: 1500, amount_total: 1500, amount_discount: 0, amount_tax: 0 }]), payments: list('/v1/invoice_payments', [invoicePayment]) };
}
function setup() {
  const f = fixtures(); let time = start + 10;
  const read = <T>(value: () => T) => vi.fn(async (..._args: unknown[]) => structuredClone(value()));
  const sdk = { accounts: { retrieveCurrent: read(() => f.account) }, balance: { retrieve: read(() => f.balance) }, prices: { retrieve: read(() => f.price) },
    checkout: { sessions: { create: read(() => f.session), retrieve: read(() => f.session), list: read(() => f.sessions), listLineItems: read(() => f.lineItems) } },
    subscriptions: { retrieve: read(() => f.subscription) }, invoices: { retrieve: read(() => f.invoice) }, invoicePayments: { list: read(() => f.payments) }, paymentIntents: { retrieve: read(() => f.paymentIntent) }, charges: { retrieve: read(() => f.charge) } };
  const input = purchase();
  const bound = verifiedUsTestSession(input, { purchaseId, sessionId: 'cs_test_UsTest', customerId: 'cus_UsTest', subscriptionId: 'sub_UsTest', createdAt: start + 1, expiresAt: start + 3600 });
  return { f, sdk, input, bound, gateway: stripeUsTestGateway(sdk as unknown as Stripe, () => time), setTime: (next: number) => { time = next; } };
}
const event = (type = 'invoice.paid') => ({ object: 'event', id: 'evt_UsTest', livemode: false, api_version: usTestStripeApiVersion, type, data: { object: { object: type === 'invoice.paid' ? 'invoice' : 'checkout.session', id: type === 'invoice.paid' ? 'in_UsTest' : 'cs_test_UsTest' } } });

describe('dedicated US TEST checkout transport', () => {
  it('uses the installed SDK request paths and response metadata with a local-only fake fetch', async () => {
    const f = fixtures(), calls: { path: string; method: string; headers: Headers }[] = [];
    const sdkPrice = { ...f.price, unit_amount_decimal: '1500' };
    const sdkSubscription = { ...f.subscription, items: { ...f.subscription.items, data: [{ ...f.subscription.items.data[0], price: sdkPrice, plan: { object: 'plan', id: offer.priceId, amount_decimal: '1500' } }] } };
    const sdkInvoice = { ...f.invoice, lines: { ...f.invoice.lines, data: [{ ...f.invoice.lines.data[0], quantity_decimal: '1' }] } };
    const sdkLines = { ...f.lineItems, data: [{ ...f.lineItems.data[0], price: sdkPrice }] };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), headers = new Headers(init?.headers);
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', headers });
      const bodies: Record<string, unknown> = {
        '/v1/account': f.account, '/v1/balance': f.balance, '/v1/prices/price_UsTest': sdkPrice,
        '/v1/checkout/sessions': f.session, '/v1/checkout/sessions/cs_test_UsTest': f.session,
        '/v1/checkout/sessions/cs_test_UsTest/line_items': sdkLines,
        '/v1/subscriptions/sub_UsTest': sdkSubscription, '/v1/invoices/in_UsTest': sdkInvoice,
        '/v1/invoice_payments': f.payments, '/v1/payment_intents/pi_UsTest': f.paymentIntent, '/v1/charges/ch_UsTest': f.charge,
      };
      if (!Object.hasOwn(bodies, url.pathname)) throw new Error('Unexpected fake transport path');
      return new Response(JSON.stringify(bodies[url.pathname]), { status: 200, headers: { 'content-type': 'application/json', 'stripe-version': usTestStripeApiVersion, 'stripe-account': 'acct_Test', ...(headers.has('idempotency-key') ? { 'idempotency-key': headers.get('idempotency-key')! } : {}) } });
    };
    const sdk = new Stripe('rk_test_FictitiousLocalOnlyNeverSent', { apiVersion: usTestStripeApiVersion, maxNetworkRetries: 0, httpClient: Stripe.createFetchHttpClient(fetcher) });
    expect(typeof sdk.invoicePayments?.list).toBe('function');
    const gateway = stripeUsTestGateway(sdk, () => start + 10), input = purchase();
    const created = await gateway.create(input), proof = await gateway.verify(input, created.session, 'recovery');
    expect(proof.invoiceId).toBe('in_UsTest'); expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(calls.find(call => call.method === 'POST')?.headers.get('idempotency-key')).toBe(usTestProviderIdempotencyKey(input));
    expect(calls.every(call => call.headers.get('stripe-version') === usTestStripeApiVersion && !call.headers.has('stripe-account'))).toBe(true);
  });
  it('creates exact stable Checkout parameters and branded session on retries', async () => {
    const t = setup(); t.f.session.status = 'open'; t.f.session.url = 'https://checkout.stripe.com/c/pay/cs_test_UsTest?prefilled_email=example%40example.com#test';
    const first = await t.gateway.create(t.input), second = await t.gateway.create(t.input);
    expect(first).toEqual(second); expect(() => assertUsTestSession(first.session)).not.toThrow();
    expect(t.sdk.checkout.sessions.create.mock.calls[0]).toEqual(t.sdk.checkout.sessions.create.mock.calls[1]);
    const [params, options] = t.sdk.checkout.sessions.create.mock.calls[0];
    expect(options).toEqual({ apiVersion: usTestStripeApiVersion, maxNetworkRetries: 0, timeout: 20_000, idempotencyKey: usTestProviderIdempotencyKey(t.input) });
    expect(params).toMatchObject({ mode: 'subscription', ui_mode: 'hosted', integration_identifier: t.input.integrationIdentifier, billing_address_collection: 'required', automatic_tax: { enabled: false }, tax_id_collection: { enabled: false }, discounts: [], allow_promotion_codes: false, line_items: [{ price: offer.priceId, quantity: 1 }], expires_at: t.input.expiresAt, client_reference_id: purchaseId, metadata: metadata(), subscription_data: { billing_mode: { type: 'flexible' }, metadata: metadata(), default_tax_rates: [] }, success_url: `${t.input.siteOrigin}/compte/espaces/us/nouveau?requestId=${requestId}&checkout=returned`, cancel_url: `${t.input.siteOrigin}/compte/espaces/us/nouveau?requestId=${requestId}&checkout=canceled` });
    expect(params).not.toHaveProperty('payment_method_types'); expect(JSON.stringify(params)).not.toMatch(/trial|connect|stripeAccount/); expect(t.sdk.accounts.retrieveCurrent).toHaveBeenCalledTimes(4);
  });
  it('snapshots caller-owned purchase before asynchronous reads', async () => {
    const t = setup(); t.sdk.accounts.retrieveCurrent.mockImplementationOnce(async () => { (t.input as { providerAccountId: string }).providerAccountId = 'acct_Other'; (t.input.offer as { priceId: string }).priceId = 'price_Other'; return structuredClone(t.f.account); });
    await expect(t.gateway.create(t.input)).resolves.toMatchObject({ session: { purchaseId } });
    expect(t.sdk.prices.retrieve).toHaveBeenCalledWith('price_UsTest', { expand: ['product'] }, expect.anything());
    expect(t.sdk.checkout.sessions.create.mock.calls[0][0]).toMatchObject({ line_items: [{ price: 'price_UsTest', quantity: 1 }] });
  });
  it('only reads the exact existing session after the minimum new-Checkout expiry window', async () => {
    const t = setup(); t.setTime(start + 1900); await expect(t.gateway.create(t.input)).resolves.toMatchObject({ url: null });
    expect(t.sdk.checkout.sessions.create).not.toHaveBeenCalled();
    expect(t.sdk.checkout.sessions.list).toHaveBeenCalledWith({ created: { gte: start, lte: start + 3600 }, limit: 100 }, expect.anything());
    expect(t.sdk.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test_UsTest', {}, expect.anything());
  });
  it.each(['none', 'duplicate', 'truncated'])('never creates a replacement for %s late lookup', async kind => {
    const t = setup(); t.setTime(start + 1900);
    if (kind === 'none') t.f.sessions.data = [];
    if (kind === 'duplicate') t.f.sessions.data.push(structuredClone(t.f.session));
    if (kind === 'truncated') t.f.sessions.has_more = true;
    await expect(t.gateway.create(t.input)).rejects.toMatchObject({ status: kind === 'truncated' ? 422 : 409 }); expect(t.sdk.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it.each(['https://evil.example/c/pay/cs_test_UsTest', 'https://checkout.stripe.com/c/pay/cs_live_UsTest', 'https://checkout.stripe.com/c/pay/cs_test_Other', 'https://checkout.stripe.com:444/c/pay/cs_test_UsTest', 'https://user@checkout.stripe.com/c/pay/cs_test_UsTest', 'https://checkout.stripe.com/redirect'])('rejects unsafe Checkout URL %s', async url => {
    const t = setup(); t.f.session.status = 'open'; t.f.session.url = url; await expect(t.gateway.create(t.input)).rejects.toBeDefined();
  });
  it('refuses altered Price before any Checkout POST', async () => { const t = setup(); t.f.price.unit_amount = 1; await expect(t.gateway.create(t.input)).rejects.toMatchObject({ code: 'provider_mismatch', status: 422 }); expect(t.sdk.checkout.sessions.create).not.toHaveBeenCalled(); });
  it('refuses expired sessions and missing open-session URLs', async () => {
    const t = setup(); t.f.session.status = 'expired'; await expect(t.gateway.create(t.input)).rejects.toMatchObject({ code: 'checkout_expired' }); t.f.session.status = 'open'; await expect(t.gateway.create(t.input)).rejects.toMatchObject({ code: 'provider_mismatch' });
  });
});

describe('initial payment proof is reconstructed from the provider graph', () => {
  it('reads all graph nodes and emits only the exact normalized private proof', async () => {
    const t = setup(), proof = await t.gateway.verify(t.input, t.bound, 'evt_UsTest');
    expect(() => assertUsTestPaidProof(proof)).not.toThrow();
    expect(proof.authority).toMatchObject({ organizationId, status: 'active', offer, evidence: { kind: 'verified_payment', referenceId: 'in_UsTest', environment: 'TEST', currency: 'USD', startsAt: start + 2 } });
    expect(proof.serverPrice).toEqual({ id: offer.priceId, active: true, livemode: false, currency: 'usd', unit_amount: 1500, type: 'recurring', tax_behavior: 'exclusive', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, product: { id: offer.productId, active: true } });
    expect(JSON.stringify(proof)).not.toContain('Internal provider label'); expect(JSON.stringify(proof)).not.toContain('not persisted');
    expect(t.sdk.invoicePayments.list).toHaveBeenCalledWith({ invoice: 'in_UsTest', limit: 2 }, expect.anything());
    expect(t.sdk.paymentIntents.retrieve).toHaveBeenCalledWith('pi_UsTest', {}, expect.anything());
    expect(t.sdk.charges.retrieve).toHaveBeenCalledWith('ch_UsTest', {}, expect.anything());
    expect(t.sdk.accounts.retrieveCurrent).toHaveBeenCalledTimes(2); expect(t.sdk.balance.retrieve).toHaveBeenCalledTimes(2);
  });
  it('permits null creation references to resolve to actual paid references', async () => {
    const t = setup(); const bound = verifiedUsTestSession(t.input, { ...t.bound, customerId: null, subscriptionId: null }); await expect(t.gateway.verify(t.input, bound, 'recovery')).resolves.toMatchObject({ customerId: 'cus_UsTest', subscriptionId: 'sub_UsTest' });
  });
  it('revalidates unbranded durable session fields and rejects extras before provider reads', async () => { const t = setup(); await expect(t.gateway.verify(t.input, { ...t.bound }, 'recovery')).resolves.toMatchObject({ invoiceId: 'in_UsTest' }); t.sdk.accounts.retrieveCurrent.mockClear(); await expect(t.gateway.verify(t.input, { ...t.bound, sessionId: 'cs_live_Other' }, 'recovery')).rejects.toMatchObject({ status: 422 }); expect(t.sdk.accounts.retrieveCurrent).not.toHaveBeenCalled(); });
  it.each(['account', 'balance', 'price', 'product', 'session', 'subscription', 'invoice', 'payment', 'paymentIntent', 'charge'])('refuses wrong account or live %s', async kind => {
    const t = setup();
    if (kind === 'account') t.f.account.id = 'acct_Other';
    else if (kind === 'product') t.f.price.product.livemode = true;
    else if (kind === 'payment') t.f.payments.data[0].livemode = true;
    else t.f[kind as 'balance' | 'price' | 'session' | 'subscription' | 'invoice' | 'paymentIntent' | 'charge'].livemode = true;
    await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'provider_mismatch', status: 422 });
  });
  const frauds: [string, (f: ReturnType<typeof fixtures>) => void][] = [
    ['session owner', f => { f.session.client_reference_id = requestId; }],
    ['metadata substitution', f => { f.subscription.metadata.organization_id = actor; }],
    ['customer graph', f => { f.paymentIntent.customer = 'cus_Other'; }],
    ['subscription graph', f => { f.invoice.parent.subscription_details.subscription = 'sub_Other'; }],
    ['invoice graph', f => { f.payments.data[0].invoice = 'in_Other'; }],
    ['charge graph', f => { f.charge.payment_intent = 'pi_Other'; }],
    ['captured amount', f => { f.charge.amount_captured = 1499; }],
    ['partial refund', f => { f.charge.amount_refunded = 1; }],
    ['full refund', f => { f.charge.refunded = true; }],
    ['dispute', f => { f.charge.disputed = true; }],
    ['authorization without capture', f => { f.charge.captured = false; }],
    ['session discount', f => { f.session.total_details.amount_discount = 1; }],
    ['session tax', f => { f.session.total_details.amount_tax = 1; }],
    ['automatic tax', f => { f.invoice.automatic_tax.enabled = true; }],
    ['off Stripe payment', f => { f.invoice.amount_paid_off_stripe = 1500; }],
    ['paused collection', f => { (f.subscription.pause_collection as unknown) = { behavior: 'mark_uncollectible' }; }],
    ['credit balance', f => { f.invoice.starting_balance = -1500; }],
    ['tax rates', f => { (f.invoice.default_tax_rates as unknown[]) = ['txr_Unexpected']; }],
    ['period graph', f => { f.subscription.items.data[0].current_period_end++; }],
    ['subscription item tax', f => { (f.subscription.items.data[0].tax_rates as unknown[]) = ['txr_Other']; }],
    ['invoice line live', f => { f.invoice.lines.data[0].livemode = true; }],
    ['invoice line graph', f => { f.invoice.lines.data[0].invoice = 'in_Other'; }],
    ['invoice line discount', f => { (f.invoice.lines.data[0].discounts as unknown[]) = ['di_Other']; }],
    ['future payment', f => { f.invoice.status_transitions.paid_at = start + 100; }],
    ['old payment', f => { f.charge.created = start - 1; }],
    ['transfer', f => { (f.charge.transfer_data as unknown) = { destination: 'acct_Other' }; }],
    ['proration', f => { f.invoice.lines.data[0].parent.subscription_item_details.proration = true; }],
    ['more line items', f => { f.lineItems.has_more = true; }],
    ['duplicate payments', f => { f.payments.data.push(structuredClone(f.payments.data[0])); }],
    ['truncated payments', f => { f.payments.has_more = true; }],
  ];
  it.each(frauds)('refuses %s before issuing proof', async (_label, mutate) => { const t = setup(); mutate(t.f); await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'provider_mismatch', status: 422 }); });
  it.each(['subscription_cycle', 'subscription_update'])('explicitly rejects unsupported %s renewals', async reason => { const t = setup(); t.f.invoice.billing_reason = reason; await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'unsupported_payment', status: 422 }); });
  it('rejects payment records and unsettled Checkout', async () => { const t = setup(); t.f.payments.data[0].payment.type = 'payment_record'; await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'unsupported_payment' }); t.f.session.payment_status = 'unpaid'; await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'payment_unconfirmed', status: 409 }); });
  it('refuses account change at the final independent read', async () => { const t = setup(); t.sdk.accounts.retrieveCurrent.mockResolvedValueOnce(t.f.account).mockResolvedValueOnce({ object: 'account', id: 'acct_Other' }); await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'provider_mismatch' }); });
  it('accepts absent SDK-optional default_tax_rates without widening tax acceptance', async () => { const t = setup(); delete (t.f.subscription as Partial<typeof t.f.subscription>).default_tax_rates; await expect(t.gateway.verify(t.input, t.bound, 'recovery')).resolves.toMatchObject({ invoiceId: 'in_UsTest' }); });
  it('fails closed and sanitizes SDK errors and response accessors', async () => {
    const t = setup(); t.sdk.prices.retrieve.mockRejectedValueOnce(new Error('sk_test_private provider detail')); await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'provider_unavailable', message: 'provider_unavailable', status: 503 });
    t.sdk.prices.retrieve.mockImplementationOnce(async () => Object.defineProperty({ ...t.f.price }, 'secret', { enumerable: true, get: () => { throw new Error('must not execute'); } }));
    await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'provider_mismatch', status: 422 });
  });
  it.each(['fractional', 'huge exponent', 'negative', 'wrong field', 'accessor'])('rejects unsafe SDK Decimal %s without executing response methods', async kind => {
    const t = setup(), getter = vi.fn(() => BigInt(1500));
    let decimal: unknown = Stripe.Decimal.from(kind === 'fractional' ? '1500.1' : kind === 'huge exponent' ? '1e100' : kind === 'negative' ? '-1500' : '1500');
    if (kind === 'accessor') decimal = Object.freeze(Object.create(Object.getPrototypeOf(Stripe.Decimal.zero), { _coefficient: { get: getter, enumerable: true }, _exponent: { value: 0, enumerable: true } }));
    t.sdk.prices.retrieve.mockImplementationOnce(async () => ({ ...structuredClone(t.f.price), [kind === 'wrong field' ? 'private' : 'unit_amount_decimal']: decimal }));
    await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'provider_mismatch', status: 422 }); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['apiVersion', 'stripeAccount', 'idempotencyKey'])('rejects mismatched SDK response %s header', async field => {
    const t = setup(); t.sdk.prices.retrieve.mockImplementationOnce(async () => Object.defineProperty(structuredClone(t.f.price), 'lastResponse', { value: { [field]: field === 'stripeAccount' ? 'acct_Other' : 'wrong' }, enumerable: false, configurable: false, writable: false }));
    await expect(t.gateway.verify(t.input, t.bound, 'recovery')).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 });
  });
});

describe('signed event data supplies locators only', () => {
  it('rereads invoice, its actual parent subscription and uniquely linked Checkout', async () => { const t = setup(); await expect(t.gateway.locate(event())).resolves.toEqual({ sessionId: 'cs_test_UsTest', eventId: 'evt_UsTest' }); expect(t.sdk.checkout.sessions.list).toHaveBeenCalledWith({ subscription: 'sub_UsTest', limit: 2 }, expect.anything()); expect(t.sdk.accounts.retrieveCurrent).not.toHaveBeenCalled(); expect(t.sdk.invoicePayments.list).not.toHaveBeenCalled(); });
  it.each(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])('rereads %s locator', async type => { const t = setup(); await expect(t.gateway.locate(event(type))).resolves.toEqual({ sessionId: 'cs_test_UsTest', eventId: 'evt_UsTest' }); expect(t.sdk.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test_UsTest', {}, expect.anything()); });
  it('ignores unrelated event types', async () => { const t = setup(); await expect(t.gateway.locate(event('customer.updated'))).resolves.toBeNull(); expect(t.sdk.checkout.sessions.retrieve).not.toHaveBeenCalled(); });
  it.each(['live', 'api', 'connect', 'ambiguous', 'invoice graph', 'renewal'])('refuses unsafe %s locator', async kind => {
    const t = setup(); const input: Record<string, unknown> = event();
    if (kind === 'live') input.livemode = true;
    if (kind === 'api') input.api_version = '2020-08-27';
    if (kind === 'connect') input.account = 'acct_Other';
    if (kind === 'ambiguous') t.f.sessions.data.push(structuredClone(t.f.session));
    if (kind === 'invoice graph') t.f.session.invoice = 'in_Other';
    if (kind === 'renewal') t.f.invoice.billing_reason = 'subscription_cycle';
    await expect(t.gateway.locate(input)).rejects.toMatchObject({ status: 422 });
  });
});
