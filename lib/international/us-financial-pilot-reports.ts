import { LedgerError, validDate } from './accounting/ledger';
import { balanceSheet, cashFlow, generalLedger, profitAndLoss, trialBalance } from './accounting/reports';
import { snapshotPrivateJson } from './private-json';
import {
  UsFinancialPilotError, financialPilotCursorOffset, validateUsFinancialPilotReports,
  type UsFinancialPilotReportQuery, type UsFinancialPilotReports,
} from './us-financial-pilot-contract';
import { financialPilotHead, financialPilotInvoiceRows, financialPilotPage, financialPilotPublicSource, financialPilotSummary, readUsFinancialPilotView } from './us-financial-pilot-projection';

function query(input: unknown): UsFinancialPilotReportQuery {
  try {
    const value = snapshotPrivateJson(input) as UsFinancialPilotReportQuery;
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !['revision', 'from', 'to', 'asOf', 'accountId', 'cursor'].includes(key)) || !Number.isSafeInteger(value.revision) || value.revision < 1 || [value.from, value.to, value.asOf].some(date => typeof date !== 'string' || date.startsWith('0000-') || !validDate(date)) || value.from > value.to) throw Error();
    if (value.accountId !== undefined && value.accountId !== null && (typeof value.accountId !== 'string' || !value.accountId.trim() || value.accountId.length > 160)) throw Error();
    if (value.accountId === undefined || value.accountId === null) { if (value.cursor !== undefined && value.cursor !== null) throw Error(); }
    else financialPilotCursorOffset(value.cursor, 'general_ledger', value.revision, `${value.accountId}|${value.from}|${value.to}`);
    return value;
  } catch { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); }
}
/** Every report uses the sole current V5 ledger. Current AR is deliberately not
 * advertised as an as-of report: settlements contain later payments/credits. */
export async function projectUsFinancialPilotReports(input: unknown, queryInput: UsFinancialPilotReportQuery): Promise<UsFinancialPilotReports> {
  const selected = query(queryInput), view = await readUsFinancialPilotView(input, selected.revision), ledger = view.ledger, range = { start: selected.from, end: selected.to };
  try {
    const tb = trialBalance(ledger, selected.asOf), pl = profitAndLoss(ledger, range), bs = balanceSheet(ledger, selected.asOf);
    let flow: UsFinancialPilotReports['cashFlow'];
    try { const result = cashFlow(ledger, range); flow = { status: 'available', method: 'direct', openingMinor: result.openingMinor, operatingMinor: result.operatingMinor, investingMinor: result.investingMinor, financingMinor: result.financingMinor, netChangeMinor: result.netChangeMinor, closingMinor: result.closingMinor }; }
    catch (error) { if (!(error instanceof LedgerError) || error.code !== 'CASH_FLOW_CLASSIFICATION_REQUIRED') throw error; flow = { status: 'unavailable', reason: 'classification_required' }; }
    let gl: UsFinancialPilotReports['generalLedger'] = null;
    if (selected.accountId !== null && selected.accountId !== undefined) {
      const account = ledger.accounts.find(row => row.id === selected.accountId);
      if (!account) throw new UsFinancialPilotError('financial_pilot_record_not_found', 404);
      const result = generalLedger(ledger, account.id, range);
      const rows = result.movements.map(row => {
        const entry = ledger.entries.find(entry => entry.id === row.entryId); if (!entry) throw new UsFinancialPilotError('invalid_financial_pilot_data', 503);
        return { journalRevision: entry.revision, transactionDate: row.transactionDate, accountingDate: row.accountingDate, paymentDate: row.paymentDate ?? null, debitMinor: row.debitMinor, creditMinor: row.creditMinor, balanceMinor: row.balanceMinor, source: financialPilotPublicSource(view, entry) };
      });
      const rowScope = `${account.id}|${selected.from}|${selected.to}`, offset = financialPilotCursorOffset(selected.cursor, 'general_ledger', view.revision, rowScope);
      const movements = financialPilotPage(view, 'general_ledger', rows, selected.cursor, rowScope);
      const opening = offset === 0 ? result.openingMinor : rows[offset - 1].balanceMinor;
      gl = { account: { accountId: account.id, code: account.code, name: account.name, type: account.type }, openingMinor: result.openingMinor, closingMinor: result.closingMinor, pageOpeningMinor: opening, pageClosingMinor: movements.items.at(-1)?.balanceMinor ?? opening, movements };
    }
    const invoices = financialPilotInvoiceRows(view);
    return validateUsFinancialPilotReports({ ...financialPilotHead(view), ledgerRevision: ledger.revision, currency: 'USD', basis: 'accrual', from: selected.from, to: selected.to, asOf: selected.asOf,
      trialBalance: { rows: tb.rows.map(row => ({ accountId: row.accountId, code: row.code, name: row.name, type: row.type, debitMinor: row.debitMinor, creditMinor: row.creditMinor })), totalDebitMinor: tb.totalDebitMinor, totalCreditMinor: tb.totalCreditMinor, balanced: tb.balanced },
      profitAndLoss: { rows: pl.rows.map(row => ({ accountId: row.accountId, name: row.name, type: row.type, amountMinor: row.amountMinor })), incomeMinor: pl.incomeMinor, expenseMinor: pl.expenseMinor, profitMinor: pl.profitMinor },
      balanceSheet: { rows: bs.rows.map(row => ({ accountId: row.accountId, name: row.name, type: row.type, amountMinor: row.amountMinor })), assetsMinor: bs.assetsMinor, liabilitiesMinor: bs.liabilitiesMinor, equityMinor: bs.equityMinor, unclosedEarningsMinor: bs.unclosedEarningsMinor, balanced: bs.balanced },
      cashFlow: flow, currentReceivables: { scope: 'current', summary: financialPilotSummary(invoices), invoices: financialPilotPage(view, 'invoices', invoices) }, generalLedger: gl }, view.organizationId, view.revision);
  } catch (error) { if (error instanceof UsFinancialPilotError) throw error; throw new UsFinancialPilotError('invalid_financial_pilot_data', 503); }
}
