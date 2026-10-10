import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createSupabaseUsSupplierDocumentStore } from './us-supplier-document-store';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import type { FinancialAuthority } from './accounting/ledger';
import type { UsSupplierDocumentDescriptor } from './us-supplier-document-contract';

const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222', otherId = '33333333-3333-4333-8333-333333333333';
const actor: FinancialAuthority = { organizationId: org, userId: 'owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-10T00:00:00.000Z' };
const documentText = 'Fictitious supplier invoice\nUSD 100.00', textSha256 = createHash('sha256').update(documentText).digest('hex');
const descriptor: UsSupplierDocumentDescriptor = { schemaVersion: 1, organizationId: org, id, contentSha256: 'a'.repeat(64), sizeBytes: 500, mediaType: 'application/pdf', fileName: 'fixture.pdf', documentText, textSha256, createdBy: actor.userId, createdAt: actor.timestamp };
const record = { ...descriptor, stored: false, proposalId: null };
const proposal = validateUsSupplierProposal({ schemaVersion: 1, organizationId: org, id: otherId, revision: 0, state: 'review', createdBy: actor.userId, createdAt: actor.timestamp,
  source: { kind: 'document_import', sha256: textSha256, documentText, mediaType: 'text/plain', fileName: 'fixture.txt', workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp },
  extraction: validateUsSupplierExtraction({ schemaVersion: 1, kind: 'unknown', confidence: 0, fields: {}, evidence: {}, fieldConfidence: {}, issues: [] }) }, org);
const fixture = (value: unknown = record, capability: 1 | 2 | 3 | 4 = 4) => {
  const rpc = vi.fn(async (_name: string, _input: Record<string, unknown>) => value); return { rpc, store: createSupabaseUsSupplierDocumentStore({ rpc } as Pick<SupabaseServerClient, 'rpc'>, { supportedSchemaVersion: capability }) };
};
const operations = ['list', 'read', 'reserve', 'complete', 'link'] as const;
function perform(f: ReturnType<typeof fixture>, operation: typeof operations[number], a = actor) {
  if (operation === 'list') return f.store.list(a);
  if (operation === 'read') return f.store.read(a, id);
  if (operation === 'reserve') return f.store.reserve(a, descriptor);
  if (operation === 'complete') return f.store.complete(a, id, descriptor.contentSha256, descriptor.sizeBytes);
  return f.store.link(a, id, proposal);
}
describe('US supplier document fixed service adapter', () => {
  it.each(operations)('uses only the fixed %s RPC and captured capability/actor', async operation => {
    const f = fixture(operation === 'list' ? [record] : operation === 'complete' ? { ...record, stored: true } : operation === 'link' ? { ...record, stored: true, proposalId: proposal.id } : record);
    await perform(f, operation); expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.rpc.mock.calls[0]).toEqual([`zentra_${operation === 'list' ? 'list_us_supplier_documents' : `${operation}_us_supplier_document`}`, expect.objectContaining({ p_organization: org, p_actor: actor, p_supported_schema_version: 4 })]);
  });
  it('keeps the first timestamp on same-ID retries and all first metadata on raw-byte dedupe', async () => {
    const fresh = { ...actor, timestamp: '2026-10-10T00:05:00.000Z' };
    expect(await fixture().store.reserve(fresh, { ...descriptor, createdAt: fresh.timestamp })).toEqual(record);
    expect(await fixture().store.reserve(fresh, { ...descriptor, id: otherId, createdAt: fresh.timestamp, fileName: 'renamed.pdf', documentText: null, textSha256: null })).toEqual(record);
  });
  it.each(operations)('refuses unentitled/financially unauthorized actors before %s I/O', async operation => {
    for (const a of [{ ...actor, role: 'member' as const }, { ...actor, managementEntitled: false }]) {
      const f = fixture(); await expect(perform(f, operation, a)).rejects.toMatchObject({ code: 'supplier_permission_required', status: 403 }); expect(f.rpc).not.toHaveBeenCalled();
    }
  });
  it.each(operations)('refuses old capability before %s I/O', async operation => {
    const f = fixture(record, 3); await expect(perform(f, operation)).rejects.toMatchObject({ code: 'supplier_upgrade_required' }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...record, organizationId: otherId }, { ...record, textSha256: 'f'.repeat(64) }, { ...record, secret: 'PRIVATE' }])('refuses malformed or hash-corrupt private results %j', async value => {
    await expect(fixture(value).store.reserve(actor, descriptor)).rejects.toMatchObject({ code: 'invalid_supplier_document_record', status: 503 });
  });
  it('checks text SHA itself, exact initial author/time and privileged input keys before RPC', async () => {
    for (const patch of [{ textSha256: 'f'.repeat(64) }, { createdBy: 'foreign' }, { createdAt: '2026-10-10T01:00:00Z' }, { private: true }]) {
      const f = fixture(); await expect(f.store.reserve(actor, { ...descriptor, ...patch })).rejects.toMatchObject({ code: 'invalid_supplier_document' }); expect(f.rpc).not.toHaveBeenCalled();
    }
  });
  it('rejects substituted record ID, raw-byte acknowledgment and link source', async () => {
    await expect(fixture({ ...record, id: otherId }).store.read(actor, id)).rejects.toMatchObject({ code: 'invalid_supplier_document_record' });
    await expect(fixture(record).store.complete(actor, id, descriptor.contentSha256, descriptor.sizeBytes)).rejects.toMatchObject({ code: 'invalid_supplier_document_record' });
    await expect(fixture({ ...record, stored: true, sizeBytes: 501 }).store.complete(actor, id, descriptor.contentSha256, descriptor.sizeBytes)).rejects.toMatchObject({ code: 'invalid_supplier_document_record' });
    await expect(fixture({ ...record, stored: true, proposalId: id }).store.link(actor, id, proposal)).rejects.toMatchObject({ code: 'invalid_supplier_document_record' });
  });
  it('allows absence only for read and rejects invalid IDs/hashes without I/O', async () => {
    expect(await fixture(null).store.read(actor, id)).toBeNull();
    const f = fixture(); await expect(f.store.read(actor, '../foreign')).rejects.toMatchObject({ code: 'invalid_supplier_document' });
    await expect(f.store.complete(actor, id, 'F'.repeat(64), 500)).rejects.toMatchObject({ code: 'invalid_supplier_document' }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('refuses duplicate IDs/raw hashes/proposal links, excessive bytes and sparse/getter lists', async () => {
    const linked = { ...record, stored: true, proposalId: otherId };
    for (const rows of [[record, record], [linked, { ...linked, id: otherId, contentSha256: 'b'.repeat(64) }], Array(51).fill(record), Array(1),
      Array.from({ length: 17 }, (_, n) => ({ ...record, id: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`, contentSha256: n.toString(16).padStart(64, '0'), sizeBytes: 6 * 1024 * 1024 }))]) await expect(fixture(rows).store.list(actor)).rejects.toMatchObject({ status: 503 });
    const getter = vi.fn(() => record), rows = Object.defineProperty([record], '0', { get: getter, enumerable: true });
    await expect(fixture(rows).store.list(actor)).rejects.toMatchObject({ status: 503 }); expect(getter).not.toHaveBeenCalled();
  });
  it.each([['PD001', 'invalid_supplier_document', 422], ['PD002', 'supplier_document_conflict', 409], ['PD003', 'supplier_document_not_found', 404], ['PD004', 'supplier_document_limit_reached', 409], ['PD005', 'invalid_supplier_document_record', 503], ['PS005', 'supplier_permission_required', 403], ['PS006', 'supplier_upgrade_required', 409], ['PU006', 'configuration_changed', 409]] as const)('maps private SQL %s to a safe code', async (sqlCode, code, status) => {
    const f = fixture(); f.rpc.mockRejectedValue(new SupabaseServerError(503, sqlCode, 'PRIVATE_DATABASE_DETAILS'));
    await expect(f.store.list(actor)).rejects.toMatchObject({ code, status, message: code });
  });
});
