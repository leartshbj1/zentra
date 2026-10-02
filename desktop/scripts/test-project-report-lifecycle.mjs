/** Real App/Gate/Reports and SDK with closed synthetic transports; no PDF/native I/O.
 * Optional: ZENTRA_NODE_PATH, ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH,
 * ZENTRA_QA_OUTPUT, ZENTRA_QA_SCENARIOS (comma-separated), ZENTRA_QA_SDK_ONLY=1.
 * TAURI_ENV_PLATFORM=ios exercises the compile profile, not a physical device.
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
  const child = spawn(process.env.ZENTRA_NODE_PATH, [script, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ZENTRA_NODE_PATH: '' } });
  process.exit(await new Promise((ok, no) => { child.once('error', no); child.once('exit', code => ok(code ?? 1)); }));
}
const desktop = resolve(dirname(script), '..');
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-project-report-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const pwPath = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(pwPath.startsWith('file:') ? pwPath : pathToFileURL(isAbsolute(pwPath) ? pwPath : require.resolve(pwPath)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const sources = ['src/App.tsx', 'src/CompanyAccountGate.tsx', 'src/WorkspaceApp.tsx', 'src/ProjectReports.tsx', 'src/bridge.ts', 'src/diagnostics.ts', 'tests/app-draft-identity-fixture.ts', 'tests/project-report-lifecycle-fixture.ts', 'scripts/test-project-report-lifecycle.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name, sha(await readFile(join(desktop, name)))])));
const report = { startedAt: new Date().toISOString(), platform: process.env.TAURI_ENV_PLATFORM || 'desktop', before: await hashes(), cases: [],
  limits: 'Synthetic selector and renderer ACK only. Real App/Gate/provider/Reports/bridge/SDK are followed sources without product overlays. This does not prove native DB/filesystem acceptance, physical picker reachability or iOS delivery. API/external requests are blocked.' };
const sdkOnly = process.env.ZENTRA_QA_SDK_ONLY === '1';
const allowed = ['current', 'cancel', 'native-refused', 'share-refused', 'late-dialog', 'late-reception', 'late-native'];
const modes = (process.env.ZENTRA_QA_SCENARIOS || `current,cancel,native-refused,late-reception,late-native${report.platform === 'ios' ? ',share-refused' : ''}`).split(',');
assert(modes.every(mode => allowed.includes(mode)), 'Unknown report scenario');
const original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length, 2);
const injected = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + `
import { installReportAudit } from './project-report-lifecycle-fixture';
export function installAppDraftIdentityFixture(workspace: Workspace) { installReportAudit(workspace, installOriginalAppDraftIdentityFixture); }
`;
const sdkEntry = "import {installReportSdkContract} from '/tests/project-report-lifecycle-fixture.ts'; installReportSdkContract();";
const probe = freePortServer(); await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port; await new Promise(ok => probe.close(ok)); assert.notEqual(port, 5363);
const origin = `http://127.0.0.1:${port}`;
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const virtual = join(desktop, '__report-sdk.ts');
const server = await vite.createServer({ ...loaded.config, configFile: false, root: desktop,
  plugins: [{ name: 'closed-report-lifecycle', enforce: 'pre',
    resolveId(id) { if (id === '/__report-sdk.ts') return virtual; },
    load(id) { const path = id.replaceAll('\\', '/').split('?')[0]; if (path === virtual.replaceAll('\\', '/')) return sdkEntry; if (path.endsWith('/tests/app-draft-identity-fixture.ts')) return injected; },
    configureServer(instance) { instance.middlewares.use('/__report-sdk.html', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body><script type="module" src="/__report-sdk.ts"></script></body></html>'); }); },
  }, ...loaded.config.plugins],
  cacheDir: join(tmpdir(), `zentra-report-lifecycle-${port}`), resolve: { ...loaded.config.resolve, dedupe: ['react', 'react-dom'] },
  optimizeDeps: { entries: [join(desktop, 'tests/mobile-harness.html')], noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'qrcode.react', '@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs'] },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**'] } }, logLevel: 'silent' });

async function screen(page, label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
}
async function closedPage(browser, row) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000); page.on('pageerror', error => row.errors.push(error.message));
  await page.route('**/*', route => { const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && request.method() === 'GET' && !/^\/api(?:\/|$)/.test(url.pathname)) return route.continue();
    row.blocked.push({ method: request.method(), origin: url.origin, pathname: url.pathname }); return route.abort(); });
  return page;
}
function safeEvents(events, terminal) {
  assert.deepEqual(events.map(event => event.phase), ['start', terminal]); assert.equal(events[0].id, events[1].id);
  for (const token of ['SYNTHETIC REPORT', 'synthetic-company', 'Zentra-Synthetic', 'PRIVATE-SYNTHETIC']) assert(!JSON.stringify(events).includes(token));
}
try {
  await server.listen(); report.origin = origin;
  for (const engine of ['chromium', 'webkit']) {
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? process.env.ZENTRA_EDGE_PATH ? { executablePath: process.env.ZENTRA_EDGE_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {} : {}) });
    try {
      for (const mode of sdkOnly ? ['legacy', 'scoped', 'object-rejection', 'string-rejection'] : modes) {
        const row = { engine, browserVersion: browser.version(), mode, errors: [], blocked: [] }; report.cases.push(row);
        const page = await closedPage(browser, row);
        try {
          if (sdkOnly) {
            await page.goto(`${origin}/__report-sdk.html`); await page.waitForFunction(() => !!window.__qaReportSdk);
            row.after = await page.evaluate(mode => window.__qaReportSdk(mode), mode);
            const result = row.after, exports = result.calls.filter(call => call.command === 'export_project_report_pdf');
            assert.equal(exports.length, 1); assert.equal(exports[0].sameReport, true); assert.equal(exports[0].arity, 3); // Real Tauri SDK always forwards options, including undefined.
            assert.deepEqual(exports[0].keys, mode === 'legacy' ? ['report', 'destinationPath'] : ['report', 'destinationPath', 'expectedWorkspaceScope']);
            assert.equal(exports[0].scope, mode === 'legacy' ? undefined : 'PRIVATE-SYNTHETIC-SCOPE');
            if (mode.includes('rejection')) { assert(result.rejected); assert(result.sameReason); assert(result.incident.code.startsWith('ZT-')); }
            else assert.deepEqual(result.result, { path: 'C:/PRIVATE-SYNTHETIC/report.pdf', pages: 2 });
            safeEvents(result.events, mode.includes('rejection') ? 'failure' : 'success');
          } else {
            await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
            await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1`);
            await page.waitForFunction(() => window.__qaAppDraftIdentity?.proof.identityReads.some(read => read.pending));
            await page.evaluate(() => { const qa = window.__qaAppDraftIdentity; qa.identityMode('ready'); for (const read of qa.proof.identityReads.filter(read => read.pending)) qa.releaseIdentity(read.id); });
            await page.locator('.desktop-app').waitFor(); await screen(page, 'Rapports');
            await page.getByText('SYNTHETIC REPORT A', { exact: true }).first().waitFor();
            await page.evaluate(mode => window.__qaReportsAudit.mode(mode), mode);
            await page.getByRole('button', { name: 'Exporter le PDF', exact: true }).click();
            await page.waitForFunction(() => window.__qaReportsAudit.proof.dialogs.length === 1);
            if (['current', 'cancel', 'native-refused', 'share-refused'].includes(mode)) {
              await page.waitForFunction(() => window.__qaReportsAudit.proof.results.length + window.__qaReportsAudit.proof.rejects.length === 1);
              await page.getByRole('button', { name: 'Exporter le PDF', exact: true }).waitFor();
              row.after = await page.evaluate(() => window.__qaReportsAudit.state());
              if (mode === 'cancel') { assert.equal(row.after.proof.exports.length, 0); assert.deepEqual(row.after.proof.results, [null]); assert.equal(row.after.proof.shares.length, 0); }
              else { assert.equal(row.after.proof.exports.length, 1); assert.equal(row.after.proof.exports[0].expectedScope, 'synthetic-company-a');
                assert(row.after.reports.includes(mode === 'native-refused' ? 'Accès refusé : le dossier choisi ne permet pas cet export.' : mode === 'share-refused' ? 'Le PDF a été créé, mais le partage' : 'Le PDF a été enregistré.')); }
              safeEvents(row.after.diagnostics, mode === 'native-refused' ? 'failure' : 'success');
            } else {
              if (mode === 'late-native') await page.waitForFunction(() => window.__qaReportsAudit.proof.exports.length === 1);
              row.held = await page.evaluate(() => window.__qaReportsAudit.state());
              if (mode === 'late-reception') {
                row.reception = await page.evaluate(() => window.__qaReportsAudit.receiveSameOrganization());
                await page.waitForFunction(() => window.__qaAppDraftIdentity.proof.identityReads.length >= 2);
                await page.locator('.desktop-app').waitFor(); assert.equal(await page.locator('.project-reports').count(), 0);
              } else {
                await page.evaluate(() => window.__qaReportsAudit.switchVerifiedAccount());
                await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).click();
                await page.locator('.desktop-app').waitFor(); await screen(page, 'Clients');
                await page.getByText('Client fictif B', { exact: true }).first().waitFor();
              }
              await page.evaluate(mode => mode === 'late-native' ? window.__qaReportsAudit.releaseNative() : window.__qaReportsAudit.releaseDialog(), mode);
              await page.waitForFunction(() => window.__qaReportsAudit.proof.results.length + window.__qaReportsAudit.proof.rejects.length === 1);
              row.after = await page.evaluate(() => window.__qaReportsAudit.state()); assert.equal(row.after.scope, 'synthetic-company-b'); assert.equal(row.after.proof.shares.length, 0);
              if (mode === 'late-native') { assert.equal(row.after.proof.exports.length, 1); assert.equal(row.after.proof.results[0].path, 'C:/Zentra-Synthetic/report.pdf'); safeEvents(row.after.diagnostics, 'success'); }
              else { assert.equal(row.after.proof.exports.length, 0); assert.equal(row.after.proof.rejects.length, 1); safeEvents(row.after.diagnostics, 'failure'); assert.equal(row.after.diagnostics[1].errorCode, 'CONFLICT'); }
            }
          }
          assert.deepEqual(row.errors, []); assert.deepEqual(row.blocked, []); row.passed = true;
        } catch (error) { row.failure = error.stack; row.last = await page.evaluate(() => window.__qaReportsAudit?.state()).catch(() => null); }
        finally { await page.close(); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); }
      }
    } finally { await browser.close(); }
  }
} finally {
  await server.close(); report.resourcesClosed = true; report.finishedAt = new Date().toISOString(); report.after = await hashes();
  report.changed = sources.filter(name => report.before[name] !== report.after[name]);
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ cases: report.cases.length, passes: report.cases.filter(row => row.passed).length, failures: report.cases.filter(row => row.failure), changed: report.changed, output: out }));
if (report.cases.some(row => row.failure) || report.changed.length) process.exitCode = 1;
