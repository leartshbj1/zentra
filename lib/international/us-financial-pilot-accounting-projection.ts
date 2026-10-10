import { validDate, type Account, type CashFlowCategory, type PostedJournal } from './accounting/ledger';
import { US_MANUAL_EXCLUDED_ACCOUNTS } from './accounting/us-journal';
import { usStarterChart } from './countries/us/accounting';
import { ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import type { UsFinancialBookViewV5 } from './us-financial-kernel-types';
import { US_FINANCIAL_PILOT_PAGE_SIZE, UsFinancialPilotError, validateUsFinancialPilotHead, validateUsFinancialPilotPage,
  type UsFinancialPilotHead, type UsFinancialPilotJournalRow, type UsFinancialPilotPeriodRow } from './us-financial-pilot-contract';
import { financialPilotHead, financialPilotPublicSource, readUsFinancialPilotView } from './us-financial-pilot-projection';

export interface UsFinancialPilotAccountingAccount { readonly accountId: string; readonly code: string; readonly name: string; readonly type: Account['type']; readonly cash: boolean }
export interface UsFinancialPilotAccountingContext extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly accounts: readonly UsFinancialPilotAccountingAccount[];
  readonly periodCount: number; readonly latestPeriodEnd: string | null; readonly earliestOpenPeriod: UsFinancialPilotPeriodRow | null;
}
export interface UsFinancialPilotJournalLine { readonly ordinal: number; readonly account: UsFinancialPilotAccountingAccount; readonly debitMinor: string; readonly creditMinor: string; readonly description: string | null }
/** Independent closed page; the existing public page-kind union is deliberately untouched. */
export interface UsFinancialPilotJournalLinesPage extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly kind: 'journal_lines'; readonly scope: string; readonly total: number;
  readonly items: readonly UsFinancialPilotJournalLine[]; readonly nextCursor: string | null;
}
export interface UsFinancialPilotJournalDetail extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly journal: UsFinancialPilotJournalRow; readonly cashFlowCategory: CashFlowCategory | null;
  readonly lineCount: number; readonly lines: UsFinancialPilotJournalLinesPage; readonly canReverse: boolean;
}
export interface UsFinancialPilotPeriodDetail extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly period: UsFinancialPilotPeriodRow; readonly earliestOpenPeriod: UsFinancialPilotPeriodRow | null; readonly canClose: boolean;
}
export interface UsFinancialPilotAccountingContextQuery { readonly revision: number }
export interface UsFinancialPilotJournalDetailQuery { readonly revision: number; readonly journalRevision: number; readonly lineCursor?: string | null }
export interface UsFinancialPilotPeriodDetailQuery { readonly revision: number; readonly periodId: string }

const invalid = (): never => { throw new ErpError('invalid_financial_pilot_response', 503); };
const invalidQuery = (): never => { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid(); }
function date(value: unknown): string { return typeof value === 'string' && !value.startsWith('0000-') && validDate(value) ? value : invalid(); }
function amount(value: unknown): string { return typeof value === 'string' && /^(0|[1-9][0-9]{0,35})$/.test(value) ? value : invalid(); }
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function head(value: Record<string, unknown>, organizationId?: string, revision?: number): UsFinancialPilotHead {
  const h = validateUsFinancialPilotHead({ consumer: value.consumer, schemaVersion: value.schemaVersion, organizationId: value.organizationId, revision: value.revision }, organizationId);
  if (revision !== undefined && h.revision !== revision) throw new UsFinancialPilotError('financial_snapshot_changed', 409);
  return h;
}
function ledger(value: unknown, h: UsFinancialPilotHead): number { return integer(value, 0, h.revision); }
function publicAccount(value: Account): UsFinancialPilotAccountingAccount { return { accountId: value.id, code: value.code, name: value.name, type: value.type, cash: value.cash === true }; }
function account(value: unknown): UsFinancialPilotAccountingAccount {
  const v = fields(value, ['accountId', 'code', 'name', 'type', 'cash']), accountId = text(v.accountId), code = text(v.code), name = text(v.name), cash = boolean(v.cash);
  const current = usStarterChart.find(row => row.id === accountId);
  if (!current || v.type !== current.type || code !== current.code || name !== current.name || cash !== (current.cash === true)) return invalid();
  return Object.freeze({ accountId, code, name, type: current.type, cash });
}
function period(value: unknown, h: UsFinancialPilotHead, ledgerRevision: number): UsFinancialPilotPeriodRow {
  const page = validateUsFinancialPilotPage({ ...h, ledgerRevision, kind: 'periods', scope: null, total: 1, items: [value], nextCursor: null }, h.organizationId, h.revision), row = page.items[0];
  return row && 'start' in row && 'end' in row && 'status' in row ? row : invalid();
}
function journal(value: unknown, h: UsFinancialPilotHead, ledgerRevision: number): UsFinancialPilotJournalRow {
  const page = validateUsFinancialPilotPage({ ...h, ledgerRevision, kind: 'journals', scope: null, total: 1, items: [value], nextCursor: null }, h.organizationId, h.revision), row = page.items[0];
  if (!row || !('journalRevision' in row) || !('postedAt' in row) || row.journalRevision > ledgerRevision || row.debitMinor === '0') return invalid();
  const { source, journalRevision, reversesJournalRevision, reversedByJournalRevision } = row;
  if ((reversesJournalRevision !== null && reversesJournalRevision >= journalRevision) || (reversedByJournalRevision !== null && (reversedByJournalRevision <= journalRevision || reversedByJournalRevision > ledgerRevision))) return invalid();
  if (source.kind === 'manual_reversal') {
    if (source.entityId !== null || source.reference !== null || source.journalRevision === null || source.journalRevision !== reversesJournalRevision || reversedByJournalRevision !== null) return invalid();
  } else if (source.kind === 'manual_journal') {
    if (source.entityId !== null || source.reference === null || source.journalRevision !== null || reversesJournalRevision !== null) return invalid();
    text(source.reference);
  } else if (source.kind === 'other') {
    if (source.entityId !== null || source.reference !== null || source.journalRevision !== null) return invalid();
  } else if (source.entityId === null || source.reference === null || source.journalRevision !== null || reversesJournalRevision !== null || reversedByJournalRevision !== null) return invalid();
  return row;
}
function protect<T>(operation: () => T): T {
  try { return operation(); } catch (error) { if (error instanceof UsFinancialPilotError && error.code === 'financial_snapshot_changed') throw error; return invalid(); }
}
function journalScope(journalRevision: number): string { integer(journalRevision, 1); return `journal:${journalRevision}`; }
export function financialPilotJournalLinesCursor(revision: number, offset: number, journalRevision: number): string {
  const value = JSON.stringify(['journal_lines', revision, offset, journalScope(journalRevision)]);
  financialPilotJournalLinesCursorOffset(value, revision, journalRevision); return value;
}
export function financialPilotJournalLinesCursorOffset(value: unknown, revision: number, journalRevision: number): number {
  try {
    integer(revision, 1); integer(journalRevision, 1, revision);
    if (value === null || value === undefined) return 0;
    if (typeof value !== 'string' || value.length > 512) return invalidQuery();
    const v: unknown = JSON.parse(value);
    if (!Array.isArray(v) || v.length !== 4 || v[0] !== 'journal_lines' || v[1] !== revision || v[3] !== journalScope(journalRevision) || integer(v[2], 25, 1000) % 25 !== 0 || JSON.stringify(v) !== value) return invalidQuery();
    return v[2] as number;
  } catch { return invalidQuery(); }
}
export function validateUsFinancialPilotAccountingContextQuery(value: unknown): UsFinancialPilotAccountingContextQuery {
  try { const v = fields(snapshotPrivateJson(value), ['revision']); return Object.freeze({ revision: integer(v.revision, 1) }); } catch { return invalidQuery(); }
}
export function validateUsFinancialPilotJournalDetailQuery(value: unknown): UsFinancialPilotJournalDetailQuery {
  try {
    const v = fields(snapshotPrivateJson(value), ['revision', 'journalRevision'], ['lineCursor']), revision = integer(v.revision, 1), journalRevision = integer(v.journalRevision, 1), lineCursor = v.lineCursor === undefined || v.lineCursor === null ? null : text(v.lineCursor, 512);
    financialPilotJournalLinesCursorOffset(lineCursor, revision, journalRevision); return Object.freeze({ revision, journalRevision, lineCursor });
  } catch { return invalidQuery(); }
}
export function validateUsFinancialPilotPeriodDetailQuery(value: unknown): UsFinancialPilotPeriodDetailQuery {
  try { const v = fields(snapshotPrivateJson(value), ['revision', 'periodId']); return Object.freeze({ revision: integer(v.revision, 1), periodId: text(v.periodId) }); } catch { return invalidQuery(); }
}
export function validateUsFinancialPilotAccountingContext(value: unknown, organizationId?: string, revision?: number): UsFinancialPilotAccountingContext {
  return protect(() => {
    const v = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'accounts', 'periodCount', 'latestPeriodEnd', 'earliestOpenPeriod']), h = head(v, organizationId, revision), ledgerRevision = ledger(v.ledgerRevision, h);
    if (!Array.isArray(v.accounts) || v.accounts.length > 25) return invalid();
    const accounts = Object.freeze(v.accounts.map(account)), eligible = usStarterChart.filter(row => !US_MANUAL_EXCLUDED_ACCOUNTS.includes(row.id));
    if (accounts.length !== eligible.length || new Set(accounts.map(row => row.accountId)).size !== accounts.length || new Set(accounts.map(row => row.code)).size !== accounts.length || accounts.some(row => US_MANUAL_EXCLUDED_ACCOUNTS.includes(row.accountId))) return invalid();
    const periodCount = integer(v.periodCount, 0, 100), latestPeriodEnd = v.latestPeriodEnd === null ? null : date(v.latestPeriodEnd), earliestOpenPeriod = v.earliestOpenPeriod === null ? null : period(v.earliestOpenPeriod, h, ledgerRevision);
    if ((periodCount === 0) !== (latestPeriodEnd === null) || (earliestOpenPeriod !== null && (periodCount === 0 || earliestOpenPeriod.status !== 'open' || latestPeriodEnd === null || earliestOpenPeriod.end > latestPeriodEnd))) return invalid();
    return Object.freeze({ ...h, ledgerRevision, accounts, periodCount, latestPeriodEnd, earliestOpenPeriod });
  });
}
export function validateUsFinancialPilotJournalLinesPage(value: unknown, organizationId?: string, revision?: number, journalRevision?: number, lineCursor?: string | null): UsFinancialPilotJournalLinesPage {
  return protect(() => {
    const v = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'kind', 'scope', 'total', 'items', 'nextCursor']), h = head(v, organizationId, revision), ledgerRevision = ledger(v.ledgerRevision, h), scope = text(v.scope);
    if (v.kind !== 'journal_lines' || !/^journal:[1-9][0-9]*$/.test(scope)) return invalid();
    const target = integer(Number(scope.slice(8)), 1, ledgerRevision);
    if (scope !== journalScope(target) || (journalRevision !== undefined && target !== journalRevision)) return invalid();
    const total = integer(v.total, 2, 1000);
    if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > US_FINANCIAL_PILOT_PAGE_SIZE) return invalid();
    const items = Object.freeze(v.items.map(raw => {
      const row = fields(raw, ['ordinal', 'account', 'debitMinor', 'creditMinor', 'description']), debitMinor = amount(row.debitMinor), creditMinor = amount(row.creditMinor);
      if ((debitMinor === '0') === (creditMinor === '0')) return invalid();
      return Object.freeze({ ordinal: integer(row.ordinal, 1, total), account: account(row.account), debitMinor, creditMinor, description: row.description === null ? null : text(row.description, 2000) });
    }));
    const offset = items[0].ordinal - 1;
    if (offset % 25 !== 0 || items.length !== Math.min(25, total - offset) || items.some((row, index) => row.ordinal !== offset + index + 1) || (lineCursor !== undefined && financialPilotJournalLinesCursorOffset(lineCursor, h.revision, target) !== offset)) return invalid();
    const nextCursor = v.nextCursor === null ? null : text(v.nextCursor, 512), expectedNext = offset + items.length < total ? financialPilotJournalLinesCursor(h.revision, offset + 25, target) : null;
    if (nextCursor !== expectedNext) return invalid();
    return Object.freeze({ ...h, ledgerRevision, kind: 'journal_lines', scope, total, items, nextCursor });
  });
}
export function validateUsFinancialPilotJournalDetail(value: unknown, organizationId?: string, revision?: number, journalRevision?: number, lineCursor?: string | null): UsFinancialPilotJournalDetail {
  return protect(() => {
    const v = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'journal', 'cashFlowCategory', 'lineCount', 'lines', 'canReverse']), h = head(v, organizationId, revision), ledgerRevision = ledger(v.ledgerRevision, h), row = journal(v.journal, h, ledgerRevision);
    if (journalRevision !== undefined && row.journalRevision !== journalRevision) return invalid();
    const cashFlowCategory = v.cashFlowCategory === null ? null : v.cashFlowCategory === 'operating' || v.cashFlowCategory === 'investing' || v.cashFlowCategory === 'financing' ? v.cashFlowCategory : invalid();
    const lineCount = integer(v.lineCount, 2, 1000), lines = validateUsFinancialPilotJournalLinesPage(v.lines, h.organizationId, h.revision, row.journalRevision, lineCursor), canReverse = boolean(v.canReverse);
    if (lines.ledgerRevision !== ledgerRevision || lines.total !== lineCount || canReverse !== (row.source.kind === 'manual_journal' && row.reversedByJournalRevision === null)) return invalid();
    const debit = lines.items.reduce((n, line) => n + BigInt(line.debitMinor), BigInt(0)), credit = lines.items.reduce((n, line) => n + BigInt(line.creditMinor), BigInt(0));
    if (debit > BigInt(row.debitMinor) || credit > BigInt(row.creditMinor) || (lines.items.length === lineCount && (debit.toString() !== row.debitMinor || credit.toString() !== row.creditMinor))) return invalid();
    const cashMovement = lines.items.reduce((n, line) => n + (line.account.cash ? BigInt(line.debitMinor) - BigInt(line.creditMinor) : BigInt(0)), BigInt(0));
    if (lines.items.length === lineCount && cashMovement !== BigInt(0) && cashFlowCategory === null) return invalid();
    return Object.freeze({ ...h, ledgerRevision, journal: row, cashFlowCategory, lineCount, lines, canReverse });
  });
}
export function validateUsFinancialPilotPeriodDetail(value: unknown, organizationId?: string, revision?: number, periodId?: string): UsFinancialPilotPeriodDetail {
  return protect(() => {
    const v = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'period', 'earliestOpenPeriod', 'canClose']), h = head(v, organizationId, revision), ledgerRevision = ledger(v.ledgerRevision, h), target = period(v.period, h, ledgerRevision), earliestOpenPeriod = v.earliestOpenPeriod === null ? null : period(v.earliestOpenPeriod, h, ledgerRevision), canClose = boolean(v.canClose);
    if ((periodId !== undefined && target.id !== periodId) || (earliestOpenPeriod !== null && (earliestOpenPeriod.status !== 'open' || (target.status === 'open' && earliestOpenPeriod.start > target.start) || (earliestOpenPeriod.id === target.id && (earliestOpenPeriod.start !== target.start || earliestOpenPeriod.end !== target.end || target.status !== 'open')))) || (target.status === 'open' && earliestOpenPeriod === null) || canClose !== (target.status === 'open' && target.id === earliestOpenPeriod?.id)) return invalid();
    return Object.freeze({ ...h, ledgerRevision, period: target, earliestOpenPeriod, canClose });
  });
}
function earliestOpenPeriod(view: UsFinancialBookViewV5): UsFinancialPilotPeriodRow | null { return [...view.ledger.periods].filter(row => row.status === 'open').sort((a, b) => compare(a.start, b.start) || compare(a.id, b.id))[0] ?? null; }
function publicJournal(view: UsFinancialBookViewV5, entry: PostedJournal): UsFinancialPilotJournalRow {
  return { journalRevision: entry.revision, transactionDate: entry.transactionDate, accountingDate: entry.accountingDate, paymentDate: entry.paymentDate ?? null, periodId: entry.periodId, description: entry.description,
    debitMinor: entry.lines.reduce((n, line) => n + BigInt(line.debitMinor), BigInt(0)).toString(), creditMinor: entry.lines.reduce((n, line) => n + BigInt(line.creditMinor), BigInt(0)).toString(), postedBy: entry.postedBy, postedAt: entry.postedAt, source: financialPilotPublicSource(view, entry),
    reversesJournalRevision: entry.reversesEntryId ? view.ledger.entries.find(row => row.id === entry.reversesEntryId)?.revision ?? invalid() : null, reversedByJournalRevision: view.ledger.entries.find(row => row.reversesEntryId === entry.id)?.revision ?? null };
}
/** Capture selectors and the private book before awaiting the shared true-V5 replay. */
export async function projectUsFinancialPilotAccountingContext(input: unknown, queryInput: UsFinancialPilotAccountingContextQuery): Promise<UsFinancialPilotAccountingContext> {
  const query = validateUsFinancialPilotAccountingContextQuery(queryInput), view = await readUsFinancialPilotView(input, query.revision);
  return validateUsFinancialPilotAccountingContext({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, accounts: view.ledger.accounts.filter(row => !US_MANUAL_EXCLUDED_ACCOUNTS.includes(row.id)).map(publicAccount), periodCount: view.ledger.periods.length,
    latestPeriodEnd: [...view.ledger.periods].sort((a, b) => compare(b.end, a.end))[0]?.end ?? null, earliestOpenPeriod: earliestOpenPeriod(view) }, view.organizationId, view.revision);
}
export async function projectUsFinancialPilotJournal(input: unknown, queryInput: UsFinancialPilotJournalDetailQuery): Promise<UsFinancialPilotJournalDetail> {
  const query = validateUsFinancialPilotJournalDetailQuery(queryInput), view = await readUsFinancialPilotView(input, query.revision), entry = view.ledger.entries.find(row => row.revision === query.journalRevision);
  if (!entry) throw new UsFinancialPilotError('financial_pilot_record_not_found', 404);
  const offset = financialPilotJournalLinesCursorOffset(query.lineCursor, view.revision, entry.revision);
  if (offset >= entry.lines.length) return invalidQuery();
  const accounts = new Map(view.ledger.accounts.map(row => [row.id, row]));
  const lines = entry.lines.slice(offset, offset + 25).map((line, index) => ({ ordinal: offset + index + 1, account: publicAccount(accounts.get(line.accountId) ?? invalid()), debitMinor: line.debitMinor, creditMinor: line.creditMinor, description: line.description ?? null }));
  const row = publicJournal(view, entry);
  return validateUsFinancialPilotJournalDetail({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, journal: row, cashFlowCategory: entry.cashFlowCategory ?? null, lineCount: entry.lines.length,
    lines: { ...financialPilotHead(view), ledgerRevision: view.ledger.revision, kind: 'journal_lines', scope: journalScope(entry.revision), total: entry.lines.length, items: lines, nextCursor: offset + 25 < entry.lines.length ? financialPilotJournalLinesCursor(view.revision, offset + 25, entry.revision) : null }, canReverse: row.source.kind === 'manual_journal' && row.reversedByJournalRevision === null }, view.organizationId, view.revision, entry.revision, query.lineCursor);
}
export async function projectUsFinancialPilotPeriod(input: unknown, queryInput: UsFinancialPilotPeriodDetailQuery): Promise<UsFinancialPilotPeriodDetail> {
  const query = validateUsFinancialPilotPeriodDetailQuery(queryInput), view = await readUsFinancialPilotView(input, query.revision), target = view.ledger.periods.find(row => row.id === query.periodId);
  if (!target) throw new UsFinancialPilotError('financial_pilot_record_not_found', 404);
  const oldest = earliestOpenPeriod(view);
  return validateUsFinancialPilotPeriodDetail({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, period: target, earliestOpenPeriod: oldest, canClose: target.status === 'open' && target.id === oldest?.id }, view.organizationId, view.revision, target.id);
}
