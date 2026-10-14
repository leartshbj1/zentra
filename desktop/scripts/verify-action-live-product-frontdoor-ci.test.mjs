// Pure dispatcher contracts. Never calls Git, compiler, recipe or HTTP.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {frontdoorInputFromEnvironment,g5InputFromEnvironment,assertG4CiAdmission,compileEnvironment,SECRET_NAMES} from './verify-action-live-g4-ci-windows.mjs';
import {BASELINE_PIN,FLAG} from './verify-action-live-product-frontdoor.mjs';
for(const name of SECRET_NAMES)if(Object.hasOwn(process.env,name))throw Error('PURE_FRONTDOOR_CI_PRIVATE_ENV_REFUSED');
globalThis.fetch=async()=>{throw Error('PURE_FRONTDOOR_CI_NETWORK_DISABLED');};
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,source='f'.repeat(40),owner='1f0d9981-607b-4848-9374-587035cdfd89';
const context=()=>({format:'zentra-a41-product-frontdoor-context-v1',sourceSha:source,campaignId:uuid(1),workspaceId:`support_${uuid(2)}`,connectionId:uuid(3),apiHookToken:`zsup_${'A'.repeat(43)}`,
  browserCookieHeader:`__Host-zentra_access=synthetic; __Host-zentra_refresh=synthetic; __Host-zentra_session_owner=${owner}`,expectedBaseline:{...BASELINE_PIN}});
const environment=v=>({CIRCLE_SHA1:source,[SECRET_NAMES[0]]:'S'.repeat(32),[SECRET_NAMES[1]]:JSON.stringify(v)});
const read=file=>readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n');
test('new closed format uses the same two credentials and exact current head pin',()=>{
  const input=frontdoorInputFromEnvironment(environment(context()));assert.equal(input.format,'zentra-a41-product-frontdoor-input-v1');assert.deepEqual(input.expectedBaseline,BASELINE_PIN);
  assert.equal(input.account.sitesServiceToken,'S'.repeat(32));assert.equal(g5InputFromEnvironment(environment(context())),null);
  assert.deepEqual(SECRET_NAMES,['ZENTRA_A41_SITES_SERVICE_TOKEN','ZENTRA_A41_BROWSER_COOKIE_QA']);
});
test('malformed/duplicate/extra/source/head drift refuses before the new mode can act',()=>{
  for(const raw of ['{',JSON.stringify(context())+'\n',' '+JSON.stringify(context()),JSON.stringify(context()).replace('"format":','"format":"duplicate","format":')])assert.throws(()=>frontdoorInputFromEnvironment({...environment(context()),[SECRET_NAMES[1]]:raw}));
  for(const patch of [{sourceSha:'e'.repeat(40)},{expectedBaseline:{...BASELINE_PIN,revision:3}},{grant:true},{plan:{ready:true}},{rootDir:'private'},{sourceId:uuid(8)}])assert.throws(()=>frontdoorInputFromEnvironment(environment({...context(),...patch})));
  for(const key of Object.keys(context())){const value=context();delete value[key];if(key==='format')assert.equal(frontdoorInputFromEnvironment(environment(value)),null);else assert.throws(()=>frontdoorInputFromEnvironment(environment(value)));}
});
test('old G5 stays distinct, and no private variable/run flag reaches compile children',()=>{
  const old={...context(),format:'zentra-a41-g5-context-v1'};assert.equal(frontdoorInputFromEnvironment(environment(old)),null);assert.equal(g5InputFromEnvironment(environment(old)).format,'zentra-a41-g5-input-v1');
  const env={CIRCLECI:'true',OS:'Windows_NT',CIRCLE_JOB:'windows-action-live-account-tests',CIRCLE_BRANCH:'codex/action-engine-native-live-a41',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',CIRCLE_SHA1:source,CIRCLE_BUILD_NUM:'999',CIRCLE_WORKFLOW_ID:uuid(30),ZENTRA_LIVE_PROFILE_PIPELINE_ID:uuid(31),
    ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',RUSTUP_TOOLCHAIN:'stable-x86_64-pc-windows-msvc'};
  assert.doesNotThrow(()=>assertG4CiAdmission(env,'win32','22.0.0'));assert.throws(()=>assertG4CiAdmission({...env,[FLAG]:'true'},'win32','22.0.0'));
  const compiler=compileEnvironment({...env,...environment(context()),[FLAG]:'true'});for(const key of [...SECRET_NAMES,FLAG])assert.equal(Object.hasOwn(compiler,key),false);
});
test('dispatch and tracked preflight precede compilation, JSON proof precedes live flag and account enrollment',()=>{
  const ci=read('./verify-action-live-g4-ci-windows.mjs'),dispatch=ci.slice(ci.indexOf('export async function runDedicatedG4Ci()'));
  assert.ok(dispatch.indexOf('const frontdoor = frontdoorInputFromEnvironment(process.env)')<dispatch.indexOf('const g5 = g5InputFromEnvironment(process.env)'));
  const run=ci.slice(ci.indexOf('async function runDedicatedFrontdoorCi(input)'));
  assert.ok(run.indexOf('delete process.env[name]')<run.indexOf('tracked();'));assert.ok(run.indexOf('tracked();')<run.indexOf('await compileFreshSource(environment)'));
  assert.ok(run.indexOf('schemas.reconcile()')<run.indexOf('await runLiveSessionRegressions()'));assert.ok(run.indexOf('await runFrontdoorInjectionRegression(input)')<run.indexOf("process.env[FRONTDOOR_FLAG]='true'"));
  assert.ok(run.indexOf("process.env[FRONTDOOR_FLAG]='true'")<run.indexOf('await runLiveProductFrontdoor(input,preflight)'));assert.match(run,/native-product-frontdoor-report\.public\.json/);
  assert.match(run,/\[\.\.\.RUN_FLAGS,CONTINUATION_FLAG,G5_FLAG,FRONTDOOR_FLAG\]/);assert.doesNotMatch(run,/runLiveG5Recipe|runLiveG4Recipe|runLiveG4Continuation/);
  const node=read('./verify-action-live-product-frontdoor.mjs'),runner=node.slice(node.indexOf('export async function runLiveProductFrontdoor'));
  assert.ok(runner.indexOf('validateFrontdoorRegression(preflight')<runner.indexOf('await runLiveAccountRecipe'));
});
