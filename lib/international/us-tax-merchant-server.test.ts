import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import type { StripeTaxTestConfigurationObservation } from './stripe-tax-test-gateway';
import type { CompanyConfiguration } from './types';
import type { ResolvedUsTaxTestMerchant } from './us-tax-merchant-resolver';
import { createUsTaxMerchantHandlers, type UsTaxMerchantServerDependencies } from './us-tax-merchant-server';
import type { UsTaxMerchantActivation, UsTaxMerchantContext, UsTaxMerchantReceipt, UsTaxMerchantStore } from './us-tax-merchant-store';

const organizationId = 'fictitious-merchant-US', requestId = 'a69ee7e4-f246-4058-9d64-e647336e85a6';
const now = '2026-10-10T12:00:00.000000Z';
const actor: FinancialAuthority = { organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp: now };
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Road', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const context: UsTaxMerchantContext = { organizationId, countryRevision: 4, configuration, sellerRevision: 2, seller: { displayName: 'Fictitious Merchant', contactEmail: 'fiction@example.test' }, taxFactsRevision: 3, taxFacts: { schemaVersion: 1, legalName: 'Fictitious Merchant LLC', taxOrigin: { country: 'US', line1: '2 Fictitious Road', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' }, bindingRevision: 0 };
const credential = { reference: 'fictitious-reference', revision: 3, accountId: 'acct_FictitiousMerchant' }, fingerprint = 'f'.repeat(64);
const url = `https://zentra.test/api/international/workspaces/${organizationId}/tax-merchant`;
const get = (suffix = '') => new Request(url + suffix, { headers: { 'X-Zentra-Expected-User': actor.userId } });
const post = (input: unknown = { requestId }, extra: Record<string, string> = {}) => new Request(url, { method: 'POST', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': actor.userId, ...extra }, body: JSON.stringify(input) });
type Change = 'user' | 'role' | 'mode' | 'scope' | 'entitlement' | 'revoked' | 'flags' | 'configuration' | 'credential' | 'fingerprint' | 'merchant';
const errors: Record<Change, readonly [number, string]> = { user: [401, 'session_changed'], role: [403, 'forbidden'], mode: [401, 'session_changed'], scope: [403, 'tenant_mismatch'], entitlement: [402, 'management_entitlement_required'], revoked: [401, 'unauthorized'], flags: [404, 'feature_unavailable'], configuration: [409, 'configuration_changed'], credential: [409, 'tax_binding_changed'], fingerprint: [409, 'tax_binding_changed'], merchant: [409, 'tax_binding_changed'] };
function fixture() {
  let current = structuredClone(context), admitted = { mode: 'browser' as 'browser' | 'device', actor: { ...actor } };
  let enabled = true, revoked = false, merchantAvailable = true, clockValue = now;
  let identity = { ...credential }, configurationFingerprint = fingerprint;
  const receipts = new Map<string, UsTaxMerchantReceipt>(), hooks: Record<string, (() => void) | undefined> = {};
  const after = (phase: string) => hooks[phase]?.();
  const observe = vi.fn(async (taxOrigin: typeof context.taxFacts.taxOrigin): Promise<StripeTaxTestConfigurationObservation> => {
    const value = { organizationId, accountId: identity.accountId, mode: 'test' as const, apiVersion: STRIPE_TAX_API_VERSION, settingsSha256: 'a'.repeat(64), registrationsSha256: 'b'.repeat(64), observedAt: clockValue, taxOrigin: structuredClone(taxOrigin) };
    after('observe'); return value;
  });
  const store = {
    readContext: vi.fn(async () => { const value = structuredClone(current); after('context'); return value; }),
    readReceipt: vi.fn(async (_actor, id) => { const value = receipts.get(id); after('receipt'); return value ? structuredClone(value) : null; }),
    readCredential: vi.fn(async () => ({ credential: structuredClone(identity), configurationFingerprint })),
    activate: vi.fn(async (_actor, input: UsTaxMerchantActivation) => {
      if (canonicalErpJson(input.context) !== canonicalErpJson(current)) throw new ErpError('tax_configuration_changed', 409);
      const configurationChanged = current.configuration.taxConfiguration.status === 'unconfigured';
      current = { ...current, countryRevision: current.countryRevision + (configurationChanged ? 1 : 0), bindingRevision: current.bindingRevision + 1, configuration: { ...current.configuration, taxConfiguration: { status: 'configured' } } };
      const receipt: UsTaxMerchantReceipt = { schemaVersion: 1, organizationId, requestId: input.requestId, actorUserId: _actor.userId, countryRevision: current.countryRevision, configurationChanged, configurationFingerprint: input.configurationFingerprint, credential: structuredClone(input.credential), binding: { organizationId, accountId: input.credential.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: current.bindingRevision, settingsSha256: input.observation.settingsSha256, registrationsSha256: input.observation.registrationsSha256, observedAt: input.observation.observedAt, validUntil: input.validUntil, evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' } };
      receipts.set(input.requestId, structuredClone(receipt)); after('activate'); return receipt;
    }),
  } satisfies UsTaxMerchantStore;
  const dependencies: UsTaxMerchantServerDependencies = {
    enabled: vi.fn(async () => { const value = enabled; after('enabled'); return value; }),
    authority: vi.fn(async () => { if (revoked) throw new AccountPublicError('private session rk_test_fiction', 401); const value = structuredClone(admitted); after('authority'); return value; }),
    configuration: vi.fn(async () => { const value = structuredClone(current.configuration); after('configuration'); return value; }),
    rateLimit: vi.fn(async () => { after('rateLimit'); }), diagnostic: vi.fn(), now: vi.fn(() => clockValue),
    merchant: vi.fn(async () => { const value: ResolvedUsTaxTestMerchant | null = merchantAvailable ? { credential: structuredClone(identity), configurationFingerprint, observe, gateway: {} as ResolvedUsTaxTestMerchant['gateway'] } : null; after('merchant'); return value; }),
    store: vi.fn(async () => { after('store'); return store; }),
  };
  function change(kind: Change) {
    if (kind === 'user') admitted.actor.userId = 'other-owner';
    if (kind === 'role') admitted.actor.role = 'admin';
    if (kind === 'mode') admitted.mode = 'device';
    if (kind === 'scope') admitted.actor.organizationId = 'other-company';
    if (kind === 'entitlement') admitted.actor.managementEntitled = false;
    if (kind === 'revoked') revoked = true;
    if (kind === 'flags') enabled = false;
    if (kind === 'configuration') current = { ...current, configuration: { ...current.configuration, language: 'fr' } };
    if (kind === 'credential') identity = { ...identity, revision: identity.revision + 1 };
    if (kind === 'fingerprint') configurationFingerprint = 'e'.repeat(64);
    if (kind === 'merchant') merchantAvailable = false;
  }
  function once(phase: string, callback: () => void) { hooks[phase] = () => { delete hooks[phase]; callback(); }; }
  function restore() { admitted = { mode: 'browser', actor: { ...actor } }; enabled = true; revoked = false; identity = { ...credential }; configurationFingerprint = fingerprint; merchantAvailable = true; Object.keys(hooks).forEach(key => delete hooks[key]); }
  return { dependencies, store, observe, hooks, once, change, restore, receipts, handler: createUsTaxMerchantHandlers(dependencies), current: () => current, setContext: (value: UsTaxMerchantContext) => { current = value; }, clock: (value: string) => { clockValue = value; }, admitted: () => admitted };
}
async function rejected(response: Response, status: number, error: string) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error });
  expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}
describe('owner US TEST merchant HTTP boundary', () => {
  it('GET is private-scope admitted but provider/read-only and exposes only its narrow projection', async () => {
    const t = fixture(), response = await t.handler.GET(get(), organizationId);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ schemaVersion: 1, organizationId, status: 'ready_to_observe', mode: 'test' });
    expect(t.observe).not.toHaveBeenCalled(); expect(t.store.activate).not.toHaveBeenCalled(); expect(t.store.readReceipt).not.toHaveBeenCalled();
    expect(t.current()).toEqual(context);
  });
  it('returns unavailable without a configured dedicated merchant or opening private storage', async () => {
    const t = fixture(); t.change('merchant'); expect(await (await t.handler.GET(get(), organizationId)).json()).toEqual({ schemaVersion: 1, organizationId, status: 'unavailable', mode: 'test' }); expect(t.dependencies.store).not.toHaveBeenCalled(); expect(t.observe).not.toHaveBeenCalled();
  });
  it('does not admit Auth, storage or merchant resolution when the gate is closed', async () => {
    const t = fixture(); t.change('flags'); await rejected(await t.handler.GET(get(), organizationId), 404, 'feature_unavailable'); await rejected(await t.handler.POST(post(), organizationId), 404, 'feature_unavailable'); expect(t.dependencies.authority).not.toHaveBeenCalled(); expect(t.dependencies.merchant).not.toHaveBeenCalled(); expect(t.dependencies.store).not.toHaveBeenCalled();
  });
  it.each(['admin', 'accountant', 'member', 'read_only'] as const)('refuses %s without reading private configuration', async role => {
    const t = fixture(); t.admitted().actor.role = role; await rejected(await t.handler.GET(get(), organizationId), 403, 'owner_permission_required'); await rejected(await t.handler.POST(post(), organizationId), 403, 'owner_permission_required'); expect(t.dependencies.configuration).not.toHaveBeenCalled(); expect(t.dependencies.merchant).not.toHaveBeenCalled();
  });
  it.each(['user', 'scope', 'entitlement', 'revoked'] as const)('refuses initial %s admission', async change => {
    const t = fixture(); t.change(change); await rejected(await t.handler.POST(post(), organizationId), ...errors[change]); expect(t.dependencies.store).not.toHaveBeenCalled(); expect(t.observe).not.toHaveBeenCalled();
  });
  it.each(['', '../private', 'invalid space', 'x'.repeat(129)])('rejects malformed scope %s before Auth', async scope => {
    const t = fixture(); await rejected(await t.handler.GET(get(), scope), 422, 'invalid_request'); expect(t.dependencies.authority).not.toHaveBeenCalled();
  });
  it.each(['?accountId=acct_private', '?requestId=x', '?secret=rk_test_private'])('refuses unsupported query %s', async suffix => {
    const t = fixture(); await rejected(await t.handler.GET(get(suffix), organizationId), 422, 'invalid_request'); expect(t.dependencies.authority).not.toHaveBeenCalled();
  });
  it('enforces the exported method exactly', async () => {
    const t = fixture(); await rejected(await t.handler.GET(post(), organizationId), 422, 'invalid_request'); await rejected(await t.handler.POST(get(), organizationId), 422, 'invalid_request'); expect(t.dependencies.authority).not.toHaveBeenCalled();
  });
  it.each([{ Origin: 'https://evil.test' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[])('refuses browser CSRF before Auth %j', async extra => {
    const t = fixture(); await rejected(await t.handler.POST(post({ requestId }, extra), organizationId), 403, 'forbidden'); expect(t.dependencies.authority).not.toHaveBeenCalled(); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('does not use a bearer header to bypass browser same-origin admission', async () => {
    const t = fixture(); await rejected(await t.handler.POST(post({ requestId }, { Authorization: 'Bearer invalid', Origin: 'https://evil.test' }), organizationId), 403, 'forbidden'); expect(t.dependencies.store).not.toHaveBeenCalled();
  });
  it('admits fresh device requests without cookie-origin fallback', async () => {
    const t = fixture(); t.admitted().mode = 'device'; const request = new Request(url, { method: 'POST', headers: { Authorization: 'Bearer fictitious-test-session', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': actor.userId }, body: JSON.stringify({ requestId }) }); const response = await t.handler.POST(request, organizationId); expect(response.status).toBe(200); expect(t.store.activate).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { requestId: 'not-uuid' }, { requestId: 1 }, { requestId, accountId: 'acct_forbidden' }, { requestId, taxOrigin: context.taxFacts.taxOrigin }, { requestId, settingsSha256: 'a'.repeat(64) }])('accepts only a UUID requestId %j', async input => {
    const t = fixture(); await rejected(await t.handler.POST(post(input), organizationId), 422, 'invalid_request'); expect(t.observe).not.toHaveBeenCalled(); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it.each([[{ 'Content-Length': '1025' }, 'x', 413], [{ 'Content-Type': 'text/plain' }, '{}', 415], [{}, '{broken', 400], [{}, ' '.repeat(1025), 413]] as const)('bounds body parsing and MIME %j', async (extra, body, status) => {
    const t = fixture(), request = new Request(url, { method: 'POST', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', ...extra }, body }); await rejected(await t.handler.POST(request, organizationId), status, 'invalid_request'); expect(t.observe).not.toHaveBeenCalled(); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('captures and activates precisely the private snapshots with a 120 second expiry', async () => {
    const t = fixture(), response = await t.handler.POST(post(), organizationId);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ schemaVersion: 1, organizationId, requestId, status: 'observed_test', replayed: false, configurationChanged: true }); expect(t.observe).toHaveBeenCalledExactlyOnceWith(context.taxFacts.taxOrigin);
    expect(vi.mocked(t.store.activate).mock.calls[0][1]).toMatchObject({ requestId, context, credential, configurationFingerprint: fingerprint, validUntil: '2026-10-10T12:02:00.000000Z' }); expect(t.current().countryRevision).toBe(5); expect(t.current().configuration.taxConfiguration.status).toBe('configured');
  });
  it('does not claim a country configuration change when the country was already configured', async () => {
    const t = fixture(); t.setContext({ ...context, configuration: { ...configuration, taxConfiguration: { status: 'configured' } } }); const response = await t.handler.POST(post(), organizationId); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ configurationChanged: false }); expect(t.current().countryRevision).toBe(4);
  });
  it('replays a historical actor receipt before any new observation or context read and never updates heads', async () => {
    const t = fixture(); expect((await t.handler.POST(post(), organizationId)).status).toBe(200); const head = { ...t.current(), countryRevision: 99, bindingRevision: 99, sellerRevision: 99 }; t.setContext(head); vi.mocked(t.store.readContext).mockClear(); t.observe.mockClear(); const response = await t.handler.POST(post(), organizationId); expect(response.status).toBe(200); expect(await response.json()).toEqual({ schemaVersion: 1, organizationId, requestId, status: 'observed_test', replayed: true, configurationChanged: true }); expect(t.observe).not.toHaveBeenCalled(); expect(t.store.readContext).not.toHaveBeenCalled(); expect(t.store.activate).toHaveBeenCalledTimes(1); expect(t.current()).toEqual(head);
  });
  it.each(['credential', 'fingerprint'] as const)('refuses historical receipt after %s rotation without observing', async change => {
    const t = fixture(); await t.handler.POST(post(), organizationId); t.change(change); t.observe.mockClear(); await rejected(await t.handler.POST(post(), organizationId), 409, 'tax_binding_changed'); expect(t.observe).not.toHaveBeenCalled(); expect(t.store.activate).toHaveBeenCalledTimes(1);
  });
  it('does not expose another actor receipt or accept extra receipt data', async () => {
    const t = fixture(); await t.handler.POST(post(), organizationId); const saved = t.receipts.get(requestId)!; t.receipts.set(requestId, { ...saved, actorUserId: 'someone-else' }); await rejected(await t.handler.POST(post(), organizationId), 503, 'service_unavailable'); expect(t.store.activate).toHaveBeenCalledTimes(1);
  });
  it.each(Object.keys(errors) as Change[])('refuses %s changed during read-only context access', async change => {
    const t = fixture(); t.once('context', () => t.change(change)); await rejected(await t.handler.GET(get(), organizationId), ...errors[change]); expect(t.observe).not.toHaveBeenCalled(); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it.each(Object.keys(errors) as Change[])('refuses %s changed during provider observation before write', async change => {
    const t = fixture(); t.once('observe', () => t.change(change)); await rejected(await t.handler.POST(post(), organizationId), ...errors[change]); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it.each(['rateLimit', 'store', 'receipt', 'context'] as const)('checks admission after %s resolves before any provider call', async phase => {
    const t = fixture(); t.once(phase, () => t.change('user')); await rejected(await t.handler.POST(post(), organizationId), 401, 'session_changed'); expect(t.observe).not.toHaveBeenCalled(); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it.each(['user', 'role', 'mode', 'scope', 'entitlement', 'revoked', 'flags', 'credential', 'fingerprint', 'merchant'] as const)('withholds a committed receipt on late %s then recovers the same receipt once', async change => {
    const t = fixture(); t.once('activate', () => t.change(change)); await rejected(await t.handler.POST(post(), organizationId), ...errors[change]); expect(t.store.activate).toHaveBeenCalledTimes(1); expect(t.receipts.size).toBe(1); t.restore(); const response = await t.handler.POST(post(), organizationId); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replayed: true, configurationChanged: true }); expect(t.observe).toHaveBeenCalledTimes(1); expect(t.store.activate).toHaveBeenCalledTimes(1);
  });
  it('withholds stale configuration success after a commit despite the legitimate tax status transition', async () => {
    const t = fixture(); t.once('activate', () => t.change('configuration')); await rejected(await t.handler.POST(post(), organizationId), 409, 'configuration_changed'); expect(t.receipts.size).toBe(1);
  });
  it('uses CAS for seller/facts revisions captured before external observation', async () => {
    const t = fixture(); t.once('observe', () => t.setContext({ ...t.current(), sellerRevision: 3, seller: { displayName: 'Changed Fictitious Merchant' } })); await rejected(await t.handler.POST(post(), organizationId), 409, 'tax_configuration_changed'); expect(t.receipts.size).toBe(0);
  });
  it('withholds a valid-looking receipt if the postcommit private country revision is different', async () => {
    const t = fixture(); t.once('activate', () => t.setContext({ ...t.current(), countryRevision: 6 })); await rejected(await t.handler.POST(post(), organizationId), 409, 'tax_configuration_changed'); expect(t.receipts.size).toBe(1);
  });
  it.each(['2026-10-10T11:59:59.999999Z', 'invalid', '2026-02-30T12:00:00Z'])('rejects a backward/invalid server clock %s', async time => {
    const t = fixture(); t.once('observe', () => t.clock(time)); await rejected(await t.handler.POST(post(), organizationId), 503, 'server_clock_unavailable'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('detects submillisecond clock regression instead of truncating it', async () => {
    const t = fixture(); t.clock('2026-10-10T12:00:00.000002Z'); t.once('observe', () => t.clock('2026-10-10T12:00:00.000001Z')); await rejected(await t.handler.POST(post(), organizationId), 503, 'server_clock_unavailable'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it.each(['2026-10-10T12:00:00.000001Z', '2026-10-10T11:59:59.999999Z'])('rejects future or backward fresh authority stamps %s', async timestamp => {
    const t = fixture(); t.once('observe', () => { t.admitted().actor.timestamp = timestamp; }); await rejected(await t.handler.POST(post(), organizationId), 503, 'server_clock_unavailable'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it.each(['2026-10-10T12:00:30.000000Z', '2026-10-10T12:00:31.000000Z'])('never writes after a late provider response %s', async time => {
    const t = fixture(); t.once('observe', () => t.clock(time)); await rejected(await t.handler.POST(post(), organizationId), 503, 'service_unavailable'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('includes revalidation time in the observation deadline before activation', async () => {
    const t = fixture(); t.once('observe', () => t.once('merchant', () => t.clock('2026-10-10T12:00:30.000000Z'))); await rejected(await t.handler.POST(post(), organizationId), 503, 'service_unavailable'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('withholds a late commit result and later replays without another provider observation', async () => {
    const t = fixture(); t.once('activate', () => t.clock('2026-10-10T12:00:31.000000Z')); const response = await t.handler.POST(post(), organizationId); expect(response.status).not.toBe(200); expect(t.receipts.size).toBe(1); const replay = await t.handler.POST(post(), organizationId); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ replayed: true }); expect(t.observe).toHaveBeenCalledTimes(1); expect(t.store.activate).toHaveBeenCalledTimes(1);
  });
  it.each(['2026-10-10T11:58:00.000000Z', '2026-10-10T12:00:00.000001Z'])('refuses expired or future provider observation %s', async observedAt => {
    const t = fixture(), original = t.observe.getMockImplementation()!; t.observe.mockImplementation(async origin => ({ ...await original(origin), observedAt })); await rejected(await t.handler.POST(post(), organizationId), 409, 'binding_unavailable'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('keeps the observation TTL attached to its captured date rather than the end of admission', async () => {
    const t = fixture(); t.once('observe', () => t.clock('2026-10-10T12:00:10.000000Z')); expect((await t.handler.POST(post(), organizationId)).status).toBe(200); expect(vi.mocked(t.store.activate).mock.calls[0][1].validUntil).toBe('2026-10-10T12:02:00.000000Z');
  });
  it.each(['accountId', 'mode', 'apiVersion', 'taxOrigin', 'settingsSha256', 'privateSecret'] as const)('rejects foreign or malformed observation %s without writing', async field => {
    const t = fixture(), original = t.observe.getMockImplementation()!; t.observe.mockImplementation(async origin => ({ ...await original(origin), [field]: 'rk_test_private' }) as StripeTaxTestConfigurationObservation); await rejected(await t.handler.POST(post(), organizationId), 503, 'service_unavailable'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('prioritizes revoked admission even when provider, configuration, resolver and gate all fail', async () => {
    const t = fixture(); t.observe.mockImplementation(async () => { t.change('revoked'); vi.mocked(t.dependencies.configuration).mockRejectedValue(new Error('private config')); vi.mocked(t.dependencies.merchant).mockRejectedValue(new Error('private key')); vi.mocked(t.dependencies.enabled).mockRejectedValue(new Error('private gate')); throw new Error('private provider'); }); await rejected(await t.handler.POST(post(), organizationId), 401, 'unauthorized'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it.each([new Error('rk_test_private acct_private EIN'), new ErpError('rk_test_private', 418), { code: 'rk_test_private', status: 403 }, Object.defineProperty({}, 'code', { get() { throw new Error('private getter executed'); } })])('sanitizes provider failures and diagnostic codes %j', async error => {
    const t = fixture(); t.observe.mockRejectedValue(error); await rejected(await t.handler.POST(post(), organizationId), 503, 'service_unavailable'); expect(t.dependencies.diagnostic).toHaveBeenLastCalledWith({ operation: 'write', code: 'service_unavailable', status: 503 }); expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic).mock.calls)).not.toContain('private'); expect(t.store.activate).not.toHaveBeenCalled();
  });
  it('uses fixed allowlist statuses and tolerates failed telemetry', async () => {
    const t = fixture(); t.observe.mockRejectedValue(new ErpError('binding_unavailable', 418)); vi.mocked(t.dependencies.diagnostic).mockImplementation(() => { throw new Error('private telemetry'); }); await rejected(await t.handler.POST(post(), organizationId), 409, 'binding_unavailable');
  });
  it('does not return account, credential provenance, private facts, hashes or an issuance grant', async () => {
    const t = fixture(); const result = JSON.stringify(await (await t.handler.POST(post(), organizationId)).json()); for (const privateValue of [credential.accountId, credential.reference, fingerprint, context.seller.displayName, context.taxFacts.legalName, context.taxFacts.taxOrigin.line1, 'grant', 'settingsSha256']) expect(result).not.toContain(privateValue);
  });
});
