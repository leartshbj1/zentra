import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { captureWithPorts, reconcileWithPorts, describeSchema, SCHEMA_PATHS } from './tauri-schema-readonly-receipt.mjs';

const SOURCE = 'a'.repeat(40), HELPER = 'b'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const lf = Buffer.from('{\n  "title": "public schema",\n  "escaped": "line\\r\\ntext"\n}\n');
const crlf = Buffer.from(lf.toString().replaceAll('\n', '\r\n'));
function fixture() {
  const state = { source: SOURCE, index: Buffer.from('tracked-index\0'), staged: Buffer.alloc(0), status: '',
    files: new Map(SCHEMA_PATHS.map(p => [p, Buffer.from(crlf)])), gitFiles: new Map(SCHEMA_PATHS.map(p => [p, Buffer.from(lf)])), commands: [] };
  const ports = { read(p) { return Buffer.from(state.files.get(p)); }, git(args) {
    state.commands.push(args);
    switch (args[0]) {
      case 'rev-parse': return Buffer.from(state.source + '\n');
      case 'diff': return state.staged;
      case 'ls-files': return state.index;
      case 'status': return Buffer.from(state.status);
      case 'ls-tree': return Buffer.from(SCHEMA_PATHS.map(p => `100644 blob ${blob(state.gitFiles.get(p))}\t${p}\0`).join(''));
      case 'cat-file': return [...state.gitFiles.values()].find(bytes => blob(bytes) === args[2]);
      default: throw new Error('mutating_or_unknown_git_command');
    }
  } };
  return { state, ports, baseline: () => captureWithPorts(SOURCE, HELPER, ports) };
}
test('four fixed paths and raw SHA/Git blob hashes are observed without Git mutation', () => {
  const f = fixture(), before = f.baseline();
  assert.equal(before.files.length, 4);
  assert.equal(before.files[0].sha256, hash(crlf));
  assert.equal(before.files[0].gitBlobSha1, blob(lf));
  assert.equal(before.files[0].rawGitBlobSha1, blob(crlf));
  assert.equal(before.files[0].byteMatch, 'git-LF-to-CRLF');
  const result = reconcileWithPorts(SOURCE, HELPER, before, f.ports);
  assert.equal(result.receipt.trackedCleanAfter, true);
  assert.deepEqual(result.receipt.rawChangedPaths, []);
  assert.equal(result.receipt.schemasWritten, false);
  assert.equal(result.receipt.schemasRestored, false);
  assert.equal(result.receipt.packageVerified, false);
  assert.equal(result.files.length, 4);
  assert.ok(f.state.commands.every(args => ['rev-parse','diff','ls-files','ls-tree','cat-file','status'].includes(args[0])));
});
test('CI 315 codec: generated LF from CRLF checkout is accepted and explicitly reported, never repaired', () => {
  const f = fixture(), before = f.baseline();
  const changed = SCHEMA_PATHS.slice(2);
  for (const p of changed) f.state.files.set(p, lf);
  f.state.status = changed.map(p => ` M ${p}\0`).join('');
  const result = reconcileWithPorts(SOURCE, HELPER, before, f.ports);
  assert.deepEqual(result.receipt.rawChangedPaths, changed);
  assert.deepEqual(result.receipt.observedModifiedPaths, changed);
  assert.equal(result.receipt.trackedCleanAfter, false);
  assert.equal(result.receipt.files[2].lineEndings, 'lf');
  assert.equal(result.receipt.files[2].byteMatch, 'git-bytes');
  assert.ok(result.files[2].bytes.equals(lf));
  assert.ok(f.state.files.get(changed[0]).equals(lf));
});
test('raw newline drift invisible to porcelain is still recorded', () => {
  const f = fixture(), before = f.baseline();
  f.state.files.set(SCHEMA_PATHS[0], lf);
  const result = reconcileWithPorts(SOURCE, HELPER, before, f.ports);
  assert.deepEqual(result.receipt.rawChangedPaths, [SCHEMA_PATHS[0]]);
  assert.deepEqual(result.receipt.observedModifiedPaths, []);
});
test('a content change is refused even when it is valid JSON and the status is clean', () => {
  const f = fixture(), before = f.baseline();
  f.state.files.set(SCHEMA_PATHS[0], Buffer.from('{"other":true}\n'));
  assert.throws(() => reconcileWithPorts(SOURCE, HELPER, before, f.ports), /schema_content_changed/);
});
test('escaped JSON backslash-r-n text is not normalized as a newline', () => {
  const value = describeSchema(lf);
  assert.equal(value.lfSha256, hash(lf));
  assert.equal(value.lineEndings, 'lf');
});
for (const [name, bytes, code] of [
  ['lone CR', Buffer.from('{\r"a":1}'), 'line_endings'],
  ['mixed LF and CRLF', Buffer.from('{\r\n"a":1\n}'), 'line_endings'],
  ['invalid UTF8', Buffer.from([0xc0,0x80]), 'utf8'],
  ['UTF8 BOM', Buffer.from('\ufeff{}'), 'utf8'],
  ['non-object JSON', Buffer.from('[]'), 'json'],
  ['malformed JSON', Buffer.from('{'), 'json'],
  ['empty bytes', Buffer.alloc(0), 'bytes'],
  ['oversize schema', Buffer.alloc(2*1024*1024+1), 'bytes'],
]) test(`refuses ${name}`, () => assert.throws(() => describeSchema(bytes), new RegExp(`schema_${code}_refused`)));
for (const status of [
  ' M desktop/src-tauri/src/lib.rs\0', `M  ${SCHEMA_PATHS[0]}\0`, ` D ${SCHEMA_PATHS[0]}\0`,
  ` R ${SCHEMA_PATHS[0]}\0original\0`, ` T ${SCHEMA_PATHS[0]}\0`, `UU ${SCHEMA_PATHS[0]}\0`,
  ` M ${SCHEMA_PATHS[0]}`, ` M ${SCHEMA_PATHS[0]}\0 M ${SCHEMA_PATHS[0]}\0`,
]) test(`refuses closed status variant ${JSON.stringify(status.slice(0, 3))} / ${status.length}`, () => {
  const f = fixture(), before = f.baseline(); f.state.status = status;
  assert.throws(() => reconcileWithPorts(SOURCE, HELPER, before, f.ports), /schema_status_refused/);
});
test('dirty baseline refuses before any file content is read', () => {
  const f = fixture(); f.state.status = ` M ${SCHEMA_PATHS[0]}\0`;
  f.ports.read = () => { throw new Error('must_not_read'); };
  assert.throws(f.baseline, /schema_before_dirty/);
});
test('source HEAD and semantic index entries must remain exact', () => {
  const f = fixture(), before = f.baseline();
  f.state.source = 'c'.repeat(40);
  assert.throws(() => reconcileWithPorts(SOURCE, HELPER, before, f.ports), /schema_source_changed/);
  f.state.source = SOURCE; f.state.index = Buffer.from('different entries\0');
  assert.throws(() => reconcileWithPorts(SOURCE, HELPER, before, f.ports), /schema_index_changed/);
  f.state.index = Buffer.from('tracked-index\0'); f.state.staged = Buffer.from('somefile\0');
  assert.throws(() => reconcileWithPorts(SOURCE, HELPER, before, f.ports), /schema_index_changed/);
});
test('baseline is closed and source/helper/hash values are scalar', () => {
  const f = fixture(), before = f.baseline();
  for (const candidate of [{...before, extra:true}, {...before, source:[SOURCE]}, {...before, helperSha256:[HELPER]},
    {...before, files:[...before.files].reverse()}, {...before, files:before.files.slice(1)}]) {
    assert.throws(() => reconcileWithPorts(SOURCE, HELPER, candidate, f.ports), /schema_baseline_refused/);
  }
  assert.throws(() => captureWithPorts([SOURCE], HELPER, f.ports), /schema_source_refused/);
  assert.throws(() => captureWithPorts(SOURCE, [HELPER], f.ports), /schema_helper_refused/);
});
test('a missing schema or symlink refusal is never replaced by empty metadata', () => {
  const f = fixture(), before = f.baseline();
  f.ports.read = () => { throw new Error('schema_file_refused'); };
  assert.throws(() => reconcileWithPorts(SOURCE, HELPER, before, f.ports), /schema_file_refused/);
});
test('raw bytes are reread to reject drift during observation', () => {
  const f = fixture(), before = f.baseline();
  let n = 0; f.ports.read = () => ++n > 4 ? lf : crlf;
  assert.throws(() => reconcileWithPorts(SOURCE, HELPER, before, f.ports), /schema_capture_changed/);
});
test('CLI is CI-only and writes only a new artifact folder; source restoration and native calls are absent', () => {
  const source = fs.readFileSync(new URL('./tauri-schema-readonly-receipt.mjs', import.meta.url), 'utf8');
  assert.match(source, /CIRCLE_JOB === 'windows-autopilot-product'/);
  assert.match(source, /CIRCLE_SHA1 === source/);
  assert.match(source, /schema_baseline_hash_refused/);
  assert.match(source, /schema_artifacts_exist/);
  assert.match(source, /flag: 'wx'/);
  assert.doesNotMatch(source, /ports\.git\(\['(?:restore|reset|checkout|update-index|add|commit)'/);
  assert.doesNotMatch(source, /execFileSync\('(?!git')/);
});
