import { AccountPublicError, isAccountRole, newUserCode, requireAccountSameOrigin, type AccountRole } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { UsAuthorityError } from './saas-authority';
import { US_DEVICE_PROTOCOL, UsDeviceError, hashUsDeviceSecret, newUsDeviceCode, usDeviceBearer, usDeviceExact, usDeviceHash, usDeviceSeconds, usDeviceUuid, validateUsDeviceAdmission, validateUsDeviceApprove, validateUsDeviceExchange, validateUsDeviceStart, type UsDeviceAdmission, type UsDeviceSession } from './us-device-contract';
import type { UsDeviceChallenge, UsDeviceSessionRow, UsDeviceStore } from './us-device-d1';
import type { ErpSchemaVersion } from './erp-schema-capability';

export interface UsDeviceDependencies {
  enabled(this:void):boolean|Promise<boolean>;
  /** New challenge admission only. Closing a capability does not rewrite or
   * block exact exchange/revocation of an already captured credential. */
  maxSchemaVersion?(this:void):ErpSchemaVersion|Promise<ErpSchemaVersion>;
  user(this:void):Promise<{userId:string}|null>;
  access(this:void,organizationId:string,userId:string):Promise<UsDeviceAdmission>;
  store(this:void):UsDeviceStore|Promise<UsDeviceStore>;
  rateLimit(this:void,request:Request,operation:'start'|'approve'|'exchange'|'me'|'revoke',key:string):Promise<void>;
  now?(this:void):number;
  newCode?(this:void):string;
  newUserCode?(this:void):string;
  newSessionId?(this:void):string;
  hash?(this:void,purpose:'session'|'code',token:string):Promise<string>;
}
const headers = {'Cache-Control':'no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json = (value:unknown,status=200)=>Response.json(value,{status,headers});
const publicErrors:Readonly<Record<string,number>>={invalid_request:422,authorization_expired:410,authorization_conflict:409,unauthorized:401,session_changed:401,forbidden:403,management_entitlement_required:402,seat_limit_reached:403,feature_unavailable:404,rate_limited:429,service_unavailable:503,client_upgrade_required:409};
function failure(error:unknown):Response {
  if(error instanceof UsDeviceError){const status=publicErrors[error.code];return status===error.status?json({error:error.code},status):json({error:'service_unavailable'},503);}
  if(error instanceof UsAuthorityError)return json({error:error.code==='subscription_required'?'management_entitlement_required':error.status===403?'forbidden':'service_unavailable'},error.status===422?503:error.status);
  if(error instanceof AccountPublicError)return json({error:error.status===429?'rate_limited':error.status===401?'unauthorized':error.status===402?'management_entitlement_required':'forbidden'},[401,402,403,429].includes(error.status)?error.status:503);
  if(error instanceof RequestBodyError)return json({error:'invalid_request'},error.status);
  return json({error:'service_unavailable'},503);
}
function same(a:UsDeviceAdmission,b:UsDeviceAdmission):boolean {return a.organizationId===b.organizationId&&a.organizationName===b.organizationName&&a.userId===b.userId&&a.role===b.role&&a.subscriptionId===b.subscriptionId&&a.entitlementValidUntil===b.entitlementValidUntil&&a.configurationStamp===b.configurationStamp;}
function approved(c:UsDeviceChallenge,a:UsDeviceAdmission):boolean {return c.organization_id===a.organizationId&&c.approved_user_id===a.userId&&c.approved_role===a.role&&c.subscription_id===a.subscriptionId&&c.entitlement_valid_until===a.entitlementValidUntil;}
function cleanRow(row:UsDeviceSessionRow):UsDeviceSessionRow {
  try {
    const v=usDeviceExact(row,['session_id','device_code_hash','token_hash','installation_id','organization_id','user_id','role','subscription_id','supported_schema_version','created_at','expires_at','entitlement_valid_until','revoked_at']);
    if(typeof v.session_id!=='string'||!v.session_id.startsWith('usd_')||!usDeviceUuid(v.session_id.slice(4))||!usDeviceHash(v.device_code_hash)||!usDeviceHash(v.token_hash)||!usDeviceUuid(v.installation_id)||!usDeviceUuid(v.organization_id)||!usDeviceUuid(v.user_id)||!isAccountRole(v.role)||typeof v.subscription_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.subscription_id)||![1,2,3,4].includes(v.supported_schema_version as number)||!usDeviceSeconds(v.created_at)||!usDeviceSeconds(v.expires_at)||!usDeviceSeconds(v.entitlement_valid_until)||v.expires_at<=v.created_at||v.expires_at>v.entitlement_valid_until||v.expires_at>v.created_at+2592000||(v.revoked_at!==null&&(!usDeviceSeconds(v.revoked_at)||v.revoked_at<v.created_at)))throw new Error();
    return v as unknown as UsDeviceSessionRow;
  }catch{throw new UsDeviceError('service_unavailable',503);}
}
function cleanChallenge(row:UsDeviceChallenge):UsDeviceChallenge {
  try{
    const v=usDeviceExact(row,['device_code_hash','user_code','installation_id','session_token_hash','supported_schema_version','created_at','expires_at','status','organization_id','approved_user_id','approved_role','subscription_id','entitlement_valid_until','approved_at','consumed_session_id']);
    validateUsDeviceStart({protocol:US_DEVICE_PROTOCOL,installationId:v.installation_id,sessionTokenHash:v.session_token_hash,supportedSchemaVersion:v.supported_schema_version});
    if(!usDeviceHash(v.device_code_hash)||typeof v.user_code!=='string'||!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(v.user_code)||!usDeviceSeconds(v.created_at)||!usDeviceSeconds(v.expires_at)||v.expires_at!==v.created_at+600||!['pending','approved','consumed'].includes(v.status as string))throw new Error();
    if(v.status==='pending'){if(['organization_id','approved_user_id','approved_role','subscription_id','entitlement_valid_until','approved_at','consumed_session_id'].some(key=>v[key]!==null))throw new Error();}
    else if(!usDeviceUuid(v.organization_id)||!usDeviceUuid(v.approved_user_id)||!isAccountRole(v.approved_role)||typeof v.subscription_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.subscription_id)||!usDeviceSeconds(v.approved_at)||v.approved_at<v.created_at||v.approved_at>=v.expires_at||!usDeviceSeconds(v.entitlement_valid_until)||v.entitlement_valid_until<=v.approved_at||
      (v.status==='approved'?v.consumed_session_id!==null:typeof v.consumed_session_id!=='string'||!v.consumed_session_id.startsWith('usd_')||!usDeviceUuid(v.consumed_session_id.slice(4))))throw new Error();
    return v as unknown as UsDeviceChallenge;
  }catch{throw new UsDeviceError('service_unavailable',503);}
}

/** Dependency injection is a private server/test port, never request authority.
 * Stored credentials carry identity only; every use reads current USD rights,
 * seats and PostgreSQL US configuration through access(). */
export function createUsDeviceHandlers(deps:UsDeviceDependencies) {
  const now=()=>{const value=deps.now?.()??Math.floor(Date.now()/1000);if(!usDeviceSeconds(value))throw new UsDeviceError('service_unavailable',503);return value;};
  async function enabled(){if(!await deps.enabled())throw new UsDeviceError('feature_unavailable',404);}
  async function hash(purpose:'session'|'code',token:string){const value=await(deps.hash??hashUsDeviceSecret)(purpose,token);if(!usDeviceHash(value))throw new UsDeviceError('service_unavailable',503);return value;}
  async function browser(request:Request){
    if(request.headers.has('Authorization'))throw new UsDeviceError('unauthorized',401);
    const user=await deps.user();if(!user||!usDeviceUuid(user.userId))throw new UsDeviceError('unauthorized',401);
    const expected=request.headers.get('X-Zentra-Expected-User');if(expected!==null&&expected!==user.userId)throw new UsDeviceError('session_changed',401);
    return user.userId;
  }
  async function access(org:string,user:string){const a=validateUsDeviceAdmission(await deps.access(org,user));if(a.organizationId!==org||a.userId!==user)throw new UsDeviceError('forbidden',403);if(a.entitlementValidUntil<=now())throw new UsDeviceError('management_entitlement_required',402);return a;}
  async function fresh(a:UsDeviceAdmission,request?:Request){
    if(request&&await browser(request)!==a.userId)throw new UsDeviceError('session_changed',401);
    const latest=await access(a.organizationId,a.userId);
    if(!same(a,latest))throw new UsDeviceError(a.role!==latest.role?'forbidden':'session_changed',a.role!==latest.role?403:401);
    if(request&&await browser(request)!==a.userId)throw new UsDeviceError('session_changed',401);
    await enabled();return latest;
  }
  function metadata(row:UsDeviceSessionRow,a:UsDeviceAdmission):UsDeviceSession {
    if(row.revoked_at!==null||row.expires_at<=now())throw new UsDeviceError('unauthorized',401);
    if(row.organization_id!==a.organizationId||row.user_id!==a.userId||row.role!==a.role||row.subscription_id!==a.subscriptionId||row.entitlement_valid_until!==a.entitlementValidUntil)throw new UsDeviceError('forbidden',403);
    return Object.freeze({protocol:US_DEVICE_PROTOCOL,edition:'us_experimental',status:'connected',sessionId:row.session_id,organizationId:row.organization_id,organizationName:a.organizationName,userId:row.user_id,installationId:row.installation_id,role:row.role,subscriptionId:row.subscription_id,country:'US',currency:'USD',expiresAt:row.expires_at,entitlementValidUntil:row.entitlement_valid_until,supportedSchemaVersion:row.supported_schema_version});
  }
  async function retained(store:UsDeviceStore,tokenHash:string,a:UsDeviceAdmission){
    const row=await store.session(tokenHash);if(!row)throw new UsDeviceError('unauthorized',401);
    const detached=cleanRow(row);if(detached.token_hash!==tokenHash)throw new UsDeviceError('unauthorized',401);await fresh(a);metadata(detached,a);
    // Re-read revocation after private admission/configuration awaits. No late
    // result is disclosed from a row whose matching bearer was just revoked.
    const final=await store.session(tokenHash,true);if(!final||JSON.stringify(cleanRow(final))!==JSON.stringify(detached))throw new UsDeviceError('unauthorized',401);
    await enabled();return metadata(detached,a);
  }
  async function requireSession(request:Request,roles?:readonly AccountRole[]):Promise<UsDeviceSession>{
    await enabled();const token=usDeviceBearer(request),tokenHash=await hash('session',token),store=await deps.store();
    const raw=await store.session(tokenHash);if(!raw)throw new UsDeviceError('unauthorized',401);const row=cleanRow(raw);
    if(row.token_hash!==tokenHash||row.revoked_at!==null||row.expires_at<=now())throw new UsDeviceError('unauthorized',401);
    const a=await access(row.organization_id,row.user_id);metadata(row,a);
    if(roles&&!roles.includes(a.role))throw new UsDeviceError('forbidden',403);
    return retained(store,tokenHash,a);
  }
  const guard=async(request:Request,task:()=>Promise<Response>)=>{try{if(new URL(request.url).search)throw new UsDeviceError('invalid_request',422);return await task();}catch(error){return failure(error);}};
  return {
    requireSession,
    START(this:void,request:Request){return guard(request,async()=>{
      await enabled();if(request.headers.has('Authorization'))throw new UsDeviceError('unauthorized',401);
      await deps.rateLimit(request,'start','ip');const v=validateUsDeviceStart(await readJsonObjectWithinLimit(request,2048));
      const capability=async()=>{const max=await deps.maxSchemaVersion?.()??3;if(![1,2,3,4].includes(max))throw new UsDeviceError('service_unavailable',503);if(v.supportedSchemaVersion>max)throw new UsDeviceError('client_upgrade_required',409);};
      await capability();
      await deps.rateLimit(request,'start',v.installationId);const code=deps.newCode?.()??newUsDeviceCode(),codeHash=await hash('code',code),userCode=deps.newUserCode?.()??newUserCode();
      const store=await deps.store();await enabled();const timestamp=now();
      await store.start({codeHash,userCode,installationId:v.installationId,tokenHash:v.sessionTokenHash,schema:v.supportedSchemaVersion,now:timestamp});
      await enabled();await capability();if(now()>=timestamp+600)throw new UsDeviceError('authorization_expired',410);return json({protocol:US_DEVICE_PROTOCOL,deviceCode:code,userCode,verificationUri:'https://zentraapp.ch/appareil/us?code='+encodeURIComponent(userCode),expiresAt:timestamp+600,interval:3,supportedSchemaVersion:v.supportedSchemaVersion},201);
    });},
    APPROVE(this:void,request:Request){return guard(request,async()=>{
      await enabled();requireAccountSameOrigin(request);const userId=await browser(request);await deps.rateLimit(request,'approve',userId);
      const v=validateUsDeviceApprove(await readJsonObjectWithinLimit(request,2048)),store=await deps.store();
      const a=await access(v.organizationId,userId);await fresh(a,request);
      const rawBefore=await store.challenge('user',v.userCode),before=rawBefore?cleanChallenge(rawBefore):null;if(!before||before.expires_at<=now())throw new UsDeviceError('authorization_expired',410);
      if(before.status!=='pending'&&!approved(before,a))throw new UsDeviceError('authorization_conflict',409);
      if(before.status==='pending'){
        await fresh(a,request);
        try{await store.approve(v.userCode,a,now());}catch{await fresh(a,request);}
      }
      const rawAfter=await store.challenge('user',v.userCode),after=rawAfter?cleanChallenge(rawAfter):null;await fresh(a,request);
      if(after&&after.expires_at<=now())throw new UsDeviceError('authorization_expired',410);
      if(!after||after.status==='pending'||!approved(after,a))throw new UsDeviceError('authorization_conflict',409);
      return json({protocol:US_DEVICE_PROTOCOL,approved:true,organizationId:a.organizationId,organizationName:a.organizationName,country:'US',currency:'USD'});
    });},
    EXCHANGE(this:void,request:Request){return guard(request,async()=>{
      await enabled();if(request.headers.has('Authorization'))throw new UsDeviceError('unauthorized',401);
      await deps.rateLimit(request,'exchange','ip');const v=validateUsDeviceExchange(await readJsonObjectWithinLimit(request,2048));
      const codeHash=await hash('code',v.deviceCode),tokenHash=await hash('session',v.sessionToken);await deps.rateLimit(request,'exchange',codeHash);
      const store=await deps.store(),rawChallenge=await store.challenge('code',codeHash),c=rawChallenge?cleanChallenge(rawChallenge):null;
      if(!c||c.device_code_hash!==codeHash||c.installation_id!==v.installationId||c.session_token_hash!==tokenHash)throw new UsDeviceError('unauthorized',401);
      if(c.status!=='consumed'&&c.expires_at<=now())throw new UsDeviceError('authorization_expired',410);
      if(c.status==='pending'){await enabled();if(c.expires_at<=now())throw new UsDeviceError('authorization_expired',410);return json({protocol:US_DEVICE_PROTOCOL,status:'authorization_pending'},202);}
      if(!c.organization_id||!c.approved_user_id)throw new UsDeviceError('service_unavailable',503);
      const a=await access(c.organization_id,c.approved_user_id);if(!approved(c,a))throw new UsDeviceError('forbidden',403);await fresh(a);
      if(c.status==='approved'){
        const id=deps.newSessionId?.()??'usd_'+crypto.randomUUID();
        try{await store.consume(c,id,now());}catch{await fresh(a);}
      }
      const rawConsumed=await store.challenge('code',codeHash),consumed=rawConsumed?cleanChallenge(rawConsumed):null;if(!consumed||consumed.status!=='consumed'||!approved(consumed,a))throw new UsDeviceError('service_unavailable',503);
      const result=await retained(store,tokenHash,a);if(result.sessionId!==consumed.consumed_session_id||result.installationId!==v.installationId)throw new UsDeviceError('unauthorized',401);
      await enabled();return json(result);
    });},
    ME(this:void,request:Request){return guard(request,async()=>{await enabled();await deps.rateLimit(request,'me','ip');return json(await requireSession(request));});},
    REVOKE(this:void,request:Request){return guard(request,async()=>{
      const token=usDeviceBearer(request),tokenHash=await hash('session',token);await deps.rateLimit(request,'revoke',tokenHash);
      if(request.body){const v=usDeviceExact(await readJsonObjectWithinLimit(request,256),['protocol']);if(v.protocol!==US_DEVICE_PROTOCOL)throw new UsDeviceError('invalid_request',422);}
      const store=await deps.store(),row=await store.session(tokenHash);if(!row||cleanRow(row).token_hash!==tokenHash)throw new UsDeviceError('unauthorized',401);
      try{await store.revoke(tokenHash,now());}catch{/* An uncertain revocation may already have committed. Read the exact hash. */}
      const current=await store.session(tokenHash);if(!current||cleanRow(current).revoked_at===null)throw new UsDeviceError('service_unavailable',503);
      return json({protocol:US_DEVICE_PROTOCOL,revoked:true});
    });},
  };
}
