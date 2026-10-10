import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { parseUsBankStatementCsv } from './us-bank-csv';
import type { CompanyLanguage } from './types';
import {
  US_FINANCIAL_PILOT_BANK_MANUAL_MARKER, US_FINANCIAL_PILOT_BANK_MAX_BODY_BYTES, US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES,
  assertUsFinancialPilotBankCapacity, validateUsFinancialPilotBankHead, validateUsFinancialPilotBankRequest,
  type UsFinancialPilotBankCommand, type UsFinancialPilotBankHead, type UsFinancialPilotBankRequest,
} from './us-financial-pilot-bank';
import {
  validateUsFinancialPilotBankContext, validateUsFinancialPilotBankDetailQuery,
  validateUsFinancialPilotBankMovementQuery, validateUsFinancialPilotBankMovementsPage,
  validateUsFinancialPilotBankStatementDetail,
  type UsFinancialPilotBankContext, type UsFinancialPilotBankDetailQuery, type UsFinancialPilotBankLine,
  type UsFinancialPilotBankMovement, type UsFinancialPilotBankMovementQuery,
  type UsFinancialPilotBankMovementsPage, type UsFinancialPilotBankStatementDetail,
} from './us-financial-pilot-bank-projection';

export const US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES = 524_288;
export const US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES = 40;
export const US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES = 12 * 1024 * 1024;
export const US_FINANCIAL_PILOT_BANK_EXPORT_TIMEOUT_MS = 30_000;
export type BankInputErrorCode =
  | 'bank_input_invalid' | 'bank_csv_too_large' | 'bank_input_too_large' | 'invalid_bank_statement'
  | 'bank_review_changed' | 'bank_review_evidence_required' | 'bank_legacy_immutable' | 'bank_legacy_pending'
  | 'bank_statement_limit_reached' | 'bank_operation_limit_reached' | 'bank_selection_required'
  | 'bank_selection_duplicate' | 'bank_selection_unavailable' | 'reconciliation_amount_mismatch'
  | 'reconciliation_incomplete' | 'statement_not_voidable' | 'invalid_financial_pilot_bank_export_selector';
const conflicts = new Set<BankInputErrorCode>(['bank_review_changed', 'bank_legacy_immutable', 'bank_legacy_pending', 'bank_statement_limit_reached', 'bank_operation_limit_reached', 'bank_selection_unavailable', 'reconciliation_incomplete', 'statement_not_voidable']);
const errorCodes = new Set<BankInputErrorCode>(['bank_input_invalid', 'bank_csv_too_large', 'bank_input_too_large', 'invalid_bank_statement', 'bank_review_changed', 'bank_review_evidence_required', 'bank_legacy_immutable', 'bank_legacy_pending', 'bank_statement_limit_reached', 'bank_operation_limit_reached', 'bank_selection_required', 'bank_selection_duplicate', 'bank_selection_unavailable', 'reconciliation_amount_mismatch', 'reconciliation_incomplete', 'statement_not_voidable', 'invalid_financial_pilot_bank_export_selector']);
export class BankInputError extends Error {
  readonly code: BankInputErrorCode;
  readonly status: 422 | 409 | 413;
  constructor(code: BankInputErrorCode) {
    const safe = errorCodes.has(code) ? code : 'bank_input_invalid';
    super(safe); this.name = 'BankInputError'; this.code = safe;
    this.status = safe === 'bank_csv_too_large' || safe === 'bank_input_too_large' ? 413 : conflicts.has(safe) ? 409 : 422;
    Object.freeze(this);
  }
}
const fail = (code: BankInputErrorCode = 'bank_input_invalid'): never => { throw new BankInputError(code); };
function protect<T>(action: () => T, code: BankInputErrorCode = 'bank_input_invalid'): T {
  try { return action(); } catch (error) {
    let captured: BankInputErrorCode | undefined;
    try { const d = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined; if (error instanceof BankInputError && d && 'value' in d && errorCodes.has(d.value)) captured = d.value as BankInputErrorCode; } catch { /* Never execute exception accessors. */ }
    return fail(captured ?? code);
  }
}
/** Capture wrappers and bounded arrays by descriptors, not by serializing all
 * repeated page metadata into one aggregate private-JSON budget. */
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !d.enumerable || !('value' in d)) return fail(); result[key] = d.value; }
  return result;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail('bank_review_evidence_required');
  const size = Object.getOwnPropertyDescriptor(value, 'length');
  if (!size || !('value' in size) || !Number.isSafeInteger(size.value) || size.value < 0 || size.value > maximum) return fail('bank_input_too_large');
  if (Reflect.ownKeys(value).length !== size.value + 1) return fail();
  const result: unknown[] = [];
  for (let i = 0; i < size.value; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !d.enumerable || !('value' in d)) return fail(); result.push(d.value); }
  return result;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail(); return value;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return fail(); return value; }
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export type BankExpected = Readonly<{ revision: number; bankRevision: number; statementRevision: number | null }>;
export type BankReviewScope = Readonly<{ organizationId: string; requestId: string; head: UsFinancialPilotBankHead; expected: BankExpected }>;
export type BankImportDraft = Readonly<{ text: string; cashAccountId: string; start: string; end: string; opening: string; closing: string }>;
export type BankDetailEvidence = Readonly<{ query: UsFinancialPilotBankDetailQuery; value: UsFinancialPilotBankStatementDetail }>;
export type BankMovementEvidence = Readonly<{ query: UsFinancialPilotBankMovementQuery; value: UsFinancialPilotBankMovementsPage }>;
export type BankCommandEvidence = Readonly<{ statement: BankDetailEvidence; linePages: readonly BankDetailEvidence[]; movementPages: readonly BankMovementEvidence[] }>;
export type BankImportTotals = Readonly<{ lineCount: number; openingMinor: string; statementNetMinor: string; closingMinor: string }>;
export type BankMatchTotals = Readonly<{ statementLineCount: number; movementCount: number; statementMinor: string; movementMinor: string; differenceMinor: '0' }>;
export type BankCapturedRequest = Readonly<{ request: UsFinancialPilotBankRequest; body: string }>;
export type BankReview = BankCapturedRequest & Readonly<{ organizationId: string; importTotals: BankImportTotals | null; matchTotals: BankMatchTotals | null }>;

function scope(input: unknown): BankReviewScope {
  const s = fields(snapshotPrivateJson(input), ['organizationId', 'requestId', 'head', 'expected']), organizationId = uuid(s.organizationId), requestId = uuid(s.requestId);
  const head = validateUsFinancialPilotBankHead(s.head, organizationId), e = fields(s.expected, ['revision', 'bankRevision', 'statementRevision']);
  const expected = Object.freeze({ revision: integer(e.revision, 1), bankRevision: integer(e.bankRevision, 0, 1000), statementRevision: e.statementRevision === null ? null : integer(e.statementRevision, 0, Number.MAX_SAFE_INTEGER - 2) });
  if (head.revision !== expected.revision || head.bankRevision !== expected.bankRevision) return fail('bank_review_changed');
  if (expected.bankRevision === 1000) return fail('bank_operation_limit_reached');
  return Object.freeze({ organizationId, requestId, head, expected });
}
function context(input: unknown, s: BankReviewScope): UsFinancialPilotBankContext {
  return protect(() => validateUsFinancialPilotBankContext(input, s.organizationId, s.expected), 'bank_review_changed');
}
function account(c: UsFinancialPilotBankContext, accountId: string): void {
  if (!c.accounts.some(a => a.accountId === accountId)) return fail('bank_input_invalid');
  if (c.legacyPending.some(p => p.cashAccountId === accountId)) return fail('bank_legacy_pending');
}
function envelope(s: BankReviewScope, command: UsFinancialPilotBankCommand): BankCapturedRequest {
  return captureBankOperationRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: s.requestId, expectedRevision: s.expected.revision, expectedBankRevision: s.expected.bankRevision, expectedStatementRevision: s.expected.statementRevision, command });
}
/** Canonical request and exact body are captured once. No actor, receipt,
 * session ownership, admission, UUID allocation or retry rebasing occurs here. */
export function captureBankOperationRequest(value: unknown): BankCapturedRequest {
  return protect(() => {
    const captured = snapshotPrivateJson(value);
    if (bytes(JSON.stringify(captured)) > US_FINANCIAL_PILOT_BANK_MAX_BODY_BYTES) return fail('bank_input_too_large');
    const request = validateUsFinancialPilotBankRequest(captured), body = JSON.stringify(request);
    if (bytes(body) > US_FINANCIAL_PILOT_BANK_MAX_BODY_BYTES) return fail('bank_input_too_large');
    return Object.freeze({ request, body });
  });
}
export function buildBankImportReview(value: Readonly<{ scope: BankReviewScope; draft: BankImportDraft; context: UsFinancialPilotBankContext }>): BankReview {
  return protect(() => {
    const v = fields(value, ['scope', 'draft', 'context']), s = scope(v.scope), c = context(v.context, s);
    if (s.expected.statementRevision !== null) return fail('bank_review_changed');
    if (c.statementCount === 100) return fail('bank_statement_limit_reached');
    const raw = fields(v.draft, ['text', 'cashAccountId', 'start', 'end', 'opening', 'closing']);
    if (typeof raw.text !== 'string') return fail('invalid_bank_statement');
    if (raw.text.length > US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES || bytes(raw.text) > US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES) return fail('bank_csv_too_large');
    const draft = snapshotPrivateJson(raw) as BankImportDraft;
    account(c, draft.cashAccountId);
    const statement = protect(() => parseUsBankStatementCsv({ ...draft, id: s.requestId, organizationId: s.organizationId, externalConnectionId: US_FINANCIAL_PILOT_BANK_MANUAL_MARKER }), 'invalid_bank_statement');
    const captured = envelope(s, { type: 'create_statement', cashAccountId: statement.cashAccountId, start: statement.start, end: statement.end, openingMinor: statement.opening.minorUnits, closingMinor: statement.closing.minorUnits, lines: statement.lines.map(l => ({ date: l.date, amountMinor: l.amount.minorUnits, reference: l.reference })) });
    const importTotals = Object.freeze({ lineCount: statement.lines.length, openingMinor: statement.opening.minorUnits, statementNetMinor: statement.lines.reduce((n, l) => n + BigInt(l.amount.minorUnits), BigInt(0)).toString(), closingMinor: statement.closing.minorUnits });
    return Object.freeze({ ...captured, organizationId: s.organizationId, importTotals, matchTotals: null });
  }, 'invalid_bank_statement');
}
function detailEvidence(input: unknown, s: BankReviewScope): BankDetailEvidence {
  return protect(() => { const e = fields(input, ['query', 'value']), query = validateUsFinancialPilotBankDetailQuery(e.query), value = validateUsFinancialPilotBankStatementDetail(e.value, s.organizationId, query);
    if (query.revision !== s.expected.revision || query.bankRevision !== s.expected.bankRevision) return fail('bank_review_changed'); return Object.freeze({ query, value });
  }, 'bank_review_changed');
}
function movementEvidence(input: unknown, s: BankReviewScope): BankMovementEvidence {
  return protect(() => { const e = fields(input, ['query', 'value']), query = validateUsFinancialPilotBankMovementQuery(e.query), value = validateUsFinancialPilotBankMovementsPage(e.value, s.organizationId, query);
    if (query.revision !== s.expected.revision || query.bankRevision !== s.expected.bankRevision) return fail('bank_review_changed'); return Object.freeze({ query, value });
  }, 'bank_review_changed');
}
function metadata(value: UsFinancialPilotBankStatementDetail): unknown {
  return { ledgerRevision: value.ledgerRevision, statement: value.statement, current: value.current, cashChangedSinceCompletion: value.cashChangedSinceCompletion };
}
export function buildBankCommandReview(value: Readonly<{ scope: BankReviewScope; context: UsFinancialPilotBankContext; command: Exclude<UsFinancialPilotBankCommand, { type: 'create_statement' }>; evidence: BankCommandEvidence }>): BankReview {
  return protect(() => {
    const v = fields(value, ['scope', 'context', 'command', 'evidence']), s = scope(v.scope), c = context(v.context, s), command = snapshotPrivateJson(v.command) as Exclude<UsFinancialPilotBankCommand, { type: 'create_statement' }>;
    if (command?.type === 'approve_match') {
      if (!Array.isArray(command.statementLineIds) || !Array.isArray(command.journalRevisions) || !command.statementLineIds.length || !command.journalRevisions.length) return fail('bank_selection_required');
      if (new Set(command.statementLineIds).size !== command.statementLineIds.length || new Set(command.journalRevisions).size !== command.journalRevisions.length) return fail('bank_selection_duplicate');
    }
    const captured = envelope(s, command), operation = captured.request.command;
    if (operation.type === 'create_statement') return fail();
    const e = protect(() => fields(v.evidence, ['statement', 'linePages', 'movementPages']), 'bank_review_evidence_required');
    const lines = array(e.linePages, US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES - 1), movements = array(e.movementPages, US_FINANCIAL_PILOT_BANK_EVIDENCE_MAX_PAGES), base = detailEvidence(e.statement, s), reference = base.value;
    if (reference.statement.origin !== 'financial-v5') return fail('bank_legacy_immutable');
    if (reference.statement.statementId !== operation.statementId || reference.statement.statementRevision !== s.expected.statementRevision || reference.ledgerRevision !== c.ledgerRevision || reference.statement.state !== 'open') return fail('bank_review_changed');
    account(c, reference.statement.cashAccountId);
    if (operation.type === 'complete') { if (lines.length || movements.length) return fail(); if (!reference.current?.ready) return fail('reconciliation_incomplete'); }
    if (operation.type === 'void_statement') { if (lines.length || movements.length) return fail(); if (reference.statement.matchCount || reference.statement.completion || reference.statement.voided) return fail('statement_not_voidable'); }
    let matchTotals: BankMatchTotals | null = null;
    if (operation.type === 'approve_match') {
      const selectedIds = new Set(operation.statementLineIds), selectedRevisions = new Set(operation.journalRevisions), selectedLines = new Map<string, UsFinancialPilotBankLine>(), selectedMovements = new Map<number, UsFinancialPilotBankMovement>();
      const seenLines = new Set<string>(), seenOrdinals = new Set<number>(), seenJournals = new Set<number>(), seenLinePages = new Set<string>(), seenMovementPages = new Set<string>();
      const ranges: { cursor: number; first: number; last: number }[] = [];
      let movementTotal: number | undefined;
      const acceptLines = (page: BankDetailEvidence) => {
        if (!same(metadata(page.value), metadata(reference))) return fail('bank_review_changed');
        const key = page.query.lineCursor ?? '';
        if (seenLinePages.has(key)) return fail('bank_review_changed'); seenLinePages.add(key);
        for (const line of page.value.lines.items) {
          if (seenLines.has(line.lineId) || seenOrdinals.has(line.ordinal)) return fail('bank_review_changed'); seenLines.add(line.lineId); seenOrdinals.add(line.ordinal);
          if (selectedIds.has(line.lineId)) selectedLines.set(line.lineId, line);
        }
      };
      acceptLines(base); for (const raw of lines) acceptLines(detailEvidence(raw, s));
      for (const raw of movements) {
        const page = movementEvidence(raw, s), p = page.value;
        if (page.query.statementId !== operation.statementId || page.query.origin !== reference.statement.origin || p.ledgerRevision !== reference.ledgerRevision || movementTotal !== undefined && movementTotal !== p.total) return fail('bank_review_changed'); movementTotal = p.total;
        const key = page.query.cursor ?? ''; if (seenMovementPages.has(key)) return fail('bank_review_changed'); seenMovementPages.add(key);
        const cursor = page.query.cursor == null ? 0 : JSON.parse(page.query.cursor)[6] as number;
        if (p.items.length) ranges.push({ cursor, first: p.items[0].journalRevision, last: p.items[p.items.length - 1].journalRevision });
        for (const row of p.items) { if (seenJournals.has(row.journalRevision)) return fail('bank_review_changed'); seenJournals.add(row.journalRevision); if (selectedRevisions.has(row.journalRevision)) selectedMovements.set(row.journalRevision, row); }
      }
      ranges.sort((a, b) => a.cursor - b.cursor);
      if (ranges.some((r, i) => i > 0 && r.first <= ranges[i - 1].last)) return fail('bank_review_changed');
      if (selectedLines.size !== selectedIds.size || selectedMovements.size !== selectedRevisions.size) return fail('bank_review_evidence_required');
      if ([...selectedLines.values()].some(l => l.matchId !== null) || [...selectedMovements.values()].some(m => m.status !== 'available' || m.bankDate < reference.statement.start || m.bankDate > reference.statement.end)) return fail('bank_selection_unavailable');
      const compact = protect(() => snapshotPrivateJson({ lines: [...selectedLines.values()], movements: [...selectedMovements.values()] }), 'bank_input_too_large');
      protect(() => assertUsFinancialPilotBankCapacity(compact), 'bank_input_too_large');
      if (bytes(JSON.stringify(compact)) > US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES) return fail('bank_input_too_large');
      const statementMinor = [...selectedLines.values()].reduce((n, l) => n + BigInt(l.amountMinor), BigInt(0)).toString(), movementMinor = [...selectedMovements.values()].reduce((n, m) => n + BigInt(m.amountMinor), BigInt(0)).toString();
      if (statementMinor !== movementMinor) return fail('reconciliation_amount_mismatch');
      matchTotals = Object.freeze({ statementLineCount: selectedLines.size, movementCount: selectedMovements.size, statementMinor, movementMinor, differenceMinor: '0' });
    }
    return Object.freeze({ ...captured, organizationId: s.organizationId, importTotals: null, matchTotals });
  });
}

export type UsFinancialPilotBankExportSelector = Readonly<{
  consumer: 'financial-pilot'; schemaVersion: 1; kind: 'bank_reconciliation'; organizationId: string;
  revision: number; bankRevision: number; statementRevision: number; statementId: string;
  origin: 'legacy-frozen' | 'financial-v5'; format: 'csv'; language: CompanyLanguage;
}>;
export const US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS = Object.freeze({
  scope: 'X-Zentra-Financial-Pilot', bankScope: 'X-Zentra-Financial-Pilot-Bank', organization: 'X-Zentra-Organization-Id',
  revision: 'X-Zentra-Financial-Revision', bankRevision: 'X-Zentra-Bank-Revision', statementRevision: 'X-Zentra-Statement-Revision',
  statementId: 'X-Zentra-Statement-Id', origin: 'X-Zentra-Bank-Origin', ledgerRevision: 'X-Zentra-Ledger-Revision',
  currency: 'X-Zentra-Currency', language: 'X-Zentra-Export-Language', format: 'X-Zentra-Export-Format',
  selectorHash: 'X-Zentra-Export-Selector-SHA256', contentHash: 'X-Zentra-Content-SHA256',
});
export function validateUsFinancialPilotBankExportSelector(value: unknown, organizationId?: string): UsFinancialPilotBankExportSelector {
  try {
    const v = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'kind', 'organizationId', 'revision', 'bankRevision', 'statementRevision', 'statementId', 'origin', 'format', 'language']);
    if (v.consumer !== 'financial-pilot' || v.schemaVersion !== 1 || v.kind !== 'bank_reconciliation' || v.format !== 'csv' || !['fr', 'de', 'it', 'en'].includes(v.language as string) || !['legacy-frozen', 'financial-v5'].includes(v.origin as string)) return fail('invalid_financial_pilot_bank_export_selector');
    const org = uuid(v.organizationId); if (organizationId !== undefined && org !== organizationId) return fail('invalid_financial_pilot_bank_export_selector');
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, kind: 'bank_reconciliation', organizationId: org, revision: integer(v.revision, 1), bankRevision: integer(v.bankRevision, 0, 1000), statementRevision: integer(v.statementRevision, 0), statementId: uuid(v.statementId), origin: v.origin as UsFinancialPilotBankExportSelector['origin'], format: 'csv', language: v.language as CompanyLanguage });
  } catch { return fail('invalid_financial_pilot_bank_export_selector'); }
}
export function browserUsFinancialPilotBankExportUrl(value: UsFinancialPilotBankExportSelector): string {
  const s = validateUsFinancialPilotBankExportSelector(value), query = new URLSearchParams({ revision: String(s.revision), bankRevision: String(s.bankRevision), statementRevision: String(s.statementRevision), origin: s.origin, format: s.format, language: s.language });
  return `/api/international/workspaces/${encodeURIComponent(s.organizationId)}/financial-pilot/bank/statements/${encodeURIComponent(s.statementId)}/export?${query}`;
}
