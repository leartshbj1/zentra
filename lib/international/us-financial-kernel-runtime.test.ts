import { describe, expect, it, vi } from 'vitest';
import { balanceSheet, cashFlow, profitAndLoss, trialBalance } from './accounting/reports';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5, projectUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5, validateUsFinancialRequestV5, type UsFinancialRequestV5, type UsFinancialRuntimeDependenciesV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';

async function fixture() {
  const data = await financialKernelFixture();
  const book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const store = await createInMemoryUsFinancialKernelStoreV5(book, data.policy, actor => actor);
  const resolveTax = vi.fn<UsFinancialRuntimeDependenciesV5['resolveTax']>(async ({ candidate, idempotencyKey }) => ({
    schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization',
    invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256,
    reference: 'synthetic-authorization-only', verifiedBy: 'synthetic-trusted-adapter', verifiedAt: data.actor.timestamp,
    providerAccountReference: 'synthetic-test-account', originalTaxTransactionReference: 'testtxn_synthetic',
    adjustmentPlanReference: `synthetic-plan-${idempotencyKey}`, authorizedTaxMinor: candidate.allocation.taxMinor,
  }));
  const deps: UsFinancialRuntimeDependenciesV5 = { ...data, store, resolveTax, revalidate: vi.fn(async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy })) };
  const read = async () => await store.read(data.configuration.organizationId) as UsFinancialBookV5;
  const request = (key = 'credit-key', quantity = '1'): UsFinancialRequestV5 => ({ idempotencyKey: key, expectedRevision: book.revision, command: { type: 'customer_credit', id: `credit-${key}`, invoiceId: data.baseline.invoices[0].id, transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic service correction', selections: [{ lineId: data.baseline.invoices[0].lines[0].id, quantityUnits: quantity }] } });
  const payment = (revision: number, amount = '10000', key = 'payment-key'): UsFinancialRequestV5 => ({ idempotencyKey: key, expectedRevision: revision, command: { type: 'customer_payment', id: `payment-${key}`, invoiceId: data.baseline.invoices[0].id, amountMinor: amount, paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic bank receipt' } });
  return { ...data, book, store, deps, read, request, payment, resolveTax };
}

describe('internal US financial runtime5 — actual financial transitions in TEST memory', () => {
  it('issues credits and payments with separate actual cash, AR, revenue and tax reports', async () => {
    const t = await fixture(), baselineJson = canonicalErpJson(t.baseline);
    const first = await executeUsFinancialKernelV5(t.deps, t.request());
    let view = await projectUsFinancialBookV5(await t.read());
    expect(view.settlements[0]).toMatchObject({ totalMinor: '32475', receivedMinor: '0', creditedMinor: '10825', outstandingMinor: '21650', status: 'partially_settled' });
    expect(view.credits[0].taxDisposition).toBe('adjustment_pending');
    const second = await executeUsFinancialKernelV5(t.deps, t.payment(first.revision));
    const third = await executeUsFinancialKernelV5(t.deps, { ...t.request('second-credit'), expectedRevision: second.revision });
    const fourth = await executeUsFinancialKernelV5(t.deps, t.payment(third.revision, '825', 'final-payment'));
    view = await projectUsFinancialBookV5(await t.read());
    expect(view.settlements[0]).toMatchObject({ totalMinor: '32475', receivedMinor: '10825', creditedMinor: '21650', outstandingMinor: '0', status: 'settled_with_credit' });
    expect(view.revision).toBe(fourth.revision); expect(view.credits).toHaveLength(2);
    expect(view.invoices[0].total.minorUnits).toBe('32475'); expect(view.invoices[0].payments).toHaveLength(2);
    expect(canonicalErpJson(t.baseline)).toBe(baselineJson);
    const range = { start: '2026-01-01', end: '2026-12-31' };
    expect(trialBalance(view.ledger, range.end).balanced).toBe(true);
    expect(balanceSheet(view.ledger, range.end)).toMatchObject({ balanced: true, assetsMinor: '10825', liabilitiesMinor: '825', unclosedEarningsMinor: '10000' });
    expect(profitAndLoss(view.ledger, range)).toMatchObject({ incomeMinor: '10000', profitMinor: '10000' });
    expect(cashFlow(view.ledger, range)).toMatchObject({ operatingMinor: '10825', closingMinor: '10825' });
    expect(t.resolveTax).toHaveBeenCalledTimes(2);
    expect(Object.keys(first).sort()).toEqual(['action', 'actorId', 'commandHash', 'entityId', 'idempotencyKey', 'revision']);
    expect(JSON.stringify(first)).not.toContain('testtxn');
  });
  it('does not treat a fully credited invoice as paid and does not create cash', async () => {
    const t = await fixture(); await executeUsFinancialKernelV5(t.deps, t.request('full', '3'));
    const view = await projectUsFinancialBookV5(await t.read());
    expect(view.settlements[0]).toMatchObject({ status: 'credited', receivedMinor: '0', creditedMinor: '32475', outstandingMinor: '0' });
    expect(cashFlow(view.ledger, { start: '2026-01-01', end: '2026-12-31' }).netChangeMinor).toBe('0');
    await expect(executeUsFinancialKernelV5(t.deps, t.payment(view.revision, '1'))).rejects.toBeInstanceOf(Error);
    expect((await t.read()).events).toHaveLength(1);
  });
  it('replays a lost response without resolving tax or posting again', async () => {
    const t = await fixture(), commit = vi.fn(async (input: Parameters<typeof t.store.commit>[0]) => { await t.store.commit(input); throw new ErpError('response_lost', 503); });
    await expect(executeUsFinancialKernelV5({ ...t.deps, store: { ...t.store, commit } }, t.request())).rejects.toMatchObject({ code: 'response_lost' });
    const receipt = await executeUsFinancialKernelV5(t.deps, t.request());
    expect(receipt.revision).toBe(t.book.revision + 1); expect((await t.read()).events).toHaveLength(1);
    expect(t.resolveTax).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1);
  });
  it('retains receipt replay when restoring a validated TEST book after later payments', async () => {
    const t = await fixture(), credit = t.request(), receipt = await executeUsFinancialKernelV5(t.deps, credit);
    await executeUsFinancialKernelV5(t.deps, t.payment(receipt.revision));
    const restored = await createInMemoryUsFinancialKernelStoreV5(await t.read(), t.policy, actor => actor);
    expect(await executeUsFinancialKernelV5({ ...t.deps, store: restored }, credit)).toEqual(receipt);
    expect(t.resolveTax).toHaveBeenCalledTimes(1);
  });
  it.each(['customer_credit', 'customer_payment'] as const)('CAS prevents concurrent %s from overwriting a credit', async kind => {
    const t = await fixture(), first = t.request('first', '3');
    const second = kind === 'customer_credit' ? t.request('other', '3') : t.payment(t.book.revision, '1');
    const results = await Promise.allSettled([executeUsFinancialKernelV5(t.deps, first), executeUsFinancialKernelV5(t.deps, second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const view = await projectUsFinancialBookV5(await t.read()); expect((await t.read()).events).toHaveLength(1);
    expect(BigInt(view.settlements[0].outstandingMinor)).toBeGreaterThanOrEqual(BigInt(0));
    expect(trialBalance(view.ledger, '2026-12-31').balanced).toBe(true);
  });
  it('rejects an idempotency key reused for another request or actor', async () => {
    const t = await fixture(), request = t.request(); await executeUsFinancialKernelV5(t.deps, request);
    await expect(executeUsFinancialKernelV5(t.deps, { ...request, command: { ...request.command, id: 'different-credit' } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const actor = { ...t.actor, userId: 'different-financial-user' };
    await expect(executeUsFinancialKernelV5({ ...t.deps, actor, revalidate: async () => ({ configuration: t.configuration, actor, policy: t.policy }) }, request)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await t.read()).events).toHaveLength(1);
  });
  it('binds the store historical receipt to its original actor as well', async () => {
    const t = await fixture(); let captured!: Parameters<typeof t.store.commit>[0];
    const commit = async (input: Parameters<typeof t.store.commit>[0]) => { captured = input; return t.store.commit(input); };
    await executeUsFinancialKernelV5({ ...t.deps, store: { ...t.store, commit } }, t.request());
    await expect(t.store.commit({ ...captured, actor: { ...captured.actor, userId: 'another-owner' } })).rejects.toMatchObject({ code: 'financial_actor_mismatch' });
    expect((await t.read()).events).toHaveLength(1);
  });
  it('checks living TEST authority again at the final CAS after asynchronous replay', async () => {
    const t = await fixture(); let authorizations = 0;
    const store = await createInMemoryUsFinancialKernelStoreV5(t.book, t.policy, actor => ++authorizations === 1 ? actor : { ...actor, managementEntitled: false });
    await expect(executeUsFinancialKernelV5({ ...t.deps, store }, t.request())).rejects.toMatchObject({ code: 'management_entitlement_required' });
    expect(authorizations).toBe(2); expect((await store.read(t.configuration.organizationId) as UsFinancialBookV5).events).toHaveLength(0);
  });
  it('does not rewrite promotion provenance while appending an otherwise valid financial event', async () => {
    const t = await fixture();
    const commit = async (input: Parameters<typeof t.store.commit>[0]) => t.store.commit({ ...input, book: { ...input.book, promotion: { ...input.book.promotion, actor: { ...input.book.promotion.actor, userId: 'different-historical-owner' } } } });
    await expect(executeUsFinancialKernelV5({ ...t.deps, store: { ...t.store, commit } }, t.request())).rejects.toMatchObject({ code: 'invalid_financial_commit' });
    expect((await t.read()).events).toHaveLength(0); expect((await t.read()).promotion.actor.userId).toBe(t.actor.userId);
  });
  it.each(['member', 'read_only'] as const)('denies %s before private reads, receipts and resolver', async role => {
    const t = await fixture(), read = vi.fn(t.store.read), receipt = vi.fn(t.store.receipt), commit = vi.fn(t.store.commit);
    await expect(executeUsFinancialKernelV5({ ...t.deps, actor: { ...t.actor, role }, store: { ...t.store, read, receipt, commit } }, t.request())).rejects.toMatchObject({ code: 'financial_permission_required' });
    expect(read).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(t.resolveTax).not.toHaveBeenCalled();
  });
  it('denies entitlement revocation after tax resolution without any financial commit', async () => {
    const t = await fixture(); let revoked = false;
    const revalidate = async () => ({ configuration: t.configuration, actor: { ...t.actor, managementEntitled: !revoked }, policy: t.policy });
    const resolveTax = async (input: Parameters<typeof t.resolveTax>[0]) => { const proof = await t.resolveTax(input); revoked = true; return proof; };
    await expect(executeUsFinancialKernelV5({ ...t.deps, revalidate, resolveTax }, t.request())).rejects.toMatchObject({ code: 'management_entitlement_required' });
    expect((await t.read()).events).toHaveLength(0);
  });
  it('prioritizes revocation even if asynchronous source validation itself fails', async () => {
    const t = await fixture(); let revoked = false, validating = false;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const read = async (org: string) => { const book = await t.store.read(org); validating = true; return book; };
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { if (validating) { revoked = true; throw new Error('Synthetic hashing failure'); } return digest(...args); });
    try {
      await expect(executeUsFinancialKernelV5({ ...t.deps, store: { ...t.store, read }, revalidate: async () => ({ configuration: t.configuration, actor: { ...t.actor, managementEntitled: !revoked }, policy: t.policy }) }, t.request())).rejects.toMatchObject({ code: 'management_entitlement_required' });
    } finally { spy.mockRestore(); }
    expect((await t.read()).events).toHaveLength(0); expect(t.resolveTax).not.toHaveBeenCalled();
  });
  it('revalidates authority on an exact historical receipt replay', async () => {
    const t = await fixture(), request = t.request(); await executeUsFinancialKernelV5(t.deps, request);
    await expect(executeUsFinancialKernelV5({ ...t.deps, revalidate: async () => ({ configuration: t.configuration, actor: { ...t.actor, role: 'read_only' }, policy: t.policy }) }, request)).rejects.toMatchObject({ code: 'financial_permission_required' });
    expect(t.resolveTax).toHaveBeenCalledTimes(1);
  });
  it('refuses a stale request before asking for tax authorization', async () => {
    const t = await fixture();
    await expect(executeUsFinancialKernelV5(t.deps, { ...t.request(), expectedRevision: t.book.revision + 1 })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(t.resolveTax).not.toHaveBeenCalled();
  });
  it('refuses a book changed while resolving tax; a concurrent payment survives', async () => {
    const t = await fixture();
    const resolveTax = async (input: Parameters<typeof t.resolveTax>[0]) => { const proof = await t.resolveTax(input); await executeUsFinancialKernelV5(t.deps, t.payment(t.book.revision)); return proof; };
    await expect(executeUsFinancialKernelV5({ ...t.deps, resolveTax }, t.request())).rejects.toMatchObject({ code: 'financial_source_changed' });
    expect((await t.read()).events).toHaveLength(1); expect((await t.read()).events[0].operation.type).toBe('customer_payment');
  });
  it('captures caller data before any asynchronous private read', async () => {
    const t = await fixture(), request = structuredClone(t.request());
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const original = t.store.receipt, receipt = async (...args: Parameters<typeof original>) => { await wait; return original(...args); };
    const pending = executeUsFinancialKernelV5({ ...t.deps, store: { ...t.store, receipt } }, request);
    (request.command as { reason: string }).reason = 'Mutation after call'; release();
    await pending; expect((await t.read()).events[0].operation).toMatchObject({ reason: 'Synthetic service correction' });
  });
  it('accepts advancing trusted timestamps without changing the execution audit identity', async () => {
    const t = await fixture(); let clock = 0;
    const revalidate = async () => ({ configuration: t.configuration, actor: { ...t.actor, timestamp: new Date(Date.parse(t.actor.timestamp) + (++clock) * 1000).toISOString() }, policy: t.policy });
    await executeUsFinancialKernelV5({ ...t.deps, revalidate }, t.request());
    const event = (await t.read()).events[0]; expect(event.posting.postedAt).toBe(event.actor.timestamp); expect(event.record).toMatchObject({ issuedAt: event.actor.timestamp });
  });
  it.each(['invoiceFingerprint', 'allocationSha256', 'authorizedTaxMinor'] as const)('refuses a tax authorization with mismatched %s', async field => {
    const t = await fixture(), resolveTax = async (input: Parameters<typeof t.resolveTax>[0]) => ({ ...await t.resolveTax(input), [field]: field === 'authorizedTaxMinor' ? '1' : '0'.repeat(64) }) as UsFinancialTaxProofV5;
    await expect(executeUsFinancialKernelV5({ ...t.deps, resolveTax }, t.request())).rejects.toBeInstanceOf(Error);
    expect((await t.read()).events).toHaveLength(0);
  });
  it('denies a changed policy or configuration before a commit', async () => {
    const t = await fixture();
    await expect(executeUsFinancialKernelV5({ ...t.deps, revalidate: async () => ({ configuration: t.configuration, actor: t.actor, policy: { ...t.policy, approval: { ...t.policy.approval, reference: 'changed-review' } } }) }, t.request())).rejects.toMatchObject({ code: 'financial_configuration_changed' });
    expect((await t.read()).events).toHaveLength(0);
  });
  it('does not forward a private adapter error or commit a failed authorization', async () => {
    const t = await fixture(), resolveTax = async () => { throw new Error('PRIVATE-provider-key-and-original-message'); };
    await expect(executeUsFinancialKernelV5({ ...t.deps, resolveTax }, t.request())).rejects.toMatchObject({ code: 'financial_service_unavailable', message: 'financial_service_unavailable', status: 503 });
    expect((await t.read()).events).toHaveLength(0);
  });
  it('rejects a forged/mismatched receipt response without leaking a different operation', async () => {
    const t = await fixture();
    await expect(executeUsFinancialKernelV5({ ...t.deps, store: { ...t.store, receipt: async () => ({ idempotencyKey: 'other', commandHash: '0'.repeat(64), revision: t.book.revision, entityId: 'other', action: 'customer_credit', actorId: t.actor.userId }) } }, t.request())).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(t.resolveTax).not.toHaveBeenCalled();
  });
  it('captures a private receipt before postflight authorization can mutate the adapter object', async () => {
    const t = await fixture(), request = t.request(), receipt = await executeUsFinancialKernelV5(t.deps, request);
    const mutable = { ...receipt, actorId: '' }; let returned = false;
    const revalidate = async () => { if (returned) mutable.actorId = t.actor.userId; return { configuration: t.configuration, actor: t.actor, policy: t.policy }; };
    await expect(executeUsFinancialKernelV5({ ...t.deps, revalidate, store: { ...t.store, receipt: async () => { returned = true; return mutable; } } }, request)).rejects.toMatchObject({ code: 'invalid_financial_receipt' });
    expect(mutable.actorId).toBe(t.actor.userId); expect((await t.read()).events).toHaveLength(1);
  });
  it('keeps another organization out of every memory adapter method', async () => {
    const t = await fixture();
    await expect(t.store.read('other-workspace')).rejects.toMatchObject({ code: 'tenant_mismatch' });
    await expect(t.store.receipt('other-workspace', 'key')).rejects.toMatchObject({ code: 'tenant_mismatch' });
    await expect(executeUsFinancialKernelV5({ ...t.deps, configuration: { ...t.configuration, organizationId: 'other-workspace' } }, t.request())).rejects.toMatchObject({ code: 'tenant_mismatch' });
  });
});

describe('financial runtime5 request boundary', () => {
  it.each(['taxProof', 'actor', 'policy', 'allocation', 'ledger', 'amountMinor'])('does not accept caller-injected credit %s', async field => {
    const t = await fixture(), request = t.request();
    expect(() => validateUsFinancialRequestV5({ ...request, command: { ...request.command, [field]: {} } })).toThrow(ErpError);
  });
  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER, '6'])('rejects invalid revision %s', async expectedRevision => {
    const t = await fixture(); expect(() => validateUsFinancialRequestV5({ ...t.request(), expectedRevision })).toThrow(ErpError);
  });
  it.each(['0', '-1', '01', '1.5', '1e2', '9'.repeat(37)])('rejects noncanonical payment %s', async amountMinor => {
    const t = await fixture(), request = t.payment(t.book.revision); expect(() => validateUsFinancialRequestV5({ ...request, command: { ...request.command, amountMinor } })).toThrow(ErpError);
  });
  it('refuses getters without invoking them', () => {
    const getter = vi.fn(() => 'fake'); const value = { get command() { return getter(); } };
    expect(() => validateUsFinancialRequestV5(value)).toThrow(ErpError); expect(getter).not.toHaveBeenCalled();
  });
});
