import { LedgerError, validDate, type Ledger, type PostedJournal, type AccountType } from './ledger';

export type ReportRange = Readonly<{ start: string; end: string }>;
function rangeCheck(range: ReportRange) {
  if (!validDate(range.start) || !validDate(range.end) || range.start > range.end) throw new LedgerError('INVALID_REPORT_RANGE');
}
function entriesIn(ledger: Ledger, range: ReportRange): readonly PostedJournal[] {
  rangeCheck(range);
  return ledger.entries.filter(entry => entry.accountingDate >= range.start && entry.accountingDate <= range.end);
}
function balances(ledger: Ledger, entries: readonly PostedJournal[]) {
  const totals = new Map(ledger.accounts.map(account => [account.id, { debit: BigInt(0), credit: BigInt(0) }]));
  for (const entry of entries) for (const line of entry.lines) {
    const total = totals.get(line.accountId); if (!total) throw new LedgerError('UNKNOWN_ACCOUNT');
    total.debit += BigInt(line.debitMinor); total.credit += BigInt(line.creditMinor);
  }
  return ledger.accounts.map(account => ({ account, debit: totals.get(account.id)!.debit, credit: totals.get(account.id)!.credit }));
}
function naturalBalance(type: AccountType, debit: bigint, credit: bigint) { return ['asset', 'expense'].includes(type) ? debit - credit : credit - debit; }
export function generalLedger(ledger: Ledger, accountId: string, range: ReportRange) {
  if (!ledger.accounts.some(account => account.id === accountId)) throw new LedgerError('UNKNOWN_ACCOUNT');
  rangeCheck(range);
  let running = BigInt(0);
  for (const entry of ledger.entries.filter(entry => entry.accountingDate < range.start)) for (const line of entry.lines.filter(line => line.accountId === accountId)) running += BigInt(line.debitMinor) - BigInt(line.creditMinor);
  const openingMinor = running.toString();
  const movements = entriesIn(ledger, range).slice().sort((a,b) => a.accountingDate.localeCompare(b.accountingDate) || a.revision-b.revision).flatMap(entry => entry.lines.filter(line => line.accountId === accountId).map(line => {
    running += BigInt(line.debitMinor)-BigInt(line.creditMinor);
    return { entryId: entry.id, transactionDate: entry.transactionDate, accountingDate: entry.accountingDate, paymentDate: entry.paymentDate, debitMinor: line.debitMinor, creditMinor: line.creditMinor, balanceMinor: running.toString(), source: entry.source };
  }));
  return { currency: ledger.currency, basis: ledger.basis, openingMinor, closingMinor: running.toString(), movements };
}
export function trialBalance(ledger: Ledger, asOf: string) {
  if (!validDate(asOf)) throw new LedgerError('INVALID_REPORT_RANGE');
  const rows = balances(ledger, ledger.entries.filter(entry => entry.accountingDate <= asOf)).map(({account,debit,credit}) => {
    const net = debit-credit;
    return { accountId: account.id, code: account.code, name: account.name, type: account.type, debitMinor: (net > BigInt(0) ? net : BigInt(0)).toString(), creditMinor: (net < BigInt(0) ? -net : BigInt(0)).toString() };
  });
  const debit = rows.reduce((sum,row) => sum+BigInt(row.debitMinor),BigInt(0)); const credit = rows.reduce((sum,row) => sum+BigInt(row.creditMinor),BigInt(0));
  return { currency: ledger.currency, basis: ledger.basis, asOf, rows, totalDebitMinor: debit.toString(), totalCreditMinor: credit.toString(), balanced: debit===credit };
}
export function profitAndLoss(ledger: Ledger, range: ReportRange) {
  const rows = balances(ledger, entriesIn(ledger, range)).filter(row => ['income','expense'].includes(row.account.type)).map(({account,debit,credit}) => ({ accountId: account.id, name: account.name, type: account.type, amountMinor: naturalBalance(account.type,debit,credit).toString() }));
  const income = rows.filter(row => row.type === 'income').reduce((sum,row) => sum+BigInt(row.amountMinor),BigInt(0));
  const expense = rows.filter(row => row.type === 'expense').reduce((sum,row) => sum+BigInt(row.amountMinor),BigInt(0));
  return { currency: ledger.currency, basis: ledger.basis, range, rows, incomeMinor: income.toString(), expenseMinor: expense.toString(), profitMinor: (income-expense).toString() };
}
export function balanceSheet(ledger: Ledger, asOf: string) {
  if (!validDate(asOf)) throw new LedgerError('INVALID_REPORT_RANGE');
  const all = balances(ledger, ledger.entries.filter(entry => entry.accountingDate <= asOf));
  const rows = all.filter(row => ['asset','liability','equity'].includes(row.account.type)).map(({account,debit,credit}) => ({ accountId: account.id, name: account.name, type: account.type, amountMinor: naturalBalance(account.type,debit,credit).toString() }));
  const total = (type: AccountType) => rows.filter(row => row.type===type).reduce((sum,row) => sum+BigInt(row.amountMinor),BigInt(0));
  // Cumulative unclosed earnings are shown separately; no fictitious closing entry.
  const earnings = all.reduce((sum,{account,debit,credit}) => account.type==='income' ? sum+credit-debit : account.type==='expense' ? sum-debit+credit : sum,BigInt(0));
  const assets=total('asset'), liabilities=total('liability'), equity=total('equity');
  return { currency:ledger.currency,basis:ledger.basis,asOf,rows,assetsMinor:assets.toString(),liabilitiesMinor:liabilities.toString(),equityMinor:equity.toString(),unclosedEarningsMinor:earnings.toString(),balanced:assets===liabilities+equity+earnings };
}
export function cashFlow(ledger: Ledger, range: ReportRange) {
  rangeCheck(range); const cashAccounts = new Set(ledger.accounts.filter(account => account.cash).map(account => account.id));
  const buckets={operating:BigInt(0),investing:BigInt(0),financing:BigInt(0)}; let opening=BigInt(0);
  for (const entry of ledger.entries.filter(entry => entry.accountingDate<=range.end)) {
    const movement=entry.lines.filter(line=>cashAccounts.has(line.accountId)).reduce((sum,line)=>sum+BigInt(line.debitMinor)-BigInt(line.creditMinor),BigInt(0));
    if (entry.accountingDate<range.start) opening+=movement;
    else if (movement!==BigInt(0)) {
      if (!entry.cashFlowCategory) throw new LedgerError('CASH_FLOW_CLASSIFICATION_REQUIRED');
      buckets[entry.cashFlowCategory]+=movement;
    }
  }
  const net=buckets.operating+buckets.investing+buckets.financing;
  return {currency:ledger.currency,basis:ledger.basis,range,openingMinor:opening.toString(),operatingMinor:buckets.operating.toString(),investingMinor:buckets.investing.toString(),financingMinor:buckets.financing.toString(),netChangeMinor:net.toString(),closingMinor:(opening+net).toString(),method:'direct' as const};
}
