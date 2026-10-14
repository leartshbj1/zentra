// Pure CI contracts; never invokes the runner, native child, Git or HTTP.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {g5InputFromEnvironment,continuationInputFromEnvironment,assertG4CiAdmission,compileEnvironment,SECRET_NAMES,publicG5CiProof} from './verify-action-live-g4-ci-windows.mjs';
for(const name of SECRET_NAMES)if(Object.hasOwn(process.env,name))throw Error('PURE_G5_CI_PRIVATE_ENV_REFUSED');
globalThis.fetch=async()=>{throw Error('PURE_G5_CI_NETWORK_DISABLED');};
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,source='f'.repeat(40),owner='1f0d9981-607b-4848-9374-587035cdfd89';
const context=()=>({format:'zentra-a41-g5-context-v1',sourceSha:source,campaignId:uuid(1),workspaceId:`support_${uuid(2)}`,connectionId:uuid(3),apiHookToken:`zsup_${'A'.repeat(43)}`,
  browserCookieHeader:`__Host-zentra_access=synthetic; __Host-zentra_refresh=synthetic; __Host-zentra_session_owner=${owner}`,
  expectedBaseline:{revision:2,snapshotId:uuid(4),archiveSha256:'a'.repeat(64)}});
const environment=value=>({CIRCLE_SHA1:source,[SECRET_NAMES[0]]:'S'.repeat(32),[SECRET_NAMES[1]]:JSON.stringify(value)});
const read=file=>readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n');
test('future G5 format uses the same two variables, exact source pin and distinct current baseline',()=>{
  const input=g5InputFromEnvironment(environment(context()));assert.equal(input.format,'zentra-a41-g5-input-v1');assert.equal(input.expectedBaseline.revision,2);
  assert.equal(input.account.sitesServiceToken,'S'.repeat(32));assert.equal(input.account.browserCookieHeader,context().browserCookieHeader);
  assert.deepEqual(SECRET_NAMES,['ZENTRA_A41_SITES_SERVICE_TOKEN','ZENTRA_A41_BROWSER_COOKIE_QA']);
});
test('old continuation format is unchanged and a raw cookie can never launch the virgin path',()=>{
  const old=context();delete old.expectedBaseline;old.format='zentra-a41-continuation-context-v1';
  assert.equal(g5InputFromEnvironment(environment(old)),null);assert.equal(continuationInputFromEnvironment(environment(old)).format,'zentra-a41-continuation-input-v1');
  const raw={...environment(old),[SECRET_NAMES[1]]:context().browserCookieHeader};assert.equal(g5InputFromEnvironment(raw),null);
  assert.throws(()=>continuationInputFromEnvironment(raw),{code:'continuation_context_required'});
});
test('G5 malformed, duplicated, extra and mismatched inputs fail before any action',()=>{
  for(const field of Object.keys(context())){const value=context();delete value[field];if(field==='format')assert.equal(g5InputFromEnvironment(environment(value)),null);else assert.throws(()=>g5InputFromEnvironment(environment(value)));}
  for(const patch of [{sourceSha:'e'.repeat(40)},{plan:'ready'},{rootDir:'private'},{expectedBaseline:{...context().expectedBaseline,revision:0}}])assert.throws(()=>g5InputFromEnvironment(environment({...context(),...patch})));
  for(const raw of ['{',JSON.stringify(context())+'\n',' '+JSON.stringify(context()),JSON.stringify(context()).replace('"format":','"format":"duplicate","format":')])
    assert.throws(()=>g5InputFromEnvironment({...environment(context()),[SECRET_NAMES[1]]:raw}));
});
test('G5 inherited run flag refuses and compiler cannot receive private variables or opt-in',()=>{
  const env={CIRCLECI:'true',OS:'Windows_NT',CIRCLE_JOB:'windows-action-live-account-tests',CIRCLE_BRANCH:'codex/action-engine-native-live-a41',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',
    CIRCLE_SHA1:source,CIRCLE_BUILD_NUM:'999',CIRCLE_WORKFLOW_ID:uuid(20),ZENTRA_LIVE_PROFILE_PIPELINE_ID:uuid(21),ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',
    ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',
    ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',RUSTUP_TOOLCHAIN:'stable-x86_64-pc-windows-msvc'};
  assert.doesNotThrow(()=>assertG4CiAdmission(env,'win32','22.0.0'));assert.throws(()=>assertG4CiAdmission({...env,ZENTRA_RUN_LIVE_G5_RECIPE:'true'},'win32','22.0.0'));
  const compiler=compileEnvironment({...env,...environment(context()),ZENTRA_RUN_LIVE_G5_RECIPE:'true'});
  for(const key of [...SECRET_NAMES,'ZENTRA_RUN_LIVE_G5_RECIPE'])assert.equal(Object.hasOwn(compiler,key),false);
});
test('dispatcher selects G5 only after closed decode, then admits tracked sources before compile and flags after regressions',()=>{
  const file=read('./verify-action-live-g4-ci-windows.mjs'),run=file.slice(file.indexOf('export async function runDedicatedG4Ci()'));
  assert.ok(run.indexOf('const g5 = g5InputFromEnvironment(process.env)')<run.indexOf('const continuation = continuationInputFromEnvironment(process.env)'));
  assert.match(run,/if \(g5 !== null\) return runDedicatedG5Ci\(g5\)/);
  const g5=file.slice(file.indexOf('async function runDedicatedG5Ci(input)'));
  assert.ok(g5.indexOf('delete process.env[name]')<g5.indexOf('tracked();'));assert.ok(g5.indexOf('tracked();')<g5.indexOf('captureTauriSchemaReconciliation(environment)'));
  assert.ok(g5.indexOf('await compileFreshSource(environment)')<g5.indexOf('schemas.reconcile()'));
  assert.ok(g5.indexOf('schemas.reconcile()')<g5.indexOf("process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true'"));
  assert.ok(g5.indexOf('await runLiveSessionRegressions()')<g5.indexOf("process.env[G5_FLAG] = 'true'"));
  assert.ok(g5.indexOf("process.env[G5_FLAG] = 'true'")<g5.indexOf('await runLiveG5Recipe(input)'));
  assert.match(g5,/\[\.\.\.RUN_FLAGS,CONTINUATION_FLAG,G5_FLAG\]/);assert.match(g5,/native-g5-subset-report\.public\.json/);
  assert.doesNotMatch(g5,/await runLiveG4Recipe|await runLiveG4Continuation/);
  assert.match(file,/g5CoordinatorSha256 === validated\.coordinatorSha256/);assert.match(file,/validateSessionRegressionProof\(sessionRegressions, identity\.source, validated\.binarySha256\)/);
  assert.throws(()=>publicG5CiProof({}, {}, {}, {}));
});
test('YAML grants/workflow remain exactly their historical baseline projection',()=>{
  const yaml=read('../../.circleci/config.yml').replace('node desktop/scripts/verify-action-live-g4-ci-windows.mjs --ci-run','node desktop/scripts/verify-action-live-account-ci-windows.mjs --ci-run');
  assert.equal(createHash('sha256').update(yaml).digest('hex'),'5646bb2aaa81b7a5207d2c6c594b5c4bfac802d748d45ab48f0f1daa597feb66');
});
