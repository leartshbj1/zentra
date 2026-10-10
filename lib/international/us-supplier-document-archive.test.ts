import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './canonical-hash';
import { readUsSupplierOriginal, retainUsSupplierOriginal, type UsSupplierDocumentArchive } from './us-supplier-document-archive';
import type { UsSupplierDocumentRecord } from './us-supplier-document-contract';
const org = '54b7ee3b-5753-4af1-98f6-b2a568fb3890', id = 'af6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', user = '53e1704e-9cc6-431b-ac4d-2186c5fe5f6d';
async function fixture() {
  const bytes = new TextEncoder().encode('Original document'), hash = await sha256Hex(bytes), objects = new Map<string, Uint8Array>();
  const document: UsSupplierDocumentRecord = { schemaVersion: 1, organizationId: org, id, contentSha256: hash, sizeBytes: bytes.length, mediaType: 'text/plain', fileName: 'original.txt', documentText: 'Original document', textSha256: hash, createdBy: user, createdAt: '2026-10-10T12:00:00.000Z', stored: false, proposalId: null };
  const archive = {
    get: vi.fn<UsSupplierDocumentArchive['get']>(async key => { const data = objects.get(key); return data ? { size: data.length, body: new Blob([Uint8Array.from(data)]).stream() } : null; }),
    put: vi.fn<UsSupplierDocumentArchive['put']>(async (key, data, options) => { expect(options.onlyIf.get('If-None-Match')).toBe('*'); expect(options.sha256).toBe(hash); expect(options.httpMetadata.contentType).toBe('application/octet-stream'); if (objects.has(key)) return null; objects.set(key, data.slice()); return {}; }),
  } satisfies UsSupplierDocumentArchive;
  return { bytes, document, archive, objects, revalidate: vi.fn(async () => {}) };
}
describe('US private original archive', () => {
  it('writes privately without replacement, verifies bytes and does not expose a key', async () => {
    const t = await fixture(); await retainUsSupplierOriginal(t.archive, t.document, t.bytes, t.revalidate);
    expect([...t.objects.keys()]).toEqual([`international/us/supplier-originals/${org}/${id}/${t.document.contentSha256}`]);
    expect(await readUsSupplierOriginal(t.archive, t.document, t.revalidate)).toEqual(t.bytes);
    expect(t.revalidate.mock.calls.length).toBeGreaterThanOrEqual(7);
  });
  it('recovers a PUT that committed before its response was lost', async () => {
    const t = await fixture(), put = t.archive.put;
    t.archive.put = vi.fn(async (...args: Parameters<UsSupplierDocumentArchive['put']>) => { await put(...args); throw new Error('lost'); });
    await expect(retainUsSupplierOriginal(t.archive, t.document, t.bytes, t.revalidate)).resolves.toBeUndefined();
    expect(t.objects.size).toBe(1);
  });
  it('verifies an already stored original on every replay without another PUT', async () => {
    const t = await fixture(); await retainUsSupplierOriginal(t.archive, t.document, t.bytes, t.revalidate);
    vi.mocked(t.archive.put).mockClear(); await retainUsSupplierOriginal(t.archive, { ...t.document, stored: true }, t.bytes, t.revalidate);
    expect(t.archive.put).not.toHaveBeenCalled();
  });
  it.each(['missing', 'size', 'hash', 'overlong'] as const)('refuses %s archive evidence', async failure => {
    const t = await fixture();
    t.archive.put = vi.fn(async () => null);
    if (failure !== 'missing') t.archive.get = vi.fn(async () => ({ size: failure === 'size' ? t.bytes.length + 1 : t.bytes.length, body: new Blob([new Uint8Array(t.bytes.length + (failure === 'overlong' ? 1 : 0))]).stream() }));
    await expect(retainUsSupplierOriginal(t.archive, t.document, t.bytes, t.revalidate)).rejects.toThrow();
  });
  it('does not read the archive after permission is lost during PUT', async () => {
    const t = await fixture(); let revoked = false;
    t.revalidate.mockImplementation(async () => { if (revoked) throw new Error('revoked'); });
    t.archive.put = vi.fn(async () => { revoked = true; return {}; });
    await expect(retainUsSupplierOriginal(t.archive, t.document, t.bytes, t.revalidate)).rejects.toThrow('revoked'); expect(t.archive.get).not.toHaveBeenCalled();
  });
  it('cancels an unread private stream when permission is revoked after archive GET', async () => {
    const t = await fixture(), cancel = vi.fn();
    t.archive.get.mockResolvedValue({ size: t.bytes.length, body: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(t.bytes.slice()); }, cancel }) });
    t.revalidate.mockImplementation(async () => { if (t.archive.get.mock.calls.length) throw new Error('revoked after GET'); });
    await expect(readUsSupplierOriginal(t.archive, t.document, t.revalidate)).rejects.toThrow('revoked after GET');
    expect(t.archive.get).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects changed input and foreign/malformed IDs before object access', async () => {
    const t = await fixture();
    await expect(retainUsSupplierOriginal(t.archive, t.document, new Uint8Array([1]), t.revalidate)).rejects.toThrow('supplier_document_conflict');
    await expect(readUsSupplierOriginal(t.archive, { ...t.document, id: '../other' }, t.revalidate)).rejects.toThrow();
    expect(t.archive.put).not.toHaveBeenCalled(); expect(t.archive.get).not.toHaveBeenCalled();
  });
});
