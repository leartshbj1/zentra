import { SupabaseServerError,type SupabaseServerClient } from '../supabase-server';
import { ErpError,canonicalErpJson } from './erp-contract';
import { validateStoredErp } from './runtime-validation';
export { validateStoredErp } from './runtime-validation';
import type { ErpCommit,ErpStore } from './runtime-types';
import type { ErpSchemaVersion } from './erp-schema-capability';
const same=(a:unknown,b:unknown)=>canonicalErpJson(a)===canonicalErpJson(b);
function unavailable():never{throw new ErpError('invalid_stored_state',503);}
import { validateErpReceipt } from './erp-receipt';
export { validateErpReceipt } from './erp-receipt';
function storageError(error:unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes:Record<string,[string,number]>={PU001:['revision_conflict',409],PU002:['idempotency_conflict',409],PU003:['immutable_record',409],PU004:['invalid_state',422],PU005:['workspace_unavailable',409],PU006:['configuration_changed',409],PU007:['event_too_large',413],PU008:['client_upgrade_required',409],PU009:['legacy_project_review_required',409],PU010:['project_revision_conflict',409],PU011:['project_customer_locked',409],PU012:['vendor_bill_project_conflict',409],PU013:['project_archived',409],PU014:['project_customer_mismatch',422],PU015:['project_not_found',422]};
    Object.assign(codes,{PO008:['sales_order_source_locked',409],PO011:['sales_order_invoice_blocked',409],PU016:['accounting_upgrade_required',409],PU017:['accounting_period_order_conflict',409],PU018:['manual_account_forbidden',422],PU019:['invalid_reversal',409],PU020:['period_limit_reached',409]});
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
