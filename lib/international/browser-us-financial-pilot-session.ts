import {
  validateUsFinancialPilotHead, validateUsFinancialPilotOverview, validateUsFinancialPilotPage,
  validateUsFinancialPilotInvoiceDetail, validateUsFinancialPilotReports,
  type UsFinancialPilotOverview, type UsFinancialPilotPage, type UsFinancialPilotInvoiceRow,
  type UsFinancialPilotInvoiceDetail, type UsFinancialPilotReports, type UsFinancialPilotReportQuery,
  financialPilotCursorOffset, type UsFinancialPilotListKind,
} from './us-financial-pilot-contract';
import { validateUsFinancialPilotPaymentRequest, validateUsFinancialPilotPaymentReceipt, type UsFinancialPilotPaymentRequest, type UsFinancialPilotPaymentReceipt } from './us-financial-pilot-payment';
import { validateUsFinancialPilotCommercialRequest, validateUsFinancialPilotCommercialReceipt, type UsFinancialPilotCommercialRequest, type UsFinancialPilotCommercialCommand, type UsFinancialPilotCommercialReceipt } from './us-financial-pilot-commercial';
import { validateUsFinancialPilotEstimateDetail, type UsFinancialPilotEstimateDetail } from './us-financial-pilot-commercial-projection';
import { snapshotPrivateJson } from './private-json';
import { validateUsFinancialPilotInvoiceRequest, validateUsFinancialPilotInvoicePreview, validateUsFinancialPilotInvoiceReceipt, validateUsFinancialPilotTaxCatalogue, type UsFinancialPilotInvoiceRequest, type UsFinancialPilotInvoiceChoices, type UsFinancialPilotInvoicePreview, type UsFinancialPilotInvoiceReceipt, type UsFinancialPilotTaxCatalogue } from './us-financial-pilot-invoice';

export type BrowserUsFinancialPilotPayment = UsFinancialPilotPaymentRequest['command'];
export type BrowserUsFinancialPilotReceipt = UsFinancialPilotPaymentReceipt;
export type BrowserUsFinancialPilotOperationReceipt = BrowserUsFinancialPilotReceipt | UsFinancialPilotCommercialReceipt;
export type BrowserUsFinancialPilotInvoiceResult = UsFinancialPilotInvoicePreview | UsFinancialPilotInvoiceReceipt;
export class BrowserUsFinancialPilotError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized') {
    super(code); this.name = 'BrowserUsFinancialPilotError';
  }
}
export interface BrowserUsFinancialPilotState {
  readonly status: 'idle' | 'loading' | 'ready' | 'denied' | 'stopped';
  readonly snapshot: UsFinancialPilotOverview | null;
  readonly refreshing: boolean; readonly writing: boolean; readonly pending: boolean; readonly requiresRefresh: boolean;
  readonly pendingKind: 'payment' | 'commercial' | 'invoice_prepare' | 'invoice_issue' | null;
  readonly invoiceReview: UsFinancialPilotInvoicePreview | null;
  readonly error: BrowserUsFinancialPilotError | null;
}
export interface BrowserUsFinancialPilotEnvironment {
  isVisible(this: void): boolean; isOnline(this: void): boolean;
  subscribe(this: void, listener: () => void): () => void;
}
export interface BrowserUsFinancialPilotOptions {
  readonly organizationId: string; readonly expectedUserId: string;
  readonly fetch?: typeof globalThis.fetch; readonly newId?: () => string;
  readonly environment?: BrowserUsFinancialPilotEnvironment;
}
export interface BrowserUsFinancialPilotSession {
  getState(this: void): BrowserUsFinancialPilotState;
  subscribe(this: void, listener: () => void): () => void;
  start(this: void): void; stop(this: void): void; dispose(this: void): void;
  load(this: void): Promise<UsFinancialPilotOverview>;
  refresh(this: void): Promise<UsFinancialPilotOverview | null>;
  readInvoices(this: void, cursor?: string, revision?: number): Promise<UsFinancialPilotPage<UsFinancialPilotInvoiceRow>>;
  readList(this: void, kind: Exclude<UsFinancialPilotListKind, 'invoices'>, cursor?: string, revision?: number): Promise<UsFinancialPilotPage>;
  readInvoice(this: void, invoiceId: string, revision?: number, cursors?: Readonly<{ paymentCursor?: string; creditCursor?: string }>): Promise<UsFinancialPilotInvoiceDetail>;
  readReports(this: void, query: UsFinancialPilotReportQuery): Promise<UsFinancialPilotReports>;
  readEstimate(this: void, estimateId: string, revision?: number): Promise<UsFinancialPilotEstimateDetail>;
  recordPayment(this: void, command: BrowserUsFinancialPilotPayment, expectedRevision?: number): Promise<BrowserUsFinancialPilotReceipt>;
  commercial(this: void, command: UsFinancialPilotCommercialCommand, expectedRevision?: number): Promise<UsFinancialPilotCommercialReceipt>;
  readTaxCodes(this: void, query?: Readonly<{ code?: string; cursor?: string }>): Promise<UsFinancialPilotTaxCatalogue>;
  prepareInvoice(this: void, command: UsFinancialPilotInvoiceRequest['command'], choices: UsFinancialPilotInvoiceChoices, expectedRevision?: number): Promise<UsFinancialPilotInvoicePreview>;
  issueInvoice(this: void): Promise<UsFinancialPilotInvoiceReceipt>;
  retryInvoice(this: void): Promise<BrowserUsFinancialPilotInvoiceResult>;
  clearInvoiceReview(this: void): void;
  retry(this: void): Promise<BrowserUsFinancialPilotOperationReceipt>;
  hasPending(this: void): boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicErrors = new Set(['financial_snapshot_changed', 'financial_revision_conflict', 'financial_authority_changed', 'financial_test_grant_changed', 'financial_test_grant_required', 'financial_policy_unavailable', 'financial_configuration_changed', 'financial_upgrade_required', 'financial_capability_unavailable', 'financial_append_unavailable', 'financial_book_too_large', 'financial_permission_required', 'management_entitlement_required', 'session_changed', 'forbidden', 'unauthorized', 'invalid_financial_request', 'invalid_financial_date', 'invalid_request', 'invoice_not_found', 'accounting_period_not_open', 'accounting_period_closed', 'payment_exceeds_balance', 'overpayment', 'revision_conflict', 'idempotency_conflict', 'rate_limited', 'service_unavailable', 'financial_service_unavailable', 'financial_pilot_unavailable', 'financial_pilot_opt_in_required', 'financial_pilot_opt_in_changed', 'financial_book_required', 'financial_source_changed', 'financial_clock_reversed', 'financial_immutable', 'financial_tax_plan_required', 'invalid_financial_pilot_request', 'invalid_financial_pilot_cursor', 'settlement_amount_conflict', 'account_not_found', 'cash_flow_classification_required', 'tenant_mismatch', 'feature_unavailable', 'edition_unavailable', 'configuration_changed']);
const rejectedConflicts = new Set(['financial_snapshot_changed', 'financial_revision_conflict', 'revision_conflict', 'idempotency_conflict']);
const rejectedPayments: Readonly<Record<string, number>> = { settlement_amount_conflict: 409, payment_exceeds_balance: 422, accounting_period_not_open: 409, invoice_not_found: 404, invalid_financial_pilot_request: 422, invalid_financial_date: 422 };
const rejectedCommercial: Readonly<Record<string, readonly number[]>> = {
  invalid_financial_pilot_request: [422], invalid_financial_date: [422], invalid_financial_request: [422],
  invalid_request: [400, 413, 415, 422], method_not_allowed: [405],
  estimate_not_found: [404], customer_required: [422], customer_already_exists: [409],
  financial_pilot_record_not_found: [404], estimate_revision_conflict: [409],
  sales_order_source_locked: [409], issued_estimate_locked: [409],
  project_not_found: [422], project_archived: [409], project_customer_mismatch: [422],
  number_sequence_exhausted: [409],
};
for (const code of Object.keys(rejectedCommercial)) publicErrors.add(code);
const rejectedInvoice: Readonly<Record<string, readonly number[]>> = {
  // These codes are structurally before the issue executor. Context, source,
  // period and provider errors can also arise after append during postflight.
  tax_review_changed: [409], tax_preparation_required: [409],
  invalid_financial_pilot_request: [422], invalid_request: [400, 413, 415, 422],
};
for (const code of Object.keys(rejectedInvoice)) publicErrors.add(code);
for (const code of ['tax_preparation_conflict','unsupported_tax_request','binding_unavailable','tax_binding_changed','tax_configuration_changed','tax_calculation_expired','invoice_already_issued','sales_order_confirmation_required','invalid_tax_date','financial_invoice_fixture_disabled']) publicErrors.add(code);
for (const code of ['tax_provider_unavailable', 'tax_catalogue_unavailable', 'tax_context_unavailable', 'tax_provider_rejected', 'financial_tax_provider_unavailable', 'financial_tax_catalogue_unavailable', 'tax_nexus_required', 'financial_tax_nexus_required', 'tax_classification_unsupported', 'tax_service_confirmation_required']) publicErrors.add(code);
const fail = (code: string, status = 422, outcome: BrowserUsFinancialPilotError['outcome'] = 'rejected'): never => { throw new BrowserUsFinancialPilotError(code, status, outcome); };
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function text(value: unknown, max = 160): value is string { return typeof value === 'string' && !!value && value === value.trim() && value.length <= max && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) < Number.MAX_SAFE_INTEGER; }
function civilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function browserEnvironment(): BrowserUsFinancialPilotEnvironment {
  return {
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    subscribe(listener) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
      window.addEventListener('online', listener); window.addEventListener('offline', listener); document.addEventListener('visibilitychange', listener);
      return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); document.removeEventListener('visibilitychange', listener); };
    },
  };
}
/** Separate cookie-only DTO1 transport. It never accepts or transports a role,
 * grant, policy, book, proof, provider reference or native ERP schema header.
 * Exact ambiguous-write recovery exists only in this instance's RAM. Stopping
 * or losing access clears it; a replacement session must reread the real book.
 * Local form drafts belong to the UI and are never replaced by this transport.
 */
export function createBrowserUsFinancialPilotSession(options: BrowserUsFinancialPilotOptions): BrowserUsFinancialPilotSession {
  const { organizationId, expectedUserId } = options;
  if (typeof organizationId !== 'string' || !uuid.test(organizationId) || !text(expectedUserId, 256)) return fail('invalid_request');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const environment = options.environment ?? browserEnvironment(), base = `/api/international/workspaces/${encodeURIComponent(organizationId)}/financial-pilot`;
  const listeners = new Set<() => void>(), controllers = new Set<AbortController>();
  let state: BrowserUsFinancialPilotState = frozen({ status: 'idle', snapshot: null, refreshing: false, writing: false, pending: false, pendingKind: null, invoiceReview: null, requiresRefresh: false, error: null });
  let disposed = false, running = false, generation = 0, mutation = 0, denied = false;
  let timer: ReturnType<typeof setTimeout> | undefined, unsubscribe: (() => void) | undefined;
  let snapshotFlight: Promise<UsFinancialPilotOverview> | null = null, refreshFlight: Promise<UsFinancialPilotOverview | null> | null = null;
  let pending: Readonly<{ kind: 'payment'; body: string; request: UsFinancialPilotPaymentRequest }> | Readonly<{ kind: 'commercial'; body: string; request: UsFinancialPilotCommercialRequest }> | Readonly<{ kind: 'invoice_prepare' | 'invoice_issue'; body: string; request: UsFinancialPilotInvoiceRequest }> | null = null;
  let prepared: Readonly<{ request: UsFinancialPilotInvoiceRequest; preview: UsFinancialPilotInvoicePreview }> | null = null;
  const publish = (patch: Partial<BrowserUsFinancialPilotState>) => { state = frozen({ ...state, ...patch }); for (const listener of listeners) { try { listener(); } catch { /* A view cannot change admission or transaction outcome. */ } } };
  function alive(epoch = generation): void { if (disposed || state.status === 'stopped' || epoch !== generation) return fail('session_disposed', 0, 'unauthorized'); if (denied) return fail('session_changed', 401, 'unauthorized'); }
  function invalidate(status: number): never {
    denied = true; running = false; generation++; mutation++; pending = null; prepared = null;
    if (timer !== undefined) clearTimeout(timer); timer = undefined; unsubscribe?.(); unsubscribe = undefined;
    for (const controller of controllers) controller.abort();
    const error = new BrowserUsFinancialPilotError(status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : 'forbidden', status, 'unauthorized');
    publish({ status: 'denied', snapshot: null, refreshing: false, writing: false, pending: false, pendingKind: null, invoiceReview: null, requiresRefresh: true, error }); throw error;
  }
  const headers = () => ({ Accept: 'application/json', 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': expectedUserId });
  async function response(path: string, init: RequestInit, write = false): Promise<unknown> {
    alive(); const epoch = generation, controller = new AbortController(); controllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new BrowserUsFinancialPilotError('response_timeout', 0, write ? 'uncertain' : 'rejected')); }, 30000); });
    try {
      const result = await Promise.race([fetcher(base + path, { ...init, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal }), deadline]);
      alive(epoch); if ([401, 402, 403].includes(result.status)) invalidate(result.status);
      let body: unknown;
      try {
        const maximum = result.ok ? 4 * 1024 * 1024 : 4096, length = result.headers.get('Content-Length');
        if (result.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error('Invalid response');
        const reader = result.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
        if (reader) {
          try { for (;;) { const part = await Promise.race([reader.read(), deadline]); alive(epoch); if (part.done) break; size += part.value.byteLength; if (size > maximum) { void reader.cancel(); throw new Error('Oversized response'); } parts.push(part.value); } }
          finally { reader.releaseLock(); }
        } else { const bytes = new Uint8Array(await Promise.race([result.arrayBuffer(), deadline])); size = bytes.byteLength; if (size > maximum) throw new Error('Oversized response'); parts.push(bytes); }
        const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (caught) { alive(epoch); if (caught instanceof BrowserUsFinancialPilotError) throw caught; return fail(timedOut ? 'response_timeout' : 'invalid_response', result.status, write ? 'uncertain' : 'rejected'); }
      alive(epoch);
      if (!result.ok) {
        const code = exact(body, ['error']) && typeof body.error === 'string' && publicErrors.has(body.error) ? body.error : 'service_unavailable';
        const definitive = pending?.kind === 'commercial' ? rejectedCommercial[code]?.includes(result.status) : pending?.kind === 'invoice_prepare' || pending?.kind === 'invoice_issue' ? rejectedInvoice[code]?.includes(result.status) : rejectedPayments[code] === result.status;
        const invoiceWrite = pending?.kind === 'invoice_prepare' || pending?.kind === 'invoice_issue';
        if (write && (!invoiceWrite && result.status === 409 && rejectedConflicts.has(code) || definitive)) { pending = null; publish({ pending: false, pendingKind: null, requiresRefresh: true }); return fail(code, result.status); }
        return fail(code, result.status, write ? 'uncertain' : 'rejected');
      }
      return body;
    } catch (caught) {
      if (caught instanceof BrowserUsFinancialPilotError && caught.outcome === 'unauthorized') throw caught;
      alive(epoch); if (caught instanceof BrowserUsFinancialPilotError) throw caught;
      return fail(timedOut ? 'response_timeout' : 'response_unavailable', 0, write ? 'uncertain' : 'rejected');
    } finally { if (timeout !== undefined) clearTimeout(timeout); controllers.delete(controller); }
  }
  function validate<T>(task: () => T, write = false): T {
    try { return frozen(structuredClone(task())); } catch { return fail('invalid_response', 200, write ? 'uncertain' : 'rejected'); }
  }
  function notifyError(caught: unknown): void {
    if (denied || disposed || state.status === 'stopped' || caught instanceof BrowserUsFinancialPilotError && ['stale_read', 'session_disposed'].includes(caught.code)) return;
    const error = caught instanceof BrowserUsFinancialPilotError ? caught : new BrowserUsFinancialPilotError('service_unavailable', 503, 'rejected');
    publish({ error });
  }
  function currentRevision(input?: number): number {
    const result = input ?? state.snapshot?.revision; if (!revision(result)) return fail('read_required', 409); return result;
  }
  function snapshotLoad(expectedRevision?: number): Promise<UsFinancialPilotOverview> {
    alive(); if (snapshotFlight) return expectedRevision === undefined ? snapshotFlight : snapshotFlight.then(value => { if (value.revision !== expectedRevision) return fail('financial_snapshot_changed', 409); return value; });
    const epoch = generation, changed = mutation;
    publish({ status: state.snapshot ? 'ready' : 'loading', refreshing: !!state.snapshot, error: null });
    const flight = (async () => {
      try {
        const body = await response(`/snapshot${expectedRevision === undefined ? '' : `?revision=${expectedRevision}`}`, { method: 'GET', headers: headers() }); alive(epoch);
        if (mutation !== changed || state.writing || pending) return fail('stale_read', 0);
        const value = validate(() => validateUsFinancialPilotOverview(body, organizationId, expectedRevision));
        if (state.snapshot && value.revision < state.snapshot.revision) return fail('invalid_response', 200);
        publish({ status: 'ready', snapshot: value, requiresRefresh: false, error: null }); return value;
      } catch (caught) { notifyError(caught); throw caught; }
      finally { if (generation === epoch) publish({ refreshing: false, ...(state.status === 'loading' ? { status: 'idle' as const } : {}) }); }
    })();
    snapshotFlight = flight; void flight.finally(() => { if (snapshotFlight === flight) snapshotFlight = null; }).catch(() => {}); return flight;
  }
  async function refresh(): Promise<UsFinancialPilotOverview | null> {
    alive(); if (refreshFlight) return refreshFlight;
    const epoch = generation;
    const flight = (async () => {
      try {
        const body = await response('/head', { method: 'GET', headers: headers() }); alive(epoch);
        const head = validate(() => validateUsFinancialPilotHead(body, organizationId));
        if (state.snapshot && head.revision < state.snapshot.revision) return fail('invalid_response', 200);
        // Admission is still checked while an uncertain write remains pending.
        if (pending || state.writing) return state.snapshot;
        if (state.snapshot && head.revision === state.snapshot.revision && !state.requiresRefresh) return state.snapshot;
        return await snapshotLoad(head.revision);
      } catch (caught) { notifyError(caught); throw caught; }
    })();
    refreshFlight = flight; void flight.finally(() => { if (refreshFlight === flight) refreshFlight = null; }).catch(() => {}); return flight;
  }
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    if (!running || denied || disposed || !environment.isVisible() || !environment.isOnline()) return;
    const epoch = generation;
    timer = setTimeout(() => { timer = undefined; if (!running || generation !== epoch) return; void refresh().catch(() => {}).finally(() => { if (generation === epoch) schedule(); }); }, 3000);
  }
  function wake(): void {
    if (!running) return; if (timer !== undefined) clearTimeout(timer); timer = undefined;
    if (!environment.isVisible() || !environment.isOnline()) return;
    const epoch = generation; void refresh().catch(() => {}).finally(() => { if (generation === epoch) schedule(); });
  }
  async function detail<T>(path: string, expectedRevision: number, parser: (value: unknown) => T): Promise<T> {
    alive(); const epoch = generation, changed = mutation;
    const body = await response(path, { method: 'GET', headers: headers() }); alive(epoch);
    if (changed !== mutation || state.snapshot && state.snapshot.revision !== expectedRevision) return fail('stale_read', 0);
    return validate(() => parser(body));
  }
  function list(kind: UsFinancialPilotListKind, cursor?: string, atRevision?: number): Promise<UsFinancialPilotPage> {
    const at = currentRevision(atRevision), query = new URLSearchParams({ revision: String(at) });
    if (!['invoices', 'customers', 'vendors', 'estimates', 'journals', 'periods'].includes(kind)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected'));
    let offset: number;
    try { offset = financialPilotCursorOffset(cursor, kind, at, null); } catch { return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected')); }
    if (cursor !== undefined) query.set('cursor', cursor);
    return detail(`${kind === 'invoices' ? '/invoices' : `/lists/${kind}`}?${query}`, at, value => {
      const page = validateUsFinancialPilotPage(value, organizationId, at);
      if (page.kind !== kind || page.scope !== null) return fail('invalid_response', 200);
      pageBounds(page, offset);
      return page;
    });
  }
  function pageBounds(page: UsFinancialPilotPage, offset: number): void {
    if (offset > page.total || page.items.length !== Math.min(25, page.total - offset) || (page.nextCursor === null ? offset + page.items.length !== page.total : financialPilotCursorOffset(page.nextCursor, page.kind, page.revision, page.scope) !== offset + 25)) return fail('invalid_response', 200);
  }
  async function send(): Promise<BrowserUsFinancialPilotOperationReceipt | BrowserUsFinancialPilotInvoiceResult> {
    alive(); if (!pending) return fail('no_pending_operation', 409); if (state.writing) return fail('pending_operation', 409);
    const original = pending, epoch = generation; mutation++; publish({ writing: true, pending: true, pendingKind: original.kind, requiresRefresh: true, error: null });
    try {
      const path = original.kind === 'invoice_prepare' ? '/invoices/prepare' : original.kind === 'invoice_issue' ? '/invoices/issue' : original.kind === 'commercial' ? '/commercial/operations' : '/operations';
      const body = await response(path, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: original.body }, true); alive(epoch);
      const receipt = validate(() => {
        if (original.kind === 'invoice_prepare') return validateUsFinancialPilotInvoicePreview(body, organizationId, original.request);
        if (original.kind === 'invoice_issue') return validateUsFinancialPilotInvoiceReceipt(body, organizationId, original.request);
        if (original.kind === 'commercial') return validateUsFinancialPilotCommercialReceipt(body, organizationId, original.request);
        if (original.kind === 'payment') return validateUsFinancialPilotPaymentReceipt(body, organizationId, original.request);
        return fail('invalid_response', 200, 'uncertain');
      }, true);
      if (original.kind === 'invoice_prepare') { prepared = frozen({ request: original.request, preview: receipt as UsFinancialPilotInvoicePreview }); publish({ invoiceReview: prepared.preview, requiresRefresh: false }); }
      if (original.kind === 'invoice_issue') { prepared = null; publish({ invoiceReview: null }); }
      pending = null; publish({ pending: false, pendingKind: null, error: null }); return receipt;
    } catch (caught) { if (!pending && (original.kind === 'invoice_prepare' || original.kind === 'invoice_issue')) { prepared = null; publish({ invoiceReview: null }); } notifyError(caught); throw caught; }
    finally {
      mutation++; if (generation === epoch) {
        publish({ writing: false, pending: pending !== null, pendingKind: pending?.kind ?? null });
        if (!pending && original.kind !== 'invoice_prepare') { const previous = snapshotFlight; void Promise.resolve(previous).catch(() => {}).then(() => { if (generation === epoch) return snapshotLoad(); }).catch(() => {}); }
      }
    }
  }
  function stop(): void {
    running = false; generation++; mutation++; if (timer !== undefined) clearTimeout(timer); timer = undefined;
    unsubscribe?.(); unsubscribe = undefined; for (const controller of controllers) controller.abort();
    snapshotFlight = null; refreshFlight = null; pending = null; prepared = null;
    publish({ status: 'stopped', snapshot: null, refreshing: false, writing: false, pending: false, pendingKind: null, invoiceReview: null, requiresRefresh: true, error: null });
  }
  return Object.freeze({
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (disposed || denied) return fail('session_disposed', 0, 'unauthorized'); if (running) return; running = true; if (state.status === 'stopped') publish({ status: 'idle' }); unsubscribe = environment.subscribe(wake); const epoch = generation; if (environment.isVisible() && environment.isOnline()) void snapshotLoad().catch(() => {}).finally(() => { if (generation === epoch) schedule(); }); },
    stop,
    dispose() { if (disposed) return; stop(); disposed = true; listeners.clear(); },
    load: () => snapshotLoad(), refresh,
    readInvoices: (cursor?: string, atRevision?: number) => list('invoices', cursor, atRevision) as Promise<UsFinancialPilotPage<UsFinancialPilotInvoiceRow>>,
    readList: list,
    readEstimate(estimateId: string, atRevision?: number) {
      if (!text(estimateId)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected'));
      const at = currentRevision(atRevision);
      return detail(`/estimates/${encodeURIComponent(estimateId)}?revision=${at}`, at, value => validateUsFinancialPilotEstimateDetail(value, organizationId, at, estimateId));
    },
    readInvoice(invoiceId: string, atRevision?: number, cursors?: Readonly<{ paymentCursor?: string; creditCursor?: string }>) {
      if (!text(invoiceId)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected'));
      const at = currentRevision(atRevision), query = new URLSearchParams({ revision: String(at) }); let paymentOffset = 0, creditOffset = 0;
      try { const captured = snapshotPrivateJson(cursors ?? {}) as Record<string, unknown>; if (!captured || Array.isArray(captured) || Object.keys(captured).some(key => !['paymentCursor', 'creditCursor'].includes(key))) return fail('invalid_request'); for (const [key, kind] of [['paymentCursor', 'invoice_payments'], ['creditCursor', 'invoice_credits']] as const) { if (captured[key] !== undefined) { const offset = financialPilotCursorOffset(captured[key], kind, at, invoiceId); if (key === 'paymentCursor') paymentOffset = offset; else creditOffset = offset; query.set(key, captured[key] as string); } } } catch { return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected')); }
      return detail(`/invoices/${encodeURIComponent(invoiceId)}?${query}`, at, value => { const result = validateUsFinancialPilotInvoiceDetail(value, organizationId, at); if (result.invoice.id !== invoiceId) return fail('invalid_response', 200); pageBounds(result.payments, paymentOffset); pageBounds(result.credits, creditOffset); return result; });
    },
    readReports(query: UsFinancialPilotReportQuery) {
      let saved: UsFinancialPilotReportQuery;
      try { const captured = snapshotPrivateJson(query) as Record<string, unknown>; if (!captured || Array.isArray(captured) || ['revision', 'from', 'to', 'asOf'].some(key => !Object.hasOwn(captured, key)) || Object.keys(captured).some(key => !['revision', 'from', 'to', 'asOf', 'accountId', 'cursor'].includes(key))) return fail('invalid_request'); saved = frozen(captured) as unknown as UsFinancialPilotReportQuery; } catch { return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected')); }
      const at = currentRevision(saved.revision);
      if (!civilDate(saved.from) || !civilDate(saved.to) || !civilDate(saved.asOf) || saved.from > saved.to || saved.accountId != null && !text(saved.accountId)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected'));
      try { if (saved.cursor != null) { if (!saved.accountId) return fail('invalid_request'); financialPilotCursorOffset(saved.cursor, 'general_ledger', at, `${saved.accountId}|${saved.from}|${saved.to}`); } } catch { return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected')); }
      const params = new URLSearchParams({ revision: String(at), from: saved.from, to: saved.to, asOf: saved.asOf }); if (saved.accountId != null) params.set('accountId', saved.accountId); if (saved.cursor != null) params.set('cursor', saved.cursor);
      return detail(`/reports?${params}`, at, value => { const result = validateUsFinancialPilotReports(value, organizationId, at); if (result.from !== saved.from || result.to !== saved.to || result.asOf !== saved.asOf || (result.generalLedger?.account.accountId ?? null) !== (saved.accountId ?? null)) return fail('invalid_response', 200); pageBounds(result.currentReceivables.invoices, 0); if (result.generalLedger) pageBounds(result.generalLedger.movements, financialPilotCursorOffset(saved.cursor, 'general_ledger', at, `${saved.accountId}|${saved.from}|${saved.to}`)); return result; });
    },
    recordPayment(command: BrowserUsFinancialPilotPayment, expectedRevision?: number) {
      alive(); if (pending || state.writing) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected')); if (state.requiresRefresh || !state.snapshot) return Promise.reject(new BrowserUsFinancialPilotError('read_required', 409, 'rejected'));
      const at = currentRevision(expectedRevision); if (at !== state.snapshot.revision) return Promise.reject(new BrowserUsFinancialPilotError('financial_snapshot_changed', 409, 'rejected'));
      let request: UsFinancialPilotPaymentRequest;
      try { request = frozen(validateUsFinancialPilotPaymentRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: newId(), expectedRevision: at, command })); } catch { return fail('invalid_financial_pilot_request'); }
      pending = frozen({ kind: 'payment', body: JSON.stringify(request), request }); return send() as Promise<BrowserUsFinancialPilotReceipt>;
    },
    commercial(command: UsFinancialPilotCommercialCommand, expectedRevision?: number) {
      alive(); if (pending || state.writing) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected')); if (state.requiresRefresh || !state.snapshot) return Promise.reject(new BrowserUsFinancialPilotError('read_required', 409, 'rejected'));
      const at = currentRevision(expectedRevision); if (at !== state.snapshot.revision) return Promise.reject(new BrowserUsFinancialPilotError('financial_snapshot_changed', 409, 'rejected'));
      let request: UsFinancialPilotCommercialRequest;
      try { request = frozen(validateUsFinancialPilotCommercialRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: newId(), expectedRevision: at, command })); } catch { return fail('invalid_financial_pilot_request'); }
      pending = frozen({ kind: 'commercial', body: JSON.stringify(request), request }); return send() as Promise<UsFinancialPilotCommercialReceipt>;
    },
    async readTaxCodes(query: Readonly<{ code?: string; cursor?: string }> = {}) {
      alive(); const epoch = generation;
      let saved: Record<string, unknown>;
      try { saved = snapshotPrivateJson(query) as Record<string, unknown>; if (!saved || Array.isArray(saved) || Object.keys(saved).some(key => !['code', 'cursor'].includes(key)) || Object.keys(saved).length > 1 || Object.values(saved).some(value => typeof value !== 'string' || !/^txcd_[0-9]{8}$/.test(value))) return fail('invalid_request'); } catch { return fail('invalid_request'); }
      const params = new URLSearchParams(); if (saved.code !== undefined) params.set('code', saved.code as string); if (saved.cursor !== undefined) params.set('cursor', saved.cursor as string);
      const body = await response(`/tax-codes${params.size ? `?${params}` : ''}`, { method: 'GET', headers: headers() }); alive(epoch);
      return validate(() => { const value = validateUsFinancialPilotTaxCatalogue(body, organizationId); if (saved.code !== undefined && (value.taxCodes.length !== 1 || value.taxCodes[0].id !== saved.code || value.hasMore || value.nextCursor !== null)) return fail('invalid_response', 200); return value; });
    },
    prepareInvoice(command: UsFinancialPilotInvoiceRequest['command'], choices: UsFinancialPilotInvoiceChoices, expectedRevision?: number) {
      alive(); if (pending || state.writing) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected')); if (state.requiresRefresh || !state.snapshot) return Promise.reject(new BrowserUsFinancialPilotError('read_required', 409, 'rejected'));
      const at = currentRevision(expectedRevision); if (at !== state.snapshot.revision) return Promise.reject(new BrowserUsFinancialPilotError('financial_snapshot_changed', 409, 'rejected'));
      let request: UsFinancialPilotInvoiceRequest;
      try { request = frozen(validateUsFinancialPilotInvoiceRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: newId(), expectedRevision: at, command, choices })); } catch { return fail('invalid_financial_pilot_request'); }
      prepared = null; publish({ invoiceReview: null }); pending = frozen({ kind: 'invoice_prepare', body: JSON.stringify(request), request }); return send() as Promise<UsFinancialPilotInvoicePreview>;
    },
    issueInvoice() {
      alive(); if (pending || state.writing) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected')); if (!prepared) return Promise.reject(new BrowserUsFinancialPilotError('tax_review_required', 409, 'rejected'));
      if (prepared.preview.financialStatus === 'issued') return Promise.reject(new BrowserUsFinancialPilotError('issued_estimate_locked', 409, 'rejected'));
      if (state.requiresRefresh || !state.snapshot || state.snapshot.revision !== prepared.request.expectedRevision) return Promise.reject(new BrowserUsFinancialPilotError('financial_snapshot_changed', 409, 'rejected'));
      if (Date.parse(prepared.preview.expiresAt) <= Date.now()) return Promise.reject(new BrowserUsFinancialPilotError('tax_review_expired', 409, 'rejected'));
      pending = frozen({ kind: 'invoice_issue', request: prepared.request, body: JSON.stringify({ request: prepared.request, reviewId: prepared.preview.reviewId }) }); return send() as Promise<UsFinancialPilotInvoiceReceipt>;
    },
    retryInvoice() { if (!pending || !['invoice_prepare', 'invoice_issue'].includes(pending.kind)) return Promise.reject(new BrowserUsFinancialPilotError('no_pending_operation', 409, 'rejected')); return send() as Promise<BrowserUsFinancialPilotInvoiceResult>; },
    clearInvoiceReview() { alive(); if (pending || state.writing) return fail('pending_operation', 409); prepared = null; publish({ invoiceReview: null }); },
    retry() { if (pending && ['invoice_prepare', 'invoice_issue'].includes(pending.kind)) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected')); return send() as Promise<BrowserUsFinancialPilotOperationReceipt>; }, hasPending: () => pending !== null,
  });
}
