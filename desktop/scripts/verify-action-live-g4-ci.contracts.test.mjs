// Pure local contracts only. No CI entrypoint, native child, HTTP or Cargo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertG4CiAdmission, compileEnvironment, privateInputFromEnvironment, validatePublicG4Report,
  validateSessionRegressionProof, publicCiProof, CONTEXT_NAME, SECRET_NAMES, G4_BASELINE_SOURCE }
  from './verify-action-live-g4-ci-windows.mjs';
import { DESCRIPTION as ACCOUNT, SESSION_REGRESSION_TESTS } from './verify-action-live-account-windows.mjs';
import { DESCRIPTION as G4 } from './verify-action-live-g4-windows.mjs';

// Manual pure contracts: no recipe entrypoint, native child, Cargo or real HTTP.
// This test is never wired into the secret-bearing CI job. Refuse any private
// context environment before fixtures can snapshot process.env or install mocks.
for (const name of ['ZENTRA_A41_SITES_SERVICE_TOKEN', 'ZENTRA_A41_BROWSER_COOKIE_QA']) {
  if (Object.hasOwn(process.env, name)) throw new Error('PURE_CONTRACTS_REFUSE_PRIVATE_ENVIRONMENT');
}
globalThis.fetch = async () => { throw new Error('PURE_CONTRACTS_NETWORK_DISABLED'); };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
let yaml;
try { yaml = require('js-yaml'); } catch {
  const base = path.join(root, 'node_modules/.pnpm');
  const name = fs.readdirSync(base).find(value => value.startsWith('js-yaml@4.'));
  yaml = require(path.join(base, name, 'node_modules/js-yaml/index.js'));
}
let checks = 0, matrixCases = 0;
const ok = fn => { fn(); checks++; };
const no = fn => { assert.throws(fn); checks++; };
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const baselineSource = '91a859eefb3ecc88716e34d77b3aa9f91a412e8c';
// These public pins were calculated from the A50/91a Git objects. No Git history
// or ignored .qa proof is needed to run this test in a fresh checkout.
const baselinePins = {
  ".circleci/config.yml": "5646bb2aaa81b7a5207d2c6c594b5c4bfac802d748d45ab48f0f1daa597feb66",
  "desktop/src-tauri/src/account_cloud.rs": "9d8d4cd86e30da0070864a51ce7c0a84cebf5220835d0fae82752e5ae9d339d9",
  "desktop/src-tauri/src/company_collaboration.rs": "2772b6bd498b57187b6753d2b074c501e0c0e035c7463d2b16146e2c2d302fee",
  "desktop/scripts/verify-action-live-account-ci-windows.mjs": "13c7c1444dd7c0ce7fcfb18f4a4219934c0852166e44dfb0438f4f451e373377",
  "desktop/scripts/verify-action-live-account-windows.mjs": "6b29fba3ec6ed428261048be445a7f24ba8e9008f8b8494088cae31124496295",
  "desktop/scripts/verify-action-live-profile-windows.ps1": "305fc3717bf52ff6578e969748ee756d5f6580b220d9de6cd1ce61c3770ad2fa",
  "desktop/src-tauri/src/account_cloud_live_a41_tests.rs": "e5cae2a2a2664d96744f6b13507d19f26d537a31d43c1722e822331ae8033384",
  "desktop/src-tauri/Cargo.toml": "77b74b439a749eeb9d84ca995f2359a61e9b53f76790e5cdf7bbe5d37a80ab10",
  "desktop/src-tauri/src/database.rs": "c5659ddbeb1bfbef616737c9c08c62d95f74895822a20e02fcdd15483d756aa9"
};
const normalizedDigest = value => digest(value.replace(/\r\n/g, '\n'));
const env = { CIRCLECI: 'true', OS: 'Windows_NT', CIRCLE_JOB: 'windows-action-live-account-tests',
  CIRCLE_BRANCH: 'codex/action-engine-native-live-a41', CIRCLE_NODE_INDEX: '0', CIRCLE_NODE_TOTAL: '1',
  ZENTRA_VERIFY_DIAGNOSTICS_ONLY: 'true', ZENTRA_VERIFY_ONLY: 'true', ZENTRA_VERIFY_NATIVE_PROFILE_ONLY: 'false',
  ZENTRA_VERIFY_LIVE_PROFILE_ONLY: 'false', ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY: 'true', ZENTRA_LIVE_PROFILE_RELEASE: 'false',
  ZENTRA_DIAGNOSTICS_NATIVE_SET: 'action-engine', RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc',
  CIRCLE_SHA1: 'f'.repeat(40), CIRCLE_BUILD_NUM: '999', CIRCLE_WORKFLOW_ID: randomUUID(),
  ZENTRA_LIVE_PROFILE_PIPELINE_ID: randomUUID(), SystemRoot: 'synthetic-windows-root', PATH: 'public-synthetic-path' };
ok(() => assertG4CiAdmission(env, 'win32', '22.0.0'));
ok(() => assert.equal(G4_BASELINE_SOURCE, baselineSource));
no(() => assertG4CiAdmission({ ...env, CIRCLE_SHA1: baselineSource }, 'win32', '22.0.0'));
for (const name of Object.keys(env).filter(value => !['SystemRoot', 'PATH'].includes(value))) {
  const missing = { ...env }; delete missing[name];
  no(() => assertG4CiAdmission(missing, 'win32', '22.0.0'));
  no(() => assertG4CiAdmission({ ...env, [name]: 'invalid' }, 'win32', '22.0.0'));
}
for (const source of G4.historicalSourcesRefused) no(() => assertG4CiAdmission({ ...env, CIRCLE_SHA1: source }, 'win32', '22.0.0'));
no(() => assertG4CiAdmission(env, 'linux', '22.0.0'));
no(() => assertG4CiAdmission(env, 'win32', '20.0.0'));
for (const name of ['CARGO_TARGET_DIR', 'ZENTRA_ACTION_NATIVE_TEST_CONTEXT', 'ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON',
  'ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256', 'ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE',
  'ZENTRA_RUN_LIVE_ACCOUNT_RECIPE', 'ZENTRA_RUN_LIVE_G4_RECIPE'])
  no(() => assertG4CiAdmission({ ...env, [name]: 'true' }, 'win32', '22.0.0'));
const privateEnv = { ...env, [SECRET_NAMES[0]]: 'synthetic-site-token-never-used-'.repeat(2),
  [SECRET_NAMES[1]]: `__Host-zentra_access=synthetic-access; __Host-zentra_refresh=synthetic-refresh; __Host-zentra_session_owner=${ACCOUNT.expectedOwnerId}`,
  STRIPE_SECRET_KEY: 'synthetic-unused', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-unused', CIRCLE_TOKEN: 'synthetic-unused',
  ZENTRA_RUN_LIVE_ACCOUNT_RECIPE: 'true', ZENTRA_RUN_LIVE_G4_RECIPE: 'true' };
ok(() => privateInputFromEnvironment(privateEnv));
for (const name of SECRET_NAMES) { const missing = { ...privateEnv }; delete missing[name]; no(() => privateInputFromEnvironment(missing)); }
const compiler = compileEnvironment(privateEnv);
for (const name of [...SECRET_NAMES, 'STRIPE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CIRCLE_TOKEN',
  'ZENTRA_RUN_LIVE_ACCOUNT_RECIPE', 'ZENTRA_RUN_LIVE_G4_RECIPE']) ok(() => assert(!Object.hasOwn(compiler, name)));
ok(() => assert.equal(compiler.ZENTRA_VERIFY_LIVE_PROFILE_ONLY, 'true'));
ok(() => assert.equal(compiler.ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY, 'false'));

const installations = [0, 1].map(() => ({ installationId: randomUUID(), licenseId: `lic_${randomUUID()}`,
  accountSessionId: `dss_${randomUUID()}`, jti: randomUUID(), licenseSha256: 'a'.repeat(64) }));
const account = { format: 'zentra-a41-native-account-report-v1', source: env.CIRCLE_SHA1, binarySha256: 'a'.repeat(64),
  coordinatorSha256: 'b'.repeat(64), rustHarnessSourceSha256: 'c'.repeat(64), profileSha256: ACCOUNT.profileSha256,
  siteOrigin: 'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site', ownerId: ACCOUNT.expectedOwnerId,
  organizationId: ACCOUNT.expectedOrganizationId, phases: ['enroll', 'reopen'].map(phase => ({ phase,
    exactTest: ACCOUNT.exactTests[phase], strictMeHttp200: true, nativeLicenseValidated: true, installations: structuredClone(installations) })),
  sameExecutableBothPhases: true, separateNativeProcesses: true, protectedStateReopened: true, browserApprovals: 2,
  nativeExecuted: true, stripePaidTestValidated: false, actionEngineExecuted: false, serverSourceDirectlyAttested: false, automaticCleanup: false };
const initial = { snapshotId: randomUUID(), baseRevision: 0, revision: 1, archiveSha256: 'd'.repeat(64),
  manifestSha256: 'e'.repeat(64), sizeBytes: 12345, transport: 'content-v1', gatewayPgFactAndD1Committed: true };
const canonical = { ...initial, snapshotId: randomUUID(), baseRevision: 1, revision: 2, archiveSha256: 'f'.repeat(64), manifestSha256: '0'.repeat(64) };
const sourceId = randomUUID();
const quote = { sourceId, proposalId: randomUUID(), reservationId: randomUUID(), fingerprint: '1'.repeat(64), quoteId: randomUUID(),
  customerId: randomUUID(), articleId: randomUUID(), receiptSha256: '2'.repeat(64), lineIds: [randomUUID()],
  quoteCount: 1, receiptCount: 1, quoteNumber: null, status: 'draft', requiresHumanValidation: true,
  nativeFrozenCreationVerified: true, auditChainValid: true };
const report = { format: 'zentra-a41-native-g4-report-v1', source: env.CIRCLE_SHA1, binarySha256: account.binarySha256,
  profileSha256: G4.profileSha256, coordinatorSha256: '3'.repeat(64), exactTest: G4.exactTest, account,
  g4: { initialPublication: initial, canonicalPublication: canonical, quote, secondStoreExactCreation: true,
    secondRoundConfirmed: 0, writerActivityCount: 1, secondStoreActivityCount: 0, strictMeHttp200Both: true },
  sourceLifecycle: { workspaceId: `support_${randomUUID()}`, connectionId: randomUUID(), sourceId, sourceRevision: 2,
    sourceEnvelopeSha256: '4'.repeat(64), actualApiHookPersisted: true, actualHumanQuoteClassification: true,
    actualGestionDelegation: true, automaticSupportClassificationExecuted: false, thirdPartyMailboxExecuted: false },
  sameExecutableAllThreePhases: true, storesCreatedInThisJob: true, nativeExecuted: true, actualApiSupportLifecycle: true,
  realDecisionProviderDirectlyAttested: false, g5FailureMatrixExecuted: false, storageV0Executed: false, automaticCleanup: false };
ok(() => validatePublicG4Report(report, env.CIRCLE_SHA1));
const mutate = fn => { const changed = structuredClone(report); fn(changed); return changed; };
const select = (value, parts) => parts.reduce((next, part) => next[part], value);
const layers = [[], ['account'], ['account', 'phases', 0], ['account', 'phases', 0, 'installations', 0],
  ['g4'], ['g4', 'initialPublication'], ['g4', 'canonicalPublication'], ['g4', 'quote'], ['sourceLifecycle']];
for (const parts of layers) {
  for (const field of Object.keys(select(report, parts))) no(() => validatePublicG4Report(mutate(value => { delete select(value, parts)[field]; }), env.CIRCLE_SHA1));
  for (const field of ['cookie', 'password', 'sitesServiceToken', 'userCode', 'deviceCode', 'licenseToken', 'sessionSha256', 'rootDir', 'providerResult'])
    no(() => validatePublicG4Report(mutate(value => { select(value, parts)[field] = 'synthetic-unused'; }), env.CIRCLE_SHA1));
}
for (const field of ['sameExecutableAllThreePhases', 'storesCreatedInThisJob', 'nativeExecuted', 'actualApiSupportLifecycle',
  'realDecisionProviderDirectlyAttested', 'g5FailureMatrixExecuted', 'storageV0Executed', 'automaticCleanup'])
  no(() => validatePublicG4Report({ ...report, [field]: !report[field] }, env.CIRCLE_SHA1));
for (const change of [value => { value.binarySha256 = '5'.repeat(64); }, value => { value.sourceLifecycle.sourceId = randomUUID(); },
  value => { value.account.phases[1].installations[0].licenseSha256 = '5'.repeat(64); },
  value => { value.g4.canonicalPublication = value.g4.initialPublication; }, value => { value.g4.quote.quoteCount = 2; },
  value => { value.g4.quote.receiptCount = 0; }, value => { value.g4.writerActivityCount = 0; },
  value => { value.g4.secondStoreActivityCount = 1; }, value => { value.g4.secondStoreExactCreation = false; },
  value => { value.g4.initialPublication.gatewayPgFactAndD1Committed = false; },
  value => { value.g4.canonicalPublication.transport = 'storage-v0'; }, value => { value.exactTest = 'other::test'; },
  value => { value.profileSha256 = '5'.repeat(64); }, value => { value.binarySha256 = [value.binarySha256]; },
  value => { value.sourceLifecycle.sourceEnvelopeSha256 = [value.sourceLifecycle.sourceEnvelopeSha256]; },
  value => { value.g4.quote.proposalId = [value.g4.quote.proposalId]; }, value => { value.g4.quote.lineIds[0] = [value.g4.quote.lineIds[0]]; },
  value => { value.g4.initialPublication.snapshotId = [value.g4.initialPublication.snapshotId]; }])
  no(() => validatePublicG4Report(mutate(change), env.CIRCLE_SHA1));
for (const source of G4.historicalSourcesRefused) no(() => validatePublicG4Report({ ...report, source }, source));
no(() => validatePublicG4Report({ ...report, source: baselineSource }, baselineSource));
const identity = { source: env.CIRCLE_SHA1, pipelineId: env.ZENTRA_LIVE_PROFILE_PIPELINE_ID,
  workflowId: env.CIRCLE_WORKFLOW_ID, jobNumber: env.CIRCLE_BUILD_NUM, nodeVersion: 'v22.0.0' };
const hashes = Object.fromEntries(['entrypointSha256', 'profileCompilationProofSha256', 'supportSourceCoordinatorSha256',
  'rustG4HarnessSourceSha256', 'rustG4CollaborationSourceSha256'].map(field => [field, '6'.repeat(64)]));
const sessionRegressions = { format: 'zentra-a41-native-session-regressions-v1', source: env.CIRCLE_SHA1,
  binarySha256: report.binarySha256, tests: [...SESSION_REGRESSION_TESTS], passed: 3, nativeExecuted: true };
ok(() => validateSessionRegressionProof(sessionRegressions, env.CIRCLE_SHA1, report.binarySha256));
for (const field of Object.keys(sessionRegressions)) {
  const missing = structuredClone(sessionRegressions); delete missing[field];
  no(() => validateSessionRegressionProof(missing, env.CIRCLE_SHA1, report.binarySha256));
}
for (const patch of [{ source: 'e'.repeat(40) }, { source: [env.CIRCLE_SHA1] },
  { binarySha256: 'e'.repeat(64) }, { binarySha256: [report.binarySha256] },
  { format: 'other' }, { tests: SESSION_REGRESSION_TESTS.slice(1) }, { tests: [...SESSION_REGRESSION_TESTS].reverse() },
  { tests: [SESSION_REGRESSION_TESTS[0], SESSION_REGRESSION_TESTS[0], SESSION_REGRESSION_TESTS[2]] },
  { tests: SESSION_REGRESSION_TESTS.map(test => [test]) }, { passed: '3' }, { passed: 2 }, { nativeExecuted: false },
  { tests: new Array(SESSION_REGRESSION_TESTS.length) },
  { cookie: 'synthetic-unused' }, { profileSha256: ACCOUNT.profileSha256 }])
  no(() => validateSessionRegressionProof({ ...sessionRegressions, ...patch }, env.CIRCLE_SHA1, report.binarySha256));
const proof = publicCiProof(report, identity, hashes, sessionRegressions);
ok(() => assert.deepEqual(proof.sessionRegressions, sessionRegressions));
ok(() => assert.equal(Object.hasOwn(proof.report, 'sessionRegressions'), false));
ok(() => assert.deepEqual(proof.claims, { g1g2NativeAccountJourneyValidated: true, g4NominalContentV1PathValidated: true,
  allActionEngineGatesEstablished: false, stripePaidTestDirectlyValidated: false, realDecisionProviderDirectlyAttested: false,
  g5FailureMatrixExecuted: false, g6FullServiceParityEstablished: false, storageV0Executed: false, autopilotProductActivated: false }));
for (const field of Object.keys(identity)) { const missing = { ...identity }; delete missing[field]; no(() => publicCiProof(report, missing, hashes, sessionRegressions)); }
for (const field of Object.keys(hashes)) { const missing = { ...hashes }; delete missing[field]; no(() => publicCiProof(report, identity, missing, sessionRegressions));
  no(() => publicCiProof(report, identity, { ...hashes, [field]: [hashes[field]] }, sessionRegressions)); }
no(() => publicCiProof(report, { ...identity, jobNumber: 999 }, hashes, sessionRegressions));
no(() => publicCiProof(report, { ...identity, password: 'synthetic-unused' }, hashes, sessionRegressions));
no(() => publicCiProof(report, identity, { ...hashes, providerResult: 'synthetic-unused' }, sessionRegressions));
no(() => publicCiProof(report, identity, hashes));
no(() => publicCiProof(report, identity, hashes, { ...sessionRegressions, source: baselineSource }));
no(() => publicCiProof(report, identity, hashes, { ...sessionRegressions, binarySha256: 'e'.repeat(64) }));

const currentYaml = read('.circleci/config.yml');
const oldYaml = currentYaml.replace('node desktop/scripts/verify-action-live-g4-ci-windows.mjs --ci-run',
  'node desktop/scripts/verify-action-live-account-ci-windows.mjs --ci-run');
ok(() => assert.equal(normalizedDigest(oldYaml), baselinePins['.circleci/config.yml']));
const old = yaml.load(oldYaml);
const current = yaml.load(currentYaml);
const expected = structuredClone(old);
expected.jobs['windows-action-live-account-tests'].steps[1].run.command = 'node desktop/scripts/verify-action-live-g4-ci-windows.mjs --ci-run';
ok(() => assert.deepEqual(current, expected));
ok(() => assert.equal(JSON.stringify(current).split(CONTEXT_NAME).length - 1, 1));
ok(() => assert.equal(current.workflows['action-live-account-verification'].jobs[0]['windows-action-live-account-tests'].context, CONTEXT_NAME));
const resolve = (value, context) => typeof value !== 'string' ? value : value === '<< pipeline.git.branch >>' ? context.branch
  : value.startsWith('<< pipeline.parameters.') ? context.parameters[value.slice(23, -3)] : value;
function evaluate(condition, context) {
  if (typeof condition !== 'object') return resolve(condition, context);
  const [[operator, args]] = Object.entries(condition);
  if (operator === 'and') return args.every(value => evaluate(value, context));
  if (operator === 'or') return args.some(value => evaluate(value, context));
  if (operator === 'not') return !evaluate(args, context);
  if (operator === 'equal') return resolve(args[0], context) === resolve(args[1], context);
  throw new Error('unknown condition');
}
const active = (configuration, context) => Object.entries(configuration.workflows)
  .filter(([, value]) => evaluate(value.when, context)).map(([name]) => name).sort();
const defaults = Object.fromEntries(Object.entries(current.parameters).map(([name, value]) => [name, value.default]));
for (const branch of ['codex/action-engine-native-live-a41', 'codex/action-engine-native', 'main', 'codex/release-1.90.14-20261006',
  'codex/drafts-errors-diagnostics-20261001', 'codex/release-1.86.0', 'codex/release-1.90.13-20261004'])
  for (let bits = 0; bits < 64; bits++) for (const diagnostics of ['full', 'action-engine', 'native-mail-payroll']) for (const platform of ['all', 'windows', 'apple']) {
    const parameters = { ...defaults, 'verify-only': Boolean(bits & 1), 'verify-native-profile-only': Boolean(bits & 2),
      'verify-live-profile-only': Boolean(bits & 4), release: Boolean(bits & 8), 'smoke-windows-job': bits & 16 ? 1 : 0,
      'smoke-apple-job': bits & 32 ? 1 : 0, 'diagnostics-native-set': diagnostics, platform, 'verify-live-account-only': false };
    assert.deepEqual(active(current, { branch, parameters }), active(old, { branch, parameters })); matrixCases++;
  }
const live = { branch: env.CIRCLE_BRANCH, parameters: { ...defaults, 'verify-only': true,
  'verify-live-account-only': true, 'diagnostics-native-set': 'action-engine' } };
ok(() => assert.deepEqual(active(current, live), ['action-live-account-verification']));
for (const [field, value] of [['verify-only', false], ['verify-live-profile-only', true], ['verify-native-profile-only', true],
  ['release', true], ['diagnostics-native-set', 'full'], ['smoke-windows-job', 1], ['smoke-apple-job', 1]])
  ok(() => assert.deepEqual(active(current, { ...live, parameters: { ...live.parameters, [field]: value } }), []));
for (const branch of ['main', 'codex/action-engine-native', 'codex/release-1.90.14-20261006'])
  ok(() => assert.deepEqual(active(current, { ...live, branch }), []));
const files = ['desktop/scripts/verify-action-live-account-ci-windows.mjs', 'desktop/scripts/verify-action-live-account-windows.mjs',
  'desktop/scripts/verify-action-live-profile-windows.ps1', 'desktop/src-tauri/src/account_cloud_live_a41_tests.rs'];
for (const file of files) ok(() => {
  let source=read(file).replace(/\r\n/g,'\n');
  if(file==='desktop/scripts/verify-action-live-profile-windows.ps1') {
    const addition="    . (Join-Path $PSScriptRoot 'quote-autopilot-verification.ps1')\n    $autopilotProof = Invoke-ZentraAutopilotProductVerification -Harness $harness -Source $source -ProfileSha256 $expectedSha -Artifacts $artifacts\n    if (-not $autopilotProof.passed) { throw 'Autopilot product native validation did not pass.' }\n";
    assert.equal(source.split(addition).length,2); source=source.replace(addition,'');
    const projection='            # This historical proof continues to describe only its eleven\n            # profile tests. The additional nine have their own closed receipt.\n            $proof.suiteExecutions = @($harnessRecord.suiteExecutions | Select-Object -First 11)';
    assert.equal(source.split(projection).length,2); source=source.replace(projection,'            $proof.suiteExecutions = @($harnessRecord.suiteExecutions)');
  }
  assert.equal(normalizedDigest(source),baselinePins[file]);
});
for (const [file, declaration] of [['desktop/src-tauri/src/account_cloud.rs', '#[cfg(all(test, windows))]\n#[path = "account_cloud_live_a41_g4_tests.rs"]\nmod live_a41_g4_tests;\n\n'],
  ['desktop/src-tauri/src/company_collaboration.rs', '#[cfg(all(test, windows))]\n#[path = "company_collaboration_live_a41_g4_support.rs"]\npub(crate) mod live_a41_g4_support;\n\n']]) {
  let source = read(file).replace(/\r\n/g, '\n');
  if(file==='desktop/src-tauri/src/account_cloud.rs') {
    for(const route of ['quote-consent','quote-activity','quote-review']) {
      const addition=`            | "/api/account/automation/${route}"\n`;
      // The existing writer paths are unchanged. Only these fixed read/CAS
      // product routes are added; no caller-selected origin becomes authority.
      assert.equal(source.split(addition).length,2);source=source.replace(addition,'');
    }
  }
  ok(() => assert.equal(source.split(declaration).length, 2));
  ok(() => assert.equal(normalizedDigest(source.replace(declaration, '')), baselinePins[file]));
}
const entry = read('desktop/scripts/verify-action-live-g4-ci-windows.mjs');
const run = entry.slice(entry.indexOf('export async function runDedicatedG4Ci()'));
ok(() => assert(run.indexOf('delete process.env[name]') < run.indexOf('requireTrackedG4Sources(environment)')));
ok(() => assert(run.indexOf('requireTrackedG4Sources(environment)') < run.indexOf('captureTauriSchemaReconciliation(environment)')));
ok(() => assert(run.indexOf('captureTauriSchemaReconciliation(environment)') < run.indexOf('await compileFreshSource(environment)')));
ok(() => assert(run.indexOf('await compileFreshSource(environment)') < run.indexOf('schemas.reconcile()')));
ok(() => assert(run.indexOf('schemas.reconcile()') < run.indexOf("process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true'")));
ok(() => assert(run.includes('tauri-schema-reconciliation.public.json') && run.includes("{ flag: 'wx' }")));
ok(() => assert(run.includes('tauri-schema-reconciliation-refusal.public.json') && run.includes('schemas.failureReceipt()')));
ok(() => assert(entry.slice(entry.indexOf('const G4_FILES'), entry.indexOf('class Refusal')).includes("'desktop/scripts/tauri-schema-reconciliation.mjs'")));
ok(() => assert(read('desktop/scripts/verify-action-live-g4-windows.mjs').includes("need(await gitRead(['rev-parse', 'HEAD']) === env.CIRCLE_SHA1\n    && await gitRead(['status', '--porcelain', '--untracked-files=no']) === '', 'g4_clean_exact_source_required');")));
ok(() => assert(run.indexOf('await compileFreshSource(environment)') < run.indexOf("process.env.ZENTRA_RUN_LIVE_G4_RECIPE = 'true'")));
ok(() => assert(run.indexOf('await compileFreshSource(environment)') < run.indexOf("process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true'")));
ok(() => assert(run.indexOf("process.env.ZENTRA_RUN_LIVE_ACCOUNT_RECIPE = 'true'") < run.indexOf('await runLiveSessionRegressions()')));
ok(() => assert(run.indexOf('await runLiveSessionRegressions()') < run.indexOf("process.env.ZENTRA_RUN_LIVE_G4_RECIPE = 'true'")));
ok(() => assert(run.indexOf('await runLiveSessionRegressions()') < run.indexOf('await runLiveG4Recipe(input)')));
ok(() => assert(run.includes('}, sessionRegressions);')));
ok(() => assert(run.includes('finally { for (const name of RUN_FLAGS) delete process.env[name]; }')));
ok(() => assert(run.indexOf('publicCiProof(report,') < run.indexOf("fs.writeFileSync(path.join(output, 'native-g4-report.public.json')")));
ok(() => assert(entry.includes("stdio: ['ignore', 'inherit', 'inherit']") && entry.includes('env: compilerEnvironment')));
ok(() => assert(entry.includes("else if (args.length === 1 && args[0] === '--ci-run')")));
for (const file of ['desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/src/database.rs'])
  ok(() => assert.equal(normalizedDigest(read(file)), baselinePins[file]));
ok(() => assert(!JSON.stringify(current).includes('contracts.test.mjs')));
console.log(JSON.stringify({ result: 'PURE_G4_CI_CONTRACTS_OK', checks, matrixCases, contextAttachedOnce: true,
  baselineSource, sourceBaselinePinsChecked: Object.keys(baselinePins).length, baselineBodiesPreservedWithExplicitProductAdditions: files.length,
  ignoredQaDependency: false, gitHistoryRequired: false, automaticallyWiredIntoCi: false,
  sessionRegressionProofSeparate: true, sameRegressionAndG4BinaryRequired: true,
  rustModulesDeclaredTestWindowsOnly: true, rustCompiled: false, nativeExecuted: false, cargoExecuted: false,
  networkUsed: false, cloudChanged: false }));
