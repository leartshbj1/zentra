/** Real App/Stock/SDK reads and isolated same-instance Form scope contract.
 * Optional: ZENTRA_NODE_PATH, ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH,
 * ZENTRA_QA_OUTPUT, ZENTRA_QA_SCENARIOS. No stock write/native DB is executed.
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
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-stock-refresh-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const pwPath = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(pwPath.startsWith('file:') ? pwPath : pathToFileURL(isAbsolute(pwPath) ? pwPath : require.resolve(pwPath)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const sources = ['src/App.tsx', 'src/CompanyAccountGate.tsx', 'src/WorkspaceApp.tsx', 'src/StockMovementForm.tsx', 'src/stockWorkflow.ts', 'src/bridge.ts', 'src/userErrors.ts', 'src/ErrorGuidance.tsx', 'tests/app-draft-identity-fixture.ts', 'tests/stock-refresh-lifecycle-fixture.ts', 'tests/stock-form-scope-fixture.tsx', 'scripts/test-stock-refresh-lifecycle.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name, sha(await readFile(join(desktop, name)))])));
const report = { startedAt: new Date().toISOString(), before: await hashes(), cases: [],
  limits: 'App read cases use real App/Gate/Stock/bridge/SDK with assembled synthetic SQLite snapshots and no writes. A foreign GET receipt proves frontend refusal only, not native DB acceptance. Same-instance A→B is an isolated React prop contract; ordinary App remounts on scope change. 390 px checks are browser layouts, not physical mobile tests.' };
const modes = (process.env.ZENTRA_QA_SCENARIOS || 'scope-refusal,ordinary-read-refusal,current-read,form-scope,form-readonly').split(',');
assert(modes.every(mode => ['scope-refusal', 'ordinary-read-refusal', 'current-read', 'form-scope', 'form-readonly'].includes(mode)), 'Unknown stock scenario');
const original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length, 2);
const injected = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + `
import {installStockRefreshFixture} from './stock-refresh-lifecycle-fixture';
export function installAppDraftIdentityFixture(workspace:Workspace){installStockRefreshFixture(workspace,installOriginalAppDraftIdentityFixture);}
`;
const virtual = join(desktop, '__stock-form-scope.tsx');
const standalone = "import {mountStockFormScopeFixture} from '/tests/stock-form-scope-fixture.tsx'; mountStockFormScopeFixture(document.getElementById('root')!);";
const probe = freePortServer(); await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port; await new Promise(ok => probe.close(ok)); assert.notEqual(port, 5363);
const origin = `http://127.0.0.1:${port}`;
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const server = await vite.createServer({ ...loaded.config, configFile: false, root: desktop,
  plugins: [{ name: 'closed-stock-lifecycle', enforce: 'pre',
    resolveId(id) { if (id === '/__stock-form-scope.tsx') return virtual; },
    load(id) { const path = id.replaceAll('\\', '/').split('?')[0]; if (path === virtual.replaceAll('\\', '/')) return standalone; if (path.endsWith('/tests/app-draft-identity-fixture.ts')) return injected; },
    configureServer(instance) { instance.middlewares.use('/__stock-form-scope.html', async (_request, response, next) => { try {
      response.setHeader('Content-Type', 'text/html');
      response.end(await instance.transformIndexHtml('/__stock-form-scope.html', '<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__stock-form-scope.tsx"></script></body></html>'));
    } catch (error) { next(error); } }); },
  }, ...loaded.config.plugins],
  cacheDir: join(tmpdir(), `zentra-stock-lifecycle-${port}`), resolve: { ...loaded.config.resolve, dedupe: ['react', 'react-dom'] },
  optimizeDeps: { entries: [join(desktop, 'tests/mobile-harness.html')], noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'qrcode.react', '@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs'] },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**'] } }, logLevel: 'silent' });
const titles = { fr: 'Entreprise ouverte à vérifier', de: 'Geöffnetes Unternehmen prüfen', it: 'Verifica l’azienda aperta', en: 'Check the open company' };
const messages = { fr: 'La demande ne correspond plus au compte ou à l’entreprise ouverte.', de: 'Diese Anfrage gehört nicht mehr zum geöffneten Konto oder Unternehmen.', it: 'La richiesta non corrisponde più al conto o all’azienda aperta.', en: 'This request no longer matches the open account or company.' };
const actions = { fr: 'Rouvrez cette action dans la bonne entreprise. Vérifiez ce qui est déjà enregistré avant de la recommencer.', de: 'Öffnen Sie diese Aktion im richtigen Unternehmen. Prüfen Sie vor einer Wiederholung, was bereits gespeichert wurde.', it: 'Riapri questa azione nell’azienda corretta. Prima di ripeterla, verifica cosa è già stato salvato.', en: 'Reopen this action in the correct company. Check what was already saved before repeating it.' };
const closeLabels = { fr: 'Fermer', de: 'Schliessen', it: 'Chiudi', en: 'Close' };
const snapshot = page => page.evaluate(() => {
  const alert = document.querySelector('.stock-workflow-alert[role=alert]');
  return { company: document.querySelector('.sidebar__company strong')?.textContent, visibleAlert: alert?.innerText, fullAlert: alert?.textContent, title: alert?.querySelector('strong')?.textContent,
    paragraphs: [...alert?.querySelectorAll(':scope > p') || []].map(node => node.textContent), buttons: [...alert?.querySelectorAll('button') || []].map(node => ({ text: node.textContent.trim(), disabled: node.disabled })),
    detailsOpen: !!alert?.querySelector('details')?.open, quantity: document.querySelector('.stock-workflow input[name=quantity]')?.value, reason: document.querySelector('.stock-workflow textarea[name=reason]')?.value,
    proof: structuredClone(window.__qaStockRefreshRead?.proof || window.__qaStockFormScope?.proof), db: window.__qaStockRefreshRead?.snapshot(), stockModal: !!document.querySelector('.stock-workflow-modal') };
});
async function language(page, value) { await page.evaluate(async value => { const { setAppLanguage } = await import('/src/language.ts'); await setAppLanguage(value); }, value); }
async function guide(page, value) {
  await language(page, value); await page.waitForFunction(title => document.querySelector('.stock-workflow-alert strong')?.textContent === title, titles[value]);
  const ui = await snapshot(page); assert.equal(ui.title, titles[value]); assert.deepEqual(ui.paragraphs, [messages[value], actions[value]]);
  assert(ui.visibleAlert.includes(messages[value]) && ui.visibleAlert.includes(actions[value])); assert(!ui.detailsOpen);
  assert(ui.buttons.some(button => button.text === closeLabels[value] && !button.disabled)); return ui;
}
async function mobileGuide(page, row) {
  await page.setViewportSize({ width: 390, height: 844 }); row.mobile = [];
  for (const value of ['fr', 'de']) {
    const ui = await guide(page, value);
    const button = page.locator('.stock-workflow-alert').getByRole('button', { name: closeLabels[value], exact: true });
    // The modal is scrollable and its footer is sticky. Centre the target through
    // ordinary scrolling, then use Playwright's real receive-events check (no force).
    await button.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await button.click({ trial: true });
    const geometry = await button.evaluate(node => {
      const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const overflow = ['html', '.stock-workflow-modal', '.stock-workflow', '.stock-workflow-alert'].map(selector => { const element = document.querySelector(selector); return { selector, client: element.clientWidth, scroll: element.scrollWidth }; });
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: innerWidth, viewportHeight: innerHeight, hittable: !!hit && (hit === node || node.contains(hit)), overflow };
    });
    row.mobile.push({ language: value, ui, geometry });
    assert(geometry.width >= 44 && geometry.height >= 44); assert(geometry.left >= 0 && geometry.right <= geometry.viewport); assert(geometry.hittable);
    assert(geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight);
    assert(geometry.overflow.every(element => element.scroll <= element.client + 1));
    await page.screenshot({ path: join(out, `${row.engine}-390-${value}.png`) });
  }
  await language(page, 'fr');
}
try {
  await server.listen(); report.origin = origin;
  for (const engine of ['chromium', 'webkit']) {
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? process.env.ZENTRA_EDGE_PATH ? { executablePath: process.env.ZENTRA_EDGE_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {} : {}) });
    try { for (const mode of modes) {
      const row = { engine, browserVersion: browser.version(), mode, errors: [], blocked: [], languages: [] }; report.cases.push(row);
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
      page.on('pageerror', error => row.errors.push(error.message));
      await page.route('**/*', route => { const request = route.request(), url = new URL(request.url()); if (url.origin === origin && request.method() === 'GET' && !/^\/api(?:\/|$)/.test(url.pathname)) return route.continue(); row.blocked.push(url.origin + url.pathname); return route.abort(); });
      try {
        if (mode.startsWith('form-')) {
          await page.goto(`${origin}/__stock-form-scope.html`); await page.locator('.stock-workflow-modal').waitFor();
          await page.locator('input[name=quantity]').fill('2,5'); await page.locator('textarea[name=reason]').fill('SYNTHETIC DRAFT KEPT');
          await page.getByRole('button', { name: 'Vérifier le mouvement', exact: true }).click(); await page.locator('.stock-workflow-review').waitFor();
          if (mode === 'form-scope') {
            await page.evaluate(() => window.__qaStockFormScope.switchScope()); await page.locator('.stock-workflow-review').waitFor({ state: 'detached' });
            row.after = await guide(page, 'fr'); assert.equal(row.after.quantity, '2,5'); assert.equal(row.after.reason, 'SYNTHETIC DRAFT KEPT');
            assert(await page.locator('input[name=quantity]').isDisabled()); assert(await page.getByRole('button', { name: 'Actualiser les quantités', exact: true }).isDisabled());
            for (const value of ['de', 'it', 'en']) row.languages.push({ language: value, ...await guide(page, value) }); await language(page, 'fr');
          } else { await page.evaluate(() => window.__qaStockFormScope.setReadOnly(true)); await page.waitForFunction(() => !!document.querySelector('.stock-workflow button[type=submit]')?.disabled); assert(await page.getByRole('button', { name: 'Enregistrer l’entrée', exact: true }).isDisabled()); }
          // Explicit synthetic submit probes the guard without pretending this is a reachable UI click.
          await page.evaluate(() => document.querySelector('form.stock-workflow').requestSubmit());
          row.after = await snapshot(page); assert.equal(row.after.proof.actions, 0); assert.equal(row.after.proof.reads, 0); assert.deepEqual(row.after.proof.native, []);
          if (mode === 'form-scope') { await page.locator('.stock-workflow-alert').getByRole('button', { name: 'Fermer', exact: true }).click(); await page.locator('.stock-workflow-modal').waitFor({ state: 'detached' }); assert(await page.getByText('FORM CLOSED EXPLICITLY').isVisible()); }
        } else {
          await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
          await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&stockGuided=1&appDraftIdentity=1`);
          await page.waitForFunction(() => window.__qaAppDraftIdentity?.proof.identityReads.some(read => read.pending));
          await page.evaluate(() => { const qa = window.__qaAppDraftIdentity; qa.identityMode('ready'); for (const read of qa.proof.identityReads.filter(read => read.pending)) qa.releaseIdentity(read.id); });
          await page.locator('.desktop-app').waitFor(); await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click(); await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Produits & services');
          await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Produits & services', { exact: true }) }).click(); await page.getByRole('button', { name: 'Entrée', exact: true }).first().click(); await page.locator('.stock-workflow-modal').waitFor();
          await page.locator('input[name=quantity]').fill('2,5'); await page.locator('textarea[name=reason]').fill('SYNTHETIC DRAFT KEPT');
          await page.evaluate(() => window.__qaStockRefreshRead.holdNext()); await page.getByRole('button', { name: 'Actualiser les quantités', exact: true }).click();
          await page.waitForFunction(() => window.__qaStockRefreshRead.proof.reads.some(read => read.pending)); row.held = await snapshot(page);
          const held = row.held.proof.reads.find(read => read.pending).id;
          await page.evaluate(({ held, mode }) => mode === 'scope-refusal' ? window.__qaStockRefreshRead.settleWrongWorkspace(held) : mode === 'ordinary-read-refusal' ? window.__qaStockRefreshRead.refuse(held) : window.__qaStockRefreshRead.settle(held), { held, mode });
          await page.waitForFunction(() => [...document.querySelectorAll('.stock-workflow button')].some(button => ['Actualiser les quantités', 'Fermer', 'Relire les quantités'].includes(button.textContent) && !button.disabled));
          if (mode !== 'current-read') await page.locator('.stock-workflow-alert').waitFor(); row.after = await snapshot(page);
          assert.equal(row.after.company, 'SYNTHETIC COMPANY A'); assert.equal(row.after.db.scope, 'synthetic-company-a'); assert.equal(row.after.quantity, '2,5'); assert.equal(row.after.reason, 'SYNTHETIC DRAFT KEPT');
          assert.equal(row.after.proof.reads.length, row.held.proof.reads.length); assert.equal(row.after.proof.writes.length, 0); assert.deepEqual(row.after.proof.blockedNative, []);
          if (mode === 'scope-refusal') {
            for (const value of ['fr', 'de', 'it', 'en']) row.languages.push({ language: value, ...await guide(page, value) }); await mobileGuide(page, row);
            await page.locator('.stock-workflow-alert').getByRole('button', { name: 'Fermer', exact: true }).click(); await page.locator('.stock-workflow-modal').waitFor({ state: 'detached' });
            const proof = await page.evaluate(() => structuredClone(window.__qaStockRefreshRead.proof)); assert.equal(proof.reads.length, row.held.proof.reads.length); assert.equal(proof.writes.length, 0);
          } else if (mode === 'ordinary-read-refusal') {
            assert.equal(row.after.title, 'Vérifions ce point'); assert(row.after.visibleAlert.includes('Votre saisie est conservée.')); assert(row.after.buttons.some(button => button.text === 'Relire les quantités' && !button.disabled)); assert(!row.after.buttons.some(button => button.text === 'Fermer'));
          } else assert.equal(row.after.title, undefined);
        }
        assert.deepEqual(row.errors, []); assert.deepEqual(row.blocked, []); row.passed = true;
      } catch (error) { row.failure = error.stack; row.last = await snapshot(page).catch(() => null); await page.screenshot({ path: join(out, `${engine}-${mode}-failure.png`) }).catch(() => {}); }
      finally { await page.close(); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); }
    } } finally { await browser.close(); }
  }
} finally {
  await server.close(); report.resourcesClosed = true; report.finishedAt = new Date().toISOString(); report.after = await hashes();
  report.changed = sources.filter(name => report.before[name] !== report.after[name]); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ cases: report.cases.length, passes: report.cases.filter(row => row.passed).length, failures: report.cases.filter(row => row.failure).map(row => row.failure), changed: report.changed, output: out }));
if (report.cases.some(row => row.failure) || report.changed.length) process.exitCode = 1;
