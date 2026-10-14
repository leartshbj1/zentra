// Private CI recipe only. Actual native handlers; no distributed gate activation.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertCiAdmission,parsePrivateJson,runLiveAccountRecipe} from './verify-action-live-account-windows.mjs';
import {validatePublicReport as validateAccountReport} from './verify-action-live-account-ci-windows.mjs';
import {G4DiagnosticChannel,validatePublication,validateQuote} from './verify-action-live-g4-windows.mjs';
import {validateG5Input,validateG5Baseline,validateG5Selected} from './verify-action-live-g5-windows.mjs';
import {makeContinuationSource,publicEnvironment,verifiedHarness,validateContinuationReview,validateContinuationSourceProof} from './verify-action-live-g4-continuation.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PROFILE='2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf',SHA=/^[a-f0-9]{64}$/,SOURCE=/^[a-f0-9]{40}$/;
export const FLAG='ZENTRA_RUN_LIVE_PRODUCT_FRONTDOOR_RECIPE';
export const BASELINE_PIN=Object.freeze({revision:2,snapshotId:'5da31610-80c6-4b34-ba76-bbb7d555ee79',archiveSha256:'43c43667109f82f9eda395de658eaa5049f30aecd4eb9ffd240f34103afb7236'});
export const EXACT_TEST='account_cloud::live_a41_g4_tests::continuation::g5::product_frontdoor::actual_six_handlers_process_one_fresh_source_on_current_head';
export const JSON_TEST='account_cloud::action_engine::supervisor::live_frontdoor::webview_json_cannot_supply_a_native_test_grant';
export const REQUIRED_FILES=Object.freeze(['desktop/scripts/verify-action-live-product-frontdoor.mjs','desktop/scripts/verify-action-live-product-frontdoor.test.mjs',
  'desktop/scripts/verify-action-live-product-frontdoor-ci.test.mjs','desktop/scripts/verify-action-live-g4-continuation.mjs',
  'desktop/src-tauri/src/account_cloud_quote_autopilot.rs','desktop/src-tauri/src/account_cloud_quote_autopilot_tests.rs',
  'desktop/src-tauri/src/account_cloud_quote_autopilot_live_frontdoor.rs','desktop/src-tauri/src/account_cloud_live_a41_product_frontdoor_tests.rs',
  'desktop/src-tauri/src/account_cloud_live_a41_g5_tests.rs','desktop/src-tauri/src/account_cloud_live_a41_g4_continuation_tests.rs',
  'desktop/src-tauri/src/account_cloud_action_engine.rs','desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs']);
export const OFF_TESTS=Object.freeze(['product_gate_is_closed_before_context_or_transport','ipc_origin_requires_both_exact_local_generations',
  'retained_round_rejects_session_nonce_reference_and_role_changes','physical_singleflight_survives_dropped_ipc_waiter_and_allows_consent_withdrawal',
  'review_and_recovery_summaries_are_distinct_from_confirmed_activity','consent_cas_and_read_dtos_refuse_extra_fields_versions_and_revision_overflow',
  'review_pages_are_bounded_same_company_and_never_expose_decisions','server_failures_map_to_closed_codes_without_response_text',
  'product_routes_are_fixed_first_party_https_without_sites_credentials'].map(n=>'account_cloud::action_engine::supervisor::tests::'+n));
const CODES=new Set(['frontdoor_input_refused','frontdoor_admission_refused','frontdoor_proof_refused','frontdoor_baseline_refused','frontdoor_complete_refused',
  'frontdoor_spawn_failed','frontdoor_before_pipe','frontdoor_deadline','frontdoor_pipe_failed','frontdoor_stdin_failed','frontdoor_binary_changed',
  'frontdoor_native_result_refused','frontdoor_new_source_needs_review','frontdoor_validation_refused','frontdoor_tick_forbidden','frontdoor_tick_conflict',
  'frontdoor_tick_context_changed','frontdoor_tick_busy','frontdoor_tick_rate_limited','frontdoor_tick_quota_exhausted','frontdoor_tick_service_unavailable']);
class Refusal extends Error{constructor(code){super(code);this.code=code;}}
const need=(ok,code='frontdoor_validation_refused')=>{if(!ok)throw new Refusal(code);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const closed=(value,keys,code='frontdoor_validation_refused')=>{need(plain(value)&&Reflect.ownKeys(value).length===keys.length,code);
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);need(d?.enumerable&&'value'in d,code);}};
const match=(v,re)=>typeof v==='string'&&re.test(v),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hash=b=>createHash('sha256').update(b).digest('hex');
async function hashFile(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
const asG5=input=>({...input,format:'zentra-a41-g5-input-v1'});
const asContinuation=input=>({format:'zentra-a41-continuation-input-v1',account:input.account,sourceSha:input.sourceSha,campaignId:input.campaignId,
  workspaceId:input.workspaceId,connectionId:input.connectionId,apiHookToken:input.apiHookToken});
export function validateFrontdoorInput(raw){closed(raw,['format','account','sourceSha','campaignId','workspaceId','connectionId','apiHookToken','expectedBaseline'],'frontdoor_input_refused');
  need(raw.format==='zentra-a41-product-frontdoor-input-v1','frontdoor_input_refused');const value=validateG5Input(asG5(raw));
  need(Object.keys(BASELINE_PIN).every(key=>value.expectedBaseline[key]===BASELINE_PIN[key]),'frontdoor_baseline_refused');return Object.freeze({...value,format:raw.format});}
function noOtherRecipe(env){need(!env.ZENTRA_RUN_LIVE_G4_RECIPE&&!env.ZENTRA_RUN_LIVE_G4_CONTINUATION&&!env.ZENTRA_RUN_LIVE_G5_RECIPE,'frontdoor_admission_refused');}
export function assertFrontdoorPreflight(env,platform=process.platform){assertCiAdmission(env,platform);noOtherRecipe(env);need(!env[FLAG],'frontdoor_admission_refused');}
export function assertFrontdoorAdmission(env,platform=process.platform){assertCiAdmission(env,platform);noOtherRecipe(env);need(env[FLAG]==='true','frontdoor_admission_refused');}
export function validateFrontdoorBaseline(raw,input){closed(raw,['event','campaignId','baseline','historicalReview','saved','consentRevisions','preexistingReviews'],'frontdoor_baseline_refused');
  need(raw.event==='frontdoor-baseline','frontdoor_baseline_refused');const value=validateG5Baseline({...raw,event:'g5-baseline'},asG5(input));
  need(value.preexistingReviews.length<=19&&value.saved.quotes>=1&&value.saved.receipts>=1,'frontdoor_baseline_refused');return {...value,event:raw.event};}
export function validateOffPolicyProof(raw,harness){closed(raw,['format','source','binarySha256','profileSha256','selectedNames','expectedTotal','runtimePassed',
  'nativeExecutionAttempted','passed','opensProduct','businessJourneyExecuted','releasePublished','suiteExecutions'],'frontdoor_proof_refused');
  need(raw.format==='zentra-autopilot-product-native-tests-v1'&&raw.source===harness.source&&raw.binarySha256===harness.sha256&&raw.profileSha256===PROFILE
    &&raw.expectedTotal===9&&raw.runtimePassed===9&&raw.nativeExecutionAttempted===true&&raw.passed===true&&raw.opensProduct===false
    &&raw.businessJourneyExecuted===false&&raw.releasePublished===false&&same(raw.selectedNames,OFF_TESTS)&&Array.isArray(raw.suiteExecutions)&&raw.suiteExecutions.length===9,'frontdoor_proof_refused');
  for(const [i,v]of raw.suiteExecutions.entries()){closed(v,['filter','selectedNames','extraArguments','nativeArguments','contextMode','exit','durationMs','passed','failed','ignored','stdout','stderr'],'frontdoor_proof_refused');
    need(v.filter===OFF_TESTS[i]&&v.selectedNames===1&&same(v.extraArguments,['--exact'])&&same(v.nativeArguments,[OFF_TESTS[i],'--test-threads=1','--exact'])
      &&v.contextMode==='diagnostics-verification'&&v.exit===0&&v.passed===1&&v.failed===0&&v.ignored===0&&Number.isFinite(v.durationMs)&&v.durationMs>=0&&v.durationMs<=600000
      &&v.stdout===`windows-test-suite-${String(i+12).padStart(2,'0')}.log`&&v.stderr===`windows-test-suite-${String(i+12).padStart(2,'0')}-errors.log`,'frontdoor_proof_refused');}
  return raw;
}
export function validateFrontdoorRegression(raw,source,binary){closed(raw,['format','sourceSha','binarySha256','profileSha256','offPolicyProofSha256','offPolicyPassed','jsonInjectionPassed','exactJsonTest','nativeExecuted','productGateOpened'],'frontdoor_proof_refused');
  need(raw.format==='zentra-a41-product-frontdoor-preflight-v1'&&raw.sourceSha===source&&raw.binarySha256===binary&&raw.profileSha256===PROFILE&&match(raw.offPolicyProofSha256,SHA)
    &&raw.offPolicyPassed===9&&raw.jsonInjectionPassed===1&&raw.exactJsonTest===JSON_TEST&&raw.nativeExecuted===true&&raw.productGateOpened===false,'frontdoor_proof_refused');return raw;}
export function validateFrontdoorComplete(raw,baseline,sourceId){closed(raw,['event','campaignId','publication','quote','actualHandlers','ticks','confirmed','historicalReviewCount','historicalReviewProjectionPreserved',
  'consentCas','consentRevisionsUnchanged','activityDelta','localWriterAck','secondStoreExactCreation','bothStoresReopened','separateBusinessProcesses','webviewInvocationProved','distributedProductGateOpened',
  'successfulConsentWriteProved','realDecisionProviderDirectlyAttested','g5Passed','g6Passed','mailExecuted','schedulerExecuted'],'frontdoor_complete_refused');
  need(raw.event==='frontdoor-complete'&&raw.campaignId===baseline.campaignId&&raw.actualHandlers===6&&raw.ticks===1&&raw.confirmed===1&&raw.activityDelta===1
    &&raw.historicalReviewCount===baseline.preexistingReviews.length&&raw.historicalReviewProjectionPreserved===true&&raw.consentCas==='stale_conflict'&&raw.consentRevisionsUnchanged===true
    &&raw.localWriterAck===true&&raw.secondStoreExactCreation===true&&raw.bothStoresReopened===true
    &&['separateBusinessProcesses','webviewInvocationProved','distributedProductGateOpened','successfulConsentWriteProved','realDecisionProviderDirectlyAttested','g5Passed','g6Passed','mailExecuted','schedulerExecuted'].every(k=>raw[k]===false),'frontdoor_complete_refused');
  const publication=validatePublication(raw.publication);need(publication.baseRevision===2&&publication.revision===3&&publication.snapshotId!==BASELINE_PIN.snapshotId,'frontdoor_complete_refused');
  need(plain(raw.quote)&&['sourceId','proposalId','reservationId','fingerprint','quoteId','customerId','articleId','receiptSha256','status'].every(k=>typeof raw.quote[k]==='string')
    &&Array.isArray(raw.quote.lineIds)&&raw.quote.lineIds.every(k=>typeof k==='string'),'frontdoor_complete_refused');
  const quote=validateQuote(raw.quote,{sourceId,customerId:baseline.saved.customer,articleId:baseline.saved.article});validateG5Selected({sourceId:quote.sourceId,proposalId:quote.proposalId,fingerprint:quote.fingerprint},sourceId);
  need(!baseline.preexistingReviews.some(v=>v.sourceId===quote.sourceId||v.proposalId===quote.proposalId),'frontdoor_complete_refused');return {...raw,publication,quote};
}
export function validateFrontdoorReport(raw,source){closed(raw,['format','sourceSha','binarySha256','profileSha256','coordinatorSha256','exactTest','preflight','account','baseline','sourceLifecycle','complete',
  'nativeTestAdmission','webviewInvocationProved','distributedProductGateOpened','successfulConsentWriteProved','realDecisionProviderDirectlyAttested','g5Passed','g6Passed','mailExecuted','schedulerExecuted','automaticCleanup']);
  need(raw.format==='zentra-a41-product-frontdoor-report-v1'&&match(source,SOURCE)&&raw.sourceSha===source&&raw.profileSha256===PROFILE&&match(raw.binarySha256,SHA)&&match(raw.coordinatorSha256,SHA)
    &&raw.exactTest===EXACT_TEST&&raw.nativeTestAdmission===true&&['webviewInvocationProved','distributedProductGateOpened','successfulConsentWriteProved','realDecisionProviderDirectlyAttested','g5Passed','g6Passed','mailExecuted','schedulerExecuted','automaticCleanup'].every(k=>raw[k]===false));
  validateFrontdoorRegression(raw.preflight,source,raw.binarySha256);const account=validateAccountReport(raw.account,source);need(account.binarySha256===raw.binarySha256);
  const baseline=validateFrontdoorBaseline(raw.baseline,{campaignId:raw.baseline?.campaignId,expectedBaseline:BASELINE_PIN});
  const lifecycle=validateContinuationSourceProof(raw.sourceLifecycle,baseline.campaignId);validateFrontdoorComplete(raw.complete,baseline,lifecycle.sourceId);
  need(Buffer.byteLength(JSON.stringify(raw))<=65536);return raw;
}
export function frontdoorFailureCode(error){try{const code=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:null;return typeof code==='string'&&CODES.has(code)?code:'frontdoor_validation_refused';}catch{return 'frontdoor_validation_refused';}}
function nativeSuccess(out,err,exit,name,harness){const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');need(exit.code===0&&!exit.signal&&!err.trim()
  &&new RegExp(`^test ${escaped} \\.\\.\\. ok\\r?$`,'m').test(out)&&new RegExp(`^test result: ok\\. 1 passed; 0 failed; 0 ignored; 0 measured; ${harness.catalogueCount-1} filtered out; finished in [0-9.]+s\\r?$`,'m').test(out),'frontdoor_native_result_refused');}
export async function runFrontdoorInjectionRegression(raw){const input=validateFrontdoorInput(raw),env={...process.env};assertFrontdoorPreflight(env);
  const harness=await verifiedHarness(input,env,{admit:assertFrontdoorPreflight,requiredFiles:REQUIRED_FILES,requiredTests:[JSON_TEST,EXACT_TEST]});
  const bytes=fs.readFileSync(path.join(ROOT,'desktop/artifacts/action-live-profile/autopilot-product-native-proof.json'));need(bytes.length<=1048576,'frontdoor_proof_refused');
  let proof;try{proof=JSON.parse(bytes);}catch{throw new Refusal('frontdoor_proof_refused');}validateOffPolicyProof(proof,harness);
  let out='',err='';const exit=await new Promise((resolve,reject)=>{const child=spawn(harness.executable,[JSON_TEST,'--exact','--test-threads=1'],{cwd:ROOT,env:{...publicEnvironment(env),RUST_BACKTRACE:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{child.kill();reject(new Refusal('frontdoor_deadline'));},60000);child.once('error',()=>{clearTimeout(timer);reject(new Refusal('frontdoor_spawn_failed'));});
    child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>1048576){child.kill();reject(new Refusal('frontdoor_native_result_refused'));}});
    child.stderr.on('data',b=>{err+=b;if(Buffer.byteLength(err)>1048576){child.kill();reject(new Refusal('frontdoor_native_result_refused'));}});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  nativeSuccess(out,err,exit,JSON_TEST,harness);need(await hashFile(harness.executable)===harness.sha256,'frontdoor_binary_changed');
  const result=validateFrontdoorRegression({format:'zentra-a41-product-frontdoor-preflight-v1',sourceSha:harness.source,binarySha256:harness.sha256,profileSha256:PROFILE,
    offPolicyProofSha256:hash(bytes),offPolicyPassed:9,jsonInjectionPassed:1,exactJsonTest:JSON_TEST,nativeExecuted:true,productGateOpened:false},harness.source,harness.sha256);
  fs.writeFileSync(path.join(ROOT,'desktop/artifacts/action-live-profile/product-frontdoor-preflight.public.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
function childEnvironment(env,pipe){return {...publicEnvironment(env),RUST_BACKTRACE:'0',OS:'Windows_NT',CIRCLE_JOB:'windows-action-live-account-tests',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',
  ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',
  [FLAG]:'true',ZENTRA_A41_PRODUCT_FRONTDOOR_PIPE:pipe};}
async function nativeFrontdoor(harness,input,retained,account){const pipe=`\\\\.\\pipe\\zentra-a41-product-frontdoor-${randomUUID()}`,challenge=randomBytes(32).toString('base64url'),server=net.createServer();
  let channel,child,accepted=false,done=false,timer,out='',err='',baseline,sourceLifecycle,sourceId;
  let rejectConnection;const connected=new Promise((resolve,reject)=>{rejectConnection=reject;server.once('error',()=>reject(new Refusal('frontdoor_pipe_failed')));
    server.on('connection',socket=>{if(accepted){socket.destroy();return;}accepted=true;channel=new G4DiagnosticChannel(socket);resolve(channel);});});connected.catch(()=>{});
  try{await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Refusal('frontdoor_pipe_failed')));server.listen(pipe,resolve);});
    need(await hashFile(harness.executable)===harness.sha256,'frontdoor_binary_changed');
    child=spawn(harness.executable,[EXACT_TEST,'--exact','--ignored','--test-threads=1'],{cwd:ROOT,env:childEnvironment(process.env,pipe),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let rejectExit;const exited=new Promise((resolve,reject)=>{rejectExit=reject;child.once('error',()=>{const e=new Refusal('frontdoor_spawn_failed');rejectConnection(e);reject(e);});
      child.once('exit',()=>{if(!accepted)rejectConnection(new Refusal('frontdoor_before_pipe'));});child.once('close',(code,signal)=>resolve({code,signal}));});exited.catch(()=>{});
    const stop=()=>{const e=new Refusal('frontdoor_deadline');rejectConnection(e);rejectExit(e);channel?.fail('g4_pipe_global_deadline');child.kill();};timer=setTimeout(stop,600000);
    child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>1048576)stop();});child.stderr.on('data',b=>{err+=b;if(Buffer.byteLength(err)>1048576)stop();});
    child.stdin.on('error',()=>{rejectConnection(new Refusal('frontdoor_stdin_failed'));channel?.fail('g4_pipe_stdin_error');child.kill();});child.stdin.end(JSON.stringify({challenge})+'\n');
    channel=await connected;const hello=await channel.read();closed(hello,['event','challenge']);need(hello.event==='hello'&&hello.challenge===challenge);
    channel.write({format:'zentra-a41-product-frontdoor-private-v1',sitesServiceToken:input.account.sitesServiceToken,rootDir:retained.rootDir,installations:account.phases[1].installations,
      sourceSha:input.sourceSha,campaignId:input.campaignId,expectedBaseline:input.expectedBaseline});
    baseline=validateFrontdoorBaseline(await channel.read(),input);
    const factory=makeContinuationSource({...asContinuation(input),account:{...input.account,browserCookieHeader:retained.browserCookieHeader}},
      {admit:()=>assertFrontdoorAdmission({...process.env}),baselineValidator:b=>validateFrontdoorBaseline(b,input),sourceTemplate:'en-g5-v1'});
    const selected=await factory.provision(baseline);sourceId=selected.sourceId;sourceLifecycle=factory.publicProof();channel.write({event:'source-ready',sourceId});
    const raw=await channel.read();if(raw?.event==='new-source-review'){validateContinuationReview(raw,sourceId);throw new Refusal('frontdoor_new_source_needs_review');}
    if(raw?.event==='frontdoor-refused'){closed(raw,['event','code','nominalPassed']);need(raw.nominalPassed===false&&CODES.has(`frontdoor_tick_${raw.code}`));throw new Refusal(`frontdoor_tick_${raw.code}`);}
    const complete=validateFrontdoorComplete(raw,baseline,sourceId);const exit=await exited;await channel.finalize();channel.assertTerminal();
    nativeSuccess(out,err,exit,EXACT_TEST,harness);need(await hashFile(harness.executable)===harness.sha256,'frontdoor_binary_changed');channel.assertTerminal();done=true;
    return {baseline,sourceLifecycle,complete};
  }finally{clearTimeout(timer);channel?.close();if(!done&&child)child.kill();await new Promise(resolve=>server.close(resolve));}
}
export async function runLiveProductFrontdoor(raw,preflight){const input=validateFrontdoorInput(raw),env={...process.env};assertFrontdoorAdmission(env);
  const harness=await verifiedHarness(input,env,{admit:assertFrontdoorAdmission,requiredFiles:REQUIRED_FILES,requiredTests:[JSON_TEST,EXACT_TEST]});validateFrontdoorRegression(preflight,harness.source,harness.sha256);
  let retained,phase='account';try{
    const account=validateAccountReport(await runLiveAccountRecipe(input.account,{privateContinuationSink:v=>{retained=v;}}),input.sourceSha);
    need(retained&&path.win32.isAbsolute(retained.rootDir)&&account.binarySha256===harness.sha256);phase='frontdoor';
    const observed=await nativeFrontdoor(harness,input,retained,account);
    return validateFrontdoorReport({format:'zentra-a41-product-frontdoor-report-v1',sourceSha:harness.source,binarySha256:harness.sha256,profileSha256:PROFILE,
      coordinatorSha256:await hashFile(fileURLToPath(import.meta.url)),exactTest:EXACT_TEST,preflight,account,...observed,nativeTestAdmission:true,
      webviewInvocationProved:false,distributedProductGateOpened:false,successfulConsentWriteProved:false,realDecisionProviderDirectlyAttested:false,
      g5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false,automaticCleanup:false},input.sourceSha);
  }catch(error){const code=frontdoorFailureCode(error);fs.writeFileSync(path.join(ROOT,'desktop/artifacts/action-live-profile/product-frontdoor-diagnostic.public.json'),
    JSON.stringify({format:'zentra-a41-product-frontdoor-diagnostic-v1',sourceSha:harness.source,binarySha256:harness.sha256,profileSha256:PROFILE,passed:false,phase,code,
      webviewInvocationProved:false,distributedProductGateOpened:false,g5Passed:false,g6Passed:false},null,2)+'\n',{flag:'wx'});throw new Refusal(code);}
}
export const DESCRIPTION=Object.freeze({format:'zentra-a41-product-frontdoor-description-v1',inactiveByDefault:true,privateInputFormat:'zentra-a41-product-frontdoor-input-v1',
  exactTest:EXACT_TEST,exactJsonTest:JSON_TEST,offPolicyCount:9,jsonInjectionCount:1,requiredFlag:FLAG+'=true',baseline:BASELINE_PIN,actualHandlers:6,ticks:1,
  protectedStoresExported:false,webviewInvocationProved:false,distributedProductGateOpened:false,successfulConsentWriteProved:false,g5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false});
// Execution is owned exclusively by the admitted CI dispatcher; CLI describes only.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);if(args.length===0||args.length===1&&args[0]==='--describe')process.stdout.write(JSON.stringify(DESCRIPTION)+'\n');
  else{process.stderr.write('{"passed":false,"code":"frontdoor_admission_refused"}\n');process.exitCode=1;}
}
