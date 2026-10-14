// Dedicated CI entrypoint for a NEW source containing the ignored G4 modules.
// Never invoke --ci-run locally. The A50 account coordinators provide the
// session regressions, account journey and private handoff. The two G4 modules
// are compiled only under cfg(all(test, windows)); no product caller is added.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONTEXT_NAME, SECRET_NAMES, assertDedicatedAdmission as assertAccountAdmission,
  compileEnvironment, privateInputFromEnvironment, validatePublicReport as validateAccountReport }
  from './verify-action-live-account-ci-windows.mjs';
import { DESCRIPTION, runLiveG4Recipe, validateComplete, validatePublication, validateSourceProof }
  from './verify-action-live-g4-windows.mjs';
import { SESSION_REGRESSION_TESTS, runLiveSessionRegressions }
  from './verify-action-live-account-windows.mjs';
import { captureTauriSchemaReconciliation } from './tauri-schema-reconciliation.mjs';
import { parsePrivateJson } from './verify-action-live-account-windows.mjs';
import { runLiveG4Continuation, validateContinuationInput, validatePublicContinuationReport,
  DESCRIPTION as CONTINUATION } from './verify-action-live-g4-continuation.mjs';
import { runLiveG5Recipe, validateG5Input, validateG5Report, DESCRIPTION as G5 } from './verify-action-live-g5-windows.mjs';

export { CONTEXT_NAME, SECRET_NAMES, compileEnvironment, privateInputFromEnvironment };
export const G4_BASELINE_SOURCE = '91a859eefb3ecc88716e34d77b3aa9f91a412e8c';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = /^[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RUN_FLAGS = Object.freeze(['ZENTRA_RUN_LIVE_ACCOUNT_RECIPE', 'ZENTRA_RUN_LIVE_G4_RECIPE']);
const CONTINUATION_FLAG = 'ZENTRA_RUN_LIVE_G4_CONTINUATION';
const CONTINUATION_CONTEXT_FORMAT = 'zentra-a41-continuation-context-v1';
const G5_CONTEXT_FORMAT = 'zentra-a41-g5-context-v1';
const G5_FLAG = 'ZENTRA_RUN_LIVE_G5_RECIPE';
const G5_FILES = Object.freeze(['desktop/scripts/verify-action-live-g5-windows.mjs','desktop/scripts/verify-action-live-g5-windows.test.mjs',
  'desktop/scripts/verify-action-live-g5-ci.test.mjs','desktop/src-tauri/src/account_cloud_action_engine_g5_support.rs',
  'desktop/src-tauri/src/company_collaboration_live_a41_g5_support.rs','desktop/src-tauri/src/account_cloud_live_a41_g5_tests.rs',
  'desktop/src-tauri/src/account_cloud_action_engine_continuation_support.rs','desktop/src-tauri/src/account_cloud_live_a41_g4_continuation_tests.rs']);
const CONTINUATION_FILES = Object.freeze(['desktop/scripts/verify-action-live-g4-continuation.mjs',
  'desktop/scripts/verify-action-live-g4-continuation.test.mjs', 'desktop/scripts/verify-action-live-g4-continuation-ci.test.mjs',
  'desktop/src-tauri/src/account_cloud_action_engine.rs', 'desktop/src-tauri/src/account_cloud_action_engine_continuation_support.rs',
  'desktop/src-tauri/src/account_cloud_live_a41_g4_continuation_tests.rs']);
const OUTPUT = 'desktop/artifacts/action-live-account';
const G4_FILES = Object.freeze(['desktop/scripts/verify-action-live-g4-ci-windows.mjs',
  'desktop/scripts/tauri-schema-reconciliation.mjs',
  'desktop/scripts/verify-action-live-g4-windows.mjs', 'desktop/scripts/live-g4-api-support-source.mjs',
  'desktop/src-tauri/src/account_cloud_live_a41_g4_tests.rs',
  'desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs']);
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code) => { if (!ok) throw new Refusal(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const closed = (value, fields) => need(plain(value)
  && Object.keys(value).sort().join('|') === [...fields].sort().join('|'), 'closed_g4_ci_public_proof_required');
const sorted = value => Array.isArray(value) ? value.map(sorted) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function assertG4CiAdmission(environment, platform = process.platform, nodeVersion = process.versions.node) {
  assertAccountAdmission(environment, platform, nodeVersion);
  need(environment.CIRCLE_SHA1 !== G4_BASELINE_SOURCE
    && !DESCRIPTION.historicalSourcesRefused.includes(environment.CIRCLE_SHA1), 'new_g4_source_required');
  need(!environment.ZENTRA_RUN_LIVE_G4_RECIPE, 'inherited_g4_run_flag_refused');
  need(!environment[CONTINUATION_FLAG], 'inherited_continuation_run_flag_refused');
  need(!environment[G5_FLAG], 'inherited_g5_run_flag_refused');
}

export function g5InputFromEnvironment(environment) {
  const raw = environment[SECRET_NAMES[1]];
  if (typeof raw !== 'string' || !/^[\[{]/.test(raw.trimStart())) return null;
  need(Buffer.byteLength(raw) <= 32768, 'g5_context_bounds');
  let value;
  try { value = parsePrivateJson(raw); } catch { throw new Refusal('g5_context_encoding_refused'); }
  if (!plain(value) || value.format !== G5_CONTEXT_FORMAT) return null;
  closed(value, ['format','sourceSha','campaignId','workspaceId','connectionId','apiHookToken','browserCookieHeader','expectedBaseline']);
  need(value.sourceSha === environment.CIRCLE_SHA1, 'g5_context_source_refused');
  return validateG5Input({ format: G5.privateInputFormat, sourceSha: value.sourceSha, campaignId: value.campaignId,
    workspaceId: value.workspaceId, connectionId: value.connectionId, apiHookToken: value.apiHookToken, expectedBaseline: value.expectedBaseline,
    account: { format: 'zentra-a41-native-account-input-v1', sitesServiceToken: environment[SECRET_NAMES[0]],
      browserCookieHeader: value.browserCookieHeader, expectedOwnerId: '1f0d9981-607b-4848-9374-587035cdfd89',
      expectedOrganizationId: 'org_trial_345a3d1f68056cf7e709d4af4fc229a4' } });
}

export function publicG5CiProof(report, identity, hashes, sessionRegressions) {
  closed(identity, ['source','pipelineId','workflowId','jobNumber','nodeVersion']);
  need(Object.values(identity).every(value => typeof value === 'string') && SOURCE.test(identity.source)
    && UUID.test(identity.pipelineId) && UUID.test(identity.workflowId) && /^[1-9][0-9]{0,9}$/.test(identity.jobNumber)
    && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(identity.nodeVersion) && Number(identity.nodeVersion.slice(1).split('.')[0]) >= 22,
    'g5_ci_identity_refused');
  closed(hashes, ['entrypointSha256','profileCompilationProofSha256','g5CoordinatorSha256','rustG5HarnessSha256',
    'rustG5AdapterSha256','rustG5PublicationPortSha256','rustParentHarnessSha256','rustCollaborationSupportSha256']);
  need(Object.values(hashes).every(value => typeof value === 'string' && SHA.test(value)), 'g5_ci_hashes_refused');
  const validated = validateG5Report(report, identity.source);
  need(hashes.g5CoordinatorSha256 === validated.coordinatorSha256, 'g5_coordinator_hash_refused');
  const regressions = validateSessionRegressionProof(sessionRegressions, identity.source, validated.binarySha256);
  return sorted({ format: 'zentra-a41-native-g5-subset-ci-public-v1', ...identity, ...hashes, nodeIndex:0, nodeTotal:1,
    claims: { threeDeclaredRecoveryBoundariesValidated:true, fullG5Passed:false, g6Passed:false, allActionEngineGatesEstablished:false,
      realDecisionProviderDirectlyAttested:false, mailExecuted:false, schedulerExecuted:false, autopilotProductActivated:false },
    sessionRegressions:regressions, report:validated });
}

// A41 is known to be populated. Its current dispatcher requires this canonical
// JSON envelope; a raw legacy cookie never launches the retained virgin body.
// The Sites credential remains separate and is never duplicated here.
export function continuationInputFromEnvironment(environment) {
  const raw = environment[SECRET_NAMES[1]];
  need(typeof raw === 'string' && /^[\[{]/.test(raw.trimStart()), 'continuation_context_required');
  need(Buffer.byteLength(raw) <= 32768, 'continuation_context_bounds');
  let value;
  try { value = parsePrivateJson(raw); } catch { throw new Refusal('continuation_context_encoding_refused'); }
  closed(value, ['format', 'sourceSha', 'campaignId', 'workspaceId', 'connectionId', 'apiHookToken', 'browserCookieHeader']);
  need(value.format === CONTINUATION_CONTEXT_FORMAT && value.sourceSha === environment.CIRCLE_SHA1,
    'continuation_context_source_refused');
  return validateContinuationInput({ format: CONTINUATION.privateInputFormat, sourceSha: value.sourceSha,
    campaignId: value.campaignId, workspaceId: value.workspaceId, connectionId: value.connectionId, apiHookToken: value.apiHookToken,
    account: { format: 'zentra-a41-native-account-input-v1', sitesServiceToken: environment[SECRET_NAMES[0]],
      browserCookieHeader: value.browserCookieHeader, expectedOwnerId: '1f0d9981-607b-4848-9374-587035cdfd89',
      expectedOrganizationId: 'org_trial_345a3d1f68056cf7e709d4af4fc229a4' } });
}

export function publicContinuationCiProof(report, identity, hashes, sessionRegressions) {
  closed(identity, ['source', 'pipelineId', 'workflowId', 'jobNumber', 'nodeVersion']);
  need(Object.values(identity).every(value => typeof value === 'string') && SOURCE.test(identity.source)
    && UUID.test(identity.pipelineId) && UUID.test(identity.workflowId) && /^[1-9][0-9]{0,9}$/.test(identity.jobNumber)
    && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(identity.nodeVersion) && Number(identity.nodeVersion.slice(1).split('.')[0]) >= 22,
  'continuation_ci_identity_refused');
  closed(hashes, ['entrypointSha256', 'profileCompilationProofSha256', 'continuationCoordinatorSha256',
    'rustContinuationHarnessSha256', 'rustContinuationAdapterSha256', 'rustParentHarnessSha256', 'rustCollaborationSupportSha256']);
  need(Object.values(hashes).every(value => typeof value === 'string' && SHA.test(value)), 'continuation_ci_hashes_refused');
  const validated = validatePublicContinuationReport(report, identity.source);
  need(hashes.continuationCoordinatorSha256 === validated.coordinatorSha256, 'continuation_coordinator_hash_refused');
  const regressions = validateSessionRegressionProof(sessionRegressions, identity.source, validated.binarySha256);
  return sorted({ format: 'zentra-a41-native-continuation-ci-public-v1', ...identity, ...hashes, nodeIndex: 0, nodeTotal: 1,
    claims: { g1g2NativeAccountJourneyValidated: true, populatedHeadReceivedInTwoNewStores: true,
      newSourceNominalG4Validated: true, lostStoresRecovered: false, historicalPreparationReplayed: false,
      allActionEngineGatesEstablished: false, stripePaidTestDirectlyValidated: false, realDecisionProviderDirectlyAttested: false,
      serverSourceDirectlyAttested: false, fullSchedulerTested: false, g5FailureMatrixExecuted: false,
      g6FullServiceParityEstablished: false, storageV0Executed: false, thirdPartyMailboxExecuted: false, autopilotProductActivated: false },
    sessionRegressions: regressions, report: validated });
}

export function validatePublicG4Report(report, source) {
  closed(report, ['format', 'source', 'binarySha256', 'profileSha256', 'coordinatorSha256', 'exactTest',
    'account', 'g4', 'sourceLifecycle', 'sameExecutableAllThreePhases', 'storesCreatedInThisJob', 'nativeExecuted',
    'actualApiSupportLifecycle', 'realDecisionProviderDirectlyAttested', 'g5FailureMatrixExecuted',
    'storageV0Executed', 'automaticCleanup']);
  need(SOURCE.test(source ?? '') && source !== G4_BASELINE_SOURCE && !DESCRIPTION.historicalSourcesRefused.includes(source)
    && report.source === source && report.format === 'zentra-a41-native-g4-report-v1'
    && report.profileSha256 === DESCRIPTION.profileSha256 && report.exactTest === DESCRIPTION.exactTest,
  'exact_g4_report_source_and_profile_required');
  for (const field of ['binarySha256', 'coordinatorSha256'])
    need(typeof report[field] === 'string' && SHA.test(report[field]), 'g4_report_hash_required');
  for (const field of ['sameExecutableAllThreePhases', 'storesCreatedInThisJob', 'nativeExecuted', 'actualApiSupportLifecycle'])
    need(report[field] === true, 'g4_report_incomplete');
  for (const field of ['realDecisionProviderDirectlyAttested', 'g5FailureMatrixExecuted', 'storageV0Executed', 'automaticCleanup'])
    need(report[field] === false, 'g4_report_scope_refused');
  const account = validateAccountReport(report.account, source);
  need(['binarySha256', 'coordinatorSha256', 'rustHarnessSourceSha256'].every(field => typeof account[field] === 'string')
    && account.phases.every(phase => phase.installations.every(installation => Object.values(installation)
      .every(value => typeof value === 'string'))), 'scalar_native_account_proof_required');
  need(account.binarySha256 === report.binarySha256 && account.profileSha256 === report.profileSha256,
    'same_g4_and_account_binary_required');
  const sourceLifecycle = validateSourceProof(report.sourceLifecycle);
  need(['workspaceId', 'connectionId', 'sourceId', 'sourceEnvelopeSha256']
    .every(field => typeof sourceLifecycle[field] === 'string'), 'scalar_source_lifecycle_proof_required');
  closed(report.g4, ['initialPublication', 'canonicalPublication', 'quote', 'secondStoreExactCreation',
    'secondRoundConfirmed', 'writerActivityCount', 'secondStoreActivityCount', 'strictMeHttp200Both']);
  need(plain(report.g4.quote), 'closed_g4_quote_required');
  for (const publication of [report.g4.initialPublication, report.g4.canonicalPublication])
    need(plain(publication) && ['snapshotId', 'archiveSha256', 'manifestSha256', 'transport']
      .every(field => typeof publication[field] === 'string'), 'scalar_publication_proof_required');
  need(['sourceId', 'proposalId', 'reservationId', 'fingerprint', 'quoteId', 'customerId', 'articleId', 'receiptSha256', 'status']
    .every(field => typeof report.g4.quote[field] === 'string') && Array.isArray(report.g4.quote.lineIds)
    && report.g4.quote.lineIds.every(value => typeof value === 'string'), 'scalar_quote_proof_required');
  const seed = { publication: validatePublication(report.g4.initialPublication), sourceId: sourceLifecycle.sourceId,
    customerId: report.g4.quote.customerId, articleId: report.g4.quote.articleId };
  const g4 = validateComplete({ ...report.g4, event: 'complete', profileSha256: report.profileSha256,
    organizationId: account.organizationId, automaticCleanup: false }, seed);
  return sorted({ ...report, account, g4, sourceLifecycle });
}

export function validateSessionRegressionProof(proof, source, binarySha256) {
  closed(proof, ['format', 'source', 'binarySha256', 'tests', 'passed', 'nativeExecuted']);
  need(proof.format === 'zentra-a41-native-session-regressions-v1'
    && typeof source === 'string' && SOURCE.test(source) && proof.source === source
    && typeof binarySha256 === 'string' && SHA.test(binarySha256)
    && typeof proof.binarySha256 === 'string' && proof.binarySha256 === binarySha256,
  'same_g4_session_regression_source_and_binary_required');
  need(Array.isArray(proof.tests) && proof.tests.length === SESSION_REGRESSION_TESTS.length
    && SESSION_REGRESSION_TESTS.every((test, index) => proof.tests[index] === test)
    && proof.passed === SESSION_REGRESSION_TESTS.length && proof.nativeExecuted === true,
  'exact_g4_session_regressions_required');
  return sorted(proof);
}

export function publicCiProof(report, identity, hashes, sessionRegressions) {
  closed(identity, ['source', 'pipelineId', 'workflowId', 'jobNumber', 'nodeVersion']);
  need(Object.values(identity).every(value => typeof value === 'string')
    && SOURCE.test(identity.source ?? '') && UUID.test(identity.pipelineId ?? '') && UUID.test(identity.workflowId ?? '')
    && /^[1-9][0-9]{0,9}$/.test(identity.jobNumber ?? '') && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(identity.nodeVersion ?? '')
    && Number(identity.nodeVersion.slice(1).split('.')[0]) >= 22, 'exact_g4_ci_identity_required');
  closed(hashes, ['entrypointSha256', 'profileCompilationProofSha256', 'supportSourceCoordinatorSha256',
    'rustG4HarnessSourceSha256', 'rustG4CollaborationSourceSha256']);
  need(Object.values(hashes).every(value => typeof value === 'string' && SHA.test(value)), 'g4_ci_source_hashes_required');
  const validated = validatePublicG4Report(report, identity.source);
  const regressions = validateSessionRegressionProof(sessionRegressions, identity.source, validated.binarySha256);
  return sorted({ format: 'zentra-a41-native-g4-ci-public-v1', ...identity, ...hashes, nodeIndex: 0, nodeTotal: 1,
    claims: { g1g2NativeAccountJourneyValidated: true, g4NominalContentV1PathValidated: true,
      allActionEngineGatesEstablished: false, stripePaidTestDirectlyValidated: false,
      realDecisionProviderDirectlyAttested: false, g5FailureMatrixExecuted: false,
      g6FullServiceParityEstablished: false, storageV0Executed: false, autopilotProductActivated: false },
    sessionRegressions: regressions, report: validated });
}

async function compileFreshSource(environment) {
  const compilerEnvironment = compileEnvironment(environment);
  need(/^C:\\Windows$/i.test(compilerEnvironment.SystemRoot ?? compilerEnvironment.SYSTEMROOT ?? ''), 'trusted_windows_root_required');
  for (const name of [...SECRET_NAMES, ...RUN_FLAGS]) need(!Object.hasOwn(compilerEnvironment, name), 'private_compile_environment_refused');
  const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'desktop/scripts/verify-action-live-profile-windows.ps1')];
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, env: compilerEnvironment, windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      reject(new Refusal('fresh_g4_profile_compile_timeout'));
      try { child.kill(); } catch { /* Timeout stays rejected even if termination fails. */ }
    }, 45 * 60 * 1000);
    child.once('error', () => { clearTimeout(timer); reject(new Refusal('fresh_g4_profile_compile_process_failed')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Refusal('fresh_g4_profile_compile_failed')); });
  });
}

function requireTrackedG4Sources(environment) {
  const options = { cwd: ROOT, env: compileEnvironment(environment), encoding: 'utf8', windowsHide: true, timeout: 30000 };
  need(execFileSync('git', ['rev-parse', 'HEAD'], options).trim() === environment.CIRCLE_SHA1, 'g4_ci_checkout_source_mismatch');
  need(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], options).trim() === '', 'g4_ci_tracked_checkout_must_be_clean');
  const tracked = execFileSync('git', ['ls-files', '--error-unmatch', '--', ...G4_FILES], options).trim().split(/\r?\n/);
  need(tracked.sort().join('|') === [...G4_FILES].sort().join('|'), 'g4_ci_sources_must_be_tracked');
  const account = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/src/account_cloud.rs'), 'utf8');
  const collaboration = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/src/company_collaboration.rs'), 'utf8');
  need(account.includes('#[cfg(all(test, windows))]\n#[path = "account_cloud_live_a41_g4_tests.rs"]\nmod live_a41_g4_tests;')
    || account.includes('#[cfg(all(test, windows))]\r\n#[path = "account_cloud_live_a41_g4_tests.rs"]\r\nmod live_a41_g4_tests;'),
  'test_only_g4_account_declaration_required');
  need(collaboration.includes('#[cfg(all(test, windows))]\n#[path = "company_collaboration_live_a41_g4_support.rs"]\npub(crate) mod live_a41_g4_support;')
    || collaboration.includes('#[cfg(all(test, windows))]\r\n#[path = "company_collaboration_live_a41_g4_support.rs"]\r\npub(crate) mod live_a41_g4_support;'),
  'test_only_g4_collaboration_declaration_required');
}

export async function runDedicatedG4Ci() {
  assertG4CiAdmission({ ...process.env });
  const g5 = g5InputFromEnvironment(process.env);
  if (g5 !== null) return runDedicatedG5Ci(g5);
  const continuation = continuationInputFromEnvironment(process.env);
  return runDedicatedContinuationCi(continuation);
  // The two credentials are private memory only from this point. No bootstrap,
  // git child, compiler or native environment receives their original variables.
  const input = privateInputFromEnvironment(process.env);
  for (const name of SECRET_NAMES) delete process.env[name];
  const environment = { ...process.env };
  need(typeof fetch === 'function' && typeof Headers.prototype.getSetCookie === 'function', 'node_fetch_cookie_runtime_required');
  requireTrackedG4Sources(environment);
  const source = environment.CIRCLE_SHA1, output = path.join(ROOT, OUTPUT);
  need(!fs.existsSync(output), 'fresh_g4_public_artifacts_required');
  const schemas = captureTauriSchemaReconciliation(environment);
  process.stdout.write(`LIVE_G4_CI_PHASE compile source=${source}\n`);
  await compileFreshSource(environment);
  let schemaReceipt;
  try { schemaReceipt = schemas.reconcile(); }
  catch (error) {
    const refusalReceipt = schemas.failureReceipt();
    if (refusalReceipt) fs.writeFileSync(path.join(ROOT, 'desktop/artifacts/action-live-profile/tauri-schema-reconciliation-refusal.public.json'),
      JSON.stringify(refusalReceipt, null, 2) + '\n', { flag: 'wx' });
    throw error;
  }
  requireTrackedG4Sources(environment);
  fs.writeFileSync(path.join(ROOT, 'desktop/artifacts/action-live-profile/tauri-schema-reconciliation.public.json'),
    JSON.stringify(schemaReceipt, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`LIVE_G4_SCHEMA_RECONCILIATION source=${source} restored=${schemaReceipt.restoredPaths.length}\n`);
  // Run flags are internal admission, not entitlement or opt-in. Normal paid,
  // seat, Automation/AE consent, flags, JEV and publication gates must pass.
  process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true';
  let report, sessionRegressions;
  try {
    sessionRegressions = await runLiveSessionRegressions();
    process.stdout.write(`LIVE_G4_SESSION_REGRESSIONS_PASSED source=${source} tests=3\n`);
    process.env.ZENTRA_RUN_LIVE_G4_RECIPE = 'true';
    report = validatePublicG4Report(await runLiveG4Recipe(input), source);
  }
  finally { for (const name of RUN_FLAGS) delete process.env[name]; }
  const digestFile = relative => hash(fs.readFileSync(path.join(ROOT, relative)));
  const result = publicCiProof(report, { source, pipelineId: environment.ZENTRA_LIVE_PROFILE_PIPELINE_ID,
    workflowId: environment.CIRCLE_WORKFLOW_ID, jobNumber: environment.CIRCLE_BUILD_NUM, nodeVersion: process.version }, {
    entrypointSha256: digestFile('desktop/scripts/verify-action-live-g4-ci-windows.mjs'),
    profileCompilationProofSha256: digestFile('desktop/artifacts/action-live-profile/live-profile-verification-proof.json'),
    supportSourceCoordinatorSha256: digestFile('desktop/scripts/live-g4-api-support-source.mjs'),
    rustG4HarnessSourceSha256: digestFile('desktop/src-tauri/src/account_cloud_live_a41_g4_tests.rs'),
    rustG4CollaborationSourceSha256: digestFile('desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs'),
  }, sessionRegressions);
  // Only closed validators can reach the existing public artifact directory.
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'native-g4-report.public.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`LIVE_G4_CI_PASSED source=${source} installations=2 reopened=2 canonicalDrafts=1 providerDirect=false allGates=false\n`);
  return result;
}

// Separate test-only branch; the complete virgin recipe body above is retained.
async function runDedicatedContinuationCi(input) {
  for (const name of SECRET_NAMES) delete process.env[name];
  const environment = { ...process.env };
  need(typeof fetch === 'function' && typeof Headers.prototype.getSetCookie === 'function', 'node_fetch_cookie_runtime_required');
  const tracked = () => {
    requireTrackedG4Sources(environment);
    const options = { cwd: ROOT, env: compileEnvironment(environment), encoding: 'utf8', windowsHide: true, timeout: 30000 };
    need(execFileSync('git', ['ls-files', '--error-unmatch', '--', ...CONTINUATION_FILES], options).trim().split(/\r?\n/).sort().join('|')
      === [...CONTINUATION_FILES].sort().join('|'), 'continuation_ci_sources_must_be_tracked');
  };
  tracked();
  const source = environment.CIRCLE_SHA1, output = path.join(ROOT, OUTPUT);
  need(input.sourceSha === source && !fs.existsSync(output), 'continuation_fresh_source_artifacts_required');
  const schemas = captureTauriSchemaReconciliation(environment);
  process.stdout.write(`LIVE_CONTINUATION_CI_PHASE compile source=${source}\n`);
  await compileFreshSource(environment);
  let schemaReceipt;
  try { schemaReceipt = schemas.reconcile(); }
  catch (error) {
    const receipt = schemas.failureReceipt();
    if (receipt) fs.writeFileSync(path.join(ROOT, 'desktop/artifacts/action-live-profile/tauri-schema-reconciliation-refusal.public.json'),
      JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    throw error;
  }
  tracked();
  fs.writeFileSync(path.join(ROOT, 'desktop/artifacts/action-live-profile/tauri-schema-reconciliation.public.json'),
    JSON.stringify(schemaReceipt, null, 2) + '\n', { flag: 'wx' });
  process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true';
  let report, sessionRegressions;
  try {
    sessionRegressions = await runLiveSessionRegressions();
    process.stdout.write(`LIVE_CONTINUATION_SESSION_REGRESSIONS_PASSED source=${source} tests=3\n`);
    process.env[CONTINUATION_FLAG] = 'true';
    report = validatePublicContinuationReport(await runLiveG4Continuation(input), source);
  }
  finally { for (const name of [...RUN_FLAGS, CONTINUATION_FLAG]) delete process.env[name]; }
  const digestFile = relative => hash(fs.readFileSync(path.join(ROOT, relative)));
  const result = publicContinuationCiProof(report, { source, pipelineId: environment.ZENTRA_LIVE_PROFILE_PIPELINE_ID,
    workflowId: environment.CIRCLE_WORKFLOW_ID, jobNumber: environment.CIRCLE_BUILD_NUM, nodeVersion: process.version }, {
    entrypointSha256: digestFile('desktop/scripts/verify-action-live-g4-ci-windows.mjs'),
    profileCompilationProofSha256: digestFile('desktop/artifacts/action-live-profile/live-profile-verification-proof.json'),
    continuationCoordinatorSha256: digestFile('desktop/scripts/verify-action-live-g4-continuation.mjs'),
    rustContinuationHarnessSha256: digestFile('desktop/src-tauri/src/account_cloud_live_a41_g4_continuation_tests.rs'),
    rustContinuationAdapterSha256: digestFile('desktop/src-tauri/src/account_cloud_action_engine_continuation_support.rs'),
    rustParentHarnessSha256: digestFile('desktop/src-tauri/src/account_cloud_live_a41_g4_tests.rs'),
    rustCollaborationSupportSha256: digestFile('desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs'),
  }, sessionRegressions);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'native-continuation-report.public.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`LIVE_CONTINUATION_CI_PASSED source=${source} newStores=2 baselineRevision=1 canonicalDrafts=1 g5=false g6=false scheduler=false\n`);
  return result;
}

async function runDedicatedG5Ci(input) {
  for (const name of SECRET_NAMES) delete process.env[name];
  const environment = { ...process.env };
  need(typeof fetch === 'function' && typeof Headers.prototype.getSetCookie === 'function', 'node_fetch_cookie_runtime_required');
  const tracked = () => {
    requireTrackedG4Sources(environment);
    const options = { cwd: ROOT, env: compileEnvironment(environment), encoding:'utf8', windowsHide:true, timeout:30000 };
    const files = [...new Set([...CONTINUATION_FILES,...G5_FILES])];
    need(execFileSync('git', ['ls-files','--error-unmatch','--',...files], options).trim().split(/\r?\n/).sort().join('|')
      === files.sort().join('|'), 'g5_ci_sources_must_be_tracked');
  };
  tracked();
  const source = environment.CIRCLE_SHA1, output = path.join(ROOT, OUTPUT);
  need(input.sourceSha === source && !fs.existsSync(output), 'g5_fresh_source_artifacts_required');
  const schemas = captureTauriSchemaReconciliation(environment);
  process.stdout.write(`LIVE_G5_CI_PHASE compile source=${source}\n`);
  await compileFreshSource(environment);
  let schemaReceipt;
  try { schemaReceipt = schemas.reconcile(); }
  catch (error) {
    const receipt = schemas.failureReceipt();
    if (receipt) fs.writeFileSync(path.join(ROOT,'desktop/artifacts/action-live-profile/tauri-schema-reconciliation-refusal.public.json'),
      JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    throw error;
  }
  tracked();
  fs.writeFileSync(path.join(ROOT,'desktop/artifacts/action-live-profile/tauri-schema-reconciliation.public.json'),JSON.stringify(schemaReceipt,null,2)+'\n',{flag:'wx'});
  process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true';
  let report, sessionRegressions;
  try {
    sessionRegressions = await runLiveSessionRegressions();
    process.stdout.write(`LIVE_G5_SESSION_REGRESSIONS_PASSED source=${source} tests=3\n`);
    process.env[G5_FLAG] = 'true';
    report = validateG5Report(await runLiveG5Recipe(input),source);
  }
  finally { for (const name of [...RUN_FLAGS,CONTINUATION_FLAG,G5_FLAG]) delete process.env[name]; }
  const digestFile = relative => hash(fs.readFileSync(path.join(ROOT,relative)));
  const result = publicG5CiProof(report, {source,pipelineId:environment.ZENTRA_LIVE_PROFILE_PIPELINE_ID,
    workflowId:environment.CIRCLE_WORKFLOW_ID,jobNumber:environment.CIRCLE_BUILD_NUM,nodeVersion:process.version}, {
    entrypointSha256:digestFile('desktop/scripts/verify-action-live-g4-ci-windows.mjs'),
    profileCompilationProofSha256:digestFile('desktop/artifacts/action-live-profile/live-profile-verification-proof.json'),
    g5CoordinatorSha256:digestFile('desktop/scripts/verify-action-live-g5-windows.mjs'),
    rustG5HarnessSha256:digestFile('desktop/src-tauri/src/account_cloud_live_a41_g5_tests.rs'),
    rustG5AdapterSha256:digestFile('desktop/src-tauri/src/account_cloud_action_engine_g5_support.rs'),
    rustG5PublicationPortSha256:digestFile('desktop/src-tauri/src/company_collaboration_live_a41_g5_support.rs'),
    rustParentHarnessSha256:digestFile('desktop/src-tauri/src/account_cloud_live_a41_g4_continuation_tests.rs'),
    rustCollaborationSupportSha256:digestFile('desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs'),
  },sessionRegressions);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output,'native-g5-subset-report.public.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(`LIVE_G5_SUBSET_CI_PASSED source=${source} processStops=3 freshPreparationRequests=1 fullG5=false g6=false\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--describe')) process.stdout.write(JSON.stringify({
    inactiveByDefault: true, context: CONTEXT_NAME, privateContextVariables: SECRET_NAMES,
    historicalSourcesRefused: DESCRIPTION.historicalSourcesRefused, newCompilationRequired: true,
    baselineSourceWithoutG4Integration: G4_BASELINE_SOURCE,
    nativeExecution: 'dedicated Windows CI only', exactG4Test: DESCRIPTION.exactTest,
    continuationPrivateContextFormat: CONTINUATION_CONTEXT_FORMAT, exactContinuationTest: CONTINUATION.exactTest,
    legacyVirginPathAllowed: false,
    g5PrivateContextFormat: G5_CONTEXT_FORMAT, exactG5Tests: G5.exactTests,
    publicArtifactDirectory: OUTPUT, productActivation: false, directDecisionProviderProof: false,
  }) + '\n');
  else if (args.length === 1 && args[0] === '--ci-run') runDedicatedG4Ci().catch(error => {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'dedicated_live_g4_ci_failed';
    process.stderr.write(JSON.stringify({ passed: false, code }) + '\n'); process.exitCode = 1;
  });
  else { process.stderr.write('{"passed":false,"code":"explicit_g4_ci_run_required"}\n'); process.exitCode = 1; }
}
