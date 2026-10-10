import { validDate } from './accounting/ledger';
import { validateAddress } from './addresses';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { money, multiplyMoney } from './money';
import type { CompanyAddress, CompanyLanguage } from './types';

/** This browser protocol is independent of the private book and of ERP1–4. */
export const US_FINANCIAL_PILOT_PAGE_SIZE = 25;
export type UsFinancialPilotListKind = 'invoices' | 'customers' | 'vendors' | 'estimates' | 'journals' | 'periods';
export type UsFinancialPilotPageKind = UsFinancialPilotListKind | 'invoice_payments' | 'invoice_credits' | 'general_ledger';
export type UsFinancialPilotStatus = 'open' | 'partially_settled' | 'paid' | 'credited' | 'settled_with_credit';
export class UsFinancialPilotError extends Error {
  constructor(readonly code: 'invalid_financial_pilot_data' | 'invalid_financial_pilot_query' | 'financial_snapshot_changed' | 'financial_pilot_record_not_found' | 'financial_pilot_too_large' | 'financial_pilot_cash_flow_unavailable', readonly status: number) { super(code); this.name = 'UsFinancialPilotError'; }
}
export interface UsFinancialPilotHead { readonly schemaVersion: 1; readonly consumer: 'financial-pilot'; readonly organizationId: string; readonly revision: number }
export interface UsFinancialPilotPage<T = UsFinancialPilotRow> extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly kind: UsFinancialPilotPageKind; readonly scope: string | null;
  readonly total: number; readonly items: readonly T[]; readonly nextCursor: string | null;
}
export interface UsFinancialPilotParty {
  readonly id: string; readonly name: string; readonly kind: 'individual' | 'business'; readonly billingAddress: CompanyAddress;
  readonly shippingAddress: CompanyAddress | null; readonly email: string | null; readonly phone: string | null;
  readonly contactName: string | null; readonly paymentTermsDays: number;
}
export interface UsFinancialPilotInvoiceRow {
  readonly id: string; readonly number: string; readonly customerId: string; readonly customerName: string;
  readonly date: string; readonly accountingDate: string; readonly dueDate: string; readonly issuedAt: string; readonly issuedBy: string;
  readonly totalMinor: string; readonly receivedMinor: string; readonly creditedMinor: string; readonly outstandingMinor: string; readonly status: UsFinancialPilotStatus;
}
export interface UsFinancialPilotEstimateRow { readonly id: string; readonly number: string; readonly revision: number; readonly customerId: string; readonly customerName: string; readonly date: string; readonly expiresAt: string; readonly status: 'draft' | 'accepted' | 'declined'; readonly netMinor: string }
export interface UsFinancialPilotPaymentRow { readonly id: string; readonly invoiceId: string; readonly amountMinor: string; readonly paymentDate: string; readonly accountingDate: string; readonly reference: string; readonly recordedBy: string }
export interface UsFinancialPilotCreditRow { readonly id: string; readonly number: string; readonly invoiceId: string; readonly transactionDate: string; readonly accountingDate: string; readonly periodId: string; readonly reason: string; readonly netMinor: string; readonly taxMinor: string; readonly totalMinor: string; readonly taxDisposition: 'historical_zero_tax' | 'adjustment_pending'; readonly issuedBy: string; readonly issuedAt: string; readonly recordedRevision: number }
export interface UsFinancialPilotSource { readonly kind: 'customer_invoice' | 'customer_payment' | 'customer_credit' | 'vendor_bill' | 'vendor_payment' | 'manual_journal' | 'manual_reversal' | 'other'; readonly entityId: string | null; readonly reference: string | null; readonly journalRevision: number | null }
export interface UsFinancialPilotJournalRow { readonly journalRevision: number; readonly transactionDate: string; readonly accountingDate: string; readonly paymentDate: string | null; readonly periodId: string; readonly description: string; readonly debitMinor: string; readonly creditMinor: string; readonly postedBy: string; readonly postedAt: string; readonly source: UsFinancialPilotSource; readonly reversesJournalRevision: number | null; readonly reversedByJournalRevision: number | null }
export interface UsFinancialPilotPeriodRow { readonly id: string; readonly start: string; readonly end: string; readonly status: 'open' | 'closed' }
export interface UsFinancialPilotMovement { readonly journalRevision: number; readonly transactionDate: string; readonly accountingDate: string; readonly paymentDate: string | null; readonly debitMinor: string; readonly creditMinor: string; readonly balanceMinor: string; readonly source: UsFinancialPilotSource }
export type UsFinancialPilotRow = UsFinancialPilotInvoiceRow | UsFinancialPilotParty | UsFinancialPilotEstimateRow | UsFinancialPilotJournalRow | UsFinancialPilotPeriodRow | UsFinancialPilotPaymentRow | UsFinancialPilotCreditRow | UsFinancialPilotMovement;
export interface UsFinancialPilotLine { readonly id: string; readonly description: string; readonly quantityUnits: string; readonly quantityScale: number; readonly unitPriceMinor: string; readonly discountBasisPoints: number; readonly netMinor: string; readonly taxMinor: string }
export interface UsFinancialPilotInvoiceDetail extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly invoice: UsFinancialPilotInvoiceRow;
  readonly seller: Readonly<{ name: string; address: CompanyAddress; email: string | null; phone: string | null }>;
  readonly customer: UsFinancialPilotParty; readonly sourceEstimate: Readonly<{ id: string; revision: number }>;
  readonly subtotalMinor: string; readonly discountMinor: string; readonly taxMinor: string;
  readonly lines: readonly UsFinancialPilotLine[]; readonly notes: string;
  readonly payments: UsFinancialPilotPage<UsFinancialPilotPaymentRow>; readonly credits: UsFinancialPilotPage<UsFinancialPilotCreditRow>;
}
export interface UsFinancialPilotSummary { readonly invoiceCount: number; readonly totalMinor: string; readonly receivedMinor: string; readonly creditedMinor: string; readonly outstandingMinor: string }
export interface UsFinancialPilotOverview extends UsFinancialPilotHead {
  readonly ledgerRevision: number;
  readonly company: Readonly<{ country: 'US'; currency: 'USD'; accountingBasis: 'accrual'; language: CompanyLanguage; timeZone: string }>;
  readonly summary: UsFinancialPilotSummary;
  readonly invoices: UsFinancialPilotPage<UsFinancialPilotInvoiceRow>; readonly customers: UsFinancialPilotPage<UsFinancialPilotParty>;
  readonly vendors: UsFinancialPilotPage<UsFinancialPilotParty>; readonly estimates: UsFinancialPilotPage<UsFinancialPilotEstimateRow>;
  readonly journals: UsFinancialPilotPage<UsFinancialPilotJournalRow>; readonly periods: UsFinancialPilotPage<UsFinancialPilotPeriodRow>;
}
export interface UsFinancialPilotAccount { readonly accountId: string; readonly code: string; readonly name: string; readonly type: 'asset' | 'liability' | 'equity' | 'income' | 'expense' }
export interface UsFinancialPilotReports extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly currency: 'USD'; readonly basis: 'accrual'; readonly from: string; readonly to: string; readonly asOf: string;
  readonly trialBalance: Readonly<{ rows: readonly (UsFinancialPilotAccount & Readonly<{ debitMinor: string; creditMinor: string }>)[]; totalDebitMinor: string; totalCreditMinor: string; balanced: boolean }>;
  readonly profitAndLoss: Readonly<{ rows: readonly Readonly<{ accountId: string; name: string; type: 'income' | 'expense'; amountMinor: string }>[]; incomeMinor: string; expenseMinor: string; profitMinor: string }>;
  readonly balanceSheet: Readonly<{ rows: readonly Readonly<{ accountId: string; name: string; type: 'asset' | 'liability' | 'equity'; amountMinor: string }>[]; assetsMinor: string; liabilitiesMinor: string; equityMinor: string; unclosedEarningsMinor: string; balanced: boolean }>;
  readonly cashFlow: Readonly<{ status: 'available'; method: 'direct'; openingMinor: string; operatingMinor: string; investingMinor: string; financingMinor: string; netChangeMinor: string; closingMinor: string }> | Readonly<{ status: 'unavailable'; reason: 'classification_required' }>;
  readonly currentReceivables: Readonly<{ scope: 'current'; summary: UsFinancialPilotSummary; invoices: UsFinancialPilotPage<UsFinancialPilotInvoiceRow> }>;
  readonly generalLedger: Readonly<{ account: UsFinancialPilotAccount; openingMinor: string; closingMinor: string; pageOpeningMinor: string; pageClosingMinor: string; movements: UsFinancialPilotPage<UsFinancialPilotMovement> }> | null;
}
export interface UsFinancialPilotListQuery { readonly revision: number; readonly kind: UsFinancialPilotListKind; readonly cursor?: string | null }
export interface UsFinancialPilotInvoiceQuery { readonly revision: number; readonly invoiceId: string; readonly paymentCursor?: string | null; readonly creditCursor?: string | null }
export interface UsFinancialPilotReportQuery { readonly revision: number; readonly from: string; readonly to: string; readonly asOf: string; readonly accountId?: string | null; readonly cursor?: string | null }

type Decoder<T> = (input: unknown) => T;
type Decoded<F extends Record<string, Decoder<unknown>>> = { readonly [K in keyof F]: ReturnType<F[K]> };
const invalid = (): never => { throw new UsFinancialPilotError('invalid_financial_pilot_data', 503); };
const object = <F extends Record<string, Decoder<unknown>>>(input: unknown, fields: F): Decoded<F> => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== Object.keys(fields).length || Object.keys(fields).some(key => !Object.hasOwn(input, key))) return invalid();
  const raw = input as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) result[key] = fields[key](raw[key]);
  return Object.freeze(result) as Decoded<F>;
};
const text = (maximum = 4000, empty = false): Decoder<string> => input => {
  if (typeof input !== 'string' || input.length > maximum || (!empty && !input.trim()) || Array.from(input).some(character => { const code = character.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code)); })) return invalid();
  return input;
};
const key: Decoder<string> = input => { const value = text(256)(input); if (Array.from(value).some(character => character.charCodeAt(0) < 32)) return invalid(); return value; };
const note = text(20_000, true);
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): Decoder<number> => input => typeof input === 'number' && Number.isSafeInteger(input) && input >= minimum && input <= maximum ? input : invalid();
const literal = <T extends string | number>(expected: T): Decoder<T> => input => input === expected ? expected : invalid();
const enumeration = <T extends string>(values: readonly T[]): Decoder<T> => input => typeof input === 'string' && values.includes(input as T) ? input as T : invalid();
const nullable = <T>(decode: Decoder<T>): Decoder<T | null> => input => input === null ? null : decode(input);
const array = <T>(decode: Decoder<T>, maximum = 1000): Decoder<readonly T[]> => input => Array.isArray(input) && input.length <= maximum ? Object.freeze(input.map(decode)) : invalid();
const unsigned: Decoder<string> = input => typeof input === 'string' && /^(0|[1-9][0-9]{0,95})$/.test(input) ? input : invalid();
const signed: Decoder<string> = input => typeof input === 'string' && /^(0|-?[1-9][0-9]{0,95})$/.test(input) ? input : invalid();
const date: Decoder<string> = input => typeof input === 'string' && !input.startsWith('0000-') && validDate(input) ? input : invalid();
const timestamp: Decoder<string> = input => { const value = text(40)(input); parseInstant(value); return value; };
const timeZone: Decoder<string> = input => { const value = text(100)(input); new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return value; };
const bool: Decoder<boolean> = input => typeof input === 'boolean' ? input : invalid();
const address: Decoder<CompanyAddress> = input => { const country = (input as { country?: unknown })?.country; if (country !== 'US' && country !== 'CH') return invalid(); return validateAddress(input, country); };
const status = enumeration<UsFinancialPilotStatus>(['open', 'partially_settled', 'paid', 'credited', 'settled_with_credit']);
const kinds: readonly UsFinancialPilotPageKind[] = ['invoices', 'customers', 'vendors', 'estimates', 'journals', 'periods', 'invoice_payments', 'invoice_credits', 'general_ledger'];
const headFields = { schemaVersion: literal(1), consumer: literal('financial-pilot'), organizationId: key, revision: integer(1) };
const scope = (value: UsFinancialPilotHead, organizationId?: string, revision?: number) => {
  if (organizationId !== undefined && value.organizationId !== organizationId) return invalid();
  if (revision !== undefined && value.revision !== revision) throw new UsFinancialPilotError('financial_snapshot_changed', 409);
};
const totals = (value: { totalMinor: string; receivedMinor: string; creditedMinor: string; outstandingMinor: string }) => {
  if (BigInt(value.totalMinor) !== BigInt(value.receivedMinor) + BigInt(value.creditedMinor) + BigInt(value.outstandingMinor)) return invalid();
};
const summary: Decoder<UsFinancialPilotSummary> = input => { const v = object(input, { invoiceCount: integer(), totalMinor: unsigned, receivedMinor: unsigned, creditedMinor: unsigned, outstandingMinor: unsigned }); totals(v); return v; };
const party: Decoder<UsFinancialPilotParty> = input => object(input, { id: key, name: text(), kind: enumeration(['individual', 'business'] as const), billingAddress: address, shippingAddress: nullable(address), email: nullable(text(320)), phone: nullable(text(100)), contactName: nullable(text(256)), paymentTermsDays: integer(0, 365) });
const invoice: Decoder<UsFinancialPilotInvoiceRow> = input => {
  const v = object(input, { id: key, number: key, customerId: key, customerName: text(), date, accountingDate: date, dueDate: date, issuedAt: timestamp, issuedBy: key, totalMinor: unsigned, receivedMinor: unsigned, creditedMinor: unsigned, outstandingMinor: unsigned, status }); totals(v);
  const received = BigInt(v.receivedMinor), credited = BigInt(v.creditedMinor), outstanding = BigInt(v.outstandingMinor);
  const expected = outstanding === BigInt(0) ? credited === BigInt(0) ? 'paid' : received === BigInt(0) ? 'credited' : 'settled_with_credit' : received + credited === BigInt(0) ? 'open' : 'partially_settled';
  if (v.status !== expected) return invalid(); return v;
};
const estimate: Decoder<UsFinancialPilotEstimateRow> = input => object(input, { id: key, number: key, revision: integer(1), customerId: key, customerName: text(), date, expiresAt: date, status: enumeration(['draft', 'accepted', 'declined'] as const), netMinor: unsigned });
const payment: Decoder<UsFinancialPilotPaymentRow> = input => { const v = object(input, { id: key, invoiceId: key, amountMinor: unsigned, paymentDate: date, accountingDate: date, reference: text(500), recordedBy: key }); if (v.amountMinor === '0') return invalid(); return v; };
const credit: Decoder<UsFinancialPilotCreditRow> = input => { const v = object(input, { id: key, number: key, invoiceId: key, transactionDate: date, accountingDate: date, periodId: key, reason: text(2000), netMinor: unsigned, taxMinor: unsigned, totalMinor: unsigned, taxDisposition: enumeration(['historical_zero_tax', 'adjustment_pending'] as const), issuedBy: key, issuedAt: timestamp, recordedRevision: integer(1) }); if (BigInt(v.netMinor) + BigInt(v.taxMinor) !== BigInt(v.totalMinor) || v.totalMinor === '0' || (v.taxDisposition === 'historical_zero_tax' && v.taxMinor !== '0')) return invalid(); return v; };
const source: Decoder<UsFinancialPilotSource> = input => object(input, { kind: enumeration(['customer_invoice', 'customer_payment', 'customer_credit', 'vendor_bill', 'vendor_payment', 'manual_journal', 'manual_reversal', 'other'] as const), entityId: nullable(key), reference: nullable(text(4000)), journalRevision: nullable(integer(1)) });
const journal: Decoder<UsFinancialPilotJournalRow> = input => { const v = object(input, { journalRevision: integer(1), transactionDate: date, accountingDate: date, paymentDate: nullable(date), periodId: key, description: text(), debitMinor: unsigned, creditMinor: unsigned, postedBy: key, postedAt: timestamp, source, reversesJournalRevision: nullable(integer(1)), reversedByJournalRevision: nullable(integer(1)) }); if (v.debitMinor !== v.creditMinor) return invalid(); return v; };
const period: Decoder<UsFinancialPilotPeriodRow> = input => { const v = object(input, { id: key, start: date, end: date, status: enumeration(['open', 'closed'] as const) }); if (v.start > v.end) return invalid(); return v; };
const movement: Decoder<UsFinancialPilotMovement> = input => { const v = object(input, { journalRevision: integer(1), transactionDate: date, accountingDate: date, paymentDate: nullable(date), debitMinor: unsigned, creditMinor: unsigned, balanceMinor: signed, source }); if (BigInt(v.debitMinor) > BigInt(0) && BigInt(v.creditMinor) > BigInt(0)) return invalid(); return v; };
const rowDecoders: Readonly<Record<UsFinancialPilotPageKind, Decoder<UsFinancialPilotRow>>> = { invoices: invoice, customers: party, vendors: party, estimates: estimate, journals: journal, periods: period, invoice_payments: payment, invoice_credits: credit, general_ledger: movement };

/** Public, bounded opaque-to-the-UI cursor. It contains no private identity/hash. */
export function financialPilotCursor(kind: UsFinancialPilotPageKind, revision: number, offset: number, rowScope: string | null): string { return JSON.stringify([kind, revision, offset, rowScope]); }
export function financialPilotCursorOffset(input: unknown, kind: UsFinancialPilotPageKind, revision: number, rowScope: string | null): number {
  if (input === null || input === undefined) return 0;
  try {
    if (typeof input !== 'string' || input.length > 512) throw Error();
    const value = JSON.parse(input) as unknown;
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== kind || value[1] !== revision || value[3] !== rowScope || !Number.isSafeInteger(value[2]) || value[2] < 25 || value[2] > 1_000_000 || value[2] % 25 !== 0 || JSON.stringify(value) !== input) throw Error();
    return value[2] as number;
  } catch { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); }
}
function page(input: unknown): UsFinancialPilotPage {
  const raw = input as { kind?: unknown }, kind = enumeration(kinds)(raw?.kind);
  const v = object(input, { ...headFields, ledgerRevision: integer(), kind: literal(kind), scope: nullable(key), total: integer(0, 1_000_000), items: array(rowDecoders[kind], 25), nextCursor: nullable(text(512)) });
  if (v.ledgerRevision > v.revision || v.items.length > v.total || ((kind === 'invoice_payments' || kind === 'invoice_credits' || kind === 'general_ledger') !== (v.scope !== null))) return invalid();
  if (kind !== 'general_ledger' && new Set(v.items.map(row => 'id' in row ? row.id : (row as UsFinancialPilotJournalRow).journalRevision)).size !== v.items.length) return invalid();
  if (v.nextCursor !== null) { const offset = financialPilotCursorOffset(v.nextCursor, kind, v.revision, v.scope); if (offset >= v.total || v.items.length !== 25) return invalid(); }
  if ((kind === 'invoice_payments' || kind === 'invoice_credits') && v.items.some(row => (row as UsFinancialPilotPaymentRow | UsFinancialPilotCreditRow).invoiceId !== v.scope)) return invalid();
  return v;
}
function checked<T>(input: unknown, decode: Decoder<T>): T { try { return decode(snapshotPrivateJson(input)); } catch (error) { if (error instanceof UsFinancialPilotError) throw error; return invalid(); } }
export function validateUsFinancialPilotHead(input: unknown, organizationId?: string): UsFinancialPilotHead { const v = checked(input, value => object(value, headFields)); scope(v, organizationId); return v; }
export function validateUsFinancialPilotPage(input: unknown, organizationId?: string, revision?: number): UsFinancialPilotPage { const v = checked(input, page); scope(v, organizationId, revision); return v; }
export function validateUsFinancialPilotOverview(input: unknown, organizationId?: string, revision?: number): UsFinancialPilotOverview {
  const v = checked(input, value => object(value, { ...headFields, ledgerRevision: integer(), company: raw => object(raw, { country: literal('US'), currency: literal('USD'), accountingBasis: literal('accrual'), language: enumeration(['fr', 'de', 'it', 'en'] as const), timeZone }), summary,
    invoices: page, customers: page, vendors: page, estimates: page, journals: page, periods: page }));
  scope(v, organizationId, revision);
  for (const kind of ['invoices', 'customers', 'vendors', 'estimates', 'journals', 'periods'] as const) { const p = v[kind]; if (p.kind !== kind || p.organizationId !== v.organizationId || p.revision !== v.revision || p.ledgerRevision !== v.ledgerRevision) return invalid(); }
  if (v.summary.invoiceCount !== v.invoices.total || v.ledgerRevision > v.revision) return invalid();
  return v as UsFinancialPilotOverview;
}
export function validateUsFinancialPilotInvoiceDetail(input: unknown, organizationId?: string, revision?: number): UsFinancialPilotInvoiceDetail {
  const line: Decoder<UsFinancialPilotLine> = raw => {
    const v = object(raw, { id: key, description: text(), quantityUnits: unsigned, quantityScale: integer(0, 6), unitPriceMinor: unsigned, discountBasisPoints: integer(0, 10000), netMinor: unsigned, taxMinor: unsigned });
    const gross = multiplyMoney(money('USD', v.unitPriceMinor), v.quantityUnits, (BigInt(10) ** BigInt(v.quantityScale)).toString()), discount = multiplyMoney(gross, String(v.discountBasisPoints), '10000');
    if (BigInt(gross.minorUnits) - BigInt(discount.minorUnits) !== BigInt(v.netMinor)) return invalid(); return v;
  };
  const v = checked(input, value => object(value, { ...headFields, ledgerRevision: integer(), invoice, seller: raw => object(raw, { name: text(), address, email: nullable(text(320)), phone: nullable(text(100)) }), customer: party, sourceEstimate: raw => object(raw, { id: key, revision: integer(1) }), subtotalMinor: unsigned, discountMinor: unsigned, taxMinor: unsigned, lines: array(line), notes: note, payments: page, credits: page }));
  scope(v, organizationId, revision);
  const sum = (field: 'netMinor' | 'taxMinor') => v.lines.reduce((n, row) => n + BigInt(row[field]), BigInt(0));
  const gross = v.lines.reduce((n, row) => n + BigInt(multiplyMoney(money('USD', row.unitPriceMinor), row.quantityUnits, (BigInt(10) ** BigInt(row.quantityScale)).toString()).minorUnits), BigInt(0));
  if (!v.lines.length || new Set(v.lines.map(row => row.id)).size !== v.lines.length || v.lines.some(row => row.quantityUnits === '0') || v.invoice.customerId !== v.customer.id || v.invoice.customerName !== v.customer.name || gross !== BigInt(v.subtotalMinor) || sum('netMinor') !== BigInt(v.subtotalMinor) - BigInt(v.discountMinor) || sum('taxMinor') !== BigInt(v.taxMinor) || sum('netMinor') + sum('taxMinor') !== BigInt(v.invoice.totalMinor) || v.seller.address.country !== 'US' || v.ledgerRevision > v.revision) return invalid();
  for (const [p, kind] of [[v.payments, 'invoice_payments'], [v.credits, 'invoice_credits']] as const) if (p.kind !== kind || p.scope !== v.invoice.id || p.organizationId !== v.organizationId || p.revision !== v.revision || p.ledgerRevision !== v.ledgerRevision) return invalid();
  if (v.payments.items.length === v.payments.total && v.payments.items.reduce((n, row) => n + BigInt((row as UsFinancialPilotPaymentRow).amountMinor), BigInt(0)).toString() !== v.invoice.receivedMinor) return invalid();
  if (v.credits.items.length === v.credits.total && v.credits.items.reduce((n, row) => n + BigInt((row as UsFinancialPilotCreditRow).totalMinor), BigInt(0)).toString() !== v.invoice.creditedMinor) return invalid();
  return v as UsFinancialPilotInvoiceDetail;
}

const accountFields = { accountId: key, code: key, name: text(), type: enumeration(['asset', 'liability', 'equity', 'income', 'expense'] as const) };
export function validateUsFinancialPilotReports(input: unknown, organizationId?: string, revision?: number): UsFinancialPilotReports {
  const cash: Decoder<UsFinancialPilotReports['cashFlow']> = raw => (raw as { status?: unknown })?.status === 'unavailable' ? object(raw, { status: literal('unavailable'), reason: literal('classification_required') }) : object(raw, { status: literal('available'), method: literal('direct'), openingMinor: signed, operatingMinor: signed, investingMinor: signed, financingMinor: signed, netChangeMinor: signed, closingMinor: signed });
  const v = checked(input, value => object(value, { ...headFields, ledgerRevision: integer(), currency: literal('USD'), basis: literal('accrual'), from: date, to: date, asOf: date,
    trialBalance: raw => object(raw, { rows: array(row => object(row, { ...accountFields, debitMinor: unsigned, creditMinor: unsigned })), totalDebitMinor: unsigned, totalCreditMinor: unsigned, balanced: bool }),
    profitAndLoss: raw => object(raw, { rows: array(row => object(row, { accountId: key, name: text(), type: enumeration(['income', 'expense'] as const), amountMinor: signed })), incomeMinor: signed, expenseMinor: signed, profitMinor: signed }),
    balanceSheet: raw => object(raw, { rows: array(row => object(row, { accountId: key, name: text(), type: enumeration(['asset', 'liability', 'equity'] as const), amountMinor: signed })), assetsMinor: signed, liabilitiesMinor: signed, equityMinor: signed, unclosedEarningsMinor: signed, balanced: bool }), cashFlow: cash,
    currentReceivables: raw => object(raw, { scope: literal('current'), summary, invoices: page }),
    generalLedger: nullable(raw => object(raw, { account: row => object(row, accountFields), openingMinor: signed, closingMinor: signed, pageOpeningMinor: signed, pageClosingMinor: signed, movements: page })) }));
  scope(v, organizationId, revision); if (v.from > v.to || v.ledgerRevision > v.revision) return invalid();
  const tb = v.trialBalance, pl = v.profitAndLoss, bs = v.balanceSheet;
  if ([tb.rows, pl.rows, bs.rows].some(rows => new Set(rows.map(row => row.accountId)).size !== rows.length)) return invalid();
  if (tb.rows.reduce((n, row) => n + BigInt(row.debitMinor), BigInt(0)).toString() !== tb.totalDebitMinor || tb.rows.reduce((n, row) => n + BigInt(row.creditMinor), BigInt(0)).toString() !== tb.totalCreditMinor || !tb.balanced || tb.totalDebitMinor !== tb.totalCreditMinor || tb.rows.some(row => BigInt(row.debitMinor) !== BigInt(0) && BigInt(row.creditMinor) !== BigInt(0))) return invalid();
  const byType = (rows: readonly { type: string; amountMinor: string }[], type: string) => rows.filter(row => row.type === type).reduce((n, row) => n + BigInt(row.amountMinor), BigInt(0));
  if (byType(pl.rows, 'income').toString() !== pl.incomeMinor || byType(pl.rows, 'expense').toString() !== pl.expenseMinor || BigInt(pl.incomeMinor) - BigInt(pl.expenseMinor) !== BigInt(pl.profitMinor) || byType(bs.rows, 'asset').toString() !== bs.assetsMinor || byType(bs.rows, 'liability').toString() !== bs.liabilitiesMinor || byType(bs.rows, 'equity').toString() !== bs.equityMinor || !bs.balanced || BigInt(bs.assetsMinor) !== BigInt(bs.liabilitiesMinor) + BigInt(bs.equityMinor) + BigInt(bs.unclosedEarningsMinor)) return invalid();
  if (v.cashFlow.status === 'available' && (BigInt(v.cashFlow.operatingMinor) + BigInt(v.cashFlow.investingMinor) + BigInt(v.cashFlow.financingMinor) !== BigInt(v.cashFlow.netChangeMinor) || BigInt(v.cashFlow.openingMinor) + BigInt(v.cashFlow.netChangeMinor) !== BigInt(v.cashFlow.closingMinor))) return invalid();
  const pages = [v.currentReceivables.invoices, ...(v.generalLedger ? [v.generalLedger.movements] : [])];
  if (pages.some(p => p.organizationId !== v.organizationId || p.revision !== v.revision || p.ledgerRevision !== v.ledgerRevision) || v.currentReceivables.invoices.kind !== 'invoices' || v.currentReceivables.summary.invoiceCount !== v.currentReceivables.invoices.total) return invalid();
  if (v.generalLedger) {
    const gl = v.generalLedger; if (gl.movements.kind !== 'general_ledger' || gl.movements.scope !== `${gl.account.accountId}|${v.from}|${v.to}`) return invalid();
    let balance = BigInt(gl.pageOpeningMinor); for (const raw of gl.movements.items) { const row = raw as UsFinancialPilotMovement; balance += BigInt(row.debitMinor) - BigInt(row.creditMinor); if (balance.toString() !== row.balanceMinor) return invalid(); }
    if (balance.toString() !== gl.pageClosingMinor) return invalid();
  }
  return v as UsFinancialPilotReports;
}

/** Parse only browser-owned selectors; actors, grants and financial facts are absent. */
export function validateUsFinancialPilotListQuery(input: unknown): UsFinancialPilotListQuery {
  try { const raw = snapshotPrivateJson(input) as Record<string, unknown>; const keys = Object.keys(raw); if (keys.some(k => !['revision', 'kind', 'cursor'].includes(k)) || !Object.hasOwn(raw, 'revision') || !Object.hasOwn(raw, 'kind')) throw Error(); const kind = enumeration<UsFinancialPilotListKind>(['invoices', 'customers', 'vendors', 'estimates', 'journals', 'periods'])(raw.kind); const revision = integer(1)(raw.revision); const cursor = raw.cursor === undefined ? null : nullable(text(512))(raw.cursor); financialPilotCursorOffset(cursor, kind, revision, null); return Object.freeze({ revision, kind, cursor }); } catch { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); }
}
