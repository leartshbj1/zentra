/** Real App/React DOM regression with synthetic, closed account/business dependencies.
 * Run using the desired Node executable, or set ZENTRA_NODE_PATH. Optional paths:
 * ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH; output: ZENTRA_QA_OUTPUT.
 * No installed app, OS clipboard, account, network API or user data is used.
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
  const exitCode = await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => yes(code ?? 1)); });
  process.exit(exitCode);
}
const desktop = resolve(dirname(script), '..');
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-settings-action-lifecycle-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const playwrightModule = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(playwrightModule.startsWith('file:') ? playwrightModule : pathToFileURL(isAbsolute(playwrightModule) ? playwrightModule : require.resolve(playwrightModule)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const scenarios = ['late-success', 'late-catch-read', 'late-first-read-rejection', 'late-fallback-rejection', 'same-space-navigation', 'read-only-after-commit', 'ordinary-recovery-control', 'ordinary-success-control', 'foreign-fallback-read', 'foreign-retry-read', 'explicit-restore-control', 'explicit-restore-recovery-control'];
const requested = process.env.ZENTRA_QA_SCENARIOS ? process.env.ZENTRA_QA_SCENARIOS.split(',') : undefined;
if (requested) assert.ok(requested.every(scenario => scenarios.includes(scenario)), 'Unknown closed-fixture scenario');
const engines = process.env.ZENTRA_QA_ENGINES ? process.env.ZENTRA_QA_ENGINES.split(',') : ['chromium', 'webkit'];
assert.ok(engines.every(engine => ['chromium', 'webkit'].includes(engine)), 'Unknown browser engine');
const sourceNames = [
  'src/App.tsx', 'src/WorkspaceApp.tsx', 'src/CompanyAccountGate.tsx', 'src/useWorkspaceRecovery.ts',
  'src/bridge.ts', 'src/CompanySettingsSync.tsx', 'src/workspaceMutation.ts', 'src/cloudAccessRevalidation.ts',
  'src/WorkspaceRecoveryDialog.tsx', 'src/ui.tsx',
  'tests/mobile-harness.tsx', 'tests/app-draft-identity-fixture.ts', 'tests/workspace-action-lifecycle-fixture.ts',
  'tests/settings-action-lifecycle-fixture.ts', 'scripts/test-settings-action-lifecycle.mjs',
];
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha(await readFile(join(desktop, name)))])));
const report = {
  startedAt: new Date().toISOString(), node: { version: process.version, executable: process.execPath },
  before: await hashes(), cases: [],
  contract: 'Real App, CompanyAccountGate, keyed provider, SettingsScreen execute, actual desktopApi.saveSettings/settingsToBackend/loadWorkspace and Tauri SDK. Synthetic already-verified B is returned by pending App revalidation; actual choose_remote button is clicked. Late A success and failed reads may not replace UI B or start recovery after cleanup. Same-space navigation releases parent busy; read-only after an admitted write preserves its confirmation. One scoped write only; ordinary success and read-only recovery must still work.',
  limits: 'This proves frontend publication with assembled synthetic snapshots, not native DB acceptance or a real session switch. A foreign organization from /me on the same native session remains refused by production. All non-static/API/external requests are blocked. Scope-switch during an already-open recovery modal is not asserted here: the separate preserved probe found the Gate button inaccessible after that synthetic transition; no inert/ARIA or modal guard is bypassed.',
};
const original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length, 2, 'Expected account fixture entry point');
const fixture = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + `
import { installSettingsAuditFixture } from '/tests/settings-action-lifecycle-fixture.ts';
export function installAppDraftIdentityFixture(workspace: Workspace) { installSettingsAuditFixture(workspace, installOriginalAppDraftIdentityFixture); }
`;
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const probe = freePortServer();
await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port;
await new Promise(ok => probe.close(ok));
assert.notEqual(port, 5363, 'User preview must remain untouched');
const origin = `http://127.0.0.1:${port}`;
const server = await vite.createServer({
  ...loaded.config, configFile: false, root: desktop,
  plugins: [{
    name: 'closed-settings-action-fixture', enforce: 'pre',
    load(id) { if (id.replaceAll('\\', '/').split('?')[0].endsWith('/tests/app-draft-identity-fixture.ts')) return fixture; },
  }, ...loaded.config.plugins],
  cacheDir: join(tmpdir(), `zentra-settings-action-lifecycle-vite-${port}`),
  resolve: { ...loaded.config.resolve, dedupe: ['react', 'react-dom'] },
  optimizeDeps: { entries: [join(desktop, 'tests/mobile-harness.html')], noDiscovery: true, include: [
    'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react',
    'qrcode.react', '@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs',
  ] },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**'] } },
  logLevel: 'silent',
});

async function screen(page, label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}
async function snapshot(page) {
  return page.evaluate(() => ({
    visibleB: document.body.textContent.includes('Client fictif B'),
    visibleA: document.querySelector('.sidebar__company strong')?.textContent === 'COMPANY SAVED A',
    visibleCompany: document.querySelector('.sidebar__company strong')?.textContent,
    appVisible: !!document.querySelector('.desktop-app'),
    successNotice: !!document.querySelector('.notice--success'),
    busy: document.querySelector('.desktop-app')?.getAttribute('aria-busy') === 'true',
    rootIsolation: [...document.body.children].filter(node => node.id === 'root').map(node => ({ inert: node.hasAttribute('inert'), ariaHidden: node.getAttribute('aria-hidden') })),
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => node.textContent.slice(0, 200)),
    database: window.__qaActParent.database(), proof: structuredClone(window.__qaActParent.proof),
    companyResolutions: structuredClone(window.__qaAppDraftIdentity.proof.companyResolutions),
    identityReads: structuredClone(window.__qaAppDraftIdentity.proof.identityReads),
  }));
}

try {
  await server.listen(); report.origin = origin;
  for (const engine of engines) {
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? process.env.ZENTRA_EDGE_PATH ? { executablePath: process.env.ZENTRA_EDGE_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {} : {}) });
    try {
      for (const scenario of scenarios.filter(scenario => !requested || requested.includes(scenario))) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
        const item = { engine, browserVersion: browser.version(), scenario, errors: [], blockedRequests: [] };
        report.cases.push(item); page.setDefaultTimeout(15000);
        page.on('pageerror', error => item.errors.push(error.message));
        await page.route('**/*', route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin === origin && request.method() === 'GET' && !/^\/api(?:\/|$)/.test(url.pathname)) return route.continue();
          item.blockedRequests.push({ method: request.method(), pathname: url.pathname, origin: url.origin });
          return route.abort();
        });
        await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__qaAppDraftIdentity?.proof.identityReads.some(read => read.pending));
        await page.evaluate(() => {
          window.__qaAppDraftIdentity.identityMode('ready');
          for (const read of window.__qaAppDraftIdentity.proof.identityReads.filter(read => read.pending)) window.__qaAppDraftIdentity.releaseIdentity(read.id);
        });
        await page.locator('.desktop-app').waitFor(); await screen(page, 'Paramètres');
        await page.locator('[data-settings-link=company]').click();
        const form = page.locator('form').filter({ has: page.locator('[name=legalName]') });
        await form.locator('[name=legalName]').fill('COMPANY SAVED A');
        await form.locator('[name=vatNumber]').fill('CHE-123.456.789 MWST');
        item.formValidity = await form.evaluate(form => ({ valid: form.checkValidity(), invalid: [...form.querySelectorAll('input,select,textarea')].filter(input => !input.checkValidity()).map(input => ({ name: input.name, value: input.value, message: input.validationMessage })) }));
        await page.evaluate(mode => window.__qaActParent.begin(mode), scenario === 'ordinary-success-control' || scenario.startsWith('explicit-restore-') ? 'control' : scenario);
        await form.getByRole('button', { name: 'Enregistrer l’entreprise', exact: true }).click();
        await page.waitForFunction(() => window.__qaActParent.proof.writes === 1);
        // Only held actions are still pending here. A second submit during
        // that admitted action must not replay it; a completed control is not
        // treated as a duplicate submission.
        if (scenario !== 'ordinary-success-control' && !scenario.startsWith('explicit-restore-')) {
          await form.evaluate(form => form.requestSubmit());
        }
        if (scenario.startsWith('explicit-restore-')) {
          await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'COMPANY SAVED A');
          await page.evaluate(mode => window.__qaActParent.begin(mode), scenario === 'explicit-restore-recovery-control' ? 'restore-held-read' : 'control');
          await page.locator('[data-settings-link=storage]').click();
          page.on('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.accept(); });
          await page.locator('.manual-backup').getByRole('button', { name: 'Restaurer', exact: true }).click();
          await page.waitForFunction(() => window.__qaActParent.proof.restores === 1);
          if (scenario === 'explicit-restore-recovery-control') {
            await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'action-final' && read.pending));
            let late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'action-final' && read.pending).id);
            await page.evaluate(id => window.__qaActParent.settle(id, true), late);
            await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'fallback-read' && read.pending));
            late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'fallback-read' && read.pending).id);
            await page.evaluate(id => window.__qaActParent.settle(id), late);
          }
          await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'RESTORED COMPANY');
          item.after = await snapshot(page);
          assert.equal(item.after.database.scope, 'synthetic-company-restored');
          assert.equal(item.after.proof.restores, 1, 'Explicit restore is never repeated');
          assert.equal(item.after.proof.writes, 1);
          assert.equal(item.after.dialogs.length, 0);
          item.controlPassed = true;
        } else if (scenario === 'ordinary-success-control') {
          await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'COMPANY SAVED A');
          item.after = await snapshot(page);
          assert.equal(item.after.proof.writes, 1); assert.equal(item.after.visibleA, true);
          item.controlPassed = true;
        } else if (scenario.startsWith('foreign-')) {
          await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'fallback-read' && read.pending));
          let late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'fallback-read' && read.pending).id);
          if (scenario === 'foreign-retry-read') {
            await page.evaluate(id => window.__qaActParent.settle(id, true), late);
            const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
            await recovery.waitFor();
            await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
            await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'fallback-read' && read.pending));
            late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'fallback-read' && read.pending).id);
          }
          item.beforeRelease = await snapshot(page);
          await page.evaluate(id => window.__qaActParent.settle(id), late);
          await page.waitForTimeout(200);
          item.afterForeign = await snapshot(page);
          item.afterForeign.text = await page.locator('body').innerText();
          assert.equal(item.afterForeign.visibleCompany, 'Atelier du Léman', 'Foreign read may not replace the original UI settings');
          assert.equal(item.afterForeign.proof.resolutionChoices.length, 1, 'Foreign read may not publish into the parent and reopen its Gate');
          const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
          await recovery.waitFor();
          assert.equal(item.afterForeign.proof.writes, 1);
          // Recover by a newly useful read only; never resend the acknowledged
          // write or install the foreign snapshot as its confirmation.
          await page.evaluate(() => window.__qaActParent.restoreOriginForRead());
          await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
          await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'fallback-read' && read.pending));
          late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'fallback-read' && read.pending).id);
          await page.evaluate(id => window.__qaActParent.settle(id), late);
          await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'COMPANY SAVED A');
          item.after = await snapshot(page);
          assert.equal(item.after.dialogs.length, 0);
          assert.equal(item.after.proof.writes, 1);
          assert.equal(await form.getByRole('button', { name: 'Enregistrer l’entreprise', exact: true }).isEnabled(), true);
        } else {
          await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'action-final' && read.pending));
          const first = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'action-final').id);
          let late = first;
          if (['late-catch-read', 'late-fallback-rejection', 'ordinary-recovery-control'].includes(scenario)) {
            await page.evaluate(id => window.__qaActParent.settle(id, true), first);
            await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'fallback-read' && read.pending));
            late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'fallback-read' && read.pending).id);
            if (scenario === 'ordinary-recovery-control') {
              await page.evaluate(id => window.__qaActParent.settle(id, true), late);
              const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
              await recovery.waitFor();
              await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
              await page.waitForFunction(() => window.__qaActParent.proof.reads.some(read => read.kind === 'fallback-read' && read.pending));
              late = await page.evaluate(() => window.__qaActParent.proof.reads.find(read => read.kind === 'fallback-read' && read.pending).id);
            }
          }
          item.oldRead = await snapshot(page);
          if (scenario === 'same-space-navigation') {
            await screen(page, 'Clients');
            await page.evaluate(id => window.__qaActParent.settle(id), late);
            await page.waitForTimeout(200);
            // This keeps the real WorkspaceApp mounted, so ignoring the old
            // settings callbacks must not strand its busy state.
            const add = page.getByRole('button', { name: 'Nouveau client', exact: true });
            await add.waitFor();
            assert.equal(await add.isEnabled(), true, 'Parent busy must be released after settings navigation');
            item.after = await snapshot(page);
            assert.equal(item.after.database.scope, 'synthetic-company-a');
            assert.equal(item.after.visibleA, false, 'Removed settings screen may not publish its late snapshot');
            assert.equal(item.after.proof.writes, 1);
            assert.equal(item.after.dialogs.length, 0);
          } else if (scenario === 'read-only-after-commit') {
            await page.evaluate(() => window.__qaActParent.makeReadOnly());
            const save = form.getByRole('button', { name: 'Enregistrer l’entreprise', exact: true });
            await page.getByText('Accès « Lecture seule » : consultation et exports autorisés, modifications bloquées sur ce poste.', { exact: true }).waitFor();
            assert.equal(await save.isDisabled(), true);
            await page.evaluate(id => window.__qaActParent.settle(id), late);
            await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'COMPANY SAVED A');
            await form.evaluate(form => form.requestSubmit());
            item.after = await snapshot(page);
            assert.equal(item.after.proof.writes, 1, 'Latest read-only permission rejects a new settings write');
            assert.equal(item.after.visibleA, true, 'Already-admitted settings save retains its truthful confirmation');
            assert.equal(await save.isDisabled(), true);
          } else if (scenario === 'ordinary-recovery-control') {
            await page.evaluate(id => window.__qaActParent.settle(id), late);
            await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'COMPANY SAVED A');
            item.after = await snapshot(page);
            assert.equal(item.after.dialogs.length, 0);
            assert.equal(item.after.proof.reads.length, 3);
            assert.equal(item.after.proof.writes, 1);
            assert.equal(await form.getByRole('button', { name: 'Enregistrer l’entreprise', exact: true }).isEnabled(), true);
            item.controlPassed = true;
          } else {
            await page.evaluate(() => window.__qaActParent.switchVerifiedAccount());
            await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).click().catch(async error => {
              item.failedSwitch = await snapshot(page);
              item.failedSwitch.text = await page.locator('body').innerText();
              throw error;
            });
            await page.locator('.desktop-app').waitFor(); await screen(page, 'Clients');
            await page.getByText('Client fictif B', { exact: true }).first().waitFor();
            item.beforeRelease = await snapshot(page);
            assert.equal(item.beforeRelease.database.scope, 'synthetic-company-b'); assert.equal(item.beforeRelease.visibleB, true);
            await page.evaluate(({ id, failure }) => window.__qaActParent.settle(id, failure), { id: late, failure: ['late-first-read-rejection', 'late-fallback-rejection'].includes(scenario) });
            // Allow real React's promise continuations and passive effects to run;
            // no forced flushSync or extracted hook host changes the event batch.
            await page.waitForTimeout(200);
            item.after = await snapshot(page);
            assert.equal(item.after.database.scope, 'synthetic-company-b'); assert.equal(item.after.proof.writes, 1);
            item.defectReproduced = !item.after.visibleB || item.after.visibleA;
            assert.equal(item.defectReproduced, false, 'Old settings publication must not replace company B');
            assert.equal(item.after.visibleCompany, 'SYNTHETIC COMPANY B');
            assert.equal(item.after.successNotice, false, 'Old settings callback must not report success in B');
            assert.equal(await page.getByRole('button', { name: 'Nouveau client', exact: true }).isEnabled(), true, 'Old finally must not block B');
            assert.equal(item.after.dialogs.length, 0);
            // Admission count is observed: the defect can itself reopen gate resolution.
            assert.equal(item.after.proof.reads.filter(read => read.pending).length, 0);
            assert.equal(item.after.proof.reads.length, scenario === 'late-first-read-rejection' || scenario === 'late-success' ? 1 : 2, 'No new read or recovery may be admitted after cleanup');
            item.stalePublicationPrevented = true;
          }
        }
        assert.deepEqual(item.after.proof.scopedInputs, [{ present: true, value: 'synthetic-company-a' }], 'The actual bridge write retains its original scope');
        assert.equal(item.after.proof.reads.filter(read => read.pending).length, 0);
        assert.deepEqual(item.errors, []); assert.deepEqual(item.blockedRequests, []);
        if (process.env.ZENTRA_QA_SCREENSHOTS === '1') await page.screenshot({ path: join(out, `${engine}-${scenario}.png`) });
        item.completed = true;
        console.log(JSON.stringify({ engine, scenario, passed: true }));
        await page.close();
      }
    } finally { await browser.close(); }
  }
  report.after = await hashes();
  assert.deepEqual(report.after, report.before, 'Source bytes unchanged while testing');
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  await server.close(); report.previewClosed = true; report.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, cases: report.cases.length, failure: report.failure ?? null, previewClosed: true }));
}
