import { AccountPublicError } from '../account-security';
import { ErpError } from './erp-contract';
import type { ErpServerDependencies } from './runtime-server';
import type { ErpSyncStore } from './runtime-sync';
import { publicErpDelta } from './public-projection';
import { confirmErpReadAdmission, confirmErpExpectedUser } from './read-admission';
import { erpClientSchemaVersion, requireErpClientSchema } from './erp-schema-capability';
export type ErpSyncServerDependencies=Pick<ErpServerDependencies,'enabled'|'authority'|'configuration'|'rateLimit'|'diagnostic'>&{syncStore:(clientSchemaVersion?:1|2)=>ErpSyncStore|Promise<ErpSyncStore>};
const headers={'Cache-Control':'no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
function cursor(request:Request){
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(k=>!['after','limit'].includes(k))||params.getAll('after').length!==1||params.getAll('limit').length>1)throw new ErpError('invalid_cursor',422);
  const parse=(s:string|null)=>{if(s===null||!/^(0|[1-9]\d{0,15})$/.test(s))throw new ErpError('invalid_cursor',422);const n=Number(s);if(!Number.isSafeInteger(n)||n>=Number.MAX_SAFE_INTEGER)throw new ErpError('invalid_cursor',422);return n;};
  const after=parse(params.get('after')),limit=params.has('limit')?parse(params.get('limit')):100;
  if(limit<1||limit>100)throw new ErpError('invalid_cursor',422);
  return {after,limit};
}
export function createErpSyncHandlers(deps:ErpSyncServerDependencies){
  async function read(request:Request,organizationId:string,operation:'revision'|'changes'){
    try{
      if(!await deps.enabled())return json({error:'feature_unavailable'},404);
      if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId))throw new ErpError('invalid_request',422);
      const trusted=await deps.authority(request,organizationId);
      confirmErpExpectedUser(request,trusted);
      if(trusted.actor.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
      if(!trusted.actor.managementEntitled)throw new ErpError('management_entitlement_required',402);
      const config=await deps.configuration(trusted.actor);
      if(config.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
      if(config.country!=='US')throw new ErpError('edition_unavailable',409);
      await deps.rateLimit(request,trusted.actor,'read');
      const clientSchemaVersion=erpClientSchemaVersion(request);
      const options=operation==='changes'?cursor(request):null;
      const store=await deps.syncStore(clientSchemaVersion);
      if(options){
        const delta=await store.changes(organizationId,options.after,options.limit);
        confirmErpReadAdmission(trusted,await deps.authority(request,organizationId));
        if(!await deps.enabled())throw new ErpError('feature_unavailable',404);
        if(delta)requireErpClientSchema(delta.schemaVersion,clientSchemaVersion);
        return json(delta?publicErpDelta(delta):null);
      }
      const head=await store.revision(organizationId);
      confirmErpReadAdmission(trusted,await deps.authority(request,organizationId));
      if(!await deps.enabled())throw new ErpError('feature_unavailable',404);
      if(head)requireErpClientSchema(head.schemaVersion,clientSchemaVersion);
      return json(head);
    }catch(error){
      let code='service_unavailable',status=503;
      if(error instanceof ErpError){code=error.code;status=error.status;}
      else if(error instanceof AccountPublicError){status=error.status;code=status===401?'unauthorized':status===402?'management_entitlement_required':'forbidden';}
      try{deps.diagnostic({operation:'read',code,status});}catch{/* Diagnostics never reveal private financial payloads. */}
      return json({error:code},status);
    }
  }
  return {revision:(r:Request,o:string)=>read(r,o,'revision'),changes:(r:Request,o:string)=>read(r,o,'changes')};
}
