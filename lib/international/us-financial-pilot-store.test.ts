import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5 } from './us-financial-kernel';
import { executeUsFinancialKernelV5, type UsFinancialReceiptV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { captureUsFinancialPilotScope, createSupabaseUsFinancialPilotStore, readUsFinancialPilotPromotionStatus, readUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';

// Real financial replay and private adapters, synthetic RPC only. PostgreSQL
// locks/ACL/durability and Auth/D1 are covered separately, not claimed here.
const scopeRpc = 'zentra_us_financial_pilot_test_scope_v1';
const headRpc = 'zentra_us_financial_pilot_test_head_v1';
const readRpc = 'zentra_read_us_financial_pilot_test_v1';
const receiptRpc = 'zentra_us_financial_pilot_test_receipt_v1';
const appendRpc = 'zentra_append_us_financial_pilot_test_v1';
const capability = 'postgres-test-financial-pilot-dto1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function fixture() {
  const data = await financialKernelFixture(), initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const scope: UsFinancialPilotScope = { scope: { organizationId: data.actor.organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 2 };
  const state = { book: initial, scope, receipts: new Map<string, unknown>() };
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (name === scopeRpc) return state.scope;
    if (name === headRpc) return { consumer: 'financial-pilot', schemaVersion: 1, organizationId: data.actor.organizationId, revision: state.book.revision };
    if (name === readRpc) return state.book;
    if (name === receiptRpc) return state.receipts.get(args.p_idempotency_key as string) ?? null;
    if (name === appendRpc) {
      state.book = args.p_book as UsFinancialBookV5;
      const receipt = args.p_receipt as UsFinancialReceiptV5;
      state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: receipt.actorId, receipt });
      return receipt;
    }
    throw Error('Unexpected synthetic pilot RPC');
  });
  const revalidate = vi.fn(async () => state.scope);
  const store = createSupabaseUsFinancialPilotStore({ rpc }, scope, revalidate);
  const deps = { ...data, store, revalidate: async () => ({ configuration: data.configuration, actor: state.scope.scope.actor, policy: state.scope.scope.policy }),
    resolveTax: async (): Promise<never> => { throw Error('Unexpected synthetic tax authorization'); }, resolveIssuance: async (): Promise<never> => { throw Error('Unexpected synthetic issuance'); } };
  const request: UsFinancialRequestV5 = { idempotencyKey: 'synthetic-pilot-payment', expectedRevision: initial.revision, command: { type: 'customer_payment', id: 'synthetic-pilot-payment', invoiceId: 'invoice-1', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'SYNTHETIC ONLY — no transfer' } };
  return { ...data, initial, scope, state, rpc, revalidate, store, deps, request };
}

describe('private financial-pilot DTO1 store — synthetic RPC', () => {
  it('captures initial scope from DB and pins both expected versions on revalidation', async () => {
    const f = await fixture();
    expect(await readUsFinancialPilotScope({ rpc: f.rpc }, f.actor)).toEqual(f.scope);
    expect(f.rpc.mock.calls.at(-1)).toEqual([scopeRpc, { p_organization: f.actor.organizationId, p_actor: f.actor, p_capability: capability, p_expected_grant_version: null, p_expected_opt_in_version: null }]);
    expect(await readUsFinancialPilotScope({ rpc: f.rpc }, f.actor, f.scope)).toEqual(f.scope);
    expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_expected_grant_version: 1, p_expected_opt_in_version: 2 });
  });
  it('detaches and deeply freezes scope, never retains mutable caller policy or actor', async () => {
    const f = await fixture(), input = clone(f.scope), result = captureUsFinancialPilotScope(input);
    Object.assign(input.scope.policy, { approval: { ...input.scope.policy.approval, reference: 'mutated' } });
    expect(result).toEqual(f.scope); expect(Object.isFrozen(result.scope.policy.approval)).toBe(true);
    const mutable = clone(f.scope), store = createSupabaseUsFinancialPilotStore({ rpc: f.rpc }, mutable, f.revalidate);
    Object.assign(mutable, { optInVersion: 99 });
    expect(await store.head()).toMatchObject({ revision: f.initial.revision });
    expect(f.rpc.mock.calls.at(-1)?.[1].p_opt_in_version).toBe(2);
  });
  it.each(['extra', 'getter', 'prototype', 'array', 'version', 'policy'] as const)('rejects malformed private scope: %s', async kind => {
    const f = await fixture(); let value: unknown = clone(f.scope);
    if (kind === 'extra') value = { ...f.scope, secret: 'not a DTO' };
    if (kind === 'getter') value = Object.defineProperty({ scope: f.scope.scope }, 'optInVersion', { get() { throw Error('Never invoke getter'); }, enumerable: true });
    if (kind === 'prototype') value = Object.assign(Object.create({ hidden: true }), f.scope);
    if (kind === 'array') value = [f.scope];
    if (kind === 'version') value = { ...f.scope, optInVersion: Number.MAX_SAFE_INTEGER };
    if (kind === 'policy') value = { ...f.scope, scope: { ...f.scope.scope, policy: { ...f.policy, environment: 'live' } } };
    expect(() => captureUsFinancialPilotScope(value)).toThrow();
  });
  it.each(['actor', 'tenant', 'grant', 'optin', 'policy'] as const)('rejects a changed DB scope: %s', async kind => {
    const f = await fixture(), changed = clone(f.scope);
    const value = kind === 'actor' ? { ...changed, scope: { ...changed.scope, actor: { ...f.actor, userId: 'different-owner' } } }
      : kind === 'tenant' ? { ...changed, scope: { ...changed.scope, organizationId: 'different-org', actor: { ...f.actor, organizationId: 'different-org' } } }
      : kind === 'grant' ? { ...changed, scope: { ...changed.scope, grantVersion: 2 } }
      : kind === 'optin' ? { ...changed, optInVersion: 3 }
      : { ...changed, scope: { ...changed.scope, policy: { ...f.policy, approval: { ...f.policy.approval, reference: 'changed-policy' } } } };
    f.rpc.mockResolvedValue(value);
    await expect(readUsFinancialPilotScope({ rpc: f.rpc }, f.actor, f.scope)).rejects.toBeInstanceOf(ErpError);
  });
  it('rejects non-financial role or false entitlement before any RPC', async () => {
    const f = await fixture();
    await expect(readUsFinancialPilotScope({ rpc: f.rpc }, { ...f.actor, role: 'member' })).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 });
    await expect(readUsFinancialPilotScope({ rpc: f.rpc }, { ...f.actor, managementEntitled: false })).rejects.toMatchObject({ code: 'management_entitlement_required', status: 402 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('head performs only the bounded head RPC, never reads/replays the book', async () => {
    const f = await fixture(), result = await f.store.head();
    expect(result).toEqual({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: f.actor.organizationId, revision: f.initial.revision });
    expect(Object.isFrozen(result)).toBe(true); expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual([headRpc]);
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_grant_version: 1, p_opt_in_version: 2, p_capability: capability });
  });
  it.each([{ revision: 0 }, { revision: '2' }, { revision: Number.MAX_SAFE_INTEGER }, { consumer: 'erp' }, { organizationId: 'foreign' }, { ledgerRevision: 10 }, { baseline: 'private' }])('rejects an untrusted head alteration %j', async fields => {
    const f = await fixture();
    f.rpc.mockResolvedValue({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: f.actor.organizationId, revision: f.initial.revision, ...fields });
    await expect(f.store.head()).rejects.toMatchObject({ code: 'invalid_financial_private_data', status: 503 });
  });
  it('wraps every book operation in its fixed atomic-pilot RPC while retaining real engine validation', async () => {
    const f = await fixture();
    expect(f.store.capability).toBe('postgres-test-invoicing-v5'); expect(Object.isFrozen(f.store)).toBe(true);
    expect(await f.store.read(f.actor.organizationId)).toEqual(f.initial);
    const receipt = await executeUsFinancialKernelV5(f.deps, f.request);
    expect(receipt.action).toBe('customer_payment'); expect(await f.store.receipt(f.actor.organizationId, f.request.idempotencyKey)).toEqual(receipt);
    expect(await executeUsFinancialKernelV5(f.deps, f.request)).toEqual(receipt);
    expect(f.rpc.mock.calls.filter(([name]) => name === appendRpc)).toHaveLength(1);
    expect(new Set(f.rpc.mock.calls.map(([name]) => name))).toEqual(new Set([readRpc, receiptRpc, appendRpc]));
    for (const [, args] of f.rpc.mock.calls) expect(args).toMatchObject({ p_grant_version: 1, p_opt_in_version: 2, p_capability: capability });
  });
  it('never publishes a slow head or failed read after an authority change', async () => {
    const f = await fixture();
    f.rpc.mockImplementation(async () => { f.state.scope = { ...f.scope, scope: { ...f.scope.scope, actor: { ...f.actor, userId: 'changed' } } }; throw Error('private upstream text'); });
    await expect(f.store.head()).rejects.toMatchObject({ code: 'financial_authority_changed', status: 403 });
    const g = await fixture();
    g.rpc.mockImplementation(async () => { g.state.scope = { ...g.scope, optInVersion: 3 }; return g.initial; });
    await expect(g.store.read(g.actor.organizationId)).rejects.toMatchObject({ code: 'financial_test_grant_changed', status: 409 });
  });
  it('rejects clock reversal and changed policy before private I/O', async () => {
    const f = await fixture();
    f.state.scope = { ...f.scope, scope: { ...f.scope.scope, actor: { ...f.actor, timestamp: '2026-10-10T11:59:59.999Z' } } };
    await expect(f.store.head()).rejects.toMatchObject({ code: 'financial_clock_reversed' }); expect(f.rpc).not.toHaveBeenCalled();
    const g = await fixture(); g.state.scope = { ...g.scope, scope: { ...g.scope.scope, policy: { ...g.policy, approval: { ...g.policy.approval, reference: 'different' } } } };
    await expect(g.store.read(g.actor.organizationId)).rejects.toMatchObject({ code: 'financial_policy_unavailable' }); expect(g.rpc).not.toHaveBeenCalled();
  });
  it.each([['PF005', 'financial_test_grant_required', 403], ['PF006', 'financial_test_grant_changed', 409], ['PF009', 'financial_capability_unavailable', 503], ['PF016', 'financial_clock_reversed', 409], ['XX999', 'financial_service_unavailable', 503]] as const)('maps %s without leaking DB messages', async (sqlCode, code, status) => {
    const f = await fixture(); f.rpc.mockRejectedValue(new SupabaseServerError(500, sqlCode, 'PRIVATE_EIN_PROOF_SECRET'));
    await expect(f.store.head()).rejects.toMatchObject({ code, status, message: code });
  });
  it('privately probes promotion by filtered marker only and never interprets an outage as unpromoted', async () => {
    const select = vi.fn(async (): Promise<unknown[]> => []), org = 'synthetic-org';
    const client = { select } as unknown as Pick<SupabaseServerClient, 'select'>;
    expect(await readUsFinancialPilotPromotionStatus(client, org)).toBe(false);
    select.mockResolvedValue([{ organization_id: org }]); expect(await readUsFinancialPilotPromotionStatus(client, org)).toBe(true);
    expect(select.mock.calls.at(-1)).toEqual(['zentra_us_financial_test_heads', { select: 'organization_id', organization_id: `eq.${org}`, limit: 1 }]);
    for (const value of [[{ organization_id: 'foreign' }], [{ organization_id: org, baseline: 'private' }], [{ organization_id: org }, { organization_id: org }]]) {
      select.mockResolvedValue(value); await expect(readUsFinancialPilotPromotionStatus(client, org)).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
    }
    select.mockRejectedValue(new SupabaseServerError(503, 'outage', 'private')); await expect(readUsFinancialPilotPromotionStatus(client, org)).rejects.toMatchObject({ code: 'financial_service_unavailable' });
  });
  it('rejects an invalid marker tenant or corrupt book before it can reach a consumer', async () => {
    const select = vi.fn(); await expect(readUsFinancialPilotPromotionStatus({ select }, 'injected&tenant')).rejects.toBeDefined(); expect(select).not.toHaveBeenCalled();
    const f = await fixture(); f.rpc.mockResolvedValue({ ...f.initial, revision: f.initial.revision + 1 });
    await expect(f.store.read(f.actor.organizationId)).rejects.toMatchObject({ code: 'invalid_financial_private_data' });
    expect(canonicalErpJson(f.initial)).not.toContain('injected&tenant');
  });
});
