import type { FinancialAuthority } from './accounting/ledger';
import type { SupabaseServerClient } from '../supabase-server';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { confirmErpReadAdmission } from './read-admission';
import { validateUsSellerProfileState, type UsSellerProfile, type UsSellerProfileState } from './seller-profile';
import type { CompanyConfiguration } from './types';
import type { WorkspaceCountryConfigured, WorkspaceCountryState } from './workspace-service';

export type UsFinancialPilotQuoteIdentity=Readonly<{
  organizationId:string;countryRevision:number;configuration:CompanyConfiguration;sellerRevision:number;seller:UsSellerProfile;
}>;
export type UsFinancialPilotQuoteIdentityDependencies=Readonly<{
  country(this:void,actor:FinancialAuthority):Promise<WorkspaceCountryState>;
  seller(this:void,actor:FinancialAuthority):Promise<UsSellerProfileState>;
}>;
export class UsFinancialPilotQuoteIdentityError extends Error {
  constructor(readonly code:'financial_pilot_seller_required'|'financial_pilot_quote_identity_changed'|'service_unavailable',readonly status:409|503){super(code);this.name='UsFinancialPilotQuoteIdentityError';}
}
const unavailable=():never=>{throw new UsFinancialPilotQuoteIdentityError('service_unavailable',503);};
const control=(value:string)=>Array.from(value).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127);
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))return unavailable();
  return value as Record<string,unknown>;
}
function revision(value:unknown):number{if(!Number.isSafeInteger(value)||(value as number)<1||(value as number)>=Number.MAX_SAFE_INTEGER)return unavailable();return value as number;}
function actor(value:unknown):FinancialAuthority{
  const a=object(snapshotPrivateJson(value),['organizationId','userId','role','managementEntitled','timestamp']);
  for(const key of ['organizationId','userId'])if(typeof a[key]!=='string'||!(a[key] as string).trim()||a[key]!== (a[key] as string).trim()||(a[key] as string).length>256||control(a[key] as string))return unavailable();
  if(!['owner','admin','accountant'].includes(a.role as string)||a.managementEntitled!==true||typeof a.timestamp!=='string')return unavailable();
  parseInstant(a.timestamp);return a as unknown as FinancialAuthority;
}
function configuration(value:unknown,organizationId:string):CompanyConfiguration{
  const c=validateCompanyConfiguration(value);
  if(c.organizationId!==organizationId||c.country!=='US'||c.currency!=='USD'||c.accountingBasis!=='accrual')return unavailable();
  return c;
}
function country(input:unknown,organizationId:string):WorkspaceCountryConfigured{
  const value=object(snapshotPrivateJson(input),['status','organizationId','revision','configuration','updatedBy','updatedAt']);
  if(value.status!=='configured'||value.organizationId!==organizationId||typeof value.updatedBy!=='string'||!value.updatedBy.trim()||value.updatedBy!==value.updatedBy.trim()||value.updatedBy.length>256||control(value.updatedBy)||typeof value.updatedAt!=='string')return unavailable();
  // Keep PostgreSQL microseconds in the captured envelope, validating its instant.
  if(!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value.updatedAt))return unavailable();
  parseInstant(value.updatedAt.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/,'$1'));
  return Object.freeze({...value,revision:revision(value.revision),configuration:configuration(value.configuration,organizationId)}) as unknown as WorkspaceCountryConfigured;
}
/** Read only the versioned public profile head. The legacy seller RPC is
 * intentionally closed after V5 promotion; it is never reopened here. This
 * reader grants no rights: readIdentity surrounds it with full pilot admission. */
export async function readUsFinancialPilotQuoteSeller(store:Pick<SupabaseServerClient,'select'>,supplied:FinancialAuthority):Promise<UsSellerProfileState>{
  try{
    const trusted=actor(supplied),prototype=Object.getPrototypeOf(store),method=Object.getOwnPropertyDescriptor(store,'select')??(prototype===null?undefined:Object.getOwnPropertyDescriptor(prototype,'select'));
    if(!method||!('value'in method)||typeof method.value!=='function')return unavailable();
    const select=method.value.bind(store) as SupabaseServerClient['select'];
    const rows=snapshotPrivateJson(await select<unknown>('zentra_us_seller_profiles',{select:'organization_id,revision,profile,updated_by,updated_at',organization_id:'eq.'+trusted.organizationId,limit:1}));
    if(!Array.isArray(rows)||rows.length>1)return unavailable();
    if(rows.length===0)return Object.freeze({status:'unconfigured',organizationId:trusted.organizationId,revision:0});
    const row=object(rows[0],['organization_id','revision','profile','updated_by','updated_at']);
    if(row.organization_id!==trusted.organizationId)return unavailable();
    return validateUsSellerProfileState({status:'configured',organizationId:trusted.organizationId,revision:row.revision,profile:row.profile,updatedBy:row.updated_by,updatedAt:row.updated_at},trusted.organizationId);
  }catch{return unavailable();}
}
/** Private detached identity. No export/browser type imports: projection may
 * reuse this validator without a contract/projection dependency cycle. */
export function validateUsFinancialPilotQuoteIdentity(input:unknown,organizationId?:string):UsFinancialPilotQuoteIdentity{
  try{
    const value=object(snapshotPrivateJson(input),['organizationId','countryRevision','configuration','sellerRevision','seller']);
    if(typeof value.organizationId!=='string'||organizationId!==undefined&&value.organizationId!==organizationId)return unavailable();
    const c=configuration(value.configuration,value.organizationId),s=revision(value.sellerRevision);
    // Reuse the closed profile validator through a structural-only envelope;
    // these constants are never stored or treated as seller audit evidence.
    const validated=validateUsSellerProfileState({status:'configured',organizationId:value.organizationId,revision:s,profile:value.seller,updatedBy:'private-identity-validation',updatedAt:'2026-01-01T00:00:00Z'},value.organizationId);
    if(validated.status!=='configured')return unavailable();
    return Object.freeze({organizationId:value.organizationId,countryRevision:revision(value.countryRevision),configuration:c,sellerRevision:s,seller:validated.profile});
  }catch{return unavailable();}
}
/** Bounded C1 → S → C2 observations. Current admission is renewed around each
 * private wait, including rejection. This is not a transaction across stores. */
export async function readUsFinancialPilotQuoteIdentity(input:UsFinancialPilotQuoteIdentityDependencies,supplied:FinancialAuthority,revalidate:()=>Promise<FinancialAuthority>):Promise<UsFinancialPilotQuoteIdentity>{
  let trusted:FinancialAuthority,readCountry:UsFinancialPilotQuoteIdentityDependencies['country'],readSeller:UsFinancialPilotQuoteIdentityDependencies['seller'];
  try{
    trusted=actor(supplied);
    const bind=<K extends keyof UsFinancialPilotQuoteIdentityDependencies>(key:K):UsFinancialPilotQuoteIdentityDependencies[K]=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!('value'in d)||typeof d.value!=='function')return unavailable();return d.value.bind(undefined) as UsFinancialPilotQuoteIdentityDependencies[K];};
    readCountry=bind('country');readSeller=bind('seller');if(typeof revalidate!=='function')return unavailable();
  }catch{return unavailable();}
  const admit=revalidate.bind(undefined);
  async function admission(){const fresh=actor(await admit());confirmErpReadAdmission({mode:'browser',actor:trusted},{mode:'browser',actor:fresh});}
  async function read<T>(load:()=>Promise<unknown>,validate:(value:unknown)=>T):Promise<T>{
    await admission();let value:T;
    try{value=validate(await load());}catch(error){await admission();if(error instanceof UsFinancialPilotQuoteIdentityError)throw error;return unavailable();}
    await admission();return value;
  }
  const c1=await read(()=>readCountry(trusted),value=>country(value,trusted.organizationId));
  const seller=await read(()=>readSeller(trusted),value=>{
    const result=validateUsSellerProfileState(snapshotPrivateJson(value),trusted.organizationId);
    if(result.status!=='configured')throw new UsFinancialPilotQuoteIdentityError('financial_pilot_seller_required',409);
    return result;
  });
  const c2=await read(()=>readCountry(trusted),value=>country(value,trusted.organizationId));
  if(c1.revision!==c2.revision||canonicalErpJson(c1.configuration)!==canonicalErpJson(c2.configuration))throw new UsFinancialPilotQuoteIdentityError('financial_pilot_quote_identity_changed',409);
  return validateUsFinancialPilotQuoteIdentity({organizationId:trusted.organizationId,countryRevision:c2.revision,configuration:c2.configuration,sellerRevision:seller.revision,seller:seller.profile},trusted.organizationId);
}
