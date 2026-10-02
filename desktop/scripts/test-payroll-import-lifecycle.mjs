import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as freePortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url)), desktop = resolve(process.env.ZENTRA_DESKTOP_ROOT || join(dir, '..')), out = resolve(process.env.ZENTRA_QA_OUTPUT || join(desktop, 'artifacts/runtime-audit-20261002/payroll-import-lifecycle/after'));
await mkdir(out, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const vite = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href);
const module = await import(pathToFileURL(process.env.ZENTRA_PLAYWRIGHT_MODULE).href), pw = module.default ?? module;
const sha = data => createHash('sha256').update(data).digest('hex'), names = ['src/App.tsx', 'src/WorkspaceApp.tsx', 'src/PayrollImportWizard.tsx', 'src/bridge.ts', 'src/types.ts', 'src/useWorkspaceRecovery.ts', 'src/workspaceMutation.ts', 'tests/app-draft-identity-fixture.ts', 'tests/mobile-harness.tsx'];
const hashes = async () => Object.fromEntries(await Promise.all(names.map(async (name) => [name, sha(await readFile(join(desktop, name)))])));
const scenarios = (process.env.ZENTRA_QA_SCENARIOS || 'current,fail-first,all-fail,held,foreign,wrong-status,late-switch,late-ack,read-only,save-scope,save-readonly,native-refused').split(','), engines = (process.env.ZENTRA_QA_ENGINES || 'chromium,webkit').split(',');
const report = { startedAt: new Date().toISOString(), diskBefore: await hashes(), cases: [], contract: 'Actual App/CompanyAccountGate/WorkspaceApp/PayrollImportWizard and SDK/bridge. Synthetic IPC ACK+snapshot only, not native DB acceptance. No model/AI installation/API/email.' };
const baseline = {};
if (process.env.ZENTRA_QA_BASELINE_ROOT)
    for (const name of ['PayrollImportWizard.tsx', 'bridge.ts', 'WorkspaceApp.tsx']) {
        const ext = name.endsWith('.tsx') ? 'tsx' : 'ts', value = await readFile(join(resolve(process.env.ZENTRA_QA_BASELINE_ROOT), name.replace('.' + ext, '.baseline-fixture.' + ext)), 'utf8');
        baseline[name] = value;
    }
report.fixtureSha = sha(await readFile(join(desktop, 'tests/payroll-import-lifecycle-fixture.ts')));
report.servedBaseline = Object.fromEntries(Object.entries(baseline).map(([n, c]) => [n, sha(c)]));
const fixture = await readFile(join(desktop, 'tests/payroll-import-lifecycle-fixture.ts'), 'utf8'), original = await readFile(join(desktop, 'tests/app-draft-identity-fixture.ts'), 'utf8'), injected = original.replace('export function installAppDraftIdentityFixture(', 'function installOriginalAppDraftIdentityFixture(') + "\nimport {installPayrollImportAuditFixture} from '/__payroll-import-audit-fixture.ts';\nexport function installAppDraftIdentityFixture(workspace:Workspace){installPayrollImportAuditFixture(workspace,installOriginalAppDraftIdentityFixture);}\n";
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktop, 'vite.config.ts')), probe = freePortServer();
await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port;
await new Promise(ok => probe.close(ok));
assert.notEqual(port, 5363);
const origin = 'http://127.0.0.1:' + port;
const server = await vite.createServer({ ...loaded.config, configFile: false, root: desktop, plugins: [{ name: 'closed-payroll-import-audit', enforce: 'pre', resolveId(id) { if (id === '/__payroll-import-audit-fixture.ts')
                return join(desktop, 'tests/payroll-import-lifecycle-fixture.ts'); }, load(id) { const p = id.replaceAll('\\', '/').split('?')[0]; for (const [name, code] of Object.entries(baseline))
                if (p.endsWith('/src/' + name))
                    return code; if (id === '/__payroll-import-audit-fixture.ts')
                return fixture; if (p.endsWith('/tests/app-draft-identity-fixture.ts'))
                return injected; } }, ...loaded.config.plugins], cacheDir: join(tmpdir(), 'zentra-payroll-import-' + port), resolve: { ...loaded.config.resolve, dedupe: ['react', 'react-dom'] }, optimizeDeps: { entries: [join(desktop, 'tests/mobile-harness.html')], noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'qrcode.react', '@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs'] }, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**'] } }, logLevel: 'silent' });
async function screen(page, label) { await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click(); await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label); await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click(); await page.locator('.navigation-palette').waitFor({ state: 'detached' }); }
async function snapshot(page) { return page.evaluate(() => window.__qaPayrollImport.state()); }
try {
    await server.listen();
    report.origin = origin;
    for (const engine of engines) {
        const browser = await pw[engine].launch({ headless: true, ...engine === 'chromium' ? { executablePath: process.env.ZENTRA_EDGE_PATH } : {} });
        try {
            for (const scenario of scenarios) {
                const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
                page.setDefaultTimeout(10000);
                const item = { engine, scenario, browserVersion: browser.version(), errors: [], blockedRequests: [] };
                report.cases.push(item);
                page.on('pageerror', e => item.errors.push(e.message));
                await page.route('**/*', route => { const req = route.request(), url = new URL(req.url()); if (url.origin === origin && req.method() === 'GET' && !/^\/api(?:\/|$)/.test(url.pathname))
                    return route.continue(); item.blockedRequests.push({ method: req.method(), pathname: url.pathname, origin: url.origin }); return route.abort(); });
                await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
                try {
                    await page.goto(origin + '/tests/mobile-harness.html?browsing=1&design=1&automation=setup&appDraftIdentity=1' + (scenario.startsWith('save-') ? '&payrollTwo=1' : ''), { waitUntil: 'domcontentloaded' });
                    await page.waitForFunction(() => window.__qaAppDraftIdentity?.proof.identityReads.some(r => r.pending));
                    await page.evaluate(() => { window.__qaAppDraftIdentity.identityMode('ready'); for (const r of window.__qaAppDraftIdentity.proof.identityReads.filter(r => r.pending))
                        window.__qaAppDraftIdentity.releaseIdentity(r.id); });
                    await page.locator('.desktop-app').waitFor();
                    await screen(page, 'Équipe & salaires');
                    await page.getByRole('button', { name: 'Fiches de salaire', exact: true }).click();
                    await page.locator('.payroll-review-banner').click();
                    const wizard = page.getByRole('dialog', { name: 'Importer des fiches de salaire', exact: true });
                    await wizard.waitFor();
                    await wizard.locator('.payroll-source-pane img').waitFor();
                    if (scenario.startsWith('save-')) {
                        await wizard.locator('.payroll-review-fields').first().locator('input').first().fill('Synthetic edited employee one');
                        await wizard.locator('.payroll-import-queue button').last().click();
                        await wizard.locator('.payroll-review-fields').first().locator('input').first().fill('Synthetic edited employee two');
                    }
                    await wizard.getByRole('checkbox', { name: 'J’ai comparé les champs et montants au document original' }).check();
                    const confirm = wizard.getByRole('button', { name: 'Confirmer et créer à contrôler', exact: true });
                    assert.equal(await confirm.isEnabled(), true);
                    await page.evaluate(mode => window.__qaPayrollImport.begin(mode), scenario);
                    if (scenario.startsWith('save-')) {
                        await wizard.getByRole('button', { name: 'Continuer plus tard', exact: true }).click();
                        await page.waitForFunction(() => window.__qaPayrollImport.proof.pendingAck);
                        item.pending = await snapshot(page);
                        if (scenario === 'save-scope') {
                            await page.evaluate(() => window.__qaPayrollImport.switchVerifiedAccount());
                            await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).click();
                            await page.locator('.desktop-app').waitFor();
                            await screen(page, 'Clients');
                            await page.getByText('Client fictif B', { exact: true }).first().waitFor();
                        }
                        else {
                            await page.evaluate(() => window.__qaPayrollImport.makeReadOnly());
                            await page.getByText('Accès « Lecture seule » : consultation et exports autorisés, modifications bloquées sur ce poste.', { exact: true }).waitFor();
                        }
                        item.beforeRelease = await snapshot(page);
                        await page.evaluate(() => window.__qaPayrollImport.releaseAck());
                        await page.waitForTimeout(250);
                        item.after = await snapshot(page);
                        item.oracle = { noNewUpdateAfterLoss: item.after.proof.updateCalls === 1 };
                        item.defectReproduced = !item.oracle.noNewUpdateAfterLoss;
                        item.verdict = item.defectReproduced ? 'RED' : 'GREEN';
                        if (scenario === 'save-readonly' && !process.env.ZENTRA_QA_BASELINE_ROOT) {
                            await wizard.getByRole('button', { name: 'Fermer « Importer des fiches de salaire »', exact: true }).click();
                            await wizard.locator('.error-panel').waitFor();
                            assert.equal(await wizard.locator('.payroll-review-fields').first().locator('input').first().inputValue(), 'Synthetic edited employee two');
                            assert.equal((await snapshot(page)).proof.updateCalls, 1);
                            item.closeRefusalExplained = true;
                        }
                    }
                    else if (scenario === 'read-only') {
                        await page.evaluate(() => window.__qaPayrollImport.makeReadOnly());
                        await page.getByText('Accès « Lecture seule » : consultation et exports autorisés, modifications bloquées sur ce poste.', { exact: true }).waitFor();
                        item.before = await snapshot(page);
                        if (await confirm.isDisabled())
                            await confirm.evaluate(b => b.click());
                        else
                            await confirm.click();
                        await page.waitForTimeout(200);
                        item.after = await snapshot(page);
                        assert.equal(item.after.proof.confirmCalls, 0);
                        item.controlPassed = true;
                    }
                    else {
                        await confirm.click();
                        await page.waitForFunction(() => window.__qaPayrollImport.proof.confirmCalls === 1);
                        if (scenario === 'native-refused') {
                            await wizard.locator('.error-panel').waitFor();
                            item.after = await snapshot(page);
                            assert.equal(item.after.proof.confirmCalls, 1);
                            assert.equal(item.after.proof.confirmed, 0);
                            assert.equal(item.after.database.status, 'needs_review');
                            assert.equal(await wizard.locator('.payroll-review-fields').first().locator('input').first().inputValue(), 'Synthetic payroll employee');
                            assert.equal(item.after.dialog, true);
                            assert.equal(item.after.notice, undefined);
                            item.localError = await wizard.locator('.error-panel').innerText();
                            item.controlPassed = true;
                        }
                        else if (scenario === 'current') {
                            await wizard.waitFor({ state: 'detached' });
                            item.after = await snapshot(page);
                            assert.equal(item.after.proof.confirmCalls, 1);
                            assert.equal(item.after.database.status, 'confirmed');
                            item.controlPassed = true;
                        }
                        else if (scenario === 'fail-first') {
                            await page.waitForFunction(() => window.__qaPayrollImport.proof.reads.filter(r => r.afterAck).length === 2);
                            await page.waitForTimeout(250);
                            item.after = await snapshot(page);
                            item.oracle = { closedAfterConfirmedRead: !item.after.dialog, noRepeatButton: item.after.confirmDisabled !== false, oneConfirmedWrite: item.after.proof.confirmCalls === 1 };
                            item.defectReproduced = !item.oracle.closedAfterConfirmedRead;
                            item.verdict = item.defectReproduced ? 'RED' : 'GREEN';
                            await page.screenshot({ path: join(out, engine + '-fail-first.png'), fullPage: true });
                            if (item.defectReproduced) {
                                await confirm.click();
                                await page.waitForFunction(() => window.__qaPayrollImport.proof.confirmCalls === 2);
                                item.afterExplicitRepeat = await snapshot(page);
                            }
                        }
                        else if (['held', 'late-switch', 'all-fail'].includes(scenario)) {
                            await page.waitForFunction(() => window.__qaPayrollImport.proof.reads.some(r => r.afterAck && r.pending));
                            const id = await page.evaluate(() => window.__qaPayrollImport.proof.reads.find(r => r.afterAck && r.pending).id);
                            item.pending = await snapshot(page);
                            assert.equal(await confirm.isDisabled(), true);
                            assert.equal(item.pending.proof.confirmCalls, 1);
                            if (scenario === 'late-switch') {
                                await page.evaluate(() => window.__qaPayrollImport.switchVerifiedAccount());
                                await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).click();
                                await page.locator('.desktop-app').waitFor();
                                await screen(page, 'Clients');
                                await page.getByText('Client fictif B', { exact: true }).first().waitFor();
                                item.beforeRelease = await snapshot(page);
                                await page.evaluate(id => window.__qaPayrollImport.settle(id), id);
                                await page.waitForTimeout(200);
                                item.after = await snapshot(page);
                                assert.equal(item.after.company, 'SYNTHETIC COMPANY B');
                                assert.equal(item.after.proof.confirmCalls, 1);
                                item.controlPassed = true;
                            }
                            else if (scenario === 'all-fail') {
                                await page.evaluate(id => window.__qaPayrollImport.settle(id, true), id);
                                await page.waitForFunction(() => window.__qaPayrollImport.proof.reads.some(r => r.afterAck && r.pending));
                                const second = await page.evaluate(() => window.__qaPayrollImport.proof.reads.find(r => r.afterAck && r.pending).id);
                                await page.evaluate(id => window.__qaPayrollImport.settle(id, true), second);
                                await page.waitForTimeout(250);
                                item.after = await snapshot(page);
                                item.oracle = { recoveryReadOnlyOffered: item.after.recovery, mutationRemainsLocked: item.after.confirmDisabled !== false, oneConfirmedWrite: item.after.proof.confirmCalls === 1 };
                                item.defectReproduced = !item.oracle.recoveryReadOnlyOffered && item.after.confirmDisabled === false;
                                item.verdict = item.defectReproduced ? 'RED' : 'GREEN';
                                if (!process.env.ZENTRA_QA_BASELINE_ROOT) {
                                    assert.ok(item.after.recovery);
                                    assert.equal(item.after.confirmDisabled, true);
                                    const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
                                    await page.evaluate(() => window.__qaPayrollImport.begin('current'));
                                    await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
                                    await recovery.waitFor({ state: 'detached' });
                                    await wizard.waitFor({ state: 'detached' });
                                    item.recovered = await snapshot(page);
                                    assert.equal(item.recovered.proof.confirmCalls, 1);
                                    item.controlPassed = true;
                                }
                            }
                            else {
                                await page.evaluate(id => window.__qaPayrollImport.settle(id), id);
                                await wizard.waitFor({ state: 'detached' });
                                item.after = await snapshot(page);
                                assert.equal(item.after.proof.confirmCalls, 1);
                                item.controlPassed = true;
                            }
                        }
                        else if (['foreign', 'wrong-status'].includes(scenario)) {
                            await page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true }).waitFor();
                            item.after = await snapshot(page);
                            assert.equal(item.after.company, 'Atelier du Léman');
                            assert.equal(item.after.proof.confirmCalls, 1);
                            const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
                            await page.evaluate(() => window.__qaPayrollImport.begin('current'));
                            await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
                            await recovery.waitFor({ state: 'detached' });
                            await wizard.waitFor({ state: 'detached' });
                            item.recovered = await snapshot(page);
                            assert.equal(item.recovered.proof.confirmCalls, 1);
                            item.controlPassed = true;
                        }
                        else if (scenario === 'late-ack') {
                            await page.waitForFunction(() => window.__qaPayrollImport.proof.pendingAck);
                            await page.evaluate(() => window.__qaPayrollImport.switchVerifiedAccount());
                            await page.getByRole('button', { name: 'Ouvrir l’espace du compte', exact: true }).click();
                            await page.locator('.desktop-app').waitFor();
                            await screen(page, 'Clients');
                            await page.getByText('Client fictif B', { exact: true }).first().waitFor();
                            item.beforeRelease = await snapshot(page);
                            await page.evaluate(() => window.__qaPayrollImport.releaseAck());
                            await page.waitForTimeout(250);
                            item.after = await snapshot(page);
                            assert.equal(item.after.company, 'SYNTHETIC COMPANY B');
                            assert.equal(item.after.dialog, false);
                            assert.equal(item.after.proof.confirmCalls, 1);
                            assert.equal(item.after.recovery, false);
                            item.controlPassed = true;
                        }
                    }
                    assert.equal(item.errors.length, 0);
                    assert.equal(item.blockedRequests.length, 0);
                }
                catch (e) {
                    item.runnerFailure = e.stack;
                    item.failedState = await snapshot(page).catch(() => null);
                    await page.screenshot({ path: join(out, engine + '-' + scenario + '-failure.png'), fullPage: true });
                }
                finally {
                    await page.close();
                    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
                }
            }
        }
        finally {
            await browser.close();
        }
    }
}
finally {
    await server.close();
    report.finishedAt = new Date().toISOString();
    report.diskAfter = await hashes();
    report.diskSourcesChanged = Object.keys(report.diskBefore).filter(n => report.diskBefore[n] !== report.diskAfter[n]);
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ out, cases: report.cases.map(c => ({ engine: c.engine, scenario: c.scenario, verdict: c.verdict, control: c.controlPassed, error: c.runnerFailure })), diskSourcesChanged: report.diskSourcesChanged }, null, 2));
if (report.cases.some(c => c.runnerFailure || (!process.env.ZENTRA_QA_BASELINE_ROOT && c.defectReproduced)))
    process.exitCode = 1;
