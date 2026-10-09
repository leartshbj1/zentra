import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../account-security';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson } from './erp-contract';
import type { ErpCommit, ErpRequest } from './runtime-types';
import type { ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { ValidatedStripeTaxCalculation } from './stripe-tax-calculation';
import { createSupabaseUsTaxInvoicePreparationStore, validateUsTaxInvoicePreparation } from './us-tax-invoice-preparation-store';
import { createSupabasePreparedUsTaxOperationStore } from './us-tax-prepared-operation-store';

const actor: FinancialAuthority = { organizationId: 'TEST-org', userId: 'TEST-admin', role: 'admin', managementEntitled: true, timestamp: '2026-10-10T12:00:00.000Z' };
const request = (): ErpRequest => ({ idempotencyKey: 'TEST-invoice', expectedRevision: 4, command: { type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-10-10', periodId: 'year' } });
function client(rpc: (name: string, input: Record<string, unknown>) => Promise<unknown>) { return { rpc } as Pick<SupabaseServerClient, 'rpc'>; }
describe('private immutable preparation and protected operation transports', () => {
  it('captures real actor, normalized request and factory capability before any hash/RPC await', async () => {
    const admitted = { ...actor }, input = request(), options = { supportedSchemaVersion: 4 as const }, rpc = vi.fn(async () => null), store = createSupabaseUsTaxInvoicePreparationStore(client(rpc), options);
    const expectedHash = await sha256Hex(canonicalErpJson([actor.organizationId, actor.userId, input])), pending = store.read(admitted, input);
    admitted.userId = 'CHANGED'; (input as { idempotencyKey: string }).idempotencyKey = 'CHANGED';
    (options as { supportedSchemaVersion: number }).supportedSchemaVersion = 1;
    expect(await pending).toBeNull();
    expect(rpc).toHaveBeenCalledWith('zentra_read_us_tax_invoice_preparation', { p_organization: actor.organizationId, p_actor: actor, p_erp_idempotency_key: 'TEST-invoice', p_command_hash: expectedHash, p_supported_schema_version: 4 });
  });
  it('refuses non-financial, unentitled and non-invoice input without calling storage', async () => {
    const rpc = vi.fn(async () => null), store = createSupabaseUsTaxInvoicePreparationStore(client(rpc));
    await expect(store.read({ ...actor, role: 'member' }, request())).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 });
    await expect(store.read({ ...actor, managementEntitled: false }, request())).rejects.toMatchObject({ code: 'management_entitlement_required', status: 402 });
    await expect(store.read(actor, { ...request(), command: { type: 'refresh_configuration' } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects malformed private projections and never returns provider/database error text', async () => {
    await expect(validateUsTaxInvoicePreparation({ privateSecret: 'TEST_PRIVATE_SENTINEL' }, actor, request())).rejects.toMatchObject({ code: 'invalid_stored_tax_preparation', status: 503 });
    for (const failure of [Error('TEST_PRIVATE_SENTINEL'), new SupabaseServerError(503, 'unknown', 'TEST_PRIVATE_SENTINEL')]) await expect(createSupabaseUsTaxInvoicePreparationStore(client(async () => { throw failure; })).read(actor, request())).rejects.toMatchObject({ code: 'service_unavailable', message: 'service_unavailable' });
  });
  it('forwards captured schema capability to protected reserve and preserves no-auto-retry errors', async () => {
    const rpc = vi.fn(async () => { throw new SupabaseServerError(409, 'PF001', 'TEST_PRIVATE_SENTINEL'); }), options = { supportedSchemaVersion: 4 as const }, store = createSupabasePreparedUsTaxOperationStore(client(rpc), options);
    (options as { supportedSchemaVersion: number }).supportedSchemaVersion = 1;
    const resolved = { organizationId: actor.organizationId, actorUserId: actor.userId, operationId: '00000000-0000-4000-8000-000000000001', resolvedBody: '{}', resolvedSha256: 'a'.repeat(64), paramsBody: '{}', paramsSha256: 'b'.repeat(64), idempotencyKey: 'ztax_test_' + 'c'.repeat(64) } as ResolvedStripeTaxRequest;
    await expect(store.reserve(actor, resolved)).rejects.toMatchObject({ code: 'tax_preparation_changed', status: 409 });
    expect(rpc).toHaveBeenCalledTimes(1); expect(rpc).toHaveBeenCalledWith('zentra_reserve_us_tax_prepared_operation', expect.objectContaining({ p_supported_schema_version: 4, p_actor: actor, p_operation_id: resolved.operationId }));
  });
  it('forwards the same captured capability and exact proof to protected record', async () => {
    const rpc = vi.fn(async () => { throw new SupabaseServerError(409, 'PF003'); }), store = createSupabasePreparedUsTaxOperationStore(client(rpc), { supportedSchemaVersion: 4 });
    const resolved = { organizationId: actor.organizationId, actorUserId: actor.userId, operationId: '00000000-0000-4000-8000-000000000001' } as ResolvedStripeTaxRequest;
    const proof = { proofBody: '{}', proofSha256: 'a'.repeat(64), assessment: {} } as ValidatedStripeTaxCalculation;
    await expect(store.record(actor, resolved, proof)).rejects.toMatchObject({ code: 'tax_preparation_required', status: 409 });
    expect(rpc).toHaveBeenCalledWith('zentra_record_us_tax_prepared_calculation', { p_organization: actor.organizationId, p_operation_id: resolved.operationId, p_actor: actor, p_proof_body: proof.proofBody, p_proof_sha256: proof.proofSha256, p_assessment: proof.assessment, p_supported_schema_version: 4 });
  });
  it('keeps commit on the protected RPC with exact validated receipt and server capability', async () => {
    const rpc = vi.fn(async () => { throw new SupabaseServerError(409, 'PF006'); }), store = createSupabasePreparedUsTaxOperationStore(client(rpc), { supportedSchemaVersion: 4 });
    const input = { organizationId: actor.organizationId, expectedRevision: 4, header: { schemaVersion: 4 }, changes: [], ledgerAudit: [], actor, receipt: { idempotencyKey: 'TEST-invoice', commandHash: 'a'.repeat(64), revision: 5, entityId: 'invoice', action: 'issue_invoice' } } as unknown as ErpCommit;
    await expect(store.commit('00000000-0000-4000-8000-000000000001', input)).rejects.toMatchObject({ code: 'tax_preparation_expired' });
    expect(rpc).toHaveBeenCalledWith('zentra_commit_us_tax_prepared_invoice_test', expect.objectContaining({ p_receipt: input.receipt, p_supported_schema_version: 4, p_actor: actor }));
  });
  it('retains the original strict operation read without turning absence into a preparation grant', async () => {
    const rpc = vi.fn(async () => null), store = createSupabasePreparedUsTaxOperationStore(client(rpc), { supportedSchemaVersion: 4 });
    expect(await store.read(actor, 'TEST-invoice', 'a'.repeat(64))).toBeNull();
    expect(rpc).toHaveBeenCalledWith('zentra_read_us_tax_operation', { p_organization: actor.organizationId, p_actor: actor, p_erp_idempotency_key: 'TEST-invoice', p_command_hash: 'a'.repeat(64) });
  });
});
