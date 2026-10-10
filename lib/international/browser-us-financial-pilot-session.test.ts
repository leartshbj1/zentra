import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserUsFinancialPilotSession, type BrowserUsFinancialPilotEnvironment } from './browser-us-financial-pilot-session';
import { financialPilotCursor, type UsFinancialPilotInvoiceRow, type UsFinancialPilotOverview, type UsFinancialPilotPage, type UsFinancialPilotReports, type UsFinancialPilotInvoiceDetail } from './us-financial-pilot-contract';
import type { UsFinancialPilotInvoiceRequest } from './us-financial-pilot-invoice';

// Fictitious client transport fixtures, not a PostgreSQL, accounting or provider test.
const organizationId = '11111111-1111-4111-8111-111111111111', expectedUserId = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333';
const head = (revision = 7) => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId, revision });
const invoice: UsFinancialPilotInvoiceRow = { id: 'invoice-a', number: 'INV-2026-1', customerId: 'customer-a', customerName: 'Fictitious Customer', date: '2026-10-01', accountingDate: '2026-10-01', dueDate: '2026-10-31', issuedAt: '2026-10-01T10:00:00.000Z', issuedBy: expectedUserId, totalMinor: '107', receivedMinor: '50', creditedMinor: '35', outstandingMinor: '22', status: 'partially_settled' };
function page<T>(kind: UsFinancialPilotPage<T>['kind'], items: readonly T[] = [], revision = 7): UsFinancialPilotPage<T> { return { ...head(revision), ledgerRevision: 5, kind, scope: null, total: items.length, items, nextCursor: null }; }
function overview(revision = 7): UsFinancialPilotOverview {
  return { ...head(revision), ledgerRevision: 5, company: { country: 'US', currency: 'USD', accountingBasis: 'accrual', language: 'en', timeZone: 'America/New_York' }, summary: { invoiceCount: 1, totalMinor: '107', receivedMinor: '50', creditedMinor: '35', outstandingMinor: '22' }, invoices: page('invoices', [invoice], revision), customers: page('customers', [], revision), vendors: page('vendors', [], revision), estimates: page('estimates', [], revision), journals: page('journals', [], revision), periods: page('periods', [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }], revision) };
}
const command = { type: 'customer_payment' as const, invoiceId: 'invoice-a', amountMinor: '10', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Fictitious bank statement' };
const receipt = { ...head(8), entityId: `pilot-payment:${requestId}`, action: 'customer_payment' as const };
function reports(): UsFinancialPilotReports {
  return { ...head(), ledgerRevision: 5, currency: 'USD', basis: 'accrual', from: '2026-01-01', to: '2026-12-31', asOf: '2026-10-10', trialBalance: { rows: [], totalDebitMinor: '0', totalCreditMinor: '0', balanced: true }, profitAndLoss: { rows: [], incomeMinor: '0', expenseMinor: '0', profitMinor: '0' }, balanceSheet: { rows: [], assetsMinor: '0', liabilitiesMinor: '0', equityMinor: '0', unclosedEarningsMinor: '0', balanced: true }, cashFlow: { status: 'unavailable', reason: 'classification_required' }, currentReceivables: { scope: 'current', summary: overview().summary, invoices: overview().invoices }, generalLedger: null };
}
function invoiceDetail(): UsFinancialPilotInvoiceDetail {
  const address = { country: 'US' as const, line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
  return { ...head(), ledgerRevision: 5, invoice, seller: { name: 'Fictitious Seller', address, email: null, phone: null }, customer: { id: 'customer-a', name: 'Fictitious Customer', kind: 'business', billingAddress: address, shippingAddress: null, email: null, phone: null, contactName: null, paymentTermsDays: 30 }, sourceEstimate: { id: 'estimate-a', revision: 1 }, subtotalMinor: '100', discountMinor: '0', taxMinor: '7', lines: [{ id: 'line-a', description: 'Fictitious goods', quantityUnits: '1', quantityScale: 0, unitPriceMinor: '100', discountBasisPoints: 0, netMinor: '100', taxMinor: '7' }], notes: 'Fictitious client transport only', payments: { ...page('invoice_payments', [{ id: 'payment-a', invoiceId: invoice.id, amountMinor: '50', paymentDate: '2026-10-02', accountingDate: '2026-10-02', reference: 'Fictitious bank', recordedBy: expectedUserId }]), scope: invoice.id }, credits: { ...page('invoice_credits', [{ id: 'credit-a', number: 'CR-2026-1', invoiceId: invoice.id, transactionDate: '2026-10-03', accountingDate: '2026-10-03', periodId: '2026', reason: 'Fictitious return', netMinor: '35', taxMinor: '0', totalMinor: '35', taxDisposition: 'historical_zero_tax' as const, issuedBy: expectedUserId, issuedAt: '2026-10-03T10:00:00.000Z', recordedRevision: 5 }]), scope: invoice.id } };
}
function fixture(sellerInstalled = false) {
  const queue: Array<() => Promise<Response> | Response> = [];
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => { const task = queue.shift(); if (!task) throw new Error('No fictitious response queued'); return task(); });
  let visible = true, online = true; const wakes = new Set<() => void>();
  const environment: BrowserUsFinancialPilotEnvironment = { isVisible: () => visible, isOnline: () => online, subscribe(listener) { wakes.add(listener); return () => { wakes.delete(listener); }; } };
  const newId = vi.fn(() => requestId), session = createBrowserUsFinancialPilotSession({ organizationId, expectedUserId, fetch: fetcher, newId, environment, ...(sellerInstalled ? { sellerInstalled: true, sellerWriteEnabled: true } : {}) });
  const enqueue = (value: unknown, status = 200) => queue.push(() => Response.json(value, { status }));
  const visibility = (value: boolean) => { visible = value; for (const wake of wakes) wake(); };
  const connectivity = (value: boolean) => { online = value; for (const wake of wakes) wake(); };
  const load = async () => { if (sellerInstalled) enqueue({ ...head(), bankRevision: 0, sellerRevision: 4 }); enqueue(overview()); return session.load(); };
  return { queue, fetcher, session, newId, enqueue, visibility, connectivity, load, wakes };
}
const denied = (status: number) => status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : 'forbidden';
async function reject(promise: Promise<unknown>, code: string, outcome = 'rejected', status?: number) { await expect(promise).rejects.toMatchObject({ name: 'BrowserUsFinancialPilotError', code, outcome, ...(status === undefined ? {} : { status }) }); }
async function flush() { for (let n = 0; n < 15; n++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); });

describe('financial-pilot DTO1 fictitious browser transport', () => {
  it('sends cookies, expected identity and only its independent consumer header', async () => {
    const t = fixture(); const value = await t.load(); expect(value.summary).toMatchObject({ receivedMinor: '50', creditedMinor: '35', outstandingMinor: '22' });
    const [url, init] = t.fetcher.mock.calls[0]; expect(url).toBe(`/api/international/workspaces/${organizationId}/financial-pilot/snapshot`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    const headers = new Headers(init?.headers); expect(headers.get('X-Zentra-Financial-Pilot')).toBe('1'); expect(headers.get('X-Zentra-Expected-User')).toBe(expectedUserId); expect(headers.has('Authorization')).toBe(false); expect([...headers.keys()].join(' ')).not.toMatch(/schema|role|grant|policy/i);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.invoices.items)).toBe(true);
  });
  it.each(['', '../foreign', 'not-an-organization'])('refuses malformed org %s before a request', organization => { expect(() => createBrowserUsFinancialPilotSession({ organizationId: organization, expectedUserId })).toThrow('invalid_request'); });
  it.each(['', ' user ', 'private\nidentity'])('refuses malformed expected identity %s', identity => { expect(() => createBrowserUsFinancialPilotSession({ organizationId, expectedUserId: identity })).toThrow('invalid_request'); });
  it('does not expose the mutable transport response or let a subscriber mutate state', async () => {
    const t = fixture(), calls = vi.fn(); t.session.subscribe(calls); const value = await t.load(); expect(calls).toHaveBeenCalled(); expect(() => { (value.summary as { outstandingMinor: string }).outstandingMinor = '999'; }).toThrow(); expect(t.session.getState().snapshot?.summary.outstandingMinor).toBe('22');
  });
  it.each(['baseline', 'policy', 'proof', 'grantVersion', 'ein'])('rejects unwhitelisted overview key %s', async key => {
    const t = fixture(); t.enqueue({ ...overview(), [key]: 'private-value' }); await reject(t.session.load(), 'invalid_response'); expect(t.session.getState().snapshot).toBeNull(); expect(JSON.stringify(t.session.getState())).not.toContain('private-value');
  });
  it('rejects a tenant mismatch, impossible AR and revision regression', async () => {
    const t = fixture(); t.enqueue({ ...overview(), organizationId: expectedUserId }); await reject(t.session.load(), 'invalid_response');
    const bad = overview(); (bad.summary as { outstandingMinor: string }).outstandingMinor = '23'; t.enqueue(bad); await reject(t.session.load(), 'invalid_response');
    await t.load(); t.enqueue(overview(6)); await reject(t.session.load(), 'invalid_response'); expect(t.session.getState().snapshot?.revision).toBe(7);
  });
  it('only polls a cheap head when unchanged, without a visible reload', async () => {
    const t = fixture(); await t.load(); const before = t.session.getState().snapshot; t.enqueue(head()); expect(await t.session.refresh()).toBe(before); expect(t.fetcher).toHaveBeenCalledTimes(2); expect(t.session.getState()).toMatchObject({ refreshing: false, status: 'ready', error: null });
  });
  it('silently replaces the snapshot at the exact changed revision and leaves unrelated drafts intact', async () => {
    const t = fixture(); await t.load(); const draft = { reference: 'I am still typing' }; t.enqueue(head(8)); t.enqueue(overview(8)); await t.session.refresh(); expect(t.fetcher.mock.calls[2][0]).toBe(`/api/international/workspaces/${organizationId}/financial-pilot/snapshot?revision=8`); expect(t.session.getState().snapshot?.revision).toBe(8); expect(draft.reference).toBe('I am still typing');
  });
  it('does not mix a raced revision into a page and leaves the last consistent overview visible', async () => {
    const t = fixture(); await t.load(); t.enqueue({ error: 'financial_snapshot_changed' }, 409); await reject(t.session.readInvoices(), 'financial_snapshot_changed'); expect(t.session.getState().snapshot?.revision).toBe(7);
    t.enqueue(page('invoices', [invoice], 8)); await reject(t.session.readInvoices(), 'invalid_response');
  });
  it.each([401, 402, 403])('clears at HTTP%s headers without reading a stalled/private body', async status => {
    const t = fixture(); await t.load(); const body = new ReadableStream<Uint8Array>({ start() {} }); t.queue.push(() => new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));
    await reject(t.session.refresh(), denied(status), 'unauthorized', status); expect(t.session.getState()).toMatchObject({ status: 'denied', snapshot: null, pending: false, writing: false, refreshing: false }); expect(t.fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });
  it.each([401, 402, 403])('ignores an old authorized response after a parallel denied HTTP%s', async status => {
    const t = fixture(); await t.load(); let finish!: (value: Response) => void; t.queue.push(() => new Promise(resolve => { finish = resolve; })); const detail = t.session.readInvoices().catch(error => error);
    t.enqueue({ error: 'forbidden' }, status); await reject(t.session.refresh(), denied(status), 'unauthorized'); finish(Response.json(page('invoices', [invoice]))); expect(await detail).toMatchObject({ outcome: 'unauthorized' }); expect(t.session.getState().snapshot).toBeNull();
  });
  it('rejects arbitrary HTML/debug errors without publishing private text', async () => {
    const t = fixture(); t.queue.push(() => new Response('private auth token', { status: 503, headers: { 'Content-Type': 'text/html' } })); await reject(t.session.load(), 'invalid_response'); expect(JSON.stringify(t.session.getState())).not.toContain('private auth token');
    t.enqueue({ error: 'secret-database-detail' }, 409); await reject(t.session.load(), 'service_unavailable');
  });
  it('bounds announced and streamed response bytes', async () => {
    const t = fixture(); t.queue.push(() => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '99999999' } })); await reject(t.session.load(), 'invalid_response');
    t.queue.push(() => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })); await reject(t.session.load(), 'invalid_response');
  });
  it('times out a stalled response body and releases its request', async () => {
    vi.useFakeTimers(); const t = fixture(); t.queue.push(() => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'application/json' } }));
    const result = t.session.load().catch(error => error); await flush(); await vi.advanceTimersByTimeAsync(30000); expect(await result).toMatchObject({ code: 'response_timeout' }); expect(vi.getTimerCount()).toBe(0);
  });
  it('shares concurrent refresh calls and does not run overlapping three-second polls', async () => {
    vi.useFakeTimers(); const t = fixture(); t.enqueue(overview()); t.session.start(); await flush(); await vi.advanceTimersByTimeAsync(0);
    let finish!: (value: Response) => void; t.queue.push(() => new Promise(resolve => { finish = resolve; })); await vi.advanceTimersByTimeAsync(3000); const same = t.session.refresh(); await vi.advanceTimersByTimeAsync(15000); expect(t.fetcher).toHaveBeenCalledTimes(2); finish(Response.json(head())); await same; t.enqueue(head()); await vi.advanceTimersByTimeAsync(3000); expect(t.fetcher).toHaveBeenCalledTimes(3); t.session.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('pauses hidden/offline polling, wakes immediately online and cleans up subscriptions', async () => {
    vi.useFakeTimers(); const t = fixture(); t.enqueue(overview()); t.session.start(); await vi.advanceTimersByTimeAsync(0); t.visibility(false); await vi.advanceTimersByTimeAsync(9000); expect(t.fetcher).toHaveBeenCalledTimes(1);
    t.connectivity(false); t.visibility(true); await vi.advanceTimersByTimeAsync(9000); expect(t.fetcher).toHaveBeenCalledTimes(1); t.enqueue(head()); t.connectivity(true); await vi.advanceTimersByTimeAsync(0); expect(t.fetcher).toHaveBeenCalledTimes(2); t.session.stop(); expect(t.wakes.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('abandons a delayed response on stop and does not repopulate a restarted session', async () => {
    const t = fixture(); let finish!: (value: Response) => void; t.queue.push(() => new Promise(resolve => { finish = resolve; })); const old = t.session.load().catch(error => error); t.session.stop(); t.enqueue(overview(8)); t.session.start(); await flush(); finish(Response.json(overview())); expect(await old).toMatchObject({ outcome: 'unauthorized' }); await flush(); expect(t.session.getState().snapshot?.revision).toBe(8); t.session.dispose();
  });
  it('keeps the exact public payment envelope and UUID after a lost response', async () => {
    const t = fixture(); await t.load(); const mutable = { ...command }; t.queue.push(() => { throw new Error('private network detail'); }); await reject(t.session.recordPayment(mutable), 'response_unavailable', 'uncertain'); expect(t.session.hasPending()).toBe(true);
    mutable.reference = 'Changed after send'; await reject(t.session.recordPayment(command), 'pending_operation'); t.enqueue(receipt); t.enqueue(overview(8)); expect(await t.session.retry()).toEqual(receipt); expect(t.newId).toHaveBeenCalledOnce(); const writes = t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(writes[1][1]?.body).toBe(writes[0][1]?.body);
    expect(JSON.parse(writes[0][1]?.body as string)).toEqual({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 7, command }); expect(writes[0][1]?.body).not.toMatch(/grant|proof|policy|idempotency|commandHash/); await flush();
  });
  it('probes permission during an ambiguous payment without replacing the old view or retrying', async () => {
    const t = fixture(); await t.load(); t.enqueue({ error: 'service_unavailable' }, 503); await reject(t.session.recordPayment(command), 'service_unavailable', 'uncertain'); t.enqueue(head(8)); await t.session.refresh(); expect(t.session.getState().snapshot?.revision).toBe(7); expect(t.session.hasPending()).toBe(true); expect(t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('never retargets a rejected revision conflict to a newly loaded revision', async () => {
    const t = fixture(); await t.load(); t.enqueue({ error: 'financial_snapshot_changed' }, 409); t.enqueue(overview(8)); await reject(t.session.recordPayment(command), 'financial_snapshot_changed'); expect(t.session.hasPending()).toBe(false); await flush(); await reject(t.session.retry(), 'no_pending_operation'); expect(t.newId).toHaveBeenCalledOnce();
  });
  it.each(['entityId', 'revision', 'organizationId', 'action', 'replayed', 'providerProof'])('withholds malformed receipt %s and preserves exact uncertainty', async field => {
    const t = fixture(); await t.load(); const bad: Record<string, unknown> = { ...receipt }; bad[field] = field === 'revision' ? 9 : 'foreign-or-private'; t.enqueue(bad); await reject(t.session.recordPayment(command), 'invalid_response', 'uncertain'); expect(t.session.hasPending()).toBe(true); expect(JSON.stringify(t.session.getState())).not.toContain('foreign-or-private');
  });
  it.each([401, 402, 403])('does not publish a late payment receipt after denied HTTP%s', async status => {
    const t = fixture(); await t.load(); let finish!: (value: Response) => void; t.queue.push(() => new Promise(resolve => { finish = resolve; })); const sending = t.session.recordPayment(command).catch(error => error); t.enqueue({ error: 'forbidden' }, status); await reject(t.session.refresh(), denied(status), 'unauthorized'); finish(Response.json(receipt)); expect(await sending).toMatchObject({ outcome: 'unauthorized' }); expect(t.session.getState()).toMatchObject({ snapshot: null, pending: false, writing: false });
  });
  it.each([{ ...command, proof: 'private' }, { ...command, id: 'caller-supplied' }, { ...command, amountMinor: 10 }, { ...command, paymentDate: '2026-02-30' }, { ...command, reference: 'secret\ncontrol' }])('refuses invalid or expanded payment before fetch', async invalid => {
    const t = fixture(); await t.load(); expect(() => t.session.recordPayment(invalid as typeof command)).toThrow('invalid_financial_pilot_request'); expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires initial data and matching expected revision before payment', async () => {
    const t = fixture(); await reject(t.session.recordPayment(command), 'read_required'); await t.load(); await reject(t.session.recordPayment(command, 6), 'financial_snapshot_changed'); expect(t.newId).not.toHaveBeenCalled();
  });
  it('does not present an older in-flight snapshot as the post-payment view', async () => {
    const t = fixture(); await t.load(); let finish!: (value: Response) => void; t.queue.push(() => new Promise(resolve => { finish = resolve; })); const old = t.session.load().catch(error => error); t.enqueue(receipt); await t.session.recordPayment(command); t.enqueue(overview(8)); finish(Response.json(overview())); expect(await old).toMatchObject({ code: 'stale_read' }); await flush(); expect(t.session.getState().snapshot?.revision).toBe(8);
  });
  it('requests reports by exact dates/revision and rejects a different report period', async () => {
    const t = fixture(); await t.load(); const report = reports(); t.enqueue(report); expect(await t.session.readReports({ revision: 7, from: report.from, to: report.to, asOf: report.asOf })).toEqual(report); expect(t.fetcher.mock.calls.at(-1)?.[0]).toContain('/reports?revision=7&from=2026-01-01&to=2026-12-31&asOf=2026-10-10');
    t.enqueue({ ...report, asOf: '2026-10-09' }); await reject(t.session.readReports({ revision: 7, from: report.from, to: report.to, asOf: report.asOf }), 'invalid_response');
  });
  it.each(['customers', 'vendors', 'estimates', 'journals', 'periods'] as const)('loads the independent %s list with revision-bound pagination', async kind => {
    const t = fixture(); await t.load(); t.enqueue(overview()[kind]); expect((await t.session.readList(kind)).kind).toBe(kind); expect(t.fetcher.mock.calls.at(-1)?.[0]).toContain(`/lists/${kind}?revision=7`);
  });
  it('validates cursors by list kind/revision and never silently fetches another page', async () => {
    const t = fixture(); await t.load(); const cursor = financialPilotCursor('invoices', 7, 25, null); t.enqueue({ ...page('invoices', [invoice]), total: 26 }); expect((await t.session.readInvoices(cursor)).items).toHaveLength(1); expect(t.fetcher.mock.calls.at(-1)?.[0]).toContain(`cursor=${encodeURIComponent(cursor)}`);
    await reject(t.session.readInvoices(financialPilotCursor('customers', 7, 25, null)), 'invalid_request'); await reject(t.session.readInvoices(financialPilotCursor('invoices', 6, 25, null)), 'invalid_request'); expect(t.fetcher).toHaveBeenCalledTimes(2);
    t.enqueue({ ...page('invoices', [invoice]), total: 27 }); await reject(t.session.readInvoices(cursor), 'invalid_response');
  });
  it('refuses a list of another kind even with the correct tenant and revision', async () => {
    const t = fixture(); await t.load(); t.enqueue(overview().vendors); await reject(t.session.readList('customers'), 'invalid_response');
  });
  it('loads a whitelisted invoice with separate paid/credited amounts and no fiscal secrets', async () => {
    const t = fixture(); await t.load(); t.enqueue(invoiceDetail()); const detail = await t.session.readInvoice(invoice.id); expect(detail.invoice).toMatchObject({ receivedMinor: '50', creditedMinor: '35', outstandingMinor: '22' }); expect(detail.credits.items[0].totalMinor).toBe('35'); expect(JSON.stringify(detail)).not.toMatch(/provider|Fingerprint|Sha256|policy|grant/);
  });
  it('binds invoice pagination to the selected invoice and preserves captured cursors', async () => {
    const t = fixture(); await t.load(); const cursor = financialPilotCursor('invoice_payments', 7, 25, invoice.id), cursors = { paymentCursor: cursor }, detail = invoiceDetail(); t.enqueue({ ...detail, payments: { ...detail.payments, total: 26 } }); await t.session.readInvoice(invoice.id, 7, cursors); expect(t.fetcher.mock.calls.at(-1)?.[0]).toContain(`paymentCursor=${encodeURIComponent(cursor)}`);
    await reject(t.session.readInvoice(invoice.id, 7, { paymentCursor: financialPilotCursor('invoice_payments', 7, 25, 'another-invoice') }), 'invalid_request'); expect(t.fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects an invoice detail that repeats page zero for a requested later page', async () => {
    const t = fixture(); await t.load(); t.enqueue(invoiceDetail()); await reject(t.session.readInvoice(invoice.id, 7, { paymentCursor: financialPilotCursor('invoice_payments', 7, 25, invoice.id) }), 'invalid_response');
  });
  it('does not return an older invoice detail after the overview has advanced', async () => {
    const t = fixture(); await t.load(); let finish!: (value: Response) => void; t.queue.push(() => new Promise(resolve => { finish = resolve; })); const old = t.session.readInvoice(invoice.id).catch(error => error); t.enqueue(head(8)); t.enqueue(overview(8)); await t.session.refresh(); finish(Response.json(invoiceDetail())); expect(await old).toMatchObject({ code: 'stale_read' });
  });
  it('captures report selectors before awaiting and refuses injected/private selectors', async () => {
    const t = fixture(); await t.load(); const report = reports(), query = { revision: 7, from: report.from, to: report.to, asOf: report.asOf }; let finish!: (value: Response) => void; t.queue.push(() => new Promise(resolve => { finish = resolve; })); const pending = t.session.readReports(query); query.asOf = '2026-10-09'; finish(Response.json(report)); expect((await pending).asOf).toBe('2026-10-10'); await reject(t.session.readReports({ ...query, grant: 'private' } as typeof query), 'invalid_request');
  });
  it.each([['settlement_amount_conflict', 409], ['payment_exceeds_balance', 422], ['accounting_period_not_open', 409], ['invoice_not_found', 404], ['invalid_financial_pilot_request', 422], ['invalid_financial_date', 422]] as const)('allows a fresh explicit review after the definitive precommit %s', async (code, status) => {
    const t = fixture(); await t.load(); t.enqueue({ error: code }, status); t.enqueue(overview()); await reject(t.session.recordPayment(command), code, 'rejected', status); expect(t.session.hasPending()).toBe(false); await flush(); await reject(t.session.retry(), 'no_pending_operation');
  });
  it.each([['settlement_amount_conflict', 503], ['unknown-before-or-after-commit', 409], ['invalid_financial_pilot_request', 503]] as const)('preserves exact uncertainty for the unproven %s/%s response', async (code, status) => {
    const t = fixture(); await t.load(); t.enqueue({ error: code }, status); await reject(t.session.recordPayment(command), code === 'unknown-before-or-after-commit' ? 'service_unavailable' : code, 'uncertain', status); expect(t.session.hasPending()).toBe(true);
  });
  it('does not poll or retain financial data after disposal', async () => {
    const t = fixture(); await t.load(); t.session.dispose(); expect(t.session.getState().snapshot).toBeNull(); expect(() => t.session.start()).toThrow('session_disposed'); await reject(t.session.refresh(), 'session_disposed', 'unauthorized'); expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('seller-installed shared owner notification reentrance', () => {
  it('shares the already installed composite flight when a subscriber refreshes synchronously, with no F reload on S alone', async () => {
    const t = fixture(true); await t.load(); const snapshot = t.session.getState().snapshot;
    let attempted = false, nested: Promise<unknown> | undefined;
    const unsubscribe = t.session.subscribe(() => { if (!attempted && t.session.getState().seller?.refreshing) { attempted = true; nested = t.session.refresh(); } });
    try {
      t.enqueue({ ...head(), bankRevision: 0, sellerRevision: 5 });
      // A second response would let an incorrect overlapping flight finish,
      // while the assertions still detect the extra request deterministically.
      t.enqueue({ ...head(), bankRevision: 0, sellerRevision: 5 });
      await t.session.refresh(); await nested;
      expect(attempted).toBe(true); expect(t.session.getState().snapshot).toBe(snapshot); expect(t.session.getState().seller?.head?.sellerRevision).toBe(5);
      expect(t.fetcher.mock.calls.filter(([url]) => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('/seller?view=head'))).toHaveLength(2);
      expect(t.fetcher.mock.calls.filter(([url]) => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('/snapshot'))).toHaveLength(1);
    } finally { unsubscribe(); t.session.dispose(); }
  });
  it('publishes common write ownership before seller invalidation can reentrantly retry its exact payment', async () => {
    const t = fixture(true); await t.load(); let attempted = false, nested: Promise<unknown> | undefined;
    const unsubscribe = t.session.subscribe(() => { if (!attempted && t.session.getState().seller?.requiresRefresh) { attempted = true; nested = t.session.retry().catch(error => error); } });
    try {
      t.enqueue(receipt); t.enqueue({ ...head(8), bankRevision: 0, sellerRevision: 4 }); t.enqueue(overview(8));
      expect(await t.session.recordPayment(command)).toEqual(receipt); expect(await nested).toMatchObject({ code: 'pending_operation', status: 409 }); await flush();
      expect(attempted).toBe(true); expect(t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); expect(t.newId).toHaveBeenCalledOnce();
    } finally { unsubscribe(); t.session.dispose(); }
  });
  it('stops at the first common write notification without dereferencing a purged payment or sending it', async () => {
    const t = fixture(true); await t.load(); const before = t.fetcher.mock.calls.length;
    const unsubscribe = t.session.subscribe(() => { if (t.session.getState().writing) t.session.stop(); });
    try {
      await reject(t.session.recordPayment(command), 'session_disposed', 'unauthorized');
      expect(t.fetcher).toHaveBeenCalledTimes(before); expect(t.session.hasPending()).toBe(false); expect(t.session.getState()).toMatchObject({ status: 'stopped', pending: false, pendingKind: null });
    } finally { unsubscribe(); t.session.dispose(); }
  });
});

describe('invoice preparation ownership before preview notifications', () => {
  const invoiceCommand: UsFinancialPilotInvoiceRequest['command'] = { type: 'issue_invoice', estimateId: 'estimate-a', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-10', periodId: '2026' };
  const choices: UsFinancialPilotInvoiceRequest['choices'] = { classifications: [{ lineId: 'line-a', taxCode: 'txcd_20030000', confirmedService: true }], taxDateInstant: '2026-10-10T13:00:00.000Z', addressSource: 'billing' };

  it.each([false, true])('does not reinstall a purged preparation after synchronous stop, seller installed=%s', async sellerInstalled => {
    const t = fixture(sellerInstalled); await t.load(); const before = t.fetcher.mock.calls.length;
    let notified = false, ownedAtNotification = false;
    const unsubscribe = t.session.subscribe(() => {
      if (notified || t.session.getState().invoiceReview !== null) return;
      notified = true;
      const state = t.session.getState(); ownedAtNotification = state.writing && state.pending && state.pendingKind === 'invoice_prepare';
      t.session.stop();
    });
    try {
      await reject(t.session.prepareInvoice(invoiceCommand, choices), 'session_disposed', 'unauthorized');
      expect(notified).toBe(true); expect(ownedAtNotification).toBe(true);
      expect(t.fetcher).toHaveBeenCalledTimes(before); expect(t.newId).toHaveBeenCalledOnce();
      expect(t.session.hasPending()).toBe(false);
      expect(t.session.getState()).toMatchObject({ status: 'stopped', snapshot: null, pending: false, pendingKind: null, writing: false, invoiceReview: null });
    } finally { unsubscribe(); t.session.dispose(); }
  });

  it.each([false, true])('keeps the exact preparation while rejecting a synchronous competing payment, seller installed=%s', async sellerInstalled => {
    const t = fixture(sellerInstalled); await t.load(); let notified = false, nested: Promise<unknown> | undefined;
    const unsubscribe = t.session.subscribe(() => {
      if (notified || t.session.getState().invoiceReview !== null) return;
      notified = true; nested = t.session.recordPayment(command).catch(error => error);
    });
    try {
      t.enqueue({ error: 'service_unavailable' }, 503);
      await reject(t.session.prepareInvoice(invoiceCommand, choices), 'service_unavailable', 'uncertain', 503);
      expect(notified).toBe(true); expect(await nested).toMatchObject({ code: 'pending_operation', status: 409 });
      expect(t.newId).toHaveBeenCalledOnce(); expect(t.session.hasPending()).toBe(true);
      expect(t.session.getState()).toMatchObject({ pending: true, pendingKind: 'invoice_prepare', writing: false });
      const writes = t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(writes).toHaveLength(1); expect(writes[0][0]).toBe(`/api/international/workspaces/${organizationId}/financial-pilot/invoices/prepare`);
      expect(JSON.parse(writes[0][1]?.body as string)).toEqual({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 7, command: invoiceCommand, choices });
    } finally { unsubscribe(); t.session.dispose(); }
  });
});
