import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalErpJson, ErpError } from './erp-contract';
import { prepareStripeTaxResolvedRequest, STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest, type StripeTaxResolvedRequestInput } from './stripe-tax-resolved-request';
import { validateStripeTaxCalculation } from './stripe-tax-calculation';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import { createStripeTaxTestGateway, observeStripeTaxTestConfiguration, type StripeTaxTestSdkClient } from './stripe-tax-test-gateway';

/** MOCK SDK ONLY. No credential, real catalogue selection, Stripe API call,
 * registration, Auth, database write or legal/production verification occurs.
 * Provider-shaped bodies are deliberately fictitious technical test inputs. */
const start = '2026-10-08T12:00:00.000Z', accountId = 'acct_FictitiousGateway', organizationId = 'fictitious-gateway-workspace';
const hash = (value: unknown) => createHash('sha256').update(canonicalErpJson(value), 'utf8').digest('hex');
const address = { country: 'US' as const, line1: '123 Fictitious Road', city: 'New York', subdivision: 'NY', postalCode: '10001' };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Registration = { id: string; object: string; active_from: number; country: string; country_options: Record<string, unknown>; created: number; expires_at: number | null; livemode: boolean; status: string };
function registration(id = 'taxreg_FictitiousUS', country = 'US'): Registration {
  return { id, object: 'tax.registration', active_from: 1791374400, country, country_options: country === 'US' ? { us: { state: 'NY', type: 'state_sales_tax' } } : { de: { type: 'standard' } }, created: 1791370000, expires_at: null, livemode: false, status: 'active' };
}
function sdkResponse<T extends Record<string, unknown>>(body: T, metadata: Record<string, unknown> = { apiVersion: STRIPE_TAX_API_VERSION }): T {
  return Object.defineProperty(body, 'lastResponse', { value: metadata, enumerable: false, writable: false, configurable: false });
}
function calculation(params: ResolvedStripeTaxRequest['params']): Record<string, unknown> {
  const line = params.line_items[0], tax = 160;
  return {
    id: 'taxcalc_FictitiousGateway', object: 'tax.calculation', amount_total: line.amount + tax, currency: 'usd', customer: null,
    customer_details: { address: { ...params.customer_details.address, line2: null }, address_source: params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
    expires_at: Date.parse('2026-10-08T13:00:00.000Z') / 1000, tax_date: params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
    line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_FictitiousGateway/line_items', data: [{ id: 'tax_li_FictitiousGateway', object: 'tax.calculation_line_item', amount: line.amount, amount_tax: tax, quantity: line.quantity, reference: line.reference, tax_code: line.tax_code, tax_behavior: 'exclusive', livemode: false, product: null, tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Fictitious jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious tax', percentage_decimal: '8.0' } }] }] },
    tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
  };
}
async function fixture() {
  let time = start;
  const account = { id: accountId, object: 'account', country: 'US' };
  const balance = { object: 'balance', livemode: false, available: [], pending: [] };
  const settings = { object: 'tax.settings', livemode: false, status: 'active', defaults: { provider: 'stripe', tax_code: 'txcd_99999999', tax_behavior: 'exclusive' }, head_office: { address: { country: 'US', line1: address.line1, line2: null as string | null, city: address.city, state: address.subdivision, postal_code: address.postalCode } }, status_details: { active: {}, pending: null } };
  const registrations = [registration()];
  const state = { readMetadata: { apiVersion: STRIPE_TAX_API_VERSION } as Record<string, unknown>, calculationMetadata: null as Record<string, unknown> | null, pages: null as { data: Registration[]; has_more: boolean }[] | null };
  const calls: { method: string; params: unknown; options: unknown }[] = [];
  const note = (method: string, params: unknown, options: unknown) => { calls.push({ method, params: structuredClone(params), options: structuredClone(options) }); };
  const retrieveCurrent = vi.fn(async (params: unknown, options: unknown) => { note('account', params, options); return sdkResponse(structuredClone(account), { ...state.readMetadata }); });
  const retrieveBalance = vi.fn(async (params: unknown, options: unknown) => { note('balance', params, options); return sdkResponse(structuredClone(balance), { ...state.readMetadata }); });
  const retrieveSettings = vi.fn(async (params: unknown, options: unknown) => { note('settings', params, options); return sdkResponse(structuredClone(settings), { ...state.readMetadata }); });
  const listRegistrations = vi.fn(async (params: { starting_after?: string }, options: unknown) => {
    note('registrations', params, options);
    const index = params.starting_after ? state.pages?.findIndex(page => page.data.at(-1)?.id === params.starting_after) ?? -1 : -1;
    const page = state.pages ? state.pages[index + 1] : { data: registrations, has_more: false };
    return sdkResponse({ object: 'list', url: '/v1/tax/registrations', ...structuredClone(page) }, { ...state.readMetadata });
  });
  const retrieveCode = vi.fn(async (code: string, params: unknown, options: unknown) => {
    note('catalogue', { code, params }, options); return sdkResponse({ id: code, object: 'tax_code', name: 'Fictitious code', description: 'Technical existence only; not a legal classification' }, { ...state.readMetadata });
  });
  const createCalculation = vi.fn(async (params: ResolvedStripeTaxRequest['params'], options: { idempotencyKey: string }) => {
    note('calculate', params, options); return sdkResponse(calculation(params), state.calculationMetadata ?? { ...state.readMetadata, idempotencyKey: options.idempotencyKey });
  });
  // Explicit mock cast; these functions simulate the structural SDK boundary.
  // The exported production subset itself is checked against the actual SDK.
  const client = { accounts: { retrieveCurrent }, balance: { retrieve: retrieveBalance }, tax: { settings: { retrieve: retrieveSettings }, registrations: { list: listRegistrations }, calculations: { create: createCalculation } }, taxCodes: { retrieve: retrieveCode } } as unknown as StripeTaxTestSdkClient;
  const now = () => time;
  const options = { client, organizationId, accountId, now, allowTestFixtures: false as const };
  const configuration = { schemaVersion: 1 as const, organizationId, country: 'US' as const, currency: 'USD' as const, language: 'en' as const, timeZone: 'America/New_York', address, accountingBasis: 'accrual' as const, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' as const } };
  const context: Mutable<UsTaxFinancialContext> = {
    organizationId, actor: { organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp: start }, recordedAt: start, countryRevision: 1, configuration, sellerRevision: 2, seller: { displayName: 'Fictitious seller', contactEmail: 'seller@example.test' }, taxFactsRevision: 3,
    taxFacts: { schemaVersion: 1, legalName: 'Private fictitious legal company', taxOrigin: address, timeZone: 'America/New_York' },
    binding: { organizationId, accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 4, settingsSha256: hash(settings), registrationsSha256: hash(registrations), observedAt: '2026-10-08T11:00:00Z', validUntil: '2026-10-08T14:00:00Z', evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' },
  };
  const request: Mutable<StripeTaxResolvedRequestInput> = {
    organizationId, operationId: 'a5000000-0000-4000-8000-000000000001', invoiceId: 'fictitious-invoice', actorUserId: context.actor.userId, erpIdempotencyKey: 'fictitious-erp-key', commandHash: 'a'.repeat(64), expectedErpRevision: 5, countryRevision: 1, sellerRevision: 2, taxFactsRevision: 3,
    configuration, taxFacts: context.taxFacts, binding: context.binding,
    estimate: { id: 'estimate-fictitious', organizationId, revision: 2, currency: 'USD', number: 'EST-000001', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, notes: 'Fictitious mock SDK only', status: 'accepted', customer: { id: 'customer-fictitious', organizationId, kind: 'business', name: 'Fictitious customer', billingAddress: { ...address, line1: '456 Fictitious Customer Road' }, paymentTermsDays: 30 }, lines: [{ id: 'line-fictitious', description: 'Fictitious service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }] },
    classifications: [{ lineId: 'line-fictitious', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 1, evidenceReference: 'fictitious-confirmed-by-test-only' }], invoiceDate: '2026-10-08', taxDateInstant: start, taxDatePolicy: 'caller_supplied_invoice_instant', now: start, addressSource: 'billing',
  };
  const resolved = await prepareStripeTaxResolvedRequest(request);
  const gateway = createStripeTaxTestGateway(options);
  return { gateway, options, context, request, resolved, account, balance, settings, registrations, state, calls, retrieveCurrent, retrieveBalance, retrieveSettings, listRegistrations, retrieveCode, createCalculation, setTime: (value: string) => { time = value; }, rehash() { context.binding = { ...context.binding, settingsSha256: hash(settings), registrationsSha256: hash([...registrations].sort((a, b) => a.id < b.id ? -1 : 1)) }; } };
}
async function denied(promise: Promise<unknown>, code = 'service_unavailable'): Promise<void> {
  const error = await promise.then(() => null, error => error as unknown);
  expect(error).toBeInstanceOf(ErpError); expect(error).toMatchObject({ code, message: code });
  expect(error).not.toHaveProperty('cause'); expect(JSON.stringify(error)).not.toMatch(/sk_live_|sk_test_|PRIVATE|Fictitious|Road/);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.restoreAllMocks());

describe('inactive, injected Stripe22.6 TEST gateway (mock SDK evidence only)', () => {
  it('accepts the installed SDK structure and exposes no credential or environment fallback', async () => {
    const sdkAssignable = (client: Stripe): StripeTaxTestSdkClient => client; expect(sdkAssignable).toBeTypeOf('function');
    const source = readFileSync(new URL('./stripe-tax-test-gateway.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/process\.env|new Stripe\(|STRIPE_SECRET|console\.|stripeAccount\s*:/);
    const f = await fixture(); expect(f.calls).toEqual([]); expect(Object.isFrozen(f.gateway)).toBe(true);
    await denied(f.gateway.calculate(f.resolved), 'binding_unavailable'); await denied(f.gateway.readTaxCode('txcd_99999999'), 'binding_unavailable'); expect(f.calls).toEqual([]);
  });
  it('requires explicit false fixtures and fixed scoped identities at construction', async () => {
    const f = await fixture();
    for (const changed of [{ allowTestFixtures: true }, { allowTestFixtures: undefined }, { accountId: 'invalid' }, { organizationId: 'foreign space' }]) expect(() => createStripeTaxTestGateway({ ...f.options, ...changed } as never)).toThrowError(ErpError);
    expect(f.calls).toEqual([]);
  });
  it('observes own authenticated account, TEST balance, active settings and registrations without rewriting a binding', async () => {
    const f = await fixture(), original = structuredClone(f.context); await f.gateway.verify(f.context);
    expect(f.calls.map(call => call.method)).toEqual(['account', 'balance', 'settings', 'registrations']);
    for (const call of f.calls) expect(call.options).toEqual({ apiVersion: STRIPE_TAX_API_VERSION, maxNetworkRetries: 0, timeout: 20_000 });
    expect(f.calls[0].params).toEqual({}); expect(f.calls[3].params).toEqual({ status: 'active', limit: 100 }); expect(f.context).toEqual(original);
  });
  it('returns exact frozen params and key after independent preflight/postflight; actual private normalizer accepts the mock calculation', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const result = await f.gateway.calculate(f.resolved);
    expect(f.calls.map(call => call.method)).toEqual(['account', 'balance', 'settings', 'registrations', 'account', 'balance', 'settings', 'registrations', 'catalogue', 'calculate', 'account', 'balance', 'settings', 'registrations']);
    expect(f.createCalculation).toHaveBeenCalledOnce(); const [params, options] = f.createCalculation.mock.calls[0];
    expect(params).toEqual(f.resolved.params); expect(Object.isFrozen(params)).toBe(true); expect(Object.isFrozen(params.line_items[0])).toBe(true);
    expect(options).toEqual({ apiVersion: STRIPE_TAX_API_VERSION, maxNetworkRetries: 0, timeout: 20_000, idempotencyKey: f.resolved.idempotencyKey }); expect(Object.isFrozen(options)).toBe(true);
    expect(result).toMatchObject({ accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'provider_observation', observedAt: start });
    expect(result.calculation).not.toHaveProperty('lastResponse'); expect(result).not.toHaveProperty('revision'); expect(result).not.toHaveProperty('canIssue'); expect(Object.isFrozen(result.calculation)).toBe(true);
    expect((await validateStripeTaxCalculation(f.resolved, result, start)).assessment).toMatchObject({ currency: 'USD' });
  });
  it('reuses exactly the same idempotency key and parameters on explicit same-operation retry without SDK retries', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const first = await f.gateway.calculate(f.resolved); const second = await f.gateway.calculate(f.resolved);
    expect(second).toEqual(first); expect(f.createCalculation).toHaveBeenCalledTimes(2); expect(f.createCalculation.mock.calls[1]).toEqual(f.createCalculation.mock.calls[0]);
    expect(f.calls.filter(call => call.method === 'calculate').every(call => (call.options as { maxNetworkRetries: number }).maxNetworkRetries === 0)).toBe(true);
  });
  it('reads a technically existing tax code without a service classification or legal grant', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const result = await f.gateway.readTaxCode('txcd_99999999');
    expect(result).toEqual({ id: 'txcd_99999999', name: 'Fictitious code', description: 'Technical existence only; not a legal classification' }); expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty('kind'); expect(result).not.toHaveProperty('verified'); expect(result).not.toHaveProperty('taxable');
  });
  it.each(['txcd_1', ' txcd_99999999', 'txcd_99999999\n'])('refuses invalid technical code %s without a catalogue request', async code => {
    const f = await fixture(); await f.gateway.verify(f.context); await denied(f.gateway.readTaxCode(code), 'binding_unavailable'); expect(f.retrieveCode).not.toHaveBeenCalled();
  });
  it.each(['id', 'object'] as const)('refuses a catalogue %s mismatch instead of guessing a replacement code', async field => {
    const f = await fixture(); await f.gateway.verify(f.context); f.retrieveCode.mockImplementationOnce(async () => sdkResponse({ id: 'txcd_99999999', object: 'tax_code', name: 'Fictitious code', description: 'Fictitious description', [field]: 'wrong' }));
    await denied(f.gateway.calculate(f.resolved), 'tax_binding_changed'); expect(f.createCalculation).not.toHaveBeenCalled();
  });
});

describe('authenticated reads and exact binding snapshots', () => {
  it.each(['account', 'balance', 'settings', 'registration'] as const)('refuses live or foreign %s despite matching informational metadata', async part => {
    const f = await fixture(); f.state.readMetadata = { apiVersion: STRIPE_TAX_API_VERSION, stripeAccount: accountId };
    if (part === 'account') f.account.id = 'acct_Foreign'; else if (part === 'balance') f.balance.livemode = true; else if (part === 'settings') f.settings.livemode = true; else f.registrations[0].livemode = true;
    await denied(f.gateway.verify(f.context), part === 'account' ? 'tax_binding_changed' : 'binding_unavailable'); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it.each(['pending', 'unavailable'])('refuses tax settings status %s', async status => {
    const f = await fixture(); f.settings.status = status; await denied(f.gateway.verify(f.context), 'binding_unavailable');
  });
  it('refuses a third-party provider and never activates settings or registrations', async () => {
    const f = await fixture(); f.settings.defaults.provider = 'third_party'; await denied(f.gateway.verify(f.context), 'binding_unavailable');
    expect(f.calls.map(call => call.method)).toEqual(['account', 'balance', 'settings']);
  });
  it.each(['line1', 'line2', 'city', 'state', 'postal_code', 'country'] as const)('refuses origin %s mismatch rather than normalizing another address', async field => {
    const f = await fixture(); f.settings.head_office.address[field] = 'changed'; await denied(f.gateway.verify(f.context), 'tax_binding_changed'); expect(f.listRegistrations).not.toHaveBeenCalled();
  });
  it.each(['settingsSha256', 'registrationsSha256'] as const)('compares captured %s and never silently updates observedAt/revision', async field => {
    const f = await fixture(); f.context.binding = { ...f.context.binding, [field]: 'f'.repeat(64) }; const original = structuredClone(f.context.binding);
    await denied(f.gateway.verify(f.context), 'tax_binding_changed'); expect(f.context.binding).toEqual(original);
  });
  it('hashes full settings JSON, including non-address defaults', async () => {
    const f = await fixture(); f.settings.defaults.tax_code = 'txcd_11111111'; await denied(f.gateway.verify(f.context), 'tax_binding_changed');
  });
  it('hashes complete active registrations from every page sorted by id, including foreign countries', async () => {
    const f = await fixture(); const foreign = registration('taxreg_AForeign', 'DE'), us = registration('taxreg_ZUS'); f.registrations.splice(0, 1, us, foreign); f.rehash();
    f.state.pages = [{ data: [us], has_more: true }, { data: [foreign], has_more: false }]; await f.gateway.verify(f.context);
    expect(f.calls.filter(call => call.method === 'registrations').map(call => call.params)).toEqual([{ status: 'active', limit: 100 }, { status: 'active', limit: 100, starting_after: us.id }]);
    foreign.country_options = { de: { type: 'changed' } }; await denied(f.gateway.verify(f.context), 'tax_binding_changed');
  });
  it.each(['empty', 'foreign-only', 'duplicate', 'scheduled', 'future-start', 'future-created', 'expired'] as const)('refuses invalid registration set: %s', async kind => {
    const f = await fixture();
    if (kind === 'empty') f.registrations.length = 0; else if (kind === 'foreign-only') f.registrations[0].country = 'DE'; else if (kind === 'duplicate') f.registrations.push({ ...f.registrations[0] }); else if (kind === 'scheduled') f.registrations[0].status = 'scheduled'; else if (kind === 'future-start') f.registrations[0].active_from = Date.parse(start) / 1000 + 1; else if (kind === 'future-created') f.registrations[0].created = Date.parse(start) / 1000 + 1; else f.registrations[0].expires_at = Date.parse(start) / 1000;
    await denied(f.gateway.verify(f.context), 'binding_unavailable');
  });
  it('rejects pagination beyond ten pages instead of hashing an incomplete snapshot', async () => {
    const f = await fixture(); f.listRegistrations.mockImplementation(async () => sdkResponse({ object: 'list', url: '/v1/tax/registrations', data: [registration(`taxreg_Page${f.listRegistrations.mock.calls.length}`)], has_more: true }));
    await denied(f.gateway.verify(f.context), 'binding_unavailable'); expect(f.listRegistrations).toHaveBeenCalledTimes(10);
  });
  it('refuses empty continuation pages and does not loop indefinitely', async () => {
    const f = await fixture(); f.state.pages = [{ data: [], has_more: true }]; await denied(f.gateway.verify(f.context)); expect(f.listRegistrations).toHaveBeenCalledOnce();
  });
  it.each(['apiVersion', 'stripeAccount', 'idempotencyKey'] as const)('present read metadata %s mismatch is a rejection, never account proof', async field => {
    const f = await fixture(); f.state.readMetadata = { [field]: field === 'stripeAccount' ? 'acct_Foreign' : 'wrong' }; await denied(f.gateway.verify(f.context), 'tax_binding_changed');
  });
  it('accepts absent SDK headers only after authenticated account/mode/configuration observations', async () => {
    const f = await fixture(); f.state.readMetadata = {}; await f.gateway.verify(f.context); await f.gateway.calculate(f.resolved); expect(f.retrieveCurrent).toHaveBeenCalledTimes(3);
    f.balance.livemode = true; await denied(f.gateway.verify(f.context), 'binding_unavailable');
  });
});

describe('private context, expiry, immutable requests and failure handling', () => {
  it.each(['organization', 'role', 'entitlement', 'fixture', 'expired', 'future-binding', 'unconfigured', 'account', 'version'] as const)('refuses invalid captured context %s before any SDK call', async kind => {
    const f = await fixture();
    if (kind === 'organization') f.context.organizationId = 'foreign'; else if (kind === 'role') f.context.actor = { ...f.context.actor, role: 'member' }; else if (kind === 'entitlement') f.context.actor = { ...f.context.actor, managementEntitled: false }; else if (kind === 'fixture') f.context.binding = { ...f.context.binding, evidenceKind: 'test_fixture' }; else if (kind === 'expired') f.context.binding = { ...f.context.binding, validUntil: start }; else if (kind === 'future-binding') f.context.binding = { ...f.context.binding, observedAt: '2026-10-08T13:00:00Z' }; else if (kind === 'unconfigured') f.context.configuration = { ...f.context.configuration, taxConfiguration: { status: 'unconfigured' } }; else if (kind === 'account') f.context.binding = { ...f.context.binding, accountId: 'acct_Foreign' }; else f.context.binding = { ...f.context.binding, apiVersion: '2025-01-01.wrong' as never };
    const code = kind === 'organization' ? 'tenant_mismatch' : kind === 'role' ? 'financial_permission_required' : kind === 'entitlement' ? 'management_entitlement_required' : 'binding_unavailable';
    await denied(f.gateway.verify(f.context), code); expect(f.calls).toEqual([]);
  });
  it('expires the initial binding during an awaited account read', async () => {
    const f = await fixture(); f.retrieveCurrent.mockImplementationOnce(async () => { f.setTime('2026-10-08T14:00:00Z'); return sdkResponse(f.account); });
    await denied(f.gateway.verify(f.context), 'binding_unavailable'); expect(f.retrieveBalance).not.toHaveBeenCalled(); await denied(f.gateway.calculate(f.resolved), 'binding_unavailable');
  });
  it('expires the captured binding after calculation without returning an observation or retrying the provider', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); f.createCalculation.mockImplementationOnce(async params => { f.setTime('2026-10-08T14:00:00Z'); return sdkResponse(calculation(params)); });
    await denied(f.gateway.calculate(f.resolved), 'binding_unavailable'); expect(f.createCalculation).toHaveBeenCalledOnce(); expect(f.retrieveCurrent).toHaveBeenCalledTimes(2);
    await denied(f.gateway.calculate(f.resolved), 'binding_unavailable'); expect(f.createCalculation).toHaveBeenCalledOnce();
  });
  it('refuses microsecond time reversal and requires explicit new verification afterward', async () => {
    const f = await fixture(); f.setTime('2026-10-08T12:00:00.000002Z'); await f.gateway.verify(f.context); f.setTime('2026-10-08T12:00:00.000001Z');
    await denied(f.gateway.calculate(f.resolved), 'server_clock_unavailable'); await denied(f.gateway.calculate(f.resolved), 'binding_unavailable'); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it('fails closed when the trusted clock itself throws', async () => {
    const f = await fixture(); const gateway = createStripeTaxTestGateway({ ...f.options, now() { throw new Error('PRIVATE_CLOCK_DETAIL'); } });
    await denied(gateway.verify(f.context), 'server_clock_unavailable'); expect(f.calls).toEqual([]);
  });
  it('clears a prior verification after failed explicit re-verification', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); f.balance.livemode = true; await denied(f.gateway.verify(f.context), 'binding_unavailable'); f.balance.livemode = false;
    await denied(f.gateway.calculate(f.resolved), 'binding_unavailable'); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it.each(['actorUserId', 'countryRevision', 'sellerRevision', 'taxFactsRevision'] as const)('refuses independently valid resolved %s differing from captured verification', async field => {
    const f = await fixture(); await f.gateway.verify(f.context); const changed = { ...f.request, [field]: field === 'actorUserId' ? 'foreign-user' : 99 };
    const resolved = await prepareStripeTaxResolvedRequest(changed); await denied(f.gateway.calculate(resolved), 'tax_binding_changed'); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it('rejects a request with rewritten amount/hash/key before any calculation or preflight request', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const before = f.calls.length;
    await denied(f.gateway.calculate({ ...f.resolved, params: { ...f.resolved.params, line_items: [{ ...f.resolved.params.line_items[0], amount: 1 }] } }));
    expect(f.calls).toHaveLength(before); expect(f.createCalculation).not.toHaveBeenCalled();
  });
  it('detaches caller context before the first account await', async () => {
    const f = await fixture(), held = deferred<ReturnType<typeof sdkResponse<typeof f.account>>>(); f.retrieveCurrent.mockImplementationOnce(() => held.promise);
    const mutable = structuredClone(f.context), pending = f.gateway.verify(mutable); mutable.binding = { ...mutable.binding, accountId: 'acct_Foreign' }; mutable.taxFacts = { ...mutable.taxFacts, taxOrigin: { ...address, line1: 'Changed' } }; held.resolve(sdkResponse(f.account));
    await pending; await f.gateway.calculate(f.resolved); expect(f.createCalculation).toHaveBeenCalledOnce();
  });
  it('detaches the canonical resolved request before hash awaits and sends the original exact operation', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const digest = crypto.subtle.digest.bind(crypto.subtle), held = deferred<void>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { await held.promise; return digest(algorithm, bytes); });
    const mutable = structuredClone(f.resolved), pending = f.gateway.calculate(mutable);
    (mutable.params.line_items[0] as { amount: number }).amount = 9999; (mutable as { idempotencyKey: string }).idempotencyKey = 'changed'; held.resolve();
    await pending; expect(f.createCalculation.mock.calls[0][0]).toEqual(f.resolved.params); expect(f.createCalculation.mock.calls[0][1].idempotencyKey).toBe(f.resolved.idempotencyKey);
  });
  it('invalidates an in-flight calculation when an explicit new verification begins', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const held = deferred<Record<string, unknown>>(); f.createCalculation.mockImplementationOnce(() => held.promise);
    const pending = f.gateway.calculate(f.resolved); await vi.waitFor(() => expect(f.createCalculation).toHaveBeenCalledOnce()); await f.gateway.verify(f.context);
    held.resolve(sdkResponse(calculation(f.resolved.params))); await denied(pending, 'tax_binding_changed'); await f.gateway.calculate(f.resolved); expect(f.createCalculation).toHaveBeenCalledTimes(2);
  });
  it.each(['balance', 'settings', 'registrations'] as const)('postflight %s change refuses the calculation observation', async part => {
    const f = await fixture(); await f.gateway.verify(f.context); f.createCalculation.mockImplementationOnce(async params => {
      if (part === 'balance') f.balance.livemode = true; else if (part === 'settings') f.settings.defaults.tax_code = 'txcd_11111111'; else f.registrations[0].country_options = { us: { state: 'CA', type: 'state_sales_tax' } };
      return sdkResponse(calculation(params));
    });
    await denied(f.gateway.calculate(f.resolved), part === 'balance' ? 'binding_unavailable' : 'tax_binding_changed'); await denied(f.gateway.calculate(f.resolved), 'binding_unavailable');
  });
  it.each(['apiVersion', 'stripeAccount', 'idempotencyKey'] as const)('refuses calculation SDK metadata %s mismatch', async field => {
    const f = await fixture(); await f.gateway.verify(f.context); f.state.calculationMetadata = { [field]: field === 'stripeAccount' ? 'acct_Foreign' : 'wrong' };
    await denied(f.gateway.calculate(f.resolved)); expect(f.retrieveCurrent).toHaveBeenCalledTimes(2);
  });
  it('refuses a live calculation response even when prior observations were TEST', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); f.createCalculation.mockImplementationOnce(async params => sdkResponse({ ...calculation(params), livemode: true }));
    await denied(f.gateway.calculate(f.resolved), 'binding_unavailable');
  });
  it.each(['account', 'calculation'] as const)('sanitizes SDK %s exceptions containing private details', async phase => {
    const f = await fixture(); const privateError = new Error('PRIVATE sk_live_FICTITIOUS_ONLY https://private.invalid/path');
    if (phase === 'account') f.retrieveCurrent.mockRejectedValueOnce(privateError); else { await f.gateway.verify(f.context); f.createCalculation.mockRejectedValueOnce(privateError); }
    await denied(phase === 'account' ? f.gateway.verify(f.context) : f.gateway.calculate(f.resolved));
  });
  it('refuses a non-JSON SDK body without invoking its getter', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const getter = vi.fn(() => { throw new Error('PRIVATE_GETTER'); });
    f.createCalculation.mockImplementationOnce(async () => Object.defineProperty({ object: 'tax.calculation', livemode: false }, 'amount_total', { get: getter, enumerable: true }));
    await denied(f.gateway.calculate(f.resolved)); expect(getter).not.toHaveBeenCalled();
  });
  it('detaches the calculation before postflight await, so a transport peer cannot rewrite its body', async () => {
    const f = await fixture(); await f.gateway.verify(f.context); const body = calculation(f.resolved.params);
    f.createCalculation.mockImplementationOnce(async () => { f.retrieveCurrent.mockImplementationOnce(async () => { body.amount_total = 99999; return sdkResponse(f.account); }); return sdkResponse(body); });
    const observed = await f.gateway.calculate(f.resolved); expect((observed.calculation as { amount_total: number }).amount_total).toBe(2160); expect(body.amount_total).toBe(99999);
  });
});

describe('read-only configuration observation for an explicit protected binding (mock SDK only)', () => {
  it('uses the same real-read primitives and returns only detached private hashes/origin without a grant or write', async () => {
    const f = await fixture(); const result = await observeStripeTaxTestConfiguration({ ...f.options, taxOrigin: address });
    expect(result).toEqual({ organizationId, accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, settingsSha256: hash(f.settings), registrationsSha256: hash(f.registrations), observedAt: start, taxOrigin: address });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.taxOrigin)).toBe(true); expect(Object.keys(result).sort()).toEqual(['organizationId', 'accountId', 'mode', 'apiVersion', 'settingsSha256', 'registrationsSha256', 'observedAt', 'taxOrigin'].sort());
    expect(f.createCalculation).not.toHaveBeenCalled(); expect(f.retrieveCode).not.toHaveBeenCalled(); expect(result).not.toHaveProperty('revision'); expect(result).not.toHaveProperty('validUntil'); expect(result).not.toHaveProperty('canIssue');
  });
  it('detaches expected tax origin before an account await and hashes every active country without legal inference', async () => {
    const f = await fixture(), origin = { ...address }, held = deferred<ReturnType<typeof sdkResponse<typeof f.account>>>(); f.retrieveCurrent.mockImplementationOnce(() => held.promise);
    f.registrations.push(registration('taxreg_Foreign', 'DE')); const pending = observeStripeTaxTestConfiguration({ ...f.options, taxOrigin: origin }); origin.line1 = 'Changed'; held.resolve(sdkResponse(f.account));
    const result = await pending; expect(result.taxOrigin.line1).toBe(address.line1); expect(result.registrationsSha256).toBe(hash([...f.registrations].sort((a, b) => a.id < b.id ? -1 : 1)));
  });
  it.each(['live', 'inactive', 'wrong-account', 'wrong-origin', 'foreign-only', 'fixture'] as const)('bootstrap rejects %s without writes, defaults or replacement registrations', async kind => {
    const f = await fixture(); if (kind === 'live') f.balance.livemode = true; else if (kind === 'inactive') f.settings.status = 'pending'; else if (kind === 'wrong-account') f.account.id = 'acct_Foreign'; else if (kind === 'wrong-origin') f.settings.head_office.address.line1 = 'Foreign'; else if (kind === 'foreign-only') f.registrations[0].country = 'DE';
    await denied(observeStripeTaxTestConfiguration({ ...f.options, taxOrigin: address, ...(kind === 'fixture' ? { allowTestFixtures: true as never } : {}) }), kind === 'wrong-account' || kind === 'wrong-origin' ? 'tax_binding_changed' : 'binding_unavailable'); expect(f.createCalculation).not.toHaveBeenCalled();
  });
});
