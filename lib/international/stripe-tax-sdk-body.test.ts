import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { extractStripeTaxSdkBody, assertStripeTaxSdkMetadata, StripeTaxSdkBodyError, type StripeTaxSdkExpectedMetadata } from './stripe-tax-sdk-body';
import { prepareStripeTaxResolvedRequest, STRIPE_TAX_API_VERSION, type StripeTaxResolvedRequestInput } from './stripe-tax-resolved-request';
import { validateStripeTaxCalculation } from './stripe-tax-calculation';

const expected: StripeTaxSdkExpectedMetadata = { accountId: 'acct_Fictitious', apiVersion: STRIPE_TAX_API_VERSION, idempotencyKey: 'ztax_test_' + 'a'.repeat(64) };
function response(body: Record<string, unknown> = { id: 'taxcalc_Fictitious', amount_total: 2160 }, metadata: unknown = { requestId: 'req_Fictitious', apiVersion: expected.apiVersion, stripeAccount: expected.accountId, idempotencyKey: expected.idempotencyKey }): Record<string, unknown> {
  return Object.defineProperty(body, 'lastResponse', { value: metadata, enumerable: false, writable: false, configurable: false });
}
function denied(fn: () => unknown, code = 'invalid_stripe_sdk_response'): void {
  expect(fn).toThrowError(StripeTaxSdkBodyError);
  try { fn(); } catch (error) { expect(error).toMatchObject({ code, status: 503, message: code }); expect(error).not.toHaveProperty('cause'); }
}

describe('strict Stripe22.6 SDK body extraction', () => {
  it('matches the installed descriptor and separates its metadata from JSON body', () => {
    const source = readFileSync(new URL('../../node_modules/stripe/esm/RequestSender.js', import.meta.url), 'utf8');
    expect(source).toMatch(/Object\.defineProperty\(jsonResponse, 'lastResponse', \{\s+enumerable: false,\s+writable: false,\s+value: rawResponse,/);
    const input = response(), result = extractStripeTaxSdkBody(input);
    expect(result.body).toEqual({ id: 'taxcalc_Fictitious', amount_total: 2160 }); expect(result.body).not.toHaveProperty('lastResponse');
    expect(result.metadata).toEqual({ requestId: 'req_Fictitious', apiVersion: expected.apiVersion, stripeAccount: expected.accountId, idempotencyKey: expected.idempotencyKey });
    expect(Object.getOwnPropertyDescriptor(input, 'lastResponse')).toMatchObject({ enumerable: false, writable: false, configurable: false });
    expect(() => assertStripeTaxSdkMetadata(result.metadata, expected)).not.toThrow();
  });
  it('accepts absent and own undefined SDK headers without inventing metadata or a grant', () => {
    for (const input of [{ id: 'taxcalc_Fictitious' }, response({ id: 'taxcalc_Fictitious' }, { requestId: undefined, apiVersion: undefined, stripeAccount: undefined, idempotencyKey: undefined })]) {
      const result = extractStripeTaxSdkBody(input); expect(result.metadata).toEqual({}); expect(() => assertStripeTaxSdkMetadata(result.metadata, expected)).not.toThrow();
      expect(result).not.toHaveProperty('verified'); expect(result).not.toHaveProperty('managementEntitled');
    }
  });
  it('accepts the real Fetch Response metadata container while ignoring neutral headers, sockets and host symbols', () => {
    const raw = new Response('{}'), getter = vi.fn(() => { throw new Error('Must not inspect transport internals'); });
    Object.defineProperty(raw, 'headers', { get: getter }); Object.defineProperty(raw, 'socket', { get: getter });
    Object.assign(raw, { requestId: 'req_Fictitious', apiVersion: expected.apiVersion });
    const result = extractStripeTaxSdkBody(response({ amount_total: 1 }, raw));
    expect(result.metadata).toEqual({ requestId: 'req_Fictitious', apiVersion: expected.apiVersion }); expect(getter).not.toHaveBeenCalled();
  });
  it('detaches and freezes nested body and metadata synchronously', () => {
    const body = { line_items: { data: [{ amount: 1 }] } }, meta = { requestId: 'req_Fictitious' }, result = extractStripeTaxSdkBody(response(body, meta));
    body.line_items.data[0].amount = 2; meta.requestId = 'req_Changed';
    const saved = result.body as typeof body; expect(saved.line_items.data[0].amount).toBe(1); expect(result.metadata.requestId).toBe('req_Fictitious');
    for (const value of [result, result.metadata, result.body, saved.line_items, saved.line_items.data, saved.line_items.data[0]]) expect(Object.isFrozen(value)).toBe(true);
  });
  it('refuses body and lastResponse getters without invoking them', () => {
    const getter = vi.fn(() => 'PRIVATE'), setter = vi.fn();
    for (const descriptor of [{ get: getter }, { set: setter }]) for (const key of ['amount_total', 'lastResponse']) denied(() => extractStripeTaxSdkBody(Object.defineProperty({}, key, { ...descriptor, enumerable: key !== 'lastResponse' })));
    expect(getter).not.toHaveBeenCalled(); expect(setter).not.toHaveBeenCalled();
  });
  it.each(['requestId', 'apiVersion', 'stripeAccount', 'idempotencyKey'] as const)('refuses metadata getter %s without invoking it', key => {
    const getter = vi.fn(() => 'PRIVATE'), meta = Object.defineProperty({}, key, { get: getter, enumerable: true });
    denied(() => extractStripeTaxSdkBody(response({}, meta))); expect(getter).not.toHaveBeenCalled();
  });
  it('ignores inherited metadata without executing it or treating it as an observation', () => {
    const getter = vi.fn(() => 'PRIVATE'), prototype = Object.defineProperty({}, 'stripeAccount', { get: getter });
    expect(extractStripeTaxSdkBody(response({}, Object.create(prototype))).metadata).toEqual({}); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['enumerable', 'writable', 'configurable'] as const)('refuses a lastResponse descriptor with %s enabled', flag => {
    denied(() => extractStripeTaxSdkBody(Object.defineProperty({}, 'lastResponse', { value: {}, enumerable: false, writable: false, configurable: false, [flag]: true })));
  });
  it('refuses lastResponse scalar/null/array and hidden known metadata fields', () => {
    for (const raw of [null, undefined, 'private', [], 1, Object.defineProperty({}, 'apiVersion', { value: expected.apiVersion })]) denied(() => extractStripeTaxSdkBody(Object.defineProperty({}, 'lastResponse', { value: raw, enumerable: false, writable: false, configurable: false })));
  });
  it('refuses unknown hidden body fields, top-level and nested symbols, prototypes and callable toJSON', () => {
    const toJSON = vi.fn(() => ({ verified: true }));
    const examples = [Object.defineProperty(response(), 'privateDebug', { value: 'PRIVATE' }), { [Symbol('hidden')]: true }, { nested: { [Symbol('hidden')]: true } }, Object.create({ inherited: true }), { nested: new Date() }, { toJSON }, []];
    for (const input of examples) denied(() => extractStripeTaxSdkBody(input)); expect(toJSON).not.toHaveBeenCalled();
  });
  it('normalizes reflective failures without exposing their private exception messages', () => {
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const input of [revoked.proxy, new Proxy({}, { ownKeys() { throw new Error('PRIVATE DETAILS'); } })]) denied(() => extractStripeTaxSdkBody(input));
  });
  it('retains private-json depth, cycle, Unicode, NUL and body-size bounds', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: unknown = null; for (let depth = 0; depth < 21; depth++) deep = { child: deep };
    for (const input of [{ value: cycle }, { value: deep }, { value: '\ud800' }, { value: '\u0000' }, { ['bad\u0000key']: 1 }, { body: 'x'.repeat(524_289) }]) denied(() => extractStripeTaxSdkBody(input));
    expect(extractStripeTaxSdkBody({ value: 'Valid 🧪\nmultiline' }).body).toEqual({ value: 'Valid 🧪\nmultiline' });
  });
  it('rejects malformed known metadata while leaving unknown transport data opaque', () => {
    for (const value of ['', ' leading', 'trailing ', 'PRIVATE\nDETAIL', '\ud800', '\u0000', 'x'.repeat(256), null, 1]) denied(() => extractStripeTaxSdkBody(response({}, { requestId: value })));
    const secret = { headers: { Authorization: 'FICTITIOUS_PRIVATE_ONLY' }, debug: 'FICTITIOUS_PRIVATE_ONLY' };
    const result = extractStripeTaxSdkBody(response({}, secret)); expect(JSON.stringify(result)).not.toContain('FICTITIOUS_PRIVATE_ONLY');
  });
});

describe('SDK observations compare with independent server scope', () => {
  it.each(['stripeAccount', 'apiVersion', 'idempotencyKey'] as const)('rejects observed %s mismatch without disclosing either value', key => {
    const wrong = key === 'stripeAccount' ? 'acct_Foreign' : key === 'apiVersion' ? '2025-01-01.old' : 'foreign-key';
    denied(() => assertStripeTaxSdkMetadata({ [key]: wrong }, expected), 'stripe_sdk_metadata_mismatch');
  });
  it('accepts each matching present observation and a clean requestId', () => {
    for (const metadata of [{ stripeAccount: expected.accountId }, { apiVersion: expected.apiVersion }, { idempotencyKey: expected.idempotencyKey }, { requestId: 'req_InformationalOnly' }]) expect(() => assertStripeTaxSdkMetadata(metadata, expected)).not.toThrow();
  });
  it('snapshots comparison arguments without executing getters or trusting unknown fields', () => {
    const getter = vi.fn(() => expected.accountId), captured = Object.defineProperty({}, 'accountId', { get: getter, enumerable: true }) as StripeTaxSdkExpectedMetadata;
    denied(() => assertStripeTaxSdkMetadata({}, captured)); expect(getter).not.toHaveBeenCalled();
    denied(() => assertStripeTaxSdkMetadata(Object.defineProperty({}, 'apiVersion', { get: getter, enumerable: true }), expected)); expect(getter).not.toHaveBeenCalled();
    for (const extra of [{ ...expected, grant: true }, Object.create(expected), { ...expected, accountId: 'foreign' }]) denied(() => assertStripeTaxSdkMetadata({}, extra));
    denied(() => assertStripeTaxSdkMetadata({ requestId: 'req_Fictitious', unexpected: 'PRIVATE' } as never, expected));
  });
});

it('round-trips a valid TEST calculation through SDK extraction and the actual private normalizer', async () => {
  const organizationId = 'fictitious-sdk-workspace', now = '2026-10-08T12:00:00.000Z', address = { country: 'US' as const, line1: '123 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
  const input: StripeTaxResolvedRequestInput = {
    organizationId, operationId: 'a4000000-0000-4000-8000-000000000001', invoiceId: 'fictitious-invoice', actorUserId: 'fictitious-owner', erpIdempotencyKey: 'fictitious-key', commandHash: 'a'.repeat(64), expectedErpRevision: 4, countryRevision: 1, sellerRevision: 1, taxFactsRevision: 1,
    configuration: { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } },
    taxFacts: { schemaVersion: 1, legalName: 'Fictitious private TEST company', taxOrigin: address, timeZone: 'America/New_York' },
    binding: { organizationId, accountId: expected.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: '2026-10-08T11:00:00Z', validUntil: '2026-10-08T14:00:00Z', evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' },
    estimate: { id: 'fictitious-estimate', organizationId, revision: 2, currency: 'USD', number: 'EST-000001', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, notes: 'Fictitious only', status: 'accepted', customer: { id: 'fictitious-customer', organizationId, kind: 'business', name: 'Fictitious customer', billingAddress: address, paymentTermsDays: 30 }, lines: [{ id: 'fictitious-line', description: 'Fictitious service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }] },
    classifications: [{ lineId: 'fictitious-line', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 1, evidenceReference: 'fictitious-not-a-real-catalogue-selection' }], invoiceDate: '2026-10-08', taxDateInstant: now, taxDatePolicy: 'caller_supplied_invoice_instant', now, addressSource: 'billing',
  };
  const resolved = await prepareStripeTaxResolvedRequest(input), line = { id: 'tax_li_Fictitious', object: 'tax.calculation_line_item', amount: 2000, amount_tax: 160, quantity: 2, reference: 'fictitious-line', tax_code: 'txcd_99999999', tax_behavior: 'exclusive', livemode: false, product: null, tax_breakdown: [{ amount: 160, taxable_amount: 2000, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'New York' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious tax', percentage_decimal: '8.0' } }] };
  const json = { id: 'taxcalc_Fictitious', object: 'tax.calculation', amount_total: 2160, currency: 'usd', customer: null, customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: 'billing', ip_address: null, tax_ids: [], taxability_override: 'none' }, expires_at: Date.parse('2026-10-08T13:00:00.000Z') / 1000, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: 160, tax_amount_inclusive: 0, line_items: { object: 'list', has_more: false, data: [line] }, tax_breakdown: [{ amount: 160, taxable_amount: 2000, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }] };
  const observation = { accountId: expected.accountId, mode: 'test' as const, apiVersion: expected.apiVersion, evidenceKind: 'test_fixture' as const, observedAt: now };
  const plain = await validateStripeTaxCalculation(resolved, { ...observation, calculation: json }, now);
  const sdk = extractStripeTaxSdkBody(response(json, { requestId: 'req_Fictitious', apiVersion: expected.apiVersion, stripeAccount: expected.accountId, idempotencyKey: resolved.idempotencyKey }));
  assertStripeTaxSdkMetadata(sdk.metadata, { ...expected, idempotencyKey: resolved.idempotencyKey });
  expect(await validateStripeTaxCalculation(resolved, { ...observation, calculation: sdk.body }, now)).toEqual(plain);
  expect(JSON.stringify(plain)).not.toContain('req_Fictitious'); expect(JSON.stringify(sdk.body)).not.toContain('lastResponse');
});
