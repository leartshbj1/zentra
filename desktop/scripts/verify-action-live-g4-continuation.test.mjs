// Pure mocked transport/codec/source contracts. No native, Git subprocess,
// credentials, cloud or genuine business admission is exercised by this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BASELINE,CONTINUATION_TEST,CONTINUATION_STEPS,DESCRIPTION,validateContinuationInput,assertContinuationAdmission,
  validateBaselineReceipt,validateHistoricalReview,validateContinuationBaseline,validateContinuationComplete,validateContinuationReview,
  validateContinuationSupportState,makeContinuationSource,continuationFailureCode,validateContinuationDiagnostic } from './verify-action-live-g4-continuation.mjs';
globalThis.fetch=async()=>{throw new Error('PURE_CONTINUATION_NETWORK_DISABLED');};
const OWNER='1f0d9981-607b-4848-9374-587035cdfd89',ORG='org_trial_345a3d1f68056cf7e709d4af4fc229a4';
const profile='2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf';
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const SITE='https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site';
const input=()=>({format:'zentra-a41-continuation-input-v1',sourceSha:'1'.repeat(40),campaignId:uuid(1),workspaceId:`support_${uuid(2)}`,connectionId:uuid(3),
  apiHookToken:`zsup_${'A'.repeat(43)}`,account:{format:'zentra-a41-native-account-input-v1',sitesServiceToken:'S'.repeat(32),
    browserCookieHeader:`__Host-zentra_access=synthetic; __Host-zentra_refresh=synthetic; __Host-zentra_session_owner=${OWNER}`,expectedOwnerId:OWNER,expectedOrganizationId:ORG}});
const historical=()=>({proposalId:BASELINE.proposalId,sourceId:BASELINE.sourceId,createdAt:1,disposition:'needs_review',reasons:['low_confidence'],requiresHumanValidation:true});
const baseline=()=>({event:'baseline',campaignId:uuid(1),baseline:{snapshotId:BASELINE.snapshotId,revision:1,archiveSha256:BASELINE.archiveSha256,
  manifestSha256:'a'.repeat(64),sizeBytes:100,transport:'content-v1',receivedBoth:true,historicalWriterAckClaimed:false,historicalGatewayFactClaimed:false},
  historicalReview:historical(),customerId:uuid(4),articleId:uuid(5),resourcesSha256:'b'.repeat(64),quoteBaselineCount:0,receiptBaselineCount:0,consentRevisions:[1,1]});
const oldTicket=()=>({id:BASELINE.sourceId,connectionId:uuid(3),externalId:'old-fictitious-source',subject:'old subject',body:'old body',senderEmail:'camille-a41@example.invalid',revision:2,state:'ready',decision:{category:'quote',manual:true},automatic:false});
const support=()=>({workspaces:[{id:`support_${uuid(2)}`,role:'owner'}],workspace:{id:`support_${uuid(2)}`,role:'owner',canManage:true,name:'QA',mode:'review',threshold:85},
  billing:{active:true,status:'active',hasSubscription:true,ownerAccess:false,offeredAccess:false,bundlePlan:'Complet Solo'},
  gestion:{organizationId:ORG,role:'owner',linked:true,autoPost:false},automation:{active:true,enabled:false},
  connections:[{id:uuid(3),provider:'api',active:true,hookUrl:`${SITE}/api/support/hooks/${uuid(3)}`}],tickets:[oldTicket()],focusedTicket:null,hasMore:false});
const env=()=>({CIRCLECI:'true',CIRCLE_BRANCH:'codex/action-engine-native-live-a41',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',CIRCLE_SHA1:'1'.repeat(40),CIRCLE_BUILD_NUM:'312',
  ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',
  ZENTRA_LIVE_PROFILE_RELEASE:'false',ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',ZENTRA_RUN_LIVE_ACCOUNT_RECIPE:'true',ZENTRA_RUN_LIVE_G4_CONTINUATION:'true'});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const refuse=fn=>assert.throws(fn);
function sourceMock(mutate=()=>{},expectedBody=/3 pièces.*A41-RAD-100/){
  const calls=[];let ticket,approved=false;
  return {calls,async fetcher(url,options){
    const body=options.body?JSON.parse(options.body):null;calls.push({url:String(url),options,body});
    assert.equal(new URL(url).origin,SITE);assert.equal(options.redirect,'error');
    if(new URL(url).pathname==='/api/auth/session')return response({authenticated:true,user:{id:OWNER,emailConfirmed:true}});
    if(new URL(url).pathname.startsWith('/api/support/hooks/')){
      ticket={id:uuid(6),connectionId:uuid(3),externalId:body.ticketId,subject:body.subject,body:body.body,senderEmail:body.senderEmail,revision:1,state:'pending',decision:null,automatic:false};
      assert.match(body.body,expectedBody);return response({ticket},202);
    }
    if(body){assert.equal(body.action,'approve');assert.equal(body.ticketId,uuid(6));assert.equal(body.revision,1);approved=true;return response({saved:true});}
    const state=support();if(ticket){const saved={...ticket,...(approved?{revision:2,state:'ready',decision:{category:'quote',manual:true}}:{})};state.tickets.push(saved);state.focusedTicket=saved;}
    mutate(state,!!ticket);return response(state);
  }};
}
test('default description is inactive and names only the distinct continuation test',()=>{
  assert.equal(DESCRIPTION.inactiveByDefault,true);assert.equal(DESCRIPTION.exactTest,CONTINUATION_TEST);
  for(const key of ['rotatesToken','createsConnection','changesConsent','resetsHead','replaysHistoricalPreparation','compilesNative','g5Executed','g6Executed','mailExecuted'])assert.equal(DESCRIPTION[key],false);
});
test('input is closed and cannot choose an origin, old source, provider, plan or baseline',()=>{
  assert.ok(Object.isFrozen(validateContinuationInput(input())));
  for(const key of ['url','sourceId','baseline','provider','plan','ready','rotateHook'])refuse(()=>validateContinuationInput({...input(),[key]:true}));
  for(const patch of [{apiHookToken:'wrong'},{campaignId:'not-uuid'},{connectionId:'https://evil.test'},{sourceSha:'a'.repeat(64)}])refuse(()=>validateContinuationInput({...input(),...patch}));
  let read=false;const getter={...input()};Object.defineProperty(getter,'apiHookToken',{enumerable:true,get(){read=true;return input().apiHookToken;}});
  refuse(()=>validateContinuationInput(getter));assert.equal(read,false);
});
test('opt-in refuses wrong platforms, missing flags and the virgin recipe',()=>{
  assert.doesNotThrow(()=>assertContinuationAdmission(env(),'win32'));
  refuse(()=>assertContinuationAdmission(env(),'linux'));
  for(const patch of [{ZENTRA_RUN_LIVE_G4_CONTINUATION:'false'},{ZENTRA_RUN_LIVE_G4_RECIPE:'true'},{CIRCLE_BRANCH:'main'}])refuse(()=>assertContinuationAdmission({...env(),...patch},'win32'));
});
test('runner places mandatory admission before executable, Git or HTTP dependencies',()=>{
  refuse(()=>assertContinuationAdmission({},'win32'));
  const source=readFileSync(new URL('./verify-action-live-g4-continuation.mjs',import.meta.url),'utf8');
  const runner=source.slice(source.indexOf('export async function runLiveG4Continuation'));
  assert.ok(runner.indexOf('assertContinuationAdmission(env)')<runner.indexOf('await verifiedHarness'));
  assert.ok(runner.indexOf('await verifiedHarness')<runner.indexOf('await runLiveAccountRecipe'));
});
test('received baseline cannot claim the old writer ACK or historical PG fact',()=>{
  assert.deepEqual(validateBaselineReceipt(baseline().baseline),baseline().baseline);
  for(const patch of [{revision:0},{snapshotId:uuid(20)},{archiveSha256:'c'.repeat(64)},{historicalWriterAckClaimed:true},{historicalGatewayFactClaimed:true},{gatewayPgFactAndD1Committed:true}])
    refuse(()=>validateBaselineReceipt({...baseline().baseline,...patch}));
});
test('historical low-confidence review remains exact and separate from the new quote',()=>{
  assert.deepEqual(validateHistoricalReview(historical()),historical());
  for(const patch of [{sourceId:uuid(6)},{proposalId:uuid(7)},{reasons:[]},{disposition:'ready'},{confidence:0.95}])refuse(()=>validateHistoricalReview({...historical(),...patch}));
});
test('native baseline binds the campaign, real resources and existing consent revisions',()=>{
  assert.equal(validateContinuationBaseline(baseline(),uuid(1)).campaignId,uuid(1));
  for(const patch of [{campaignId:uuid(9)},{consentRevisions:[0,1]},{quoteBaselineCount:-1},{resourcesSha256:'bad'}])refuse(()=>validateContinuationBaseline({...baseline(),...patch},uuid(1)));
});
test('existing QA connection is required; unrelated/partial campaigns refuse before mutation',()=>{
  assert.equal(validateContinuationSupportState(support(),input()).oldTicket.id,BASELINE.sourceId);
  for(const mutate of [s=>s.hasMore=true,s=>s.connections[0].active=false,s=>s.connections[0].provider='infomaniak',s=>s.connections[0].hookUrl='https://example.test/hook',s=>s.tickets[0].externalId=`a41-continuation-${uuid(1)}`,s=>s.billing.ownerAccess=true]){
    const state=support();mutate(state);refuse(()=>validateContinuationSupportState(state,input()));
  }
});
test('source lifecycle uses only existing hook and normal human approve, preserving settings and old ticket',async()=>{
  const mock=sourceMock(),source=makeContinuationSource(input(),{fetcher:mock.fetcher,admit:()=>{}});
  assert.deepEqual(await source.provision(baseline()),{sourceId:uuid(6)});
  const mutations=mock.calls.filter(c=>c.body);assert.equal(mutations.length,2);
  assert.equal(new URL(mutations[0].url).pathname,`/api/support/hooks/${uuid(3)}`);assert.equal(mutations[1].body.action,'approve');
  assert.equal(mutations[0].options.headers.authorization,`Bearer ${input().apiHookToken}`);
  assert.equal(mutations[1].options.headers.authorization,undefined);
  const proof=source.publicProof();assert.equal(proof.existingConnectionReused,true);assert.equal(proof.historicalTicketPreserved,true);
  assert.equal(proof.sourceId,uuid(6));assert.equal(proof.thirdPartyMailboxExecuted,false);
  assert.ok(!JSON.stringify(proof).includes(input().apiHookToken));assert.ok(!JSON.stringify(proof).includes(input().account.sitesServiceToken));
});
test('source template is a closed local choice and cannot enter the private JSON contract',()=>{
  let calls=0;const fetcher=async()=>{calls++;throw Error('synthetic');};
  for(const sourceTemplate of ['en','https://example.test','Please quote 3 items',null,()=>{},['en-g5-v1'],{toString:()=> 'en-g5-v1'}])
    refuse(()=>makeContinuationSource(input(),{admit:()=>{},fetcher,sourceTemplate}));
  refuse(()=>validateContinuationInput({...input(),sourceTemplate:'en-g5-v1'}));
  assert.equal(calls,0);
});
test('default continuation retains its exact French envelope and hash',async()=>{
  const mock=sourceMock(),source=makeContinuationSource(input(),{fetcher:mock.fetcher,admit:()=>{}});
  await source.provision(baseline());
  const envelope=mock.calls.find(call=>new URL(call.url).pathname.startsWith('/api/support/hooks/')).body;
  assert.deepEqual(envelope,{ticketId:`a41-continuation-${uuid(1)}`,subject:`Devis Radiateur A41 — ${uuid(1)}`,
    body:'Bonjour, pour Camille Recette A41, merci de préparer un devis pour 3 pièces de Radiateur A41, référence A41-RAD-100. Merci.',
    senderEmail:'camille-a41@example.invalid',senderName:'Camille Recette A41',version:`a41-continuation-${uuid(1)}`});
  assert.equal(source.publicProof().sourceEnvelopeSha256,createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
});
test('G5 English template changes only subject and body, with exact SKU, envelope hash and one source attempt',async()=>{
  const mock=sourceMock(()=>{},/^Please prepare a new quotation for 3 pieces of Radiateur A41, SKU A41-RAD-100\. Thank you\.$/),
    source=makeContinuationSource(input(),{fetcher:mock.fetcher,admit:()=>{},sourceTemplate:'en-g5-v1'});
  await source.provision(baseline());
  const envelope=mock.calls.find(call=>new URL(call.url).pathname.startsWith('/api/support/hooks/')).body;
  assert.deepEqual(envelope,{ticketId:`a41-continuation-${uuid(1)}`,subject:`Quotation request: 3 radiators A41-RAD-100 — ${uuid(1)}`,
    body:'Please prepare a new quotation for 3 pieces of Radiateur A41, SKU A41-RAD-100. Thank you.',
    senderEmail:'camille-a41@example.invalid',senderName:'Camille Recette A41',version:`a41-continuation-${uuid(1)}`});
  assert.equal(source.publicProof().sourceEnvelopeSha256,createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
  assert.deepEqual(mock.calls.filter(call=>call.body).map(call=>call.body.action??'hook'),['hook','approve']);
  const count=mock.calls.length;await assert.rejects(source.provision(baseline()),/continuation_source_attempt_already_used/);assert.equal(mock.calls.length,count);
  const g5=readFileSync(new URL('./verify-action-live-g5-windows.mjs',import.meta.url),'utf8'),old=readFileSync(new URL('./verify-action-live-g4-continuation.mjs',import.meta.url),'utf8');
  assert.equal((g5.match(/sourceTemplate:'en-g5-v1'/g)||[]).length,1);
  assert.doesNotMatch(old.slice(old.indexOf('export async function runLiveG4Continuation')),/sourceTemplate/);
});
test('unknown source response is never retried or replaced with a fresh source',async()=>{
  let calls=0;const source=makeContinuationSource(input(),{admit:()=>{},fetcher:async()=>{calls++;throw Error('synthetic private error');}});
  await assert.rejects(source.provision(baseline()),/continuation_source_network_failed/);const count=calls;
  await assert.rejects(source.provision(baseline()),/continuation_source_attempt_already_used/);assert.equal(calls,count);
});
test('campaign already present refuses before any POST and no settings compensation is attempted',async()=>{
  const mock=sourceMock(state=>{state.tickets[0].externalId=`a41-continuation-${uuid(1)}`;}),source=makeContinuationSource(input(),{fetcher:mock.fetcher,admit:()=>{}});
  await assert.rejects(source.provision(baseline()),/continuation_campaign_already_exists/);assert.equal(mock.calls.filter(c=>c.body).length,0);
});
test('post-ingress state drift fails without mutating link, settings or historical ticket',async()=>{
  const mock=sourceMock((state,created)=>{if(created)state.tickets[0].revision++;}),source=makeContinuationSource(input(),{fetcher:mock.fetcher,admit:()=>{}});
  await assert.rejects(source.provision(baseline()),/continuation_existing_state_changed/);
  assert.deepEqual(mock.calls.filter(c=>c.body).map(c=>c.body.action??'hook'),['hook','approve']);
});
test('new review outcome can never pass the nominal complete validator',()=>{
  const event={event:'new-source-review',historicalReviewPreserved:true,newSourceId:uuid(6),newProposalId:uuid(7),reasons:['low_confidence'],nominalG4Passed:false};
  assert.equal(validateContinuationReview(event,uuid(6)).nominalG4Passed,false);
  refuse(()=>validateContinuationReview({...event,nominalG4Passed:true},uuid(6)));refuse(()=>validateContinuationReview({...event,newProposalId:BASELINE.proposalId},uuid(6)));
  refuse(()=>validateContinuationComplete(event,baseline(),uuid(6)));
});
test('failure receipts expose only fixed codes and metadata, never raw errors or caller content',()=>{
  const raw={code:'g4_pipe_private_secret',message:'synthetic private message',stack:'synthetic stack'};
  assert.equal(continuationFailureCode(raw),'continuation_validation_refused');
  let read=false;assert.equal(continuationFailureCode({get code(){read=true;return 'g4_pipe_eof';}}),'continuation_validation_refused');assert.equal(read,false);
  const value={format:'zentra-a41-continuation-diagnostic-v1',sourceSha:'1'.repeat(40),binarySha256:'a'.repeat(64),profileSha256:profile,passed:false,nominalG4Passed:false,
    outcome:'failed',code:'continuation_validation_refused',checkpointsSeen:3,historicalReviewPreserved:null,g5Executed:false,g6Executed:false,mailExecuted:false};
  assert.equal(validateContinuationDiagnostic(value).passed,false);
  for(const patch of [{message:raw.message},{code:raw.code},{g5Executed:true},{historicalReviewPreserved:true},{checkpointsSeen:8}])refuse(()=>validateContinuationDiagnostic({...value,...patch}));
});
const complete=()=>({event:'complete',profileSha256:profile,organizationId:ORG,campaignId:uuid(1),baseline:baseline().baseline,historicalReview:historical(),
  canonicalPublication:{snapshotId:uuid(8),baseRevision:1,revision:2,archiveSha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),sizeBytes:200,transport:'content-v1',gatewayPgFactAndD1Committed:true},
  quote:{sourceId:uuid(6),proposalId:uuid(7),reservationId:uuid(9),fingerprint:'e'.repeat(64),quoteId:uuid(10),customerId:uuid(4),articleId:uuid(5),receiptSha256:'f'.repeat(64),lineIds:[uuid(11)],quoteCount:1,receiptCount:1,quoteNumber:null,status:'draft',requiresHumanValidation:true,nativeFrozenCreationVerified:true,auditChainValid:true},
  newStores:true,lostStoresRecovered:false,historicalPreparationRequests:0,writerActivityCount:1,secondStoreActivityCount:0,secondStoreExactCreation:true,reopenedBoth:true,g5Executed:false,g6Executed:false,mailExecuted:false});
test('only new revision2 publication, exact quote and new-writer ACK can complete nominal G4',()=>{
  assert.equal(validateContinuationComplete(complete(),baseline(),uuid(6)).quote.sourceId,uuid(6));
  for(const patch of [{historicalPreparationRequests:1},{lostStoresRecovered:true},{secondStoreActivityCount:1},{g5Executed:true},{g6Executed:true},{mailExecuted:true}])refuse(()=>validateContinuationComplete({...complete(),...patch},baseline(),uuid(6)));
  const old=complete();old.quote.proposalId=BASELINE.proposalId;refuse(()=>validateContinuationComplete(old,baseline(),uuid(6)));
});
test('Rust registration is test-only and the virgin scenario body is untouched by the child declaration',()=>{
  const root=new URL('../src-tauri/src/',import.meta.url),read=name=>readFileSync(new URL(name,root),'utf8');
  const parent=read('account_cloud_live_a41_g4_tests.rs'),adapter=read('account_cloud_action_engine_continuation_support.rs'),rust=read('account_cloud_live_a41_g4_continuation_tests.rs'),consumer=read('account_cloud_action_engine.rs');
  assert.match(parent,/#\[path = "account_cloud_live_a41_g4_continuation_tests.rs"\]\s*mod continuation;/);
  assert.match(consumer,/#\[cfg\(all\(test, windows\)\)\]\s*#\[path = "account_cloud_action_engine_continuation_support.rs"\]/);
  assert.match(rust,/#\[ignore = "Explicit populated A41 continuation/);
  assert.ok(rust.includes('fn populated_head_new_source_across_two_new_native_stores()'));
  assert.match(adapter,/source == HISTORICAL_SOURCE/);assert.equal((adapter.match(/preparation_request\(source\)/g)||[]).length,1);
  assert.match(adapter,/execute_quote_draft_at\(store, &original, selected, body, Some\(&prepared\.fingerprint\)\)/);
  assert.doesNotMatch(rust,/\b(?:paid_consent|seed|publish_initial|require_fresh_remote|round)\s*\(/);
  assert.doesNotMatch(adapter,/decide|createQuote|synthetic|provider.*with|\.decide/);
  assert.match(rust,/"historicalWriterAckClaimed":false,"historicalGatewayFactClaimed":false/);
  assert.equal((rust.match(/canonical\.public_proof\(\)/g)||[]).length,1);assert.doesNotMatch(rust,/head\.public_proof\(\)/);
  assert.equal(CONTINUATION_STEPS.length,7);for(const {step,index} of CONTINUATION_STEPS)assert.ok(rust.includes(`pipe.checkpoint("${step}",${index})?;`));
});
test('no new provider/threshold/connection mutation or product-gate path exists in coordinator',()=>{
  const source=readFileSync(new URL('./verify-action-live-g4-continuation.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/action:'(?:connect|rotateHook|settings|linkGestion|retry)'|runLiveG4Recipe\(|paid_consent\(|publish_initial\(|seed\(/);
  assert.match(source,/--exact','--ignored','--test-threads=1/);assert.match(source,/await channel\.finalize\(\)/);assert.match(source,/channel\.assertTerminal\(\)/);
  assert.match(source,/continuation_new_test_required_before_enrollment/);assert.match(source,/continuation_sources_must_be_tracked/);
  assert.match(source,/fullSchedulerTested:false,g5Executed:false,g6Executed:false,mailExecuted:false/);
});
