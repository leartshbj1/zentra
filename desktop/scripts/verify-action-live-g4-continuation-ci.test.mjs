// Pure closed contracts only. No CI/recipe entrypoint, Git child, native or HTTP.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { continuationInputFromEnvironment, publicContinuationCiProof, SECRET_NAMES, compileEnvironment,
  assertG4CiAdmission } from './verify-action-live-g4-ci-windows.mjs';
import { BASELINE, CONTINUATION_TEST, validatePublicContinuationReport, validateContinuationBaseline,
  validateBaselineReceipt } from './verify-action-live-g4-continuation.mjs';
import { DESCRIPTION as ACCOUNT, SESSION_REGRESSION_TESTS } from './verify-action-live-account-windows.mjs';
for (const name of SECRET_NAMES) if (Object.hasOwn(process.env, name)) throw new Error('PURE_CONTINUATION_REFUSES_PRIVATE_ENVIRONMENT');
globalThis.fetch = async () => { throw new Error('PURE_CONTINUATION_NETWORK_DISABLED'); };
const uuid = n => `${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const source = 'f'.repeat(40), binary = 'a'.repeat(64), profile = ACCOUNT.profileSha256;
const cookie = `__Host-zentra_access=synthetic; __Host-zentra_refresh=synthetic; __Host-zentra_session_owner=${ACCOUNT.expectedOwnerId}`;
const context = () => ({format:'zentra-a41-continuation-context-v1',sourceSha:source,campaignId:uuid(1),workspaceId:`support_${uuid(2)}`,
  connectionId:uuid(3),apiHookToken:`zsup_${'A'.repeat(43)}`,browserCookieHeader:cookie});
const environment = value => ({CIRCLE_SHA1:source,[SECRET_NAMES[0]]:'S'.repeat(32),[SECRET_NAMES[1]]:JSON.stringify(value)});
const history = () => ({proposalId:BASELINE.proposalId,sourceId:BASELINE.sourceId,createdAt:1,disposition:'needs_review',reasons:['low_confidence'],requiresHumanValidation:true});
const baseline = () => ({event:'baseline',campaignId:uuid(1),baseline:{snapshotId:BASELINE.snapshotId,revision:1,archiveSha256:BASELINE.archiveSha256,
  manifestSha256:'b'.repeat(64),sizeBytes:100,transport:'content-v1',receivedBoth:true,historicalWriterAckClaimed:false,historicalGatewayFactClaimed:false},
  historicalReview:history(),customerId:uuid(4),articleId:uuid(5),resourcesSha256:'c'.repeat(64),quoteBaselineCount:2,receiptBaselineCount:2,consentRevisions:[1,1]});
const installations = () => [20,21].map(n=>({installationId:uuid(n),licenseId:`lic_${uuid(n+2)}`,accountSessionId:`dss_${uuid(n+4)}`,jti:uuid(n+6),licenseSha256:'d'.repeat(64)}));
const account = () => ({format:'zentra-a41-native-account-report-v1',source,binarySha256:binary,coordinatorSha256:'e'.repeat(64),rustHarnessSourceSha256:'f'.repeat(64),
  profileSha256:profile,siteOrigin:'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site',ownerId:ACCOUNT.expectedOwnerId,organizationId:ACCOUNT.expectedOrganizationId,
  phases:['enroll','reopen'].map(phase=>({phase,exactTest:ACCOUNT.exactTests[phase],strictMeHttp200:true,nativeLicenseValidated:true,installations:installations()})),
  sameExecutableBothPhases:true,separateNativeProcesses:true,protectedStateReopened:true,browserApprovals:2,nativeExecuted:true,stripePaidTestValidated:false,
  actionEngineExecuted:false,serverSourceDirectlyAttested:false,automaticCleanup:false});
const complete = () => ({event:'complete',profileSha256:profile,organizationId:ACCOUNT.expectedOrganizationId,campaignId:uuid(1),baseline:baseline().baseline,historicalReview:history(),
  canonicalPublication:{snapshotId:uuid(8),baseRevision:1,revision:2,archiveSha256:'1'.repeat(64),manifestSha256:'2'.repeat(64),sizeBytes:200,transport:'content-v1',gatewayPgFactAndD1Committed:true},
  quote:{sourceId:uuid(6),proposalId:uuid(7),reservationId:uuid(9),fingerprint:'3'.repeat(64),quoteId:uuid(10),customerId:uuid(4),articleId:uuid(5),receiptSha256:'4'.repeat(64),
    lineIds:[uuid(11)],quoteCount:1,receiptCount:1,quoteNumber:null,status:'draft',requiresHumanValidation:true,nativeFrozenCreationVerified:true,auditChainValid:true},
  newStores:true,lostStoresRecovered:false,historicalPreparationRequests:0,writerActivityCount:1,secondStoreActivityCount:0,secondStoreExactCreation:true,reopenedBoth:true,g5Executed:false,g6Executed:false,mailExecuted:false});
const report = () => ({format:'zentra-a41-native-continuation-report-v1',sourceSha:source,binarySha256:binary,profileSha256:profile,coordinatorSha256:'5'.repeat(64),exactTest:CONTINUATION_TEST,
  account:account(),baselineEvent:baseline(),complete:complete(),sourceLifecycle:{campaignId:uuid(1),workspaceId:`support_${uuid(2)}`,connectionId:uuid(3),sourceId:uuid(6),sourceRevision:2,
    sourceEnvelopeSha256:'6'.repeat(64),historicalTicketSha256:'7'.repeat(64),existingConnectionReused:true,historicalTicketPreserved:true,settingsAndDelegationPreserved:true,
    actualHumanQuoteClassification:true,automaticSupportClassificationObserved:false,thirdPartyMailboxExecuted:false},
  nominalG4Passed:true,realDecisionProviderDirectlyAttested:false,serverSourceDirectlyAttested:false,fullSchedulerTested:false,g5Executed:false,g6Executed:false,mailExecuted:false,automaticCleanup:false});
const identity = () => ({source,pipelineId:uuid(30),workflowId:uuid(31),jobNumber:'313',nodeVersion:'v22.0.0'});
const hashes = () => Object.fromEntries(['entrypointSha256','profileCompilationProofSha256','continuationCoordinatorSha256','rustContinuationHarnessSha256',
  'rustContinuationAdapterSha256','rustParentHarnessSha256','rustCollaborationSupportSha256'].map(k=>[k,k==='continuationCoordinatorSha256'?'5'.repeat(64):'8'.repeat(64)]));
const regressions = () => ({format:'zentra-a41-native-session-regressions-v1',source,binarySha256:binary,tests:[...SESSION_REGRESSION_TESTS],passed:3,nativeExecuted:true});
const read = file => readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const sha = value => createHash('sha256').update(value).digest('hex');

test('same private context variables admit a closed continuation and retain separate Sites credential',()=>{
  const value=continuationInputFromEnvironment(environment(context()));
  assert.equal(value.format,'zentra-a41-continuation-input-v1');assert.equal(value.account.browserCookieHeader,cookie);
  assert.equal(value.account.sitesServiceToken,'S'.repeat(32));assert.equal(value.sourceSha,source);
  assert.throws(()=>continuationInputFromEnvironment({...environment(context()),[SECRET_NAMES[1]]:cookie}),{code:'continuation_context_required'});
  assert.throws(()=>continuationInputFromEnvironment({CIRCLE_SHA1:source}),{code:'continuation_context_required'});
  assert.deepEqual(SECRET_NAMES,['ZENTRA_A41_SITES_SERVICE_TOKEN','ZENTRA_A41_BROWSER_COOKIE_QA']);
});
test('unknown or malformed JSON never selects the virgin cookie path',()=>{
  for(const raw of ['{}','[]','{',' '+JSON.stringify(context()),JSON.stringify(context())+'\n',
    JSON.stringify(context()).replace('"format":','"format":"duplicate","format":')])
    assert.throws(()=>continuationInputFromEnvironment({...environment(context()),[SECRET_NAMES[1]]:raw}));
  for(const patch of [{format:'unknown'},{sourceSha:'e'.repeat(40)},{sitesServiceToken:'unrequested'},{plan:{ready:true}},{apiHookToken:'wrong'}])
    assert.throws(()=>continuationInputFromEnvironment(environment({...context(),...patch})));
  for(const field of Object.keys(context())){const value=context();delete value[field];assert.throws(()=>continuationInputFromEnvironment(environment(value)));}
});
test('compiler whitelist drops both private variables and all recipe run flags',()=>{
  const env={...environment(context()),ZENTRA_RUN_LIVE_G4_CONTINUATION:'true',ZENTRA_RUN_LIVE_ACCOUNT_RECIPE:'true',ZENTRA_RUN_LIVE_G4_RECIPE:'true'};
  const compiler=compileEnvironment(env);
  for(const name of [...SECRET_NAMES,'ZENTRA_RUN_LIVE_G4_CONTINUATION','ZENTRA_RUN_LIVE_ACCOUNT_RECIPE','ZENTRA_RUN_LIVE_G4_RECIPE'])assert.equal(Object.hasOwn(compiler,name),false);
  assert.throws(()=>assertG4CiAdmission({...env},'win32','22.0.0'));
});
test('a fully admitted CI environment still refuses an inherited continuation opt-in',()=>{
  const admitted={CIRCLECI:'true',OS:'Windows_NT',CIRCLE_JOB:'windows-action-live-account-tests',CIRCLE_BRANCH:'codex/action-engine-native-live-a41',
    CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',CIRCLE_SHA1:source,CIRCLE_BUILD_NUM:'313',CIRCLE_WORKFLOW_ID:uuid(30),ZENTRA_LIVE_PROFILE_PIPELINE_ID:uuid(31),
    ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',
    ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',RUSTUP_TOOLCHAIN:'stable-x86_64-pc-windows-msvc'};
  assert.doesNotThrow(()=>assertG4CiAdmission(admitted,'win32','22.0.0'));
  for(const value of ['true','false','1'])assert.throws(()=>assertG4CiAdmission({...admitted,ZENTRA_RUN_LIVE_G4_CONTINUATION:value},'win32','22.0.0'));
});
test('baseline scalars cannot be coerced from arrays or objects',()=>{
  assert.throws(()=>validateBaselineReceipt({...baseline().baseline,manifestSha256:['b'.repeat(64)]}));
  for(const field of ['customerId','articleId','resourcesSha256'])assert.throws(()=>validateContinuationBaseline({...baseline(),[field]:[baseline()[field]]},uuid(1)));
});
test('public continuation records actual baseline and explicitly excludes older ACK and unrun gates',()=>{
  const value=validatePublicContinuationReport(report(),source);
  assert.equal(value.baselineEvent.quoteBaselineCount,2);assert.equal(value.complete.quote.quoteCount,1);
  assert.equal(value.baselineEvent.baseline.historicalWriterAckClaimed,false);assert.equal(value.complete.historicalPreparationRequests,0);
  for(const field of ['g5Executed','g6Executed','mailExecuted','fullSchedulerTested','serverSourceDirectlyAttested'])assert.equal(value[field],false);
  for(const field of ['g5Executed','g6Executed','mailExecuted','fullSchedulerTested','serverSourceDirectlyAttested','realDecisionProviderDirectlyAttested','automaticCleanup'])
    assert.throws(()=>validatePublicContinuationReport({...report(),[field]:true},source));
});
test('public report refuses omitted fields, private extras and cross-binary/source/campaign/old-proposal drift',()=>{
  for(const field of Object.keys(report())){const value=report();delete value[field];assert.throws(()=>validatePublicContinuationReport(value,source));}
  for(const selector of [v=>v,v=>v.baselineEvent,v=>v.baselineEvent.baseline,v=>v.sourceLifecycle,v=>v.complete,v=>v.complete.quote]){
    const value=report();selector(value).sitesServiceToken='synthetic';assert.throws(()=>validatePublicContinuationReport(value,source));
  }
  for(const change of [v=>{v.account.binarySha256='b'.repeat(64);},v=>{v.sourceSha='b'.repeat(40);},v=>{v.sourceLifecycle.campaignId=uuid(80);},
    v=>{v.complete.quote.proposalId=BASELINE.proposalId;},v=>{v.sourceLifecycle.sourceId=BASELINE.sourceId;},v=>{v.complete.canonicalPublication.baseRevision=0;},
    v=>{v.baselineEvent.consentRevisions=[0,1];},v=>{v.complete.quote.fingerprint=[v.complete.quote.fingerprint];},v=>{v.complete.canonicalPublication.snapshotId=[uuid(8)];}]){
    const value=report();change(value);assert.throws(()=>validatePublicContinuationReport(value,source));
  }
});
test('separate CI proof ties source/binary/hash and never asserts scheduler, G5, G6 or product availability',()=>{
  const value=publicContinuationCiProof(report(),identity(),hashes(),regressions());
  assert.equal(value.format,'zentra-a41-native-continuation-ci-public-v1');assert.equal(value.claims.newSourceNominalG4Validated,true);
  for(const field of ['fullSchedulerTested','g5FailureMatrixExecuted','g6FullServiceParityEstablished','autopilotProductActivated','lostStoresRecovered'])assert.equal(value.claims[field],false);
  for(const patch of [{continuationCoordinatorSha256:'9'.repeat(64)},{cookie:'synthetic'}])assert.throws(()=>publicContinuationCiProof(report(),identity(),{...hashes(),...patch},regressions()));
  assert.throws(()=>publicContinuationCiProof(report(),identity(),hashes(),{...regressions(),binarySha256:'9'.repeat(64)}));
});
test('virgin CI body is byte preserved after removing only explicit continuation and G5 dispatch lines',()=>{
  const source=read('./verify-action-live-g4-ci-windows.mjs');
  const addition='  const g5 = g5InputFromEnvironment(process.env);\n  if (g5 !== null) return runDedicatedG5Ci(g5);\n  const continuation = continuationInputFromEnvironment(process.env);\n  return runDedicatedContinuationCi(continuation);\n';
  const body=source.slice(source.indexOf('export async function runDedicatedG4Ci()'),source.indexOf('\n// Separate test-only branch;'));
  assert.equal(body.split(addition).length,2);
  assert.equal(sha(body.replace(addition,'')),'9bbe9166345de4b4b61743080cce7bfa8da6a200735d69443067e9dfc79a5e36');
});
test('continuation branch admits tracked sources before compilation and sets only its distinct opt-in afterwards',()=>{
  const source=read('./verify-action-live-g4-ci-windows.mjs');
  const body=source.slice(source.indexOf('async function runDedicatedContinuationCi'));
  assert.ok(body.indexOf('delete process.env[name]')<body.indexOf('tracked();'));
  assert.ok(body.indexOf('tracked();')<body.indexOf('captureTauriSchemaReconciliation(environment)'));
  assert.ok(body.indexOf('await compileFreshSource(environment)')<body.indexOf('schemas.reconcile()'));
  assert.ok(body.indexOf('schemas.reconcile()')<body.indexOf("process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true'"));
  assert.ok(body.indexOf('await runLiveSessionRegressions()')<body.indexOf("process.env[CONTINUATION_FLAG] = 'true'"));
  assert.ok(body.indexOf("process.env[CONTINUATION_FLAG] = 'true'")<body.indexOf('await runLiveG4Continuation(input)'));
  assert.doesNotMatch(body,/runLiveG4Recipe\(|ZENTRA_RUN_LIVE_G4_RECIPE\s*=/);
  assert.match(body,/for \(const name of \[\.\.\.RUN_FLAGS, CONTINUATION_FLAG\]\) delete process\.env\[name\]/);
  assert.match(body,/native-continuation-report\.public\.json/);
  const required=source.slice(source.indexOf('const CONTINUATION_FILES'),source.indexOf('const OUTPUT'));
  for(const file of ['verify-action-live-g4-continuation.mjs','verify-action-live-g4-continuation-ci.test.mjs','account_cloud_action_engine_continuation_support.rs','account_cloud_live_a41_g4_continuation_tests.rs'])assert.ok(required.includes(file));
});
