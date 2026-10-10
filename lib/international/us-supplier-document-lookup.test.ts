import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import type { UsSupplierDocumentRecord } from './us-supplier-document-contract';
import { findUsSupplierDocumentByHash } from './us-supplier-document-lookup';

const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';
const actor: FinancialAuthority = { organizationId: org, userId: 'owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-10T00:00:00.000Z' };
const documentText = 'Fictitious private supplier invoice\nUSD 100.00';
const document: UsSupplierDocumentRecord = {
  schemaVersion: 1, organizationId: org, id: '33333333-3333-4333-8333-333333333333',
  contentSha256: 'a'.repeat(64), sizeBytes: 500, mediaType: 'application/pdf', fileName: 'first.pdf',
  documentText, textSha256: createHash('sha256').update(documentText).digest('hex'),
  createdBy: 'first-author', createdAt: actor.timestamp, stored: false, proposalId: null,
};
function fixture(value: unknown = document) {
  const rpc = vi.fn(async (_name: string, _parameters: Record<string, unknown>) => value);
  return { rpc, client: { rpc } as Pick<SupabaseServerClient, 'rpc'> };
}

describe('US supplier original private digest lookup adapter', () => {
  it('uses the fixed RPC with the captured financial actor and schema v4', async () => {
    const f = fixture();
    const result = await findUsSupplierDocumentByHash(f.client, actor, document.contentSha256);
    expect(result).toEqual(document);
    expect(result).not.toBe(document);
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('zentra_find_us_supplier_document_by_sha256', {
      p_organization: org, p_actor: actor, p_supported_schema_version: 4, p_content_sha256: document.contentSha256,
    });
  });
  it.each([false, true])('keeps the canonical first metadata for stored=%s', async stored => {
    const canonical = { ...document, stored, ...(stored ? { proposalId: otherOrg } : {}) };
    expect(await findUsSupplierDocumentByHash(fixture(canonical).client, { ...actor, role: 'accountant' }, document.contentSha256)).toEqual(canonical);
  });
  it('returns null only for an explicitly absent private projection', async () => {
    expect(await findUsSupplierDocumentByHash(fixture(null).client, actor, document.contentSha256)).toBeNull();
    const f = fixture(); f.rpc.mockResolvedValue(undefined);
    await expect(findUsSupplierDocumentByHash(f.client, actor, document.contentSha256)).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    {}, [], { ...document, organizationId: otherOrg }, { ...document, contentSha256: 'b'.repeat(64) },
    { ...document, sizeBytes: '500' }, { ...document, stored: 'true' }, { ...document, mediaType: 'text/html' },
    { ...document, textSha256: 'f'.repeat(64) }, { ...document, documentText: null },
    { ...document, proposalId: otherOrg }, { ...document, privateSecret: 'PRIVATE' },
  ])('treats a malformed or foreign RPC projection as a private 503 invariant: %j', async value => {
    await expect(findUsSupplierDocumentByHash(fixture(value).client, actor, document.contentSha256))
      .rejects.toMatchObject({ code: 'invalid_supplier_document_record', status: 503 });
  });
  it('does not invoke accessors in a private RPC projection', async () => {
    const getter = vi.fn(() => 'a'.repeat(64));
    const value = Object.defineProperty({ ...document }, 'contentSha256', { get: getter, enumerable: true });
    await expect(findUsSupplierDocumentByHash(fixture(value).client, actor, document.contentSha256))
      .rejects.toMatchObject({ code: 'invalid_supplier_document_record', status: 503 });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), ' ' + 'a'.repeat(64)])('rejects invalid digest %s before I/O', async hash => {
    const f = fixture();
    await expect(findUsSupplierDocumentByHash(f.client, actor, hash)).rejects.toMatchObject({ code: 'invalid_supplier_document', status: 422 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['member', 'read_only'] as const)('rejects the %s role before I/O', async role => {
    const f = fixture();
    await expect(findUsSupplierDocumentByHash(f.client, { ...actor, role }, document.contentSha256)).rejects.toMatchObject({ code: 'supplier_permission_required', status: 403 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('rejects missing Gestion and actor accessors before I/O', async () => {
    const f = fixture();
    await expect(findUsSupplierDocumentByHash(f.client, { ...actor, managementEntitled: false }, document.contentSha256)).rejects.toMatchObject({ status: 403 });
    const getter = vi.fn(() => org);
    const value = Object.defineProperty({ ...actor }, 'organizationId', { get: getter, enumerable: true });
    await expect(findUsSupplierDocumentByHash(f.client, value, document.contentSha256)).rejects.toMatchObject({ status: 503 });
    expect(getter).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('captures the actor before an awaited RPC can mutate caller-owned fields', async () => {
    const original = { ...actor };
    let finish!: (value: unknown) => void;
    const rpc = vi.fn((_name: string, _parameters: Record<string, unknown>) => new Promise<unknown>(resolve => { finish = resolve; }));
    const pending = findUsSupplierDocumentByHash({ rpc } as Pick<SupabaseServerClient, 'rpc'>, original, document.contentSha256);
    original.organizationId = otherOrg; original.userId = 'foreign'; original.role = 'read_only';
    finish(document);
    expect(await pending).toEqual(document);
    expect(rpc.mock.calls[0]?.[1].p_actor).toEqual(actor);
    expect(Object.isFrozen(rpc.mock.calls[0]?.[1].p_actor)).toBe(true);
  });
  it.each([
    ['PD001', 'invalid_supplier_document', 422], ['PS005', 'supplier_permission_required', 403],
    ['PS006', 'supplier_upgrade_required', 409], ['PU005', 'workspace_unavailable', 409],
    ['PU006', 'configuration_changed', 409], ['PU008', 'client_upgrade_required', 409],
  ] as const)('maps only the approved SQL error %s', async (sqlCode, code, status) => {
    const f = fixture(); f.rpc.mockRejectedValue(new SupabaseServerError(503, sqlCode, 'PRIVATE_DATABASE_DETAILS'));
    await expect(findUsSupplierDocumentByHash(f.client, actor, document.contentSha256)).rejects.toMatchObject({ code, status, message: code });
  });
  it.each([new Error('PRIVATE_TRANSPORT_DETAILS'), new SupabaseServerError(503, 'UNKNOWN', 'PRIVATE_DATABASE_DETAILS')])('sanitizes unrecognized failures', async error => {
    const f = fixture(); f.rpc.mockRejectedValue(error);
    await expect(findUsSupplierDocumentByHash(f.client, actor, document.contentSha256)).rejects.toMatchObject({ code: 'service_unavailable', status: 503, message: 'service_unavailable' });
  });
});
