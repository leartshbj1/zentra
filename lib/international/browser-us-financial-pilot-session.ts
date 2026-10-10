import {
  validateUsFinancialPilotHead, validateUsFinancialPilotOverview, validateUsFinancialPilotPage,
  validateUsFinancialPilotInvoiceDetail, validateUsFinancialPilotReports,
  type UsFinancialPilotOverview, type UsFinancialPilotPage, type UsFinancialPilotInvoiceRow,
  type UsFinancialPilotInvoiceDetail, type UsFinancialPilotReports, type UsFinancialPilotReportQuery,
  financialPilotCursorOffset, type UsFinancialPilotListKind,
} from './us-financial-pilot-contract';
import { validateUsFinancialPilotPaymentRequest, validateUsFinancialPilotPaymentReceipt, type UsFinancialPilotPaymentRequest, type UsFinancialPilotPaymentReceipt } from './us-financial-pilot-payment';
import { validateUsFinancialPilotCommercialRequest, validateUsFinancialPilotCommercialReceipt, type UsFinancialPilotCommercialRequest, type UsFinancialPilotCommercialCommand, type UsFinancialPilotCommercialReceipt, type UsFinancialPilotCommercialCustomer } from './us-financial-pilot-commercial';
import { validateUsFinancialPilotEstimateDetail, validateUsFinancialPilotCustomerDetail, type UsFinancialPilotEstimateDetail, type UsFinancialPilotCustomerDetail } from './us-financial-pilot-commercial-projection';
import { buildCustomerEditReview, type CustomerEditReview } from './browser-us-financial-pilot-commercial-input';
import { snapshotPrivateJson } from './private-json';
import { validateUsFinancialPilotInvoiceRequest, validateUsFinancialPilotInvoicePreview, validateUsFinancialPilotInvoiceReceipt, validateUsFinancialPilotTaxCatalogue, type UsFinancialPilotInvoiceRequest, type UsFinancialPilotInvoiceChoices, type UsFinancialPilotInvoicePreview, type UsFinancialPilotInvoiceReceipt, type UsFinancialPilotTaxCatalogue } from './us-financial-pilot-invoice';
import { validateUsFinancialPilotPurchasingRequest, validateUsFinancialPilotPurchasingReceipt, type UsFinancialPilotPurchasingRequest, type UsFinancialPilotPurchasingCommand, type UsFinancialPilotPurchasingReceipt } from './us-financial-pilot-purchasing';
import { validateUsFinancialPilotVendorDetail, validateUsFinancialPilotVendorBillDetail, validateUsFinancialPilotPurchasingPage, financialPilotPurchasingCursorOffset, type UsFinancialPilotVendorDetail, type UsFinancialPilotVendorBillDetail, type UsFinancialPilotPurchasingPage, type UsFinancialPilotVendorBillRow } from './us-financial-pilot-purchasing-projection';
import { validateUsFinancialPilotAccountingRequest, validateUsFinancialPilotAccountingReceipt, type UsFinancialPilotAccountingCommand, type UsFinancialPilotAccountingRequest, type UsFinancialPilotAccountingReceipt } from './us-financial-pilot-accounting';
import { validateUsFinancialPilotAccountingContext, validateUsFinancialPilotJournalDetail, validateUsFinancialPilotPeriodDetail, financialPilotJournalLinesCursorOffset, type UsFinancialPilotAccountingContext, type UsFinancialPilotJournalDetail, type UsFinancialPilotPeriodDetail } from './us-financial-pilot-accounting-projection';
import { canonicalErpJson } from './erp-contract';
import type { CompanyLanguage } from './types';
import { validateUsFinancialPilotBankHead, validateUsFinancialPilotBankReceipt, type UsFinancialPilotBankHead, type UsFinancialPilotBankRequest, type UsFinancialPilotBankCommand, type UsFinancialPilotBankReceipt } from './us-financial-pilot-bank';
import { validateUsFinancialPilotBankQuery, validateUsFinancialPilotBankListQuery, validateUsFinancialPilotBankDetailQuery, validateUsFinancialPilotBankMovementQuery, validateUsFinancialPilotBankContext, validateUsFinancialPilotBankStatementsPage, validateUsFinancialPilotBankStatementDetail, validateUsFinancialPilotBankMovementsPage, type UsFinancialPilotBankQuery, type UsFinancialPilotBankListQuery, type UsFinancialPilotBankDetailQuery, type UsFinancialPilotBankMovementQuery, type UsFinancialPilotBankContext, type UsFinancialPilotBankStatementsPage, type UsFinancialPilotBankStatementDetail, type UsFinancialPilotBankMovementsPage } from './us-financial-pilot-bank-projection';
import { BankInputError, buildBankImportReview, buildBankCommandReview, validateUsFinancialPilotBankExportSelector, browserUsFinancialPilotBankExportUrl, US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS as bankExportHeaders, US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES, US_FINANCIAL_PILOT_BANK_EXPORT_TIMEOUT_MS, type BankImportDraft, type BankReview, type BankDetailEvidence, type BankMovementEvidence } from './browser-us-financial-pilot-bank-input';

export interface BrowserUsFinancialPilotBankState {
  readonly active: boolean; readonly head: UsFinancialPilotBankHead | null;
  readonly refreshing: boolean; readonly requiresRefresh: boolean;
  readonly pendingReview: BankReview | null; readonly lastReceipt: UsFinancialPilotBankReceipt | null;
  readonly error: BrowserUsFinancialPilotError | null;
}
export interface BrowserUsFinancialPilotBankEvidence {
  readonly statement: UsFinancialPilotBankStatementDetail;
  readonly linePages: readonly UsFinancialPilotBankStatementDetail[];
  readonly movementPages: readonly UsFinancialPilotBankMovementsPage[];
}
export interface BrowserUsFinancialPilotBankExportResult {
  readonly blob: Blob; readonly filename: string; readonly revision: number; readonly bankRevision: number;
  readonly statementRevision: number; readonly statementId: string; readonly ledgerRevision: number;
}

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
  readonly pendingKind: 'payment' | 'commercial' | 'invoice_prepare' | 'invoice_issue' | 'purchasing' | 'accounting' | 'bank' | null;
  readonly bank: BrowserUsFinancialPilotBankState;
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
  readCustomer(this: void, customerId: string, revision?: number): Promise<UsFinancialPilotCustomerDetail>;
  reviewCustomerEdit(this: void, source: UsFinancialPilotCustomerDetail, customer: UsFinancialPilotCommercialCustomer): CustomerEditReview;
  submitCustomerEdit(this: void, review: CustomerEditReview, approved: boolean): Promise<UsFinancialPilotCommercialReceipt>;
  recordPayment(this: void, command: BrowserUsFinancialPilotPayment, expectedRevision?: number): Promise<BrowserUsFinancialPilotReceipt>;
  commercial(this: void, command: UsFinancialPilotCommercialCommand, expectedRevision?: number): Promise<UsFinancialPilotCommercialReceipt>;
  purchasing(this: void, command: UsFinancialPilotPurchasingCommand, expectedRevision?: number): Promise<UsFinancialPilotPurchasingReceipt>;
  retryPurchasing(this: void): Promise<UsFinancialPilotPurchasingReceipt>;
  accounting(this: void, command: UsFinancialPilotAccountingCommand, expectedRevision?: number): Promise<UsFinancialPilotAccountingReceipt>;
  retryAccounting(this: void): Promise<UsFinancialPilotAccountingReceipt>;
  readAccountingContext(this: void, revision?: number): Promise<UsFinancialPilotAccountingContext>;
  readJournal(this: void, journalRevision: number, revision?: number, lineCursor?: string): Promise<UsFinancialPilotJournalDetail>;
  readPeriod(this: void, periodId: string, revision?: number): Promise<UsFinancialPilotPeriodDetail>;
  readVendor(this: void, vendorId: string, revision?: number): Promise<UsFinancialPilotVendorDetail>;
  readVendorBills(this: void, cursor?: string, revision?: number): Promise<UsFinancialPilotPurchasingPage<UsFinancialPilotVendorBillRow>>;
  readVendorBill(this: void, billId: string, revision?: number, paymentCursor?: string): Promise<UsFinancialPilotVendorBillDetail>;
  readTaxCodes(this: void, query?: Readonly<{ code?: string; cursor?: string }>): Promise<UsFinancialPilotTaxCatalogue>;
  prepareInvoice(this: void, command: UsFinancialPilotInvoiceRequest['command'], choices: UsFinancialPilotInvoiceChoices, expectedRevision?: number): Promise<UsFinancialPilotInvoicePreview>;
  issueInvoice(this: void): Promise<UsFinancialPilotInvoiceReceipt>;
  retryInvoice(this: void): Promise<BrowserUsFinancialPilotInvoiceResult>;
  clearInvoiceReview(this: void): void;
  retry(this: void): Promise<BrowserUsFinancialPilotOperationReceipt>;
  hasPending(this: void): boolean;
  setBankActive(this: void, active: boolean): void;
  refreshBank(this: void): Promise<UsFinancialPilotBankHead | null>;
  readBankContext(this: void, query?: UsFinancialPilotBankQuery): Promise<UsFinancialPilotBankContext>;
  readBankStatements(this: void, query?: UsFinancialPilotBankListQuery): Promise<UsFinancialPilotBankStatementsPage>;
  readBankStatement(this: void, query: UsFinancialPilotBankDetailQuery): Promise<UsFinancialPilotBankStatementDetail>;
  readBankMovements(this: void, query: UsFinancialPilotBankMovementQuery): Promise<UsFinancialPilotBankMovementsPage>;
  reviewBankImport(this: void, draft: BankImportDraft): BankReview;
  reviewBank(this: void, command: Exclude<UsFinancialPilotBankCommand, { type: 'create_statement' }>, evidence: BrowserUsFinancialPilotBankEvidence): BankReview;
  submitBank(this: void, review: BankReview, approved: boolean): Promise<UsFinancialPilotBankReceipt>;
  retryBank(this: void): Promise<UsFinancialPilotBankReceipt>;
  exportBank(this: void, statement: UsFinancialPilotBankStatementDetail, language: CompanyLanguage): Promise<BrowserUsFinancialPilotBankExportResult>;
  downloadBank(this: void, result: BrowserUsFinancialPilotBankExportResult): void;
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
publicErrors.add('customer_not_found');
const rejectedInvoice: Readonly<Record<string, readonly number[]>> = {
  // These codes are structurally before the issue executor. Context, source,
  // period and provider errors can also arise after append during postflight.
  tax_review_changed: [409], tax_preparation_required: [409],
  invalid_financial_pilot_request: [422], invalid_request: [400, 413, 415, 422],
};
for (const code of Object.keys(rejectedInvoice)) publicErrors.add(code);
for (const code of ['unknown_account','entry_id_conflict','entry_not_found','invalid_reversal','accounting_period_required','accounting_period_order_conflict','period_already_exists','period_limit_reached','invalid_period','manual_account_forbidden','invalid_financial_pilot_query','invalid_journal','invalid_journal_line','invalid_amount','invalid_date','invalid_account','unbalanced_journal','journal_not_found','journal_already_reversed','manual_journal_required','accounting_period_not_found','accounting_period_already_exists','accounting_period_limit','accounting_period_order','accounting_period_overlap','accounting_period_closed','accounting_period_not_open','cash_flow_classification_required']) publicErrors.add(code);
for (const code of ['vendor_required','vendor_already_exists','vendor_bill_already_recorded','vendor_bill_not_found','vendor_payment_already_recorded','invalid_amount','invalid_date','purchase_account_required']) publicErrors.add(code);
for (const code of ['tax_preparation_conflict','unsupported_tax_request','binding_unavailable','tax_binding_changed','tax_configuration_changed','tax_calculation_expired','invoice_already_issued','sales_order_confirmation_required','invalid_tax_date','financial_invoice_fixture_disabled']) publicErrors.add(code);
for (const code of ['tax_provider_unavailable', 'tax_catalogue_unavailable', 'tax_context_unavailable', 'tax_provider_rejected', 'financial_tax_provider_unavailable', 'financial_tax_catalogue_unavailable', 'tax_nexus_required', 'financial_tax_nexus_required', 'tax_classification_unsupported', 'tax_service_confirmation_required']) publicErrors.add(code);
for (const code of ['invalid_financial_pilot_bank_request', 'invalid_financial_pilot_bank_query', 'invalid_financial_pilot_bank_cursor', 'bank_snapshot_changed', 'bank_record_not_found', 'bank_legacy_frozen', 'bank_legacy_pending', 'bank_capacity_exceeded', 'bank_duplicate_statement', 'bank_overlap', 'bank_entry_claimed', 'bank_statement_closed', 'bank_revision_conflict', 'bank_idempotency_conflict', 'bank_statement_overlap', 'bank_entry_already_matched', 'invalid_bank_request', 'bank_limit_reached', 'bank_statement_duplicate', 'bank_operation_limit_reached', 'bank_legacy_immutable', 'bank_clock_reversed', 'bank_statement_limit_reached', 'reconciliation_not_found', 'reconciliation_voided', 'reconciliation_closed', 'statement_not_voidable', 'cash_account_required', 'reconciliation_ledger_changed', 'reconciliation_incomplete', 'reconciliation_already_matched', 'reconciliation_amount_mismatch', 'statement_line_required', 'ledger_entry_required', 'cash_movement_required', 'invalid_bank_statement', 'invalid_amount', 'invalid_date', 'invalid_bank_reference', 'invalid_statement_amount', 'invalid_statement_period', 'invalid_statement_date', 'duplicate_statement_line', 'statement_balance_mismatch', 'currency_mismatch', 'invalid_reconciliation_match', 'invalid_financial_pilot_bank_export_selector', 'invalid_financial_pilot_bank_export_snapshot', 'financial_pilot_bank_export_too_large', 'financial_pilot_bank_export_unavailable', 'financial_pilot_bank_export_timeout']) publicErrors.add(code);
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
  const emptyBank = (): BrowserUsFinancialPilotBankState => ({ active: false, head: null, refreshing: false, requiresRefresh: true, pendingReview: null, lastReceipt: null, error: null });
  let state: BrowserUsFinancialPilotState = frozen({ status: 'idle', snapshot: null, refreshing: false, writing: false, pending: false, pendingKind: null, invoiceReview: null, requiresRefresh: false, error: null, bank: emptyBank() });
  let disposed = false, running = false, generation = 0, mutation = 0, denied = false, stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined, unsubscribe: (() => void) | undefined;
  let snapshotFlight: Promise<UsFinancialPilotOverview> | null = null, refreshFlight: Promise<UsFinancialPilotOverview | null> | null = null;
  let pending: Readonly<{ kind: 'payment'; body: string; request: UsFinancialPilotPaymentRequest }> | Readonly<{ kind: 'commercial'; body: string; request: UsFinancialPilotCommercialRequest }> | Readonly<{ kind: 'invoice_prepare' | 'invoice_issue'; body: string; request: UsFinancialPilotInvoiceRequest }> | Readonly<{ kind: 'purchasing'; body: string; request: UsFinancialPilotPurchasingRequest }> | Readonly<{ kind: 'accounting'; body: string; request: UsFinancialPilotAccountingRequest }> | Readonly<{ kind: 'bank'; body: string; request: UsFinancialPilotBankRequest; review: BankReview }> | null = null;
  let prepared: Readonly<{ request: UsFinancialPilotInvoiceRequest; preview: UsFinancialPilotInvoicePreview }> | null = null;
  let bankEpoch = 0, floorF = 0, floorB = 0;
  let bankRefreshFlight: Promise<UsFinancialPilotBankHead | null> | null = null;
  let bankContext: UsFinancialPilotBankContext | null = null;
  type BankPageStamp = Readonly<{ epoch: number; generation: number; mutation: number; kind: 'detail'; query: UsFinancialPilotBankDetailQuery } | { epoch: number; generation: number; mutation: number; kind: 'movements'; query: UsFinancialPilotBankMovementQuery }>;
  let bankPages = new WeakMap<object, BankPageStamp>(), bankReviews = new WeakMap<BankReview, Readonly<{ epoch: number; generation: number; mutation: number }>>();
  type CustomerStamp = Readonly<{ epoch: number; generation: number; mutation: number; revision: number }>;
  let customerEpoch = 0, customerPages = new WeakMap<UsFinancialPilotCustomerDetail, CustomerStamp>();
  let customerReviews = new WeakMap<CustomerEditReview, CustomerStamp>(), activeCustomerReview: CustomerEditReview | null = null;
  let bankExportFlight = false, bankExportResult: BrowserUsFinancialPilotBankExportResult | null = null;
  const bankUrls = new Set<string>(), bankUrlTimers = new Set<ReturnType<typeof setTimeout>>(), bankExportCancels = new Set<() => void>();
  const publish = (patch: Partial<BrowserUsFinancialPilotState>) => { state = frozen({ ...state, ...patch }); for (const listener of listeners) { try { listener(); } catch { /* A view cannot change admission or transaction outcome. */ } } };
  const publishBank = (patch: Partial<BrowserUsFinancialPilotBankState>) => publish({ bank: { ...state.bank, ...patch } });
  function invalidateCustomerEdits(): void {
    customerEpoch++; customerPages = new WeakMap(); customerReviews = new WeakMap(); activeCustomerReview = null;
  }
  function customerReady(at?: number): CustomerStamp {
    alive();
    if (pending || state.writing) return fail('pending_operation', 409);
    if (state.requiresRefresh || !state.snapshot) return fail('read_required', 409);
    const revision = currentRevision(at);
    if (revision !== state.snapshot.revision || revision < floorF) return fail('financial_snapshot_changed', 409);
    return { epoch: customerEpoch, generation, mutation, revision };
  }
  function customerFresh(stamp: CustomerStamp): void {
    alive(stamp.generation);
    if (stamp.epoch !== customerEpoch || stamp.mutation !== mutation || stamp.revision !== state.snapshot?.revision || state.requiresRefresh || pending || state.writing) return fail('customer_edit_review_changed', 409);
  }
  function clearBankExport(): void {
    bankExportResult = null;
    for (const cancel of bankExportCancels) cancel(); bankExportCancels.clear();
    for (const timer of bankUrlTimers) clearTimeout(timer); bankUrlTimers.clear();
    for (const url of bankUrls) URL.revokeObjectURL(url); bankUrls.clear();
  }
  function invalidateBank(emit = true): void {
    bankEpoch++; bankContext = null; bankPages = new WeakMap(); bankReviews = new WeakMap(); clearBankExport();
    if (emit) publishBank({ head: null, requiresRefresh: true, pendingReview: pending?.kind === 'bank' ? pending.review : null });
  }
  function observeFinancial(at: number): void {
    const epoch = generation, changed = mutation;
    if (at < floorF) return fail('stale_read', 0);
    if (at > floorF) invalidateCustomerEdits();
    if (!state.snapshot || state.snapshot.revision !== at) publish({ requiresRefresh: true });
    alive(epoch); if (changed !== mutation) return fail('stale_read', 0);
    if (at > floorF) { floorF = at; invalidateBank(); }
    alive(epoch); if (changed !== mutation) return fail('stale_read', 0);
  }
  function alive(epoch = generation): void { if (disposed || stopping || state.status === 'stopped' || epoch !== generation) return fail('session_disposed', 0, 'unauthorized'); if (denied) return fail('session_changed', 401, 'unauthorized'); }
  function invalidate(status: number): never {
    denied = true; running = false; generation++; mutation++; pending = null; prepared = null;
    invalidateCustomerEdits();
    invalidateBank(false); floorF = 0; floorB = 0; bankRefreshFlight = null;
    if (timer !== undefined) clearTimeout(timer); timer = undefined; unsubscribe?.(); unsubscribe = undefined;
    for (const controller of controllers) controller.abort();
    const error = new BrowserUsFinancialPilotError(status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : 'forbidden', status, 'unauthorized');
    publish({ status: 'denied', snapshot: null, refreshing: false, writing: false, pending: false, pendingKind: null, invoiceReview: null, requiresRefresh: true, error, bank: { ...emptyBank(), error } }); throw error;
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
        const maximum = result.ok ? path.startsWith('/bank/') ? 2_621_440 : 4 * 1024 * 1024 : 4096, length = result.headers.get('Content-Length');
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
        // Purchasing public errors carry no execution-phase proof, including
        // mapped ledger validation errors. Preserve its exact envelope.
        const customerEditWrite = pending?.kind === 'commercial' && pending.request.command.type === 'update_customer';
        const definitive = customerEditWrite || pending?.kind === 'purchasing' || pending?.kind === 'accounting' || pending?.kind === 'bank' ? false : pending?.kind === 'commercial' ? rejectedCommercial[code]?.includes(result.status) : pending?.kind === 'invoice_prepare' || pending?.kind === 'invoice_issue' ? rejectedInvoice[code]?.includes(result.status) : rejectedPayments[code] === result.status;
        const invoiceWrite = customerEditWrite || pending?.kind === 'invoice_prepare' || pending?.kind === 'invoice_issue' || pending?.kind === 'purchasing' || pending?.kind === 'accounting' || pending?.kind === 'bank';
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
        observeFinancial(value.revision);
        alive(epoch); if (changed !== mutation) return fail('stale_read', 0);
        publish({ status: 'ready', snapshot: value, requiresRefresh: false, error: null }); return value;
      } catch (caught) { notifyError(caught); throw caught; }
      finally { if (generation === epoch) publish({ refreshing: false, ...(state.status === 'loading' ? { status: 'idle' as const } : {}) }); }
    })();
    snapshotFlight = flight; void flight.finally(() => { if (snapshotFlight === flight) snapshotFlight = null; }).catch(() => {}); return flight;
  }
  async function refresh(preserveBankSnapshot = false): Promise<UsFinancialPilotOverview | null> {
    alive(); if (refreshFlight) return refreshFlight;
    const epoch = generation, changed = mutation;
    const flight = (async () => {
      try {
        const body = await response('/head', { method: 'GET', headers: headers() }); alive(epoch);
        const head = validate(() => validateUsFinancialPilotHead(body, organizationId));
        if (mutation !== changed) return fail('stale_read', 0);
        if (state.snapshot && head.revision < state.snapshot.revision) return fail('invalid_response', 200);
        observeFinancial(head.revision);
        alive(epoch); if (changed !== mutation) return fail('stale_read', 0);
        // Admission is still checked while an uncertain write remains pending.
        if (pending || state.writing) return state.snapshot;
        if (state.snapshot && head.revision === state.snapshot.revision && (!state.requiresRefresh || preserveBankSnapshot)) { if (preserveBankSnapshot) publish({ requiresRefresh: false }); return state.snapshot; }
        return await snapshotLoad(head.revision);
      } catch (caught) { notifyError(caught); throw caught; }
    })();
    refreshFlight = flight; void flight.finally(() => { if (refreshFlight === flight) refreshFlight = null; }).catch(() => {}); return flight;
  }
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    if (!running || denied || disposed || !environment.isVisible() || !environment.isOnline()) return;
    const epoch = generation;
    timer = setTimeout(() => { timer = undefined; if (!running || generation !== epoch) return; void poll().catch(() => {}).finally(() => { if (generation === epoch) schedule(); }); }, 3000);
  }
  function wake(): void {
    if (!running) return; if (timer !== undefined) clearTimeout(timer); timer = undefined;
    if (!environment.isVisible() || !environment.isOnline()) return;
    const epoch = generation; void poll().catch(() => {}).finally(() => { if (generation === epoch) schedule(); });
  }
  async function poll(): Promise<unknown> {
    if (!state.bank.active && pending?.kind !== 'bank') return refresh();
    try { return await refreshBank(); }
    catch (error) {
      if (denied || disposed || state.status === 'stopped' || error instanceof BrowserUsFinancialPilotError && error.outcome === 'unauthorized') throw error;
      // One financial fallback preserves the other modules. It cannot clear
      // the bank error, uncertainty or debt, nor fabricate a composite head.
      return refresh(true);
    }
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
  /** F and B are observed together. Floors reject stale reads; they are never
   * combined to invent a head that the server did not return. */
  function refreshBank(): Promise<UsFinancialPilotBankHead | null> {
    alive(); if (bankRefreshFlight) return bankRefreshFlight;
    const epoch = generation, changed = mutation, initialBankEpoch = bankEpoch;
    publishBank({ refreshing: true });
    const flight = (async () => {
      try {
        const body = await response('/bank/head', { method: 'GET', headers: headers() }); alive(epoch);
        if (changed !== mutation || initialBankEpoch !== bankEpoch) return fail('stale_read', 0);
        const head = validate(() => validateUsFinancialPilotBankHead(body, organizationId));
        if (head.revision < floorF || head.bankRevision < floorB) return fail('stale_read', 0);
        if (head.revision > floorF) invalidateCustomerEdits();
        if (!state.snapshot || state.snapshot.revision !== head.revision) publish({ requiresRefresh: true });
        alive(epoch); if (changed !== mutation || initialBankEpoch !== bankEpoch) return fail('stale_read', 0);
        if (!state.bank.head || head.revision !== state.bank.head.revision || head.bankRevision !== state.bank.head.bankRevision) invalidateBank();
        alive(epoch); if (changed !== mutation) return fail('stale_read', 0);
        floorF = head.revision; floorB = head.bankRevision;
        publishBank({ head, requiresRefresh: false, error: null });
        alive(epoch); if (changed !== mutation) return fail('stale_read', 0);
        const adoptedEpoch = bankEpoch;
        if (!pending && !state.writing) {
          if (state.snapshot?.revision === head.revision) publish({ requiresRefresh: false });
          else await snapshotLoad(head.revision);
        }
        alive(epoch); if (changed !== mutation || bankEpoch !== adoptedEpoch || state.bank.head !== head) return fail('stale_read', 0); return head;
      } catch (caught) {
        if (!denied && !disposed && generation === epoch && state.status !== 'stopped' && !(caught instanceof BrowserUsFinancialPilotError && caught.code === 'stale_read')) {
          const error = caught instanceof BrowserUsFinancialPilotError ? caught : new BrowserUsFinancialPilotError('service_unavailable', 503, 'rejected');
          publishBank({ requiresRefresh: true, error });
        }
        throw caught;
      } finally { if (generation === epoch) publishBank({ refreshing: false }); }
    })();
    bankRefreshFlight = flight;
    void flight.finally(() => { if (bankRefreshFlight === flight) bankRefreshFlight = null; }).catch(() => {});
    return flight;
  }
  function bankPair(query?: UsFinancialPilotBankQuery): UsFinancialPilotBankQuery {
    alive(); const head = state.bank.head;
    if (!head || state.bank.requiresRefresh || !state.snapshot || state.snapshot.revision !== head.revision || state.writing) return fail('bank_read_required', 409);
    const owned = query === undefined ? { revision: head.revision, bankRevision: head.bankRevision } : query;
    if (owned.revision !== head.revision || owned.bankRevision !== head.bankRevision) return fail('bank_review_changed', 409);
    return { revision: head.revision, bankRevision: head.bankRevision };
  }
  function bankInput<T>(task: () => T): T {
    try { return task(); }
    catch (caught) { if (caught instanceof BankInputError) return fail(caught.code, caught.status); if (caught instanceof BrowserUsFinancialPilotError) throw caught; return fail('bank_input_invalid', 422); }
  }
  async function bankRead<T>(path: string, query: UsFinancialPilotBankQuery, parser: (value: unknown) => T): Promise<T> {
    bankPair(query); const epoch = generation, changed = mutation, at = bankEpoch;
    const body = await response(path, { method: 'GET', headers: headers() }); alive(epoch);
    if (changed !== mutation || at !== bankEpoch || state.writing) return fail('stale_read', 0);
    bankPair(query); return validate(() => parser(body));
  }
  function bankReadStamp(): Readonly<{ epoch: number; generation: number; mutation: number }> { return { epoch: bankEpoch, generation, mutation }; }
  function confirmBankRead(stamp: ReturnType<typeof bankReadStamp>): void {
    alive(stamp.generation); if (stamp.epoch !== bankEpoch || stamp.mutation !== mutation) return fail('stale_read', 0);
  }
  function bankParams(query: UsFinancialPilotBankQuery): URLSearchParams { return new URLSearchParams({ revision: String(query.revision), bankRevision: String(query.bankRevision) }); }
  function readyBank(): UsFinancialPilotBankHead {
    bankPair();
    if (pending || state.writing) return fail('pending_operation', 409);
    if (state.requiresRefresh || !bankContext) return fail('bank_read_required', 409);
    return state.bank.head!;
  }
  function ownReview(review: BankReview): BankReview {
    bankReviews.set(review, { epoch: bankEpoch, generation, mutation }); publishBank({ pendingReview: review, error: null }); return review;
  }
  function detailEvidence(value: UsFinancialPilotBankStatementDetail): BankDetailEvidence {
    const stamp = value && typeof value === 'object' ? bankPages.get(value) : undefined;
    if (!stamp || stamp.kind !== 'detail' || stamp.epoch !== bankEpoch || stamp.generation !== generation || stamp.mutation !== mutation) return fail('bank_review_evidence_required', 409);
    bankPair(stamp.query); return { query: stamp.query, value };
  }
  function movementEvidence(value: UsFinancialPilotBankMovementsPage): BankMovementEvidence {
    const stamp = value && typeof value === 'object' ? bankPages.get(value) : undefined;
    if (!stamp || stamp.kind !== 'movements' || stamp.epoch !== bankEpoch || stamp.generation !== generation || stamp.mutation !== mutation) return fail('bank_review_evidence_required', 409);
    bankPair(stamp.query); return { query: stamp.query, value };
  }
  // Retain page identity without invoking accessors or cloning away ownership.
  function evidenceArray<T>(value: readonly T[], maximum: number): readonly T[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return fail('bank_input_invalid');
    const output: T[] = [];
    for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !d.enumerable || !('value' in d)) return fail('bank_input_invalid'); output.push(d.value as T); }
    return output;
  }
  async function exportBank(statement: UsFinancialPilotBankStatementDetail, language: CompanyLanguage): Promise<BrowserUsFinancialPilotBankExportResult> {
    alive(); if (pending || state.writing || bankExportFlight) return fail('pending_operation', 409);
    const evidence = detailEvidence(statement), pair = bankPair(evidence.query);
    const selector = bankInput(() => validateUsFinancialPilotBankExportSelector({ consumer: 'financial-pilot', schemaVersion: 1, kind: 'bank_reconciliation', organizationId, ...pair, statementRevision: statement.statement.statementRevision, statementId: statement.statement.statementId, origin: statement.statement.origin, format: 'csv', language }, organizationId));
    const url = browserUsFinancialPilotBankExportUrl(selector), selectorBytes = new TextEncoder().encode(canonicalErpJson(selector));
    clearBankExport(); bankExportFlight = true;
    const epoch = generation, changed = mutation, at = bankEpoch, controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, received: Response | undefined;
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => { controller.abort(); reject(new BrowserUsFinancialPilotError('bank_review_changed', 409, 'rejected')); }; bankExportCancels.add(cancel); });
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsFinancialPilotError('bank_export_timeout', 0, 'rejected')); }, US_FINANCIAL_PILOT_BANK_EXPORT_TIMEOUT_MS); });
    const wait = <T>(task: Promise<T>): Promise<T> => Promise.race([task, deadline, cancelled]);
    function fresh(): void { alive(epoch); if (changed !== mutation || at !== bankEpoch || pending || state.writing) return fail('bank_review_changed', 409); bankPair(pair); }
    const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    async function bytesOf(result: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
      if (!result.body) return fail('invalid_bank_export_response');
      reader = result.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await wait(reader.read()); fresh(); if (part.done) break; const owned = new Uint8Array(part.value); size += owned.byteLength; if (size > maximum) return fail('invalid_bank_export_response'); chunks.push(owned); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
    }
    try {
      const selectorHash = hex(await wait(crypto.subtle.digest('SHA-256', selectorBytes))); fresh();
      const result = await wait(fetcher(url, { method: 'GET', headers: { ...headers(), Accept: 'text/csv' }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal }));
      received = result;
      alive(epoch); if ([401, 402, 403].includes(result.status)) return invalidate(result.status); fresh();
      if (!result.ok) {
        if (result.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('bank_export_unavailable', result.status);
        const bytes = await bytesOf(result, 4096); let body: unknown;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('bank_export_unavailable', result.status); }
        const code = exact(body, ['error']) && typeof body.error === 'string' && publicErrors.has(body.error) ? body.error : 'bank_export_unavailable';
        return fail(code, result.status);
      }
      const h = bankExportHeaders, length = result.headers.get('Content-Length');
      if (!length || !/^[1-9][0-9]*$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES) return fail('invalid_bank_export_response');
      const checks: Readonly<Record<string, string>> = { [h.scope]: '1', [h.bankScope]: '1', [h.organization]: organizationId, [h.revision]: String(selector.revision), [h.bankRevision]: String(selector.bankRevision), [h.statementRevision]: String(selector.statementRevision), [h.statementId]: selector.statementId, [h.origin]: selector.origin, [h.ledgerRevision]: String(statement.ledgerRevision), [h.currency]: 'USD', [h.language]: language, [h.format]: 'csv', [h.selectorHash]: selectorHash };
      if (Object.entries(checks).some(([key, value]) => result.headers.get(key) !== value) || result.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/csv' || result.headers.get('X-Content-Type-Options')?.toLowerCase() !== 'nosniff' || result.headers.get('Referrer-Policy')?.toLowerCase() !== 'no-referrer' || !result.headers.get('Cache-Control')?.toLowerCase().split(',').some(value => value.trim() === 'no-store')) return fail('invalid_bank_export_response');
      const vary = result.headers.get('Vary')?.toLowerCase().split(',').map(value => value.trim());
      if (!['cookie', 'x-zentra-expected-user', 'x-zentra-financial-pilot'].every(value => vary?.includes(value))) return fail('invalid_bank_export_response');
      const filename = result.headers.get('Content-Disposition')?.match(/^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,179})"$/)?.[1], hash = result.headers.get(h.contentHash);
      if (!filename || filename.includes('..') || !filename.endsWith('.csv') || !hash || !/^[0-9a-f]{64}$/.test(hash)) return fail('invalid_bank_export_response');
      const bytes = await bytesOf(result, Number(length)); fresh();
      if (bytes.byteLength !== Number(length) || bytes[0] !== 239 || bytes[1] !== 187 || bytes[2] !== 191) return fail('invalid_bank_export_response');
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const actualHash = hex(await wait(crypto.subtle.digest('SHA-256', bytes))); fresh(); if (actualHash !== hash) return fail('invalid_bank_export_response');
      const output = Object.freeze({ blob: new Blob([bytes], { type: 'text/csv;charset=utf-8' }), filename, revision: selector.revision, bankRevision: selector.bankRevision, statementRevision: selector.statementRevision, statementId: selector.statementId, ledgerRevision: statement.ledgerRevision });
      bankExportResult = output; return output;
    } catch (caught) {
      if (caught instanceof BrowserUsFinancialPilotError) throw caught;
      fresh(); return fail('bank_export_unavailable', 0);
    } finally {
      controller.abort(); if (reader) void reader.cancel().catch(() => {}); else if (received?.body) void received.body.cancel().catch(() => {});
      if (timer !== undefined) clearTimeout(timer); controllers.delete(controller); bankExportCancels.delete(cancel); bankExportFlight = false;
    }
  }
  function downloadBank(result: BrowserUsFinancialPilotBankExportResult): void {
    alive(); if (result !== bankExportResult || !result || pending || state.writing) return fail('invalid_bank_export_response'); bankPair(result);
    const url = URL.createObjectURL(result.blob); bankUrls.add(url);
    try { const link = document.createElement('a'); link.href = url; link.download = result.filename; link.rel = 'noopener'; link.click(); }
    catch { URL.revokeObjectURL(url); bankUrls.delete(url); return fail('bank_export_unavailable', 0); }
    const timer = setTimeout(() => { URL.revokeObjectURL(url); bankUrls.delete(url); bankUrlTimers.delete(timer); }, 1000); bankUrlTimers.add(timer);
  }
  async function send(): Promise<BrowserUsFinancialPilotOperationReceipt | BrowserUsFinancialPilotInvoiceResult | UsFinancialPilotPurchasingReceipt | UsFinancialPilotAccountingReceipt | UsFinancialPilotBankReceipt> {
    alive(); if (!pending) return fail('no_pending_operation', 409); if (state.writing) return fail('pending_operation', 409);
    const original = pending, epoch = generation; mutation++; invalidateCustomerEdits(); publish({ writing: true, pending: true, pendingKind: original.kind, requiresRefresh: true, error: null }); invalidateBank();
    try {
      const path = original.kind === 'bank' ? '/bank/operations' : original.kind === 'accounting' ? '/accounting/operations' : original.kind === 'purchasing' ? '/purchasing/operations' : original.kind === 'invoice_prepare' ? '/invoices/prepare' : original.kind === 'invoice_issue' ? '/invoices/issue' : original.kind === 'commercial' ? '/commercial/operations' : '/operations';
      const body = await response(path, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: original.body }, true); alive(epoch);
      const receipt = validate(() => {
        if (original.kind === 'bank') return validateUsFinancialPilotBankReceipt(body, organizationId, original.request);
        if (original.kind === 'accounting') return validateUsFinancialPilotAccountingReceipt(body, organizationId, original.request);
        if (original.kind === 'purchasing') return validateUsFinancialPilotPurchasingReceipt(body, organizationId, original.request);
        if (original.kind === 'invoice_prepare') return validateUsFinancialPilotInvoicePreview(body, organizationId, original.request);
        if (original.kind === 'invoice_issue') return validateUsFinancialPilotInvoiceReceipt(body, organizationId, original.request);
        if (original.kind === 'commercial') return validateUsFinancialPilotCommercialReceipt(body, organizationId, original.request);
        if (original.kind === 'payment') return validateUsFinancialPilotPaymentReceipt(body, organizationId, original.request);
        return fail('invalid_response', 200, 'uncertain');
      }, true);
      if (original.kind === 'invoice_prepare') { prepared = frozen({ request: original.request, preview: receipt as UsFinancialPilotInvoicePreview }); publish({ invoiceReview: prepared.preview, requiresRefresh: false }); }
      if (original.kind === 'invoice_issue') { prepared = null; publish({ invoiceReview: null }); }
      if (original.kind === 'bank') publishBank({ lastReceipt: receipt as UsFinancialPilotBankReceipt, pendingReview: null, error: null });
      pending = null; publish({ pending: false, pendingKind: null, error: null });
      if (original.kind === 'commercial' && original.request.command.type === 'update_customer') alive(epoch);
      return receipt;
    } catch (caught) { if (!pending && (original.kind === 'invoice_prepare' || original.kind === 'invoice_issue')) { prepared = null; publish({ invoiceReview: null }); } notifyError(caught); throw caught; }
    finally {
      mutation++; if (generation === epoch) {
        publish({ writing: false, pending: pending !== null, pendingKind: pending?.kind ?? null });
        if (!pending && original.kind !== 'invoice_prepare') {
          const previous = original.kind === 'bank' ? bankRefreshFlight : snapshotFlight;
          void Promise.resolve(previous).catch(() => {}).then(async () => {
            if (generation === epoch) { if (original.kind === 'bank') await refreshBank(); else await snapshotLoad(); }
          }).catch(() => {});
        }
      }
    }
  }
  function stop(): void {
    if (stopping) return; stopping = true;
    running = false; generation++; mutation++; if (timer !== undefined) clearTimeout(timer); timer = undefined;
    unsubscribe?.(); unsubscribe = undefined; for (const controller of controllers) controller.abort();
    snapshotFlight = null; refreshFlight = null; pending = null; prepared = null;
    invalidateCustomerEdits();
    invalidateBank(false); bankRefreshFlight = null; floorF = 0; floorB = 0;
    publish({ status: 'stopped', snapshot: null, refreshing: false, writing: false, pending: false, pendingKind: null, invoiceReview: null, requiresRefresh: true, error: null, bank: emptyBank() });
    stopping = false;
  }
  return Object.freeze({
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (disposed || denied || stopping) return fail('session_disposed', 0, 'unauthorized'); if (running) return; running = true; if (state.status === 'stopped') publish({ status: 'idle' }); unsubscribe = environment.subscribe(wake); const epoch = generation; if (environment.isVisible() && environment.isOnline()) void (state.bank.active ? poll() : snapshotLoad()).catch(() => {}).finally(() => { if (generation === epoch) schedule(); }); },
    stop,
    dispose() { if (disposed) return; stop(); disposed = true; listeners.clear(); },
    load: () => snapshotLoad(), refresh: () => refresh(),
    setBankActive(active: boolean) {
      alive(); if (typeof active !== 'boolean') return fail('bank_input_invalid');
      if (active === state.bank.active) return;
      const epoch = generation, changed = mutation;
      invalidateBank(); alive(epoch); if (changed !== mutation) return fail('stale_read', 0);
      publishBank({ active });
      if (active && environment.isVisible() && environment.isOnline()) void Promise.resolve(bankRefreshFlight).catch(() => {}).then(() => { if (!disposed && !denied && state.status !== 'stopped' && state.bank.active) return refreshBank(); }).catch(() => {});
    },
    refreshBank,
    async readBankContext(input?: UsFinancialPilotBankQuery) {
      const query = bankInput(() => validateUsFinancialPilotBankQuery(input ?? bankPair()));
      const stamp = bankReadStamp();
      const result = await bankRead(`/bank/context?${bankParams(query)}`, query, value => validateUsFinancialPilotBankContext(value, organizationId, query));
      confirmBankRead(stamp); bankContext = result; return result;
    },
    readBankStatements(input?: UsFinancialPilotBankListQuery) {
      const query = bankInput(() => validateUsFinancialPilotBankListQuery(input ?? bankPair())), params = bankParams(query); if (query.cursor != null) params.set('cursor', query.cursor);
      return bankRead(`/bank/statements?${params}`, query, value => validateUsFinancialPilotBankStatementsPage(value, organizationId, query));
    },
    async readBankStatement(input: UsFinancialPilotBankDetailQuery) {
      const query = bankInput(() => validateUsFinancialPilotBankDetailQuery(input)), params = bankParams(query); params.set('origin', query.origin);
      if (query.lineCursor != null) params.set('lineCursor', query.lineCursor); if (query.matchCursor != null) params.set('matchCursor', query.matchCursor);
      const stamp = bankReadStamp();
      const result = await bankRead(`/bank/statements/${query.statementId}?${params}`, query, value => validateUsFinancialPilotBankStatementDetail(value, organizationId, query));
      confirmBankRead(stamp); bankPages.set(result, { ...stamp, kind: 'detail', query }); return result;
    },
    async readBankMovements(input: UsFinancialPilotBankMovementQuery) {
      const query = bankInput(() => validateUsFinancialPilotBankMovementQuery(input)), params = bankParams(query); params.set('origin', query.origin); if (query.cursor != null) params.set('cursor', query.cursor);
      const stamp = bankReadStamp();
      const result = await bankRead(`/bank/statements/${query.statementId}/movements?${params}`, query, value => validateUsFinancialPilotBankMovementsPage(value, organizationId, query));
      confirmBankRead(stamp); bankPages.set(result, { ...stamp, kind: 'movements', query }); return result;
    },
    reviewBankImport(draft: BankImportDraft) {
      const head = readyBank();
      return ownReview(bankInput(() => buildBankImportReview({ scope: { organizationId, requestId: newId(), head, expected: { revision: head.revision, bankRevision: head.bankRevision, statementRevision: null } }, context: bankContext!, draft })));
    },
    reviewBank(command: Exclude<UsFinancialPilotBankCommand, { type: 'create_statement' }>, evidence: BrowserUsFinancialPilotBankEvidence) {
      const head = readyBank();
      if (!exact(evidence, ['statement', 'linePages', 'movementPages'])) return fail('bank_input_invalid');
      const ownField = (key: string): unknown => { const d = Object.getOwnPropertyDescriptor(evidence, key); if (!d || !d.enumerable || !('value' in d)) return fail('bank_input_invalid'); return d.value; };
      const statement = detailEvidence(ownField('statement') as UsFinancialPilotBankStatementDetail);
      const linePages = evidenceArray(ownField('linePages') as readonly UsFinancialPilotBankStatementDetail[], 39).map(detailEvidence);
      const movementPages = evidenceArray(ownField('movementPages') as readonly UsFinancialPilotBankMovementsPage[], 40).map(movementEvidence);
      return ownReview(bankInput(() => buildBankCommandReview({ scope: { organizationId, requestId: newId(), head, expected: { revision: head.revision, bankRevision: head.bankRevision, statementRevision: statement.value.statement.statementRevision } }, context: bankContext!, command, evidence: { statement, linePages, movementPages } })));
    },
    submitBank(review: BankReview, approved: boolean) {
      alive(); if (pending || state.writing) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected'));
      const stamp = review && typeof review === 'object' ? bankReviews.get(review) : undefined;
      if (approved !== true || !stamp || review !== state.bank.pendingReview || stamp.epoch !== bankEpoch || stamp.generation !== generation || stamp.mutation !== mutation) return Promise.reject(new BrowserUsFinancialPilotError('bank_review_changed', 409, 'rejected'));
      readyBank();
      pending = frozen({ kind: 'bank', body: review.body, request: review.request, review }); return send() as Promise<UsFinancialPilotBankReceipt>;
    },
    retryBank() { if (pending?.kind !== 'bank') return Promise.reject(new BrowserUsFinancialPilotError('no_pending_operation', 409, 'rejected')); return send() as Promise<UsFinancialPilotBankReceipt>; },
    exportBank, downloadBank,
    readInvoices: (cursor?: string, atRevision?: number) => list('invoices', cursor, atRevision) as Promise<UsFinancialPilotPage<UsFinancialPilotInvoiceRow>>,
    readList: list,
    readAccountingContext(atRevision?: number) {
      const at = currentRevision(atRevision);
      return detail(`/accounting/context?revision=${at}`, at, value => validateUsFinancialPilotAccountingContext(value, organizationId, at));
    },
    readJournal(journalRevision: number, atRevision?: number, lineCursor?: string) {
      if (!revision(journalRevision)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected'));
      const at = currentRevision(atRevision);
      try { financialPilotJournalLinesCursorOffset(lineCursor, at, journalRevision); } catch { return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected')); }
      return detail(`/journals/${journalRevision}?revision=${at}${lineCursor ? `&lineCursor=${encodeURIComponent(lineCursor)}` : ''}`, at, value => validateUsFinancialPilotJournalDetail(value, organizationId, at, journalRevision, lineCursor));
    },
    readPeriod(periodId: string, atRevision?: number) {
      if (!text(periodId)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected'));
      const at = currentRevision(atRevision);
      return detail(`/periods/${encodeURIComponent(periodId)}?revision=${at}`, at, value => validateUsFinancialPilotPeriodDetail(value, organizationId, at, periodId));
    },
    readVendor(vendorId: string, atRevision?: number) {
      if (!text(vendorId)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request',422,'rejected'));
      const at = currentRevision(atRevision); return detail(`/vendors/${encodeURIComponent(vendorId)}?revision=${at}`,at,value => validateUsFinancialPilotVendorDetail(value,organizationId,at,vendorId));
    },
    readVendorBills(cursor?: string, atRevision?: number) {
      const at = currentRevision(atRevision); let offset: number;
      try { offset = financialPilotPurchasingCursorOffset(cursor,'vendor_bills',at,null); } catch { return Promise.reject(new BrowserUsFinancialPilotError('invalid_request',422,'rejected')); }
      return detail(`/vendor-bills?revision=${at}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,at,value => { const page = validateUsFinancialPilotPurchasingPage(value,organizationId,at,'vendor_bills',null); if (offset > page.total || page.items.length !== Math.min(25,page.total-offset) || (page.nextCursor === null ? offset+page.items.length !== page.total : financialPilotPurchasingCursorOffset(page.nextCursor,'vendor_bills',at,null) !== offset+25)) return fail('invalid_response',200); return page; });
    },
    readVendorBill(billId: string, atRevision?: number, paymentCursor?: string) {
      if (!text(billId)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request',422,'rejected'));
      const at = currentRevision(atRevision); let offset: number;
      try { offset = financialPilotPurchasingCursorOffset(paymentCursor,'vendor_payments',at,billId); } catch { return Promise.reject(new BrowserUsFinancialPilotError('invalid_request',422,'rejected')); }
      return detail(`/vendor-bills/${encodeURIComponent(billId)}?revision=${at}${paymentCursor ? `&paymentCursor=${encodeURIComponent(paymentCursor)}` : ''}`,at,value => { const result = validateUsFinancialPilotVendorBillDetail(value,organizationId,at,billId),page=result.payments; if (offset > page.total || page.items.length !== Math.min(25,page.total-offset) || (page.nextCursor === null ? offset+page.items.length !== page.total : financialPilotPurchasingCursorOffset(page.nextCursor,'vendor_payments',at,billId) !== offset+25)) return fail('invalid_response',200); return result; });
    },
    readEstimate(estimateId: string, atRevision?: number) {
      if (!text(estimateId)) return Promise.reject(new BrowserUsFinancialPilotError('invalid_request', 422, 'rejected'));
      const at = currentRevision(atRevision);
      return detail(`/estimates/${encodeURIComponent(estimateId)}?revision=${at}`, at, value => validateUsFinancialPilotEstimateDetail(value, organizationId, at, estimateId));
    },
    async readCustomer(customerId: string, atRevision?: number) {
      if (!text(customerId)) return fail('invalid_request');
      const stamp = customerReady(atRevision);
      const value = await detail(`/customers/${encodeURIComponent(customerId)}?revision=${stamp.revision}`, stamp.revision,
        body => validateUsFinancialPilotCustomerDetail(body, organizationId, stamp.revision, customerId));
      customerFresh(stamp); customerPages.set(value, stamp); return value;
    },
    reviewCustomerEdit(source: UsFinancialPilotCustomerDetail, customer: UsFinancialPilotCommercialCustomer) {
      const stamp = customerReady(), owned = customerPages.get(source);
      if (!owned) return fail('customer_edit_review_required', 409);
      customerFresh(owned);
      let review: CustomerEditReview;
      try { review = buildCustomerEditReview({ organizationId, requestId: newId(), revision: stamp.revision, source, customer }); }
      catch { return fail('invalid_financial_pilot_request'); }
      customerFresh(stamp); customerReviews.set(review, stamp); activeCustomerReview = review; return review;
    },
    async submitCustomerEdit(review: CustomerEditReview, approved: boolean) {
      const stamp = customerReady(), owned = customerReviews.get(review);
      if (approved !== true || !owned || activeCustomerReview !== review) return Promise.reject(new BrowserUsFinancialPilotError('customer_edit_review_changed', 409, 'rejected'));
      customerFresh(owned); customerFresh(stamp);
      pending = frozen({ kind: 'commercial', body: review.body, request: review.request }); return send() as Promise<UsFinancialPilotCommercialReceipt>;
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
      if (request.command.type === 'update_customer') return fail('customer_edit_review_required', 409);
      pending = frozen({ kind: 'commercial', body: JSON.stringify(request), request }); return send() as Promise<UsFinancialPilotCommercialReceipt>;
    },
    purchasing(command: UsFinancialPilotPurchasingCommand, expectedRevision?: number) {
      alive(); if (pending || state.writing) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation',409,'rejected')); if (state.requiresRefresh || !state.snapshot) return Promise.reject(new BrowserUsFinancialPilotError('read_required',409,'rejected'));
      const at = currentRevision(expectedRevision); if (at !== state.snapshot.revision) return Promise.reject(new BrowserUsFinancialPilotError('financial_snapshot_changed',409,'rejected'));
      let request: UsFinancialPilotPurchasingRequest; try { request = frozen(validateUsFinancialPilotPurchasingRequest({ consumer:'financial-pilot',schemaVersion:1,requestId:newId(),expectedRevision:at,command })); } catch { return fail('invalid_financial_pilot_request'); }
      pending = frozen({ kind:'purchasing',body:JSON.stringify(request),request }); return send() as Promise<UsFinancialPilotPurchasingReceipt>;
    },
    retryPurchasing() { if (pending?.kind !== 'purchasing') return Promise.reject(new BrowserUsFinancialPilotError('no_pending_operation',409,'rejected')); return send() as Promise<UsFinancialPilotPurchasingReceipt>; },
    accounting(command: UsFinancialPilotAccountingCommand, expectedRevision?: number) {
      alive(); if (pending || state.writing) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected'));
      if (state.requiresRefresh || !state.snapshot) return Promise.reject(new BrowserUsFinancialPilotError('read_required', 409, 'rejected'));
      const at = currentRevision(expectedRevision); if (at !== state.snapshot.revision) return Promise.reject(new BrowserUsFinancialPilotError('financial_snapshot_changed', 409, 'rejected'));
      let request: UsFinancialPilotAccountingRequest;
      try { request = frozen(validateUsFinancialPilotAccountingRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: newId(), expectedRevision: at, command })); } catch { return fail('invalid_financial_pilot_request'); }
      pending = frozen({ kind: 'accounting', body: JSON.stringify(request), request }); return send() as Promise<UsFinancialPilotAccountingReceipt>;
    },
    retryAccounting() { if (pending?.kind !== 'accounting') return Promise.reject(new BrowserUsFinancialPilotError('no_pending_operation', 409, 'rejected')); return send() as Promise<UsFinancialPilotAccountingReceipt>; },
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
    retry() { if (pending && ['invoice_prepare', 'invoice_issue', 'purchasing', 'accounting', 'bank'].includes(pending.kind)) return Promise.reject(new BrowserUsFinancialPilotError('pending_operation', 409, 'rejected')); return send() as Promise<BrowserUsFinancialPilotOperationReceipt>; }, hasPending: () => pending !== null,
  });
}
