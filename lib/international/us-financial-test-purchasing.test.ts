import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { cashFlow, generalLedger, trialBalance } from './accounting/reports';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { executeUsFinancialKernelV5, type UsFinancialCommitV5, type UsFinancialReceiptV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialErpEventV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
import { createSupabaseUsFinancialCommercialTestStoreV5 } from './us-financial-test-commercial';
import type { UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialPurchasingTestStoreV5 } from './us-financial-test-purchasing';
import { createSupabaseUsFinancialSettlementTestStoreV5 } from './us-financial-test-settlement';

// Actual ERP/financial transitions and immutable replay, with a synthetic RPC
// transport. This file does not establish PostgreSQL guards, hosted authority,
// real tax adjustments, bank execution or transport/concurrency guarantees.
const readRpc = 'zentra_read_us_financial_purchasing_test_v5';
const receiptRpc = 'zentra_us_financial_purchasing_test_receipt_v5';
const appendRpc = 'zentra_append_us_financial_purchasing_test_v5';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const range = { start: '2026-01-01', end: '2026-12-31' };
type BillCommand = Extract<UsFinancialErpCommandV5, { type: 'record_vendor_bill' }>;
type VendorPaymentCommand = Extract<UsFinancialErpCommandV5, { type: 'record_vendor_payment' }>;
function lastErp(book: UsFinancialBookV5): UsFinancialErpEventV5 {
  const event = book.events.at(-1);
  if (!event || event.operation.type !== 'erp_command' || !('commit' in event)) throw Error('Expected synthetic ERP event');
  return event;
}

async function fixture() {
  const data = await financialKernelFixture(), initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const scope: UsFinancialTestScopeV5 = { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 };
  const state = { book: initial, receipts: new Map<string, unknown>() };
  const revalidate = vi.fn(async () => scope);
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (name === readRpc) return state.book;
    if (name === receiptRpc) return state.receipts.get(args.p_idempotency_key as string) ?? null;
    if (name === appendRpc) {
      const receipt = args.p_receipt as UsFinancialReceiptV5;
      state.book = args.p_book as UsFinancialBookV5;
      state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: receipt.actorId, receipt });
      return receipt;
    }
    throw Error('Unexpected synthetic purchasing RPC');
  });
  const store = createSupabaseUsFinancialPurchasingTestStoreV5({ rpc }, scope, revalidate);
  const resolveTax = vi.fn(async ({ candidate, idempotencyKey }: { candidate: { invoiceFingerprint: string; allocationSha256: string; allocation: { taxMinor: string } }; idempotencyKey: string }): Promise<UsFinancialTaxProofV5> => ({
    schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint,
    allocationSha256: candidate.allocationSha256, reference: 'SYNTHETIC ONLY', verifiedBy: 'synthetic-resolver', verifiedAt: data.actor.timestamp,
    providerAccountReference: 'acct_synthetic', originalTaxTransactionReference: 'testtxn_synthetic', adjustmentPlanReference: `testplan_${idempotencyKey}`, authorizedTaxMinor: candidate.allocation.taxMinor,
  }));
  const resolveIssuance = vi.fn(async (): Promise<never> => { throw Error('Issuance is outside the purchasing capability'); });
  const deps = { ...data, store, resolveTax, resolveIssuance, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }) };
  const request = (key: string, command: UsFinancialErpCommandV5): UsFinancialRequestV5 => ({ idempotencyKey: key, expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } });
  const send = (key: string, command: UsFinancialErpCommandV5) => executeUsFinancialKernelV5(deps, request(key, command));
  const vendor = { ...data.baseline.customers[0], id: 'vendor-1', name: 'Synthetic Supplier LLC — no real transaction' };
  const bill = (overrides: Partial<BillCommand> = {}): BillCommand => ({ type: 'record_vendor_bill', id: 'bill-1', vendorId: vendor.id, reference: 'SYNTHETIC-SUP-001', date: '2026-10-09', accountingDate: '2026-10-10', dueDate: '2026-11-08', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases', sourceReference: 'Synthetic manual reference — not an archived original', ...overrides });
  const vendorPayment = (id: string, amountMinor: string): VendorPaymentCommand => ({ type: 'record_vendor_payment', id, billId: 'bill-1', amountMinor, paymentDate: '2026-10-09', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic recorded payment — no bank transfer' });
  const customer = { ...data.baseline.customers[0], id: 'customer-2', name: 'Synthetic additional customer' };
  const quote: UsFinancialErpCommandV5 = { type: 'save_estimate', id: 'quote-2', expectedEstimateRevision: 0, customerId: customer.id, date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: data.baseline.estimates[0].lines, notes: 'Synthetic first line\nSecond line · Genève · 東京 · 🌍' };
  const credit = (id = 'credit-one'): UsFinancialRequestV5 => ({ idempotencyKey: id, expectedRevision: state.book.revision, command: { type: 'customer_credit', id, invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic service correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
  const customerPayment = (): UsFinancialRequestV5 => ({ idempotencyKey: 'customer-payment', expectedRevision: state.book.revision, command: { type: 'customer_payment', id: 'customer-payment', invoiceId: 'invoice-1', amountMinor: '1000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic customer receipt — no money moved' } });
  const appends = () => rpc.mock.calls.filter(([name]) => name === appendRpc).length;
  const commit = (): UsFinancialCommitV5 => {
    const args = rpc.mock.calls.filter(([name]) => name === appendRpc).at(-1)?.[1];
    if (!args) throw Error('Expected synthetic append');
    return { organizationId: scope.organizationId, expectedRevision: args.p_expected_revision as number, previousFingerprint: args.p_previous_fingerprint as string, book: args.p_book as UsFinancialBookV5, receipt: args.p_receipt as UsFinancialReceiptV5, actor: args.p_actor as FinancialAuthority };
  };
  const candidate = async (key: string, command: UsFinancialErpCommandV5, actor: FinancialAuthority = data.actor): Promise<UsFinancialCommitV5> => {
    const request: UsFinancialRequestV5 = { idempotencyKey: key, expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } };
    const result = await applyUsFinancialOperationV5(state.book, { type: 'erp_command', idempotencyKey: key, command, facts: { kind: 'none' } }, actor, usFinancialErpEntityIdV5(command, actor.organizationId));
    return { organizationId: actor.organizationId, expectedRevision: state.book.revision, previousFingerprint: await sha256Hex(canonicalErpJson(state.book)), book: result.book, actor,
      receipt: { idempotencyKey: key, commandHash: await sha256Hex(canonicalErpJson([actor.organizationId, actor.userId, request])), revision: result.book.revision, entityId: result.book.events.at(-1)!.id, action: 'erp_command', actorId: actor.userId } };
  };
  return { ...data, initial, scope, state, revalidate, rpc, store, deps, request, send, vendor, bill, vendorPayment, customer, quote, credit, customerPayment, appends, commit, candidate, resolveTax, resolveIssuance };
}

async function purchasedFixture() {
  const t = await fixture();
  await t.send('vendor-create', { type: 'save_vendor', vendor: t.vendor });
  await t.send('bill-create', t.bill());
  return t;
}

describe('private purchasing TEST adapter — actual engine, synthetic RPC transport', () => {
  it('exposes a frozen closed capability and only the three fixed private RPC names', async () => {
    const t = await fixture();
    expect(t.store.capability).toBe('postgres-test-purchasing-v5'); expect(Object.isFrozen(t.store)).toBe(true);
    expect(Object.keys(t.store).sort()).toEqual(['capability', 'commit', 'read', 'receipt']);
    expect(await t.store.read(t.scope.organizationId)).toEqual(t.initial); expect(await t.store.receipt(t.scope.organizationId, 'missing')).toBeNull();
    await t.send('vendor-create', { type: 'save_vendor', vendor: t.vendor });
    expect(new Set(t.rpc.mock.calls.map(([name]) => name))).toEqual(new Set([readRpc, receiptRpc, appendRpc]));
    for (const [, args] of t.rpc.mock.calls) expect(args).toMatchObject({ p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-purchasing-v5' });
  });

  it('keeps commercial work, AP payments and AR credits on one correctly revised ledger', async () => {
    const t = await fixture(), baseline = canonicalErpJson(t.initial.baseline), policy = canonicalErpJson(t.initial.policy);
    await executeUsFinancialKernelV5(t.deps, t.credit());
    await t.send('vendor-create', { type: 'save_vendor', vendor: t.vendor });
    await t.send('bill-create', t.bill());
    const billEvent = lastErp(t.state.book);
    expect(billEvent.effects.postings[0].revision).toBe(t.baseline.ledger.revision + 2);
    expect(billEvent.commit.header.ledger.revision).toBe(t.baseline.ledger.revision + 1);
    await t.send('vendor-payment-partial', t.vendorPayment('vendor-payment-partial', '4000'));
    expect(lastErp(t.state.book).effects.postings[0].revision).toBe(t.baseline.ledger.revision + 3);
    expect(lastErp(t.state.book).commit.header.ledger.revision).toBe(t.baseline.ledger.revision + 2);
    await t.send('customer-create', { type: 'save_customer', customer: t.customer });
    await t.send('quote-create', t.quote);
    await t.send('quote-accept', { type: 'accept_estimate', estimateId: 'quote-2', expectedEstimateRevision: 1 });
    expect(lastErp(t.state.book).effects).toEqual({ postings: [], audit: [] });
    expect(lastErp(t.state.book).commit.header.ledger.revision).toBe(t.baseline.ledger.revision + 2);
    await executeUsFinancialKernelV5(t.deps, t.customerPayment());
    await t.send('vendor-payment-final', t.vendorPayment('vendor-payment-final', '6825'));
    const finalPayment = lastErp(t.state.book);
    expect(finalPayment.effects.postings[0].revision).toBe(t.baseline.ledger.revision + 5);
    expect(finalPayment.commit.header.ledger.revision).toBe(t.baseline.ledger.revision + 4);
    await executeUsFinancialKernelV5(t.deps, t.credit('credit-two'));
    const retained = await t.store.read(t.scope.organizationId) as UsFinancialBookV5, view = await projectUsFinancialBookV5(retained);
    expect(view.revision).toBe(t.initial.revision + 10); expect(view.ledger.revision).toBe(t.baseline.ledger.revision + 6);
    expect(view.ledger.entries.map(entry => entry.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(view.ledger.audit.map(event => event.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(view.settlements[0]).toMatchObject({ receivedMinor: '1000', creditedMinor: '21650', outstandingMinor: '9825' });
    expect(view.invoices[0].payments).toHaveLength(1); expect(view.invoices[0].payments[0].amount.minorUnits).toBe('1000');
    expect(view.vendorBills[0]).toMatchObject({ total: { currency: 'USD', minorUnits: '10825' }, vendorSnapshot: t.vendor, approvalSource: 'manual_entry' });
    expect(view.vendorPayments.map(payment => payment.amount.minorUnits)).toEqual(['4000', '6825']);
    expect(generalLedger(view.ledger, 'purchases', range).closingMinor).toBe('10825');
    expect(generalLedger(view.ledger, 'payables', range).closingMinor).toBe('0');
    expect(generalLedger(view.ledger, 'receivables', range).closingMinor).toBe('9825');
    expect(generalLedger(view.ledger, 'cash', range).closingMinor).toBe('-9825');
    expect(cashFlow(view.ledger, range)).toMatchObject({ operatingMinor: '-9825', investingMinor: '0', financingMinor: '0' });
    expect(trialBalance(view.ledger, '2026-12-31').balanced).toBe(true);
    expect(view.estimates.find(estimate => estimate.id === 'quote-2')).toMatchObject({ status: 'accepted', revision: 2 });
    expect(canonicalErpJson(retained.baseline)).toBe(baseline); expect(canonicalErpJson(retained.policy)).toBe(policy);
    expect(Object.keys(retained).sort()).toEqual(['baseline', 'events', 'policy', 'promotion', 'revision', 'schemaVersion']);
    expect(Object.hasOwn(view, 'compatibility')).toBe(false); expect(view.ledger.entries.filter(entry => entry.source.type === 'customer_credit')).toHaveLength(2);
    expect(t.resolveTax).toHaveBeenCalledTimes(2); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });

  it('posts purchase tax as cost, keeps accounting/payment dates distinct and performs no provider action', async () => {
    const t = await purchasedFixture(), billEvent = lastErp(t.state.book), entry = billEvent.effects.postings[0];
    expect(entry).toMatchObject({ transactionDate: '2026-10-09', accountingDate: '2026-10-10', source: { type: 'vendor_bill', id: 'bill-1' }, basis: 'accrual', currency: 'USD' });
    expect(entry.lines).toEqual([{ accountId: 'purchases', debitMinor: '10825', creditMinor: '0' }, { accountId: 'payables', debitMinor: '0', creditMinor: '10825' }]);
    expect(Object.hasOwn(entry, 'cashFlowCategory')).toBe(false); expect(billEvent.operation.facts).toEqual({ kind: 'none' });
    await t.send('vendor-payment', t.vendorPayment('vendor-payment', '4000'));
    const paymentEvent = lastErp(t.state.book);
    expect(paymentEvent.effects.postings[0]).toMatchObject({ transactionDate: '2026-10-09', paymentDate: '2026-10-09', accountingDate: '2026-10-10', cashFlowCategory: 'operating' });
    expect((await projectUsFinancialBookV5(t.state.book)).ledger.accounts).toEqual(t.baseline.ledger.accounts);
    expect(t.resolveTax).not.toHaveBeenCalled(); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });

  it('freezes a bill supplier snapshot while allowing repeated live supplier saves without new journals', async () => {
    const t = await purchasedFixture(), original = (await projectUsFinancialBookV5(t.state.book)).vendorBills[0];
    const updated = { ...t.vendor, name: 'Synthetic renamed supplier', billingAddress: { ...t.vendor.billingAddress!, line1: '2 Synthetic Updated Street' } };
    await t.send('vendor-edit', { type: 'save_vendor', vendor: updated });
    await t.send('vendor-noop', { type: 'save_vendor', vendor: updated });
    const event = lastErp(t.state.book), view = await projectUsFinancialBookV5(t.state.book);
    expect(event.commit.changes).toEqual([{ kind: 'vendor', id: updated.id, payload: updated }]); expect(event.effects).toEqual({ postings: [], audit: [] });
    expect(view.vendorBills[0]).toEqual(original); expect(view.vendorBills[0].vendorSnapshot).toEqual(t.vendor); expect(view.vendors[0]).toEqual(updated);
    expect(view.vendorBills[0].recordedRevision).toBe(t.initial.revision + 2); expect(view.ledger.revision).toBe(t.baseline.ledger.revision + 1);
  });

  it('corroborates the outer purchase receipt rather than accepting the inner ERP receipt hash', async () => {
    const t = await fixture(); await t.send('vendor-create', { type: 'save_vendor', vendor: t.vendor });
    const request = t.request('bill-create', t.bill()), receipt = await executeUsFinancialKernelV5(t.deps, request), event = lastErp(t.state.book);
    expect(receipt.action).toBe('erp_command'); expect(event.commit.receipt.action).toBe('record_vendor_bill');
    expect(receipt.commandHash).toBe(await sha256Hex(canonicalErpJson([t.scope.organizationId, t.actor.userId, request])));
    expect(receipt.commandHash).not.toBe(event.commit.receipt.commandHash); expect(await t.store.receipt(t.scope.organizationId, request.idempotencyKey)).toEqual(receipt);
    t.state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: t.actor.userId, receipt: { ...receipt, commandHash: event.commit.receipt.commandHash } });
    await expect(t.store.receipt(t.scope.organizationId, receipt.idempotencyKey)).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });

  it('recovers the exact original bill and payment receipts after later mixed events without appending twice', async () => {
    const t = await fixture(); await t.send('vendor-create', { type: 'save_vendor', vendor: t.vendor });
    const billRequest = t.request('bill-create', t.bill()), billReceipt = await executeUsFinancialKernelV5(t.deps, billRequest);
    const paymentRequest = t.request('vendor-payment', t.vendorPayment('vendor-payment', '4000')), paymentReceipt = await executeUsFinancialKernelV5(t.deps, paymentRequest);
    await t.send('vendor-edit', { type: 'save_vendor', vendor: { ...t.vendor, name: 'Later synthetic supplier name' } });
    await t.send('customer-edit', { type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Later synthetic customer' } });
    await executeUsFinancialKernelV5(t.deps, t.credit()); await executeUsFinancialKernelV5(t.deps, t.customerPayment());
    const before = canonicalErpJson(t.state.book), count = t.appends();
    t.revalidate.mockResolvedValue({ ...t.scope, actor: { ...t.actor, timestamp: '2026-10-11T12:00:00.000Z' } });
    expect(await executeUsFinancialKernelV5(t.deps, billRequest)).toEqual(billReceipt);
    expect(await executeUsFinancialKernelV5(t.deps, paymentRequest)).toEqual(paymentReceipt);
    expect(await t.store.receipt(t.scope.organizationId, billRequest.idempotencyKey)).toEqual(billReceipt);
    expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before); expect(t.resolveTax).toHaveBeenCalledTimes(1);
  });

  it('does not silently turn a changed body under a retained purchase key into a new bill', async () => {
    const t = await purchasedFixture(), original = t.request('bill-create', t.bill({ netMinor: '9999' })), count = t.appends();
    await expect(executeUsFinancialKernelV5(t.deps, original)).rejects.toMatchObject({ code: 'idempotency_conflict' }); expect(t.appends()).toBe(count);
  });

  it.each(['commercial', 'settlement'] as const)('keeps the older %s port closed to a valid purchasing tail for read, receipt and commit', async profile => {
    const t = await purchasedFixture(), commit = t.commit();
    const rpc = vi.fn(async (name: string): Promise<unknown> => name.includes('_receipt_') ? { origin: 'financial_v5', actorId: t.actor.userId, receipt: commit.receipt } : t.state.book);
    const factory = profile === 'commercial' ? createSupabaseUsFinancialCommercialTestStoreV5 : createSupabaseUsFinancialSettlementTestStoreV5;
    const old = factory({ rpc }, t.scope, t.revalidate);
    await expect(old.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
    await expect(old.receipt(t.scope.organizationId, commit.receipt.idempotencyKey)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
    rpc.mockClear(); await expect(old.commit(commit)).rejects.toMatchObject({ code: 'financial_append_unavailable' }); expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['save_projects', 'close_period', 'open_period', 'post_manual_journal', 'reverse_manual_journal', 'issue_invoice'] as const)('refuses valid unadmitted %s before RPC or provider lookup', async kind => {
    const t = await fixture();
    const commands: Record<typeof kind, UsFinancialErpCommandV5> = {
      save_projects: { type: 'save_projects', projects: [{ id: 'project-2', expectedProjectRevision: 0, customerId: 'customer-1', name: 'Synthetic project', status: 'active', notes: '', startDate: null, targetDate: null, budgetMinor: null, vendorBillIds: [] }] },
      close_period: { type: 'close_period', periodId: '2026' }, open_period: { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' },
      post_manual_journal: { type: 'post_manual_journal', id: 'manual-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic journal', sourceReference: 'Synthetic reference', lines: [{ accountId: 'cash', debitMinor: '100', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '100' }], cashFlowCategory: 'financing' },
      reverse_manual_journal: { type: 'reverse_manual_journal', id: 'reversal-1', entryId: 'manual-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic correction' },
      issue_invoice: { type: 'issue_invoice', id: 'invoice-2', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-08', periodId: '2026' },
    };
    await expect(t.send('blocked-operation', commands[kind])).rejects.toMatchObject({ code: 'financial_append_unavailable', status: 409 });
    expect(t.rpc).not.toHaveBeenCalled(); expect(t.resolveTax).not.toHaveBeenCalled(); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });

  it('rejects an otherwise valid memory-only period tail instead of presenting a reduced book', async () => {
    const t = await purchasedFixture();
    t.state.book = (await applyUsFinancialOperationV5(t.state.book, { type: 'erp_command', idempotencyKey: 'memory-period-only', command: { type: 'close_period', periodId: '2026' }, facts: { kind: 'none' } }, t.actor, '2026')).book;
    await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
  });

  it.each([
    { netMinor: '0', purchaseTaxMinor: '0' }, { netMinor: '-1' }, { netMinor: '01' }, { netMinor: '1.5' }, { purchaseTaxMinor: '-1' },
    { netMinor: '9'.repeat(36), purchaseTaxMinor: '1' }, { expenseAccountId: 'cash' }, { dueDate: '2026-10-08' }, { accountingDate: '2026-02-30' },
  ])('refuses invalid or overflowing manual purchase input %o without recording effects', async patch => {
    const t = await fixture(); await t.send('vendor-create', { type: 'save_vendor', vendor: t.vendor });
    const before = canonicalErpJson(t.state.book), count = t.appends();
    await expect(t.send('invalid-bill', t.bill(patch))).rejects.toThrow(); expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
    expect(t.resolveTax).not.toHaveBeenCalled(); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });

  it('rejects duplicate supplier reference/date and an overpayment while retaining the true AP balance', async () => {
    const t = await purchasedFixture(), before = canonicalErpJson(t.state.book), count = t.appends();
    await expect(t.send('duplicate-bill', t.bill({ id: 'bill-duplicate' }))).rejects.toMatchObject({ code: 'vendor_bill_already_recorded' });
    await expect(t.send('overpayment', t.vendorPayment('overpayment', '10826'))).rejects.toMatchObject({ code: 'overpayment' });
    expect(t.appends()).toBe(count); expect(canonicalErpJson(t.state.book)).toBe(before);
    expect(generalLedger((await projectUsFinancialBookV5(t.state.book)).ledger, 'payables', range).closingMinor).toBe('-10825');
  });

  it.each(['member', 'read_only'] as const)('never grants PostgreSQL purchasing access to %s', async role => {
    const t = await fixture(), actor = { ...t.actor, role };
    expect(() => createSupabaseUsFinancialPurchasingTestStoreV5({ rpc: t.rpc }, { ...t.scope, actor }, t.revalidate)).toThrowError();
    await expect(executeUsFinancialKernelV5({ ...t.deps, actor }, t.request('forbidden-vendor', { type: 'save_vendor', vendor: t.vendor }))).rejects.toMatchObject({ code: 'financial_permission_required' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it.each(['admin', 'accountant'] as const)('admits the explicitly scoped financial role %s', async role => {
    const t = await fixture(), actor = { ...t.actor, role }, scope = { ...t.scope, actor };
    const store = createSupabaseUsFinancialPurchasingTestStoreV5({ rpc: t.rpc }, scope, async () => scope);
    const deps = { ...t.deps, actor, store, revalidate: async () => ({ configuration: t.configuration, actor, policy: t.policy }) };
    await executeUsFinancialKernelV5(deps, t.request('scoped-vendor', { type: 'save_vendor', vendor: t.vendor }));
    expect(lastErp(t.state.book).actor).toEqual(actor);
  });

  it('rejects a factory scope with an invalid grant or missing trusted callback before IO', async () => {
    const t = await fixture();
    for (const grantVersion of [0, Number.MAX_SAFE_INTEGER]) expect(() => createSupabaseUsFinancialPurchasingTestStoreV5({ rpc: t.rpc }, { ...t.scope, grantVersion }, t.revalidate)).toThrowError();
    expect(() => createSupabaseUsFinancialPurchasingTestStoreV5({ rpc: t.rpc }, t.scope, null as never)).toThrowError(); expect(t.rpc).not.toHaveBeenCalled();
  });

  it.each(['read', 'receipt', 'commit'] as const)('refuses a foreign organization before %s IO', async method => {
    const t = await fixture(), commit = await t.candidate('vendor-candidate', { type: 'save_vendor', vendor: t.vendor });
    if (method === 'read') expect(() => t.store.read('foreign')).toThrowError();
    else if (method === 'receipt') await expect(t.store.receipt('foreign', 'key')).rejects.toMatchObject({ code: 'tenant_mismatch' });
    else await expect(t.store.commit({ ...commit, organizationId: 'foreign' })).rejects.toMatchObject({ code: 'tenant_mismatch' });
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('refuses a runtime capability switch before any purchasing lookup', async () => {
    const t = await fixture(), mutable = { ...t.store };
    await expect(executeUsFinancialKernelV5({ ...t.deps, store: mutable, revalidate: async () => { mutable.capability = 'memory-test-v5'; return { configuration: t.configuration, actor: t.actor, policy: t.policy }; } }, t.request('vendor-create', { type: 'save_vendor', vendor: t.vendor }))).rejects.toMatchObject({ code: 'financial_capability_unavailable' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it('keeps cash basis outside the TEST accrual policy before IO', async () => {
    const t = await fixture();
    await expect(executeUsFinancialKernelV5({ ...t.deps, configuration: { ...t.configuration, accountingBasis: 'cash' } }, t.request('vendor-create', { type: 'save_vendor', vendor: t.vendor }))).rejects.toMatchObject({ code: 'financial_policy_unavailable' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it.each(['balanced-posting', 'cash-flow', 'inner-ledger-revision', 'supplier-snapshot', 'prefix'] as const)('rejects a forged %s purchase commit before append', async field => {
    const t = await purchasedFixture(), input = clone(await t.candidate('vendor-payment', t.vendorPayment('vendor-payment', '4000'))), event = lastErp(input.book);
    t.rpc.mockClear();
    if (field === 'balanced-posting') {
      const posting = event.effects.postings[0];
      (posting.lines[0] as { debitMinor: string }).debitMinor = '4001'; (posting.lines[1] as { creditMinor: string }).creditMinor = '4001';
    } else if (field === 'cash-flow') (event.effects.postings[0] as { cashFlowCategory: string }).cashFlowCategory = 'investing';
    else if (field === 'inner-ledger-revision') (event.commit.header.ledger as { revision: number }).revision += 1;
    else if (field === 'supplier-snapshot') {
      const billEvent = input.book.events.find(item => item.operation.type === 'erp_command' && item.operation.command.type === 'record_vendor_bill');
      if (!billEvent || !('commit' in billEvent)) throw Error('Expected synthetic bill event');
      const record = billEvent.commit.changes.find(change => change.kind === 'vendor_bill')?.payload as { vendorSnapshot: { name: string } };
      record.vendorSnapshot.name = 'Forged supplier';
    } else (input as { previousFingerprint: string }).previousFingerprint = '0'.repeat(64);
    await expect(t.store.commit(input)).rejects.toMatchObject({ code: 'invalid_financial_private_data' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it('rejects a malformed private purchase effect returned from read after the final authority check', async () => {
    const t = await purchasedFixture(), corrupt = clone(t.state.book);
    (lastErp(corrupt).effects as { audit: unknown }).audit = null; t.rpc.mockResolvedValue(corrupt); t.revalidate.mockClear();
    await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'invalid_financial_private_data', status: 503 }); expect(t.revalidate).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, false, 0, [], {}])('rejects malformed private book response %o without exposing it', async value => {
    const t = await fixture(); t.rpc.mockResolvedValue(value);
    await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'invalid_financial_private_data', status: 503 }); expect(t.revalidate).toHaveBeenCalledTimes(2);
  });

  it('returns only null as an absent book or receipt', async () => {
    const t = await fixture(); t.rpc.mockResolvedValue(null);
    expect(await t.store.read(t.scope.organizationId)).toBeNull(); expect(await t.store.receipt(t.scope.organizationId, 'missing')).toBeNull();
  });

  it('rejects getters and inherited factory inputs without executing their accessors', async () => {
    const t = await fixture(), getter = vi.fn(() => t.actor), raw = clone(t.scope);
    Object.defineProperty(raw, 'actor', { enumerable: true, get: getter });
    expect(() => createSupabaseUsFinancialPurchasingTestStoreV5({ rpc: t.rpc }, raw, t.revalidate)).toThrowError(); expect(getter).not.toHaveBeenCalled();
    expect(() => createSupabaseUsFinancialPurchasingTestStoreV5({ rpc: t.rpc }, Object.create(t.scope) as UsFinancialTestScopeV5, t.revalidate)).toThrowError(); expect(t.rpc).not.toHaveBeenCalled();
  });

  it('captures initial scope and nested candidate records before callers can mutate them during an await', async () => {
    const t = await fixture(), scope = clone(t.scope), input = clone(await t.candidate('vendor-candidate', { type: 'save_vendor', vendor: t.vendor })), expected = clone(input);
    const store = createSupabaseUsFinancialPurchasingTestStoreV5({ rpc: t.rpc }, scope, t.revalidate);
    (scope as { grantVersion: number }).grantVersion = 99;
    const pending = store.commit(input); (input.receipt as { entityId: string }).entityId = 'Changed after capture';
    const event = lastErp(input.book); if (event.operation.command.type !== 'save_vendor') throw Error('Expected synthetic vendor operation');
    (event.operation.command.vendor as { name: string }).name = 'Changed after capture';
    expect(await pending).toEqual(expected.receipt);
    expect(t.rpc).toHaveBeenLastCalledWith(appendRpc, { p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-purchasing-v5', p_expected_revision: expected.expectedRevision, p_previous_fingerprint: expected.previousFingerprint, p_book: expected.book, p_receipt: expected.receipt });
  });

  it.each([
    ['financial_test_grant_changed', (scope: UsFinancialTestScopeV5) => ({ ...scope, grantVersion: 2 })],
    ['financial_authority_changed', (scope: UsFinancialTestScopeV5) => ({ ...scope, actor: { ...scope.actor, userId: 'other-user' } })],
    ['management_entitlement_required', (scope: UsFinancialTestScopeV5) => ({ ...scope, actor: { ...scope.actor, managementEntitled: false } })],
    ['financial_policy_unavailable', (scope: UsFinancialTestScopeV5) => ({ ...scope, policy: { ...scope.policy, approval: { ...scope.policy.approval, reference: 'changed' } } })],
  ] as const)('prioritizes postflight authority failure %s over malformed read data', async (code, patch) => {
    const t = await fixture(); t.rpc.mockResolvedValue({}); t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue(patch(t.scope));
    await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code });
  });

  it('prefers revocation during invalid commit hashing without sending an append', async () => {
    const t = await fixture(), input = await t.candidate('vendor-candidate', { type: 'save_vendor', vendor: t.vendor });
    t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue({ ...t.scope, grantVersion: 2 });
    await expect(t.store.commit({ ...input, previousFingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'financial_test_grant_changed' }); expect(t.rpc).not.toHaveBeenCalled();
  });

  it('rejects revoked postflight access even after the synthetic append persisted its effect, without retrying', async () => {
    const t = await fixture(), input = await t.candidate('vendor-candidate', { type: 'save_vendor', vendor: t.vendor });
    let appended = false;
    const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      if (name !== appendRpc) throw Error('Only synthetic append expected');
      t.state.book = args.p_book as UsFinancialBookV5; appended = true; return args.p_receipt;
    });
    const store = createSupabaseUsFinancialPurchasingTestStoreV5({ rpc }, t.scope, async () => ({ ...t.scope, grantVersion: appended ? 2 : 1 }));
    await expect(store.commit(input)).rejects.toMatchObject({ code: 'financial_test_grant_changed' });
    expect(t.state.book).toEqual(input.book); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('revalidates receipt corroboration after hashing even when the retained hash is invalid', async () => {
    const t = await purchasedFixture(), receipt = t.commit().receipt;
    t.state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: t.actor.userId, receipt: { ...receipt, commandHash: '0'.repeat(64) } });
    let checks = 0; t.revalidate.mockImplementation(async () => ++checks < 5 ? t.scope : { ...t.scope, grantVersion: 2 });
    await expect(t.store.receipt(t.scope.organizationId, receipt.idempotencyKey)).rejects.toMatchObject({ code: 'financial_test_grant_changed' });
  });

  it('refuses a future execution actor before append and accepts historical commits under an advanced trusted clock', async () => {
    const t = await fixture(), command: UsFinancialErpCommandV5 = { type: 'save_vendor', vendor: t.vendor };
    const future = await t.candidate('future-vendor', command, { ...t.actor, timestamp: '2026-10-11T12:00:00.000Z' });
    await expect(t.store.commit(future)).rejects.toMatchObject({ code: 'financial_clock_reversed' }); expect(t.rpc).not.toHaveBeenCalled();
    const historical = await t.candidate('historical-vendor', command);
    t.revalidate.mockResolvedValue({ ...t.scope, actor: { ...t.actor, timestamp: '2026-10-11T12:00:00.000Z' } });
    expect(await t.store.commit(historical)).toEqual(historical.receipt);
  });

  it('refuses a backward trusted clock on a purchasing read', async () => {
    const t = await fixture(); t.revalidate.mockResolvedValueOnce({ ...t.scope, actor: { ...t.actor, timestamp: '2026-10-10T12:01:00.000Z' } }).mockResolvedValue(t.scope);
    await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_clock_reversed' });
  });

  it('maps a live source lock as a definite refusal and hides unknown private transport diagnostics', async () => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(500, 'PO008', 'Synthetic confidential database detail'));
    await expect(t.send('customer-edit', { type: 'save_customer', customer: t.customer })).rejects.toMatchObject({ code: 'sales_order_source_locked', status: 409 });
    t.rpc.mockClear(); t.rpc.mockRejectedValue(new SupabaseServerError(500, 'XX000', 'Synthetic confidential database detail'));
    const input = await t.candidate('vendor-candidate', { type: 'save_vendor', vendor: t.vendor });
    await expect(t.store.commit(input)).rejects.toMatchObject({ code: 'financial_service_unavailable', status: 503 }); expect(t.rpc).toHaveBeenCalledTimes(1);
  });
});
