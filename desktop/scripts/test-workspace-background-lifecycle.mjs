/** Actual App/React DOM background-scan regression with closed synthetic transports.
 * Runtime: ZENTRA_NODE_PATH, ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH.
 * Output: ZENTRA_QA_OUTPUT; optional screenshots: ZENTRA_QA_SCREENSHOTS=1.
 * No installed binary, real account, API, DB, email or user data is used.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const script = fileURLToPath(import.meta.url);
if (process.env.ZENTRA_NODE_PATH && resolve(process.env.ZENTRA_NODE_PATH).toLowerCase() !== resolve(process.execPath).toLowerCase()) {
  const child = spawn(process.env.ZENTRA_NODE_PATH, [script], { stdio: 'inherit', env: { ...process.env, ZENTRA_NODE_PATH: '' } });
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', value => yes(value ?? 1)); });
  process.exit(code);
}
const desktop = resolve(dirname(script), '..');
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-workspace-background-lifecycle-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const playwrightModule = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(playwrightModule.startsWith('file:') ? playwrightModule : pathToFileURL(isAbsolute(playwrightModule) ? playwrightModule : require.resolve(playwrightModule)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceNames = [
  'src/App.tsx', 'src/WorkspaceApp.tsx', 'src/CompanyAccountGate.tsx', 'src/useWorkspaceRecovery.ts',
  'src/bridge.ts', 'src/recurrenceUi.ts', 'src/recurrenceCalendar.ts', 'src/remindersUi.ts', 'src/workspaceMutation.ts',
  'tests/mobile-harness.tsx', 'tests/app-draft-identity-fixture.ts', 'tests/workspace-background-lifecycle-fixture.ts',
];
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha(await readFile(join(desktop, name)))])));
const scenarios = ['reminder-settings', 'reminder-settings-failure', 'reminder-result', 'reminder-focus-control', 'recurrence-late-success', 'recurrence-late-failure', 'recurrence-layout-window', 'recurrence-fallback-success', 'recurrence-fallback-failure'];
const report = {
  startedAt: new Date().toISOString(), node: { version: process.version, executable: process.execPath },
  before: await hashes(), runnerSha256: sha(await readFile(script)), cases: [],
  contract: 'Actual App/CompanyAccountGate/WorkspaceApp/React StrictMode and actual bridge/diagnosticInvoke/SDK, never extracted callbacks. Held old responses must not start scans or replace B. Current origin scope, date and request UUID contract is retained; no mutation is replayed. First committed read failure plus a held fallback must not create recovery after cleanup.',
  limits: 'Native replies and locally replaced already-verified A/B sessions are synthetic. The real choose_remote/open button is used. Frontend emission/publication is tested, not native DB acceptance, email, physical devices or real session exchange. All non-static/API/external requests are blocked.',
};
const original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length, 2, 'Expected account fixture entry point');
const fixture = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + `
import { installWorkspaceBackgroundLifecycleFixture } from './workspace-background-lifecycle-fixture';
export function installAppDraftIdentityFixture(workspace: Workspace) {
  installWorkspaceBackgroundLifecycleFixture(workspace, installOriginalAppDraftIdentityFixture);
}
`;
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const probe = freePortServer(); await new Promise(ok => probe.listen(0, '127.0.0.1', ok)); const port = probe.address().port; await new Promise(ok => probe.close(ok));
assert.notEqual(port, 5363); const origin = `http://127.0.0.1:${port}`;
const server = await vite.createServer({ ...loaded.config, configFile: false, root: desktop,
  plugins: [{ name: 'closed-background-scans', enforce: 'pre', load(id) { if (id.replaceAll('\\', '/').split('?')[0].endsWith('/tests/app-draft-identity-fixture.ts')) return fixture; } }, ...loaded.config.plugins],
  cacheDir: join(tmpdir(), `zentra-workspace-background-lifecycle-${port}`), resolve: { ...loaded.config.resolve, dedupe: ['react', 'react-dom'] },
  optimizeDeps: { entries: [join(desktop, 'tests/mobile-harness.html')], noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'qrcode.react', '@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs'] },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**'] } }, logLevel: 'silent' });
async function screen(page, label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}
async function snapshot(page) { return page.evaluate(() => ({ proof: structuredClone(window.__qaScan.proof), database: window.__qaScan.database(), desktopVisible: !!document.querySelector('.desktop-app'), visibleB: document.body.textContent.includes('Client fictif B'), notices: [...document.querySelectorAll('.notice')].map(node => node.textContent), dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => node.textContent.slice(0, 180)) })); }
try {
  await server.listen(); report.origin = origin;
  for (const engine of ['chromium', 'webkit']) {
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? process.env.ZENTRA_EDGE_PATH ? { executablePath: process.env.ZENTRA_EDGE_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {} : {}) });
    try { for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
      const item = { engine, browserVersion: browser.version(), scenario, errors: [], blockedRequests: [] }; report.cases.push(item);
      page.on('pageerror', error => item.errors.push(error.message));
      await page.route('**/*', route => { const request = route.request(), url = new URL(request.url()); if (url.origin === origin && request.method() === 'GET' && !/^\/api(?:\/|$)/.test(url.pathname)) return route.continue(); item.blockedRequests.push({ method: request.method(), pathname: url.pathname, origin: url.origin }); return route.abort(); });
      await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1&scanProbe=${scenario}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__qaAppDraftIdentity?.proof.identityReads.some(read => read.pending));
      await page.evaluate(() => { window.__qaAppDraftIdentity.identityMode('ready'); for (const read of window.__qaAppDraftIdentity.proof.identityReads.filter(read => read.pending)) window.__qaAppDraftIdentity.releaseIdentity(read.id); });
      await page.locator('.desktop-app').waitFor();
      const kind = scenario.startsWith('recurrence') ? 'workspace-A' : scenario === 'reminder-result' ? 'scan-A' : 'settings-A';
      await page.waitForFunction(kind => window.__qaScan.pending(kind).length === 1, kind);
      const held = await page.evaluate(kind => window.__qaScan.pending(kind)[0], kind);
      await page.evaluate(() => { for (let i = 0; i < 6; i++) window.dispatchEvent(new Event('focus')); });
      item.initial = await snapshot(page);
      const scanCommand = scenario.startsWith('recurrence') ? 'generate_recurrence_occurrences' : 'scan_due_reminders';
      if (!scenario.startsWith('recurrence')) assert.equal(item.initial.proof.calls.filter(call => call.command === 'get_reminder_settings' && call.scopeAtCall === 'synthetic-company-a').length, 1, 'StrictMode/focus burst must remain one held reminder flight');
      else assert.equal(item.initial.proof.calls.filter(call => call.command === scanCommand).length, 1, 'StrictMode/focus burst must remain one held recurrence flight');
      if (scenario.startsWith('recurrence-fallback')) assert.equal(item.initial.proof.calls.filter(call => call.command === 'get_workspace').length, 2, 'One failed committed read then one held read-only fallback');
      if (scenario === 'reminder-focus-control') {
        await page.evaluate(id => window.__qaScan.settle(id), held);
        await page.waitForFunction(() => window.__qaScan.proof.calls.some(call => call.command === 'scan_due_reminders'));
        item.after = await snapshot(page);
        assert.equal(item.after.proof.calls.filter(call => call.command === scanCommand).length, 1); item.controlPassed = true;
      } else {
        if (scenario === 'recurrence-layout-window') await page.evaluate(id => window.__qaScan.releaseAtUnmount(id), held);
        await page.evaluate(() => window.__qaScan.switchVerifiedAccount());
        await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).waitFor();
        if (scenario === 'recurrence-layout-window') { await page.waitForTimeout(200); item.atLayoutWindow = await snapshot(page); }
        await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).click();
        await page.locator('.desktop-app').waitFor(); await screen(page, 'Clients'); await page.getByText('Client fictif B', { exact: true }).first().waitFor();
        item.beforeRelease = await snapshot(page); assert.equal(item.beforeRelease.database.scope, 'synthetic-company-b');
        if (scenario !== 'recurrence-layout-window') await page.evaluate(({ id, failure }) => window.__qaScan.settle(id, failure), { id: held, failure: scenario.endsWith('failure') });
        await page.waitForTimeout(200); item.after = await snapshot(page);
        assert.equal(item.after.visibleB, true); assert.equal(item.after.database.scope, 'synthetic-company-b'); assert.deepEqual(item.after.dialogs, []);
        const calls = item.after.proof.calls.filter(call => call.command === scanCommand);
        if (scenario === 'reminder-settings') {
          assert.equal(calls.length, 0); item.controlPassed = true; item.fact = 'Old A enabled setting is ignored after B admission; no scan SDK command is emitted.';
        } else if (scenario === 'recurrence-layout-window') {
          item.detachedCommands = calls.filter(call => !call.appVisible); assert.deepEqual(item.detachedCommands, [], 'No second recurrence after layout cleanup'); item.controlPassed = true; item.defectReproduced = false;
          item.fact = item.defectReproduced ? 'Actual second recurrence SDK command is emitted in the observed layout-unmount/passive-cleanup window.' : 'No second detached recurrence command observed in this React timing window.';
        } else {
          assert.equal(calls.length, scenario === 'reminder-settings-failure' ? 0 : 1);
          if (scenario.startsWith('recurrence-fallback')) assert.equal(item.after.proof.calls.filter(call => call.command === 'get_workspace').length, 2, 'No further fallback read after cleanup');
          assert.deepEqual(item.after.notices, []); item.controlPassed = true;
        }
        if (process.env.ZENTRA_QA_SCREENSHOTS === '1') await page.screenshot({ path: join(out, `${engine}-${scenario}.png`) });
      }
      for (const call of item.after.proof.calls.filter(call => call.command === scanCommand)) {
        const request = call.args.input;
        assert.match(request.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        assert.match(request.as_of ?? request.through_date, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(call.args.expectedWorkspaceScope, 'synthetic-company-a');
      }
      for (const call of item.after.proof.calls.filter(call => call.command === 'get_reminder_settings')) assert.equal(call.args.expectedWorkspaceScope, call.scopeAtCall);
      assert.deepEqual(item.errors, []); assert.deepEqual(item.blockedRequests, []); item.completed = true;
      console.log(JSON.stringify({ engine, scenario, reproduced: item.defectReproduced ?? false, control: item.controlPassed ?? false, detachedCommands: item.detachedCommands?.length })); await page.close();
    } } finally { await browser.close(); }
  }
  report.after = await hashes();
  assert.deepEqual(report.after, report.before, 'Source bytes unchanged while testing');
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await server.close(); report.previewClosed = true; report.finishedAt = new Date().toISOString(); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ cases: report.cases.length, reproduced: report.cases.filter(item => item.defectReproduced).length, failure: report.failure ?? null, previewClosed: true })); }
