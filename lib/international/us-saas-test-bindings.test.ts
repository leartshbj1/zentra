import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import type { UsTestLifecycleGateway, UsTestLifecycleLocator } from './us-saas-test-lifecycle-contract';
import type { UsTestLifecycleStore } from './us-saas-test-lifecycle-server';
import type { UsTestPurchase } from './us-saas-test-contract';
const profile = { schemaVersion:1, kind:'sandbox', profileId:'sandbox-fixture', siteOrigin:'https://sandbox.example', supabaseOrigin:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', license:{kid:'sandbox-fixture-v1',publicKeyB64url:'A'.repeat(43)}, identifiers:{windows:'ch.zentra.sandbox.windows',macos:'ch.zentra.sandbox.macos',mobile:'ch.zentra.sandbox.mobile'},productName:'Zentra Sandbox',binaryName:'ZentraSandbox',updater:'disabled',sha256:'a'.repeat(64) };
const fixture = vi.hoisted(() => ({ env:{} as Record<string,string> }));
vi.mock('cloudflare:workers', () => ({env:fixture.env}));
function bindings() { return { ZENTRA_DEPLOYMENT_KIND:'sandbox',ZENTRA_DEPLOYMENT_PROFILE_ID:profile.profileId,ZENTRA_DEPLOYMENT_PROFILE_SHA256:profile.sha256,PUBLIC_SITE_URL:profile.siteOrigin,SUPABASE_URL:profile.supabaseOrigin,INTERNATIONAL_CORE_ENABLED:'true',INTERNATIONAL_US_CREATION_ENABLED:'true',INTERNATIONAL_US_SAAS_TEST_ENABLED:'true',INTERNATIONAL_US_BILLING_ENVIRONMENT:'TEST',INTERNATIONAL_US_SAAS_TEST_TAX_MODE:'sandbox_no_tax',INTERNATIONAL_US_SAAS_TEST_SECRET_KEY:'rk_test_'+'f'.repeat(20),INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET:'whsec_'+'f'.repeat(20),INTERNATIONAL_US_SAAS_TEST_ACCOUNT_ID:'acct_fixture',INTERNATIONAL_US_SAAS_CATALOG_JSON:JSON.stringify([{seatLimit:3,offer:{kind:'saas_subscription',catalogVersion:'fixture',country:'US',currency:'USD',module:'gestion',plan:'fixture',priceId:'price_fixture',productId:'prod_fixture',environment:'TEST',unitAmountMinor:'1000',interval:'month',intervalCount:1,taxBehavior:'exclusive'}}]) } as Record<string,string>; }
async function selected(sandbox=true) { vi.resetModules(); if(sandbox)vi.stubGlobal('__ZENTRA_DEPLOYMENT_PROFILE__',profile); return import('./us-saas-test-bindings'); }
const closeFixtures: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks();for(const close of closeFixtures.splice(0))close();for(const key of Object.keys(fixture.env))delete fixture.env[key];vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules(); });
async function emptyCatalogueFixture() {
  const billing = await selected(), lifecycle = await import('./us-saas-test-lifecycle-bindings');
  const data = await (await import('./us-saas-test-lifecycle-test-fixture')).lifecycleFixture(); closeFixtures.push(() => data.sql.close());
  const contract = await import('./us-saas-test-lifecycle-contract');
  const binding = contract.validateUsTestLifecycleBinding({ ...data.binding, purchase: { ...data.purchase, siteOrigin: profile.siteOrigin } });
  Object.assign(fixture.env, bindings(), { INTERNATIONAL_US_SAAS_TEST_ACCOUNT_ID: binding.purchase.providerAccountId, INTERNATIONAL_US_SAAS_CATALOG_JSON: '[]', INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED: 'true', INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET: 'whsec_' + 'l'.repeat(20) });
  const locator: UsTestLifecycleLocator = { eventId: 'evt_EmptyCatalogue', subscriptionId: binding.subscriptionId, sourceType: 'charge', sourceId: 'ch_EmptyCatalogue' };
  const observation = contract.verifiedUsTestLifecycleObservation(binding, { ...locator, purchaseId: binding.purchase.purchaseId, organizationId: binding.purchase.organizationId, customerId: binding.customerId, providerAccountId: binding.purchase.providerAccountId, observedAt: data.now(), action: 'revoke', reason: 'refunded', invoiceId: binding.initialInvoiceId, authority: null, serverPrice: null });
  // Actual configuration/signature/HTTP composition; external provider reads
  // and the private storage sink are explicit trusted TEST ports here.
  const store: UsTestLifecycleStore = { bySubscription: vi.fn(async () => binding), apply: vi.fn(async (_binding, value, fresh) => { await fresh(); return value.action === 'revoke' ? 'revoked' : 'paid_period'; }) };
  const gateway: UsTestLifecycleGateway = { locate: vi.fn(async () => locator), observe: vi.fn(async () => observation) };
  vi.spyOn(lifecycle.usTestLifecycleDependencies, 'store').mockResolvedValue(store);
  vi.spyOn(lifecycle.usTestLifecycleDependencies, 'gateway').mockResolvedValue(gateway);
  vi.spyOn(lifecycle.usTestLifecycleDependencies, 'creations').mockResolvedValue({ find: vi.fn(async () => data.intent), reserve: vi.fn(), confirm: vi.fn() });
  const raw = JSON.stringify({ id: locator.eventId, object: 'event', api_version: '2026-08-26.dahlia', livemode: false, type: 'charge.refunded', data: { object: { object: 'charge', id: locator.sourceId } } });
  const request = (secret: string) => new Request(profile.siteOrigin + '/api/international/billing/test/webhook', { method: 'POST', body: raw, headers: { 'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({ payload: raw, secret }) } });
  return { billing, lifecycle, data, binding, contract, locator, store, gateway, request };
}
describe('dedicated US TEST runtime configuration', () => {
  it('keeps page/admission configuration strict while allowing an empty catalogue only for internal lifecycle configuration', async () => {
    const billing = await selected(), lifecycle = await import('./us-saas-test-lifecycle-bindings'), value = { ...bindings(), INTERNATIONAL_US_SAAS_CATALOG_JSON: '[]', INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED: 'true', INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET: 'whsec_' + 'l'.repeat(20) };
    Object.assign(fixture.env, value);
    expect(() => billing.usTestBillingConfiguration(value)).toThrow('service_unavailable');
    expect(await billing.usTestBillingEnabled()).toBe(false);
    expect(lifecycle.usTestLifecycleConfiguration(value)).toMatchObject({ policy: { environment: 'TEST', catalog: [] } });
    expect(await billing.usTestBillingDependencies.enabled()).toBe(true);
    delete fixture.env.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET;
    expect(await billing.usTestBillingDependencies.enabled()).toBe(false);
    fixture.env.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET = value.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET;
    fixture.env.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED = 'false';
    expect(await billing.usTestBillingDependencies.enabled()).toBe(false);
  });
  it.each(['dedicated', 'shared'] as const)('verifies the actual %s signature and processes a revocation after the final offer is removed', async endpoint => {
    const f = await emptyCatalogueFixture(), secret = endpoint === 'dedicated' ? fixture.env.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET : fixture.env.INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET;
    const handlers = endpoint === 'dedicated' ? f.lifecycle.usTestLifecycleHandlers : f.billing.usTestBillingHandlers;
    const response = await handlers.WEBHOOK(f.request(secret));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true, disposition: 'revoked' });
    expect(f.store.apply).toHaveBeenCalledOnce(); expect(vi.mocked(f.store.apply).mock.calls[0][1]).toMatchObject({ action: 'revoke', reason: 'refunded' });
    vi.mocked(f.store.apply).mockClear();
    expect((await handlers.WEBHOOK(f.request('whsec_' + 'x'.repeat(20)))).status).toBe(400); expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('does not grant a renewed period through the real shared binding when no current offer remains', async () => {
    const f = await emptyCatalogueFixture(), invoiceId = 'in_EmptyCataloguePaid';
    const paid = f.contract.verifiedUsTestLifecycleObservation(f.binding, { ...f.locator, purchaseId: f.binding.purchase.purchaseId, organizationId: f.binding.purchase.organizationId, customerId: f.binding.customerId, providerAccountId: f.binding.purchase.providerAccountId, observedAt: f.data.now(), action: 'paid_period', reason: 'paid', invoiceId,
      authority: { ...f.data.authority, evidence: { ...f.data.authority.evidence!, referenceId: invoiceId, startsAt: f.data.now(), endsAt: f.data.now() + 3600 } }, serverPrice: f.data.price });
    vi.mocked(f.gateway.observe).mockResolvedValue(paid);
    const response = await f.billing.usTestBillingHandlers.WEBHOOK(f.request(fixture.env.INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'offer_unavailable' }); expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('does not create Checkout or admit a workspace through POST/recover with an empty catalogue', async () => {
    const f = await emptyCatalogueFixture(), { ownSubscriptionId: _ownSubscriptionId, ...unadmitted } = f.data.intent, intent = { ...unadmitted, state: 'postgres_confirmed' as const };
    const purchases = { find: vi.fn(async (): Promise<UsTestPurchase | null> => null), bySession: vi.fn(), reserve: vi.fn(), bind: vi.fn(), session: vi.fn(), admit: vi.fn() };
    vi.spyOn(f.billing.usTestBillingDependencies, 'user').mockResolvedValue({ userId: intent.actorUserId });
    vi.spyOn(f.billing.usTestBillingDependencies, 'creations').mockResolvedValue({ find: vi.fn(async () => intent), reserve: vi.fn(), confirm: vi.fn() });
    vi.spyOn(f.billing.usTestBillingDependencies, 'purchases').mockResolvedValue(purchases);
    vi.spyOn(f.billing.usTestBillingDependencies, 'rateLimit').mockResolvedValue(undefined);
    const gateway = vi.spyOn(f.billing.usTestBillingDependencies, 'gateway');
    const request = (body: unknown) => new Request(profile.siteOrigin + '/api/international/billing/test', { method: 'POST', headers: { Origin: profile.siteOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await f.billing.usTestBillingHandlers.POST(request({ requestId: intent.requestId, module: f.binding.purchase.offer.module, plan: f.binding.purchase.offer.plan, confirmTest: true }))).status).toBe(409);
    purchases.find.mockResolvedValue(f.binding.purchase);
    expect((await f.billing.usTestBillingHandlers.RECOVER(request({ requestId: intent.requestId }))).status).toBe(409);
    expect(gateway).not.toHaveBeenCalled(); expect(purchases.reserve).not.toHaveBeenCalled(); expect(purchases.admit).not.toHaveBeenCalled();
  });
  it('requires an independent lifecycle gate and signing secret without enabling production', async () => {
    await selected(); const m = await import('./us-saas-test-lifecycle-bindings'), base = bindings();
    expect(() => m.usTestLifecycleConfiguration(base)).toThrow('feature_unavailable');
    expect(() => m.usTestLifecycleConfiguration({ ...base, INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED: 'true' })).toThrow('service_unavailable');
    expect(m.usTestLifecycleConfiguration({ ...base, INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED: 'true', INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET: 'whsec_' + 'l'.repeat(20) })).toMatchObject({ policy: { environment: 'TEST' } });
    vi.unstubAllGlobals(); await selected(false); const production = await import('./us-saas-test-lifecycle-bindings');
    expect(() => production.usTestLifecycleConfiguration({ ...base, INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED: 'true', INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET: 'whsec_' + 'l'.repeat(20) })).toThrow('feature_unavailable');
  });
  it('verifies the actual SDK signature with the dedicated lifecycle secret, TEST mode and exact API version', async () => {
    await selected(); const m = await import('./us-saas-test-lifecycle-bindings');
    Object.assign(fixture.env, bindings(), { INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED: 'true', INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET: 'whsec_' + 'l'.repeat(20) });
    const raw = JSON.stringify({ id: 'evt_fixture', object: 'event', api_version: '2026-08-26.dahlia', livemode: false, type: 'invoice.paid', data: { object: { id: 'in_fixture' } } });
    const secret = fixture.env.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET;
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
    expect(await m.usTestLifecycleDependencies.verifyEvent(raw, signature)).toMatchObject({ id: 'evt_fixture' });
    await expect(m.usTestLifecycleDependencies.verifyEvent(raw, Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: fixture.env.INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET }))).rejects.toMatchObject({ code: 'invalid_signature', status: 400 });
    for (const change of [{ livemode: true }, { api_version: '2025-03-31.basil' }, { account: 'acct_foreign' }, { context: 'acct_foreign' }]) {
      const altered = JSON.stringify({ ...JSON.parse(raw), ...change });
      await expect(m.usTestLifecycleDependencies.verifyEvent(altered, Stripe.webhooks.generateTestHeaderString({ payload: altered, secret }))).rejects.toMatchObject({ code: 'invalid_signature', status: 400 });
    }
  });
  it('is closed in a production build even if TEST flags and keys are present', async () => { const m=await selected(false);expect(()=>m.usTestBillingConfiguration(bindings())).toThrow('feature_unavailable');expect(()=>m.usTestBillingConfiguration(bindings(),{allowEmptyCatalogue:true})).toThrow('feature_unavailable'); });
  it('accepts only the matching compiled isolated sandbox and dedicated TEST configuration', async () => { const m=await selected();expect(m.usTestBillingConfiguration(bindings())).toMatchObject({providerAccountId:'acct_fixture',siteOrigin:profile.siteOrigin,policy:{environment:'TEST'}}); });
  it.each(['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_CREATION_ENABLED','INTERNATIONAL_US_SAAS_TEST_ENABLED','INTERNATIONAL_US_SAAS_TEST_TAX_MODE','INTERNATIONAL_US_SAAS_TEST_SECRET_KEY','INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET','INTERNATIONAL_US_SAAS_TEST_ACCOUNT_ID','INTERNATIONAL_US_BILLING_ENVIRONMENT','ZENTRA_DEPLOYMENT_PROFILE_SHA256','PUBLIC_SITE_URL','SUPABASE_URL'])('fails closed without %s', async field => {const m=await selected(),value=bindings();delete value[field];expect(()=>m.usTestBillingConfiguration(value)).toThrow();expect(()=>m.usTestBillingConfiguration(value,{allowEmptyCatalogue:true})).toThrow();});
  it('does not substitute legacy/merchant secrets or live mode', async () => { const m=await selected(),value=bindings();for(const key of ['sk_test_'+'x'.repeat(20),'rk_live_'+'x'.repeat(20),''])expect(()=>m.usTestBillingConfiguration({...value,INTERNATIONAL_US_SAAS_TEST_SECRET_KEY:key,STRIPE_SECRET_KEY:'sk_test_legacy',STRIPE_MERCHANT_SECRET_KEY:'rk_test_merchant'})).toThrow(); });
  it('rejects a production origin, empty or ambiguous catalogue', async () => {const m=await selected(),value=bindings();expect(()=>m.usTestBillingConfiguration({...value,PUBLIC_SITE_URL:'https://zentraapp.ch'})).toThrow();expect(()=>m.usTestBillingConfiguration({...value,INTERNATIONAL_US_SAAS_CATALOG_JSON:'[]'})).toThrow();const entry=JSON.parse(value.INTERNATIONAL_US_SAAS_CATALOG_JSON)[0];expect(()=>m.usTestBillingConfiguration({...value,INTERNATIONAL_US_SAAS_CATALOG_JSON:JSON.stringify([entry,entry])})).toThrow();});
  it('never exposes secrets in the internal safe configuration DTO', async () => {const m=await selected(),value=bindings(),result=JSON.stringify(m.usTestBillingConfiguration(value));expect(result).not.toContain(value.INTERNATIONAL_US_SAAS_TEST_SECRET_KEY);expect(result).not.toContain(value.INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET);});
});
