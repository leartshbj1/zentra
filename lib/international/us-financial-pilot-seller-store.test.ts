import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { buildUsFinancialPilotSellerProof, type UsFinancialPilotSellerRead, type UsFinancialPilotSellerRequest } from './us-financial-pilot-seller';
import { createSupabaseUsFinancialPilotSellerStore } from './us-financial-pilot-seller-store';

async function fixture() {
  const data = await financialKernelFixture(), scope = { scope: { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const read: UsFinancialPilotSellerRead = { head: { consumer: 'financial-pilot', schemaVersion: 1, organizationId: data.actor.organizationId, revision: 4, bankRevision: 2, sellerRevision: 7 }, presentation: {
    origin: 'legacy-frozen', baseSellerRevision: 7, sellerRevision: 7, changeCount: 0, profile: { displayName: 'Synthetic original' }, updatedBy: data.actor.userId, updatedAt: data.actor.timestamp, changeSha256: null } };
  const request: UsFinancialPilotSellerRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: 'abcdef00-0000-4000-8000-000000000001', expectedRevision: 4, expectedSellerRevision: 7,
    command: { type: 'update_seller_presentation', displayName: 'Synthetic changed', contactEmail: null, contactPhone: null } };
  const proof = await buildUsFinancialPilotSellerProof(read, request, data.actor);
  const rpc = vi.fn(async (name: string, _args: Readonly<Record<string, unknown>>): Promise<unknown> => name.includes('head') ? read.head : name.includes('receipt') ? null : name.includes('append') ? proof : read);
  const fresh = vi.fn(async () => scope), client = { rpc }, store = createSupabaseUsFinancialPilotSellerStore(client, scope, fresh);
  return { data, scope, read, request, proof, rpc, fresh, client, store };
}
describe('seller private RPC store and renewed scope', () => {
  it('uses four exact point RPCs and captures composite observations without history arrays', async () => {
    const t = await fixture(); expect(await t.store.head()).toEqual(t.read.head); expect(await t.store.read()).toEqual(t.read); expect(await t.store.receipt(t.request.requestId)).toBeNull();
    expect(await t.store.append({ request: t.request, proof: t.proof })).toEqual(t.proof);
    expect(t.rpc.mock.calls.map(call => call[0])).toEqual(['zentra_us_financial_pilot_seller_test_head_v1', 'zentra_read_us_financial_pilot_seller_test_v1', 'zentra_us_financial_pilot_seller_test_receipt_v1', 'zentra_append_us_financial_pilot_seller_test_v1']);
    expect(t.rpc.mock.calls[3][1]).toEqual({ p_organization: t.scope.scope.organizationId, p_actor: t.proof.actor, p_grant_version: 1, p_opt_in_version: 1, p_capability: 'postgres-test-financial-pilot-dto1', p_request: t.request, p_proof: t.proof }); expect(t.fresh).toHaveBeenCalledTimes(8);
  });
  it('accepts only an exact same-user historical proof without adopting its old sourceF as current', async () => {
    const t = await fixture(); t.rpc.mockResolvedValueOnce(t.proof); expect(await t.store.receipt(t.request.requestId)).toEqual(t.proof); expect(t.fresh).toHaveBeenCalledTimes(2);
    const foreign = { ...t.proof, actor: { ...t.proof.actor, userId: 'different' } }; t.rpc.mockResolvedValueOnce(foreign); await expect(t.store.receipt(t.request.requestId)).rejects.toMatchObject({ status: 503 });
  });
  it('captures append facts and rpc method before the first hash or admission await', async () => {
    const t = await fixture(), value = structuredClone({ request: t.request, proof: t.proof });
    const pending = t.store.append(value); Object.assign(value.request.command, { displayName: 'Changed' }); Object.assign(value.proof.after, { displayName: 'Changed' });
    t.client.rpc = vi.fn(async () => { throw new Error('Swapped'); }); expect(await pending).toEqual(t.proof); expect(t.rpc).toHaveBeenCalledOnce();
  });
  it.each(['grant', 'optin', 'policy', 'user', 'role', 'clock'] as const)('rejects %s drift before RPC', async kind => {
    const t = await fixture(), changed = structuredClone(t.scope);
    if (kind === 'grant') changed.scope.grantVersion++; else if (kind === 'optin') changed.optInVersion++; else if (kind === 'policy') Object.assign(changed.scope.policy.approval, { reference: 'different' });
    else if (kind === 'user') Object.assign(changed.scope.actor, { userId: 'different' }); else if (kind === 'role') Object.assign(changed.scope.actor, { role: 'admin' }); else Object.assign(changed.scope.actor, { timestamp: '2000-01-01T00:00:00.000Z' });
    t.fresh.mockResolvedValueOnce(changed); await expect(t.store.head()).rejects.toBeInstanceOf(ErpError); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['success', 'rejection', 'malformed'] as const)('renews admission after RPC %s before publishing anything', async kind => {
    const t = await fixture(); if (kind === 'rejection') t.rpc.mockRejectedValueOnce(new SupabaseServerError(503, 'SQ007')); if (kind === 'malformed') t.rpc.mockResolvedValueOnce({ private: 'secret' });
    t.fresh.mockResolvedValueOnce(t.scope).mockRejectedValueOnce(new ErpError('financial_test_grant_required', 403));
    await expect(t.store.head()).rejects.toMatchObject({ code: 'financial_test_grant_required', status: 403 }); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
  it.each(['SQ001', 'SQ002', 'SQ003', 'SQ004', 'SQ005', 'SQ006', 'SQ007', 'PF005'] as const)('maps only SQL code %s without provider text', async code => {
    const t = await fixture(); t.rpc.mockRejectedValueOnce(new SupabaseServerError(503, code, 'PRIVATE RESOURCE'));
    await expect(t.store.head()).rejects.toMatchObject({ status: code === 'SQ004' ? 503 : code === 'PF005' ? 403 : 409 });
  });
  it('refuses getter data and unknown error accessors without running or exposing them', async () => {
    const t = await fixture(), getter = vi.fn(() => 'PRIVATE'), raw = Object.defineProperty({}, 'head', { enumerable: true, get: getter }); t.rpc.mockResolvedValueOnce(raw);
    await expect(t.store.read()).rejects.toMatchObject({ status: 503 }); expect(getter).not.toHaveBeenCalled();
    const error = new SupabaseServerError(503, 'UNKNOWN'); Object.defineProperty(error, 'code', { get: getter }); t.rpc.mockRejectedValueOnce(error);
    await expect(t.store.head()).rejects.toMatchObject({ code: 'financial_service_unavailable', status: 503 }); expect(getter).not.toHaveBeenCalled();
    t.rpc.mockRejectedValueOnce(new Proxy(error, { getPrototypeOf() { throw new Error('PRIVATE PROXY'); } }));
    await expect(t.store.head()).rejects.toMatchObject({ code: 'financial_service_unavailable', status: 503 });
    expect(() => createSupabaseUsFinancialPilotSellerStore(Object.defineProperty({}, 'rpc', { get: getter }) as typeof t.client, t.scope, t.fresh)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
