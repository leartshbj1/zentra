// Future explicit campaign only. Same-worker private stores never become artifacts.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertCiAdmission,parsePrivateJson,runLiveAccountRecipe } from './verify-action-live-account-windows.mjs';
import { validatePublicReport as validateAccountReport } from './verify-action-live-account-ci-windows.mjs';
import { G4DiagnosticChannel,validatePublication,validateQuote } from './verify-action-live-g4-windows.mjs';
import { BASELINE,validateContinuationInput,validateHistoricalReview,validateContinuationReview,validateContinuationSourceProof,
  makeContinuationSource,publicEnvironment,verifiedHarness } from './verify-action-live-g4-continuation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PROFILE='2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/,SOURCE=/^[a-f0-9]{40}$/;
const PREFIX='account_cloud::live_a41_g4_tests::continuation::g5::';
export const G5_TESTS=Object.freeze(['fresh_source_writer_durable_before_process_stop','real_publication_commit_response_loss_before_process_stop',
  'real_confirmation_response_loss_before_local_ack_and_process_stop','recover_exact_confirmation_ack_and_receive_second_store',
  'reopen_both_stores_after_ack_without_new_preparation'].map(n=>PREFIX+n));
const EVENTS=Object.freeze(['writer-durable','commit-response-discarded','confirmation-response-discarded','ack-and-receive','g5-complete']);
const REVIEW_REASONS=Object.freeze(['missing_customer_name','ambiguous_customer','archived_customer','missing_quantity','ambiguous_quantity','unsupported_quantity',
  'missing_article','too_many_candidates','source_too_long','low_confidence','not_quote_request','invalid_decision','provider_unavailable']);
const REQUIRED=Object.freeze(['desktop/scripts/verify-action-live-g5-windows.mjs','desktop/scripts/verify-action-live-g5-windows.test.mjs',
  'desktop/scripts/verify-action-live-g4-continuation.mjs','desktop/src-tauri/src/account_cloud_action_engine_g5_support.rs',
  'desktop/src-tauri/src/company_collaboration_live_a41_g5_support.rs','desktop/src-tauri/src/account_cloud_live_a41_g5_tests.rs',
  'desktop/src-tauri/src/account_cloud_action_engine_continuation_support.rs','desktop/src-tauri/src/account_cloud_live_a41_g4_continuation_tests.rs',
  'desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs']);
const CODES=new Set(['g5_input_refused','g5_admission_refused','g5_baseline_refused','g5_selected_refused','g5_phase_refused','g5_new_source_needs_review',
  'g5_spawn_failed','g5_before_pipe','g5_deadline','g5_stdin_failed','g5_pipe_failed','g5_kill_refused','g5_native_result_refused',
  'g5_binary_changed','g5_validation_refused','g4_pipe_socket_error','g4_pipe_eof','g4_pipe_closed','g4_pipe_utf8_refused','g4_pipe_json_refused',
  'g4_pipe_bounds_refused','g4_pipe_read_timeout','g4_pipe_global_deadline','g4_pipe_transport_refused','g4_pipe_terminal_refused']);
export class G5Refusal extends Error{constructor(code){super(code);this.code=code;}}
const need=(v,c='g5_validation_refused')=>{if(!v)throw new G5Refusal(c);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const closed=(v,keys,code='g5_validation_refused')=>{need(plain(v)&&Reflect.ownKeys(v).length===keys.length&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),code);
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(v,key);need(d?.enumerable&&'value'in d,code);}};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=b=>createHash('sha256').update(b).digest('hex');
async function shaFile(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
const stringMatch=(v,re)=>typeof v==='string'&&re.test(v);
export function validateG5Pin(value){closed(value,['revision','snapshotId','archiveSha256'],'g5_baseline_refused');
  need(Number.isSafeInteger(value.revision)&&value.revision>=1&&value.revision<=Number.MAX_SAFE_INTEGER-1
    &&stringMatch(value.snapshotId,UUID)&&stringMatch(value.archiveSha256,SHA),'g5_baseline_refused');return {...value};}
const continuation=value=>({format:'zentra-a41-continuation-input-v1',account:value.account,sourceSha:value.sourceSha,campaignId:value.campaignId,
  workspaceId:value.workspaceId,connectionId:value.connectionId,apiHookToken:value.apiHookToken});
export function validateG5Input(value){closed(value,['format','account','sourceSha','campaignId','workspaceId','connectionId','apiHookToken','expectedBaseline'],'g5_input_refused');
  need(value.format==='zentra-a41-g5-input-v1','g5_input_refused');const checked=validateContinuationInput(continuation(value));
  return Object.freeze({...checked,format:value.format,expectedBaseline:Object.freeze(validateG5Pin(value.expectedBaseline))});}
export function assertG5Admission(env,platform=process.platform){assertCiAdmission(env,platform);
  need(env.ZENTRA_RUN_LIVE_G5_RECIPE==='true'&&!env.ZENTRA_RUN_LIVE_G4_RECIPE&&!env.ZENTRA_RUN_LIVE_G4_CONTINUATION,'g5_admission_refused');}
export function validateG5Baseline(value,input){closed(value,['event','campaignId','baseline','historicalReview','saved','consentRevisions','preexistingReviews'],'g5_baseline_refused');
  need(value.event==='g5-baseline'&&value.campaignId===input.campaignId,'g5_baseline_refused');
  const b=value.baseline;closed(b,['snapshotId','revision','archiveSha256','manifestSha256','sizeBytes','transport','receivedBoth','historicalWriterAckClaimed','historicalGatewayFactClaimed'],'g5_baseline_refused');
  need(b.snapshotId===input.expectedBaseline.snapshotId&&b.revision===input.expectedBaseline.revision&&b.archiveSha256===input.expectedBaseline.archiveSha256
    &&stringMatch(b.manifestSha256,SHA)&&Number.isSafeInteger(b.sizeBytes)&&b.sizeBytes>0&&b.sizeBytes<=536870912&&b.transport==='content-v1'
    &&b.receivedBoth===true&&b.historicalWriterAckClaimed===false&&b.historicalGatewayFactClaimed===false,'g5_baseline_refused');
  validateHistoricalReview(value.historicalReview);
  need(Array.isArray(value.preexistingReviews)&&value.preexistingReviews.length>=2&&value.preexistingReviews.length<=50,'g5_baseline_refused');
  for(const [index,item]of value.preexistingReviews.entries()){
    closed(item,['proposalId','sourceId','createdAt','disposition','reasons','requiresHumanValidation'],'g5_baseline_refused');
    need(stringMatch(item.proposalId,UUID)&&stringMatch(item.sourceId,UUID)&&Number.isSafeInteger(item.createdAt)&&item.createdAt>0&&item.createdAt<=253402300799
      &&item.disposition==='needs_review'&&item.requiresHumanValidation===true&&Array.isArray(item.reasons)&&item.reasons.length>=1&&item.reasons.length<=13
      &&new Set(item.reasons).size===item.reasons.length&&item.reasons.every(r=>REVIEW_REASONS.includes(r))
      &&!value.preexistingReviews.slice(0,index).some(prior=>prior.proposalId===item.proposalId||prior.sourceId===item.sourceId),'g5_baseline_refused');
  }
  need(value.preexistingReviews.some(item=>same(item,value.historicalReview)),'g5_baseline_refused');
  closed(value.saved,['quotes','receipts','resources','customer','article'],'g5_baseline_refused');
  need(['quotes','receipts'].every(k=>Number.isSafeInteger(value.saved[k])&&value.saved[k]>=0&&value.saved[k]<=1000000)
    &&stringMatch(value.saved.resources,SHA)&&['customer','article'].every(k=>stringMatch(value.saved[k],UUID))
    &&Array.isArray(value.consentRevisions)&&value.consentRevisions.length===2&&value.consentRevisions.every(v=>Number.isSafeInteger(v)&&v>=1&&v<=2147483647),'g5_baseline_refused');
  return value;
}
export function validateG5Selected(value,sourceId){closed(value,['sourceId','proposalId','fingerprint'],'g5_selected_refused');
  need(stringMatch(sourceId,UUID)&&value.sourceId===sourceId&&sourceId!==BASELINE.sourceId&&stringMatch(value.proposalId,UUID)
    &&value.proposalId!==BASELINE.proposalId&&stringMatch(value.fingerprint,SHA),'g5_selected_refused');return {...value};}
function publication(value,baseline){need(plain(value)&&['snapshotId','archiveSha256','manifestSha256','transport'].every(k=>typeof value[k]==='string'),'g5_phase_refused');
  const v=validatePublication(value);need(v.baseRevision===baseline.baseline.revision&&v.revision===v.baseRevision+1&&v.snapshotId!==baseline.baseline.snapshotId,'g5_phase_refused');return v;}
function quote(value,baseline,selected){need(plain(value)&&['sourceId','proposalId','reservationId','fingerprint','quoteId','customerId','articleId','receiptSha256','status'].every(k=>typeof value[k]==='string')
  &&Array.isArray(value.lineIds)&&value.lineIds.every(v=>typeof v==='string'),'g5_phase_refused');
  const v=validateQuote(value,{sourceId:selected.sourceId,customerId:baseline.saved.customer,articleId:baseline.saved.article});
  need(v.proposalId===selected.proposalId&&v.fingerprint===selected.fingerprint,'g5_phase_refused');return v;}
export function validateG5Phase(value,phase,state){need(Number.isInteger(phase)&&phase>=0&&phase<5&&value?.event===EVENTS[phase],'g5_phase_refused');
  if(phase===0){closed(value,['event','selected','saved','localAck'],'g5_phase_refused');need(value.localAck===false&&same(value.saved,state.baseline.saved),'g5_phase_refused');
    return {...value,selected:validateG5Selected(value.selected,state.sourceId)};}
  if(phase===1||phase===2){closed(value,['event','publication','httpStatus','localAck'],'g5_phase_refused');need(value.httpStatus===200&&value.localAck===false,'g5_phase_refused');
    const p=publication(value.publication,state.baseline);if(phase===2)need(same(p,state.publication),'g5_phase_refused');return {...value,publication:p};}
  if(phase===3){closed(value,['event','publication','quote','localAck','secondStoreExactCreation'],'g5_phase_refused');
    need(value.localAck===true&&value.secondStoreExactCreation===true,'g5_phase_refused');const p=publication(value.publication,state.baseline);need(same(p,state.publication),'g5_phase_refused');
    return {...value,publication:p,quote:quote(value.quote,state.baseline,state.selected)};}
  closed(value,['event','publication','quote','historicalReview','writerActivityCount','secondStoreActivityCount','bothReopenedInNewProcess',
    'historicalPreparationRequests','freshPreparationRequests','preexistingReviewCount','preexistingReviewProjectionPreserved','fullG5Passed','g6Passed','mailExecuted','schedulerExecuted'],'g5_phase_refused');
  need(value.writerActivityCount===1&&value.secondStoreActivityCount===0&&value.bothReopenedInNewProcess===true&&value.historicalPreparationRequests===0
    &&value.freshPreparationRequests===1&&value.preexistingReviewCount===state.baseline.preexistingReviews.length&&value.preexistingReviewProjectionPreserved===true
    &&['fullG5Passed','g6Passed','mailExecuted','schedulerExecuted'].every(k=>value[k]===false),'g5_phase_refused');
  const p=publication(value.publication,state.baseline),q=quote(value.quote,state.baseline,state.selected);
  need(same(p,state.publication)&&same(q,state.quote)&&same(validateHistoricalReview(value.historicalReview),validateHistoricalReview(state.baseline.historicalReview)),'g5_phase_refused');
  return {...value,publication:p,quote:q};
}
export function g5FailureCode(error){const v=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:null;return typeof v==='string'&&CODES.has(v)?v:'g5_validation_refused';}
export function validateG5Diagnostic(value){closed(value,['format','sourceSha','binarySha256','profileSha256','passed','phase','code','fullG5Passed','g6Passed']);
  need(value.format==='zentra-a41-g5-diagnostic-v1'&&stringMatch(value.sourceSha,SOURCE)&&stringMatch(value.binarySha256,SHA)&&value.profileSha256===PROFILE
    &&value.passed===false&&Number.isInteger(value.phase)&&value.phase>=0&&value.phase<5&&CODES.has(value.code)&&value.fullG5Passed===false&&value.g6Passed===false);
  need(Buffer.byteLength(JSON.stringify(value))<=4096);return value;}
export async function runG5Sequence(phasePort,state){
  const written=await phasePort(0,state);state.selected=written.selected;
  const committed=await phasePort(1,state);state.publication=committed.publication;
  await phasePort(2,state);
  const acknowledged=await phasePort(3,state);state.quote=acknowledged.quote;
  return phasePort(4,state);
}
export async function killAndReapAtCheckpoint({alreadyExited,kill,waitExit,finalize,assertTerminal}){
  need(!alreadyExited()&&kill(),'g5_kill_refused');
  const exit=await waitExit();need(exit.code!==0||exit.signal,'g5_kill_refused');
  await finalize();assertTerminal();
}
export function validateG5Report(value,source){closed(value,['format','sourceSha','binarySha256','profileSha256','coordinatorSha256','account','baseline','sourceLifecycle','complete',
  'passedBoundaries','killedAndReapedProcesses','reopenedNativeProcesses','freshPreparationRequests','historicalPreparationRequests',
  'commitTransport','otherPublicationTransport','realDecisionProviderDirectlyAttested','fullG5Passed','g6Passed','mailExecuted','schedulerExecuted','automaticCleanup']);
  need(value.format==='zentra-a41-g5-subset-report-v1'&&stringMatch(source,SOURCE)&&value.sourceSha===source&&value.profileSha256===PROFILE
    &&['binarySha256','coordinatorSha256'].every(k=>stringMatch(value[k],SHA))&&value.killedAndReapedProcesses===3&&value.reopenedNativeProcesses===4
    &&value.freshPreparationRequests===1&&value.historicalPreparationRequests===0
    &&value.commitTransport==='native_session_request_status_observed'&&value.otherPublicationTransport==='original_helper'
    &&['realDecisionProviderDirectlyAttested','fullG5Passed','g6Passed','mailExecuted','schedulerExecuted','automaticCleanup'].every(k=>value[k]===false)
    &&same(value.passedBoundaries,['writer_process_stop','committed_response_loss','confirmation_response_loss_before_local_ack']));
  const account=validateAccountReport(value.account,source);need(account.binarySha256===value.binarySha256&&account.profileSha256===PROFILE);
  const b=value.baseline;closed(b,['event','campaignId','baseline','historicalReview','saved','consentRevisions','preexistingReviews']);
  validateG5Baseline(b,{campaignId:b.campaignId,expectedBaseline:validateG5Pin({revision:b.baseline?.revision,snapshotId:b.baseline?.snapshotId,archiveSha256:b.baseline?.archiveSha256})});
  const lifecycle=validateContinuationSourceProof(value.sourceLifecycle,b.campaignId);
  const selected=validateG5Selected({sourceId:value.complete?.quote?.sourceId,proposalId:value.complete?.quote?.proposalId,fingerprint:value.complete?.quote?.fingerprint},lifecycle.sourceId);
  validateG5Phase(value.complete,4,{baseline:b,selected,publication:publication(value.complete.publication,b),quote:quote(value.complete.quote,b,selected)});
  need(Buffer.byteLength(JSON.stringify(value))<=65536);return value;
}

async function nativePhase(harness,input,retained,account,phase,state){
  const pipe=`\\\\.\\pipe\\zentra-a41-g5-${randomUUID()}`,challenge=randomBytes(32).toString('base64url'),server=net.createServer();
  let channel,child,accepted=false,done=false,timer,out='',err='',observedExit=false;
  let rejectConnection;const connected=new Promise((resolve,reject)=>{rejectConnection=reject;server.once('error',()=>reject(new G5Refusal('g5_pipe_failed')));
    server.on('connection',socket=>{if(accepted){socket.destroy();return;}accepted=true;channel=new G4DiagnosticChannel(socket);resolve(channel);});});connected.catch(()=>{});
  try{
    await new Promise((resolve,reject)=>{server.once('error',()=>reject(new G5Refusal('g5_pipe_failed')));server.listen(pipe,resolve);});
    need(await shaFile(harness.executable)===harness.sha256,'g5_binary_changed');
    child=spawn(harness.executable,[G5_TESTS[phase],'--exact','--ignored','--test-threads=1'],{cwd:ROOT,env:{...publicEnvironment(process.env),RUST_BACKTRACE:'0',
      ZENTRA_RUN_LIVE_G5_RECIPE:'true',ZENTRA_A41_G5_PIPE:pipe},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let rejectExit;const exited=new Promise((resolve,reject)=>{rejectExit=reject;child.once('error',()=>{const e=new G5Refusal('g5_spawn_failed');rejectConnection(e);reject(e);});
      child.once('exit',()=>{observedExit=true;if(!accepted)rejectConnection(new G5Refusal('g5_before_pipe'));});child.once('close',(code,signal)=>resolve({code,signal}));});exited.catch(()=>{});
    const stop=()=>{const e=new G5Refusal('g5_deadline');rejectConnection(e);rejectExit(e);channel?.fail('g4_pipe_global_deadline');child.kill();};
    timer=setTimeout(stop,600000);child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>1048576)stop();});child.stderr.on('data',b=>{err+=b;if(Buffer.byteLength(err)>1048576)stop();});
    child.stdin.on('error',()=>{rejectConnection(new G5Refusal('g5_stdin_failed'));channel?.fail('g4_pipe_stdin_error');child.kill();});child.stdin.end(JSON.stringify({challenge})+'\n');
    channel=await connected;const hello=await channel.read();closed(hello,['event','challenge']);need(hello.event==='hello'&&hello.challenge===challenge);
    channel.write({format:'zentra-a41-g5-private-v1',sitesServiceToken:input.account.sitesServiceToken,rootDir:retained.rootDir,installations:account.phases[1].installations,
      sourceSha:input.sourceSha,campaignId:input.campaignId,expectedBaseline:input.expectedBaseline,phase,selected:state.selected??null,saved:state.baseline?.saved??null,
      reviews:state.baseline?.preexistingReviews??null,consentRevisions:state.baseline?.consentRevisions??null});
    if(phase===0){state.baseline=validateG5Baseline(await channel.read(),input);
      const factory=makeContinuationSource({...continuation(input),account:{...input.account,browserCookieHeader:retained.browserCookieHeader}},
        {admit:()=>assertG5Admission({...process.env}),baselineValidator:b=>validateG5Baseline(b,input)});
      const source=await factory.provision(state.baseline);state.sourceId=source.sourceId;state.sourceLifecycle=factory.publicProof();channel.write({event:'source-ready',sourceId:state.sourceId});}
    const raw=await channel.read();if(raw?.event==='new-source-review'){validateContinuationReview(raw,state.sourceId);throw new G5Refusal('g5_new_source_needs_review');}
    const event=validateG5Phase(raw,phase,state);
    if(phase<3){await killAndReapAtCheckpoint({alreadyExited:()=>observedExit,kill:()=>child.kill(),waitExit:()=>exited,
      finalize:()=>channel.finalize(),assertTerminal:()=>channel.assertTerminal()});
      need(await shaFile(harness.executable)===harness.sha256,'g5_binary_changed');done=true;return event;}
    const exit=await exited;await channel.finalize();channel.assertTerminal();
    const escaped=G5_TESTS[phase].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    need(exit.code===0&&!exit.signal&&!err.trim()&&new RegExp(`^test ${escaped} \\.\\.\\. ok\\r?$`,'m').test(out)
      &&new RegExp(`^test result: ok\\. 1 passed; 0 failed; 0 ignored; 0 measured; ${harness.catalogueCount-1} filtered out; finished in [0-9.]+s\\r?$`,'m').test(out),'g5_native_result_refused');
    need(await shaFile(harness.executable)===harness.sha256,'g5_binary_changed');channel.assertTerminal();done=true;return event;
  }finally{clearTimeout(timer);channel?.close();if(!done&&child)child.kill();await new Promise(resolve=>server.close(resolve));}
}
export async function runLiveG5Recipe(raw){
  const input=validateG5Input(raw),env={...process.env};assertG5Admission(env);
  const harness=await verifiedHarness(input,env,{admit:assertG5Admission,requiredFiles:REQUIRED,requiredTests:G5_TESTS});let retained;
  const account=validateAccountReport(await runLiveAccountRecipe(input.account,{privateContinuationSink:v=>{retained=v;}}),input.sourceSha);
  need(retained&&path.win32.isAbsolute(retained.rootDir)&&account.binarySha256===harness.sha256,'g5_validation_refused');
  const state={};let phase=0;
  try{
    const complete=await runG5Sequence((index,current)=>{phase=index;return nativePhase(harness,input,retained,account,index,current);},state);
    return validateG5Report({format:'zentra-a41-g5-subset-report-v1',sourceSha:harness.source,binarySha256:harness.sha256,profileSha256:PROFILE,
      coordinatorSha256:await shaFile(fileURLToPath(import.meta.url)),account,baseline:state.baseline,sourceLifecycle:validateContinuationSourceProof(state.sourceLifecycle,input.campaignId),complete,
      passedBoundaries:['writer_process_stop','committed_response_loss','confirmation_response_loss_before_local_ack'],killedAndReapedProcesses:3,
      reopenedNativeProcesses:4,freshPreparationRequests:1,historicalPreparationRequests:0,
      commitTransport:'native_session_request_status_observed',otherPublicationTransport:'original_helper',realDecisionProviderDirectlyAttested:false,
      fullG5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false,automaticCleanup:false},input.sourceSha);
  }catch(error){const code=g5FailureCode(error),diagnostic=validateG5Diagnostic({format:'zentra-a41-g5-diagnostic-v1',sourceSha:harness.source,binarySha256:harness.sha256,
    profileSha256:PROFILE,passed:false,phase,code,fullG5Passed:false,g6Passed:false});
    fs.writeFileSync(path.join(ROOT,'desktop/artifacts/action-live-profile/native-g5-diagnostic.public.json'),JSON.stringify(diagnostic,null,2)+'\n',{flag:'wx'});throw new G5Refusal(code);}
}
export const DESCRIPTION=Object.freeze({format:'zentra-a41-g5-description-v1',inactiveByDefault:true,privateInputFormat:'zentra-a41-g5-input-v1',
  exactTests:G5_TESTS,requiredFlag:'ZENTRA_RUN_LIVE_G5_RECIPE=true',newCampaignOnly:true,usesCurrentBaselinePin:true,freshPreparationRequests:1,
  historicalPreparationRequests:0,realHttpBeforeDiscard:true,processStops:3,protectedStoresExported:false,fullG5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false});
async function main(){const args=process.argv.slice(2);if(args.length===0||args.length===1&&args[0]==='--describe'){process.stdout.write(JSON.stringify(DESCRIPTION)+'\n');return;}
  need(args.length===1&&args[0]==='--run','g5_admission_refused');assertG5Admission({...process.env});need(!process.stdin.isTTY,'g5_input_refused');const stat=fs.fstatSync(0);need(stat.isFIFO()||stat.isSocket()||(stat.mode&0o170000)===0o010000,'g5_input_refused');
  const chunks=[];let size=0;const timer=setTimeout(()=>process.stdin.destroy(new G5Refusal('g5_input_refused')),30000);
  try{for await(const b of process.stdin){size+=b.length;need(size<=32768,'g5_input_refused');chunks.push(b);}}finally{clearTimeout(timer);}
  const text=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks));const input=parsePrivateJson(text.endsWith('\n')?text.slice(0,-1):text);
  process.stdout.write(JSON.stringify(await runLiveG5Recipe(input))+'\n');}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{process.stderr.write(JSON.stringify({passed:false,code:g5FailureCode(e)})+'\n');process.exitCode=1;});
