import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError, canonicalErpJson } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { salesOrderInteger, validateUsSalesOrderHead, validateUsSalesOrderPage, validateUsSalesOrderRecord, validateUsSalesOrderReceipt, validateUsSalesOrderRequest, validateUsSalesOrderSource, type UsSalesOrderStore } from './us-sales-order-contract';

export const US_SALES_ORDER_SQL_ERRORS: Readonly<Record<string, readonly [string, number]>> = Object.freeze({
  PO001: ['sales_order_revision_conflict',409], PO002: ['sales_order_idempotency_conflict',409], PO003: ['sales_order_erp_revision_conflict',409],
  PO004: ['invalid_sales_order_request',422], PO005: ['sales_order_upgrade_required',409], PO006: ['sales_order_permission_required',403],
  PO007: ['sales_order_source_unavailable',409], PO008: ['sales_order_source_locked',409], PO009: ['sales_order_already_exists',409],
  PO010: ['sales_order_not_found',404], PO011: ['sales_order_state_conflict',409], PO012: ['sales_order_already_invoiced',409],
  PO013: ['seller_configuration_required',409], PO014: ['invalid_sales_order_record',503], PO015: ['sales_order_sequence_exhausted',409],
});
const fail = (): never => { throw new ErpError('invalid_sales_order_request',422); };
function parameters(actorInput: FinancialAuthority, supportedSchemaVersion: number) {
  let actor: FinancialAuthority; try { actor=snapshotPrivateJson(actorInput) as FinancialAuthority; } catch { return fail(); }
  if (!actor || Object.keys(actor).length !== 5 || !['organizationId','userId','role','managementEntitled','timestamp'].every(k=>Object.hasOwn(actor,k)) || typeof actor.organizationId !== 'string' || !/^[0-9a-f-]{36}$/.test(actor.organizationId) || typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length>256 || Array.from(actor.userId).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127) || !['owner','admin','accountant','member','read_only'].includes(actor.role) || actor.managementEntitled!==true) throw new ErpError('sales_order_permission_required',403);
  try { parseInstant(actor.timestamp); } catch { return fail(); }
  if (supportedSchemaVersion!==4) throw new ErpError('sales_order_upgrade_required',409);
  return { p_organization:actor.organizationId,p_actor:actor,p_supported_schema_version:4 };
}
function controlled(error: unknown): never {
  if(error instanceof ErpError)throw error;
  if(error instanceof SupabaseServerError && Object.hasOwn(US_SALES_ORDER_SQL_ERRORS,error.code))throw new ErpError(...US_SALES_ORDER_SQL_ERRORS[error.code]);
  throw new ErpError('service_unavailable',503);
}
/** Service-only RPC transport. Auth/D1 admission and revalidation remain at the HTTP boundary. */
export function createSupabaseUsSalesOrderStore(client:Pick<SupabaseServerClient,'rpc'>,options:Readonly<{supportedSchemaVersion?:number}>={}):UsSalesOrderStore {
  const capability=options.supportedSchemaVersion??4;
  return {
    async head(actor){try{const p=parameters(actor,capability);return validateUsSalesOrderHead(await client.rpc('zentra_us_sales_order_head',p),p.p_organization);}catch(e){return controlled(e);}},
    async source(actor,estimateId){try{
      const p=parameters(actor,capability);if(typeof estimateId!=='string'||!estimateId.trim()||estimateId!==estimateId.trim()||estimateId.length>160||Array.from(estimateId).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return fail();
      const source=validateUsSalesOrderSource(await client.rpc('zentra_us_sales_order_source',{...p,p_estimate_id:estimateId}),p.p_organization);if(source.estimateId!==estimateId)throw new ErpError('invalid_sales_order_record',503);return source;
    }catch(e){return controlled(e);}},
    async list(actor,beforeSequence=null){
      try { const p=parameters(actor,capability);if(beforeSequence!==null)salesOrderInteger(beforeSequence,1);return validateUsSalesOrderPage(await client.rpc('zentra_list_us_sales_orders',{...p,p_before_sequence:beforeSequence}),p.p_organization); }catch(e){return controlled(e);}
    },
    async read(actor,orderId){
      try {const p=parameters(actor,capability);if(!/^[0-9a-f-]{36}$/.test(orderId))return fail();const result=await client.rpc('zentra_read_us_sales_order',{...p,p_order_id:orderId});if(result===null)return null;const record=validateUsSalesOrderRecord(result,p.p_organization);if(record.order.id!==orderId)throw new ErpError('invalid_sales_order_record',503);return record;}catch(e){return controlled(e);}
    },
    async receipt(actor,idempotencyKey){
      try {const p=parameters(actor,capability);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(idempotencyKey))return fail();const result=await client.rpc('zentra_us_sales_order_receipt',{...p,p_idempotency_key:idempotencyKey});if(result===null)return null;const receipt=validateUsSalesOrderReceipt(result,p.p_organization);if(receipt.idempotencyKey!==idempotencyKey||receipt.actorId!==p.p_actor.userId)throw new ErpError('sales_order_idempotency_conflict',409);return receipt;}catch(e){return controlled(e);}
    },
    async execute(actor,input,commandHash){
      try {
        const p=parameters(actor,capability),request=validateUsSalesOrderRequest(input,p.p_organization);
        if(p.p_actor.role==='read_only')throw new ErpError('sales_order_permission_required',403);
        if(!/^[a-f0-9]{64}$/.test(commandHash))return fail();
        const raw=snapshotPrivateJson(await client.rpc('zentra_execute_us_sales_order',{...p,p_request:request,p_command_hash:commandHash})) as {receipt:unknown;replayed:unknown};
        if(!raw||Object.keys(raw).length!==2||!Object.hasOwn(raw,'receipt')||typeof raw.replayed!=='boolean')throw new ErpError('invalid_sales_order_record',503);
        const receipt=validateUsSalesOrderReceipt(raw.receipt,p.p_organization);
        if(receipt.commandHash!==commandHash||receipt.actorId!==p.p_actor.userId||receipt.orderId!==request.orderId||receipt.action!==request.command.type||receipt.idempotencyKey!==request.idempotencyKey||receipt.erpRevision!==request.expectedErpRevision||receipt.headRevision!==request.expectedHeadRevision+1||receipt.revision!==(request.expectedOrderRevision??0)+1)throw new ErpError('invalid_sales_order_record',503);
        return Object.freeze({receipt,replayed:raw.replayed});
      }catch(e){return controlled(e);}
    },
  };
}
/** Exact request identity shared with SQL; no caller-supplied record or number is hashed as authority. */
export function usSalesOrderCommandIdentity(organizationId:string,actorId:string,request:unknown):string {return canonicalErpJson([organizationId,actorId,validateUsSalesOrderRequest(request,organizationId)]);}
