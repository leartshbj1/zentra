import { US_MANUAL_EXCLUDED_ACCOUNTS, validateUsManualJournalInput, validateUsManualReversalInput, validateUsOpenPeriodInput } from './accounting/us-journal';
import { validDate, type PostedJournal } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { decimalToMoney } from './money';
import type { ErpCommand, ErpState } from './runtime-types';

export type BrowserAccountingEditor = 'journal' | 'period' | 'reversal' | 'close' | 'upgrade';
export interface BrowserJournalLine { id: string; accountId: string; debit: string; credit: string; description: string }
const excluded = new Set(US_MANUAL_EXCLUDED_ACCOUNTS);
export const browserManualAccounts = (state: ErpState) => state.ledger.accounts.filter(account => !excluded.has(account.id));
export function browserReversibleEntry(state: ErpState, entryId?: string): PostedJournal | undefined {
  const entry = state.ledger.entries.find(row => row.id === entryId);
  return entry?.source.type === 'manual_journal' && !state.ledger.entries.some(row => row.reversesEntryId === entry.id) ? entry : undefined;
}
function exactUsd(value: string): string {
  if (!/^(?:0|[1-9][0-9]{0,33})(?:\.[0-9]{1,2})?$/.test(value)) throw new ErpError('invalid_amount', 422);
  return decimalToMoney('USD', value).minorUnits;
}
export function browserJournalTotals(lines: readonly BrowserJournalLine[]): { debitMinor: string; creditMinor: string } | null {
  try { return { debitMinor: lines.reduce((sum, line) => sum + BigInt(exactUsd(line.debit.trim() || '0')), BigInt(0)).toString(), creditMinor: lines.reduce((sum, line) => sum + BigInt(exactUsd(line.credit.trim() || '0')), BigInt(0)).toString() }; } catch { return null; }
}
function text(form: FormData, name: string): string { const value = form.get(name); if (typeof value !== 'string') throw new ErpError('invalid_request', 422); return value.trim(); }
function date(form: FormData, name: string): string { const value = text(form, name); if (value.startsWith('0000-') || !validDate(value)) throw new ErpError('invalid_date', 422); return value; }
function period(form: FormData, state: ErpState) {
  const periodId = text(form, 'periodId'), accountingDate = date(form, 'accountingDate'), selected = state.ledger.periods.find(row => row.id === periodId);
  if (!selected || selected.status !== 'open' || accountingDate < selected.start || accountingDate > selected.end || state.ledger.periods.some(row => row.status === 'closed' && accountingDate <= row.end)) throw new ErpError('accounting_period_not_open', 409);
  return { periodId, accountingDate };
}
/** Read-side review only. It neither creates authority nor changes the ledger.
 * The current state supplies periods/accounts; the server independently rechecks. */
export function buildBrowserAccountingCommand(kind: BrowserAccountingEditor, form: FormData, state: ErpState, id: string, lines: readonly BrowserJournalLine[] = [], entityId?: string): ErpCommand {
  let command: ErpCommand;
  if (kind === 'upgrade') {
    if (state.schemaVersion !== 3) throw new ErpError('accounting_upgrade_required', 409);
    if (form.get('confirm') !== 'on') throw new ErpError('invalid_request', 422);
    command = { type: 'upgrade_accounting' };
  } else {
    if (state.schemaVersion !== 4) throw new ErpError('accounting_upgrade_required', 409);
    if (kind === 'period') {
      const input = validateUsOpenPeriodInput({ id: text(form, 'periodId'), start: date(form, 'start'), end: date(form, 'end') });
      if (state.ledger.periods.length >= 100) throw new ErpError('period_limit_reached', 409);
      if (state.ledger.periods.some(row => row.id === input.id)) throw new ErpError('period_already_exists', 409);
      if (state.ledger.periods.some(row => input.start <= row.end)) throw new ErpError('invalid_period', 422);
      command = { type: 'open_period', ...input };
    } else if (kind === 'close') {
      const first = state.ledger.periods.filter(row => row.status === 'open').sort((a, b) => a.start.localeCompare(b.start))[0];
      if (!first || first.id !== entityId) throw new ErpError('accounting_period_order_conflict', 409);
      if (form.get('confirm') !== 'on') throw new ErpError('invalid_request', 422);
      command = { type: 'close_period', periodId: first.id };
    } else if (kind === 'reversal') {
      const original = browserReversibleEntry(state, entityId);
      if (!original) throw new ErpError('manual_journal_required', 409);
      command = { type: 'reverse_manual_journal', ...validateUsManualReversalInput({ id, entryId: original.id, transactionDate: date(form, 'transactionDate'), ...period(form, state), reason: text(form, 'reason') }) };
    } else {
      const category = text(form, 'cashFlowCategory');
      const input = validateUsManualJournalInput({ id, transactionDate: date(form, 'transactionDate'), ...period(form, state), description: text(form, 'description'), sourceReference: text(form, 'sourceReference'), lines: lines.map(line => ({ accountId: line.accountId, debitMinor: exactUsd(line.debit.trim() || '0'), creditMinor: exactUsd(line.credit.trim() || '0'), ...(line.description.trim() ? { description: line.description.trim() } : {}) })), ...(category ? { cashFlowCategory: category } : {}) });
      let debit = BigInt(0), credit = BigInt(0), cash = BigInt(0);
      for (const line of input.lines) { const account = state.ledger.accounts.find(row => row.id === line.accountId); if (!account || excluded.has(account.id)) throw new ErpError('manual_account_forbidden', 422); const dr = BigInt(line.debitMinor), cr = BigInt(line.creditMinor); if ((dr > BigInt(0)) === (cr > BigInt(0))) throw new ErpError('invalid_entry', 422); debit += dr; credit += cr; if (account.cash) cash += dr - cr; }
      if (debit !== credit || debit <= BigInt(0)) throw new ErpError('unbalanced_entry', 422);
      if (cash !== BigInt(0) && !input.cashFlowCategory) throw new ErpError('cash_flow_category_required', 422);
      command = { type: 'post_manual_journal', ...input };
    }
  }
  return validateErpRequest({ idempotencyKey: 'browser-accounting-review', expectedRevision: state.revision, command }, state.configuration.organizationId).command;
}
