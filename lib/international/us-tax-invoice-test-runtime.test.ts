import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../account-security';
import { canonicalErpJson, ErpError } from './erp-contract';
import { createUsTaxInvoicePreparationHandlers } from './us-tax-invoice-preparation-server';
import { invoicePreparationFixture } from './us-tax-invoice-preparation.test-fixtures';
import { createUsTaxInvoicePrivateScope, createUsTaxInvoiceTestRuntime } from './us-tax-invoice-test-runtime';
import type { StoredUsTaxOperation, UsTaxOperationStore } from './us-tax-operation-store';
import { prepareStripeTaxResolvedRequest } from './stripe-tax-resolved-request';
import type { ErpReceipt } from './runtime-types';

function runtimeFixture() {
  const f = invoicePreparationFixture();
  const operations = { read: vi.fn(async () => null as StoredUsTaxOperation | null), reserve: vi.fn(async () => { throw new ErpError('service_unavailable', 503); }), record: vi.fn(async () => { throw new ErpError('service_unavailable', 503); }), commit: vi.fn(async () => { throw new ErpError('service_unavailable', 503); }) } satisfies UsTaxOperationStore;
  const dependencies = { ...f.dependencies, operations: vi.fn(async () => operations), operationId: vi.fn(() => 'a6000000-0000-4000-8000-000000000001') };
  return { ...f, operations, runtimeDependencies: dependencies, issue: () => createUsTaxInvoiceTestRuntime(dependencies)(f.execution(), f.request) };
}
async function historic(f: ReturnType<typeof runtimeFixture>): Promise<ErpReceipt> { return { idempotencyKey: f.request.idempotencyKey, commandHash: await sha256Hex(canonicalErpJson([f.organizationId, f.actor.userId, f.request])), revision: f.request.expectedRevision + 1, action: 'issue_invoice', entityId: 'invoice' }; }
describe('lazy private US TEST runtime composition', () => {
  it('replays the historical ERP receipt while the TEST flag is disabled with no private reads', async () => {
    const f = runtimeFixture(), receipt = await historic(f); f.disable(); f.erpStore.receipt = vi.fn(async () => receipt);
    expect(await f.issue()).toEqual({ receipt, replayed: true }); expect(f.dependencies.merchant).not.toHaveBeenCalled(); expect(f.runtimeDependencies.operations).not.toHaveBeenCalled(); expect(f.dependencies.preparations).not.toHaveBeenCalled();
  });
  it('never discloses a historical receipt after authority revocation', async () => {
    const f = runtimeFixture(); f.erpStore.receipt = vi.fn(async () => { f.revoke(); return historic(f); });
    await expect(f.issue()).rejects.toMatchObject({ code: 'unauthorized', status: 401 }); expect(f.dependencies.merchant).not.toHaveBeenCalled();
  });
  it('replays a concurrent committed operation before current merchant/preparation/flags', async () => {
    const f = runtimeFixture(), receipt = await historic(f); f.disable();
    f.operations.read.mockResolvedValue({ status: 'committed', organizationId: f.organizationId, actorUserId: f.actor.userId, erpIdempotencyKey: f.request.idempotencyKey, commandHash: receipt.commandHash, receipt } as StoredUsTaxOperation);
    expect(await f.issue()).toEqual({ receipt, replayed: true }); expect(f.dependencies.merchant).not.toHaveBeenCalled(); expect(f.dependencies.preparations).not.toHaveBeenCalled(); expect(f.runtimeDependencies.operations).toHaveBeenCalledWith(4);
  });
  it('defaults closed for a new invoice when the TEST flag is disabled', async () => {
    const f = runtimeFixture(); f.disable(); await expect(f.issue()).rejects.toMatchObject({ code: 'feature_unavailable', status: 404 }); expect(f.gateway.calculate).not.toHaveBeenCalled(); expect(f.operations.reserve).not.toHaveBeenCalled();
  });
  it('returns the dedicated preparation-required code without reserving or calculating', async () => {
    const f = runtimeFixture(); await expect(f.issue()).rejects.toMatchObject({ code: 'tax_preparation_required', status: 409 }); expect(f.gateway.calculate).not.toHaveBeenCalled(); expect(f.operations.reserve).not.toHaveBeenCalled();
  });
  it('detaches the exact request before an operation port can mutate its caller', async () => {
    const f = runtimeFixture(), originalKey = f.request.idempotencyKey;
    f.operations.read.mockImplementationOnce(async () => { (f.request as { idempotencyKey: string }).idempotencyKey = 'mutated-by-port'; return null; });
    await expect(f.issue()).rejects.toMatchObject({ code: 'tax_preparation_required', status: 409 });
    expect(f.rpc.mock.calls.find(([name]) => name === 'zentra_read_us_tax_invoice_preparation')?.[1].p_erp_idempotency_key).toBe(originalKey); expect(f.operations.reserve).not.toHaveBeenCalled();
  });
  it('detaches original authority before a merchant port mutates the caller actor', async () => {
    const f = runtimeFixture(), scope = createUsTaxInvoicePrivateScope(f.dependencies, f.actor, f.execution().revalidate), selected = await f.dependencies.merchant();
    f.dependencies.merchant.mockImplementationOnce(async () => { f.actor.userId = 'mutated-by-port'; return selected; });
    await expect(scope.admitted()).rejects.toMatchObject({ code: 'session_changed', status: 401 }); expect(f.gateway.calculate).not.toHaveBeenCalled();
  });
  it('blocks changed private context before reserving a confirmed preparation', async () => {
    const f = runtimeFixture(); await createUsTaxInvoicePreparationHandlers(f.dependencies).POST(f.http(), f.organizationId);
    (f.context as { sellerRevision: number }).sellerRevision++;
    await expect(f.issue()).rejects.toMatchObject({ code: 'tax_configuration_changed', status: 409 }); expect(f.operations.reserve).not.toHaveBeenCalled(); expect(f.gateway.calculate).not.toHaveBeenCalled();
  });
  it('keeps a previously reserved operation, instant and provider key on every retry', async () => {
    const f = runtimeFixture(); await createUsTaxInvoicePreparationHandlers(f.dependencies).POST(f.http(), f.organizationId); const preparation = f.saved()!;
    const resolved = await prepareStripeTaxResolvedRequest({ organizationId: f.organizationId, operationId: 'a6000000-0000-4000-8000-000000000001', invoiceId: 'invoice', actorUserId: f.actor.userId, erpIdempotencyKey: f.request.idempotencyKey, commandHash: preparation.commandHash, expectedErpRevision: f.request.expectedRevision, countryRevision: f.context.countryRevision, sellerRevision: f.context.sellerRevision, taxFactsRevision: f.context.taxFactsRevision, configuration: f.configuration, estimate: f.estimate, taxFacts: f.context.taxFacts, binding: f.context.binding, classifications: preparation.classifications, invoiceDate: '2026-10-10', taxDateInstant: preparation.taxDateInstant, taxDatePolicy: 'caller_supplied_invoice_instant', now: f.dependencies.now(), addressSource: preparation.addressSource });
    f.operations.read.mockResolvedValue({ status: 'reserved', organizationId: f.organizationId, actorUserId: f.actor.userId, erpIdempotencyKey: f.request.idempotencyKey, commandHash: preparation.commandHash, operationId: resolved.operationId, resolved, reservedAt: f.dependencies.now(), retryUntil: '2026-10-11T11:00:00.000Z', calculation: null, receipt: null });
    for (let i = 0; i < 2; i++) await expect(f.issue()).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(f.gateway.calculate).toHaveBeenCalledTimes(2); expect(f.gateway.calculate.mock.calls.map(call => (call as unknown as [typeof resolved])[0])).toEqual([resolved, resolved]); expect(f.operations.reserve).not.toHaveBeenCalled(); expect(f.runtimeDependencies.operationId).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'rotated', 'context', 'late'] as const)('fences %s during the gateway verification', async change => {
    const f = runtimeFixture(), scope = createUsTaxInvoicePrivateScope(f.dependencies, f.actor, f.execution().revalidate), context = await scope.readContext();
    f.gateway.verify.mockImplementationOnce(async () => { if (change === 'revoked') f.revoke(); if (change === 'rotated') f.rotate(); if (change === 'context') (f.context as { taxFactsRevision: number }).taxFactsRevision++; if (change === 'late') f.advance(30_001); });
    await expect(scope.verify(context)).rejects.toMatchObject({ status: change === 'revoked' ? 401 : 409 }); expect(f.gateway.calculate).not.toHaveBeenCalled();
  });
});
