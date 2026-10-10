import { describe, expect, it } from 'vitest';
import type { FinancialAuthority } from './accounting/ledger';
import { balanceSheet, cashFlow, generalLedger, profitAndLoss, trialBalance } from './accounting/reports';
import { canonicalErpJson } from './erp-contract';
import type { TaxCalculationProvider } from './invoicing';
import { money } from './money';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommand, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, fingerprintUsFinancialInvoiceV5, projectUsFinancialBookV5, promoteUsFinancialBookV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialCreditInputV5, UsFinancialOperationV5, UsFinancialPolicyV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';

const org = 'test-financial-kernel-workspace';
const timestamp = '2026-10-10T12:00:00.000Z';
const actor: FinancialAuthority = { organizationId: org, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp };
const policy: UsFinancialPolicyV5 = { version: 'us-accrual-receivable-credit-v1', environment: 'test', approval: { reference: 'test-policy-review-only', reviewedBy: 'fictitious-qualified-reviewer', reviewedAt: '2026-10-10T11:00:00.000Z' } };
async function fixture(options: { paid?: string; tax?: string; basis?: 'cash' | 'accrual'; discount?: number; secondInvoice?: boolean; closed?: boolean } = {}) {
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'Brooklyn', postalCode: '11201', subdivision: 'NY' }, accountingBasis: options.basis ?? 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } };
  let state: ErpState | null = null, seq = 0; const receipts = new Map<string, ErpReceipt>();
  const store: ErpStore = { supportedSchemaVersion: 4, read: async () => state, receipt: async (_org, key) => receipts.get(key) ?? null, commit: async c => {
    state = applyErpDelta(state, { schemaVersion: 4, organizationId: org, fromRevision: c.expectedRevision, toRevision: c.header.revision, headRevision: c.header.revision, hasMore: false, resetRequired: false, events: [{ schemaVersion: 4, organizationId: org, revision: c.header.revision, header: c.header, changes: c.changes, ledgerAudit: c.ledgerAudit, receipt: c.receipt, actorId: c.actor.userId, occurredAt: c.actor.timestamp }] }, org, 4); receipts.set(c.receipt.idempotencyKey, c.receipt); return c.receipt;
  } };
  const provider: TaxCalculationProvider = { id: 'fictitious-not-tax-law', calculate: async request => ({ ...request, source: 'external-provider', providerReference: 'taxcalc_fictitious', determinedAt: '2026-10-10T11:00:00Z', validUntil: '2026-10-10T13:00:00Z', lines: request.lines.map(l => ({ id: l.id, taxMinor: options.tax ?? '2475', jurisdiction: 'fictitious-jurisdiction', evidenceReference: `taxcalc_fictitious:taxli_${l.id}` })) }) };
  const send = async (command: ErpCommand) => executeErp({ configuration, actor, store, revalidate: async () => actor, taxProvider: async () => provider, seller: async () => ({ organizationId: org, displayName: 'Fictitious Seller' }) }, { idempotencyKey: `fixture-${++seq}`, expectedRevision: state?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'customer', organizationId: org, kind: 'business', name: 'Fictitious Buyer', billingAddress: configuration.address, paymentTermsDays: 30 } });
  await send({ type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: 'customer', date: '2026-10-09', expiresAt: '2026-11-09', paymentTermsDays: 30, notes: 'Test only', lines: [{ id: 'line', description: 'Fictitious goods', quantityUnits: '3', quantityScale: 0, unitPrice: money('USD', '10000'), discountBasisPoints: options.discount ?? 0, taxTreatment: 'taxable' }] });
  await send({ type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 });
  await send({ type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-09', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: '2026' });
  if (options.secondInvoice) {
    await send({ type: 'save_estimate', id: 'estimate-two', expectedEstimateRevision: 0, customerId: 'customer', date: '2026-10-09', expiresAt: '2026-11-09', paymentTermsDays: 30, notes: 'Test only', lines: [{ id: 'line', description: 'Other fictitious goods', quantityUnits: '3', quantityScale: 0, unitPrice: money('USD', '10000'), discountBasisPoints: 0, taxTreatment: 'taxable' }] });
    await send({ type: 'accept_estimate', estimateId: 'estimate-two', expectedEstimateRevision: 1 });
    await send({ type: 'issue_invoice', id: 'invoice-two', estimateId: 'estimate-two', expectedEstimateRevision: 2, date: '2026-10-09', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: '2026' });
  }
  if (options.paid) await send({ type: 'record_payment', id: 'baseline-payment', invoiceId: 'invoice', amountMinor: options.paid, paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Fictitious bank payment' });
  if (options.closed) await send({ type: 'close_period', periodId: '2026' });
  const baseline = state!;
  const credit: UsFinancialCreditInputV5 = { type: 'customer_credit', idempotencyKey: 'credit-one', invoiceId: 'invoice', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Fictitious returned goods', selections: [{ lineId: 'line', quantityUnits: '1' }] };
  const promote = () => promoteUsFinancialBookV5(baseline, policy, actor);
  return { baseline, actor, policy, credit, send, promote };
}
async function authorized(book: UsFinancialBookV5, input: UsFinancialCreditInputV5, patch: Partial<UsFinancialTaxProofV5> = {}): Promise<UsFinancialOperationV5> {
  const c = await buildUsFinancialCreditCandidateV5(book, input);
  const zeroTax = c.allocation.lines.every(l => c.source.lines.find(s => s.lineId === l.lineId)?.taxMinor === '0');
  const taxProof: UsFinancialTaxProofV5 = zeroTax ? { schemaVersion: 1, environment: 'test', kind: 'historical_zero_tax', reference: 'historical-assessment-reviewed', verifiedBy: 'trusted-test-resolver', verifiedAt: timestamp, invoiceFingerprint: c.invoiceFingerprint, allocationSha256: c.allocationSha256 } : { schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', reference: 'fictitious-review-not-provider-reversal', verifiedBy: 'trusted-test-resolver', verifiedAt: timestamp, invoiceFingerprint: c.invoiceFingerprint, allocationSha256: c.allocationSha256, providerAccountReference: 'acct_fictitious', originalTaxTransactionReference: 'testtxn_fictitious', adjustmentPlanReference: `testplan_${input.idempotencyKey}`, authorizedTaxMinor: c.allocation.taxMinor };
  return { ...input, taxProof: { ...taxProof, ...patch } as UsFinancialTaxProofV5 };
}
const payment = (amountMinor: string, idempotencyKey = 'payment-one'): UsFinancialOperationV5 => ({ type: 'customer_payment', idempotencyKey, invoiceId: 'invoice', amountMinor, paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Fictitious bank transfer' });
function clone<T>(value: T): T { return structuredClone(value); }

describe('US internal financial capability5', () => {
  it('promotes an exact immutable ERP4 baseline without altering any old source or journal', async () => {
    const t = await fixture(), before = canonicalErpJson(t.baseline), book = await t.promote();
    expect(book.schemaVersion).toBe(5); expect(book.revision).toBe(t.baseline.revision + 1); expect(book.events).toEqual([]);
    expect(canonicalErpJson(book.baseline)).toBe(before); expect(canonicalErpJson(t.baseline)).toBe(before);
    const view = await projectUsFinancialBookV5(book); expect(view.ledger).toEqual(t.baseline.ledger); expect(view.settlements[0].outstandingMinor).toBe('32475');
    expect(Reflect.ownKeys(book).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['baseline', 'events', 'policy', 'promotion', 'revision', 'schemaVersion']);
    expect(Object.isFrozen(book.baseline.invoices[0])).toBe(true);
  });
  it.each(['admin', 'accountant', 'member', 'read_only'] as const)('requires owner to promote, refusing %s', async role => {
    const t = await fixture(); await expect(promoteUsFinancialBookV5(t.baseline, policy, { ...actor, role })).rejects.toMatchObject({ code: role === 'member' || role === 'read_only' ? 'financial_permission_required' : 'owner_required' });
  });
  it('rejects cash books rather than reusing accrual rules', async () => { const t = await fixture({ basis: 'cash' }); await expect(t.promote()).rejects.toMatchObject({ code: 'financial_baseline_required' }); });
  it.each(['live', 'production', '', null])('rejects policy environment%o', async environment => {
    const t = await fixture(); await expect(promoteUsFinancialBookV5(t.baseline, { ...policy, environment } as UsFinancialPolicyV5, actor)).rejects.toMatchObject({ code: 'financial_policy_unavailable' });
  });
  it('requires the exact separately trusted policy during validation', async () => {
    const t = await fixture(), book = await t.promote(); await expect(validateUsFinancialBookV5(book, org, { ...policy, approval: { ...policy.approval, reference: 'different-review' } })).rejects.toMatchObject({ code: 'financial_policy_changed' });
  });
  it('preserves and verifies owner promotion provenance and the exact baseline fingerprint', async () => {
    const t = await fixture(), book = await t.promote();
    expect(book.promotion.actor).toEqual(actor); expect(book.promotion.baselineSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(validateUsFinancialBookV5({ ...book, promotion: { ...book.promotion, actor: { ...actor, role: 'admin' } } }, org, policy)).rejects.toMatchObject({ code: 'owner_required' });
    await expect(validateUsFinancialBookV5({ ...book, promotion: { ...book.promotion, actor: { ...actor, timestamp: '2026-10-10T11:00:00.000Z' } } }, org, policy)).rejects.toMatchObject({ code: 'financial_clock_reversed' });
    const baseline = clone(book.baseline) as unknown as { customers: { name: string }[] }; baseline.customers[0].name = 'Different current contact';
    await expect(validateUsFinancialBookV5({ ...book, baseline }, org, policy)).rejects.toMatchObject({ code: 'financial_baseline_changed' });
    await expect(validateUsFinancialBookV5({ ...book, promotion: { ...book.promotion, baselineSha256: 'a'.repeat(64) } }, org, policy)).rejects.toMatchObject({ code: 'financial_baseline_changed' });
  });
  it('issues an immutable credit and balanced posting; no cash moves and original invoice remains exact', async () => {
    const t = await fixture(), book = await t.promote(), before = canonicalErpJson(book), op = await authorized(book, t.credit);
    const result = await applyUsFinancialOperationV5(book, op, actor, 'credit-record');
    expect(canonicalErpJson(book)).toBe(before); expect(result.book.revision).toBe(book.revision + 1);
    expect(result.view.invoices).toEqual(t.baseline.invoices);
    expect(result.view.credits[0]).toMatchObject({ number: 'CR-2026-000001', taxDisposition: 'adjustment_pending', allocation: { netMinor: '10000', taxMinor: '825', totalMinor: '10825' } });
    expect(result.view.settlements[0]).toMatchObject({ totalMinor: '32475', receivedMinor: '0', creditedMinor: '10825', outstandingMinor: '21650', status: 'partially_settled' });
    expect(result.book.events[0].posting.lines).toEqual([{ accountId: 'sales', debitMinor: '10000', creditMinor: '0' }, { accountId: 'tax-payable', debitMinor: '825', creditMinor: '0' }, { accountId: 'receivables', debitMinor: '0', creditMinor: '10825' }]);
    expect(cashFlow(result.view.ledger, { start: '2026-01-01', end: '2026-12-31' }).netChangeMinor).toBe('0');
    expect(trialBalance(result.view.ledger, '2026-12-31').balanced).toBe(true); expect(balanceSheet(result.view.ledger, '2026-12-31').balanced).toBe(true);
    expect(profitAndLoss(result.view.ledger, { start: '2026-01-01', end: '2026-12-31' }).incomeMinor).toBe('20000');
    expect(generalLedger(result.view.ledger, 'receivables', { start: '2026-01-01', end: '2026-12-31' }).closingMinor).toBe('21650');
    expect(Object.hasOwn(result.view.credits[0], 'taxProof')).toBe(false);
    expect(result.book.events[0].operation).toEqual(op);
  });
  it('keeps actual payments distinct and accepts a credit within remaining AR after partial payment', async () => {
    const t = await fixture({ paid: '10000' }), book = await t.promote(), r = await applyUsFinancialOperationV5(book, await authorized(book, t.credit), actor, 'credit');
    expect(r.view.settlements[0]).toMatchObject({ receivedMinor: '10000', creditedMinor: '10825', outstandingMinor: '11650' });
    const paid = await applyUsFinancialOperationV5(r.book, payment('11650'), actor, 'new-payment');
    expect(paid.view.settlements[0]).toMatchObject({ receivedMinor: '21650', creditedMinor: '10825', outstandingMinor: '0', status: 'settled_with_credit' });
    expect(paid.view.invoices[0].total.minorUnits).toBe('32475'); expect(paid.view.invoices[0].payments).toHaveLength(2);
    expect(generalLedger(paid.view.ledger, 'receivables', { start: '2026-01-01', end: '2026-12-31' }).closingMinor).toBe('0');
    expect(cashFlow(paid.view.ledger, { start: '2026-01-01', end: '2026-12-31' }).netChangeMinor).toBe('21650');
    expect(profitAndLoss(paid.view.ledger, { start: '2026-01-01', end: '2026-12-31' }).incomeMinor).toBe('20000');
  });
  it('rejects overpayment after credit even though legacy invoiceBalance is higher', async () => {
    const t = await fixture(), book = await t.promote(), r = await applyUsFinancialOperationV5(book, await authorized(book, t.credit), actor, 'credit');
    await expect(applyUsFinancialOperationV5(r.book, payment('21651'), actor, 'payment')).rejects.toMatchObject({ code: 'payment_exceeds_outstanding' });
    expect(r.view.invoices[0].payments).toEqual([]);
  });
  it.each(['21651', '32475'])('rejects credits exceeding outstanding after payment%o', async paid => {
    const t = await fixture({ paid }), book = await t.promote(); await expect(buildUsFinancialCreditCandidateV5(book, { ...t.credit, selections: [{ lineId: 'line', quantityUnits: '3' }] })).rejects.toMatchObject({ code: 'credit_exceeds_outstanding' });
  });
  it('allocates successive quantities cumulatively and exact final cents after original discount', async () => {
    const t = await fixture({ tax: '1', discount: 3333 }); let book = await t.promote(); const net: string[] = [], tax: string[] = [];
    for (let i = 0; i < 3; i++) { const input = { ...t.credit, idempotencyKey: `slice-${i}` }, r = await applyUsFinancialOperationV5(book, await authorized(book, input), actor, `credit-${i}`); net.push(r.view.credits.at(-1)!.allocation.netMinor); tax.push(r.view.credits.at(-1)!.allocation.taxMinor); book = r.book; }
    const view = await projectUsFinancialBookV5(book);
    expect(net).toEqual(['6667', '6667', '6667']); expect(tax).toEqual(['0', '1', '0']);
    expect(view.settlements[0]).toMatchObject({ creditedMinor: '20002', outstandingMinor: '0', status: 'credited', receivedMinor: '0' });
    expect(view.credits.map(c => c.number)).toEqual(['CR-2026-000001', 'CR-2026-000002', 'CR-2026-000003']);
    await expect(buildUsFinancialCreditCandidateV5(book, { ...t.credit, idempotencyKey: 'too-much' })).rejects.toMatchObject({ code: 'credit_quantity_exceeded' });
  });
  it('does not infer zero-tax authority from a slice rounded to zero tax', async () => {
    const t = await fixture({ tax: '1' }), book = await t.promote(), op = await authorized(book, t.credit, { kind: 'historical_zero_tax' }), c = await buildUsFinancialCreditCandidateV5(book, t.credit);
    expect(c.allocation.taxMinor).toBe('0');
    if (op.type !== 'customer_credit') throw new Error('credit fixture');
    const { providerAccountReference: _account, originalTaxTransactionReference: _txn, adjustmentPlanReference: _plan, authorizedTaxMinor: _tax, ...baseProof } = op.taxProof as Extract<UsFinancialTaxProofV5, { kind: 'test_adjustment_authorization' }>;
    await expect(applyUsFinancialOperationV5(book, { ...op, taxProof: baseProof as UsFinancialTaxProofV5 }, actor, 'credit')).rejects.toMatchObject({ code: 'tax_adjustment_required' });
  });
  it('accepts verified historical zero-tax and stores no pending adjustment', async () => {
    const t = await fixture({ tax: '0' }), book = await t.promote(), r = await applyUsFinancialOperationV5(book, await authorized(book, t.credit), actor, 'credit');
    expect(r.view.credits[0].taxDisposition).toBe('historical_zero_tax');
    expect(r.book.events[0].posting.lines).toHaveLength(2);
  });
  it.each(['invoiceFingerprint', 'allocationSha256', 'authorizedTaxMinor'] as const)('rejects a trusted proof with mismatched%s', async field => {
    const t = await fixture(), book = await t.promote(), op = await authorized(book, t.credit, { [field]: field === 'authorizedTaxMinor' ? '1' : 'a'.repeat(64) });
    await expect(applyUsFinancialOperationV5(book, op, actor, 'credit')).rejects.toMatchObject({ code: 'financial_proof_mismatch' });
  });
  it.each(['taxcalc_fake', 'taxcalc_fake:taxli_fake', 'not-a-transaction'])('refuses calculation/reference masquerading as tax transaction%s', async originalTaxTransactionReference => {
    const t = await fixture(), book = await t.promote(), op = await authorized(book, t.credit, { originalTaxTransactionReference });
    await expect(applyUsFinancialOperationV5(book, op, actor, 'credit')).rejects.toMatchObject({ code: 'tax_transaction_required' });
  });
  it('prevents one durable adjustment plan from authorizing two credits', async () => {
    const t = await fixture(), book = await t.promote(), r = await applyUsFinancialOperationV5(book, await authorized(book, t.credit), actor, 'credit');
    const second = { ...t.credit, idempotencyKey: 'credit-two' }, op = await authorized(r.book, second, { adjustmentPlanReference: 'testplan_credit-one' });
    await expect(applyUsFinancialOperationV5(r.book, op, actor, 'credit-two')).rejects.toMatchObject({ code: 'tax_adjustment_plan_conflict' });
  });
  it('does not reuse one original tax transaction for another invoice in the same provider account', async () => {
    const t = await fixture({ secondInvoice: true }), book = await t.promote(), first = await applyUsFinancialOperationV5(book, await authorized(book, t.credit), actor, 'credit');
    const input = { ...t.credit, invoiceId: 'invoice-two', idempotencyKey: 'credit-two' };
    await expect(applyUsFinancialOperationV5(first.book, await authorized(first.book, input), actor, 'credit-two')).rejects.toMatchObject({ code: 'tax_transaction_invoice_conflict' });
  });
  it('retains the published request key length without exceeding journal limits', async () => {
    const t = await fixture(), book = await t.promote(), input = { ...t.credit, idempotencyKey: 'c'.repeat(232) }, r = await applyUsFinancialOperationV5(book, await authorized(book, input), actor, 'credit');
    expect(r.book.events[0].posting.idempotencyKey).toHaveLength(239);
    await expect(buildUsFinancialCreditCandidateV5(book, { ...input, idempotencyKey: 'c'.repeat(233) })).rejects.toMatchObject({ code: 'invalid_financial_operation' });
  });
  it('replays exact idempotency without another record, posting or revision', async () => {
    const t = await fixture(), book = await t.promote(), op = await authorized(book, t.credit), r = await applyUsFinancialOperationV5(book, op, actor, 'credit');
    const replay = await applyUsFinancialOperationV5(r.book, op, { ...actor, timestamp: '2026-10-10T12:01:00.000Z' }, 'credit');
    expect(replay).toEqual(r);
    await expect(applyUsFinancialOperationV5(r.book, { ...op, reason: 'changed' } as UsFinancialOperationV5, actor, 'credit')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(applyUsFinancialOperationV5(r.book, op, actor, 'other-id')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(applyUsFinancialOperationV5(r.book, op, { ...actor, userId: 'another-accountant' }, 'credit')).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('rejects reused entity IDs and baseline payment identities', async () => {
    const t = await fixture({ paid: '1' }), book = await t.promote();
    await expect(applyUsFinancialOperationV5(book, payment('1'), actor, 'baseline-payment')).rejects.toMatchObject({ code: 'financial_entity_conflict' });
    const r = await applyUsFinancialOperationV5(book, payment('1'), actor, 'new-payment');
    await expect(applyUsFinancialOperationV5(r.book, payment('1', 'payment-two'), actor, 'new-payment')).rejects.toMatchObject({ code: 'financial_entity_conflict' });
  });
  it.each(['member', 'read_only'] as const)('refuses financial operation by%s', async role => { const t = await fixture(), book = await t.promote(); await expect(applyUsFinancialOperationV5(book, payment('1'), { ...actor, role }, 'payment')).rejects.toMatchObject({ code: 'financial_permission_required' }); });
  it.each(['admin', 'accountant'] as const)('admits financial operation by%s', async role => { const t = await fixture(), book = await t.promote(), r = await applyUsFinancialOperationV5(book, payment('1'), { ...actor, role }, 'payment'); expect(r.view.settlements[0].receivedMinor).toBe('1'); });
  it('rejects tenant mismatch, lost entitlement and reversed authority clock', async () => {
    const t = await fixture(), book = await t.promote();
    await expect(applyUsFinancialOperationV5(book, payment('1'), { ...actor, organizationId: 'other-org' }, 'p')).rejects.toMatchObject({ code: 'tenant_mismatch' });
    await expect(applyUsFinancialOperationV5(book, payment('1'), { ...actor, managementEntitled: false }, 'p')).rejects.toMatchObject({ code: 'management_entitlement_required' });
    await expect(applyUsFinancialOperationV5(book, payment('1'), { ...actor, timestamp: '2026-10-10T11:59:59.000Z' }, 'p')).rejects.toMatchObject({ code: 'financial_clock_reversed' });
  });
  it('checks period and invoice dates before any operation', async () => {
    const t = await fixture(), book = await t.promote();
    await expect(buildUsFinancialCreditCandidateV5(book, { ...t.credit, periodId: 'missing' })).rejects.toMatchObject({ code: 'accounting_period_not_open' });
    await expect(buildUsFinancialCreditCandidateV5(book, { ...t.credit, transactionDate: '2026-10-08' })).rejects.toMatchObject({ code: 'credit_precedes_invoice' });
    await expect(applyUsFinancialOperationV5(book, { ...payment('1'), paymentDate: '2026-10-08' } as UsFinancialOperationV5, actor, 'p')).rejects.toMatchObject({ code: 'payment_precedes_invoice' });
    await expect(applyUsFinancialOperationV5(book, { ...payment('1'), accountingDate: '2027-01-01' } as UsFinancialOperationV5, actor, 'p')).rejects.toMatchObject({ code: 'accounting_period_not_open' });
  });
  it('does not reopen a closed baseline period for a credit or payment', async () => {
    const t = await fixture({ closed: true }), book = await t.promote();
    await expect(buildUsFinancialCreditCandidateV5(book, t.credit)).rejects.toMatchObject({ code: 'accounting_period_not_open' });
    await expect(applyUsFinancialOperationV5(book, payment('1'), actor, 'p')).rejects.toMatchObject({ code: 'accounting_period_not_open' });
    expect(book.baseline.ledger.periods[0].status).toBe('closed'); expect(book.events).toEqual([]);
  });
  it.each(['2026-10-10T12:01:00.000Z', '2026-10-10T11:59:59.000Z'])('rejects proof timestamp outside source/actor chronology%s', async verifiedAt => {
    const t = await fixture(), book = await t.promote(), op = await authorized(book, t.credit, { verifiedAt });
    await expect(applyUsFinancialOperationV5(book, op, actor, 'credit')).rejects.toMatchObject({ code: 'financial_proof_mismatch' });
  });
  it('replays each event into exact current balances, source, records, postings and audit', async () => {
    const t = await fixture(), initial = await t.promote(), one = await applyUsFinancialOperationV5(initial, await authorized(initial, t.credit), actor, 'credit'), two = await applyUsFinancialOperationV5(one.book, payment('10000'), actor, 'payment');
    const validated = await validateUsFinancialBookV5(clone(two.book), org, policy), view = await projectUsFinancialBookV5(validated);
    expect(validated).toEqual(two.book); expect(view).toEqual(two.view); expect(view.ledger.audit.length).toBe(t.baseline.ledger.audit.length + 2);
    expect(await fingerprintUsFinancialInvoiceV5(view.invoices[0])).toBe(await fingerprintUsFinancialInvoiceV5(t.baseline.invoices[0]));
  });
  it.each(['revision', 'record', 'posting', 'actor', 'operation'] as const)('rejects mutated immutable event%s', async field => {
    const t = await fixture(), initial = await t.promote(), r = await applyUsFinancialOperationV5(initial, await authorized(initial, t.credit), actor, 'credit'), changed = clone(r.book) as unknown as { events: Record<string, unknown>[] };
    if (field === 'revision') changed.events[0].revision = 999;
    else if (field === 'record') (changed.events[0].record as { reason: string }).reason = 'tampered';
    else if (field === 'posting') (changed.events[0].posting as { lines: { debitMinor: string }[] }).lines[0].debitMinor = '1';
    else if (field === 'actor') (changed.events[0].actor as { userId: string }).userId = 'forged';
    else (changed.events[0].operation as { reason: string }).reason = 'tampered';
    await expect(validateUsFinancialBookV5(changed, org, policy)).rejects.toBeDefined();
  });
  it('refuses missing, reordered or duplicated history and a duplicated current-ledger copy', async () => {
    const t = await fixture(), initial = await t.promote(), one = await applyUsFinancialOperationV5(initial, await authorized(initial, t.credit), actor, 'credit'), two = await applyUsFinancialOperationV5(one.book, payment('1'), actor, 'payment');
    for (const events of [[], [...two.book.events].reverse(), [two.book.events[0], two.book.events[0]]]) await expect(validateUsFinancialBookV5({ ...two.book, events }, org, policy)).rejects.toBeDefined();
    await expect(validateUsFinancialBookV5({ ...two.book, ledger: two.view.ledger }, org, policy)).rejects.toBeDefined();
  });
  it('does not expose raw fiscal evidence in the candidate or credit record', async () => {
    const t = await fixture(), book = await t.promote(), c = await buildUsFinancialCreditCandidateV5(book, t.credit), r = await applyUsFinancialOperationV5(book, await authorized(book, t.credit), actor, 'credit');
    const json = JSON.stringify([c, r.view.credits]); expect(json).not.toContain('taxcalc_fictitious'); expect(json).not.toContain('taxli_'); expect(json).not.toContain('originalTaxTransactionReference');
    expect(c.source.lines[0].evidenceReference).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it('captures caller input before awaits and returns deeply frozen financial state', async () => {
    const t = await fixture(), book = await t.promote(), op = clone(await authorized(book, t.credit)), suppliedActor = { ...actor }, promise = applyUsFinancialOperationV5(book, op, suppliedActor, 'credit');
    if (op.type === 'customer_credit') (op as { reason: string }).reason = 'changed during hash'; suppliedActor.userId = 'changed';
    const r = await promise; expect(r.view.credits[0].reason).toBe(t.credit.reason); expect(r.view.credits[0].issuedBy).toBe(actor.userId);
    for (const value of [r.book, r.book.events, r.book.events[0], r.book.events[0].operation, r.book.events[0].record, r.book.events[0].posting, r.view, r.view.credits, r.view.settlements, r.view.invoices[0]]) expect(Object.isFrozen(value)).toBe(true);
  });
});
