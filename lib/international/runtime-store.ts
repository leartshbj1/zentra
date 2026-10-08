import { SupabaseServerError,type SupabaseServerClient } from '../supabase-server';
import { ErpError,canonicalErpJson } from './erp-contract';
import { validateStoredErp } from './runtime-validation';
export { validateStoredErp } from './runtime-validation';
import type { ErpCommit,ErpReceipt,ErpStore } from './runtime-types';
import type { ErpSchemaVersion } from './erp-schema-capability';
const same=(a:unknown,b:unknown)=>canonicalErpJson(a)===canonicalErpJson(b);
function unavailable():never{throw new ErpError('invalid_stored_state',503);}
const receiptFields = ['idempotencyKey','commandHash','revision','entityId','action'] as const;
const receiptActions = ['initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period','save_vendor','record_vendor_bill','record_vendor_payment','save_projects','upgrade_accounting','open_period','post_manual_journal','reverse_manual_journal'];
/** Privileged RPC results are unknown. Copy only own JSON data; never invoke getters or return the source object. */
export function validateErpReceipt(input: unknown, organizationId: string): ErpReceipt {
  try {
    if (typeof organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || !input || typeof input !== 'object' || Array.isArray(input)) return unavailable();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return unavailable();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== receiptFields.length || keys.some(key => typeof key !== 'string' || !receiptFields.includes(key as typeof receiptFields[number]))) return unavailable();
    const copied: Record<string, unknown> = Object.create(null);
    for (const key of receiptFields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return unavailable();
      copied[key] = descriptor.value;
    }
    const { idempotencyKey, commandHash, revision, entityId, action } = copied;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
      || typeof commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(commandHash)
      || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$/.test(idempotencyKey)
      || typeof entityId !== 'string' || !entityId.trim() || entityId.length > 160 || Array.from(entityId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || typeof action !== 'string' || !receiptActions.includes(action)) return unavailable();
    return Object.freeze({ idempotencyKey, commandHash, revision, entityId, action: action as ErpReceipt['action'] });
  } catch { return unavailable(); }
}
function storageError(error:unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes:Record<string,[string,number]>={PU001:['revision_conflict',409],PU002:['idempotency_conflict',409],PU003:['immutable_record',409],PU004:['invalid_state',422],PU005:['workspace_unavailable',409],PU006:['configuration_changed',409],PU007:['event_too_large',413],PU008:['client_upgrade_required',409],PU009:['legacy_project_review_required',409],PU010:['project_revision_conflict',409],PU011:['project_customer_locked',409],PU012:['vendor_bill_project_conflict',409],PU013:['project_archived',409],PU014:['project_customer_mismatch',422],PU015:['project_not_found',422]};
    Object.assign(codes,{PU016:['accounting_upgrade_required',409],PU017:['accounting_period_order_conflict',409],PU018:['manual_account_forbidden',422],PU019:['invalid_reversal',409],PU020:['period_limit_reached',409]});
    if (codes[error.code]) return new ErpError(...codes[error.code]);
  }
  return new ErpError('service_unavailable',503);
}
/** No direct writes: the PostgreSQL RPC owns the transaction and journal immutability. */
export function createSupabaseErpStore(client:Pick<SupabaseServerClient,'rpc'>,options:Readonly<{supportedSchemaVersion?:ErpSchemaVersion}>={}):ErpStore {
  const supportedSchemaVersion=options.supportedSchemaVersion??1;
  if(![1,2,3,4].includes(supportedSchemaVersion))throw new ErpError('invalid_request');
  return {
    supportedSchemaVersion,
    async read(organizationId) {
      try { const state=await client.rpc<unknown>(supportedSchemaVersion===4?'zentra_read_us_erp_v4':supportedSchemaVersion===3?'zentra_read_us_erp_v3':supportedSchemaVersion===2?'zentra_read_us_erp_v2':'zentra_read_us_erp',{p_organization:organizationId}); if(state===null)return null;const parsed=validateStoredErp(state,organizationId);if(parsed.schemaVersion>supportedSchemaVersion)throw new ErpError('client_upgrade_required',409);return parsed; }
      catch(error) {throw storageError(error);}
    },
    async receipt(organizationId,idempotencyKey) {
      try {const result=await client.rpc<unknown>(supportedSchemaVersion===4?'zentra_us_erp_receipt_v4':supportedSchemaVersion===3?'zentra_us_erp_receipt_v3':supportedSchemaVersion===2?'zentra_us_erp_receipt_v2':'zentra_us_erp_receipt',{p_organization:organizationId,p_idempotency_key:idempotencyKey});if(result===null)return null;const r=validateErpReceipt(result,organizationId);if(r.idempotencyKey!==idempotencyKey)return unavailable();return r;}
      catch(error) {throw storageError(error);}
    },
    async commit(input:ErpCommit) {
      try {if(input.header.schemaVersion>supportedSchemaVersion)throw new ErpError('client_upgrade_required',409); const expected=validateErpReceipt(input.receipt,input.organizationId);const result=await client.rpc<unknown>('zentra_commit_us_erp',{p_organization:input.organizationId,p_expected_revision:input.expectedRevision,p_header:input.header,p_changes:input.changes,p_ledger_audit:input.ledgerAudit,p_receipt:expected,p_actor:input.actor}); const r=validateErpReceipt(result,input.organizationId); if (!same(r,expected)) return unavailable(); return r; }
      catch(error) {throw storageError(error);}
    },
  };
}
