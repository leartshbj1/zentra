import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { createUsFinancialPilotSellerHandlers } from './us-financial-pilot-seller-server';
import { applyUsFinancialPilotSellerProof, validateUsFinancialPilotSellerRead, type UsFinancialPilotSellerCommand, type UsFinancialPilotSellerPort, type UsFinancialPilotSellerPresentation, type UsFinancialPilotSellerProof, type UsFinancialPilotSellerRequest } from './us-financial-pilot-seller';
import { createBrowserUsFinancialPilotSession, type BrowserUsFinancialPilotOptions, type BrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import { buildSellerReview } from './browser-us-financial-pilot-seller-input';
import { browserUsFinancialPilotSellerCopy, browserUsFinancialPilotSellerErrorCopy } from './browser-us-financial-pilot-seller-copy';
import { createBrowserUsFinancialPilotExportSession, type BrowserUsFinancialPilotExportSession } from './browser-us-financial-pilot-export-session';
import type { UsFinancialPilotExportSelector } from './us-financial-pilot-export-contract';

const org = '11111111-1111-4111-8111-111111111111', origin = 'https://zentraapp.ch';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = (displayName = 'Corrected Synthetic Seller'): UsFinancialPilotSellerCommand => ({ type: 'update_seller_presentation', displayName, contactEmail: 'corrected@example.test', contactPhone: null });
const sessions: BrowserUsFinancialPilotSession[] = [];
const exportSessions: BrowserUsFinancialPilotExportSession[] = [];
afterEach(() => { for (const session of exportSessions.splice(0)) session.dispose(); for (const session of sessions.splice(0)) session.dispose(); vi.restoreAllMocks(); });
async function settle() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/** The browser owner, HTTP handlers, V5 financial kernel and seller transition
 * are real. Auth/D1, seller persistence and head B are controlled memory ports;
 * faults affect transport replies only. This is not PostgreSQL or browser QA. */
async function fixture() {
  const original = await financialKernelFixture({ tax: '0', paid: '10000' });
  const data = JSON.parse(JSON.stringify(original).replaceAll(original.actor.organizationId, org)) as typeof original;
  const book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), financial = await createInMemoryUsFinancialKernelStoreV5(book, data.policy, value => value);
  const readBook = async () => await financial.read(org) as UsFinancialBookV5;
  let actor: FinancialAuthority = data.actor, denied = 0, writesEnabled = true, bankRevision = 0, sequence = 100, externalSequence = 1000;
  let presentation: UsFinancialPilotSellerPresentation = { origin: 'legacy-frozen', baseSellerRevision: 4, sellerRevision: 4, changeCount: 0,
    profile: { displayName: 'Original Synthetic Seller', contactEmail: 'original@example.test', contactPhone: '+1 555 0100' }, updatedBy: data.actor.userId, updatedAt: '2026-10-10T11:00:00.123456Z', changeSha256: null };
  const receipts = new Map<string, UsFinancialPilotSellerProof>();
  const head = async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: (await readBook()).revision, bankRevision, sellerRevision: presentation.sellerRevision });
  const read = async () => validateUsFinancialPilotSellerRead({ head: await head(), presentation }, org);
  const store: UsFinancialPilotSellerPort = {
    read: vi.fn(read), head: vi.fn(head), receipt: vi.fn(async requestId => receipts.get(requestId) ?? null),
    append: vi.fn(async input => {
      const previous = receipts.get(input.request.requestId);
      if (previous) { if (canonicalErpJson(previous) !== canonicalErpJson(input.proof)) throw new ErpError('seller_idempotency_conflict', 409); return previous; }
      const next = await applyUsFinancialPilotSellerProof(await read(), input.proof); presentation = next.presentation;
      receipts.set(input.request.requestId, input.proof); return input.proof;
    }),
  };
  const shared = { enabled: () => true, authority: async () => { if (denied) throw new AccountPublicError('Synthetic denial', denied); return { mode: 'browser' as const, actor }; }, configuration: async () => data.configuration,
    scope: async () => ({ scope: { organizationId: org, actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 }), rateLimit: async () => {}, diagnostic: () => {} };
  const financialDeps: UsFinancialPilotDependencies = { ...shared, store: () => ({ ...financial, head: async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: (await readBook()).revision }) }) };
  const finance = createUsFinancialPilotHandlers(financialDeps), seller = createUsFinancialPilotSellerHandlers({ ...shared, store: () => store, writeEnabled: async () => writesEnabled });
  const base = `/api/international/workspaces/${org}/financial-pilot`;
  async function dispatch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.slice(base.length);
    if (path === '/snapshot') return finance.SNAPSHOT(request, org);
    if (path === '/head') return finance.HEAD(request, org);
    if (path === '/operations') return finance.POST(request, org);
    if (path === '/seller') return request.method === 'POST' ? seller.POST(request, org) : seller.GET(request, org);
    throw Error(`Unexpected synthetic seller route: ${path}`);
  }
  type Intercept = (request: Request, next: () => Promise<Response>) => Promise<Response>;
  let intercept: Intercept | undefined;
  const requests: { url: string; method: string; body: string }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin');
    const request = new Request(new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, origin), { ...init, headers });
    requests.push({ url: request.url, method: request.method, body: request.method === 'POST' ? await request.clone().text() : '' });
    return intercept ? intercept(request, () => dispatch(request)) : dispatch(request);
  });
  const newId = vi.fn(() => id(++sequence));
  const makeSession = (options: Pick<BrowserUsFinancialPilotOptions, 'sellerInstalled' | 'sellerWriteEnabled'> = { sellerInstalled: true, sellerWriteEnabled: true }) => {
    const session = createBrowserUsFinancialPilotSession({ organizationId: org, expectedUserId: actor.userId, fetch: fetcher, newId, environment: { isVisible: () => true, isOnline: () => true, subscribe: () => () => {} }, ...options });
    sessions.push(session); return session;
  };
  const session = makeSession();
  const ready = async (target = session) => { await target.load(); return target.readSeller(); };
  const review = async (name?: string) => session.reviewSeller(await session.readSeller(), command(name));
  const externalSeller = async (name: string) => {
    const current = await read(), request: UsFinancialPilotSellerRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: id(++externalSequence), expectedRevision: current.head.revision, expectedSellerRevision: current.head.sellerRevision, command: command(name) };
    const response = await seller.POST(new Request(origin + base + '/seller', { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': actor.userId, 'Content-Type': 'application/json' }, body: JSON.stringify(request) }), org);
    expect(response.status).toBe(200); return response.json();
  };
  const externalFinance = async () => executeUsFinancialKernelV5({ ...data, store: financial, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }), resolveTax: async () => { throw Error('No provider in seller tests'); } },
    { idempotencyKey: `synthetic-external-${++externalSequence}`, expectedRevision: (await readBook()).revision, command: { type: 'erp_command', request: { type: 'save_customer', customer: { id: `external-${externalSequence}`, organizationId: org, kind: 'business', name: 'Independent Synthetic Customer', billingAddress: data.configuration.address, paymentTermsDays: 30 } } } });
  return { ...data, session, makeSession, newId, ready, review, requests, store, readBook, read, head, externalSeller, externalFinance, receipts,
    intercept: (value?: Intercept) => { intercept = value; }, writes: (value: boolean) => { writesEnabled = value; }, deny: (value: number) => { denied = value; },
    role: (value: FinancialAuthority['role']) => { actor = { ...actor, role: value }; }, bank: (value: number) => { bankRevision = value; } };
}

describe('seller presentation through the real financial browser owner', () => {
  it('requires its own read/review, explicit approval and a change before allocating one request identity', async () => {
    const t = await fixture(), source = await t.ready(), review = t.session.reviewSeller(source, command());
    expect(() => t.session.reviewSeller(structuredClone(source), command())).toThrow(expect.objectContaining({ code: 'seller_review_required' }));
    const other = t.makeSession(); await t.ready(other);
    expect(() => other.reviewSeller(source, command())).toThrow(expect.objectContaining({ code: 'seller_review_required' }));
    expect(() => t.session.submitSeller(buildSellerReview(source, command()), true)).toThrow(expect.objectContaining({ code: 'seller_review_required' }));
    expect(() => t.session.submitSeller(structuredClone(review), true)).toThrow(expect.objectContaining({ code: 'seller_review_required' }));
    await expect(t.session.submitSeller(review, false)).rejects.toMatchObject({ code: 'seller_approval_required' });
    const unchanged = t.session.reviewSeller(source, { type: 'update_seller_presentation', displayName: source.presentation.profile.displayName, contactEmail: source.presentation.profile.contactEmail ?? null, contactPhone: source.presentation.profile.contactPhone ?? null });
    expect(() => t.session.submitSeller(unchanged, true)).toThrow(expect.objectContaining({ code: 'seller_no_changes' }));
    expect(t.newId).not.toHaveBeenCalled(); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it('saves S alone, preserving the exact financial snapshot and complete kernel with no snapshot GET', async () => {
    const t = await fixture(); await t.ready(); const before = canonicalErpJson(await t.readBook()), snapshot = t.session.getState().snapshot, review = await t.review();
    t.requests.length = 0;
    const receipt = await t.session.submitSeller(review, true); await settle(); await t.session.refresh();
    expect(receipt).toMatchObject({ sourceRevision: snapshot!.revision, sellerRevision: 5, replayed: false }); expect(t.newId).toHaveBeenCalledOnce();
    expect(canonicalErpJson(await t.readBook())).toBe(before); expect(t.session.getState().snapshot).toBe(snapshot);
    expect(t.requests.filter(r => new URL(r.url).pathname.endsWith('/snapshot'))).toHaveLength(0);
    expect(t.session.getState()).toMatchObject({ pending: false, pendingKind: null, seller: { head: { sellerRevision: 5 }, lastReceipt: receipt } });
    expect((await t.session.readSeller()).presentation.profile).toEqual(review.profile); expect(t.store.append).toHaveBeenCalledOnce();
  });
  it('retries the exact lost-reply body after independent S/F changes and write disablement', async () => {
    const t = await fixture(); await t.ready(); const review = await t.review();
    t.intercept(async (request, next) => { const response = await next(); return request.method === 'POST' ? Response.json({ error: 'financial_service_unavailable' }, { status: 503 }) : response; });
    await expect(t.session.submitSeller(review, true)).rejects.toMatchObject({ status: 503 });
    const original = t.requests.find(r => r.method === 'POST')!.body;
    expect(t.session.getState()).toMatchObject({ pending: true, pendingKind: 'seller', seller: { pendingReview: review } });
    await t.externalSeller('Independent Synthetic Seller'); await t.externalFinance(); t.writes(false); t.intercept();
    await expect(t.session.readSeller()).rejects.toMatchObject({ code: 'pending_operation' });
    const recovered = await t.session.retrySeller(); await settle(); await t.session.refresh();
    expect(t.requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([original, original]); expect(t.newId).toHaveBeenCalledOnce();
    expect(recovered).toMatchObject({ sourceRevision: review.source.head.revision, sellerRevision: 5, replayed: true }); expect(t.store.append).toHaveBeenCalledTimes(2);
    expect(t.session.getState().seller?.head).toMatchObject({ revision: review.source.head.revision + 1, sellerRevision: 6 });
    expect((await t.session.readSeller()).presentation.profile.displayName).toBe('Independent Synthetic Seller');
  });
  it.each([409, 422, 200])('retains an exact pending request after a post-commit %s reply and blocks competing intents', async status => {
    const t = await fixture(); await t.ready(); const review = await t.review();
    t.intercept(async (request, next) => { const response = await next(); return request.method === 'POST' ? Response.json(status === 200 ? { privateMalformedReceipt: true } : { error: status === 409 ? 'seller_revision_conflict' : 'invalid_financial_pilot_request' }, { status }) : response; });
    await expect(t.session.submitSeller(review, true)).rejects.toBeDefined();
    expect(t.session.getState()).toMatchObject({ pending: true, pendingKind: 'seller', writing: false }); expect(t.receipts.size).toBe(1);
    await expect(t.session.readSeller()).rejects.toMatchObject({ code: 'pending_operation' });
    expect(() => t.session.reviewSeller(review.source, command('Competing Seller'))).toThrow();
    await expect(t.session.recordPayment({ type: 'customer_payment', invoiceId: 'invoice-1', amountMinor: '1', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic payment' })).rejects.toMatchObject({ code: 'pending_operation' });
    const body = t.requests.find(r => r.method === 'POST')!.body; t.intercept();
    expect(await t.session.retrySeller()).toMatchObject({ sellerRevision: 5, replayed: true });
    expect(t.requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([body, body]); expect(t.newId).toHaveBeenCalledOnce(); expect(t.store.append).toHaveBeenCalledOnce();
  });
  it('preserves owned review on B alone, invalidates it on S, and never regresses a composite floor', async () => {
    const t = await fixture(); await t.ready(); const snapshot = t.session.getState().snapshot, review = await t.review(), oldHead = await t.head();
    t.bank(1); await t.session.refresh();
    expect(t.session.getState().seller?.pendingReview).toBe(review); expect(t.session.getState().snapshot).toBe(snapshot);
    await t.externalSeller('New Current Seller'); await t.session.refresh();
    expect(t.session.getState().snapshot).toBe(snapshot); expect(t.session.getState().seller?.pendingReview).toBeNull();
    expect(() => t.session.submitSeller(review, true)).toThrow(expect.objectContaining({ code: 'seller_review_required' }));
    t.intercept(async (request, next) => new URL(request.url).searchParams.get('view') === 'head' ? Response.json(oldHead) : next());
    await expect(t.session.refresh()).rejects.toMatchObject({ code: 'stale_read' });
    expect(t.session.getState().seller?.head).toMatchObject({ bankRevision: 1, sellerRevision: 5 }); expect(t.newId).not.toHaveBeenCalled();
  });
  it('refuses invoice and report exports before GET while the real owner retains a seller pending request', async () => {
    const t = await fixture(); await t.ready(); const review = await t.review();
    t.intercept(async (request, next) => { const response = await next(); return request.method === 'POST' ? Response.json({ error: 'financial_service_unavailable' }, { status: 503 }) : response; });
    await expect(t.session.submitSeller(review, true)).rejects.toMatchObject({ status: 503 });
    const pending = t.session.getState(), originalBody = t.requests.find(r => r.method === 'POST')!.body;
    const fetcher = vi.fn(async (): Promise<Response> => { throw Error('An export GET must not start while seller is pending'); });
    const exports = createBrowserUsFinancialPilotExportSession({ organizationId: org, expectedUserId: t.actor.userId, financialSession: t.session, fetch: fetcher }); exportSessions.push(exports);
    const selectors: UsFinancialPilotExportSelector[] = [
      { kind: 'invoice', invoiceId: 'invoice-1', revision: review.source.head.revision, language: 'en', format: 'pdf' },
      { kind: 'report', reportType: 'receivables', revision: review.source.head.revision, language: 'en', format: 'csv' },
    ];
    for (const selector of selectors) await expect(exports.file(selector)).rejects.toMatchObject({ code: 'financial_export_owner_changed', status: 409 });
    expect(fetcher).not.toHaveBeenCalled(); expect(t.session.getState()).toBe(pending); expect(t.session.hasPending()).toBe(true);
    expect(t.requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([originalBody]); expect(t.newId).toHaveBeenCalledOnce();
  });
  it('aborts invoice and report exports in flight on real seller-pending publication without a fabricated file response', async () => {
    const t = await fixture(); await t.ready(); const review = await t.review(), started = deferred<void>(), signals: AbortSignal[] = [];
    // This transport never supplies PDF/CSV bytes or invokes a renderer. It
    // holds both fetches until the real financial owner aborts their signals.
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal; if (!signal) return Promise.reject(Error('Expected an export cancellation signal'));
      signals.push(signal); if (signals.length === 2) started.resolve();
      return new Promise<Response>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('Synthetic held export aborted', 'AbortError')), { once: true }); });
    });
    const selectors: UsFinancialPilotExportSelector[] = [
      { kind: 'invoice', invoiceId: 'invoice-1', revision: review.source.head.revision, language: 'en', format: 'pdf' },
      { kind: 'report', reportType: 'receivables', revision: review.source.head.revision, language: 'en', format: 'csv' },
    ];
    const rejected = selectors.map(selector => {
      const exports = createBrowserUsFinancialPilotExportSession({ organizationId: org, expectedUserId: t.actor.userId, financialSession: t.session, fetch: fetcher }); exportSessions.push(exports);
      return expect(exports.file(selector)).rejects.toMatchObject({ code: 'financial_export_owner_changed', status: 409 });
    });
    await started.promise;
    t.intercept(async (request, next) => { const response = await next(); return request.method === 'POST' ? Response.json({ error: 'financial_service_unavailable' }, { status: 503 }) : response; });
    await expect(t.session.submitSeller(review, true)).rejects.toMatchObject({ status: 503 }); await Promise.all(rejected);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(t.session.getState()).toMatchObject({ pending: true, pendingKind: 'seller', writing: false });
    expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(1); expect(t.store.append).toHaveBeenCalledOnce(); expect(t.newId).toHaveBeenCalledOnce();
  });
  it('invalidates an old read after S advances while its HTTP result is held', async () => {
    const t = await fixture(); await t.ready(); const gate = deferred<void>(), observed = deferred<void>();
    t.intercept(async (request, next) => { const response = await next(); if (new URL(request.url).pathname.endsWith('/seller') && !new URL(request.url).searchParams.has('view')) { observed.resolve(); await gate.promise; } return response; });
    const pending = t.session.readSeller(); const rejected = expect(pending).rejects.toMatchObject({ code: 'seller_review_changed' }); await observed.promise;
    await t.externalSeller('Seller Changed During Read'); await t.session.refresh(); gate.resolve(); await rejected;
    expect(t.session.getState().seller?.read).toBeNull(); expect(t.session.getState().seller?.head?.sellerRevision).toBe(5);
  });
  it('reloads finance after F alone advances and requires a fresh seller read and review', async () => {
    const t = await fixture(); await t.ready(); const review = await t.review(), snapshot = t.session.getState().snapshot;
    await t.externalFinance(); t.requests.length = 0; await t.session.refresh();
    expect(t.session.getState().snapshot?.revision).toBe(snapshot!.revision + 1); expect(t.session.getState().seller?.head?.sellerRevision).toBe(4);
    expect(t.requests.filter(r => new URL(r.url).pathname.endsWith('/snapshot'))).toHaveLength(1);
    expect(() => t.session.submitSeller(review, true)).toThrow(expect.objectContaining({ code: 'seller_review_required' }));
    expect((await t.session.readSeller()).head.revision).toBe(snapshot!.revision + 1); expect(t.newId).not.toHaveBeenCalled();
  });
  it('suppresses a held receipt after stop and purges the original pending review', async () => {
    const t = await fixture(); await t.ready(); const review = await t.review(), gate = deferred<void>(), committed = deferred<void>();
    t.intercept(async (request, next) => { const response = await next(); if (request.method === 'POST') { committed.resolve(); await gate.promise; } return response; });
    const pending = t.session.submitSeller(review, true), rejected = expect(pending).rejects.toMatchObject({ code: 'session_disposed' });
    await committed.promise; t.session.stop(); gate.resolve(); await rejected;
    expect(t.receipts.size).toBe(1); expect(t.session.getState()).toMatchObject({ status: 'stopped', pending: false, seller: { pendingReview: null, lastReceipt: null, read: null } });
  });
  it('stops reentrantly before sending and leaves no pending intent or append', async () => {
    const t = await fixture(); await t.ready(); const review = await t.review();
    const unsubscribe = t.session.subscribe(() => { if (t.session.getState().writing) t.session.stop(); });
    await expect(t.session.submitSeller(review, true)).rejects.toMatchObject({ code: 'session_disposed' }); unsubscribe();
    expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0); expect(t.store.append).not.toHaveBeenCalled(); expect(t.session.hasPending()).toBe(false);
  });
  it.each(['admin', 'accountant'] as const)('allows %s to read under the real handler and forbids its write', async role => {
    const t = await fixture(); t.role(role); await t.ready(); const review = await t.review();
    await expect(t.session.submitSeller(review, true)).rejects.toMatchObject({ status: 403 });
    expect(t.store.append).not.toHaveBeenCalled(); expect(t.session.getState()).toMatchObject({ status: 'denied', seller: { read: null, pendingReview: null } });
  });
  it('keeps installed read-only mode readable and legacy mode free of seller HTTP', async () => {
    const t = await fixture(), readOnly = t.makeSession({ sellerInstalled: true, sellerWriteEnabled: false }), source = await t.ready(readOnly), review = readOnly.reviewSeller(source, command());
    await expect(readOnly.submitSeller(review, true)).rejects.toMatchObject({ code: 'seller_approval_required' }); expect(t.newId).not.toHaveBeenCalled();
    const legacy = t.makeSession({ sellerInstalled: false, sellerWriteEnabled: false }); t.requests.length = 0;
    await legacy.load(); await legacy.refresh(); expect(legacy.getState().seller).toBeUndefined(); expect(t.requests.some(r => new URL(r.url).pathname.endsWith('/seller'))).toBe(false);
  });
  it('provides all seller states and safe recovery copy in the four supported languages', () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const copy = browserUsFinancialPilotSellerCopy[language]; for (const value of Object.values(copy)) expect(value.trim().length).toBeGreaterThan(0);
      expect(browserUsFinancialPilotSellerErrorCopy(language, 'seller_writes_disabled')).toBe(copy.writesDisabled);
      expect(browserUsFinancialPilotSellerErrorCopy(language, 'seller_revision_conflict')).toBe(copy.changed);
      expect(browserUsFinancialPilotSellerErrorCopy(language, 'invalid_seller_input')).toBe(copy.invalid);
      expect(browserUsFinancialPilotSellerErrorCopy(language, 'private-diagnostic')).toBe(copy.unavailable);
    }
  });
});
