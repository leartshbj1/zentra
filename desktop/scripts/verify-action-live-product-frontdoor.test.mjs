// Pure local codecs/source contracts only; never invokes a recipe/native/Git/HTTP.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {BASELINE_PIN,FLAG,EXACT_TEST,JSON_TEST,OFF_TESTS,DESCRIPTION,validateFrontdoorInput,validateFrontdoorBaseline,
  validateOffPolicyProof,validateFrontdoorRegression,validateFrontdoorComplete,validateFrontdoorReport,assertFrontdoorPreflight,assertFrontdoorAdmission,frontdoorFailureCode} from './verify-action-live-product-frontdoor.mjs';
import {BASELINE} from './verify-action-live-g4-continuation.mjs';
import {DESCRIPTION as ACCOUNT,SESSION_REGRESSION_TESTS} from './verify-action-live-account-windows.mjs';
import {publicFrontdoorCiProof} from './verify-action-live-g4-ci-windows.mjs';
for(const key of ['ZENTRA_A41_SITES_SERVICE_TOKEN','ZENTRA_A41_BROWSER_COOKIE_QA'])if(Object.hasOwn(process.env,key))throw Error('PURE_FRONTDOOR_PRIVATE_ENV_REFUSED');
globalThis.fetch=async()=>{throw Error('PURE_FRONTDOOR_NETWORK_DISABLED');};
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,source='f'.repeat(40),binary='a'.repeat(64),profile=ACCOUNT.profileSha256;
const input=()=>({format:'zentra-a41-product-frontdoor-input-v1',sourceSha:source,campaignId:uuid(1),workspaceId:`support_${uuid(2)}`,connectionId:uuid(3),apiHookToken:`zsup_${'A'.repeat(43)}`,
  account:{format:'zentra-a41-native-account-input-v1',sitesServiceToken:'S'.repeat(32),browserCookieHeader:`__Host-zentra_access=synthetic; __Host-zentra_refresh=synthetic; __Host-zentra_session_owner=${ACCOUNT.expectedOwnerId}`,
    expectedOwnerId:ACCOUNT.expectedOwnerId,expectedOrganizationId:ACCOUNT.expectedOrganizationId},expectedBaseline:{...BASELINE_PIN}});
const history=()=>({proposalId:BASELINE.proposalId,sourceId:BASELINE.sourceId,createdAt:1,disposition:'needs_review',reasons:['low_confidence'],requiresHumanValidation:true});
const baseline=()=>({event:'frontdoor-baseline',campaignId:uuid(1),baseline:{...BASELINE_PIN,manifestSha256:'b'.repeat(64),sizeBytes:100,transport:'content-v1',receivedBoth:true,historicalWriterAckClaimed:false,historicalGatewayFactClaimed:false},
  historicalReview:history(),saved:{quotes:1,receipts:1,resources:'c'.repeat(64),customer:uuid(4),article:uuid(5)},consentRevisions:[1,1],preexistingReviews:[history(),{...history(),proposalId:uuid(30),sourceId:uuid(31),createdAt:2}]});
const quote=()=>({sourceId:uuid(6),proposalId:uuid(7),reservationId:uuid(8),fingerprint:'d'.repeat(64),quoteId:uuid(9),customerId:uuid(4),articleId:uuid(5),receiptSha256:'e'.repeat(64),lineIds:[uuid(10)],
  quoteCount:1,receiptCount:1,quoteNumber:null,status:'draft',requiresHumanValidation:true,nativeFrozenCreationVerified:true,auditChainValid:true});
const complete=()=>({event:'frontdoor-complete',campaignId:uuid(1),publication:{snapshotId:uuid(11),baseRevision:2,revision:3,archiveSha256:'1'.repeat(64),manifestSha256:'2'.repeat(64),sizeBytes:200,transport:'content-v1',gatewayPgFactAndD1Committed:true},quote:quote(),
  actualHandlers:6,ticks:1,confirmed:1,historicalReviewCount:2,historicalReviewProjectionPreserved:true,consentCas:'stale_conflict',consentRevisionsUnchanged:true,activityDelta:1,localWriterAck:true,secondStoreExactCreation:true,
  bothStoresReopened:true,separateBusinessProcesses:false,webviewInvocationProved:false,distributedProductGateOpened:false,successfulConsentWriteProved:false,realDecisionProviderDirectlyAttested:false,g5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false});
const offProof=()=>({format:'zentra-autopilot-product-native-tests-v1',source,binarySha256:binary,profileSha256:profile,selectedNames:[...OFF_TESTS],expectedTotal:9,runtimePassed:9,nativeExecutionAttempted:true,passed:true,
  opensProduct:false,businessJourneyExecuted:false,releasePublished:false,suiteExecutions:OFF_TESTS.map((name,i)=>({filter:name,selectedNames:1,extraArguments:['--exact'],nativeArguments:[name,'--test-threads=1','--exact'],contextMode:'diagnostics-verification',
    exit:0,durationMs:1,passed:1,failed:0,ignored:0,stdout:`windows-test-suite-${String(i+12).padStart(2,'0')}.log`,stderr:`windows-test-suite-${String(i+12).padStart(2,'0')}-errors.log`}))});
const regression=()=>({format:'zentra-a41-product-frontdoor-preflight-v1',sourceSha:source,binarySha256:binary,profileSha256:profile,offPolicyProofSha256:'3'.repeat(64),offPolicyPassed:9,jsonInjectionPassed:1,exactJsonTest:JSON_TEST,nativeExecuted:true,productGateOpened:false});
const installation=n=>({installationId:uuid(n),licenseId:`lic_${uuid(n+2)}`,accountSessionId:`dss_${uuid(n+4)}`,jti:uuid(n+6),licenseSha256:'4'.repeat(64)});
const account=()=>({format:'zentra-a41-native-account-report-v1',source,binarySha256:binary,coordinatorSha256:'5'.repeat(64),rustHarnessSourceSha256:'6'.repeat(64),profileSha256:profile,
  siteOrigin:'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site',ownerId:ACCOUNT.expectedOwnerId,organizationId:ACCOUNT.expectedOrganizationId,
  phases:['enroll','reopen'].map(phase=>({phase,exactTest:ACCOUNT.exactTests[phase],strictMeHttp200:true,nativeLicenseValidated:true,installations:[installation(40),installation(41)]})),
  sameExecutableBothPhases:true,separateNativeProcesses:true,protectedStateReopened:true,browserApprovals:2,nativeExecuted:true,stripePaidTestValidated:false,actionEngineExecuted:false,serverSourceDirectlyAttested:false,automaticCleanup:false});
const report=()=>({format:'zentra-a41-product-frontdoor-report-v1',sourceSha:source,binarySha256:binary,profileSha256:profile,coordinatorSha256:'7'.repeat(64),exactTest:EXACT_TEST,preflight:regression(),account:account(),baseline:baseline(),
  sourceLifecycle:{campaignId:uuid(1),workspaceId:`support_${uuid(2)}`,connectionId:uuid(3),sourceId:uuid(6),sourceRevision:2,sourceEnvelopeSha256:'8'.repeat(64),historicalTicketSha256:'9'.repeat(64),existingConnectionReused:true,historicalTicketPreserved:true,
    settingsAndDelegationPreserved:true,actualHumanQuoteClassification:true,automaticSupportClassificationObserved:false,thirdPartyMailboxExecuted:false},complete:complete(),nativeTestAdmission:true,webviewInvocationProved:false,distributedProductGateOpened:false,
  successfulConsentWriteProved:false,realDecisionProviderDirectlyAttested:false,g5Passed:false,g6Passed:false,mailExecuted:false,schedulerExecuted:false,automaticCleanup:false});
const env=()=>({CIRCLECI:'true',CIRCLE_BRANCH:'codex/action-engine-native-live-a41',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',CIRCLE_SHA1:source,CIRCLE_BUILD_NUM:'999',
  ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',ZENTRA_RUN_LIVE_ACCOUNT_RECIPE:'true'});
const read=file=>readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n');
test('new mode is closed, fixed to the observed revision-two baseline, and accepts any JSON field order',()=>{
  assert.equal(validateFrontdoorInput(input()).expectedBaseline.revision,2);assert.equal(DESCRIPTION.offPolicyCount,9);assert.equal(DESCRIPTION.jsonInjectionCount,1);
  assert.doesNotThrow(()=>validateFrontdoorInput({...input(),expectedBaseline:{archiveSha256:BASELINE_PIN.archiveSha256,snapshotId:BASELINE_PIN.snapshotId,revision:2}}));
  for(const patch of [{format:'zentra-a41-g5-input-v1'},{sourceId:uuid(6)},{ready:true},{testFrontdoor:true},{sourceTemplate:'en-g5-v1'},{expectedBaseline:{...BASELINE_PIN,revision:1}}])assert.throws(()=>validateFrontdoorInput({...input(),...patch}));
  let read=false;const value=input();Object.defineProperty(value,'account',{enumerable:true,get(){read=true;return input().account;}});assert.throws(()=>validateFrontdoorInput(value));assert.equal(read,false);
});
test('preflight and live flag phases cannot be confused or mixed with G5/virgin/continuation',()=>{
  assert.doesNotThrow(()=>assertFrontdoorPreflight(env(),'win32'));assert.throws(()=>assertFrontdoorAdmission(env(),'win32'));
  assert.doesNotThrow(()=>assertFrontdoorAdmission({...env(),[FLAG]:'true'},'win32'));assert.throws(()=>assertFrontdoorPreflight({...env(),[FLAG]:'true'},'win32'));
  for(const key of ['ZENTRA_RUN_LIVE_G4_RECIPE','ZENTRA_RUN_LIVE_G4_CONTINUATION','ZENTRA_RUN_LIVE_G5_RECIPE'])assert.throws(()=>assertFrontdoorAdmission({...env(),[FLAG]:'true',[key]:'true'},'win32'));
  assert.throws(()=>assertFrontdoorAdmission({...env(),[FLAG]:'true'},'linux'));
});
test('baseline is complete, contains historical resources/reviews, and cannot claim the old writer ACK',()=>{
  assert.equal(validateFrontdoorBaseline(baseline(),input()).saved.quotes,1);
  for(const mutation of [v=>v.baseline.historicalWriterAckClaimed=true,v=>v.baseline.revision=3,v=>v.saved.quotes=0,v=>v.preexistingReviews=Array(20).fill(history())]){const v=baseline();mutation(v);assert.throws(()=>validateFrontdoorBaseline(v,input()));}
});
test('preflight keeps nine OFF results distinct from one new JSON result on the same source and binary',()=>{
  assert.equal(validateOffPolicyProof(offProof(),{source,sha256:binary}).runtimePassed,9);assert.equal(validateFrontdoorRegression(regression(),source,binary).jsonInjectionPassed,1);
  for(const patch of [{runtimePassed:10},{selectedNames:OFF_TESTS.slice(1)},{binarySha256:'9'.repeat(64)},{opensProduct:true}])assert.throws(()=>validateOffPolicyProof({...offProof(),...patch},{source,sha256:binary}));
  for(const patch of [{offPolicyPassed:10},{jsonInjectionPassed:0},{exactJsonTest:EXACT_TEST},{productGateOpened:true}])assert.throws(()=>validateFrontdoorRegression({...regression(),...patch},source,binary));
});
test('complete requires exactly one tick, real ACK, canonical revision-three quote and the second-store reopen',()=>{
  assert.equal(validateFrontdoorComplete(complete(),baseline(),uuid(6)).ticks,1);
  for(const field of Object.keys(complete())){const v=complete();delete v[field];assert.throws(()=>validateFrontdoorComplete(v,baseline(),uuid(6)));}
  for(const patch of [{ticks:2},{confirmed:0},{localWriterAck:false},{secondStoreExactCreation:false},{bothStoresReopened:false},{separateBusinessProcesses:true},{historicalReviewCount:1},{webviewInvocationProved:true},{distributedProductGateOpened:true}])assert.throws(()=>validateFrontdoorComplete({...complete(),...patch},baseline(),uuid(6)));
  const v=complete();v.publication.baseRevision=1;assert.throws(()=>validateFrontdoorComplete(v,baseline(),uuid(6)));
});
test('public report remains bounded and cannot relabel native admission as product/WebView/G5/G6',()=>{
  assert.equal(validateFrontdoorReport(report(),source).nativeTestAdmission,true);
  for(const field of Object.keys(report())){const v=report();delete v[field];assert.throws(()=>validateFrontdoorReport(v,source));}
  for(const patch of [{webviewInvocationProved:true},{distributedProductGateOpened:true},{g5Passed:true},{g6Passed:true},{successfulConsentWriteProved:true},{rootDir:'private'}])assert.throws(()=>validateFrontdoorReport({...report(),...patch},source));
});
test('CI proof ties coordinator/session-regression/binary without claiming an app release',()=>{
  const identity={source,pipelineId:uuid(60),workflowId:uuid(61),jobNumber:'999',nodeVersion:'v22.0.0'},hashes=Object.fromEntries(['entrypointSha256','profileCompilationProofSha256','frontdoorCoordinatorSha256','frontdoorPreflightProofSha256','rustFrontdoorHarnessSha256',
    'rustFrontdoorCapabilitySha256','rustSupervisorSha256','rustSupervisorTestsSha256','rustParentG5Sha256','rustContinuationHarnessSha256','rustCollaborationSupportSha256'].map(k=>[k,k==='frontdoorCoordinatorSha256'?'7'.repeat(64):'8'.repeat(64)])),sessions={format:'zentra-a41-native-session-regressions-v1',source,binarySha256:binary,tests:[...SESSION_REGRESSION_TESTS],passed:3,nativeExecuted:true};
  const proof=publicFrontdoorCiProof(report(),identity,hashes,sessions);assert.equal(proof.claims.actualNativeFrontdoorHandlersValidated,true);assert.equal(proof.claims.autopilotProductActivated,false);
  assert.throws(()=>publicFrontdoorCiProof(report(),identity,{...hashes,frontdoorCoordinatorSha256:'9'.repeat(64)},sessions));assert.throws(()=>publicFrontdoorCiProof(report(),identity,hashes,{...sessions,binarySha256:'9'.repeat(64)}));
});
test('failure code inspection never invokes a private getter',()=>{
  let read=false;assert.equal(frontdoorFailureCode({get code(){read=true;throw Error('private');}}),'frontdoor_validation_refused');assert.equal(read,false);
  assert.equal(frontdoorFailureCode({code:'private secret'}),'frontdoor_validation_refused');assert.equal(frontdoorFailureCode({code:'frontdoor_new_source_needs_review'}),'frontdoor_new_source_needs_review');
});
test('real native source calls six handlers and exactly one tick; off gate and private capability remain closed',()=>{
  const native=read('../src-tauri/src/account_cloud_quote_autopilot.rs'),capability=read('../src-tauri/src/account_cloud_quote_autopilot_live_frontdoor.rs'),recipe=read('../src-tauri/src/account_cloud_live_a41_product_frontdoor_tests.rs');
  assert.match(native,/const PRODUCT_ENABLED: bool = cfg!\(all\(target_os = "windows", feature = "quote-autopilot-product"\)\);/);assert.match(native,/#\[cfg\(all\(test, windows\)\)\]\n    #\[serde\(skip\)\]/);
  for(const name of ['quote_autopilot_state','quote_autopilot_consent','set_quote_autopilot_consent','quote_autopilot_tick','quote_autopilot_activity','quote_autopilot_review'])assert.ok(capability.includes(name+'(app.state()'));
  assert.equal((capability.match(/quote_autopilot_tick\(app\.state/g)||[]).length,1);assert.match(capability,/expected_revision: before\.revision - 1/);assert.match(capability,/after\.data != consent\.data/);
  assert.match(capability,/Arc::ptr_eq/);assert.match(capability,/grant\.original != \*stamp/);assert.match(recipe,/#\[ignore="Explicit future A41 native product frontdoor/);
  assert.doesNotMatch(recipe,/staged::|prepare_and_write_once|paid_consent\(|seed\(|publish_initial\(|configure_test_license/);
  for(const name of ['frontdoor::exercise_once','new_quote_proof','acknowledged_publication','corroborate_writer','receive_exact','drop(a);drop(b);'])assert.ok(recipe.includes(name));
  const node=read('./verify-action-live-product-frontdoor.mjs');assert.match(node,/await channel\.finalize\(\);channel\.assertTerminal\(\)/);assert.match(node,/rejectConnection\(e\);reject\(e\)/);assert.doesNotMatch(node,/persist_to_workspace/);
});
