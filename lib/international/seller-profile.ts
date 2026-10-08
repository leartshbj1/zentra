import type { AccountRole } from '../account-security';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { canonicalErpJson } from './erp-contract';
import { parseInstant } from './localization';

export type SellerProfileStore=Pick<SupabaseServerClient,'rpc'>;
/** Fresh membership and SaaS rights are supplied by the Auth/D1 boundary. */
export interface SellerProfileActor {readonly organizationId:string;readonly userId:string;readonly role:AccountRole;}
export interface UsSellerProfile {readonly displayName:string;readonly contactEmail?:string;readonly contactPhone?:string;}
export interface UsSellerProfileConfigured {readonly status:'configured';readonly organizationId:string;readonly revision:number;readonly profile:UsSellerProfile;readonly updatedBy:string;readonly updatedAt:string;}
export type UsSellerProfileState=UsSellerProfileConfigured|Readonly<{status:'unconfigured';organizationId:string;revision:0}>;
export interface UsSellerProfileWrite {readonly expectedRevision:number;readonly requestId:string;readonly profile:UsSellerProfile;}
export interface UsSellerProfileReceipt extends UsSellerProfileConfigured {readonly requestId:string;readonly replayed:boolean;}
export class SellerProfileError extends Error {
  constructor(readonly code:'invalid_request'|'forbidden'|'revision_conflict'|'request_id_conflict'|'workspace_unavailable'|'service_unavailable',readonly status:number){super(code);this.name='SellerProfileError';}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scope=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function object(input:unknown,allowed:readonly string[],required:readonly string[]):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new SellerProfileError('invalid_request',422);
  const value=input as Record<string,unknown>;
  if(required.some(key=>!Object.hasOwn(value,key)))throw new SellerProfileError('invalid_request',422);
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!allowed.includes(key))throw new SellerProfileError('invalid_request',422);
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)throw new SellerProfileError('invalid_request',422);
  }
  return value;
}
function text(value:unknown,maximum:number):string {
  if(typeof value!=='string'||!value.trim()||value.length>maximum||Array.from(value).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))throw new SellerProfileError('invalid_request',422);
  return value.trim();
}
function profile(input:unknown):UsSellerProfile {
  const value=object(input,['displayName','contactEmail','contactPhone'],['displayName']);
  const displayName=text(value.displayName,256),contactEmail=Object.hasOwn(value,'contactEmail')?text(value.contactEmail,254):undefined,contactPhone=Object.hasOwn(value,'contactPhone')?text(value.contactPhone,80):undefined;
  if(contactEmail!==undefined&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contactEmail))throw new SellerProfileError('invalid_request',422);
  return Object.freeze({displayName,...(contactEmail===undefined?{}:{contactEmail}),...(contactPhone===undefined?{}:{contactPhone})});
}
function actorValid(actor:SellerProfileActor,owner=false):void {
  if(!actor||typeof actor.organizationId!=='string'||!scope.test(actor.organizationId)||typeof actor.userId!=='string'||!actor.userId.trim()||actor.userId.length>256||Array.from(actor.userId).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)||!['owner','admin','accountant','member','read_only'].includes(actor.role)||owner&&actor.role!=='owner')throw new SellerProfileError('forbidden',403);
}
export function validateUsSellerProfileWrite(input:unknown):UsSellerProfileWrite {
  const value=object(input,['expectedRevision','requestId','profile'],['expectedRevision','requestId','profile']);
  if(!Number.isSafeInteger(value.expectedRevision)||(value.expectedRevision as number)<0||(value.expectedRevision as number)>=Number.MAX_SAFE_INTEGER-1||typeof value.requestId!=='string'||!UUID.test(value.requestId))throw new SellerProfileError('invalid_request',422);
  return Object.freeze({expectedRevision:value.expectedRevision as number,requestId:value.requestId.toLowerCase(),profile:profile(value.profile)});
}
function configured(input:unknown,organizationId:string,receipt=false):UsSellerProfileConfigured {
  const fields=['status','organizationId','revision','profile','updatedBy','updatedAt'];
  const value=object(input,receipt?[...fields,'requestId','replayed']:fields,fields);
  const parsed=profile(value.profile);
  if(value.status!=='configured'||value.organizationId!==organizationId||!Number.isSafeInteger(value.revision)||(value.revision as number)<1||(value.revision as number)>=Number.MAX_SAFE_INTEGER||typeof value.updatedBy!=='string'||!value.updatedBy.trim()||value.updatedBy.length>256||Array.from(value.updatedBy).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)||typeof value.updatedAt!=='string'||canonicalErpJson(parsed)!==canonicalErpJson(value.profile))throw new Error('Invalid seller profile response');
  // PostgreSQL preserves microseconds. Validate a millisecond projection only;
  // keep the exact original timestamp in current and historical receipts.
  if(!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value.updatedAt))throw new Error('Invalid seller timestamp');
  parseInstant(value.updatedAt.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/,'$1'));
  return Object.freeze({status:'configured',organizationId,revision:value.revision as number,profile:parsed,updatedBy:value.updatedBy,updatedAt:value.updatedAt});
}
function storageError(error:unknown):SellerProfileError {
  if(error instanceof SupabaseServerError){
    const states={PS001:['revision_conflict',409],PS002:['request_id_conflict',409],PS003:['workspace_unavailable',409],PS004:['invalid_request',422]} as const;
    const value=states[error.code as keyof typeof states];if(value)return new SellerProfileError(value[0],value[1]);
  }
  return new SellerProfileError('service_unavailable',503);
}
export async function getUsSellerProfile(store:SellerProfileStore,actor:SellerProfileActor):Promise<UsSellerProfileState> {
  actorValid(actor);const organizationId=actor.organizationId;
  try {
    const result=await store.rpc<unknown>('zentra_read_us_seller_profile',{p_organization:organizationId});
    const row=object(result,['status','organizationId','revision','profile','updatedBy','updatedAt'],['status','organizationId','revision']);
    if(row.status==='unconfigured'){
      const value=object(row,['status','organizationId','revision'],['status','organizationId','revision']);
      if(value.organizationId!==organizationId||value.revision!==0)throw new Error('Invalid empty seller response');
      return Object.freeze({status:'unconfigured',organizationId,revision:0});
    }
    return configured(result,organizationId);
  }catch(error){throw storageError(error);}
}
export async function putUsSellerProfile(store:SellerProfileStore,actor:SellerProfileActor,input:unknown,beforeWrite?:()=>Promise<void>):Promise<UsSellerProfileReceipt> {
  actorValid(actor,true);const write=validateUsSellerProfileWrite(input);
  const organizationId=actor.organizationId,userId=actor.userId;
  // Auth exceptions retain their status. Never catch this hook as a SQL error.
  if(beforeWrite)await beforeWrite();
  try {
    const result=await store.rpc<unknown>('zentra_put_us_seller_profile',{p_organization:organizationId,p_actor:userId,p_expected_revision:write.expectedRevision,p_request_id:write.requestId,p_profile:write.profile});
    const state=configured(result,organizationId,true),row=result as Record<string,unknown>;
    if(row.requestId!==write.requestId||typeof row.replayed!=='boolean'||state.updatedBy!==userId||state.revision!==write.expectedRevision+1||canonicalErpJson(state.profile)!==canonicalErpJson(write.profile))throw new Error('Invalid seller receipt');
    return Object.freeze({...state,requestId:write.requestId,replayed:row.replayed});
  }catch(error){throw storageError(error);}
}
