import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserUsTaxInvoiceSession, validateBrowserUsTaxInvoiceChoices, type BrowserUsTaxInvoiceChoices } from './browser-us-tax-invoice-session';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import type { ErpCommand } from './runtime-types';

const organizationId = 'fictitious-sales-company', key = '00000000-0000-4000-8000-000000000001';
const command: Extract<ErpCommand, { type: 'issue_invoice' }> = { type: 'issue_invoice', id: 'invoice-test', estimateId: 'estimate-2', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-11', dueDate: '2026-11-10', periodId: 'period-2026' };
const choices: BrowserUsTaxInvoiceChoices = { classifications: [{ lineId: 'line-1', taxCode: 'txcd_10000000', confirmedService: true }], taxDateInstant: '2026-10-10T16:00:00.000Z', addressSource: 'billing' };
const prepared = { schemaVersion: 1, organizationId, status: 'prepared_test', idempotencyKey: key, replayed: false };
const receipt = { receipt: { idempotencyKey: key, commandHash: 'a'.repeat(64), revision: 9, entityId: command.id, action: 'issue_invoice' }, replayed: false };
const taxCode = { id: 'txcd_10000000', name: 'Fictitious service', description: 'Synthetic catalogue description, no real tax advice.' };
function fixture(timeoutMs = 1000) {
  const queue: (() => Response | Promise<Response>)[] = [];
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => { const next = queue.shift(); if (!next) throw new Error('No fixture response'); return next(); });
  const newId = vi.fn(() => key);
  const session = createBrowserUsTaxInvoiceSession({ organizationId, expectedUserId: 'fictitious-owner', role: 'owner', supportedSchemaVersion: 4, fetch: fetcher, newId, timeoutMs });
  const enqueue = (value: unknown, status = 200) => queue.push(() => Response.json(value, { status }));
  const paths = () => fetcher.mock.calls.map(([url]) => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).split(organizationId)[1]);
  return { session, fetcher, newId, enqueue, queue, paths };
}
afterEach(() => vi.useRealTimers());
describe('explicit TEST invoice preparation and exact ERP recovery', () => {
  it('prepares then issues one unchanged command using only same-origin cookies and scoped headers', async () => {
    const t = fixture(); t.enqueue(prepared); t.enqueue(receipt); expect(await t.session.submit(command, 8, choices)).toEqual(receipt);
    expect(t.paths()).toEqual(['/tax-invoice-preparation', '/erp']); expect(t.newId).toHaveBeenCalledOnce(); expect(t.session.hasPending()).toBe(false);
    const [preparation, issuance] = t.fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(preparation).toEqual({ request: issuance, choices }); expect(issuance).toEqual({ idempotencyKey: key, expectedRevision: 8, command });
    for (const [, init] of t.fetcher.mock.calls) { expect(init).toMatchObject({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store' }); const headers = new Headers(init!.headers); expect(headers.get(ERP_SCHEMA_HEADER)).toBe('4'); expect(headers.get('X-Zentra-Expected-User')).toBe('fictitious-owner'); expect(headers.has('Authorization')).toBe(false); }
  });
  it('recovers an uncertain preparation with ERP first, then exact preparation only when explicitly required', async () => {
    const t = fixture(), mutableCommand = structuredClone(command), mutableChoices = structuredClone(choices); t.queue.push(() => { throw new Error('private token'); });
    await expect(t.session.submit(mutableCommand, 8, mutableChoices)).rejects.toMatchObject({ code: 'response_unavailable', outcome: 'uncertain' }); const original = t.fetcher.mock.calls[0][1]!.body;
    (mutableCommand as { dueDate: string }).dueDate = '2026-12-01'; (mutableChoices.classifications[0] as { taxCode: string }).taxCode = 'txcd_99999999';
    t.enqueue({ error: 'tax_preparation_required' }, 409); t.enqueue({ ...prepared, replayed: true }); t.enqueue(receipt);
    await t.session.retry(); expect(t.paths()).toEqual(['/tax-invoice-preparation', '/erp', '/tax-invoice-preparation', '/erp']); expect(t.fetcher.mock.calls[2][1]!.body).toBe(original); expect(t.fetcher.mock.calls[1][1]!.body).toBe(t.fetcher.mock.calls[3][1]!.body); expect(t.newId).toHaveBeenCalledOnce();
  });
  it('replays a committed invoice without another preparation or fresh TEST readiness', async () => {
    const t = fixture(); t.enqueue(prepared); t.enqueue({ error: 'service_unavailable' }, 503); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ outcome: 'uncertain' });
    const exact = t.fetcher.mock.calls[1][1]!.body; t.enqueue({ ...receipt, replayed: true }); expect(await t.session.retry()).toMatchObject({ replayed: true }); expect(t.paths()).toEqual(['/tax-invoice-preparation', '/erp', '/erp']); expect(t.fetcher.mock.calls[2][1]!.body).toBe(exact);
  });
  it.each(['tax_preparation_changed', 'tax_preparation_expired', 'tax_binding_changed', 'tax_configuration_changed', 'tax_operation_expired', 'revision_conflict'])('retains uncertainty after %s and never silently mints another key', async code => {
    const t = fixture(); t.enqueue(prepared); t.enqueue({ error: code }, 409); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ code, outcome: 'uncertain' }); expect(t.session.hasPending()).toBe(true);
    await expect(t.session.submit(command, 9, choices)).rejects.toMatchObject({ code: 'pending_operation' }); t.enqueue({ error: code }, 409); await expect(t.session.retry()).rejects.toMatchObject({ code }); expect(t.paths()).toEqual(['/tax-invoice-preparation', '/erp', '/erp']); expect(t.newId).toHaveBeenCalledOnce();
  });
  it.each(['invalid_request', 'invalid_tax_preparation', 'invalid_tax_date', 'unsupported_tax_request'])('allows correcting %s only when the initial preparation was definitively rejected before ERP', async code => {
    const t = fixture(); t.enqueue({ error: code }, 422); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ code, outcome: 'rejected' }); expect(t.session.hasPending()).toBe(false); expect(t.paths()).toEqual(['/tax-invoice-preparation']);
  });
  it('keeps a preparation rejection uncertain after ERP has already been attempted', async () => {
    const t = fixture(); t.queue.push(() => Promise.reject(new Error('lost'))); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ outcome: 'uncertain' });
    t.enqueue({ error: 'tax_preparation_required' }, 409); t.enqueue({ error: 'invalid_tax_preparation' }, 422); await expect(t.session.retry()).rejects.toMatchObject({ outcome: 'uncertain' }); expect(t.session.hasPending()).toBe(true);
  });
  it.each([401, 402, 403])('purges pending and concurrent reads immediately on access loss HTTP %s without waiting for a body', async status => {
    const t = fixture(); t.queue.push(() => Promise.reject(new Error('lost'))); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ outcome: 'uncertain' });
    let resolve!: (response: Response) => void; t.queue.push(() => new Promise(done => { resolve = done; })); const read = t.session.lookup(taxCode.id); const readCheck = expect(read).rejects.toMatchObject({ outcome: 'unauthorized' });
    t.queue.push(() => new Response(new ReadableStream({ start() {} }), { status, headers: { 'Content-Type': 'application/json' } })); await expect(t.session.retry()).rejects.toMatchObject({ status, outcome: 'unauthorized' }); await readCheck;
    expect(t.session.hasPending()).toBe(false); expect(t.fetcher.mock.calls.slice(1).every(([, init]) => init!.signal!.aborted)).toBe(true); resolve(Response.json({ schemaVersion: 1, organizationId, taxCode })); await expect(t.session.retry()).rejects.toMatchObject({ code: 'session_changed' }); expect(t.fetcher).toHaveBeenCalledTimes(3);
  });
  it('bounds a late preparation response and never issues after its deadline', async () => {
    vi.useFakeTimers(); const t = fixture(20); let resolve!: (response: Response) => void; t.queue.push(() => new Promise(done => { resolve = done; })); const operation = t.session.submit(command, 8, choices), check = expect(operation).rejects.toMatchObject({ code: 'response_timeout', outcome: 'uncertain' }); await vi.advanceTimersByTimeAsync(21); await check; resolve(Response.json(prepared)); await Promise.resolve(); expect(t.paths()).toEqual(['/tax-invoice-preparation']); expect(t.session.hasPending()).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('serializes writes and synchronous disposal prevents a late preparation from issuing', async () => {
    const t = fixture(); let resolve!: (response: Response) => void; t.queue.push(() => new Promise(done => { resolve = done; })); const operation = t.session.submit(command, 8, choices), check = expect(operation).rejects.toMatchObject({ outcome: 'unauthorized' }); await expect(t.session.retry()).rejects.toMatchObject({ code: 'pending_operation' }); t.session.dispose(); await check; resolve(Response.json(prepared)); await Promise.resolve(); expect(t.fetcher).toHaveBeenCalledOnce(); expect(t.session.hasPending()).toBe(false);
  });
  it.each([{ ...prepared, secret: 'PRIVATE' }, { ...prepared, organizationId: 'other' }, { ...prepared, idempotencyKey: 'other' }, { ...prepared, replayed: 1 }])('rejects malformed preparation without sending ERP', async response => { const t = fixture(); t.enqueue(response); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' }); expect(t.session.hasPending()).toBe(true); expect(t.fetcher).toHaveBeenCalledOnce(); });
  it.each([{ ...receipt, private: true }, { ...receipt, receipt: { ...receipt.receipt, revision: 10 } }, { ...receipt, receipt: { ...receipt.receipt, entityId: 'other' } }, { ...receipt, receipt: { ...receipt.receipt, commandHash: 'wrong' } }])('keeps malformed ERP success uncertain', async response => { const t = fixture(); t.enqueue(prepared); t.enqueue(response); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' }); expect(t.session.hasPending()).toBe(true); });
  it('sanitizes unknown server messages and extra error properties', async () => { const t = fixture(); t.enqueue({ error: 'sk_test_PRIVATE', account: 'acct_PRIVATE' }, 503); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ message: 'service_unavailable', code: 'service_unavailable' }); });
  it.each(['member', 'read_only'] as const)('does not create a financial session for %s', role => { expect(() => createBrowserUsTaxInvoiceSession({ organizationId, expectedUserId: 'owner', role, supportedSchemaVersion: 4 })).toThrowError('financial_permission_required'); });
  it.each([' user', 'user\nheader', '', 'a'.repeat(257)])('rejects invalid expected browser identity %j', expectedUserId => { expect(() => createBrowserUsTaxInvoiceSession({ organizationId, expectedUserId, role: 'owner', supportedSchemaVersion: 4 })).toThrowError('invalid_request'); });
});
describe('bounded public fiscal reads and complete explicit choices', () => {
  it('permits filtered empty pages and raw provider cursors unrelated to returned codes', async () => { const t = fixture(); t.enqueue({ schemaVersion: 1, organizationId, taxCodes: [], hasMore: true, nextCursor: 'txcd_99999999' }); expect(await t.session.catalogue()).toMatchObject({ taxCodes: [], nextCursor: 'txcd_99999999' }); t.enqueue({ schemaVersion: 1, organizationId, taxCodes: [taxCode], hasMore: true, nextCursor: 'txcd_88888888' }); expect(await t.session.catalogue('txcd_99999999')).toMatchObject({ taxCodes: [taxCode], nextCursor: 'txcd_88888888' }); expect(t.newId).not.toHaveBeenCalled(); });
  it('rejects a pagination cursor loop', async () => { const t = fixture(); t.enqueue({ schemaVersion: 1, organizationId, taxCodes: [], hasMore: true, nextCursor: taxCode.id }); await expect(t.session.catalogue(taxCode.id)).rejects.toMatchObject({ code: 'invalid_response' }); });
  it.each([{ ...taxCode, id: 'txcd_99999999' }, { ...taxCode, secret: 'PRIVATE' }, { ...taxCode, description: 'x'.repeat(16001) }])('rejects invalid or overbroad public catalogue rows', async row => { const t = fixture(); t.enqueue({ schemaVersion: 1, organizationId, taxCode: row }); await expect(t.session.lookup(taxCode.id)).rejects.toMatchObject({ code: 'invalid_response' }); });
  it('readiness is informative and cannot create or release a pending operation', async () => { const t = fixture(); t.queue.push(() => Promise.reject(new Error('lost'))); await expect(t.session.submit(command, 8, choices)).rejects.toMatchObject({ outcome: 'uncertain' }); const now = Math.floor(Date.now() / 1000); t.enqueue({ schemaVersion: 1, organizationId, currency: 'USD', effectiveSchemaVersion: 4, checkedAt: now, expiresAt: now + 120, status: 'ready_test' }); expect(await t.session.readiness()).toMatchObject({ status: 'ready_test' }); expect(t.session.hasPending()).toBe(true); expect(t.paths()).toEqual(['/tax-invoice-preparation', '/tax-readiness']); });
  it.each(['2026-10-10T16:00:00Z', '2026-10-10T16:00:00.000Z', '2026-10-10T12:00:00-04:00'])('accepts explicit whole-second instant %s without changing its exact representation', instant => { expect(validateBrowserUsTaxInvoiceChoices({ ...choices, taxDateInstant: instant }).taxDateInstant).toBe(instant); });
  it.each([{ ...choices, taxDateInstant: '2026-10-10T12:00:00' }, { ...choices, taxDateInstant: '2026-10-10T12:00:00.001Z' }, { ...choices, addressSource: '' }, { ...choices, classifications: [] }, { ...choices, classifications: [{ ...choices.classifications[0], confirmedService: false }] }, { ...choices, classifications: [...choices.classifications, ...choices.classifications] }, { ...choices, privateGrant: true }])('rejects incomplete, implicit or invented fiscal choices', value => { expect(() => validateBrowserUsTaxInvoiceChoices(value)).toThrowError('invalid_request'); });
  it('bounds response bytes even without a trustworthy content-length', async () => { const t = fixture(); t.queue.push(() => new Response('x'.repeat(524289), { headers: { 'Content-Type': 'application/json' } })); await expect(t.session.catalogue()).rejects.toMatchObject({ code: 'invalid_response' }); });
});
