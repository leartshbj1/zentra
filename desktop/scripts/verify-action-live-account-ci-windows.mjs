// Dedicated opt-in CI entrypoint. Never invoke --ci-run on a local machine.
// The context variables are copied to private memory and removed BEFORE any
// bootstrap/build process. Compilation receives a public allowlist only.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DESCRIPTION,validatePrivateInput,runLiveAccountRecipe} from './verify-action-live-account-windows.mjs';

const REPOSITORY=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const HISTORICAL_SOURCE='ad57c6905112462bbf844c8bb89072d488294f2c';
const ORIGIN='https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site';
export const CONTEXT_NAME='zentra-a41-native-live-account-qa';
export const SECRET_NAMES=Object.freeze(['ZENTRA_A41_SITES_SERVICE_TOKEN','ZENTRA_A41_BROWSER_COOKIE_QA']);
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
class CiFailure extends Error {constructor(code){super(code);this.code=code;}}
const need=(condition,code)=>{if(!condition)throw new CiFailure(code);};
const closed=(value,names)=>need(plain(value)&&Object.keys(value).sort().join('|')===[...names].sort().join('|'),'public_report_shape_refused');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

export function assertDedicatedAdmission(environment,platform=process.platform,nodeVersion=process.versions.node) {
  const expected={CIRCLECI:'true',OS:'Windows_NT',CIRCLE_JOB:'windows-action-live-account-tests',
    CIRCLE_BRANCH:'codex/action-engine-native-live-a41',CIRCLE_NODE_INDEX:'0',CIRCLE_NODE_TOTAL:'1',
    ZENTRA_VERIFY_DIAGNOSTICS_ONLY:'true',ZENTRA_VERIFY_ONLY:'true',ZENTRA_VERIFY_NATIVE_PROFILE_ONLY:'false',
    ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'false',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'true',ZENTRA_LIVE_PROFILE_RELEASE:'false',
    ZENTRA_DIAGNOSTICS_NATIVE_SET:'action-engine',RUSTUP_TOOLCHAIN:'stable-x86_64-pc-windows-msvc'};
  need(plain(environment)&&platform==='win32','dedicated_windows_ci_required');
  for(const[name,value]of Object.entries(expected))need(environment[name]===value,'dedicated_ci_admission_refused');
  need(/^[a-f0-9]{40}$/.test(environment.CIRCLE_SHA1??'')&&environment.CIRCLE_SHA1!==HISTORICAL_SOURCE,'new_source_required');
  need(/^[1-9][0-9]{0,9}$/.test(environment.CIRCLE_BUILD_NUM??''),'ci_job_identity_required');
  for(const name of ['CIRCLE_WORKFLOW_ID','ZENTRA_LIVE_PROFILE_PIPELINE_ID'])need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(environment[name]??''),'ci_uuid_required');
  for(const name of ['CARGO_TARGET_DIR','ZENTRA_ACTION_NATIVE_TEST_CONTEXT','ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON','ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256','ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE','ZENTRA_RUN_LIVE_ACCOUNT_RECIPE'])need(!environment[name],'inherited_compile_or_run_input_refused');
  need(Number(nodeVersion.split('.')[0])>=22,'node_22_or_newer_required');
}

export function compileEnvironment(environment) {
  const result={};
  for(const name of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA',
    'HOMEDRIVE','HOMEPATH','COMSPEC','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramFiles','ProgramFiles(x86)','ProgramData',
    'VSINSTALLDIR','VCINSTALLDIR','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion','WindowsLibPath','INCLUDE','LIB','LIBPATH',
    'RUSTUP_HOME','CARGO_HOME','CIRCLECI','OS','CIRCLE_BRANCH','CIRCLE_SHA1','CIRCLE_NODE_INDEX','CIRCLE_NODE_TOTAL','CIRCLE_WORKFLOW_ID',
    'CIRCLE_BUILD_NUM','ZENTRA_LIVE_PROFILE_PIPELINE_ID','ZENTRA_VERIFY_DIAGNOSTICS_ONLY','ZENTRA_VERIFY_ONLY',
    'ZENTRA_VERIFY_NATIVE_PROFILE_ONLY','ZENTRA_LIVE_PROFILE_RELEASE','ZENTRA_DIAGNOSTICS_NATIVE_SET','RUSTUP_TOOLCHAIN']){
    if(typeof environment[name]==='string')result[name]=environment[name];
  }
  return {...result,CARGO_PROFILE_TEST_DEBUG:'0',ZENTRA_VERIFY_LIVE_PROFILE_ONLY:'true',ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY:'false'};
}

export function privateInputFromEnvironment(environment) {
  return validatePrivateInput({format:DESCRIPTION.privateInputFormat,sitesServiceToken:environment[SECRET_NAMES[0]],
    browserCookieHeader:environment[SECRET_NAMES[1]],expectedOwnerId:DESCRIPTION.expectedOwnerId,
    expectedOrganizationId:DESCRIPTION.expectedOrganizationId});
}

export function validatePublicReport(report,source) {
  closed(report,['format','source','binarySha256','coordinatorSha256','rustHarnessSourceSha256','profileSha256','siteOrigin',
    'ownerId','organizationId','phases','sameExecutableBothPhases','separateNativeProcesses','protectedStateReopened',
    'browserApprovals','nativeExecuted','stripePaidTestValidated','actionEngineExecuted','serverSourceDirectlyAttested','automaticCleanup']);
  need(report.format==='zentra-a41-native-account-report-v1'&&/^[a-f0-9]{40}$/.test(source??'')&&report.source===source&&source!==HISTORICAL_SOURCE,'new_native_report_source_required');
  need(report.profileSha256===DESCRIPTION.profileSha256&&report.siteOrigin===ORIGIN&&report.ownerId===DESCRIPTION.expectedOwnerId&&report.organizationId===DESCRIPTION.expectedOrganizationId,'native_report_authority_refused');
  for(const name of ['binarySha256','coordinatorSha256','rustHarnessSourceSha256'])need(SHA.test(report[name]??''),'native_report_hash_required');
  for(const name of ['sameExecutableBothPhases','separateNativeProcesses','protectedStateReopened','nativeExecuted'])need(report[name]===true,'native_report_incomplete');
  for(const name of ['stripePaidTestValidated','actionEngineExecuted','serverSourceDirectlyAttested','automaticCleanup'])need(report[name]===false,'native_report_scope_refused');
  need(report.browserApprovals===2&&Array.isArray(report.phases)&&report.phases.length===2,'two_native_phases_required');
  for(const[index,phase]of report.phases.entries()){
    closed(phase,['phase','exactTest','strictMeHttp200','nativeLicenseValidated','installations']);
    const expected=index===0?'enroll':'reopen';
    need(phase.phase===expected&&phase.exactTest===DESCRIPTION.exactTests[expected]&&phase.strictMeHttp200===true&&phase.nativeLicenseValidated===true,'native_phase_refused');
    need(Array.isArray(phase.installations)&&phase.installations.length===2,'two_installations_required');
    for(const installation of phase.installations){
      closed(installation,['installationId','licenseId','accountSessionId','jti','licenseSha256']);
      need(UUID.test(installation.installationId??'')&&UUID.test(installation.jti??'')&&typeof installation.accountSessionId==='string'
        &&installation.accountSessionId.startsWith('dss_')&&UUID.test(installation.accountSessionId.slice(4))
        &&typeof installation.licenseId==='string'&&installation.licenseId.startsWith('lic_')&&UUID.test(installation.licenseId.slice(4))
        &&SHA.test(installation.licenseSha256??''),'native_installation_proof_refused');
    }
    for(const name of ['installationId','licenseId','accountSessionId'])need(new Set(phase.installations.map(value=>value[name])).size===2,'native_installations_not_distinct');
  }
  need(JSON.stringify(stable(report.phases[0].installations))===JSON.stringify(stable(report.phases[1].installations)),'reopened_native_state_changed');
  return stable(report);
}

async function compileFreshSource(environment) {
  const compilerEnvironment=compileEnvironment(environment);
  need(/^C:\\Windows$/i.test(compilerEnvironment.SystemRoot??compilerEnvironment.SYSTEMROOT??''),'trusted_windows_root_required');
  const executable='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(REPOSITORY,'desktop/scripts/verify-action-live-profile-windows.ps1')];
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:REPOSITORY,env:compilerEnvironment,windowsHide:true,stdio:['ignore','inherit','inherit']});
    const timer=setTimeout(()=>{child.kill();reject(new CiFailure('fresh_profile_compile_timeout'));},45*60*1000);
    child.once('error',()=>{clearTimeout(timer);reject(new CiFailure('fresh_profile_compile_process_failed'));});
    child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new CiFailure('fresh_profile_compile_failed'));});
  });
}

export async function runDedicatedCi() {
  assertDedicatedAdmission({...process.env});
  // Capture, validate, then remove the two context credentials from this
  // process. Never restore them or pass an environment snapshot to children.
  const input=privateInputFromEnvironment(process.env);
  for(const name of SECRET_NAMES)delete process.env[name];
  const environment={...process.env};
  need(typeof fetch==='function'&&typeof Headers.prototype.getSetCookie==='function','node_fetch_cookie_runtime_required');
  const source=environment.CIRCLE_SHA1;
  const head=execFileSync('git',['-C',REPOSITORY,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
  need(head===source,'ci_checkout_source_mismatch');
  need(execFileSync('git',['-C',REPOSITORY,'status','--porcelain','--untracked-files=no'],{encoding:'utf8',windowsHide:true}).trim()==='','tracked_checkout_must_be_clean');
  const liveTests=fs.readFileSync(path.join(REPOSITORY,'desktop/src-tauri/src/account_cloud_live_a41_tests.rs'),'utf8');
  need(Object.values(DESCRIPTION.exactTests).every(name=>liveTests.includes(`fn ${name.split('::').at(-1)}()`))
    &&(liveTests.match(/#\[ignore =/g)??[]).length===2,'new_ignored_live_tests_required');
  const output=path.join(REPOSITORY,'desktop/artifacts/action-live-account');need(!fs.existsSync(output),'fresh_account_artifacts_required');
  process.stdout.write(`LIVE_ACCOUNT_CI_PHASE compile source=${source}\n`);
  await compileFreshSource(environment);
  process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE='true';
  let report;
  try {report=validatePublicReport(await runLiveAccountRecipe(input),source);}
  finally {delete process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE;}
  // Only the second, closed validation above admits an artifact write.
  const proof=fs.readFileSync(path.join(REPOSITORY,'desktop/artifacts/action-live-profile/live-profile-verification-proof.json'));
  const result={format:'zentra-a41-native-account-ci-public-v1',source,pipelineId:environment.ZENTRA_LIVE_PROFILE_PIPELINE_ID,
    workflowId:environment.CIRCLE_WORKFLOW_ID,jobNumber:environment.CIRCLE_BUILD_NUM,nodeIndex:0,nodeTotal:1,
    nodeVersion:process.version,profileCompilationProofSha256:sha(proof),nativeAccountJourneyValidated:true,
    stripePaidTestValidated:false,actionEngineGatesEstablished:false,report};
  fs.mkdirSync(output);fs.writeFileSync(path.join(output,'native-account-report.public.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(`LIVE_ACCOUNT_CI_PASSED source=${source} installations=2 reopened=2 paid=false actionEngine=false\n`);
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length===0||(args.length===1&&args[0]==='--describe'))process.stdout.write(JSON.stringify({inactiveByDefault:true,
    context:CONTEXT_NAME,privateContextVariables:SECRET_NAMES,newCompilationRequired:true,historicalSourceRejected:HISTORICAL_SOURCE,
    minimumNodeMajor:22,nativeExecution:'dedicated Windows CI only',paidOrActionEngineValidation:false})+'\n');
  else if(args.length===1&&args[0]==='--ci-run')runDedicatedCi().catch(error=>{
    const code=typeof error?.code==='string'&&/^[a-z0-9_]{1,80}$/.test(error.code)?error.code:'dedicated_live_account_ci_failed';
    process.stderr.write(JSON.stringify({passed:false,code})+'\n');process.exitCode=1;
  });
  else {process.stderr.write('{"passed":false,"code":"explicit_ci_run_required"}\n');process.exitCode=1;}
}
