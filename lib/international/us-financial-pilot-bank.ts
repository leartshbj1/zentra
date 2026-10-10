import { assertFinancialAuthority, validDate, type FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { UsBankRecord, UsBankRequest } from './us-bank-contract';
import { applyUsBankCommand, validateUsBankRecord, validateUsBankRequest } from './us-bank-reconciliation';
import { projectUsFinancialBookV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialBookViewV5, UsFinancialPolicyV5 } from './us-financial-kernel-types';

export const US_FINANCIAL_PILOT_BANK_MAX_BODY_BYTES = 1_048_576;
export const US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES = 2_621_440;
export const US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS = 1000;
export const US_FINANCIAL_PILOT_BANK_MANUAL_MARKER = 'manual-csv:financial-pilot-v1';
export type UsFinancialPilotBankOrigin = 'legacy-frozen' | 'financial-v5';
export type UsFinancialPilotBankCommand =
  | Readonly<{ type: 'create_statement'; cashAccountId: string; start: string; end: string; openingMinor: string; closingMinor: string; lines: readonly Readonly<{ date: string; amountMinor: string; reference: string }>[] }>
  | Readonly<{ type: 'approve_match'; statementId: string; statementLineIds: readonly string[]; journalRevisions: readonly number[] }>
  | Readonly<{ type: 'complete'; statementId: string }>
  | Readonly<{ type: 'void_statement'; statementId: string; reason: string }>;
export interface UsFinancialPilotBankRequest {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly requestId: string;
  readonly expectedRevision: number; readonly expectedBankRevision: number; readonly expectedStatementRevision: number | null;
  readonly command: UsFinancialPilotBankCommand;
}
export interface UsFinancialPilotBankHead {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number; readonly bankRevision: number;
}
export interface UsFinancialPilotBankRecord { readonly origin: UsFinancialPilotBankOrigin; readonly record: UsBankRecord }
export interface UsFinancialPilotBankSource { readonly revision: number; readonly ledgerRevision: number; readonly bookSha256: string }
export interface UsFinancialPilotBankOperationProof {
  readonly schemaVersion: 1; readonly organizationId: string; readonly request: UsFinancialPilotBankRequest; readonly actor: FinancialAuthority;
  readonly idempotencyKey: string; readonly commandHash: string; readonly action: UsFinancialPilotBankCommand['type']; readonly statementId: string;
  readonly bankRevision: number; readonly statementRevision: number; readonly source: UsFinancialPilotBankSource;
}
export interface UsFinancialPilotBankRegister {
  readonly schemaVersion: 1; readonly organizationId: string; readonly bankRevision: number;
  readonly records: readonly UsFinancialPilotBankRecord[]; readonly operations: readonly UsFinancialPilotBankOperationProof[];
}
export interface UsFinancialPilotBankRead { readonly book: UsFinancialBookV5; readonly register: UsFinancialPilotBankRegister }
export interface UsFinancialPilotBankReceipt extends UsFinancialPilotBankHead {
  readonly requestId: string; readonly action: UsFinancialPilotBankCommand['type']; readonly statementId: string; readonly statementRevision: number;
}
export interface UsFinancialPilotBankWriteResult { readonly receipt: UsFinancialPilotBankReceipt; readonly replayed: boolean }
export interface UsFinancialPilotBankCommit { readonly request: UsFinancialPilotBankRequest; readonly proof: UsFinancialPilotBankOperationProof; readonly record: UsFinancialPilotBankRecord }
export interface UsFinancialPilotBankPort {
  read(this: void): Promise<UsFinancialPilotBankRead>;
  head(this: void): Promise<UsFinancialPilotBankHead>;
  receipt(this: void, requestId: string): Promise<UsFinancialPilotBankOperationProof | null>;
  commit(this: void, input: UsFinancialPilotBankCommit): Promise<UsFinancialPilotBankOperationProof>;
}
export interface UsFinancialPilotBankDependencies {
  readonly organizationId: string; readonly actor: FinancialAuthority; readonly policy: UsFinancialPolicyV5; readonly store: UsFinancialPilotBankPort;
  revalidate(this: void): Promise<Readonly<{ actor: FinancialAuthority; policy: UsFinancialPolicyV5 }>>;
}

const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const fail = (code = 'invalid_financial_bank_data', status = 503): never => { throw new ErpError(code, status); };
const invalidRequest = (): never => fail('invalid_financial_pilot_request', 422);
function capture(value: unknown): unknown { try { return snapshotPrivateJson(value); } catch { return fail(); } }
function fields(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key))) return fail();
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail();
  return value;
}
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return value;
}
function org(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return fail(); return value; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return fail(); return value; }
function date(value: unknown): string { if (typeof value !== 'string' || value.startsWith('0000-') || !validDate(value)) return fail(); return value; }
function minor(value: unknown, nonzero = false): string { if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]{0,35})$/.test(value) || (nonzero && value === '0')) return fail(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail(); return value; }
function actor(value: unknown, organizationId: string): FinancialAuthority {
  const a = fields(value, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (a.organizationId !== organizationId || !['owner', 'admin', 'accountant'].includes(a.role as string) || a.managementEntitled !== true) return fail();
  text(a.userId, 256); if (typeof a.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(a.timestamp)) return fail(); parseInstant(a.timestamp);
  return Object.freeze({ ...a }) as unknown as FinancialAuthority;
}

/** The SQL helper's conservative JSONB budgets also apply to the full private register. */
export function assertUsFinancialPilotBankCapacity(value: unknown, append = false): void {
  try {
    const data = snapshotPrivateJson(value), encoder = new TextEncoder(); let nodes = 0, decoded = 0;
    const visit = (row: unknown, depth: number): string => {
      if (++nodes > 49_000 || depth > 20) return fail();
      if (typeof row === 'string') { const bytes = encoder.encode(row).byteLength; decoded += bytes; if (bytes > 500_000 || decoded > 2_000_000) return fail(); return JSON.stringify(row); }
      if (Array.isArray(row)) return '[' + row.map(child => visit(child, depth + 1)).join(', ') + ']';
      if (row && typeof row === 'object') return '{' + Object.entries(row).map(([key, child]) => { const bytes = encoder.encode(key).byteLength; decoded += bytes; if (bytes > 500_000 || decoded > 2_000_000) return fail(); return JSON.stringify(key) + ': ' + visit(child, depth + 1); }).join(', ') + '}';
      return JSON.stringify(row);
    };
    if (encoder.encode(visit(data, 0)).byteLength > 2_600_000 || encoder.encode(JSON.stringify(data)).byteLength > US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES) return fail();
  } catch { return fail(append ? 'bank_limit_reached' : 'invalid_financial_bank_data', append ? 409 : 503); }
}

/** Detached own-data capture; selected sets are canonical, imported rows remain ordered. */
export function validateUsFinancialPilotBankRequest(value: unknown): UsFinancialPilotBankRequest {
  try {
    const r = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'requestId', 'expectedRevision', 'expectedBankRevision', 'expectedStatementRevision', 'command']);
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1) return invalidRequest();
    const requestId = uuid(r.requestId), expectedRevision = integer(r.expectedRevision, 1), expectedBankRevision = integer(r.expectedBankRevision, 0, Number.MAX_SAFE_INTEGER - 2);
    const c = fields(r.command, ['type'], ['cashAccountId', 'start', 'end', 'openingMinor', 'closingMinor', 'lines', 'statementId', 'statementLineIds', 'journalRevisions', 'reason']);
    let command: UsFinancialPilotBankCommand;
    if (c.type === 'create_statement') {
      fields(c, ['type', 'cashAccountId', 'start', 'end', 'openingMinor', 'closingMinor', 'lines']);
      const start = date(c.start), end = date(c.end), openingMinor = minor(c.openingMinor), closingMinor = minor(c.closingMinor);
      if (start > end || !Array.isArray(c.lines) || c.lines.length > 1000 || r.expectedStatementRevision !== null) return invalidRequest();
      const lines = c.lines.map(raw => { const l = fields(raw, ['date', 'amountMinor', 'reference']), d = date(l.date); if (d < start || d > end) return invalidRequest(); return Object.freeze({ date: d, amountMinor: minor(l.amountMinor, true), reference: text(l.reference, 256) }); });
      if (BigInt(openingMinor) + lines.reduce((n, l) => n + BigInt(l.amountMinor), BigInt(0)) !== BigInt(closingMinor)) return invalidRequest();
      command = Object.freeze({ type: 'create_statement', cashAccountId: text(c.cashAccountId), start, end, openingMinor, closingMinor, lines: Object.freeze(lines) });
    } else if (c.type === 'approve_match') {
      fields(c, ['type', 'statementId', 'statementLineIds', 'journalRevisions']);
      if (!Array.isArray(c.statementLineIds) || !c.statementLineIds.length || c.statementLineIds.length > 1000 || !Array.isArray(c.journalRevisions) || !c.journalRevisions.length || c.journalRevisions.length > 1000) return invalidRequest();
      const statementLineIds = c.statementLineIds.map(id => text(id)), journalRevisions = c.journalRevisions.map(revision => integer(revision, 1));
      if (new Set(statementLineIds).size !== statementLineIds.length || new Set(journalRevisions).size !== journalRevisions.length) return invalidRequest();
      command = Object.freeze({ type: 'approve_match', statementId: uuid(c.statementId), statementLineIds: Object.freeze(statementLineIds.sort()), journalRevisions: Object.freeze(journalRevisions.sort((a, b) => a - b)) });
    } else if (c.type === 'complete') { fields(c, ['type', 'statementId']); command = Object.freeze({ type: 'complete', statementId: uuid(c.statementId) }); }
    else if (c.type === 'void_statement') { fields(c, ['type', 'statementId', 'reason']); command = Object.freeze({ type: 'void_statement', statementId: uuid(c.statementId), reason: text(c.reason, 2000) }); }
    else return invalidRequest();
    const expectedStatementRevision = r.expectedStatementRevision === null ? null : integer(r.expectedStatementRevision, 0, Number.MAX_SAFE_INTEGER - 2);
    if (command.type !== 'create_statement' && expectedStatementRevision === null) return invalidRequest();
    const result = Object.freeze({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, requestId, expectedRevision, expectedBankRevision, expectedStatementRevision, command });
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > US_FINANCIAL_PILOT_BANK_MAX_BODY_BYTES) return invalidRequest();
    return result;
  } catch { return invalidRequest(); }
}
export function usFinancialPilotBankStatementId(request: UsFinancialPilotBankRequest): string { const r = validateUsFinancialPilotBankRequest(request); return r.command.type === 'create_statement' ? r.requestId : r.command.statementId; }
export function usFinancialPilotBankIdempotencyKey(request: UsFinancialPilotBankRequest): string { return `pilot:bank:${validateUsFinancialPilotBankRequest(request).requestId}`; }
export function validateUsFinancialPilotBankHead(value: unknown, organizationId?: string): UsFinancialPilotBankHead {
  const h = fields(capture(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision']);
  if (h.consumer !== 'financial-pilot' || h.schemaVersion !== 1 || (organizationId !== undefined && h.organizationId !== organizationId)) return fail();
  return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org(h.organizationId), revision: integer(h.revision, 1), bankRevision: integer(h.bankRevision, 0, US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS) });
}
export function validateUsFinancialPilotBankReceipt(value: unknown, organizationId?: string, request?: UsFinancialPilotBankRequest): UsFinancialPilotBankReceipt {
  const r = fields(capture(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision', 'requestId', 'action', 'statementId', 'statementRevision']);
  const h = validateUsFinancialPilotBankHead({ consumer: r.consumer, schemaVersion: r.schemaVersion, organizationId: r.organizationId, revision: r.revision, bankRevision: r.bankRevision }, organizationId);
  if (!['create_statement', 'approve_match', 'complete', 'void_statement'].includes(r.action as string)) return fail();
  const result = Object.freeze({ ...h, requestId: uuid(r.requestId), action: r.action as UsFinancialPilotBankCommand['type'], statementId: uuid(r.statementId), statementRevision: integer(r.statementRevision) });
  if (result.bankRevision < 1 || (result.action === 'create_statement' ? result.statementRevision !== 0 || result.requestId !== result.statementId : result.statementRevision < 1)) return fail();
  if (request) { const expected = validateUsFinancialPilotBankRequest(request); if (result.requestId !== expected.requestId || result.action !== expected.command.type || result.statementId !== usFinancialPilotBankStatementId(expected) || result.revision !== expected.expectedRevision || result.bankRevision !== expected.expectedBankRevision + 1 || result.statementRevision !== (expected.expectedStatementRevision === null ? 0 : expected.expectedStatementRevision + 1)) return fail(); }
  return result;
}
function operationProof(value: unknown, organizationId?: string): UsFinancialPilotBankOperationProof {
  const p = fields(capture(value), ['schemaVersion', 'organizationId', 'request', 'actor', 'idempotencyKey', 'commandHash', 'action', 'statementId', 'bankRevision', 'statementRevision', 'source']);
  const organization = org(p.organizationId), request = validateUsFinancialPilotBankRequest(p.request), a = actor(p.actor, organization), s = fields(p.source, ['revision', 'ledgerRevision', 'bookSha256']);
  if (p.schemaVersion !== 1 || !same(p.request, request) || (organizationId !== undefined && organization !== organizationId) || p.idempotencyKey !== usFinancialPilotBankIdempotencyKey(request) || p.action !== request.command.type || p.statementId !== usFinancialPilotBankStatementId(request) || p.bankRevision !== request.expectedBankRevision + 1 || p.statementRevision !== (request.expectedStatementRevision === null ? 0 : request.expectedStatementRevision + 1) || s.revision !== request.expectedRevision) return fail();
  return Object.freeze({ schemaVersion: 1, organizationId: organization, request, actor: a, idempotencyKey: p.idempotencyKey as string, commandHash: hash(p.commandHash), action: request.command.type, statementId: p.statementId as string,
    bankRevision: integer(p.bankRevision, 1, US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS), statementRevision: integer(p.statementRevision), source: Object.freeze({ revision: integer(s.revision, 1), ledgerRevision: integer(s.ledgerRevision, 0, s.revision as number), bookSha256: hash(s.bookSha256) }) });
}
export function validateUsFinancialPilotBankOperationProof(value: unknown, organizationId?: string): UsFinancialPilotBankOperationProof { try { return operationProof(value, organizationId); } catch { return fail(); } }
export function validateUsFinancialPilotBankRegister(value: unknown, organizationId?: string): UsFinancialPilotBankRegister {
  const raw = capture(value); assertUsFinancialPilotBankCapacity(raw);
  const r = fields(raw, ['schemaVersion', 'organizationId', 'bankRevision', 'records', 'operations']), organization = org(r.organizationId);
  if (r.schemaVersion !== 1 || (organizationId !== undefined && organization !== organizationId) || !Array.isArray(r.records) || r.records.length > 100 || !Array.isArray(r.operations) || r.operations.length > US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS) return fail();
  const records = r.records.map(rawRecord => { const v = fields(rawRecord, ['origin', 'record']); if (v.origin !== 'legacy-frozen' && v.origin !== 'financial-v5') return fail(); return Object.freeze({ origin: v.origin, record: validateUsBankRecord(v.record, organization) }); });
  const operations = r.operations.map(p => validateUsFinancialPilotBankOperationProof(p, organization)), bankRevision = integer(r.bankRevision, 0, US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS);
  if (bankRevision !== operations.length || operations.some((p, i) => p.bankRevision !== i + 1) || new Set(operations.map(p => p.idempotencyKey)).size !== operations.length || new Set(records.map(r => r.record.reconciliation.statement.id)).size !== records.length) return fail();
  const currentIds = new Set(records.filter(r => r.origin === 'financial-v5').map(r => r.record.reconciliation.statement.id));
  if (operations.some(p => !currentIds.has(p.statementId))) return fail();
  for (const record of records.filter(r => r.origin === 'financial-v5')) { const history = operations.filter(p => p.statementId === record.record.reconciliation.statement.id); if (!history.length || history[0].action !== 'create_statement' || history.some((p, i) => p.statementRevision !== i) || history.at(-1)!.statementRevision !== record.record.reconciliation.revision) return fail(); }
  return Object.freeze({ schemaVersion: 1, organizationId: organization, bankRevision, records: Object.freeze(records), operations: Object.freeze(operations) });
}
export async function usFinancialPilotBankCommandHash(organizationId: string, actorId: string, request: UsFinancialPilotBankRequest): Promise<string> {
  const organization = org(organizationId), user = text(actorId, 256), captured = validateUsFinancialPilotBankRequest(request);
  return sha256Hex(canonicalErpJson([organization, user, captured]));
}
export function usFinancialPilotBankContent(value: UsBankRecord): string {
  const raw = fields(capture(value), ['schemaVersion', 'reconciliation', 'createdBy', 'createdAt'], ['voided']), reconciliation = fields(raw.reconciliation, ['statement', 'organizationId', 'revision', 'matches'], ['completedAt', 'completedBy', 'completedLedgerRevision']);
  const r = validateUsBankRecord(raw, org(reconciliation.organizationId)), s = r.reconciliation.statement;
  return canonicalErpJson([s.organizationId, s.cashAccountId, s.start, s.end, s.opening.minorUnits, s.closing.minorUnits, s.lines.map(l => [l.date, l.amount.minorUnits, l.reference])]);
}
function transition(request: UsFinancialPilotBankRequest, inputView: UsFinancialBookViewV5, register: UsFinancialPilotBankRegister, suppliedActor: FinancialAuthority, historical: boolean): UsFinancialPilotBankRecord {
  const view = capture(inputView) as UsFinancialBookViewV5;
  const r = validateUsFinancialPilotBankRequest(request), current = validateUsFinancialPilotBankRegister(register, view.organizationId), a = actor(capture(suppliedActor), view.organizationId);
  assertFinancialAuthority(view.ledger, a);
  if (view.schemaVersion !== 5 || view.configuration.country !== 'US' || view.configuration.currency !== 'USD' || view.configuration.accountingBasis !== 'accrual' || view.ledger.currency !== 'USD' || view.ledger.basis !== 'accrual') return fail();
  if (r.expectedRevision !== view.revision) return fail('revision_conflict', 409);
  if (r.expectedBankRevision !== current.bankRevision) return fail('bank_revision_conflict', 409);
  if (current.bankRevision >= US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS) return fail('bank_operation_limit_reached', 409);
  if (current.operations.some(p => p.request.requestId === r.requestId)) return fail('idempotency_conflict', 409);
  const statementId = usFinancialPilotBankStatementId(r), found = current.records.find(row => row.record.reconciliation.statement.id === statementId);
  if (r.command.type === 'create_statement' && found) return fail('bank_statement_duplicate', 409);
  if (found?.origin === 'legacy-frozen') return fail('bank_legacy_immutable', 409);
  if (r.command.type !== 'create_statement' && !found) return fail('reconciliation_not_found', 404);
  const cashAccountId = r.command.type === 'create_statement' ? r.command.cashAccountId : found!.record.reconciliation.statement.cashAccountId;
  if (!historical && current.records.some(row => row.origin === 'legacy-frozen' && row.record.reconciliation.statement.cashAccountId === cashAccountId && !row.record.voided && !row.record.reconciliation.completedAt)) return fail('bank_legacy_pending', 409);
  let command: UsBankRequest['command'];
  if (r.command.type === 'create_statement') {
    const c = r.command;
    command = { type: 'create_statement', statement: { id: statementId, organizationId: view.organizationId, externalConnectionId: US_FINANCIAL_PILOT_BANK_MANUAL_MARKER, currency: 'USD', cashAccountId: c.cashAccountId, start: c.start, end: c.end,
      opening: { currency: 'USD', minorUnits: c.openingMinor }, closing: { currency: 'USD', minorUnits: c.closingMinor }, lines: c.lines.map((l, i) => ({ id: `${statementId}:${i + 1}`, date: l.date, amount: { currency: 'USD', minorUnits: l.amountMinor }, reference: l.reference })) } };
  } else if (r.command.type === 'approve_match') {
    const ledgerEntryIds = r.command.journalRevisions.map(revision => view.ledger.entries.find(entry => entry.revision === revision)?.id ?? fail('ledger_entry_required', 422)).sort();
    command = { type: 'approve_match', id: r.requestId, statementLineIds: r.command.statementLineIds, ledgerEntryIds };
  } else command = r.command.type === 'complete' ? { type: 'complete' } : { type: 'void_statement', reason: r.command.reason };
  const internal = validateUsBankRequest({ schemaVersion: 1, idempotencyKey: usFinancialPilotBankIdempotencyKey(r), reconciliationId: statementId, expectedErpRevision: r.expectedRevision, expectedReconciliationRevision: r.expectedStatementRevision, command }, view.organizationId);
  const record = applyUsBankCommand(found?.record ?? null, internal, view.ledger, a, current.records.map(row => row.record));
  return Object.freeze({ origin: 'financial-v5', record });
}
/** New operations only. Historical exact retries are handled before this function. */
export function applyUsFinancialPilotBank(request: UsFinancialPilotBankRequest, view: UsFinancialBookViewV5, register: UsFinancialPilotBankRegister, actor: FinancialAuthority): UsFinancialPilotBankRecord {
  return transition(request, view, register, actor, false);
}
export async function buildUsFinancialPilotBankProof(request: UsFinancialPilotBankRequest, input: UsFinancialBookV5, suppliedActor: FinancialAuthority, proposed: UsFinancialPilotBankRecord): Promise<UsFinancialPilotBankOperationProof> {
  const r = validateUsFinancialPilotBankRequest(request), capturedBook = capture(input) as UsFinancialBookV5, capturedRecord = capture(proposed), a = actor(capture(suppliedActor), capturedBook.baseline.configuration.organizationId);
  const record = fields(capturedRecord, ['origin', 'record']); if (record.origin !== 'financial-v5') return fail();
  const checkedRecord = validateUsBankRecord(record.record, a.organizationId), book = await validateUsFinancialBookV5(capturedBook, a.organizationId), view = await projectUsFinancialBookV5(book);
  if (book.revision !== r.expectedRevision || checkedRecord.reconciliation.statement.id !== usFinancialPilotBankStatementId(r)) return fail();
  if (Date.parse(a.timestamp) < Date.parse(book.events.at(-1)?.actor.timestamp ?? book.promotion.actor.timestamp)) return fail('bank_clock_reversed', 409);
  return validateUsFinancialPilotBankOperationProof({ schemaVersion: 1, organizationId: a.organizationId, request: r, actor: a, idempotencyKey: usFinancialPilotBankIdempotencyKey(r), commandHash: await usFinancialPilotBankCommandHash(a.organizationId, a.userId, r), action: r.command.type,
    statementId: usFinancialPilotBankStatementId(r), bankRevision: r.expectedBankRevision + 1, statementRevision: checkedRecord.reconciliation.revision, source: { revision: book.revision, ledgerRevision: view.ledger.revision, bookSha256: await sha256Hex(canonicalErpJson(book)) } }, a.organizationId);
}
export function appendUsFinancialPilotBankRegister(input: UsFinancialPilotBankRegister, proposed: UsFinancialPilotBankRecord, inputProof: UsFinancialPilotBankOperationProof): UsFinancialPilotBankRegister {
  const register = validateUsFinancialPilotBankRegister(input), proof = validateUsFinancialPilotBankOperationProof(inputProof, register.organizationId), row = fields(capture(proposed), ['origin', 'record']);
  if (row.origin !== 'financial-v5') return fail(); const record = validateUsBankRecord(row.record, register.organizationId);
  if (proof.request.expectedBankRevision !== register.bankRevision || proof.bankRevision !== register.bankRevision + 1 || proof.statementId !== record.reconciliation.statement.id || proof.statementRevision !== record.reconciliation.revision) return fail();
  const existing = register.records.find(r => r.record.reconciliation.statement.id === proof.statementId);
  if (existing?.origin === 'legacy-frozen') return fail();
  const records = existing ? register.records.map(r => r.record.reconciliation.statement.id === proof.statementId ? { origin: 'financial-v5' as const, record } : r) : [...register.records, { origin: 'financial-v5' as const, record }];
  const next = { schemaVersion: 1, organizationId: register.organizationId, bankRevision: proof.bankRevision, records, operations: [...register.operations, proof] };
  assertUsFinancialPilotBankCapacity(next, true); return validateUsFinancialPilotBankRegister(next, register.organizationId);
}
/** Reconstruct each exact financial source and preceding B state. No current actor admission. */
export async function validateUsFinancialPilotBankHistory(input: UsFinancialBookV5, registerInput: UsFinancialPilotBankRegister): Promise<UsFinancialPilotBankRegister> {
  const capturedBook = capture(input), register = validateUsFinancialPilotBankRegister(registerInput), book = await validateUsFinancialBookV5(capturedBook, register.organizationId);
  let rebuilt: UsFinancialPilotBankRegister = { schemaVersion: 1, organizationId: register.organizationId, bankRevision: 0, records: register.records.filter(r => r.origin === 'legacy-frozen'), operations: [] };
  const sources = new Map<number, { book: UsFinancialBookV5; view: UsFinancialBookViewV5; hash: string }>(); let previousFinance = book.baseline.revision + 1;
  for (const proof of register.operations) {
    const revision = proof.source.revision;
    if (revision < previousFinance || revision > book.revision || revision < book.baseline.revision + 1) return fail(); previousFinance = revision;
    let source = sources.get(revision);
    if (!source) { const prefix = await validateUsFinancialBookV5({ ...book, revision, events: book.events.filter(e => e.revision <= revision) }, register.organizationId); source = { book: prefix, view: await projectUsFinancialBookV5(prefix), hash: await sha256Hex(canonicalErpJson(prefix)) }; sources.set(revision, source); }
    if (source.hash !== proof.source.bookSha256 || source.view.ledger.revision !== proof.source.ledgerRevision || proof.commandHash !== await usFinancialPilotBankCommandHash(register.organizationId, proof.actor.userId, proof.request) || Date.parse(proof.actor.timestamp) < Date.parse(source.book.events.at(-1)?.actor.timestamp ?? source.book.promotion.actor.timestamp)) return fail();
    let next: UsFinancialPilotBankRecord;
    try { next = transition(proof.request, source.view, rebuilt, proof.actor, true); } catch { return fail(); }
    rebuilt = appendUsFinancialPilotBankRegister(rebuilt, next, proof);
  }
  const ordered = (r: UsFinancialPilotBankRegister) => [...r.records].sort((a, b) => a.record.reconciliation.statement.id < b.record.reconciliation.statement.id ? -1 : 1);
  if (!same(ordered(register), ordered(rebuilt))) return fail();
  return register;
}

function publicReceipt(proof: UsFinancialPilotBankOperationProof): UsFinancialPilotBankReceipt {
  return validateUsFinancialPilotBankReceipt({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: proof.organizationId, revision: proof.source.revision, bankRevision: proof.bankRevision, requestId: proof.request.requestId, action: proof.action, statementId: proof.statementId, statementRevision: proof.statementRevision }, proof.organizationId, proof.request);
}
/** Receipt-first bank runtime. The bound SQL port independently validates durable history. */
export async function executeUsFinancialPilotBank(deps: UsFinancialPilotBankDependencies, value: unknown): Promise<UsFinancialPilotBankWriteResult> {
  const own = (input: unknown, key: string): unknown => { if (!input || typeof input !== 'object') return fail(); const d = Object.getOwnPropertyDescriptor(input, key); if (!d?.enumerable || !('value' in d)) return fail(); return d.value; };
  const method = <T>(input: unknown, key: string): T => { const value = own(input, key); if (typeof value !== 'function') return fail(); return value as T; };
  const request = validateUsFinancialPilotBankRequest(value), organizationId = org(own(deps, 'organizationId')), initialActor = actor(capture(own(deps, 'actor')), organizationId), policy = capture(own(deps, 'policy')), store = own(deps, 'store');
  const revalidate = method<UsFinancialPilotBankDependencies['revalidate']>(deps, 'revalidate'), readStore = method<UsFinancialPilotBankPort['read']>(store, 'read'), receiptStore = method<UsFinancialPilotBankPort['receipt']>(store, 'receipt'), commitStore = method<UsFinancialPilotBankPort['commit']>(store, 'commit');
  let observedAt = Date.parse(initialActor.timestamp);
  const fresh = async () => { const current = fields(capture(await revalidate()), ['actor', 'policy']), a = actor(current.actor, organizationId); if (a.userId !== initialActor.userId || a.role !== initialActor.role) return fail('financial_authority_changed', 403); if (!same(current.policy, policy)) return fail('financial_policy_unavailable', 409); if (Date.parse(a.timestamp) < observedAt) return fail('financial_clock_reversed', 409); observedAt = Date.parse(a.timestamp); return a; };
  const guarded = async <T>(operation: () => Promise<T>, captureResult: (value: T) => T = value => value): Promise<T> => { await fresh(); let outcome: { value: T } | { error: unknown }; try { outcome = { value: captureResult(await operation()) }; } catch (error) { outcome = { error }; } await fresh(); if ('error' in outcome) throw outcome.error; return outcome.value; };
  const commandHash = await guarded(() => usFinancialPilotBankCommandHash(organizationId, initialActor.userId, request));
  const replay = async () => { const proof = await guarded(() => receiptStore(request.requestId), value => value === null ? null : validateUsFinancialPilotBankOperationProof(value, organizationId)); if (proof === null) return null; if (proof.actor.userId !== initialActor.userId || proof.commandHash !== commandHash || !same(proof.request, request)) return fail('idempotency_conflict', 409); return Object.freeze({ receipt: publicReceipt(proof), replayed: true }); };
  const previous = await replay(); if (previous) return previous;
  let retry = false;
  for (;;) {
    try {
      const read = await guarded(() => readStore(), value => {
        // Capture each member immediately on resolution, before the next authority await.
        if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 2) return fail();
        return Object.freeze({ book: capture(own(value, 'book')) as UsFinancialBookV5, register: validateUsFinancialPilotBankRegister(own(value, 'register'), organizationId) });
      });
      const rawBook = read.book, rawRegister = read.register;
      const book = await guarded(() => validateUsFinancialBookV5(rawBook, organizationId, policy as UsFinancialPolicyV5));
      const register = await guarded(() => validateUsFinancialPilotBankHistory(book, rawRegister));
      const view = await guarded(() => projectUsFinancialBookV5(book)), executionActor = await fresh();
      const record = applyUsFinancialPilotBank(request, view, register, executionActor), proof = await guarded(() => buildUsFinancialPilotBankProof(request, book, executionActor, record));
      appendUsFinancialPilotBankRegister(register, record, proof);
      const saved = await guarded(() => commitStore({ request, proof, record }), value => validateUsFinancialPilotBankOperationProof(value, organizationId));
      if (!same(saved, proof)) return fail(); return Object.freeze({ receipt: publicReceipt(saved), replayed: false });
    } catch (error) {
      const found = await replay(); if (found) return found;
      const code = error instanceof ErpError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined, status = error instanceof ErpError ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
      if (!retry && code && 'value' in code && ['revision_conflict', 'bank_revision_conflict'].includes(code.value) && status && 'value' in status && status.value === 409) { retry = true; continue; }
      throw error;
    }
  }
}
