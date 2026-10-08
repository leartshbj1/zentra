import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareStripeTaxResolvedRequest, STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest, type StripeTaxResolvedRequestInput } from './stripe-tax-resolved-request';
import { validateStoredStripeTaxCalculation, validateStripeTaxCalculation, type StripeTaxCalculationObservation } from './stripe-tax-calculation';
import { canonicalErpJson } from './erp-contract';

const now = '2026-10-08T12:00:00.000Z';
function input(): StripeTaxResolvedRequestInput {
  const organizationId = 'fictitious-tax-workspace', address = { country: 'US' as const, line1: '123 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
  return {
    organizationId, operationId: 'a2000000-0000-4000-8000-000000000001', invoiceId: 'invoice-1', actorUserId: 'fictitious-owner', erpIdempotencyKey: 'fictitious-key', commandHash: 'a'.repeat(64),
    expectedErpRevision: 4, countryRevision: 1, sellerRevision: 1, taxFactsRevision: 1,
    configuration: { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } },
    taxFacts: { schemaVersion: 1, legalName: 'Private Fictitious Name', taxOrigin: { ...address, line1: 'Private Tax Origin Only' }, timeZone: 'America/New_York' },
    binding: { organizationId, accountId: 'acct_Fictitious', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: '2026-10-08T11:00:00Z', validUntil: '2026-10-08T14:00:00Z', evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' },
    estimate: { id: 'estimate-1', organizationId, revision: 2, currency: 'USD', number: 'EST-000001', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, notes: 'Fictitious only', status: 'accepted', customer: { id: 'customer-1', organizationId, kind: 'business', name: 'Fictitious Customer', billingAddress: address, paymentTermsDays: 30 }, lines: [{ id: 'line-1', description: 'Fictitious Service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }] },
    classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 1, evidenceReference: 'fictitious-classification-not-actual-code' }],
    invoiceDate: '2026-10-08', taxDateInstant: now, taxDatePolicy: 'caller_supplied_invoice_instant', now, addressSource: 'billing',
  };
}
function breakdown(amount = 160, taxability_reason = 'standard_rated') {
  return { amount, taxable_amount: 2000, taxability_reason, sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'New York' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious sales tax', percentage_decimal: '8.0' } as Record<string, unknown> | null };
}
function calculation(resolved: ResolvedStripeTaxRequest) {
  const line = { id: 'tax_li_Fictitious1', object: 'tax.calculation_line_item', amount: 2000, amount_tax: 160, quantity: 2, reference: 'line-1', tax_code: 'txcd_99999999', tax_behavior: 'exclusive', livemode: false, product: null, metadata: { privateIgnoredText: 'Must never be on invoice' }, tax_breakdown: [breakdown()] };
  return {
    id: 'taxcalc_Fictitious', object: 'tax.calculation', amount_total: 2160, currency: 'usd', customer: null,
    customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: 'billing', ip_address: null, tax_ids: [], taxability_override: 'none' },
    expires_at: 1791547200, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: 160, tax_amount_inclusive: 0,
    line_items: { object: 'list', has_more: false, data: [line], url: '/v1/tax/calculations/taxcalc_Fictitious/line_items' },
    tax_breakdown: [{ amount: 160, taxable_amount: 2000, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
  };
}
type Calculation = ReturnType<typeof calculation>;
function observation(resolved: ResolvedStripeTaxRequest, c: unknown): StripeTaxCalculationObservation {
  return { accountId: resolved.binding.accountId, mode: 'test', apiVersion: resolved.binding.apiVersion, evidenceKind: resolved.binding.evidenceKind, observedAt: now, calculation: c };
}
async function fixture() { const resolved = await prepareStripeTaxResolvedRequest(input()), c = calculation(resolved); return { resolved, c, observation: observation(resolved, c) }; }

describe('private Stripe Tax TEST response validation', () => {
  it('binds full discounted line totals, quantity, code, account, request, time and private proof; public assessment contains only existing fields', async () => {
    const t = await fixture(), result = await validateStripeTaxCalculation(t.resolved, t.observation, now);
    expect(result.proof).toMatchObject({ mode: 'test', evidenceKind: 'test_fixture', netMinor: '2000', taxMinor: '160', totalMinor: '2160', paramsSha256: t.resolved.paramsSha256, resolvedSha256: t.resolved.resolvedSha256 });
    expect(result.proof.lines[0]).toMatchObject({ netMinor: '2000', quantity: '2', taxMinor: '160', breakdowns: [{ amountMinor: '160', taxableMinor: '2000', taxabilityReason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', displayName: 'New York' } }] });
    expect(result.proofBody).toBe(canonicalErpJson(result.proof)); expect(result.proofSha256).toBe(createHash('sha256').update(result.proofBody, 'utf8').digest('hex'));
    expect(Object.keys(result.assessment)).toHaveLength(11); expect(Object.keys(result.assessment.lines[0])).toEqual(['id', 'taxMinor', 'jurisdiction', 'evidenceReference']);
    expect(result.assessment.validUntil).toBe(new Date(t.resolved.binding.validUntil).toISOString()); expect(result.assessment.lines[0].jurisdiction).toBe('US-NY');
    const exposed = JSON.stringify(result.assessment);
    // Existing assessment fingerprint contains public invoice/customer addresses;
    // the private declaration's origin must never be added to that projection.
    for (const privateValue of ['acct_Fictitious', 'Private Fictitious Name', 'Must never be on invoice', 'Private Tax Origin Only', 'settingsSha256', 'bindingRevision']) expect(exposed).not.toContain(privateValue);
    expect(JSON.stringify(result.proof)).not.toContain('privateIgnoredText'); expect(result.proof).not.toHaveProperty('grant');
    expect(Object.isFrozen(result.proof.lines[0].breakdowns[0].jurisdiction)).toBe(true);
  });
  it('preserves mixed known jurisdiction reasons in the real documented Stripe pattern', async () => {
    const t = await fixture(), county = breakdown(0, 'not_subject_to_tax'); county.taxable_amount = 0; county.tax_rate_details = null; county.jurisdiction = { country: 'US', state: 'NY', level: 'county', display_name: 'Fictitious County' };
    t.c.line_items.data[0].tax_breakdown.push(county);
    const result = await validateStripeTaxCalculation(t.resolved, t.observation, now);
    expect(result.proof.lines[0].breakdowns.map(b => b.taxabilityReason)).toEqual(['standard_rated', 'not_subject_to_tax']); expect(result.proof.taxMinor).toBe('160');
  });
  it.each(['zero_rated', 'product_exempt', 'not_subject_to_tax'])('accepts explicit provider zero reason %s without inventing a rate', async value => {
    const t = await fixture(); t.c.amount_total = 2000; t.c.tax_amount_exclusive = 0; t.c.line_items.data[0].amount_tax = 0;
    t.c.line_items.data[0].tax_breakdown = [breakdown(0, value)]; t.c.line_items.data[0].tax_breakdown[0].tax_rate_details = null;
    t.c.tax_breakdown[0].amount = 0; t.c.tax_breakdown[0].taxability_reason = value; t.c.tax_breakdown[0].tax_rate_details.percentage_decimal = '0.0';
    const result = await validateStripeTaxCalculation(t.resolved, t.observation, now); expect(result.assessment.lines[0].taxMinor).toBe('0');
  });
  it.each(['not_collecting', 'not_supported', 'customer_exempt', 'reverse_charge', 'vat_exempt', 'portion_product_exempt', 'new_unknown'])('blocks unvalidated tax reason %s instead of silently deciding zero', async value => {
    const t = await fixture(); t.c.line_items.data[0].tax_breakdown[0].taxability_reason = value;
    await expect(validateStripeTaxCalculation(t.resolved, t.observation, now)).rejects.toThrow('unsupported_tax_calculation');
  });
  const corruptions: [string, (c: Calculation) => void][] = [
    ['live mode', c => { c.livemode = true; }], ['line live mode', c => { c.line_items.data[0].livemode = true; }], ['currency', c => { c.currency = 'chf'; }], ['tax date', c => { c.tax_date++; }],
    ['null calculation id', c => { (c as unknown as Record<string, unknown>).id = null; }], ['shipping', c => { (c as unknown as Record<string, unknown>).shipping_cost = { amount: 0 }; }],
    ['tax included', c => { c.tax_amount_inclusive = 160; }], ['address changed', c => { c.customer_details.address.city = 'Other City'; }], ['address source changed', c => { c.customer_details.address_source = 'shipping'; }],
    ['customer override', c => { c.customer_details.taxability_override = 'customer_exempt'; }], ['existing customer', c => { (c as unknown as Record<string, unknown>).customer = 'cus_Any'; }],
    ['pagination', c => { c.line_items.has_more = true; }], ['missing line', c => { c.line_items.data = []; }], ['duplicate line', c => { c.line_items.data.push(structuredClone(c.line_items.data[0])); }],
    ['net double multiplication', c => { c.line_items.data[0].amount = 4000; }], ['fractional quantity', c => { c.line_items.data[0].quantity = 2.5; }], ['wrong quantity', c => { c.line_items.data[0].quantity = 1; }],
    ['wrong reference', c => { c.line_items.data[0].reference = 'wrong'; }], ['wrong code', c => { c.line_items.data[0].tax_code = 'txcd_12345678'; }], ['inclusive line', c => { c.line_items.data[0].tax_behavior = 'inclusive'; }],
    ['missing breakdown expansion', c => { delete (c.line_items.data[0] as unknown as Record<string, unknown>).tax_breakdown; }], ['empty breakdown', c => { c.line_items.data[0].tax_breakdown = []; }],
    ['line tax mismatch', c => { c.line_items.data[0].amount_tax++; }], ['taxable amount too large', c => { c.line_items.data[0].tax_breakdown[0].taxable_amount++; }], ['negative tax', c => { c.line_items.data[0].tax_breakdown[0].amount = -1; }],
    ['unsafe integer', c => { c.amount_total = Number.MAX_SAFE_INTEGER + 1; }], ['NaN', c => { c.tax_amount_exclusive = Number.NaN; }], ['total mismatch', c => { c.amount_total++; }], ['exclusive sum mismatch', c => { c.tax_amount_exclusive++; }],
    ['top sum mismatch', c => { c.tax_breakdown[0].amount++; }], ['top foreign jurisdiction', c => { c.tax_breakdown[0].tax_rate_details.country = 'CH'; }], ['foreign VAT', c => { c.line_items.data[0].tax_breakdown[0].tax_rate_details!.tax_type = 'vat'; }],
    ['flat fee', c => { c.tax_breakdown[0].tax_rate_details.rate_type = 'flat_amount'; }], ['foreign country', c => { c.line_items.data[0].tax_breakdown[0].jurisdiction.country = 'DE'; }],
    ['duplicate jurisdiction', c => { c.line_items.data[0].tax_breakdown.push(structuredClone(c.line_items.data[0].tax_breakdown[0])); }], ['unknown level', c => { c.line_items.data[0].tax_breakdown[0].jurisdiction.level = 'planet'; }],
    ['zero reason with positive tax', c => { c.line_items.data[0].tax_breakdown[0].taxability_reason = 'product_exempt'; }], ['missing top breakdown', c => { c.tax_breakdown = []; }],
  ];
  it.each(corruptions)('refuses %s', async (_, mutate) => { const t = await fixture(); mutate(t.c); await expect(validateStripeTaxCalculation(t.resolved, t.observation, now)).rejects.toThrow(); });
  it.each(['accountId', 'mode', 'apiVersion', 'evidenceKind'] as const)('refuses changed transport binding %s', async field => {
    const t = await fixture(), obs = { ...t.observation, [field]: 'wrong' }; await expect(validateStripeTaxCalculation(t.resolved, obs as StripeTaxCalculationObservation, now)).rejects.toThrow('tax_binding_changed');
  });
  it('rejects an expired calculation at the exact boundary', async () => {
    const t = await fixture(); t.c.expires_at = t.resolved.params.tax_date;
    await expect(validateStripeTaxCalculation(t.resolved, t.observation, now)).rejects.toThrow('tax_calculation_expired');
  });
  it.each(['observation', 'clock', 'binding'] as const)('keeps private microsecond %s evidence and makes a conservative public millisecond projection', async field => {
    const request = { ...input() }; if (field === 'binding') request.binding = { ...request.binding, validUntil: '2026-10-08T14:00:00.000001Z' };
    const resolved = await prepareStripeTaxResolvedRequest(request), c = calculation(resolved), obs = observation(resolved, c);
    if (field === 'observation') (obs as { observedAt: string }).observedAt = '2026-10-08T11:59:59.123456Z';
    const result = await validateStripeTaxCalculation(resolved, obs, field === 'clock' ? '2026-10-08T12:00:00.000001Z' : now);
    expect(result.assessment.determinedAt).toMatch(/\.\d{3}Z$/); expect(result.assessment.validUntil).toMatch(/\.\d{3}Z$/);
    expect(result.proof.calculatedAt).toBe(obs.observedAt);
    expect(await validateStoredStripeTaxCalculation(resolved, { proofBody: result.proofBody, proofSha256: result.proofSha256, assessment: result.assessment }, '2026-10-08T12:00:00.000002Z')).toEqual(result);
  });
  it('refuses the final one-microsecond binding window instead of extending the public expiry', async () => {
    const request = { ...input() }; request.binding = { ...request.binding, validUntil: '2026-10-08T12:00:00.000001Z' };
    const resolved = await prepareStripeTaxResolvedRequest(request), c = calculation(resolved);
    await expect(validateStripeTaxCalculation(resolved, observation(resolved, c), now)).rejects.toThrow('tax_calculation_expired');
  });
  it('rejects future, pre-binding and accessor observations without executing getters', async () => {
    const t = await fixture();
    for (const observedAt of ['2026-10-08T12:00:00.000001Z', '2026-10-08T10:59:59Z']) await expect(validateStripeTaxCalculation(t.resolved, { ...t.observation, observedAt }, now)).rejects.toThrow();
    let invoked = false; Object.defineProperty(t.c, 'amount_total', { enumerable: true, get() { invoked = true; return 2160; } });
    await expect(validateStripeTaxCalculation(t.resolved, t.observation, now)).rejects.toThrow(); expect(invoked).toBe(false);
  });
  it('snapshots before the first await, never retaining mutable caller data', async () => {
    const t = await fixture(), pending = validateStripeTaxCalculation(t.resolved, t.observation, now); t.c.amount_total = 99999; t.c.line_items.data[0].tax_breakdown[0].jurisdiction.display_name = 'Changed';
    const result = await pending; expect(result.proof.totalMinor).toBe('2160'); expect(result.proof.lines[0].breakdowns[0].jurisdiction.displayName).toBe('New York');
  });
  it('rejects a persisted DTO whose private body, monetary snapshot or request key was replaced', async () => {
    const t = await fixture();
    for (const changed of [{ ...t.resolved, resolvedBody: '{}' }, { ...t.resolved, idempotencyKey: 'ztax_test_' + '0'.repeat(64) }, { ...t.resolved, netTotalMinor: '4000' }]) await expect(validateStripeTaxCalculation(changed, t.observation, now)).rejects.toThrow();
  });
  it('recovers exactly the normalized calculated operation from private storage', async () => {
    const t = await fixture(), original = await validateStripeTaxCalculation(t.resolved, t.observation, now);
    const stored = { proofBody: original.proofBody, proofSha256: original.proofSha256, assessment: original.assessment };
    expect(await validateStoredStripeTaxCalculation(t.resolved, stored, '2026-10-08T12:05:00Z')).toEqual(original);
  });
  it.each(['body', 'hash', 'account', 'tax', 'lineTax', 'quantity', 'reason', 'jurisdiction', 'sum', 'extra', 'assessment'] as const)('refuses corrupt normalized storage %s', async field => {
    const t = await fixture(), original = await validateStripeTaxCalculation(t.resolved, t.observation, now), proof = JSON.parse(original.proofBody);
    const stored = { proofBody: original.proofBody, proofSha256: original.proofSha256, assessment: structuredClone(original.assessment) };
    if (field === 'body') stored.proofBody += ' ';
    else if (field === 'hash') stored.proofSha256 = '0'.repeat(64);
    else if (field === 'assessment') stored.assessment = { ...stored.assessment, lines: [{ ...stored.assessment.lines[0], taxMinor: '0' }] };
    else {
      if (field === 'account') proof.accountId = 'acct_Other';
      if (field === 'tax') proof.taxMinor = '0';
      if (field === 'lineTax') proof.lines[0].taxMinor = '0';
      if (field === 'quantity') proof.lines[0].quantity = '3';
      if (field === 'reason') proof.lines[0].breakdowns[0].taxabilityReason = 'not_collecting';
      if (field === 'jurisdiction') proof.lines[0].breakdowns[0].jurisdiction.country = 'CH';
      if (field === 'sum') proof.totalMinor = '2159';
      if (field === 'extra') proof.grant = true;
      // Even a newly hashed body cannot overcome semantic/allowlist checks.
      stored.proofBody = canonicalErpJson(proof); stored.proofSha256 = createHash('sha256').update(stored.proofBody).digest('hex');
    }
    await expect(validateStoredStripeTaxCalculation(t.resolved, stored, now)).rejects.toThrow();
  });
});
