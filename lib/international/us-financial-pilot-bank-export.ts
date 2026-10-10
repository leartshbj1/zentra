import { AccountPublicError } from '../account-security';
import { reconciliationStatus } from './accounting/reconciliation';
import { sha256Hex } from './canonical-hash';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { CompanyConfiguration, CompanyLanguage } from './types';
import { projectUsFinancialBookV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { UsFinancialPilotError } from './us-financial-pilot-contract';
import { financialPilotPublicSource } from './us-financial-pilot-projection';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import {
  assertUsFinancialPilotBankCapacity, validateUsFinancialPilotBankHead, validateUsFinancialPilotBankHistory, validateUsFinancialPilotBankRegister,
  type UsFinancialPilotBankPort, type UsFinancialPilotBankRead, type UsFinancialPilotBankRegister,
} from './us-financial-pilot-bank';
import {
  financialPilotBankCursor, validateUsFinancialPilotBankStatementDetail, validateUsFinancialPilotBankMovementsPage,
  type UsFinancialPilotBankStatementSummary, type UsFinancialPilotBankLine, type UsFinancialPilotBankMatch,
  type UsFinancialPilotBankMovement, type UsFinancialPilotBankEvaluation, type UsFinancialPilotBankPageKind,
} from './us-financial-pilot-bank-projection';
import type { UsFinancialPilotBankDependencies as UsFinancialPilotBankHttpDependencies } from './us-financial-pilot-bank-server';
import { financialPilotCsvDecimal as decimal, financialPilotCsvTextCell as textCell, financialPilotCsvQuoted as quoted } from './us-financial-pilot-csv';
import {
  BankInputError, validateUsFinancialPilotBankExportSelector, browserUsFinancialPilotBankExportUrl,
  US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES, US_FINANCIAL_PILOT_BANK_EXPORT_TIMEOUT_MS, US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS,
  type UsFinancialPilotBankExportSelector,
} from './browser-us-financial-pilot-bank-input';
import { browserUsFinancialPilotBankCopy } from './browser-us-financial-pilot-bank-copy';

export interface UsFinancialPilotBankExportSnapshot {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string;
  readonly revision: number; readonly bankRevision: number; readonly ledgerRevision: number;
  readonly currency: 'USD'; readonly language: CompanyLanguage; readonly selector: UsFinancialPilotBankExportSelector;
  readonly statement: UsFinancialPilotBankStatementSummary;
  readonly lines: readonly UsFinancialPilotBankLine[]; readonly matches: readonly UsFinancialPilotBankMatch[];
  readonly movements: readonly UsFinancialPilotBankMovement[] | null;
  readonly current: UsFinancialPilotBankEvaluation | null; readonly cashChangedSinceCompletion: boolean | null;
}
export type UsFinancialPilotBankExportDependencies = Pick<UsFinancialPilotBankHttpDependencies,
  'enabled' | 'authority' | 'configuration' | 'scope' | 'store' | 'rateLimit' | 'diagnostic'> & Readonly<{
  render?: (this: void, snapshot: UsFinancialPilotBankExportSnapshot) => Uint8Array | Promise<Uint8Array>;
  hash?: (this: void, bytes: Uint8Array) => Promise<string>;
  /** Private bounded seam, never a query parameter. */
  deadlineMs?: number;
}>;
const unavailable = (): never => { throw new ErpError('financial_pilot_bank_export_unavailable', 503); };
const invalidSnapshot = (): never => { throw new ErpError('invalid_financial_pilot_bank_export_snapshot', 503); };
const tooLarge = (): never => { throw new ErpError('financial_pilot_bank_export_too_large', 413); };
const changed = (): never => { throw new ErpError('financial_snapshot_changed', 409); };
const securityHeaders = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot' };
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) return invalidSnapshot();
  return value as Record<string, unknown>;
}
function exportCapacity(value: unknown): void { try { assertUsFinancialPilotBankCapacity(value); } catch { return tooLarge(); } }

/** Public whitelist validation. DTO validators validate bounded presentation
 * slices only; no source projection or history replay occurs inside this loop. */
export function validateUsFinancialPilotBankExportSnapshot(value: unknown, expected?: UsFinancialPilotBankExportSelector): UsFinancialPilotBankExportSnapshot {
  try {
    const v = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision', 'ledgerRevision', 'currency', 'language', 'selector', 'statement', 'lines', 'matches', 'movements', 'current', 'cashChangedSinceCompletion']);
    const selector = validateUsFinancialPilotBankExportSelector(v.selector), head = validateUsFinancialPilotBankHead({ consumer: v.consumer, schemaVersion: v.schemaVersion, organizationId: v.organizationId, revision: v.revision, bankRevision: v.bankRevision }, selector.organizationId);
    if (expected && !same(selector, validateUsFinancialPilotBankExportSelector(expected)) || head.revision !== selector.revision || head.bankRevision !== selector.bankRevision || v.currency !== 'USD' || v.language !== selector.language || !Number.isSafeInteger(v.ledgerRevision) || (v.ledgerRevision as number) < 0 || (v.ledgerRevision as number) > head.revision) return invalidSnapshot();
    if (!Array.isArray(v.lines) || !Array.isArray(v.matches) || v.lines.length > 1000 || v.matches.length > 1000 || v.movements !== null && !Array.isArray(v.movements)) return invalidSnapshot();
    const lines = v.lines as unknown as readonly UsFinancialPilotBankLine[], matches = v.matches as unknown as readonly UsFinancialPilotBankMatch[], statement = v.statement as UsFinancialPilotBankStatementSummary;
    if (!statement || statement.lineCount !== lines.length || statement.matchCount !== matches.length || statement.statementRevision !== selector.statementRevision || statement.statementId !== selector.statementId || statement.origin !== selector.origin) return invalidSnapshot();
    const common = { ...head, ledgerRevision: v.ledgerRevision }, query = { revision: head.revision, bankRevision: head.bankRevision, origin: selector.origin, statementId: selector.statementId };
    const page = (kind: UsFinancialPilotBankPageKind, items: readonly unknown[], offset: number) => ({ ...common, kind, origin: selector.origin, statementId: selector.statementId, total: items.length, items: items.slice(offset, offset + 25), nextCursor: offset + 25 < items.length ? financialPilotBankCursor(kind, head.organizationId, head.revision, head.bankRevision, offset + 25, selector.origin, selector.statementId) : null });
    const detail = (lineOffset: number, matchOffset: number) => validateUsFinancialPilotBankStatementDetail({ ...common, statement, lines: page('bank_lines', lines, lineOffset), matches: page('bank_matches', matches, matchOffset), current: v.current, cashChangedSinceCompletion: v.cashChangedSinceCompletion }, head.organizationId, { ...query, lineCursor: lineOffset ? financialPilotBankCursor('bank_lines', head.organizationId, head.revision, head.bankRevision, lineOffset, selector.origin, selector.statementId) : null, matchCursor: matchOffset ? financialPilotBankCursor('bank_matches', head.organizationId, head.revision, head.bankRevision, matchOffset, selector.origin, selector.statementId) : null });
    detail(0, 0); for (let offset = 25; offset < lines.length; offset += 25) detail(offset, 0); for (let offset = 25; offset < matches.length; offset += 25) detail(0, offset);
    if (new Set(lines.map(l => l.lineId)).size !== lines.length || new Set(matches.map(m => m.matchId)).size !== matches.length || BigInt(statement.openingMinor) + lines.reduce((n, l) => n + BigInt(l.amountMinor), BigInt(0)) !== BigInt(statement.closingMinor)) return invalidSnapshot();
    const lineClaims = new Set<string>(), journalClaims = new Set<number>(); let approvedAt = statement.createdAt, sourceRevision = 0;
    for (const m of matches) {
      if (Date.parse(m.approvedAt) < Date.parse(approvedAt) || statement.completion && Date.parse(m.approvedAt) > Date.parse(statement.completion.completedAt)) return invalidSnapshot(); approvedAt = m.approvedAt;
      if (m.sourceRevision !== null) { if (m.sourceRevision < sourceRevision || statement.completion?.source && m.sourceRevision > statement.completion.source.revision) return invalidSnapshot(); sourceRevision = m.sourceRevision; }
      let sum = BigInt(0); for (const id of m.statementLineIds) { const line = lines.find(l => l.lineId === id); if (!line || line.matchId !== m.matchId || lineClaims.has(id)) return invalidSnapshot(); lineClaims.add(id); sum += BigInt(line.amountMinor); }
      for (const revision of m.journalRevisions) { if (journalClaims.has(revision) || statement.completion && revision > statement.completion.ledgerRevision) return invalidSnapshot(); journalClaims.add(revision); }
      if (sum.toString() !== m.amountMinor) return invalidSnapshot();
    }
    if (lines.some(l => (l.matchId !== null) !== lineClaims.has(l.lineId))) return invalidSnapshot();
    if (selector.origin === 'legacy-frozen') { if (v.movements !== null) return invalidSnapshot(); }
    else {
      if (!Array.isArray(v.movements) || v.movements.length > 1000) return invalidSnapshot();
      const movements = v.movements as unknown as readonly UsFinancialPilotBankMovement[];
      for (let offset = 0; offset < Math.max(1, movements.length); offset += 25) validateUsFinancialPilotBankMovementsPage(page('bank_movements', movements, offset), head.organizationId, { ...query, cursor: offset ? financialPilotBankCursor('bank_movements', head.organizationId, head.revision, head.bankRevision, offset, selector.origin, selector.statementId) : null });
      if (movements.some((m, i) => m.bankDate < statement.start || m.bankDate > statement.end || i > 0 && m.journalRevision <= movements[i - 1].journalRevision || (m.status === 'matched') !== journalClaims.has(m.journalRevision))) return invalidSnapshot();
      for (const match of matches) { let sum = BigInt(0); for (const revision of match.journalRevisions) { const movement = movements.find(m => m.journalRevision === revision); if (!movement) return invalidSnapshot(); sum += BigInt(movement.amountMinor); } if (sum.toString() !== match.amountMinor) return invalidSnapshot(); }
      const current = v.current as UsFinancialPilotBankEvaluation;
      if (current.outstandingLineCount !== lines.length - lineClaims.size || current.unmatchedMovementCount !== movements.length - journalClaims.size || BigInt(current.endingDifferenceMinor) !== BigInt(current.beginningDifferenceMinor) + BigInt(statement.openingMinor) + movements.reduce((n, m) => n + BigInt(m.amountMinor), BigInt(0)) - BigInt(statement.closingMinor)) return invalidSnapshot();
    }
    assertUsFinancialPilotBankCapacity(v); return v as unknown as UsFinancialPilotBankExportSnapshot;
  } catch { return invalidSnapshot(); }
}

async function snapshotSource(bookInput: UsFinancialBookV5, registerInput: UsFinancialPilotBankRegister, selectorInput: UsFinancialPilotBankExportSelector) {
  // All caller-owned sources are captured before the first asynchronous hash.
  const b = snapshotPrivateJson(bookInput), r = validateUsFinancialPilotBankRegister(registerInput), selector = validateUsFinancialPilotBankExportSelector(selectorInput), book = await validateUsFinancialBookV5(b, selector.organizationId);
  if (book.revision !== selector.revision || r.organizationId !== selector.organizationId || r.bankRevision !== selector.bankRevision) return changed();
  const register = await validateUsFinancialPilotBankHistory(book, r), view = await projectUsFinancialBookV5(book), row = register.records.find(r => r.origin === selector.origin && r.record.reconciliation.statement.id === selector.statementId);
  if (!row) throw new ErpError('reconciliation_not_found', 404);
  const record = row.record, reconciliation = record.reconciliation, s = reconciliation.statement;
  if (reconciliation.revision !== selector.statementRevision) return changed();
  const completed = register.operations.find(p => p.statementId === s.id && p.action === 'complete');
  const statement: UsFinancialPilotBankStatementSummary = { origin: row.origin, statementId: s.id, statementRevision: reconciliation.revision, cashAccountId: s.cashAccountId, start: s.start, end: s.end, openingMinor: s.opening.minorUnits, closingMinor: s.closing.minorUnits, lineCount: s.lines.length, matchCount: reconciliation.matches.length, state: record.voided ? 'voided' : reconciliation.completedAt ? 'completed' : 'open', createdBy: record.createdBy, createdAt: record.createdAt, completion: reconciliation.completedAt ? { completedAt: reconciliation.completedAt, completedBy: reconciliation.completedBy!, ledgerRevision: reconciliation.completedLedgerRevision!, source: row.origin === 'legacy-frozen' ? null : completed ? { revision: completed.source.revision, ledgerRevision: completed.source.ledgerRevision } : unavailable() } : null, voided: record.voided ?? null };
  const lines = s.lines.map((l, i) => ({ ordinal: i + 1, lineId: l.id, date: l.date, amountMinor: l.amount.minorUnits, reference: l.reference, matchId: reconciliation.matches.find(m => m.statementLineIds.includes(l.id))?.id ?? null }));
  const matches = reconciliation.matches.map(m => ({ matchId: m.id, statementLineIds: m.statementLineIds, journalRevisions: m.ledgerEntryIds.map(id => view.ledger.entries.find(e => e.id === id)?.revision ?? unavailable()).sort((a, b) => a - b), amountMinor: s.lines.filter(l => m.statementLineIds.includes(l.id)).reduce((n, l) => n + BigInt(l.amount.minorUnits), BigInt(0)).toString(), approvedBy: m.approvedBy, approvedAt: m.approvedAt, sourceRevision: row.origin === 'legacy-frozen' ? null : register.operations.find(p => p.request.requestId === m.id)?.source.revision ?? unavailable() }));
  const movements: UsFinancialPilotBankMovement[] | null = row.origin === 'legacy-frozen' ? null : [];
  if (movements) for (const e of view.ledger.entries) { const bankDate = e.paymentDate ?? e.transactionDate, amount = e.lines.filter(l => l.accountId === s.cashAccountId).reduce((n, l) => n + BigInt(l.debitMinor) - BigInt(l.creditMinor), BigInt(0)); if (bankDate < s.start || bankDate > s.end || amount === BigInt(0)) continue; const claim = register.records.find(r => !r.record.voided && r.record.reconciliation.matches.some(m => m.ledgerEntryIds.includes(e.id))); movements.push({ journalRevision: e.revision, transactionDate: e.transactionDate, accountingDate: e.accountingDate, paymentDate: e.paymentDate ?? null, bankDate, amountMinor: amount.toString(), description: e.description, source: financialPilotPublicSource(view, e), status: claim ? claim.record.reconciliation.statement.id === s.id ? 'matched' : 'claimed_elsewhere' : 'available' }); }
  movements?.sort((a, b) => a.journalRevision - b.journalRevision);
  const status = row.origin === 'legacy-frozen' ? null : reconciliationStatus(reconciliation, view.ledger), current = status ? { outstandingLineCount: status.outstandingStatementLineIds.length, unmatchedMovementCount: status.unmatchedBookEntryIds.length, beginningDifferenceMinor: status.beginningDifferenceMinor, endingDifferenceMinor: status.endingDifferenceMinor, ready: status.ready } : null;
  const output = { consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: view.organizationId, revision: view.revision, bankRevision: register.bankRevision, ledgerRevision: view.ledger.revision, currency: 'USD' as const, language: selector.language, selector, statement, lines, matches, movements, current, cashChangedSinceCompletion: row.origin === 'legacy-frozen' || !statement.completion ? null : !current!.ready };
  exportCapacity(output);
  return { snapshot: validateUsFinancialPilotBankExportSnapshot(output, selector), targetCanonical: canonicalErpJson(row), bookCanonical: canonicalErpJson(book), book };
}
export async function buildUsFinancialPilotBankExportSnapshot(book: UsFinancialBookV5, register: UsFinancialPilotBankRegister, selector: UsFinancialPilotBankExportSelector): Promise<UsFinancialPilotBankExportSnapshot> { return (await snapshotSource(book, register, selector)).snapshot; }

/** Complete normalized relations; group amounts are never multiplied by a join. */
export function renderUsFinancialPilotBankExportCsv(value: unknown): Uint8Array<ArrayBuffer> {
  const s = validateUsFinancialPilotBankExportSnapshot(value), copy = browserUsFinancialPilotBankCopy[s.language], c = copy.csv, statement = s.statement;
  const text = (...values: string[]) => values.map(textCell), rows: string[][] = [text(c.title), ...[copy.notices.test, copy.notices.manualOnly, copy.notices.csvNotArchived, copy.notices.exportComplete].map(v => text(v)), text(c.organization, s.organizationId), text(c.origin, copy.origin[statement.origin]), text(c.statementId, statement.statementId), text(c.financialRevision, String(s.revision)), text(c.bankRevision, String(s.bankRevision)), text(c.statementRevision, String(statement.statementRevision)), text(c.ledgerRevision, String(s.ledgerRevision)), text(c.currency, 'USD'), text(c.account, statement.cashAccountId), text(c.status, copy.state[statement.state]), text(c.start, statement.start), text(c.end, statement.end), [textCell(c.opening), decimal(statement.openingMinor)], [textCell(c.closing), decimal(statement.closingMinor)], [], text(c.lines), text(c.ordinal, c.lineId, c.date, c.amount + ' (USD)', c.reference, c.matchId)];
  rows.splice(rows.length - 3, 0, text(c.createdBy, statement.createdBy), text(c.createdAt, statement.createdAt));
  for (const l of s.lines) rows.push([...text(String(l.ordinal), l.lineId, l.date), decimal(l.amountMinor), ...text(l.reference, l.matchId ?? '')]);
  rows.push([], text(c.matches), text(c.matchId, c.amount + ' (USD)', c.approvedBy, c.approvedAt, c.sourceRevision));
  for (const m of s.matches) rows.push([textCell(m.matchId), decimal(m.amountMinor), ...text(m.approvedBy, m.approvedAt, m.sourceRevision === null ? '' : String(m.sourceRevision))]);
  rows.push([], text(c.matchLines), text(c.matchId, c.lineId)); for (const m of s.matches) for (const id of m.statementLineIds) rows.push(text(m.matchId, id));
  rows.push([], text(c.matchJournals), text(c.matchId, c.journalRevision)); for (const m of s.matches) for (const revision of m.journalRevisions) rows.push(text(m.matchId, String(revision)));
  rows.push([], text(c.movements));
  if (s.movements === null) rows.push(text(c.legacyUnavailable));
  else { rows.push(text(c.journalRevision, c.bankDate, c.transactionDate, c.accountingDate, c.paymentDate, c.amount + ' (USD)', c.description, c.sourceKind, c.sourceEntity, c.sourceReference, c.originalJournalRevision, c.status)); for (const m of s.movements) rows.push([...text(String(m.journalRevision), m.bankDate, m.transactionDate, m.accountingDate, m.paymentDate ?? ''), decimal(m.amountMinor), ...text(m.description, copy.sourceKind[m.source.kind], m.source.entityId ?? '', m.source.reference ?? '', m.source.journalRevision === null ? '' : String(m.source.journalRevision), copy.movementStatus[m.status])]); }
  rows.push([], text(c.completion)); if (statement.completion) { const complete = statement.completion; rows.push(text(c.completedBy, complete.completedBy), text(c.completedAt, complete.completedAt), text(c.completedLedgerRevision, String(complete.ledgerRevision)), text(c.completedSourceRevision, complete.source === null ? '' : String(complete.source.revision))); }
  rows.push([], text(c.current)); if (s.current) rows.push(text(c.outstandingLines, String(s.current.outstandingLineCount)), text(c.unmatchedMovements, String(s.current.unmatchedMovementCount)), [textCell(c.beginningDifference), decimal(s.current.beginningDifferenceMinor)], [textCell(c.endingDifference), decimal(s.current.endingDifferenceMinor)], text(c.ready, String(s.current.ready)), text(c.cashChanged, s.cashChangedSinceCompletion === null ? '' : String(s.cashChangedSinceCompletion))); else rows.push(text(c.legacyUnavailable));
  if (statement.voided) rows.push([], text(c.voidedBy, statement.voided.by), text(c.voidedAt, statement.voided.at), text(c.voidReason, statement.voided.reason));
  const result = new TextEncoder().encode('\uFEFF' + rows.map(row => row.map(quoted).join(',')).join('\r\n') + '\r\n'); if (result.byteLength > US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES) return tooLarge(); return result;
}

const publicCodes: Readonly<Record<string, readonly number[]>> = {
  unauthorized: [401], session_changed: [401], forbidden: [403], tenant_mismatch: [403], management_entitlement_required: [402], financial_permission_required: [403], rate_limited: [429], method_not_allowed: [405],
  feature_unavailable: [404], financial_pilot_unavailable: [404], financial_pilot_opt_in_required: [403], financial_pilot_opt_in_changed: [409], financial_test_grant_required: [403], financial_test_grant_changed: [409], financial_authority_changed: [403], financial_configuration_changed: [409], financial_policy_unavailable: [409], financial_upgrade_required: [409], financial_capability_unavailable: [409, 503], financial_book_too_large: [413], financial_snapshot_changed: [409], financial_book_required: [409], financial_source_changed: [409], edition_unavailable: [409], reconciliation_not_found: [404],
  invalid_financial_pilot_bank_export_selector: [422], invalid_financial_pilot_bank_export_snapshot: [503], financial_pilot_bank_export_too_large: [413], financial_pilot_bank_export_timeout: [503], financial_pilot_bank_export_unavailable: [503],
};
function failure(error: unknown, diagnostic: UsFinancialPilotBankExportDependencies['diagnostic']): Response {
  let code = 'financial_pilot_bank_export_unavailable', status = 503;
  try {
    const c = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined, s = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
    if (error instanceof AccountPublicError && s && 'value' in s && [401, 402, 403, 429].includes(s.value as number)) { status = s.value as number; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden'; }
    else if ((error instanceof ErpError || error instanceof UsFinancialPilotError || error instanceof BankInputError) && c && s && 'value' in c && 'value' in s && typeof c.value === 'string' && Object.hasOwn(publicCodes, c.value) && publicCodes[c.value].includes(s.value as number)) { code = c.value; status = s.value as number; }
  } catch { /* Private messages, causes and accessors never become public. */ }
  try { diagnostic({ operation: 'read', code, status }); } catch { /* Telemetry cannot change authority. */ }
  return Response.json({ error: code }, { status, headers: { ...securityHeaders, ...(status === 405 ? { Allow: 'GET' } : {}) } });
}
function admissionSnapshot(value: unknown): ErpReadAdmission {
  const a = snapshotPrivateJson(value) as ErpReadAdmission;
  if (!a || Reflect.ownKeys(a).length !== 2 || !Object.hasOwn(a, 'mode') || !Object.hasOwn(a, 'actor') || !['browser', 'device'].includes(a.mode) || !a.actor || Reflect.ownKeys(a.actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(k => Object.hasOwn(a.actor, k))) return unavailable();
  if (typeof a.actor.organizationId !== 'string' || typeof a.actor.userId !== 'string' || !a.actor.userId || a.actor.userId !== a.actor.userId.trim() || a.actor.userId.length > 256 || Array.from(a.actor.userId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || typeof a.actor.managementEntitled !== 'boolean' || typeof a.actor.timestamp !== 'string' || !Number.isFinite(Date.parse(a.actor.timestamp)) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(a.actor.role)) return unavailable(); return a;
}
function capturedRead(value: unknown): UsFinancialPilotBankRead {
  const row = fields(value, ['book', 'register']); if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unavailable();
  const read = (key: 'book' | 'register') => { const d = Object.getOwnPropertyDescriptor(row, key); if (!d || !d.enumerable || !('value' in d)) return unavailable(); return snapshotPrivateJson(d.value); };
  return { book: read('book') as UsFinancialBookV5, register: read('register') as UsFinancialPilotBankRegister };
}
function copyBytes(input: unknown): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array) || Object.getPrototypeOf(input) !== Uint8Array.prototype) return unavailable();
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object, length = Object.getOwnPropertyDescriptor(prototype, 'length')!.get!.call(input) as number, buffer: unknown = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!.call(input);
  if (!Number.isSafeInteger(length) || length < 1 || !buffer || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return unavailable(); if (length > US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES) return tooLarge();
  const owned = new Uint8Array(length); Uint8Array.prototype.set.call(owned, input); return owned;
}
function outputBytes(value: unknown): Uint8Array<ArrayBuffer> { const bytes = copyBytes(value); let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return unavailable(); } if (!text.startsWith('\uFEFF') || !text.endsWith('\r\n')) return unavailable(); return bytes; }
function parameters(request: Request, organizationId: string, statementId: string): UsFinancialPilotBankExportSelector {
  if (request.method !== 'GET') throw new ErpError('method_not_allowed', 405);
  const invalid = (): never => { throw new ErpError('invalid_financial_pilot_bank_export_selector', 422); };
  if (request.url.length > 4096) return invalid(); const url = new URL(request.url), allowed = ['revision', 'bankRevision', 'statementRevision', 'origin', 'format', 'language'];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return invalid();
  const integer = (key: string) => { const raw = url.searchParams.get(key); if (raw === null || !/^(0|[1-9][0-9]{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) return invalid(); return Number(raw); };
  const selector = validateUsFinancialPilotBankExportSelector({ consumer: 'financial-pilot', schemaVersion: 1, kind: 'bank_reconciliation', organizationId, statementId, revision: integer('revision'), bankRevision: integer('bankRevision'), statementRevision: integer('statementRevision'), origin: url.searchParams.get('origin'), format: url.searchParams.get('format'), language: url.searchParams.get('language') });
  if (url.pathname !== new URL(browserUsFinancialPilotBankExportUrl(selector), url.origin).pathname) return invalid(); return selector;
}

/** Cookie-only read boundary. No receipt/commit/provider method is captured. */
export function createUsFinancialPilotBankExportHandler(input: UsFinancialPilotBankExportDependencies): (request: Request, organizationId: string, statementId: string) => Promise<Response> {
  const bind = <K extends keyof UsFinancialPilotBankExportDependencies>(key: K, optional = false): UsFinancialPilotBankExportDependencies[K] => { const d = Object.getOwnPropertyDescriptor(input, key); if (!d && optional) return undefined as UsFinancialPilotBankExportDependencies[K]; if (!d || !('value' in d) || typeof d.value !== 'function') return unavailable(); return d.value.bind(undefined) as UsFinancialPilotBankExportDependencies[K]; };
  const deps = Object.freeze({ enabled: bind('enabled'), authority: bind('authority'), configuration: bind('configuration'), scope: bind('scope'), store: bind('store'), rateLimit: bind('rateLimit'), diagnostic: bind('diagnostic'), render: bind('render', true), hash: bind('hash', true) });
  const d = Object.getOwnPropertyDescriptor(input, 'deadlineMs'), duration: unknown = d && 'value' in d ? d.value : US_FINANCIAL_PILOT_BANK_EXPORT_TIMEOUT_MS;
  if (d && !('value' in d) || typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1 || duration > US_FINANCIAL_PILOT_BANK_EXPORT_TIMEOUT_MS) return unavailable();
  return async (supplied, organizationId, statementId) => {
    const request = new Request(supplied.url, { method: supplied.method, headers: new Headers(supplied.headers), signal: supplied.signal }), until = Date.now() + duration;
    let trusted: ErpReadAdmission | undefined, scope: UsFinancialPilotScope | undefined, configuration: CompanyConfiguration | undefined;
    function active(): void { if (request.signal.aborted) return unavailable(); if (Date.now() >= until) throw new ErpError('financial_pilot_bank_export_timeout', 503); }
    async function wait<T>(task: () => T | Promise<T>): Promise<T> {
      active(); let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
      try { return await Promise.race([Promise.resolve().then(task), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ErpError('financial_pilot_bank_export_timeout', 503)), Math.max(1, until - Date.now())); abort = () => reject(new ErpError('financial_pilot_bank_export_unavailable', 503)); request.signal.addEventListener('abort', abort, { once: true }); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); if (abort) request.signal.removeEventListener('abort', abort); }
    }
    async function authority(): Promise<ErpReadAdmission> {
      const fresh = admissionSnapshot(await wait(() => deps.authority(request, organizationId))); confirmErpExpectedUser(request, fresh);
      if (fresh.mode !== 'browser') throw new ErpError('forbidden', 403); if (fresh.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403); if (!fresh.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402); if (!['owner', 'admin', 'accountant'].includes(fresh.actor.role)) throw new ErpError('financial_permission_required', 403); if (trusted) confirmErpReadAdmission(trusted, fresh); return fresh;
    }
    async function admission(): Promise<UsFinancialPilotScope> {
      const fresh = await authority(); if (!await wait(deps.enabled)) throw new ErpError('feature_unavailable', 404);
      const config = validateCompanyConfiguration(snapshotPrivateJson(await wait(() => deps.configuration(fresh.actor))));
      if (config.organizationId !== organizationId || config.country !== 'US' || config.currency !== 'USD' || config.accountingBasis !== 'accrual') throw new ErpError('edition_unavailable', 409); if (configuration && !same(configuration, config)) throw new ErpError('financial_configuration_changed', 409);
      const current = captureUsFinancialPilotScope(await wait(() => deps.scope(fresh.actor, scope)));
      if (current.scope.organizationId !== organizationId || current.scope.actor.userId !== fresh.actor.userId || current.scope.actor.role !== fresh.actor.role) throw new ErpError('financial_authority_changed', 403);
      if (scope && current.optInVersion !== scope.optInVersion) throw new ErpError('financial_pilot_opt_in_changed', 409); if (scope && current.scope.grantVersion !== scope.scope.grantVersion) throw new ErpError('financial_test_grant_changed', 409); if (scope && !same(current.scope.policy, scope.scope.policy)) throw new ErpError('financial_policy_unavailable', 409);
      await authority(); if (!await wait(deps.enabled)) throw new ErpError('feature_unavailable', 404); active(); configuration ??= config; return current;
    }
    async function step<T, C>(task: () => T | Promise<T>, capture: (result: T) => C): Promise<C> { await admission(); const owned = capture(await wait(task)); await admission(); return owned; }
    try {
      if (request.headers.has('Authorization')) throw new ErpError('forbidden', 403); if (request.headers.get('X-Zentra-Financial-Pilot') !== '1' || !request.headers.get('X-Zentra-Expected-User')) throw new ErpError('invalid_financial_pilot_bank_export_selector', 422);
      const selector = parameters(request, organizationId, statementId), site = request.headers.get('Sec-Fetch-Site'), origin = request.headers.get('Origin');
      if (origin ? origin !== new URL(request.url).origin : !['same-origin', 'none'].includes(site ?? '')) throw new ErpError('forbidden', 403); if (site && !['same-origin', 'none'].includes(site)) throw new ErpError('forbidden', 403);
      if (!await wait(deps.enabled)) throw new ErpError('feature_unavailable', 404); trusted = await authority(); await wait(() => deps.rateLimit(request, trusted!.actor, 'read')); scope = await admission();
      const store = await step(() => deps.store(scope!, admission), value => { const method = <K extends 'read' | 'head'>(key: K): UsFinancialPilotBankPort[K] => { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return unavailable(); return descriptor.value.bind(undefined) as UsFinancialPilotBankPort[K]; }; return { read: method('read'), head: method('head') }; });
      const source = await step(store.read, capturedRead);
      const prepared = await step(() => snapshotSource(source.book, source.register, selector), value => value);
      if (!same(prepared.book.baseline.configuration, configuration)) throw new ErpError('financial_configuration_changed', 409); if (!same(prepared.book.policy, scope.scope.policy)) throw new ErpError('financial_policy_unavailable', 409);
      const snapshot = prepared.snapshot, bytes = await step(() => deps.render ? deps.render(snapshot) : renderUsFinancialPilotBankExportCsv(snapshot), outputBytes);
      const hashInput = copyBytes(bytes), beforeHash = copyBytes(hashInput), contentHash = await step(() => deps.hash ? deps.hash(hashInput) : sha256Hex(hashInput), value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || Uint8Array.prototype.some.call(hashInput, (b: number, i: number) => b !== beforeHash[i])) return unavailable(); return value; });
      if (contentHash !== await step(() => sha256Hex(bytes), value => value)) return unavailable(); const selectorHash = await step(() => sha256Hex(canonicalErpJson(selector)), value => value);
      const finalSource = await step(store.read, capturedRead), final = await step(async () => { try { return await snapshotSource(finalSource.book, finalSource.register, selector); } catch (error) { const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined; if (error instanceof ErpError && code && 'value' in code && code.value === 'reconciliation_not_found') return changed(); throw error; } }, value => value);
      if (final.targetCanonical !== prepared.targetCanonical || final.bookCanonical !== prepared.bookCanonical) return changed();
      const head = await step(store.head, value => validateUsFinancialPilotBankHead(value, organizationId)); if (head.revision !== selector.revision || head.bankRevision !== selector.bankRevision) return changed(); await admission(); active();
      const headers = new Headers(securityHeaders), h = US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS;
      headers.set('Content-Type', 'text/csv; charset=utf-8'); headers.set('Content-Length', String(bytes.byteLength)); headers.set('Content-Disposition', `attachment; filename="zentra-bank-${selector.origin}-${selector.statementId}-f${selector.revision}-b${selector.bankRevision}-r${selector.statementRevision}-${selector.language}.csv"`);
      for (const [key, value] of [[h.scope, '1'], [h.bankScope, '1'], [h.organization, organizationId], [h.revision, String(snapshot.revision)], [h.bankRevision, String(snapshot.bankRevision)], [h.statementRevision, String(selector.statementRevision)], [h.statementId, statementId], [h.origin, selector.origin], [h.ledgerRevision, String(snapshot.ledgerRevision)], [h.currency, 'USD'], [h.language, selector.language], [h.format, 'csv'], [h.selectorHash, selectorHash], [h.contentHash, contentHash]]) headers.set(key, value);
      return new Response(bytes, { headers });
    } catch (error) { let latest = error; if (trusted && !request.signal.aborted && Date.now() < until) try { await admission(); } catch (fresh) { latest = fresh; } return failure(latest, deps.diagnostic); }
  };
}
