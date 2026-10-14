// Distinct opt-in test-only continuation. No compile, seed, reset, connection
// rotation, consent/settings mutation, old preparation or release operation.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertCiAdmission, parsePrivateJson, runLiveAccountRecipe, validatePrivateInput } from './verify-action-live-account-windows.mjs';
import { G4DiagnosticChannel, validatePublication, validateQuote } from './verify-action-live-g4-windows.mjs';
import { requirePaidA41Workspace } from './live-g4-api-support-source.mjs';
import { validatePublicReport as validateAccountReport } from './verify-action-live-account-ci-windows.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const SITE='https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site';
const OWNER='1f0d9981-607b-4848-9374-587035cdfd89';
const ORG='org_trial_345a3d1f68056cf7e709d4af4fc229a4';
const PROFILE='2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/, SOURCE=/^[a-f0-9]{40}$/;
export const BASELINE=Object.freeze({revision:1,snapshotId:'5ba6a352-807e-4b7f-9bc7-e216477ef7f2',
  archiveSha256:'c782d6c38685b9bae3efebf32601f265dbaae35ab3a0e6829cf339ea6469f315',
  sourceId:'6876287b-2ad0-486a-85df-95610f2d2a6d',proposalId:'c668fb83-9262-4809-8724-af6638f813e5'});
export const CONTINUATION_TEST='account_cloud::live_a41_g4_tests::continuation::populated_head_new_source_across_two_new_native_stores';
export const CONTINUATION_STEPS=Object.freeze([
  ['continuation_admitted',0],['new_stores_authenticated',0],['baseline_received',0],['new_source_discovered',0],
  ['new_quote_confirmed',0],['second_store_received',1],['new_stores_reopened',0],
].map(([step,index])=>Object.freeze({step,index})));
const REQUIRED_FILES=Object.freeze(['desktop/scripts/verify-action-live-g4-continuation.mjs',
  'desktop/scripts/verify-action-live-g4-continuation.test.mjs','desktop/src-tauri/src/account_cloud_live_a41_g4_continuation_tests.rs',
  'desktop/src-tauri/src/account_cloud_action_engine_continuation_support.rs','desktop/src-tauri/src/account_cloud_live_a41_g4_tests.rs',
  'desktop/src-tauri/src/account_cloud_action_engine.rs']);
const FAILURE_CODES=new Set(['continuation_new_source_needs_review','continuation_source_network_failed','continuation_source_http_refused',
  'continuation_source_attempt_already_used','continuation_campaign_already_exists','continuation_existing_state_changed',
  'continuation_native_spawn_failed','continuation_native_before_pipe','continuation_native_deadline','continuation_stdin_failed',
  'continuation_pipe_server_failed','continuation_binary_changed','continuation_native_result_refused','continuation_source_pin_refused',
  'continuation_clean_source_required','continuation_fresh_compile_required','continuation_new_test_required_before_enrollment',
  'continuation_sources_must_be_tracked','continuation_validation_refused',
  'g4_pipe_socket_error','g4_pipe_eof','g4_pipe_closed','g4_pipe_utf8_refused','g4_pipe_json_refused','g4_pipe_bounds_refused',
  'g4_pipe_read_timeout','g4_pipe_global_deadline','g4_pipe_child_exit','g4_pipe_output_limit','g4_pipe_stdin_error',
  'g4_pipe_write_refused','g4_pipe_transport_refused','g4_pipe_terminal_refused']);
export class ContinuationRefusal extends Error { constructor(code){super(code);this.code=code;} }
const need=(value,code)=>{if(!value)throw new ContinuationRefusal(code);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const closed=(value,keys,code)=>{
  need(plain(value)&&Reflect.ownKeys(value).length===keys.length&&Object.keys(value).sort().join('|')===[...keys].sort().join('|'),code);
  for(const key of keys){const field=Object.getOwnPropertyDescriptor(value,key);need(field?.enumerable&&'value'in field,code);}
};
const sorted=value=>Array.isArray(value)?value.map(sorted):plain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(sorted(value))).digest('hex');
const equal=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
const workspaceId=value=>typeof value==='string'&&UUID.test(value.startsWith('support_')?value.slice(8):value);

export function validateContinuationInput(raw){
  closed(raw,['format','account','sourceSha','campaignId','workspaceId','connectionId','apiHookToken'],'continuation_input_refused');
  need(raw.format==='zentra-a41-continuation-input-v1'&&typeof raw.sourceSha==='string'&&SOURCE.test(raw.sourceSha)&&typeof raw.campaignId==='string'&&UUID.test(raw.campaignId)
    &&workspaceId(raw.workspaceId)&&typeof raw.connectionId==='string'&&UUID.test(raw.connectionId)&&typeof raw.apiHookToken==='string'
    &&/^zsup_[A-Za-z0-9_-]{43}$/.test(raw.apiHookToken),'continuation_scope_refused');
  return Object.freeze({...raw,account:Object.freeze(validatePrivateInput(raw.account))});
}
export function assertContinuationAdmission(env,platform=process.platform){
  assertCiAdmission(env,platform);
  need(env.ZENTRA_RUN_LIVE_G4_CONTINUATION==='true'&&(env.ZENTRA_RUN_LIVE_G4_RECIPE===undefined||env.ZENTRA_RUN_LIVE_G4_RECIPE==='false'),
    'continuation_opt_in_required');
}
export function validateBaselineReceipt(value){
  closed(value,['snapshotId','revision','archiveSha256','manifestSha256','sizeBytes','transport','receivedBoth',
    'historicalWriterAckClaimed','historicalGatewayFactClaimed'],'continuation_baseline_closed');
  need(value.snapshotId===BASELINE.snapshotId&&value.revision===1&&value.archiveSha256===BASELINE.archiveSha256&&typeof value.manifestSha256==='string'&&SHA.test(value.manifestSha256)
    &&Number.isSafeInteger(value.sizeBytes)&&value.sizeBytes>0&&value.sizeBytes<=536870912&&value.transport==='content-v1'
    &&value.receivedBoth===true&&value.historicalWriterAckClaimed===false&&value.historicalGatewayFactClaimed===false,'continuation_baseline_refused');
  return sorted(value);
}
export function validateHistoricalReview(value){
  closed(value,['proposalId','sourceId','createdAt','disposition','reasons','requiresHumanValidation'],'continuation_history_closed');
  need(value.proposalId===BASELINE.proposalId&&value.sourceId===BASELINE.sourceId&&Number.isSafeInteger(value.createdAt)&&value.createdAt>0&&value.createdAt<=253402300799
    &&value.disposition==='needs_review'&&equal(value.reasons,['low_confidence'])&&value.requiresHumanValidation===true,'continuation_history_refused');
  return sorted(value);
}
export function validateContinuationBaseline(event,campaign){
  closed(event,['event','campaignId','baseline','historicalReview','customerId','articleId','resourcesSha256','quoteBaselineCount','receiptBaselineCount','consentRevisions'],
    'continuation_baseline_event_closed');
  need(typeof campaign==='string'&&UUID.test(campaign)&&event.event==='baseline'&&event.campaignId===campaign
    &&['customerId','articleId'].every(k=>typeof event[k]==='string'&&UUID.test(event[k]))&&typeof event.resourcesSha256==='string'&&SHA.test(event.resourcesSha256)
    &&['quoteBaselineCount','receiptBaselineCount'].every(k=>Number.isSafeInteger(event[k])&&event[k]>=0&&event[k]<=1000000)
    &&Array.isArray(event.consentRevisions)&&event.consentRevisions.length===2&&event.consentRevisions.every(v=>Number.isSafeInteger(v)&&v>=1&&v<=2147483647),
    'continuation_baseline_event_refused');
  return {...event,baseline:validateBaselineReceipt(event.baseline),historicalReview:validateHistoricalReview(event.historicalReview)};
}
export function validateContinuationComplete(event,baseline,sourceId){
  closed(event,['event','profileSha256','organizationId','campaignId','baseline','historicalReview','canonicalPublication','quote','newStores','lostStoresRecovered',
    'historicalPreparationRequests','writerActivityCount','secondStoreActivityCount','secondStoreExactCreation','reopenedBoth','g5Executed','g6Executed','mailExecuted'],
    'continuation_complete_closed');
  need(event.event==='complete'&&event.profileSha256===PROFILE&&event.organizationId===ORG&&event.campaignId===baseline.campaignId
    &&event.newStores===true&&event.lostStoresRecovered===false&&event.historicalPreparationRequests===0&&event.writerActivityCount===1
    &&event.secondStoreActivityCount===0&&event.secondStoreExactCreation===true&&event.reopenedBoth===true
    &&event.g5Executed===false&&event.g6Executed===false&&event.mailExecuted===false,'continuation_complete_refused');
  need(equal(validateBaselineReceipt(event.baseline),baseline.baseline)&&equal(validateHistoricalReview(event.historicalReview),baseline.historicalReview),'continuation_baseline_changed');
  need(plain(event.canonicalPublication)&&['snapshotId','archiveSha256','manifestSha256','transport'].every(k=>typeof event.canonicalPublication[k]==='string')
    &&plain(event.quote)&&['sourceId','proposalId','reservationId','fingerprint','quoteId','customerId','articleId','receiptSha256','status'].every(k=>typeof event.quote[k]==='string')
    &&Array.isArray(event.quote.lineIds)&&event.quote.lineIds.every(v=>typeof v==='string'),'continuation_complete_scalars_required');
  const publication=validatePublication(event.canonicalPublication);
  need(publication.baseRevision===1&&publication.revision===2&&publication.snapshotId!==BASELINE.snapshotId&&publication.archiveSha256!==BASELINE.archiveSha256,
    'continuation_new_publication_required');
  const quote=validateQuote(event.quote,{sourceId,customerId:baseline.customerId,articleId:baseline.articleId});
  need(quote.proposalId!==BASELINE.proposalId,'continuation_old_proposal_refused');
  return sorted({...event,baseline:baseline.baseline,historicalReview:baseline.historicalReview,canonicalPublication:publication,quote});
}
export function validateContinuationReview(event,sourceId){
  closed(event,['event','historicalReviewPreserved','newSourceId','newProposalId','reasons','nominalG4Passed'],'continuation_review_closed');
  const reasons=['missing_customer_name','ambiguous_customer','archived_customer','missing_quantity','ambiguous_quantity','unsupported_quantity','missing_article',
    'too_many_candidates','source_too_long','low_confidence','not_quote_request','invalid_decision','provider_unavailable'];
  need(typeof sourceId==='string'&&UUID.test(sourceId)&&event.event==='new-source-review'&&event.historicalReviewPreserved===true&&event.newSourceId===sourceId&&typeof event.newProposalId==='string'&&UUID.test(event.newProposalId)
    &&event.newProposalId!==BASELINE.proposalId&&event.nominalG4Passed===false&&Array.isArray(event.reasons)&&event.reasons.length>=1
    &&event.reasons.length<=13&&new Set(event.reasons).size===event.reasons.length&&event.reasons.every(v=>reasons.includes(v)),'continuation_new_review_refused');
  return sorted(event);
}
export function continuationFailureCode(error){
  const code=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:null;
  return typeof code==='string'&&FAILURE_CODES.has(code)?code:'continuation_validation_refused';
}
export function validateContinuationDiagnostic(value){
  closed(value,['format','sourceSha','binarySha256','profileSha256','passed','nominalG4Passed','outcome','code','checkpointsSeen',
    'historicalReviewPreserved','g5Executed','g6Executed','mailExecuted'],'continuation_diagnostic_closed');
  need(value.format==='zentra-a41-continuation-diagnostic-v1'&&typeof value.sourceSha==='string'&&SOURCE.test(value.sourceSha)
    &&typeof value.binarySha256==='string'&&SHA.test(value.binarySha256)&&value.profileSha256===PROFILE&&value.passed===false&&value.nominalG4Passed===false
    &&FAILURE_CODES.has(value.code)&&Number.isSafeInteger(value.checkpointsSeen)&&value.checkpointsSeen>=0&&value.checkpointsSeen<=CONTINUATION_STEPS.length
    &&value.g5Executed===false&&value.g6Executed===false&&value.mailExecuted===false,'continuation_diagnostic_refused');
  if(value.outcome==='new_source_needs_review')need(value.code==='continuation_new_source_needs_review'&&value.historicalReviewPreserved===true,'continuation_diagnostic_refused');
  else need(value.outcome==='failed'&&value.code!=='continuation_new_source_needs_review'&&value.historicalReviewPreserved===null,'continuation_diagnostic_refused');
  need(Buffer.byteLength(JSON.stringify(value))<=4096,'continuation_diagnostic_refused');return sorted(value);
}

export function validateContinuationSourceProof(value,campaign){
  closed(value,['campaignId','workspaceId','connectionId','sourceId','sourceRevision','sourceEnvelopeSha256','historicalTicketSha256',
    'existingConnectionReused','historicalTicketPreserved','settingsAndDelegationPreserved','actualHumanQuoteClassification',
    'automaticSupportClassificationObserved','thirdPartyMailboxExecuted'],'continuation_source_proof_closed');
  need(typeof campaign==='string'&&UUID.test(campaign)&&value.campaignId===campaign&&workspaceId(value.workspaceId)
    &&['connectionId','sourceId'].every(k=>typeof value[k]==='string'&&UUID.test(value[k]))&&value.sourceId!==BASELINE.sourceId
    &&Number.isSafeInteger(value.sourceRevision)&&value.sourceRevision>=2&&value.sourceRevision<=2147483647
    &&['sourceEnvelopeSha256','historicalTicketSha256'].every(k=>typeof value[k]==='string'&&SHA.test(value[k]))
    &&['existingConnectionReused','historicalTicketPreserved','settingsAndDelegationPreserved','actualHumanQuoteClassification'].every(k=>value[k]===true)
    &&typeof value.automaticSupportClassificationObserved==='boolean'&&value.thirdPartyMailboxExecuted===false,'continuation_source_proof_refused');
  return sorted(value);
}
export function validatePublicContinuationReport(report,source){
  closed(report,['format','sourceSha','binarySha256','profileSha256','coordinatorSha256','exactTest','account','baselineEvent','complete','sourceLifecycle',
    'nominalG4Passed','realDecisionProviderDirectlyAttested','serverSourceDirectlyAttested','fullSchedulerTested','g5Executed','g6Executed','mailExecuted','automaticCleanup'],
    'continuation_report_closed');
  need(typeof source==='string'&&SOURCE.test(source)&&report.sourceSha===source&&report.format==='zentra-a41-native-continuation-report-v1'
    &&report.profileSha256===PROFILE&&report.exactTest===CONTINUATION_TEST&&report.nominalG4Passed===true
    &&['binarySha256','coordinatorSha256'].every(k=>typeof report[k]==='string'&&SHA.test(report[k]))
    &&['realDecisionProviderDirectlyAttested','serverSourceDirectlyAttested','fullSchedulerTested','g5Executed','g6Executed','mailExecuted','automaticCleanup'].every(k=>report[k]===false),
    'continuation_report_refused');
  const account=validateAccountReport(report.account,source);
  need(account.binarySha256===report.binarySha256&&account.profileSha256===PROFILE
    &&['coordinatorSha256','rustHarnessSourceSha256'].every(k=>typeof account[k]==='string')
    &&account.phases.every(phase=>phase.installations.every(installation=>Object.values(installation).every(value=>typeof value==='string'))),
    'continuation_account_binary_refused');
  const baselineEvent=validateContinuationBaseline(report.baselineEvent,report.baselineEvent?.campaignId);
  const sourceLifecycle=validateContinuationSourceProof(report.sourceLifecycle,baselineEvent.campaignId);
  const complete=validateContinuationComplete(report.complete,baselineEvent,sourceLifecycle.sourceId);
  need(Buffer.byteLength(JSON.stringify(report))<=65536,'continuation_report_bounds');
  return sorted({...report,account,baselineEvent,sourceLifecycle,complete});
}

class Cookies{
  #values=new Map();
  constructor(header){for(const pair of header.split('; ')){const at=pair.indexOf('=');need(at>0,'continuation_cookie_refused');
    const name=pair.slice(0,at),value=pair.slice(at+1);need(/^__Host-zentra_[a-z_]+$/.test(name)&&/^[\x21-\x7e]+$/.test(value)&&!/[;,]/.test(value)&&!this.#values.has(name),'continuation_cookie_refused');this.#values.set(name,value);}this.owner();}
  owner(){let owner;try{owner=decodeURIComponent(this.#values.get('__Host-zentra_session_owner')??'');}catch{owner='';}
    need(owner===OWNER&&this.#values.get('__Host-zentra_access')&&this.#values.get('__Host-zentra_refresh'),'continuation_cookie_owner_refused');}
  absorb(response){need(typeof response.headers.getSetCookie==='function','continuation_cookie_reader_required');
    for(const raw of response.headers.getSetCookie()){const parts=raw.split(';').map(v=>v.trim()),at=parts[0].indexOf('='),name=parts[0].slice(0,at),value=parts[0].slice(at+1);if(!name.startsWith('__Host-zentra_'))continue;
      const attrs=new Map(parts.slice(1).map(v=>{const split=v.indexOf('=');return split<0?[v.toLowerCase(),'']:[v.slice(0,split).toLowerCase(),v.slice(split+1)];}));
      need(at>0&&/^__Host-zentra_[a-z_]+$/.test(name)&&/^[\x21-\x7e]*$/.test(value)&&!/[;,]/.test(value)&&!attrs.has('domain')&&attrs.get('path')==='/'
        &&attrs.has('secure')&&attrs.has('httponly')&&attrs.get('samesite')?.toLowerCase()==='lax','continuation_response_cookie_refused');
      if(!value||attrs.has('max-age')&&Number(attrs.get('max-age'))<=0)this.#values.delete(name);else this.#values.set(name,value);
    }this.owner();}
  header(){return [...this.#values].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('; ');}
}
async function responseJson(response){
  need(response.body&&response.headers.get('content-type')?.split(';')[0].trim()==='application/json','continuation_json_required');
  const reader=response.body.getReader(),chunks=[];let count=0;
  try{for(;;){const part=await reader.read();if(part.done)break;count+=part.value.byteLength;need(count<=1048576,'continuation_response_bounds');chunks.push(Buffer.from(part.value));}
    try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new ContinuationRefusal('continuation_json_refused');}
  }finally{await reader.cancel().catch(()=>{});}
}
const stableState=state=>({workspace:state.workspace,gestion:state.gestion,automation:state.automation,connections:state.connections});
export function validateContinuationSupportState(state,input){
  requirePaidA41Workspace(state,input.workspaceId,true,false);
  need(state.hasMore===false&&Array.isArray(state.tickets)&&state.tickets.length<=60&&Array.isArray(state.connections),'continuation_support_page_required');
  const selected=state.connections.filter(c=>c.id===input.connectionId);
  need(selected.length===1&&selected[0].provider==='api'&&selected[0].active===true&&selected[0].hookUrl===`${SITE}/api/support/hooks/${input.connectionId}`,
    'continuation_existing_connection_required');
  const old=state.tickets.filter(t=>t.id===BASELINE.sourceId);
  need(old.length===1&&old[0].connectionId===input.connectionId&&Number.isSafeInteger(old[0].revision)&&old[0].revision>=1,'continuation_old_ticket_required');
  const external=`a41-continuation-${input.campaignId}`;
  need(!state.tickets.some(t=>t.externalId===external),'continuation_campaign_already_exists');
  return {oldTicket:old[0],stable:stableState(state),ticketIds:state.tickets.map(t=>t.id).sort()};
}

// Fetch injection exists only for pure source-lifecycle unit tests. The runner
// below always supplies the actual global fetch, never a private-input callback.
export function makeContinuationSource(raw,{fetcher=globalThis.fetch,admit=()=>assertContinuationAdmission({...process.env})}={}){
  const input=validateContinuationInput(raw);const jar=new Cookies(input.account.browserCookieHeader);let attempted=false,result;
  async function request(route,body,hook=false){
    const expectedHook=`/api/support/hooks/${input.connectionId}`;
    const url=new URL(route,SITE);need(url.origin===SITE&&!url.username&&!url.password&&!url.hash
      &&(url.pathname==='/api/auth/session'||url.pathname==='/api/support'||url.pathname===expectedHook),'continuation_route_refused');
    if(body&&url.pathname==='/api/support')need(body.action==='approve'&&body.workspaceId===input.workspaceId,'continuation_mutation_refused');
    if(body&&url.pathname!==expectedHook&&url.pathname!=='/api/support')throw new ContinuationRefusal('continuation_mutation_refused');
    const headers={accept:'application/json','oai-sites-authorization':`Bearer ${input.account.sitesServiceToken}`};
    if(hook)headers.authorization=`Bearer ${input.apiHookToken}`;else{headers.cookie=jar.header();headers.origin=SITE;}
    if(body)headers['content-type']='application/json';let response;
    try{response=await fetcher(url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});}
    catch{throw new ContinuationRefusal('continuation_source_network_failed');}
    need((hook?[200,202]:[200]).includes(response.status),'continuation_source_http_refused');
    if(!hook)jar.absorb(response);return {status:response.status,value:await responseJson(response)};
  }
  return {
    async provision(baseline){
      admit();need(!attempted,'continuation_source_attempt_already_used');attempted=true;
      validateContinuationBaseline(baseline,input.campaignId);
      const auth=(await request('/api/auth/session')).value;need(auth?.authenticated===true&&auth.user?.id===OWNER&&auth.user?.emailConfirmed===true,'continuation_owner_refused');
      const route=`/api/support?workspace=${input.workspaceId}`;
      const before=(await request(route)).value,prior=validateContinuationSupportState(before,input);
      const envelope={ticketId:`a41-continuation-${input.campaignId}`,subject:`Devis Radiateur A41 — ${input.campaignId}`,
        body:'Bonjour, pour Camille Recette A41, merci de préparer un devis pour 3 pièces de Radiateur A41, référence A41-RAD-100. Merci.',
        senderEmail:'camille-a41@example.invalid',senderName:'Camille Recette A41',version:`a41-continuation-${input.campaignId}`};
      const received=await request(`/api/support/hooks/${input.connectionId}`,envelope,true),ticket=received.value.ticket;
      need(UUID.test(ticket?.id??'')&&ticket.id!==BASELINE.sourceId&&ticket.connectionId===input.connectionId&&ticket.externalId===envelope.ticketId
        &&ticket.subject===envelope.subject&&ticket.body===envelope.body&&ticket.senderEmail===envelope.senderEmail&&Number.isSafeInteger(ticket.revision)&&ticket.revision>=1
        &&typeof ticket.automatic==='boolean','continuation_new_source_not_persisted');
      // Human Support classification is a normal owner operation. It is not an
      // Action Engine decision or a declaration of a ready quote.
      await request('/api/support',{action:'approve',workspaceId:input.workspaceId,ticketId:ticket.id,revision:ticket.revision,
        category:'quote',priority:'normal',destination:{teamId:'support'}});
      const after=(await request(`${route}&ticket=${ticket.id}`)).value;
      requirePaidA41Workspace(after,input.workspaceId,true,false);
      need(after.hasMore===false&&equal(stableState(after),prior.stable)&&Array.isArray(after.tickets)
        &&equal(after.tickets.filter(t=>t.id!==ticket.id).map(t=>t.id).sort(),prior.ticketIds)
        &&equal(after.tickets.find(t=>t.id===BASELINE.sourceId),prior.oldTicket),'continuation_existing_state_changed');
      const saved=after.focusedTicket;
      need(saved?.id===ticket.id&&saved.connectionId===input.connectionId&&saved.externalId===envelope.ticketId&&saved.revision===ticket.revision+1
        &&saved.state==='ready'&&saved.decision?.category==='quote'&&saved.decision?.manual===true,'continuation_human_classification_unconfirmed');
      result=Object.freeze({campaignId:input.campaignId,workspaceId:input.workspaceId,connectionId:input.connectionId,sourceId:ticket.id,
        sourceRevision:saved.revision,sourceEnvelopeSha256:digest(JSON.stringify(envelope)),historicalTicketSha256:digest(prior.oldTicket),
        existingConnectionReused:true,historicalTicketPreserved:true,settingsAndDelegationPreserved:true,actualHumanQuoteClassification:true,
        automaticSupportClassificationObserved:ticket.automatic,thirdPartyMailboxExecuted:false});
      return {sourceId:ticket.id};
    },
    publicProof(){need(result,'continuation_source_not_complete');return {...result};},
  };
}

function publicEnvironment(env){const result={};for(const name of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA',
  'HOMEDRIVE','HOMEPATH','COMSPEC','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','CIRCLECI','CIRCLE_BRANCH','CIRCLE_SHA1'])if(typeof env[name]==='string')result[name]=env[name];return result;}
async function shaFile(file){const h=createHash('sha256');for await(const bytes of fs.createReadStream(file))h.update(bytes);return h.digest('hex');}
async function verifiedHarness(input,env){
  assertContinuationAdmission(env);need(input.sourceSha===env.CIRCLE_SHA1,'continuation_source_pin_refused');
  const gitRead=args=>new Promise((resolve,reject)=>{const child=spawn('git',args,{cwd:ROOT,env:publicEnvironment(env),windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
    const fail=()=>{clearTimeout(timer);child.kill();reject(new ContinuationRefusal('continuation_git_refused'));};const timer=setTimeout(fail,30000);
    child.once('error',fail);child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>65536)fail();});child.stderr.on('data',b=>{err+=b;if(Buffer.byteLength(err)>65536)fail();});
    child.once('exit',code=>{clearTimeout(timer);if(code!==0||err.trim())reject(new ContinuationRefusal('continuation_git_refused'));else resolve(out.trim());});});
  need(await gitRead(['rev-parse','HEAD'])===input.sourceSha&&await gitRead(['status','--porcelain','--untracked-files=no'])==='','continuation_clean_source_required');
  need(equal((await gitRead(['ls-files','--error-unmatch','--',...REQUIRED_FILES])).split(/\r?\n/).sort(),[...REQUIRED_FILES].sort()),'continuation_sources_must_be_tracked');
  const folder=path.join(ROOT,'desktop/artifacts/action-live-profile');
  const read=name=>{const bytes=fs.readFileSync(path.join(folder,name));need(bytes.length<=1048576,'continuation_proof_bounds');try{return JSON.parse(bytes);}catch{throw new ContinuationRefusal('continuation_proof_refused');}};
  const profile=read('live-profile-verification-proof.json'),harness=read('windows-test-harness-proof.json');
  need(profile.source===input.sourceSha&&profile.circleSource===input.sourceSha&&profile.jobNumber===env.CIRCLE_BUILD_NUM&&profile.passed===true&&profile.runtimePassed===11&&profile.expectedTotal===11
    &&profile.compileInputManifestSha256===PROFILE&&profile.binarySha256===harness.binarySha256After&&harness.source===input.sourceSha&&harness.prepared===true&&harness.compileExit===0
    &&harness.compileNoRun===true&&SHA.test(profile.binarySha256??''),'continuation_fresh_compile_required');
  const listing=fs.readFileSync(path.join(folder,'windows-test-harness-list-after.txt'),'utf8');need(Buffer.byteLength(listing)<=1048576,'continuation_catalogue_bounds');
  const lines=listing.replace(/\r\n/g,'\n').trimEnd().split('\n'),summary=lines.pop()?.match(/^(\d+) tests, 0 benchmarks$/);
  const names=lines.filter(Boolean).map(line=>{const m=line.match(/^([A-Za-z_][A-Za-z0-9_:]*): test$/);need(m,'continuation_catalogue_refused');return m[1];});
  need(summary&&names.length===Number(summary[1])&&names.length===profile.catalogueCount&&new Set(names).size===names.length&&names.includes(CONTINUATION_TEST),'continuation_new_test_required_before_enrollment');
  need(typeof harness.executable==='string'&&path.isAbsolute(harness.executable),'continuation_executable_refused');
  const executable=fs.realpathSync(harness.executable),stat=fs.lstatSync(harness.executable),deps=fs.realpathSync(path.join(ROOT,'desktop/src-tauri/target/release/deps'));
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=536870912&&path.dirname(executable).toLowerCase()===deps.toLowerCase()
    &&/^helvichantier_lib-[a-f0-9]{16}\.exe$/.test(path.basename(executable))&&await shaFile(executable)===profile.binarySha256,'continuation_binary_refused');
  return {executable,sha256:profile.binarySha256,source:input.sourceSha,catalogueCount:names.length};
}
async function nativeContinuation(harness,input,retained,account,env){
  const pipeName=`\\\\.\\pipe\\zentra-a41-continuation-${randomUUID()}`,challenge=randomBytes(32).toString('base64url');
  const server=net.createServer();let channel,child,accepted=false,completed=false,timer,out='',err='',position=0,sourceId,baseline,review;
  let rejectConnection;const connected=new Promise((resolve,reject)=>{rejectConnection=reject;server.once('error',()=>reject(new ContinuationRefusal('continuation_pipe_server_failed')));
    server.on('connection',socket=>{if(accepted){socket.destroy();return;}accepted=true;channel=new G4DiagnosticChannel(socket);resolve(channel);});});connected.catch(()=>{});
  const next=async()=>{for(;;){const event=await channel.read();if(event?.event!=='checkpoint')return event;
    closed(event,['event','step','index'],'continuation_checkpoint_closed');const expected=CONTINUATION_STEPS[position++];need(expected&&event.step===expected.step&&event.index===expected.index,'continuation_checkpoint_order_refused');}};
  try{
    await new Promise((resolve,reject)=>{server.once('error',()=>reject(new ContinuationRefusal('continuation_pipe_server_failed')));server.listen(pipeName,resolve);});
    need(await shaFile(harness.executable)===harness.sha256,'continuation_binary_changed');
    child=spawn(harness.executable,[CONTINUATION_TEST,'--exact','--ignored','--test-threads=1'],{cwd:ROOT,env:{...publicEnvironment(env),RUST_BACKTRACE:'0',ZENTRA_RUN_LIVE_G4_CONTINUATION:'true',ZENTRA_A41_CONTINUATION_PIPE:pipeName},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let rejectExit;const exited=new Promise((resolve,reject)=>{rejectExit=reject;child.once('error',()=>{const failure=new ContinuationRefusal('continuation_native_spawn_failed');rejectConnection(failure);reject(failure);});
      child.once('exit',()=>{if(!accepted)rejectConnection(new ContinuationRefusal('continuation_native_before_pipe'));});
      // close follows stdout/stderr drainage; named-pipe EOF is checked separately.
      child.once('close',(code,signal)=>resolve({code,signal}));});exited.catch(()=>{});
    const stop=()=>{const e=new ContinuationRefusal('continuation_native_deadline');rejectConnection(e);rejectExit(e);channel?.fail('g4_pipe_global_deadline');child.kill();};
    timer=setTimeout(stop,600000);child.stdout.on('data',bytes=>{out+=bytes;if(Buffer.byteLength(out)>1048576)stop();});child.stderr.on('data',bytes=>{err+=bytes;if(Buffer.byteLength(err)>1048576)stop();});
    child.stdin.on('error',()=>{rejectConnection(new ContinuationRefusal('continuation_stdin_failed'));channel?.fail('g4_pipe_stdin_error');child.kill();});child.stdin.end(JSON.stringify({challenge})+'\n');
    channel=await connected;const hello=await channel.read();closed(hello,['event','challenge'],'continuation_hello_closed');need(hello.event==='hello'&&hello.challenge===challenge,'continuation_challenge_refused');
    channel.write({format:'zentra-a41-continuation-private-v1',sitesServiceToken:input.account.sitesServiceToken,rootDir:retained.rootDir,
      installations:account.phases[1].installations,sourceSha:input.sourceSha,campaignId:input.campaignId});
    baseline=validateContinuationBaseline(await next(),input.campaignId);need(position===3,'continuation_baseline_steps_missing');
    const source=makeContinuationSource({...input,account:{...input.account,browserCookieHeader:retained.browserCookieHeader}});
    const selected=await source.provision(baseline);sourceId=selected.sourceId;channel.write({event:'source-ready',sourceId});
    const event=await next();
    if(event?.event==='new-source-review'){review=validateContinuationReview(event,sourceId);throw new ContinuationRefusal('continuation_new_source_needs_review');}
    const complete=validateContinuationComplete(event,baseline,sourceId);need(position===CONTINUATION_STEPS.length,'continuation_steps_missing');
    const exit=await exited;await channel.finalize();const name=CONTINUATION_TEST.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    need(exit.code===0&&!exit.signal&&!err.trim()&&new RegExp(`^test ${name} \\.\\.\\. ok\\r?$`,'m').test(out)
      &&new RegExp(`^test result: ok\\. 1 passed; 0 failed; 0 ignored; 0 measured; ${harness.catalogueCount-1} filtered out; finished in [0-9.]+s\\r?$`,'m').test(out)
      &&await shaFile(harness.executable)===harness.sha256,'continuation_native_result_refused');channel.assertTerminal();completed=true;
    return {baselineEvent:baseline,complete,sourceLifecycle:source.publicProof()};
  }catch(error){
    const code=review?'continuation_new_source_needs_review':continuationFailureCode(error);
    const receipt=validateContinuationDiagnostic({format:'zentra-a41-continuation-diagnostic-v1',sourceSha:harness.source,binarySha256:harness.sha256,profileSha256:PROFILE,
      passed:false,nominalG4Passed:false,outcome:review?'new_source_needs_review':'failed',code,checkpointsSeen:Math.min(position,CONTINUATION_STEPS.length),
      historicalReviewPreserved:review?.historicalReviewPreserved??null,g5Executed:false,g6Executed:false,mailExecuted:false});
    fs.writeFileSync(path.join(ROOT,'desktop/artifacts/action-live-profile/native-continuation-diagnostic.public.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    throw new ContinuationRefusal(code);
  }finally{clearTimeout(timer);channel?.close();if(!completed&&child)child.kill();await new Promise(resolve=>server.close(resolve));}
}
export async function runLiveG4Continuation(raw){
  const input=validateContinuationInput(raw),env={...process.env};assertContinuationAdmission(env);
  const harness=await verifiedHarness(input,env);let retained;
  const account=await runLiveAccountRecipe(input.account,{privateContinuationSink:value=>{retained=value;}});
  need(retained&&path.win32.isAbsolute(retained.rootDir)&&account.source===harness.source&&account.binarySha256===harness.sha256
    &&account.protectedStateReopened===true&&account.sameExecutableBothPhases===true&&account.phases.length===2,'continuation_new_accounts_not_correlated');
  const result=await nativeContinuation(harness,input,retained,account,env);
  return sorted({format:'zentra-a41-native-continuation-report-v1',sourceSha:harness.source,binarySha256:harness.sha256,profileSha256:PROFILE,
    coordinatorSha256:await shaFile(fileURLToPath(import.meta.url)),exactTest:CONTINUATION_TEST,account,...result,
    nominalG4Passed:true,realDecisionProviderDirectlyAttested:false,serverSourceDirectlyAttested:false,fullSchedulerTested:false,g5Executed:false,g6Executed:false,mailExecuted:false,automaticCleanup:false});
}
export const DESCRIPTION=Object.freeze({format:'zentra-a41-continuation-description-v1',inactiveByDefault:true,baseline:BASELINE,profileSha256:PROFILE,
  exactTest:CONTINUATION_TEST,requiredFlag:'ZENTRA_RUN_LIVE_G4_CONTINUATION=true',privateInputFormat:'zentra-a41-continuation-input-v1',
  inputKeys:['format','account','sourceSha','campaignId','workspaceId','connectionId','apiHookToken'],rotatesToken:false,createsConnection:false,
  changesConsent:false,resetsHead:false,replaysHistoricalPreparation:false,compilesNative:false,g5Executed:false,g6Executed:false,mailExecuted:false});
async function main(){
  const args=process.argv.slice(2);if(args.length===0||args.length===1&&args[0]==='--describe'){process.stdout.write(JSON.stringify(DESCRIPTION)+'\n');return;}
  need(args.length===1&&args[0]==='--run','continuation_explicit_run_required');assertContinuationAdmission({...process.env});
  need(!process.stdin.isTTY,'continuation_private_stdin_required');const stat=fs.fstatSync(0);need(stat.isFIFO()||stat.isSocket()||(stat.mode&0o170000)===0o010000,'continuation_private_stdin_required');
  let size=0;const chunks=[],timer=setTimeout(()=>process.stdin.destroy(new ContinuationRefusal('continuation_input_deadline')),30000);
  try{for await(const bytes of process.stdin){size+=bytes.length;need(size<=32768,'continuation_input_bounds');chunks.push(bytes);}}finally{clearTimeout(timer);}
  const text=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks));const raw=parsePrivateJson(text.endsWith('\n')?text.slice(0,-1):text);
  process.stdout.write(JSON.stringify(await runLiveG4Continuation(raw))+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  process.stderr.write(JSON.stringify({passed:false,code:continuationFailureCode(error)})+'\n');process.exitCode=1;
});
