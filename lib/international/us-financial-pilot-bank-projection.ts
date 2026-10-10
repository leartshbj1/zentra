import { validDate } from './accounting/ledger';
import { reconciliationStatus } from './accounting/reconciliation';
import { usStarterChart } from './countries/us/accounting';
import { ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { projectUsFinancialBookV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialBookViewV5 } from './us-financial-kernel-types';
import { financialPilotPublicSource } from './us-financial-pilot-projection';
import type { UsFinancialPilotSource } from './us-financial-pilot-contract';
import {
  US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES, validateUsFinancialPilotBankHead, validateUsFinancialPilotBankHistory, validateUsFinancialPilotBankRegister,
  type UsFinancialPilotBankHead, type UsFinancialPilotBankOrigin, type UsFinancialPilotBankRecord, type UsFinancialPilotBankRegister,
} from './us-financial-pilot-bank';

export type UsFinancialPilotBankPageKind = 'bank_statements' | 'bank_lines' | 'bank_matches' | 'bank_movements';
export interface UsFinancialPilotBankQuery { readonly revision: number; readonly bankRevision: number }
export interface UsFinancialPilotBankListQuery extends UsFinancialPilotBankQuery { readonly cursor?: string | null }
export interface UsFinancialPilotBankDetailQuery extends UsFinancialPilotBankQuery { readonly statementId: string; readonly origin: UsFinancialPilotBankOrigin; readonly lineCursor?: string | null; readonly matchCursor?: string | null }
export interface UsFinancialPilotBankMovementQuery extends UsFinancialPilotBankQuery { readonly statementId: string; readonly origin: UsFinancialPilotBankOrigin; readonly cursor?: string | null }
export interface UsFinancialPilotBankAccount { readonly accountId: string; readonly code: string; readonly name: string }
export interface UsFinancialPilotBankContext extends UsFinancialPilotBankHead {
  readonly ledgerRevision: number; readonly accounts: readonly UsFinancialPilotBankAccount[]; readonly statementCount: number;
  readonly legacyPending: readonly Readonly<{ statementId: string; cashAccountId: string }>[];
}
export interface UsFinancialPilotBankCompletion {
  readonly completedAt: string; readonly completedBy: string; readonly ledgerRevision: number;
  readonly source: Readonly<{ revision: number; ledgerRevision: number }> | null;
}
export interface UsFinancialPilotBankStatementSummary {
  readonly origin: UsFinancialPilotBankOrigin; readonly statementId: string; readonly statementRevision: number; readonly cashAccountId: string;
  readonly start: string; readonly end: string; readonly openingMinor: string; readonly closingMinor: string; readonly lineCount: number; readonly matchCount: number;
  readonly state: 'open' | 'completed' | 'voided'; readonly createdBy: string; readonly createdAt: string;
  readonly completion: UsFinancialPilotBankCompletion | null; readonly voided: Readonly<{ by: string; at: string; reason: string }> | null;
}
export interface UsFinancialPilotBankPage<T> extends UsFinancialPilotBankHead {
  readonly ledgerRevision: number; readonly kind: UsFinancialPilotBankPageKind; readonly origin: UsFinancialPilotBankOrigin | null; readonly statementId: string | null;
  readonly total: number; readonly items: readonly T[]; readonly nextCursor: string | null;
}
export type UsFinancialPilotBankStatementsPage = UsFinancialPilotBankPage<UsFinancialPilotBankStatementSummary>;
export interface UsFinancialPilotBankLine { readonly ordinal: number; readonly lineId: string; readonly date: string; readonly amountMinor: string; readonly reference: string; readonly matchId: string | null }
export interface UsFinancialPilotBankMatch { readonly matchId: string; readonly statementLineIds: readonly string[]; readonly journalRevisions: readonly number[]; readonly amountMinor: string; readonly approvedBy: string; readonly approvedAt: string; readonly sourceRevision: number | null }
export interface UsFinancialPilotBankEvaluation { readonly outstandingLineCount: number; readonly unmatchedMovementCount: number; readonly beginningDifferenceMinor: string; readonly endingDifferenceMinor: string; readonly ready: boolean }
export interface UsFinancialPilotBankStatementDetail extends UsFinancialPilotBankHead {
  readonly ledgerRevision: number; readonly statement: UsFinancialPilotBankStatementSummary;
  readonly lines: UsFinancialPilotBankPage<UsFinancialPilotBankLine>; readonly matches: UsFinancialPilotBankPage<UsFinancialPilotBankMatch>;
  readonly current: UsFinancialPilotBankEvaluation | null; readonly cashChangedSinceCompletion: boolean | null;
}
export interface UsFinancialPilotBankMovement {
  readonly journalRevision: number; readonly transactionDate: string; readonly accountingDate: string; readonly paymentDate: string | null; readonly bankDate: string;
  readonly amountMinor: string; readonly description: string; readonly source: UsFinancialPilotSource; readonly status: 'available' | 'matched' | 'claimed_elsewhere';
}
export type UsFinancialPilotBankMovementsPage = UsFinancialPilotBankPage<UsFinancialPilotBankMovement>;

const fail = (code = 'invalid_financial_bank_data', status = 503): never => { throw new ErpError(code, status); };
const queryError = (): never => fail('invalid_financial_pilot_query', 422);
function fields(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(k => !Object.hasOwn(value, k)) || Reflect.ownKeys(value).some(k => typeof k !== 'string' || ![...keys, ...optional].includes(k))) return fail(); return value as Record<string, unknown>; }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER - 1): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(); return value; }
function text(value: unknown, max = 160): string { if (typeof value !== 'string' || !value.trim() || value.length > max || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail(); return value; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return fail(); return value; }
function origin(value: unknown): UsFinancialPilotBankOrigin { if (value !== 'legacy-frozen' && value !== 'financial-v5') return fail(); return value; }
function date(value: unknown): string { if (typeof value !== 'string' || value.startsWith('0000-') || !validDate(value)) return fail(); return value; }
function instant(value: unknown): string { const t = text(value, 64); parseInstant(t); return t; }
function amount(value: unknown, max = 36): string { if (typeof value !== 'string' || !new RegExp(`^(?:0|-?[1-9][0-9]{0,${max - 1}})$`).test(value)) return fail(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value; }
function snapshot(value: unknown): unknown { try { const data = snapshotPrivateJson(value); if (new TextEncoder().encode(JSON.stringify(data)).byteLength > US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES) return fail(); return data; } catch { return fail(); } }
function protect<T>(operation: () => T): T { try { return operation(); } catch { return fail(); } }
function query(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> { try { return fields(snapshotPrivateJson(value), ['revision', 'bankRevision', ...required], optional); } catch { return queryError(); } }
function queryHeads(v: Record<string, unknown>): UsFinancialPilotBankQuery { return { revision: integer(v.revision, 1), bankRevision: integer(v.bankRevision, 0, 1000) }; }
function cursorValue(value: unknown): string | null { return value === undefined || value === null ? null : text(value, 512); }
export function validateUsFinancialPilotBankQuery(value: unknown): UsFinancialPilotBankQuery { try { return Object.freeze(queryHeads(query(value, [], []))); } catch { return queryError(); } }
export function validateUsFinancialPilotBankListQuery(value: unknown): UsFinancialPilotBankListQuery { try { const v = query(value, [], ['cursor']); return Object.freeze({ ...queryHeads(v), cursor: cursorValue(v.cursor) }); } catch { return queryError(); } }
export function validateUsFinancialPilotBankDetailQuery(value: unknown): UsFinancialPilotBankDetailQuery { try { const v = query(value, ['statementId', 'origin'], ['lineCursor', 'matchCursor']); return Object.freeze({ ...queryHeads(v), statementId: uuid(v.statementId), origin: origin(v.origin), lineCursor: cursorValue(v.lineCursor), matchCursor: cursorValue(v.matchCursor) }); } catch { return queryError(); } }
export function validateUsFinancialPilotBankMovementQuery(value: unknown): UsFinancialPilotBankMovementQuery { try { const v = query(value, ['statementId', 'origin'], ['cursor']); return Object.freeze({ ...queryHeads(v), statementId: uuid(v.statementId), origin: origin(v.origin), cursor: cursorValue(v.cursor) }); } catch { return queryError(); } }

export function financialPilotBankCursor(kind: UsFinancialPilotBankPageKind, organizationId: string, revision: number, bankRevision: number, offset: number, rowOrigin: UsFinancialPilotBankOrigin | null = null, statementId: string | null = null): string {
  const value = JSON.stringify([kind, organizationId, revision, bankRevision, rowOrigin, statementId, offset]); financialPilotBankCursorOffset(value, kind, organizationId, revision, bankRevision, rowOrigin, statementId); return value;
}
export function financialPilotBankCursorOffset(value: string | null | undefined, kind: UsFinancialPilotBankPageKind, organizationId: string, revision: number, bankRevision: number, rowOrigin: UsFinancialPilotBankOrigin | null = null, statementId: string | null = null): number {
  try {
    if (!['bank_statements', 'bank_lines', 'bank_matches', 'bank_movements'].includes(kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) return queryError();
    integer(revision, 1); integer(bankRevision, 0, 1000);
    if (kind === 'bank_statements' ? rowOrigin !== null || statementId !== null : rowOrigin === null || statementId === null) return queryError();
    if (rowOrigin !== null) origin(rowOrigin); if (statementId !== null) uuid(statementId);
    if (value == null) return 0;
    const tuple: unknown = JSON.parse(value); if (typeof value !== 'string' || value.length > 512 || !Array.isArray(tuple) || tuple.length !== 7 || JSON.stringify(tuple) !== value || tuple[0] !== kind || tuple[1] !== organizationId || tuple[2] !== revision || tuple[3] !== bankRevision || tuple[4] !== rowOrigin || tuple[5] !== statementId) return queryError();
    const offset = integer(tuple[6], 0, 1000); if (offset % 25 !== 0) return queryError(); return offset;
  } catch { return queryError(); }
}
function h(value: Record<string, unknown>, organizationId?: string, expected?: UsFinancialPilotBankQuery): UsFinancialPilotBankHead {
  const head = validateUsFinancialPilotBankHead({ consumer: value.consumer, schemaVersion: value.schemaVersion, organizationId: value.organizationId, revision: value.revision, bankRevision: value.bankRevision }, organizationId);
  if (expected && (head.revision !== expected.revision || head.bankRevision !== expected.bankRevision)) return fail(); return head;
}
function summary(value: unknown, head: UsFinancialPilotBankHead, ledgerRevision: number): UsFinancialPilotBankStatementSummary {
  const r = fields(value, ['origin', 'statementId', 'statementRevision', 'cashAccountId', 'start', 'end', 'openingMinor', 'closingMinor', 'lineCount', 'matchCount', 'state', 'createdBy', 'createdAt', 'completion', 'voided']);
  const rowOrigin = origin(r.origin), start = date(r.start), end = date(r.end), statementRevision = integer(r.statementRevision), lineCount = integer(r.lineCount, 0, 1000), matchCount = integer(r.matchCount, 0, 1000);
  if (start > end || !['open', 'completed', 'voided'].includes(r.state as string) || !usStarterChart.some(a => a.cash && a.id === r.cashAccountId)) return fail();
  let completion: UsFinancialPilotBankCompletion | null = null;
  if (r.completion !== null) { const c = fields(r.completion, ['completedAt', 'completedBy', 'ledgerRevision', 'source']); let source: UsFinancialPilotBankCompletion['source'] = null; if (c.source !== null) { const s = fields(c.source, ['revision', 'ledgerRevision']); source = Object.freeze({ revision: integer(s.revision, 1, head.revision), ledgerRevision: integer(s.ledgerRevision, 0, ledgerRevision) }); if (source.ledgerRevision !== c.ledgerRevision) return fail(); } if ((rowOrigin === 'legacy-frozen') !== (source === null)) return fail(); completion = Object.freeze({ completedAt: instant(c.completedAt), completedBy: text(c.completedBy, 256), ledgerRevision: integer(c.ledgerRevision, 0, ledgerRevision), source }); }
  let voided: UsFinancialPilotBankStatementSummary['voided'] = null;
  if (r.voided !== null) { const v = fields(r.voided, ['by', 'at', 'reason']); voided = Object.freeze({ by: text(v.by, 256), at: instant(v.at), reason: text(v.reason, 2000) }); }
  if ((r.state === 'completed') !== (completion !== null) || (r.state === 'voided') !== (voided !== null) || (completion && voided) || (voided && matchCount !== 0) || statementRevision !== matchCount + (completion ? 1 : 0) + (voided ? 1 : 0) || matchCount > lineCount) return fail();
  const createdAt = instant(r.createdAt); if ((completion && Date.parse(completion.completedAt) < Date.parse(createdAt)) || (voided && Date.parse(voided.at) < Date.parse(createdAt))) return fail();
  return Object.freeze({ origin: rowOrigin, statementId: uuid(r.statementId), statementRevision, cashAccountId: text(r.cashAccountId), start, end, openingMinor: amount(r.openingMinor), closingMinor: amount(r.closingMinor), lineCount, matchCount, state: r.state as UsFinancialPilotBankStatementSummary['state'], createdBy: text(r.createdBy, 256), createdAt, completion, voided });
}
function page<T>(value: unknown, kind: UsFinancialPilotBankPageKind, organizationId: string | undefined, expected: UsFinancialPilotBankQuery | undefined, rowOrigin: UsFinancialPilotBankOrigin | null, statementId: string | null, cursor: string | null | undefined, row: (value: unknown, head: UsFinancialPilotBankHead, ledgerRevision: number) => T, max: number): UsFinancialPilotBankPage<T> {
  const p = fields(value, ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision', 'ledgerRevision', 'kind', 'origin', 'statementId', 'total', 'items', 'nextCursor']), head = h(p, organizationId, expected), ledgerRevision = integer(p.ledgerRevision, 0, head.revision), total = integer(p.total, 0, max);
  if (p.kind !== kind || p.origin !== rowOrigin || p.statementId !== statementId || !Array.isArray(p.items)) return fail();
  const offset = financialPilotBankCursorOffset(cursor, kind, head.organizationId, head.revision, head.bankRevision, rowOrigin, statementId);
  if (offset > 0 && offset >= total || p.items.length !== Math.min(25, Math.max(0, total - offset))) return fail();
  const items = Object.freeze(p.items.map(value => row(value, head, ledgerRevision))), nextCursor = offset + items.length < total ? financialPilotBankCursor(kind, head.organizationId, head.revision, head.bankRevision, offset + 25, rowOrigin, statementId) : null;
  if (p.nextCursor !== nextCursor) return fail(); return Object.freeze({ ...head, ledgerRevision, kind, origin: rowOrigin, statementId, total, items, nextCursor });
}
export function validateUsFinancialPilotBankContext(value: unknown, organizationId?: string, expected?: UsFinancialPilotBankQuery): UsFinancialPilotBankContext {
  return protect(() => { const v = fields(snapshot(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision', 'ledgerRevision', 'accounts', 'statementCount', 'legacyPending']), head = h(v, organizationId, expected), ledgerRevision = integer(v.ledgerRevision, 0, head.revision), statementCount = integer(v.statementCount, 0, 100);
    if (!Array.isArray(v.accounts) || !Array.isArray(v.legacyPending) || v.legacyPending.length > statementCount) return fail();
    const accounts = v.accounts.map(raw => { const a = fields(raw, ['accountId', 'code', 'name']), chart = usStarterChart.find(c => c.cash && c.id === a.accountId); if (!chart || a.code !== chart.code || a.name !== chart.name) return fail(); return Object.freeze({ accountId: chart.id, code: chart.code, name: chart.name }); });
    if (accounts.length !== usStarterChart.filter(c => c.cash).length || new Set(accounts.map(a => a.accountId)).size !== accounts.length) return fail();
    const legacyPending = v.legacyPending.map(raw => { const b = fields(raw, ['statementId', 'cashAccountId']); if (!accounts.some(a => a.accountId === b.cashAccountId)) return fail(); return Object.freeze({ statementId: uuid(b.statementId), cashAccountId: text(b.cashAccountId) }); });
    if (new Set(legacyPending.map(b => b.statementId)).size !== legacyPending.length) return fail(); return Object.freeze({ ...head, ledgerRevision, accounts: Object.freeze(accounts), statementCount, legacyPending: Object.freeze(legacyPending) }); });
}
export function validateUsFinancialPilotBankStatementsPage(value: unknown, organizationId?: string, expected?: UsFinancialPilotBankListQuery): UsFinancialPilotBankStatementsPage {
  return protect(() => { const p = page(snapshot(value), 'bank_statements', organizationId, expected, null, null, expected?.cursor, summary, 100); if (new Set(p.items.map(r => r.statementId)).size !== p.items.length || p.items.some((r, i) => i > 0 && (r.createdAt > p.items[i - 1].createdAt || (r.createdAt === p.items[i - 1].createdAt && r.statementId < p.items[i - 1].statementId)))) return fail(); return p; });
}
function evaluation(value: unknown): UsFinancialPilotBankEvaluation {
  const e = fields(value, ['outstandingLineCount', 'unmatchedMovementCount', 'beginningDifferenceMinor', 'endingDifferenceMinor', 'ready']), outstandingLineCount = integer(e.outstandingLineCount, 0, 1000), unmatchedMovementCount = integer(e.unmatchedMovementCount, 0, 1000), beginningDifferenceMinor = amount(e.beginningDifferenceMinor, 48), endingDifferenceMinor = amount(e.endingDifferenceMinor, 48), ready = boolean(e.ready);
  if (ready !== (outstandingLineCount === 0 && unmatchedMovementCount === 0 && beginningDifferenceMinor === '0' && endingDifferenceMinor === '0')) return fail(); return Object.freeze({ outstandingLineCount, unmatchedMovementCount, beginningDifferenceMinor, endingDifferenceMinor, ready });
}
export function validateUsFinancialPilotBankStatementDetail(value: unknown, organizationId?: string, expected?: UsFinancialPilotBankDetailQuery): UsFinancialPilotBankStatementDetail {
  return protect(() => { const v = fields(snapshot(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision', 'ledgerRevision', 'statement', 'lines', 'matches', 'current', 'cashChangedSinceCompletion']), head = h(v, organizationId, expected), ledgerRevision = integer(v.ledgerRevision, 0, head.revision), statement = summary(v.statement, head, ledgerRevision);
    if (expected && (statement.statementId !== expected.statementId || statement.origin !== expected.origin)) return fail();
    const lines = page(v.lines, 'bank_lines', head.organizationId, head, statement.origin, statement.statementId, expected?.lineCursor, raw => { const l = fields(raw, ['ordinal', 'lineId', 'date', 'amountMinor', 'reference', 'matchId']), d = date(l.date), amountMinor = amount(l.amountMinor); if (d < statement.start || d > statement.end || amountMinor === '0') return fail(); return Object.freeze({ ordinal: integer(l.ordinal, 1, statement.lineCount), lineId: text(l.lineId), date: d, amountMinor, reference: text(l.reference, 256), matchId: l.matchId === null ? null : uuid(l.matchId) }); }, 1000);
    const matches = page(v.matches, 'bank_matches', head.organizationId, head, statement.origin, statement.statementId, expected?.matchCursor, raw => { const m = fields(raw, ['matchId', 'statementLineIds', 'journalRevisions', 'amountMinor', 'approvedBy', 'approvedAt', 'sourceRevision']); if (!Array.isArray(m.statementLineIds) || !m.statementLineIds.length || m.statementLineIds.length > 1000 || !Array.isArray(m.journalRevisions) || !m.journalRevisions.length || m.journalRevisions.length > 1000) return fail(); const ids = m.statementLineIds.map(id => text(id)), revisions = m.journalRevisions.map(r => integer(r, 1, ledgerRevision)); if (ids.some((id, i) => i > 0 && id <= ids[i - 1]) || revisions.some((r, i) => i > 0 && r <= revisions[i - 1])) return fail(); const sourceRevision = m.sourceRevision === null ? null : integer(m.sourceRevision, 1, head.revision); if ((statement.origin === 'legacy-frozen') !== (sourceRevision === null)) return fail(); return Object.freeze({ matchId: uuid(m.matchId), statementLineIds: Object.freeze(ids), journalRevisions: Object.freeze(revisions), amountMinor: amount(m.amountMinor, 48), approvedBy: text(m.approvedBy, 256), approvedAt: instant(m.approvedAt), sourceRevision }); }, 1000);
    const offset = financialPilotBankCursorOffset(expected?.lineCursor, 'bank_lines', head.organizationId, head.revision, head.bankRevision, statement.origin, statement.statementId);
    if (lines.ledgerRevision !== ledgerRevision || matches.ledgerRevision !== ledgerRevision || lines.total !== statement.lineCount || matches.total !== statement.matchCount || lines.items.some((l, i) => l.ordinal !== offset + i + 1) || new Set(lines.items.map(l => l.lineId)).size !== lines.items.length || new Set(matches.items.map(m => m.matchId)).size !== matches.items.length) return fail();
    if (statement.origin === 'financial-v5' && lines.items.some(l => l.lineId !== `${statement.statementId}:${l.ordinal}`)) return fail();
    if (lines.items.length === lines.total && matches.items.length === matches.total) {
      const claimed = new Set<string>();
      for (const m of matches.items) {
        if (Date.parse(m.approvedAt) < Date.parse(statement.createdAt) || statement.completion && Date.parse(m.approvedAt) > Date.parse(statement.completion.completedAt)) return fail();
        let sum = BigInt(0);
        for (const lineId of m.statementLineIds) { const l = lines.items.find(l => l.lineId === lineId); if (!l || claimed.has(lineId) || l.matchId !== m.matchId) return fail(); claimed.add(lineId); sum += BigInt(l.amountMinor); }
        if (sum.toString() !== m.amountMinor) return fail();
      }
      if (lines.items.some(l => (l.matchId !== null) !== claimed.has(l.lineId))) return fail();
    }
    if (lines.items.length === lines.total && BigInt(statement.openingMinor) + lines.items.reduce((n, l) => n + BigInt(l.amountMinor), BigInt(0)) !== BigInt(statement.closingMinor)) return fail();
    const current = v.current === null ? null : evaluation(v.current), changed = v.cashChangedSinceCompletion === null ? null : boolean(v.cashChangedSinceCompletion);
    if ((statement.origin === 'legacy-frozen') !== (current === null) || changed !== (statement.origin === 'legacy-frozen' || statement.completion === null ? null : !current!.ready) || (current && current.outstandingLineCount > statement.lineCount)) return fail();
    return Object.freeze({ ...head, ledgerRevision, statement, lines, matches, current, cashChangedSinceCompletion: changed }); });
}
export function validateUsFinancialPilotBankMovementsPage(value: unknown, organizationId?: string, expected?: UsFinancialPilotBankMovementQuery): UsFinancialPilotBankMovementsPage {
  return protect(() => { const v = fields(snapshot(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision', 'ledgerRevision', 'kind', 'origin', 'statementId', 'total', 'items', 'nextCursor']), rowOrigin = origin(v.origin), statementId = uuid(v.statementId); if (rowOrigin !== 'financial-v5' || expected && (expected.origin !== rowOrigin || expected.statementId !== statementId)) return fail();
    const p = page(v, 'bank_movements', organizationId, expected, rowOrigin, statementId, expected?.cursor, (raw, _head, ledgerRevision) => { const m = fields(raw, ['journalRevision', 'transactionDate', 'accountingDate', 'paymentDate', 'bankDate', 'amountMinor', 'description', 'source', 'status']), transactionDate = date(m.transactionDate), paymentDate = m.paymentDate === null ? null : date(m.paymentDate), amountMinor = amount(m.amountMinor, 48), s = fields(m.source, ['kind', 'entityId', 'reference', 'journalRevision']); if (m.bankDate !== (paymentDate ?? transactionDate) || amountMinor === '0' || !['available', 'matched', 'claimed_elsewhere'].includes(m.status as string) || !['customer_invoice', 'customer_payment', 'customer_credit', 'vendor_bill', 'vendor_payment', 'manual_journal', 'manual_reversal', 'other'].includes(s.kind as string)) return fail(); const source: UsFinancialPilotSource = { kind: s.kind as UsFinancialPilotSource['kind'], entityId: s.entityId === null ? null : text(s.entityId, 256), reference: s.reference === null ? null : text(s.reference, 2000), journalRevision: s.journalRevision === null ? null : integer(s.journalRevision, 1, ledgerRevision) }; return Object.freeze({ journalRevision: integer(m.journalRevision, 1, ledgerRevision), transactionDate, accountingDate: date(m.accountingDate), paymentDate, bankDate: date(m.bankDate), amountMinor, description: text(m.description, 2000), source: Object.freeze(source), status: m.status as UsFinancialPilotBankMovement['status'] }); }, 1000);
    if (p.items.some((r, i) => i > 0 && r.journalRevision <= p.items[i - 1].journalRevision)) return fail();
    for (const m of p.items) {
      const s = m.source;
      if (['customer_invoice', 'customer_payment', 'customer_credit', 'vendor_bill', 'vendor_payment'].includes(s.kind)) { if (s.entityId === null || s.reference === null || s.journalRevision !== null) return fail(); }
      else if (s.kind === 'manual_journal') { if (s.entityId !== null || s.reference === null || s.journalRevision !== null) return fail(); }
      else if (s.kind === 'manual_reversal') { if (s.entityId !== null || s.reference !== null || s.journalRevision === null || s.journalRevision >= m.journalRevision) return fail(); }
      else if (s.entityId !== null || s.reference !== null || s.journalRevision !== null) return fail();
    }
    return p; });
}

async function read(bookInput: UsFinancialBookV5, registerInput: UsFinancialPilotBankRegister, expected: UsFinancialPilotBankQuery): Promise<{ view: UsFinancialBookViewV5; register: UsFinancialPilotBankRegister }> {
  const b = snapshotPrivateJson(bookInput), r = validateUsFinancialPilotBankRegister(registerInput), book = await validateUsFinancialBookV5(b, r.organizationId);
  if (book.revision !== expected.revision || r.bankRevision !== expected.bankRevision) return fail('financial_snapshot_changed', 409);
  const register = await validateUsFinancialPilotBankHistory(book, r), view = await projectUsFinancialBookV5(book); return { view, register };
}
function head(view: UsFinancialBookViewV5, register: UsFinancialPilotBankRegister): UsFinancialPilotBankHead { return { consumer: 'financial-pilot', schemaVersion: 1, organizationId: view.organizationId, revision: view.revision, bankRevision: register.bankRevision }; }
function publicSummary(row: UsFinancialPilotBankRecord, register: UsFinancialPilotBankRegister): UsFinancialPilotBankStatementSummary {
  const r = row.record, reconciliation = r.reconciliation, s = reconciliation.statement, complete = register.operations.find(p => p.statementId === s.id && p.action === 'complete');
  return { origin: row.origin, statementId: s.id, statementRevision: reconciliation.revision, cashAccountId: s.cashAccountId, start: s.start, end: s.end, openingMinor: s.opening.minorUnits, closingMinor: s.closing.minorUnits, lineCount: s.lines.length, matchCount: reconciliation.matches.length, state: r.voided ? 'voided' : reconciliation.completedAt ? 'completed' : 'open', createdBy: r.createdBy, createdAt: r.createdAt,
    completion: reconciliation.completedAt ? { completedAt: reconciliation.completedAt, completedBy: reconciliation.completedBy!, ledgerRevision: reconciliation.completedLedgerRevision!, source: row.origin === 'legacy-frozen' ? null : complete ? { revision: complete.source.revision, ledgerRevision: complete.source.ledgerRevision } : fail() } : null, voided: r.voided ?? null };
}
function makePage<T>(view: UsFinancialBookViewV5, register: UsFinancialPilotBankRegister, kind: UsFinancialPilotBankPageKind, items: readonly T[], cursor?: string | null, rowOrigin: UsFinancialPilotBankOrigin | null = null, statementId: string | null = null): UsFinancialPilotBankPage<T> {
  const offset = financialPilotBankCursorOffset(cursor, kind, view.organizationId, view.revision, register.bankRevision, rowOrigin, statementId); if (offset > 0 && offset >= items.length) return queryError();
  return { ...head(view, register), ledgerRevision: view.ledger.revision, kind, origin: rowOrigin, statementId, total: items.length, items: items.slice(offset, offset + 25), nextCursor: offset + 25 < items.length ? financialPilotBankCursor(kind, view.organizationId, view.revision, register.bankRevision, offset + 25, rowOrigin, statementId) : null };
}
function target(register: UsFinancialPilotBankRegister, statementId: string, rowOrigin: UsFinancialPilotBankOrigin): UsFinancialPilotBankRecord { return register.records.find(r => r.origin === rowOrigin && r.record.reconciliation.statement.id === statementId) ?? fail('reconciliation_not_found', 404); }
export async function projectUsFinancialPilotBankContext(book: UsFinancialBookV5, input: UsFinancialPilotBankRegister, queryInput: UsFinancialPilotBankQuery): Promise<UsFinancialPilotBankContext> {
  const q = validateUsFinancialPilotBankQuery(queryInput), { view, register } = await read(book, input, q);
  return validateUsFinancialPilotBankContext({ ...head(view, register), ledgerRevision: view.ledger.revision, accounts: view.ledger.accounts.filter(a => a.cash).map(a => ({ accountId: a.id, code: a.code, name: a.name })), statementCount: register.records.length,
    legacyPending: register.records.filter(r => r.origin === 'legacy-frozen' && !r.record.voided && !r.record.reconciliation.completedAt).map(r => ({ statementId: r.record.reconciliation.statement.id, cashAccountId: r.record.reconciliation.statement.cashAccountId })) }, view.organizationId, q);
}
export async function projectUsFinancialPilotBankList(book: UsFinancialBookV5, input: UsFinancialPilotBankRegister, queryInput: UsFinancialPilotBankListQuery): Promise<UsFinancialPilotBankStatementsPage> {
  const q = validateUsFinancialPilotBankListQuery(queryInput), { view, register } = await read(book, input, q), rows = register.records.map(r => publicSummary(r, register)).sort((a, b) => a.createdAt === b.createdAt ? a.statementId < b.statementId ? -1 : 1 : a.createdAt > b.createdAt ? -1 : 1);
  return validateUsFinancialPilotBankStatementsPage(makePage(view, register, 'bank_statements', rows, q.cursor), view.organizationId, q);
}
export async function projectUsFinancialPilotBankStatement(book: UsFinancialBookV5, input: UsFinancialPilotBankRegister, queryInput: UsFinancialPilotBankDetailQuery): Promise<UsFinancialPilotBankStatementDetail> {
  const q = validateUsFinancialPilotBankDetailQuery(queryInput), { view, register } = await read(book, input, q), row = target(register, q.statementId, q.origin), r = row.record.reconciliation, s = r.statement;
  const lines = s.lines.map((l, i) => ({ ordinal: i + 1, lineId: l.id, date: l.date, amountMinor: l.amount.minorUnits, reference: l.reference, matchId: r.matches.find(m => m.statementLineIds.includes(l.id))?.id ?? null }));
  const matches = r.matches.map(m => ({ matchId: m.id, statementLineIds: m.statementLineIds, journalRevisions: m.ledgerEntryIds.map(id => view.ledger.entries.find(e => e.id === id)?.revision ?? fail()).sort((a, b) => a - b), amountMinor: s.lines.filter(l => m.statementLineIds.includes(l.id)).reduce((n, l) => n + BigInt(l.amount.minorUnits), BigInt(0)).toString(), approvedBy: m.approvedBy, approvedAt: m.approvedAt, sourceRevision: row.origin === 'legacy-frozen' ? null : register.operations.find(p => p.request.requestId === m.id)?.source.revision ?? fail() }));
  const status = row.origin === 'legacy-frozen' ? null : reconciliationStatus(r, view.ledger), current = status ? { outstandingLineCount: status.outstandingStatementLineIds.length, unmatchedMovementCount: status.unmatchedBookEntryIds.length, beginningDifferenceMinor: status.beginningDifferenceMinor, endingDifferenceMinor: status.endingDifferenceMinor, ready: status.ready } : null;
  return validateUsFinancialPilotBankStatementDetail({ ...head(view, register), ledgerRevision: view.ledger.revision, statement: publicSummary(row, register), lines: makePage(view, register, 'bank_lines', lines, q.lineCursor, q.origin, q.statementId), matches: makePage(view, register, 'bank_matches', matches, q.matchCursor, q.origin, q.statementId), current, cashChangedSinceCompletion: row.origin === 'legacy-frozen' || !r.completedAt ? null : !current!.ready }, view.organizationId, q);
}
export async function projectUsFinancialPilotBankMovements(book: UsFinancialBookV5, input: UsFinancialPilotBankRegister, queryInput: UsFinancialPilotBankMovementQuery): Promise<UsFinancialPilotBankMovementsPage> {
  const q = validateUsFinancialPilotBankMovementQuery(queryInput), { view, register } = await read(book, input, q), row = target(register, q.statementId, q.origin); if (row.origin === 'legacy-frozen') return fail('bank_legacy_immutable', 409);
  const s = row.record.reconciliation.statement, items: UsFinancialPilotBankMovement[] = [];
  for (const e of view.ledger.entries) { const bankDate = e.paymentDate ?? e.transactionDate, movement = e.lines.filter(l => l.accountId === s.cashAccountId).reduce((n, l) => n + BigInt(l.debitMinor) - BigInt(l.creditMinor), BigInt(0)); if (bankDate < s.start || bankDate > s.end || movement === BigInt(0)) continue; const claim = register.records.find(r => !r.record.voided && r.record.reconciliation.matches.some(m => m.ledgerEntryIds.includes(e.id)));
    items.push({ journalRevision: e.revision, transactionDate: e.transactionDate, accountingDate: e.accountingDate, paymentDate: e.paymentDate ?? null, bankDate, amountMinor: movement.toString(), description: e.description, source: financialPilotPublicSource(view, e), status: claim ? claim.record.reconciliation.statement.id === s.id ? 'matched' : 'claimed_elsewhere' : 'available' }); }
  items.sort((a, b) => a.journalRevision - b.journalRevision); return validateUsFinancialPilotBankMovementsPage(makePage(view, register, 'bank_movements', items, q.cursor, q.origin, q.statementId), view.organizationId, q);
}
