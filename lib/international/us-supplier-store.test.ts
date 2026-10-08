import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { canonicalErpJson } from './erp-contract';
import { createSupabaseUsSupplierStore } from './us-supplier-store';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommit } from './runtime-types';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsSupplierApprovalRequest, UsSupplierProposal, UsSupplierRecording } from './us-supplier-contract';

const org = '11111111-1111-4111-8111-111111111111', otherOrg = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333', requestId = '44444444-4444-4444-8444-444444444444';
const actor: FinancialAuthority = { organizationId: org, userId: 'person', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const documentText = 'Supplier: TEST vendor\nInvoice: TEST-1\nUSD 10.00';
const proposal: UsSupplierProposal = { schemaVersion: 1, organizationId: org, id, revision: 0, state: 'review', createdBy: actor.userId, createdAt: actor.timestamp,
  source: { kind: 'document_import', sha256: createHash('sha256').update(documentText).digest('hex'), fileName: 'fictitious.txt', mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp, documentText },
  extraction: validateUsSupplierExtraction({ schemaVersion: 1, kind: 'unknown', confidence: 0, fields: {}, evidence: {}, fieldConfidence: {}, issues: [] }) };
const request: UsSupplierApprovalRequest = { schemaVersion: 1, idempotencyKey: requestId, proposalId: id, expectedProposalRevision: 0, expectedErpRevision: 3, confirmed: true, taxReviewed: true,
  review: { vendorId: 'vendor', reference: 'TEST-1', date: '2026-10-01', accountingDate: '2026-10-01', dueDate: '2026-10-31', periodId: 'year', netMinor: '1000', printedTaxMinor: '0' } };
const requestHash = createHash('sha256').update(canonicalErpJson([org, actor.userId, request])).digest('hex');
// Deliberately fictitious transport envelope; actual journal/header validation
// and PostgreSQL atomicity are established in the separate PG suite.
const erp = { organizationId: org, expectedRevision: 3, header: { schemaVersion: 4 }, changes: [], ledgerAudit: [], actor,
  receipt: { idempotencyKey: `us-mail-approve:${requestId}`, commandHash: 'a'.repeat(64), revision: 4, entityId: `us-mail-bill:${id}`, action: 'record_vendor_bill' } } as unknown as ErpCommit;
const approval = { actor, request, requestHash, erp };
const recording: UsSupplierRecording = { idempotencyKey: requestId, requestHash, by: actor.userId, at: actor.timestamp, review: request.review, erpReceipt: erp.receipt };
const recorded: UsSupplierProposal = { ...proposal, revision: 1, state: 'recorded', recording };
type Operation = 'list' | 'read' | 'findSource' | 'create' | 'approve';
const operations: readonly Operation[] = ['list', 'read', 'findSource', 'create', 'approve'];
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Field in keyof T]: Mutable<T[Field]> } : T;
function mutable<T>(value: T): Mutable<T> { return structuredClone(value) as Mutable<T>; }
function fixture(result: unknown, cap: ErpSchemaVersion = 4) {
  const rpc = vi.fn(async () => result) as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
  return { rpc, store: createSupabaseUsSupplierStore({ rpc }, { supportedSchemaVersion: cap }) };
}
function perform(f: ReturnType<typeof fixture>, operation: Operation, a = actor) {
  if (operation === 'list') return f.store.list(a);
  if (operation === 'read') return f.store.read(a, id);
  if (operation === 'findSource') return f.store.findSource(a, proposal.source.sha256);
  if (operation === 'create') return f.store.create(a, { ...proposal, createdBy: a.userId, createdAt: a.timestamp });
  return f.store.approve({ ...approval, actor: a });
}
const resultFor = (operation: Operation) => operation === 'list' ? [proposal] : operation === 'approve' ? recording : proposal;
const base = { p_organization: org, p_actor: actor, p_supported_schema_version: 4 };

describe('US supplier fixed private transport, fictitious RPC only', () => {
  it.each(operations)('uses only the fixed %s RPC with immutable captured cap4 and own actor', async operation => {
    const f = fixture(resultFor(operation)); expect(await perform(f, operation)).toEqual(resultFor(operation));
    const names = { list: 'zentra_list_us_supplier_proposals', read: 'zentra_read_us_supplier_proposal', findSource: 'zentra_find_us_supplier_source', create: 'zentra_create_us_supplier_proposal', approve: 'zentra_approve_us_supplier_proposal' };
    const extra = operation === 'read' ? { p_id: id } : operation === 'findSource' ? { p_sha256: proposal.source.sha256 } : operation === 'create' ? { p_proposal: proposal } : operation === 'approve' ? { p_request: request, p_request_hash: requestHash, p_erp: erp } : {};
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith(names[operation], { ...base, ...extra });
  });
  it.each(['read', 'findSource'] as const)('permits absent %s without inventing a proposal', async operation => {
    expect(await perform(fixture(null), operation)).toBeNull();
  });
  it.each([1, 2, 3] as const)('rejects ceiling%s before any I/O across all five ports', async cap => {
    const f = fixture(proposal, cap);
    for (const operation of operations) await expect(perform(f, operation)).rejects.toMatchObject({ code: 'supplier_upgrade_required', status: 409 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('defaults to1 and cannot be promoted by changing the caller-owned options', async () => {
    const rpc = vi.fn(), plain = createSupabaseUsSupplierStore({ rpc });
    await expect(plain.list(actor)).rejects.toMatchObject({ code: 'supplier_upgrade_required' });
    const options: { supportedSchemaVersion: ErpSchemaVersion } = { supportedSchemaVersion: 3 }, captured = createSupabaseUsSupplierStore({ rpc }, options); options.supportedSchemaVersion = 4;
    await expect(captured.list(actor)).rejects.toMatchObject({ code: 'supplier_upgrade_required' }); expect(rpc).not.toHaveBeenCalled();
  });
  it.each([0, 5, '4', false])('refuses an invalid configured ceiling%j', cap => {
    expect(() => createSupabaseUsSupplierStore({ rpc: vi.fn() }, { supportedSchemaVersion: cap as ErpSchemaVersion })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
  it('treats an absent/null runtime ceiling as least capability1, never a grant', async () => {
    const rpc = vi.fn(), store = createSupabaseUsSupplierStore({ rpc }, { supportedSchemaVersion: null as unknown as ErpSchemaVersion });
    expect(store.supportedSchemaVersion).toBe(1); await expect(store.list(actor)).rejects.toMatchObject({ code: 'supplier_upgrade_required' }); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['member', 'read_only', 'no-entitlement'] as const)('refuses authority%s before reading private source', async kind => {
    const a = { ...actor, ...(kind === 'no-entitlement' ? { managementEntitled: false } : { role: kind }) }, f = fixture(proposal);
    for (const operation of operations) await expect(perform(f, operation, a)).rejects.toMatchObject({ code: 'supplier_permission_required', status: 403 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'] as const)('refuses missing or accessor actor%s without running code', async field => {
    const f = fixture(proposal), bad = { ...actor } as Record<string, unknown>; delete bad[field];
    await expect(f.store.list(bad as unknown as FinancialAuthority)).rejects.toBeInstanceOf(Error);
    const getter = vi.fn(() => 'PRIVATE_SECRET');
    await expect(f.store.list(Object.defineProperty({ ...actor }, field, { get: getter, enumerable: true }))).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(getter).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['', '2026-02-30T00:00:00Z', '2026-10-08T12:00:00+00:00', '2026-10-08T12:00:00.0Z'])('refuses noncanonical actor timestamp%s', async timestamp => {
    const f = fixture(proposal); await expect(f.store.list({ ...actor, timestamp })).rejects.toMatchObject({ code: 'invalid_supplier_record' }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('captures all caller-owned approval data before its first await', async () => {
    const raw = mutable(approval), f = fixture(recording), pending = f.store.approve(raw);
    raw.request.review.netMinor = '999'; raw.requestHash = 'f'.repeat(64); raw.actor.userId = 'mutated';
    expect(await pending).toEqual(recording); expect(f.rpc.mock.calls[0]?.[1]).toEqual({ ...base, p_request: request, p_request_hash: requestHash, p_erp: erp });
  });
  it('returns detached frozen projections and source dedupe, including an already recorded original', async () => {
    const raw = mutable(recorded), f = fixture(raw), actual = await f.store.create(actor, proposal);
    raw.source.documentText = 'changed'; expect(actual).toEqual(recorded); expect(Object.isFrozen(actual.source)).toBe(true);
    const alternate = { ...proposal, id: '55555555-5555-4555-8555-555555555555' }; expect(await fixture(recorded).store.create(actor, alternate)).toEqual(recorded);
  });
  it.each([{}, [], 'private', { ...proposal, organizationId: otherOrg }, { ...proposal, private: 'SECRET' }])('refuses malformed private proposal%j', async bad => {
    for (const operation of ['read', 'findSource', 'create'] as const) await expect(perform(fixture(bad), operation)).rejects.toMatchObject({ code: 'invalid_supplier_record', status: 503 });
  });
  it('rejects a null creation acknowledgment instead of treating it as absence', async () => {
    await expect(fixture(null).store.create(actor, proposal)).rejects.toMatchObject({ code: 'invalid_supplier_record', status: 503 });
  });
  it('refuses an RPC record with a different ID/source or substituted creation source', async () => {
    await expect(fixture({ ...proposal, id: requestId }).store.read(actor, id)).rejects.toMatchObject({ code: 'invalid_supplier_record' });
    await expect(fixture({ ...proposal, source: { ...proposal.source, sha256: 'f'.repeat(64) } }).store.findSource(actor, proposal.source.sha256)).rejects.toMatchObject({ code: 'invalid_supplier_record' });
    await expect(fixture({ ...proposal, source: { ...proposal.source, documentText: 'different' } }).store.create(actor, proposal)).rejects.toMatchObject({ code: 'invalid_supplier_record' });
  });
  it('refuses duplicate IDs, duplicate source hashes, sparse/getter lists and more than50', async () => {
    for (const rows of [[proposal, proposal], [proposal, { ...proposal, id: requestId }], Array(1), Array(51).fill(proposal)]) await expect(fixture(rows).store.list(actor)).rejects.toBeInstanceOf(Error);
    const getter = vi.fn(() => proposal), rows = Object.defineProperty([proposal], '0', { get: getter, enumerable: true });
    await expect(fixture(rows).store.list(actor)).rejects.toMatchObject({ code: 'service_unavailable' }); expect(getter).not.toHaveBeenCalled();
  });
  it.each([null, 7, '', 'bad', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])('refuses noncanonical proposal ID%j before I/O', async value => {
    const f = fixture(proposal); await expect(f.store.read(actor, value as string)).rejects.toMatchObject({ code: 'invalid_supplier_proposal' }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([null, 7, '', 'f'.repeat(63), 'F'.repeat(64)])('refuses invalid source hash%j before I/O', async value => {
    const f = fixture(proposal); await expect(f.store.findSource(actor, value as string)).rejects.toMatchObject({ code: 'invalid_supplier_proposal' }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['confirmed', 'taxReviewed'] as const)('never accepts a proposal as approval without%s', async field => {
    const f = fixture(recording); await expect(f.store.approve({ ...approval, request: { ...request, [field]: false } } as unknown as typeof approval)).rejects.toMatchObject({ code: 'supplier_review_required' }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('refuses foreign actor, forged ERP metadata, wrong request hash and unsolicited privileged fields', async () => {
    for (const input of [{ ...approval, extra: 'secret' }, { ...approval, requestHash: 'b'.repeat(64) }, { ...approval, erp: { ...erp, organizationId: otherOrg } }, { ...approval, erp: { ...erp, actor: { ...actor, userId: 'other' } } }, { ...approval, erp: { ...erp, receipt: { ...erp.receipt, revision: 5 } } }, { ...approval, erp: { ...erp, header: { schemaVersion: 3 } } }]) {
      const f = fixture(recording); await expect(f.store.approve(input as typeof approval)).rejects.toBeInstanceOf(Error); expect(f.rpc).not.toHaveBeenCalled();
    }
  });
  it('permits exact old ERP body with fresh authority time for an immutable replay', async () => {
    const f = fixture(recording); expect(await f.store.approve({ ...approval, actor: { ...actor, timestamp: '2026-10-08T13:00:00Z' } })).toEqual(recording);
  });
  it.each(['by', 'at', 'requestHash', 'idempotencyKey', 'review', 'erpReceipt'] as const)('refuses substituted approval result%s', async field => {
    const bad = { ...recording, [field]: field === 'at' ? '2026-10-08T13:00:00Z' : field === 'review' ? { ...recording.review, netMinor: '9' } : field === 'erpReceipt' ? { ...erp.receipt, commandHash: 'b'.repeat(64) } : field === 'idempotencyKey' ? id : field === 'requestHash' ? 'b'.repeat(64) : 'other' };
    await expect(fixture(bad).store.approve(approval)).rejects.toMatchObject({ code: 'invalid_supplier_record', status: 503 });
  });
  it.each([
    ['PS001', 'supplier_revision_conflict', 409], ['PS002', 'supplier_idempotency_conflict', 409], ['PS003', 'supplier_erp_revision_conflict', 409],
    ['PS004', 'invalid_supplier_proposal', 422], ['PS005', 'supplier_permission_required', 403], ['PS006', 'supplier_upgrade_required', 409],
    ['PS007', 'supplier_limit_reached', 409], ['PS008', 'invalid_supplier_record', 503], ['PU001', 'supplier_erp_revision_conflict', 409],
    ['PU002', 'supplier_idempotency_conflict', 409], ['PU003', 'immutable_record', 409], ['PU004', 'invalid_supplier_proposal', 422],
    ['PU005', 'workspace_unavailable', 409], ['PU006', 'configuration_changed', 409], ['PU007', 'event_too_large', 413], ['PU008', 'supplier_upgrade_required', 409],
  ] as const)('maps SQL%s without exposing private detail', async (sqlCode, code, status) => {
    const f = fixture(null); f.rpc.mockRejectedValue(new SupabaseServerError(503, sqlCode, 'PRIVATE_DATABASE_SECRET'));
    await expect(f.store.list(actor)).rejects.toMatchObject({ code, status, message: code });
  });
  it.each([new Error('PRIVATE_SECRET'), new SupabaseServerError(503, 'XX999', 'PRIVATE_SECRET'), { message: 'PRIVATE_SECRET' }])('sanitizes unknown failures%j', async error => {
    const f = fixture(null); f.rpc.mockRejectedValue(error); await expect(f.store.list(actor)).rejects.toMatchObject({ code: 'service_unavailable', message: 'service_unavailable', status: 503 });
  });
});
