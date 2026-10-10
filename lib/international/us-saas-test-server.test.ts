import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsTestBillingHandlers, type UsTestBillingDependencies, type UsTestBillingConfiguration } from './us-saas-test-server';
import { UsTestBillingError, verifiedUsTestPaidProof, verifiedUsTestSession, type UsTestPurchase, type UsTestSession } from './us-saas-test-contract';
import type { WorkspaceCreationIntent } from './workspace-creation';
import type { SaasSubscriptionAuthority, ServerStripePrice } from './subscriptions';
import type { UsTestPublicState } from './us-saas-test-public';

const origin = 'https://sandbox.example', actor = randomUUID(), requestId = randomUUID(), organizationId = randomUUID(), creationId = randomUUID();
const now = Math.floor(Date.now()/1000);
let intent: WorkspaceCreationIntent, config: UsTestBillingConfiguration, purchase: UsTestPurchase | null, session: UsTestSession | null, deps: UsTestBillingDependencies;
function request(body?: unknown, path = '', headers: Record<string,string> = {}) {
  return new Request(`${origin}/api/international/billing/test${path}${body === undefined ? '?requestId='+requestId : ''}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type':'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const checkout = () => ({ requestId, module:'gestion', plan:'fixture_us', confirmTest:true });
function paidProof(p: UsTestPurchase, s: UsTestSession, eventId = 'recovery') {
  const authority: SaasSubscriptionAuthority = { kind:'saas_subscription_authority', organizationId, subscriptionId:'sub_fixture', offer:p.offer, status:'active', evidence:{ kind:'verified_payment', referenceId:'in_fixture', organizationId, subscriptionId:'sub_fixture', environment:'TEST', catalogVersion:p.offer.catalogVersion, priceId:p.offer.priceId, currency:'USD', startsAt:now-1, endsAt:now+86400, revoked:false } };
  const price: ServerStripePrice = { id:p.offer.priceId, active:true, livemode:false, currency:'usd', unit_amount:1000, type:'recurring', tax_behavior:'exclusive', recurring:{ interval:'month', interval_count:1, usage_type:'licensed' }, product:{ id:p.offer.productId, active:true } };
  return verifiedUsTestPaidProof(p, { purchaseId:p.purchaseId, sessionId:s.sessionId, customerId:'cus_fixture', subscriptionId:'sub_fixture', invoiceId:'in_fixture', eventId, providerAccountId:p.providerAccountId, authority, serverPrice:price, verifiedAt:now });
}
beforeEach(() => {
  const configuration = { schemaVersion:1 as const, organizationId, country:'US' as const, currency:'USD' as const, language:'en' as const, timeZone:'America/New_York', address:{ country:'US' as const, line1:'1 Fictitious St', city:'New York', subdivision:'NY', postalCode:'10001' }, accountingBasis:'accrual' as const, invoiceNumberPrefix:'INV', taxConfiguration:{ status:'unconfigured' as const } };
  const stamp = new Date(now*1000).toISOString(), fingerprint = 'a'.repeat(64);
  intent = { creationId, organizationId, actorUserId:actor, requestId, confirmationVersion:1, companyName:'Fictitious Company', fingerprint, configuration, state:'postgres_confirmed', receipt:{ creationId, organizationId, actorUserId:actor, requestId, configurationFingerprint:fingerprint, configuration, revision:1, updatedBy:actor, updatedAt:stamp, replayed:false }, createdAt:stamp, updatedAt:stamp };
  config = { providerAccountId:'acct_fixture', siteOrigin:origin, policy:{ environment:'TEST', now, catalog:[{ seatLimit:3, offer:{ kind:'saas_subscription', catalogVersion:'fixture_catalog', country:'US', currency:'USD', module:'gestion', plan:'fixture_us', priceId:'price_fixture', productId:'prod_fixture', environment:'TEST', unitAmountMinor:'1000', interval:'month', intervalCount:1, taxBehavior:'exclusive' } }] } };
  purchase = null; session = null;
  const store = { find:vi.fn(async () => purchase), bySession:vi.fn(async (id:string) => session?.sessionId === id ? purchase : null), reserve:vi.fn(async (_intent:WorkspaceCreationIntent, candidate:UsTestPurchase, fresh:()=>Promise<void>) => { await fresh(); purchase ??= candidate; return purchase; }), bind:vi.fn(async (_purchase:UsTestPurchase, candidate:UsTestSession, fresh:()=>Promise<void>) => { await fresh(); session ??= candidate; return session; }), session:vi.fn(async () => session), admit:vi.fn(async (_intent:WorkspaceCreationIntent, _purchase:UsTestPurchase, _session:UsTestSession, proof:ReturnType<typeof paidProof>, _candidate:unknown, fresh:()=>Promise<void>) => { await fresh(); intent = { ...intent, state:'ready', ownSubscriptionId:proof.subscriptionId }; return intent; }) };
  const gateway = { create:vi.fn(async (p:UsTestPurchase) => ({ session:verifiedUsTestSession(p, { purchaseId:p.purchaseId, sessionId:'cs_test_fixture', customerId:null, subscriptionId:null, createdAt:now, expiresAt:p.expiresAt }), url:'https://checkout.stripe.com/c/pay/cs_test_fixture#payment' })), locate:vi.fn(async () => ({ sessionId:'cs_test_fixture', eventId:'evt_fixture' })), verify:vi.fn(async (p:UsTestPurchase,s:UsTestSession,event:string) => paidProof(p,s,event)) };
  deps = { enabled:vi.fn(() => true), configuration:vi.fn(() => config), user:vi.fn(async () => ({ userId:actor })), creations:vi.fn(() => ({ find:vi.fn(async (user:string,id:string) => user === actor && id === requestId ? intent : null), reserve:vi.fn(), confirm:vi.fn() })), purchases:vi.fn(() => store), gateway:vi.fn(() => gateway), confirmCreation:vi.fn(async (value,fresh) => { await fresh(); intent = { ...value, state:'postgres_confirmed', receipt:intent.receipt }; return intent; }), verifyEvent:vi.fn(async () => ({ fixture:true })), rateLimit:vi.fn(async () => {}), now:()=>now, allocateId:()=>randomUUID(), integrationIdentifier:()=>'zentra_us_test_abcdefgh', diagnostic:vi.fn() };
});
async function start() { const response = await createUsTestBillingHandlers(deps).POST(request(checkout())); expect(response.status).toBe(200); return response; }
const webhook = () => new Request(origin+'/api/international/billing/test/webhook', { method:'POST', headers:{ 'Stripe-Signature':'fixture_signature' }, body:'{"id":"evt_fixture"}' });
describe('US initial TEST billing HTTP boundary', () => {
  it('reserves before external create; Checkout return does not grant access', async () => {
    const gateway = await deps.gateway(); vi.mocked(gateway.create).mockImplementationOnce(async p => { expect(purchase?.purchaseId).toBe(p.purchaseId); return { session:verifiedUsTestSession(p,{ purchaseId:p.purchaseId, sessionId:'cs_test_fixture', customerId:null, subscriptionId:null, createdAt:now, expiresAt:p.expiresAt }), url:'https://checkout.stripe.com/c/pay/cs_test_fixture' }; });
    const response = await start(); const body = await response.json() as UsTestPublicState; expect(body.purchase.state).toBe('checkout_pending'); expect(intent.state).toBe('postgres_confirmed'); expect((await deps.purchases()).admit).not.toHaveBeenCalled();
  });
  it('retries a lost provider response using the SAME durable purchase', async () => {
    const gateway = await deps.gateway(); vi.mocked(gateway.create).mockRejectedValueOnce(new Error('secret upstream body'));
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout()))).status).toBe(503); const saved = purchase;
    await start(); expect(purchase).toBe(saved); expect(gateway.create).toHaveBeenCalledTimes(2); expect(vi.mocked(gateway.create).mock.calls[0][0]).toEqual(vi.mocked(gateway.create).mock.calls[1][0]);
  });
  it('recovers a verified payment and returns READY only after admission', async () => {
    await start(); const response = await createUsTestBillingHandlers(deps).RECOVER(request({requestId},'/recover'));
    expect(response.status).toBe(200); expect((await response.json() as UsTestPublicState).purchase.state).toBe('ready'); expect(intent.ownSubscriptionId).toBe('sub_fixture'); expect((await deps.purchases()).admit).toHaveBeenCalledOnce();
  });
  it('rebinds an uncertain create before verified recovery', async () => {
    await start(); session = null;
    expect((await createUsTestBillingHandlers(deps).RECOVER(request({requestId},'/recover'))).status).toBe(200); expect(session).not.toBeNull();
  });
  it('does not infer access from a success query or GET', async () => {
    await start(); const response = await createUsTestBillingHandlers(deps).GET(new Request(origin+'/api/international/billing/test?requestId='+requestId+'&checkout=returned'));
    expect(response.status).toBe(200); expect((await response.json() as UsTestPublicState).purchase.state).toBe('checkout_pending'); expect((await deps.gateway()).verify).not.toHaveBeenCalled();
  });
  it('rejects price, authority, organization and unknown fields in the public request', async () => {
    for (const field of ['priceId','authority','organizationId','seatLimit']) expect((await createUsTestBillingHandlers(deps).POST(request({...checkout(),[field]:'forged'}))).status).toBe(422);
    expect((await deps.gateway()).create).not.toHaveBeenCalled();
  });
  it('does not allow a plan switch to create a second initial Checkout', async () => {
    await start(); const offer = config.policy.catalog[0].offer; config = {...config,policy:{...config.policy,catalog:[...config.policy.catalog,{seatLimit:10,offer:{...offer,plan:'other',priceId:'price_other'}}]}};
    expect((await createUsTestBillingHandlers(deps).POST(request({...checkout(),plan:'other'}))).status).toBe(409); expect((await deps.gateway()).create).toHaveBeenCalledOnce();
  });
  it('does not grant on an unpaid or unverified proof', async () => {
    await start(); const gateway = await deps.gateway(); vi.mocked(gateway.verify).mockRejectedValueOnce(new UsTestBillingError('payment_unconfirmed',409));
    expect((await createUsTestBillingHandlers(deps).RECOVER(request({requestId},'/recover'))).status).toBe(409);
    vi.mocked(gateway.verify).mockImplementationOnce(async (p,s) => ({...paidProof(p,s)}));
    expect((await createUsTestBillingHandlers(deps).RECOVER(request({requestId},'/recover'))).status).toBe(422); expect((await deps.purchases()).admit).not.toHaveBeenCalled();
  });
  it('rejects an unverified create response and malicious checkout URL', async () => {
    const gateway = await deps.gateway(); vi.mocked(gateway.create).mockImplementationOnce(async p => ({session:{...verifiedUsTestSession(p,{purchaseId:p.purchaseId,sessionId:'cs_test_fixture',customerId:null,subscriptionId:null,createdAt:now,expiresAt:p.expiresAt})},url:'https://checkout.stripe.com/c/pay/fixture'}));
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout()))).status).toBe(422); expect(session).toBeNull();
    vi.mocked(gateway.create).mockImplementationOnce(async p => ({session:verifiedUsTestSession(p,{purchaseId:p.purchaseId,sessionId:'cs_test_fixture',customerId:null,subscriptionId:null,createdAt:now,expiresAt:p.expiresAt}),url:'https://checkout.stripe.com.evil.example/pay'}));
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout()))).status).toBe(503);
  });
  it('rejects device bearer credentials without browser fallback', async () => {
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout(),'',{Authorization:'Bearer zus_fixture'}))).status).toBe(401); expect(deps.user).not.toHaveBeenCalled();
  });
  it('rejects an expected-account mismatch before any write', async () => {
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout(),'',{'X-Zentra-Expected-User':randomUUID()}))).status).toBe(401); expect(purchase).toBeNull();
  });
  it('rechecks the user after provider response', async () => {
    const gateway = await deps.gateway(); vi.mocked(gateway.create).mockImplementationOnce(async p => { vi.mocked(deps.user).mockResolvedValue({userId:randomUUID()}); return {session:verifiedUsTestSession(p,{purchaseId:p.purchaseId,sessionId:'cs_test_fixture',customerId:null,subscriptionId:null,createdAt:now,expiresAt:p.expiresAt}),url:null}; });
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout()))).status).toBe(401); expect(session).toBeNull();
  });
  it.each(['create', 'verify', 'configuration'] as const)('prioritizes account loss on a rejected %s await', async failureAt => {
    const gateway = await deps.gateway();
    if (failureAt === 'verify') await start();
    const rejectAfterAccountLoss = async () => { vi.mocked(deps.user).mockResolvedValue(null); throw new Error('private upstream failure'); };
    if (failureAt === 'create') vi.mocked(gateway.create).mockImplementationOnce(rejectAfterAccountLoss);
    else if (failureAt === 'verify') vi.mocked(gateway.verify).mockImplementationOnce(rejectAfterAccountLoss);
    else vi.mocked(deps.configuration).mockImplementationOnce(() => config).mockImplementationOnce(rejectAfterAccountLoss);
    const response = failureAt === 'verify'
      ? await createUsTestBillingHandlers(deps).RECOVER(request({requestId}, '/recover'))
      : await createUsTestBillingHandlers(deps).POST(request(checkout()));
    expect(response.status).toBe(401); expect((await deps.purchases()).admit).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('private upstream');
  });
  it('exposes only the locked public offer needed to reopen the same pending checkout', async () => {
    await start(); const original = purchase;
    const response = await createUsTestBillingHandlers(deps).GET(request());
    const state = await response.json() as UsTestPublicState;
    expect(state.purchase).toEqual({state:'checkout_pending',expiresAt:now+3600,module:'gestion',plan:'fixture_us'});
    expect(JSON.stringify(state)).not.toContain('price_fixture');
    await start(); expect(purchase).toBe(original); expect((await deps.purchases()).admit).not.toHaveBeenCalled();
  });
  it('prioritizes account loss over a concurrently closed feature gate', async () => {
    const gateway = await deps.gateway(); vi.mocked(gateway.create).mockImplementationOnce(async p => { vi.mocked(deps.user).mockResolvedValue(null); vi.mocked(deps.enabled).mockReturnValue(false); return {session:verifiedUsTestSession(p,{purchaseId:p.purchaseId,sessionId:'cs_test_fixture',customerId:null,subscriptionId:null,createdAt:now,expiresAt:p.expiresAt}),url:null}; });
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout()))).status).toBe(401); expect(session).toBeNull();
  });
  it('rechecks the gate and catalogue after slow provider verification', async () => {
    await start(); const gateway = await deps.gateway(); vi.mocked(gateway.verify).mockImplementationOnce(async (p,s) => { vi.mocked(deps.enabled).mockReturnValue(false); return paidProof(p,s); });
    expect((await createUsTestBillingHandlers(deps).RECOVER(request({requestId},'/recover'))).status).toBe(404); expect((await deps.purchases()).admit).not.toHaveBeenCalled();
    vi.mocked(deps.enabled).mockReturnValue(true); vi.mocked(gateway.verify).mockImplementationOnce(async (p,s) => { config = {...config,policy:{...config.policy,catalog:[]}}; return paidProof(p,s); });
    expect((await createUsTestBillingHandlers(deps).RECOVER(request({requestId},'/recover'))).status).toBe(409); expect((await deps.purchases()).admit).not.toHaveBeenCalled();
  });
  it('scopes reads to the authenticated creator', async () => {
    vi.mocked(deps.user).mockResolvedValue({userId:randomUUID()}); expect((await createUsTestBillingHandlers(deps).GET(request())).status).toBe(404); expect(deps.gateway).not.toHaveBeenCalled();
  });
  it('confirms a reserved PostgreSQL intent from server state before offering activation', async () => {
    intent = {...intent,state:'reserved'};
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout()))).status).toBe(409);
    const result = await createUsTestBillingHandlers(deps).RECOVER(request({requestId},'/recover')); expect(result.status).toBe(200); expect(deps.confirmCreation).toHaveBeenCalledOnce(); expect((await result.json() as UsTestPublicState).purchase.state).toBe('not_started');
  });
  it('verifies raw signed webhook before locator/database lookups; never calls browser Auth', async () => {
    await start(); vi.mocked(deps.user).mockClear(); vi.mocked(deps.verifyEvent).mockClear();
    const response = await createUsTestBillingHandlers(deps).WEBHOOK(webhook()); expect(response.status).toBe(200); expect(intent.state).toBe('ready'); expect(deps.verifyEvent).toHaveBeenCalledWith('{"id":"evt_fixture"}','fixture_signature'); expect(deps.user).not.toHaveBeenCalled();
  });
  it('returns retriable status when a signed webhook arrives before session binding', async () => {
    await start(); session = null; expect((await createUsTestBillingHandlers(deps).WEBHOOK(webhook())).status).toBe(503); expect(intent.state).toBe('postgres_confirmed'); expect((await deps.purchases()).admit).not.toHaveBeenCalled();
  });
  it('rejects a bad signature before touching purchase state', async () => {
    vi.mocked(deps.verifyEvent).mockRejectedValue(new UsTestBillingError('invalid_signature',400));
    expect((await createUsTestBillingHandlers(deps).WEBHOOK(webhook())).status).toBe(400); expect(deps.purchases).not.toHaveBeenCalled(); expect(deps.gateway).not.toHaveBeenCalled();
  });
  it('acknowledges unrelated signed events without a grant', async () => {
    vi.mocked((await deps.gateway()).locate).mockResolvedValue(null); expect((await createUsTestBillingHandlers(deps).WEBHOOK(webhook())).status).toBe(200); expect(deps.purchases).not.toHaveBeenCalled();
  });
  it('bounds bodies, rejects cross-origin writes and keeps diagnostics free of upstream errors', async () => {
    expect((await createUsTestBillingHandlers(deps).POST(request(checkout(),'',{Origin:'https://evil.example'}))).status).toBe(403);
    expect((await createUsTestBillingHandlers(deps).POST(request({...checkout(),plan:'x'.repeat(3000)}))).status).toBe(413);
    vi.mocked((await deps.gateway()).create).mockRejectedValue(new Error('secret_provider_key'));
    const result = await createUsTestBillingHandlers(deps).POST(request(checkout())); expect(await result.text()).toBe('{"error":"service_unavailable"}'); expect(JSON.stringify(vi.mocked(deps.diagnostic).mock.calls)).not.toContain('secret_provider_key'); expect(result.headers.get('Cache-Control')).toContain('no-store');
  });
});
