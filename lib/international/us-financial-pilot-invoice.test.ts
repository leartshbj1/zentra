import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import { validateStripeTaxCalculation, type StripeTaxCalculationObservation } from './stripe-tax-calculation';
import { financialInvoiceClassificationEvidenceV5, resolveUsFinancialInvoicePreparationV5, validateUsFinancialInvoicePreparationV5, type UsFinancialInvoiceOperationV5, type UsFinancialInvoicePreparationV5 } from './us-financial-invoice-test';
import { validateUsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotInvoiceRequest, projectUsFinancialPilotInvoicePreview, usFinancialPilotInvoiceChoicesMatch,
  validateUsFinancialPilotInvoiceIssueRequest, validateUsFinancialPilotInvoicePreview, validateUsFinancialPilotInvoiceReceipt,
  validateUsFinancialPilotInvoiceRequest, validateUsFinancialPilotTaxCatalogue, type UsFinancialPilotInvoiceRequest } from './us-financial-pilot-invoice';

const requestId = 'a6000000-0000-4000-8000-000000000001', operationId = 'a6000000-0000-4000-8000-000000000002';
const now = '2026-10-10T12:00:00.000Z';
const input = (): UsFinancialPilotInvoiceRequest => ({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 5,
  command: { type: 'issue_invoice', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' },
  choices: { classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', confirmedService: true }], taxDateInstant: now, addressSource: 'billing' } });
const digest = (v: unknown) => sha256Hex(canonicalErpJson(v));
function observation(r: ResolvedStripeTaxRequest): StripeTaxCalculationObservation {
  const line = r.params.line_items[0], tax = 2475;
  return { accountId: r.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: { id: 'taxcalc_PilotSynthetic', object: 'tax.calculation', amount_total: line.amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...r.params.customer_details.address, line2: null }, address_source: r.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 3600, tax_date: r.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_PilotSynthetic/line_items', data: [{ id: 'tax_li_PilotSynthetic', object: 'tax.calculation_line_item', amount: line.amount, amount_tax: tax, quantity: line.quantity, reference: line.reference, tax_code: line.tax_code, tax_behavior: 'exclusive', livemode: false, product: null,
        tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Synthetic jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Synthetic tax', percentage_decimal: '8.25' } }] }] },
      tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.25', rate_type: 'percentage', flat_amount: null } }],
    } };
}
/** Real validators and resolved calculation; all authority/provider data are
 * synthetic. This unit fixture proves neither SQL admission nor tax law. */
async function prepared() {
  const f = await financialKernelFixture(), request = input(), built = buildUsFinancialPilotInvoiceRequest(request, f.configuration.organizationId);
  if (built.command.type !== 'erp_command') throw Error('Synthetic issue required');
  const erpRequest = { idempotencyKey: built.idempotencyKey, expectedRevision: built.expectedRevision, command: built.command.request };
  const financialCommandHash = await digest([f.configuration.organizationId, f.actor.userId, built]);
  const c = { schemaVersion: 1 as const, organizationId: f.configuration.organizationId, revision: 1, countryRevision: 1, configuration: f.configuration,
    sellerRevision: 1, seller: { displayName: 'Synthetic seller', contactEmail: 'seller@example.test' }, taxFactsRevision: 1,
    taxFacts: { schemaVersion: 1 as const, legalName: 'PRIVATE SYNTHETIC LEGAL NAME', taxOrigin: f.configuration.address, timeZone: f.configuration.timeZone },
    binding: { organizationId: f.configuration.organizationId, accountId: 'acct_PilotSynthetic', mode: 'test' as const, apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: '2026-10-10T11:59:30.000Z', validUntil: '2026-10-10T12:01:30.000Z', evidenceKind: 'test_fixture' as const, scope: 'erp_invoice_tax' as const },
    merchant: { credential: { reference: 'PRIVATE-KEY-REFERENCE', revision: 1, accountId: 'acct_PilotSynthetic' }, configurationFingerprint: 'd'.repeat(64) }, admittedBy: 'synthetic-db-owner', admittedAt: now };
  const estimate = f.baseline.estimates[0];
  const p = { schemaVersion: 1 as const, organizationId: f.configuration.organizationId, actorId: f.actor.userId, request: built, financialCommandHash,
    erpRequest, erpCommandHash: await digest([f.configuration.organizationId, f.actor.userId, erpRequest]), previousBookFingerprint: await digest(f.baseline),
    context: { ...c, contextSha256: await digest(c) }, estimate, estimateSha256: await digest(estimate),
    classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', kind: 'service' as const, taxBehavior: 'exclusive' as const, revision: 1,
      evidenceReference: await financialInvoiceClassificationEvidenceV5(f.configuration.organizationId, f.actor.userId, financialCommandHash, 'line-1', 'txcd_99999999') }],
    taxDateInstant: now, addressSource: 'billing' as const, preparedAt: now };
  const preparation = await validateUsFinancialInvoicePreparationV5({ ...p, preparationSha256: await digest(p) }, f.configuration.organizationId, true) as UsFinancialInvoicePreparationV5;
  const resolved = await resolveUsFinancialInvoicePreparationV5(preparation, operationId, now), calc = await validateStripeTaxCalculation(resolved, observation(resolved), now);
  const operation: UsFinancialInvoiceOperationV5 = { schemaVersion: 1, organizationId: f.configuration.organizationId, operationId, status: 'calculated', preparation,
    resolvedBody: resolved.resolvedBody, resolvedSha256: resolved.resolvedSha256, paramsBody: resolved.paramsBody, paramsSha256: resolved.paramsSha256, providerKey: resolved.idempotencyKey,
    reservedAt: now, retryUntil: '2026-10-11T11:00:00.000Z', proofBody: calc.proofBody, proofSha256: calc.proofSha256, assessment: calc.assessment, receipt: null };
  return { ...f, request, built, operation };
}
const bad = (v: unknown) => expect(() => validateUsFinancialPilotInvoiceRequest(v)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_request', status: 422 }));

describe('closed private pilot invoice presentation contract', () => {
  it('derives private identity and key without supplying any fiscal or financial fact', () => {
    const request = validateUsFinancialPilotInvoiceRequest(input()), built = buildUsFinancialPilotInvoiceRequest(request, 'workspace');
    expect(built).toEqual({ idempotencyKey: `pilot:invoice:${requestId}`, expectedRevision: 5, command: { type: 'erp_command', request: { ...request.command, id: `pilot-invoice:${requestId}` } } });
    expect(validateUsFinancialRequestV5(built, 'workspace')).toEqual(built); expect(Object.isFrozen(request.choices.classifications[0])).toBe(true);
    expect(built.command).not.toHaveProperty('choices');
  });
  it.each([
    ['protocol', { ...input(), schemaVersion: 5 }], ['uppercase UUID', { ...input(), requestId: requestId.toUpperCase() }],
    ['authority', { ...input(), actor: {} }], ['total', { ...input(), totalMinor: '1' }],
    ['revision zero', { ...input(), expectedRevision: 0 }], ['unsafe revision', { ...input(), expectedRevision: Number.MAX_SAFE_INTEGER }],
    ['caller invoice id', { ...input(), command: { ...input().command, id: 'foreign' } }],
    ['blank period', { ...input(), command: { ...input().command, periodId: ' ' } }],
    ['invalid civil day', { ...input(), command: { ...input().command, date: '2026-02-30' } }],
    ['year zero', { ...input(), command: { ...input().command, date: '0000-01-01' } }],
    ['due before issue', { ...input(), command: { ...input().command, dueDate: '2026-10-09' } }],
    ['unconfirmed service', { ...input(), choices: { ...input().choices, classifications: [{ ...input().choices.classifications[0], confirmedService: false }] } }],
    ['private tax rate', { ...input(), choices: { ...input().choices, classifications: [{ ...input().choices.classifications[0], rate: 8.25 }] } }],
    ['missing classification', { ...input(), choices: { ...input().choices, classifications: [] } }],
    ['duplicate line', { ...input(), choices: { ...input().choices, classifications: [input().choices.classifications[0], input().choices.classifications[0]] } }],
    ['bad code', { ...input(), choices: { ...input().choices, classifications: [{ ...input().choices.classifications[0], taxCode: 'generic-services' }] } }],
    ['implicit timezone', { ...input(), choices: { ...input().choices, taxDateInstant: '2026-10-10T12:00:00' } }],
    ['fractional second', { ...input(), choices: { ...input().choices, taxDateInstant: '2026-10-10T12:00:00.001Z' } }],
    ['invalid instant', { ...input(), choices: { ...input().choices, taxDateInstant: '2026-02-30T12:00:00.000Z' } }],
    ['IP inferred address', { ...input(), choices: { ...input().choices, addressSource: 'ip' } }],
    ['private binding', { ...input(), choices: { ...input().choices, binding: {} } }],
  ])('rejects %s', (_label, v) => bad(v));
  it('bounds 100 classifications and rejects hostile JSON without invoking accessors', () => {
    const r = input(), classifications = Array.from({ length: 100 }, (_, i) => ({ ...r.choices.classifications[0], lineId: `line-${i}` }));
    expect(validateUsFinancialPilotInvoiceRequest({ ...r, choices: { ...r.choices, classifications } }).choices.classifications).toHaveLength(100);
    bad({ ...r, choices: { ...r.choices, classifications: [...classifications, { ...classifications[0], lineId: '101' }] } });
    const getter = vi.fn(() => 'private'); bad(Object.defineProperty({ ...r }, 'actor', { enumerable: true, get: getter })); expect(getter).not.toHaveBeenCalled();
    bad(Object.assign(Object.create({ actor: 'owner' }) as object, r)); bad({ ...r, [Symbol('private')]: 1 });
    const sparse: unknown[] = []; sparse.length = 1; bad({ ...r, choices: { ...r.choices, classifications: sparse } });
    bad({ ...r, command: { ...r.command, estimateId: '\ud800' } });
  });
  it('requires a separate exact review envelope, not a boolean approval or command mutation', () => {
    const value = { request: input(), reviewId: 'a'.repeat(64) };
    expect(validateUsFinancialPilotInvoiceIssueRequest(value)).toEqual(value);
    for (const v of [{ ...value, approved: true }, { ...value, reviewId: 'a' }, { request: input(), reviewId: 'A'.repeat(64) }]) expect(() => validateUsFinancialPilotInvoiceIssueRequest(v)).toThrow();
  });
  it('binds receipts to expected invoice, request ID, actor-space scope and revision', () => {
    const r = input(), receipt = { consumer: 'financial-pilot', schemaVersion: 1, organizationId: 'workspace', revision: 6, entityId: `pilot-invoice:${requestId}`, action: 'issue_invoice', requestId };
    expect(validateUsFinancialPilotInvoiceReceipt(receipt, 'workspace', r)).toEqual(receipt);
    for (const patch of [{ revision: 7 }, { entityId: 'other' }, { requestId: operationId }, { organizationId: 'other' }, { replayed: true }, { action: 'erp_command' }]) expect(() => validateUsFinancialPilotInvoiceReceipt({ ...receipt, ...patch }, 'workspace', r)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_response', status: 503 }));
  });
  it('validates bounded catalogue pages and preserves filtered-provider pagination', () => {
    const v = { consumer: 'financial-pilot', schemaVersion: 1, organizationId: 'workspace', taxCodes: [{ id: 'txcd_99999999', name: 'Synthetic service', description: 'Synthetic catalogue description' }], hasMore: true, nextCursor: 'txcd_99999999' };
    expect(validateUsFinancialPilotTaxCatalogue(v, 'workspace')).toEqual(v);
    for (const patch of [{ organizationId: 'other' }, { nextCursor: 'wrong' }, { nextCursor: null }, { merchant: {} }, { taxCodes: [v.taxCodes[0], v.taxCodes[0]] }]) expect(() => validateUsFinancialPilotTaxCatalogue({ ...v, ...patch }, 'workspace')).toThrow();
    expect(validateUsFinancialPilotTaxCatalogue({ ...v, hasMore: false, nextCursor: null })).toMatchObject({ hasMore: false });
    expect(validateUsFinancialPilotTaxCatalogue({ ...v, taxCodes: [], nextCursor: 'txcd_00000001' })).toMatchObject({ taxCodes: [], hasMore: true, nextCursor: 'txcd_00000001' });
  });
});

describe('private calculated operation to invoice review projection', () => {
  it('projects exact totals from validated private evidence without leaking merchant, tax origin or raw proof', async () => {
    const t = await prepared(), p = await projectUsFinancialPilotInvoicePreview(t.operation, t.request, true);
    expect(p).toMatchObject({ revision: 5, financialStatus: 'not_issued', netMinor: '30000', taxMinor: '2475', totalMinor: '32475', expiresAt: '2026-10-10T12:01:30.000Z', lines: [{ id: 'line-1', netMinor: '30000', taxMinor: '2475', totalMinor: '32475' }] });
    expect(validateUsFinancialPilotInvoicePreview(p, t.configuration.organizationId, t.request)).toEqual(p);
    expect(p.reviewId).toMatch(/^[a-f0-9]{64}$/);
    for (const secret of ['PRIVATE SYNTHETIC', 'PRIVATE-KEY', 'acct_Pilot', 'taxcalc_', 'providerKey', 'proofBody', 'registrationsSha256', 'contextSha256', 'policy']) expect(JSON.stringify(p)).not.toContain(secret);
  });
  it('never promotes QA fixture evidence without explicit local permission or treats a reservation as calculated', async () => {
    const t = await prepared(); await expect(projectUsFinancialPilotInvoicePreview(t.operation, t.request)).rejects.toThrow();
    const reserved = { ...t.operation, status: 'reserved' as const, proofBody: null, proofSha256: null, assessment: null };
    await expect(projectUsFinancialPilotInvoicePreview(reserved, t.request, true)).rejects.toMatchObject({ code: 'invalid_financial_pilot_response', status: 503 });
  });
  it('binds review to the exact request and stored choices, including inputs absent from the ERP command hash', async () => {
    const t = await prepared(); expect(usFinancialPilotInvoiceChoicesMatch(t.operation, t.request)).toBe(true);
    const changes = [{ ...t.request, choices: { ...t.request.choices, addressSource: 'shipping' as const } }, { ...t.request, choices: { ...t.request.choices, taxDateInstant: '2026-10-10T12:00:01.000Z' } }, { ...t.request, choices: { ...t.request.choices, classifications: [{ lineId: 'line-1', taxCode: 'txcd_00000001', confirmedService: true as const }] } }, { ...t.request, expectedRevision: 6 }];
    for (const changed of changes) { expect(usFinancialPilotInvoiceChoicesMatch(t.operation, changed)).toBe(false); await expect(projectUsFinancialPilotInvoicePreview(t.operation, changed, true)).rejects.toMatchObject({ code: 'invalid_financial_pilot_response' }); }
  });
  it('captures both arguments before hashing so later caller mutation cannot change the reviewed amount or choices', async () => {
    const t = await prepared(), op = structuredClone(t.operation), r = structuredClone(t.request), flight = projectUsFinancialPilotInvoicePreview(op, r, true);
    (op.preparation.estimate.lines[0] as { description: string }).description = 'MUTATED'; (r.choices as { addressSource: string }).addressSource = 'shipping';
    const p = await flight; expect(p.lines[0].description).not.toBe('MUTATED'); expect(p.addressSource).toBe('billing');
  });
  it('rejects altered totals, lines, choices, dates, private fields and mismatched presentation identity', async () => {
    const t = await prepared(), p = await projectUsFinancialPilotInvoicePreview(t.operation, t.request, true);
    const patches = [{ taxMinor: '1' }, { netMinor: '30001' }, { totalMinor: '32476' }, { invoiceId: 'foreign' }, { revision: 6 }, { estimateRevision: 3 }, { requestId: operationId }, { periodId: 'other' }, { timeZone: 'Europe/Zurich' }, { taxDateInstant: '2026-10-10T12:00:01.000Z' }, { context: {} }, { lines: [{ ...p.lines[0], taxCode: 'txcd_00000001' }] }, { lines: [{ ...p.lines[0], totalMinor: '1' }] }, { lines: [{ ...p.lines[0], quantityScale: 2 }] }];
    for (const patch of patches) expect(() => validateUsFinancialPilotInvoicePreview({ ...p, ...patch }, t.configuration.organizationId, t.request)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_response', status: 503 }));
  });
  it('keeps integer presentation amounts above MAX_SAFE_INTEGER exact and validates sum invariants', async () => {
    const t = await prepared(), p = await projectUsFinancialPilotInvoicePreview(t.operation, t.request, true), n = '900719925474099301';
    const exact = { ...p, lines: [{ ...p.lines[0], netMinor: n, taxMinor: '1', totalMinor: '900719925474099302' }], netMinor: n, taxMinor: '1', totalMinor: '900719925474099302' };
    expect(validateUsFinancialPilotInvoicePreview(exact, t.configuration.organizationId, t.request).totalMinor).toBe('900719925474099302');
    expect(() => validateUsFinancialPilotInvoicePreview({ ...exact, netMinor: '0900719925474099301' })).toThrow();
  });
  it('preserves review identity for a committed historical operation without claiming it is not issued', async () => {
    const t = await prepared(), before = await projectUsFinancialPilotInvoicePreview(t.operation, t.request, true);
    const op: UsFinancialInvoiceOperationV5 = { ...t.operation, status: 'committed', receipt: { actorId: t.actor.userId, idempotencyKey: t.built.idempotencyKey, commandHash: t.operation.preparation.financialCommandHash, revision: 6, entityId: `pilot-invoice:${requestId}`, action: 'erp_command' } };
    const after = await projectUsFinancialPilotInvoicePreview(op, t.request, true); expect(after.reviewId).toBe(before.reviewId); expect(after.financialStatus).toBe('issued');
  });
});
