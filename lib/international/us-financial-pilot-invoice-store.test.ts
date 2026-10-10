import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { createSupabaseUsFinancialPilotInvoiceStore } from './us-financial-pilot-invoice-store';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

async function fixture() {
  const data = await financialKernelFixture(), bound: UsFinancialPilotScope = { scope: { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 2 };
  const rpc = vi.fn(async (_name: string, _args: Readonly<Record<string, unknown>>): Promise<unknown> => null), fresh = vi.fn(async () => bound);
  return { bound, rpc, fresh, store: () => createSupabaseUsFinancialPilotInvoiceStore({ rpc }, bound, fresh) };
}

describe('pilot fiscal adapter private context boundary — synthetic RPC', () => {
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
