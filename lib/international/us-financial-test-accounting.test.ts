import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { balanceSheet, cashFlow, generalLedger, profitAndLoss, trialBalance } from './accounting/reports';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommand, ErpReceipt, ErpStore } from './runtime-types';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { executeUsFinancialKernelV5, type UsFinancialCommitV5, type UsFinancialReceiptV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialErpEventV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
import { createSupabaseUsFinancialAccountingTestStoreV5 } from './us-financial-test-accounting';
import { createSupabaseUsFinancialCommercialTestStoreV5 } from './us-financial-test-commercial';
import type { UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialPurchasingTestStoreV5 } from './us-financial-test-purchasing';
import { createSupabaseUsFinancialSettlementTestStoreV5 } from './us-financial-test-settlement';

// Real domain, ERP executor, immutable V5 replay and private adapter; synthetic
// RPC only. No PostgreSQL transaction, hosted permission, bank, provider effect
// or production/concurrent durability guarantee is established by this file.
const readRpc = 'zentra_read_us_financial_accounting_test_v5';
const receiptRpc = 'zentra_us_financial_accounting_test_receipt_v5';
const appendRpc = 'zentra_append_us_financial_accounting_test_v5';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const range = { start: '2026-01-01', end: '2027-12-31' };
type Manual = Extract<UsFinancialErpCommandV5, { type: 'post_manual_journal' }>;
type Reversal = Extract<UsFinancialErpCommandV5, { type: 'reverse_manual_journal' }>;
type Bill = Extract<UsFinancialErpCommandV5, { type: 'record_vendor_bill' }>;
function lastErp(book: UsFinancialBookV5): UsFinancialErpEventV5 {
  const event = book.events.at(-1);
  if (!event || event.operation.type !== 'erp_command' || !('commit' in event)) throw Error('Expected synthetic ERP event');
  return event;
}
function manual(overrides: Partial<Manual> = {}): Manual {
  return { type: 'post_manual_journal', id: 'capital', transactionDate: '2026-10-09', accountingDate: '2026-10-10', periodId: '2026',
    description: 'Synthetic owner capital — not a bank operation', sourceReference: 'SYNTHETIC-CAPITAL', cashFlowCategory: 'financing',
    lines: [{ accountId: 'cash', debitMinor: '5000', creditMinor: '0', description: 'Synthetic cash receipt' }, { accountId: 'equity', debitMinor: '0', creditMinor: '5000' }], ...overrides };
}
function reversal(overrides: Partial<Reversal> = {}): Reversal {
  return { type: 'reverse_manual_journal', id: 'capital-reversal', entryId: 'capital', transactionDate: '2027-01-04', accountingDate: '2027-01-05', periodId: '2027', reason: 'Synthetic correction of owner capital', ...overrides };
}

async function fixture(baselineAccounting = false) {
  const original = await financialKernelFixture();
  let baseline = original.baseline;
  if (baselineAccounting) {
    const receipts = new Map<string, ErpReceipt>();
    const store: ErpStore = {
      supportedSchemaVersion: 4, async read() { return baseline; }, async receipt(_org, key) { return receipts.get(key) ?? null; },
      async commit(input) {
        const next = applyErpDelta(baseline, { schemaVersion: 4, organizationId: original.actor.organizationId, fromRevision: input.expectedRevision, toRevision: input.header.revision, headRevision: input.header.revision, hasMore: false, resetRequired: false,
          events: [{ schemaVersion: 4, organizationId: original.actor.organizationId, revision: input.header.revision, header: input.header, changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: input.actor.userId, occurredAt: input.actor.timestamp }] }, original.actor.organizationId, 4);
        if (!next) throw Error('Expected a synthetic ERP4 accounting baseline'); baseline = next;
        receipts.set(input.receipt.idempotencyKey, input.receipt); return input.receipt;
      },
    };
    const commands: ErpCommand[] = [manual({ id: 'baseline-capital' }), reversal({ id: 'baseline-reversal', entryId: 'baseline-capital', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026' }),
      { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }, { type: 'close_period', periodId: '2026' }];
    for (const [index, command] of commands.entries()) await executeErp({ store, configuration: original.configuration, actor: original.actor, revalidate: async () => original.actor, taxProvider: async () => { throw Error('Unexpected provider lookup for synthetic accounting'); } }, { idempotencyKey: `baseline-accounting-${index}`, expectedRevision: baseline.revision, command });
  }
  const data = { ...original, baseline }, initial = await promoteUsFinancialBookV5(baseline, data.policy, data.actor);
  const scope: UsFinancialTestScopeV5 = { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 };
  const state = { book: initial, receipts: new Map<string, unknown>() };
  const revalidate = vi.fn(async () => scope);
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (name === readRpc) return state.book;
    if (name === receiptRpc) return state.receipts.get(args.p_idempotency_key as string) ?? null;
    if (name === appendRpc) {
      const receipt = args.p_receipt as UsFinancialReceiptV5;
      if (args.p_expected_revision !== state.book.revision) throw new SupabaseServerError(409, 'PF001', 'Synthetic CAS refusal');
      if (args.p_previous_fingerprint !== await sha256Hex(canonicalErpJson(state.book))) throw new SupabaseServerError(503, 'PF004', 'Synthetic prefix refusal');
      state.book = args.p_book as UsFinancialBookV5;
      state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: receipt.actorId, receipt }); return receipt;
    }
    throw Error('Unexpected synthetic accounting RPC');
  });
  const store = createSupabaseUsFinancialAccountingTestStoreV5({ rpc }, scope, revalidate);
  const resolveTax = vi.fn(async ({ candidate, idempotencyKey }: { candidate: { invoiceFingerprint: string; allocationSha256: string; allocation: { taxMinor: string } }; idempotencyKey: string }): Promise<UsFinancialTaxProofV5> => ({
    schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256,
    reference: 'SYNTHETIC ONLY', verifiedBy: 'synthetic-reviewer', verifiedAt: data.actor.timestamp, providerAccountReference: 'acct_synthetic', originalTaxTransactionReference: 'testtxn_synthetic',
    adjustmentPlanReference: `testplan_${idempotencyKey}`, authorizedTaxMinor: candidate.allocation.taxMinor,
  }));
  const resolveIssuance = vi.fn(async (): Promise<never> => { throw Error('No invoice issuance in accounting TEST'); });
  const deps = { ...data, store, resolveTax, resolveIssuance, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }) };
  const request = (key: string, command: UsFinancialErpCommandV5): UsFinancialRequestV5 => ({ idempotencyKey: key, expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } });
  const send = (key: string, command: UsFinancialErpCommandV5) => executeUsFinancialKernelV5(deps, request(key, command));
  const credit = (id = 'credit-one', year = '2026'): UsFinancialRequestV5 => ({ idempotencyKey: id, expectedRevision: state.book.revision, command: { type: 'customer_credit', id, invoiceId: 'invoice-1', transactionDate: year === '2026' ? '2026-10-10' : `${year}-01-05`, accountingDate: year === '2026' ? '2026-10-10' : `${year}-01-06`, periodId: year, reason: 'Synthetic service correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
  const customerPayment = (id = 'customer-payment', year = '2027'): UsFinancialRequestV5 => ({ idempotencyKey: id, expectedRevision: state.book.revision, command: { type: 'customer_payment', id, invoiceId: 'invoice-1', amountMinor: '1000', paymentDate: year === '2026' ? '2026-10-10' : `${year}-01-05`, accountingDate: year === '2026' ? '2026-10-10' : `${year}-01-06`, periodId: year, reference: 'Synthetic receipt — no transfer' } });
  const vendor = { ...data.baseline.customers[0], id: 'vendor-1', name: 'Synthetic supplier — no real transaction' };
  const bill = (overrides: Partial<Bill> = {}): Bill => ({ type: 'record_vendor_bill', id: 'bill-1', vendorId: vendor.id, reference: 'SYNTHETIC-SUPPLIER-001', date: '2026-10-09', accountingDate: '2026-10-10', dueDate: '2026-11-08', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases', sourceReference: 'Synthetic reference — no archived original', ...overrides });
  const vendorPayment = (id: string, amountMinor: string, year = '2026'): UsFinancialErpCommandV5 => ({ type: 'record_vendor_payment', id, billId: 'bill-1', amountMinor, paymentDate: `${year}-10-09`, accountingDate: `${year}-10-10`, periodId: year, reference: 'Synthetic recorded payment — no transfer' });
  const appends = () => rpc.mock.calls.filter(([name]) => name === appendRpc).length;
  const commit = (): UsFinancialCommitV5 => {
    const args = rpc.mock.calls.filter(([name]) => name === appendRpc).at(-1)?.[1];
    if (!args) throw Error('Expected synthetic append');
    return { organizationId: scope.organizationId, expectedRevision: args.p_expected_revision as number, previousFingerprint: args.p_previous_fingerprint as string, book: args.p_book as UsFinancialBookV5, receipt: args.p_receipt as UsFinancialReceiptV5, actor: args.p_actor as FinancialAuthority };
  };
  const candidate = async (key: string, command: UsFinancialErpCommandV5, actor = data.actor): Promise<UsFinancialCommitV5> => {
    const input = request(key, command), result = await applyUsFinancialOperationV5(state.book, { type: 'erp_command', idempotencyKey: key, command, facts: { kind: 'none' } }, actor, usFinancialErpEntityIdV5(command, actor.organizationId));
    return { organizationId: actor.organizationId, expectedRevision: state.book.revision, previousFingerprint: await sha256Hex(canonicalErpJson(state.book)), book: result.book, actor,
      receipt: { idempotencyKey: key, commandHash: await sha256Hex(canonicalErpJson([actor.organizationId, actor.userId, input])), revision: result.book.revision, entityId: result.book.events.at(-1)!.id, action: 'erp_command', actorId: actor.userId } };
  };
  return { ...data, initial, scope, state, revalidate, rpc, store, deps, request, send, credit, customerPayment, vendor, bill, vendorPayment, appends, commit, candidate, resolveTax, resolveIssuance };
}
async function journalFixture() {
  const t = await fixture(); await executeUsFinancialKernelV5(t.deps, t.credit()); await t.send('capital-key', manual()); return t;
}
async function closedFixture() {
  const t = await journalFixture(); await t.send('vendor-key', { type: 'save_vendor', vendor: t.vendor }); await t.send('bill-key', t.bill());
  await t.send('close-key', { type: 'close_period', periodId: '2026' }); await t.send('open-key', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }); return t;
}

describe('private accounting TEST — real mixed engine, synthetic RPC', () => {
  it('exposes a closed frozen accounting profile with only fixed private RPCs', async () => {
    const t = await fixture();
    expect(t.store.capability).toBe('postgres-test-accounting-v5'); expect(Object.isFrozen(t.store)).toBe(true);
    expect(Object.keys(t.store).sort()).toEqual(['capability', 'commit', 'read', 'receipt']);
    expect(await t.store.read(t.scope.organizationId)).toEqual(t.initial); expect(await t.store.receipt(t.scope.organizationId, 'missing')).toBeNull();
    await t.send('capital-key', manual());
    expect(new Set(t.rpc.mock.calls.map(([name]) => name))).toEqual(new Set([readRpc, receiptRpc, appendRpc]));
    for (const [, args] of t.rpc.mock.calls) expect(args).toMatchObject({ p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-accounting-v5' });
  });

  it('continues the complete mixed cycle across a year close with one real ledger and three distinct revisions', async () => {
    const t = await fixture(), baseline = canonicalErpJson(t.initial.baseline), policy = canonicalErpJson(t.initial.policy);
    await executeUsFinancialKernelV5(t.deps, t.credit()); await t.send('vendor-key', { type: 'save_vendor', vendor: t.vendor }); await t.send('bill-key', t.bill());
    await t.send('supplier-partial', t.vendorPayment('supplier-partial', '4000')); await t.send('capital-key', manual());
    const original = clone(lastErp(t.state.book).effects.postings[0]);
    await t.send('close-key', { type: 'close_period', periodId: '2026' }); const closed = lastErp(t.state.book);
    expect(closed.commit.changes).toEqual([]); expect(closed.effects).toMatchObject({ postings: [], audit: [{ revision: 6, action: 'period_closed', entityId: '2026' }] }); expect(closed.commit.header.ledger.revision).toBe(5);
    await t.send('open-key', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' });
    expect(lastErp(t.state.book).effects).toMatchObject({ postings: [], audit: [{ revision: 7, action: 'period_opened' }] });
    await executeUsFinancialKernelV5(t.deps, t.customerPayment()); await executeUsFinancialKernelV5(t.deps, t.credit('credit-two', '2027'));
    await t.send('supplier-final', t.vendorPayment('supplier-final', '6825', '2027')); await t.send('reversal-key', reversal());
    const reversed = lastErp(t.state.book);
    expect(reversed.effects.postings[0]).toMatchObject({ revision: 11, source: { type: 'manual_reversal', id: 'capital' }, reversesEntryId: 'capital', cashFlowCategory: 'financing', transactionDate: '2027-01-04', accountingDate: '2027-01-05' });
    expect(reversed.effects.postings[0].lines).toEqual(original.lines.map(line => ({ ...line, debitMinor: line.creditMinor, creditMinor: line.debitMinor })));
    const customer = { ...t.baseline.customers[0], id: 'customer-2', name: 'Synthetic second customer' };
    await t.send('customer-key', { type: 'save_customer', customer });
    await t.send('quote-key', { type: 'save_estimate', id: 'quote-2', expectedEstimateRevision: 0, customerId: customer.id, date: '2027-01-05', expiresAt: '2027-02-05', paymentTermsDays: 30, lines: t.baseline.estimates[0].lines, notes: 'Synthetic next-year estimate' });
    await t.send('accept-key', { type: 'accept_estimate', estimateId: 'quote-2', expectedEstimateRevision: 1 });
    const retained = await t.store.read(t.scope.organizationId) as UsFinancialBookV5, view = await projectUsFinancialBookV5(retained);
    expect(retained.revision).toBe(t.initial.revision + 14); expect(view.ledger.revision).toBe(11); expect(view.ledger.audit.map(audit => audit.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(view.ledger.entries.map(entry => entry.revision)).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11]); expect(view.ledger.entries.find(entry => entry.id === 'capital')).toEqual(original);
    let realRevision = t.baseline.ledger.revision, creditCount = 0;
    for (const event of retained.events) {
      expect(event.revision).toBe(t.initial.revision + retained.events.indexOf(event) + 1);
      if (event.operation.type === 'erp_command' && 'effects' in event) {
        realRevision += event.effects.audit.length; expect(event.commit.header.ledger.revision).toBe(realRevision - creditCount);
        for (const entry of event.effects.postings) expect(entry.revision).toBe(realRevision);
      } else { realRevision += 1; if (event.operation.type === 'customer_credit') creditCount += 1; }
    }
    expect(lastErp(retained).commit.header.ledger).toMatchObject({ revision: 9, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'closed' }, { id: '2027', start: '2027-01-01', end: '2027-12-31', status: 'open' }] });
    expect(view.settlements[0]).toMatchObject({ receivedMinor: '1000', creditedMinor: '21650', outstandingMinor: '9825' });
    expect(view.vendorBills[0].vendorSnapshot).toEqual(t.vendor); expect(view.vendorPayments.map(payment => payment.amount.minorUnits)).toEqual(['4000', '6825']);
    for (const [account, amount] of [['receivables', '9825'], ['payables', '0'], ['cash', '-9825'], ['equity', '0'], ['purchases', '10825']] as const) expect(generalLedger(view.ledger, account, range).closingMinor).toBe(amount);
    expect(cashFlow(view.ledger, range)).toMatchObject({ operatingMinor: '-9825', financingMinor: '0', investingMinor: '0', closingMinor: '-9825' });
    expect(cashFlow(view.ledger, { start: '2027-01-01', end: '2027-12-31' })).toMatchObject({ openingMinor: '1000', operatingMinor: '-5825', financingMinor: '-5000', closingMinor: '-9825' });
    expect(profitAndLoss(view.ledger, range)).toMatchObject({ incomeMinor: '10000', expenseMinor: '10825', profitMinor: '-825' });
    expect(trialBalance(view.ledger, '2027-12-31').balanced).toBe(true); expect(balanceSheet(view.ledger, '2027-12-31').balanced).toBe(true);
    expect(view.estimates.find(estimate => estimate.id === 'quote-2')).toMatchObject({ revision: 2, status: 'accepted' });
    expect(canonicalErpJson(retained.baseline)).toBe(baseline); expect(canonicalErpJson(retained.policy)).toBe(policy);
    expect(Object.keys(retained).sort()).toEqual(['baseline', 'events', 'policy', 'promotion', 'revision', 'schemaVersion']); expect(Object.hasOwn(view, 'compatibility')).toBe(false);
    expect(view.credits.map(credit => credit.taxDisposition)).toEqual(['adjustment_pending', 'adjustment_pending']); expect(t.resolveTax).toHaveBeenCalledTimes(2); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });

  it.each(['customer-credit', 'customer-payment', 'vendor-bill', 'vendor-payment', 'manual', 'reversal'] as const)('refuses a new %s in the closed old period without losing its history', async kind => {
    const t = await closedFixture(), before = canonicalErpJson(t.state.book), count = t.appends();
    const action = kind === 'customer-credit' ? () => executeUsFinancialKernelV5(t.deps, t.credit('closed-credit'))
      : kind === 'customer-payment' ? () => executeUsFinancialKernelV5(t.deps, t.customerPayment('closed-payment', '2026'))
      : kind === 'vendor-bill' ? () => t.send('closed-bill', t.bill({ id: 'bill-2', reference: 'SYNTHETIC-SECOND' }))
      : kind === 'vendor-payment' ? () => t.send('closed-supplier-payment', t.vendorPayment('closed-supplier-payment', '1'))
      : kind === 'manual' ? () => t.send('closed-journal', manual({ id: 'closed-journal' }))
      : () => t.send('closed-reversal', reversal({ transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026' }));
    await expect(action()).rejects.toThrow(); expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
    expect((await projectUsFinancialBookV5(await t.store.read(t.scope.organizationId) as UsFinancialBookV5)).ledger.periods.map(period => period.status)).toEqual(['closed', 'open']);
  });

  it('admits a new supplier bill and journal in the next period while preserving prior snapshots', async () => {
    const t = await closedFixture(), original = clone((await projectUsFinancialBookV5(t.state.book)).vendorBills[0]);
    await t.send('next-bill', t.bill({ id: 'bill-2', reference: 'SYNTHETIC-2027', date: '2027-01-05', accountingDate: '2027-01-06', dueDate: '2027-02-05', periodId: '2027', netMinor: '100', purchaseTaxMinor: '0' }));
    await t.send('next-journal', manual({ id: 'next-journal', transactionDate: '2027-01-05', accountingDate: '2027-01-06', periodId: '2027' }));
    const view = await projectUsFinancialBookV5(t.state.book); expect(view.vendorBills).toHaveLength(2); expect(view.vendorBills[0]).toEqual(original); expect(view.ledger.entries.at(-1)?.periodId).toBe('2027'); expect(trialBalance(view.ledger, '2027-12-31').balanced).toBe(true);
  });

  it('opens before closing, enforces chronological closure, and retains exact audit-only receipts', async () => {
    const t = await journalFixture(), open = t.request('open-key', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' });
    const receipt = await executeUsFinancialKernelV5(t.deps, open), count = t.appends();
    expect((await projectUsFinancialBookV5(t.state.book)).ledger.periods.map(period => period.status)).toEqual(['open', 'open']);
    await expect(t.send('wrong-close', { type: 'close_period', periodId: '2027' })).rejects.toMatchObject({ code: 'accounting_period_order_conflict' }); expect(t.appends()).toBe(count);
    await t.send('close-2026', { type: 'close_period', periodId: '2026' }); await t.send('close-2027', { type: 'close_period', periodId: '2027' });
    const before = canonicalErpJson(t.state.book); expect(await executeUsFinancialKernelV5(t.deps, open)).toEqual(receipt); expect(await t.store.receipt(t.scope.organizationId, 'open-key')).toEqual(receipt); expect(canonicalErpJson(t.state.book)).toBe(before);
    await expect(t.send('close-again', { type: 'close_period', periodId: '2026' })).rejects.toMatchObject({ code: 'accounting_period_closed' });
  });

  it.each([
    { id: '2026', start: '2027-01-01', end: '2027-12-31' }, { id: 'overlap', start: '2026-12-31', end: '2027-12-31' },
    { id: 'bad-day', start: '2027-02-30', end: '2027-12-31' }, { id: 'backward', start: '2027-12-31', end: '2027-01-01' },
  ])('rejects an invalid period transition %o without adding an audit', async input => {
    const t = await journalFixture(), before = canonicalErpJson(t.state.book), count = t.appends();
    await expect(t.send('invalid-open', { type: 'open_period', ...input })).rejects.toThrow(); expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
  });

  it('promotes actual ERP4 journal/reversal/period history and continues without renumbering its baseline', async () => {
    const t = await fixture(true), before = canonicalErpJson(t.baseline), originalEntries = clone(t.baseline.ledger.entries);
    await t.send('new-capital', manual({ id: 'new-capital', transactionDate: '2027-01-03', accountingDate: '2027-01-04', periodId: '2027' }));
    await executeUsFinancialKernelV5(t.deps, t.customerPayment());
    await expect(t.send('twice-reversed-baseline', reversal({ id: 'duplicate-baseline-reversal', entryId: 'baseline-capital' }))).rejects.toMatchObject({ code: 'INVALID_REVERSAL' });
    const view = await projectUsFinancialBookV5(await t.store.read(t.scope.organizationId) as UsFinancialBookV5);
    expect(view.ledger.entries.slice(0, originalEntries.length)).toEqual(originalEntries); expect(view.ledger.revision).toBe(t.baseline.ledger.revision + 2); expect(canonicalErpJson(t.state.book.baseline)).toBe(before);
    expect(view.ledger.periods.map(period => period.status)).toEqual(['closed', 'open']); expect(view.settlements[0].receivedMinor).toBe('1000');
  });

  it('keeps exact amounts above safe integer and allows an aggregate longer than the per-line 36-digit bound', async () => {
    const t = await journalFixture(), maximum = '9'.repeat(36), aggregate = (BigInt(maximum) * BigInt(2)).toString();
    await t.send('large-manual', manual({ id: 'large-manual', lines: [{ accountId: 'cash', debitMinor: maximum, creditMinor: '0' }, { accountId: 'cash', debitMinor: maximum, creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: maximum }, { accountId: 'equity', debitMinor: '0', creditMinor: maximum }] }));
    const entry = lastErp(t.state.book).effects.postings[0]; expect(entry.lines.reduce((total, line) => total + BigInt(line.debitMinor), BigInt(0)).toString()).toBe(aggregate); expect(entry.lines.reduce((total, line) => total + BigInt(line.creditMinor), BigInt(0)).toString()).toBe(aggregate); expect(aggregate).toHaveLength(37);
    const view = await projectUsFinancialBookV5(await t.store.read(t.scope.organizationId) as UsFinancialBookV5); expect(generalLedger(view.ledger, 'cash', range).closingMinor).toBe((BigInt(aggregate) + BigInt(5000)).toString()); expect(trialBalance(view.ledger, '2027-12-31').balanced).toBe(true);
  });

  it('preserves interior C1 text accepted by the actual manual-journal domain through commit and replay', async () => {
    const t = await journalFixture(), description = 'Synthetic\u0085interior description', sourceReference = 'SYNTHETIC\u0085REFERENCE';
    await t.send('c1-manual', manual({ id: 'c1-manual', description, sourceReference }));
    const view = await projectUsFinancialBookV5(await t.store.read(t.scope.organizationId) as UsFinancialBookV5);
    expect(view.ledger.entries.at(-1)).toMatchObject({ description, source: { type: 'manual_journal', id: sourceReference } });
  });

  it.each(['\u0000', '\u001f', '\u007f'])('refuses an ASCII/DEL control %j in manual text without recording it', async control => {
    const t = await journalFixture(), before = canonicalErpJson(t.state.book), count = t.appends();
    await expect(t.send('control-text', manual({ id: 'control-text', sourceReference: `SYNTHETIC${control}REFERENCE` }))).rejects.toThrow();
    expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
  });

  it.each(['receivables', 'payables', 'tax-payable', 'deposits'])('keeps %s under its subledger rather than a manual journal', async accountId => {
    const t = await journalFixture(), before = canonicalErpJson(t.state.book), count = t.appends();
    await expect(t.send('control-account', manual({ id: 'control-account', lines: [{ accountId, debitMinor: '1', creditMinor: '0' }, { accountId: 'cash', debitMinor: '0', creditMinor: '1' }] }))).rejects.toMatchObject({ code: 'manual_account_forbidden' });
    expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
  });

  it.each(['unbalanced', 'unknown-account', 'cash-category', 'fractional', 'leading-zero', 'too-large'] as const)('rejects a %s manual command without affecting prior AR or audits', async kind => {
    const t = await journalFixture(), command = clone(manual({ id: 'invalid-manual' })), before = canonicalErpJson(t.state.book), count = t.appends();
    if (kind === 'unbalanced') (command.lines[0] as { debitMinor: string }).debitMinor = '4999';
    else if (kind === 'unknown-account') (command.lines[0] as { accountId: string }).accountId = 'unknown';
    else if (kind === 'cash-category') delete (command as { cashFlowCategory?: string }).cashFlowCategory;
    else (command.lines[0] as { debitMinor: string }).debitMinor = kind === 'fractional' ? '1.5' : kind === 'leading-zero' ? '05000' : '1'.repeat(37);
    await expect(t.send('invalid-manual', command)).rejects.toThrow(); expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
  });

  it('cannot create a manual journal whose ID is hidden from the credit-free compatibility view', async () => {
    const t = await journalFixture(), credit = t.state.book.events[0]; if (!('posting' in credit)) throw Error('Expected synthetic credit');
    const before = canonicalErpJson(t.state.book); await expect(t.send('hidden-collision', manual({ id: credit.posting.id }))).rejects.toMatchObject({ code: 'ENTRY_ID_CONFLICT' }); expect(canonicalErpJson(t.state.book)).toBe(before);
  });

  it('retains the original journal, forbids double reversal and refuses an operational source', async () => {
    const t = await journalFixture(), original = clone(lastErp(t.state.book).effects.postings[0]);
    await t.send('reverse-key', reversal({ transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026' })); const before = canonicalErpJson(t.state.book), count = t.appends();
    await expect(t.send('reverse-again', reversal({ id: 'reversal-two', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026' }))).rejects.toMatchObject({ code: 'INVALID_REVERSAL' });
    await expect(t.send('reverse-invoice', reversal({ id: 'reverse-invoice', entryId: t.baseline.ledger.entries[0].id, transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026' }))).rejects.toMatchObject({ code: 'manual_journal_required' });
    expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before); expect((await projectUsFinancialBookV5(t.state.book)).ledger.entries.find(entry => entry.id === 'capital')).toEqual(original);
  });

  it('recovers original journal and close receipts after later periods and credits without reapplying them', async () => {
    const t = await fixture(), journalRequest = t.request('capital-key', manual()), journalReceipt = await executeUsFinancialKernelV5(t.deps, journalRequest);
    const closeRequest = t.request('close-key', { type: 'close_period', periodId: '2026' }), closeReceipt = await executeUsFinancialKernelV5(t.deps, closeRequest);
    await t.send('open-key', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }); await executeUsFinancialKernelV5(t.deps, t.credit('next-credit', '2027')); await executeUsFinancialKernelV5(t.deps, t.customerPayment());
    const before = canonicalErpJson(t.state.book), count = t.appends(); t.revalidate.mockResolvedValue({ ...t.scope, actor: { ...t.actor, timestamp: '2027-01-10T12:00:00.000Z' } });
    expect(await executeUsFinancialKernelV5(t.deps, journalRequest)).toEqual(journalReceipt); expect(await executeUsFinancialKernelV5(t.deps, closeRequest)).toEqual(closeReceipt);
    expect(await t.store.receipt(t.scope.organizationId, 'capital-key')).toEqual(journalReceipt); expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before); expect(t.resolveTax).toHaveBeenCalledTimes(1);
    await expect(executeUsFinancialKernelV5(t.deps, { ...journalRequest, command: { type: 'erp_command', request: manual({ description: 'Changed body' }) } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('recovers a lost append reply through its retained period receipt without a second append', async () => {
    const t = await journalFixture(), request = t.request('close-lost', { type: 'close_period', periodId: '2026' }), original = t.rpc.getMockImplementation()!;
    t.rpc.mockImplementation(async (name, args) => { const result = await original(name, args); if (name === appendRpc) throw Error('Synthetic lost reply after persistence'); return result; });
    await expect(executeUsFinancialKernelV5(t.deps, request)).rejects.toMatchObject({ code: 'financial_service_unavailable' }); const count = t.appends(), before = canonicalErpJson(t.state.book);
    t.rpc.mockImplementation(original); expect(await executeUsFinancialKernelV5(t.deps, request)).toMatchObject({ revision: t.state.book.revision, entityId: '2026' }); expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
  });

  it('binds the outer receipt to the original accounting request rather than its inner ERP hash', async () => {
    const t = await journalFixture(), receipt = t.commit().receipt, event = lastErp(t.state.book);
    expect(receipt.commandHash).not.toBe(event.commit.receipt.commandHash); expect(receipt.action).toBe('erp_command'); expect(event.commit.receipt.action).toBe('post_manual_journal');
    t.state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: t.actor.userId, receipt: { ...receipt, commandHash: event.commit.receipt.commandHash } });
    await expect(t.store.receipt(t.scope.organizationId, receipt.idempotencyKey)).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });

  it.each(['settlement', 'commercial', 'purchasing'] as const)('keeps the old %s adapter closed to accounting read, receipt and commit', async profile => {
    const t = await journalFixture(), input = t.commit(), rpc = vi.fn(async (name: string): Promise<unknown> => name.includes('_receipt_') ? { origin: 'financial_v5', actorId: t.actor.userId, receipt: input.receipt } : t.state.book);
    const factories = { settlement: createSupabaseUsFinancialSettlementTestStoreV5, commercial: createSupabaseUsFinancialCommercialTestStoreV5, purchasing: createSupabaseUsFinancialPurchasingTestStoreV5 }, old = factories[profile]({ rpc }, t.scope, t.revalidate);
    await expect(old.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_append_unavailable' }); await expect(old.receipt(t.scope.organizationId, input.receipt.idempotencyKey)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
    rpc.mockClear(); await expect(old.commit(input)).rejects.toMatchObject({ code: 'financial_append_unavailable' }); expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['save_projects', 'issue_invoice'] as const)('refuses %s before any RPC or trusted provider lookup', async kind => {
    const t = await fixture(), command: UsFinancialErpCommandV5 = kind === 'issue_invoice' ? { type: 'issue_invoice', id: 'new-invoice', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' }
      : { type: 'save_projects', projects: [{ id: 'project-1', expectedProjectRevision: 0, customerId: 'customer-1', name: 'Synthetic project', status: 'active', notes: '', startDate: null, targetDate: null, budgetMinor: null, vendorBillIds: [] }] };
    await expect(t.send('not-admitted', command)).rejects.toMatchObject({ code: 'financial_append_unavailable', status: 409 }); expect(t.rpc).not.toHaveBeenCalled(); expect(t.resolveTax).not.toHaveBeenCalled(); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });

  it.each(['real-periods', 'compat-periods', 'audit-action', 'audit-revision', 'posted-revision', 'cash-category', 'source', 'prefix'] as const)('rejects a forged %s accounting candidate before append', async field => {
    const t = await journalFixture(), input = clone(await t.candidate('open-candidate', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' })), event = lastErp(input.book), journal = input.book.events.find(item => item.operation.type === 'erp_command' && item.operation.command.type === 'post_manual_journal');
    if (!journal || !('commit' in journal)) throw Error('Expected synthetic journal');
    if (field === 'real-periods') (event.operation.command as { start: string }).start = '2027-01-02';
    else if (field === 'compat-periods') (event.commit.header.ledger.periods[0] as { status: string }).status = 'closed';
    else if (field === 'audit-action') (event.effects.audit[0] as { action: string }).action = 'posted';
    else if (field === 'audit-revision') (event.effects.audit[0] as { revision: number }).revision += 1;
    else if (field === 'posted-revision') (journal.effects.postings[0] as { revision: number }).revision += 1;
    else if (field === 'cash-category') (journal.effects.postings[0] as { cashFlowCategory: string }).cashFlowCategory = 'operating';
    else if (field === 'source') (journal.effects.postings[0].source as { type: string }).type = 'customer_payment';
    else (input as { previousFingerprint: string }).previousFingerprint = '0'.repeat(64);
    t.rpc.mockClear(); await expect(t.store.commit(input)).rejects.toMatchObject({ code: 'invalid_financial_private_data', status: 503 }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it('rejects a forged reversed-line description despite balanced inverse amounts', async () => {
    const t = await journalFixture(), input = clone(await t.candidate('reverse-candidate', reversal({ transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026' })));
    (lastErp(input.book).effects.postings[0].lines[0] as { description: string }).description = 'Forged description'; t.rpc.mockClear();
    await expect(t.store.commit(input)).rejects.toMatchObject({ code: 'invalid_financial_private_data' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it.each(['member', 'read_only'] as const)('refuses %s even for a retained accounting operation', async role => {
    const t = await journalFixture(), actor = { ...t.actor, role };
    expect(() => createSupabaseUsFinancialAccountingTestStoreV5({ rpc: t.rpc }, { ...t.scope, actor }, t.revalidate)).toThrowError(); t.rpc.mockClear();
    await expect(executeUsFinancialKernelV5({ ...t.deps, actor }, { idempotencyKey: 'capital-key', expectedRevision: t.initial.revision + 1, command: { type: 'erp_command', request: manual() } })).rejects.toMatchObject({ code: 'financial_permission_required' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it.each(['admin', 'accountant'] as const)('admits a specifically scoped %s for manual and period actions', async role => {
    const t = await fixture(), actor = { ...t.actor, role }, scope = { ...t.scope, actor }, store = createSupabaseUsFinancialAccountingTestStoreV5({ rpc: t.rpc }, scope, async () => scope), deps = { ...t.deps, actor, store, revalidate: async () => ({ configuration: t.configuration, actor, policy: t.policy }) };
    await executeUsFinancialKernelV5(deps, t.request('authorized-manual', manual())); await executeUsFinancialKernelV5(deps, t.request('authorized-close', { type: 'close_period', periodId: '2026' }));
    expect(lastErp(t.state.book).effects.audit[0].actorId).toBe(actor.userId); expect(lastErp(t.state.book).actor.role).toBe(role);
  });

  it('captures nested accounting effects and initial scope before awaited authority checks', async () => {
    const t = await journalFixture(), scope = clone(t.scope), input = clone(await t.candidate('captured-reversal', reversal({ transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026' }))), expected = clone(input);
    const store = createSupabaseUsFinancialAccountingTestStoreV5({ rpc: t.rpc }, scope, t.revalidate); (scope as { grantVersion: number }).grantVersion = 99;
    const pending = store.commit(input); (lastErp(input.book).effects.postings[0].lines[0] as { creditMinor: string }).creditMinor = '9999'; (input.receipt as { entityId: string }).entityId = 'mutated';
    expect(await pending).toEqual(expected.receipt); expect(t.rpc).toHaveBeenLastCalledWith(appendRpc, expect.objectContaining({ p_grant_version: 1, p_book: expected.book, p_receipt: expected.receipt }));
  });

  it('rejects accessor commands without reading them and rejects injected journal facts before IO', async () => {
    const t = await fixture(), command = clone(manual()), getter = vi.fn(() => 'Secret reference'); Object.defineProperty(command, 'sourceReference', { enumerable: true, get: getter });
    await expect(t.send('accessor', command)).rejects.toMatchObject({ code: 'invalid_financial_request' }); expect(getter).not.toHaveBeenCalled();
    await expect(executeUsFinancialKernelV5(t.deps, { ...t.request('injected', manual()), command: { type: 'erp_command', request: manual(), facts: { kind: 'none' } } })).rejects.toMatchObject({ code: 'invalid_financial_request' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it('prioritizes live revocation over a corrupt audit-only read response', async () => {
    const t = await closedFixture(), corrupt = clone(t.state.book); (lastErp(corrupt).effects as { audit: unknown }).audit = null;
    t.rpc.mockResolvedValue(corrupt); t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue({ ...t.scope, grantVersion: 2 });
    await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_test_grant_changed' });
  });

  it('rechecks authority after invalid period-candidate hashing without sending an append', async () => {
    const t = await journalFixture(), input = await t.candidate('close-candidate', { type: 'close_period', periodId: '2026' }); t.rpc.mockClear();
    t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue({ ...t.scope, grantVersion: 2 });
    await expect(t.store.commit({ ...input, previousFingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'financial_test_grant_changed' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it('does not return a committed close after the living grant was revoked and does not retry it', async () => {
    const t = await journalFixture(), input = await t.candidate('close-candidate', { type: 'close_period', periodId: '2026' }); let appended = false;
    const rpc = vi.fn(async (_name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => { t.state.book = args.p_book as UsFinancialBookV5; appended = true; return args.p_receipt; });
    const store = createSupabaseUsFinancialAccountingTestStoreV5({ rpc }, t.scope, async () => ({ ...t.scope, grantVersion: appended ? 2 : 1 }));
    await expect(store.commit(input)).rejects.toMatchObject({ code: 'financial_test_grant_changed' }); expect(t.state.book).toEqual(input.book); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('refuses a future execution actor before IO and a backward trusted clock after read', async () => {
    const t = await fixture(), future = await t.candidate('future-period', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }, { ...t.actor, timestamp: '2026-10-11T12:00:00.000Z' });
    await expect(t.store.commit(future)).rejects.toMatchObject({ code: 'financial_clock_reversed' }); expect(t.rpc).not.toHaveBeenCalled();
    t.revalidate.mockResolvedValueOnce({ ...t.scope, actor: { ...t.actor, timestamp: '2026-10-11T12:00:00.000Z' } }).mockResolvedValue(t.scope);
    await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_clock_reversed' });
  });

  it('rejects a stale second candidate through synthetic CAS without changing the first accepted period', async () => {
    const t = await journalFixture(), first = await t.candidate('open-first', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }), second = await t.candidate('close-stale', { type: 'close_period', periodId: '2026' });
    await t.store.commit(first); const before = canonicalErpJson(t.state.book); await expect(t.store.commit(second)).rejects.toMatchObject({ code: 'revision_conflict', status: 409 }); expect(canonicalErpJson(t.state.book)).toBe(before);
  });
});
