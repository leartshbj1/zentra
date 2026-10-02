import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5275', folder = `.qa/settings-picker-lifecycle-${engine}`, report = [];
await mkdir(folder, { recursive: true });
let activePage;
async function navigate(page, name) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
}
async function category(page, id) { await page.locator(`[data-settings-link=${id}]`).click(); }
async function setup() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); activePage = page; page.setDefaultTimeout(15000);
  const errors = [], prompts = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); });
  await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&companyRealtime=1`);
  await page.waitForFunction(() => Boolean(window.__qaDesktopApi)); await navigate(page, 'Paramètres');
  await page.evaluate(() => {
    const api = window.__qaDesktopApi, save = api.saveSettings;
    window.__pickerAudit = { requests: [], writes: [], stages: [], restores: [] };
    api.saveSettings = async settings => { window.__pickerAudit.writes.push(structuredClone(settings)); return save(settings); };
    for (const kind of ['Folder', 'Logo', 'RestoreFile']) api[`choose${kind === 'Folder' ? 'BackupFolder' : kind}`] = () => new Promise((resolve, reject) => window.__pickerAudit.requests.push({ kind, resolve, reject }));
    api.stageCompanyLogo = async path => { window.__pickerAudit.stages.push(path); return 'company-logo-synthetic.png'; };
    api.restoreBackup = async path => { window.__pickerAudit.restores.push(path); return api.loadWorkspace(); };
  });
  return { page, errors, prompts };
}
async function picker(page, kind) {
  await category(page, kind === 'Logo' ? 'company' : 'storage');
  if (kind === 'Folder') await page.getByText('Options de sauvegarde', { exact: true }).click();
  await page.getByRole('button', { name: kind === 'Folder' ? 'Choisir le dossier' : kind === 'Logo' ? 'Choisir le logo' : 'Restaurer', exact: true }).click();
  await page.waitForFunction(() => window.__pickerAudit.requests.length > 0);
}
const finish = (page, index = 0, value = 'C:/synthetic-selection') => page.evaluate(({ index, value }) => window.__pickerAudit.requests[index].resolve(value), { index, value });
const snapshot = page => page.evaluate(async () => ({ settings: (await window.__qaDesktopApi.loadWorkspace()).settings, writes: window.__pickerAudit.writes, stages: window.__pickerAudit.stages, restores: window.__pickerAudit.restores }));
try {
  for (const kind of ['Folder', 'Logo', 'RestoreFile']) {
    const { page, errors, prompts } = await setup(); await picker(page, kind);
    await page.evaluate(() => { window.companyRealtimeFixture.renameCompany('Entreprise reçue pendant le sélecteur'); window.dispatchEvent(new CustomEvent('zentra-project-documents-changed', { detail: { userRequested: true } })); });
    await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'Entreprise reçue pendant le sélecteur');
    await finish(page); await page.waitForTimeout(200);
    const result = await snapshot(page);
    assert.equal(result.settings.organization.legalName, 'Entreprise reçue pendant le sélecteur');
    assert.deepEqual(result.writes, []); assert.deepEqual(result.stages, []); assert.deepEqual(result.restores, []); assert.deepEqual(errors, []); assert.deepEqual(prompts, []);
    report.push({ engine, kind, obsoleteReceiveResponseIgnored: true, currentSettingsPreserved: true, writes: 0 }); await page.close();
  }
  {
    const { page, errors } = await setup(); await picker(page, 'Folder');
    await page.locator('.settings-backup-confirmation input').check();
    await category(page, 'company'); await page.locator('[name=legalName]').fill('Entreprise modifiée pendant le choix'); await page.locator('[name=vatNumber]').fill('CHE-123.456.789 MWST');
    await page.getByRole('button', { name: 'Enregistrer l’entreprise', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sidebar__company strong')?.textContent === 'Entreprise modifiée pendant le choix');
    await finish(page); await page.waitForFunction(() => window.__pickerAudit.writes.length === 2);
    const result = await snapshot(page);
    assert.equal(result.settings.organization.legalName, 'Entreprise modifiée pendant le choix'); assert.equal(result.settings.backup.recoveryConfirmed, true); assert.equal(result.settings.backup.folder, 'C:/synthetic-selection'); assert.deepEqual(errors, []);
    report.push({ engine, latestSettingsMerged: true, otherSaveAndDraftPreserved: true }); await page.close();
  }
  {
    const { page, errors, prompts } = await setup(); await picker(page, 'Folder'); await navigate(page, 'Clients'); await finish(page); await page.waitForTimeout(200);
    assert.deepEqual((await snapshot(page)).writes, []); assert.deepEqual(errors, []); assert.deepEqual(prompts, []);
    report.push({ engine, obsoleteNavigationResponseIgnored: true }); await page.close();
  }
  {
    const { page, errors } = await setup(); await picker(page, 'Folder');
    await page.getByRole('button', { name: 'Choisir le dossier', exact: true }).click(); await page.waitForFunction(() => window.__pickerAudit.requests.length === 2);
    await finish(page, 1, 'C:/latest-folder'); await page.waitForFunction(() => window.__pickerAudit.writes.length === 1); await finish(page, 0, 'C:/obsolete-folder'); await page.waitForTimeout(200);
    const result = await snapshot(page); assert.equal(result.writes.length, 1); assert.equal(result.settings.backup.folder, 'C:/latest-folder'); assert.deepEqual(errors, []);
    report.push({ engine, latestConcurrentPickerWins: true, writes: 1 }); await page.close();
  }
  {
    const { page, errors } = await setup(); await picker(page, 'Logo');
    await page.evaluate(() => { window.__qaDesktopApi.stageCompanyLogo = path => new Promise(resolve => { window.__pickerAudit.stages.push(path); window.__pickerAudit.finishStage = () => resolve('staged-logo.png'); }); });
    await finish(page); await page.waitForFunction(() => Boolean(window.__pickerAudit.finishStage)); await navigate(page, 'Clients');
    await page.evaluate(() => window.__pickerAudit.finishStage()); await page.waitForTimeout(200);
    assert.deepEqual((await snapshot(page)).writes, []); assert.deepEqual(errors, []);
    const mutationLockReleased = await page.getByRole('button', { name: 'Nouveau client', exact: true }).isEnabled(); assert.equal(mutationLockReleased, true);
    report.push({ engine, obsoleteStagedLogoNotSaved: true, mutationLockReleased }); await page.close();
  }
  {
    const { page, errors } = await setup(); await picker(page, 'Logo');
    await page.evaluate(() => { window.__qaDesktopApi.stageCompanyLogo = async () => { throw Error('Synthetic logo copy failed'); }; });
    await finish(page); await page.locator('.notice--error').waitFor(); assert.deepEqual((await snapshot(page)).writes, []); assert.deepEqual(errors, []);
    report.push({ engine, actualLogoCopyFailureStillVisible: true, writes: 0 }); await page.close();
  }
  {
    const { page, errors } = await setup(); await picker(page, 'Folder'); await finish(page, 0, null); await page.waitForTimeout(100);
    await page.getByRole('button', { name: 'Choisir le dossier', exact: true }).click(); await page.waitForFunction(() => window.__pickerAudit.requests.length === 2);
    await page.evaluate(() => window.__pickerAudit.requests[1].reject(new Error('Synthetic picker unavailable')));
    await page.locator('.notice--error').waitFor(); assert.deepEqual((await snapshot(page)).writes, []); assert.deepEqual(errors, []);
    report.push({ engine, cancelledPickerWritesNothing: true, pickerFailureShownWithoutUnhandledError: true }); await page.close();
  }
} catch (error) { report.push({ error: String(error.stack || error) }); if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: `${folder}/failure.png` }); process.exitCode = 1; }
finally { await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); }
