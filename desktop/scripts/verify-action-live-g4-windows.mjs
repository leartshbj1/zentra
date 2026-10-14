// FUTURE same-job composition. Default CLI only describes it; no --run entry.
// Enrollment/reopening come from the unchanged b502 account coordinator. This
// subsequent G4 test must exist in a newly compiled catalogue BEFORE enrollment.
// No compilation, SQL, server decision injection, billing or cleanup here.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertCiAdmission, parsePrivateJson, runLiveAccountRecipe, validatePrivateInput } from './verify-action-live-account-windows.mjs';
import { makeRealApiSupportSource } from './live-g4-api-support-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = '2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf';
const ORG = 'org_trial_345a3d1f68056cf7e709d4af4fc229a4';
const TEST = 'account_cloud::live_a41_g4_tests::canonical_quote_round_across_two_native_stores';
const EXCLUDED_SOURCES = new Set(['ad57c6905112462bbf844c8bb89072d488294f2c', 'b50214696754365b3f4b9d889bfefd0d3816e36a']);
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const workspaceIdentifier = value => typeof value === 'string'
  && UUID.test(value.startsWith('support_') ? value.slice(8) : value);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/;
const MAX = 32 * 1024;
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code) => { if (!ok) throw new Refusal(code); };
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const closed = (value, names, code) => need(plain(value) && Object.keys(value).sort().join('|') === [...names].sort().join('|'), code);
const sorted = x => Array.isArray(x) ? x.map(sorted) : plain(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sorted(x[k])])) : x;
export const G4_CHECKPOINTS = Object.freeze([
  ['input_admitted', 0], ['retained_root', 0], ['open_store', 0], ['open_store', 1],
  ['strict_account', 0], ['strict_account', 1], ['paid_consent', 0], ['paid_consent', 1],
  ['fresh_remote', 0], ['seed', 0], ['publish_initial', 0], ['receive_initial', 1],
  ['source_ready', 0], ['discovery', 0], ['round', 0], ['quote_proof', 0], ['local_activity', 0],
  ['canonical_publication', 0], ['corroborate_writer', 0], ['receive_canonical', 1],
  ['quote_proof', 1], ['discovery', 1], ['round', 1], ['quote_proof', 1], ['local_activity', 1],
  ['corroborate_writer', 0], ['quote_proof', 0], ['strict_account', 0], ['strict_account', 1],
].map(([step, index]) => Object.freeze({ step, index })));
export const G4_MAX_QUEUED_EVENTS = G4_CHECKPOINTS.length + 3; // hello, initial-publication, complete
const INITIAL_CHECKPOINTS = 12;
const TRANSPORT_CODES = new Set(['g4_pipe_socket_error', 'g4_pipe_eof', 'g4_pipe_closed', 'g4_pipe_utf8_refused',
  'g4_pipe_json_refused', 'g4_pipe_bounds_refused', 'g4_pipe_read_timeout', 'g4_pipe_global_deadline',
  'g4_pipe_child_exit', 'g4_pipe_output_limit', 'g4_pipe_stdin_error', 'g4_pipe_write_refused', 'g4_pipe_transport_refused',
  'g4_pipe_terminal_refused', 'g4_native_spawn_failed']);
const DIAGNOSTIC_PHASES = new Set(['native_spawn', 'handshake', 'initial_publication', 'support_source', 'quote_round', 'native_result']);
const NORMAL_PIPE_END = new Set(['g4_pipe_eof', 'g4_pipe_closed']);

export function validateG4Checkpoint(event, position) {
  closed(event, ['event', 'step', 'index'], 'closed_g4_checkpoint_required');
  const expected = Number.isSafeInteger(position) && position >= 0 ? G4_CHECKPOINTS[position] : undefined;
  need(expected && event.event === 'checkpoint' && event.step === expected.step && event.index === expected.index,
    'g4_checkpoint_order_refused');
  return `native_g4_${expected.step}_${expected.index}`;
}

export function validateG4Review(event, position) {
  closed(event, ['event', 'index', 'confirmed', 'held', 'reviewRequired'], 'closed_g4_review_required');
  const expected = Number.isSafeInteger(position) && position > 0 ? G4_CHECKPOINTS[position - 1] : undefined;
  need(expected?.step === 'round' && event.event === 'review-required' && event.index === expected.index
    && ['confirmed', 'held', 'reviewRequired'].every(field => Number.isSafeInteger(event[field]) && event[field] >= 0 && event[field] <= 20)
    && event.reviewRequired > 0 && event.confirmed + event.held + event.reviewRequired <= 20, 'g4_review_observation_refused');
  return Object.freeze({ confirmed: event.confirmed, held: event.held, reviewRequired: event.reviewRequired });
}

export function validateG4DiagnosticReceipt(value) {
  closed(value, ['format', 'sourceSha', 'binarySha256', 'profileSha256', 'passed', 'nominalG4Passed', 'outcome', 'phase',
    'code', 'lastCheckpoint', 'checkpointsSeen', 'counts', 'nativeSpawned', 'pipeConnected', 'helloValidated',
    'nativeExited', 'nativeExitCode', 'nativeSignaled'], 'closed_g4_diagnostic_required');
  need(value.format === 'zentra-a41-native-g4-diagnostic-v1' && typeof value.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(value.sourceSha)
    && typeof value.binarySha256 === 'string' && SHA.test(value.binarySha256) && value.profileSha256 === PROFILE && value.passed === false
    && value.nominalG4Passed === false && ['needs_review', 'failed'].includes(value.outcome)
    && DIAGNOSTIC_PHASES.has(value.phase) && Number.isSafeInteger(value.checkpointsSeen)
    && value.checkpointsSeen >= 0 && value.checkpointsSeen <= G4_CHECKPOINTS.length,
  'g4_diagnostic_scope_refused');
  const expected = value.checkpointsSeen ? G4_CHECKPOINTS[value.checkpointsSeen - 1] : null;
  need(value.lastCheckpoint === (expected ? `native_g4_${expected.step}_${expected.index}` : null), 'g4_diagnostic_checkpoint_refused');
  for (const field of ['nativeSpawned', 'pipeConnected', 'helloValidated', 'nativeExited', 'nativeSignaled'])
    need(typeof value[field] === 'boolean', 'g4_diagnostic_process_refused');
  need((!value.pipeConnected || value.nativeSpawned) && (!value.helloValidated || value.pipeConnected)
    && (!value.nativeExited || value.nativeSpawned) && (!value.nativeSignaled || value.nativeExited), 'g4_diagnostic_process_refused');
  need(value.nativeExitCode === null || value.nativeExited && Number.isSafeInteger(value.nativeExitCode)
    && value.nativeExitCode >= -2147483648 && value.nativeExitCode <= 4294967295, 'g4_diagnostic_process_refused');
  if (value.outcome === 'needs_review') {
    need(value.code === 'g4_review_required' && plain(value.counts), 'g4_diagnostic_review_refused');
    closed(value.counts, ['confirmed', 'held', 'reviewRequired'], 'closed_g4_review_counts_required');
    validateG4Review({ event: 'review-required', index: expected?.index, ...value.counts }, value.checkpointsSeen);
  } else need(value.counts === null && (TRANSPORT_CODES.has(value.code) || value.code === 'g4_validation_refused'), 'g4_diagnostic_failure_refused');
  const result = sorted(value);
  need(Buffer.byteLength(JSON.stringify(result)) <= 4096, 'g4_diagnostic_bounds_refused');
  return result;
}
export function assertFutureCiAdmission(env, platform = process.platform) {
  assertCiAdmission(env, platform);
  need(env.ZENTRA_RUN_LIVE_G4_RECIPE === 'true' && !EXCLUDED_SOURCES.has(env.CIRCLE_SHA1), 'future_g4_source_required');
}
async function shaFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function validatePublication(value) {
  closed(value, ['snapshotId', 'baseRevision', 'revision', 'archiveSha256', 'manifestSha256', 'sizeBytes', 'transport', 'gatewayPgFactAndD1Committed'], 'closed_publication_required');
  need(UUID.test(value.snapshotId ?? '') && Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0
    && value.revision === value.baseRevision + 1 && SHA.test(value.archiveSha256 ?? '') && SHA.test(value.manifestSha256 ?? '')
    && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= 512 * 1024 * 1024
    && value.transport === 'content-v1' && value.gatewayPgFactAndD1Committed === true, 'publication_not_corroborated');
  return sorted(value);
}

export function validateQuote(value, seed) {
  closed(value, ['sourceId', 'proposalId', 'reservationId', 'fingerprint', 'quoteId', 'customerId', 'articleId', 'receiptSha256',
    'lineIds', 'quoteCount', 'receiptCount', 'quoteNumber', 'status', 'requiresHumanValidation', 'nativeFrozenCreationVerified', 'auditChainValid'], 'closed_quote_required');
  need(ID.test(value.sourceId ?? '') && ID.test(value.proposalId ?? '') && UUID.test(value.reservationId ?? '') && UUID.test(value.quoteId ?? '')
    && UUID.test(value.customerId ?? '') && UUID.test(value.articleId ?? '') && SHA.test(value.fingerprint ?? '') && SHA.test(value.receiptSha256 ?? '')
    && Array.isArray(value.lineIds) && value.lineIds.length >= 1 && value.lineIds.length <= 100
    && value.lineIds.every(id => UUID.test(id ?? '')) && new Set(value.lineIds).size === value.lineIds.length
    && value.sourceId === seed.sourceId && value.customerId === seed.customerId && value.articleId === seed.articleId
    && value.quoteCount === 1 && value.receiptCount === 1 && value.quoteNumber === null && value.status === 'draft'
    && value.requiresHumanValidation === true && value.nativeFrozenCreationVerified === true && value.auditChainValid === true, 'single_native_draft_required');
  return sorted(value);
}

export function validateComplete(event, seed) {
  closed(event, ['event', 'profileSha256', 'organizationId', 'initialPublication', 'canonicalPublication', 'quote', 'secondStoreExactCreation',
    'secondRoundConfirmed', 'writerActivityCount', 'secondStoreActivityCount', 'strictMeHttp200Both', 'automaticCleanup'], 'closed_g4_complete_required');
  need(event.event === 'complete' && event.profileSha256 === PROFILE && event.organizationId === ORG
    && event.secondStoreExactCreation === true && event.secondRoundConfirmed === 0 && event.writerActivityCount === 1
    && event.secondStoreActivityCount === 0 && event.strictMeHttp200Both === true && event.automaticCleanup === false, 'g4_complete_refused');
  const initial = validatePublication(event.initialPublication), canonical = validatePublication(event.canonicalPublication);
  need(JSON.stringify(initial) === JSON.stringify(seed.publication) && canonical.revision > initial.revision
    && canonical.snapshotId !== initial.snapshotId && canonical.archiveSha256 !== initial.archiveSha256, 'g4_publications_not_distinct');
  return sorted({ initialPublication: initial, canonicalPublication: canonical, quote: validateQuote(event.quote, seed),
    secondStoreExactCreation: true, secondRoundConfirmed: 0, writerActivityCount: 1, secondStoreActivityCount: 0, strictMeHttp200Both: true });
}

export function validateSourceProof(value) {
  closed(value, ['workspaceId', 'connectionId', 'sourceId', 'sourceRevision', 'sourceEnvelopeSha256', 'actualApiHookPersisted',
    'actualHumanQuoteClassification', 'actualGestionDelegation', 'automaticSupportClassificationExecuted', 'thirdPartyMailboxExecuted'], 'closed_source_lifecycle_required');
  need(workspaceIdentifier(value.workspaceId) && UUID.test(value.connectionId ?? '') && UUID.test(value.sourceId ?? '')
    && Number.isSafeInteger(value.sourceRevision) && value.sourceRevision >= 2 && SHA.test(value.sourceEnvelopeSha256 ?? '')
    && value.actualApiHookPersisted === true && value.actualHumanQuoteClassification === true && value.actualGestionDelegation === true
    && value.automaticSupportClassificationExecuted === false && value.thirdPartyMailboxExecuted === false, 'real_api_source_lifecycle_required');
  return sorted(value);
}

function readJson(file) {
  const bytes = fs.readFileSync(file); need(bytes.length <= 1024 * 1024, 'compile_proof_oversized');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Refusal('compile_proof_invalid'); }
}

async function futureHarness(env) {
  assertFutureCiAdmission(env);
  const gitRead = args => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, env: publicEnvironment(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', timer;
    const fail = () => { clearTimeout(timer); child.kill(); reject(new Refusal('g4_source_read_refused')); };
    timer = setTimeout(fail, 30000); child.once('error', fail);
    child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 65536) fail(); });
    child.stderr.on('data', bytes => { errors += bytes; if (Buffer.byteLength(errors) > 65536) fail(); });
    child.once('exit', code => { clearTimeout(timer); if (code !== 0 || errors.trim()) reject(new Refusal('g4_source_read_refused')); else resolve(output.trim()); });
  });
  need(await gitRead(['rev-parse', 'HEAD']) === env.CIRCLE_SHA1
    && await gitRead(['status', '--porcelain', '--untracked-files=no']) === '', 'g4_clean_exact_source_required');
  const futureFiles = ['desktop/scripts/live-g4-api-support-source.mjs', 'desktop/scripts/verify-action-live-g4-windows.mjs',
    'desktop/src-tauri/src/account_cloud_live_a41_g4_tests.rs', 'desktop/src-tauri/src/company_collaboration_live_a41_g4_support.rs'];
  need((await gitRead(['ls-files', '--error-unmatch', '--', ...futureFiles])).split(/\r?\n/).sort().join('|') === futureFiles.sort().join('|'),
    'g4_sources_must_be_tracked');
  const folder = path.join(ROOT, 'desktop/artifacts/action-live-profile');
  const live = readJson(path.join(folder, 'live-profile-verification-proof.json'));
  const harness = readJson(path.join(folder, 'windows-test-harness-proof.json'));
  need(live.source === env.CIRCLE_SHA1 && live.circleSource === env.CIRCLE_SHA1 && live.jobNumber === env.CIRCLE_BUILD_NUM
    && harness.source === env.CIRCLE_SHA1 && live.passed === true && live.runtimePassed === 11 && live.expectedTotal === 11
    && live.compileInputManifestSha256 === PROFILE && live.binarySha256 === harness.binarySha256After
    && harness.prepared === true && harness.compileNoRun === true && harness.compileExit === 0 && SHA.test(live.binarySha256 ?? ''), 'fresh_compile_required');
  const listing = fs.readFileSync(path.join(folder, 'windows-test-harness-list-after.txt'), 'utf8');
  need(Buffer.byteLength(listing) <= 1024 * 1024, 'catalogue_size_refused');
  const lines = listing.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const summary = lines.pop()?.match(/^([0-9]+) tests, 0 benchmarks$/);
  const names = lines.filter(Boolean).map(line => { const m = line.match(/^([A-Za-z_][A-Za-z0-9_:]*): test$/); need(m, 'catalogue_row_refused'); return m[1]; });
  need(summary && names.length === Number(summary[1]) && names.length === live.catalogueCount && new Set(names).size === names.length
    && names.includes(TEST) && names.includes('account_cloud::live_a41_account_tests::enroll_two_native_stores')
    && names.includes('account_cloud::live_a41_account_tests::reopen_two_native_stores'), 'new_g4_test_required_before_enrollment');
  need(typeof harness.executable === 'string' && path.isAbsolute(harness.executable), 'exact_g4_library_required');
  const executable = fs.realpathSync(harness.executable), stat = fs.lstatSync(harness.executable);
  const deps = fs.realpathSync(path.join(ROOT, 'desktop/src-tauri/target/release/deps'));
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024 * 1024
    && path.dirname(executable).toLowerCase() === deps.toLowerCase() && /^helvichantier_lib-[a-f0-9]{16}\.exe$/.test(path.basename(executable))
    && await shaFile(executable) === live.binarySha256, 'g4_library_hash_refused');
  return { executable, sha256: live.binarySha256, source: live.source, catalogueCount: names.length };
}

export class G4DiagnosticChannel {
  #socket; #buffer = Buffer.alloc(0); #queue = []; #pending; #failure; #ended = false; #terminalPending; #setTimer; #clearTimer;
  constructor(socket, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.#socket = socket;
    this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    socket.on('data', bytes => {
        this.#buffer = Buffer.concat([this.#buffer, bytes]);
        for (;;) {
          const end = this.#buffer.indexOf(10); if (end < 0) break;
          if (end > MAX || this.#queue.length >= G4_MAX_QUEUED_EVENTS) { this.fail('g4_pipe_bounds_refused'); return; }
          let text, value;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer.subarray(0, end)); }
          catch { this.fail('g4_pipe_utf8_refused'); return; }
          try { value = parsePrivateJson(text); }
          catch { this.fail('g4_pipe_json_refused'); return; }
          this.#buffer = this.#buffer.subarray(end + 1);
          if (this.#pending) { const pending = this.#pending; this.#pending = undefined; pending.resolve(value); }
          else this.#queue.push(value);
        }
        if (this.#buffer.length > MAX) this.fail('g4_pipe_bounds_refused');
    });
    socket.on('error', () => this.fail('g4_pipe_socket_error'));
    const ended = reason => {
      this.#ended = true; this.fail(reason);
      this.#terminalPending?.resolve(); this.#terminalPending = undefined;
    };
    socket.on('end', () => ended('g4_pipe_eof')); socket.on('close', () => ended('g4_pipe_closed'));
  }
  fail(reason) {
    const code = TRANSPORT_CODES.has(reason) ? reason : 'g4_pipe_transport_refused';
    if (this.#failure && (!NORMAL_PIPE_END.has(this.#failure) || NORMAL_PIPE_END.has(code))) return;
    this.#failure = code;
    this.#pending?.reject(new Refusal(this.#failure)); this.#pending = undefined; this.#socket.destroy();
    if (!NORMAL_PIPE_END.has(this.#failure)) {
      this.#terminalPending?.reject(new Refusal(this.#failure)); this.#terminalPending = undefined;
    }
  }
  read() {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#failure) return Promise.reject(new Refusal(this.#failure));
    return new Promise((resolve, reject) => {
      const timer = this.#setTimer(() => this.fail('g4_pipe_read_timeout'), 240000);
      this.#pending = { resolve: value => { this.#clearTimer(timer); resolve(value); }, reject: error => { this.#clearTimer(timer); reject(error); } };
    });
  }
  write(value) { const text = JSON.stringify(value); need(!this.#failure && Buffer.byteLength(text) <= MAX, 'g4_pipe_write_refused'); this.#socket.write(text + '\n'); }
  assertTerminal() {
    if (this.#failure && !NORMAL_PIPE_END.has(this.#failure)) throw new Refusal(this.#failure);
    need(this.#ended && this.#queue.length === 0 && this.#buffer.length === 0 && !this.#pending, 'g4_pipe_terminal_refused');
  }
  async finalize() {
    if (!this.#ended && (!this.#failure || NORMAL_PIPE_END.has(this.#failure))) {
      need(!this.#terminalPending, 'g4_pipe_terminal_refused');
      await new Promise((resolve, reject) => {
        const timer = this.#setTimer(() => this.fail('g4_pipe_read_timeout'), 240000);
        this.#terminalPending = { resolve: () => { this.#clearTimer(timer); resolve(); },
          reject: error => { this.#clearTimer(timer); reject(error); } };
      });
    }
    this.assertTerminal();
  }
  close() { this.#socket.destroy(); }
}

function publicEnvironment(env) {
  const result = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'CIRCLECI', 'CIRCLE_BRANCH']) {
    if (typeof env[name] === 'string') result[name] = env[name];
  }
  return result;
}
function childEnvironment(env, pipe) { return { ...publicEnvironment(env), RUST_BACKTRACE: '0', ZENTRA_RUN_LIVE_G4_RECIPE: 'true', ZENTRA_A41_G4_PRIVATE_PIPE: pipe }; }

async function nativeG4(harness, input, continuation, account, provisionSource, env) {
  const pipeName = `\\\\.\\pipe\\zentra-a41-g4-${randomUUID()}`, challenge = randomBytes(32).toString('base64url');
  const server = net.createServer(); let channel, child, accepted = false, completed = false, timer, stdout = '', stderr = '';
  let phase = 'native_spawn', checkpointsSeen = 0, lastCheckpoint = null, reviewCounts = null;
  let nativeSpawned = false, helloValidated = false, nativeExited = false, nativeExitCode = null, nativeSignaled = false;
  const readEvent = async () => {
    for (;;) {
      const event = await channel.read();
      if (event?.event === 'checkpoint') {
        lastCheckpoint = validateG4Checkpoint(event, checkpointsSeen);
        checkpointsSeen++;
      } else if (event?.event === 'review-required') {
        reviewCounts = validateG4Review(event, checkpointsSeen);
        // An observed human-review outcome is terminal for this nominal recipe.
        // Never retry preparation or promote it into a successful G4 result.
        throw new Refusal('g4_review_required');
      } else return event;
    }
  };
  let rejectConnection;
  const connected = new Promise((resolve, reject) => { rejectConnection = reject; server.once('error', () => reject(new Refusal('g4_pipe_server_failed')));
    server.on('connection', socket => { if (accepted) { socket.destroy(); return; } accepted = true; channel = new G4DiagnosticChannel(socket); resolve(channel); }); });
  connected.catch(() => {});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipeName, resolve); });
    need(await shaFile(harness.executable) === harness.sha256, 'g4_library_changed_before_run');
    child = spawn(harness.executable, [TEST, '--exact', '--ignored', '--test-threads=1'], { cwd: ROOT,
      env: childEnvironment(env, pipeName), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.once('spawn', () => { nativeSpawned = true; });
    let rejectExit;
    const exited = new Promise((resolve, reject) => { rejectExit = reject;
      child.once('error', () => {
        const failure = new Refusal('g4_native_spawn_failed');
        rejectConnection(failure); reject(failure);
      });
      child.once('exit', (code, signal) => {
        nativeExited = true; nativeExitCode = code; nativeSignaled = signal !== null;
        if (!completed && !accepted) rejectConnection(new Refusal('g4_native_refused_before_pipe'));
        // Exit can precede the final named-pipe data/end events. Do not destroy
        // the pipe here: preserve a queued review and drain the terminal frame.
        resolve({ code, signal });
      }); });
    exited.catch(() => {});
    const stop = code => { rejectConnection(new Refusal(code)); channel?.fail(code); rejectExit(new Refusal(code)); child.kill(); };
    timer = setTimeout(() => stop('g4_pipe_global_deadline'), 600000);
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); if (Buffer.byteLength(stdout) > 1024 * 1024) stop('g4_pipe_output_limit'); });
    child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); if (Buffer.byteLength(stderr) > 1024 * 1024) stop('g4_pipe_output_limit'); });
    child.stdin.on('error', () => stop('g4_pipe_stdin_error')); child.stdin.end(JSON.stringify({ challenge }) + '\n');
    channel = await connected;
    phase = 'handshake';
    const hello = await channel.read(); closed(hello, ['event', 'challenge'], 'closed_g4_hello_required');
    need(hello.event === 'hello' && hello.challenge === challenge, 'g4_pipe_challenge_refused');
    helloValidated = true; phase = 'initial_publication';
    channel.write({ format: 'zentra-a41-g4-private-v1', sitesServiceToken: input.sitesServiceToken,
      rootDir: continuation.rootDir, installations: account.phases[1].installations });
    const initial = await readEvent();
    need(checkpointsSeen === INITIAL_CHECKPOINTS, 'g4_checkpoint_incomplete');
    closed(initial, ['event', 'publication', 'customerId', 'articleId', 'consentRevisions'], 'closed_initial_publication_required');
    need(initial.event === 'initial-publication' && UUID.test(initial.customerId ?? '') && UUID.test(initial.articleId ?? '')
      && Array.isArray(initial.consentRevisions) && initial.consentRevisions.length === 2
      && initial.consentRevisions.every(n => Number.isSafeInteger(n) && n >= 1), 'paid_consent_initial_publication_required');
    const seed = { publication: validatePublication(initial.publication), customerId: initial.customerId, articleId: initial.articleId };
    // This hook is an external lifecycle handoff, NOT a transport/provider seam:
    // it can return ONE selector only, and all native handlers read/re-authorize
    // the durable source. Its implementation must use the actual Support path.
    phase = 'support_source';
    const source = await provisionSource(Object.freeze({ ...seed, organizationId: ORG,
      browserCookieHeader: continuation.browserCookieHeader }));
    closed(source, ['sourceId'], 'closed_real_source_selector_required'); need(ID.test(source.sourceId ?? ''), 'real_source_selector_required');
    seed.sourceId = source.sourceId; channel.write({ event: 'source-ready', sourceId: source.sourceId });
    phase = 'quote_round';
    const complete = validateComplete(await readEvent(), seed);
    need(checkpointsSeen === G4_CHECKPOINTS.length, 'g4_checkpoint_incomplete');
    phase = 'native_result';
    const result = await exited;
    await channel.finalize();
    const name = TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    need(result.code === 0 && !result.signal && stderr.trim() === ''
      && new RegExp(`^test ${name} \\.\\.\\. ok\\r?$`, 'm').test(stdout)
      && new RegExp(`^test result: ok\\. 1 passed; 0 failed; 0 ignored; 0 measured; ${harness.catalogueCount - 1} filtered out; finished in [0-9.]+s\\r?$`, 'm').test(stdout)
      && await shaFile(harness.executable) === harness.sha256, 'exact_g4_native_result_required');
    channel.assertTerminal();
    completed = true; return complete;
  } catch (error) {
    const code = reviewCounts ? 'g4_review_required' : error instanceof Refusal && TRANSPORT_CODES.has(error.code)
      ? error.code : 'g4_validation_refused';
    const receipt = validateG4DiagnosticReceipt({ format: 'zentra-a41-native-g4-diagnostic-v1', sourceSha: harness.source,
      binarySha256: harness.sha256, profileSha256: PROFILE, passed: false, nominalG4Passed: false,
      outcome: reviewCounts ? 'needs_review' : 'failed', phase, code, lastCheckpoint, checkpointsSeen, counts: reviewCounts,
      nativeSpawned, pipeConnected: accepted, helloValidated, nativeExited, nativeExitCode, nativeSignaled });
    fs.writeFileSync(path.join(ROOT, 'desktop/artifacts/action-live-profile/native-g4-diagnostic.public.json'),
      JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(`LIVE_G4_DIAGNOSTIC phase=${receipt.phase} code=${receipt.code} outcome=${receipt.outcome}\n`);
    throw error;
  } finally {
    clearTimeout(timer); channel?.close(); if (!completed && child) child.kill();
    await new Promise(resolve => server.close(resolve));
    // Never persist/forward native stdout/stderr, cookies, paths or protected DB.
  }
}

export async function runLiveG4Recipe(rawAccountInput) {
  const input = validatePrivateInput(rawAccountInput), env = { ...process.env };
  const harness = await futureHarness(env); // BEFORE any native enrollment.
  let continuation;
  const account = await runLiveAccountRecipe(input, { privateContinuationSink: value => { continuation = value; } });
  need(account.source === harness.source && account.binarySha256 === harness.sha256 && account.protectedStateReopened === true
    && account.sameExecutableBothPhases === true && account.phases.length === 2 && continuation
    && path.win32.isAbsolute(continuation.rootDir), 'same_job_native_account_continuation_required');
  const source = makeRealApiSupportSource(input);
  const g4 = await nativeG4(harness, input, continuation, account, source.provision, env);
  const sourceLifecycle = validateSourceProof(source.publicProof());
  need(sourceLifecycle.sourceId === g4.quote.sourceId, 'g4_source_lifecycle_not_correlated');
  return sorted({ format: 'zentra-a41-native-g4-report-v1', source: harness.source, binarySha256: harness.sha256,
    profileSha256: PROFILE, coordinatorSha256: await shaFile(fileURLToPath(import.meta.url)), exactTest: TEST,
    account, g4, sourceLifecycle, sameExecutableAllThreePhases: true, storesCreatedInThisJob: true, nativeExecuted: true,
    actualApiSupportLifecycle: true, realDecisionProviderDirectlyAttested: false,
    g5FailureMatrixExecuted: false, storageV0Executed: false, automaticCleanup: false });
}

export const DESCRIPTION = Object.freeze({ inactiveByDefault: true, productIntegrationPending: true,
  compiledInB502: false, historicalSourcesRefused: [...EXCLUDED_SOURCES], profileSha256: PROFILE, exactTest: TEST,
  requiredFlag: 'ZENTRA_RUN_LIVE_G4_RECIPE=true', composition: ['enroll', 'reopen', 'initial archive + G4 round + second store'],
  accountCoordinatorUnchanged: true, existingAccountJobCompatible: true, testOnlyCiWiringPresent: true, nativeExecutionValidated: false,
  requiredTestModules: ['account_cloud::live_a41_g4_tests', 'company_collaboration::live_a41_g4_support'],
  sourceLifecycleRequired: 'Existing Support API webhook + actual human quote classification + Gestion delegation after initial PG/D1 publication',
  paidCompleteRequired: 'Real quote-consent admission and normal work/A8/A7 predicates; no caller flags or D1 SQL',
  publicReportOnly: true, createsInfrastructure: false, createsSupportTestData: true, automaticCleanup: false });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--describe')) process.stdout.write(JSON.stringify(DESCRIPTION) + '\n');
  else { process.stderr.write('{"passed":false,"code":"dedicated_g4_ci_entrypoint_required"}\n'); process.exitCode = 1; }
}
