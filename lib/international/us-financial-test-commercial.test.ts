import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { executeUsFinancialKernelV5, type UsFinancialCommitV5, type UsFinancialReceiptV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { createSupabaseUsFinancialCommercialTestStoreV5 } from './us-financial-test-commercial';
import { createSupabaseUsFinancialSettlementTestStoreV5 } from './us-financial-test-settlement';
import type { UsFinancialTestScopeV5 } from './us-financial-test-foundation';

// Real financial/ERP transitions, synthetic RPC transport only. SQL tests in
// the separate postgres file must establish the independent DB guards.
async function fixture() {
  const data = await financialKernelFixture(), initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const scope: UsFinancialTestScopeV5 = { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 };
  const state = { book: initial, receipts: new Map<string, UsFinancialReceiptV5>() };
  const revalidate = vi.fn(async () => scope);
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (name === 'zentra_read_us_financial_commercial_test_v5') return state.book;
    if (name === 'zentra_us_financial_commercial_test_receipt_v5') {
      const receipt = state.receipts.get(args.p_idempotency_key as string); return receipt ? { origin: 'financial_v5', actorId: receipt.actorId, receipt } : null;
    }
    if (name === 'zentra_append_us_financial_commercial_test_v5') {
      const receipt = args.p_receipt as UsFinancialReceiptV5; state.book = args.p_book as UsFinancialBookV5; state.receipts.set(receipt.idempotencyKey, receipt); return receipt;
    }
    throw Error('Unexpected private commercial RPC');
  });
  const store = createSupabaseUsFinancialCommercialTestStoreV5({ rpc }, scope, revalidate);
  const resolveTax = vi.fn(async ({ candidate, idempotencyKey }: { candidate: { invoiceFingerprint: string; allocationSha256: string; allocation: { taxMinor: string } }; idempotencyKey: string }): Promise<UsFinancialTaxProofV5> => ({ schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'SYNTHETIC ONLY', verifiedBy: 'synthetic-resolver', verifiedAt: data.actor.timestamp, providerAccountReference: 'acct_synthetic', originalTaxTransactionReference: 'testtxn_synthetic', adjustmentPlanReference: `testplan_${idempotencyKey}`, authorizedTaxMinor: candidate.allocation.taxMinor }));
  const resolveIssuance = vi.fn(async (): Promise<never> => { throw Error('No issuance in this capability'); });
  const deps = { ...data, store, resolveTax, resolveIssuance, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }) };
  const request = (key: string, command: UsFinancialErpCommandV5): UsFinancialRequestV5 => ({ idempotencyKey: key, expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } });
  const send = (key: string, command: UsFinancialErpCommandV5) => executeUsFinancialKernelV5(deps, request(key, command));
  const customer = { ...data.baseline.customers[0], id: 'customer-2', name: 'Synthetic new customer' };
  const quote: UsFinancialErpCommandV5 = { type: 'save_estimate', id: 'quote-2', expectedEstimateRevision: 0, customerId: customer.id, date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: data.baseline.estimates[0].lines, notes: 'First line\nSecond line · Genève · 東京 · 🌍' };
  const payment = (): UsFinancialRequestV5 => ({ idempotencyKey: 'payment-later', expectedRevision: state.book.revision, command: { type: 'customer_payment', id: 'payment-later', invoiceId: 'invoice-1', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic no money moved' } });
  const credit = (): UsFinancialRequestV5 => ({ idempotencyKey: 'credit-original', expectedRevision: state.book.revision, command: { type: 'customer_credit', id: 'credit-original', invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
  const commit = (): UsFinancialCommitV5 => {
    const args = rpc.mock.calls.filter(([name]) => name === 'zentra_append_us_financial_commercial_test_v5').at(-1)![1];
    return { organizationId: scope.organizationId, expectedRevision: args.p_expected_revision as number, previousFingerprint: args.p_previous_fingerprint as string, book: args.p_book as UsFinancialBookV5, receipt: args.p_receipt as UsFinancialReceiptV5, actor: args.p_actor as typeof data.actor };
  };
  return { ...data, initial, scope, state, revalidate, rpc, store, deps, request, send, customer, quote, payment, credit, commit, resolveTax, resolveIssuance };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('private commercial TEST adapter — synthetic RPC transport', () => {
  it('exposes only the new closed capability and private RPC names', async () => {
    const t = await fixture(); expect(Object.keys(t.store).sort()).toEqual(['capability', 'commit', 'read', 'receipt']); expect(Object.isFrozen(t.store)).toBe(true);
    expect(t.store.capability).toBe('postgres-test-commercial-v5'); expect(await t.store.read(t.scope.organizationId)).toEqual(t.initial);
    expect(t.rpc).toHaveBeenLastCalledWith('zentra_read_us_financial_commercial_test_v5', { p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-commercial-v5' });
  });
  it('continues commercial work after credit, then pays the original invoice in one book', async () => {
    const t = await fixture(), immutable = canonicalErpJson(t.initial.baseline);
    await executeUsFinancialKernelV5(t.deps, t.credit());
    await t.send('customer-create', { type: 'save_customer', customer: t.customer }); await t.send('customer-edit', { type: 'save_customer', customer: { ...t.customer, name: 'Synthetic updated customer' } });
    await t.send('quote-create', t.quote); await t.send('quote-accept', { type: 'accept_estimate', estimateId: 'quote-2', expectedEstimateRevision: 1 });
    await executeUsFinancialKernelV5(t.deps, t.payment());
    const view = await projectUsFinancialBookV5(await t.store.read(t.scope.organizationId) as UsFinancialBookV5);
    expect(view.revision).toBe(t.initial.revision + 6); expect(view.ledger.revision).toBe(t.baseline.ledger.revision + 2);
    expect(view.settlements[0]).toMatchObject({ receivedMinor: '100', creditedMinor: '10825', outstandingMinor: '21550' });
    expect(view.customers.find(c => c.id === t.customer.id)?.name).toBe('Synthetic updated customer'); expect(view.estimates.find(q => q.id === 'quote-2')).toMatchObject({ status: 'accepted', revision: 2, notes: t.quote.type === 'save_estimate' ? t.quote.notes : '' });
    expect(canonicalErpJson(t.state.book.baseline)).toBe(immutable); expect(t.resolveIssuance).not.toHaveBeenCalled(); expect(t.resolveTax).toHaveBeenCalledTimes(1);
  });
  it('keeps historical invoice and estimate customer snapshots after editing the live customer', async () => {
    const t = await fixture(), original = t.baseline.customers[0];
    await t.send('edit-original', { type: 'save_customer', customer: { ...original, name: 'Synthetic renamed live customer' } });
    const view = await projectUsFinancialBookV5(t.state.book);
    expect(view.invoices[0].customer).toEqual(original); expect(view.estimates[0].customer).toEqual(original); expect(view.customers[0].name).not.toBe(original.name);
  });
  it('allows repeated entity IDs, no-op customer saves and repeated acceptance without adding journals', async () => {
    const t = await fixture();
    await t.send('same-one', { type: 'save_customer', customer: t.baseline.customers[0] }); await t.send('same-two', { type: 'save_customer', customer: t.baseline.customers[0] });
    await t.send('new-customer', { type: 'save_customer', customer: t.customer }); await t.send('new-quote', t.quote);
    await t.send('accept-one', { type: 'accept_estimate', estimateId: 'quote-2', expectedEstimateRevision: 1 }); await t.send('accept-two', { type: 'accept_estimate', estimateId: 'quote-2', expectedEstimateRevision: 2 });
    const first = t.state.book.events[0]; if (!('commit' in first)) throw Error('Expected synthetic ERP event');
    expect(first.commit.changes).toEqual([]); expect(first.effects).toEqual({ postings: [], audit: [] });
    const view = await projectUsFinancialBookV5(t.state.book); expect(view.estimates.at(-1)?.revision).toBe(3); expect(view.ledger).toEqual(t.baseline.ledger);
  });
  it('corroborates an outer ERP receipt independently of the inner ERP command receipt', async () => {
    const t = await fixture(), request = t.request('new-customer', { type: 'save_customer', customer: t.customer });
    const receipt = await executeUsFinancialKernelV5(t.deps, request), event = t.state.book.events.at(-1)!;
    if (!('commit' in event)) throw Error('Expected synthetic ERP event');
    expect(receipt.commandHash).not.toBe(event.commit.receipt.commandHash); expect(receipt.commandHash).toBe(await sha256Hex(canonicalErpJson([t.scope.organizationId, t.actor.userId, request])));
    expect(await t.store.receipt(t.scope.organizationId, request.idempotencyKey)).toEqual(receipt);
    t.state.receipts.set(receipt.idempotencyKey, { ...receipt, commandHash: event.commit.receipt.commandHash });
    await expect(t.store.receipt(t.scope.organizationId, request.idempotencyKey)).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('replays an old commercial request after later credit and payment without repeating append', async () => {
    const t = await fixture(), request = t.request('new-customer', { type: 'save_customer', customer: t.customer });
    const receipt = await executeUsFinancialKernelV5(t.deps, request); await executeUsFinancialKernelV5(t.deps, t.credit()); await executeUsFinancialKernelV5(t.deps, t.payment());
    const appends = t.rpc.mock.calls.filter(([name]) => name === 'zentra_append_us_financial_commercial_test_v5').length;
    expect(await executeUsFinancialKernelV5(t.deps, request)).toEqual(receipt); expect(t.rpc.mock.calls.filter(([name]) => name === 'zentra_append_us_financial_commercial_test_v5')).toHaveLength(appends);
  });
  it.each(['member', 'read_only'] as const)('does not infer a commercial PostgreSQL grant for %s', async role => {
    const t = await fixture(), actor = { ...t.actor, role };
    expect(() => createSupabaseUsFinancialCommercialTestStoreV5({ rpc: t.rpc }, { ...t.scope, actor }, t.revalidate)).toThrowError();
    await expect(executeUsFinancialKernelV5({ ...t.deps, actor }, t.request('member-save', { type: 'save_customer', customer: t.customer }))).rejects.toMatchObject({ code: 'financial_permission_required' }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['save_vendor', 'save_projects', 'record_vendor_bill', 'record_vendor_payment', 'close_period', 'open_period', 'post_manual_journal', 'reverse_manual_journal', 'issue_invoice'] as const)('refuses the valid but unadmitted ERP command %s before RPC/provider IO', async kind => {
    const t = await fixture();
    const commands: Record<typeof kind, UsFinancialErpCommandV5> = {
      save_vendor: { type: 'save_vendor', vendor: t.customer }, close_period: { type: 'close_period', periodId: '2026' }, open_period: { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' },
      save_projects: { type: 'save_projects', projects: [{ id: 'project-2', expectedProjectRevision: 0, customerId: t.customer.id, name: 'Synthetic project', status: 'active', notes: '', startDate: null, targetDate: null, budgetMinor: null, vendorBillIds: [] }] },
      record_vendor_bill: { type: 'record_vendor_bill', id: 'bill-2', vendorId: t.customer.id, reference: 'Synthetic bill', date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-10', periodId: '2026', netMinor: '100', purchaseTaxMinor: '0', expenseAccountId: 'purchases', sourceReference: 'synthetic-document' },
      record_vendor_payment: { type: 'record_vendor_payment', id: 'vendor-payment-2', billId: 'bill-2', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic payment' },
      post_manual_journal: { type: 'post_manual_journal', id: 'journal-2', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic journal', sourceReference: 'synthetic-document', lines: [{ accountId: 'purchases', debitMinor: '100', creditMinor: '0' }, { accountId: 'cash', debitMinor: '0', creditMinor: '100' }], cashFlowCategory: 'operating' },
      reverse_manual_journal: { type: 'reverse_manual_journal', id: 'reverse-2', entryId: 'journal-2', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic correction' },
      issue_invoice: { type: 'issue_invoice', id: 'invoice-2', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-10', periodId: '2026' },
    };
    await expect(t.send('blocked-command', commands[kind])).rejects.toMatchObject({ code: 'financial_append_unavailable', status: 409 }); expect(t.rpc).not.toHaveBeenCalled(); expect(t.resolveTax).not.toHaveBeenCalled(); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });
  it('rejects a foreign capability switch during revalidation', async () => {
    const t = await fixture(), store = { ...t.store };
    await expect(executeUsFinancialKernelV5({ ...t.deps, store, revalidate: async () => { store.capability = 'memory-test-v5'; return { configuration: t.configuration, actor: t.actor, policy: t.policy }; } }, t.request('new-customer', { type: 'save_customer', customer: t.customer }))).rejects.toMatchObject({ code: 'financial_capability_unavailable' }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('keeps the settlement adapter closed to a commercial book after sharing validation mechanics', async () => {
    const t = await fixture(); await t.send('new-customer', { type: 'save_customer', customer: t.customer });
    const rpc = vi.fn(async () => t.state.book), old = createSupabaseUsFinancialSettlementTestStoreV5({ rpc }, t.scope, t.revalidate);
    await expect(old.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
    await expect(old.commit(t.commit())).rejects.toMatchObject({ code: 'financial_append_unavailable' });
  });
  it('rejects an otherwise valid full-memory ERP tail not admitted by the commercial profile', async () => {
    const t = await fixture(), result = await applyUsFinancialOperationV5(t.initial, { type: 'erp_command', idempotencyKey: 'vendor', command: { type: 'save_vendor', vendor: t.customer }, facts: { kind: 'none' } }, t.actor, t.customer.id);
    t.state.book = result.book; await expect(t.store.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
  });
  it.each(['receipt', 'inner-header', 'prefix'] as const)('refuses forged %s before sending append', async field => {
    const t = await fixture(); await t.send('new-customer', { type: 'save_customer', customer: t.customer }); const commit = clone(t.commit()); t.rpc.mockClear();
    if (field === 'receipt') (commit.receipt as { commandHash: string }).commandHash = '0'.repeat(64);
    else if (field === 'prefix') (commit as { previousFingerprint: string }).previousFingerprint = '0'.repeat(64);
    else { const event = commit.book.events.at(-1)!; if (!('commit' in event)) throw Error('Expected synthetic ERP event'); (event.commit.header.ledger as { revision: number }).revision += 1; }
    await expect(t.store.commit(commit)).rejects.toMatchObject({ code: 'invalid_financial_private_data' }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('maps authoritative sales-order source locks without exposing SQL diagnostics', async () => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(500, 'PO008', 'Synthetic confidential details'));
    await expect(t.send('new-customer', { type: 'save_customer', customer: t.customer })).rejects.toMatchObject({ code: 'sales_order_source_locked', status: 409 });
  });
  it('revalidates commercial append authority even if the response is successful', async () => {
    const t = await fixture(); await t.send('new-customer', { type: 'save_customer', customer: t.customer }); const commit = t.commit();
    let revoked = false; const rpc = vi.fn(async () => { revoked = true; return commit.receipt; });
    const store = createSupabaseUsFinancialCommercialTestStoreV5({ rpc }, t.scope, async () => ({ ...t.scope, grantVersion: revoked ? 2 : 1 }));
    await expect(store.commit(commit)).rejects.toMatchObject({ code: 'financial_test_grant_changed' }); expect(rpc).toHaveBeenCalledTimes(1);
  });
});
