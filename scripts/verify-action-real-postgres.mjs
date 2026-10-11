import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRealPostgresConfiguration } from './action-real-postgres-evidence.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const testFile =
  'lib/action-engine/publication-coordination.real-postgres.test.ts';
const migrations = [
  '202609140200_company_collaboration',
  '202609200300_company_content',
  '20261007194528_international_workspace_country_config',
  '20261008001726_new_us_workspace_admission',
  '20261011011348_action_engine_publication_coordination',
].map((name) => `supabase/migrations/${name}.sql`);
const sourceFiles = [
  testFile,
  ...migrations,
  'scripts/action-real-postgres-evidence.mjs',
  'scripts/verify-action-real-postgres.mjs',
];
export const REAL_POSTGRES_CASE_NAMES = Object.freeze([
  'observes a head-row lock between independent PostgreSQL backends',
  'serializes two same-base commits into one publication and one cancellation',
  'serializes concurrent replay of the same operation exactly once',
  'returns the committed receipt when close waits behind commit',
  'tombstones before a delayed commit, including an absent candidate',
  'lets a waiting close cancel after the unpublished commit rolls back',
  'preserves exact receipts after a newer head, pruning and identity mismatch',
  'enforces anon/authenticated ACLs, service mutation guards and legacy refusal',
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function bytes(path, maximum = 8 * 1024 * 1024) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= maximum,
    'Ordinary bounded test evidence is required.',
  );
  return readFileSync(path);
}
function git(arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: repository,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(
    result.status,
    0,
    'The exact tracked test source could not be corroborated.',
  );
  return result.stdout.trim();
}
function source(configuration) {
  assert.equal(
    git(['rev-parse', 'HEAD']),
    configuration.sourceCommit,
    'The current source does not match the requested PostgreSQL test source.',
  );
  git(['ls-files', '--error-unmatch', ...sourceFiles]);
  git([
    'diff',
    '--exit-code',
    configuration.sourceCommit,
    '--',
    ...sourceFiles,
  ]);
  return new Map(
    sourceFiles.map((path) => [path, digest(bytes(join(repository, path)))]),
  );
}
function readJson(path) {
  return JSON.parse(bytes(path).toString('utf8'));
}

export function runRealPostgresVerification(environment = process.env) {
  // Invalid or absent configuration is refused before any subprocess, driver
  // import, connection, deletion, SQL or evidence overwrite.
  const configuration = readRealPostgresConfiguration(environment);
  const originalHashes = source(configuration);
  const directory = dirname(configuration.reportFile);
  const vitestReport = join(
    directory,
    `action-engine-real-postgres-${configuration.runId}.vitest.json`,
  );
  const summaryPath = join(
    directory,
    `action-engine-real-postgres-${configuration.runId}.summary.json`,
  );
  assert.ok(
    !existsSync(vitestReport) && !existsSync(summaryPath),
    'A fresh report destination is required; old evidence is never overwritten.',
  );
  // The test receives only system runtime settings and its dedicated selectors.
  // No Supabase, Stripe, email, provider or other production credential passes.
  const allowed =
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|CI|CIRCLECI|CIRCLE_SHA1|NODE_EXTRA_CA_CERTS)$/i;
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        allowed.test(key) ||
        key === 'ZENTRA_ACTION_REAL_PG' ||
        key.startsWith('ZENTRA_ACTION_REAL_PG_'),
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      join(repository, 'vitest.config.ts'),
      testFile,
      '--reporter=json',
      `--outputFile=${vitestReport}`,
    ],
    {
      cwd: repository,
      env: childEnvironment,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ok(
    !result.error,
    'The isolated PostgreSQL test process did not finish.',
  );
  assert.equal(result.status, 0, 'The isolated PostgreSQL test failed.');
  const report = readJson(vitestReport);
  assert.equal(report.success, true);
  assert.equal(report.numTotalTests, REAL_POSTGRES_CASE_NAMES.length);
  assert.equal(report.numPassedTests, REAL_POSTGRES_CASE_NAMES.length);
  for (const field of ['numFailedTests', 'numPendingTests', 'numTodoTests'])
    assert.equal(
      report[field],
      0,
      'An omitted or failed test is not a PostgreSQL concurrency proof.',
    );
  assert.equal(report.testResults.length, 1);
  assert.equal(
    resolve(report.testResults[0].name),
    resolve(repository, testFile),
  );
  assert.deepEqual(
    report.testResults[0].assertionResults.map((test) => test.title),
    REAL_POSTGRES_CASE_NAMES,
  );
  assert.ok(
    report.testResults[0].assertionResults.every(
      (test) => test.status === 'passed',
    ),
  );
  const proofBytes = bytes(configuration.reportFile);
  const proof = JSON.parse(proofBytes.toString('utf8'));
  assert.equal(proof.format, 'zentra-action-real-postgres-proof');
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.synthetic, true);
  assert.equal(proof.gate, 'G3');
  assert.equal(proof.status, 'passed');
  assert.equal(proof.runId, configuration.runId);
  assert.equal(proof.sourceCommit, configuration.sourceCommit);
  assert.equal(proof.testFile, testFile);
  assert.equal(proof.testSha256, originalHashes.get(testFile));
  assert.deepEqual(proof.pgModule, {
    name: 'pg',
    version: configuration.moduleVersion,
  });
  assert.deepEqual(proof.target, {
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
  });
  assert.ok(
    typeof proof.server.version === 'string' && proof.server.version.length > 0,
  );
  const pids = proof.server.backendPids;
  assert.deepEqual(Object.keys(pids).sort(), [
    'control',
    'first',
    'observer',
    'second',
  ]);
  const backendPids = Object.values(pids);
  assert.ok(backendPids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  assert.equal(new Set(backendPids).size, 4);
  assert.deepEqual(proof.preflight, {
    databaseInitiallyEmpty: true,
    dedicatedClusterChecked: true,
    noOtherClientsInitially: true,
    qaOwnerCreateRoleRequired: true,
    qaOwnerSuperuser: false,
    roleCreatedByUnchangedMigration: 'zentra_us_admission_owner',
    fixtureRetained: true,
  });
  assert.deepEqual(
    proof.migrations,
    migrations.map((file) => ({ file, sha256: originalHashes.get(file) })),
  );
  assert.deepEqual(
    proof.cases,
    REAL_POSTGRES_CASE_NAMES.map((name) => ({ name, passed: true })),
  );
  assert.ok(
    Array.isArray(proof.locks) && proof.locks.length === 6,
    'Real observed lock waits are required, not a Promise.all scheduling assumption.',
  );
  assert.deepEqual(
    proof.locks.map((lock) => lock.case),
    REAL_POSTGRES_CASE_NAMES.slice(0, 6),
    'Each concurrency case must observe its own independent backend lock.',
  );
  for (const lock of proof.locks) {
    assert.ok(REAL_POSTGRES_CASE_NAMES.includes(lock.case));
    assert.ok(
      backendPids.includes(lock.blockedPid) &&
        backendPids.includes(lock.blockerPid),
    );
    assert.notEqual(lock.blockedPid, lock.blockerPid);
    assert.equal(lock.state, 'active');
    assert.equal(lock.waitEventType, 'Lock');
    assert.ok(typeof lock.waitEvent === 'string' && lock.waitEvent.length > 0);
    assert.ok(
      Array.isArray(lock.blockingPids) &&
        lock.blockingPids.includes(lock.blockerPid),
    );
  }
  assert.deepEqual(proof.cleanup, {
    transactionsClosed: true,
    connectionsClosed: true,
  });
  assert.deepEqual(proof.limitations, {
    hostedParity: false,
    d1Coordination: false,
    nativeExecution: false,
    archiveInterop: false,
  });
  const finalHashes = source(configuration);
  assert.deepEqual(
    finalHashes,
    originalHashes,
    'The test sources changed during verification.',
  );
  assert.equal(
    digest(bytes(configuration.reportFile)),
    digest(proofBytes),
    'The SQL proof changed during verification.',
  );
  const summary = {
    format: 'zentra-action-real-postgres-verification',
    schemaVersion: 1,
    sourceCommit: configuration.sourceCommit,
    gate: 'G3',
    status: 'passed',
    synthetic: true,
    casesPassed: REAL_POSTGRES_CASE_NAMES.length,
    casesSkipped: 0,
    independentBackendCount: 4,
    observedLockWaits: proof.locks.length,
    proofSha256: digest(proofBytes),
    vitestSha256: digest(bytes(vitestReport)),
    hostedParityVerified: false,
    productionDataUsed: false,
    runtimeActivated: false,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    flag: 'wx',
  });
  return { summary, summaryPath, vitestReport };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = runRealPostgresVerification();
    process.stdout.write(
      `Isolated PostgreSQL concurrency verified: ${result.summaryPath}\n`,
    );
  } catch {
    // Neither URLs/credentials nor an untrusted driver exception are reflected.
    process.stderr.write(
      'Isolated PostgreSQL verification refused; no successful concurrency proof is claimed.\n',
    );
    process.exitCode = 1;
  }
}
