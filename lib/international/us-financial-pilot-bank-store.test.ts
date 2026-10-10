import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import { ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { applyUsFinancialPilotBank, appendUsFinancialPilotBankRegister, buildUsFinancialPilotBankProof, type UsFinancialPilotBankRegister, type UsFinancialPilotBankRequest } from './us-financial-pilot-bank';
import { createSupabaseUsFinancialPilotBankStore } from './us-financial-pilot-bank-store';

type Mutable<T> = T extends readonly (infer V)[] ? Mutable<V>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
async function fixture() {
  const data = await financialKernelFixture(), book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), organizationId = data.actor.organizationId;
  const scope = { scope: { organizationId, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const register: UsFinancialPilotBankRegister = { schemaVersion: 1, organizationId, bankRevision: 0, records: [], operations: [] };
  const request: UsFinancialPilotBankRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: randomUUID(), expectedRevision: book.revision, expectedBankRevision: 0, expectedStatementRevision: null,
    command: { type: 'create_statement', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-02', openingMinor: '0', closingMinor: '0', lines: [] } };
  const record = applyUsFinancialPilotBank(request, await projectUsFinancialBookV5(book), register, data.actor), proof = await buildUsFinancialPilotBankProof(request, book, data.actor, record);
  const response = { book, register }, head = { consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: book.revision, bankRevision: 0 };
  const rpc = vi.fn(async (name: string, _parameters: Readonly<Record<string, unknown>>): Promise<unknown> => name.includes('head') ? head : name.includes('receipt') ? null : name.includes('commit') ? proof : response), fresh = vi.fn(async () => scope);
  const store = createSupabaseUsFinancialPilotBankStore({ rpc }, scope, fresh);
  return { data, book, scope, register, request, record, proof, response, head, rpc, fresh, store };
}
describe('private V5 bank store transport and authority fences', () => {
  it('captures an atomic composite head without loading financial or bank history', async () => {
    const t = await fixture(); expect(await t.store.head()).toEqual(t.head); expect(t.rpc).toHaveBeenCalledTimes(1);
    expect(t.rpc.mock.calls[0][0]).toBe('zentra_us_financial_pilot_bank_test_head_v1'); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
  it('reads and validates one admitted book/register pair and its complete historical source', async () => {
    const t = await fixture(), register = appendUsFinancialPilotBankRegister(t.register, t.record, t.proof);
    t.rpc.mockResolvedValueOnce({ book: t.book, register }); expect((await t.store.read()).register).toEqual(register); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
  it('sends exactly the captured canonical request, original actor, record and proof', async () => {
    const t = await fixture(); expect(await t.store.commit({ request: t.request, record: t.record, proof: t.proof })).toEqual(t.proof);
    expect(t.rpc.mock.calls[0]).toEqual(['zentra_commit_us_financial_pilot_bank_test_v1', { p_organization: t.scope.scope.organizationId, p_actor: t.proof.actor, p_grant_version: 1, p_opt_in_version: 1, p_capability: 'postgres-test-financial-pilot-dto1', p_request: t.request, p_record: t.record.record, p_proof: t.proof }]);
  });
  it('uses one same-actor point receipt lookup and leaves historical heads untouched', async () => {
    const t = await fixture(); t.rpc.mockResolvedValueOnce(t.proof); expect(await t.store.receipt(t.request.requestId)).toEqual(t.proof);
    expect(t.rpc.mock.calls[0][0]).toBe('zentra_us_financial_pilot_bank_test_receipt_v1'); expect(t.rpc.mock.calls[0][1]).toMatchObject({ p_request_id: t.request.requestId });
  });
  it.each(['user', 'role', 'tenant', 'grant', 'optIn', 'policy', 'clock'] as const)('rejects %s drift before the private RPC', async kind => {
    const t = await fixture(), scope = clone(t.scope);
    if (kind === 'user') scope.scope.actor.userId = 'different'; else if (kind === 'role') scope.scope.actor.role = 'admin'; else if (kind === 'tenant') scope.scope.organizationId = scope.scope.actor.organizationId = 'other';
    else if (kind === 'grant') scope.scope.grantVersion++; else if (kind === 'optIn') scope.optInVersion++; else if (kind === 'policy') scope.scope.policy.approval.reference += '-different'; else scope.scope.actor.timestamp = '2000-01-01T00:00:00Z';
    t.fresh.mockResolvedValueOnce(scope); await expect(t.store.head()).rejects.toBeInstanceOf(ErpError); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'] as const)('renews authority after RPC %s before disclosing either result', async kind => {
    const t = await fixture(); if (kind === 'failure') t.rpc.mockRejectedValueOnce(new SupabaseServerError(503, 'BQ005'));
    t.fresh.mockResolvedValueOnce(t.scope).mockRejectedValueOnce(new ErpError('financial_test_grant_required', 403));
    await expect(t.store.head()).rejects.toMatchObject({ code: 'financial_test_grant_required', status: 403 }); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
  it('renews authority after malformed private projection', async () => {
    const t = await fixture(); t.rpc.mockResolvedValueOnce({ ...t.head, privateLedger: 'secret' }); await expect(t.store.head()).rejects.toBeInstanceOf(ErpError); expect(t.fresh).toHaveBeenCalledTimes(2);
  });
  it.each(['actor', 'request', 'hash'] as const)('rejects a substituted historical receipt %s', async kind => {
    const t = await fixture(), proof = clone(t.proof); if (kind === 'actor') proof.actor.userId = 'different'; else if (kind === 'request') proof.request.requestId = randomUUID(); else proof.commandHash = '0'.repeat(64);
    t.rpc.mockResolvedValueOnce(proof); await expect(t.store.receipt(t.request.requestId)).rejects.toBeInstanceOf(ErpError);
  });
  it('rejects coherent intrinsic records with a counterfeit financial source hash', async () => {
    const t = await fixture(), register = clone(appendUsFinancialPilotBankRegister(t.register, t.record, t.proof)); register.operations[0].source.bookSha256 = '0'.repeat(64);
    t.rpc.mockResolvedValueOnce({ book: t.book, register }); await expect(t.store.read()).rejects.toBeInstanceOf(ErpError);
  });
  it('captures caller-owned commit facts before its first awaited admission', async () => {
    const t = await fixture(), input = clone({ request: t.request, record: t.record, proof: t.proof }), result = t.store.commit(input);
    input.request.expectedBankRevision = 100; input.proof.request.expectedBankRevision = 100; expect(await result).toEqual(t.proof);
  });
  it.each(['wrapper', 'intrinsic'] as const)('rejects malformed commit %s before any RPC', async kind => {
    const t = await fixture(), input = clone({ request: t.request, record: t.record, proof: t.proof });
    if (kind === 'wrapper') Object.assign(input.record, { privateExtra: true }); else input.record.record.reconciliation.statement.currency = 'EUR' as 'USD';
    await expect(t.store.commit(input)).rejects.toBeInstanceOf(ErpError); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('rejects accessor envelopes without evaluating their getters', async () => {
    const t = await fixture(), getter = vi.fn(() => t.book), value = { register: t.register }; Object.defineProperty(value, 'book', { enumerable: true, get: getter }); t.rpc.mockResolvedValueOnce(value);
    await expect(t.store.read()).rejects.toBeInstanceOf(ErpError); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['BQ001', 'BQ002', 'BQ003', 'BQ004', 'BQ009', 'BQ013', 'PF005'] as const)('maps allowlisted private SQL code %s without a message', async code => {
    const t = await fixture(); t.rpc.mockRejectedValueOnce(new SupabaseServerError(503, code, 'SECRET SQL RESOURCE')); await expect(t.store.head()).rejects.toMatchObject({ status: code === 'PF005' ? 403 : 409 });
  });
  it('closes unknown SQL errors and never reads an error-code accessor', async () => {
    const t = await fixture(), error = new SupabaseServerError(503, 'UNKNOWN', 'SECRET'), getter = vi.fn(() => 'BQ005'); Object.defineProperty(error, 'code', { get: getter }); t.rpc.mockRejectedValueOnce(error);
    await expect(t.store.head()).rejects.toMatchObject({ code: 'financial_service_unavailable', status: 503 }); expect(getter).not.toHaveBeenCalled();
  });
});
