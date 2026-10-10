import type { PostedJournal } from './accounting/ledger';
import { estimateTotals, lineTotals, type Contact } from './invoicing';
import { snapshotPrivateJson } from './private-json';
import { projectUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialBookViewV5 } from './us-financial-kernel-types';
import {
  US_FINANCIAL_PILOT_PAGE_SIZE, UsFinancialPilotError, financialPilotCursor, financialPilotCursorOffset,
  validateUsFinancialPilotInvoiceDetail, validateUsFinancialPilotListQuery, validateUsFinancialPilotOverview, validateUsFinancialPilotPage,
  type UsFinancialPilotCreditRow, type UsFinancialPilotHead, type UsFinancialPilotInvoiceDetail, type UsFinancialPilotInvoiceQuery,
  type UsFinancialPilotInvoiceRow, type UsFinancialPilotListKind, type UsFinancialPilotListQuery, type UsFinancialPilotOverview,
  type UsFinancialPilotPage, type UsFinancialPilotPageKind, type UsFinancialPilotParty, type UsFinancialPilotRow,
  type UsFinancialPilotSource, type UsFinancialPilotSummary,
} from './us-financial-pilot-contract';

const invalid = (): never => { throw new UsFinancialPilotError('invalid_financial_pilot_data', 503); };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** Synchronous capture prevents caller mutation during the asynchronous replay.
 * This server-only helper is never an HTTP payload or an authority check. */
export async function readUsFinancialPilotView(input: unknown, expectedRevision?: number): Promise<UsFinancialBookViewV5> {
  let captured: unknown;
  try { captured = snapshotPrivateJson(input); } catch { return invalid(); }
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new UsFinancialPilotError('invalid_financial_pilot_query', 422);
  let view: UsFinancialBookViewV5;
  try { view = await projectUsFinancialBookV5(captured as UsFinancialBookV5); } catch { return invalid(); }
  if (view.configuration.country !== 'US' || view.configuration.currency !== 'USD' || view.configuration.accountingBasis !== 'accrual') return invalid();
  if (expectedRevision !== undefined && view.revision !== expectedRevision) throw new UsFinancialPilotError('financial_snapshot_changed', 409);
  return view;
}
export function financialPilotHead(view: UsFinancialBookViewV5): UsFinancialPilotHead { return { schemaVersion: 1, consumer: 'financial-pilot', organizationId: view.organizationId, revision: view.revision }; }
export function financialPilotParty(contact: Contact): UsFinancialPilotParty {
  return { id: contact.id, name: contact.name, kind: contact.kind, billingAddress: contact.billingAddress, shippingAddress: contact.shippingAddress ?? null, email: contact.email ?? null, phone: contact.phone ?? null, contactName: contact.contactName ?? null, paymentTermsDays: contact.paymentTermsDays };
}
export function financialPilotInvoiceRows(view: UsFinancialBookViewV5): readonly UsFinancialPilotInvoiceRow[] {
  return view.invoices.map(invoice => {
    const settlement = view.settlements.find(row => row.invoiceId === invoice.id); if (!settlement) return invalid();
    return { id: invoice.id, number: invoice.number, customerId: invoice.customer.id, customerName: invoice.customer.name, date: invoice.date, accountingDate: invoice.accountingDate, dueDate: invoice.dueDate, issuedAt: invoice.issuedAt, issuedBy: invoice.issuedBy,
      totalMinor: settlement.totalMinor, receivedMinor: settlement.receivedMinor, creditedMinor: settlement.creditedMinor, outstandingMinor: settlement.outstandingMinor, status: settlement.status };
  }).sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt) || compare(b.id, a.id));
}
export function financialPilotSummary(rows: readonly UsFinancialPilotInvoiceRow[]): UsFinancialPilotSummary {
  const sum = (key: 'totalMinor' | 'receivedMinor' | 'creditedMinor' | 'outstandingMinor') => rows.reduce((n, row) => n + BigInt(row[key]), BigInt(0)).toString();
  return { invoiceCount: rows.length, totalMinor: sum('totalMinor'), receivedMinor: sum('receivedMinor'), creditedMinor: sum('creditedMinor'), outstandingMinor: sum('outstandingMinor') };
}
export function financialPilotPage<T extends UsFinancialPilotRow>(view: UsFinancialBookViewV5, kind: UsFinancialPilotPageKind, rows: readonly T[], cursor: string | null | undefined = null, rowScope: string | null = null): UsFinancialPilotPage<T> {
  const offset = financialPilotCursorOffset(cursor, kind, view.revision, rowScope);
  if (offset > 0 && offset >= rows.length) throw new UsFinancialPilotError('invalid_financial_pilot_query', 422);
  const end = offset + US_FINANCIAL_PILOT_PAGE_SIZE;
  return validateUsFinancialPilotPage({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, kind, scope: rowScope, total: rows.length, items: rows.slice(offset, end), nextCursor: end < rows.length ? financialPilotCursor(kind, view.revision, end, rowScope) : null }, view.organizationId, view.revision) as UsFinancialPilotPage<T>;
}
export function financialPilotPublicSource(view: UsFinancialBookViewV5, entry: PostedJournal): UsFinancialPilotSource {
  const id = entry.source.id, empty = { entityId: null, reference: null, journalRevision: null };
  switch (entry.source.type) {
    case 'customer_invoice': { const row = view.invoices.find(invoice => invoice.id === id); return row ? { kind: 'customer_invoice', entityId: row.id, reference: row.number, journalRevision: null } : invalid(); }
    case 'customer_payment': { const invoice = view.invoices.find(row => row.id === id); return invoice ? { kind: 'customer_payment', entityId: invoice.id, reference: invoice.number, journalRevision: null } : invalid(); }
    case 'customer_credit': { const row = view.credits.find(credit => credit.id === id); return row ? { kind: 'customer_credit', entityId: row.id, reference: row.number, journalRevision: null } : invalid(); }
    case 'vendor_bill': { const row = view.vendorBills.find(bill => bill.id === id); return row ? { kind: 'vendor_bill', entityId: row.id, reference: row.reference, journalRevision: null } : invalid(); }
    case 'vendor_payment': { const row = view.vendorBills.find(bill => bill.id === id); return row ? { kind: 'vendor_payment', entityId: row.id, reference: row.reference, journalRevision: null } : invalid(); }
    case 'manual_journal': return { kind: 'manual_journal', ...empty, reference: id };
    case 'manual_reversal': { const original = view.ledger.entries.find(row => row.id === entry.reversesEntryId); return original ? { kind: 'manual_reversal', ...empty, journalRevision: original.revision } : invalid(); }
    default: return { kind: 'other', ...empty };
  }
}
function creditRows(view: UsFinancialBookViewV5, invoiceId: string): readonly UsFinancialPilotCreditRow[] {
  return view.credits.filter(credit => credit.invoiceId === invoiceId).map(credit => ({ id: credit.id, number: credit.number, invoiceId: credit.invoiceId, transactionDate: credit.transactionDate, accountingDate: credit.accountingDate, periodId: credit.periodId, reason: credit.reason, netMinor: credit.allocation.netMinor, taxMinor: credit.allocation.taxMinor, totalMinor: credit.allocation.totalMinor, taxDisposition: credit.taxDisposition, issuedBy: credit.issuedBy, issuedAt: credit.issuedAt, recordedRevision: credit.recordedRevision })).sort((a, b) => b.recordedRevision - a.recordedRevision || compare(b.id, a.id));
}
function list(view: UsFinancialBookViewV5, kind: UsFinancialPilotListKind, cursor?: string | null): UsFinancialPilotPage {
  if (kind === 'invoices') return financialPilotPage(view, kind, financialPilotInvoiceRows(view), cursor);
  if (kind === 'customers' || kind === 'vendors') return financialPilotPage(view, kind, view[kind].map(financialPilotParty).sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id)), cursor);
  if (kind === 'estimates') return financialPilotPage(view, kind, view.estimates.map(estimate => ({ id: estimate.id, number: estimate.number, revision: estimate.revision, customerId: estimate.customer.id, customerName: estimate.customer.name, date: estimate.date, expiresAt: estimate.expiresAt, status: estimate.status, netMinor: estimateTotals(estimate).net.minorUnits })).sort((a, b) => compare(b.date, a.date) || compare(b.id, a.id)), cursor);
  if (kind === 'periods') return financialPilotPage(view, kind, [...view.ledger.periods].sort((a, b) => compare(b.start, a.start) || compare(b.id, a.id)).map(period => ({ id: period.id, start: period.start, end: period.end, status: period.status })), cursor);
  return financialPilotPage(view, kind, [...view.ledger.entries].sort((a, b) => b.revision - a.revision).map(entry => ({ journalRevision: entry.revision, transactionDate: entry.transactionDate, accountingDate: entry.accountingDate, paymentDate: entry.paymentDate ?? null, periodId: entry.periodId, description: entry.description,
    debitMinor: entry.lines.reduce((n, line) => n + BigInt(line.debitMinor), BigInt(0)).toString(), creditMinor: entry.lines.reduce((n, line) => n + BigInt(line.creditMinor), BigInt(0)).toString(), postedBy: entry.postedBy, postedAt: entry.postedAt, source: financialPilotPublicSource(view, entry),
    reversesJournalRevision: entry.reversesEntryId ? view.ledger.entries.find(row => row.id === entry.reversesEntryId)?.revision ?? invalid() : null, reversedByJournalRevision: view.ledger.entries.find(row => row.reversesEntryId === entry.id)?.revision ?? null })), cursor);
}
export async function projectUsFinancialPilotOverview(input: unknown, expectedRevision?: number): Promise<UsFinancialPilotOverview> {
  const view = await readUsFinancialPilotView(input, expectedRevision), rows = financialPilotInvoiceRows(view);
  return validateUsFinancialPilotOverview({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, company: { country: 'US', currency: 'USD', accountingBasis: 'accrual', language: view.configuration.language, timeZone: view.configuration.timeZone }, summary: financialPilotSummary(rows), invoices: financialPilotPage(view, 'invoices', rows), customers: list(view, 'customers'), vendors: list(view, 'vendors'), estimates: list(view, 'estimates'), journals: list(view, 'journals'), periods: list(view, 'periods') }, view.organizationId, view.revision);
}
export async function projectUsFinancialPilotList(input: unknown, queryInput: UsFinancialPilotListQuery): Promise<UsFinancialPilotPage> {
  const query = validateUsFinancialPilotListQuery(queryInput), view = await readUsFinancialPilotView(input, query.revision);
  return list(view, query.kind, query.cursor);
}
export async function projectUsFinancialPilotInvoices(input: unknown, queryInput: Readonly<{ revision: number; cursor?: string | null }>): Promise<UsFinancialPilotPage<UsFinancialPilotInvoiceRow>> {
  let raw: Record<string, unknown>; try { raw = snapshotPrivateJson(queryInput) as Record<string, unknown>; if (!raw || Array.isArray(raw) || Object.keys(raw).some(key => !['revision', 'cursor'].includes(key))) throw Error(); } catch { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); }
  return projectUsFinancialPilotList(input, { ...raw, kind: 'invoices' } as unknown as UsFinancialPilotListQuery) as Promise<UsFinancialPilotPage<UsFinancialPilotInvoiceRow>>;
}
export async function projectUsFinancialPilotInvoice(input: unknown, queryInput: UsFinancialPilotInvoiceQuery): Promise<UsFinancialPilotInvoiceDetail> {
  let query: UsFinancialPilotInvoiceQuery;
  try { query = snapshotPrivateJson(queryInput) as UsFinancialPilotInvoiceQuery; if (!query || Array.isArray(query) || Object.keys(query).some(key => !['revision', 'invoiceId', 'paymentCursor', 'creditCursor'].includes(key)) || !Number.isSafeInteger(query.revision) || query.revision < 1 || typeof query.invoiceId !== 'string' || !query.invoiceId.trim() || query.invoiceId.length > 256) throw Error(); financialPilotCursorOffset(query.paymentCursor, 'invoice_payments', query.revision, query.invoiceId); financialPilotCursorOffset(query.creditCursor, 'invoice_credits', query.revision, query.invoiceId); } catch { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); }
  const view = await readUsFinancialPilotView(input, query.revision), invoice = view.invoices.find(row => row.id === query.invoiceId);
  if (!invoice) throw new UsFinancialPilotError('financial_pilot_record_not_found', 404);
  const publicInvoice = financialPilotInvoiceRows(view).find(row => row.id === invoice.id) ?? invalid();
  const payments = [...invoice.payments].sort((a, b) => compare(b.paymentDate, a.paymentDate) || compare(b.id, a.id)).map(payment => ({ id: payment.id, invoiceId: payment.invoiceId, amountMinor: payment.amount.minorUnits, paymentDate: payment.paymentDate, accountingDate: payment.accountingDate, reference: payment.reference, recordedBy: payment.recordedBy }));
  const lines = invoice.lines.map(line => ({ id: line.id, description: line.description, quantityUnits: line.quantityUnits, quantityScale: line.quantityScale, unitPriceMinor: line.unitPrice.minorUnits, discountBasisPoints: line.discountBasisPoints, netMinor: lineTotals(line, 'USD').net.minorUnits, taxMinor: invoice.taxAssessment.lines.find(row => row.id === line.id)?.taxMinor ?? invalid() }));
  return validateUsFinancialPilotInvoiceDetail({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, invoice: publicInvoice,
    seller: { name: invoice.sellerSnapshot.displayName, address: invoice.companyConfiguration.address, email: invoice.sellerSnapshot.contactEmail ?? null, phone: invoice.sellerSnapshot.contactPhone ?? null }, customer: financialPilotParty(invoice.customer), sourceEstimate: { id: invoice.sourceEstimateId, revision: invoice.sourceEstimateRevision },
    subtotalMinor: invoice.subtotal.minorUnits, discountMinor: invoice.discount.minorUnits, taxMinor: invoice.tax.minorUnits, lines, notes: invoice.notes,
    payments: financialPilotPage(view, 'invoice_payments', payments, query.paymentCursor, invoice.id), credits: financialPilotPage(view, 'invoice_credits', creditRows(view, invoice.id), query.creditCursor, invoice.id) }, view.organizationId, view.revision);
}
