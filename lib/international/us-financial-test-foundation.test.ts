import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import { applyUsFinancialOperationV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { createSupabaseUsFinancialTestFoundationV5, type UsFinancialPromotionReceiptV5, type UsFinancialTestScopeV5 } from './us-financial-test-foundation';

async function fixture() {
  const data = await financialKernelFixture();
  const book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const scope: UsFinancialTestScopeV5 = { organizationId: data.configuration.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 };
  const revalidate = vi.fn(async () => scope);
  const hash = await sha256Hex(canonicalErpJson([scope.organizationId, scope.actor.userId, {
    type: 'promote_financial_book', idempotencyKey: 'promote-1', baselineRevision: book.baseline.revision,
    baselineSha256: book.promotion.baselineSha256, policy: book.policy,
  }]));
  const receipt: UsFinancialPromotionReceiptV5 = {
    schemaVersion: 1, organizationId: scope.organizationId, idempotencyKey: 'promote-1', commandHash: hash,
    revision: book.revision, baselineRevision: book.baseline.revision, baselineSha256: book.promotion.baselineSha256,
    actorId: scope.actor.userId, action: 'promote_financial_book',
  };
  const promotion = { book, receipt, replayed: false };
  const legacy = { origin: 'legacy_erp4', actorId: 'synthetic-historical-member', receipt: { idempotencyKey: 'legacy-1', commandHash: '1'.repeat(64), revision: 2, entityId: 'customer-1', action: 'save_customer' } };
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'zentra_read_us_financial_test_v5') return book;
    if (name === 'zentra_us_financial_test_receipt_v5') return legacy;
    if (name === 'zentra_promote_us_financial_test_v5') return promotion;
    throw new Error('Unexpected private fixture RPC');
  });
  const adapter = createSupabaseUsFinancialTestFoundationV5({ rpc }, scope, revalidate);
  return { ...data, book, scope, revalidate, receipt, promotion, legacy, rpc, adapter };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('private PostgreSQL TEST financial foundation adapter — not an append runtime', () => {
  it('has a distinct capability and no append/commit/public ERP version', async () => {
    const t = await fixture();
    expect(t.adapter.capability).toBe('postgres-test-foundation-v5');
    expect(Object.keys(t.adapter).sort()).toEqual(['capability', 'promote', 'read', 'receipt']);
    expect(Object.isFrozen(t.adapter)).toBe(true);
  });
  it('reads and fully reconstructs a detached baseline book using the private RPC', async () => {
    const t = await fixture(), result = await t.adapter.read();
    expect(result).toEqual(t.book); expect(result).not.toBe(t.book);
    expect(t.rpc).toHaveBeenCalledWith('zentra_read_us_financial_test_v5', {
      p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-foundation-v5',
    });
    expect(t.revalidate).toHaveBeenCalledTimes(2);
  });
  it('accepts only null as an absent book/receipt', async () => {
    const t = await fixture(); t.rpc.mockResolvedValue(null);
    expect(await t.adapter.read()).toBeNull(); expect(await t.adapter.receipt('missing')).toBeNull();
  });
  it.each([undefined, false, 0, '', [], {}])('refuses a malformed private read: %s', async value => {
    const t = await fixture(); t.rpc.mockResolvedValue(value);
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'invalid_financial_private_data', status: 503 });
  });
  it('does not trust a balanced/hash-shaped book with corrupted financial sources', async () => {
    const t = await fixture(), corrupted = clone(t.book);
    (corrupted.baseline.invoices[0].total as { minorUnits: string }).minorUnits = '1';
    t.rpc.mockResolvedValue(corrupted);
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('does not accept events from a future append implementation under this capability', async () => {
    const t = await fixture();
    const { book } = await applyUsFinancialOperationV5(t.book, { type: 'customer_payment', idempotencyKey: 'synthetic-payment', invoiceId: 'invoice-1', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic-only' }, t.actor, 'payment-1');
    t.rpc.mockResolvedValue(book);
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
    t.rpc.mockClear();
    await expect(t.adapter.promote({ book, idempotencyKey: 'promote-1' })).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('promotes an exact caller-captured book with a deterministic request hash', async () => {
    const t = await fixture(), result = await t.adapter.promote({ book: t.book, idempotencyKey: 'promote-1' });
    expect(result).toEqual(t.promotion); expect(result.receipt).not.toBe(t.receipt);
    expect(t.rpc).toHaveBeenCalledWith('zentra_promote_us_financial_test_v5', {
      p_organization: t.scope.organizationId, p_actor: t.actor, p_grant_version: 1, p_capability: 'postgres-test-foundation-v5',
      p_book: t.book, p_idempotency_key: 'promote-1', p_command_hash: t.receipt.commandHash,
    });
  });
  it('preserves the original promotion receipt/provenance on an exact replay', async () => {
    const t = await fixture(); t.rpc.mockResolvedValue({ ...t.promotion, replayed: true });
    t.revalidate.mockResolvedValue({ ...t.scope, actor: { ...t.actor, timestamp: '2026-10-10T12:01:00.000Z' } });
    expect(await t.adapter.promote({ book: t.book, idempotencyKey: 'promote-1' })).toEqual({ ...t.promotion, replayed: true });
    expect(t.rpc.mock.calls[0][1].p_actor).toEqual(t.actor);
  });
  it.each([
    { actorId: 'different-user' }, { commandHash: '2'.repeat(64) }, { revision: 900 }, { baselineRevision: 900 },
    { baselineSha256: '2'.repeat(64) }, { organizationId: 'another-org' }, { idempotencyKey: 'another-key' },
    { action: 'customer_credit' }, { schemaVersion: 5 }, { unexpected: true },
  ])('rejects a mismatched promotion receipt %j', async mutation => {
    const t = await fixture(); t.rpc.mockResolvedValue({ ...t.promotion, receipt: { ...t.receipt, ...mutation } });
    await expect(t.adapter.promote({ book: t.book, idempotencyKey: 'promote-1' })).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('refuses a different but internally valid retained book', async () => {
    const t = await fixture(), baseline = clone(t.baseline);
    (baseline.customers[0] as { name: string }).name = 'Another synthetic customer label';
    const other = await promoteUsFinancialBookV5(baseline, t.policy, t.actor);
    t.rpc.mockResolvedValue({ ...t.promotion, book: other });
    await expect(t.adapter.promote({ book: t.book, idempotencyKey: 'promote-1' })).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it.each(['false', null, undefined])('does not coerce a malformed replay flag %s', async replayed => {
    const t = await fixture(); t.rpc.mockResolvedValue({ ...t.promotion, replayed });
    await expect(t.adapter.promote({ book: t.book, idempotencyKey: 'promote-1' })).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('reads a preserved legacy receipt without rewriting its actor/action', async () => {
    const t = await fixture(), result = await t.adapter.receipt('legacy-1');
    expect(result).toEqual(t.legacy); expect(result?.receipt).not.toBe(t.legacy.receipt);
    expect(t.rpc.mock.calls[0][0]).toBe('zentra_us_financial_test_receipt_v5');
  });
  it('retains the older 232-character key namespace while new promotion keys are capped at 200', async () => {
    const t = await fixture(), legacyKey = 'a'.repeat(232);
    t.rpc.mockResolvedValueOnce({ ...t.legacy, receipt: { ...t.legacy.receipt, idempotencyKey: legacyKey } });
    expect((await t.adapter.receipt(legacyKey))?.receipt.idempotencyKey).toBe(legacyKey);
    t.rpc.mockClear();
    await expect(t.adapter.promote({ book: t.book, idempotencyKey: 'a'.repeat(201) })).rejects.toMatchObject({ code: 'invalid_financial_request' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('binds a promotion envelope actor to its validated receipt', async () => {
    const t = await fixture(); t.rpc.mockResolvedValueOnce({ origin: 'promotion', actorId: t.actor.userId, receipt: t.receipt });
    expect(await t.adapter.receipt('promote-1')).toEqual({ origin: 'promotion', actorId: t.actor.userId, receipt: t.receipt });
    t.rpc.mockResolvedValue({ origin: 'promotion', actorId: 'other', receipt: t.receipt });
    await expect(t.adapter.receipt('promote-1')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it.each([{ commandHash: 'f'.repeat(64) }, { baselineSha256: 'f'.repeat(64) }, { actorId: 'different-owner' }])('corroborates a shape-valid promotion receipt with its canonical book %j', async mutation => {
    const t = await fixture(), receipt = { ...t.receipt, ...mutation };
    t.rpc.mockResolvedValueOnce({ origin: 'promotion', actorId: receipt.actorId, receipt });
    await expect(t.adapter.receipt('promote-1')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('rejects a legacy receipt newer than the immutable baseline', async () => {
    const t = await fixture(); t.rpc.mockResolvedValueOnce({ ...t.legacy, receipt: { ...t.legacy.receipt, revision: t.book.revision } });
    await expect(t.adapter.receipt('legacy-1')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('refuses an indexed receipt when the actual book is missing', async () => {
    const t = await fixture(); t.rpc.mockResolvedValueOnce(t.legacy).mockResolvedValueOnce(null);
    await expect(t.adapter.receipt('legacy-1')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('makes revocation win over a corrupt receipt after asynchronous corroboration', async () => {
    const t = await fixture(), receipt = { ...t.receipt, commandHash: 'f'.repeat(64) };
    t.rpc.mockResolvedValueOnce({ origin: 'promotion', actorId: receipt.actorId, receipt });
    let calls = 0;
    t.revalidate.mockImplementation(async () => ++calls < 5 ? t.scope : { ...t.scope, grantVersion: 2 });
    await expect(t.adapter.receipt('promote-1')).rejects.toMatchObject({ code: 'financial_test_grant_changed' });
    expect(calls).toBe(5);
  });
  it.each([
    { origin: 'financial_v5', actorId: 'actor', receipt: {} },
    { origin: 'legacy_erp4', actorId: '', receipt: {} },
    { origin: 'legacy_erp4', actorId: 'actor', receipt: null },
    { origin: 'promotion', actorId: 'actor', receipt: {} },
  ])('refuses unknown/currently unavailable/malformed receipt envelopes %j', async value => {
    const t = await fixture(); t.rpc.mockResolvedValue(value);
    await expect(t.adapter.receipt('legacy-1')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it('rejects a legacy receipt belonging to another idempotency key', async () => {
    const t = await fixture();
    await expect(t.adapter.receipt('different')).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
  });
  it.each(['member', 'read_only'] as const)('denies %s before any private database call', async role => {
    const t = await fixture();
    expect(() => createSupabaseUsFinancialTestFoundationV5({ rpc: t.rpc }, { ...t.scope, actor: { ...t.actor, role } }, t.revalidate)).toThrowError('financial_permission_required');
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('normalizes a JSON object role without invoking object coercion', async () => {
    const t = await fixture(), malformed = { ...t.scope, actor: { ...t.actor, role: {} } } as unknown as UsFinancialTestScopeV5;
    expect(() => createSupabaseUsFinancialTestFoundationV5({ rpc: t.rpc }, malformed, t.revalidate)).toThrowError('financial_permission_required');
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['admin', 'accountant'] as const)('permits an authorized %s read but not promotion', async role => {
    const t = await fixture(), scope = { ...t.scope, actor: { ...t.actor, role } };
    const adapter = createSupabaseUsFinancialTestFoundationV5({ rpc: t.rpc }, scope, async () => scope);
    expect(await adapter.read()).toEqual(t.book); t.rpc.mockClear();
    await expect(adapter.promote({ book: t.book, idempotencyKey: 'promote-1' })).rejects.toMatchObject({ code: 'owner_required' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('does not derive permission from approval text in the stored policy', async () => {
    const t = await fixture(); t.revalidate.mockResolvedValue({ ...t.scope, actor: { ...t.actor, managementEntitled: false } });
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'management_entitlement_required' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['financial_test_grant_changed', (s: UsFinancialTestScopeV5) => ({ ...s, grantVersion: 2 })],
    ['financial_authority_changed', (s: UsFinancialTestScopeV5) => ({ ...s, actor: { ...s.actor, userId: 'other-owner' } })],
    ['financial_authority_changed', (s: UsFinancialTestScopeV5) => ({ ...s, actor: { ...s.actor, role: 'admin' as const } })],
    ['financial_policy_unavailable', (s: UsFinancialTestScopeV5) => ({ ...s, policy: { ...s.policy, approval: { ...s.policy.approval, reference: 'different-policy' } } })],
  ] as const)('denies changed authority before RPC: %s', async (code, change) => {
    const t = await fixture(); t.revalidate.mockResolvedValue(change(t.scope));
    await expect(t.adapter.read()).rejects.toMatchObject({ code }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('does not release data after grant revocation while the RPC is running', async () => {
    const t = await fixture(); t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue({ ...t.scope, grantVersion: 2 });
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'financial_test_grant_changed' });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it('makes postflight revocation take precedence over a malformed or failed private RPC', async () => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(503, 'PF001'));
    t.revalidate.mockResolvedValueOnce(t.scope).mockResolvedValue({ ...t.scope, actor: { ...t.actor, managementEntitled: false } });
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'management_entitlement_required' });
  });
  it('captures the RPC result before the asynchronous postflight can mutate the source', async () => {
    const t = await fixture(), raw = clone(t.book); t.rpc.mockResolvedValue(raw);
    t.revalidate.mockResolvedValueOnce(t.scope).mockImplementation(async () => {
      (raw.promotion as { baselineSha256: string }).baselineSha256 = 'f'.repeat(64); return t.scope;
    });
    expect((await t.adapter.read())?.promotion.baselineSha256).toBe(t.book.promotion.baselineSha256);
  });
  it('captures constructor options and the promotion candidate before its first await', async () => {
    const t = await fixture(), mutableScope = clone(t.scope), input = { book: clone(t.book), idempotencyKey: 'promote-1' };
    const adapter = createSupabaseUsFinancialTestFoundationV5({ rpc: t.rpc }, mutableScope, async () => t.scope);
    (mutableScope as { grantVersion: number }).grantVersion = 999;
    const pending = adapter.promote(input); input.idempotencyKey = 'mutated';
    (input.book.promotion as { baselineSha256: string }).baselineSha256 = 'f'.repeat(64);
    expect((await pending).receipt).toEqual(t.receipt);
    expect(t.rpc.mock.calls[0][1].p_grant_version).toBe(1);
  });
  it('does not invoke getters in caller input or database results', async () => {
    const t = await fixture(), getter = vi.fn(() => t.book);
    const input = { get book() { return getter(); }, idempotencyKey: 'promote-1' };
    await expect(t.adapter.promote(input)).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
    t.rpc.mockResolvedValue({ get schemaVersion() { getter(); return 5; } });
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    ['PF001', 'revision_conflict', 409], ['PF002', 'idempotency_conflict', 409], ['PF003', 'financial_immutable', 409],
    ['PF004', 'invalid_financial_private_data', 503], ['PF005', 'financial_test_grant_required', 403], ['PF006', 'financial_test_grant_changed', 409],
    ['PF007', 'financial_configuration_changed', 409], ['PF008', 'financial_upgrade_required', 409], ['PF009', 'financial_capability_unavailable', 503],
    ['PF010', 'financial_append_unavailable', 409], ['PF011', 'financial_policy_unavailable', 409], ['PF012', 'financial_book_too_large', 413],
  ])('maps only the known SQL failure %s', async (sql, code, status) => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(500, sql));
    await expect(t.adapter.read()).rejects.toMatchObject({ code, status }); expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('synthetic-private-secret-do-not-expose'), new SupabaseServerError(503, 'PF999'), { code: 'PF001', message: 'synthetic-private-secret' }])('sanitizes an unknown infrastructure failure without retrying', async error => {
    const t = await fixture(); t.rpc.mockRejectedValue(error);
    await expect(t.adapter.read()).rejects.toMatchObject({ code: 'financial_service_unavailable', message: 'financial_service_unavailable', status: 503 });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it('does not automatically repeat promotion after an ambiguous timeout', async () => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(504, 'timeout'));
    await expect(t.adapter.promote({ book: t.book, idempotencyKey: 'promote-1' })).rejects.toMatchObject({ code: 'financial_service_unavailable' });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
});
