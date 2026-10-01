import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5275', folder = `.qa/scoped-form-drafts-${engine}`, report = [];
await mkdir(folder, { recursive: true });
let activePage;
try {
for (const storageUnavailable of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); activePage = page; page.setDefaultTimeout(15000);
  const errors = [], closePrompts = []; let acceptClosure = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { if (dialog.message().startsWith('Créer une version')) await dialog.accept(); else { closePrompts.push(dialog.message()); if (acceptClosure) await dialog.accept(); else await dialog.dismiss(); } });
  await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&formDrafts=1`);
  await page.waitForFunction(() => Boolean(window.__qaFormDraftRefresh));
  await page.evaluate(async () => {
    const api = window.__qaDesktopApi, workspace = await api.loadWorkspace(), template = workspace.quotes[0];
    const issued = { ...template, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', number: 'D-RACE', title: 'Devis émis à réviser', status: 'issued' };
    const other = { ...template, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', number: '', title: 'Autre devis brouillon', status: 'draft' };
    const revision = { ...template, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', number: '', title: 'Nouvelle révision correcte', status: 'draft' };
    workspace.quotes = [issued, other]; workspace.invoices = []; workspace.salesOrders = [];
    api.loadWorkspace = async () => structuredClone(workspace);
    api.createQuoteRevision = async () => { workspace.quotes.push(revision); return { revisionId: revision.id }; };
    await window.__qaFormDraftRefresh();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args) => new Promise(resolve => { window.__releaseRevisionPreparation = () => { crypto.subtle.digest = digest; resolve(digest(...args)); }; });
  });
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Devis');
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Devis', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Créer une version modifiable du devis D-RACE', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__releaseRevisionPreparation));
  await page.getByRole('button', { name: 'Modifier le devis Autre devis brouillon', exact: true }).click();
  if (storageUnavailable) await page.evaluate(() => {
    const original = { get: Storage.prototype.getItem, set: Storage.prototype.setItem, remove: Storage.prototype.removeItem };
    // The existing revision-attempt registry remains usable so the real mutation can finish.
    // Every form-draft operation is denied, including reads, writes and removal.
    for (const [method, operation] of [['getItem', 'get'], ['setItem', 'set'], ['removeItem', 'remove']]) {
      Storage.prototype[method] = function (key, ...args) { if (key === 'zentra.quote-revision-attempts.v1') return original[operation].call(this, key, ...args); throw Error('All form recovery storage operations denied'); };
    }
  });
  let dialog = page.getByRole('dialog'); await dialog.locator('[name=title]').fill('Saisie privée du devis B');
  await page.evaluate(() => window.__releaseRevisionPreparation());
  await page.getByText('Le devis D-RACE est conservé dans l’historique. Sa nouvelle version est prête à être modifiée.', { exact: true }).waitFor();
  assert.equal(await dialog.locator('[name=title]').inputValue(), 'Saisie privée du devis B', 'a finished revision preserves the intervening form');
  if (storageUnavailable) await page.evaluate(() => { for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = () => { throw Error('All storage operations denied'); }; });
  await dialog.locator('[name=title]').fill('Dernière frappe privée du devis B é');
  assert.equal(await dialog.locator('[name=title]').inputValue(), 'Dernière frappe privée du devis B é');
  await page.screenshot({ path: `${folder}/${storageUnavailable ? 'unavailable' : 'healthy'}-intervening-form.png` });
  await page.keyboard.press('Escape');
  if (storageUnavailable) {
    assert.equal(closePrompts.length, 1); assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.locator('[name=title]').inputValue(), 'Dernière frappe privée du devis B é', 'declining closure retains the unsaved final keystroke');
    acceptClosure = true; await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(closePrompts.length, 2);
  } else {
    await dialog.waitFor({ state: 'hidden' }); assert.equal(closePrompts.length, 0);
    await page.getByRole('button', { name: 'Modifier le devis Nouvelle révision correcte', exact: true }).click(); dialog = page.getByRole('dialog');
    assert.equal(await dialog.locator('[name=title]').inputValue(), 'Nouvelle révision correcte', 'opening the revised record mounts its own values');
    await dialog.locator('[name=title]').fill('Saisie privée de la révision C');
    const records = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('zentra.forms.drafts.v1.')).map(([key, value]) => ({ scope: decodeURIComponent(key.substring('zentra.forms.drafts.v1.'.length)), value: JSON.parse(value).value })));
    assert.equal(records.length, 2, 'each record keeps its own draft');
    assert.equal(records.find(record => record.scope.includes('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))?.value.documentTitle, 'Dernière frappe privée du devis B é');
    assert.equal(records.find(record => record.scope.includes('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))?.value.documentTitle, 'Saisie privée de la révision C');
  }
  assert.deepEqual(errors, []);
  report.push({ engine, storageUnavailable, interveningFormPreserved: true, finalKeystrokePreserved: true, explicitClosure: true, ...(!storageUnavailable ? { distinctDraftKeys: true, distinctFormValues: true } : {}) }); await page.close();
}
} catch (error) { report.push({ error: String(error.stack || error) }); if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: `${folder}/failure.png` }); process.exitCode = 1; }
finally { await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); }
