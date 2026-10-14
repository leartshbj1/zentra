// Pure protocol tests only: fake sockets/timers, public synthetic metadata.
// No named pipe, native child, Cargo, HTTP, account or filesystem mutation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { G4_CHECKPOINTS, G4_MAX_QUEUED_EVENTS, validateG4Checkpoint, validateG4Review, validateG4DiagnosticReceipt,
  G4DiagnosticChannel, validateComplete, validatePublication } from './verify-action-live-g4-windows.mjs';

for (const name of ['ZENTRA_A41_SITES_SERVICE_TOKEN', 'ZENTRA_A41_BROWSER_COOKIE_QA'])
  if (Object.hasOwn(process.env, name)) throw new Error('PURE_CONTRACTS_REFUSE_PRIVATE_ENVIRONMENT');
globalThis.fetch = async () => { throw new Error('PURE_CONTRACTS_NETWORK_DISABLED'); };
const PROFILE = '2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf';
const ROUND_POSITION = G4_CHECKPOINTS.findIndex(value => value.step === 'round' && value.index === 0) + 1;
const review = () => ({ event: 'review-required', index: 0, confirmed: 0, held: 0, reviewRequired: 1 });
const receipt = () => ({ format: 'zentra-a41-native-g4-diagnostic-v1', sourceSha: 'a'.repeat(40), binarySha256: 'b'.repeat(64),
  profileSha256: PROFILE, passed: false, nominalG4Passed: false, outcome: 'needs_review', phase: 'quote_round',
  code: 'g4_review_required', lastCheckpoint: 'native_g4_round_0', checkpointsSeen: ROUND_POSITION,
  counts: { confirmed: 0, held: 0, reviewRequired: 1 }, nativeSpawned: true, pipeConnected: true, helloValidated: true,
  nativeExited: false, nativeExitCode: null, nativeSignaled: false });
class Socket extends EventEmitter {
  destroy() { this.destroyed = true; }
  write(value) { this.written = value; }
}
const fixture = () => {
  const socket = new Socket(); let timeout;
  const channel = new G4DiagnosticChannel(socket, { setTimer(fn, ms) { assert.equal(ms, 240000); timeout = fn; return 1; }, clearTimer() {} });
  return { socket, channel, timeout: () => timeout() };
};

test('Rust literal checkpoint order exactly matches the closed JS sequence', () => {
  const source = fs.readFileSync(new URL('../src-tauri/src/account_cloud_live_a41_g4_tests.rs', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/pipe\.checkpoint\("([a-z_]+)", ([01])\)\?/g)].map(match => ({ step: match[1], index: Number(match[2]) }));
  assert.deepEqual(calls, G4_CHECKPOINTS);
  for (const [position, expected] of G4_CHECKPOINTS.entries())
    assert.equal(validateG4Checkpoint({ event: 'checkpoint', ...expected }, position), `native_g4_${expected.step}_${expected.index}`);
  assert.equal((source.match(/action_engine::advance_quote_work_round\(store, &mut round\)/g) ?? []).length, 1);
  assert(source.includes('if review_required != 0 {')); assert(source.includes('"reviewRequired":review_required'));
  assert(source.includes('if round(&a, &mut pipe, 0).await? != 1')); assert(source.includes('if round(&b, &mut pipe, 1).await? != 0'));
  assert(source.includes('panic!("ZENTRA_A41_NATIVE_G4_REFUSED")'));
});

test('checkpoint protocol rejects arbitrary fields, reordered steps and device indices', () => {
  for (const value of [{ event: 'checkpoint', step: 'secret', index: 0 }, { event: 'checkpoint', ...G4_CHECKPOINTS[1] },
    { event: 'checkpoint', ...G4_CHECKPOINTS[0], index: 2 }, { event: 'checkpoint', ...G4_CHECKPOINTS[0], sourceId: 'private' }])
    assert.throws(() => validateG4Checkpoint(value, 0));
  assert.throws(() => validateG4Checkpoint({ event: 'checkpoint', ...G4_CHECKPOINTS[0] }, G4_CHECKPOINTS.length));
});

test('needs_review is a bounded observation from the active round, never a nominal success', () => {
  assert.deepEqual(validateG4Review(review(), ROUND_POSITION), { confirmed: 0, held: 0, reviewRequired: 1 });
  const result = validateG4DiagnosticReceipt(receipt());
  assert.equal(result.outcome, 'needs_review'); assert.equal(result.passed, false); assert.equal(result.nominalG4Passed, false);
  assert(Buffer.byteLength(JSON.stringify(result)) < 4096);
  for (const patch of [{ reviewRequired: 0 }, { reviewRequired: 21 }, { confirmed: 20, reviewRequired: 1 },
    { held: -1 }, { index: 1 }, { reviewRequired: '1' }, { proposalId: 'private' }, { reason: 'low_confidence' }])
    assert.throws(() => validateG4Review({ ...review(), ...patch }, ROUND_POSITION));
  assert.throws(() => validateG4Review(review(), 0));
});

test('diagnostic receipt refuses success, identities, paths, tokens and raw output', () => {
  for (const key of Object.keys(receipt())) {
    const value = receipt(); delete value[key]; assert.throws(() => validateG4DiagnosticReceipt(value));
  }
  for (const key of ['sourceId', 'organizationId', 'installationId', 'rootDir', 'sitesServiceToken', 'stdout', 'stderr', 'message', 'stack'])
    assert.throws(() => validateG4DiagnosticReceipt({ ...receipt(), [key]: 'PRIVATE_MARKER' }));
  for (const patch of [{ passed: true }, { nominalG4Passed: true }, { code: 'success' }, { phase: 'private-path' },
    { lastCheckpoint: 'private-path' }, { checkpointsSeen: G4_CHECKPOINTS.length + 1 }, { sourceSha: ['a'.repeat(40)] },
    { binarySha256: ['b'.repeat(64)] }, { nativeExited: false, nativeExitCode: 101 }, { nativeSignaled: true },
    { counts: { ...receipt().counts, event: 'review-required' } }, { counts: { ...receipt().counts, sourceId: 'private' } }])
    assert.throws(() => validateG4DiagnosticReceipt({ ...receipt(), ...patch }));
});

test('non-review failure receipts carry a closed transport cause without business data', () => {
  for (const code of ['g4_pipe_socket_error', 'g4_pipe_eof', 'g4_pipe_closed', 'g4_pipe_utf8_refused', 'g4_pipe_json_refused',
    'g4_pipe_bounds_refused', 'g4_pipe_read_timeout', 'g4_pipe_child_exit', 'g4_pipe_global_deadline', 'g4_native_spawn_failed', 'g4_validation_refused']) {
    const result = validateG4DiagnosticReceipt({ ...receipt(), outcome: 'failed', counts: null, code });
    assert.equal(result.code, code); assert.equal(result.nominalG4Passed, false);
  }
  assert.throws(() => validateG4DiagnosticReceipt({ ...receipt(), outcome: 'failed', counts: null, code: 'raw-private-error' }));
});

for (const [event, code] of [['end', 'g4_pipe_eof'], ['close', 'g4_pipe_closed'], ['error', 'g4_pipe_socket_error']])
  test(`socket ${event} retains its own closed cause`, async () => {
    const f = fixture(), rejected = assert.rejects(f.channel.read(), error => error.code === code);
    f.socket.emit(event, new Error('PRIVATE_RAW_ERROR')); await rejected;
    await assert.rejects(f.channel.read(), error => error.code === code && !error.message.includes('PRIVATE_RAW_ERROR'));
  });

for (const [bytes, code] of [[Buffer.from([255, 10]), 'g4_pipe_utf8_refused'], [Buffer.from('{\n'), 'g4_pipe_json_refused'],
  [Buffer.from('{"event":"hello","event":"hello"}\n'), 'g4_pipe_json_refused'], [Buffer.alloc(32769, 65), 'g4_pipe_bounds_refused']])
  test(`invalid wire bytes fail with ${code}`, async () => {
    const f = fixture(), rejected = assert.rejects(f.channel.read(), error => error.code === code);
    f.socket.emit('data', bytes); await rejected;
  });

test('read timeout is distinct and needs no real sleep', async () => {
  const f = fixture(), rejected = assert.rejects(f.channel.read(), error => error.code === 'g4_pipe_read_timeout');
  f.timeout(); await rejected;
});

test('global deadline, child exit and stdin/output limits remain distinct', async () => {
  for (const code of ['g4_pipe_global_deadline', 'g4_pipe_child_exit', 'g4_pipe_stdin_error', 'g4_pipe_output_limit']) {
    const f = fixture(), rejected = assert.rejects(f.channel.read(), error => error.code === code);
    f.channel.fail(code); await rejected;
  }
  const f = fixture(), rejected = assert.rejects(f.channel.read(), error => error.code === 'g4_pipe_transport_refused');
  f.channel.fail('PRIVATE_ERROR'); await rejected;
});

test('a queued review survives EOF and still cannot become nominal completion', async () => {
  const f = fixture(); f.socket.emit('data', Buffer.from(JSON.stringify(review()) + '\n')); f.socket.emit('end');
  assert.deepEqual(validateG4Review(await f.channel.read(), ROUND_POSITION), receipt().counts);
  await assert.rejects(f.channel.read(), error => error.code === 'g4_pipe_eof');
  assert.equal(validateG4DiagnosticReceipt(receipt()).nominalG4Passed, false);
});

test('queue bounds derive from the complete protocol and reject one additional queued frame', async () => {
  assert.equal(G4_MAX_QUEUED_EVENTS, G4_CHECKPOINTS.length + 3);
  const f = fixture(); f.socket.emit('data', Buffer.from(Array(G4_MAX_QUEUED_EVENTS + 1).fill('{"event":"hello"}\n').join('')));
  for (let index = 0; index < G4_MAX_QUEUED_EVENTS; index++) assert.deepEqual(await f.channel.read(), { event: 'hello' });
  await assert.rejects(f.channel.read(), error => error.code === 'g4_pipe_bounds_refused');
});

for (const chunkSize of [0, 7]) test(`a complete valid transcript survives a ${chunkSize ? 'split' : 'coalesced'} burst before the reader resumes`, async () => {
  const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const initial = { snapshotId: uuid(1), baseRevision: 0, revision: 1, archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
    sizeBytes: 100, transport: 'content-v1', gatewayPgFactAndD1Committed: true };
  const canonical = { ...initial, snapshotId: uuid(2), baseRevision: 1, revision: 2, archiveSha256: 'c'.repeat(64) };
  const seed = { publication: validatePublication(initial), sourceId: 'source-synthetic', customerId: uuid(3), articleId: uuid(4) };
  const quote = { sourceId: seed.sourceId, proposalId: 'proposal-synthetic', reservationId: uuid(5), fingerprint: 'd'.repeat(64),
    quoteId: uuid(6), customerId: seed.customerId, articleId: seed.articleId, receiptSha256: 'e'.repeat(64), lineIds: [uuid(7)],
    quoteCount: 1, receiptCount: 1, quoteNumber: null, status: 'draft', requiresHumanValidation: true,
    nativeFrozenCreationVerified: true, auditChainValid: true };
  const complete = { event: 'complete', profileSha256: PROFILE, organizationId: 'org_trial_345a3d1f68056cf7e709d4af4fc229a4',
    initialPublication: initial, canonicalPublication: canonical, quote, secondStoreExactCreation: true, secondRoundConfirmed: 0,
    writerActivityCount: 1, secondStoreActivityCount: 0, strictMeHttp200Both: true, automaticCleanup: false };
  const first = { event: 'initial-publication', publication: initial, customerId: seed.customerId, articleId: seed.articleId, consentRevisions: [1, 1] };
  const frames = [{ event: 'hello', challenge: 'x'.repeat(43) },
    ...G4_CHECKPOINTS.slice(0, 12).map(step => ({ event: 'checkpoint', ...step })), first,
    ...G4_CHECKPOINTS.slice(12).map(step => ({ event: 'checkpoint', ...step })), complete];
  assert.equal(frames.length, G4_MAX_QUEUED_EVENTS); assert(frames.length > 8);
  const bytes = Buffer.from(frames.map(value => JSON.stringify(value) + '\n').join('')), f = fixture();
  for (let offset = 0; offset < bytes.length; offset += chunkSize || bytes.length)
    f.socket.emit('data', bytes.subarray(offset, offset + (chunkSize || bytes.length)));
  f.socket.emit('end');
  assert.deepEqual(await f.channel.read(), frames[0]);
  for (let index = 0; index < 12; index++) validateG4Checkpoint(await f.channel.read(), index);
  assert.deepEqual(await f.channel.read(), first);
  for (let index = 12; index < G4_CHECKPOINTS.length; index++) validateG4Checkpoint(await f.channel.read(), index);
  assert.deepEqual(validateComplete(await f.channel.read(), seed).quote, quote);
  await f.channel.finalize(); f.channel.assertTerminal();
});

for (const end of ['end', 'close']) test(`normal ${end} after the terminal frame completes finalization`, async () => {
  const f = fixture(); f.socket.emit('data', Buffer.from('{"event":"complete"}\n'));
  assert.deepEqual(await f.channel.read(), { event: 'complete' });
  let resolved = false;
  const pending = f.channel.finalize().then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false); // Child exit alone cannot stand in for a drained stream.
  f.socket.emit(end); await pending; assert.equal(resolved, true); f.channel.assertTerminal();
});

for (const [suffix, code] of [[Buffer.from('{"event":"extra"}\n'), 'g4_pipe_terminal_refused'],
  [Buffer.from('{\n'), 'g4_pipe_json_refused'], [Buffer.from('{'), 'g4_pipe_terminal_refused'],
  [Buffer.from([255, 10]), 'g4_pipe_utf8_refused'], [Buffer.alloc(32769, 65), 'g4_pipe_bounds_refused']])
  test(`terminal frame followed by extra/invalid input refuses ${code}`, async () => {
    const f = fixture(); f.socket.emit('data', Buffer.concat([Buffer.from('{"event":"complete"}\n'), suffix]));
    assert.deepEqual(await f.channel.read(), { event: 'complete' }); f.socket.emit('end');
    await assert.rejects(f.channel.finalize(), error => error.code === code);
  });

test('socket error after normal EOF still prevents nominal finalization', async () => {
  const f = fixture(); f.socket.emit('data', Buffer.from('{"event":"complete"}\n')); await f.channel.read();
  f.socket.emit('end'); f.socket.emit('error', new Error('PRIVATE_ERROR'));
  await assert.rejects(f.channel.finalize(), error => error.code === 'g4_pipe_socket_error');
});

test('terminal stream finalization has its own bounded wait', async () => {
  const f = fixture(); f.socket.emit('data', Buffer.from('{"event":"complete"}\n')); await f.channel.read();
  const rejected = assert.rejects(f.channel.finalize(), error => error.code === 'g4_pipe_read_timeout');
  f.timeout(); await rejected;
});
