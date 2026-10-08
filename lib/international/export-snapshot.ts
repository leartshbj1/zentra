import { snapshotPrivateJson } from './private-json';
import { validateStoredErp } from './runtime-validation';
import { buildPrintableDocument, type PrintedParty } from './documents';
import { estimateTotals, invoiceBalance, validatePublicSellerSnapshot, type PublicSellerSnapshot } from './invoicing';
import { validateAddress } from './addresses';
import { trialBalance, profitAndLoss, balanceSheet, cashFlow, generalLedger } from './accounting/reports';
import { validDate } from './accounting/ledger';
import { vendorBillBalance } from './purchasing';
import { formatDateOnly } from './localization';
import { exportCopy, type ExportLabelKey } from './export-copy';
import type { CompanyLanguage } from './types';
import { formatMoney } from './money';

export const MAX_EXPORT_ROWS = 1000;
export const MAX_EXPORT_TEXT_CHARACTERS = 500_000;
export const MAX_EXPORT_PDF_PAGES = 200;
export type ExportSelector =
  | Readonly<{ kind: 'document'; documentType: 'estimate' | 'invoice' | 'vendor_bill' | 'project'; id: string }>
  | Readonly<{ kind: 'report'; reportType: 'trial_balance' | 'balance_sheet'; asOf: string }>
  | Readonly<{ kind: 'report'; reportType: 'profit_loss' | 'cash_flow'; start: string; end: string }>
  | Readonly<{ kind: 'report'; reportType: 'general_ledger'; accountId: string; start: string; end: string }>;
export type ExportErrorCode = 'invalid_export_selector' | 'export_source_not_found' | 'seller_configuration_required' | 'export_unavailable' | 'invalid_export_snapshot' | 'export_too_large' | 'unsupported_export_glyph' | 'invalid_export_font';
const statuses: Record<ExportErrorCode, number> = { invalid_export_selector: 422, export_source_not_found: 404, seller_configuration_required: 409, export_unavailable: 409, invalid_export_snapshot: 503, export_too_large: 413, unsupported_export_glyph: 422, invalid_export_font: 503 };
export class ExportError extends Error {
  readonly status: number;
  constructor(readonly code: ExportErrorCode) { super(code); this.name = 'ExportError'; this.status = statuses[code]; }
}
export interface ExportSnapshot {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly currency: 'USD';
  readonly paper: 'Letter';
  readonly language: CompanyLanguage;
  readonly erpRevision: number;
  readonly ledgerRevision: number;
  /** Invoice issuance has no own revision field: never invent one. */
  readonly recordRevision: number | null;
  readonly selector: ExportSelector;
  readonly seller: PrintedParty;
  readonly recipient: PrintedParty | null;
  readonly number: string | null;
  readonly facts: readonly Readonly<{ label: ExportLabelKey; value: string }>[];
  readonly columns: readonly Readonly<{ label: ExportLabelKey; kind: 'text' | 'money'; align: 'left' | 'right' }>[];
  /** Money cells are canonical signed minor-unit strings, never floating point. */
  readonly rows: readonly (readonly string[])[];
  readonly totals: readonly Readonly<{ label: ExportLabelKey; minorUnits: string }>[];
  readonly notes: string;
}
const fail = (code: ExportErrorCode): never => { throw new ExportError(code); };
const object = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return fail('invalid_export_snapshot');
  return input as Record<string, unknown>;
};
const text = (input: unknown, maximum = 4000, empty = false): string => {
  if (typeof input !== 'string' || input.length > maximum || (!empty && !input.trim()) || Array.from(input).some(char => { const code = char.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code)); })) return fail('invalid_export_snapshot');
  return input;
};
const key = (input: unknown): string => { const value = text(input, 160); if (Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail('invalid_export_snapshot'); return value; };
const organization = (input: unknown): string => { const value = text(input, 128); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return fail('invalid_export_snapshot'); return value; };
const revision = (input: unknown, zero = false): number => { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < (zero ? 0 : 1)) return fail('invalid_export_snapshot'); return input; };
const minor = (input: unknown): string => { if (typeof input !== 'string' || !/^(?:0|-?[1-9][0-9]{0,51})$/.test(input)) return fail('invalid_export_snapshot'); return input; };
const label = (input: unknown): ExportLabelKey => { if (typeof input !== 'string' || !Object.hasOwn(exportCopy.en, input)) return fail('invalid_export_snapshot'); return input as ExportLabelKey; };
function civil(input: unknown): string { if (typeof input !== 'string' || input.startsWith('0000-') || !validDate(input)) return fail('invalid_export_selector'); return input; }
export function validateUsExportSelector(input: unknown): ExportSelector {
  try {
    const value = snapshotPrivateJson(input) as Record<string, unknown>;
    if (value.kind === 'document') {
      object(value, ['kind', 'documentType', 'id']);
      if (!['estimate', 'invoice', 'vendor_bill', 'project'].includes(String(value.documentType))) return fail('invalid_export_selector');
      return Object.freeze({ kind: 'document', documentType: value.documentType as 'estimate' | 'invoice' | 'vendor_bill' | 'project', id: key(value.id) });
    }
    if (value.kind !== 'report') return fail('invalid_export_selector');
    if (value.reportType === 'trial_balance' || value.reportType === 'balance_sheet') {
      object(value, ['kind', 'reportType', 'asOf']); return Object.freeze({ kind: 'report', reportType: value.reportType, asOf: civil(value.asOf) });
    }
    if (!['profit_loss', 'cash_flow', 'general_ledger'].includes(String(value.reportType))) return fail('invalid_export_selector');
    object(value, value.reportType === 'general_ledger' ? ['kind', 'reportType', 'accountId', 'start', 'end'] : ['kind', 'reportType', 'start', 'end']);
    const start = civil(value.start), end = civil(value.end); if (start > end) return fail('invalid_export_selector');
    return value.reportType === 'general_ledger' ? Object.freeze({ kind: 'report', reportType: 'general_ledger', accountId: key(value.accountId), start, end }) : Object.freeze({ kind: 'report', reportType: value.reportType as 'profit_loss' | 'cash_flow', start, end });
  } catch { return fail('invalid_export_selector'); }
}
function party(input: unknown): PrintedParty {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_export_snapshot');
  const value = input as Record<string, unknown>, keys = Object.keys(value);
  if (!keys.includes('name') || !keys.includes('address') || keys.some(k => !['name', 'address', 'contactEmail', 'contactPhone'].includes(k))) return fail('invalid_export_snapshot');
  const name = text(value.name, 256), raw = value.address as { country?: unknown };
  if (raw?.country !== 'CH' && raw?.country !== 'US') return fail('invalid_export_snapshot');
  const address = validateAddress(value.address, raw.country);
  return { name, address, ...(Object.hasOwn(value, 'contactEmail') ? { contactEmail: text(value.contactEmail, 254) } : {}), ...(Object.hasOwn(value, 'contactPhone') ? { contactPhone: text(value.contactPhone, 80) } : {}) };
}
/** Renderers revalidate this exact public DTO, including recomputable table totals. */
export function validateUsExportSnapshot(input: unknown): ExportSnapshot {
  try {
    const value = object(snapshotPrivateJson(input), ['schemaVersion', 'organizationId', 'currency', 'paper', 'language', 'erpRevision', 'ledgerRevision', 'recordRevision', 'selector', 'seller', 'recipient', 'number', 'facts', 'columns', 'rows', 'totals', 'notes']);
    if (value.schemaVersion !== 1 || value.currency !== 'USD' || value.paper !== 'Letter' || !['fr', 'de', 'it', 'en'].includes(String(value.language))) return fail('invalid_export_snapshot');
    const organizationId = organization(value.organizationId), erpRevision = revision(value.erpRevision), ledgerRevision = revision(value.ledgerRevision, true), recordRevision = value.recordRevision === null ? null : revision(value.recordRevision);
    if (ledgerRevision > erpRevision || (recordRevision !== null && recordRevision > erpRevision)) return fail('invalid_export_snapshot');
    const selector = validateUsExportSelector(value.selector), seller = party(value.seller), recipient = value.recipient === null ? null : party(value.recipient), number = value.number === null ? null : text(value.number, 500);
    if ((selector.kind === 'report' && (recipient !== null || number !== null || recordRevision !== null)) || (selector.kind === 'document' && (!recipient || !number))) return fail('invalid_export_snapshot');
    if (seller.address.country !== 'US' || (selector.kind === 'document' && (selector.documentType === 'invoice' ? recordRevision !== null : recordRevision === null))) return fail('invalid_export_snapshot');
    if (!Array.isArray(value.facts) || value.facts.length > 32 || !Array.isArray(value.columns) || !value.columns.length || value.columns.length > 8 || !Array.isArray(value.rows) || value.rows.length > MAX_EXPORT_ROWS || !Array.isArray(value.totals) || value.totals.length > 16) return fail('invalid_export_snapshot');
    const facts = value.facts.map(raw => { const f = object(raw, ['label', 'value']); return { label: label(f.label), value: text(f.value, 2000, true) }; });
    const columns = value.columns.map(raw => { const c = object(raw, ['label', 'kind', 'align']); if (!['text', 'money'].includes(String(c.kind)) || !['left', 'right'].includes(String(c.align))) return fail('invalid_export_snapshot'); return { label: label(c.label), kind: c.kind as 'text' | 'money', align: c.align as 'left' | 'right' }; });
    if (new Set(columns.map(c => c.label)).size !== columns.length) return fail('invalid_export_snapshot');
    const rows = value.rows.map(raw => { if (!Array.isArray(raw) || raw.length !== columns.length) return fail('invalid_export_snapshot'); return raw.map((cell, index) => columns[index].kind === 'money' ? minor(cell) : text(cell, 4000, true)); });
    const totals = value.totals.map(raw => { const t = object(raw, ['label', 'minorUnits']); return { label: label(t.label), minorUnits: minor(t.minorUnits) }; });
    if (new Set(totals.map(t => t.label)).size !== totals.length) return fail('invalid_export_snapshot');
    const expectedColumns: readonly ExportLabelKey[] = selector.kind === 'document' ? selector.documentType === 'project' ? ['sourceType', 'number', 'date', 'net', 'tax', 'total', 'balance'] : selector.documentType === 'vendor_bill' ? ['description', 'net', 'tax', 'total'] : ['description', 'quantity', 'unitPrice', 'net'] : selector.reportType === 'trial_balance' ? ['account', 'description', 'accountType', 'debit', 'credit'] : selector.reportType === 'profit_loss' || selector.reportType === 'balance_sheet' ? ['account', 'accountType', 'amount'] : selector.reportType === 'cash_flow' ? ['description', 'amount'] : ['accountingDate', 'transactionDate', 'paymentDate', 'sourceReference', 'debit', 'credit', 'balance'];
    const moneyLabels: readonly ExportLabelKey[] = ['unitPrice', 'net', 'tax', 'total', 'debit', 'credit', 'amount', 'balance'];
    if (columns.length !== expectedColumns.length || columns.some((col, i) => col.label !== expectedColumns[i] || col.kind !== (moneyLabels.includes(col.label) ? 'money' : 'text') || col.align !== (moneyLabels.includes(col.label) ? 'right' : 'left'))) return fail('invalid_export_snapshot');
    const expectedTotals: readonly ExportLabelKey[] = selector.kind === 'document' ? selector.documentType === 'project' ? ['estimatesNet', 'invoicedNet', 'invoicedTax', 'invoicedTotal', 'received', 'outstanding', 'purchasesNet', 'purchasesTax', 'purchasesTotal', 'purchasesBalance'] : selector.documentType === 'vendor_bill' ? ['net', 'tax', 'total', 'balance'] : selector.documentType === 'invoice' ? ['subtotal', 'discount', 'tax', 'total', 'balance'] : ['subtotal', 'discount', 'total'] : selector.reportType === 'trial_balance' ? ['debit', 'credit'] : selector.reportType === 'profit_loss' ? ['income', 'expense', 'profit'] : selector.reportType === 'balance_sheet' ? ['assets', 'liabilities', 'equity', 'unclosedEarnings'] : selector.reportType === 'cash_flow' ? ['opening', 'operating', 'investing', 'financing', 'netChange', 'closing'] : ['opening', 'closing'];
    if (totals.length !== expectedTotals.length || totals.some((t, i) => t.label !== expectedTotals[i]) || new Set(facts.map(f => f.label)).size !== facts.length) return fail('invalid_export_snapshot');
    const specificFacts: readonly ExportLabelKey[] = selector.kind === 'document' ? selector.documentType === 'project' ? ['projectName', 'projectStatus', 'budgetNet', 'startDate', 'targetDate'] : selector.documentType === 'vendor_bill' ? ['date', 'accountingDate', 'dueDate', 'period', 'sourceReference'] : selector.documentType === 'invoice' ? ['date', 'dueDate', 'termsDays', 'accountingDate', 'sourceEstimateRevision'] : ['date', 'expiresAt', 'termsDays'] : 'asOf' in selector ? ['asOf'] : selector.reportType === 'general_ledger' ? ['from', 'to', 'account'] : ['from', 'to'];
    const requiredFacts = ['currency', 'accountingBasis', ...specificFacts.filter(k => !['expiresAt', 'startDate', 'targetDate'].includes(k))] as const;
    if (facts.some(f => !['currency', 'accountingBasis', ...specificFacts].includes(f.label) || !f.value.trim()) || requiredFacts.some(k => !facts.some(f => f.label === k)) || facts.find(f => f.label === 'currency')?.value !== 'USD' || ![exportCopy[value.language as CompanyLanguage].cash, exportCopy[value.language as CompanyLanguage].accrual].includes(facts.find(f => f.label === 'accountingBasis')!.value)) return fail('invalid_export_snapshot');
    const typeIndex = columns.findIndex(col => col.label === 'accountType');
    if (typeIndex >= 0 && rows.some(row => !['asset', 'liability', 'equity', 'income', 'expense'].includes(row[typeIndex]))) return fail('invalid_export_snapshot');
    if (rows.some(row => columns.some((col, i) => ['unitPrice', 'net', 'tax', 'total', 'debit', 'credit'].includes(col.label) && BigInt(row[i]) < BigInt(0)))) return fail('invalid_export_snapshot');
    const debitIndex = columns.findIndex(col => col.label === 'debit'), creditIndex = columns.findIndex(col => col.label === 'credit');
    if (debitIndex >= 0 && rows.some(row => BigInt(row[debitIndex]) > BigInt(0) && BigInt(row[creditIndex]) > BigInt(0))) return fail('invalid_export_snapshot');
    if (selector.kind === 'document' && ((selector.documentType !== 'project' && !rows.length) || rows.some(row => !row[0].trim()))) return fail('invalid_export_snapshot');
    if (selector.kind === 'document' && (selector.documentType === 'estimate' || selector.documentType === 'invoice') && rows.some(row => !/^(?:[1-9][0-9]*|0)(?:\.[0-9]*[1-9])?$/.test(row[1]) || !/[1-9]/.test(row[1]))) return fail('invalid_export_snapshot');
    const notes = text(value.notes, 20_000, true);
    const sum = (column: ExportLabelKey) => { const index = columns.findIndex(c => c.label === column && c.kind === 'money'); if (index < 0) return fail('invalid_export_snapshot'); return rows.reduce((total, row) => total + BigInt(row[index]), BigInt(0)); };
    const total = (name: ExportLabelKey) => { const found = totals.find(t => t.label === name); if (!found) return fail('invalid_export_snapshot'); return BigInt(found.minorUnits); };
    if (selector.kind === 'document') {
      if (selector.documentType === 'project') {
        const copy = exportCopy[value.language as CompanyLanguage], byType = (type: string, index: number) => rows.filter(row => row[0] === type).reduce((sum, row) => sum + BigInt(row[index]), BigInt(0));
        if (recordRevision === null || ![copy.active, copy.archived].includes(facts.find(f => f.label === 'projectStatus')!.value) || rows.some(row => ![copy.estimate, copy.invoice, copy.vendor_bill].includes(row[0]) || !row[1].trim() || !row[2].trim() || BigInt(row[3]) + BigInt(row[4]) !== BigInt(row[5]) || BigInt(row[6]) < BigInt(0) || BigInt(row[6]) > BigInt(row[5]) || (row[0] === copy.estimate && (row[4] !== '0' || row[6] !== '0')))) return fail('invalid_export_snapshot');
        if (byType(copy.estimate, 3) !== total('estimatesNet') || byType(copy.invoice, 3) !== total('invoicedNet') || byType(copy.invoice, 4) !== total('invoicedTax') || byType(copy.invoice, 5) !== total('invoicedTotal') || byType(copy.invoice, 6) !== total('outstanding') || total('invoicedTotal') - total('outstanding') !== total('received') || byType(copy.vendor_bill, 3) !== total('purchasesNet') || byType(copy.vendor_bill, 4) !== total('purchasesTax') || byType(copy.vendor_bill, 5) !== total('purchasesTotal') || byType(copy.vendor_bill, 6) !== total('purchasesBalance')) return fail('invalid_export_snapshot');
      }
      else if (selector.documentType === 'vendor_bill') { if (rows.length !== 1 || sum('net') !== total('net') || sum('tax') !== total('tax') || sum('total') !== total('total') || total('net') + total('tax') !== total('total')) return fail('invalid_export_snapshot'); }
      else if (sum('net') !== total('subtotal') - total('discount') || total('subtotal') - total('discount') + (selector.documentType === 'invoice' ? total('tax') : BigInt(0)) !== total('total')) return fail('invalid_export_snapshot');
      if ((selector.documentType === 'invoice' || selector.documentType === 'vendor_bill') && (total('balance') < BigInt(0) || total('balance') > total('total'))) return fail('invalid_export_snapshot');
      if (totals.some(t => BigInt(t.minorUnits) < BigInt(0))) return fail('invalid_export_snapshot');
    } else if (selector.reportType === 'trial_balance') { if (sum('debit') !== total('debit') || sum('credit') !== total('credit') || total('debit') !== total('credit')) return fail('invalid_export_snapshot'); }
    else if (selector.reportType === 'profit_loss' || selector.reportType === 'balance_sheet') {
      const typeIndex = columns.findIndex(col => col.label === 'accountType' && col.kind === 'text'), amountIndex = columns.findIndex(col => col.label === 'amount' && col.kind === 'money');
      if (typeIndex < 0 || amountIndex < 0) return fail('invalid_export_snapshot');
      const allowed = selector.reportType === 'profit_loss' ? ['income', 'expense'] : ['asset', 'liability', 'equity'];
      if (rows.some(row => !allowed.includes(row[typeIndex]))) return fail('invalid_export_snapshot');
      const byType = (type: string) => rows.filter(row => row[typeIndex] === type).reduce((sum, row) => sum + BigInt(row[amountIndex]), BigInt(0));
      if (selector.reportType === 'profit_loss') { if (byType('income') !== total('income') || byType('expense') !== total('expense') || total('income') - total('expense') !== total('profit')) return fail('invalid_export_snapshot'); }
      else if (byType('asset') !== total('assets') || byType('liability') !== total('liabilities') || byType('equity') !== total('equity') || total('assets') !== total('liabilities') + total('equity') + total('unclosedEarnings')) return fail('invalid_export_snapshot');
    }
    else if (selector.reportType === 'cash_flow') {
      const cashLabels = ['opening', 'operating', 'investing', 'financing', 'netChange', 'closing'] as const;
      if (rows.length !== cashLabels.length || rows.some((row, i) => row[0] !== exportCopy[value.language as CompanyLanguage][cashLabels[i]] || BigInt(row[1]) !== total(cashLabels[i])) || total('operating') + total('investing') + total('financing') !== total('netChange') || total('opening') + total('netChange') !== total('closing')) return fail('invalid_export_snapshot');
    } else {
      let running = total('opening');
      for (const row of rows) { running += BigInt(row[4]) - BigInt(row[5]); if (running !== BigInt(row[6])) return fail('invalid_export_snapshot'); }
      if (running !== total('closing')) return fail('invalid_export_snapshot');
    }
    const detached = { schemaVersion: 1 as const, organizationId, currency: 'USD' as const, paper: 'Letter' as const, language: value.language as CompanyLanguage, erpRevision, ledgerRevision, recordRevision, selector, seller, recipient, number, facts, columns, rows, totals, notes };
    if (JSON.stringify(detached).length > MAX_EXPORT_TEXT_CHARACTERS) return fail('export_too_large');
    return snapshotPrivateJson(detached) as ExportSnapshot;
  } catch (error) { if (error instanceof ExportError && error.code === 'export_too_large') throw error; return fail('invalid_export_snapshot'); }
}
/** Pure projection from a durable, authorized book. No numbering, write or tax call. */
export function buildUsExportSnapshot(input: unknown, sellerInput: PublicSellerSnapshot | null, selectorInput: unknown, languageInput?: CompanyLanguage): ExportSnapshot {
  const selector = validateUsExportSelector(selectorInput);
  try {
    const captured = snapshotPrivateJson(input) as { configuration: { organizationId: string } };
    const state = validateStoredErp(captured, captured.configuration.organizationId);
    if (state.configuration.currency !== 'USD' || state.configuration.country !== 'US') return fail('export_unavailable');
    const invoice = selector.kind === 'document' && selector.documentType === 'invoice' ? state.invoices.find(i => i.id === selector.id) : null;
    if (selector.kind === 'document' && selector.documentType === 'invoice' && !invoice) return fail('export_source_not_found');
    const sourceSeller = invoice?.sellerSnapshot ?? sellerInput;
    if (!sourceSeller) return fail('seller_configuration_required');
    const seller = validatePublicSellerSnapshot(snapshotPrivateJson(sourceSeller), state.configuration.organizationId);
    const language = languageInput ?? invoice?.companyConfiguration.language ?? state.configuration.language;
    if (!['fr', 'de', 'it', 'en'].includes(language)) return fail('invalid_export_selector');
    const copy = exportCopy[language], locale = `${language}-US`, date = (value: string) => formatDateOnly(value, locale);
    const facts: { label: ExportLabelKey; value: string }[] = [], totals: { label: ExportLabelKey; minorUnits: string }[] = [];
    const fact = (label: ExportLabelKey, value: string) => facts.push({ label, value });
    const total = (label: ExportLabelKey, minorUnits: string) => totals.push({ label, minorUnits });
    const column = (label: ExportLabelKey, kind: 'text' | 'money' = 'text') => ({ label, kind, align: kind === 'money' ? 'right' as const : 'left' as const });
    let publicSeller: PrintedParty = { name: seller.displayName, address: state.configuration.address, ...(seller.contactEmail ? { contactEmail: seller.contactEmail } : {}), ...(seller.contactPhone ? { contactPhone: seller.contactPhone } : {}) };
    let recipient: PrintedParty | null = null, number: string | null = null, notes = '', recordRevision: number | null = null, columns: ExportSnapshot['columns'] = [], rows: ExportSnapshot['rows'] = [];
    fact('currency', 'USD'); fact('accountingBasis', copy[(invoice?.companyConfiguration ?? state.configuration).accountingBasis]);
    if (selector.kind === 'document' && selector.documentType === 'project') {
      const project = state.schemaVersion >= 3 ? state.projects?.find(p => p.id === selector.id) : null;
      if (!project) return fail('export_source_not_found');
      const customer = state.customers.find(c => c.id === project.customerId); if (!customer) return fail('invalid_export_snapshot');
      recipient = { name: customer.name, address: customer.billingAddress, ...(customer.email ? { contactEmail: customer.email } : {}), ...(customer.phone ? { contactPhone: customer.phone } : {}) };
      number = project.number; recordRevision = project.revision; notes = project.notes;
      fact('projectName', project.name); fact('projectStatus', copy[project.status]); fact('budgetNet', project.budget === null ? copy.notSet : formatMoney(project.budget, locale));
      if (project.startDate !== null) fact('startDate', date(project.startDate)); if (project.targetDate !== null) fact('targetDate', date(project.targetDate));
      const quotes = state.estimates.filter(e => e.projectId === project.id), invoices = state.invoices.filter(i => i.projectId === project.id), bills = (state.vendorBills ?? []).filter(b => project.vendorBillIds.includes(b.id));
      columns = [column('sourceType'), column('number'), column('date'), column('net', 'money'), column('tax', 'money'), column('total', 'money'), column('balance', 'money')];
      rows = [...quotes.map(e => { const net = estimateTotals(e).net.minorUnits; return [copy.estimate, e.number, date(e.date), net, '0', net, '0']; }), ...invoices.map(i => [copy.invoice, i.number, date(i.date), (BigInt(i.subtotal.minorUnits) - BigInt(i.discount.minorUnits)).toString(), i.tax.minorUnits, i.total.minorUnits, invoiceBalance(i).minorUnits]), ...bills.map(b => [copy.vendor_bill, b.reference, date(b.date), b.net.minorUnits, b.tax.minorUnits, b.total.minorUnits, vendorBillBalance(b, (state.vendorPayments ?? []).filter(p => p.billId === b.id)).minorUnits])];
      const byType = (type: string, index: number) => rows.filter(row => row[0] === type).reduce((sum, row) => sum + BigInt(row[index]), BigInt(0));
      total('estimatesNet', byType(copy.estimate, 3).toString()); total('invoicedNet', byType(copy.invoice, 3).toString()); total('invoicedTax', byType(copy.invoice, 4).toString()); total('invoicedTotal', byType(copy.invoice, 5).toString()); total('received', (byType(copy.invoice, 5) - byType(copy.invoice, 6)).toString()); total('outstanding', byType(copy.invoice, 6).toString()); total('purchasesNet', byType(copy.vendor_bill, 3).toString()); total('purchasesTax', byType(copy.vendor_bill, 4).toString()); total('purchasesTotal', byType(copy.vendor_bill, 5).toString()); total('purchasesBalance', byType(copy.vendor_bill, 6).toString());
    } else if (selector.kind === 'document' && selector.documentType !== 'vendor_bill') {
      const document = selector.documentType === 'invoice' ? invoice! : state.estimates.find(e => e.id === selector.id);
      if (!document) return fail('export_source_not_found');
      const printed = buildPrintableDocument(state.configuration, seller, selector.documentType === 'invoice' ? { type: 'invoice', document: invoice! } : { type: 'estimate', document: document as typeof state.estimates[number] }, { paper: 'Letter' });
      publicSeller = printed.seller; recipient = printed.customer; number = printed.number; notes = printed.notes;
      recordRevision = selector.documentType === 'estimate' ? (document as typeof state.estimates[number]).revision : null;
      fact('date', date(printed.date)); if (printed.dueDate) fact('dueDate', date(printed.dueDate)); if (printed.expiresAt) fact('expiresAt', date(printed.expiresAt)); if (printed.termsDays !== null) fact('termsDays', String(printed.termsDays));
      if (invoice) { fact('accountingDate', date(invoice.accountingDate)); fact('sourceEstimateRevision', String(invoice.sourceEstimateRevision)); }
      columns = [column('description'), column('quantity'), column('unitPrice', 'money'), column('net', 'money')];
      rows = printed.lines.map(line => [line.description, line.quantity, line.unitPrice.minorUnits, line.net.minorUnits]);
      total('subtotal', printed.subtotal.minorUnits); total('discount', printed.discount.minorUnits); if (printed.tax) total('tax', printed.tax.minorUnits); total('total', printed.total.minorUnits); if (printed.balance) total('balance', printed.balance.minorUnits);
    } else if (selector.kind === 'document') {
      const bill = state.vendorBills?.find(b => b.id === selector.id); if (!bill) return fail('export_source_not_found');
      recipient = { name: bill.vendorSnapshot.name, address: bill.vendorSnapshot.billingAddress, ...(bill.vendorSnapshot.email ? { contactEmail: bill.vendorSnapshot.email } : {}), ...(bill.vendorSnapshot.phone ? { contactPhone: bill.vendorSnapshot.phone } : {}) };
      number = bill.reference; recordRevision = bill.recordedRevision;
      fact('date', date(bill.date)); fact('accountingDate', date(bill.accountingDate)); fact('dueDate', date(bill.dueDate)); fact('period', bill.periodId); fact('sourceReference', bill.sourceReference);
      columns = [column('description'), column('net', 'money'), column('tax', 'money'), column('total', 'money')]; rows = [[bill.reference, bill.net.minorUnits, bill.tax.minorUnits, bill.total.minorUnits]];
      total('net', bill.net.minorUnits); total('tax', bill.tax.minorUnits); total('total', bill.total.minorUnits); total('balance', vendorBillBalance(bill, (state.vendorPayments ?? []).filter(p => p.billId === bill.id)).minorUnits);
    } else {
      if ('asOf' in selector) fact('asOf', date(selector.asOf)); else { fact('from', date(selector.start)); fact('to', date(selector.end)); }
      if (selector.reportType === 'trial_balance') {
        const r = trialBalance(state.ledger, selector.asOf); columns = [column('account'), column('description'), column('accountType'), column('debit', 'money'), column('credit', 'money')]; rows = r.rows.map(row => [row.code, row.name, row.type, row.debitMinor, row.creditMinor]); total('debit', r.totalDebitMinor); total('credit', r.totalCreditMinor);
      } else if (selector.reportType === 'profit_loss') {
        const r = profitAndLoss(state.ledger, selector); columns = [column('account'), column('accountType'), column('amount', 'money')]; rows = r.rows.map(row => [row.name, row.type, row.amountMinor]); total('income', r.incomeMinor); total('expense', r.expenseMinor); total('profit', r.profitMinor);
      } else if (selector.reportType === 'balance_sheet') {
        const r = balanceSheet(state.ledger, selector.asOf); columns = [column('account'), column('accountType'), column('amount', 'money')]; rows = r.rows.map(row => [row.name, row.type, row.amountMinor]); total('assets', r.assetsMinor); total('liabilities', r.liabilitiesMinor); total('equity', r.equityMinor); total('unclosedEarnings', r.unclosedEarningsMinor);
      } else if (selector.reportType === 'cash_flow') {
        const r = cashFlow(state.ledger, selector); columns = [column('description'), column('amount', 'money')]; rows = (['opening', 'operating', 'investing', 'financing', 'netChange', 'closing'] as const).map(k => [copy[k], r[`${k}Minor` as keyof typeof r] as string]);
        total('opening', r.openingMinor); total('operating', r.operatingMinor); total('investing', r.investingMinor); total('financing', r.financingMinor); total('netChange', r.netChangeMinor); total('closing', r.closingMinor);
      } else if (selector.reportType === 'general_ledger') {
        const account = state.ledger.accounts.find(a => a.id === selector.accountId); if (!account) return fail('export_source_not_found');
        const r = generalLedger(state.ledger, selector.accountId, selector); fact('account', account.name);
        columns = [column('accountingDate'), column('transactionDate'), column('paymentDate'), column('sourceReference'), column('debit', 'money'), column('credit', 'money'), column('balance', 'money')]; rows = r.movements.map(row => [date(row.accountingDate), date(row.transactionDate), row.paymentDate ? date(row.paymentDate) : '', `${row.source.type}: ${row.source.id}`, row.debitMinor, row.creditMinor, row.balanceMinor]); total('opening', r.openingMinor); total('closing', r.closingMinor);
      } else return fail('invalid_export_selector');
    }
    return validateUsExportSnapshot({ schemaVersion: 1, organizationId: state.configuration.organizationId, currency: 'USD', paper: 'Letter', language, erpRevision: state.revision, ledgerRevision: state.ledger.revision, recordRevision, selector, seller: publicSeller, recipient, number, facts, columns, rows, totals, notes });
  } catch (error) { if (error instanceof ExportError) throw error; return fail('invalid_export_snapshot'); }
}
