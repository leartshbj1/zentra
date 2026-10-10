import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserUsSupplierDocumentsSession, validateBrowserUsSupplierDocument } from './browser-us-supplier-documents-session';
import { browserUsSupplierDocumentError, browserUsSupplierDocumentsCopy } from './browser-us-supplier-documents-copy';
import { sha256Hex } from './canonical-hash';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { US_SUPPLIER_FIELDS, validateUsSupplierExtraction } from './us-supplier-extraction';
import type { UsSupplierDocument } from './us-supplier-document-contract';

const organizationId = '54b7ee3b-5753-4af1-98f6-b2a568fb3890', expectedUserId = 'fixture-accountant';
const id = 'af6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', otherId = 'bf6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', proposalId = '0a6e5eae-23c8-4535-bb3c-a8eafc1bf8a7';
const text = 'Fictitious Harbor supplier invoice US-1043. USD 1,000.00 subtotal, 82.50 tax, 1,082.50 total. April 5, 2026. Due May 5, 2026.';
const bytes = new TextEncoder().encode(text), input = () => ({ fileName: 'Original épreuve.txt', mediaType: 'text/plain' as const, bytes: bytes.slice().buffer });
async function document(patch: Partial<UsSupplierDocument> = {}): Promise<UsSupplierDocument> { return { schemaVersion: 1, organizationId, id, contentSha256: await sha256Hex(text), sizeBytes: bytes.length, mediaType: 'text/plain', fileName: input().fileName, createdBy: expectedUserId, createdAt: '2026-10-10T12:00:00.000Z', readable: true, stored: true, proposalId: null, ...patch }; }
function proposal() { return validateUsSupplierProposal({ schemaVersion: 1, organizationId, id: proposalId, revision: 0, state: 'review', source: { kind: 'document_import', sha256: 'a'.repeat(64), fileName: input().fileName, mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: '2026-10-10T12:00:00.000Z', documentText: text }, extraction: validateUsSupplierExtraction({ schemaVersion: 1, kind: 'vendor_invoice', confidence: 0.99, fields: { supplierName: 'Fictitious Harbor', reference: 'US-1043', invoiceDate: '2026-04-05', dueDate: '2026-05-05', currency: 'USD', netMinor: '100000', printedTaxMinor: '8250', totalMinor: '108250' }, evidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 'Fictitious printed evidence'])), fieldConfidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 0.99])), issues: [] }), createdBy: expectedUserId, createdAt: '2026-10-10T12:00:00.000Z' }, organizationId); }
function session(fetcher: typeof fetch, extra: Record<string, unknown> = {}) { return createBrowserUsSupplierDocumentsSession({ organizationId, expectedUserId, role: 'accountant', supportedSchemaVersion: 4, newId: () => id, fetch: fetcher, ...extra }); }
const requestUrl = (url: RequestInfo | URL) => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => vi.restoreAllMocks());

describe('US supplier originals browser transport', () => {
  it('requires an admitted list, sends raw bytes and URI filename with identity/schema, then verifies the downloaded binary', async () => {
    const row = await document(), calls: { url: string; request: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, request = {}) => { calls.push({ url: requestUrl(url), request }); return request.method === 'PUT' ? json({ document: row, replayed: false }) : requestUrl(url).endsWith('/content') ? new Response(bytes, { headers: { 'Content-Type': 'text/plain' } }) : json({ documents: [row] }); });
    const s = session(fetcher); await expect(s.import(input())).rejects.toMatchObject({ code: 'read_required' });
    expect(await s.load()).toEqual([row]); expect(await s.import(input())).toMatchObject({ action: 'import', document: row });
    const put = calls.find(value => value.request.method === 'PUT')!;
    expect(put.url).toBe(`/api/international/workspaces/${organizationId}/supplier-documents/${id}`);
    expect(new Uint8Array(put.request.body as ArrayBuffer)).toEqual(bytes); expect(put.request.headers).toMatchObject({ 'X-Zentra-File-Name': encodeURIComponent(input().fileName), 'Content-Type': 'text/plain', 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': expectedUserId });
    expect(put.request).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(await (await s.download(row)).text()).toBe(text); expect(s.hasPending()).toBe(false); s.dispose();
  });
  it('keeps the original id and detached bytes after a lost write response', async () => {
    const row = await document(), bodies: Uint8Array[] = [], paths: string[] = []; let count = 0;
    const s = session(vi.fn<typeof fetch>(async (url, request = {}) => { if (request.method !== 'PUT') return json({ documents: [] }); bodies.push(new Uint8Array(request.body as ArrayBuffer).slice()); paths.push(requestUrl(url)); if (++count === 1) throw new Error('lost response with private message'); return json({ document: row, replayed: true }); }));
    await s.load(); const value = input(); const first = s.import(value); value.bytes = new ArrayBuffer(3);
    await expect(first).rejects.toMatchObject({ code: 'service_unavailable', outcome: 'uncertain' }); expect(s.pendingAction()).toBe('import');
    await expect(s.import(input())).rejects.toMatchObject({ code: 'pending_operation' }); await s.retry(); expect(paths[0]).toBe(paths[1]); expect(bodies[0]).toEqual(bytes); expect(bodies[1]).toEqual(bytes); expect(s.hasPending()).toBe(false);
  });
  it('accepts canonical same-binary dedupe without replacing its first filename or author', async () => {
    const row = await document({ id: otherId, createdBy: 'first-author', fileName: 'First original.txt' });
    const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => request.method === 'PUT' ? json({ document: row, replayed: true }) : json({ documents: [] })));
    await s.load(); expect((await s.import(input())).document).toEqual(row);
  });
  it('defers stale list results after a later mutation and after another newer list', async () => {
    const row = await document(), old = deferred<Response>(); let reads = 0;
    const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => request.method === 'PUT' ? json({ document: row, replayed: false }) : ++reads === 2 ? old.promise : json({ documents: reads === 1 ? [] : [row] })));
    await s.load(); const delayed = s.load(); await s.import(input()); old.resolve(json({ documents: [] })); await expect(delayed).rejects.toMatchObject({ code: 'stale_read' }); expect(await s.load()).toEqual([row]);
    const older = deferred<Response>(), newer = deferred<Response>(); let n = 0; const parallel = session(vi.fn<typeof fetch>(async () => ++n === 1 ? older.promise : newer.promise));
    const a = parallel.load(), b = parallel.load(); newer.resolve(json({ documents: [row] })); await b; older.resolve(json({ documents: [] })); await expect(a).rejects.toMatchObject({ code: 'stale_read' });
  });
  it('sends only explicit consent and keeps exact analyze body through an uncertain retry', async () => {
    const row = await document(), linked = { ...row, proposalId }, bodies: string[] = []; let n = 0;
    const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => { if (request.method !== 'POST') return json({ documents: [row] }); bodies.push(typeof request.body === 'string' ? request.body : ''); return ++n === 1 ? json({ error: 'configuration_changed' }, 409) : json({ document: linked, proposal: proposal(), replayed: true }); }));
    await s.load(); await expect(s.analyze(row, true)).rejects.toMatchObject({ outcome: 'uncertain' }); expect(s.hasPending()).toBe(true); expect(await s.retry()).toMatchObject({ action: 'analyze', document: linked }); expect(bodies).toEqual(['{"schemaVersion":1,"action":"analyze","consent":true}', '{"schemaVersion":1,"action":"analyze","consent":true}']);
  });
  it('keeps Gestion originals and download after Automation 402 and clears only the denied analysis', async () => {
    const row = await document(); const s = session(vi.fn<typeof fetch>(async (url, request = {}) => request.method === 'POST' ? json({ error: 'automation_entitlement_required' }, 402) : requestUrl(url).endsWith('/content') ? new Response(bytes, { headers: { 'Content-Type': 'text/plain' } }) : json({ documents: [row] })));
    expect(await s.load()).toEqual([row]); await expect(s.analyze(row, true)).rejects.toMatchObject({ code: 'automation_entitlement_required', outcome: 'rejected' }); expect(s.hasPending()).toBe(false); expect(await (await s.download(row)).text()).toBe(text); expect(await s.load()).toEqual([row]);
  });
  it.each([401, 403, 402])('purges exact pending on Gestion/auth loss %s, including malformed 402', async status => {
    const row = await document(); let deny = false; const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => deny ? new Response('private failure', { status }) : request.method === 'PUT' ? json({ error: 'supplier_document_archive_unavailable' }, 503) : json({ documents: [row] })));
    await s.load(); await expect(s.import(input())).rejects.toMatchObject({ outcome: 'uncertain' }); expect(s.hasPending()).toBe(true); deny = true; await expect(s.retry()).rejects.toMatchObject({ outcome: 'unauthorized' }); expect(s.hasPending()).toBe(false); await expect(s.retry()).rejects.toMatchObject({ code: 'session_changed' });
  });
  it.each(['feature_unavailable', 'edition_unavailable', 'client_upgrade_required', 'supplier_upgrade_required'])('purges pending when the confirmed gate closes: %s', async error => {
    const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => request.method === 'PUT' ? json({ error }, 409) : json({ documents: [] }))); await s.load(); await expect(s.import(input())).rejects.toMatchObject({ outcome: 'unauthorized' }); expect(s.hasPending()).toBe(false);
  });
  it('refuses an unlinked analyze conflict and preserves the immutable proposal result already visible', async () => {
    const row = await document(), originalProposal = proposal(); const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => request.method === 'POST' ? json({ error: 'supplier_source_conflict' }, 409) : json({ documents: [row] })));
    await s.load(); await expect(s.analyze(row, true)).rejects.toMatchObject({ code: 'supplier_source_conflict', outcome: 'rejected' }); expect(originalProposal.source.fileName).toBe(input().fileName); expect(s.hasPending()).toBe(false);
  });
  it.each([{ stored: false }, { readable: false }])('does not analyze an unready original: %j', async patch => {
    const row = await document(patch), fetcher = vi.fn<typeof fetch>(async () => json({ documents: [row] })), s = session(fetcher); await s.load(); await expect(s.analyze(row, true)).rejects.toMatchObject({ code: 'supplier_source_unreadable' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['text/plain', 'application/pdf', 'image/png', 'image/jpeg'])('supports bounded original media %s without guessing a type', async mediaType => {
    const row = await document({ mediaType: mediaType as UsSupplierDocument['mediaType'] }), s = session(vi.fn<typeof fetch>(async (_url, request = {}) => request.method === 'PUT' ? json({ document: row, replayed: false }) : json({ documents: [] }))); await s.load(); expect((await s.import({ ...input(), mediaType: row.mediaType })).document.mediaType).toBe(mediaType);
  });
  it('refuses cross-workspace, private fields, duplicates, corrupt bytes, wrong media and oversized bodies', async () => {
    const row = await document();
    for (const value of [{ ...row, organizationId: otherId }, { ...row, documentText: text }, { ...row, contentSha256: 'bad' }, { ...row, sizeBytes: 7 * 1024 * 1024 }, { ...row, proposalId, readable: false }]) expect(() => validateBrowserUsSupplierDocument(value, organizationId)).toThrow();
    const duplicate = session(vi.fn<typeof fetch>(async () => json({ documents: [row, row] }))); await expect(duplicate.load()).rejects.toMatchObject({ code: 'invalid_response' });
    for (const response of [new Response('corrupt', { headers: { 'Content-Type': 'text/plain' } }), new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } }), new Response(bytes, { headers: { 'Content-Type': 'text/plain', 'Content-Length': String(7 * 1024 * 1024) } })]) { const s = session(vi.fn<typeof fetch>(async () => response)); await expect(s.download(row)).rejects.toMatchObject({ code: 'invalid_response' }); }
  });
  it('disposes during a delayed response body and rejects the late result with pending cleared', async () => {
    const row = await document(), held = deferred<ReadableStreamDefaultController<Uint8Array>>();
    const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => request.method === 'PUT' ? new Response(new ReadableStream({ start(controller) { held.resolve(controller); } }), { headers: { 'Content-Type': 'application/json' } }) : json({ documents: [] })));
    await s.load(); const operation = s.import(input()); const controller = await held.promise; expect(s.hasPending()).toBe(true); s.dispose(); controller.enqueue(new TextEncoder().encode(JSON.stringify({ document: row, replayed: false }))); controller.close(); await expect(operation).rejects.toMatchObject({ code: 'session_changed' }); expect(s.hasPending()).toBe(false);
  });
  it('disposes during binary digest verification and never returns the late Blob', async () => {
    const row = await document(), computed = deferred<ArrayBuffer>(), entered = deferred<void>(); vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => { entered.resolve(); return computed.promise; });
    const s = session(vi.fn<typeof fetch>(async () => new Response(bytes, { headers: { 'Content-Type': 'text/plain' } }))), download = s.download(row); await entered.promise; s.dispose(); computed.resolve(new Uint8Array(32).buffer); await expect(download).rejects.toMatchObject({ code: 'session_changed' });
  });
  it('times out a write as uncertain and safely retries only its original envelope', async () => {
    const row = await document(); let count = 0; const s = session(vi.fn<typeof fetch>(async (_url, request = {}) => request.method !== 'PUT' ? json({ documents: [] }) : ++count === 1 ? new Promise(() => {}) : json({ document: row, replayed: true })), { timeoutMs: 5 });
    await s.load(); await expect(s.import(input())).rejects.toMatchObject({ code: 'response_timeout', outcome: 'uncertain' }); expect(s.hasPending()).toBe(true); await s.retry(); expect(s.hasPending()).toBe(false);
  });
  it.each(['en', 'fr', 'de', 'it'] as const)('provides bounded translated feedback for %s without rendering private errors', language => {
    const c = browserUsSupplierDocumentsCopy[language]; expect(browserUsSupplierDocumentError(language, 'private-secret-token')).toBe(c.unavailable); expect(browserUsSupplierDocumentError(language, 'automation_entitlement_required')).toBe(c.quota); expect(browserUsSupplierDocumentError(language, 'supplier_source_conflict')).toBe(c.conflict); expect(c.retry).toBeTruthy(); expect(c.unreadable).toBeTruthy();
  });
});
