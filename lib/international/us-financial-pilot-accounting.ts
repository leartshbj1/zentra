import { validDate, type CashFlowCategory, type JournalLine } from './accounting/ledger';
import { US_MANUAL_EXCLUDED_ACCOUNTS } from './accounting/us-journal';
import { usStarterChart } from './countries/us/accounting';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import type { ErpCommand } from './runtime-types';
import { validateUsFinancialRequestV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';

/** Browser-editable facts only; private identity and authority stay server-owned. */
export const US_FINANCIAL_PILOT_ACCOUNTING_MAX_BODY_BYTES = 262_144;
export type UsFinancialPilotAccountingCommand =
  | Readonly<{ type: 'post_manual_journal'; transactionDate: string; accountingDate: string; periodId: string; description: string; sourceReference: string; lines: readonly JournalLine[]; cashFlowCategory?: CashFlowCategory }>
  | Readonly<{ type: 'reverse_manual_journal'; journalRevision: number; transactionDate: string; accountingDate: string; periodId: string; reason: string }>
  | Readonly<{ type: 'open_period'; start: string; end: string }>
  | Readonly<{ type: 'close_period'; periodId: string }>;
export interface UsFinancialPilotAccountingRequest {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly requestId: string; readonly expectedRevision: number;
  readonly command: UsFinancialPilotAccountingCommand;
}
export interface UsFinancialPilotAccountingReceipt {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number;
  readonly entityId: string; readonly action: UsFinancialPilotAccountingCommand['type']; readonly requestId: string;
}
const invalid = (): never => { throw new ErpError('invalid_financial_pilot_request', 422); };
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return invalid();
  return value;
}
function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER ? value : invalid(); }
function uuid(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : invalid(); }
function date(value: unknown): string { return typeof value === 'string' && !value.startsWith('0000-') && validDate(value) ? value : invalid(); }
function amount(value: unknown): string { return typeof value === 'string' && /^(0|[1-9][0-9]{0,35})$/.test(value) ? value : invalid(); }
function category(value: unknown): CashFlowCategory {
  return value === 'operating' || value === 'investing' || value === 'financing' ? value : invalid();
}
function journalLines(value: unknown, cashFlowCategory: CashFlowCategory | undefined): readonly JournalLine[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 1000) return invalid();
  // Runtime validation requires this adapter chart. Never duplicate its IDs or cash flags.
  const accounts = new Map(usStarterChart.map(account => [account.id, account]));
  let debit = BigInt(0), credit = BigInt(0), cashMovement = BigInt(0);
  const lines = value.map(raw => {
    const line = fields(raw, ['accountId', 'debitMinor', 'creditMinor'], ['description']), accountId = text(line.accountId), account = accounts.get(accountId);
    if (!account || US_MANUAL_EXCLUDED_ACCOUNTS.includes(accountId)) return invalid();
    const debitMinor = amount(line.debitMinor), creditMinor = amount(line.creditMinor), dr = BigInt(debitMinor), cr = BigInt(creditMinor);
    if ((dr === BigInt(0)) === (cr === BigInt(0))) return invalid();
    debit += dr; credit += cr; if (account.cash) cashMovement += dr - cr;
    return Object.freeze({ accountId, debitMinor, creditMinor, ...(Object.hasOwn(line, 'description') ? { description: text(line.description, 2000) } : {}) });
  });
  if (debit === BigInt(0) || debit !== credit || (cashMovement !== BigInt(0) && cashFlowCategory === undefined)) return invalid();
  return Object.freeze(lines);
}
export function validateUsFinancialPilotAccountingRequest(value: unknown): UsFinancialPilotAccountingRequest {
  try {
    const captured = snapshotPrivateJson(value);
    if (new TextEncoder().encode(JSON.stringify(captured)).byteLength > US_FINANCIAL_PILOT_ACCOUNTING_MAX_BODY_BYTES) return invalid();
    const r = fields(captured, ['consumer', 'schemaVersion', 'requestId', 'expectedRevision', 'command']);
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1) return invalid();
    const requestId = uuid(r.requestId), expectedRevision = integer(r.expectedRevision), raw = fields(r.command, ['type'], ['transactionDate', 'accountingDate', 'periodId', 'description', 'sourceReference', 'lines', 'cashFlowCategory', 'journalRevision', 'reason', 'start', 'end']);
    let command: UsFinancialPilotAccountingCommand;
    if (raw.type === 'post_manual_journal') {
      const c = fields(raw, ['type', 'transactionDate', 'accountingDate', 'periodId', 'description', 'sourceReference', 'lines'], ['cashFlowCategory']);
      const cashFlowCategory = Object.hasOwn(c, 'cashFlowCategory') ? category(c.cashFlowCategory) : undefined;
      command = Object.freeze({ type: 'post_manual_journal', transactionDate: date(c.transactionDate), accountingDate: date(c.accountingDate), periodId: text(c.periodId), description: text(c.description, 2000), sourceReference: text(c.sourceReference), lines: journalLines(c.lines, cashFlowCategory), ...(cashFlowCategory === undefined ? {} : { cashFlowCategory }) });
    } else if (raw.type === 'reverse_manual_journal') {
      const c = fields(raw, ['type', 'journalRevision', 'transactionDate', 'accountingDate', 'periodId', 'reason']);
      command = Object.freeze({ type: 'reverse_manual_journal', journalRevision: integer(c.journalRevision), transactionDate: date(c.transactionDate), accountingDate: date(c.accountingDate), periodId: text(c.periodId), reason: text(c.reason, 2000) });
    } else if (raw.type === 'open_period') {
      const c = fields(raw, ['type', 'start', 'end']), start = date(c.start), end = date(c.end);
      if (end < start) return invalid();
      command = Object.freeze({ type: 'open_period', start, end });
    } else if (raw.type === 'close_period') {
      const c = fields(raw, ['type', 'periodId']); command = Object.freeze({ type: 'close_period', periodId: text(c.periodId) });
    } else return invalid();
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision, command });
  } catch { return invalid(); }
}
/** Identity only; current existence, source eligibility and collisions are server checks. */
export function usFinancialPilotAccountingEntityId(value: UsFinancialPilotAccountingRequest): string {
  const r = validateUsFinancialPilotAccountingRequest(value), c = r.command;
  return c.type === 'close_period' ? c.periodId : `${c.type === 'open_period' ? 'pilot-period' : c.type === 'post_manual_journal' ? 'pilot-journal' : 'pilot-journal-reversal'}:${r.requestId}`;
}
/** Reverse identity must be resolved from the admitted true V5 ledger, including replay.
 * Do not make eligibility checks here: later reversals/closures cannot block historical receipts. */
export function buildUsFinancialPilotAccountingRequest(value: unknown, organizationId: string, resolvedEntryId?: string): UsFinancialRequestV5 {
  try {
    const r = validateUsFinancialPilotAccountingRequest(value), c = r.command, id = usFinancialPilotAccountingEntityId(r);
    text(organizationId, 128);
    let command: ErpCommand;
    if (c.type === 'reverse_manual_journal') {
      command = { type: c.type, id, entryId: text(resolvedEntryId), transactionDate: c.transactionDate, accountingDate: c.accountingDate, periodId: c.periodId, reason: c.reason };
    } else {
      if (resolvedEntryId !== undefined) return invalid();
      command = c.type === 'close_period' ? { ...c } : { ...c, id };
    }
    const built = validateUsFinancialRequestV5({ idempotencyKey: `pilot:accounting:${r.requestId}`, expectedRevision: r.expectedRevision, command: { type: 'erp_command', request: command } }, organizationId);
    if (built.command.type !== 'erp_command' || canonicalErpJson(built.command.request) !== canonicalErpJson(command)) return invalid();
    return built;
  } catch { return invalid(); }
}
export function validateUsFinancialPilotAccountingReceipt(value: unknown, organizationId: string, expected?: UsFinancialPilotAccountingRequest): UsFinancialPilotAccountingReceipt {
  try {
    const r = fields(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'entityId', 'action', 'requestId']);
    const requestId = uuid(r.requestId), revision = integer(r.revision), entityId = text(r.entityId), action = r.action;
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1 || r.organizationId !== organizationId || (action !== 'post_manual_journal' && action !== 'reverse_manual_journal' && action !== 'open_period' && action !== 'close_period')) return invalid();
    if ((action === 'post_manual_journal' && entityId !== `pilot-journal:${requestId}`) || (action === 'reverse_manual_journal' && entityId !== `pilot-journal-reversal:${requestId}`) || (action === 'open_period' && entityId !== `pilot-period:${requestId}`)) return invalid();
    if (expected) {
      const request = validateUsFinancialPilotAccountingRequest(expected);
      if (requestId !== request.requestId || action !== request.command.type || revision !== request.expectedRevision + 1 || entityId !== usFinancialPilotAccountingEntityId(request)) return invalid();
    }
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision, entityId, action, requestId });
  } catch { throw new ErpError('invalid_financial_pilot_response', 503); }
}
