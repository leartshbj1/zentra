#!/usr/bin/env node
/**
 * External CDP proof for the exact Windows 1.90.9 package. Node >= 22, no deps.
 * The parent owns the isolated synthetic profile, process lifecycle and a hard
 * watchdog. No business writes, authentication, licence changes or IPC mocks.
 *
 * node desktop/scripts/windows-volume-collector.mjs \
 *   --endpoint http://127.0.0.1:9387 --profile C:/temporary/profile \
 *   --version 1.90.9 --output C:/temporary/run-1.json \
 *   --started-epoch-ms 1789999400000 --deadline-epoch-ms 1790000000000
 *
 * Exit 0 means the whole measurement completed. Exit 2 means CDP was unavailable
 * (status=not_measured), or IPC completed but access to UI was blocked (partial).
 * Other failures exit 1 and retain any partial evidence.
 * A timed-out native operation is NOT cancelled by CDP: parent must kill its
 * owned application process tree. Never interpret a partial result as a pass.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const TARGET_URL = 'http://tauri.localhost/';
const COMPANY = 'Atelier Volume 1909 - FICTIF';
const CALL_LIMIT_MS = 90_000;
const DISCOVERY_LIMIT_MS = 15_000;
const SCREENS = [
  { id: 'dashboard', name: 'Accueil', labels: ['Tableau de bord', 'Accueil'] },
  { id: 'quotes', name: 'Ventes', labels: ['Ventes'] },
  { id: 'clients', name: 'Clients', labels: ['Clients'] },
  { id: 'accounting', name: 'Comptabilité', labels: ['Comptabilité'] },
];

export function normalizeWindowsPath(value) {
  return String(value).replaceAll('/', '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase();
}

export function parseArguments(argv) {
  const allowed = new Set(['endpoint', 'profile', 'version', 'output', 'started-epoch-ms', 'deadline-epoch-ms']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    assert.ok(argv[i]?.startsWith('--') && allowed.has(key), `Unknown argument: ${argv[i]}`);
    assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for ${argv[i]}`);
    assert.ok(!Object.hasOwn(args, key), `Duplicate argument: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  for (const key of allowed) assert.ok(args[key], `Missing --${key}`);
  const endpoint = new URL(args.endpoint);
  assert.equal(endpoint.protocol, 'http:', 'CDP must use local HTTP');
  assert.equal(endpoint.hostname, '127.0.0.1', 'CDP endpoint must be explicit IPv4 loopback');
  assert.ok(endpoint.port && Number(endpoint.port) > 0, 'CDP needs an explicit port');
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Invalid CDP endpoint');
  assert.ok(endpoint.pathname === '/', 'CDP endpoint must be an origin');
  assert.ok(path.isAbsolute(args.profile), 'Profile must be absolute');
  assert.ok(path.isAbsolute(args.output), 'Output must be absolute');
  assert.equal(args.version, '1.90.9', 'This collector validates release 1.90.9 only');
  const deadline = Number(args['deadline-epoch-ms']);
  assert.ok(Number.isSafeInteger(deadline) && deadline > 0, 'Invalid absolute deadline');
  const started = Number(args['started-epoch-ms']);
  assert.ok(Number.isSafeInteger(started) && started > 0 && started < deadline && started <= Date.now(), 'Invalid process start time');
  return { endpoint: endpoint.origin, profile: args.profile, version: args.version, output: args.output, deadline, started };
}

export function validateFixture(marker) {
  assert.equal(marker.synthetic, true, 'A synthetic fixture marker is required');
  assert.equal(marker.accountOrLicenseAdded, false, 'Fixture must have no account or added licence');
  assert.equal(marker.companyName, COMPANY, 'Unexpected fixture company');
  for (const table of ['invoices', 'quotes']) assert.equal(marker.counts?.[table], 5000, `Unexpected ${table} count`);
  for (const table of ['invoice_items', 'quote_items']) assert.equal(marker.counts?.[table], 40000, `Unexpected ${table} count`);
}

export function validateWorkspace(result) {
  assert.equal(result.profileVerified, true, 'Native profile ownership was not verified');
  assert.equal(result.versionVerified, true, 'Native version was not verified');
  assert.equal(result.syntheticCompanyVerified, true, 'Native company differs from synthetic fixture');
  assert.equal(result.journalEntriesAbsent, true, 'get_workspace still includes journal_entries');
  assert.equal(result.journalLinesAbsent, true, 'get_workspace still includes journal_lines');
  for (const table of ['invoices', 'quotes']) assert.equal(result.counts?.[table], 5000, `Unexpected native ${table} count`);
  for (const table of ['invoice_items', 'quote_items']) assert.equal(result.counts?.[table], 40000, `Unexpected native ${table} count`);
  assert.ok(result.counts.clients > 0, 'Synthetic clients are missing');
  assert.ok(Number.isFinite(result.ipcMs) && result.ipcMs >= 0, 'Invalid IPC timing');
  assert.ok(Number.isSafeInteger(result.jsonBytes) && result.jsonBytes > 0, 'Missing payload byte count');
  assert.match(result.sha256, /^[a-f0-9]{64}$/, 'Missing SHA256 digest');
}

export function collectionOutcome(error, proof) {
  if (error.code === 'CDP_UNAVAILABLE') return { status: 'not_measured', measured: false, ipcMeasured: false, uiMeasured: false, exitCode: 2 };
  if (error.code === 'UI_UNAVAILABLE' && proof.ipcMeasured && !proof.errors.length && !proof.unresolvedCommands.length) {
    return { status: 'partial', measured: false, ipcMeasured: true, uiMeasured: false, exitCode: 2 };
  }
  return { status: 'failed', measured: false, ipcMeasured: Boolean(proof.ipcMeasured), uiMeasured: Boolean(proof.uiMeasured), exitCode: 1 };
}

function uiUnavailable(reason) {
  const error = new Error(reason);
  error.code = 'UI_UNAVAILABLE';
  return error;
}

function browserSource(fn, arg) {
  return `(${fn.toString()})(${JSON.stringify(arg)})`;
}

// This function executes inside the native WebView, never in a mock browser.
export async function readNative(arg) {
  if (location.href !== arg.url) throw new Error('Unexpected native page URL');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') throw new Error('Native Tauri IPC unavailable');
  const state = await invoke('get_app_state');
  const normalize = value => String(value).replaceAll('/', '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase();
  if (normalize(state.data_dir) !== arg.profile) throw new Error('Native profile ownership mismatch');
  if (state.app_version !== arg.version) throw new Error('Native package version mismatch');
  if (!arg.workspace) return { profileVerified: true, versionVerified: true, version: state.app_version };
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const data = await invoke('get_workspace');
  const ipcMs = performance.now() - start;
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  if (!crypto.subtle) throw new Error('WebView SHA256 is unavailable');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    startedAt, completedAt: new Date().toISOString(), ipcMs,
    profileVerified: true, versionVerified: true,
    syntheticCompanyVerified: data.settings?.company_name === arg.company,
    journalEntriesAbsent: !Object.hasOwn(data, 'journal_entries'),
    journalLinesAbsent: !Object.hasOwn(data, 'journal_lines'),
    counts: Object.fromEntries(Object.entries(data).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    jsonBytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
  };
}

function installPerformance() {
  if (location.href !== 'http://tauri.localhost/') return;
  const proof = { timeOrigin: performance.timeOrigin, installedAt: performance.now(), longTasks: [], longTaskSupported: false, droppedLongTasks: 0 };
  Object.defineProperty(window, '__zentraVolumeProof', { value: proof, configurable: true });
  if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    proof.longTaskSupported = true;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (proof.longTasks.length < 2000) proof.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        else proof.droppedLongTasks++;
      }
    }).observe({ type: 'longtask', buffered: true });
  }
}

function performanceSnapshot() {
  return {
    ...window.__zentraVolumeProof,
    observedAtMs: performance.now(),
    paint: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, startTime: entry.startTime })),
    memoryBytes: performance.memory?.usedJSHeapSize ?? null,
  };
}

// Content + busy/error state + two animation frames; a heading alone never passes.
export async function inspectScreen(arg) {
  if (location.href !== arg.url) throw new Error('Unexpected page URL during readiness check');
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const inspect = () => {
    const main = document.querySelector('main.app-main');
    const screen = main?.querySelector(`.page-content[data-screen="${arg.id}"]`);
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
    const licenceBannerVisible = visible(document.querySelector('.license-banner'));
    const accountGateVisible = visible(document.querySelector('main.company-account-opening'));
    const error = main?.querySelector('.error-panel, .notice--error, [role="alert"]');
    const busy = main?.querySelector('[aria-busy="true"]');
    const pendingText = [...(screen?.querySelectorAll('[role="status"]') ?? [])].some(node => /Chargement|Ouverture|Actualisation des écritures/u.test(node.textContent ?? ''));
    let contentCount = 0;
    if (arg.id === 'dashboard') contentCount = screen?.querySelectorAll('.dashboard-grid .metric-card strong').length ?? 0;
    if (arg.id === 'quotes') contentCount = screen?.querySelectorAll('.sales-documents--quotes tbody tr').length ?? 0;
    if (arg.id === 'clients') contentCount = screen?.querySelectorAll('.client-directory__list tbody tr, .client-mobile-list > li').length ?? 0;
    if (arg.id === 'accounting') contentCount = screen?.querySelectorAll('.finance-overview__figures[aria-busy="false"] article strong').length ?? 0;
    const ready = visible(screen) && !main?.inert && !busy && !pendingText && !error && !dialogs.length && contentCount > 0;
    const blocker = dialogs.length ? 'visible_modal' : accountGateVisible ? 'company_account_gate' : !main && licenceBannerVisible ? 'licence_activation_gate' : null;
    return { ready, screen: screen?.dataset.screen ?? null, contentCount, busy: Boolean(busy || pendingText), errorVisible: visible(error), dialogCount: dialogs.length, licenceBannerVisible, accountGateVisible, blocker };
  };
  const before = inspect();
  if (!before.ready) return before;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { ...inspect(), readyAtMs: performance.now(), timeOrigin: performance.timeOrigin, heading: document.querySelector('main h1')?.textContent?.trim() ?? null, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, viewport: { width: innerWidth, height: innerHeight }, nodes: document.querySelectorAll('*').length };
}

// Finds only the existing sidebar navigation controls, never arbitrary text.
function navigationTarget(arg) {
  if (location.href !== arg.url) throw new Error('Unexpected page URL during navigation');
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(node => node.getClientRects().length);
  if (dialogs.length) throw new Error('A modal blocks navigation; no licence/login bypass is permitted');
  const buttons = [...document.querySelectorAll('.sidebar__nav button')].filter(button => arg.labels.includes(button.querySelector('span')?.textContent?.trim()));
  if (buttons.length !== 1) throw new Error('Expected exactly one sidebar navigation button');
  const button = buttons[0];
  if (button.disabled || button.closest('[inert]')) throw new Error('Navigation control unavailable');
  button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const rect = button.getBoundingClientRect();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  if (rect.width <= 0 || rect.height <= 0 || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !button.contains(document.elementFromPoint(x, y))) throw new Error('Navigation control hidden or obstructed');
  return { x, y, label: button.querySelector('span').textContent.trim(), startedAtMs: performance.now(), timeOrigin: performance.timeOrigin };
}

export class CdpConnection {
  constructor(socket, deadline, proof) {
    this.socket = socket;
    this.deadline = deadline;
    this.proof = proof;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.events = new Set();
    this.eventFailures = [];
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { this.failAll(new Error('Malformed CDP message')); return; }
      if (message.id) {
        const item = this.pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(message.id);
        if (message.error) item.reject(new Error(`${item.method}: ${message.error.message}`));
        else item.resolve(message.result);
      } else {
        for (const handler of this.handlers.get(message.method) ?? []) {
          const task = Promise.resolve().then(() => handler(message.params));
          this.events.add(task);
          task.catch(error => this.eventFailures.push(String(error.message))).finally(() => this.events.delete(task));
        }
      }
    });
    socket.addEventListener('close', () => this.failAll(new Error('CDP socket closed')));
    socket.addEventListener('error', () => this.failAll(new Error('CDP socket error')));
  }
  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }
  failAll(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  send(method, params = {}, timeout = CALL_LIMIT_MS) {
    const ms = Math.min(timeout, this.deadline - Date.now());
    if (ms <= 0) return Promise.reject(new Error('Collector deadline exceeded'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.proof.unresolvedCommands.push(method);
        reject(new Error(`${method} timed out; parent must terminate the owned application`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(fn, arg, timeout = CALL_LIMIT_MS) {
    const response = await this.send('Runtime.evaluate', { expression: browserSource(fn, arg), returnByValue: true, awaitPromise: true, userGesture: false }, timeout);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'WebView evaluation failed');
    return response.result?.value;
  }
  async settleEvents() {
    while (this.events.size) await Promise.allSettled([...this.events]);
    assert.deepEqual(this.eventFailures, [], 'CDP event handling failed');
  }
  close() { this.socket.close(); }
}

async function discover(endpoint, deadline) {
  const until = Math.min(deadline, Date.now() + DISCOVERY_LIMIT_MS);
  let reason = 'CDP discovery timed out';
  while (Date.now() < until) {
    try {
      const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, until - Date.now()))), redirect: 'error' });
      assert.equal(response.ok, true, 'CDP discovery HTTP failure');
      const pages = (await response.json()).filter(target => target.type === 'page' && target.url === TARGET_URL);
      assert.ok(pages.length <= 1, 'Multiple exact native pages: refusing ambiguous ownership');
      if (pages.length === 1) {
        const socketUrl = new URL(pages[0].webSocketDebuggerUrl);
        assert.equal(socketUrl.protocol, 'ws:', 'Unexpected CDP socket protocol');
        assert.equal(socketUrl.hostname, '127.0.0.1', 'CDP socket escaped loopback');
        assert.equal(socketUrl.port, new URL(endpoint).port, 'CDP socket changed port');
        assert.ok(!socketUrl.username && !socketUrl.password, 'Invalid CDP socket credentials');
        const socket = new WebSocket(socketUrl);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, Math.max(1, until - Date.now()));
          socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
          socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
        });
        return socket;
      }
      reason = 'No exact http://tauri.localhost/ page exposed by CDP';
    } catch (error) {
      reason = error.message;
      if (/ambiguous|escaped|changed port|protocol|credentials/.test(reason)) throw error;
    }
    if (Date.now() < until) await delay(Math.min(250, until - Date.now()));
  }
  const error = new Error(reason);
  error.code = 'CDP_UNAVAILABLE';
  throw error;
}

async function blockExternalNetwork(cdp, proof) {
  await cdp.send('Network.enable');
  // Tauri assets and IPC are local HTTP; all HTTPS and websocket traffic is blocked.
  await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'wss://*', 'ws://*'] });
  cdp.on('Fetch.requestPaused', async event => {
    const requestUrl = new URL(event.request.url);
    if (requestUrl.protocol === 'http:' && ['tauri.localhost', 'ipc.localhost', 'asset.localhost'].includes(requestUrl.hostname) && !requestUrl.port && !requestUrl.username && !requestUrl.password) {
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId }, 5000);
    } else {
      proof.network.blockedRequests++;
      const origin = requestUrl.origin;
      if (!proof.network.blockedOrigins.includes(origin) && proof.network.blockedOrigins.length < 50) proof.network.blockedOrigins.push(origin);
      await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, 5000);
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*', requestStage: 'Request' }] });
  proof.network.rendererBlockingInstalled = true;
}

async function waitScreen(cdp, screen, deadline, afterTimeOrigin = null) {
  const until = Math.min(deadline, Date.now() + CALL_LIMIT_MS);
  let last = null;
  while (Date.now() < until) {
    try {
      last = await cdp.evaluate(inspectScreen, { id: screen.id, url: TARGET_URL }, until - Date.now());
      if (last.ready && (afterTimeOrigin === null || last.timeOrigin > afterTimeOrigin)) return last;
      if (last.errorVisible) throw new Error(`Screen ${screen.name} displays an error`);
      if (last.blocker) throw uiUnavailable(`Screen ${screen.name} is blocked by ${last.blocker}; no dismissal, authentication or licence bypass attempted`);
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
    }
    if (Date.now() < until) await delay(Math.min(100, until - Date.now()));
  }
  throw new Error(`Content readiness deadline for ${screen.name}: ${JSON.stringify(last)}`);
}

export async function collect(args) {
  const proof = {
    schemaVersion: 1, status: 'running', measured: false, ipcMeasured: false, uiMeasured: false, uiNotMeasuredReason: null,
    startedAt: new Date().toISOString(), completedAt: null,
    scope: 'Exact Windows 1.90.9 package; isolated deterministic synthetic company; local IPC and renderer only. No production capacity or cloud concurrency claim.',
    expectedVersion: args.version, expectedProfile: args.profile, deadlineEpochMs: args.deadline,
    nativeOwnership: null, syntheticFixtureVerified: false, startup: null,
    workspace: [], reload: null, navigation: [], errors: [], consoleErrors: [],
    unresolvedCommands: [], network: { rendererBlockingInstalled: false, blockedRequests: 0, blockedOrigins: [] },
    limitations: ['The parent must independently verify the package hash, own and terminate the app process tree, and compare SQLite business invariants before/after.', 'CDP blocking covers the attached renderer after connection; the parent separately contains Rust/background network.', 'Timings include observer and protocol overhead; screenshots contain only the verified synthetic profile.'],
  };
  mkdirSync(path.dirname(args.output), { recursive: true });
  writeFileSync(args.output, JSON.stringify(proof, null, 2), { flag: 'wx' });
  const save = () => writeFileSync(args.output, JSON.stringify(proof, null, 2));
  let cdp;
  let exitCode = 1;
  const watchdog = setTimeout(() => {
    proof.status = 'failed';
    proof.measured = false;
    proof.completedAt = new Date().toISOString();
    proof.errors.push('Absolute collector deadline reached; parent must terminate the owned application.');
    proof.unresolvedCommands.push(...(cdp ? [...cdp.pending.values()].map(item => item.method) : ['CDP discovery or setup']));
    save();
    process.exit(1);
  }, Math.max(1, args.deadline - Date.now()));
  try {
    assert.ok(typeof WebSocket === 'function', 'Node >= 22 with built-in WebSocket is required');
    assert.ok(args.deadline > Date.now(), 'Absolute deadline has already elapsed');
    const profile = realpathSync.native(args.profile);
    assert.ok(/^zentra-volume-1909-/i.test(path.basename(path.dirname(profile))), 'Refusing a profile outside the dedicated synthetic run directory');
    assert.equal(path.basename(profile), 'profile', 'Unexpected synthetic profile directory');
    const marker = JSON.parse(readFileSync(path.join(path.dirname(profile), 'fixture.json'), 'utf8').replace(/^\uFEFF/, ''));
    validateFixture(marker);
    proof.syntheticFixtureVerified = true;
    const nativeArgs = { url: TARGET_URL, profile: normalizeWindowsPath(profile), version: args.version, company: COMPANY, workspace: false };
    const socket = await discover(args.endpoint, args.deadline);
    cdp = new CdpConnection(socket, args.deadline, proof);
    cdp.on('Runtime.exceptionThrown', event => {
      if (proof.errors.length < 100) proof.errors.push({ phase: 'renderer', timestamp: event.timestamp, text: String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? 'Renderer exception').slice(0, 1500) });
    });
    cdp.on('Runtime.consoleAPICalled', event => {
      if (event.type === 'error' && proof.consoleErrors.length < 100) proof.consoleErrors.push({ timestamp: event.timestamp, argumentTypes: event.args?.map(arg => arg.type) ?? [], message: 'Console error occurred; business argument values are not copied.' });
    });
    await blockExternalNetwork(cdp, proof);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    proof.nativeOwnership = await cdp.evaluate(readNative, nativeArgs);
    await cdp.send('Page.bringToFront');
    const initialContent = await cdp.evaluate(inspectScreen, { id: SCREENS[0].id, url: TARGET_URL });
    proof.initialUi = initialContent;
    const recordStartup = (content, afterIpcReads) => {
      proof.startup = {
        processStartedAt: new Date(args.started).toISOString(), contentObservedAt: new Date().toISOString(),
        processToContentObservedMs: Date.now() - args.started,
        includesCollectorAttachmentAndOwnershipVerification: true, observedAfterMeasuredIpcReads: afterIpcReads,
        observationPollIntervalMs: 100, ...content,
      };
    };
    if (initialContent.ready) recordStartup(initialContent, false);
    save();
    for (let run = 1; run <= 3; run++) {
      const result = await cdp.evaluate(readNative, { ...nativeArgs, workspace: true });
      proof.workspace.push({ run, ...result });
      validateWorkspace(result);
      if (run > 1) assert.equal(result.sha256, proof.workspace[0].sha256, 'Workspace changed between sequential reads');
      save();
    }
    proof.ipcMeasured = true;
    save();
    // A licence/account modal must not prevent independent read-only IPC proof.
    // Recheck real DOM after the reads; never dismiss or authenticate through it.
    const accessibleContent = await waitScreen(cdp, SCREENS[0], args.deadline);
    if (!proof.startup) recordStartup(accessibleContent, true);
    // No modal is dismissed or licence changed. A blocking overlay is a limitation.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: browserSource(installPerformance, null) });
    const beforeReload = await cdp.evaluate(() => ({ timeOrigin: performance.timeOrigin }));
    const reloadStarted = Date.now();
    await cdp.send('Page.reload', { ignoreCache: false });
    const ready = await waitScreen(cdp, SCREENS[0], args.deadline, beforeReload.timeOrigin);
    await cdp.evaluate(readNative, nativeArgs);
    proof.reload = { startedAt: new Date(reloadStarted).toISOString(), completedAt: new Date().toISOString(), wallMs: Date.now() - reloadStarted, ...ready };
    proof.reload.performance = await cdp.evaluate(performanceSnapshot);
    save();
    for (const screen of SCREENS) {
      await cdp.evaluate(readNative, nativeArgs);
      const currentUi = await cdp.evaluate(inspectScreen, { id: screen.id, url: TARGET_URL });
      if (currentUi.blocker) throw uiUnavailable(`Navigation to ${screen.name} is blocked by ${currentUi.blocker}; no bypass attempted`);
      const start = await cdp.evaluate(navigationTarget, { ...screen, url: TARGET_URL });
      const startedAt = new Date().toISOString();
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y, button: 'left', clickCount: 1 });
      const content = await waitScreen(cdp, screen, args.deadline);
      assert.equal(content.timeOrigin, start.timeOrigin, 'Page navigated during screen measurement');
      assert.equal(content.horizontalOverflow, false, `${screen.name} has horizontal viewport overflow`);
      const result = { name: screen.name, actualNavigationLabel: start.label, startedAt, completedAt: new Date().toISOString(), ms: content.readyAtMs - start.startedAtMs, ...content };
      const screenshot = path.join(path.dirname(args.output), `${path.basename(args.output, path.extname(args.output))}-${screen.id}.png`);
      // Ownership is rechecked immediately before every synthetic screenshot.
      await cdp.evaluate(readNative, nativeArgs);
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      writeFileSync(screenshot, Buffer.from(capture.data, 'base64'), { flag: 'wx' });
      result.screenshot = screenshot;
      proof.navigation.push(result);
      save();
    }
    proof.performance = await cdp.evaluate(performanceSnapshot);
    assert.ok(proof.performance.timeOrigin, 'Reload instrumentation did not run');
    if (!proof.performance.longTaskSupported) proof.limitations.push('This WebView does not expose long-task observations.');
    if (!proof.performance.paint.length) proof.limitations.push('This WebView returned no paint entries.');
    await cdp.settleEvents();
    assert.deepEqual(proof.unresolvedCommands, [], 'An operation is unresolved');
    assert.deepEqual(proof.errors, [], 'Renderer exceptions were observed');
    if (proof.consoleErrors.length) proof.limitations.push('Renderer console errors were observed; external network is intentionally blocked. See consoleErrors; no console argument payloads were exported.');
    proof.status = 'passed';
    proof.measured = true;
    proof.uiMeasured = true;
    exitCode = 0;
  } catch (error) {
    const outcome = collectionOutcome(error, proof);
    exitCode = outcome.exitCode;
    const { exitCode: _, ...fields } = outcome;
    Object.assign(proof, fields);
    if (outcome.status === 'partial') {
      proof.uiNotMeasuredReason = String(error.message).slice(0, 2500);
      proof.limitations.push(proof.uiNotMeasuredReason);
    } else proof.errors.push(String(error.message).slice(0, 2500));
  } finally {
    if (cdp) {
      try { await cdp.settleEvents(); }
      catch (error) { proof.errors.push(String(error.message)); proof.status = 'failed'; proof.measured = false; exitCode = 1; }
      if (cdp.pending.size) { proof.unresolvedCommands.push(...[...cdp.pending.values()].map(item => item.method)); proof.status = 'failed'; proof.measured = false; exitCode = 1; }
      cdp.close();
    }
    clearTimeout(watchdog);
    proof.completedAt = new Date().toISOString();
    proof.durationMs = Date.parse(proof.completedAt) - Date.parse(proof.startedAt);
    save();
  }
  return { proof, exitCode };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { proof, exitCode } = await collect(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ status: proof.status, measured: proof.measured, ipcMeasured: proof.ipcMeasured, uiMeasured: proof.uiMeasured, workspaceCalls: proof.workspace.length, screens: proof.navigation.length, output: path.resolve(process.argv[process.argv.indexOf('--output') + 1]) }));
    // The parent owns the app watchdog. Exit also prevents a dead CDP socket
    // from keeping this already-finalized collector alive indefinitely.
    process.exit(exitCode);
  } catch (error) {
    console.error(String(error.message));
    process.exit(1);
  }
}
