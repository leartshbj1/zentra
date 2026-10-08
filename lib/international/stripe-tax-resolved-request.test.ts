import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { prepareStripeTaxResolvedRequest, validateResolvedStripeTaxRequest, STRIPE_TAX_API_VERSION, type StripeTaxResolvedRequestInput } from './stripe-tax-resolved-request';

/** Fictitious classifications/account observations only, no real catalogue code
 * determination, provider verification, registrations, Auth or grant evidence. */
function input(): StripeTaxResolvedRequestInput {
  const address = { country: 'US' as const, line1: '123 Fictitious Origin Road', city: 'New York', subdivision: 'NY', postalCode: '10001' };
  return {
    organizationId: 'fictitious-us-workspace', operationId: 'a1000000-0000-4000-8000-000000000001', invoiceId: 'fictitious-invoice', actorUserId: 'fictitious-owner', erpIdempotencyKey: 'fictitious-erp-operation', commandHash: 'a'.repeat(64), expectedErpRevision: 5, countryRevision: 1, sellerRevision: 2, taxFactsRevision: 3,
    configuration: { schemaVersion: 1, organizationId: 'fictitious-us-workspace', country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } },
    estimate: { id: 'estimate-1', organizationId: 'fictitious-us-workspace', revision: 2, currency: 'USD', number: 'EST-000001', customer: { id: 'customer-1', organizationId: 'fictitious-us-workspace', kind: 'business', name: 'Fictitious customer', billingAddress: { ...address, line1: '456 Fictitious Billing Street' }, shippingAddress: { ...address, line1: '789 Fictitious Service Location', line2: 'Suite 4' }, paymentTermsDays: 30 }, date: '2026-10-01', expiresAt: '2026-11-01', paymentTermsDays: 30, lines: [{ id: 'line-1', description: 'Fictitious service', quantityUnits: '2000', quantityScale: 3, unitPrice: { currency: 'USD', minorUnits: '1999' }, discountBasisPoints: 1250, taxTreatment: 'taxable' }], notes: 'Fictitious notes', status: 'accepted' },
    taxFacts: { schemaVersion: 1, legalName: 'Private Fictitious Legal Company', taxOrigin: address, timeZone: 'America/New_York' },
    binding: { organizationId: 'fictitious-us-workspace', accountId: 'acct_FictitiousTestOnly', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 4, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: '2026-10-08T11:00:00Z', validUntil: '2026-10-09T12:00:00Z', evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' },
    classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 7, evidenceReference: 'fictitious-server-classification' }], invoiceDate: '2026-10-08', taxDateInstant: '2026-10-08T08:00:00-04:00', taxDatePolicy: 'caller_supplied_invoice_instant', now: '2026-10-08T12:00:00Z', addressSource: 'billing',
  };
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
function change(transform: (value: Mutable<StripeTaxResolvedRequestInput>) => void): StripeTaxResolvedRequestInput { const value = structuredClone(input()); transform(value); return value; }
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
afterEach(() => vi.restoreAllMocks());

describe('private resolved Stripe Tax TEST calculation preparation', () => {
  it('uses exact discounted line TOTAL and integer quantity without multiplying twice or granting configured status', async () => {
    const result = await prepareStripeTaxResolvedRequest(input());
    expect(result.params.line_items).toEqual([{ amount: 3498, quantity: 2, reference: 'line-1', tax_code: 'txcd_99999999', tax_behavior: 'exclusive' }]);
    expect(result.netTotalMinor).toBe('3498'); expect(result.params.currency).toBe('usd');
    expect(result.params.expand).toEqual(['line_items.data.tax_breakdown']);
    expect(result.params.customer_details).toEqual({ address_source: 'billing', address: { country: 'US', line1: '456 Fictitious Billing Street', city: 'New York', state: 'NY', postal_code: '10001' } });
    expect(result.snapshots.configuration.taxConfiguration.status).toBe('unconfigured'); expect(result.binding.evidenceKind).toBe('test_fixture');
    expect(Object.keys(result.params).sort()).toEqual(['currency', 'customer_details', 'expand', 'line_items', 'tax_date']);
    expect(result.params).not.toHaveProperty('customer'); expect(result.params).not.toHaveProperty('shipping_cost'); expect(result.params).not.toHaveProperty('ship_from_details');
    expect(result.params.customer_details).not.toHaveProperty('taxability_override'); expect(result.params.customer_details).not.toHaveProperty('tax_ids');
    expect(result.params.tax_date).toBe(1791460800); expect(result.timeZone).toBe('America/New_York');
  });
  it('preserves original quantity units/scale and every tenant/private revision in detached frozen snapshots', async () => {
    const original = input(), result = await prepareStripeTaxResolvedRequest(original);
    expect(result).toMatchObject({ expectedErpRevision: 5, countryRevision: 1, sellerRevision: 2, taxFactsRevision: 3, sourceEstimateId: 'estimate-1', sourceEstimateRevision: 2 });
    expect(result.snapshots.estimate.lines[0]).toMatchObject({ quantityUnits: '2000', quantityScale: 3 });
    expect(result.snapshots.estimate).not.toBe(original.estimate);
    for (const part of [result, result.params, result.params.line_items, result.params.line_items[0], result.params.customer_details.address, result.snapshots.estimate, result.snapshots.estimate.lines, result.snapshots.estimate.lines[0].unitPrice, result.binding, result.classifications, result.classifications[0], result.snapshots.taxFacts.taxOrigin]) expect(Object.isFrozen(part)).toBe(true);
  });
  it('returns canonical UTF8 bodies and independently correct SHA256, with an opaque operation/account/mode-derived key', async () => {
    const result = await prepareStripeTaxResolvedRequest(input());
    expect(result.paramsBody).toBe(canonicalErpJson(result.params)); expect(result.paramsSha256).toBe(hash(result.paramsBody));
    expect(result.resolvedSha256).toBe(hash(result.resolvedBody)); expect(JSON.parse(result.resolvedBody)).toMatchObject({ paramsSha256: result.paramsSha256, binding: result.binding, snapshots: result.snapshots });
    expect(result.idempotencyKey).toBe(`ztax_test_${hash(canonicalErpJson(['zentra:us:stripe-tax:calculation:v1', result.organizationId, result.operationId, result.binding.accountId, result.binding.mode, result.resolvedSha256]))}`);
    expect(result.idempotencyKey).not.toMatch(/Fictitious|customer|owner|workspace|Legal|Street|acct_|@/);
    expect(JSON.parse(result.resolvedBody)).not.toHaveProperty('resolvedSha256'); expect(JSON.parse(result.resolvedBody)).not.toHaveProperty('idempotencyKey');
  });
  it('checking identical inputs later does not mint a different key or incorporate the fresh clock into persisted parameters', async () => {
    const first = await prepareStripeTaxResolvedRequest(input()), later = await prepareStripeTaxResolvedRequest(change(value => { value.now = '2026-10-08T12:05:00Z'; }));
    expect(later.resolvedBody).toBe(first.resolvedBody); expect(later.idempotencyKey).toBe(first.idempotencyKey);
    expect(JSON.parse(first.resolvedBody)).not.toHaveProperty('now');
  });
  it.each([
    ['operation', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.operationId = 'a1000000-0000-4000-8000-000000000002'; }],
    ['account', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.binding = { ...value.binding, accountId: 'acct_OtherFictitious' }; }],
    ['private revision', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.taxFactsRevision++; }],
    ['classification revision', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.classifications = [{ ...value.classifications[0], revision: 8 }]; }],
    ['private facts', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.taxFacts = { ...value.taxFacts, legalName: 'Another private TEST entity' }; }],
  ] as const)('changes immutable fingerprint for %s even when public amounts are identical', async (_label, transform) => {
    const first = await prepareStripeTaxResolvedRequest(input()), other = await prepareStripeTaxResolvedRequest(change(transform));
    expect(other.paramsSha256).toBe(first.paramsSha256); expect(other.resolvedSha256).not.toBe(first.resolvedSha256); expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
  });
  it('only uses shipping when explicitly selected, including line2, without inventing shipment costs for a service', async () => {
    const result = await prepareStripeTaxResolvedRequest(change(value => { value.addressSource = 'shipping'; }));
    expect(result.params.customer_details).toMatchObject({ address_source: 'shipping', address: { line1: '789 Fictitious Service Location', line2: 'Suite 4' } });
    expect(result.params).not.toHaveProperty('shipping_cost');
    await expect(prepareStripeTaxResolvedRequest(change(value => { value.addressSource = 'shipping'; value.estimate = { ...value.estimate, customer: { ...value.estimate.customer, shippingAddress: undefined } } as typeof value.estimate; }))).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it.each([
    ['foreign config', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.configuration = { ...value.configuration, organizationId: 'other' }; }],
    ['foreign customer', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.estimate = { ...value.estimate, customer: { ...value.estimate.customer, organizationId: 'other' } }; }],
    ['foreign binding', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.binding = { ...value.binding, organizationId: 'other' }; }],
  ] as const)('refuses %s before any provider preparation', async (_label, transform) => {
    await expect(prepareStripeTaxResolvedRequest(change(transform))).rejects.toMatchObject({ code: 'tenant_mismatch', status: 403 });
  });
  it.each([
    ['draft estimate', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.estimate = { ...value.estimate, status: 'draft' }; }],
    ['mixed exemption', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.estimate = { ...value.estimate, lines: [{ ...value.estimate.lines[0], taxTreatment: 'exempt' }] }; }],
    ['non-taxable', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.estimate = { ...value.estimate, lines: [{ ...value.estimate.lines[0], taxTreatment: 'non_taxable' }] }; }],
    ['goods classification', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.classifications = [{ ...value.classifications[0], kind: 'goods' }] as unknown as typeof value.classifications; }],
    ['inclusive classification', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.classifications = [{ ...value.classifications[0], taxBehavior: 'inclusive' }] as unknown as typeof value.classifications; }],
    ['fractional quantity', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.estimate = { ...value.estimate, lines: [{ ...value.estimate.lines[0], quantityUnits: '2500' }] }; }],
    ['free line', (value: Mutable<StripeTaxResolvedRequestInput>) => { value.estimate = { ...value.estimate, lines: [{ ...value.estimate.lines[0], discountBasisPoints: 10000 }] }; }],
  ] as const)('does not convert or silently reinterpret unsupported %s', async (_label, transform) => {
    await expect(prepareStripeTaxResolvedRequest(change(transform))).rejects.toMatchObject({ code: 'unsupported_tax_request' });
  });
  it('accepts 100 lines, rejects101 and checks exact matching classification coverage', async () => {
    const value = change(value => { value.estimate = { ...value.estimate, lines: Array.from({ length: 100 }, (_unused, index) => ({ ...value.estimate.lines[0], id: `line-${index}` })) }; value.classifications = value.estimate.lines.map(line => ({ ...value.classifications[0], lineId: line.id })); });
    expect((await prepareStripeTaxResolvedRequest(value)).params.line_items).toHaveLength(100);
    await expect(prepareStripeTaxResolvedRequest({ ...value, estimate: { ...value.estimate, lines: [...value.estimate.lines, { ...value.estimate.lines[0], id: 'line-100' }] }, classifications: [...value.classifications, { ...value.classifications[0], lineId: 'line-100' }] })).rejects.toMatchObject({ code: 'unsupported_tax_request' });
    await expect(prepareStripeTaxResolvedRequest({ ...value, classifications: value.classifications.map((_line, index) => value.classifications[index ? index : 1]) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(prepareStripeTaxResolvedRequest({ ...value, classifications: [{ ...value.classifications[0], lineId: 'missing' }, ...value.classifications.slice(1)] })).rejects.toMatchObject({ code: 'unsupported_tax_request' });
  });
  it('accepts only exactly safe integer cents and quantities and also bounds their sum', async () => {
    const safe = change(value => { value.estimate = { ...value.estimate, lines: [{ ...value.estimate.lines[0], quantityUnits: '1', quantityScale: 0, discountBasisPoints: 0, unitPrice: { currency: 'USD', minorUnits: String(Number.MAX_SAFE_INTEGER) } }] }; });
    expect((await prepareStripeTaxResolvedRequest(safe)).params.line_items[0].amount).toBe(Number.MAX_SAFE_INTEGER);
    await expect(prepareStripeTaxResolvedRequest({ ...safe, estimate: { ...safe.estimate, lines: [{ ...safe.estimate.lines[0], unitPrice: { currency: 'USD', minorUnits: '9007199254740992' } }] } })).rejects.toMatchObject({ code: 'unsupported_tax_request' });
    const quantity = change(value => { value.estimate = { ...value.estimate, lines: [{ ...value.estimate.lines[0], quantityUnits: '9007199254740991', quantityScale: 0, discountBasisPoints: 0, unitPrice: { currency: 'USD', minorUnits: '1' } }] }; });
    expect((await prepareStripeTaxResolvedRequest(quantity)).params.line_items[0].quantity).toBe(Number.MAX_SAFE_INTEGER);
    await expect(prepareStripeTaxResolvedRequest({ ...quantity, estimate: { ...quantity.estimate, lines: [{ ...quantity.estimate.lines[0], quantityUnits: '9007199254740992' }] } })).rejects.toMatchObject({ code: 'unsupported_tax_request' });
    await expect(prepareStripeTaxResolvedRequest({ ...safe, estimate: { ...safe.estimate, lines: [...safe.estimate.lines, { ...safe.estimate.lines[0], id: 'extra', unitPrice: { currency: 'USD', minorUnits: '1' } }] }, classifications: [...safe.classifications, { ...safe.classifications[0], lineId: 'extra' }] })).rejects.toMatchObject({ code: 'unsupported_tax_request' });
  });
  it.each([
    ['live mode', { mode: 'live' }], ['different API', { apiVersion: '2026-03-25.dahlia' }], ['wrong scope', { scope: 'saas_subscription' }], ['unverified evidence', { evidenceKind: 'declaration' }],
    ['expired', { validUntil: '2026-10-08T12:00:00Z' }], ['future observation', { observedAt: '2026-10-08T12:00:00.000001Z' }],
  ])('refuses binding %s without conferring authority', async (_label, patch) => {
    await expect(prepareStripeTaxResolvedRequest(change(value => { value.binding = { ...value.binding, ...patch } as typeof value.binding; }))).rejects.toMatchObject({ code: 'binding_unavailable' });
  });
  it('accepts the known observation kind structurally and compares microsecond validity without interpreting a fixture as verification', async () => {
    const result = await prepareStripeTaxResolvedRequest(change(value => { value.binding = { ...value.binding, evidenceKind: 'provider_observation', observedAt: '2026-10-08T12:00:00.000000Z', validUntil: '2026-10-08T12:00:00.000001Z' }; }));
    expect(result.binding.evidenceKind).toBe('provider_observation'); expect(result).not.toHaveProperty('canIssue'); expect(result).not.toHaveProperty('verified');
  });
  it('uses explicit DST fold instants in the declared zone and accepts minute offsets without an implicit UTC day', async () => {
    const at = (instant: string) => change(value => { value.invoiceDate = '2026-11-01'; value.taxDateInstant = instant; value.now = '2026-11-01T12:00:00Z'; value.binding = { ...value.binding, observedAt: '2026-11-01T00:00:00Z', validUntil: '2026-11-02T00:00:00Z' }; });
    const early = await prepareStripeTaxResolvedRequest(at('2026-11-01T01:30:00-04:00')), late = await prepareStripeTaxResolvedRequest(at('2026-11-01T01:30:00-05:00'));
    expect(late.params.tax_date - early.params.tax_date).toBe(3600);
    expect((await prepareStripeTaxResolvedRequest(at('2026-11-01T00:30:00-05:45'))).params.tax_date).toBe(early.params.tax_date + 2700);
    await expect(prepareStripeTaxResolvedRequest(change(value => { value.taxDateInstant = '2026-10-08T00:00:00Z'; }))).rejects.toMatchObject({ code: 'invalid_tax_date' });
  });
  it('enforces exact31day caller-clock bounds and whole Unix seconds', async () => {
    const boundary = (instant: string, date: string) => change(value => { value.taxDateInstant = instant; value.invoiceDate = date; });
    expect((await prepareStripeTaxResolvedRequest(boundary('2026-11-08T12:00:00Z', '2026-11-08'))).params.tax_date).toBe(1794139200);
    expect((await prepareStripeTaxResolvedRequest(boundary('2026-09-07T12:00:00Z', '2026-09-07'))).params.tax_date).toBe(1788782400);
    await expect(prepareStripeTaxResolvedRequest(boundary('2026-11-08T12:00:01Z', '2026-11-08'))).rejects.toMatchObject({ code: 'invalid_tax_date' });
    await expect(prepareStripeTaxResolvedRequest(boundary('2026-09-07T11:59:59Z', '2026-09-07'))).rejects.toMatchObject({ code: 'invalid_tax_date' });
    await expect(prepareStripeTaxResolvedRequest(boundary('2026-10-08T12:00:00.000001Z', '2026-10-08'))).rejects.toMatchObject({ code: 'invalid_tax_date' });
  });
  it.each(['2026-10-08', '2026-02-30T12:00:00Z', '2026-10-08T24:00:00Z', '2026-10-08T12:00:00+24:00', '2026-10-08T12:00:00.0000000Z'])('refuses malformed or implicit tax instant %s', async taxDateInstant => {
    await expect(prepareStripeTaxResolvedRequest({ ...input(), taxDateInstant })).rejects.toMatchObject({ code: 'invalid_tax_date' });
  });
  it.each(['\ud800', '\udc00'])('rejects isolatedUTF16 in a snapshot, preserving legal emoji pairs', async malformed => {
    await expect(prepareStripeTaxResolvedRequest(change(value => { value.taxFacts = { ...value.taxFacts, legalName: malformed }; }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(prepareStripeTaxResolvedRequest(change(value => { value.classifications = [{ ...value.classifications[0], evidenceReference: malformed }]; }))).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await prepareStripeTaxResolvedRequest(change(value => { value.taxFacts = { ...value.taxFacts, legalName: 'Valid TEST company 🧪' }; }))).snapshots.taxFacts.legalName).toBe('Valid TEST company 🧪');
  });
  it.each(['notes', 'nested key'] as const)('rejects PostgreSQL-unrepresentable NUL in %s before hashing', async field => {
    const digest = vi.spyOn(crypto.subtle, 'digest'), value = change(value => {
      if (field === 'notes') value.estimate = { ...value.estimate, notes: 'First\u0000second' };
      else value.estimate = { ...value.estimate, lines: [{ ...value.estimate.lines[0], unitPrice: Object.assign({}, value.estimate.lines[0].unitPrice, { ['private\u0000key']: 'value' }) }] };
    });
    await expect(prepareStripeTaxResolvedRequest(value)).rejects.toMatchObject({ code: 'invalid_request', status: 422 });
    expect(digest).not.toHaveBeenCalled();
  });
  it('preserves permitted multiline notes through preparation and durable revalidation', async () => {
    const value = change(value => { value.estimate = { ...value.estimate, notes: 'First line\nSecond line\r\nThird line' }; });
    const result = await prepareStripeTaxResolvedRequest(value);
    expect(result.snapshots.estimate.notes).toBe(value.estimate.notes);
    expect(await validateResolvedStripeTaxRequest(JSON.parse(JSON.stringify(result)), value.now)).toEqual(result);
  });
  it('never invokes nested getters or accepts injected shipping/authority fields', async () => {
    const getter = vi.fn(() => 'txcd_99999999'), value = input(); Object.defineProperty(value.classifications[0], 'taxCode', { get: getter, enumerable: true });
    await expect(prepareStripeTaxResolvedRequest(value)).rejects.toMatchObject({ code: 'invalid_request' }); expect(getter).not.toHaveBeenCalled();
    await expect(prepareStripeTaxResolvedRequest({ ...input(), canIssue: true } as StripeTaxResolvedRequestInput)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(prepareStripeTaxResolvedRequest({ ...input(), shippingCost: { amount: 0 } } as StripeTaxResolvedRequestInput)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('freezes every input before hash awaits so peer mutation cannot rewrite a pending operation', async () => {
    const actualDigest = crypto.subtle.digest.bind(crypto.subtle); let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await held; return actualDigest(algorithm, data); });
    const value = input(), pending = prepareStripeTaxResolvedRequest(value);
    (value.taxFacts as { legalName: string }).legalName = 'Changed during hash'; (value.binding as { accountId: string }).accountId = 'acct_Changed';
    (value.estimate.lines[0].unitPrice as { minorUnits: string }).minorUnits = '100000'; release();
    const result = await pending; expect(result.snapshots.taxFacts.legalName).toBe('Private Fictitious Legal Company'); expect(result.binding.accountId).toBe('acct_FictitiousTestOnly'); expect(result.params.line_items[0].amount).toBe(3498);
    expect(result.resolvedSha256).toBe(hash(result.resolvedBody));
  });
  it('revalidates an unknown durable DTO and every exact body/hash/key without binding to the old verification clock', async () => {
    const result = await prepareStripeTaxResolvedRequest(input()), fromRpc: unknown = JSON.parse(JSON.stringify(result));
    expect(await validateResolvedStripeTaxRequest(fromRpc, '2026-10-08T12:05:00Z')).toEqual(result);
    await expect(validateResolvedStripeTaxRequest(fromRpc, result.binding.validUntil)).rejects.toMatchObject({ code: 'binding_unavailable' });
  });
  it.each(['sourceEstimateId', 'sourceEstimateRevision', 'timeZone', 'netTotalMinor', 'paramsBody', 'resolvedBody', 'paramsSha256', 'resolvedSha256', 'idempotencyKey'] as const)('rejects a modified persisted %s instead of casting the RPC result', async field => {
    const result = await prepareStripeTaxResolvedRequest(input());
    await expect(validateResolvedStripeTaxRequest({ ...result, [field]: field === 'sourceEstimateRevision' ? 99 : 'tampered' }, input().now)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('refuses forged persisted parameters even if an attacker recomputes their public hash', async () => {
    const result = await prepareStripeTaxResolvedRequest(input());
    const params = { ...result.params, line_items: [{ ...result.params.line_items[0], amount: 1 }] }, paramsBody = canonicalErpJson(params);
    await expect(validateResolvedStripeTaxRequest({ ...result, params, paramsBody, paramsSha256: hash(paramsBody) }, input().now)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('validates persisted large accepted-document snapshots without introducing a smaller arbitrary replay string limit', async () => {
    const value = change(value => { value.estimate = { ...value.estimate, lines: Array.from({ length: 100 }, (_unused, index) => ({ ...value.estimate.lines[0], id: `line-${index}`, description: '🧪'.repeat(2000) })), notes: 'n'.repeat(20000) }; value.classifications = value.estimate.lines.map(line => ({ ...value.classifications[0], lineId: line.id })); });
    const result = await prepareStripeTaxResolvedRequest(value); expect(result.resolvedBody.length).toBeGreaterThan(20000);
    expect(await validateResolvedStripeTaxRequest(JSON.parse(JSON.stringify(result)), value.now)).toEqual(result);
  });
  it('rejects getters, unknown prototypes, symbols and private grant extensions in persisted projections without invoking anything', async () => {
    const result = await prepareStripeTaxResolvedRequest(input()), getter = vi.fn(() => result.params), withGetter = { ...result };
    Object.defineProperty(withGetter, 'params', { enumerable: true, get: getter });
    for (const value of [withGetter, Object.assign(Object.create({ inherited: true }), result), { ...result, [Symbol('grant')]: true }, { ...result, canIssue: true }]) await expect(validateResolvedStripeTaxRequest(value, input().now)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(getter).not.toHaveBeenCalled();
  });
});
