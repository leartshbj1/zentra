import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { executeUsFinancialKernelV5, type UsFinancialCommitV5, type UsFinancialReceiptV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import type { UsFinancialBookV5, UsFinancialOperationV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
import type { UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialSettlementTestStoreV5 } from './us-financial-test-settlement';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function fixture() {
  const data = await financialKernelFixture();
  const book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const scope: UsFinancialTestScopeV5 = { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 };
  const request: UsFinancialRequestV5 = { idempotencyKey: 'payment-one', expectedRevision: book.revision, command: { type: 'customer_payment', id: 'payment-one', invoiceId: 'invoice-1', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic no money moved' } };
  const { id, ...fields } = request.command as Extract<UsFinancialRequestV5['command'], { type: 'customer_payment' }>;
  const result = await applyUsFinancialOperationV5(book, { ...fields, idempotencyKey: request.idempotencyKey }, data.actor, id);
  const receipt: UsFinancialReceiptV5 = { idempotencyKey: request.idempotencyKey, commandHash: await sha256Hex(canonicalErpJson([scope.organizationId, data.actor.userId, request])), revision: result.book.revision, entityId: id, action: 'customer_payment', actorId: data.actor.userId };
  const commit: UsFinancialCommitV5 = { organizationId: scope.organizationId, expectedRevision: book.revision, previousFingerprint: await sha256Hex(canonicalErpJson(book)), book: result.book, receipt, actor: data.actor };
  const state = { book: book as UsFinancialBookV5 | null, receipts: new Map<string, unknown>() };
  const revalidate = vi.fn(async () => scope);
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (name === 'zentra_read_us_financial_settlement_test_v5') return state.book;
    if (name === 'zentra_us_financial_settlement_test_receipt_v5') return state.receipts.get(args.p_idempotency_key as string) ?? null;
    if (name === 'zentra_append_us_financial_settlement_test_v5') {
      state.book = args.p_book as UsFinancialBookV5;
      const r = args.p_receipt as UsFinancialReceiptV5;
      state.receipts.set(r.idempotencyKey, { origin: 'financial_v5', actorId: r.actorId, receipt: r });
      return r;
    }
    throw Error('Unexpected private settlement RPC');
  });
  const adapter = createSupabaseUsFinancialSettlementTestStoreV5({ rpc }, scope, revalidate);
  const tax = vi.fn(async (input: { book: UsFinancialBookV5; idempotencyKey: string; candidate: { invoiceFingerprint: string; allocationSha256: string; allocation: { taxMinor: string } } }): Promise<UsFinancialTaxProofV5> => ({ schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: input.candidate.invoiceFingerprint, allocationSha256: input.candidate.allocationSha256, reference: 'SYNTHETIC TEST AUTHORIZATION ONLY', verifiedBy: 'synthetic-test-resolver', verifiedAt: data.actor.timestamp, providerAccountReference: 'acct_synthetic', originalTaxTransactionReference: 'testtxn_synthetic', adjustmentPlanReference: `testplan_${input.idempotencyKey}`, authorizedTaxMinor: input.candidate.allocation.taxMinor }));
  const deps = { configuration: data.configuration, actor: data.actor, policy: data.policy, store: adapter, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }), resolveTax: tax };
  return { ...data, book, scope, request, result, receipt, commit, state, revalidate, rpc, adapter, tax, deps };
}

describe('private PostgreSQL TEST settlement adapter — mock RPC transport', () => {
  it('declares only settlement capability, no public ERP version or promotion', async () => {
    const t = await fixture(); expect(Object.keys(t.adapter).sort()).toEqual(['capability', 'commit', 'read', 'receipt']);
    expect(t.adapter.capability).toBe('postgres-test-settlement-v5'); expect(Object.isFrozen(t.adapter)).toBe(true);
  });
  it('validates/captures the shared TEST scope and requires a trusted callback', async () => {
    const t = await fixture();
    expect(() => createSupabaseUsFinancialSettlementTestStoreV5({ rpc: t.rpc }, { ...t.scope, grantVersion: Number.MAX_SAFE_INTEGER }, t.revalidate)).toThrowError();
    expect(() => createSupabaseUsFinancialSettlementTestStoreV5({ rpc: t.rpc }, t.scope, null as never)).toThrowError();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('reads a detached promoted baseline and later reconstructs its actual payment tail', async () => {
    const t = await fixture(); expect(await t.adapter.read(t.scope.organizationId)).toEqual(t.book);
    t.state.book = t.result.book; const read = await t.adapter.read(t.scope.organizationId) as UsFinancialBookV5;
    expect(read).toEqual(t.result.book); expect(read).not.toBe(t.result.book);
    expect((await projectUsFinancialBookV5(read)).settlements[0]).toMatchObject({ receivedMinor: '100', creditedMinor: '0', outstandingMinor: '32375' });
    expect(t.rpc).toHaveBeenLastCalledWith('zentra_read_us_financial_settlement_test_v5', { p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-settlement-v5' });
  });
  it('integrates the real runtime payment and exact retry without a second append', async () => {
    const t = await fixture(); expect(await executeUsFinancialKernelV5(t.deps, t.request)).toEqual(t.receipt);
    expect(await executeUsFinancialKernelV5(t.deps, t.request)).toEqual(t.receipt);
    expect(t.rpc.mock.calls.filter(([name]) => name === 'zentra_append_us_financial_settlement_test_v5')).toHaveLength(1);
    expect(t.tax).not.toHaveBeenCalled(); expect(t.state.book).toEqual(t.result.book);
  });
  it('integrates credit then payment through the same runtime/book and trusted TEST tax resolver', async () => {
    const t = await fixture();
    await executeUsFinancialKernelV5(t.deps, { idempotencyKey: 'credit-one', expectedRevision: t.book.revision, command: { type: 'customer_credit', id: 'credit-one', invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic returned service', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
    expect(t.tax).toHaveBeenCalledTimes(1);
    await executeUsFinancialKernelV5(t.deps, { ...t.request, expectedRevision: t.state.book!.revision });
    const view = await projectUsFinancialBookV5(t.state.book!);
    expect(view.settlements[0]).toMatchObject({ creditedMinor: '10825', receivedMinor: '100', outstandingMinor: '21550' });
    expect(view.credits[0].taxDisposition).toBe('adjustment_pending'); expect(view.invoices[0].total.minorUnits).toBe('32475');
  });
  it('refuses mixed ERP requests before any RPC or provider lookup', async () => {
    const t = await fixture();
    await expect(executeUsFinancialKernelV5(t.deps, { idempotencyKey: 'not-settlement', expectedRevision: t.book.revision, command: { type: 'erp_command', request: { type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Synthetic changed customer' } } } })).rejects.toMatchObject({ code: 'financial_append_unavailable', status: 409 });
    expect(t.rpc).not.toHaveBeenCalled(); expect(t.tax).not.toHaveBeenCalled();
  });
  it('rejects a capability switch during runtime revalidation', async () => {
    const t = await fixture(), mutable = { ...t.adapter };
    const deps = { ...t.deps, store: mutable, revalidate: async () => { mutable.capability = 'memory-test-v5'; return { configuration: t.configuration, actor: t.actor, policy: t.policy }; } };
    await expect(executeUsFinancialKernelV5(deps, t.request)).rejects.toMatchObject({ code: 'financial_capability_unavailable' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('allows only null as absence', async () => {
    const t = await fixture(); t.rpc.mockResolvedValue(null);
    expect(await t.adapter.read(t.scope.organizationId)).toBeNull(); expect(await t.adapter.receipt(t.scope.organizationId, 'missing')).toBeNull();
  });
  it.each([undefined, false, 0, '', [], {}])('rejects malformed private book %s after revalidating', async value => {
    const t = await fixture(); t.rpc.mockResolvedValue(value);
    await expect(t.adapter.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'invalid_financial_private_data', status: 503 }); expect(t.revalidate).toHaveBeenCalledTimes(2);
  });
  it.each(['read', 'receipt', 'commit'] as const)('refuses another tenant before %s RPC', async method => {
    const t = await fixture();
    if (method === 'commit') await expect(t.adapter.commit({ ...t.commit, organizationId: 'foreign' })).rejects.toMatchObject({ code: 'tenant_mismatch' });
    else if (method === 'read') expect(() => t.adapter.read('foreign')).toThrowError();
    else await expect(t.adapter.receipt('foreign', 'key')).rejects.toMatchObject({ code: 'tenant_mismatch' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('corroborates a financial receipt with the actual event and canonical request hash', async () => {
    const t = await fixture(); t.state.book = t.result.book;
    t.state.receipts.set('payment-one', { origin: 'financial_v5', actorId: t.actor.userId, receipt: t.receipt });
    expect(await t.adapter.receipt(t.scope.organizationId, 'payment-one')).toEqual(t.receipt);
    t.state.receipts.set('payment-one', { origin: 'financial_v5', actorId: t.actor.userId, receipt: { ...t.receipt, commandHash: '0'.repeat(64) } });
    await expect(t.adapter.receipt(t.scope.organizationId, 'payment-one')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it.each([
    { origin: 'financial_v5', actorId: 'foreign' },
    { origin: 'unknown', actorId: 'synthetic-financial-owner' },
    { origin: 'financial_v5', actorId: 'synthetic-financial-owner', extra: true },
  ])('rejects malformed/foreign receipt envelope %o', async envelope => {
    const t = await fixture(); t.state.receipts.set('payment-one', { receipt: t.receipt, ...envelope });
    await expect(t.adapter.receipt(t.scope.organizationId, 'payment-one')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('reserves legacy receipt keys without treating them as financial receipts', async () => {
    const t = await fixture(), legacyKey = 'L'.repeat(232);
    t.state.receipts.set(legacyKey, { origin: 'legacy_erp4', actorId: t.actor.userId, receipt: { idempotencyKey: legacyKey, commandHash: '1'.repeat(64), revision: 2, entityId: 'customer-1', action: 'save_customer' } });
    await expect(t.adapter.receipt(t.scope.organizationId, legacyKey)).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it('refuses a correctly shaped financial receipt whose actual event is missing', async () => {
    const t = await fixture(); t.state.receipts.set('payment-one', { origin: 'financial_v5', actorId: t.actor.userId, receipt: t.receipt });
    await expect(t.adapter.receipt(t.scope.organizationId, 'payment-one')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('checks exact prefix SHA, event actor and reconstructed receipt before append', async () => {
    const t = await fixture(); expect(await t.adapter.commit(t.commit)).toEqual(t.receipt);
    expect(t.rpc).toHaveBeenCalledWith('zentra_append_us_financial_settlement_test_v5', { p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-settlement-v5', p_expected_revision: t.book.revision, p_previous_fingerprint: t.commit.previousFingerprint, p_book: t.result.book, p_receipt: t.receipt });
  });
  it.each([
    (c: UsFinancialCommitV5) => ({ ...c, previousFingerprint: '0'.repeat(64) }),
    (c: UsFinancialCommitV5) => ({ ...c, expectedRevision: c.expectedRevision + 1 }),
    (c: UsFinancialCommitV5) => ({ ...c, receipt: { ...c.receipt, commandHash: '0'.repeat(64) } }),
    (c: UsFinancialCommitV5) => ({ ...c, actor: { ...c.actor, timestamp: '2026-10-10T11:59:00.000Z' } }),
    (c: UsFinancialCommitV5) => ({ ...c, receipt: { ...c.receipt, entityId: 'wrong' } }),
  ])('rejects a forged commit before SQL %s', async patch => {
    const t = await fixture(); await expect(t.adapter.commit(patch(t.commit))).rejects.toMatchObject({ code: 'invalid_financial_private_data' }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('rejects a mixed ERP event even when it reconstructs as a valid V5 book', async () => {
    const t = await fixture();
    const op: UsFinancialOperationV5 = { type: 'erp_command', idempotencyKey: 'erp-one', command: { type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Synthetic newer customer' } }, facts: { kind: 'none' } };
    t.state.book = (await applyUsFinancialOperationV5(t.book, op, t.actor, 'customer-1')).book;
    await expect(t.adapter.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_append_unavailable' });
  });
  it('does not expose a malformed or changed append response', async () => {
    const t = await fixture(); t.rpc.mockResolvedValue({ ...t.receipt, actorId: 'wrong' });
    await expect(t.adapter.commit(t.commit)).rejects.toMatchObject({ code: 'invalid_financial_private_data' }); expect(t.revalidate).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['financial_test_grant_changed', (s: UsFinancialTestScopeV5) => ({ ...s, grantVersion: 2 })],
    ['financial_authority_changed', (s: UsFinancialTestScopeV5) => ({ ...s, actor: { ...s.actor, userId: 'other' } })],
    ['management_entitlement_required', (s: UsFinancialTestScopeV5) => ({ ...s, actor: { ...s.actor, managementEntitled: false } })],
    ['financial_policy_unavailable', (s: UsFinancialTestScopeV5) => ({ ...s, policy: { ...s.policy, approval: { ...s.policy.approval, reference: 'changed' } } })],
  ] as const)('prefers fresh authority failure %s over malformed RPC response', async (code, patch) => {
    const t = await fixture(); t.rpc.mockResolvedValue({}); t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue(patch(t.scope));
    await expect(t.adapter.read(t.scope.organizationId)).rejects.toMatchObject({ code });
  });
  it('rechecks authority after receipt/event hashing, including mismatched receipt', async () => {
    const t = await fixture(); t.state.book = t.result.book;
    t.state.receipts.set('payment-one', { origin: 'financial_v5', actorId: t.actor.userId, receipt: { ...t.receipt, commandHash: '0'.repeat(64) } });
    let checks = 0; t.revalidate.mockImplementation(async () => ++checks < 5 ? t.scope : { ...t.scope, grantVersion: 2 });
    await expect(t.adapter.receipt(t.scope.organizationId, 'payment-one')).rejects.toMatchObject({ code: 'financial_test_grant_changed' });
  });
  it('prefers revocation during failed commit validation without sending an append', async () => {
    const t = await fixture(); t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue({ ...t.scope, grantVersion: 2 });
    await expect(t.adapter.commit({ ...t.commit, previousFingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'financial_test_grant_changed' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('refuses a future execution actor relative to the trusted current clock before append', async () => {
    const t = await fixture(), futureActor = { ...t.actor, timestamp: '2026-10-11T12:00:00.000Z' };
    const event = t.result.book.events[0]; if (event.operation.type !== 'customer_payment') throw Error('Expected synthetic payment');
    const result = await applyUsFinancialOperationV5(t.book, event.operation, futureActor, event.id);
    await expect(t.adapter.commit({ ...t.commit, actor: futureActor, book: result.book })).rejects.toMatchObject({ code: 'financial_clock_reversed' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('keeps historical exact retries valid when the trusted clock has advanced', async () => {
    const t = await fixture(); t.revalidate.mockResolvedValue({ ...t.scope, actor: { ...t.actor, timestamp: '2026-10-11T12:00:00.000Z' } });
    expect(await t.adapter.commit(t.commit)).toEqual(t.receipt);
    expect(await t.adapter.commit(t.commit)).toEqual(t.receipt);
  });
  it('refuses a backward trusted clock even on a private read', async () => {
    const t = await fixture(); t.revalidate.mockResolvedValueOnce({ ...t.scope, actor: { ...t.actor, timestamp: '2026-10-10T12:01:00.000Z' } }).mockResolvedValue(t.scope);
    await expect(t.adapter.read(t.scope.organizationId)).rejects.toMatchObject({ code: 'financial_clock_reversed' });
  });
  it('captures initial scope and commit before async work can mutate originals', async () => {
    const t = await fixture(), initial = clone(t.scope), candidate = clone(t.commit);
    const adapter = createSupabaseUsFinancialSettlementTestStoreV5({ rpc: t.rpc }, initial, t.revalidate);
    (initial as { grantVersion: number }).grantVersion = 99;
    const pending = adapter.commit(candidate); (candidate.receipt as { entityId: string }).entityId = 'changed';
    expect(await pending).toEqual(t.receipt);
  });
  it.each([
    ['PF001', 'revision_conflict', 409], ['PF002', 'idempotency_conflict', 409], ['PF004', 'invalid_financial_private_data', 503],
    ['PF005', 'financial_test_grant_required', 403], ['PF006', 'financial_test_grant_changed', 409], ['PF008', 'financial_upgrade_required', 409],
    ['PF010', 'financial_append_unavailable', 409], ['PF013', 'settlement_amount_conflict', 409], ['PF014', 'financial_tax_plan_required', 409],
    ['PF015', 'accounting_period_not_open', 409], ['PF016', 'financial_clock_reversed', 409],
  ])('maps only known private SQL codes %s', async (sqlstate, code, status) => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(500, sqlstate, 'Synthetic secret diagnostic'));
    await expect(t.adapter.commit(t.commit)).rejects.toMatchObject({ code, status });
  });
  it.each([new Error('secret'), { code: 'PF005', message: 'secret' }, new SupabaseServerError(500, 'XX000', 'secret')])('sanitizes unknown transport errors and never retries %o', async failure => {
    const t = await fixture(); t.rpc.mockRejectedValue(failure);
    await expect(t.adapter.commit(t.commit)).rejects.toMatchObject({ code: 'financial_service_unavailable', status: 503 });
    expect(t.rpc).toHaveBeenCalledTimes(1); expect(t.revalidate).toHaveBeenCalledTimes(4);
  });
});
