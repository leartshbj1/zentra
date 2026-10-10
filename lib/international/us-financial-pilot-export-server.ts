import { AccountPublicError } from '../account-security';
import { sha256Hex } from './canonical-hash';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { CompanyConfiguration } from './types';
import type { FinancialAuthority } from './accounting/ledger';
import { UsFinancialPilotError, validateUsFinancialPilotHead } from './us-financial-pilot-contract';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import type { UsFinancialPilotDependencies } from './us-financial-pilot-server';
import {
  US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES, US_FINANCIAL_PILOT_EXPORT_HEADERS,
  UsFinancialPilotExportError, validateUsFinancialPilotExportSelector, validateUsFinancialPilotExportSnapshot,
  type UsFinancialPilotExportFormat, type UsFinancialPilotExportSelector, type UsFinancialPilotExportSnapshot,
} from './us-financial-pilot-export-contract';
import { buildUsFinancialPilotEstimateExportSnapshot, buildUsFinancialPilotExportSnapshot } from './us-financial-pilot-export-projection';
import { readUsFinancialPilotView } from './us-financial-pilot-projection';
import { UsFinancialPilotQuoteIdentityError, validateUsFinancialPilotQuoteIdentity, type UsFinancialPilotQuoteIdentity } from './us-financial-pilot-quote-identity';
import { creationUuid } from './workspace-creation';

export interface UsFinancialPilotExportFonts { readonly regular: Uint8Array; readonly bold: Uint8Array }
export type UsFinancialPilotExportStage='parameters'|'admission'|'source'|'identity'|'snapshot'|'fonts'|'render'|'hash'|'head'|'postflight';
export interface UsFinancialPilotExportDependencies extends Pick<UsFinancialPilotDependencies,'enabled'|'authority'|'configuration'|'scope'|'store'|'rateLimit'> {
  fonts(this:void):Promise<UsFinancialPilotExportFonts>|UsFinancialPilotExportFonts;
  render?(this:void,snapshot:UsFinancialPilotExportSnapshot,format:UsFinancialPilotExportFormat,fonts?:UsFinancialPilotExportFonts):Promise<Uint8Array|string>|Uint8Array|string;
  hash?(this:void,bytes:Uint8Array):Promise<string>;
  quoteIdentity?(this:void,actor:FinancialAuthority,revalidate:()=>Promise<FinancialAuthority>):Promise<UsFinancialPilotQuoteIdentity>;
  diagnostic?(this:void,event:Readonly<{operation:'invoice'|'report'|'estimate';stage:UsFinancialPilotExportStage;code:string;status:number}>):void;
  /** Private bounded test seam. It never comes from a browser or a grant. */
  deadlineMs?:number;
}
const securityHeaders={'Cache-Control':'no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot'};
const invalid=():never=>{throw new ErpError('invalid_financial_pilot_export_request',422);};
const unavailable=():never=>{throw new ErpError('financial_export_unavailable',503);};
function sameOrigin(request:Request):void {
  const origin=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');
  // Same-origin browser GETs normally omit Origin but carry Fetch Metadata.
  if(origin?origin!==new URL(request.url).origin:!['same-origin','none'].includes(site??''))throw new ErpError('forbidden',403);
  if(site&&!['same-origin','none'].includes(site))throw new ErpError('forbidden',403);
}
const publicCodes:Readonly<Record<string,number>>={
  unauthorized:401,session_changed:401,forbidden:403,tenant_mismatch:403,management_entitlement_required:402,financial_permission_required:403,
  feature_unavailable:404,financial_pilot_unavailable:404,financial_pilot_opt_in_required:403,financial_pilot_opt_in_changed:409,
  financial_test_grant_required:403,financial_test_grant_changed:409,financial_authority_changed:403,financial_configuration_changed:409,
  financial_policy_unavailable:409,financial_upgrade_required:409,financial_capability_unavailable:409,financial_book_too_large:413,
  financial_snapshot_changed:409,financial_book_required:409,financial_source_changed:409,financial_clock_reversed:409,
  invalid_financial_pilot_export_request:422,invalid_financial_pilot_query:422,financial_pilot_record_not_found:404,
  financial_pilot_too_large:413,financial_pilot_cash_flow_unavailable:409,rate_limited:429,edition_unavailable:409,
  financial_export_unavailable:503,financial_export_timeout:503,method_not_allowed:405,
  invalid_financial_pilot_export_selector:422,invalid_financial_pilot_export_snapshot:503,financial_pilot_export_source_not_found:404,
  financial_pilot_export_too_large:413,financial_pilot_export_unavailable:409,financial_pilot_export_cash_flow_unavailable:409,
  invalid_financial_pilot_export_font:503,unsupported_financial_pilot_export_glyph:422,
  financial_pilot_seller_required:409,financial_pilot_quote_identity_changed:409,
};
function capturedAdmission(value:unknown):ErpReadAdmission {
  const a=snapshotPrivateJson(value) as ErpReadAdmission;
  if(!a||Reflect.ownKeys(a).length!==2||!Object.hasOwn(a,'mode')||!Object.hasOwn(a,'actor')||!['browser','device'].includes(a.mode)||!a.actor||Reflect.ownKeys(a.actor).length!==5||!['organizationId','userId','role','managementEntitled','timestamp'].every(key=>Object.hasOwn(a.actor,key)))return unavailable();
  if(typeof a.actor.userId!=='string'||!a.actor.userId||a.actor.userId!==a.actor.userId.trim()||a.actor.userId.length>256||Array.from(a.actor.userId).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)||typeof a.actor.organizationId!=='string'||typeof a.actor.managementEntitled!=='boolean'||typeof a.actor.timestamp!=='string'||!Number.isFinite(Date.parse(a.actor.timestamp)))return unavailable();
  if(!['owner','admin','accountant','member','read_only'].includes(a.actor.role))return unavailable();
  return a;
}
function copyBytes(input:unknown,maximum:number):Uint8Array<ArrayBuffer> {
  if(!(input instanceof Uint8Array)||Object.getPrototypeOf(input)!==Uint8Array.prototype)return unavailable();
  const prototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
  const length=Object.getOwnPropertyDescriptor(prototype,'length')!.get!.call(input) as number;
  const buffer=Object.getOwnPropertyDescriptor(prototype,'buffer')!.get!.call(input) as unknown;
  if(!Number.isSafeInteger(length)||length<1||!buffer||Object.getPrototypeOf(buffer)!==ArrayBuffer.prototype)return unavailable();
  if(length>maximum)throw new ErpError('financial_pilot_export_too_large',413);
  const copy=new Uint8Array(length);Uint8Array.prototype.set.call(copy,input);return copy;
}
function fonts(input:unknown):UsFinancialPilotExportFonts {
  if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==2)return unavailable();
  const read=(key:'regular'|'bold')=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!d.enumerable||!('value'in d))return unavailable();return copyBytes(d.value,2*1024*1024);};
  return Object.freeze({regular:read('regular'),bold:read('bold')});
}
function outputBytes(output:unknown,format:UsFinancialPilotExportFormat):Uint8Array<ArrayBuffer> {
  if(format==='pdf'){
    const bytes=copyBytes(output,US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES);
    if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-'||!new TextDecoder().decode(bytes.subarray(-2048)).includes('%%EOF'))return unavailable();
    return bytes;
  }
  if(typeof output!=='string'||!output.startsWith('\uFEFF'))return unavailable();
  if(output.length>US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES)throw new ErpError('financial_pilot_export_too_large',413);
  return copyBytes(new TextEncoder().encode(output),US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES);
}
function parameters(request:Request,kind:'invoice'|'report'|'estimate',detail:string):UsFinancialPilotExportSelector {
  if(request.method!=='GET')throw new ErpError('method_not_allowed',405);
  if(request.url.length>4096)return invalid();
  const params=new URL(request.url).searchParams;
  const allowed=['revision','format','language',...(kind==='estimate'?['estimateRevision']:kind==='report'?(detail==='trial_balance'||detail==='balance_sheet'?['asOf']:detail==='general_ledger'?['from','to','accountId']:detail==='profit_loss'||detail==='cash_flow'?['from','to']:[]):[])];
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)return invalid();
  const raw=params.get('revision');if(raw===null||!/^[1-9][0-9]{0,15}$/.test(raw)||!Number.isSafeInteger(Number(raw)))return invalid();
  if(kind==='estimate'){
    const e=params.get('estimateRevision');
    if(allowed.some(key=>!params.has(key))||e===null||!/^[1-9][0-9]{0,15}$/.test(e)||!Number.isSafeInteger(Number(e))||Number(e)>=Number.MAX_SAFE_INTEGER||Number(raw)>=Number.MAX_SAFE_INTEGER)return invalid();
    return validateUsFinancialPilotExportSelector({kind,estimateId:detail,estimateRevision:Number(e),revision:Number(raw),format:params.get('format'),language:params.get('language')});
  }
  const selector:Record<string,unknown>={revision:Number(raw),format:params.get('format'),language:params.get('language'),kind,...(kind==='invoice'?{invoiceId:detail}:{reportType:detail})};
  for(const key of allowed)if(!['revision','format','language'].includes(key)&&params.has(key))selector[key]=params.get(key);
  return validateUsFinancialPilotExportSelector(selector);
}
function filename(selector:UsFinancialPilotExportSelector):string {
  if(selector.kind==='estimate')return `zentra-estimate-r${selector.revision}-e${selector.estimateRevision}-${selector.language}.pdf`;
  return `zentra-${selector.kind==='invoice'?'invoice':selector.reportType}-r${selector.revision}-${selector.language}.${selector.format}`;
}
function admissionDenial(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const s=Object.getOwnPropertyDescriptor(error,'status'),d=Object.getOwnPropertyDescriptor(error,'code');
  if(!s||!('value'in s)||![401,402,403].includes(s.value as number))return false;
  if(error instanceof AccountPublicError)return true;
  return error instanceof ErpError&&!!d&&'value'in d&&typeof d.value==='string'&&Object.hasOwn(publicCodes,d.value)&&publicCodes[d.value]===s.value;
}
function failure(error:unknown,operation:'invoice'|'report'|'estimate',stage:UsFinancialPilotExportStage,diagnostic:UsFinancialPilotExportDependencies['diagnostic']):Response {
  let code='financial_export_unavailable',status=503;
  try{
    const d=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code'):undefined,s=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'status'):undefined;
    if(error instanceof AccountPublicError){status=s&&'value'in s&&[401,402,403,429].includes(s.value as number)?s.value as number:503;code=status===401?'unauthorized':status===402?'management_entitlement_required':status===403?'forbidden':status===429?'rate_limited':code;}
    else if(error instanceof ErpError||error instanceof UsFinancialPilotError||error instanceof UsFinancialPilotExportError||error instanceof UsFinancialPilotQuoteIdentityError){if(d&&s&&'value'in d&&'value'in s&&typeof d.value==='string'&&Object.hasOwn(publicCodes,d.value)&&publicCodes[d.value]===s.value){code=d.value;status=s.value as number;}}
  }catch{/* Malformed private exceptions remain one generic bounded field. */}
  try{diagnostic?.({operation,stage,code,status});}catch{/* Diagnostics never disclose data or change admission. */}
  return Response.json({error:code},{status,headers:{...securityHeaders,...(status===405?{Allow:'GET'}:{})}});
}
/** Read-only browser export boundary. The captured private store exposes only
 * read/head here; no receipt, commit, provider or Storage operation is used. */
export function createUsFinancialPilotExportHandlers(input:UsFinancialPilotExportDependencies){
  const bind=<K extends keyof UsFinancialPilotExportDependencies>(key:K,optional=false):UsFinancialPilotExportDependencies[K]=>{
    const d=Object.getOwnPropertyDescriptor(input,key);if(!d&&optional)return undefined as UsFinancialPilotExportDependencies[K];
    if(!d||!('value'in d)||typeof d.value!=='function')return unavailable();
    return d.value.bind(undefined) as UsFinancialPilotExportDependencies[K];
  };
  const deps=Object.freeze({enabled:bind('enabled'),authority:bind('authority'),configuration:bind('configuration'),scope:bind('scope'),store:bind('store'),rateLimit:bind('rateLimit'),fonts:bind('fonts'),render:bind('render',true),hash:bind('hash',true),quoteIdentity:bind('quoteIdentity',true),diagnostic:bind('diagnostic',true)});
  const descriptor=Object.getOwnPropertyDescriptor(input,'deadlineMs'),duration=descriptor&&'value'in descriptor?descriptor.value:30_000;
  if(descriptor&&!('value'in descriptor)||typeof duration!=='number'||!Number.isSafeInteger(duration)||duration<1||duration>120_000)return unavailable();
  async function run(supplied:Request,organizationId:string,kind:'invoice'|'report'|'estimate',detail:string):Promise<Response>{
    // Request headers/cookies and callback references are owned before a wait.
    const request=new Request(supplied.url,{method:supplied.method,headers:new Headers(supplied.headers),signal:supplied.signal});
    const until=Date.now()+duration;let stage:UsFinancialPilotExportStage='parameters',trusted:ErpReadAdmission|undefined,scope:UsFinancialPilotScope|undefined,configuration:CompanyConfiguration|undefined;
    function active(){if(request.signal.aborted)throw new ErpError('financial_export_unavailable',503);if(Date.now()>=until)throw new ErpError('financial_export_timeout',503);}
    async function wait<T>(task:()=>T|Promise<T>):Promise<T>{
      active();let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
      try{return await Promise.race([Promise.resolve().then(task),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ErpError('financial_export_timeout',503)),Math.max(1,until-Date.now()));abort=()=>reject(new ErpError('financial_export_unavailable',503));request.signal.addEventListener('abort',abort,{once:true});})]);}
      finally{if(timer)clearTimeout(timer);if(abort)request.signal.removeEventListener('abort',abort);}
    }
    async function authority(){
      const current=capturedAdmission(await wait(()=>deps.authority(request,organizationId)));confirmErpExpectedUser(request,current);
      if(current.mode!=='browser')throw new ErpError('forbidden',403);
      if(current.actor.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
      if(!current.actor.managementEntitled)throw new ErpError('management_entitlement_required',402);
      if(!['owner','admin','accountant'].includes(current.actor.role))throw new ErpError('financial_permission_required',403);
      if(trusted)confirmErpReadAdmission(trusted,current);return current;
    }
    async function admission():Promise<UsFinancialPilotScope>{
      const fresh=await authority();if(!await wait(deps.enabled))throw new ErpError('feature_unavailable',404);
      const config=validateCompanyConfiguration(snapshotPrivateJson(await wait(()=>deps.configuration(fresh.actor))));
      if(config.organizationId!==organizationId||config.country!=='US'||config.currency!=='USD'||config.accountingBasis!=='accrual')throw new ErpError('edition_unavailable',409);
      if(configuration&&canonicalErpJson(config)!==canonicalErpJson(configuration))throw new ErpError('financial_configuration_changed',409);
      const current=captureUsFinancialPilotScope(await wait(()=>deps.scope(fresh.actor,scope)));
      if(current.scope.organizationId!==organizationId||current.scope.actor.userId!==fresh.actor.userId||current.scope.actor.role!==fresh.actor.role)throw new ErpError('financial_authority_changed',403);
      if(scope&&(current.optInVersion!==scope.optInVersion||current.scope.grantVersion!==scope.scope.grantVersion))throw new ErpError('financial_test_grant_changed',409);
      if(scope&&canonicalErpJson(current.scope.policy)!==canonicalErpJson(scope.scope.policy))throw new ErpError('financial_policy_unavailable',409);
      if(!await wait(deps.enabled))throw new ErpError('feature_unavailable',404);
      // Recheck rollout after the final Auth/D1 wait as well as the scope reads.
      await authority();if(!await wait(deps.enabled))throw new ErpError('feature_unavailable',404);active();return current;
    }
    try{
      if(request.headers.has('Authorization'))throw new ErpError('forbidden',403);
      if(request.headers.get('X-Zentra-Financial-Pilot')!=='1'||!request.headers.get('X-Zentra-Expected-User'))return invalid();
      try{creationUuid(organizationId);}catch{return invalid();}
      sameOrigin(request);const selector=parameters(request,kind,detail);
      if(!await wait(deps.enabled))throw new ErpError('feature_unavailable',404);
      stage='admission';trusted=await authority();await wait(()=>deps.rateLimit(request,trusted!.actor,'read'));
      configuration=validateCompanyConfiguration(snapshotPrivateJson(await wait(()=>deps.configuration(trusted!.actor))));
      scope=await admission();const suppliedStore=await wait(()=>deps.store(scope!,admission));
      const method=(key:'read'|'head')=>{const d=Object.getOwnPropertyDescriptor(suppliedStore,key);if(!d||!('value'in d)||typeof d.value!=='function')return unavailable();return d.value.bind(undefined) as (...args:string[])=>Promise<unknown>;};
      const read=method('read'),head=method('head');await admission();
      stage='source';const source=snapshotPrivateJson(await wait(()=>read(organizationId)));if(source===null)throw new ErpError('financial_book_required',409);
      if(!source||typeof source!=='object'||Array.isArray(source)||!('baseline'in source)||!source.baseline||typeof source.baseline!=='object'||Array.isArray(source.baseline)||!('configuration'in source.baseline)||!('policy'in source))return unavailable();
      if(canonicalErpJson(source.baseline.configuration)!==canonicalErpJson(configuration))throw new ErpError('financial_configuration_changed',409);
      if(canonicalErpJson(source.policy)!==canonicalErpJson(scope.scope.policy))throw new ErpError('financial_policy_unavailable',409);
      await admission();
      let identity:UsFinancialPilotQuoteIdentity|undefined;
      const identityAdmission=async()=>{const current=await admission();return current.scope.actor;};
      async function quoteIdentity(){
        if(!deps.quoteIdentity)return unavailable();
        await admission();
        const captured=validateUsFinancialPilotQuoteIdentity(await wait(()=>deps.quoteIdentity!(trusted!.actor,identityAdmission)),organizationId);
        await admission();
        if(canonicalErpJson(captured.configuration)!==canonicalErpJson(configuration))throw new UsFinancialPilotQuoteIdentityError('financial_pilot_quote_identity_changed',409);
        return captured;
      }
      if(selector.kind==='estimate'){
        // Resolve existence/E before private current seller reads. No receipt or
        // current customer card contributes to a saved quote's recipient.
        const view=await wait(()=>readUsFinancialPilotView(source,selector.revision));await admission();
        const estimate=view.estimates.find(row=>row.id===selector.estimateId);
        if(!estimate)throw new UsFinancialPilotExportError('financial_pilot_export_source_not_found',404);
        if(estimate.revision!==selector.estimateRevision)throw new ErpError('financial_snapshot_changed',409);
        stage='identity';identity=await quoteIdentity();
      }
      stage='snapshot';const snapshot=validateUsFinancialPilotExportSnapshot(await wait(()=>selector.kind==='estimate'?buildUsFinancialPilotEstimateExportSnapshot(source,selector,identity!):buildUsFinancialPilotExportSnapshot(source,selector)),organizationId,selector);await admission();
      stage='fonts';const ownedFonts=selector.format==='pdf'?fonts(await wait(deps.fonts)):undefined;await admission();
      stage='render';const output=await wait(async()=>{if(deps.render)return deps.render(snapshot,selector.format,ownedFonts);const renderer=await import('./us-financial-pilot-export-renderer');return selector.format==='pdf'?renderer.renderUsFinancialPilotExportPdf(snapshot,ownedFonts!):renderer.renderUsFinancialPilotExportCsv(snapshot);});
      const bytes=outputBytes(output,selector.format);await admission();
      stage='hash';const hash=deps.hash??sha256Hex;const contentHash=await wait(()=>hash(copyBytes(bytes,US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES)));
      if(typeof contentHash!=='string'||!/^[0-9a-f]{64}$/.test(contentHash))return unavailable();
      const selectorHash=await wait(()=>sha256Hex(canonicalErpJson(selector)));await admission();
      if(identity){stage='identity';if(canonicalErpJson(await quoteIdentity())!==canonicalErpJson(identity))throw new UsFinancialPilotQuoteIdentityError('financial_pilot_quote_identity_changed',409);}
      stage='head';const currentHead=validateUsFinancialPilotHead(await wait(head),organizationId);
      if(currentHead.revision!==selector.revision)throw new ErpError('financial_snapshot_changed',409);
      stage='postflight';await admission();active();
      const headers=new Headers(securityHeaders);headers.set('Content-Type',selector.format==='pdf'?'application/pdf':'text/csv; charset=utf-8');headers.set('Content-Length',String(bytes.byteLength));headers.set('Content-Disposition',`attachment; filename="${filename(selector)}"`);
      const h=US_FINANCIAL_PILOT_EXPORT_HEADERS;
      for(const [key,value]of [[h.scope,'1'],[h.organization,organizationId],[h.revision,String(snapshot.revision)],[h.ledgerRevision,String(snapshot.ledgerRevision)],[h.currency,'USD'],[h.language,selector.language],[h.format,selector.format],[h.selectorHash,selectorHash],[h.contentHash,contentHash]])headers.set(key,value);
      if(selector.kind==='estimate'&&identity){headers.set(h.estimateRevision,String(selector.estimateRevision));headers.set(h.countryRevision,String(identity.countryRevision));headers.set(h.sellerRevision,String(identity.sellerRevision));headers.set(h.issuerBasis,'current_at_export');}
      return new Response(bytes,{headers});
    }catch(error){
      let latest=error;if(trusted&&!request.signal.aborted&&Date.now()<until)try{await admission();}catch(fresh){try{
        if(kind==='estimate'){
          // A bounded source failure is publishable only after current full
          // admission succeeds. Keep proven denials ahead of an outage.
          if(admissionDenial(fresh)||!admissionDenial(error))latest=fresh;
        }else{
          const status=fresh&&typeof fresh==='object'?Object.getOwnPropertyDescriptor(fresh,'status'):undefined;
          if((fresh instanceof ErpError||fresh instanceof AccountPublicError)&&status&&'value'in status&&[401,402,403,404,409].includes(status.value as number))latest=fresh;
        }
      }catch{if(kind==='estimate')latest=new ErpError('financial_export_unavailable',503);/* No private exception accessor escapes. */}}
      return failure(latest,kind,stage,deps.diagnostic);
    }
  }
  return Object.freeze({INVOICE:(request:Request,organizationId:string,invoiceId:string)=>run(request,organizationId,'invoice',invoiceId),REPORT:(request:Request,organizationId:string,reportType:string)=>run(request,organizationId,'report',reportType),ESTIMATE:(request:Request,organizationId:string,estimateId:string)=>run(request,organizationId,'estimate',estimateId)});
}
