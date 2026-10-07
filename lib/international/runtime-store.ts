import { SupabaseServerError,type SupabaseServerClient } from '../supabase-server';
import { ErpError,canonicalErpJson } from './erp-contract';
import { validateStoredErp } from './runtime-validation';
export { validateStoredErp } from './runtime-validation';
import type { ErpCommit,ErpReceipt,ErpStore } from './runtime-types';
const same=(a:unknown,b:unknown)=>canonicalErpJson(a)===canonicalErpJson(b);
function unavailable():never{throw new ErpError('invalid_stored_state',503);}
function receipt(value: unknown, organizationId: string): ErpReceipt {
  if (!organizationId || !value || typeof value !== 'object') return unavailable();
  const r = value as ErpReceipt;
  if (!Number.isSafeInteger(r.revision) || r.revision < 1 || typeof r.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.commandHash) || typeof r.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$/.test(r.idempotencyKey) || typeof r.entityId !== 'string' || !r.entityId || !['initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period'].includes(r.action)) return unavailable();
  return r;
}
function storageError(error:unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes:Record<string,[string,number]>={PU001:['revision_conflict',409],PU002:['idempotency_conflict',409],PU003:['immutable_record',409],PU004:['invalid_state',422],PU005:['workspace_unavailable',409],PU006:['configuration_changed',409],PU007:['event_too_large',413]};
    if (codes[error.code]) return new ErpError(...codes[error.code]);
  }
  return new ErpError('service_unavailable',503);
}
/** No direct writes: the PostgreSQL RPC owns the transaction and journal immutability. */
export function createSupabaseErpStore(client:Pick<SupabaseServerClient,'rpc'>):ErpStore {
  return {
    async read(organizationId) {
      try { const state=await client.rpc<unknown>('zentra_read_us_erp',{p_organization:organizationId}); return state===null?null:validateStoredErp(state,organizationId); }
      catch(error) {throw storageError(error);}
    },
    async receipt(organizationId,idempotencyKey) {
      try {const result=await client.rpc<unknown>('zentra_us_erp_receipt',{p_organization:organizationId,p_idempotency_key:idempotencyKey});return result===null?null:receipt(result,organizationId);}
      catch(error) {throw storageError(error);}
    },
    async commit(input:ErpCommit) {
      try { const result=await client.rpc<unknown>('zentra_commit_us_erp',{p_organization:input.organizationId,p_expected_revision:input.expectedRevision,p_header:input.header,p_changes:input.changes,p_ledger_audit:input.ledgerAudit,p_receipt:input.receipt,p_actor:input.actor}); const r=receipt(result,input.organizationId); if (!same(r,input.receipt)) return unavailable(); return r; }
      catch(error) {throw storageError(error);}
    },
  };
}
