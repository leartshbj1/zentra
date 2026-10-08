import { describe, expect, it, vi } from 'vitest';
import { browserExportUrl, createBrowserExportSession, BrowserExportError } from './browser-export-session';
import { browserSalesFixture } from './browser-sales-test-fixture';
import { buildUsExportSnapshot, type ExportSelector, type ExportSnapshot } from './export-snapshot';
import { canonicalErpJson } from './erp-contract';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
const org = 'fictitious-sales-company', user = 'fictitious-owner', selector: ExportSelector = { kind: 'report', reportType: 'trial_balance', asOf: '2026-12-31' };
const digest = async (value: ArrayBuffer | Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join('');
const fixture = async (): Promise<ExportSnapshot> => buildUsExportSnapshot(await browserSalesFixture(), { organizationId: org, displayName: 'Fictitious seller' }, selector, 'en');
async function response(snapshot: ExportSnapshot, format: 'json' | 'pdf' | 'html' | 'csv' = 'json', extra: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(format === 'json' ? JSON.stringify(snapshot) : format === 'pdf' ? '%PDF-1.7\nFictitious transport bytes' : format === 'html' ? '<!doctype html><p>Fictitious printable file</p>' : 'Fictitious CSV');
  const headers = { 'Content-Type': { json: 'application/json', pdf: 'application/pdf', html: 'text/html', csv: 'text/csv' }[format], 'Content-Disposition': `${format === 'json' || format === 'html' ? 'inline' : 'attachment'}; filename="trial_balance-r7-en.${format}"`, 'X-Zentra-Organization-Id': org, 'X-Zentra-Currency': 'USD', 'X-Zentra-Export-Language': 'en', 'X-Zentra-Export-Format': format, 'X-Zentra-Erp-Revision': String(snapshot.erpRevision), 'X-Zentra-Ledger-Revision': String(snapshot.ledgerRevision), 'X-Zentra-Content-SHA256': await digest(bytes), 'X-Zentra-Export-Selector-SHA256': await digest(new TextEncoder().encode(canonicalErpJson(snapshot.selector))), ...(snapshot.recordRevision === null ? {} : { 'X-Zentra-Record-Revision': String(snapshot.recordRevision) }), ...extra };
  return new Response(bytes, { headers });
}
describe('cookie-only verified US exports browser transport', () => {
  it('encodes only selectors and language; never puts identity or secrets in URL', () => {
    expect(browserExportUrl(org, selector, 'de', 'pdf')).toBe(`/api/international/workspaces/${org}/exports/reports/trial_balance?format=pdf&language=de&asOf=2026-12-31`);
    expect(browserExportUrl(org, { kind: 'document', documentType: 'invoice', id: 'invoice-1' }, 'en', 'json')).toContain('/documents/invoice/invoice-1?format=json&language=en');
    expect(() => browserExportUrl('../other', selector, 'en', 'pdf')).toThrow(); expect(() => browserExportUrl(org, { ...selector, asOf: '2026-02-30' }, 'en', 'pdf')).toThrow();
  });
  it('checks a detached exact public snapshot and cookie/header request contract', async () => {
    const snapshot = await fixture(), fetcher = vi.fn(async () => response(snapshot)); const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, supportedSchemaVersion: 2, fetch: fetcher });
    const value = await session.load(selector, 'en', snapshot.erpRevision); expect(value).toEqual(snapshot); expect(Object.isFrozen(value.rows)).toBe(true);
    expect(fetcher.mock.calls[0]).toEqual([browserExportUrl(org, selector, 'en', 'json'), expect.objectContaining({ method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json', 'X-Zentra-Expected-User': user, [ERP_SCHEMA_HEADER]: '2' } })]); session.dispose();
  });
  it.each(['pdf', 'html', 'csv'] as const)('returns verified %s bytes without executing or opening them', async format => {
    const snapshot = await fixture(), session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => response(snapshot, format) });
    const result = await session.file(selector, 'en', snapshot.erpRevision, format, snapshot.erpRevision); expect(result.filename.endsWith(`.${format}`)).toBe(true); expect(result.erpRevision).toBe(snapshot.erpRevision); expect(result.blob.size).toBeGreaterThan(0); session.dispose();
  });
  it.each([{ 'Content-Type': 'text/html' }, { 'X-Zentra-Organization-Id': 'other-company' }, { 'X-Zentra-Currency': 'CHF' }, { 'X-Zentra-Export-Language': 'fr' }, { 'X-Zentra-Export-Format': 'pdf' }, { 'X-Zentra-Erp-Revision': '999999999999999999' }, { 'X-Zentra-Ledger-Revision': '99' }, { 'X-Zentra-Record-Revision': '0' }, { 'X-Zentra-Content-SHA256': 'f'.repeat(64) }, { 'X-Zentra-Export-Selector-SHA256': 'f'.repeat(64) }, { 'Content-Disposition': 'attachment; filename="../secret.json"' }])('rejects mismatched metadata/bytes %j', async extra => {
    const snapshot = await fixture(), session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => response(snapshot, 'json', Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))) }); await expect(session.load(selector, 'en', snapshot.erpRevision)).rejects.toBeInstanceOf(BrowserExportError); session.dispose();
  });
  it('rejects an unexpected selector even with self-consistent headers and digest', async () => {
    const state = await browserSalesFixture(), snapshot = buildUsExportSnapshot(state, { organizationId: org, displayName: 'Fictitious seller' }, { ...selector, asOf: '2026-10-08' }, 'en'); const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => response(snapshot) }); await expect(session.load(selector, 'en', 1)).rejects.toMatchObject({ code: 'invalid_export_response' }); session.dispose();
  });
  it('refuses stale and changed report exports instead of silently changing the shown report', async () => {
    const snapshot = await fixture(), session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => response(snapshot, 'pdf') }); await expect(session.file(selector, 'en', snapshot.erpRevision + 1, 'pdf')).rejects.toMatchObject({ code: 'export_revision_changed' }); await expect(session.file(selector, 'en', 1, 'pdf', snapshot.erpRevision - 1)).rejects.toMatchObject({ code: 'export_revision_changed' }); session.dispose();
  });
  it.each([401, 402, 403])('denies at %s headers without waiting on the private body and permanently invalidates the session', async status => {
    const privateBody = vi.fn(), session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => ({ status, ok: false, json: privateBody } as unknown as Response) }); await expect(session.load(selector, 'en', 1)).rejects.toMatchObject({ status, unauthorized: true }); expect(privateBody).not.toHaveBeenCalled(); await expect(session.load(selector, 'en', 1)).rejects.toMatchObject({ unauthorized: true });
  });
  it('disposal aborts and withholds a private response that resolves late', async () => {
    const snapshot = await fixture(); let release: ((value: Response) => void) | undefined, signal: AbortSignal | null = null;
    const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async (_url, init) => { signal = init?.signal ?? null; return new Promise<Response>(done => { release = done; }); } });
    const outcome = session.load(selector, 'en', 1), rejected = expect(outcome).rejects.toMatchObject({ unauthorized: true }); session.dispose(); await rejected; release!(await response(snapshot)); expect(signal!.aborted).toBe(true);
  });
  it('times out an indefinitely stalled response and does not return a replacement document', async () => {
    const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, timeoutMs: 10, fetch: async () => new Promise<Response>(() => {}) }); await expect(session.load(selector, 'en', 1)).rejects.toMatchObject({ code: 'export_timeout' }); session.dispose();
  });
  it('does not reveal arbitrary server debug text', async () => {
    const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => new Response('{"error":"sensitive raw database and token"}', { status: 503, headers: { 'Content-Type': 'application/json' } }) }); await expect(session.load(selector, 'en', 1)).rejects.toMatchObject({ code: 'export_unavailable' }); session.dispose();
  });
  it('invalidates an outstanding response when another export observes revocation', async () => {
    const snapshot = await fixture(); let release: ((value: Response) => void) | undefined, calls = 0;
    const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => ++calls === 1 ? new Promise<Response>(done => { release = done; }) : new Response('{}', { status: 403 }) });
    const first = session.load(selector, 'en', 1), firstRejected = expect(first).rejects.toMatchObject({ unauthorized: true }), failed = session.load(selector, 'en', 1); await expect(failed).rejects.toMatchObject({ unauthorized: true }); await firstRejected; release!(await response(snapshot));
  });
  it('disposal settles a stalled body immediately even when the transport ignores AbortSignal', async () => {
    const snapshot = await fixture(), original = await response(snapshot); let bodyReached!: () => void;
    const reached = new Promise<void>(done => { bodyReached = done; });
    const stalled = { status: 200, ok: true, headers: original.headers, arrayBuffer: () => { bodyReached(); return new Promise<ArrayBuffer>(() => {}); } } as unknown as Response;
    const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => stalled });
    const reading = session.load(selector, 'en', 1), rejected = expect(reading).rejects.toMatchObject({ code: 'session_changed', unauthorized: true }); await reached; session.dispose(); await rejected;
  });
  it('revokes created download URLs on disposal and rejects files from another session', async () => {
    const snapshot = await fixture(), session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => response(snapshot, 'pdf') }), other = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => response(snapshot, 'pdf') });
    const click = vi.fn(), create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:isolated-test'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: () => ({ click }) });
    try { const result = await session.file(selector, 'en', 1, 'pdf'); expect(() => other.download(result)).toThrow(); session.download(result); expect(click).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce(); session.dispose(); expect(revoke).toHaveBeenCalledWith('blob:isolated-test'); expect(() => session.download(result)).toThrow(); }
    finally { session.dispose(); other.dispose(); vi.unstubAllGlobals(); create.mockRestore(); revoke.mockRestore(); }
  });
  it.each(['seller_configuration_required', 'unsupported_export_glyph', 'configuration_changed', 'rate_limited'])('keeps only the public recoverable error %s', async code => {
    const session = createBrowserExportSession({ organizationId: org, expectedUserId: user, fetch: async () => Response.json({ error: code }, { status: code === 'rate_limited' ? 429 : 409 }) }); await expect(session.load(selector, 'en', 1)).rejects.toMatchObject({ code }); session.dispose();
  });
});
