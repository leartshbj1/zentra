import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { snapshotPrivateJson } from './private-json';
import { ErpError, canonicalErpJson } from './erp-contract';
import { parseInstant } from './localization';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsBankReceipt, UsBankStore } from './us-bank-contract';
import { validateUsBankRecord } from './us-bank-reconciliation';

const unavailable = (): never => { throw new ErpError('invalid_bank_record', 503); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const fields = ['schemaVersion', 'organizationId', 'idempotencyKey', 'commandHash', 'actorId', 'reconciliationId', 'action', 'revision', 'erpRevision'];
const actions = ['create_statement', 'approve_match', 'complete', 'void_statement'];
function safeRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
}
function safeActor(actor: FinancialAuthority): FinancialAuthority {
  const copied = snapshotPrivateJson(actor) as FinancialAuthority;
  if (!copied || typeof copied !== 'object' || Array.isArray(copied) || Object.keys(copied).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(field => Object.hasOwn(copied, field))) return unavailable();
  if (typeof copied.organizationId !== 'string' || !uuid.test(copied.organizationId) || typeof copied.userId !== 'string' || !copied.userId.trim() || copied.userId.length > 256 || Array.from(copied.userId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return unavailable();
  if (copied.managementEntitled !== true || !['owner', 'admin', 'accountant'].includes(copied.role)) throw new ErpError('bank_permission_required', 403);
  try { if (typeof copied.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(copied.timestamp)) return unavailable(); parseInstant(copied.timestamp); } catch { return unavailable(); }
  return copied;
}
export function validateUsBankReceipt(input: unknown, organizationId: string): UsBankReceipt {
  try {
    const value = snapshotPrivateJson(input) as UsBankReceipt;
    if (typeof organizationId !== 'string' || !uuid.test(organizationId) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) return unavailable();
    if (value.schemaVersion !== 1 || value.organizationId !== organizationId || !uuid.test(value.reconciliationId) || typeof value.idempotencyKey !== 'string' || !key.test(value.idempotencyKey) || typeof value.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.commandHash) || typeof value.actorId !== 'string' || !value.actorId.trim() || value.actorId.length > 256 || Array.from(value.actorId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !actions.includes(value.action) || !safeRevision(value.revision, 0) || !safeRevision(value.erpRevision, 1)) return unavailable();
    return Object.freeze(value);
  } catch { return unavailable(); }
}
function controlled(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes: Readonly<Record<string, readonly [string, number]>> = {
      PB001: ['bank_revision_conflict', 409], PB002: ['bank_idempotency_conflict', 409], PB003: ['bank_statement_overlap', 409],
      PB004: ['bank_entry_already_matched', 409], PB005: ['invalid_bank_request', 422], PB006: ['bank_erp_revision_conflict', 409],
      PB007: ['bank_permission_required', 403], PB008: ['bank_upgrade_required', 409], PB009: ['bank_limit_reached', 409],
      PB010: ['invalid_bank_record', 503], PB011: ['bank_statement_closed', 409], PB012: ['bank_statement_duplicate', 409],
    };
    if (Object.hasOwn(codes, error.code)) return new ErpError(...codes[error.code]);
  }
  return new ErpError('service_unavailable', 503);
}
/** Service-only transport. Fresh Auth/D1 authority remains the HTTP caller's duty. */
export function createSupabaseUsBankStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{ supportedSchemaVersion?: ErpSchemaVersion }> = {}): UsBankStore {
  const supportedSchemaVersion = options.supportedSchemaVersion ?? 1;
  if (![1, 2, 3, 4].includes(supportedSchemaVersion)) throw new ErpError('invalid_request', 422);
  const parameters = (actor: FinancialAuthority) => {
    const trusted = safeActor(actor);
    if (supportedSchemaVersion !== 4) throw new ErpError('bank_upgrade_required', 409);
    return { p_organization: trusted.organizationId, p_actor: trusted, p_supported_schema_version: supportedSchemaVersion };
  };
  const readKey = (id: string) => { if (typeof id !== 'string' || !uuid.test(id)) throw new ErpError('invalid_bank_request', 422); return id; };
  return {
    supportedSchemaVersion,
    async list(actor) {
      try {
        const params = parameters(actor), result = snapshotPrivateJson(await client.rpc<unknown>('zentra_list_us_bank_reconciliations', params));
        if (!Array.isArray(result) || result.length > 100) return unavailable();
        const parsed = result.map(row => validateUsBankRecord(row, params.p_organization));
        if (new Set(parsed.map(row => row.reconciliation.statement.id)).size !== parsed.length) return unavailable();
        return Object.freeze(parsed);
      } catch (error) { throw controlled(error); }
    },
    async read(actor, reconciliationId) {
      try {
        const params = parameters(actor), result = await client.rpc<unknown>('zentra_read_us_bank_reconciliation', { ...params, p_id: readKey(reconciliationId) });
        if (result === null) return null;
        const parsed = validateUsBankRecord(result, params.p_organization);
        if (parsed.reconciliation.statement.id !== reconciliationId) return unavailable();
        return parsed;
      } catch (error) { throw controlled(error); }
    },
    async receipt(actor, idempotencyKey) {
      try {
        const params = parameters(actor);
        if (typeof idempotencyKey !== 'string' || !key.test(idempotencyKey)) throw new ErpError('invalid_bank_request', 422);
        const result = await client.rpc<unknown>('zentra_us_bank_receipt', { ...params, p_idempotency_key: idempotencyKey });
        if (result === null) return null;
        const parsed = validateUsBankReceipt(result, params.p_organization);
        if (parsed.idempotencyKey !== idempotencyKey || parsed.actorId !== params.p_actor.userId) return unavailable();
        return parsed;
      } catch (error) { throw controlled(error); }
    },
    async commit(input) {
      try {
        input = snapshotPrivateJson(input) as typeof input;
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 5 || !['actor','expectedErpRevision','expectedReconciliationRevision','record','receipt'].every(field => Object.hasOwn(input, field))) throw new ErpError('invalid_bank_request', 422);
        const params = parameters(input.actor), record = validateUsBankRecord(input.record, params.p_organization), receipt = validateUsBankReceipt(input.receipt, params.p_organization);
        if (!safeRevision(input.expectedErpRevision, 1) || input.expectedReconciliationRevision !== null && !safeRevision(input.expectedReconciliationRevision, 0) || receipt.erpRevision !== input.expectedErpRevision || receipt.actorId !== params.p_actor.userId || receipt.reconciliationId !== record.reconciliation.statement.id || receipt.revision !== record.reconciliation.revision || (input.expectedReconciliationRevision === null ? receipt.revision !== 0 || receipt.action !== 'create_statement' : receipt.revision !== input.expectedReconciliationRevision + 1 || receipt.action === 'create_statement')) throw new ErpError('invalid_bank_request', 422);
        const result = await client.rpc<unknown>('zentra_commit_us_bank_reconciliation', { ...params, p_expected_erp_revision: input.expectedErpRevision, p_expected_reconciliation_revision: input.expectedReconciliationRevision, p_record: record, p_receipt: receipt });
        const actual = validateUsBankReceipt(result, params.p_organization);
        if (canonicalErpJson(actual) !== canonicalErpJson(receipt)) return unavailable();
        return actual;
      } catch (error) { throw controlled(error); }
    },
  };
}
