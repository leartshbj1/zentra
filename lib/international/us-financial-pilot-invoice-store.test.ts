import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { canonicalErpJson, ErpError } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import type { UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { createSupabaseUsFinancialPilotInvoiceStore } from './us-financial-pilot-invoice-store';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

async function fixture() {
  const data = await financialKernelFixture(), bound: UsFinancialPilotScope = { scope: { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 2 };
  const rpc = vi.fn(async (_name: string, _args: Readonly<Record<string, unknown>>): Promise<unknown> => null), fresh = vi.fn(async () => bound);
  return { bound, rpc, fresh, store: () => createSupabaseUsFinancialPilotInvoiceStore({ rpc }, bound, fresh) };
}

describe('pilot fiscal adapter private context boundary — synthetic RPC', () => {
  it.each([undefined, null, false, 0])('closes a falsey context rejection %s after renewing admission', async rejection => {
    const t = await fixture(); t.rpc.mockRejectedValue(rejection);
    await expect(t.store().context(t.bound.scope.actor)).rejects.toMatchObject({ code: 'financial_service_unavailable', status: 503 }); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('captures installation=%s and selects compatible context/read/preflight aliases without fallback', async sellerInstalled => {
    const t = await fixture(), options = { sellerInstalled }, store = createSupabaseUsFinancialPilotInvoiceStore({ rpc: t.rpc }, t.bound, t.fresh, options), suffix = sellerInstalled ? 'seller_v1' : 'v1';
    options.sellerInstalled = !sellerInstalled;
    const request: UsFinancialRequestV5 = { idempotencyKey: 'synthetic-invoice-alias', expectedRevision: 1, command: { type: 'erp_command', request: { type: 'issue_invoice', id: 'synthetic-invoice', estimateId: 'synthetic-quote', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' } } };
    const erp = { idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision, command: request.command.type === 'erp_command' ? request.command.request : null };
    const input = { request, financialCommandHash: await sha256Hex(canonicalErpJson([t.bound.scope.organizationId, t.bound.scope.actor.userId, request])), erpCommandHash: await sha256Hex(canonicalErpJson([t.bound.scope.organizationId, t.bound.scope.actor.userId, erp])) };
    await expect(store.context(t.bound.scope.actor)).rejects.toMatchObject({ status: 503 });
    expect(await store.read(t.bound.scope.actor, input)).toBeNull();
    await expect(store.preflight(t.bound.scope.actor, { ...input, previousBookFingerprint: 'a'.repeat(64) })).rejects.toMatchObject({ status: 503 });
    expect(t.rpc.mock.calls.map(([name]) => name)).toEqual([`zentra_us_financial_pilot_invoice_test_context_${suffix}`, `zentra_read_us_financial_pilot_invoice_test_operation_${suffix}`, `zentra_preflight_us_financial_pilot_invoice_test_${suffix}`]);
    for (const [, args] of t.rpc.mock.calls) expect(args).toMatchObject({ p_opt_in_version: 2, p_capability: 'postgres-test-financial-pilot-dto1' });
  });
  it('does not fall back to legacy after a missing installed context helper', async () => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(404, '42883', 'private missing function'));
    const store = createSupabaseUsFinancialPilotInvoiceStore({ rpc: t.rpc }, t.bound, t.fresh, { sellerInstalled: true });
    await expect(store.context(t.bound.scope.actor)).rejects.toMatchObject({ code: 'financial_service_unavailable', status: 503 });
    expect(t.rpc).toHaveBeenCalledOnce(); expect(t.rpc.mock.calls[0][0]).toBe('zentra_us_financial_pilot_invoice_test_context_seller_v1'); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
  it('captures the actor before revalidation and pins the pilot wrapper capability and opt-in', async () => {
    const t = await fixture(), actor = { ...t.bound.scope.actor }, original = { ...actor };
    t.fresh.mockImplementation(async () => { actor.userId = 'mutated-private-actor'; return t.bound; });
    await expect(t.store().context(actor)).rejects.toMatchObject({ status: 503 });
    expect(t.rpc).toHaveBeenCalledWith('zentra_us_financial_pilot_invoice_test_context_v1', { p_organization: t.bound.scope.organizationId, p_actor: original, p_grant_version: 1, p_opt_in_version: 2, p_capability: 'postgres-test-financial-pilot-dto1' });
  });
  it('rejects actor accessors before invoking them or any asynchronous private port', async () => {
    const t = await fixture(), getter = vi.fn(() => t.bound.scope.actor.userId), actor = Object.defineProperty({ ...t.bound.scope.actor }, 'userId', { enumerable: true, get: getter });
    await expect(t.store().context(actor)).rejects.toMatchObject({ status: 503 }); expect(getter).not.toHaveBeenCalled(); expect(t.fresh).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('lets live authority denial take precedence over a rejected private context call', async () => {
    const t = await fixture(); let revoked = false;
    t.rpc.mockImplementation(async () => { revoked = true; throw Error('PRIVATE rejected context'); });
    t.fresh.mockImplementation(async () => { if (revoked) throw new ErpError('session_changed', 401); return t.bound; });
    await expect(t.store().context(t.bound.scope.actor)).rejects.toMatchObject({ code: 'session_changed', status: 401 });
  });
  it.each(['grant', 'optIn', 'policy'] as const)('rejects a changed %s after the RPC even when its response is invalid', async field => {
    const t = await fixture(); let changed = false;
    t.rpc.mockImplementation(async () => { changed = true; return null; });
    t.fresh.mockImplementation(async () => changed ? { ...t.bound, optInVersion: field === 'optIn' ? 3 : 2, scope: { ...t.bound.scope, grantVersion: field === 'grant' ? 2 : 1, policy: field === 'policy' ? { ...t.bound.scope.policy, approval: { ...t.bound.scope.policy.approval, reference: 'Synthetic changed' } } : t.bound.scope.policy } } : t.bound);
    await expect(t.store().context(t.bound.scope.actor)).rejects.toMatchObject({ code: field === 'policy' ? 'financial_policy_unavailable' : 'financial_test_grant_changed', status: 409 });
  });
  it('rejects a reversed post-RPC observation clock', async () => {
    const t = await fixture(), newer = { ...t.bound, scope: { ...t.bound.scope, actor: { ...t.bound.scope.actor, timestamp: new Date(Date.parse(t.bound.scope.actor.timestamp) + 1000).toISOString() } } };
    t.fresh.mockResolvedValueOnce(newer).mockResolvedValue(t.bound);
    await expect(t.store().context(t.bound.scope.actor)).rejects.toMatchObject({ code: 'financial_clock_reversed', status: 409 });
  });
  it.each([['PF005', 'financial_test_grant_required', 403], ['PF006', 'financial_test_grant_changed', 409], ['PF007', 'financial_configuration_changed', 409], ['PF014', 'binding_unavailable', 409]] as const)('maps private SQL rejection %s to the bounded public fiscal error', async (code, mapped, status) => {
    const t = await fixture(); t.rpc.mockRejectedValue(new SupabaseServerError(409, code, 'PRIVATE synthetic denial'));
    await expect(t.store().context(t.bound.scope.actor)).rejects.toMatchObject({ code: mapped, status }); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
});
