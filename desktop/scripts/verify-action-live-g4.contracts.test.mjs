// Local PURE contracts. Imports do not run the recipe or any HTTP/native child.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertFutureCiAdmission, validatePublication, validateQuote, validateComplete, validateSourceProof, DESCRIPTION, G4_CHECKPOINTS }
  from './verify-action-live-g4-windows.mjs';
import { requirePaidA41Workspace, makeRealApiSupportSource } from './live-g4-api-support-source.mjs';
// Manual pure contracts: no recipe entrypoint, native child, Cargo or real HTTP.
// This test is never wired into the secret-bearing CI job. Refuse any private
// context environment before fixtures can snapshot process.env or install mocks.
for (const name of ['ZENTRA_A41_SITES_SERVICE_TOKEN', 'ZENTRA_A41_BROWSER_COOKIE_QA']) {
  if (Object.hasOwn(process.env, name)) throw new Error('PURE_CONTRACTS_REFUSE_PRIVATE_ENVIRONMENT');
}
globalThis.fetch = async () => { throw new Error('PURE_CONTRACTS_NETWORK_DISABLED'); };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Public source pins calculated from the A50/91a Git objects. Only the two
// future test-only module declarations may differ in the integration copy.
const baselineSource = '91a859eefb3ecc88716e34d77b3aa9f91a412e8c';
const baselinePins = {
  'desktop/src-tauri/src/account_cloud.rs': '9d8d4cd86e30da0070864a51ce7c0a84cebf5220835d0fae82752e5ae9d339d9',
  'desktop/src-tauri/src/company_collaboration.rs': '2772b6bd498b57187b6753d2b074c501e0c0e035c7463d2b16146e2c2d302fee',
};
let checks = 0;
const ok = fn => { fn(); checks++; };
const no = fn => { assert.throws(fn); checks++; };
ok(() => assert.equal(DESCRIPTION.createsInfrastructure,false));
ok(() => assert.equal(DESCRIPTION.createsSupportTestData,true));
ok(() => assert.equal(Object.hasOwn(DESCRIPTION,'createsCloudResources'),false));
const env = { CIRCLECI:'true',CIRCLE_BRANCH:'codex/action-engine-native-live-a41',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',
  ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',
  ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',
  ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',ZENTRA_RUN_LIVE_ACCOUNT_RECIPE:'true',ZENTRA_RUN_LIVE_G4_RECIPE:'true',
  CIRCLE_SHA1:'f'.repeat(40),CIRCLE_BUILD_NUM:'999' };
ok(() => assertFutureCiAdmission(env,'win32'));
for (const key of Object.keys(env)) { const missing = {...env}; delete missing[key]; no(() => assertFutureCiAdmission(missing,'win32'));
  no(() => assertFutureCiAdmission({...env,[key]:'invalid'},'win32')); }
for (const source of DESCRIPTION.historicalSourcesRefused) no(() => assertFutureCiAdmission({...env,CIRCLE_SHA1:source},'win32'));
no(() => assertFutureCiAdmission(env,'linux'));
const initial = { snapshotId:randomUUID(),baseRevision:0,revision:1,archiveSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),
  sizeBytes:12345,transport:'content-v1',gatewayPgFactAndD1Committed:true };
const canonical = {...initial,snapshotId:randomUUID(),baseRevision:1,revision:2,archiveSha256:'c'.repeat(64),manifestSha256:'d'.repeat(64)};
const seed = { publication:validatePublication(initial),sourceId:randomUUID(),customerId:randomUUID(),articleId:randomUUID() };
const quote = { sourceId:seed.sourceId,proposalId:randomUUID(),reservationId:randomUUID(),fingerprint:'e'.repeat(64),quoteId:randomUUID(),
  customerId:seed.customerId,articleId:seed.articleId,receiptSha256:'f'.repeat(64),lineIds:[randomUUID()],quoteCount:1,receiptCount:1,
  quoteNumber:null,status:'draft',requiresHumanValidation:true,nativeFrozenCreationVerified:true,auditChainValid:true };
const complete = { event:'complete',profileSha256:DESCRIPTION.profileSha256,organizationId:'org_trial_345a3d1f68056cf7e709d4af4fc229a4',
  initialPublication:initial,canonicalPublication:canonical,quote,secondStoreExactCreation:true,secondRoundConfirmed:0,
  writerActivityCount:1,secondStoreActivityCount:0,strictMeHttp200Both:true,automaticCleanup:false };
const sourceProof = { workspaceId:randomUUID(),connectionId:randomUUID(),sourceId:seed.sourceId,sourceRevision:2,
  sourceEnvelopeSha256:'a'.repeat(64),actualApiHookPersisted:true,actualHumanQuoteClassification:true,actualGestionDelegation:true,
  automaticSupportClassificationExecuted:false,thirdPartyMailboxExecuted:false };
ok(() => validatePublication(initial)); ok(() => validateQuote(quote,seed)); ok(() => validateComplete(complete,seed)); ok(() => validateSourceProof(sourceProof));
const supportId = `support_${randomUUID()}`;
ok(() => validateSourceProof({...sourceProof, workspaceId:supportId}));
for (const value of ['', 'support_', `support_support_${randomUUID()}`, `support_${randomUUID()}x`, 'other_'+randomUUID(), 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '11111111-1111-1111-8111-111111111111', 123]) {
  no(() => validateSourceProof({...sourceProof, workspaceId:value}));
}
no(() => validateSourceProof({...sourceProof, connectionId:supportId}));
no(() => validateSourceProof({...sourceProof, organizationId:'other-tenant'}));
const workspace = {workspaces:[{id:supportId,role:'owner'}],workspace:{id:supportId,role:'owner',canManage:true},
  billing:{active:true,status:'active',hasSubscription:true,ownerAccess:false,offeredAccess:false,bundlePlan:'Solo',testMode:false,ready:false},
  gestion:{organizationId:complete.organizationId,role:'owner',linked:true,autoPost:false},automation:{active:true,enabled:false},
  tickets:[],connections:[],focusedTicket:null,hasMore:false,counts:{total:0}};
ok(() => assert.equal(requirePaidA41Workspace(workspace,undefined,true,true),supportId));
ok(() => requirePaidA41Workspace({...workspace,automation:{active:true,enabled:true}},supportId,true,true));
ok(() => requirePaidA41Workspace({...workspace,gestion:{...workspace.gestion,linked:false},automation:{active:false,enabled:false}},supportId,false,true));
for (const patch of [{workspaces:[]},{workspaces:[...workspace.workspaces,...workspace.workspaces]},
  {workspaces:[{id:supportId,role:'admin'}]},{workspace:{...workspace.workspace,id:randomUUID()}},
  {workspace:{...workspace.workspace,role:'admin'}},{workspace:{...workspace.workspace,canManage:false}},
  {gestion:{...workspace.gestion,organizationId:'other-tenant'}},{gestion:{...workspace.gestion,role:'admin'}},
  {gestion:{...workspace.gestion,autoPost:true}},{gestion:{...workspace.gestion,linked:false}},
  {billing:{...workspace.billing,active:false}},{billing:{...workspace.billing,status:'trialing'}},
  {billing:{...workspace.billing,hasSubscription:false}},{billing:{...workspace.billing,ownerAccess:true}},
  {billing:{...workspace.billing,offeredAccess:true}},{billing:{...workspace.billing,bundlePlan:''}},
  {automation:{active:false,enabled:false}},{automation:{active:true,enabled:'false'}},
  {tickets:[{id:randomUUID()}]},{connections:[{id:randomUUID()}]},{focusedTicket:{}},{hasMore:true},{counts:{total:1}}]) {
  no(() => requirePaidA41Workspace({...workspace,...patch},supportId,true,true));
}
no(() => requirePaidA41Workspace(workspace,randomUUID(),true,true));
no(() => requirePaidA41Workspace({...workspace,gestion:{...workspace.gestion,linked:false},automation:{active:false,enabled:true}},supportId,false));
for (const [value,validator] of [[initial,validatePublication],[quote,x=>validateQuote(x,seed)],[complete,x=>validateComplete(x,seed)],[sourceProof,validateSourceProof]]) {
  for (const key of Object.keys(value)) { const bad=structuredClone(value); delete bad[key]; no(()=>validator(bad)); }
  for (const field of ['sitesServiceToken','cookie','sessionSha256','deviceCode','licenseToken','rootDir','providerResult']) no(()=>validator({...value,[field]:'PRIVATE-SYNTHETIC-NEVER-USED'}));
}
for (const patch of [{gatewayPgFactAndD1Committed:false},{revision:0},{revision:2},{transport:'storage-v0'},{sizeBytes:0},{manifestSha256:'x'.repeat(64)}]) no(()=>validatePublication({...initial,...patch}));
for (const patch of [{quoteCount:2},{receiptCount:0},{quoteNumber:'D-1'},{status:'issued'},{requiresHumanValidation:false},{auditChainValid:false},
  {sourceId:randomUUID()},{customerId:randomUUID()},{articleId:randomUUID()},{lineIds:[]},{lineIds:[quote.lineIds[0],quote.lineIds[0]]}]) no(()=>validateQuote({...quote,...patch},seed));
for (const patch of [{canonicalPublication:initial},{secondStoreExactCreation:false},{secondRoundConfirmed:1},{writerActivityCount:0},
  {secondStoreActivityCount:1},{strictMeHttp200Both:false},{automaticCleanup:true}]) no(()=>validateComplete({...complete,...patch},seed));
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const rust = read('desktop/src-tauri/src/account_cloud_live_a41_g4_tests.rs');
const bridge = read('desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs');
const coordinator = read('desktop/scripts/verify-action-live-g4-windows.mjs');
const source = read('desktop/scripts/live-g4-api-support-source.mjs');
ok(()=>assert(rust.includes('#[ignore = ') && rust.includes('fn canonical_quote_round_across_two_native_stores()')));
ok(()=>assert(rust.indexOf('closed_guard()?;') < rust.indexOf('LocalStore::initialize(')));
ok(()=>assert(rust.indexOf('let consent_b = paid_consent(&b).await?;') < rust.indexOf('let (customer, article) = seed(&a)?;')
  && rust.indexOf('collaboration::require_fresh_remote(&a)') < rust.indexOf('let (customer, article) = seed(&a)?;')));
ok(()=>assert(rust.indexOf('collaboration::publish_initial(&a)') < rust.indexOf('if round(&a, &mut pipe, 0).await? != 1')));
ok(()=>assert(rust.includes('begin_quote_work_round(store)') && rust.includes('advance_quote_work_round(store, &mut round)')));
for(const fragment of ['frozen_quote_publication_matches','read_action_engine_quote_activity','corroborate_writer(&a','receive_exact(&b','strict_account(&b'])ok(()=>assert(rust.includes(fragment)));
for(const fragment of ['prepare_for_send_worker','send(store, &session, true, true)','"action":"recover-publication"','reply["known"] != true','reply["committed"] != true','require_archive_content','download(store, &session, &head)','apply(&owned'])ok(()=>assert(bridge.includes(fragment)));
for(const text of [rust,bridge])for(const banned of ['.execute(','.execute_batch(','configure_test_license_key(','install_server_issued_license(','println!(','dbg!(','assert_eq!(','advance_quote_work_round_with(','send_with('])ok(()=>assert(!text.includes(banned),banned));
for (const [file, declaration] of [
  ['desktop/src-tauri/src/account_cloud.rs', '#[cfg(all(test, windows))]\n#[path = "account_cloud_live_a41_g4_tests.rs"]\nmod live_a41_g4_tests;\n\n'],
  ['desktop/src-tauri/src/company_collaboration.rs', '#[cfg(all(test, windows))]\n#[path = "company_collaboration_live_a41_g4_support.rs"]\npub(crate) mod live_a41_g4_support;\n\n'],
]) {
  let declared = read(file).replace(/\r\n/g,'\n');
  if(file==='desktop/src-tauri/src/account_cloud.rs') {
    // Preserve the historical body/hash after projecting only the three fixed
    // product read/CAS routes, exactly as the independent CI contract does.
    for(const route of ['quote-consent','quote-activity','quote-review']) {
      const addition=`            | "/api/account/automation/${route}"\n`;
      ok(()=>assert.equal(declared.split(addition).length,2));
      declared=declared.replace(addition,'');
    }
  }
  ok(()=>assert.equal(declared.split(declaration).length,2));
  ok(()=>assert.equal(createHash('sha256').update(declared.replace(declaration,'')).digest('hex'),baselinePins[file]));
}
ok(()=>assert(coordinator.indexOf('const harness = await futureHarness(env);') < coordinator.indexOf('const account = await runLiveAccountRecipe(input')));
ok(()=>assert(coordinator.includes('rejectExit(new Refusal(code))')
  && coordinator.includes("setTimeout(() => stop('g4_pipe_global_deadline'), 600000)")));
ok(()=>assert(coordinator.includes("['ls-files', '--error-unmatch'") && coordinator.includes("['status', '--porcelain', '--untracked-files=no']")));
ok(()=>assert(!coordinator.includes('options.provisionSource') && coordinator.includes('makeRealApiSupportSource(input)')));
ok(()=>assert(coordinator.includes("stdio: ['pipe', 'pipe', 'pipe']") && !coordinator.includes('process.stdout.write(stdout)')));
for(const fragment of ['requirePaidA41Workspace',"provider: 'api'","ticket.state === 'pending'","action: 'approve'","category: 'quote'","action: 'linkGestion'","automaticSupportClassificationExecuted: false","redirect: 'error'","AbortSignal.timeout(30000)"])ok(()=>assert(source.includes(fragment)));
ok(()=>assert(!source.includes("action: 'createWorkspace'") && source.indexOf('const workspaceId = requirePaidA41Workspace(') < source.indexOf("action: 'linkGestion'")));
ok(()=>assert(source.includes('} finally {') && source.includes('g4_delegation_restore_unconfirmed') && source.includes('if (sourceAutomationEnabled) try {')));
ok(()=>assert(source.includes('state.focusedTicket?.revision === ticket.revision + 1')));
// Offline fault injection only. The fake fetch is installed before admission;
// it accepts only the fixed A41 host and never opens a socket. These are unit
// proofs of sequencing/restoration, never a hosted receipt or a JEV result.
async function supportFixture({enabled=true,failAt,otherTenant=false}={}) {
  const savedFetch=globalThis.fetch, savedEnv={...process.env};
  const savedPlatform=Object.getOwnPropertyDescriptor(process,'platform');
  // This is an offline Windows-admission unit fixture, independent of the
  // host running Node. The real helper's guard is unchanged; fetch below is
  // fully simulated and cannot create a network or native process.
  Object.defineProperty(process,'platform',{...savedPlatform,value:'win32'});
  Object.assign(process.env,env);
  let linked=true,connectionId,ticket,failed=false;const calls=[],mutations=[];
  const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const view=()=>({...structuredClone(workspace),
    gestion:{...workspace.gestion,linked,organizationId:otherTenant?'other-tenant':complete.organizationId},
    automation:{active:linked,enabled:linked&&enabled},
    connections:connectionId?[{id:connectionId}]:[],tickets:ticket?[ticket]:[],counts:{total:ticket?1:0},
    focusedTicket:ticket??null});
  globalThis.fetch=async (raw,init={})=>{
    const url=new URL(raw);assert.equal(url.origin,'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site');
    assert.equal(init.redirect,'error');calls.push(url.pathname);
    if(url.pathname==='/api/auth/session')return respond({authenticated:true,user:{id:'1f0d9981-607b-4848-9374-587035cdfd89',emailConfirmed:true}});
    if(url.pathname==='/api/support'&&init.method==='GET') {
      const value=view();if(!url.searchParams.has('ticket'))value.focusedTicket=null;
      return respond(value);
    }
    const body=JSON.parse(init.body);
    if(url.pathname==='/api/support') {
      mutations.push(body.action==='linkGestion'?`link:${body.enabled}`:body.action);
      assert.equal(body.workspaceId,supportId);
      if(body.action==='linkGestion') {
        assert.equal(body.organizationId,complete.organizationId);assert.equal(body.autoPost,false);linked=body.enabled;
        if(!failed&&((!linked&&failAt==='pause-response')||(linked&&failAt==='restore-response'))){failed=true;return respond({error:'unit failure'},503);}
        return respond({saved:true});
      }
      if(!failed&&body.action===failAt){failed=true;return respond({error:'unit failure'},503);}
      if(body.action==='settings')return respond({saved:true});
      if(body.action==='connect'){connectionId=randomUUID();return respond({connectionId,hookToken:'zsup_'+'X'.repeat(43)},201);}
      if(body.action==='approve'){ticket={...ticket,state:'ready',revision:ticket.revision+1,decision:{category:'quote',manual:true}};return respond({saved:true});}
      throw Error('unit unexpected mutation');
    }
    assert.equal(url.pathname,`/api/support/hooks/${connectionId}`);
    if(!failed&&failAt==='hook'){failed=true;return respond({error:'unit failure'},503);}
    assert.equal(linked&&enabled,false);
    ticket={id:randomUUID(),connectionId,externalId:body.ticketId,state:'pending',decision:null,
      senderEmail:body.senderEmail,revision:1};
    return respond({ticket,automationRequired:!linked},202);
  };
  try {
    const cookie=`__Host-zentra_session_owner=1f0d9981-607b-4848-9374-587035cdfd89; __Host-zentra_access=unit-access; __Host-zentra_refresh=unit-refresh`;
    const source=makeRealApiSupportSource({format:'zentra-a41-native-account-input-v1',sitesServiceToken:'unit-only-'.repeat(8),
      browserCookieHeader:cookie,expectedOwnerId:'1f0d9981-607b-4848-9374-587035cdfd89',expectedOrganizationId:complete.organizationId});
    let result,error;try {result=await source.provision({organizationId:complete.organizationId,customerId:seed.customerId,articleId:seed.articleId,browserCookieHeader:cookie});}
    catch(caught){error=caught.message;}
    return {result,error,linked,mutations,calls,proof:result?source.publicProof():undefined};
  } finally {
    globalThis.fetch=savedFetch;
    Object.defineProperty(process,'platform',savedPlatform);
    for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];
    for(const[key,value]of Object.entries(savedEnv))process.env[key]=value;
  }
}
for(const enabled of [false,true]) {
  const fixture=await supportFixture({enabled});
  ok(()=>assert.equal(fixture.error,undefined));ok(()=>assert.equal(fixture.linked,true));
  ok(()=>assert.equal(fixture.proof.workspaceId,supportId));ok(()=>validateSourceProof(fixture.proof));
  ok(()=>assert.deepEqual(fixture.mutations,enabled?['link:false','settings','connect','approve','link:true']:['settings','connect','approve']));
}
for(const failAt of ['pause-response','settings','connect','hook','approve']) {
  const fixture=await supportFixture({failAt});
  ok(()=>assert.equal(fixture.error,'g4_support_http_refused'));ok(()=>assert.equal(fixture.linked,true));
  ok(()=>assert.deepEqual(fixture.mutations.filter(x=>x.startsWith('link:')),['link:false','link:true']));
  ok(()=>assert.equal(fixture.proof,undefined));
}
const restoreUnconfirmed=await supportFixture({failAt:'restore-response'});
ok(()=>assert.equal(restoreUnconfirmed.error,'g4_delegation_restore_unconfirmed'));
ok(()=>assert.equal(restoreUnconfirmed.proof,undefined));
const foreign=await supportFixture({otherTenant:true});
ok(()=>assert.equal(foreign.error,'g4_exact_paid_complete_delegation_required'));
ok(()=>assert.deepEqual(foreign.mutations,[]));
const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform');
try {
  Object.defineProperty(process,'platform',{...originalPlatform,value:'linux'});
  const emulatedHost=await supportFixture({enabled:false});
  ok(()=>assert.equal(emulatedHost.error,undefined));
  ok(()=>assert.equal(process.platform,'linux'));
} finally { Object.defineProperty(process,'platform',originalPlatform); }
ok(()=>assert(!read('.circleci/config.yml').includes('contracts.test.mjs')));
const diagnosticRust = read('desktop/src-tauri/src/account_cloud_live_a41_g4_tests.rs');
ok(()=>assert.deepEqual([...diagnosticRust.matchAll(/pipe\.checkpoint\("([a-z_]+)", ([01])\)\?/g)]
  .map(match=>({step:match[1],index:Number(match[2])})),G4_CHECKPOINTS));
ok(()=>assert.equal((diagnosticRust.match(/action_engine::advance_quote_work_round\(store, &mut round\)/g)??[]).length,1));
ok(()=>assert(diagnosticRust.includes('"reviewRequired":review_required') && diagnosticRust.includes('return Err(());')));
const diagnosticCoordinator=read('desktop/scripts/verify-action-live-g4-windows.mjs');
ok(()=>assert(diagnosticCoordinator.includes("throw new Refusal('g4_review_required')")
  && diagnosticCoordinator.includes('nominalG4Passed: false') && diagnosticCoordinator.includes('native-g4-diagnostic.public.json')));
ok(()=>assert(diagnosticCoordinator.includes('G4_MAX_QUEUED_EVENTS = G4_CHECKPOINTS.length + 3')));
ok(()=>assert(diagnosticCoordinator.indexOf('const result = await exited;') < diagnosticCoordinator.indexOf('await channel.finalize();')
  && diagnosticCoordinator.indexOf('await channel.finalize();') < diagnosticCoordinator.indexOf('channel.assertTerminal();')
  && diagnosticCoordinator.indexOf('channel.assertTerminal();') < diagnosticCoordinator.indexOf('completed = true; return complete;')));
const exitListener=diagnosticCoordinator.slice(diagnosticCoordinator.indexOf("child.once('exit', (code, signal)"), diagnosticCoordinator.indexOf('exited.catch'));
ok(()=>assert(!exitListener.includes('channel?.fail(') && !exitListener.includes('channel.fail(')));
ok(()=>assert(diagnosticCoordinator.includes("const failure = new Refusal('g4_native_spawn_failed');\n        rejectConnection(failure); reject(failure);")));
console.log(JSON.stringify({result:'PURE_G4_SUPPORT_COORDINATOR_CONTRACTS_OK',checks,
  baselineSource,sourceBaselinePinsChecked:Object.keys(baselinePins).length,
  ignoredQaDependency:false,gitHistoryRequired:false,automaticallyWiredIntoCi:false,
  rustModulesDeclaredTestWindowsOnly:true,rustCompiled:false,nativeExecuted:false,cargoExecuted:false,
  networkUsed:false,cloudChanged:false}));
