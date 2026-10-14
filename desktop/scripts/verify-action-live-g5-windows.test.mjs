// Pure codec/state/source contracts. No native, Git child, HTTP or Cargo.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {G5_TESTS,DESCRIPTION,validateG5Input,validateG5Pin,assertG5Admission,validateG5Baseline,validateG5Selected,
  validateG5Phase,runG5Sequence,killAndReapAtCheckpoint,g5FailureCode,validateG5Diagnostic,validateG5Report} from './verify-action-live-g5-windows.mjs';
import {BASELINE,makeContinuationSource} from './verify-action-live-g4-continuation.mjs';
import {DESCRIPTION as ACCOUNT,SESSION_REGRESSION_TESTS} from './verify-action-live-account-windows.mjs';
import {publicG5CiProof} from './verify-action-live-g4-ci-windows.mjs';
for(const name of ['ZENTRA_A41_SITES_SERVICE_TOKEN','ZENTRA_A41_BROWSER_COOKIE_QA'])if(Object.hasOwn(process.env,name))throw Error('PURE_G5_PRIVATE_ENV_REFUSED');
globalThis.fetch=async()=>{throw Error('PURE_G5_NETWORK_DISABLED');};
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,source='f'.repeat(40),binary='a'.repeat(64);
const pin=()=>({revision:2,snapshotId:uuid(1),archiveSha256:'b'.repeat(64)});
const input=()=>({format:'zentra-a41-g5-input-v1',sourceSha:source,campaignId:uuid(2),workspaceId:`support_${uuid(3)}`,connectionId:uuid(4),apiHookToken:`zsup_${'A'.repeat(43)}`,
  expectedBaseline:pin(),account:{format:'zentra-a41-native-account-input-v1',sitesServiceToken:'S'.repeat(32),
    browserCookieHeader:`__Host-zentra_access=synthetic; __Host-zentra_refresh=synthetic; __Host-zentra_session_owner=${ACCOUNT.expectedOwnerId}`,
    expectedOwnerId:ACCOUNT.expectedOwnerId,expectedOrganizationId:ACCOUNT.expectedOrganizationId}});
const history=()=>({proposalId:BASELINE.proposalId,sourceId:BASELINE.sourceId,createdAt:1,disposition:'needs_review',reasons:['low_confidence'],requiresHumanValidation:true});
const baseline=()=>({event:'g5-baseline',campaignId:uuid(2),baseline:{...pin(),manifestSha256:'c'.repeat(64),sizeBytes:100,transport:'content-v1',receivedBoth:true,
  historicalWriterAckClaimed:false,historicalGatewayFactClaimed:false},historicalReview:history(),saved:{quotes:1,receipts:1,resources:'d'.repeat(64),customer:uuid(5),article:uuid(6)},consentRevisions:[1,1],
  preexistingReviews:[history(),{...history(),proposalId:uuid(40),sourceId:uuid(41),createdAt:2}]});
const selected=()=>({sourceId:uuid(7),proposalId:uuid(8),fingerprint:'e'.repeat(64)});
const publication=()=>({snapshotId:uuid(9),baseRevision:2,revision:3,archiveSha256:'1'.repeat(64),manifestSha256:'2'.repeat(64),sizeBytes:200,transport:'content-v1',gatewayPgFactAndD1Committed:true});
const quote=()=>({sourceId:uuid(7),proposalId:uuid(8),reservationId:uuid(10),fingerprint:'e'.repeat(64),quoteId:uuid(11),customerId:uuid(5),articleId:uuid(6),receiptSha256:'3'.repeat(64),
  lineIds:[uuid(12)],quoteCount:1,receiptCount:1,quoteNumber:null,status:'draft',requiresHumanValidation:true,nativeFrozenCreationVerified:true,auditChainValid:true});
const state=()=>({baseline:baseline(),sourceId:uuid(7),selected:selected()});
const event=phase=>phase===0?{event:'writer-durable',selected:selected(),saved:baseline().saved,localAck:false}
  :phase<3?{event:phase===1?'commit-response-discarded':'confirmation-response-discarded',publication:publication(),httpStatus:200,localAck:false}
  :phase===3?{event:'ack-and-receive',publication:publication(),quote:quote(),localAck:true,secondStoreExactCreation:true}
  :{event:'g5-complete',publication:publication(),quote:quote(),historicalReview:history(),writerActivityCount:1,secondStoreActivityCount:0,bothReopenedInNewProcess:true,
    historicalPreparationRequests:0,freshPreparationRequests:1,preexistingReviewCount:2,preexistingReviewProjectionPreserved:true,fullG5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false};
const env=()=>({CIRCLECI:'true',CIRCLE_BRANCH:'codex/action-engine-native-live-a41',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',CIRCLE_SHA1:source,CIRCLE_BUILD_NUM:'999',
  ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',
  ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',ZENTRA_RUN_LIVE_ACCOUNT_RECIPE:'true',ZENTRA_RUN_LIVE_G5_RECIPE:'true'});
const installation=n=>({installationId:uuid(n),licenseId:`lic_${uuid(n+2)}`,accountSessionId:`dss_${uuid(n+4)}`,jti:uuid(n+6),licenseSha256:'4'.repeat(64)});
const account=()=>({format:'zentra-a41-native-account-report-v1',source,binarySha256:binary,coordinatorSha256:'5'.repeat(64),rustHarnessSourceSha256:'6'.repeat(64),profileSha256:ACCOUNT.profileSha256,
  siteOrigin:'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site',ownerId:ACCOUNT.expectedOwnerId,organizationId:ACCOUNT.expectedOrganizationId,
  phases:['enroll','reopen'].map(phase=>({phase,exactTest:ACCOUNT.exactTests[phase],strictMeHttp200:true,nativeLicenseValidated:true,installations:[installation(20),installation(21)]})),
  sameExecutableBothPhases:true,separateNativeProcesses:true,protectedStateReopened:true,browserApprovals:2,nativeExecuted:true,stripePaidTestValidated:false,actionEngineExecuted:false,serverSourceDirectlyAttested:false,automaticCleanup:false});
const report=()=>({format:'zentra-a41-g5-subset-report-v1',sourceSha:source,binarySha256:binary,profileSha256:ACCOUNT.profileSha256,coordinatorSha256:'7'.repeat(64),account:account(),baseline:baseline(),
  sourceLifecycle:{campaignId:uuid(2),workspaceId:`support_${uuid(3)}`,connectionId:uuid(4),sourceId:uuid(7),sourceRevision:2,sourceEnvelopeSha256:'8'.repeat(64),historicalTicketSha256:'9'.repeat(64),
    existingConnectionReused:true,historicalTicketPreserved:true,settingsAndDelegationPreserved:true,actualHumanQuoteClassification:true,automaticSupportClassificationObserved:false,thirdPartyMailboxExecuted:false},
  complete:event(4),passedBoundaries:['writer_process_stop','committed_response_loss','confirmation_response_loss_before_local_ack'],killedAndReapedProcesses:3,reopenedNativeProcesses:4,
  freshPreparationRequests:1,historicalPreparationRequests:0,commitTransport:'native_session_request_status_observed',otherPublicationTransport:'original_helper',
  realDecisionProviderDirectlyAttested:false,fullG5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false,automaticCleanup:false});
const read=file=>readFileSync(new URL(file,import.meta.url),'utf8');

test('future mode is opt-in and never asserts the whole G5 or G6',()=>{
  assert.equal(DESCRIPTION.inactiveByDefault,true);assert.equal(G5_TESTS.length,5);assert.equal(DESCRIPTION.processStops,3);
  for(const field of ['fullG5Passed','g6Passed','mailExecuted','schedulerExecuted','protectedStoresExported'])assert.equal(DESCRIPTION[field],false);
  assert.doesNotThrow(()=>assertG5Admission(env(),'win32'));
  for(const patch of [{ZENTRA_RUN_LIVE_G5_RECIPE:'false'},{ZENTRA_RUN_LIVE_G4_CONTINUATION:'true'},{ZENTRA_RUN_LIVE_G4_RECIPE:'true'},{CIRCLE_BRANCH:'main'}])assert.throws(()=>assertG5Admission({...env(),...patch},'win32'));
  assert.throws(()=>assertG5Admission(env(),'linux'));
});
test('dynamic revision-two baseline is closed, nonzero and never a guessed historical ACK',()=>{
  assert.equal(validateG5Input(input()).expectedBaseline.revision,2);assert.doesNotThrow(()=>validateG5Baseline(baseline(),input()));
  for(const patch of [{revision:0},{revision:'2'},{snapshotId:[uuid(1)]},{archiveSha256:['b'.repeat(64)]},{rootDir:'private'}])assert.throws(()=>validateG5Pin({...pin(),...patch}));
  for(const patch of [{receivedBoth:false},{historicalWriterAckClaimed:true},{revision:1}])assert.throws(()=>validateG5Baseline({...baseline(),baseline:{...baseline().baseline,...patch}},input()));
});
test('request cannot supply provider, URLs, plan, selected source, root or a callback',()=>{
  for(const field of ['provider','url','plan','sourceId','rootDir','callback','forceReady'])assert.throws(()=>validateG5Input({...input(),[field]:true}));
  let accessed=false;const value=input();Object.defineProperty(value,'apiHookToken',{enumerable:true,get(){accessed=true;return 'secret';}});
  assert.throws(()=>validateG5Input(value));assert.equal(accessed,false);
});
test('selected new source/proposal/digest must match and never target historical review',()=>{
  assert.deepEqual(validateG5Selected(selected(),uuid(7)),selected());
  for(const patch of [{sourceId:BASELINE.sourceId},{proposalId:BASELINE.proposalId},{fingerprint:['e'.repeat(64)]},{decision:'ready'}])assert.throws(()=>validateG5Selected({...selected(),...patch},uuid(7)));
});
test('three real losses must precede local ACK and preserve the exact publication',()=>{
  const s=state();assert.equal(validateG5Phase(event(0),0,s).localAck,false);
  s.publication=validateG5Phase(event(1),1,s).publication;assert.equal(validateG5Phase(event(2),2,s).httpStatus,200);
  for(const phase of [1,2])for(const patch of [{localAck:true},{httpStatus:202},{message:'private'}])assert.throws(()=>validateG5Phase({...event(phase),...patch},phase,s));
  assert.throws(()=>validateG5Phase({...event(2),publication:{...publication(),snapshotId:uuid(90)}},2,s));
  s.quote=validateG5Phase(event(3),3,s).quote;assert.equal(validateG5Phase(event(4),4,s).bothReopenedInNewProcess,true);
});
test('all preexisting reviews are captured dynamically and must survive without asserting a total of one',()=>{
  const b=baseline();b.preexistingReviews.push({...history(),proposalId:uuid(42),sourceId:uuid(43),createdAt:3});
  assert.equal(validateG5Baseline(b,input()).preexistingReviews.length,3);
  const s=state();s.baseline=b;s.publication=validateG5Phase(event(1),1,s).publication;s.quote=validateG5Phase(event(3),3,s).quote;
  assert.throws(()=>validateG5Phase(event(4),4,s));assert.equal(validateG5Phase({...event(4),preexistingReviewCount:3},4,s).preexistingReviewProjectionPreserved,true);
  for(const items of [[history()],[],[history(),history()]])assert.throws(()=>validateG5Baseline({...baseline(),preexistingReviews:items},input()));
});
test('future coordinator executes five phases once and retains selectors for every restart',async()=>{
  const calls=[],s=state();const complete=await runG5Sequence(async phase=>{calls.push(phase);return validateG5Phase(event(phase),phase,s);},s);
  assert.deepEqual(calls,[0,1,2,3,4]);assert.equal(complete.event,'g5-complete');assert.deepEqual(s.selected,selected());
});
test('a review or any failed stage stops without replaying preparation or advancing later phases',async()=>{
  for(const failureAt of [0,1,2,3,4]){const calls=[],s=state();await assert.rejects(runG5Sequence(async phase=>{calls.push(phase);if(phase===failureAt)throw Error('synthetic');return validateG5Phase(event(phase),phase,s);},s));
    assert.deepEqual(calls,Array.from({length:failureAt+1},(_,n)=>n));assert.equal(calls.filter(n=>n===0).length,1);}
});
test('physical process termination waits for reaping and real pipe completion',async()=>{
  let exit,finishPipe,settled=false;const calls=[];
  const exited=new Promise(resolve=>{exit=resolve;}),eof=new Promise(resolve=>{finishPipe=resolve;});
  const operation=killAndReapAtCheckpoint({alreadyExited:()=>false,kill:()=>{calls.push('kill');return true;},waitExit:()=>exited,
    finalize:()=>{calls.push('finalize');return eof;},assertTerminal:()=>calls.push('terminal')}).then(()=>{settled=true;});
  assert.deepEqual(calls,['kill']);exit({code:1,signal:null});await Promise.resolve();assert.equal(settled,false);
  assert.deepEqual(calls,['kill','finalize']);finishPipe();await operation;assert.deepEqual(calls,['kill','finalize','terminal']);
});
test('already exited, failed kill, successful exit or fatal residual pipe cannot count as a crash',async()=>{
  for(const patch of [{alreadyExited:()=>true},{kill:()=>false},{waitExit:async()=>({code:0,signal:null})},{assertTerminal:()=>{throw Error('synthetic trailing frame');}}])
    await assert.rejects(killAndReapAtCheckpoint({alreadyExited:()=>false,kill:()=>true,waitExit:async()=>({code:1,signal:null}),finalize:async()=>{},assertTerminal:()=>{},...patch}));
});
test('report is closed and never upgrades these three boundaries to all-gates success',()=>{
  assert.equal(validateG5Report(report(),source).fullG5Passed,false);
  for(const field of Object.keys(report())){const value=report();delete value[field];assert.throws(()=>validateG5Report(value,source));}
  for(const patch of [{fullG5Passed:true},{g6Passed:true},{schedulerExecuted:true},{freshPreparationRequests:2},{historicalPreparationRequests:1},{killedAndReapedProcesses:2},{rootDir:'private'}])assert.throws(()=>validateG5Report({...report(),...patch},source));
});
test('CI receipt links the same source, binary, coordinator and three regressions with bounded claims',()=>{
  const identity={source,pipelineId:uuid(50),workflowId:uuid(51),jobNumber:'999',nodeVersion:'v22.0.0'};
  const hashes=Object.fromEntries(['entrypointSha256','profileCompilationProofSha256','g5CoordinatorSha256','rustG5HarnessSha256',
    'rustG5AdapterSha256','rustG5PublicationPortSha256','rustParentHarnessSha256','rustCollaborationSupportSha256'].map(key=>[key,key==='g5CoordinatorSha256'?'7'.repeat(64):'8'.repeat(64)]));
  const regressions={format:'zentra-a41-native-session-regressions-v1',source,binarySha256:binary,tests:[...SESSION_REGRESSION_TESTS],passed:3,nativeExecuted:true};
  const proof=publicG5CiProof(report(),identity,hashes,regressions);
  assert.equal(proof.claims.threeDeclaredRecoveryBoundariesValidated,true);assert.equal(proof.report.complete.preexistingReviewCount,2);
  for(const key of ['fullG5Passed','g6Passed','allActionEngineGatesEstablished','realDecisionProviderDirectlyAttested','mailExecuted','schedulerExecuted','autopilotProductActivated'])assert.equal(proof.claims[key],false);
  for(const patch of [{g5CoordinatorSha256:'9'.repeat(64)},{cookie:'private'}])assert.throws(()=>publicG5CiProof(report(),identity,{...hashes,...patch},regressions));
  for(const patch of [{source:'e'.repeat(40)},{binarySha256:'9'.repeat(64)},{passed:2}])assert.throws(()=>publicG5CiProof(report(),identity,hashes,{...regressions,...patch}));
});
test('diagnostic retains only fixed phase/code and hashes, never private errors',()=>{
  const value={format:'zentra-a41-g5-diagnostic-v1',sourceSha:source,binarySha256:binary,profileSha256:ACCOUNT.profileSha256,passed:false,phase:2,code:'g5_native_result_refused',fullG5Passed:false,g6Passed:false};
  assert.equal(validateG5Diagnostic(value).phase,2);assert.equal(g5FailureCode({code:'private value'}),'g5_validation_refused');
  let read=false;assert.equal(g5FailureCode({get code(){read=true;return 'g5_deadline';}}),'g5_validation_refused');assert.equal(read,false);
  for(const patch of [{message:'private'},{phase:5},{fullG5Passed:true},{code:'arbitrary'}])assert.throws(()=>validateG5Diagnostic({...value,...patch}));
});
test('old continuation retains revision-one refusal while trusted G5 port validates its own current baseline',async()=>{
  const c={...input(),format:'zentra-a41-continuation-input-v1'};delete c.expectedBaseline;
  let calls=0;const fetcher=async()=>{calls++;throw Error('synthetic transport stop');};
  await assert.rejects(makeContinuationSource(c,{admit:()=>{},fetcher}).provision(baseline()));assert.equal(calls,0);
  await assert.rejects(makeContinuationSource(c,{admit:()=>{},fetcher,baselineValidator:b=>validateG5Baseline(b,input())}).provision(baseline()));assert.equal(calls,1);
});
test('Rust helpers use one genuine preparation, actual writer and HTTP before response discard',()=>{
  const rust=read('../src-tauri/src/account_cloud_action_engine_g5_support.rs'),publication=read('../src-tauri/src/company_collaboration_live_a41_g5_support.rs');
  assert.equal((rust.match(/protocol::preparation_request\(source\)/g)||[]).length,1);
  assert.match(rust,/local_effect\(store, &original, move \|store, _\| store\.commit_action_engine_quote_draft_after_recovery\(input\)\)/);
  assert.match(rust,/execute_quote_draft_at\(store, &original, selected, body, Some\(&expected\.fingerprint\)\)/);
  assert.match(rust,/operation_lock\.clone\(\)\.lock_owned\(\)\.await/);assert.match(rust,/require_stamp\(&checked, &before\)/);assert.match(rust,/require_stamp\(&checked, &original\)/);
  const confirmation=rust.slice(rust.indexOf('pub(crate) async fn recover_and_lose_confirmation'),rust.indexOf('pub(crate) async fn resume_exact_and_ack'));
  assert.match(confirmation,/let response = request\(session, body\)\.await\?/);assert.match(confirmation,/response\.0 != StatusCode::OK/);
  assert.doesNotMatch(confirmation,/acknowledge\(/);
  assert.match(publication,/publish_action_engine_quote_with/);assert.match(publication,/action_publication_transport\(store, session, packet\)\.await/);
  assert.ok(publication.indexOf('current.request(Method::POST, PATH')<publication.indexOf('dropped.store(true'));
  assert.match(publication,/status != StatusCode::OK/);assert.match(publication,/TransferGuard::take\(\)/);assert.match(publication,/pause_for_workspace_change\(\)/);
  for(const source of [rust,publication])assert.doesNotMatch(source,/\.execute\(|\.execute_batch\(|configure_test_license|synthetic_committed|force_ready|paid_consent/);
});
test('all future native phases are ignored/test-only and block before Node process termination',()=>{
  const rust=read('../src-tauri/src/account_cloud_live_a41_g5_tests.rs');
  for(const name of G5_TESTS)assert.ok(rust.includes(`phase_test!(${name.split('::').at(-1)},`));
  assert.match(rust,/#\[ignore="Explicit future A41 G5 campaign/);assert.match(rust,/let _:Challenge=pipe\.read\(\)\?/);
  assert.match(rust,/input\.reviews\.as_ref\(\)!=Some\(&reviews\)/);assert.match(rust,/input\.consent_revisions\.as_ref\(\)!=Some\(&consents\)/);
  assert.match(rust,/prepare_and_write_once/);assert.doesNotMatch(rust,/paid_consent\(|seed\(|require_fresh_remote\(|publish_initial\(/);
  const node=read('./verify-action-live-g5-windows.mjs');assert.match(node,/killAndReapAtCheckpoint\(\{alreadyExited:\(\)=>observedExit,kill:\(\)=>child\.kill\(\)/);assert.match(node,/const exit=await exited/);
  assert.match(node,/await channel\.finalize\(\)/);assert.match(node,/channel\.assertTerminal\(\)/);assert.doesNotMatch(node,/persist_to_workspace|writeFileSync\([^\n]*rootDir|process\.stdout\.write\(out/);
  const runner=node.slice(node.indexOf('export async function runLiveG5Recipe'));assert.ok(runner.indexOf('assertG5Admission(env)')<runner.indexOf('await verifiedHarness'));
});
