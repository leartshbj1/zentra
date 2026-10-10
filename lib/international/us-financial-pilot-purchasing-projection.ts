import { validDate } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { vendorBillBalance, type RecordedVendorBill } from './purchasing';
import type { UsFinancialBookViewV5 } from './us-financial-kernel-types';
import { US_FINANCIAL_PILOT_PAGE_SIZE, UsFinancialPilotError, validateUsFinancialPilotHead, validateUsFinancialPilotPage,
  type UsFinancialPilotHead, type UsFinancialPilotParty } from './us-financial-pilot-contract';
import { financialPilotHead, financialPilotParty, readUsFinancialPilotView } from './us-financial-pilot-projection';

/** This closed page contract deliberately does not extend the incumbent kind union. */
export type UsFinancialPilotPurchasingPageKind = 'vendor_bills' | 'vendor_payments';
export interface UsFinancialPilotVendorBillRow {
  readonly id: string; readonly vendorId: string; readonly vendorName: string; readonly reference: string;
  readonly date: string; readonly accountingDate: string; readonly dueDate: string; readonly periodId: string;
  readonly netMinor: string; readonly purchaseTaxMinor: string; readonly totalMinor: string; readonly paidMinor: string; readonly outstandingMinor: string;
  readonly status: 'open' | 'partially_paid' | 'paid'; readonly approvedBy: string; readonly approvedAt: string; readonly recordedRevision: number;
}
export interface UsFinancialPilotVendorPaymentRow {
  readonly id: string; readonly billId: string; readonly amountMinor: string; readonly paymentDate: string; readonly accountingDate: string;
  readonly periodId: string; readonly reference: string; readonly recordedBy: string; readonly recordedAt: string; readonly recordedRevision: number;
}
export type UsFinancialPilotPurchasingRow = UsFinancialPilotVendorBillRow | UsFinancialPilotVendorPaymentRow;
export interface UsFinancialPilotPurchasingPage<T extends UsFinancialPilotPurchasingRow = UsFinancialPilotPurchasingRow> extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly kind: UsFinancialPilotPurchasingPageKind; readonly scope: string | null;
  readonly total: number; readonly items: readonly T[]; readonly nextCursor: string | null;
}
export interface UsFinancialPilotVendorDetail extends UsFinancialPilotHead { readonly ledgerRevision: number; readonly vendor: UsFinancialPilotParty }
export interface UsFinancialPilotVendorBillDetail extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly bill: UsFinancialPilotVendorBillRow; readonly vendor: UsFinancialPilotParty;
  readonly sourceReference: string; readonly approvalSource: 'manual_entry'; readonly payments: UsFinancialPilotPurchasingPage<UsFinancialPilotVendorPaymentRow>;
}
export interface UsFinancialPilotVendorBillsQuery { readonly revision: number; readonly cursor?: string | null }
export interface UsFinancialPilotVendorDetailQuery { readonly revision: number; readonly vendorId: string }
export interface UsFinancialPilotVendorBillDetailQuery { readonly revision: number; readonly billId: string; readonly paymentCursor?: string | null }
const invalid = (): never => { throw new ErpError('invalid_financial_pilot_response', 503); };
const invalidQuery = (): never => { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid(); }
function date(value: unknown): string { return typeof value === 'string' && !value.startsWith('0000-') && validDate(value) ? value : invalid(); }
function instant(value: unknown): string {
  const v = text(value, 40);
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return invalid();
  parseInstant(v); return v;
}
function unsigned(value: unknown, positive = false): string { return typeof value === 'string' && (positive ? /^[1-9][0-9]{0,35}$/ : /^(0|[1-9][0-9]{0,35})$/).test(value) ? value : invalid(); }
function ledger(value: unknown, head: UsFinancialPilotHead): number { const revision = integer(value); return revision <= head.revision ? revision : invalid(); }
function head(value: Record<string, unknown>, organizationId?: string, revision?: number): UsFinancialPilotHead {
  const result = validateUsFinancialPilotHead({ consumer: value.consumer, schemaVersion: value.schemaVersion, organizationId: value.organizationId, revision: value.revision }, organizationId);
  if (revision !== undefined && result.revision !== revision) throw new UsFinancialPilotError('financial_snapshot_changed', 409);
  return result;
}
function party(value: unknown, h: UsFinancialPilotHead, ledgerRevision: number): UsFinancialPilotParty {
  const p = validateUsFinancialPilotPage({ ...h, ledgerRevision, kind: 'vendors', scope: null, total: 1, items: [value], nextCursor: null }, h.organizationId, h.revision);
  return p.items[0] as UsFinancialPilotParty;
}
function billRow(value: unknown, revision: number): UsFinancialPilotVendorBillRow {
  const v = exact(value, ['id', 'vendorId', 'vendorName', 'reference', 'date', 'accountingDate', 'dueDate', 'periodId', 'netMinor', 'purchaseTaxMinor', 'totalMinor', 'paidMinor', 'outstandingMinor', 'status', 'approvedBy', 'approvedAt', 'recordedRevision']);
  const netMinor = unsigned(v.netMinor), purchaseTaxMinor = unsigned(v.purchaseTaxMinor), totalMinor = unsigned(v.totalMinor, true), paidMinor = unsigned(v.paidMinor), outstandingMinor = unsigned(v.outstandingMinor);
  const documentDate = date(v.date), dueDate = date(v.dueDate), recordedRevision = integer(v.recordedRevision, 1, revision);
  const status = outstandingMinor === '0' ? 'paid' : paidMinor === '0' ? 'open' : 'partially_paid';
  if (BigInt(netMinor) + BigInt(purchaseTaxMinor) !== BigInt(totalMinor) || BigInt(paidMinor) + BigInt(outstandingMinor) !== BigInt(totalMinor) || v.status !== status || dueDate < documentDate) return invalid();
  return Object.freeze({ id: text(v.id), vendorId: text(v.vendorId), vendorName: text(v.vendorName, 4000), reference: text(v.reference, 500), date: documentDate,
    accountingDate: date(v.accountingDate), dueDate, periodId: text(v.periodId), netMinor, purchaseTaxMinor, totalMinor, paidMinor, outstandingMinor, status,
    approvedBy: text(v.approvedBy), approvedAt: instant(v.approvedAt), recordedRevision });
}
function paymentRow(value: unknown, revision: number): UsFinancialPilotVendorPaymentRow {
  const v = exact(value, ['id', 'billId', 'amountMinor', 'paymentDate', 'accountingDate', 'periodId', 'reference', 'recordedBy', 'recordedAt', 'recordedRevision']);
  return Object.freeze({ id: text(v.id), billId: text(v.billId), amountMinor: unsigned(v.amountMinor, true), paymentDate: date(v.paymentDate), accountingDate: date(v.accountingDate),
    periodId: text(v.periodId), reference: text(v.reference, 500), recordedBy: text(v.recordedBy), recordedAt: instant(v.recordedAt), recordedRevision: integer(v.recordedRevision, 1, revision) });
}
export function financialPilotPurchasingCursor(kind: UsFinancialPilotPurchasingPageKind, revision: number, offset: number, scope: string | null): string {
  const value = JSON.stringify([kind, revision, offset, scope]); financialPilotPurchasingCursorOffset(value, kind, revision, scope); return value;
}
export function financialPilotPurchasingCursorOffset(value: unknown, kind: UsFinancialPilotPurchasingPageKind, revision: number, scope: string | null): number {
  try {
    if (!['vendor_bills', 'vendor_payments'].includes(kind) || integer(revision, 1) !== revision || (kind === 'vendor_bills' ? scope !== null : text(scope) !== scope)) return invalidQuery();
    if (value === null || value === undefined) return 0;
    if (typeof value !== 'string' || value.length > 512) return invalidQuery();
    const v: unknown = JSON.parse(value);
    if (!Array.isArray(v) || v.length !== 4 || v[0] !== kind || v[1] !== revision || v[3] !== scope || integer(v[2], 25, 1_000_000) % 25 !== 0 || JSON.stringify(v) !== value) return invalidQuery();
    return v[2] as number;
  } catch { return invalidQuery(); }
}
function query(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const v = snapshotPrivateJson(value);
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => ![...required, ...optional].includes(k))) return invalidQuery();
  return v as Record<string, unknown>;
}
export function validateUsFinancialPilotVendorBillsQuery(value: unknown): UsFinancialPilotVendorBillsQuery {
  try {
    const v = query(value, ['revision'], ['cursor']), revision = integer(v.revision, 1), cursor = v.cursor === undefined ? null : v.cursor === null ? null : text(v.cursor, 512);
    financialPilotPurchasingCursorOffset(cursor, 'vendor_bills', revision, null); return Object.freeze({ revision, cursor });
  } catch { return invalidQuery(); }
}
export function validateUsFinancialPilotVendorDetailQuery(value: unknown): UsFinancialPilotVendorDetailQuery {
  try { const v = query(value, ['revision', 'vendorId']); return Object.freeze({ revision: integer(v.revision, 1), vendorId: text(v.vendorId) }); } catch { return invalidQuery(); }
}
export function validateUsFinancialPilotVendorBillDetailQuery(value: unknown): UsFinancialPilotVendorBillDetailQuery {
  try {
    const v = query(value, ['revision', 'billId'], ['paymentCursor']), revision = integer(v.revision, 1), billId = text(v.billId), paymentCursor = v.paymentCursor === undefined ? null : v.paymentCursor === null ? null : text(v.paymentCursor, 512);
    financialPilotPurchasingCursorOffset(paymentCursor, 'vendor_payments', revision, billId); return Object.freeze({ revision, billId, paymentCursor });
  } catch { return invalidQuery(); }
}
export function validateUsFinancialPilotPurchasingPage(value: unknown, organizationId: string | undefined, revision: number | undefined, kind: 'vendor_bills', scope?: null): UsFinancialPilotPurchasingPage<UsFinancialPilotVendorBillRow>;
export function validateUsFinancialPilotPurchasingPage(value: unknown, organizationId: string | undefined, revision: number | undefined, kind: 'vendor_payments', scope: string): UsFinancialPilotPurchasingPage<UsFinancialPilotVendorPaymentRow>;
export function validateUsFinancialPilotPurchasingPage(value: unknown, organizationId?: string, revision?: number, kind?: UsFinancialPilotPurchasingPageKind, scope?: string | null): UsFinancialPilotPurchasingPage;
export function validateUsFinancialPilotPurchasingPage(value: unknown, organizationId?: string, revision?: number, expectedKind?: UsFinancialPilotPurchasingPageKind, expectedScope?: string | null): UsFinancialPilotPurchasingPage {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'kind', 'scope', 'total', 'items', 'nextCursor']), h = head(v, organizationId, revision), ledgerRevision = ledger(v.ledgerRevision, h);
    if (!['vendor_bills', 'vendor_payments'].includes(v.kind as string) || (expectedKind !== undefined && v.kind !== expectedKind) || (expectedScope !== undefined && v.scope !== expectedScope)) return invalid();
    const kind = v.kind as UsFinancialPilotPurchasingPageKind, scope = v.scope === null ? null : text(v.scope), total = integer(v.total, 0, 1_000_000);
    if ((kind === 'vendor_payments') !== (scope !== null) || !Array.isArray(v.items) || v.items.length > US_FINANCIAL_PILOT_PAGE_SIZE || v.items.length > total || (total > 0 && v.items.length === 0)) return invalid();
    const items = Object.freeze(v.items.map(item => kind === 'vendor_bills' ? billRow(item, h.revision) : paymentRow(item, h.revision)));
    if (new Set(items.map(item => item.id)).size !== items.length || items.some((item, index) => index > 0 && (items[index - 1].recordedRevision < item.recordedRevision || (items[index - 1].recordedRevision === item.recordedRevision && compare(items[index - 1].id, item.id) < 0)))) return invalid();
    if (kind === 'vendor_payments' && items.some(item => !('billId' in item) || item.billId !== scope)) return invalid();
    const nextCursor = v.nextCursor === null ? null : text(v.nextCursor, 512);
    if (nextCursor !== null) {
      const offset = financialPilotPurchasingCursorOffset(nextCursor, kind, h.revision, scope);
      if (offset >= total || items.length !== US_FINANCIAL_PILOT_PAGE_SIZE) return invalid();
    }
    return Object.freeze({ ...h, ledgerRevision, kind, scope, total, items, nextCursor });
  } catch (error) { if (error instanceof UsFinancialPilotError && error.code === 'financial_snapshot_changed') throw error; return invalid(); }
}
export function validateUsFinancialPilotVendorDetail(value: unknown, organizationId?: string, revision?: number, vendorId?: string): UsFinancialPilotVendorDetail {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'vendor']), h = head(v, organizationId, revision), ledgerRevision = ledger(v.ledgerRevision, h), vendor = party(v.vendor, h, ledgerRevision);
    if (vendorId !== undefined && vendor.id !== vendorId) return invalid();
    return Object.freeze({ ...h, ledgerRevision, vendor });
  } catch (error) { if (error instanceof UsFinancialPilotError && error.code === 'financial_snapshot_changed') throw error; return invalid(); }
}
export function validateUsFinancialPilotVendorBillDetail(value: unknown, organizationId?: string, revision?: number, billId?: string): UsFinancialPilotVendorBillDetail {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'bill', 'vendor', 'sourceReference', 'approvalSource', 'payments']), h = head(v, organizationId, revision), ledgerRevision = ledger(v.ledgerRevision, h);
    const bill = billRow(v.bill, h.revision), vendor = party(v.vendor, h, ledgerRevision), payments = validateUsFinancialPilotPurchasingPage(v.payments, h.organizationId, h.revision, 'vendor_payments', bill.id);
    if ((billId !== undefined && bill.id !== billId) || bill.vendorId !== vendor.id || bill.vendorName !== vendor.name || v.approvalSource !== 'manual_entry' || payments.ledgerRevision !== ledgerRevision || payments.items.some(payment => payment.recordedRevision <= bill.recordedRevision)) return invalid();
    const displayedPaid = payments.items.reduce((n, payment) => n + BigInt(payment.amountMinor), BigInt(0));
    if (displayedPaid > BigInt(bill.paidMinor) || (payments.total === 0) !== (bill.paidMinor === '0') || (payments.total === payments.items.length && displayedPaid.toString() !== bill.paidMinor)) return invalid();
    return Object.freeze({ ...h, ledgerRevision, bill, vendor, sourceReference: text(v.sourceReference, 500), approvalSource: 'manual_entry', payments });
  } catch (error) { if (error instanceof UsFinancialPilotError && error.code === 'financial_snapshot_changed') throw error; return invalid(); }
}
function publicBill(view: UsFinancialBookViewV5, bill: RecordedVendorBill): UsFinancialPilotVendorBillRow {
  const outstandingMinor = vendorBillBalance(bill, view.vendorPayments.filter(payment => payment.billId === bill.id)).minorUnits, paidMinor = (BigInt(bill.total.minorUnits) - BigInt(outstandingMinor)).toString();
  return { id: bill.id, vendorId: bill.vendorId, vendorName: bill.vendorSnapshot.name, reference: bill.reference, date: bill.date, accountingDate: bill.accountingDate, dueDate: bill.dueDate,
    periodId: bill.periodId, netMinor: bill.net.minorUnits, purchaseTaxMinor: bill.tax.minorUnits, totalMinor: bill.total.minorUnits, paidMinor, outstandingMinor,
    status: outstandingMinor === '0' ? 'paid' : paidMinor === '0' ? 'open' : 'partially_paid', approvedBy: bill.validatedBy, approvedAt: bill.approvedAt, recordedRevision: bill.recordedRevision };
}
function page<T extends UsFinancialPilotPurchasingRow>(view: UsFinancialBookViewV5, kind: UsFinancialPilotPurchasingPageKind, rows: readonly T[], cursor: string | null | undefined, scope: string | null): UsFinancialPilotPurchasingPage<T> {
  const offset = financialPilotPurchasingCursorOffset(cursor, kind, view.revision, scope);
  if (offset > 0 && offset >= rows.length) return invalidQuery();
  const end = offset + US_FINANCIAL_PILOT_PAGE_SIZE;
  return validateUsFinancialPilotPurchasingPage({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, kind, scope, total: rows.length, items: rows.slice(offset, end),
    nextCursor: end < rows.length ? financialPilotPurchasingCursor(kind, view.revision, end, scope) : null }, view.organizationId, view.revision, kind, scope) as UsFinancialPilotPurchasingPage<T>;
}
/** All caller data is synchronously detached before asynchronous V5 replay. */
export async function projectUsFinancialPilotVendor(input: unknown, queryInput: UsFinancialPilotVendorDetailQuery): Promise<UsFinancialPilotVendorDetail> {
  const query = validateUsFinancialPilotVendorDetailQuery(queryInput), view = await readUsFinancialPilotView(input, query.revision), vendor = view.vendors.find(row => row.id === query.vendorId);
  if (!vendor) throw new UsFinancialPilotError('financial_pilot_record_not_found', 404);
  return validateUsFinancialPilotVendorDetail({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, vendor: financialPilotParty(vendor) }, view.organizationId, view.revision, query.vendorId);
}
export async function projectUsFinancialPilotVendorBills(input: unknown, queryInput: UsFinancialPilotVendorBillsQuery): Promise<UsFinancialPilotPurchasingPage<UsFinancialPilotVendorBillRow>> {
  const query = validateUsFinancialPilotVendorBillsQuery(queryInput), view = await readUsFinancialPilotView(input, query.revision);
  const rows = view.vendorBills.map(bill => publicBill(view, bill)).sort((a, b) => b.recordedRevision - a.recordedRevision || compare(b.id, a.id));
  return page(view, 'vendor_bills', rows, query.cursor, null);
}
export async function projectUsFinancialPilotVendorBill(input: unknown, queryInput: UsFinancialPilotVendorBillDetailQuery): Promise<UsFinancialPilotVendorBillDetail> {
  const query = validateUsFinancialPilotVendorBillDetailQuery(queryInput), view = await readUsFinancialPilotView(input, query.revision), bill = view.vendorBills.find(row => row.id === query.billId);
  if (!bill) throw new UsFinancialPilotError('financial_pilot_record_not_found', 404);
  const rows = view.vendorPayments.filter(payment => payment.billId === bill.id).map(payment => ({ id: payment.id, billId: payment.billId, amountMinor: payment.amount.minorUnits,
    paymentDate: payment.paymentDate, accountingDate: payment.accountingDate, periodId: payment.periodId, reference: payment.reference, recordedBy: payment.recordedBy,
    recordedAt: payment.recordedAt, recordedRevision: payment.recordedRevision })).sort((a, b) => b.recordedRevision - a.recordedRevision || compare(b.id, a.id));
  return validateUsFinancialPilotVendorBillDetail({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, bill: publicBill(view, bill), vendor: financialPilotParty(bill.vendorSnapshot),
    sourceReference: bill.sourceReference, approvalSource: bill.approvalSource, payments: page(view, 'vendor_payments', rows, query.paymentCursor, bill.id) }, view.organizationId, view.revision, query.billId);
}
