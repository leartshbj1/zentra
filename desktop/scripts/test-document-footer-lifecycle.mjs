/** Real App/React DOM footer regression; run with the desired Node executable.
 * Optional ZENTRA_PLAYWRIGHT_MODULE, ZENTRA_EDGE_PATH, ZENTRA_QA_OUTPUT.
 * Synthetic closed SDK transport only; no native process/API/user data.
 * Serves every shipping module directly from disk; no production overlay.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const desktop = resolve(dirname(script), '..');
const repository = resolve(desktop, '..');
const out = resolve(process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-document-footer-lifecycle-${Date.now()}`));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const playwrightModule = process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(playwrightModule.startsWith('file:') ? playwrightModule : pathToFileURL(isAbsolute(playwrightModule) ? playwrightModule : require.resolve(playwrightModule)).href);
const pw = imported.default ?? imported;
const sha = value => createHash('sha256').update(value).digest('hex');
const sources = [
  'desktop/src/App.tsx', 'desktop/src/WorkspaceApp.tsx', 'desktop/src/DocumentEditor.tsx',
  'desktop/src/CompanyAccountGate.tsx', 'desktop/src/bridge.ts', 'desktop/src/ui.tsx',
  'desktop/src/useFormDraft.tsx', 'desktop/src/useWorkspaceRecovery.ts',
  'desktop/src/WorkspaceRecoveryDialog.tsx', 'desktop/src/formDrafts.ts',
  'desktop/tests/mobile-harness.tsx', 'desktop/tests/app-draft-identity-fixture.ts',
  'desktop/tests/automation-company-fixture.ts', 'desktop/tests/finance-fixture.ts',
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name, sha(await readFile(join(repository, name)))])));
const scenarios = process.env.ZENTRA_QA_SCENARIOS?.split(',') || ['foreign-b', 'ordinary-a', 'native-refusal', 'double-click-busy', 'read-only', 'foreign-fallback-retry-a'];
assert.ok(scenarios.every(item => ['foreign-b', 'ordinary-a', 'native-refusal', 'double-click-busy', 'read-only', 'foreign-fallback-retry-a'].includes(item)));
const engines = process.env.ZENTRA_QA_ENGINES?.split(',') || ['chromium', 'webkit'];
assert.ok(engines.every(item => ['chromium', 'webkit'].includes(item)));
const report = {
  startedAt: new Date().toISOString(), node: { executable: process.execPath, version: process.version },
  before: await hashes(), cases: [], sourceVariant: 'tracked-source',
  servedDocumentEditorSha256: sha(await readFile(join(desktop, 'src/DocumentEditor.tsx'))),
  fixtureSha256: sha(await readFile(join(desktop, 'tests/document-footer-lifecycle-fixture.ts'))), runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  contract: 'Actual App + CompanyAccountGate + draft provider + DocumentEditor + WorkspaceApp.act + production saveSettings/settingsToBackend/loadWorkspace + Tauri SDK. Closed controlled SDK update_settings acknowledgement and held GET; only the existing identity/licence/read-only activity dependencies are synthetic. No production act/onSaved/setWorkspace/DocumentEditor override. A remains the UI origin while the foreign B receipt is held.',
  limits: 'Synthetic transport acknowledgement is not native SQL acceptance, native origin validation, a session/account switch, licence authenticity or production data. No model, installed native process, real API or user data. Root/Modal inert and aria-hidden attributes are observed only, never forced or removed. The production App, DocumentEditor, parent, Modal and bridge are loaded from disk without substitution. Only the existing identity test installer is adapted to install the closed dependency fixture. No tracked edit by this runner.',
};
const original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8');
assert.equal(original.split('export function installAppDraftIdentityFixture(').length, 2);
const injected = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + `\nimport { installFooterReceiptFixture } from '/tests/document-footer-lifecycle-fixture.ts';\nexport function installAppDraftIdentityFixture(workspace: Workspace) { installFooterReceiptFixture(workspace, installOriginalAppDraftIdentityFixture); }\n`;
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts'));
const portServer = freePortServer();
await new Promise(ok => portServer.listen(0, '127.0.0.1', ok));
const port = portServer.address().port;
await new Promise(ok => portServer.close(ok));
assert.notEqual(port, 5363);
const origin = `http://127.0.0.1:${port}`;
const server = await vite.createServer({
  ...loaded.config, configFile: false, root: desktop,
  plugins: [{ name: 'closed-footer-receipt-probe', enforce: 'pre',
    async load(id) {
      if (id.replaceAll('\\', '/').split('?')[0].endsWith('/tests/app-draft-identity-fixture.ts')) return injected;
    },
  }, ...loaded.config.plugins],
  cacheDir: join(tmpdir(), `zentra-footer-receipt-probe-${port}`),
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
    company: document.querySelector('.sidebar__company strong')?.textContent,
    appVisible: !!document.querySelector('.desktop-app'),
    successNotice: document.querySelector('.notice--success')?.textContent || null,
    errorNotice: document.querySelector('.notice--error')?.textContent || null,
    rootIsolation: [...document.body.children].filter(node => node.id === 'root').map(node => ({ inert: node.hasAttribute('inert'), ariaHidden: node.getAttribute('aria-hidden') })),
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => ({ label: node.getAttribute('aria-labelledby'), text: node.textContent.slice(0, 200) })),
    title: document.querySelector('[role=dialog] [name=title]')?.value,
    terms: document.querySelector('[role=dialog] [name=terms]')?.value,
    templateName: document.querySelector('[role=dialog] [placeholder="Ex. Conditions devis standard"]')?.value,
    templateSelected: document.querySelector('.document-footer-templates select')?.value,
    saveDisabled: [...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.includes('Enregistrer le modèle'))?.matches(':disabled'),
    publicationEvents: structuredClone(window.__footerPublicationEvents),
    proof: structuredClone(window.__qaFooterReceipt.proof),
    transportState: window.__qaFooterReceipt.transportState(),
    identity: structuredClone(window.__qaAppDraftIdentity.proof),
  }));
}

try {
  await server.listen(); report.origin = origin;
  for (const engine of engines) {
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? process.env.ZENTRA_EDGE_PATH ? { executablePath: process.env.ZENTRA_EDGE_PATH } : { channel: 'msedge' } : {}) });
    try {
      for (const scenario of scenarios) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
        const item = { engine, browserVersion: browser.version(), scenario, errors: [], blockedRequests: [] };
        report.cases.push(item); page.setDefaultTimeout(15000);
        page.on('pageerror', error => item.errors.push(error.message));
        await page.route('**/*', route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin === origin && request.method() === 'GET' && !/^\/api(?:\/|$)/.test(url.pathname)) return route.continue();
          item.blockedRequests.push({ method: request.method(), origin: url.origin, pathname: url.pathname });
          return route.abort();
        });
        await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
        try {
          await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1`, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => window.__qaAppDraftIdentity?.proof.identityReads.some(row => row.pending));
          await page.evaluate(() => {
            window.__qaAppDraftIdentity.identityMode('ready');
            for (const read of window.__qaAppDraftIdentity.proof.identityReads.filter(read => read.pending)) window.__qaAppDraftIdentity.releaseIdentity(read.id);
          });
          await page.locator('.desktop-app').waitFor();
          await page.evaluate(() => {
            window.__footerPublicationEvents = [];
            const observer = new MutationObserver(() => {
              const company = document.querySelector('.sidebar__company strong')?.textContent;
              const success = document.querySelector('.notice--success')?.textContent;
              if (company || success) window.__footerPublicationEvents.push({ company, success });
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          });
          await screen(page, 'Devis');
          await page.getByRole('button', { name: 'Nouveau devis', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Nouveau devis', exact: true });
          await dialog.waitFor();
          await dialog.locator('[name=title]').fill('DOCUMENT A CONSERVÉ');
          await dialog.locator('[name=clientId]').selectOption({ index: 1 });
          await dialog.getByRole('button', { name: '2. Prestations', exact: true }).click();
          await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Prestation fictive conservée');
          await dialog.getByRole('textbox', { name: 'Quantité', exact: true }).fill('1');
          await dialog.locator('[aria-label="Unité"]').fill('h');
          await dialog.getByRole('textbox', { name: 'Prix unitaire', exact: true }).fill('100');
          const vat = dialog.getByRole('combobox', { name: 'Taux TVA', exact: true });
          if (await vat.count()) await vat.selectOption({ index: 1 });
          await dialog.getByRole('button', { name: '3. Conditions', exact: true }).click();
          await dialog.locator('[name=terms]').fill('TEXTE A CONSERVÉ');
          await dialog.getByText('Réutiliser un texte de bas de page', { exact: true }).click();
          await dialog.getByRole('textbox', { name: 'Nom du nouveau modèle', exact: true }).fill('MODÈLE A SYNTHÉTIQUE');
          await page.evaluate(mode => window.__qaFooterReceipt.begin(mode), scenario);
          const save = dialog.getByRole('button', { name: 'Enregistrer le modèle', exact: true });
          if (scenario === 'read-only') {
            await page.evaluate(() => window.__qaFooterReceipt.makeReadOnly());
            await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.includes('Enregistrer le modèle'))?.matches(':disabled'));
            item.actualClickRejected = false;
            try { await save.click({ timeout: 500 }); } catch (error) { assert.equal(error.name, 'TimeoutError'); item.actualClickRejected = true; }
            item.after = await snapshot(page);
            assert.equal(item.after.proof.attempts, 0);
            assert.equal(item.after.title, 'DOCUMENT A CONSERVÉ');
            assert.equal(item.after.terms, 'TEXTE A CONSERVÉ');
            assert.equal(item.actualClickRejected, true);
            item.controlPassed = true;
          } else {
            if (scenario === 'double-click-busy') await save.dblclick();
            else await save.click();
            await page.waitForFunction(() => window.__qaFooterReceipt.proof.attempts === 1);
            if (scenario === 'native-refusal') {
              await dialog.locator('.error-guidance__message').waitFor();
              item.after = await snapshot(page);
              item.accessibleParentRefusalCount = await page.getByRole('alert').filter({ hasText: 'Refus synthétique du modèle de bas de page' }).count();
              item.accessibleDialogRefusalCount = await dialog.getByText('Refus synthétique du modèle de bas de page', { exact: false }).count();
              item.errorInaccessibleWithModal = !!item.after.errorNotice && item.accessibleParentRefusalCount === 0 && item.accessibleDialogRefusalCount === 0;
              item.accessibleDialogAlerts = await dialog.getByRole('alert').count();
                assert.equal(item.accessibleDialogAlerts, 1, 'The existing ErrorGuidance alert is inside the accessible current modal');
                assert.equal(await dialog.getByRole('alert').isVisible(), true);
                assert.equal(item.after.errorNotice, null, 'The refused mutation uses child onError, not the isolated parent alert');
              assert.deepEqual(item.after.rootIsolation, [{ inert: true, ariaHidden: 'true' }], 'Central modal isolation stays intact');
              await page.screenshot({ path: join(out, `${engine}-${scenario}.png`) });
              assert.equal(item.after.proof.acknowledgedWrites, 0);
              assert.equal(item.after.title, 'DOCUMENT A CONSERVÉ');
              assert.equal(item.after.terms, 'TEXTE A CONSERVÉ');
              assert.equal(item.after.templateName, 'MODÈLE A SYNTHÉTIQUE');
              assert.equal(item.after.dialogs.length, 1);
              item.controlPassed = true;
            } else {
              await page.waitForFunction(() => window.__qaFooterReceipt.proof.reads.some(row => row.kind === 'SDK-workspace' && row.pending));
              item.beforeRelease = await snapshot(page);
              assert.equal(item.beforeRelease.company, 'Atelier du Léman');
              assert.equal(item.beforeRelease.title, 'DOCUMENT A CONSERVÉ');
              assert.equal(await save.isDisabled(), true, 'Busy blocks a second actual button click');
              if (scenario === 'double-click-busy') {
                item.busyClickRejected = false;
                try { await save.click({ timeout: 500 }); } catch (error) { assert.equal(error.name, 'TimeoutError'); item.busyClickRejected = true; }
                assert.equal(item.busyClickRejected, true);
              }
              await page.evaluate(failure => window.__qaFooterReceipt.release(failure), scenario === 'foreign-fallback-retry-a');
              if (scenario.startsWith('foreign-')) {
                await page.waitForFunction(() => window.__qaFooterReceipt.proof.reads.filter(row => row.kind === 'SDK-workspace').length === 2 && window.__qaFooterReceipt.proof.reads.some(row => row.kind === 'SDK-workspace' && row.pending));
                item.beforeFallback = await snapshot(page);
                assert.equal(item.beforeFallback.company, 'Atelier du Léman');
                assert.equal(item.beforeFallback.title, 'DOCUMENT A CONSERVÉ');
                assert.equal(item.beforeFallback.proof.attempts, 1);
                await page.evaluate(() => window.__qaFooterReceipt.release());
              }
              if (scenario.startsWith('foreign-')) {
                const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
                await recovery.waitFor();
                item.afterForeign = await snapshot(page);
                assert.equal(item.afterForeign.company, 'Atelier du Léman', 'Foreign initial/fallback receipts cannot replace the original UI');
                assert.equal(item.afterForeign.title, 'DOCUMENT A CONSERVÉ');
                assert.equal(item.afterForeign.terms, 'TEXTE A CONSERVÉ');
                assert.equal(item.afterForeign.successNotice, null);
                assert.equal(item.afterForeign.dialogs.length, 2, 'Original document stays below the read-only recovery modal');
                assert.deepEqual(item.afterForeign.rootIsolation, [{ inert: true, ariaHidden: 'true' }]);
                assert.equal(item.afterForeign.proof.acknowledgedWrites, 1);
                await page.evaluate(() => window.__qaFooterReceipt.restoreOriginForRead());
                await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
                await page.waitForFunction(() => window.__qaFooterReceipt.proof.reads.filter(row => row.kind === 'SDK-workspace').length === 3 && window.__qaFooterReceipt.proof.reads.some(row => row.kind === 'SDK-workspace' && row.pending));
                item.beforeOriginRetryRelease = await snapshot(page);
                assert.equal(item.beforeOriginRetryRelease.proof.attempts, 1);
                await page.evaluate(() => window.__qaFooterReceipt.release());
                await page.waitForFunction(() => document.querySelectorAll('[role=dialog]').length === 1 && !!document.querySelector('.notice--success') && !!document.querySelector('.document-footer-templates select')?.value);
                item.after = await snapshot(page);
                assert.equal(item.after.company, 'Atelier du Léman');
                assert.equal(item.after.title, 'DOCUMENT A CONSERVÉ');
                assert.equal(item.after.terms, 'TEXTE A CONSERVÉ');
                assert.equal(item.after.templateName, 'MODÈLE A SYNTHÉTIQUE');
                assert.equal(item.after.dialogs.length, 1);
                assert.equal(await save.isEnabled(), true);
                assert.deepEqual(item.after.rootIsolation, [{ inert: true, ariaHidden: 'true' }]);
                item.foreignPublication = item.afterForeign.publicationEvents.some(event => event.company === 'FOREIGN RECEIPT COMPANY B');
                item.oldSuccessPublished = item.afterForeign.publicationEvents.some(event => Boolean(event.success));
                assert.equal(item.foreignPublication, false);
                assert.equal(item.oldSuccessPublished, false);
                item.expectedInvariantPassed = true;
                item.controlPassed = true;
                item.readOnlyRecoveryWithoutReplay = true;
              } else {
                await page.waitForFunction(() => !!document.querySelector('.notice--success') && !!document.querySelector('.document-footer-templates select')?.value);
                item.after = await snapshot(page);
                assert.equal(item.after.company, 'Atelier du Léman');
                assert.equal(item.after.title, 'DOCUMENT A CONSERVÉ');
                assert.equal(item.after.terms, 'TEXTE A CONSERVÉ');
                assert.equal(item.after.dialogs.length, 1);
                assert.ok(item.after.templateSelected);
                item.controlPassed = true;
              }
              assert.equal(item.after.proof.acknowledgedWrites, 1);
              assert.equal(item.after.proof.attempts, 1);
              assert.equal(item.after.proof.reads.filter(row => row.kind === 'SDK-workspace').length,
                scenario.startsWith('foreign-') ? 3 : 1);
            }
          }
          if (scenario !== 'read-only') assert.deepEqual(item.after.proof.payloads.map(input => ({ present: input.expectedScopePresent, scope: input.expectedWorkspaceScope })), [{ present: true, scope: 'synthetic-company-a' }]);
          assert.deepEqual(item.errors, []);
          assert.deepEqual(item.blockedRequests, []);
          if (scenario.startsWith('foreign-')) await page.screenshot({ path: join(out, `${engine}-${scenario}.png`) });
          item.completed = true;
          console.log(JSON.stringify({ engine, scenario, redOracle: item.redOracle ?? null, controlPassed: item.controlPassed ?? null, errorInaccessibleWithModal: item.errorInaccessibleWithModal ?? null }));
        } catch (error) {
          item.failure = { name: error.name, message: error.message, stack: error.stack };
          item.failedSnapshot = await snapshot(page).catch(() => null);
          item.failedBody = await page.locator('body').innerText().catch(() => null);
          process.exitCode = 1;
          console.log(JSON.stringify({ engine, scenario, failed: error.message }));
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await server.close(); report.previewClosed = true;
  report.after = await hashes();
  try { assert.deepEqual(report.after, report.before); } catch (error) { report.sourceChanged = error.message; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, cases: report.cases.length, previewClosed: true, incomplete: report.cases.filter(item => !item.completed).length }));
}
