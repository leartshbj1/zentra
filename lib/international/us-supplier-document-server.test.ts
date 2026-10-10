import { describe, expect, it, vi } from 'vitest';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { usStarterChart } from './countries/us/accounting';
import { sha256Hex } from './canonical-hash';
import { ErpError } from './erp-contract';
import type { ErpState } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { UsSupplierDocumentArchive } from './us-supplier-document-archive';
import { createUsSupplierDocumentHandlers, type UsSupplierDocumentServerDependencies } from './us-supplier-document-server';
import { validateUsSupplierDocumentDescriptor, validateUsSupplierDocumentRecord, type UsSupplierDocument, type UsSupplierDocumentRecord, type UsSupplierDocumentStore } from './us-supplier-document-contract';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { validateUsSupplierExtraction, US_SUPPLIER_FIELDS } from './us-supplier-extraction';
import type { UsSupplierProposal } from './us-supplier-contract';
const org = '54b7ee3b-5753-4af1-98f6-b2a568fb3890', user = '53e1704e-9cc6-431b-ac4d-2186c5fe5f6d', id = 'af6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', proposalId = '0a6e5eae-23c8-4535-bb3c-a8eafc1bf8a7';
const otherId = 'bf6e5eae-23c8-4535-bb3c-a8eafc1bf8a7', foreignOrg = '64b7ee3b-5753-4af1-98f6-b2a568fb3890';
const actor: FinancialAuthority = { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: '2026-10-10T12:00:00.000Z' };
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const text = 'Harbor Supplies LLC\nInvoice Number US-1043\nInvoice Date April 5 2026\nDue Date May 5 2026\nSubtotal USD 1,000.00\nSales Tax USD 82.50\nTotal USD 1,082.50';
const extraction = validateUsSupplierExtraction({ schemaVersion: 1, kind: 'vendor_invoice', confidence: 0.99,
  fields: { supplierName: 'Harbor Supplies LLC', reference: 'US-1043', invoiceDate: '2026-04-05', dueDate: '2026-05-05', currency: 'USD', netMinor: '100000', printedTaxMinor: '8250', totalMinor: '108250' },
  evidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 'Fictitious printed evidence'])), fieldConfidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 0.99])), issues: [] });
function fixture() {
  const rows = new Map<string, UsSupplierDocumentRecord>(), objects = new Map<string, Uint8Array>();
  let proposal: UsSupplierProposal | null = null;
  const state: ErpState = { schemaVersion: 4, revision: 10, configuration, counters: { estimate: 0, invoice: 0, project: 0 }, ledger: createLedger({ organizationId: org, currency: 'USD', basis: 'accrual', accounts: usStarterChart, periods: [] }), customers: [], estimates: [], invoices: [], projects: [], vendors: [], vendorBills: [], vendorPayments: [] };
  const store = {
    list: vi.fn<UsSupplierDocumentStore['list']>(async () => structuredClone([...rows.values()])), read: vi.fn<UsSupplierDocumentStore['read']>(async (_actor, key) => structuredClone(rows.get(key) ?? null)),
    reserve: vi.fn<UsSupplierDocumentStore['reserve']>(async (fresh, input) => {
      const descriptor = validateUsSupplierDocumentDescriptor(input, org), old = rows.get(input.id) ?? [...rows.values()].find(value => value.contentSha256 === input.contentSha256);
      if (old) return structuredClone(old);
      const row = validateUsSupplierDocumentRecord({ ...descriptor, createdBy: fresh.userId, stored: false, proposalId: null }, org); rows.set(row.id, row); return structuredClone(row);
    }),
    complete: vi.fn<UsSupplierDocumentStore['complete']>(async (_actor, key) => { const row = { ...rows.get(key)!, stored: true }; rows.set(key, row); return structuredClone(row); }),
    link: vi.fn<UsSupplierDocumentStore['link']>(async (_actor, key, value) => {
      if ([...rows.values()].some(row => row.proposalId === value.id && row.id !== key)) throw new ErpError('supplier_document_conflict', 409);
      const row = { ...rows.get(key)!, proposalId: value.id }; rows.set(key, row); return structuredClone(row);
    }),
  } satisfies UsSupplierDocumentStore;
  const archive = {
    put: vi.fn<UsSupplierDocumentArchive['put']>(async (key, bytes) => { if (objects.has(key)) return null; objects.set(key, bytes.slice()); return {}; }),
    get: vi.fn<UsSupplierDocumentArchive['get']>(async key => { const bytes = objects.get(key); return bytes ? { size: bytes.length, body: new Blob([Uint8Array.from(bytes)]).stream() } : null; }),
  } satisfies UsSupplierDocumentArchive;
  const dependencies: UsSupplierDocumentServerDependencies = {
    enabled: () => true, authority: vi.fn(async () => ({ mode: 'browser' as const, actor: structuredClone(actor) })), configuration: vi.fn(async () => structuredClone(configuration)),
    store: () => ({ supportedSchemaVersion: 4, read: async () => structuredClone(state), receipt: async () => null, commit: async () => { throw new Error('financial writes forbidden'); } }), freshSupportedSchemaVersion: () => 4,
    documentStore: () => store, archive: () => archive, automationAccess: vi.fn(async () => {}), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn(),
    prepareAnalysis: vi.fn(async input => {
      await input.revalidate();
      if (proposal) return { proposal, replayed: true };
      proposal = validateUsSupplierProposal({ schemaVersion: 1, organizationId: org, id: proposalId, revision: 0, state: 'review', source: input.source, extraction, createdBy: input.actor.userId, createdAt: input.actor.timestamp }, org);
      return { proposal, replayed: false };
    }),
  };
  const handlers = createUsSupplierDocumentHandlers(dependencies), url = `https://zentra.test/api/international/workspaces/${org}/supplier-documents`;
  const request = (method = 'GET', body?: BodyInit, extra: Record<string, string> = {}) => new Request(url, { method, headers: { 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': user, ...(method === 'GET' ? {} : { Origin: 'https://zentra.test' }), ...extra }, ...(body === undefined ? {} : { body }) });
  const upload = (value = text, key = id, extra: Record<string, string> = {}) => handlers.PUT(request('PUT', value, { 'Content-Type': 'text/plain', 'X-Zentra-File-Name': 'original.txt', ...extra }), org, key);
  const analyze = (key = id, value: unknown = { schemaVersion: 1, action: 'analyze', consent: true }) => handlers.ANALYZE(request('POST', JSON.stringify(value), { 'Content-Type': 'application/json' }), org, key);
  return { rows, objects, store, archive, dependencies, handlers, upload, analyze, request, state };
}
async function rejected(response: Response, error: string, status: number) { expect(response.status).toBe(status); expect(await response.json()).toEqual({ error }); expect(response.headers.get('Cache-Control')).toContain('no-store'); }
describe('US supplier original HTTP boundary', () => {
  it('uploads, lists, downloads and analyzes without a financial write', async () => {
    const t = fixture(), before = structuredClone(t.state);
    const response = await t.upload(); expect(response.status).toBe(200);
    const uploaded = await response.json() as { document: Record<string, unknown> }; expect(uploaded).toMatchObject({ replayed: false, document: { id, stored: true, readable: true, proposalId: null } });
    expect(uploaded.document.documentText).toBeUndefined(); expect(uploaded.document.textSha256).toBeUndefined();
    const list = await (await t.handlers.GET(t.request(), org)).json() as { documents: UsSupplierDocument[] }; expect(list.documents).toHaveLength(1); expect(JSON.stringify(list)).not.toContain(text); expect(JSON.stringify(list)).not.toContain('supplier-originals');
    const downloaded = await t.handlers.CONTENT(t.request(), org, id); expect(downloaded.status).toBe(200); expect(await downloaded.text()).toBe(text);
    expect(downloaded.headers.get('Content-Disposition')).toContain('attachment'); expect(downloaded.headers.get('Content-Security-Policy')).toContain('sandbox');
    const prepared = await t.analyze(); expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({ document: { proposalId }, proposal: { state: 'review', source: { sha256: await sha256Hex(text), mediaType: 'text/plain', documentText: text } }, replayed: false });
    expect(await (await t.analyze()).json()).toMatchObject({ replayed: true }); expect(t.rows.size).toBe(1); expect(t.state).toEqual(before);
  });
  it('retains an image but does not send invented OCR to analysis', async () => {
    const t = fixture(); const response = await t.handlers.PUT(t.request('PUT', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), { 'Content-Type': 'image/png', 'X-Zentra-File-Name': 'photo.png' }), org, id);
    expect(await response.json()).toMatchObject({ document: { stored: true, readable: false } });
    await rejected(await t.analyze(), 'supplier_source_unreadable', 422); expect(t.dependencies.prepareAnalysis).not.toHaveBeenCalled();
  });
  it('keeps binary and extracted-text hashes separate for a PDF', async () => {
    const t = fixture(); t.dependencies.extractText = vi.fn(async () => text);
    const raw = '%PDF-1.7\nFictitious bytes';
    expect((await t.handlers.PUT(t.request('PUT', raw, { 'Content-Type': 'application/pdf', 'X-Zentra-File-Name': 'invoice.pdf' }), org, id)).status).toBe(200);
    expect(t.rows.get(id)?.contentSha256).toBe(await sha256Hex(raw)); expect(t.rows.get(id)?.textSha256).toBe(await sha256Hex(text));
    expect((await t.analyze()).status).toBe(200);
    expect(vi.mocked(t.dependencies.prepareAnalysis).mock.calls[0][0].source.sha256).toBe(await sha256Hex(text));
  });
  it('replays exact uploads without rerunning extraction and preserves original identity across a duplicate ID', async () => {
    const t = fixture(); t.dependencies.extractText = vi.fn(async () => text); await t.upload();
    t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, timestamp: '2026-10-10T13:00:00.000Z' } });
    expect(await (await t.upload()).json()).toMatchObject({ replayed: true, document: { createdAt: actor.timestamp } });
    expect(t.dependencies.extractText).toHaveBeenCalledTimes(1);
    expect(await (await t.upload(text, otherId)).json()).toMatchObject({ replayed: true, document: { id } }); expect(t.rows.size).toBe(1); expect(t.objects.size).toBe(1);
    await rejected(await t.upload(text + 'changed'), 'supplier_document_conflict', 409);
  });
  it('recovers an upload whose completion response was lost', async () => {
    const t = fixture(), complete = t.store.complete; let once = true;
    t.store.complete = vi.fn<UsSupplierDocumentStore['complete']>(async (...args) => { const result = await complete(...args); if (once) { once = false; throw new Error('response lost'); } return result; });
    await rejected(await t.upload(), 'service_unavailable', 503);
    expect(await (await t.upload()).json()).toMatchObject({ replayed: true, document: { stored: true } }); expect(t.objects.size).toBe(1);
  });
  it('recovers a committed provenance link after its response was lost', async () => {
    const t = fixture(); await t.upload(); const link = t.store.link; let once = true;
    t.store.link = vi.fn<UsSupplierDocumentStore['link']>(async (...args) => { const result = await link(...args); if (once) { once = false; throw new Error('link response lost'); } return result; });
    await rejected(await t.analyze(), 'service_unavailable', 503); expect(t.rows.get(id)?.proposalId).toBe(proposalId);
    expect(await (await t.analyze()).json()).toMatchObject({ replayed: true, document: { proposalId } });
    expect(t.rows.size).toBe(1); expect(t.state.vendorBills).toHaveLength(0);
  });
  it('does not grant Automation from Gestion archive rights', async () => {
    const t = fixture(); t.dependencies.automationAccess = vi.fn(async () => { throw new ErpError('automation_entitlement_required', 402); });
    expect((await t.upload()).status).toBe(200); expect((await t.handlers.GET(t.request(), org)).status).toBe(200); expect((await t.handlers.CONTENT(t.request(), org, id)).status).toBe(200);
    expect(t.dependencies.automationAccess).not.toHaveBeenCalled(); await rejected(await t.analyze(), 'automation_entitlement_required', 402);
  });
  it.each(['user', 'role', 'management', 'mode', 'country', 'flag', 'capability'] as const)('withholds delayed original after %s changes', async change => {
    const t = fixture(); await t.upload(); const original = t.archive.get;
    t.archive.get = vi.fn<UsSupplierDocumentArchive['get']>(async (...args) => {
      const data = await original(...args);
      if (change === 'user') t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, userId: foreignOrg } });
      if (change === 'role') t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, role: 'accountant' } });
      if (change === 'management') t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, managementEntitled: false } });
      if (change === 'mode') t.dependencies.authority = async () => ({ mode: 'device', actor });
      if (change === 'country') t.dependencies.configuration = async () => ({ ...configuration, timeZone: 'America/Chicago' });
      if (change === 'flag') t.dependencies.enabled = () => false;
      if (change === 'capability') t.dependencies.freshSupportedSchemaVersion = () => 3;
      return data;
    });
    const response = await t.handlers.CONTENT(t.request(), org, id); expect([401, 402, 403, 404, 409]).toContain(response.status); expect(await response.text()).not.toContain(text);
  });
  it('supersedes a storage failure with fresh revoked identity and sanitizes logs', async () => {
    const t = fixture(); await t.upload();
    t.archive.get = vi.fn<UsSupplierDocumentArchive['get']>(async () => { t.dependencies.authority = async () => { throw new ErpError('unauthorized', 401); }; throw new Error('private raw key and provider secret'); });
    await rejected(await t.handlers.CONTENT(t.request(), org, id), 'unauthorized', 401);
    expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toMatch(/original.txt|provider secret|supplier-originals/);
  });
  it.each(['member', 'read_only'] as const)('refuses role %s before private archive access', async role => {
    const t = fixture(); t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, role } });
    await rejected(await t.upload(), 'financial_permission_required', 403); expect(t.archive.put).not.toHaveBeenCalled(); expect(t.store.reserve).not.toHaveBeenCalled();
  });
  it('rejects stale user binding, foreign company, CH currency, old capability and cross-origin writes', async () => {
    const t = fixture();
    await rejected(await t.handlers.GET(t.request('GET', undefined, { 'X-Zentra-Expected-User': foreignOrg }), org), 'session_changed', 401);
    await rejected(await t.upload(text, id, { Origin: 'https://evil.test' }), 'forbidden', 403);
    await rejected(await t.upload(text, id, { 'X-Zentra-Erp-Schema-Version': '3' }), 'supplier_upgrade_required', 409);
    t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, organizationId: foreignOrg } });
    await rejected(await t.upload(), 'tenant_mismatch', 403);
    t.dependencies.authority = async () => ({ mode: 'browser', actor }); t.dependencies.configuration = async () => ({ schemaVersion: 1, organizationId: org, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, address: { country: 'CH', line1: '1 Fictitious Street', city: 'Geneva', subdivision: 'GE', postalCode: '1200' } });
    await rejected(await t.upload(), 'edition_unavailable', 409); expect(t.archive.put).not.toHaveBeenCalled();
  });
  it('validates names, media, real streamed size, missing/reserved documents and consent', async () => {
    const t = fixture();
    for (const name of ['../evil.txt', '%00bad', '%ZZ', '']) await rejected(await t.upload(text, id, { 'X-Zentra-File-Name': name }), 'invalid_supplier_document', 422);
    await rejected(await t.upload(text, id, { 'Content-Type': 'text/html' }), 'invalid_supplier_document', 422);
    await rejected(await t.upload(text, id, { 'Content-Length': '6291457' }), 'invalid_supplier_document', 413);
    await rejected(await t.handlers.CONTENT(t.request(), org, id), 'supplier_document_not_found', 404);
    await t.upload();
    for (const input of [{ schemaVersion: 1, action: 'analyze', consent: false }, { schemaVersion: 1, action: 'analyze', consent: true, text: 'replace' }]) await rejected(await t.analyze(id, input), 'invalid_supplier_document', 422);
    t.rows.set(id, { ...t.rows.get(id)!, stored: false });
    await rejected(await t.handlers.CONTENT(t.request(), org, id), 'supplier_document_archive_unavailable', 503); expect(t.dependencies.prepareAnalysis).not.toHaveBeenCalled();
  });
  it('rejects corrupted original bytes before analysis or download', async () => {
    const t = fixture(); await t.upload(); for (const key of t.objects.keys()) t.objects.set(key, new Uint8Array(t.objects.get(key)!.length));
    await rejected(await t.analyze(), 'supplier_document_archive_unavailable', 503); await rejected(await t.handlers.CONTENT(t.request(), org, id), 'supplier_document_archive_unavailable', 503); expect(t.dependencies.prepareAnalysis).not.toHaveBeenCalled();
  });
  it('does not adopt a different original producing the same proposal', async () => {
    const t = fixture(); t.dependencies.extractText = async () => text;
    await t.handlers.PUT(t.request('PUT', '%PDF-1.7\nfirst original', { 'Content-Type': 'application/pdf', 'X-Zentra-File-Name': 'first.pdf' }), org, id); await t.analyze();
    await t.handlers.PUT(t.request('PUT', '%PDF-1.7\nsecond original', { 'Content-Type': 'application/pdf', 'X-Zentra-File-Name': 'second.pdf' }), org, otherId);
    await rejected(await t.analyze(otherId), 'supplier_document_conflict', 409); expect(t.rows.get(otherId)?.proposalId).toBeNull();
  });
});
