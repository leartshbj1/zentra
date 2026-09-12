import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5269';
const output = '.qa/opening-lazy';
await mkdir(output, { recursive: true });
const report = [];
async function navigate(page, label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
}
async function payroll(page) {
  await navigate(page, 'Équipe & salaires');
  await page.locator('.team-navigation').getByRole('button', { name: /Fiches de salaire/ }).click();
  await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
}
async function start(page) {
  await page.goto(`${base}/tests/mobile-harness.html?browsing=1&design=1&payroll=1`);
  await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
}
async function settled(page) {
  await page.waitForFunction(() => ![...document.querySelectorAll('.deferred-view,.settings-cloud-status')].some(node => node.getClientRects().length && /Ouverture|Cet écran n’a pas/.test(node.textContent)));
}
for (const [engine, type] of (process.env.ZENTRA_QA_SMOKE ? [['edge', chromium]] : [['edge', chromium], ['webkit', webkit]])) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of (process.env.ZENTRA_QA_SMOKE ? [390] : [320, 390, 1440])) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(16000);
      const errors = [], requests = [], external = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', request => requests.push(new URL(request.url()).pathname));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) && /^https?:$/.test(url.protocol)) { external.push(url.origin); return route.abort(); }
        return route.continue();
      });
      try {
        await start(page);
        for (const name of ['DetailedPayslipForm', 'DocumentEditor', 'CatalogScreen', 'SalesOrdersScreen', 'DocumentDesignStudio']) {
          assert.equal(requests.some(url => url.endsWith(`/src/${name}.tsx`)), false, `${name} must not load for the dashboard`);
        }
        await navigate(page, 'Paramètres');
        assert.equal(requests.some(url => url.endsWith('/src/PayrollContributionsPanel.tsx')), false, 'Closed payroll settings stay deferred');
        await page.locator('[data-settings-link=payroll]').click();
        await page.locator('.payroll-definitions').waitFor();
        assert.equal(requests.some(url => url.endsWith('/src/PayrollContributionsPanel.tsx')), true);

        let release;
        const hold = new Promise(resolve => { release = resolve; });
        let payrollReads = 0;
        await page.route('**/src/DetailedPayslipForm.tsx*', async route => { payrollReads++; await hold; await route.continue(); });
        await payroll(page);
        await page.getByRole('dialog', { name: 'Ouverture de la fiche de salaire…', exact: true }).waitFor();
        await page.screenshot({ path: `${output}/${engine}-${width}-loading.png` });
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('dialog').count(), 0, 'A slow module never traps the user');
        release();
        await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
        const modal = page.locator('.payroll-dialog');
        await modal.waitFor();
        await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
        await modal.locator('[name=period]').fill('2026-09');
        await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
        await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true }).fill('5123.45');
        await modal.getByRole('button', { name: 'Enregistrer le salaire en brouillon', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        assert.equal(payrollReads, 1, 'The same in-flight module serves a reopened dialog');
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save'))[0].lines[0].amountCents), 512345);

        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        const labels = await page.locator('.navigation-palette__results button strong').allTextContents();
        await page.keyboard.press('Escape');
        for (const label of labels) {
          await navigate(page, label);
          await settled(page);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} overflows ${width}px`);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, [], 'Screens use only local assets in this native-style fixture');
        report.push({ engine, width, deferredAtStartup: true, settingsOnDemand: true, cancelAndReopen: true, oneModuleRequest: true, draftSaved: true, localScreens: labels.length });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        await writeFile(`${output}/failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`);
        throw error;
      } finally { await page.close(); }
    }
    // React StrictMode, a failed load, retries and a late resolution after closing.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    try {
      await page.goto(`${base}/tests/deferred-view-harness.html`);
      await page.getByLabel('Notes du formulaire précédent').fill('Notes de paie conservées');
      await page.getByRole('button', { name: 'Ouvrir une fiche', exact: true }).click();
      await page.getByRole('dialog', { name: 'Ouverture de la fiche…', exact: true }).waitFor();
      await page.evaluate(() => { window.deferredFixture.fail = true; window.deferredFixture.release(); });
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByLabel('Notes du formulaire précédent', { exact: true }).inputValue(), 'Notes de paie conservées');
      assert.equal(await page.evaluate(() => window.deferredFixture.calls), 1);
      await page.getByRole('button', { name: 'Réessayer l’ouverture', exact: true }).click();
      await page.waitForFunction(() => window.deferredFixture.calls === 2);
      assert.ok(await page.evaluate(() => !!document.activeElement.closest('[role=dialog]')), 'Retry retains focus inside the loading dialog');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0, 'Retry can be cancelled with the keyboard');
      await page.evaluate(() => { window.deferredFixture.fail = false; window.deferredFixture.changeEmployee('Alex'); window.deferredFixture.release(); });
      await page.waitForFunction(() => window.deferredFixture.loaded);
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.getByRole('button', { name: 'Ouvrir une fiche', exact: true }).click();
      await page.getByRole('dialog', { name: 'La fiche de Alex', exact: true }).waitFor();
      await page.getByLabel('Notes de la fiche', { exact: true }).fill('Champ déjà rempli');
      await page.evaluate(() => window.deferredFixture.changeEmployee('Camille'));
      assert.equal(await page.getByLabel('Notes de la fiche', { exact: true }).inputValue(), 'Champ déjà rempli', 'Prop changes do not remount the loaded editor');
      assert.equal(await page.evaluate(() => window.deferredFixture.calls), 2);
      report.push({ engine, strictModeDedupe: true, retryKeepsParentDraft: true, lateResolutionStaysClosed: true, loadedEditorNotRemounted: true });
    } catch (error) {
      await page.screenshot({ path: `${output}/${engine}-retry-failure.png` });
      await writeFile(`${output}/${engine}-retry-failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`);
      throw error;
    } finally { await page.close(); }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
