import { assertFinancialAuthority, LedgerError, validDate, type FinancialAuthority, type Ledger } from './accounting/ledger';
import { approveReconciliationMatch, completeReconciliation, createReconciliation, type BankStatement, type Reconciliation, type ReconciliationMatch } from './accounting/reconciliation';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { UsBankCommand, UsBankRecord, UsBankRequest } from './us-bank-contract';

export const MAX_US_BANK_STATEMENT_LINES = 1000;
export const MAX_US_BANK_RECORDS = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const signedPattern = /^(?:0|-?[1-9][0-9]{0,35})$/;

function fail(code = 'invalid_bank_request', status = 422): never { throw new ErpError(code, status); }
function snapshot(input: unknown): unknown { try { return snapshotPrivateJson(input); } catch { return fail(); } }
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const v = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) return fail();
  return v;
}
function text(input: unknown, maximum = 160): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || Array.from(input).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return input;
}
function uuid(input: unknown): string { if (typeof input !== 'string' || !uuidPattern.test(input)) return fail(); return input; }
function key(input: unknown): string { if (typeof input !== 'string' || !keyPattern.test(input)) return fail(); return input; }
function integer(input: unknown): number { if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) >= Number.MAX_SAFE_INTEGER) return fail(); return input as number; }
function organization(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) return fail();
  return input;
}
function date(input: unknown): string { if (typeof input !== 'string' || input.startsWith('0000-') || !validDate(input)) return fail(); return input; }
function instant(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input) || input.startsWith('0000-')) return fail();
  try { parseInstant(input); } catch { return fail(); }
  return input;
}
function amount(input: unknown, nonzero = false): BankStatement['opening'] {
  const v = fields(input, ['currency', 'minorUnits']);
  if (v.currency !== 'USD' || typeof v.minorUnits !== 'string' || !signedPattern.test(v.minorUnits) || (nonzero && v.minorUnits === '0')) return fail();
  return Object.freeze({ currency: 'USD', minorUnits: v.minorUnits });
}
function ids(input: unknown, maximum = 160): readonly string[] {
  if (!Array.isArray(input) || !input.length || input.length > 1000) return fail();
  const result = input.map(value => text(value, maximum));
  if (new Set(result).size !== result.length) return fail();
  return Object.freeze(result);
}
/** Match IDs are sets. Canonical request hashing uses the same UTF16 lexical
 * order as the existing reconciliation engine; it does not reorder CSV lines. */
function canonicalIds(input: unknown, maximum = 160): readonly string[] { return Object.freeze([...ids(input, maximum)].sort()); }
function statement(input: unknown, organizationId: string): BankStatement {
  const v = fields(input, ['id', 'organizationId', 'externalConnectionId', 'currency', 'cashAccountId', 'start', 'end', 'opening', 'closing', 'lines']);
  if (v.organizationId !== organizationId || v.currency !== 'USD' || !Array.isArray(v.lines) || v.lines.length > MAX_US_BANK_STATEMENT_LINES) return fail();
  const start = date(v.start), end = date(v.end), opening = amount(v.opening), closing = amount(v.closing);
  if (end < start) return fail();
  const lines = v.lines.map(raw => {
    const l = fields(raw, ['id', 'date', 'amount', 'reference']), d = date(l.date);
    if (d < start || d > end) return fail();
    return Object.freeze({ id: text(l.id), date: d, amount: amount(l.amount, true), reference: text(l.reference, 256) });
  });
  if (new Set(lines.map(line => line.id)).size !== lines.length || BigInt(opening.minorUnits) + lines.reduce((sum, line) => sum + BigInt(line.amount.minorUnits), BigInt(0)) !== BigInt(closing.minorUnits)) return fail();
  return Object.freeze({ id: uuid(v.id), organizationId, externalConnectionId: text(v.externalConnectionId), currency: 'USD', cashAccountId: text(v.cashAccountId), start, end, opening, closing, lines: Object.freeze(lines) });
}

/** Structural request capture only: match ID sets are copied/sorted before the
 * service hashes this canonical request. The service/SQL compares actual ERP
 * HEAD, not ledger.revision, and checks a receipt before a new transition. */
export function validateUsBankRequest(input: unknown, organizationId: string): UsBankRequest {
  const org = organization(organizationId), v = fields(snapshot(input), ['schemaVersion', 'idempotencyKey', 'reconciliationId', 'expectedErpRevision', 'expectedReconciliationRevision', 'command']);
  if (v.schemaVersion !== 1) return fail();
  const reconciliationId = uuid(v.reconciliationId), c = fields(v.command, ['type'], ['statement', 'id', 'statementLineIds', 'ledgerEntryIds', 'reason']);
  let command: UsBankCommand;
  switch (c.type) {
    case 'create_statement': {
      fields(c, ['type', 'statement']);
      const imported = statement(c.statement, org);
      if (v.expectedReconciliationRevision !== null || imported.id !== reconciliationId) return fail();
      command = Object.freeze({ type: 'create_statement', statement: imported }); break;
    }
    case 'approve_match':
      fields(c, ['type', 'id', 'statementLineIds', 'ledgerEntryIds']);
      command = Object.freeze({ type: 'approve_match', id: uuid(c.id), statementLineIds: canonicalIds(c.statementLineIds), ledgerEntryIds: canonicalIds(c.ledgerEntryIds, 512) }); break;
    case 'complete': fields(c, ['type']); command = Object.freeze({ type: 'complete' }); break;
    case 'void_statement': fields(c, ['type', 'reason']); command = Object.freeze({ type: 'void_statement', reason: text(c.reason, 2000) }); break;
    default: return fail();
  }
  const expectedReconciliationRevision = v.expectedReconciliationRevision === null ? null : integer(v.expectedReconciliationRevision);
  if (command.type !== 'create_statement' && expectedReconciliationRevision === null) return fail();
  const expectedErpRevision = integer(v.expectedErpRevision);
  if (expectedErpRevision < 1) return fail();
  return Object.freeze({ schemaVersion: 1, idempotencyKey: key(v.idempotencyKey), reconciliationId, expectedErpRevision, expectedReconciliationRevision, command });
}

/** A persisted snapshot cannot grant a role or assert that the current ledger
 * still reconciles. It verifies immutable facts and chronology without a book. */
export function validateUsBankRecord(input: unknown, organizationId: string): UsBankRecord {
  try {
    const org = organization(organizationId), v = fields(snapshot(input), ['schemaVersion', 'reconciliation', 'createdBy', 'createdAt'], ['voided']);
    if (v.schemaVersion !== 1) return fail();
    const r = fields(v.reconciliation, ['organizationId', 'statement', 'revision', 'matches'], ['completedAt', 'completedBy', 'completedLedgerRevision']);
    if (r.organizationId !== org || !Array.isArray(r.matches) || r.matches.length > 1000) return fail();
    const imported = statement(r.statement, org), createdBy = text(v.createdBy, 256), createdAt = instant(v.createdAt);
    let latestAt = parseInstant(createdAt).getTime();
    const lineIds = new Set(imported.lines.map(line => line.id)), matchedLines = new Set<string>(), matchedEntries = new Set<string>(), matchIds = new Set<string>(), matchKeys = new Set<string>();
    const matches: ReconciliationMatch[] = r.matches.map(raw => {
      const m = fields(raw, ['id', 'idempotencyKey', 'statementLineIds', 'ledgerEntryIds', 'fingerprint', 'approvedBy', 'approvedAt']);
      const id = uuid(m.id), idempotencyKey = key(m.idempotencyKey), statementLineIds = ids(m.statementLineIds), ledgerEntryIds = ids(m.ledgerEntryIds, 512), approvedBy = text(m.approvedBy, 256), approvedAt = instant(m.approvedAt);
      const stamp = parseInstant(approvedAt).getTime();
      const sortedLines = [...statementLineIds].sort(), sortedEntries = [...ledgerEntryIds].sort();
      const fingerprint = JSON.stringify([org, imported.id, 'USD', imported.cashAccountId, sortedLines, sortedEntries]);
      if (stamp < latestAt || matchIds.has(id) || matchKeys.has(idempotencyKey) || m.fingerprint !== fingerprint || statementLineIds.some((value, index) => value !== sortedLines[index] || !lineIds.has(value) || matchedLines.has(value)) || ledgerEntryIds.some((value, index) => value !== sortedEntries[index] || matchedEntries.has(value))) return fail();
      latestAt = stamp; matchIds.add(id); matchKeys.add(idempotencyKey); statementLineIds.forEach(value => matchedLines.add(value)); ledgerEntryIds.forEach(value => matchedEntries.add(value));
      return Object.freeze({ id, idempotencyKey, statementLineIds, ledgerEntryIds, fingerprint, approvedBy, approvedAt });
    });
    const completionKeys = ['completedAt', 'completedBy', 'completedLedgerRevision'];
    const completed = completionKeys.some(k => Object.hasOwn(r, k));
    if (completed && (completionKeys.some(k => !Object.hasOwn(r, k)) || matchedLines.size !== imported.lines.length)) return fail();
    const completion = completed ? { completedAt: instant(r.completedAt), completedBy: text(r.completedBy, 256), completedLedgerRevision: integer(r.completedLedgerRevision) } : null;
    if (completion && parseInstant(completion.completedAt).getTime() < latestAt) return fail();
    const voidedInput = Object.hasOwn(v, 'voided') ? fields(v.voided, ['by', 'at', 'reason']) : null;
    const voided = voidedInput ? Object.freeze({ by: text(voidedInput.by, 256), at: instant(voidedInput.at), reason: text(voidedInput.reason, 2000) }) : null;
    if (voided && (matches.length || completed || parseInstant(voided.at).getTime() < latestAt)) return fail();
    const revision = integer(r.revision);
    if (revision !== matches.length + (completed ? 1 : 0) + (voided ? 1 : 0)) return fail();
    const reconciliation: Reconciliation = Object.freeze({ organizationId: org, statement: imported, revision, matches: Object.freeze(matches), ...completion });
    return Object.freeze({ schemaVersion: 1, reconciliation, createdBy, createdAt, ...(voided ? { voided } : {}) });
  } catch { return fail('invalid_bank_record', 503); }
}

function importIdentity(s: BankStatement): string {
  return canonicalErpJson([s.organizationId, s.cashAccountId, s.start, s.end, s.opening.minorUnits, s.closing.minorUnits, s.lines.map(line => [line.date, line.amount.minorUnits, line.reference])]);
}
function controlled(error: unknown): never {
  if (error instanceof ErpError) throw error;
  if (error instanceof LedgerError) {
    const known: Record<string, readonly [string, number]> = {
      TENANT_MISMATCH: ['tenant_mismatch', 403], FINANCIAL_PERMISSION_REQUIRED: ['financial_permission_required', 403], MANAGEMENT_ENTITLEMENT_REQUIRED: ['management_entitlement_required', 402],
      CASH_ACCOUNT_REQUIRED: ['cash_account_required', 422], REVISION_CONFLICT: ['bank_revision_conflict', 409], IDEMPOTENCY_CONFLICT: ['idempotency_conflict', 409],
      RECONCILIATION_CLOSED: ['reconciliation_closed', 409], RECONCILIATION_LEDGER_CHANGED: ['reconciliation_ledger_changed', 409], RECONCILIATION_INCOMPLETE: ['reconciliation_incomplete', 409],
      RECONCILIATION_ALREADY_MATCHED: ['reconciliation_already_matched', 409], RECONCILIATION_AMOUNT_MISMATCH: ['reconciliation_amount_mismatch', 422],
      STATEMENT_LINE_REQUIRED: ['statement_line_required', 422], LEDGER_ENTRY_REQUIRED: ['ledger_entry_required', 422], CASH_MOVEMENT_REQUIRED: ['cash_movement_required', 422], INVALID_STATEMENT_DATE: ['invalid_bank_statement', 422],
    };
    const mapped = known[error.code]; if (mapped) return fail(...mapped);
  }
  return fail('service_unavailable', 503);
}

/** Pure review transition. ERP revision, schema4, fresh Auth and SQL atomicity
 * remain service/store responsibilities. This never modifies/posts a ledger. */
export function applyUsBankCommand(record: UsBankRecord | null, request: UsBankRequest, ledger: Ledger, actor: FinancialAuthority, siblings: readonly UsBankRecord[]): UsBankRecord {
  try {
    const freshActor = snapshot(actor) as FinancialAuthority;
    assertFinancialAuthority(ledger, freshActor);
    if (ledger.currency !== 'USD') return fail('edition_unavailable', 409);
    const currentRequest = validateUsBankRequest(request, ledger.organizationId), current = record === null ? null : validateUsBankRecord(record, ledger.organizationId);
    const stamp = instant(freshActor.timestamp); text(freshActor.userId, 256);
    if (!Array.isArray(siblings) || siblings.length > MAX_US_BANK_RECORDS) return fail('bank_statement_limit_reached', 409);
    if (Object.getPrototypeOf(siblings) !== Array.prototype || Reflect.ownKeys(siblings).length !== siblings.length + 1) return fail('invalid_bank_record', 503);
    const all: UsBankRecord[] = [];
    for (let i = 0; i < siblings.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(siblings, String(i));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail('invalid_bank_record', 503);
      all.push(validateUsBankRecord(descriptor.value, ledger.organizationId));
    }
    const siblingIds = all.map(sibling => sibling.reconciliation.statement.id);
    if (new Set(siblingIds).size !== siblingIds.length) return fail('invalid_bank_record', 503);
    const same = all.find(sibling => sibling.reconciliation.statement.id === currentRequest.reconciliationId);
    if (same && (!current || canonicalErpJson(same) !== canonicalErpJson(current))) return fail('bank_revision_conflict', 409);
    const others = all.filter(sibling => sibling.reconciliation.statement.id !== currentRequest.reconciliationId);
    if (currentRequest.command.type === 'create_statement') {
      if (current) return fail('bank_statement_duplicate', 409);
      if (all.length >= MAX_US_BANK_RECORDS) return fail('bank_statement_limit_reached', 409);
      const s = currentRequest.command.statement;
      if (all.some(sibling => importIdentity(sibling.reconciliation.statement) === importIdentity(s))) return fail('bank_statement_duplicate', 409);
      if (all.some(sibling => !sibling.voided && sibling.reconciliation.statement.cashAccountId === s.cashAccountId && s.start <= sibling.reconciliation.statement.end && sibling.reconciliation.statement.start <= s.end)) return fail('bank_statement_overlap', 409);
      return validateUsBankRecord({ schemaVersion: 1, reconciliation: createReconciliation(s, ledger, freshActor), createdBy: freshActor.userId, createdAt: stamp }, ledger.organizationId);
    }
    if (!current || current.reconciliation.statement.id !== currentRequest.reconciliationId) return fail('reconciliation_not_found', 404);
    if (current.voided) return fail('reconciliation_voided', 409);
    if (current.reconciliation.completedAt) return fail('reconciliation_closed', 409);
    if (current.reconciliation.revision !== currentRequest.expectedReconciliationRevision || current.reconciliation.revision >= Number.MAX_SAFE_INTEGER - 1) return fail('bank_revision_conflict', 409);
    const latest = current.reconciliation.matches.at(-1)?.approvedAt ?? current.createdAt;
    if (parseInstant(stamp).getTime() < parseInstant(latest).getTime()) return fail('bank_clock_reversed', 409);
    if (currentRequest.command.type === 'void_statement') {
      if (current.reconciliation.matches.length) return fail('statement_not_voidable', 409);
      return validateUsBankRecord({ ...current, reconciliation: { ...current.reconciliation, revision: current.reconciliation.revision + 1 }, voided: { by: freshActor.userId, at: stamp, reason: currentRequest.command.reason } }, ledger.organizationId);
    }
    let reconciliation: Reconciliation;
    if (currentRequest.command.type === 'approve_match') {
      const c = currentRequest.command;
      if (others.some(sibling => !sibling.voided && sibling.reconciliation.matches.some(match => match.ledgerEntryIds.some(id => c.ledgerEntryIds.includes(id))))) return fail('bank_entry_already_matched', 409);
      for (const id of c.ledgerEntryIds) {
        const entry = ledger.entries.find(candidate => candidate.id === id);
        if (entry && parseInstant(stamp).getTime() < parseInstant(entry.postedAt).getTime()) return fail('bank_clock_reversed', 409);
      }
      if (JSON.stringify([ledger.organizationId, current.reconciliation.statement.id, 'USD', current.reconciliation.statement.cashAccountId, [...c.statementLineIds].sort(), [...c.ledgerEntryIds].sort()]).length > 524288) return fail('invalid_bank_request', 422);
      reconciliation = approveReconciliationMatch(current.reconciliation, ledger, { id: c.id, idempotencyKey: currentRequest.idempotencyKey, statementLineIds: c.statementLineIds, ledgerEntryIds: c.ledgerEntryIds }, freshActor, current.reconciliation.revision);
    } else reconciliation = completeReconciliation(current.reconciliation, ledger, freshActor, current.reconciliation.revision);
    if (reconciliation.revision !== current.reconciliation.revision + 1) return fail('idempotency_conflict', 409);
    return validateUsBankRecord({ ...current, reconciliation }, ledger.organizationId);
  } catch (error) { return controlled(error); }
}
