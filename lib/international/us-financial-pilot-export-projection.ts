import { LedgerError } from './accounting/ledger';
import { balanceSheet, cashFlow, generalLedger, profitAndLoss, trialBalance } from './accounting/reports';
import { lineTotals } from './invoicing';
import type { UsFinancialBookViewV5 } from './us-financial-kernel-types';
import {
  US_FINANCIAL_PILOT_EXPORT_COLUMNS, US_FINANCIAL_PILOT_EXPORT_MAX_ROWS, US_FINANCIAL_PILOT_EXPORT_TOTALS,
  UsFinancialPilotExportError, validateUsFinancialPilotExportSelector, validateUsFinancialPilotExportSnapshot,
  type UsFinancialPilotExportFact, type UsFinancialPilotExportLabel, type UsFinancialPilotExportSection,
  type UsFinancialPilotExportSectionKind, type UsFinancialPilotExportSelector, type UsFinancialPilotExportSnapshot,
} from './us-financial-pilot-export-contract';
import { UsFinancialPilotError } from './us-financial-pilot-contract';
import { financialPilotInvoiceRows, financialPilotPublicSource, financialPilotSummary, readUsFinancialPilotView } from './us-financial-pilot-projection';

const invalid = (): never => { throw new UsFinancialPilotExportError('invalid_financial_pilot_export_snapshot', 503); };
const missing = (): never => { throw new UsFinancialPilotExportError('financial_pilot_export_source_not_found', 404); };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function section(kind: UsFinancialPilotExportSectionKind, rows: readonly (readonly string[])[], amounts: readonly string[]): UsFinancialPilotExportSection {
  if (rows.length > US_FINANCIAL_PILOT_EXPORT_MAX_ROWS) throw new UsFinancialPilotExportError('financial_pilot_export_too_large', 413);
  const labels = US_FINANCIAL_PILOT_EXPORT_TOTALS[kind];
  if (labels.length !== amounts.length) return invalid();
  return { kind, columns: US_FINANCIAL_PILOT_EXPORT_COLUMNS[kind], rows, totals: labels.map((label, index) => ({ label, minorUnits: amounts[index] })) };
}
function fact(label: UsFinancialPilotExportLabel, value: string, kind: UsFinancialPilotExportFact['kind'] = 'text'): UsFinancialPilotExportFact { return { label, value, kind }; }
function quantity(units: string, scale: number): string {
  if (scale === 0) return units;
  const padded = units.padStart(scale + 1, '0');
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}
function common(view: UsFinancialBookViewV5, selector: UsFinancialPilotExportSelector): UsFinancialPilotExportSnapshot {
  return {
    consumer: 'financial-pilot', schemaVersion: 1, organizationId: view.organizationId, revision: view.revision,
    ledgerRevision: view.ledger.revision, currency: 'USD', paper: 'Letter', language: selector.language, selector,
    number: null, issuer: { name: null, address: view.configuration.address, email: null, phone: null }, recipient: null,
    facts: [fact('organization', view.organizationId), fact('currency', 'USD'), fact('accountingBasis', 'accrual'), fact('financialRevision', String(view.revision)), fact('ledgerRevision', String(view.ledger.revision))],
    sections: [], notes: '',
  };
}
function invoiceSnapshot(view: UsFinancialBookViewV5, selector: Extract<UsFinancialPilotExportSelector, { kind: 'invoice' }>): UsFinancialPilotExportSnapshot {
  const invoice = view.invoices.find(row => row.id === selector.invoiceId) ?? missing();
  const settlement = view.settlements.find(row => row.invoiceId === invoice.id) ?? invalid();
  const lines = invoice.lines.map(line => {
    const net = lineTotals(line, 'USD').net.minorUnits;
    const tax = invoice.taxAssessment.lines.find(row => row.id === line.id)?.taxMinor ?? invalid();
    return [line.description, quantity(line.quantityUnits, line.quantityScale), line.unitPrice.minorUnits, net, tax, (BigInt(net) + BigInt(tax)).toString()];
  });
  const payments = [...invoice.payments].sort((a, b) => compare(a.paymentDate, b.paymentDate) || compare(a.id, b.id)).map(payment => [payment.reference, payment.paymentDate, payment.accountingDate, payment.amount.minorUnits]);
  const credits = view.credits.filter(credit => credit.invoiceId === invoice.id).sort((a, b) => a.recordedRevision - b.recordedRevision || compare(a.id, b.id)).map(credit => [credit.number, credit.transactionDate, credit.accountingDate, credit.reason, credit.taxDisposition, credit.allocation.netMinor, credit.allocation.taxMinor, credit.allocation.totalMinor]);
  return {
    ...common(view, selector), number: invoice.number,
    // Both identities and the address are the immutable values at issuance.
    issuer: { name: invoice.sellerSnapshot.displayName, address: invoice.companyConfiguration.address, email: invoice.sellerSnapshot.contactEmail ?? null, phone: invoice.sellerSnapshot.contactPhone ?? null },
    recipient: { name: invoice.customer.name, address: invoice.customer.billingAddress, email: invoice.customer.email ?? null, phone: invoice.customer.phone ?? null },
    facts: [...common(view, selector).facts, fact('date', invoice.date, 'date'), fact('accountingDate', invoice.accountingDate, 'date'), fact('dueDate', invoice.dueDate, 'date'), fact('sourceEstimateRevision', String(invoice.sourceEstimateRevision))],
    sections: [
      section('invoice_lines', lines, [invoice.subtotal.minorUnits, invoice.discount.minorUnits, (BigInt(invoice.subtotal.minorUnits) - BigInt(invoice.discount.minorUnits)).toString(), invoice.tax.minorUnits, settlement.totalMinor, settlement.receivedMinor, settlement.creditedMinor, settlement.outstandingMinor]),
      section('payments', payments, [settlement.receivedMinor]), section('credits', credits, [settlement.creditedMinor]),
    ], notes: invoice.notes,
  };
}
function reportSnapshot(view: UsFinancialBookViewV5, selector: Extract<UsFinancialPilotExportSelector, { kind: 'report' }>): UsFinancialPilotExportSnapshot {
  const base = common(view, selector), ledger = view.ledger;
  if (selector.reportType === 'receivables') {
    const rows = financialPilotInvoiceRows(view), summary = financialPilotSummary(rows);
    return { ...base, sections: [section('receivables', rows.map(row => [row.number, row.customerName, row.date, row.dueDate, row.totalMinor, row.receivedMinor, row.creditedMinor, row.outstandingMinor, row.status]), [summary.totalMinor, summary.receivedMinor, summary.creditedMinor, summary.outstandingMinor])] };
  }
  if (selector.reportType === 'trial_balance') {
    const result = trialBalance(ledger, selector.asOf);
    return { ...base, facts: [...base.facts, fact('asOf', selector.asOf, 'date')], sections: [section('trial_balance', result.rows.map(row => [row.code, row.name, row.type, row.debitMinor, row.creditMinor]), [result.totalDebitMinor, result.totalCreditMinor])] };
  }
  if (selector.reportType === 'balance_sheet') {
    const result = balanceSheet(ledger, selector.asOf);
    return { ...base, facts: [...base.facts, fact('asOf', selector.asOf, 'date')], sections: [section('balance_sheet', result.rows.map(row => [row.name, row.type, row.amountMinor]), [result.assetsMinor, result.liabilitiesMinor, result.equityMinor, result.unclosedEarningsMinor])] };
  }
  if (!('from' in selector)) return invalid();
  const range = { start: selector.from, end: selector.to }, facts = [...base.facts, fact('from', selector.from, 'date'), fact('to', selector.to, 'date')];
  if (selector.reportType === 'profit_loss') {
    const result = profitAndLoss(ledger, range);
    return { ...base, facts, sections: [section('profit_loss', result.rows.map(row => [row.name, row.type, row.amountMinor]), [result.incomeMinor, result.expenseMinor, result.profitMinor])] };
  }
  if (selector.reportType === 'cash_flow') {
    try {
      const result = cashFlow(ledger, range);
      return { ...base, facts, sections: [section('cash_flow', [], [result.openingMinor, result.operatingMinor, result.investingMinor, result.financingMinor, result.netChangeMinor, result.closingMinor])] };
    } catch (error) { if (error instanceof LedgerError && error.code === 'CASH_FLOW_CLASSIFICATION_REQUIRED') throw new UsFinancialPilotExportError('financial_pilot_export_cash_flow_unavailable', 409); throw error; }
  }
  if (selector.reportType !== 'general_ledger') return invalid();
  const account = ledger.accounts.find(row => row.id === selector.accountId) ?? missing();
  const result = generalLedger(ledger, account.id, range);
  const rows = result.movements.map(row => {
    const entry = ledger.entries.find(entry => entry.id === row.entryId) ?? invalid(), source = financialPilotPublicSource(view, entry);
    const reference = source.reference ?? (source.journalRevision === null ? '' : `#${source.journalRevision}`);
    return [String(entry.revision), row.transactionDate, row.accountingDate, row.paymentDate ?? '', reference, row.debitMinor, row.creditMinor, row.balanceMinor];
  });
  return { ...base, facts: [...facts, fact('account', `${account.code} · ${account.name}`)], sections: [section('general_ledger', rows, [result.openingMinor, result.closingMinor])] };
}
/** Complete read-only export from one captured, replayed V5 book. Does not use
 * paginated UI DTOs, legacy ERP export semantics or any provider/network call. */
export async function buildUsFinancialPilotExportSnapshot(book: unknown, selectorInput: UsFinancialPilotExportSelector): Promise<UsFinancialPilotExportSnapshot> {
  const selector = validateUsFinancialPilotExportSelector(selectorInput);
  try {
    const view = await readUsFinancialPilotView(book, selector.revision);
    const snapshot = selector.kind === 'invoice' ? invoiceSnapshot(view, selector) : reportSnapshot(view, selector);
    return validateUsFinancialPilotExportSnapshot(snapshot, view.organizationId, selector);
  } catch (error) {
    if (error instanceof UsFinancialPilotExportError) throw error;
    if (error instanceof UsFinancialPilotError && error.code === 'financial_snapshot_changed') throw new UsFinancialPilotExportError('financial_snapshot_changed', 409);
    return invalid();
  }
}
