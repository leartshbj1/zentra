import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { readRealPostgresConfiguration } from './action-real-postgres-evidence.mjs';
import { runRealPostgresVerification } from './verify-action-real-postgres.mjs';

// These tests use a package descriptor only. No driver, socket or SQL is loaded.
const root = mkdtempSync(join(tmpdir(), 'zentra-pg-gates-'));
const moduleDirectory = join(root, 'module');
const reportDirectory = join(root, 'reports');
mkdirSync(moduleDirectory);
mkdirSync(reportDirectory);
writeFileSync(
  join(moduleDirectory, 'package.json'),
  JSON.stringify({ name: 'pg', version: '8.0.0' }),
);
const runId = 'a'.repeat(32);
const baseline = {
  ZENTRA_ACTION_REAL_PG: '1',
  ZENTRA_ACTION_REAL_PG_HOST: '127.0.0.1',
  ZENTRA_ACTION_REAL_PG_PORT: '5432',
  ZENTRA_ACTION_REAL_PG_RUN_ID: runId,
  ZENTRA_ACTION_REAL_PG_DATABASE: `zentra_action_engine_qa_${runId}`,
  ZENTRA_ACTION_REAL_PG_USER: `zentra_action_engine_qa_${runId}`,
  ZENTRA_ACTION_REAL_PG_SOURCE_COMMIT: 'b'.repeat(40),
  ZENTRA_ACTION_REAL_PG_MODULE_DIR: moduleDirectory,
  ZENTRA_ACTION_REAL_PG_REPORT_FILE: join(
    reportDirectory,
    `action-engine-real-postgres-${runId}.json`,
  ),
};
const refuse = (environment) =>
  assert.throws(() => readRealPostgresConfiguration(environment), {
    message: 'ZENTRA_ACTION_REAL_PG_CONFIGURATION_REFUSED',
  });

test('accepts only the explicit disposable loopback contract without loading pg', () => {
  const configuration = readRealPostgresConfiguration(baseline);
  assert.equal(configuration.host, '127.0.0.1');
  assert.equal(configuration.port, 5432);
  assert.equal(configuration.database, baseline.ZENTRA_ACTION_REAL_PG_DATABASE);
  assert.equal(configuration.password, '');
  assert.equal(Object.isFrozen(configuration), true);
});
test('refuses absent, implicit or disabled opt-in', () => {
  for (const value of [undefined, '', '0', 'true', ' 1'])
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG: value });
});
test('the actual runner refuses absence before starting Vitest or importing a driver', () => {
  assert.throws(() => runRealPostgresVerification({}), {
    message: 'ZENTRA_ACTION_REAL_PG_CONFIGURATION_REFUSED',
  });
});
test('the actual runner refuses a remote target before any subprocess', () => {
  assert.throws(
    () =>
      runRealPostgresVerification({
        ...baseline,
        ZENTRA_ACTION_REAL_PG_HOST: 'production.example.invalid',
      }),
    { message: 'ZENTRA_ACTION_REAL_PG_CONFIGURATION_REFUSED' },
  );
});
test('refuses every missing dedicated selector', () => {
  for (const key of Object.keys(baseline)) {
    const environment = { ...baseline };
    delete environment[key];
    refuse(environment);
  }
});
test('refuses remote hosts, URLs, sockets, aliases and noncanonical loopback', () => {
  for (const host of [
    'localhost',
    '::1',
    '127.1',
    '/tmp/postgres',
    'xvfohjdlhlirksrvkiqu.supabase.co',
    'postgres://127.0.0.1/db',
    '127.0.0.1 ',
  ])
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_HOST: host });
});
test('refuses invalid or privileged ports', () => {
  for (const port of [
    '5432x',
    '05432',
    '5432.0',
    '1e4',
    '1023',
    '65536',
    '-5432',
    '',
    ' 5432',
  ])
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_PORT: port });
});
test('refuses generic, mismatched or unscoped databases and users', () => {
  for (const suffix of ['DATABASE', 'USER'])
    for (const value of [
      'postgres',
      'zentra',
      `zentra_action_engine_qa_${'c'.repeat(32)}`,
      '',
    ])
      refuse({ ...baseline, [`ZENTRA_ACTION_REAL_PG_${suffix}`]: value });
});
test('refuses noncanonical execution and source identities', () => {
  for (const value of ['a'.repeat(31), 'A'.repeat(32), 'a'.repeat(33), '../a'])
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_RUN_ID: value });
  for (const value of ['b'.repeat(39), 'B'.repeat(40), 'HEAD', ''])
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_SOURCE_COMMIT: value });
});
test('refuses ambient libpq settings even when dedicated selectors are present', () => {
  for (const key of [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGSSLMODE',
    'PGOPTIONS',
    'PGAPPNAME',
  ])
    refuse({ ...baseline, [key]: 'synthetic-value' });
});
test('refuses invalid passwords without reflecting their value', () => {
  for (const password of [
    'secret\nvalue',
    'secret\rvalue',
    'secret\0value',
    's'.repeat(257),
  ]) {
    const environment = {
      ...baseline,
      ZENTRA_ACTION_REAL_PG_PASSWORD: password,
    };
    refuse(environment);
  }
});
test('refuses missing, relative or non-package module directories', () => {
  for (const directory of [
    'relative-module',
    join(root, 'missing'),
    reportDirectory,
  ])
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_MODULE_DIR: directory });
});
test('refuses an unrelated package descriptor or an unpinned prerelease', () => {
  const other = join(root, 'other-module');
  mkdirSync(other);
  for (const descriptor of [
    { name: 'fake', version: '8.0.0' },
    { name: 'pg', version: '8.0.0-beta' },
  ]) {
    writeFileSync(join(other, 'package.json'), JSON.stringify(descriptor));
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_MODULE_DIR: other });
  }
});
test('refuses relative, unexpected, existing or absent-parent report destinations', () => {
  const existing = join(root, `action-engine-real-postgres-${runId}.json`);
  writeFileSync(existing, 'old evidence');
  for (const path of [
    'report.json',
    join(root, 'wrong.json'),
    existing,
    join(root, 'missing', `action-engine-real-postgres-${runId}.json`),
  ])
    refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_REPORT_FILE: path });
});
test('refuses a linked module path without following it into pg', () => {
  // Directory junctions are unprivileged on Windows; symlinks elsewhere.
  const linked = join(root, 'module-link');
  symlinkSync(
    moduleDirectory,
    linked,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  refuse({ ...baseline, ZENTRA_ACTION_REAL_PG_MODULE_DIR: linked });
});
test('removes only this test-created temporary fixture', () => {
  assert.ok(root.startsWith(join(tmpdir(), 'zentra-pg-gates-')));
  assert.equal(realpathSync(root), resolve(root));
  assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir()));
  rmSync(root, { recursive: true, force: true });
});
