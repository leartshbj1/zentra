import { validDate } from './accounting/ledger';
import { snapshotPrivateJson } from './private-json';
import type { CompanyAddress, CompanyLanguage } from './types';
import { validateAddress } from './addresses';
import { money, multiplyMoney } from './money';

export const US_FINANCIAL_PILOT_EXPORT_MAX_ROWS = 1_000;
export const US_FINANCIAL_PILOT_EXPORT_MAX_TEXT_CHARACTERS = 500_000;
export const US_FINANCIAL_PILOT_EXPORT_MAX_PDF_PAGES = 200;
export const US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
export const US_FINANCIAL_PILOT_ESTIMATE_EXPORT_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const US_FINANCIAL_PILOT_EXPORT_HEADERS = {
  scope: 'X-Zentra-Financial-Pilot', organization: 'X-Zentra-Organization-Id', revision: 'X-Zentra-Financial-Revision',
  ledgerRevision: 'X-Zentra-Ledger-Revision', currency: 'X-Zentra-Currency', language: 'X-Zentra-Export-Language',
  format: 'X-Zentra-Export-Format', selectorHash: 'X-Zentra-Export-Selector-SHA256', contentHash: 'X-Zentra-Content-SHA256',
  estimateRevision: 'X-Zentra-Estimate-Revision', countryRevision: 'X-Zentra-Country-Revision',
  sellerRevision: 'X-Zentra-Seller-Revision', issuerBasis: 'X-Zentra-Issuer-Basis',
} as const;
export type UsFinancialPilotExportFormat = 'pdf' | 'csv';
export type UsFinancialPilotExportReportType = 'trial_balance' | 'profit_loss' | 'balance_sheet' | 'cash_flow' | 'general_ledger' | 'receivables';
type Selection = Readonly<{ revision: number; language: CompanyLanguage; format: UsFinancialPilotExportFormat }>;
export type UsFinancialPilotEstimateExportSelector = Selection & Readonly<{ kind: 'estimate'; estimateId: string; estimateRevision: number; format: 'pdf' }>;
export type UsFinancialPilotExportSelector =
  | UsFinancialPilotEstimateExportSelector
  | (Selection & Readonly<{ kind: 'invoice'; invoiceId: string; format: 'pdf' }>)
  | (Selection & Readonly<{ kind: 'report'; reportType: 'trial_balance' | 'balance_sheet'; asOf: string }>)
  | (Selection & Readonly<{ kind: 'report'; reportType: 'profit_loss' | 'cash_flow'; from: string; to: string }>)
  | (Selection & Readonly<{ kind: 'report'; reportType: 'general_ledger'; from: string; to: string; accountId: string }>)
  | (Selection & Readonly<{ kind: 'report'; reportType: 'receivables' }>);
export type UsFinancialPilotExportSectionKind = UsFinancialPilotExportReportType | 'invoice_lines' | 'estimate_lines' | 'payments' | 'credits';
export type UsFinancialPilotExportLabel =
  | 'organization' | 'customer' | 'number' | 'date' | 'dueDate' | 'transactionDate' | 'accountingDate' | 'paymentDate'
  | 'from' | 'to' | 'asOf' | 'period' | 'account' | 'accountType' | 'description' | 'quantity' | 'unitPrice'
  | 'net' | 'subtotal' | 'discount' | 'tax' | 'total' | 'received' | 'credited' | 'outstanding' | 'amount' | 'balance'
  | 'debit' | 'credit' | 'opening' | 'closing' | 'income' | 'expense' | 'profit' | 'assets' | 'liabilities' | 'equity'
  | 'unclosedEarnings' | 'operating' | 'investing' | 'financing' | 'netChange' | 'currency' | 'accountingBasis'
  | 'financialRevision' | 'ledgerRevision' | 'sourceEstimateRevision' | 'sourceReference' | 'reference' | 'reason'
  | 'taxDisposition' | 'recordedBy' | 'journalRevision' | 'status'
  | 'estimateDate' | 'expiresAt' | 'paymentTermsDays' | 'estimateRevision' | 'countryRevision' | 'sellerRevision' | 'lineDiscount';
export type UsFinancialPilotExportParty = Readonly<{ name: string | null; address: CompanyAddress; email: string | null; phone: string | null }>;
export type UsFinancialPilotExportColumn = Readonly<{ label: UsFinancialPilotExportLabel; kind: 'text' | 'money' | 'date'; align: 'left' | 'right' }>;
export type UsFinancialPilotExportFact = Readonly<{ label: UsFinancialPilotExportLabel; kind: 'text' | 'date'; value: string }>;
export type UsFinancialPilotExportTotal = Readonly<{ label: UsFinancialPilotExportLabel; minorUnits: string }>;
export type UsFinancialPilotExportSection = Readonly<{
  kind: UsFinancialPilotExportSectionKind; columns: readonly UsFinancialPilotExportColumn[];
  rows: readonly (readonly string[])[]; totals: readonly UsFinancialPilotExportTotal[];
}>;
type UsFinancialPilotExportSnapshotFields = Readonly<{
  consumer: 'financial-pilot'; schemaVersion: 1; organizationId: string; revision: number; ledgerRevision: number;
  currency: 'USD'; paper: 'Letter'; language: CompanyLanguage; selector: UsFinancialPilotExportSelector;
  number: string | null; issuer: UsFinancialPilotExportParty; recipient: UsFinancialPilotExportParty | null;
  facts: readonly UsFinancialPilotExportFact[]; sections: readonly UsFinancialPilotExportSection[]; notes: string;
}>;
export type UsFinancialPilotEstimateExportMeta = Readonly<{
  estimateId: string; estimateRevision: number; status: 'draft' | 'accepted' | 'declined';
  countryRevision: number; sellerRevision: number; issuerBasis: 'current_at_export'; amountBasis: 'before_sales_tax';
}>;
export type UsFinancialPilotEstimateExportSnapshot = UsFinancialPilotExportSnapshotFields & Readonly<{
  selector: UsFinancialPilotEstimateExportSelector; estimate: UsFinancialPilotEstimateExportMeta;
}>;
export type UsFinancialPilotExportSnapshot =
  | (UsFinancialPilotExportSnapshotFields & Readonly<{ selector: Exclude<UsFinancialPilotExportSelector, UsFinancialPilotEstimateExportSelector>; estimate?: never }>)
  | UsFinancialPilotEstimateExportSnapshot;
export type UsFinancialPilotExportErrorCode =
  | 'invalid_financial_pilot_export_selector' | 'invalid_financial_pilot_export_snapshot' | 'financial_snapshot_changed'
  | 'financial_pilot_export_source_not_found' | 'financial_pilot_export_too_large' | 'financial_pilot_export_unavailable'
  | 'financial_pilot_export_cash_flow_unavailable' | 'invalid_financial_pilot_export_font' | 'unsupported_financial_pilot_export_glyph'
  | 'financial_pilot_seller_required' | 'financial_pilot_quote_identity_changed';
export class UsFinancialPilotExportError extends Error {
  constructor(readonly code: UsFinancialPilotExportErrorCode, readonly status: number) { super(code); this.name = 'UsFinancialPilotExportError'; }
}
const fail = (): never => { throw new UsFinancialPilotExportError('invalid_financial_pilot_export_snapshot', 503); };
const tooLarge = (): never => { throw new UsFinancialPilotExportError('financial_pilot_export_too_large', 413); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return fail();
  return result;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || Array.from(value).some(character => { const code = character.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code)); })) return fail();
  return value;
}
function revision(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value >= Number.MAX_SAFE_INTEGER) return fail();
  return value;
}
function date(value: unknown): string { const result = text(value, 10); if (result.startsWith('0000-') || !validDate(result)) return fail(); return result; }
function minor(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(?:0|-[1-9]\d{0,95}|[1-9]\d{0,95})$/u.test(value) || (positive && BigInt(value) < BigInt(0))) return fail();
  return value;
}
function array(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value)) return fail(); if (value.length > maximum) return tooLarge(); return value; }
function language(value: unknown): CompanyLanguage { if (!['fr', 'de', 'it', 'en'].includes(value as string)) return fail(); return value as CompanyLanguage; }
function estimateId(value: unknown): string {
  const result = text(value, 160);
  if (result !== result.trim() || Array.from(result).some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; })) return fail();
  return result;
}
/** Pure public selector. No actor, grant, provider, book fingerprint or tax proof. */
export function validateUsFinancialPilotExportSelector(input: unknown): UsFinancialPilotExportSelector {
  try {
    const raw = snapshotPrivateJson(input) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
    const common = ['revision', 'language', 'format', 'kind'];
    revision(raw.revision); language(raw.language);
    if (raw.format !== 'pdf' && raw.format !== 'csv') return fail();
    if (raw.kind === 'invoice') { object(raw, [...common, 'invoiceId']); text(raw.invoiceId, 256); if (raw.format !== 'pdf') return fail(); }
    else if (raw.kind === 'estimate') { object(raw, [...common, 'estimateId', 'estimateRevision']); estimateId(raw.estimateId); revision(raw.estimateRevision); if (raw.format !== 'pdf') return fail(); }
    else if (raw.kind === 'report') {
      if (raw.reportType === 'trial_balance' || raw.reportType === 'balance_sheet') { object(raw, [...common, 'reportType', 'asOf']); date(raw.asOf); }
      else if (raw.reportType === 'profit_loss' || raw.reportType === 'cash_flow' || raw.reportType === 'general_ledger') {
        object(raw, [...common, 'reportType', 'from', 'to', ...(raw.reportType === 'general_ledger' ? ['accountId'] : [])]);
        if (date(raw.from) > date(raw.to)) return fail(); if (raw.reportType === 'general_ledger') text(raw.accountId, 160);
      } else if (raw.reportType === 'receivables') object(raw, [...common, 'reportType']);
      else return fail();
    } else return fail();
    return raw as unknown as UsFinancialPilotExportSelector;
  } catch { throw new UsFinancialPilotExportError('invalid_financial_pilot_export_selector', 422); }
}
const column = (label: UsFinancialPilotExportLabel, kind: UsFinancialPilotExportColumn['kind'] = 'text'): UsFinancialPilotExportColumn => ({ label, kind, align: kind === 'money' ? 'right' : 'left' });
export const US_FINANCIAL_PILOT_EXPORT_COLUMNS: Readonly<Record<UsFinancialPilotExportSectionKind, readonly UsFinancialPilotExportColumn[]>> = {
  invoice_lines: [column('description'), column('quantity'), column('unitPrice', 'money'), column('net', 'money'), column('tax', 'money'), column('total', 'money')],
  estimate_lines: [column('description'), column('quantity'), column('unitPrice', 'money'), column('lineDiscount'), column('net', 'money')],
  payments: [column('reference'), column('paymentDate', 'date'), column('accountingDate', 'date'), column('amount', 'money')],
  credits: [column('number'), column('transactionDate', 'date'), column('accountingDate', 'date'), column('reason'), column('taxDisposition'), column('net', 'money'), column('tax', 'money'), column('total', 'money')],
  trial_balance: [column('account'), column('description'), column('accountType'), column('debit', 'money'), column('credit', 'money')],
  profit_loss: [column('account'), column('accountType'), column('amount', 'money')],
  balance_sheet: [column('account'), column('accountType'), column('amount', 'money')],
  cash_flow: [],
  general_ledger: [column('journalRevision'), column('transactionDate', 'date'), column('accountingDate', 'date'), column('paymentDate', 'date'), column('sourceReference'), column('debit', 'money'), column('credit', 'money'), column('balance', 'money')],
  receivables: [column('number'), column('customer'), column('date', 'date'), column('dueDate', 'date'), column('total', 'money'), column('received', 'money'), column('credited', 'money'), column('outstanding', 'money'), column('status')],
};
export const US_FINANCIAL_PILOT_EXPORT_TOTALS: Readonly<Record<UsFinancialPilotExportSectionKind, readonly UsFinancialPilotExportLabel[]>> = {
  estimate_lines: ['subtotal', 'discount', 'net'],
  invoice_lines: ['subtotal', 'discount', 'net', 'tax', 'total', 'received', 'credited', 'outstanding'], payments: ['received'], credits: ['credited'],
  trial_balance: ['debit', 'credit'], profit_loss: ['income', 'expense', 'profit'], balance_sheet: ['assets', 'liabilities', 'equity', 'unclosedEarnings'],
  cash_flow: ['opening', 'operating', 'investing', 'financing', 'netChange', 'closing'], general_ledger: ['opening', 'closing'], receivables: ['total', 'received', 'credited', 'outstanding'],
};

for (const columns of Object.values(US_FINANCIAL_PILOT_EXPORT_COLUMNS)) { for (const item of columns) Object.freeze(item); Object.freeze(columns); }
Object.freeze(US_FINANCIAL_PILOT_EXPORT_COLUMNS);
for (const totals of Object.values(US_FINANCIAL_PILOT_EXPORT_TOTALS)) Object.freeze(totals);
Object.freeze(US_FINANCIAL_PILOT_EXPORT_TOTALS);
Object.freeze(US_FINANCIAL_PILOT_EXPORT_HEADERS);

/** Public snapshots have their own bounded capture: a 1001-row document is a
 * budget rejection (413), never a silently truncated page or a getter call. */
function captureSnapshot(input: unknown): unknown {
  let nodes = 0, characters = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 50_000 || depth > 14) return tooLarge();
    if (typeof value === 'string') {
      characters += value.length; if (characters > US_FINANCIAL_PILOT_EXPORT_MAX_TEXT_CHARACTERS) return tooLarge();
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i); if (c === 0) return fail();
        if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) return fail(); }
        else if (c >= 0xdc00 && c <= 0xdfff) return fail();
      }
      return value;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (!value || typeof value !== 'object') return fail();
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0) return fail();
      if (length.value > US_FINANCIAL_PILOT_EXPORT_MAX_ROWS) return tooLarge();
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== length.value + 1) return fail();
      const result = [];
      for (let index = 0; index < length.value; index++) { const d = Object.getOwnPropertyDescriptor(value, String(index)); if (!d || !('value' in d) || !d.enumerable) return fail(); result.push(visit(d.value, depth + 1)); }
      return Object.freeze(result);
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) { if (typeof key !== 'string') return fail(); const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d) || !d.enumerable) return fail(); result[key] = visit(d.value, depth + 1); }
    return Object.freeze(result);
  };
  return visit(input, 0);
}
function party(value: unknown, nameRequired: boolean, usOnly: boolean): void {
  const raw = object(value, ['name', 'address', 'email', 'phone']);
  if (raw.name === null) { if (nameRequired) return fail(); } else text(raw.name, 400);
  if (raw.email !== null) text(raw.email, 320); if (raw.phone !== null) text(raw.phone, 80);
  const address = raw.address as CompanyAddress;
  if (!address || (address.country !== 'US' && address.country !== 'CH') || (usOnly && address.country !== 'US')) return fail();
  validateAddress(address, address.country);
}
function factLabels(selector: UsFinancialPilotExportSelector): readonly UsFinancialPilotExportLabel[] {
  const common: UsFinancialPilotExportLabel[] = ['organization', 'currency', 'accountingBasis', 'financialRevision', 'ledgerRevision'];
  if (selector.kind === 'invoice') return [...common, 'date', 'accountingDate', 'dueDate', 'sourceEstimateRevision'];
  if (selector.kind === 'estimate') return [...common, 'estimateDate', 'expiresAt', 'paymentTermsDays', 'estimateRevision', 'status', 'countryRevision', 'sellerRevision'];
  if ('asOf' in selector) return [...common, 'asOf'];
  if ('from' in selector) return [...common, 'from', 'to', ...(selector.reportType === 'general_ledger' ? ['account' as const] : [])];
  return common;
}
const dateLabels: readonly UsFinancialPilotExportLabel[] = ['date', 'accountingDate', 'dueDate', 'from', 'to', 'asOf', 'estimateDate', 'expiresAt'];
/** The source rounds gross and then its discount half away from zero. Keep
 * this same exact two-stage operation; quantities never pass through Number. */
function estimateRowAmounts(row: readonly string[]): Readonly<{ gross: bigint; discount: bigint; net: bigint }> {
  if (!/^(?:0|[1-9]\d{0,95})(?:\.\d{1,6})?$/u.test(row[1]) || !/^(?:0|[1-9]\d{0,3}|10000)$/u.test(row[3])) return fail();
  const [whole, fraction = ''] = row[1].split('.'), units = BigInt(whole + fraction);
  if (units <= BigInt(0)) return fail();
  const gross = multiplyMoney(money('USD', row[2]), units.toString(), (BigInt(10) ** BigInt(fraction.length)).toString());
  const discount = multiplyMoney(gross, row[3], '10000');
  return { gross: BigInt(gross.minorUnits), discount: BigInt(discount.minorUnits), net: BigInt(gross.minorUnits) - BigInt(discount.minorUnits) };
}
function validateSection(value: unknown, kind: UsFinancialPilotExportSectionKind): UsFinancialPilotExportSection {
  const raw = object(value, ['kind', 'columns', 'rows', 'totals']); if (raw.kind !== kind) return fail();
  const expectedColumns = US_FINANCIAL_PILOT_EXPORT_COLUMNS[kind], columns = array(raw.columns, 12);
  if (columns.length !== expectedColumns.length) return fail();
  columns.forEach((item, index) => { const col = object(item, ['label', 'kind', 'align']), expected = expectedColumns[index]; if (col.label !== expected.label || col.kind !== expected.kind || col.align !== expected.align) return fail(); });
  const rows = array(raw.rows, US_FINANCIAL_PILOT_EXPORT_MAX_ROWS);
  if (kind === 'cash_flow' && rows.length !== 0) return fail();
  rows.forEach(row => {
    const cells = array(row, expectedColumns.length); if (cells.length !== expectedColumns.length) return fail();
    cells.forEach((cell, index) => { const column = expectedColumns[index];
      if (column.kind === 'money') minor(cell, !['profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger'].includes(kind));
      else if (column.kind === 'date') { if (!(kind === 'general_ledger' && column.label === 'paymentDate' && cell === '')) date(cell); }
      else text(cell, 20_000, column.label === 'reference' || column.label === 'sourceReference');
    });
    const typed = cells as readonly string[];
    if (kind === 'estimate_lines' && estimateRowAmounts(typed).net !== BigInt(typed[4])) return fail();
    if (kind === 'invoice_lines' && (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(typed[1]) || BigInt(typed[3]) + BigInt(typed[4]) !== BigInt(typed[5]))) return fail();
    if (kind === 'credits' && (!['historical_zero_tax', 'adjustment_pending'].includes(typed[4]) || BigInt(typed[5]) + BigInt(typed[6]) !== BigInt(typed[7]) || BigInt(typed[7]) <= BigInt(0) || (typed[4] === 'historical_zero_tax' && typed[6] !== '0'))) return fail();
    if (kind === 'payments' && BigInt(typed[3]) <= BigInt(0)) return fail();
    if (kind === 'trial_balance' && (!['asset', 'liability', 'equity', 'income', 'expense'].includes(typed[2]) || (typed[3] !== '0' && typed[4] !== '0'))) return fail();
    if (kind === 'profit_loss' && !['income', 'expense'].includes(typed[1])) return fail();
    if (kind === 'balance_sheet' && !['asset', 'liability', 'equity'].includes(typed[1])) return fail();
    if (kind === 'general_ledger' && (!/^[1-9]\d{0,15}$/u.test(typed[0]) || !Number.isSafeInteger(Number(typed[0])) || BigInt(typed[5]) < BigInt(0) || BigInt(typed[6]) < BigInt(0))) return fail();
    if (kind === 'receivables') {
      const [total, received, credited, outstanding] = typed.slice(4, 8).map(BigInt);
      if (total !== received + credited + outstanding || !['open', 'partially_settled', 'paid', 'credited', 'settled_with_credit'].includes(typed[8])) return fail();
      const status = outstanding > BigInt(0) ? received + credited === BigInt(0) ? 'open' : 'partially_settled' : credited === BigInt(0) ? 'paid' : received === BigInt(0) ? 'credited' : 'settled_with_credit';
      if (typed[8] !== status) return fail();
    }
  });
  const totals = array(raw.totals, 12), labels = US_FINANCIAL_PILOT_EXPORT_TOTALS[kind];
  if (totals.length !== labels.length) return fail();
  totals.forEach((item, index) => { const total = object(item, ['label', 'minorUnits']); if (total.label !== labels[index]) return fail(); minor(total.minorUnits, !['profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger'].includes(kind)); });
  const section = raw as unknown as UsFinancialPilotExportSection;
  const amount = (label: UsFinancialPilotExportLabel) => BigInt(section.totals.find(item => item.label === label)?.minorUnits ?? fail());
  const sum = (index: number, type?: string) => section.rows.filter(row => !type || row[1] === type).reduce((n, row) => n + BigInt(row[index]), BigInt(0));
  if (kind === 'estimate_lines') {
    const computed = section.rows.map(estimateRowAmounts);
    const exact = (key: 'gross' | 'discount' | 'net') => computed.reduce((total, row) => total + row[key], BigInt(0));
    if (exact('gross') !== amount('subtotal') || exact('discount') !== amount('discount') || exact('net') !== amount('net') || amount('subtotal') - amount('discount') !== amount('net')) return fail();
  }
  if (kind === 'invoice_lines' && (amount('subtotal') - amount('discount') !== amount('net') || sum(3) !== amount('net') || sum(4) !== amount('tax') || sum(5) !== amount('total') || amount('net') + amount('tax') !== amount('total') || amount('total') !== amount('received') + amount('credited') + amount('outstanding'))) return fail();
  if (kind === 'payments' && sum(3) !== amount('received')) return fail();
  if (kind === 'credits' && sum(7) !== amount('credited')) return fail();
  if (kind === 'trial_balance' && (sum(3) !== amount('debit') || sum(4) !== amount('credit') || amount('debit') !== amount('credit'))) return fail();
  if (kind === 'profit_loss' && (sum(2, 'income') !== amount('income') || sum(2, 'expense') !== amount('expense') || amount('income') - amount('expense') !== amount('profit'))) return fail();
  if (kind === 'balance_sheet' && (sum(2, 'asset') !== amount('assets') || sum(2, 'liability') !== amount('liabilities') || sum(2, 'equity') !== amount('equity') || amount('assets') !== amount('liabilities') + amount('equity') + amount('unclosedEarnings'))) return fail();
  if (kind === 'cash_flow' && (amount('operating') + amount('investing') + amount('financing') !== amount('netChange') || amount('opening') + amount('netChange') !== amount('closing'))) return fail();
  if (kind === 'receivables' && (sum(4) !== amount('total') || sum(5) !== amount('received') || sum(6) !== amount('credited') || sum(7) !== amount('outstanding') || amount('total') !== amount('received') + amount('credited') + amount('outstanding'))) return fail();
  if (kind === 'general_ledger') {
    let running = amount('opening'), priorDate = '', priorRevision = 0;
    for (const row of section.rows) { const journalRevision = Number(row[0]); if (row[2] < priorDate || (row[2] === priorDate && journalRevision < priorRevision)) return fail(); priorDate = row[2]; priorRevision = journalRevision; running += BigInt(row[5]) - BigInt(row[6]); if (running !== BigInt(row[7])) return fail(); }
    if (running !== amount('closing')) return fail();
  }
  return section;
}
/** Whitelist and arithmetic validation for presentation only, not financial or
 * membership authority. The sole source is still the replayed private book. */
export function validateUsFinancialPilotExportSnapshot(input: unknown, organizationId?: string, expectedSelector?: UsFinancialPilotExportSelector): UsFinancialPilotExportSnapshot {
  try {
    const captured = captureSnapshot(input);
    if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return fail();
    const selector = validateUsFinancialPilotExportSelector((captured as Record<string, unknown>).selector);
    if (selector.kind === 'estimate' && new TextEncoder().encode(JSON.stringify(captured)).byteLength > US_FINANCIAL_PILOT_ESTIMATE_EXPORT_MAX_SNAPSHOT_BYTES) return tooLarge();
    const raw = object(captured, ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'currency', 'paper', 'language', 'selector', 'number', 'issuer', 'recipient', 'facts', 'sections', 'notes', ...(selector.kind === 'estimate' ? ['estimate'] : [])]);
    if (raw.consumer !== 'financial-pilot' || raw.schemaVersion !== 1 || raw.currency !== 'USD' || raw.paper !== 'Letter') return fail();
    text(raw.organizationId, 256); if (organizationId !== undefined && raw.organizationId !== organizationId) return fail();
    const currentRevision = revision(raw.revision), ledgerRevision = revision(raw.ledgerRevision, true);
    if (ledgerRevision > currentRevision || selector.revision !== currentRevision || language(raw.language) !== selector.language) return fail();
    if (expectedSelector && JSON.stringify(selector) !== JSON.stringify(validateUsFinancialPilotExportSelector(expectedSelector))) {
      const expected = validateUsFinancialPilotExportSelector(expectedSelector);
      if (Object.keys(selector).length !== Object.keys(expected).length || Object.keys(selector).some(key => Reflect.get(selector, key) !== Reflect.get(expected, key))) return fail();
    }
    if (selector.kind === 'invoice' || selector.kind === 'estimate') { text(raw.number, 160); party(raw.issuer, true, true); party(raw.recipient, true, false); }
    else { if (raw.number !== null || raw.recipient !== null || (raw.issuer as UsFinancialPilotExportParty)?.name !== null) return fail(); party(raw.issuer, false, true); if ((raw.issuer as UsFinancialPilotExportParty).email !== null || (raw.issuer as UsFinancialPilotExportParty).phone !== null) return fail(); }
    const labels = factLabels(selector), facts = array(raw.facts, 16); if (facts.length !== labels.length) return fail();
    facts.forEach((item, index) => { const fact = object(item, ['label', 'kind', 'value']), label = labels[index]; if (fact.label !== label || fact.kind !== (dateLabels.includes(label) ? 'date' : 'text')) return fail(); if (fact.kind === 'date') date(fact.value); else text(fact.value, 400); });
    const getFact = (label: UsFinancialPilotExportLabel) => (facts as readonly UsFinancialPilotExportFact[]).find(fact => fact.label === label)?.value;
    if (getFact('organization') !== raw.organizationId || getFact('currency') !== 'USD' || getFact('accountingBasis') !== 'accrual' || getFact('financialRevision') !== String(currentRevision) || getFact('ledgerRevision') !== String(ledgerRevision)) return fail();
    if ('asOf' in selector && getFact('asOf') !== selector.asOf) return fail();
    if ('from' in selector && (getFact('from') !== selector.from || getFact('to') !== selector.to)) return fail();
    if (selector.kind === 'invoice' && (!/^[1-9]\d{0,15}$/u.test(getFact('sourceEstimateRevision') ?? '') || !Number.isSafeInteger(Number(getFact('sourceEstimateRevision'))))) return fail();
    if (selector.kind === 'estimate') {
      const meta = object(raw.estimate, ['estimateId', 'estimateRevision', 'status', 'countryRevision', 'sellerRevision', 'issuerBasis', 'amountBasis']);
      if (estimateId(meta.estimateId) !== selector.estimateId || revision(meta.estimateRevision) !== selector.estimateRevision || !['draft', 'accepted', 'declined'].includes(meta.status as string) || meta.issuerBasis !== 'current_at_export' || meta.amountBasis !== 'before_sales_tax') return fail();
      const countryRevision = revision(meta.countryRevision), sellerRevision = revision(meta.sellerRevision);
      if (getFact('estimateRevision') !== String(selector.estimateRevision) || getFact('countryRevision') !== String(countryRevision) || getFact('sellerRevision') !== String(sellerRevision) || getFact('status') !== meta.status) return fail();
      const terms = getFact('paymentTermsDays') ?? '';
      if (!/^(?:0|[1-9]\d{0,2})$/u.test(terms) || BigInt(terms) > BigInt(365) || date(getFact('expiresAt')) < date(getFact('estimateDate'))) return fail();
    }
    const kinds: readonly UsFinancialPilotExportSectionKind[] = selector.kind === 'invoice' ? ['invoice_lines', 'payments', 'credits'] : selector.kind === 'estimate' ? ['estimate_lines'] : [selector.reportType];
    const rawSections = array(raw.sections, 3); if (rawSections.length !== kinds.length) return fail();
    const sections = rawSections.map((section, index) => validateSection(section, kinds[index]));
    if (sections.reduce((count, section) => count + section.rows.length, 0) > US_FINANCIAL_PILOT_EXPORT_MAX_ROWS) return tooLarge();
    if (selector.kind === 'invoice') {
      if (!sections[0].rows.length || sections[0].totals.find(item => item.label === 'received')?.minorUnits !== sections[1].totals[0].minorUnits || sections[0].totals.find(item => item.label === 'credited')?.minorUnits !== sections[2].totals[0].minorUnits) return fail();
    }
    if (selector.kind === 'estimate' && !sections[0].rows.length) return fail();
    if (selector.kind === 'report' && selector.reportType === 'general_ledger') for (const row of sections[0].rows) if (Number(row[0]) > ledgerRevision || row[2] < selector.from || row[2] > selector.to) return fail();
    text(raw.notes, 20_000, true);
    return raw as unknown as UsFinancialPilotExportSnapshot;
  } catch (error) { if (error instanceof UsFinancialPilotExportError && error.code === 'financial_pilot_export_too_large') throw error; return fail(); }
}
