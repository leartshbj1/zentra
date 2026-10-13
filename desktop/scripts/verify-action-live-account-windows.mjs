// Inactive unless --run, exact CI admission and private stdin are all supplied.
// No Cargo, compilation, browser launch, release, AE or cleanup is performed.
// The two ignored Rust tests use the SAME already verified library executable.
// Secrets enter through private stdin; approval codes travel on a challenged
// Windows duplex pipe. Native stdout/stderr are captured, never persisted or
// forwarded. Only a closed public report is emitted by this coordinator.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site';
const PROFILE_SHA256 = '2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf';
const OWNER_ID = '1f0d9981-607b-4848-9374-587035cdfd89';
const ORGANIZATION_ID = 'org_trial_345a3d1f68056cf7e709d4af4fc229a4';
const PRIVATE_FORMAT = 'zentra-a41-native-private-v1';
const MAX_MESSAGE = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TESTS = Object.freeze({
  enroll: 'account_cloud::live_a41_account_tests::enroll_two_native_stores',
  reopen: 'account_cloud::live_a41_account_tests::reopen_two_native_stores',
});
export const SESSION_REGRESSION_TESTS = Object.freeze([
  'account_cloud::tests::validates_server_organization_ids_for_uuid_and_trial_contracts',
  'account_cloud::tests::trial_organization_session_keeps_normal_credential_and_role_guards',
  'account_cloud::tests::trial_organization_session_is_bound_to_its_installation',
]);
class RecipeFailure extends Error {
  constructor(code) { super(code); this.name = 'RecipeFailure'; this.code = code; }
}
const need = (condition, code) => { if (!condition) throw new RecipeFailure(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, expected, code) => need(plain(value) && Object.keys(value).sort().join('|') === [...expected].sort().join('|'), code);
const sorted = value => Array.isArray(value) ? value.map(sorted) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

export function parsePrivateJson(text) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= MAX_MESSAGE, 'private_input_size_refused');
  let value;
  try { value = JSON.parse(text); } catch { throw new RecipeFailure('private_input_json_refused'); }
  // Canonical JSON.stringify wire encoding also rejects duplicate field names.
  need(text === JSON.stringify(value), 'private_input_encoding_refused');
  return value;
}

export function validatePrivateInput(input) {
  keys(input, ['format', 'sitesServiceToken', 'browserCookieHeader', 'expectedOwnerId', 'expectedOrganizationId'], 'closed_private_input_required');
  need(input.format === 'zentra-a41-native-account-input-v1', 'private_input_format_refused');
  need(input.expectedOwnerId === OWNER_ID && input.expectedOrganizationId === ORGANIZATION_ID, 'retained_a43_authority_required');
  need(typeof input.sitesServiceToken === 'string' && /^[\x21-\x7e]{32,4096}$/.test(input.sitesServiceToken), 'sites_token_refused');
  need(typeof input.browserCookieHeader === 'string' && input.browserCookieHeader.length <= 16384 && /^[\x21-\x7e ]+$/.test(input.browserCookieHeader), 'browser_cookie_refused');
  const jar = new CookieJar(input.browserCookieHeader);
  need(jar.hasOwner(), 'retained_browser_session_required');
  return { ...input };
}

export function assertCiAdmission(environment, platform = process.platform) {
  const expected = { CIRCLECI: 'true', CIRCLE_BRANCH: 'codex/action-engine-native-live-a41', CIRCLE_NODE_INDEX: '0', CIRCLE_NODE_TOTAL: '1',
    ZENTRA_VERIFY_DIAGNOSTICS_ONLY: 'true', ZENTRA_VERIFY_ONLY: 'true', ZENTRA_VERIFY_NATIVE_PROFILE_ONLY: 'false',
    ZENTRA_VERIFY_LIVE_PROFILE_ONLY: 'false', ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY: 'true', ZENTRA_LIVE_PROFILE_RELEASE: 'false', ZENTRA_DIAGNOSTICS_NATIVE_SET: 'action-engine',
    ZENTRA_RUN_LIVE_ACCOUNT_RECIPE: 'true' };
  need(platform === 'win32' && plain(environment), 'windows_ci_required');
  for (const [name, value] of Object.entries(expected)) need(environment[name] === value, 'explicit_ci_admission_required');
  need(/^[a-f0-9]{40}$/.test(environment.CIRCLE_SHA1 ?? '') && environment.CIRCLE_SHA1 !== 'ad57c6905112462bbf844c8bb89072d488294f2c'
    && /^[1-9][0-9]{0,9}$/.test(environment.CIRCLE_BUILD_NUM ?? ''), 'new_ci_identity_required');
}

class CookieJar {
  #values = new Map();
  constructor(header) {
    for (const pair of header.split('; ')) {
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator), value = pair.slice(separator + 1);
      need(separator > 0 && /^__Host-zentra_[a-z_]+$/.test(name) && /^[\x21-\x7e]+$/.test(value) && !/[;,]/.test(value) && !this.#values.has(name), 'cookie_boundary_refused');
      this.#values.set(name, value);
    }
  }
  absorb(response) {
    need(typeof response.headers.getSetCookie === 'function', 'node_get_set_cookie_required');
    for (const header of response.headers.getSetCookie()) {
      const parts = header.split(';').map(part => part.trim()), separator = parts[0].indexOf('=');
      need(separator > 0, 'response_cookie_refused');
      const name = parts[0].slice(0, separator), value = parts[0].slice(separator + 1);
      if (!name.startsWith('__Host-zentra_')) continue;
      need(/^__Host-zentra_[a-z_]+$/.test(name) && /^[\x21-\x7e]*$/.test(value) && !/[;,]/.test(value), 'response_cookie_refused');
      const attributes = new Map(parts.slice(1).map(part => { const i = part.indexOf('='); return i < 0 ? [part.toLowerCase(), ''] : [part.slice(0, i).toLowerCase(), part.slice(i + 1)]; }));
      need(!attributes.has('domain') && attributes.get('path') === '/' && attributes.has('secure') && attributes.has('httponly') && attributes.get('samesite')?.toLowerCase() === 'lax', 'response_cookie_boundary_refused');
      if (!value || (attributes.has('max-age') && Number(attributes.get('max-age')) <= 0)) this.#values.delete(name);
      else this.#values.set(name, value);
    }
  }
  hasOwner() {
    let owner;
    try { owner = decodeURIComponent(this.#values.get('__Host-zentra_session_owner') ?? ''); } catch { return false; }
    return owner === OWNER_ID && Boolean(this.#values.get('__Host-zentra_access') && this.#values.get('__Host-zentra_refresh'));
  }
  header() { return [...this.#values].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join('; '); }
}

async function boundedJson(response) {
  need(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'site_json_required');
  need(response.body, 'site_response_required');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; need(size <= 64 * 1024, 'site_response_size_refused'); parts.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new RecipeFailure('site_response_json_refused'); }
  } finally { await reader.cancel().catch(() => {}); }
}

async function siteRequest(input, jar, route, body) {
  need(['/api/auth/session', '/api/account/workspaces', '/api/account/device/approve'].includes(route), 'browser_route_refused');
  const headers = { accept: 'application/json', origin: ORIGIN, cookie: jar.header(), 'oai-sites-authorization': `Bearer ${input.sitesServiceToken}` };
  if (body) headers['content-type'] = 'application/json';
  let response;
  try { response = await fetch(ORIGIN + route, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new RecipeFailure('browser_network_failed'); }
  need(response.status === 200, 'browser_http_200_required');
  jar.absorb(response); const payload = await boundedJson(response);
  need(jar.hasOwner(), 'browser_owner_changed');
  return payload;
}

async function verifyBrowserAuthority(input, jar) {
  const session = await siteRequest(input, jar, '/api/auth/session');
  need(session?.authenticated === true && session.user?.id === OWNER_ID && session.user?.emailConfirmed === true, 'browser_identity_mismatch');
  const discovery = await siteRequest(input, jar, '/api/account/workspaces');
  need(Array.isArray(discovery?.workspaces) && discovery.workspaces.some(workspace => workspace.organizationId === ORGANIZATION_ID && workspace.role === 'owner' && workspace.edition === 'ch_legacy'), 'browser_workspace_mismatch');
}

async function shaFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function loadVerifiedHarness(environment) {
  const artifacts = path.join(REPOSITORY, 'desktop/artifacts/action-live-profile');
  const read = filename => {
    const bytes = fs.readFileSync(path.join(artifacts, filename)); need(bytes.length <= 1024 * 1024, 'compile_proof_size_refused');
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new RecipeFailure('compile_proof_json_refused'); }
  };
  const harness = read('windows-test-harness-proof.json'), live = read('live-profile-verification-proof.json');
  need(harness.prepared === true && harness.source === environment.CIRCLE_SHA1 && harness.verificationOnly === true && harness.contextMode === 'diagnostics-verification'
    && harness.nativeProfile === 'release' && harness.target === 'x86_64-pc-windows-msvc' && harness.compileNoRun === true && harness.compileExit === 0, 'verified_library_harness_required');
  need(live.passed === true && live.runtimePassed === 11 && live.expectedTotal === 11 && live.context === 'live-sandbox-a41'
    && live.source === environment.CIRCLE_SHA1 && live.circleSource === environment.CIRCLE_SHA1 && live.jobNumber === environment.CIRCLE_BUILD_NUM
    && live.compileInputManifestSha256 === PROFILE_SHA256 && live.fixtureBytesSha256 === '2dbc44803bfbb886ede0e07637465bb3bb562c46392b971ec757939c99300ac0'
    && live.binarySha256 === harness.binarySha256After && SHA256.test(live.binarySha256 ?? '')
    && Number.isSafeInteger(live.catalogueCount) && live.catalogueCount >= 13, 'eleven_live_profile_checks_required');
  const catalogueBytes = fs.readFileSync(path.join(artifacts, 'windows-test-harness-list-after.txt'));
  need(catalogueBytes.length <= 1024 * 1024, 'native_catalogue_size_refused');
  const lines = catalogueBytes.toString('utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
  const summary = lines.pop()?.match(/^([0-9]+) tests, 0 benchmarks$/);
  const names = lines.filter(Boolean).map(line => { const match = line.match(/^([A-Za-z_][A-Za-z0-9_:]*): test$/); need(match, 'native_catalogue_row_refused'); return match[1]; });
  need(summary && names.length === Number(summary[1]) && names.length === live.catalogueCount && new Set(names).size === names.length
    && Object.values(TESTS).every(name => names.includes(name)), 'new_live_tests_required_before_execution');
  need(typeof harness.executable === 'string' && path.isAbsolute(harness.executable), 'exact_library_executable_required');
  const executable = fs.realpathSync(harness.executable), metadata = fs.lstatSync(harness.executable);
  const deps = fs.realpathSync(path.join(REPOSITORY, 'desktop/src-tauri/target/release/deps'));
  need(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 && metadata.size <= 512 * 1024 * 1024
    && path.dirname(executable).toLowerCase() === deps.toLowerCase() && /^helvichantier_lib-[a-f0-9]{16}\.exe$/.test(path.basename(executable)), 'library_executable_scope_refused');
  need(await shaFile(executable) === live.binarySha256, 'library_executable_hash_mismatch');
  return { executable, sha256: live.binarySha256, catalogueCount: live.catalogueCount, source: live.source };
}

class PrivateChannel {
  #socket; #buffer = Buffer.alloc(0); #queue = []; #pending; #failed;
  constructor(socket) {
    this.#socket = socket;
    socket.on('data', chunk => {
      try {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        for (;;) {
          const newline = this.#buffer.indexOf(10); if (newline < 0) break;
          need(newline <= MAX_MESSAGE && this.#queue.length < 8, 'private_protocol_bounds_refused');
          const value = parsePrivateJson(new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer.subarray(0, newline)));
          this.#buffer = this.#buffer.subarray(newline + 1);
          if (this.#pending) { const pending = this.#pending; this.#pending = undefined; pending.resolve(value); }
          else this.#queue.push(value);
        }
        need(this.#buffer.length <= MAX_MESSAGE, 'private_protocol_bounds_refused');
      } catch { this.fail(); }
    });
    socket.on('error', () => this.fail());
    socket.on('end', () => this.fail());
  }
  fail() { this.#failed = true; if (this.#pending) { this.#pending.reject(new RecipeFailure('private_protocol_failed')); this.#pending = undefined; } this.#socket.destroy(); }
  read() {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#failed) return Promise.reject(new RecipeFailure('private_protocol_failed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); reject(new RecipeFailure('private_protocol_timeout')); }, 240000);
      this.#pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
  }
  write(value) { const text = JSON.stringify(value); need(Buffer.byteLength(text) <= MAX_MESSAGE && !this.#failed, 'private_protocol_write_refused'); this.#socket.write(text + '\n'); }
  close() { this.#socket.destroy(); }
}

export function validateInstallationProofs(proofs) {
  need(Array.isArray(proofs) && proofs.length === 2, 'two_native_proofs_required');
  const result = proofs.map(proof => {
    keys(proof, ['installationId', 'licenseId', 'accountSessionId', 'jti', 'licenseSha256', 'sessionSha256'], 'closed_native_proof_required');
    need(UUID.test(proof.installationId ?? '') && UUID.test(proof.jti ?? '') && /^dss_/.test(proof.accountSessionId ?? '') && UUID.test(proof.accountSessionId.slice(4))
      && typeof proof.licenseId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(proof.licenseId) && SHA256.test(proof.licenseSha256 ?? '') && SHA256.test(proof.sessionSha256 ?? ''), 'native_proof_identity_refused');
    // Session fingerprints are only a private baseline between processes.
    // The public projection deliberately omits them, as well as all tokens.
    return { installationId: proof.installationId, licenseId: proof.licenseId, accountSessionId: proof.accountSessionId, jti: proof.jti, licenseSha256: proof.licenseSha256 };
  });
  for (const field of ['installationId', 'licenseId', 'accountSessionId']) need(new Set(result.map(proof => proof[field])).size === 2, 'native_proofs_not_distinct');
  return result;
}

const NATIVE_PROGRESS = Object.freeze({
  enroll: Object.freeze([
    ...[0, 1].flatMap(index => ['initialize_store', 'start_link', 'pending_poll', 'approved_poll'].map(step => Object.freeze({ step, index }))),
    ...[0, 1].map(index => Object.freeze({ step: 'verify_native_proof', index })),
  ]),
  reopen: Object.freeze([...[0, 1].flatMap(index => ['retained_store', 'initialize_store', 'verify_native_proof'].map(step => Object.freeze({ step, index })))]),
});

export function validateNativeProgress(event, phase, position) {
  keys(event, ['event', 'phase', 'step', 'index'], 'closed_native_progress_required');
  const expected = Number.isSafeInteger(position) && position >= 0 ? NATIVE_PROGRESS[phase]?.[position] : undefined;
  need(expected && event.event === 'progress' && event.phase === phase && event.step === expected.step && event.index === expected.index,
    'native_progress_order_refused');
  // Only compile-time literals can form this public diagnostic code.
  return `native_${phase}_${expected.step}_${expected.index}`;
}

function childEnvironment(environment, pipe) {
  const result = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'CIRCLECI', 'CIRCLE_BRANCH']) {
    if (typeof environment[name] === 'string') result[name] = environment[name];
  }
  return { ...result, RUST_BACKTRACE: '0', ZENTRA_A41_NATIVE_PRIVATE_PIPE: pipe };
}

// Public-environment regression tests of the freshly compiled, verified binary.
// The same strict Windows CI admission applies; never call this on a local PC.
export async function runLiveSessionRegressions() {
  const environment = { ...process.env };
  assertCiAdmission(environment);
  const harness = await loadVerifiedHarness(environment);
  const catalogue = fs.readFileSync(path.join(REPOSITORY, 'desktop/artifacts/action-live-profile/windows-test-harness-list-after.txt'), 'utf8');
  need(SESSION_REGRESSION_TESTS.every(name => catalogue.replace(/\r\n/g, '\n').split('\n').includes(`${name}: test`)), 'session_regression_tests_required');
  const childEnv = childEnvironment(environment, '');
  delete childEnv.ZENTRA_A41_NATIVE_PRIVATE_PIPE;
  for (const name of SESSION_REGRESSION_TESTS) {
    need(await shaFile(harness.executable) === harness.sha256, 'regression_library_changed');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(harness.executable, [name, '--exact', '--nocapture', '--test-threads=1'], {
        cwd: REPOSITORY, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new RecipeFailure('session_regression_timeout')); }, 60000);
      const capture = (stream, bytes) => {
        if (Buffer.byteLength(stream === 'stdout' ? stdout : stderr) + bytes.length > 128 * 1024) {
          child.kill(); reject(new RecipeFailure('session_regression_output_refused')); return;
        }
        if (stream === 'stdout') stdout += bytes.toString('utf8'); else stderr += bytes.toString('utf8');
      };
      child.stdout.on('data', bytes => capture('stdout', bytes));
      child.stderr.on('data', bytes => capture('stderr', bytes));
      child.once('error', () => { clearTimeout(timer); reject(new RecipeFailure('session_regression_process_failed')); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    need(result.code === 0 && result.stderr.trim() === ''
      && result.stdout.replace(/\r\n/g, '\n').split('\n').includes(`test ${name} ... ok`)
      && result.stdout.includes(`test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; ${harness.catalogueCount - 1} filtered out;`),
      'session_regression_not_proven');
  }
  need(await shaFile(harness.executable) === harness.sha256, 'regression_library_changed');
  return { format: 'zentra-a41-native-session-regressions-v1', source: harness.source, binarySha256: harness.sha256,
    tests: [...SESSION_REGRESSION_TESTS], passed: SESSION_REGRESSION_TESTS.length, nativeExecuted: true };
}

async function nativePhase(phase, harness, input, jar, environment, previous) {
  need(await shaFile(harness.executable) === harness.sha256, 'library_changed_before_phase');
  const pipeName = `\\\\.\\pipe\\zentra-a41-native-${randomUUID()}`, challenge = randomBytes(32).toString('base64url');
  let channel, accepted = false, child, completed = false, timer, stdout = '', stderr = '', rootDir = previous?.rootDir;
  let progressCount = 0, diagnosticStage;
  const server = net.createServer();
  const connection = new Promise((resolve, reject) => {
    server.on('error', () => reject(new RecipeFailure('private_pipe_failed')));
    server.on('connection', socket => { if (accepted) { socket.destroy(); return; } accepted = true; channel = new PrivateChannel(socket); resolve(channel); });
  });
  // A listen failure can occur before the connection race is awaited.
  connection.catch(() => {});
  try {
    await new Promise((resolve, reject) => { server.once('error', () => reject(new RecipeFailure('private_pipe_failed'))); server.listen(pipeName, resolve); });
    child = spawn(harness.executable, [TESTS[phase], '--ignored', '--exact', '--nocapture', '--test-threads=1'], { cwd: REPOSITORY,
      env: childEnvironment(environment, pipeName), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let rejectExit;
    const exit = new Promise((resolve, reject) => { rejectExit = reject; child.once('error', () => resolve({ code: null })); child.once('close', code => resolve({ code })); });
    const stop = (code = 'native_process_stopped') => { child.kill(); channel?.fail(); rejectExit(new RecipeFailure(code)); };
    timer = setTimeout(() => stop('native_phase_timeout'), 480000);
    child.stdout.on('data', bytes => { if (Buffer.byteLength(stdout) + bytes.length > 1024 * 1024) stop(); else stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { if (Buffer.byteLength(stderr) + bytes.length > 64 * 1024) stop(); else stderr += bytes.toString('utf8'); });
    child.stdin.on('error', () => stop('native_stdin_failed')); child.stdin.end(JSON.stringify({ challenge }) + '\n');
    channel = await Promise.race([connection, exit.then(() => { throw new RecipeFailure('native_exited_before_pipe'); })]);
    const hello = await channel.read(); keys(hello, ['event', 'challenge'], 'private_pipe_hello_refused');
    need(hello.event === 'hello' && hello.challenge === challenge, 'private_pipe_challenge_refused');
    channel.write({ format: PRIVATE_FORMAT, phase, sitesServiceToken: input.sitesServiceToken, expectedOwnerId: OWNER_ID,
      expectedOrganizationId: ORGANIZATION_ID, rootDir: previous?.rootDir ?? null, baseline: previous?.privateBaseline ?? null });
    const admitted = await channel.read(); keys(admitted, ['event', 'phase', 'profileSha256'], 'native_admission_refused');
    need(admitted.event === 'admitted' && admitted.phase === phase && admitted.profileSha256 === PROFILE_SHA256, 'native_profile_admission_mismatch');
    await verifyBrowserAuthority(input, jar); channel.write({ event: 'continue' });
    const approvals = [];
    for (;;) {
      const event = await channel.read();
      if (event?.event === 'progress') {
        diagnosticStage = validateNativeProgress(event, phase, progressCount++);
      } else if (phase === 'enroll' && event?.event === 'workspace') {
        keys(event, ['event', 'rootDir'], 'closed_workspace_event_required');
        need(rootDir === undefined && typeof event.rootDir === 'string' && path.win32.isAbsolute(event.rootDir)
          && path.win32.basename(event.rootDir).startsWith('zentra-a41-native-'), 'private_workspace_refused'); rootDir = event.rootDir;
      } else if (phase === 'enroll' && event?.event === 'approve') {
        keys(event, ['event', 'index', 'installationId', 'userCode'], 'closed_approval_event_required');
        need(rootDir && event.index === approvals.length && event.index < 2 && UUID.test(event.installationId ?? '')
          && /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(event.userCode ?? ''), 'native_approval_event_refused');
        const response = await siteRequest(input, jar, '/api/account/device/approve', { userCode: event.userCode, organizationId: ORGANIZATION_ID });
        need(response?.approved === true && response.organization?.id === ORGANIZATION_ID, 'real_browser_approval_mismatch');
        approvals.push(event.installationId); channel.write({ event: 'approved' });
      } else {
        need(progressCount === NATIVE_PROGRESS[phase].length, 'native_progress_incomplete');
        keys(event, ['event', 'phase', 'profileSha256', 'ownerId', 'organizationId', 'strictMeHttp200', 'nativeLicenseValidated', 'installations'], 'closed_completion_event_required');
        need(event.event === 'complete' && event.phase === phase && event.profileSha256 === PROFILE_SHA256 && event.ownerId === OWNER_ID
          && event.organizationId === ORGANIZATION_ID && event.strictMeHttp200 === true && event.nativeLicenseValidated === true, 'native_completion_refused');
        const proofs = validateInstallationProofs(event.installations);
        if (phase === 'enroll') need(rootDir && approvals.length === 2 && proofs.every((proof, index) => proof.installationId === approvals[index]), 'native_enrollment_incomplete');
        else need(JSON.stringify(sorted(event.installations)) === JSON.stringify(sorted(previous.privateBaseline)), 'persisted_native_identity_changed');
        const result = await exit;
        const exactName = TESTS[phase].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        need(result.code === 0 && stderr.trim() === '' && new RegExp(`^test ${exactName} \\.\\.\\. ok\\r?$`, 'm').test(stdout)
          && new RegExp(`^test result: ok\\. 1 passed; 0 failed; 0 ignored; 0 measured; ${harness.catalogueCount - 1} filtered out; finished in [0-9.]+s\\r?$`, 'm').test(stdout), 'exact_native_test_not_proven');
        need(await shaFile(harness.executable) === harness.sha256, 'library_changed_after_phase');
        completed = true; return { rootDir, proofs, privateBaseline: event.installations, publicPhase: { phase, exactTest: TESTS[phase], strictMeHttp200: true, nativeLicenseValidated: true, installations: proofs } };
      }
    }
  } catch (error) {
    if (diagnosticStage && ['private_protocol_failed', 'private_protocol_timeout'].includes(error?.code)) {
      throw new RecipeFailure(diagnosticStage + (error.code === 'private_protocol_timeout' ? '_timeout' : '_failed'));
    }
    throw error;
  } finally {
    clearTimeout(timer); channel?.close(); if (!completed && child) child.kill();
    await new Promise(resolve => server.close(resolve));
    // Deliberately no raw child output, protected store archive or cleanup.
  }
}

export async function runLiveAccountRecipe(rawInput, options = {}) {
  const input = validatePrivateInput(rawInput), environment = { ...process.env };
  assertCiAdmission(environment);
  const harness = await loadVerifiedHarness(environment), jar = new CookieJar(input.browserCookieHeader);
  const enrolled = await nativePhase('enroll', harness, input, jar, environment);
  const reopened = await nativePhase('reopen', harness, input, jar, environment, enrolled);
  if (typeof options.privateContinuationSink === 'function') await options.privateContinuationSink({ rootDir: enrolled.rootDir, browserCookieHeader: jar.header() });
  return sorted({ format: 'zentra-a41-native-account-report-v1', source: harness.source, binarySha256: harness.sha256,
    coordinatorSha256: await shaFile(fileURLToPath(import.meta.url)),
    rustHarnessSourceSha256: await shaFile(path.join(REPOSITORY, 'desktop/src-tauri/src/account_cloud_live_a41_tests.rs')),
    profileSha256: PROFILE_SHA256, siteOrigin: ORIGIN, ownerId: OWNER_ID, organizationId: ORGANIZATION_ID,
    phases: [enrolled.publicPhase, reopened.publicPhase], sameExecutableBothPhases: true, separateNativeProcesses: true,
    protectedStateReopened: true, browserApprovals: 2, nativeExecuted: true, stripePaidTestValidated: false,
    actionEngineExecuted: false, serverSourceDirectlyAttested: false, automaticCleanup: false });
}

export const DESCRIPTION = Object.freeze({ inactiveByDefault: true, context: 'live-sandbox-a41', profileSha256: PROFILE_SHA256,
  requiredPrivateInputKeys: ['format', 'sitesServiceToken', 'browserCookieHeader', 'expectedOwnerId', 'expectedOrganizationId'],
  privateInputFormat: 'zentra-a41-native-account-input-v1', expectedOwnerId: OWNER_ID, expectedOrganizationId: ORGANIZATION_ID,
  requiredDedicatedCiFlag: 'ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY=true',
  requiredExplicitCiFlag: 'ZENTRA_RUN_LIVE_ACCOUNT_RECIPE=true', existingCompileProofDirectory: 'desktop/artifacts/action-live-profile',
  exactTests: TESTS, secretTransport: 'private stdin and challenged Windows duplex pipe; never stdout',
  output: 'closed public JSON report only', createsCloudResources: false, automaticCleanup: false });

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--describe')) { process.stdout.write(JSON.stringify(DESCRIPTION) + '\n'); return; }
  need(args.length === 1 && args[0] === '--run', 'explicit_run_required');
  assertCiAdmission({ ...process.env }); need(!process.stdin.isTTY, 'private_stdin_pipe_required');
  const stat = fs.fstatSync(0); need(stat.isFIFO() || stat.isSocket() || (stat.mode & 0o170000) === 0o010000, 'private_stdin_pipe_required');
  const parts = []; let size = 0;
  const inputDeadline = setTimeout(() => process.stdin.destroy(new RecipeFailure('private_stdin_timeout')), 30000);
  try {
    for await (const chunk of process.stdin) { size += chunk.length; need(size <= MAX_MESSAGE, 'private_input_size_refused'); parts.push(chunk); }
  } finally { clearTimeout(inputDeadline); }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  const input = parsePrivateJson(text.endsWith('\n') ? text.slice(0, -1) : text);
  process.stdout.write(JSON.stringify(await runLiveAccountRecipe(input)) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(JSON.stringify({ passed: false, code: error instanceof RecipeFailure ? error.code : 'live_account_recipe_failed' }) + '\n'); process.exitCode = 1; });
}
