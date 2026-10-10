import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { generalLedger, trialBalance } from './accounting/reports';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';
import { projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { executeUsFinancialKernelV5, type UsFinancialReceiptV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
import { createSupabaseUsFinancialAccountingTestStoreV5 } from './us-financial-test-accounting';
import type { UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialInvoicingTestStoreV5 } from './us-financial-test-invoicing';
import { createUsFinancialInvoiceTestResolverV5, validateUsFinancialInvoiceContextV5, validateUsFinancialInvoiceOperationV5, usFinancialInvoiceBaseContextV5, usFinancialInvoiceSellerProfileV5, type UsFinancialInvoiceContextV5, type UsFinancialInvoiceOperationV5, type UsFinancialInvoicePreparationV5 } from './us-financial-invoice-test';
import { createSupabaseUsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test-store';

// Actual ERP/kernel, canonical tax/proof validators and both private adapters.
// The RPC transport, DB-owner admission and gateway observations are synthetic:
// this file does not prove PostgreSQL locks/atomicity or a real merchant account.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (value: unknown) => sha256Hex(canonicalErpJson(value));
const operationId = 'a5000000-0000-4000-8000-000000000001';
const readRpc = 'zentra_read_us_financial_invoicing_test_v5', receiptRpc = 'zentra_us_financial_invoicing_test_receipt_v5', appendRpc = 'zentra_append_us_financial_invoicing_test_v5';
const operationRpc = 'zentra_read_us_financial_invoice_test_operation_v5', preflightRpc = 'zentra_preflight_us_financial_invoice_test_v5', reserveRpc = 'zentra_reserve_us_financial_invoice_test_v5', recordRpc = 'zentra_record_us_financial_invoice_test_calculation_v5';
function observation(r: ResolvedStripeTaxRequest, now: string): StripeTaxCalculationObservation {
  const line = r.params.line_items[0], tax = 2475;
  return { accountId: r.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: { id: 'taxcalc_SyntheticV5', object: 'tax.calculation', amount_total: line.amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...r.params.customer_details.address, line2: null }, address_source: r.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 3600, tax_date: r.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_SyntheticV5/line_items', data: [{ id: 'tax_li_SyntheticV5', object: 'tax.calculation_line_item', amount: line.amount, amount_tax: tax, quantity: line.quantity, reference: line.reference, tax_code: line.tax_code, tax_behavior: 'exclusive', livemode: false, product: null,
        tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Synthetic jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Synthetic tax', percentage_decimal: '8.25' } }] }] },
      tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.25', rate_type: 'percentage', flat_amount: null } }],
    } };
}
async function fixture(options: Readonly<{ allowFixtures?: boolean; role?: 'owner' | 'admin' | 'accountant' }> = {}) {
  const data = await financialKernelFixture(), actor = { ...data.actor, role: options.role ?? data.actor.role };
  let time = Date.parse(actor.timestamp), revoked = false, grantVersion = 1;
  const now = () => new Date(time).toISOString();
  const scope: UsFinancialTestScopeV5 = { organizationId: actor.organizationId, actor, policy: data.policy, grantVersion };
  const state: { book: UsFinancialBookV5; operation: UsFinancialInvoiceOperationV5 | null; receipts: Map<string, unknown>; gate: Error | null } = { book: await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), operation: null, receipts: new Map(), gate: null };
  const hooks = new Map<string, () => unknown>(), transforms = new Map<string, (value: unknown) => unknown>();
  async function fire(phase: string) { const fn = hooks.get(phase); if (fn) { hooks.delete(phase); await fn(); } }
  const revalidate = vi.fn(async () => { if (revoked) throw new ErpError('session_changed', 401); return { ...scope, actor: { ...actor, timestamp: now() }, grantVersion }; });
  const c = { schemaVersion: 1 as const, organizationId: actor.organizationId, revision: 1, countryRevision: 1, configuration: data.configuration, sellerRevision: 1, seller: { displayName: 'Synthetic V5 seller', contactEmail: 'seller@example.test' }, taxFactsRevision: 1,
    taxFacts: { schemaVersion: 1 as const, legalName: 'PRIVATE SYNTHETIC LEGAL NAME', taxOrigin: data.configuration.address as Extract<typeof data.configuration.address, { country: 'US' }>, timeZone: data.configuration.timeZone },
    binding: { organizationId: actor.organizationId, accountId: 'acct_SyntheticV5', mode: 'test' as const, apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: new Date(time - 30_000).toISOString(), validUntil: new Date(time + 90_000).toISOString(), evidenceKind: 'test_fixture' as const, scope: 'erp_invoice_tax' as const },
    merchant: { credential: { reference: 'synthetic-test-key-reference', revision: 1, accountId: 'acct_SyntheticV5' }, configurationFingerprint: 'd'.repeat(64) }, admittedBy: 'synthetic-db-owner-only-not-service', admittedAt: now() };
  let context: UsFinancialInvoiceContextV5 = { ...c, contextSha256: await digest(c) };
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    await fire(name); let result: unknown;
    if (name === readRpc || name === 'zentra_read_us_financial_accounting_test_v5') result = state.book;
    else if (name === receiptRpc || name === 'zentra_us_financial_accounting_test_receipt_v5') result = state.receipts.get(args.p_idempotency_key as string) ?? null;
    else if (name === appendRpc) {
      if (args.p_expected_revision !== state.book.revision || args.p_previous_fingerprint !== await digest(state.book)) throw new SupabaseServerError(409, 'PF001', 'Synthetic CAS refusal');
      const next = args.p_book as UsFinancialBookV5, receipt = args.p_receipt as UsFinancialReceiptV5, event = next.events.at(-1)!;
      if (event.operation.type === 'erp_command' && event.operation.command.type === 'issue_invoice') {
        if (state.gate) throw state.gate;
        if (!state.operation || state.operation.status !== 'calculated' || state.operation.preparation.financialCommandHash !== receipt.commandHash || canonicalErpJson(event.operation.facts) !== canonicalErpJson({ kind: 'invoice_issuance', sellerSnapshot: { organizationId: actor.organizationId, ...usFinancialInvoiceSellerProfileV5(state.operation.preparation.context) }, taxAssessment: state.operation.assessment })) throw new SupabaseServerError(503, 'PX005', 'Synthetic absent evidence');
        state.operation = { ...state.operation, status: 'committed', receipt };
      }
      state.book = clone(next); state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: receipt.actorId, receipt }); result = receipt;
    } else if (name === operationRpc) {
      if (state.operation && (state.operation.preparation.financialCommandHash !== args.p_financial_command_hash || state.operation.preparation.erpCommandHash !== args.p_erp_command_hash)) throw new SupabaseServerError(409, 'PF002', 'Synthetic key conflict');
      result = state.operation;
    } else if (name === preflightRpc) {
      if (state.gate) throw state.gate;
      const request = args.p_request as UsFinancialRequestV5, view = await projectUsFinancialBookV5(state.book);
      if (request.expectedRevision !== state.book.revision || args.p_previous_fingerprint !== await digest(state.book)) throw new SupabaseServerError(409, 'PF001', 'Synthetic source changed');
      if (request.command.type !== 'erp_command' || request.command.request.type !== 'issue_invoice') throw Error('Synthetic expected invoice request');
      const command = request.command.request;
      result = { context: state.operation?.preparation.context ?? context, estimate: view.estimates.find(e => e.id === command.estimateId), bookRevision: state.book.revision, bookFingerprint: await digest(state.book) };
    } else if (name === reserveRpc) {
      const p = args.p_preparation as UsFinancialInvoicePreparationV5;
      if (!state.operation) state.operation = { schemaVersion: 1, organizationId: actor.organizationId, operationId, status: 'reserved', preparation: p, resolvedBody: args.p_resolved_body as string, resolvedSha256: args.p_resolved_sha256 as string, paramsBody: args.p_params_body as string, paramsSha256: args.p_params_sha256 as string, providerKey: args.p_provider_idempotency_key as string, reservedAt: now(), retryUntil: new Date(time + 23 * 3_600_000).toISOString(), proofBody: null, proofSha256: null, assessment: null, receipt: null };
      result = state.operation;
    } else if (name === recordRpc) {
      if (!state.operation) throw Error('Synthetic missing reservation');
      state.operation = { ...state.operation, status: 'calculated', proofBody: args.p_proof_body as string, proofSha256: args.p_proof_sha256 as string, assessment: args.p_assessment as UsFinancialInvoiceOperationV5['assessment'] }; result = state.operation;
    } else throw Error(`Unexpected synthetic RPC ${name}`);
    await fire(`${name}:after`); const transform = transforms.get(name); return clone(transform ? transform(result) : result);
  });
  const store = createSupabaseUsFinancialInvoicingTestStoreV5({ rpc }, scope, revalidate);
  const resolveTax = vi.fn(async ({ candidate, idempotencyKey }: { candidate: { invoiceFingerprint: string; allocationSha256: string; allocation: { taxMinor: string } }; idempotencyKey: string }): Promise<UsFinancialTaxProofV5> => ({ schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'SYNTHETIC LOCAL PLAN', verifiedBy: 'synthetic-reviewer', verifiedAt: now(), providerAccountReference: 'acct_SyntheticV5', originalTaxTransactionReference: `testtxn_${candidate.invoiceFingerprint}`, adjustmentPlanReference: `testplan_${idempotencyKey}`, authorizedTaxMinor: candidate.allocation.taxMinor }));
  const deps = { ...data, actor, store, resolveTax, revalidate: async () => ({ configuration: data.configuration, actor: (await revalidate()).actor, policy: data.policy }) };
  const send = (key: string, command: UsFinancialErpCommandV5) => executeUsFinancialKernelV5(deps, { idempotencyKey: key, expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } });
  await send('new-quote', { type: 'save_estimate', id: 'estimate-2', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: data.baseline.estimates[0].lines, notes: 'Synthetic new invoice source' });
  await send('accept-new-quote', { type: 'accept_estimate', estimateId: 'estimate-2', expectedEstimateRevision: 1 });
  const taxStore = createSupabaseUsFinancialInvoiceTestStoreV5({ rpc }, scope, revalidate, { allowTestFixtures: options.allowFixtures ?? true });
  const choices = vi.fn(async () => ({ classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', kind: 'service' as const, taxBehavior: 'exclusive' as const }], taxDateInstant: '2026-10-10T12:00:00.000Z', addressSource: 'billing' as const }));
  const gateway = { calculate: vi.fn(async (r: ResolvedStripeTaxRequest) => { await fire('calculate'); return observation(r, now()); }) };
  const resolverDependencies = { scope, revalidate, store: taxStore, choices, gateway, operationId: () => operationId, now, allowTestFixtures: options.allowFixtures ?? true };
  const resolver = createUsFinancialInvoiceTestResolverV5(resolverDependencies);
  const full = { ...deps, resolveIssuance: resolver };
  const command: Extract<UsFinancialErpCommandV5, { type: 'issue_invoice' }> = { type: 'issue_invoice', id: 'invoice-2', estimateId: 'estimate-2', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' };
  const request: UsFinancialRequestV5 = { idempotencyKey: 'issue-new', expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } };
  rpc.mockClear(); revalidate.mockClear();
  return { ...data, actor, scope, state, rpc, store, taxStore, choices, gateway, resolver, resolverDependencies, full, command, request, hooks, transforms, revalidate, send, now,
    issue: () => executeUsFinancialKernelV5(full, request), revoke: () => { revoked = true; }, changeGrant: () => { grantVersion += 1; }, advance: (ms: number) => { time += ms; },
    setContext: (value: UsFinancialInvoiceContextV5) => { context = value; }, context: () => clone(context),
    appends: () => rpc.mock.calls.filter(([name]) => name === appendRpc).length,
  };
}

async function presentationContext(base: UsFinancialInvoiceContextV5, origin: 'legacy-frozen' | 'financial-v5' = 'financial-v5'): Promise<UsFinancialInvoiceContextV5> {
  const original = usFinancialInvoiceBaseContextV5(base), { contextSha256, ...fields } = original;
  const value = { ...fields, schemaVersion: 2 as const, presentation: { schemaVersion: 1 as const, baseContextRevision: original.revision, baseContextSha256: contextSha256,
    origin, sellerRevision: origin === 'legacy-frozen' ? original.sellerRevision : original.sellerRevision + 1, sellerChangeSha256: origin === 'legacy-frozen' ? null : 'e'.repeat(64),
    profile: origin === 'legacy-frozen' ? original.seller : { displayName: 'Current commercial seller · Genève', contactPhone: '+1 555 0100' } } };
  return validateUsFinancialInvoiceContextV5({ ...value, contextSha256: await digest(value) }, original.organizationId, true);
}
describe('compatible private invoice presentation context', () => {
  it.each(['legacy-frozen', 'financial-v5'] as const)('captures %s without changing the original fiscal context or hash', async origin => {
    const t = await fixture(), original = t.context(), value = await presentationContext(original, origin), supplied = clone(value);
    const promise = validateUsFinancialInvoiceContextV5(supplied, t.actor.organizationId, true);
    if (supplied.schemaVersion === 2) (supplied.presentation.profile as { displayName: string }).displayName = 'Mutated after capture';
    const captured = await promise;
    expect(captured).toEqual(value); expect(usFinancialInvoiceBaseContextV5(captured)).toEqual(original);
    expect(canonicalErpJson(usFinancialInvoiceBaseContextV5(captured))).toBe(canonicalErpJson(original));
    expect(captured.sellerRevision).toBe(original.sellerRevision); expect(captured.binding).toEqual(original.binding); expect(captured.merchant).toEqual(original.merchant);
  });
  it.each(['extra', 'baseHash', 'baseRevision', 'profile', 'origin', 'changeHash', 'outerHash'] as const)('rejects coherent malformed %s presentation', async field => {
    const t = await fixture(), value = clone(await presentationContext(t.context())) as Extract<UsFinancialInvoiceContextV5, { schemaVersion: 2 }>;
    const changed = value as unknown as Record<string, unknown>, p = changed.presentation as Record<string, unknown>;
    if (field === 'extra') p.legalName = 'Private field';
    if (field === 'baseHash') p.baseContextSha256 = 'f'.repeat(64);
    if (field === 'baseRevision') p.baseContextRevision = 2;
    if (field === 'profile') p.profile = { displayName: 'Trimmed ', contactEmail: 'invalid' };
    if (field === 'origin') p.origin = 'current';
    if (field === 'changeHash') p.sellerChangeSha256 = null;
    if (field !== 'outerHash') { const { contextSha256: _hash, ...body } = changed; void _hash; changed.contextSha256 = await digest(body); }
    else changed.contextSha256 = 'f'.repeat(64);
    await expect(validateUsFinancialInvoiceContextV5(changed, t.actor.organizationId, true)).rejects.toMatchObject({ code: 'invalid_financial_invoice_private_data', status: 503 });
  });
  it.each([null, 1, [], 'private'])('closes non-object private context %s', async value => {
    await expect(validateUsFinancialInvoiceContextV5(value, 'synthetic', true)).rejects.toMatchObject({ code: 'invalid_financial_invoice_private_data', status: 503 });
  });
  it('prints commercial presentation while resolved requests retain fiscal S and original money/TTL', async () => {
    const t = await fixture(), original = t.context(), commercial = await presentationContext(original); t.setContext(commercial);
    const before = await projectUsFinancialBookV5(t.state.book), oldInvoice = canonicalErpJson(before.invoices[0]); await t.issue();
    const view = await projectUsFinancialBookV5(t.state.book), operation = t.state.operation!, resolved = JSON.parse(operation.resolvedBody) as { sellerRevision: number; binding: unknown };
    expect(view.invoices[1].sellerSnapshot).toEqual({ organizationId: t.actor.organizationId, ...usFinancialInvoiceSellerProfileV5(commercial) });
    expect(resolved.sellerRevision).toBe(original.sellerRevision); expect(operation.preparation.context.binding).toEqual(original.binding);
    expect(operation.preparation.context.taxFacts).toEqual(original.taxFacts); expect(operation.preparation.context.merchant).toEqual(original.merchant);
    expect(view.invoices[1].total.minorUnits).toBe('32475'); expect(canonicalErpJson(view.invoices[0])).toBe(oldInvoice);
    expect(await validateUsFinancialInvoiceOperationV5(operation, t.actor.organizationId, true)).toEqual(operation);
    expect(t.gateway.calculate).toHaveBeenCalledOnce();
  });
  it('retains the recorded presentation across an uncertain calculated operation and a changed current S', async () => {
    const t = await fixture(), recorded = await presentationContext(t.context()); t.setContext(recorded);
    t.hooks.set(appendRpc, () => { throw new ErpError('synthetic_lost_financial_append', 503); }); await expect(t.issue()).rejects.toMatchObject({ status: 503 });
    const prior = clone(t.state.operation!), changed = clone(recorded) as Extract<UsFinancialInvoiceContextV5, { schemaVersion: 2 }>;
    const payload = { ...changed, presentation: { ...changed.presentation, sellerRevision: changed.presentation.sellerRevision + 1, sellerChangeSha256: 'f'.repeat(64), profile: { displayName: 'Later current seller' } } };
    const { contextSha256: _hash, ...body } = payload; void _hash;
    t.setContext(await validateUsFinancialInvoiceContextV5({ ...body, contextSha256: await digest(body) }, t.actor.organizationId, true)); t.state.gate = null;
    await t.issue(); expect(t.state.operation!.preparation).toEqual(prior.preparation); expect(t.state.operation!.providerKey).toBe(prior.providerKey);
    expect(t.state.operation!.resolvedBody).toBe(prior.resolvedBody); expect(t.gateway.calculate).toHaveBeenCalledOnce();
    expect((await projectUsFinancialBookV5(t.state.book)).invoices[1].sellerSnapshot).toEqual({ organizationId: t.actor.organizationId, ...usFinancialInvoiceSellerProfileV5(recorded) });
  });
});

describe('private V5 invoice issuance with synthetic tax transport', () => {
  it('issues, persists, receives and credits a new invoice on the same true ledger', async () => {
    const t = await fixture(), start = t.state.book.revision, old = canonicalErpJson(t.state.book.baseline);
    const receipt = await t.issue(), issued = await projectUsFinancialBookV5(t.state.book), invoice = issued.invoices.find(i => i.id === 'invoice-2')!;
    expect(receipt).toMatchObject({ entityId: 'invoice-2', action: 'erp_command', revision: start + 1 });
    expect(invoice).toMatchObject({ number: 'SYNTHETIC-INV-000002', total: { minorUnits: '32475' }, tax: { minorUnits: '2475' }, sourceEstimateId: 'estimate-2', sourceEstimateRevision: 2 });
    expect(invoice.sellerSnapshot).not.toHaveProperty('legalName'); expect(invoice.taxAssessment.providerReference).toBe('taxcalc_SyntheticV5');
    expect(t.state.operation).toMatchObject({ status: 'committed', receipt });
    const preparation = t.state.operation!.preparation;
    expect(preparation.financialCommandHash).not.toBe(preparation.erpCommandHash);
    expect(preparation.context.binding.evidenceKind).toBe('test_fixture'); expect(JSON.parse(t.state.operation!.proofBody!).evidenceKind).toBe('test_fixture');
    expect(JSON.parse(t.state.operation!.resolvedBody).commandHash).toBe(preparation.erpCommandHash);
    expect(t.rpc.mock.calls.findIndex(([name]) => name === preflightRpc)).toBeLessThan(t.rpc.mock.calls.findIndex(([name]) => name === reserveRpc));
    expect(t.gateway.calculate).toHaveBeenCalledOnce(); expect(t.choices).toHaveBeenCalledOnce();
    await executeUsFinancialKernelV5(t.full, { idempotencyKey: 'receive-new', expectedRevision: t.state.book.revision, command: { type: 'customer_payment', id: 'receive-new', invoiceId: 'invoice-2', amountMinor: '1000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'SYNTHETIC NO MONEY MOVED' } });
    await executeUsFinancialKernelV5(t.full, { idempotencyKey: 'credit-new', expectedRevision: t.state.book.revision, command: { type: 'customer_credit', id: 'credit-new', invoiceId: 'invoice-2', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
    const view = await projectUsFinancialBookV5(t.state.book);
    expect(view.settlements.find(s => s.invoiceId === 'invoice-2')).toMatchObject({ receivedMinor: '1000', creditedMinor: '10825', outstandingMinor: '20650' });
    expect(view.ledger.revision).toBe(4); expect(trialBalance(view.ledger, '2026-12-31').balanced).toBe(true);
    expect(generalLedger(view.ledger, 'receivables', { start: '2026-01-01', end: '2026-12-31' }).closingMinor).toBe('53125');
    expect(canonicalErpJson(t.state.book.baseline)).toBe(old);
  });
  it('continues issuance after an existing credit, manual journal and close/open of the current periods', async () => {
    const t = await fixture();
    await executeUsFinancialKernelV5(t.full, { idempotencyKey: 'old-credit', expectedRevision: t.state.book.revision, command: { type: 'customer_credit', id: 'old-credit', invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic prior service credit', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
    await t.send('capital-before', { type: 'post_manual_journal', id: 'capital-before', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic capital, no money moved', sourceReference: 'SYNTHETIC', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '5000', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '5000' }] });
    await t.send('close-before', { type: 'close_period', periodId: '2026' });
    await t.send('open-before', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' });
    t.advance(Date.parse('2027-01-05T12:00:00.000Z') - Date.parse(t.now()));
    const old = t.context(), { contextSha256: _oldHash, ...body } = old; void _oldHash;
    const renewed = { ...body, revision: 2, admittedAt: t.now(), binding: { ...body.binding, revision: 2, observedAt: t.now(), validUntil: '2027-01-05T12:02:00.000Z' } };
    t.setContext({ ...renewed, contextSha256: await digest(renewed) });
    t.choices.mockResolvedValue({ classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive' }], taxDateInstant: t.now(), addressSource: 'billing' });
    const command = { ...t.command, date: '2027-01-05', accountingDate: '2027-01-05', dueDate: '2027-02-04', periodId: '2027' };
    await executeUsFinancialKernelV5(t.full, { ...t.request, expectedRevision: t.state.book.revision, command: { type: 'erp_command', request: command } });
    await executeUsFinancialKernelV5(t.full, { idempotencyKey: 'new-year-receipt', expectedRevision: t.state.book.revision, command: { type: 'customer_payment', id: 'new-year-receipt', invoiceId: 'invoice-2', amountMinor: '1000', paymentDate: '2027-01-05', accountingDate: '2027-01-05', periodId: '2027', reference: 'SYNTHETIC' } });
    await executeUsFinancialKernelV5(t.full, { idempotencyKey: 'new-year-credit', expectedRevision: t.state.book.revision, command: { type: 'customer_credit', id: 'new-year-credit', invoiceId: 'invoice-2', transactionDate: '2027-01-05', accountingDate: '2027-01-05', periodId: '2027', reason: 'Synthetic current-year credit', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
    const view = await projectUsFinancialBookV5(t.state.book);
    expect(view.ledger.revision).toBe(8); expect(view.ledger.periods.map(p => [p.id, p.status])).toEqual([['2026', 'closed'], ['2027', 'open']]);
    expect(view.settlements.find(s => s.invoiceId === 'invoice-2')).toMatchObject({ receivedMinor: '1000', creditedMinor: '10825', outstandingMinor: '20650' });
    expect(generalLedger(view.ledger, 'receivables', { start: '2026-01-01', end: '2027-12-31' }).closingMinor).toBe('42300');
    expect(trialBalance(view.ledger, '2027-12-31').balanced).toBe(true);
    const issueEvent = t.state.book.events.find(e => e.operation.type === 'erp_command' && e.operation.command.type === 'issue_invoice');
    expect(issueEvent && 'effects' in issueEvent && issueEvent.commit.header.ledger.revision).toBe(5);
  });
  it.each(['owner', 'admin', 'accountant'] as const)('uses the actual %s financial actor, never a fabricated owner', async role => {
    const t = await fixture({ role }); await t.issue();
    expect(t.rpc.mock.calls.filter(([name]) => [preflightRpc, reserveRpc, recordRpc, appendRpc].includes(name)).every(([, args]) => (args.p_actor as { role: string }).role === role)).toBe(true);
  });
  it('replays exact issuance after later payment and expired merchant without consulting tax ports', async () => {
    const t = await fixture(), receipt = await t.issue();
    await t.send('after-issue', { type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Synthetic later customer name' } });
    t.advance(3600_000); t.rpc.mockClear(); t.choices.mockClear(); t.gateway.calculate.mockClear();
    expect(await t.issue()).toEqual(receipt); expect(t.appends()).toBe(0); expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(t.choices).not.toHaveBeenCalled();
    expect(t.rpc.mock.calls.some(([name]) => [operationRpc, preflightRpc, reserveRpc, recordRpc].includes(name))).toBe(false);
  });
  it.each([reserveRpc, recordRpc, appendRpc])('recovers an exact retry after lost %s response', async phase => {
    const t = await fixture(); t.hooks.set(`${phase}:after`, () => { throw new Error('Synthetic lost transport response'); });
    await expect(t.issue()).rejects.toMatchObject({ status: 503 });
    const result = await t.issue(); expect(result.entityId).toBe('invoice-2');
    expect((await projectUsFinancialBookV5(t.state.book)).invoices.filter(i => i.id === 'invoice-2')).toHaveLength(1);
    expect(t.gateway.calculate).toHaveBeenCalledOnce(); expect(t.state.operation!.retryUntil).toBe('2026-10-11T11:00:00.000Z');
  });
  it.each(['PO011', 'PF001', 'PF002', 'PF013', 'PF014', 'PF015'])('refuses SQL preflight %s before human choices or gateway', async code => {
    const t = await fixture(); t.state.gate = new SupabaseServerError(409, code, 'Synthetic source refusal');
    await expect(t.issue()).rejects.toMatchObject({ status: 409 }); expect(t.choices).not.toHaveBeenCalled(); expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(t.state.operation).toBeNull(); expect(t.appends()).toBe(0);
    if (code === 'PF014') await expect(t.issue()).rejects.toMatchObject({ code: 'financial_invoice_evidence_required' });
  });
  it('requires explicit local fixture opt-in without altering evidence kind', async () => {
    const t = await fixture({ allowFixtures: false }); await expect(t.issue()).rejects.toMatchObject({ code: 'financial_invoice_fixture_disabled' });
    expect(t.choices).not.toHaveBeenCalled(); expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(t.context().binding.evidenceKind).toBe('test_fixture');
  });
  it('refuses a context with fixture evidence relabelled real while its immutable hash remains old', async () => {
    const t = await fixture(), c = t.context(); t.setContext({ ...c, binding: { ...c.binding, evidenceKind: 'provider_observation' } });
    await expect(t.issue()).rejects.toMatchObject({ status: 503 }); expect(t.gateway.calculate).not.toHaveBeenCalled();
  });
  it.each(['source', 'book', 'context', 'extra'])('rejects altered %s preflight response before reservation', async kind => {
    const t = await fixture(); t.transforms.set(preflightRpc, value => {
      const v = clone(value) as { estimate: { notes: string }; bookRevision: number; context: { contextSha256: string }; extra?: boolean };
      if (kind === 'source') v.estimate.notes = 'Synthetic changed source'; if (kind === 'book') v.bookRevision += 1; if (kind === 'context') v.context.contextSha256 = '0'.repeat(64); if (kind === 'extra') v.extra = true; return v;
    });
    await expect(t.issue()).rejects.toBeDefined(); expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(t.appends()).toBe(0);
  });
  it.each(['wrong-account', 'real-mode', 'wrong-tax', 'wrong-evidence'])('rejects %s calculation observation without financial append', async kind => {
    const t = await fixture(); t.gateway.calculate.mockImplementation(async r => {
      const v = observation(r, t.now()); if (kind === 'wrong-account') return { ...v, accountId: 'acct_Other' }; if (kind === 'real-mode') return { ...v, mode: 'live' as 'test' }; if (kind === 'wrong-evidence') return { ...v, evidenceKind: 'provider_observation' };
      return { ...v, calculation: { ...(v.calculation as Record<string, unknown>), tax_amount_exclusive: 100 } };
    });
    await expect(t.issue()).rejects.toBeDefined(); expect(t.state.operation!.status).toBe('reserved'); expect(t.appends()).toBe(0);
  });
  it.each([operationRpc, preflightRpc, reserveRpc, recordRpc])('revocation after %s wins over a malformed private response', async phase => {
    const t = await fixture(); t.hooks.set(`${phase}:after`, () => { t.revoke(); }); t.transforms.set(phase, () => ({ secret: 'PRIVATE NEVER PROJECT' }));
    await expect(t.issue()).rejects.toMatchObject({ status: 401 }); expect(t.appends()).toBe(0);
  });
  it('refuses grant change during gateway and preserves the durable reservation', async () => {
    const t = await fixture(); t.hooks.set('calculate', () => { t.changeGrant(); });
    await expect(t.issue()).rejects.toMatchObject({ code: 'financial_test_grant_changed' }); expect(t.state.operation!.status).toBe('reserved'); expect(t.appends()).toBe(0);
  });
  it('refuses an expired binding after a slow calculation without extending any clock', async () => {
    const t = await fixture(); t.hooks.set('calculate', () => { t.advance(91_000); });
    await expect(t.issue()).rejects.toBeDefined(); expect(t.state.operation!.status).toBe('reserved'); expect(t.appends()).toBe(0); expect(t.state.operation!.retryUntil).toBe('2026-10-11T11:00:00.000Z');
  });
  it.each([undefined, null, false])('does not treat a falsy thrown gateway error (%s) as success', async thrown => {
    const t = await fixture(); t.gateway.calculate.mockImplementation(async () => { throw thrown; });
    await expect(t.issue()).rejects.toBeDefined(); expect(t.state.operation!.status).toBe('reserved'); expect(t.appends()).toBe(0);
  });
  it('captures gateway and store methods before callbacks can replace them', async () => {
    const t = await fixture(); expect(Object.isFrozen(t.taxStore)).toBe(true); t.hooks.set(preflightRpc, () => { t.gateway.calculate = vi.fn(async () => { throw Error('Mutable gateway replacement'); }); });
    await t.issue(); expect(t.state.operation!.status).toBe('committed');
  });
  it('detaches and freezes the request passed to human choices and tax ports', async () => {
    const t = await fixture();
    t.choices.mockImplementation(async function () {
      const args = t.choices.mock.calls.at(-1) as unknown as [{ request: UsFinancialRequestV5 }];
      expect(Object.isFrozen(args[0].request)).toBe(true);
      if (args[0].request.command.type !== 'erp_command') throw Error('Synthetic command expected');
      const command = args[0].request.command.request;
      expect(Object.isFrozen(command)).toBe(true);
      expect(() => { (command as { date: string }).date = '2027-01-01'; }).toThrow();
      return { classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive' }], taxDateInstant: t.now(), addressSource: 'billing' };
    });
    await t.issue(); expect(t.state.operation!.preparation.erpRequest.command).toMatchObject({ date: '2026-10-10' });
  });
  it('handles a concurrently committed operation by requiring the financial runtime retry', async () => {
    const t = await fixture(), capturedBook = clone(t.state.book); await t.issue(); t.rpc.mockClear(); t.gateway.calculate.mockClear();
    await expect(t.resolver({ organizationId: t.actor.organizationId, actor: t.actor, idempotencyKey: t.request.idempotencyKey, commandHash: await digest([t.actor.organizationId, t.actor.userId, t.request]), book: capturedBook, command: t.command })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(t.rpc.mock.calls.map(([name]) => name)).toEqual([operationRpc]); expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(await t.issue()).toEqual(t.state.operation!.receipt);
  });
  it('keeps malformed financial append replies from becoming a local success', async () => {
    const t = await fixture(); t.transforms.set(appendRpc, value => ({ ...(value as Record<string, unknown>), commandHash: '0'.repeat(64), secret: 'PRIVATE' }));
    await expect(t.issue()).rejects.toMatchObject({ status: 503 }); expect(t.state.operation!.status).toBe('committed');
    t.transforms.delete(appendRpc); expect(await t.issue()).toEqual(t.state.operation!.receipt); expect(t.gateway.calculate).toHaveBeenCalledOnce();
  });
  it('rejects a hash-valid future admission before any human/catalogue callback', async () => {
    const t = await fixture(), { contextSha256: _hash, ...old } = t.context(); void _hash;
    const c = { ...old, admittedAt: '2026-10-10T12:00:30.000Z', binding: { ...old.binding, observedAt: '2026-10-10T12:00:30.000Z', validUntil: '2026-10-10T12:02:30.000Z' } };
    t.setContext({ ...c, contextSha256: await digest(c) }); await expect(t.issue()).rejects.toMatchObject({ code: 'binding_unavailable' }); expect(t.choices).not.toHaveBeenCalled(); expect(t.gateway.calculate).not.toHaveBeenCalled();
  });
  it('rejects malformed/prototyped input without invoking getters or RPC', async () => {
    const t = await fixture(), getter = vi.fn(() => t.request); t.rpc.mockClear();
    await expect(t.taxStore.read(t.actor, Object.defineProperty({}, 'request', { get: getter, enumerable: true }) as never)).rejects.toMatchObject({ status: 503 }); expect(getter).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('rejects an inner/outer hash swap before the tax RPC', async () => {
    const t = await fixture(), outer = await digest([t.actor.organizationId, t.actor.userId, t.request]);
    await expect(t.taxStore.read(t.actor, { request: t.request, financialCommandHash: outer, erpCommandHash: outer })).rejects.toMatchObject({ code: 'idempotency_conflict' }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('captures the financial RPC port before an awaited authority callback replaces it', async () => {
    const t = await fixture(), replacement = vi.fn(async () => { throw Error('Mutable financial RPC replacement'); }), client = { rpc: t.rpc };
    const store = createSupabaseUsFinancialInvoicingTestStoreV5(client, t.scope, async () => { client.rpc = replacement as typeof t.rpc; return t.scope; });
    expect(await store.read(t.actor.organizationId)).toEqual(t.state.book); expect(replacement).not.toHaveBeenCalled(); expect(t.rpc).toHaveBeenCalledWith(readRpc, expect.anything());
  });
  it('captures the fiscal RPC port before an awaited authority callback replaces it', async () => {
    const t = await fixture(), replacement = vi.fn(async () => { throw Error('Mutable fiscal RPC replacement'); }), client = { rpc: t.rpc };
    const store = createSupabaseUsFinancialInvoiceTestStoreV5(client, t.scope, async () => { client.rpc = replacement as typeof t.rpc; return t.scope; }, { allowTestFixtures: true });
    const financialCommandHash = await digest([t.actor.organizationId, t.actor.userId, t.request]);
    const erpCommandHash = await digest([t.actor.organizationId, t.actor.userId, { idempotencyKey: t.request.idempotencyKey, expectedRevision: t.request.expectedRevision, command: t.command }]);
    expect(await store.read(t.actor, { request: t.request, financialCommandHash, erpCommandHash })).toBeNull(); expect(replacement).not.toHaveBeenCalled(); expect(t.rpc).toHaveBeenCalledWith(operationRpc, expect.anything());
  });
  it('refuses corrupted operation/proof bodies and retains historical clocks', async () => {
    const t = await fixture(); await t.issue(); const saved = clone(t.state.operation!);
    await expect(validateUsFinancialInvoiceOperationV5({ ...saved, retryUntil: '2026-10-12T11:00:00.000Z' }, t.actor.organizationId, true)).rejects.toMatchObject({ status: 503 });
    await expect(validateUsFinancialInvoiceOperationV5({ ...saved, proofSha256: '0'.repeat(64) }, t.actor.organizationId, true)).rejects.toBeDefined();
    await expect(validateUsFinancialInvoiceOperationV5(saved, t.actor.organizationId, true)).resolves.toEqual(saved);
  });
  it.each(['save_project', 'record_payment', 'refresh_configuration'])('keeps unsupported %s closed before financial I/O', async type => {
    const t = await fixture(); t.rpc.mockClear();
    const command = type === 'save_project' ? { type, project: { id: 'project', organizationId: t.actor.organizationId, name: 'Synthetic project', customerId: 'customer-1', status: 'active' } }
      : type === 'record_payment' ? { type, id: 'old-payment', invoiceId: 'invoice-1', amountMinor: '1', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic legacy payment' }
      : { type, expectedCountryRevision: 1 };
    await expect(executeUsFinancialKernelV5(t.full, { idempotencyKey: 'unsupported', expectedRevision: t.state.book.revision, command: { type: 'erp_command', request: command } })).rejects.toBeDefined(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('old accounting capability refuses issuance before I/O and a new invoice tail on read', async () => {
    const t = await fixture(), oldStore = createSupabaseUsFinancialAccountingTestStoreV5({ rpc: t.rpc }, t.scope, t.revalidate);
    await expect(executeUsFinancialKernelV5({ ...t.full, store: oldStore }, t.request)).rejects.toMatchObject({ code: 'financial_append_unavailable' }); expect(t.rpc).not.toHaveBeenCalled();
    await t.issue(); await expect(oldStore.read(t.actor.organizationId)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
  });
  it('SQL final refusal does not consume a financial revision or issue a second calculation', async () => {
    const t = await fixture(), before = canonicalErpJson(t.state.book);
    t.hooks.set(appendRpc, () => { t.state.gate = new SupabaseServerError(409, 'PO011', 'Synthetic concurrent source refusal'); });
    await expect(t.issue()).rejects.toMatchObject({ code: 'sales_order_confirmation_required' }); expect(canonicalErpJson(t.state.book)).toBe(before); expect(t.state.operation!.status).toBe('calculated');
    t.state.gate = null; await t.issue(); expect(t.gateway.calculate).toHaveBeenCalledOnce();
  });
  it('does not claim that matching context hashes authenticate merchant provenance', async () => {
    const t = await fixture(), context = t.context();
    await expect(validateUsFinancialInvoiceContextV5(context, t.actor.organizationId, true)).resolves.toEqual(context);
    expect(t.rpc.mock.calls.some(([name]) => name.includes('activate') || name.includes('context'))).toBe(false);
  });
});
