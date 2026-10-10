import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsTestLifecycleHandlers, type UsTestLifecycleDependencies } from './us-saas-test-lifecycle-server';
import { assertUsTestLifecycleObservation, usTestLifecycleMaterial, validateUsTestLifecycleBinding, validateUsTestLifecycleLocator, verifiedUsTestLifecycleObservation, type UsTestLifecycleBinding, type UsTestLifecycleLocator, type UsTestLifecycleObservation } from './us-saas-test-lifecycle-contract';
import { UsTestBillingError } from './us-saas-test-contract';
import type { UsTestBillingConfiguration } from './us-saas-test-server';
import type { WorkspaceCreationIntent } from './workspace-creation';

const origin = 'https://sandbox.example', now = 1_790_000_000;
let binding: UsTestLifecycleBinding, intent: WorkspaceCreationIntent, config: UsTestBillingConfiguration, deps: UsTestLifecycleDependencies;
let locator: UsTestLifecycleLocator;
const request = (headers: Record<string, string> = {}, body = '{"id":"evt_fixture"}', url = origin) => new Request(url + '/api/international/billing/test/lifecycle/webhook', { method: 'POST', body, headers: { 'Stripe-Signature': 'synthetic_signature', ...headers } });
function observation(patch: Partial<UsTestLifecycleObservation> = {}) {
  return verifiedUsTestLifecycleObservation(binding, { ...locator, purchaseId: binding.purchase.purchaseId, organizationId: binding.purchase.organizationId, customerId: binding.customerId, providerAccountId: binding.purchase.providerAccountId, observedAt: now, action: 'observe', reason: 'payment_pending', invoiceId: 'in_renewal', authority: null, serverPrice: null, ...patch });
}
function paid() {
  const purchase = binding.purchase, organizationId = purchase.organizationId, subscriptionId = binding.subscriptionId, offer = purchase.offer;
  return observation({ action: 'paid_period', reason: 'paid', invoiceId: 'in_renewal',
    authority: { kind: 'saas_subscription_authority', organizationId, subscriptionId, offer, status: 'active', evidence: { kind: 'verified_payment', referenceId: 'in_renewal', organizationId, subscriptionId, environment: 'TEST', catalogVersion: offer.catalogVersion, priceId: offer.priceId, currency: 'USD', startsAt: now - 1, endsAt: now + 86400, revoked: false } },
    serverPrice: { id: offer.priceId, active: true, livemode: false, currency: 'usd', unit_amount: 1000, type: 'recurring', tax_behavior: 'exclusive', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, product: { id: offer.productId, active: true } },
  });
}
beforeEach(() => {
  const organizationId = randomUUID(), creationId = randomUUID(), actorUserId = randomUUID(), requestId = randomUUID();
  const configuration = { schemaVersion: 1 as const, organizationId, country: 'US' as const, currency: 'USD' as const, language: 'en' as const, timeZone: 'America/New_York', address: { country: 'US' as const, line1: '1 Fictitious St', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual' as const, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' as const } };
  const stamp = new Date((now - 7200) * 1000).toISOString(), fingerprint = 'a'.repeat(64);
  const receipt = { creationId, organizationId, actorUserId, requestId, configurationFingerprint: fingerprint, configuration, revision: 1 as const, updatedBy: actorUserId, updatedAt: stamp, replayed: false };
  const purchase = { purchaseId: randomUUID(), creationId, organizationId, actorUserId, requestId, configurationFingerprint: fingerprint, receipt, offer: { kind: 'saas_subscription' as const, catalogVersion: 'fixture', country: 'US' as const, currency: 'USD' as const, module: 'complet' as const, plan: 'fixture', priceId: 'price_fixture', productId: 'prod_fixture', environment: 'TEST' as const, unitAmountMinor: '1000', interval: 'month' as const, intervalCount: 1, taxBehavior: 'exclusive' as const }, seatLimit: 3, providerAccountId: 'acct_fixture', siteOrigin: origin, integrationIdentifier: 'zentra_us_test_abcdefgh', createdAt: now - 7200, expiresAt: now - 3600 };
  binding = { purchase, session: { purchaseId: purchase.purchaseId, sessionId: 'cs_test_fixture', customerId: null, subscriptionId: null, createdAt: purchase.createdAt, expiresAt: purchase.expiresAt }, customerId: 'cus_fixture', subscriptionId: 'sub_fixture', initialInvoiceId: 'in_initial' };
  intent = { creationId, organizationId, actorUserId, requestId, confirmationVersion: 1, companyName: 'Fictitious company', fingerprint, configuration, state: 'ready', ownSubscriptionId: binding.subscriptionId, receipt, createdAt: stamp, updatedAt: stamp };
  config = { providerAccountId: purchase.providerAccountId, siteOrigin: origin, policy: { now, environment: 'TEST', catalog: [{ offer: purchase.offer, seatLimit: 3 }] } };
  locator = { eventId: 'evt_fixture', subscriptionId: binding.subscriptionId, sourceType: 'invoice', sourceId: 'in_renewal' };
  const store = { bySubscription: vi.fn(async () => binding), apply: vi.fn(async (_binding, value, fresh) => { await fresh(); return value.action === 'paid_period' ? 'paid_period' as const : value.action === 'revoke' ? 'revoked' as const : 'observed' as const; }) };
  const gateway = { locate: vi.fn(async () => locator), observe: vi.fn(async () => paid()) };
  deps = { enabled: vi.fn(() => true), configuration: vi.fn(() => config), store: vi.fn(() => store), gateway: vi.fn(() => gateway), creations: vi.fn(() => ({ find: vi.fn(async () => intent), reserve: vi.fn(), confirm: vi.fn() })), verifyEvent: vi.fn(async () => ({ fixture: true })), now: () => now, diagnostic: vi.fn() };
});
describe('private US TEST lifecycle contract', () => {
  it('accepts a paid renewal after the original Checkout expiry without changing purchase/session', () => {
    const original = structuredClone(binding), value = paid(); assertUsTestLifecycleObservation(value);
    expect(value.authority!.evidence!.referenceId).toBe('in_renewal'); expect(binding).toEqual(original); expect(Object.isFrozen(value.authority)).toBe(true);
  });
  it('rejects unbranded, fabricated copies and foreign identities', () => {
    expect(() => assertUsTestLifecycleObservation({ ...paid() })).toThrow('unverified_lifecycle');
    for (const patch of [{ subscriptionId: 'sub_foreign' }, { customerId: 'cus_foreign' }, { organizationId: randomUUID() }, { providerAccountId: 'acct_foreign' }]) expect(() => observation(patch)).toThrow();
  });
  it('rejects unknown fields, malformed graph locators and stale session hints', () => {
    expect(() => validateUsTestLifecycleBinding({ ...binding, arbitrary: true } as unknown as UsTestLifecycleBinding)).toThrow();
    expect(() => validateUsTestLifecycleBinding({ ...binding, session: { ...binding.session, subscriptionId: 'sub_foreign' } })).toThrow();
    expect(() => validateUsTestLifecycleLocator({ ...locator, sourceId: 'sub_not_an_invoice' })).toThrow();
    expect(() => validateUsTestLifecycleLocator({ ...locator, eventId: 'recovery' })).toThrow();
  });
  it('never treats an observation or revoked record as paid evidence', () => {
    expect(() => observation({ action: 'observe', reason: 'paid' })).toThrow();
    expect(() => observation({ action: 'revoke', reason: 'payment_pending' })).toThrow();
    expect(() => observation({ action: 'revoke', reason: 'refunded', invoiceId: null })).toThrow();
    expect(() => observation({ action: 'observe', authority: paid().authority })).toThrow();
  });
  it('preserves first material retry identity but differentiates newly observed risk on the SAME event', () => {
    const first = paid(), later = verifiedUsTestLifecycleObservation(binding, { ...first, observedAt: now + 1 });
    expect(usTestLifecycleMaterial(first)).toBe(usTestLifecycleMaterial(later));
    expect(usTestLifecycleMaterial(observation({ action: 'revoke', reason: 'refunded' }))).not.toBe(usTestLifecycleMaterial(first));
  });
  it('rejects amount, environment, revoked and future/expired period proofs', () => {
    const good = paid();
    const changes = [
      { ...good, serverPrice: { ...good.serverPrice!, unit_amount: 1001 } },
      { ...good, authority: { ...good.authority!, evidence: { ...good.authority!.evidence!, environment: 'PRODUCTION' as const } } },
      { ...good, authority: { ...good.authority!, evidence: { ...good.authority!.evidence!, revoked: true } } },
      { ...good, authority: { ...good.authority!, evidence: { ...good.authority!.evidence!, startsAt: now + 1 } } },
      { ...good, authority: { ...good.authority!, evidence: { ...good.authority!.evidence!, endsAt: now } } },
    ];
    for (const value of changes) expect(() => verifiedUsTestLifecycleObservation(binding, value)).toThrow();
  });
});
describe('signed US TEST lifecycle HTTP boundary', () => {
  it('verifies signature before resolving provider or storage; commits only fresh scoped proof', async () => {
    const response = await createUsTestLifecycleHandlers(deps).WEBHOOK(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true, disposition: 'paid_period' });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(vi.mocked(deps.verifyEvent).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked((await deps.gateway()).locate).mock.invocationCallOrder[0]);
    expect((await deps.store()).apply).toHaveBeenCalledOnce();
  });
  it('is closed before signature/provider/DB when disabled or origin mismatches', async () => {
    vi.mocked(deps.enabled).mockReturnValue(false);
    expect((await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).status).toBe(404);
    vi.mocked(deps.enabled).mockReturnValue(true);
    expect((await createUsTestLifecycleHandlers(deps).WEBHOOK(request({}, '{}', 'https://other.example'))).status).toBe(503);
    expect(deps.verifyEvent).not.toHaveBeenCalled(); expect(deps.gateway).not.toHaveBeenCalled(); expect(deps.store).not.toHaveBeenCalled();
  });
  it('rejects browser/bearer substitution, missing/bad signature and oversized body', async () => {
    const handler = createUsTestLifecycleHandlers(deps);
    expect((await handler.WEBHOOK(request({ Authorization: 'Bearer forged' }))).status).toBe(400);
    expect((await handler.WEBHOOK(request({ 'Stripe-Signature': '' }))).status).toBe(400);
    expect((await handler.WEBHOOK(request({ 'Stripe-Signature': 'x'.repeat(4097) }))).status).toBe(400);
    expect((await handler.WEBHOOK(request({}, 'x'.repeat(1_048_577)))).status).toBe(413);
    vi.mocked(deps.verifyEvent).mockRejectedValue(new UsTestBillingError('invalid_signature', 400));
    expect((await handler.WEBHOOK(request())).status).toBe(400); expect(deps.gateway).not.toHaveBeenCalled();
  });
  it('ignores irrelevant or unknown subscriptions without creating or admitting a company', async () => {
    const gateway = await deps.gateway(); vi.mocked(gateway.locate).mockResolvedValueOnce(null);
    expect(await (await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).json()).toEqual({ received: true, disposition: 'ignored' });
    vi.mocked((await deps.store()).bySubscription).mockResolvedValue(null);
    expect(await (await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).json()).toEqual({ received: true, disposition: 'ignored' });
    expect(gateway.observe).not.toHaveBeenCalled(); expect((await deps.store()).apply).not.toHaveBeenCalled();
  });
  it('rejects unbranded or locator-swapped provider results', async () => {
    const gateway = await deps.gateway(); vi.mocked(gateway.observe).mockResolvedValueOnce({ ...paid() });
    expect((await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).status).toBe(422);
    vi.mocked(gateway.observe).mockResolvedValueOnce(observation({ eventId: 'evt_other' }));
    expect((await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).status).toBe(422); expect((await deps.store()).apply).not.toHaveBeenCalled();
  });
  it.each([-61, 1])('rejects a provider observation outside fresh server bounds (%s seconds)', async delta => {
    vi.mocked((await deps.gateway()).observe).mockResolvedValue(observation({ observedAt: now + delta }));
    expect((await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).status).toBe(409); expect((await deps.store()).apply).not.toHaveBeenCalled();
  });
  it('refuses removed offer for grants but still records/revokes a confirmed old invoice risk', async () => {
    config = { ...config, policy: { ...config.policy, catalog: [] } };
    expect((await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).status).toBe(409);
    vi.mocked((await deps.gateway()).observe).mockResolvedValue(observation({ action: 'revoke', reason: 'refunded', invoiceId: binding.initialInvoiceId }));
    const response = await createUsTestLifecycleHandlers(deps).WEBHOOK(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true, disposition: 'revoked' });
  });
  it.each(['gate', 'catalog', 'binding', 'creation'] as const)('does not commit when %s changes while provider request is in flight', async target => {
    vi.mocked((await deps.gateway()).observe).mockImplementation(async () => {
      const value = paid();
      if (target === 'gate') vi.mocked(deps.enabled).mockReturnValue(false);
      else if (target === 'catalog') config = { ...config, policy: { ...config.policy, catalog: [] } };
      else if (target === 'binding') vi.mocked((await deps.store()).bySubscription).mockResolvedValue(null);
      else intent = { ...intent, ownSubscriptionId: 'sub_foreign' };
      return value;
    });
    expect([404, 409]).toContain((await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).status); expect((await deps.store()).apply).not.toHaveBeenCalled();
  });
  it('checks ownership again inside the storage write and sanitizes provider/DB errors', async () => {
    const store = await deps.store(); vi.mocked(store.apply).mockImplementation(async (_b, _o, fresh) => { intent = { ...intent, state: 'postgres_confirmed' }; await fresh(); return 'observed'; });
    expect((await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).status).toBe(409);
    vi.mocked(store.bySubscription).mockRejectedValue(new Error('provider secret customer email raw response'));
    const response = await createUsTestLifecycleHandlers(deps).WEBHOOK(request()); expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":"service_unavailable"}');
    expect(JSON.stringify(vi.mocked(deps.diagnostic).mock.calls)).not.toMatch(/customer email|raw response|provider secret/);
  });
  it('distinguishes observation without granting from a paid period', async () => {
    vi.mocked((await deps.gateway()).observe).mockResolvedValue(observation({ reason: 'canceled_paid_through' }));
    expect(await (await createUsTestLifecycleHandlers(deps).WEBHOOK(request())).json()).toEqual({ received: true, disposition: 'observed' });
    expect(vi.mocked((await deps.store()).apply).mock.calls[0][1].authority).toBeNull();
  });
});
