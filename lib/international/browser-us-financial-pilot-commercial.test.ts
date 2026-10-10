import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserUsFinancialPilotSession, type BrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import { AccountPublicError } from '../account-security';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialErpCommandV5 } from './us-financial-kernel-types';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { createUsFinancialPilotCommercialHandlers } from './us-financial-pilot-commercial-server';
import { createUsFinancialPilotAccountingHandlers } from './us-financial-pilot-accounting-server';
import { appendUsFinancialPilotBankRegister, validateUsFinancialPilotBankHistory, type UsFinancialPilotBankRegister, type UsFinancialPilotBankPort } from './us-financial-pilot-bank';
import { createUsFinancialPilotBankHandlers } from './us-financial-pilot-bank-server';
import type { CustomerEditReview } from './browser-us-financial-pilot-commercial-input';
import type { UsFinancialPilotOverview } from './us-financial-pilot-contract';
import type { UsFinancialPilotCommercialCommand, UsFinancialPilotCommercialReceipt } from './us-financial-pilot-commercial';
import type { UsFinancialPilotEstimateDetail } from './us-financial-pilot-commercial-projection';

// Synthetic HTTP transport only. The independent PostgreSQL recipe exercises persistence.
const organizationId = '11111111-1111-4111-8111-111111111111';
const expectedUserId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const head = (revision = 7) => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId, revision });
const address = { country: 'US' as const, line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
const customer = { kind: 'business' as const, name: 'Synthetic Buyer', billingAddress: address, shippingAddress: null, email: null, phone: null, contactName: null, paymentTermsDays: 30 };
const create: UsFinancialPilotCommercialCommand = { type: 'create_customer', customer };
const save: UsFinancialPilotCommercialCommand = { type: 'save_estimate', estimateId: null, expectedEstimateRevision: 0, customerId: 'customer-a', projectId: null, date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: [{ id: null, description: 'Synthetic work', quantityUnits: '125', quantityScale: 2, unitPriceMinor: '1001', discountBasisPoints: 1000, taxTreatment: 'taxable' }], notes: 'Synthetic note\nSecond line' };
const accept: UsFinancialPilotCommercialCommand = { type: 'accept_estimate', estimateId: 'estimate-a', expectedEstimateRevision: 2 };
function overview(revision = 7): UsFinancialPilotOverview {
  const page = (kind: 'customers'|'vendors'|'estimates'|'journals'|'periods'|'invoices') => ({ ...head(revision), ledgerRevision: 5, kind, scope: null, total: 0, items: [], nextCursor: null });
  return { ...head(revision), ledgerRevision: 5, company: { country: 'US', currency: 'USD', accountingBasis: 'accrual', language: 'en', timeZone: 'America/New_York' }, summary: { invoiceCount: 0, totalMinor: '0', receivedMinor: '0', creditedMinor: '0', outstandingMinor: '0' }, invoices: page('invoices'), customers: page('customers'), vendors: page('vendors'), estimates: page('estimates'), journals: page('journals'), periods: page('periods') };
}
function receipt(command = create): UsFinancialPilotCommercialReceipt {
  return { ...head(8), action: command.type, entityId: command.type === 'create_customer' ? `pilot-customer:${requestId}` : command.type === 'update_customer' ? command.customerId : command.type === 'save_estimate' ? command.estimateId ?? `pilot-estimate:${requestId}` : command.estimateId };
}
function estimate(): UsFinancialPilotEstimateDetail {
  return { ...head(), ledgerRevision: 5, estimate: { id: 'estimate-a', number: 'EST-2026-0001', revision: 2, customerId: 'customer-a', customerName: customer.name, date: '2026-10-10', expiresAt: '2026-11-10', status: 'draft', netMinor: '900' }, customer: { ...customer, id: 'customer-a' }, projectId: null, paymentTermsDays: 30, notes: 'Draft', subtotalMinor: '1000', discountMinor: '100', netMinor: '900', lines: [{ id: 'line-a', description: 'Synthetic work', quantityUnits: '1', quantityScale: 0, unitPriceMinor: '1000', discountBasisPoints: 1000, taxTreatment: 'taxable', netMinor: '900' }] };
}

const realSessions: BrowserUsFinancialPilotSession[] = [];
afterEach(() => { for (const session of realSessions.splice(0)) session.dispose(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let n = 0; n < 16; n++) await new Promise<void>(resolve => setImmediate(resolve)); }

/** Real V5/kernel/projections/handlers and bank sidecar. Only Auth/D1,
 * scheduling and transport faults are synthetic; no PG/provider/network. */
async function customerFixture() {
  const original = await financialKernelFixture({ tax: '0', paid: '10000' }), org = organizationId, origin = 'https://zentraapp.ch';
  const data = JSON.parse(JSON.stringify(original).replaceAll(original.actor.organizationId, org)) as typeof original;
  const initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), financial = await createInMemoryUsFinancialKernelStoreV5(initial, data.policy, actor => actor);
  const readBook = async () => await financial.read(org) as UsFinancialBookV5;
  let denied = 0, sequence = 100, externalSequence = 900;
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const scope = { scope: { organizationId: org, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const shared = { enabled: () => true, authority: async () => { if (denied) throw new AccountPublicError('Synthetic denial', denied); return { mode: 'browser' as const, actor: data.actor }; }, configuration: async () => data.configuration, scope: async () => scope, rateLimit: async () => {}, diagnostic: () => {} };
  const financialStore = { ...financial, head: async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: (await readBook()).revision }) };
  const deps: UsFinancialPilotDependencies = { ...shared, store: () => financialStore };
  const finance = createUsFinancialPilotHandlers(deps), commercial = createUsFinancialPilotCommercialHandlers(deps), accounting = createUsFinancialPilotAccountingHandlers(deps);
  let register: UsFinancialPilotBankRegister = { schemaVersion: 1, organizationId: org, bankRevision: 0, records: [], operations: [] };
  const bankStore: UsFinancialPilotBankPort = {
    read: async () => ({ book: await readBook(), register }),
    head: async () => ({ ...await financialStore.head(), bankRevision: register.bankRevision }),
    receipt: async requestId => register.operations.find(p => p.request.requestId === requestId) ?? null,
    commit: async input => {
      const previous = register.operations.find(p => p.request.requestId === input.request.requestId);
      if (previous) { if (canonicalErpJson(previous) !== canonicalErpJson(input.proof)) throw new ErpError('idempotency_conflict', 409); return previous; }
      if (input.request.expectedRevision !== (await readBook()).revision || input.request.expectedBankRevision !== register.bankRevision) throw new ErpError('revision_conflict', 409);
      const next = appendUsFinancialPilotBankRegister(register, input.record, input.proof); await validateUsFinancialPilotBankHistory(await readBook(), next); register = next; return input.proof;
    },
  };
  const bank = createUsFinancialPilotBankHandlers({ ...shared, store: () => bankStore });
  const base = `/api/international/workspaces/${org}/financial-pilot`;
  const dispatch = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname.slice(base.length);
    if (path === '/snapshot') return finance.SNAPSHOT(req, org);
    if (path === '/head') return finance.HEAD(req, org);
    if (path === '/operations') return finance.POST(req, org);
    if (path === '/commercial/operations') return commercial.POST(req, org);
    if (path === '/accounting/operations') return accounting.POST(req, org);
    if (path === '/bank/head') return bank.HEAD(req, org);
    if (path === '/bank/context') return bank.CONTEXT(req, org);
    if (path === '/bank/operations') return bank.POST(req, org);
    if (path.startsWith('/customers/')) return commercial.CUSTOMER(req, org, decodeURIComponent(path.slice(11)));
    if (path.startsWith('/estimates/')) return commercial.ESTIMATE(req, org, decodeURIComponent(path.slice(11)));
    if (path.startsWith('/lists/')) return finance.LIST(req, org, path.slice(7));
    throw Error('Unexpected synthetic route ' + path);
  };
  type Intercept = (request: Request, next: () => Promise<Response>) => Promise<Response>;
  let intercept: Intercept | undefined;
  const requests: { url: string; method: string; body: string }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin');
    const req = new Request(new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, origin), { ...init, headers });
    requests.push({ url: req.url, method: req.method, body: req.method === 'POST' ? await req.clone().text() : '' });
    return intercept ? intercept(req, () => dispatch(req)) : dispatch(req);
  });
  const newId = vi.fn(() => uid(++sequence)), makeSession = () => { const session = createBrowserUsFinancialPilotSession({ organizationId: org, expectedUserId: data.actor.userId, fetch: fetcher, newId, environment: { isVisible: () => true, isOnline: () => true, subscribe: () => () => {} } }); realSessions.push(session); return session; };
  const session = makeSession();
  const external = async (command: UsFinancialErpCommandV5) => executeUsFinancialKernelV5({ configuration: data.configuration, actor: data.actor, policy: data.policy, store: financial,
    revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }), resolveTax: async () => { throw Error('No tax authority for synthetic commercial operation'); } },
  { idempotencyKey: `synthetic-external-${++externalSequence}`, expectedRevision: (await readBook()).revision, command: { type: 'erp_command', request: command } });
  const externalCustomer = async (name = 'Synthetic independent customer') => external({ type: 'save_customer', customer: { id: `external-${externalSequence}`, organizationId: org, kind: 'business', name, billingAddress: data.configuration.address, paymentTermsDays: 30 } });
  const review = async (name = 'Corrected Synthetic Customer') => { const source = await session.readCustomer('customer-1'); const { id: _id, ...fields } = source.customer; return session.reviewCustomerEdit(source, { ...fields, name }); };
  const payment = { type: 'customer_payment' as const, invoiceId: 'invoice-1', amountMinor: '1', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic already-recorded payment' };
  const importDraft = { text: 'date,amount,reference\n2026-10-10,100.00,Synthetic receipt\n', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: '0', closing: '100.00' };
  const externalBank = async () => bank.POST(new Request(`${origin}${base}/bank/operations`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': data.actor.userId },
    body: JSON.stringify({ consumer: 'financial-pilot', schemaVersion: 1, requestId: uid(++externalSequence), expectedRevision: (await readBook()).revision, expectedBankRevision: register.bankRevision, expectedStatementRevision: null,
      command: { type: 'create_statement', cashAccountId: 'cash', start: importDraft.start, end: importDraft.end, openingMinor: '0', closingMinor: '10000', lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Synthetic receipt' }] } }) }), org);
  return { ...data, org, session, makeSession, newId, initial, readBook, external, externalCustomer, review, requests, fetcher, payment, importDraft, bankStore, register: () => register,
    externalBank, intercept: (value?: Intercept) => { intercept = value; }, deny: (value: number) => { denied = value; }, ready: () => session.load() };
}
function fixture() {
  const queue: Array<() => Response|Promise<Response>> = [];
  const fetcher = vi.fn(async (_url: RequestInfo|URL, _init?: RequestInit) => { const task = queue.shift(); if (!task) throw Error('Missing synthetic response'); return task(); });
  const newId = vi.fn(() => requestId);
  const session = createBrowserUsFinancialPilotSession({ organizationId, expectedUserId, fetch: fetcher, newId, environment: { isVisible: () => true, isOnline: () => true, subscribe: () => () => {} } });
  const enqueue = (value: unknown, status = 200) => queue.push(() => Response.json(value, { status }));
  return { session, newId, queue, fetcher, enqueue, load: async () => { enqueue(overview()); await session.load(); } };
}
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe('shared commercial/payment browser session', () => {
  it.each([create, save, accept])('sends and validates $type under its own endpoint and same admission', async command => {
    const t = fixture(); await t.load(); t.enqueue(receipt(command)); t.enqueue(overview(8));
    expect(await t.session.commercial(command)).toEqual(receipt(command)); await flush();
    const write = t.fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(write?.[0]).toBe(`/api/international/workspaces/${organizationId}/financial-pilot/commercial/operations`);
    expect(write?.[1]).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(new Headers(write?.[1]?.headers).get('X-Zentra-Expected-User')).toBe(expectedUserId);
    expect(JSON.parse(write?.[1]?.body as string)).toEqual({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 7, command });
    expect(t.session.getState()).toMatchObject({ pendingKind: null, pending: false });
    expect(t.session.getState().snapshot?.revision).toBe(8); t.session.dispose();
  });
  it('captures a mutable draft before awaiting and retries exactly after a lost reply', async () => {
    const t = fixture(); await t.load(); const draft = structuredClone(save);
    t.queue.push(() => { throw Error('Private transport detail'); });
    await expect(t.session.commercial(draft)).rejects.toMatchObject({ code: 'response_unavailable', outcome: 'uncertain' });
    if (draft.type === 'save_estimate') (draft as { notes: string }).notes = 'Changed after sending';
    expect(t.session.getState()).toMatchObject({ pending: true, pendingKind: 'commercial', writing: false });
    t.enqueue(receipt(save)); t.enqueue(overview(8)); expect(await t.session.retry()).toEqual(receipt(save));
    const writes = t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes[1][1]?.body).toBe(writes[0][1]?.body); expect(t.newId).toHaveBeenCalledOnce();
    expect(writes[0][1]?.body).not.toContain('Changed after sending'); await flush(); t.session.dispose();
  });
  it('serializes payments and commercial operations through one uncertain-write lock', async () => {
    const t = fixture(); await t.load(); t.enqueue({ error: 'service_unavailable' }, 503);
    await expect(t.session.commercial(create)).rejects.toMatchObject({ outcome: 'uncertain' });
    await expect(t.session.commercial(save)).rejects.toMatchObject({ code: 'pending_operation' });
    await expect(t.session.recordPayment({ type: 'customer_payment', invoiceId: 'invoice-a', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic bank' })).rejects.toMatchObject({ code: 'pending_operation' });
    t.enqueue(head(8)); await t.session.refresh(); expect(t.session.getState().snapshot?.revision).toBe(7);
    expect(t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); t.session.dispose();
  });
  it('also prevents a commercial write while a payment is pending', async () => {
    const t = fixture(); await t.load(); t.enqueue({ error: 'service_unavailable' }, 503);
    await expect(t.session.recordPayment({ type: 'customer_payment', invoiceId: 'invoice-a', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic bank' })).rejects.toMatchObject({ outcome: 'uncertain' });
    await expect(t.session.commercial(save)).rejects.toMatchObject({ code: 'pending_operation' }); expect(t.session.getState().pendingKind).toBe('payment'); t.session.dispose();
  });
  it.each(['entityId','action','revision','organizationId','replayed','privateProof'])('does not trust a malformed commercial receipt: %s', async field => {
    const t = fixture(); await t.load(); const bad: Record<string, unknown> = { ...receipt(create) }; bad[field] = field === 'revision' ? 9 : 'foreign-or-private'; t.enqueue(bad);
    await expect(t.session.commercial(create)).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' });
    expect(t.session.getState().pendingKind).toBe('commercial'); expect(JSON.stringify(t.session.getState())).not.toContain('foreign-or-private'); t.session.dispose();
  });
  it.each([401,402,403])('clears data and never publishes a late receipt after HTTP %s denial', async status => {
    const t = fixture(); await t.load(); let finish!: (response: Response) => void;
    t.queue.push(() => new Promise(resolve => { finish = resolve; })); const write = t.session.commercial(create).catch(error => error);
    t.enqueue({ error: 'forbidden' }, status); await expect(t.session.refresh()).rejects.toMatchObject({ outcome: 'unauthorized' });
    finish(Response.json(receipt(create))); expect(await write).toMatchObject({ outcome: 'unauthorized' });
    expect(t.session.getState()).toMatchObject({ status: 'denied', snapshot: null, pending: false, pendingKind: null }); t.session.dispose();
  });
  it.each([['financial_revision_conflict',409],['estimate_revision_conflict',409],['sales_order_source_locked',409],['issued_estimate_locked',409],['estimate_not_found',404],['invalid_financial_pilot_request',422],['customer_already_exists',409],['invalid_request',400],['invalid_request',413],['invalid_request',415]] as const)('requires explicit draft review after definitive %s/%s', async (code,status) => {
    const t = fixture(); await t.load(); t.enqueue({ error: code },status); t.enqueue(overview(8));
    await expect(t.session.commercial(accept)).rejects.toMatchObject({ code, status, outcome: 'rejected' });
    await flush(); expect(t.session.hasPending()).toBe(false); expect(t.session.getState().pendingKind).toBeNull(); await expect(t.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' }); expect(t.newId).toHaveBeenCalledOnce(); t.session.dispose();
  });
  it.each([['financial_configuration_changed',409],['financial_authority_changed',409],['service_unavailable',503]])('keeps exact recovery for potentially postcommit %s', async (code,status) => {
    const t = fixture(); await t.load(); t.enqueue({ error: code },status); await expect(t.session.commercial(create)).rejects.toMatchObject({ code, outcome: 'uncertain' }); expect(t.session.hasPending()).toBe(true); t.session.dispose();
  });
  it('requires initial data and a matching reviewed global revision before starting', async () => {
    const t = fixture(); await expect(t.session.commercial(create)).rejects.toMatchObject({ code: 'read_required' }); await t.load(); await expect(t.session.commercial(create,6)).rejects.toMatchObject({ code: 'financial_snapshot_changed' }); expect(t.newId).not.toHaveBeenCalled(); t.session.dispose();
  });
  it('refuses a private command or accessor before fetching', async () => {
    const t = fixture(); await t.load(); expect(() => t.session.commercial({ ...create, policy: 'private' } as typeof create)).toThrow('invalid_financial_pilot_request');
    let read = false; const dangerous = { type: 'create_customer', get customer() { read = true; return customer; } };
    expect(() => t.session.commercial(dangerous as typeof create)).toThrow('invalid_financial_pilot_request'); expect(read).toBe(false); expect(t.fetcher).toHaveBeenCalledOnce(); t.session.dispose();
  });
  it('reads a strict editable quote bound to tenant, ID and current revision', async () => {
    const t = fixture(); await t.load(); t.enqueue(estimate()); const value = await t.session.readEstimate('estimate-a'); expect(value).toEqual(estimate()); expect(Object.isFrozen(value.lines)).toBe(true);
    expect(t.fetcher.mock.calls.at(-1)?.[0]).toContain('/estimates/estimate-a?revision=7'); t.enqueue({ ...estimate(), notes: 'Read only', privateProof: 'secret' }); await expect(t.session.readEstimate('estimate-a')).rejects.toMatchObject({ code: 'invalid_response' }); t.session.dispose();
  });
  it.each(['foreign-id','foreign-organization','foreign-revision'])('rejects a quote detail for %s', async kind => {
    const t = fixture(); await t.load(); const bad = structuredClone(estimate());
    if (kind === 'foreign-id') (bad.estimate as { id: string }).id = 'other'; else if (kind === 'foreign-organization') (bad as { organizationId: string }).organizationId = expectedUserId; else (bad as { revision: number }).revision = 8;
    t.enqueue(bad); await expect(t.session.readEstimate('estimate-a')).rejects.toMatchObject({ code: 'invalid_response' }); t.session.dispose();
  });
  it('discards an old quote detail after a concurrent refreshed head', async () => {
    const t = fixture(); await t.load(); let finish!: (response: Response) => void;
    t.queue.push(() => new Promise(resolve => { finish = resolve; })); const reading = t.session.readEstimate('estimate-a').catch(error => error);
    t.enqueue(head(8)); t.enqueue(overview(8)); await t.session.refresh(); finish(Response.json(estimate())); expect(await reading).toMatchObject({ code: 'stale_read' }); t.session.dispose();
  });
  it('discards a detail begun before a commercial write and waits for a fresh snapshot', async () => {
    const t = fixture(); await t.load(); let finish!: (response: Response) => void;
    t.queue.push(() => new Promise(resolve => { finish = resolve; })); const reading = t.session.readEstimate('estimate-a').catch(error => error);
    t.enqueue(receipt(create)); t.enqueue(overview(8)); await t.session.commercial(create); finish(Response.json(estimate())); expect(await reading).toMatchObject({ code: 'stale_read' }); await flush(); t.session.dispose();
  });
  it('clears pending commercial work on stop and cannot retry it from a replacement session', async () => {
    const t = fixture(); await t.load(); t.queue.push(() => { throw Error('network'); }); await expect(t.session.commercial(create)).rejects.toMatchObject({ outcome: 'uncertain' }); t.session.stop(); expect(t.session.getState()).toMatchObject({ snapshot: null, pendingKind: null, pending: false }); await expect(t.session.retry()).rejects.toMatchObject({ outcome: 'unauthorized' }); const replacement = fixture(); await replacement.load(); await expect(replacement.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' }); replacement.session.dispose();
  });
});

describe('customer editing through the real V5 session and handlers', () => {
  it('updates the same customer while preserving real money, counters and document snapshots', async () => {
    const t = await customerFixture(); await t.ready(); const before = await projectUsFinancialBookV5(await t.readBook()), review = await t.review();
    const receipt = await t.session.submitCustomerEdit(review, true); await settle(); const after = await projectUsFinancialBookV5(await t.readBook());
    expect(receipt).toMatchObject({ action: 'update_customer', entityId: 'customer-1', revision: review.request.expectedRevision + 1 });
    expect(after.customers.find(c => c.id === 'customer-1')?.name).toBe('Corrected Synthetic Customer'); expect(after.customers).toHaveLength(before.customers.length);
    expect(after.ledger).toEqual(before.ledger); expect(after.counters).toEqual(before.counters); expect(after.invoices).toEqual(before.invoices); expect(after.estimates).toEqual(before.estimates);
    expect(t.register().bankRevision).toBe(0); expect(t.session.getState().snapshot?.revision).toBe(receipt.revision);
    expect(t.requests.filter(r => r.method === 'POST')[0].body).toBe(review.body); expect(t.newId).toHaveBeenCalledOnce();
  });
  it('reads and edits a customer outside the first page without scanning or truncating the record', async () => {
    const t = await customerFixture(); for (let n = 0; n < 26; n++) await t.externalCustomer(`ZZZ Synthetic ${String(n).padStart(2, '0')}`);
    await t.ready(); const target = `external-925`, snapshot = t.session.getState().snapshot!;
    expect(snapshot.customers.items.some(c => c.id === target)).toBe(false); expect(snapshot.customers.total).toBe(27);
    const source = await t.session.readCustomer(target), { id: _id, ...fields } = source.customer;
    const review = t.session.reviewCustomerEdit(source, { ...fields, contactName: 'New contact', email: 'new@example.test', shippingAddress: source.customer.billingAddress });
    await t.session.submitCustomerEdit(review, true); await settle();
    expect((await projectUsFinancialBookV5(await t.readBook())).customers.find(c => c.id === target)).toMatchObject({ name: 'ZZZ Synthetic 25', contactName: 'New contact', email: 'new@example.test', shippingAddress: source.customer.billingAddress });
    expect(t.requests.filter(r => new URL(r.url).pathname.includes('/lists/'))).toHaveLength(0);
  }, 30000);
  it('requires an owned source, the latest owned review and explicit approval', async () => {
    const t = await customerFixture(); await t.ready(); const source = await t.session.readCustomer('customer-1'), { id: _id, ...fields } = source.customer;
    expect(() => t.session.reviewCustomerEdit(structuredClone(source), fields)).toThrow('customer_edit_review_required');
    const other = t.makeSession(); await other.load(); expect(() => other.reviewCustomerEdit(source, fields)).toThrow('customer_edit_review_required');
    const first = t.session.reviewCustomerEdit(source, { ...fields, name: 'First' }), second = t.session.reviewCustomerEdit(source, { ...fields, name: 'Second' });
    await expect(t.session.submitCustomerEdit(first, true)).rejects.toMatchObject({ code: 'customer_edit_review_changed' });
    await expect(t.session.submitCustomerEdit(structuredClone(second), true)).rejects.toMatchObject({ code: 'customer_edit_review_changed' });
    await expect(t.session.submitCustomerEdit(second, false)).rejects.toMatchObject({ code: 'customer_edit_review_changed' });
    expect(() => t.session.commercial(second.request.command)).toThrow('customer_edit_review_required'); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
    await t.session.submitCustomerEdit(second, true); await settle(); expect((await projectUsFinancialBookV5(await t.readBook())).customers[0].name).toBe('Second');
  });
  it('detaches the reviewed draft and invalidates source/review after a common payment mutation', async () => {
    const t = await customerFixture(); await t.ready(); const source = await t.session.readCustomer('customer-1'), { id: _id, ...fields } = source.customer;
    const draft = { ...fields, name: 'Captured' }, review = t.session.reviewCustomerEdit(source, draft); draft.name = 'Later';
    expect(review.request.command.customer.name).toBe('Captured'); await t.session.recordPayment(t.payment); await settle();
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'customer_edit_review_changed' });
    expect(() => t.session.reviewCustomerEdit(source, draft)).toThrow('customer_edit_review_required'); expect((await t.readBook()).events).toHaveLength(1);
  });
  it('invalidates the customer review for a local bank write but preserves it across an external B-only observation', async () => {
    const t = await customerFixture(); await t.ready(); await t.session.refreshBank(); let review = await t.review(); const snapshot = t.session.getState().snapshot;
    expect((await t.externalBank()).status).toBe(200); await t.session.refreshBank(); expect(t.session.getState().snapshot).toBe(snapshot); expect(t.session.getState().bank.head?.bankRevision).toBe(1);
    await t.session.submitCustomerEdit(review, true); await settle(); await t.session.refreshBank(); await t.session.readBankContext(); review = await t.review('Second correction');
    const bankReview = t.session.reviewBankImport({ ...t.importDraft, start: '2026-11-01', end: '2026-11-30', text: 'date,amount,reference\n2026-11-10,100.00,Synthetic next month\n' });
    await t.session.submitBank(bankReview, true); await settle();
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'customer_edit_review_changed' }); expect(t.register().bankRevision).toBe(2);
  });
  it.each(['409', '422', '503', 'malformed', 'lost-reply'] as const)('keeps exact pending after a true commit followed by %s and retries without duplication', async fault => {
    const t = await customerFixture(); await t.ready(); const review = await t.review(); let damaged = false;
    t.intercept(async (req, next) => {
      const result = await next(); if (req.method !== 'POST' || damaged) return result; damaged = true; expect(result.status).toBe(200);
      if (fault === 'lost-reply') throw Error('Synthetic dropped durable reply');
      if (fault === 'malformed') return Response.json({ ...await result.json() as Record<string, unknown>, privateProof: 'not-public' });
      return Response.json({ error: fault === '409' ? 'revision_conflict' : fault === '422' ? 'invalid_financial_pilot_request' : 'financial_service_unavailable' }, { status: Number(fault) });
    });
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ outcome: 'uncertain' });
    expect((await t.readBook()).events).toHaveLength(1); expect(t.session.getState()).toMatchObject({ pendingKind: 'commercial', pending: true, writing: false });
    await expect(t.session.recordPayment(t.payment)).rejects.toMatchObject({ code: 'pending_operation' }); await expect(t.session.commercial(create)).rejects.toMatchObject({ code: 'pending_operation' });
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'pending_operation' });
    await expect(t.session.accounting({ type: 'close_period', periodId: '2026' })).rejects.toMatchObject({ code: 'pending_operation' });
    await expect(t.session.purchasing({} as Parameters<typeof t.session.purchasing>[0])).rejects.toMatchObject({ code: 'pending_operation' });
    await expect(t.session.prepareInvoice({} as Parameters<typeof t.session.prepareInvoice>[0], {} as Parameters<typeof t.session.prepareInvoice>[1])).rejects.toMatchObject({ code: 'pending_operation' });
    await t.session.refreshBank(); expect(() => t.session.reviewBankImport(t.importDraft)).toThrow('bank_read_required');
    const receipt = await t.session.retry(); await settle(); expect(receipt).toMatchObject({ action: 'update_customer', revision: review.request.expectedRevision + 1, entityId: 'customer-1' });
    const posts = t.requests.filter(r => r.method === 'POST'); expect(posts).toHaveLength(2); expect(posts[0].body).toBe(review.body); expect(posts[1].body).toBe(review.body); expect((await t.readBook()).events).toHaveLength(1); expect(t.newId).toHaveBeenCalledOnce(); expect(t.session.hasPending()).toBe(false);
  });
  it('returns a historical receipt with newer known F/B without adopting its F or recreating pending on failed refresh', async () => {
    const t = await customerFixture(); await t.ready(); const review = await t.review(); let drop = true;
    t.intercept(async (req, next) => { const result = await next(); if (req.method === 'POST' && drop) { drop = false; throw Error('Synthetic durable reply loss'); } return result; });
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ outcome: 'uncertain' });
    await t.externalCustomer(); await t.externalCustomer(); expect((await t.externalBank()).status).toBe(200); await t.session.refreshBank(); const newer = t.session.getState().bank.head!;
    expect(newer.revision).toBe(review.request.expectedRevision + 3); expect(newer.bankRevision).toBe(1);
    t.intercept(async (req, next) => new URL(req.url).pathname.endsWith('/snapshot') ? Response.json({ error: 'financial_service_unavailable' }, { status: 503 }) : next());
    const receipt = await t.session.retry(); await settle(); expect(receipt.revision).toBe(review.request.expectedRevision + 1); expect(t.session.getState().bank.head).toBeNull(); expect(t.session.hasPending()).toBe(false); expect(t.session.getState().requiresRefresh).toBe(true);
    t.intercept(); await t.session.load(); expect(t.session.getState().snapshot?.revision).toBe(newer.revision); expect((await t.readBook()).events).toHaveLength(3);
  });
  it('keeps a real uncommitted CAS conflict pending until explicit lifecycle purge', async () => {
    const t = await customerFixture(); await t.ready(); const review = await t.review(); await t.externalCustomer();
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'revision_conflict', outcome: 'uncertain' });
    await expect(t.session.retry()).rejects.toMatchObject({ code: 'revision_conflict', outcome: 'uncertain' });
    expect(t.requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([review.body, review.body]); expect((await t.readBook()).events).toHaveLength(1);
    t.session.stop(); expect(t.session.getState()).toMatchObject({ snapshot: null, pending: false, status: 'stopped' });
    const replacement = t.makeSession(); await replacement.load(); await expect(replacement.retry()).rejects.toMatchObject({ code: 'no_pending_operation' });
    expect((await projectUsFinancialBookV5(await t.readBook())).customers.find(c => c.id === 'customer-1')?.name).toBe(review.before.name);
  });
  it.each(['financial', 'composite'] as const)('invalidates the review as soon as %s HEAD advances F, before a failing snapshot returns', async kind => {
    const t = await customerFixture(); await t.ready(); const review = await t.review(), held = deferred<Response>(); await t.externalCustomer();
    t.intercept(async (req, next) => new URL(req.url).pathname.endsWith('/snapshot') ? held.promise : next());
    const refreshing = (kind === 'financial' ? t.session.refresh() : t.session.refreshBank()).catch(error => error); await settle();
    expect(t.session.getState().requiresRefresh).toBe(true); await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'read_required' });
    held.resolve(Response.json({ error: 'financial_service_unavailable' }, { status: 503 })); await refreshing;
    t.intercept(); await t.session.load(); await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'customer_edit_review_changed' }); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it.each(['payment', 'stop'] as const)('does not own a late customer detail after %s', async action => {
    const t = await customerFixture(); await t.ready(); const held = deferred<Response>(), started = deferred<Response>();
    t.intercept(async (req, next) => { const response = await next(); if (new URL(req.url).pathname.includes('/customers/')) { started.resolve(response); return held.promise; } return response; });
    const reading = t.session.readCustomer('customer-1').catch(error => error), old = await started.promise;
    if (action === 'payment') { await t.session.recordPayment(t.payment); await settle(); } else t.session.stop();
    held.resolve(old); expect(await reading).toMatchObject({ code: action === 'payment' ? 'stale_read' : 'session_disposed' });
    if (action === 'stop') expect(t.session.getState()).toMatchObject({ status: 'stopped', snapshot: null });
  });
  it.each(['wrong-id', 'wrong-tenant', 'wrong-F', 'extra'] as const)('does not trust or own a customer response with %s', async kind => {
    const t = await customerFixture(); await t.ready();
    t.intercept(async (req, next) => { const result = await next(); if (!new URL(req.url).pathname.includes('/customers/')) return result; const value = await result.json() as { customer: { id: string }; organizationId: string; revision: number; privateBook?: unknown };
      if (kind === 'wrong-id') value.customer.id = 'another'; if (kind === 'wrong-tenant') value.organizationId = expectedUserId; if (kind === 'wrong-F') value.revision++; if (kind === 'extra') value.privateBook = {}; return Response.json(value); });
    await expect(t.session.readCustomer('customer-1')).rejects.toMatchObject({ code: 'invalid_response' }); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it.each([401, 402, 403])('purges ownership and pending on current denial %s', async status => {
    const t = await customerFixture(); await t.ready(); const review = await t.review(); t.deny(status);
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ outcome: 'unauthorized' });
    expect(t.session.getState()).toMatchObject({ status: 'denied', snapshot: null, pending: false }); await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ outcome: 'unauthorized' }); expect((await t.readBook()).events).toHaveLength(0);
  });
  it('does not publish a review if the UUID callback synchronously stops the session', async () => {
    const t = await customerFixture(); await t.ready(); const source = await t.session.readCustomer('customer-1'), { id: _id, ...fields } = source.customer;
    t.newId.mockImplementationOnce(() => { t.session.stop(); return requestId; });
    expect(() => t.session.reviewCustomerEdit(source, fields)).toThrow('session_disposed'); expect(t.session.getState()).toMatchObject({ status: 'stopped', snapshot: null }); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it.each(['start', 'confirmed'] as const)('does not reenter or return an edit after a subscriber stops at write %s', async moment => {
    const t = await customerFixture(); await t.ready(); const review = await t.review(); let stopped = false;
    t.session.subscribe(() => { const state = t.session.getState(); if (!stopped && state.writing && (moment === 'start' ? state.pending : !state.pending)) { stopped = true; t.session.stop(); } });
    await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'session_disposed' });
    expect(t.session.getState()).toMatchObject({ status: 'stopped', snapshot: null, pending: false, writing: false }); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(moment === 'start' ? 0 : 1);
  });
  it('refuses a superseded, stopped or forged review before any write', async () => {
    const t = await customerFixture(); await t.ready(); const review = await t.review(); await expect(t.session.submitCustomerEdit({} as CustomerEditReview, true)).rejects.toMatchObject({ code: 'customer_edit_review_changed' });
    t.session.stop(); await expect(t.session.submitCustomerEdit(review, true)).rejects.toMatchObject({ code: 'session_disposed' }); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
});
