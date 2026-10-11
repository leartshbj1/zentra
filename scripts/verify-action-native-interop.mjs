import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This consumer never builds Rust, creates a ZIP/database, downloads evidence,
// or treats a skipped/default Vitest run as native interoperability evidence.
const repository = fileURLToPath(new URL('..', import.meta.url));
const testFile = 'lib/action-engine/native-archive-interop.test.ts';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compareNames = (left, right) =>
  Number(left > right) - Number(left < right);
const fixedFilters = [
  ['action_engine_resources::tests::', 20],
  ['action_engine_quote::tests::', 67],
  ['action_engine_device_protocol::tests::', 33],
  ['account_cloud::action_engine::tests::', 29],
  ['backup::action_engine_archive_tests::', 4],
  ['company_collaboration::action_engine_collaboration_tests::', 3],
  ['company_collaboration::action_publication_tests::', 17],
  ['company_collaboration::action_execution_tests::', 8],
  ['company_collaboration::publication_recovery_tests::', 13],
  [
    'company_merge::tests::actual_v60_and_v61_references_merge_v62_branches_receipts_and_republish_fresh_resources',
    1,
    true,
  ],
  ['backup::recovery_tests::', 5],
  ['company_collaboration::reference_worker_tests::', 10],
  ['company_collaboration::content_version_compat_tests::', 7],
  ['company_collaboration::merge_version_compat_tests::', 3],
];
const crashPrefix = 'backup::recovery_crash_tests::';
const excludedCrashTests = [
  `${crashPrefix}native_crash_child`,
  `${crashPrefix}native_crash_boundaries_restore_one_complete_profile_before_migration`,
];

function required(value, name) {
  assert.equal(
    typeof value,
    'string',
    `${name} is required; no native evidence was executed.`,
  );
  assert.ok(value.trim(), `${name} must not be empty.`);
  return value;
}
function readBoundedFile(path, maximum) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    `Expected ordinary evidence file: ${path}`,
  );
  assert.ok(
    stat.size > 0 && stat.size <= maximum,
    `Evidence size is invalid: ${path}`,
  );
  return readFileSync(path);
}
function jsonFile(directory, name) {
  return JSON.parse(
    readBoundedFile(join(directory, name), 4 * 1024 * 1024).toString('utf8'),
  );
}
function names(value, count, label) {
  assert.ok(Array.isArray(value), `${label} is missing.`);
  assert.equal(value.length, count, `${label} count changed.`);
  assert.ok(
    value.every(
      (name) =>
        typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_:]*$/.test(name),
    ),
    `${label} contains an invalid test name.`,
  );
  assert.equal(new Set(value).size, count, `${label} contains duplicates.`);
  return value;
}

/** Read-only gate shared with the opt-in test. All inputs must be real artifacts. */
export function readNativeArchiveEvidence(environment = process.env) {
  const evidenceDirectory = realpathSync(
    required(
      environment.ZENTRA_ACTION_ARCHIVE_EVIDENCE,
      'ZENTRA_ACTION_ARCHIVE_EVIDENCE',
    ),
  );
  assert.ok(
    lstatSync(evidenceDirectory).isDirectory(),
    'The archive evidence directory is missing.',
  );
  const expectedSource = required(
    environment.ZENTRA_ACTION_NATIVE_SOURCE_SHA,
    'ZENTRA_ACTION_NATIVE_SOURCE_SHA',
  );
  assert.match(
    expectedSource,
    /^[a-f0-9]{40}$/,
    'Expected an exact native source SHA.',
  );
  const proofDirectory = realpathSync(
    environment.ZENTRA_ACTION_NATIVE_PROOF_DIR || dirname(evidenceDirectory),
  );
  const metadata = jsonFile(evidenceDirectory, 'synthetic-quote-metadata.json');
  assert.equal(metadata.format, 'zentra-action-quote-archive-fixture');
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.synthetic, true);
  assert.equal(metadata.nativeFixture, true);
  assert.equal(metadata.nativeSchemaVersion, 62);
  assert.equal(
    metadata.publicationContext,
    'synthetic_committed_no_remote_authority',
  );
  assert.equal(
    metadata.sourceCommit,
    expectedSource,
    'The archive is from another/unproven native source.',
  );
  assert.equal(
    metadata.archiveFile,
    'synthetic-quote.zentra',
    'Only the complete native fixture is accepted.',
  );
  const archivePath = join(evidenceDirectory, metadata.archiveFile);
  const archive = new Uint8Array(
    readBoundedFile(archivePath, 16 * 1024 * 1024),
  );
  assert.equal(archive.byteLength, metadata.archiveSizeBytes);
  assert.equal(digest(archive), metadata.archiveSha256);
  assert.equal(metadata.origin.archiveSha256, metadata.archiveSha256);

  const proof = jsonFile(
    proofDirectory,
    'diagnostics-action-engine-proof.json',
  );
  const harness = jsonFile(proofDirectory, 'windows-test-harness-proof.json');
  for (const record of [proof, harness]) {
    assert.equal(
      record.source,
      expectedSource,
      'Native proof source does not match the archive.',
    );
    assert.equal(record.verificationOnly, true);
    assert.equal(record.target, 'x86_64-pc-windows-msvc');
    assert.equal(record.nativeProfile, 'release');
    for (const flag of [
      'publishesInstaller',
      'publishesRelease',
      'installsApplication',
    ])
      assert.equal(record[flag], false);
  }
  assert.equal(proof.circleSource, expectedSource);
  assert.equal(proof.branch, 'codex/action-engine-native');
  assert.equal(proof.selection, 'action-engine');
  assert.equal(proof.data, 'synthetic');
  assert.equal(
    proof.nativeExecuted,
    true,
    'A written or compiled-only test is not an executed native proof.',
  );
  assert.equal(proof.nativeExecution, 'compiled-library-harness');
  assert.equal(proof.selectedNativeSuitesPassed, true);
  assert.equal(proof.nativeHarnessProof, 'windows-test-harness-proof.json');
  for (const flag of [
    'fullFunctionalExecuted',
    'frontendExecuted',
    'mobileExecuted',
    'frontendBuildExecuted',
    'benchmarksExecuted',
    'packagingExecuted',
    'signingExecuted',
  ])
    assert.equal(proof[flag], false);
  assert.equal(harness.contextMode, 'diagnostics-verification');
  assert.equal(
    harness.prepared,
    true,
    'Native harness preparation did not finish.',
  );
  assert.equal(harness.compileNoRun, true);
  assert.equal(
    harness.compileExit,
    0,
    'The exact native library harness did not compile.',
  );
  assert.equal(harness.loaderExitAfter, 0);
  assert.equal(harness.applicationManifestModified, false);
  assert.equal(harness.dllModified, false);
  assert.deepEqual(harness.compileArguments, [
    'test',
    '--manifest-path',
    'desktop/src-tauri/Cargo.toml',
    '--locked',
    '--release',
    '--lib',
    '--no-run',
    '--message-format=json',
  ]);
  assert.match(harness.binarySha256After, /^[a-f0-9]{64}$/);
  assert.equal(proof.expectedCoreCount, 195);
  assert.equal(proof.runtimePassed, 239);
  assert.deepEqual(proof.corroboration, {
    CorePassed: 195,
    RegressionPassed: 44,
    TotalPassed: 239,
    UniqueSelectedCount: 239,
    RuntimeCatalogCorroborated: true,
  });
  const core = names(proof.coreTestNames, 195, 'coreTestNames');
  const regression = names(
    proof.regressionTestNames,
    44,
    'regressionTestNames',
  );
  const selected = names(proof.selectedNames, 239, 'selectedNames');
  assert.deepEqual(
    [...core, ...regression].sort(compareNames),
    [...selected].sort(compareNames),
  );

  const catalogText = readBoundedFile(
    join(proofDirectory, 'windows-test-harness-list-after.txt'),
    4 * 1024 * 1024,
  ).toString('utf8');
  const catalog = [
    ...catalogText.matchAll(/^([A-Za-z_][A-Za-z0-9_:]*): test\r?$/gm),
  ].map((match) => match[1]);
  names(catalog, catalog.length, 'compiled libtest catalogue');
  assert.ok(catalog.some((name) => name.startsWith('diagnostics::')));
  assert.ok(
    selected.every((name) => catalog.includes(name)),
    'A selected name is absent from the compiled catalogue.',
  );
  const crashNames = catalog
    .filter((name) => name.includes(crashPrefix))
    .sort(compareNames);
  assert.equal(crashNames.length, 21);
  assert.ok(excludedCrashTests.every((name) => crashNames.includes(name)));
  const filters = [
    ...fixedFilters,
    ...crashNames
      .filter((name) => !excludedCrashTests.includes(name))
      .map((name) => [name, 1, true]),
  ];
  assert.equal(filters.length, 33);
  assert.deepEqual(
    proof.nativeFilters,
    filters.map(([name]) => name),
  );
  assert.deepEqual(
    proof.suiteExecutions,
    harness.suiteExecutions,
    'Diagnostic and harness runtime evidence disagree.',
  );
  assert.equal(harness.suiteExecutions.length, 33);
  const actualCore = [],
    actualRegression = [];
  for (const [index, [filter, count, exact]] of filters.entries()) {
    const suite = harness.suiteExecutions[index];
    const expectedNames = catalog.filter((name) =>
      exact ? name === filter : name.includes(filter),
    );
    assert.equal(expectedNames.length, count);
    (index < 10 ? actualCore : actualRegression).push(...expectedNames);
    assert.equal(suite.filter, filter);
    assert.equal(suite.contextMode, 'diagnostics-verification');
    assert.deepEqual(suite.extraArguments, exact ? ['--exact'] : []);
    assert.deepEqual(suite.nativeArguments, [
      filter,
      '--test-threads=1',
      ...(exact ? ['--exact'] : []),
    ]);
    for (const counter of ['exit', 'failed', 'ignored'])
      assert.equal(suite[counter], 0, `Native suite ${filter} has ${counter}.`);
    assert.equal(suite.selectedNames, count);
    assert.equal(suite.passed, count);
  }
  assert.deepEqual(actualCore, core);
  assert.deepEqual(actualRegression, regression);
  return {
    evidenceDirectory,
    proofDirectory,
    expectedSource,
    metadata,
    archivePath,
    archive,
    proof,
    harness,
  };
}

export function runNativeArchiveInterop(environment = process.env) {
  // All absence/source/compile/runtime gates run before deleting old reports or
  // launching Vitest. No fallback fixture or successful empty report exists.
  const evidence = readNativeArchiveEvidence(environment);
  const reportPath = join(
    evidence.evidenceDirectory,
    'server-native-archive-interop.vitest.json',
  );
  const summaryPath = join(
    evidence.evidenceDirectory,
    'server-native-archive-interop-proof.json',
  );
  for (const path of [reportPath, summaryPath])
    if (existsSync(path)) rmSync(path);
  const result = spawnSync(
    process.execPath,
    [
      join(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      join(repository, 'vitest.config.ts'),
      testFile,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    {
      cwd: repository,
      env: {
        ...environment,
        ZENTRA_ACTION_ARCHIVE_EVIDENCE: evidence.evidenceDirectory,
        ZENTRA_ACTION_NATIVE_SOURCE_SHA: evidence.expectedSource,
        ZENTRA_ACTION_NATIVE_PROOF_DIR: evidence.proofDirectory,
      },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Native archive interoperability failed.');
  const report = JSON.parse(
    readBoundedFile(reportPath, 8 * 1024 * 1024).toString('utf8'),
  );
  assert.equal(report.success, true);
  assert.ok(report.numTotalTests > 0);
  assert.equal(report.numPassedTests, report.numTotalTests);
  for (const field of ['numFailedTests', 'numPendingTests', 'numTodoTests'])
    assert.equal(
      report[field],
      0,
      'Skipped/failed tests are not interoperability proof.',
    );
  assert.equal(report.testResults.length, 1);
  assert.equal(
    resolve(report.testResults[0].name),
    resolve(repository, testFile),
  );
  assert.ok(
    report.testResults[0].assertionResults.every(
      (test) => test.status === 'passed',
    ),
  );
  assert.equal(
    digest(readBoundedFile(evidence.archivePath, 16 * 1024 * 1024)),
    evidence.metadata.archiveSha256,
    'The native ZIP changed during interoperability verification.',
  );
  const serverSource = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(serverSource.status, 0);
  const summary = {
    format: 'zentra-native-archive-server-interop',
    schemaVersion: 1,
    nativeSourceCommit: evidence.expectedSource,
    serverSourceCommit: serverSource.stdout.trim(),
    archiveSha256: evidence.metadata.archiveSha256,
    archiveSizeBytes: evidence.archive.byteLength,
    nativeCorePassed: 195,
    nativeRegressionPassed: 44,
    nativeTotalPassed: 239,
    serverTestsPassed: report.numPassedTests,
    serverTestsSkipped: 0,
    publicationContext: 'synthetic_committed_no_remote_authority',
    nativeArchiveRead: true,
    realSqlJsWasm: true,
    hostedPublicationVerified: false,
    productionDataUsed: false,
    publishesInstaller: false,
    publishesRelease: false,
  };
  // JSON evidence is emitted only after the one real-artifact suite passes.
  return { summary, summaryPath, reportPath };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { summary, summaryPath, reportPath } = runNativeArchiveInterop();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
      flag: 'wx',
    });
    process.stdout.write(
      `Native archive interoperability passed; report: ${reportPath}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Native archive interoperability refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
