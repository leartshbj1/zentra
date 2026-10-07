import type { Currency } from '../types';
import { parseInstant } from '../localization';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type AccountingBasis = 'cash' | 'accrual';
export type FinancialRole = 'owner' | 'admin' | 'accountant' | 'member' | 'read_only';
export type CashFlowCategory = 'operating' | 'investing' | 'financing';
export type Account = Readonly<{ id: string; code: string; name: string; type: AccountType; cash?: boolean }>;
export type AccountingPeriod = Readonly<{ id: string; start: string; end: string; status: 'open' | 'closed' }>;
export type JournalLine = Readonly<{ accountId: string; debitMinor: string; creditMinor: string; description?: string }>;
export type JournalInput = Readonly<{
  id: string;
  idempotencyKey: string;
  organizationId: string;
  currency: Currency;
  basis: AccountingBasis;
  transactionDate: string;
  accountingDate: string;
  paymentDate?: string;
  periodId: string;
  description: string;
  source: Readonly<{ type: string; id: string }>;
  lines: readonly JournalLine[];
  cashFlowCategory?: CashFlowCategory;
  reversesEntryId?: string;
}>;
export type PostedJournal = JournalInput & Readonly<{ postedBy: string; postedAt: string; revision: number; fingerprint: string }>;
export type LedgerAuditEvent = Readonly<{ revision: number; action: 'posted' | 'period_closed'; actorId: string; timestamp: string; entityId: string }>;
export type Ledger = Readonly<{
  organizationId: string;
  currency: Currency;
  basis: AccountingBasis;
  revision: number;
  accounts: readonly Account[];
  periods: readonly AccountingPeriod[];
  entries: readonly PostedJournal[];
  audit: readonly LedgerAuditEvent[];
}>;
/** Constructed from verified server/native session authority, never request JSON. */
export type FinancialAuthority = Readonly<{
  organizationId: string;
  userId: string;
  role: FinancialRole;
  managementEntitled: boolean;
  timestamp: string;
}>;

export class LedgerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'LedgerError'; }
}
export function minorInteger(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,35})$/.test(value)) throw new LedgerError('INVALID_MINOR_AMOUNT');
  return BigInt(value);
}
export function validDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function timestamp(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new LedgerError('INVALID_AUDIT_TIMESTAMP');
  try { parseInstant(value); } catch { throw new LedgerError('INVALID_AUDIT_TIMESTAMP'); }
}
function nonempty(value: string, code: string, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32)) throw new LedgerError(code);
}
export function assertFinancialAuthority(ledger: Ledger, actor: FinancialAuthority) {
  if (actor.organizationId !== ledger.organizationId) throw new LedgerError('TENANT_MISMATCH');
  if (actor.managementEntitled !== true) throw new LedgerError('MANAGEMENT_ENTITLEMENT_REQUIRED');
  if (!['owner', 'admin', 'accountant'].includes(actor.role)) throw new LedgerError('FINANCIAL_PERMISSION_REQUIRED');
  nonempty(actor.userId, 'ACTOR_REQUIRED'); timestamp(actor.timestamp);
}
export function createLedger(input: Pick<Ledger, 'organizationId' | 'currency' | 'basis' | 'accounts' | 'periods'>): Ledger {
  nonempty(input.organizationId, 'ORGANIZATION_REQUIRED');
  if (!['CHF', 'USD'].includes(input.currency) || !['cash', 'accrual'].includes(input.basis)) throw new LedgerError('INVALID_LEDGER_CONFIGURATION');
  const ids = new Set<string>(); const codes = new Set<string>();
  for (const account of input.accounts) {
    nonempty(account.id, 'INVALID_ACCOUNT'); nonempty(account.code, 'INVALID_ACCOUNT'); nonempty(account.name, 'INVALID_ACCOUNT');
    if (ids.has(account.id) || codes.has(account.code) || !['asset', 'liability', 'equity', 'income', 'expense'].includes(account.type) || (account.cash && account.type !== 'asset')) throw new LedgerError('INVALID_ACCOUNT');
    ids.add(account.id); codes.add(account.code);
  }
  const periods = [...input.periods].sort((a, b) => a.start.localeCompare(b.start)); const periodIds = new Set<string>();
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index]; nonempty(period.id, 'INVALID_PERIOD');
    if (periodIds.has(period.id) || !validDate(period.start) || !validDate(period.end) || period.end < period.start || !['open', 'closed'].includes(period.status)) throw new LedgerError('INVALID_PERIOD');
    if (index > 0 && periods[index - 1].end >= period.start) throw new LedgerError('OVERLAPPING_PERIODS');
    periodIds.add(period.id);
  }
  return Object.freeze({ ...input, accounts: Object.freeze(input.accounts.map(account => Object.freeze({ ...account }))), periods: Object.freeze(periods.map(period => Object.freeze({ ...period }))), revision: 0, entries: Object.freeze([]), audit: Object.freeze([]) });
}
/** Stable content identity. Not a cryptographic seal or regulatory certification. */
function journalFingerprint(input: JournalInput): string {
  return JSON.stringify([input.organizationId, input.currency, input.basis, input.transactionDate, input.accountingDate, input.paymentDate ?? null, input.periodId, input.description, input.source.type, input.source.id, input.cashFlowCategory ?? null, input.reversesEntryId ?? null, input.lines.map(line => [line.accountId, line.debitMinor, line.creditMinor, line.description ?? null])]);
}
export function postJournal(ledger: Ledger, input: JournalInput, actor: FinancialAuthority, expectedRevision: number): Ledger {
  assertFinancialAuthority(ledger, actor);
  if (input.organizationId !== ledger.organizationId) throw new LedgerError('TENANT_MISMATCH');
  if (input.currency !== ledger.currency) throw new LedgerError('CURRENCY_MISMATCH');
  if (input.basis !== ledger.basis) throw new LedgerError('ACCOUNTING_BASIS_MISMATCH');
  nonempty(input.id, 'ENTRY_ID_REQUIRED', 512); nonempty(input.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED', 240);
  nonempty(input.description, 'DESCRIPTION_REQUIRED', 2000); nonempty(input.source.type, 'SOURCE_REQUIRED'); nonempty(input.source.id, 'SOURCE_REQUIRED');
  const fingerprint = journalFingerprint(input);
  const previous = ledger.entries.find(entry => entry.idempotencyKey === input.idempotencyKey);
  if (previous) {
    if (previous.id !== input.id || previous.fingerprint !== fingerprint) throw new LedgerError('IDEMPOTENCY_CONFLICT');
    return ledger;
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== ledger.revision || ledger.revision >= Number.MAX_SAFE_INTEGER) throw new LedgerError('REVISION_CONFLICT');
  if (ledger.entries.some(entry => entry.id === input.id)) throw new LedgerError('ENTRY_ID_CONFLICT');
  if (!validDate(input.transactionDate) || !validDate(input.accountingDate) || (input.paymentDate !== undefined && !validDate(input.paymentDate))) throw new LedgerError('INVALID_DATE');
  const period = ledger.periods.find(candidate => candidate.id === input.periodId);
  if (!period || input.accountingDate < period.start || input.accountingDate > period.end) throw new LedgerError('ACCOUNTING_PERIOD_REQUIRED');
  if (period.status === 'closed' || ledger.periods.some(candidate => candidate.status === 'closed' && input.accountingDate <= candidate.end)) throw new LedgerError('ACCOUNTING_PERIOD_CLOSED');
  if (!Array.isArray(input.lines) || input.lines.length < 2 || input.lines.length > 1000) throw new LedgerError('JOURNAL_LINES_REQUIRED');
  const accounts = new Map(ledger.accounts.map(account => [account.id, account]));
  let debit = BigInt(0); let credit = BigInt(0); let cashMovement = BigInt(0);
  for (const line of input.lines) {
    const account = accounts.get(line.accountId); if (!account) throw new LedgerError('UNKNOWN_ACCOUNT');
    const dr = minorInteger(line.debitMinor); const cr = minorInteger(line.creditMinor);
    if ((dr > BigInt(0) && cr > BigInt(0)) || (dr === BigInt(0) && cr === BigInt(0))) throw new LedgerError('INVALID_JOURNAL_LINE');
    debit += dr; credit += cr; if (account.cash) cashMovement += dr - cr;
  }
  if (debit !== credit || debit === BigInt(0)) throw new LedgerError('UNBALANCED_JOURNAL');
  if (cashMovement !== BigInt(0) && !['operating', 'investing', 'financing'].includes(input.cashFlowCategory ?? '')) throw new LedgerError('CASH_FLOW_CLASSIFICATION_REQUIRED');
  if (input.reversesEntryId) {
    const original = ledger.entries.find(entry => entry.id === input.reversesEntryId);
    if (!original || ledger.entries.some(entry => entry.reversesEntryId === original.id)) throw new LedgerError('INVALID_REVERSAL');
    if (original.lines.length !== input.lines.length || original.lines.some((line, index) => line.accountId !== input.lines[index].accountId || line.debitMinor !== input.lines[index].creditMinor || line.creditMinor !== input.lines[index].debitMinor)) throw new LedgerError('INVALID_REVERSAL');
    if (input.cashFlowCategory !== original.cashFlowCategory) throw new LedgerError('INVALID_REVERSAL');
  }
  const revision = ledger.revision + 1;
  const entry: PostedJournal = Object.freeze({ ...input, source: Object.freeze({ ...input.source }), lines: Object.freeze(input.lines.map(line => Object.freeze({ ...line }))), postedBy: actor.userId, postedAt: actor.timestamp, revision, fingerprint });
  return Object.freeze({ ...ledger, revision, entries: Object.freeze([...ledger.entries, entry]), audit: Object.freeze([...ledger.audit, Object.freeze({ revision, action: 'posted' as const, actorId: actor.userId, timestamp: actor.timestamp, entityId: entry.id })]) });
}
export function reverseJournal(ledger: Ledger, entryId: string, correction: Pick<JournalInput, 'id' | 'idempotencyKey' | 'transactionDate' | 'accountingDate' | 'periodId' | 'description'>, actor: FinancialAuthority, expectedRevision: number): Ledger {
  const original = ledger.entries.find(entry => entry.id === entryId);
  if (!original) throw new LedgerError('ENTRY_NOT_FOUND');
  return postJournal(ledger, { ...correction, organizationId: ledger.organizationId, currency: ledger.currency, basis: ledger.basis, source: { type: 'reversal', id: entryId }, reversesEntryId: entryId, cashFlowCategory: original.cashFlowCategory, lines: original.lines.map(line => ({ accountId: line.accountId, debitMinor: line.creditMinor, creditMinor: line.debitMinor })) }, actor, expectedRevision);
}
export function closePeriod(ledger: Ledger, periodId: string, actor: FinancialAuthority, expectedRevision: number): Ledger {
  assertFinancialAuthority(ledger, actor);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== ledger.revision || ledger.revision >= Number.MAX_SAFE_INTEGER) throw new LedgerError('REVISION_CONFLICT');
  const period = ledger.periods.find(candidate => candidate.id === periodId); if (!period) throw new LedgerError('ACCOUNTING_PERIOD_REQUIRED');
  if (period.status === 'closed') return ledger;
  const revision = ledger.revision + 1;
  return Object.freeze({ ...ledger, revision, periods: Object.freeze(ledger.periods.map(candidate => candidate.id === periodId ? Object.freeze({ ...candidate, status: 'closed' as const }) : candidate)), audit: Object.freeze([...ledger.audit, Object.freeze({ revision, action: 'period_closed' as const, actorId: actor.userId, timestamp: actor.timestamp, entityId: periodId })]) });
}
