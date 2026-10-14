// Pure Node contracts: fake Git and file metadata only. No subprocess, native,
// Cargo, network, checkout restoration or filesystem write is performed here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { TAURI_SCHEMA_PATHS, modifiedTauriSchemas, captureTauriSchemasWithPorts,
  captureTauriSchemaReconciliation, describeTauriSchemaRefusal } from './tauri-schema-reconciliation.mjs';

for (const name of ['ZENTRA_A41_SITES_SERVICE_TOKEN', 'ZENTRA_A41_BROWSER_COOKIE_QA'])
  if (Object.hasOwn(process.env, name)) throw new Error('PURE_CONTRACTS_REFUSE_PRIVATE_ENVIRONMENT');
globalThis.fetch = async () => { throw new Error('PURE_CONTRACTS_NETWORK_DISABLED'); };
const SOURCE = 'a'.repeat(40), HELPER = 'b'.repeat(64);
const digest = text => createHash('sha256').update(text).digest('hex');

function fixture() {
  const before = TAURI_SCHEMA_PATHS.map((_, index) => ({ bytes: index + 1, sha256: digest(`before-${index}`) }));
  const current = structuredClone(before), calls = [];
  const state = { head: SOURCE, index: '', status: '', restoreBroken: false,
    entries: TAURI_SCHEMA_PATHS.map((relative, index) => `100644 ${String(index + 1).repeat(40)} 0\t${relative}\0`).join('') };
  const ports = {
    git(args) {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return state.head + '\n';
      if (args[0] === 'diff') return state.index;
      if (args[0] === 'ls-files') return state.entries;
      if (args[0] === 'status') return state.status;
      if (args[0] === 'restore') {
        assert.deepEqual(args.slice(0, 4), ['restore', `--source=${SOURCE}`, '--worktree', '--']);
        for (const relative of args.slice(4)) {
          assert(TAURI_SCHEMA_PATHS.includes(relative));
          if (!state.restoreBroken) current[TAURI_SCHEMA_PATHS.indexOf(relative)] = { ...before[TAURI_SCHEMA_PATHS.indexOf(relative)] };
        }
        state.status = ''; return '';
      }
      throw new Error('Unexpected fake Git command');
    },
    snapshot(relative) { return { ...current[TAURI_SCHEMA_PATHS.indexOf(relative)] }; },
  };
  return { before, current, state, calls, ports,
    capture: () => captureTauriSchemasWithPorts(SOURCE, HELPER, ports),
    restores: () => calls.filter(args => args[0] === 'restore') };
}

test('CI admission refuses a local invocation before Git or filesystem access', () => {
  assert.throws(() => captureTauriSchemaReconciliation({}), /dedicated_windows_ci_required|dedicated_ci_admission_refused/);
});

test('unchanged generated schemas produce a closed receipt without a restore', () => {
  const f = fixture(), receipt = f.capture().reconcile();
  assert.deepEqual(receipt.modifiedPaths, []); assert.deepEqual(receipt.restoredPaths, []);
  assert.equal(f.restores().length, 0); assert.equal(receipt.source, SOURCE); assert.equal(receipt.helperSha256, HELPER);
  assert.deepEqual(receipt.phases, ['precompile_clean', 'postcompile_observed', 'restored_clean']);
  assert.deepEqual(Object.keys(receipt).sort(), ['format', 'source', 'helperSha256', 'phases', 'trackedCleanBefore',
    'indexMatchesSourceBeforeAndAfter', 'trackedCleanAfter', 'modifiedPaths', 'restoredPaths', 'files'].sort());
  assert(receipt.files.every(file => file.beforeSha256 === file.postcompileSha256 && file.beforeSha256 === file.restoredSha256));
});

for (const count of [1, 4]) test(`restores exactly ${count} modified generated files from the captured commit`, () => {
  const f = fixture(), baseline = f.capture();
  for (let i = 0; i < count; i++) f.current[i] = { bytes: 99, sha256: digest(`generated-${i}`) };
  f.state.status = TAURI_SCHEMA_PATHS.slice(0, count).map(relative => ` M ${relative}\0`).join('');
  const receipt = baseline.reconcile();
  assert.deepEqual(receipt.modifiedPaths, TAURI_SCHEMA_PATHS.slice(0, count));
  assert.deepEqual(receipt.restoredPaths, receipt.modifiedPaths);
  assert.deepEqual(f.restores(), [['restore', `--source=${SOURCE}`, '--worktree', '--', ...receipt.modifiedPaths]]);
  assert(receipt.files.slice(0, count).every(file => file.postcompileSha256 !== file.beforeSha256 && file.restoredSha256 === file.beforeSha256));
  assert.throws(() => baseline.reconcile(), /tauri_schema_baseline_consumed/);
});

test('raw byte drift hidden by line-ending normalization is still restored and reported', () => {
  const f = fixture(), baseline = f.capture(); f.current[2] = { bytes: 100, sha256: digest('line-ending-drift') };
  const receipt = baseline.reconcile(); assert.deepEqual(receipt.modifiedPaths, [TAURI_SCHEMA_PATHS[2]]);
  assert.equal(f.restores().length, 1); assert.equal(receipt.files[2].restoredSha256, receipt.files[2].beforeSha256);
});

for (const status of ['M  ', 'MM ', ' D ', 'D  ', 'A  ', '?? ', ' T ', 'T  ', 'UU ', 'R  ', ' R ', 'C  '])
  test(`rejects status ${JSON.stringify(status)} before restoration`, () => {
    const f = fixture(), baseline = f.capture(); f.state.status = status + TAURI_SCHEMA_PATHS[0] + '\0';
    assert.throws(() => baseline.reconcile(), /tauri_schema_status_refused/); assert.equal(f.restores().length, 0);
  });

for (const status of [' M desktop/src-tauri/src/account_cloud.rs\0', ` M ${TAURI_SCHEMA_PATHS[0]}\0arbitrary-rename-target\0`,
  ` M ${TAURI_SCHEMA_PATHS[0]}`, ` M ${TAURI_SCHEMA_PATHS[0]}\0 M ${TAURI_SCHEMA_PATHS[0]}\0`,
  ' M desktop/src-tauri/gen/schemas/../src/secret\0', ' M ' + 'x'.repeat(65536)])
  test('rejects unknown, renamed, duplicate, malformed or oversized status without leaking its contents', () => {
    const f = fixture(), baseline = f.capture(); f.state.status = status;
    assert.throws(() => baseline.reconcile(), error => error.code === 'tauri_schema_status_refused' && !error.message.includes('secret'));
    assert.equal(f.restores().length, 0);
  });

for (const phase of ['before', 'after']) test(`requires clean exact HEAD and index ${phase} compilation`, () => {
  for (const change of [f => { f.state.head = 'c'.repeat(40); }, f => { f.state.index = 'private-path\0'; },
    f => { f.state.entries = f.state.entries.replace('100644', '100755'); },
    f => { f.state.entries = f.state.entries.replace('100644', '120000'); },
    f => { f.state.entries = f.state.entries.replace(' 0\t', ' 1\t'); },
    f => { f.state.entries = f.state.entries.slice(f.state.entries.indexOf('\0') + 1); }]) {
    const f = fixture(), baseline = phase === 'after' ? f.capture() : null; change(f);
    assert.throws(() => baseline ? baseline.reconcile() : f.capture()); assert.equal(f.restores().length, 0);
  }
});

test('precompile tracked dirt is never reconciled', () => {
  const f = fixture(); f.state.status = ` M ${TAURI_SCHEMA_PATHS[0]}\0`;
  assert.throws(f.capture, /tauri_schema_precompile_dirty/); assert.equal(f.restores().length, 0);
});

test('rejects deletion, oversized content and unsafe filesystem metadata before restoration', () => {
  for (const value of [{ bytes: 0, sha256: digest('') }, { bytes: 2 * 1024 * 1024 + 1, sha256: digest('oversized') },
    { bytes: 2, sha256: 'invalid' }]) {
    const f = fixture(), baseline = f.capture(); f.current[0] = value;
    assert.throws(() => baseline.reconcile(), /tauri_schema_file_refused/); assert.equal(f.restores().length, 0);
  }
  const f = fixture(), baseline = f.capture(); f.ports.snapshot = () => { throw new Error('tauri_schema_file_refused'); };
  assert.throws(() => baseline.reconcile(), /tauri_schema_reconciliation_refused/); assert.equal(f.restores().length, 0);
});

test('failed restoration cannot produce a successful clean receipt', () => {
  const f = fixture(), baseline = f.capture(); f.current[0] = { bytes: 100, sha256: digest('changed') };
  f.state.status = ` M ${TAURI_SCHEMA_PATHS[0]}\0`; f.state.restoreBroken = true;
  assert.throws(() => baseline.reconcile(), /tauri_schema_restore_hash_refused/);
});

test('a late unrelated mutation still fails the final clean guard', () => {
  const f = fixture(), baseline = f.capture(), original = f.ports.git;
  let statusCalls = 0;
  f.ports.git = args => args[0] === 'status' && ++statusCalls === 2 ? ' M private-path\0' : original(args);
  assert.throws(() => baseline.reconcile(), /tauri_schema_postcompile_dirty/);
});

test('the parser accepts no constructor or caller-provided path allowlist', () => {
  assert.deepEqual(modifiedTauriSchemas(''), []); assert.equal(Object.isFrozen(TAURI_SCHEMA_PATHS), true);
  assert.throws(() => modifiedTauriSchemas({ toString: () => '' }), /tauri_schema_status_refused/);
  assert.throws(() => captureTauriSchemasWithPorts({ toString: () => SOURCE }, HELPER, {}), /tauri_schema_source_refused/);
});

test('refusal metadata retains only safe source-tree names and closed file facts', () => {
  const visited = [], publicPath = 'desktop/src-tauri/src/account_cloud.rs';
  const result = describeTauriSchemaRefusal(` M ${publicPath}\0 M ../../secret\0 M untracked-file\0 R old-path\0target-path\0`, {
    trackedAtSource(relative) { visited.push(relative); return relative === publicPath; },
    inspect() { return { kind: 'file', bytes: 123, sha256: digest('public source'), body: 'MUST_NOT_BE_RETURNED' }; },
  });
  assert.deepEqual(result.files, [{ path: publicPath, change: 'modified', kind: 'file', bytes: 123, sha256: digest('public source') }]);
  assert.equal(result.omitted, true); assert(!visited.includes('../../secret'));
  assert(!JSON.stringify(result).includes('MUST_NOT_BE_RETURNED')); assert(!JSON.stringify(result).includes('target-path'));
});

test('refusal metadata never hashes links, exposes raw errors or exceeds sixteen files', () => {
  const paths = Array.from({ length: 20 }, (_, index) => `desktop/file-${index}.json`);
  const result = describeTauriSchemaRefusal(paths.map(relative => ` M ${relative}\0`).join(''), {
    trackedAtSource() { return true; }, inspect() { return { kind: 'link', bytes: 1, sha256: digest('not a read') }; },
  });
  assert.equal(result.files.length, 16); assert.equal(result.omitted, true); assert(result.files.every(file => file.sha256 === null));
  const thrown = describeTauriSchemaRefusal(' M desktop/file.json\0', {
    trackedAtSource() { return true; }, inspect() { throw new Error('private-body-or-provider-error'); },
  });
  assert.deepEqual(thrown, { files: [], omitted: true });
});
