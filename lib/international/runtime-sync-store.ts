import type { SupabaseServerClient } from '../supabase-server';
import { SupabaseServerError } from '../supabase-server';
import { ErpError } from './erp-contract';
import { validateErpDelta,validateErpRevision,type ErpSyncStore } from './runtime-sync';

function failure(error:unknown):never{
  if(error instanceof ErpError)throw error;
  if(error instanceof SupabaseServerError&&error.code==='PU004')throw new ErpError('invalid_cursor',422);
  throw new ErpError('service_unavailable',503);
}
export function createSupabaseErpSyncStore(client:Pick<SupabaseServerClient,'rpc'>):ErpSyncStore{
  return {
    async revision(organizationId){try{const result=await client.rpc<unknown>('zentra_us_erp_revision',{p_organization:organizationId});return result===null?null:validateErpRevision(result,organizationId);}catch(error){return failure(error);}},
    async changes(organizationId,afterRevision,limit){try{const result=await client.rpc<unknown>('zentra_us_erp_delta',{p_organization:organizationId,p_after_revision:afterRevision,p_limit:limit});return result===null?null:validateErpDelta(result,organizationId,afterRevision,limit);}catch(error){return failure(error);}},
  };
}
