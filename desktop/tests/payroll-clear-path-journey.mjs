// Synthetic UI acceptance: monthly salary, focused corrections and interrupted reads.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5196';
const output = '.qa/payroll-clear-path';
await mkdir(output, { recursive: true });
const report = [];
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${base}/tests/mobile-harness.html?payroll=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
        await page.locator('.team-navigation').getByRole('button', { name: /Fiches de salaire/ }).click();
        await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
        const modal = page.locator('.payroll-dialog');
        const button = name => modal.getByRole('button', { name, exact: true });
        await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
        await modal.locator('[name=period]').fill('2026-09');
        await button('Continuer').click();
        const salary = modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true });
        await salary.fill('5123.45');
        await modal.getByText('Vous pouvez calculer le net', { exact: true }).waitFor();
        assert.equal(await modal.locator('[data-payroll-selection]').getAttribute('open'), null);
        assert.equal(await button('Mes caisses et assurances').isVisible(), false);
        assert.match(await modal.locator('.payroll-current-person').innerText(), /Élodie Dubois.*septembre 2026/);
        await page.screenshot({ path: `${output}/${engine}-${width}-salary.png` });

        // Editing an insurance from the salary also opens one question at a time.
        await modal.getByText('Mes cotisations et assurances', { exact: true }).click();
        await button('Mes caisses et assurances').click();
        const setup = modal.locator('.payroll-setup');
        assert.equal(await setup.locator('.payroll-setup-nav').isVisible(), false);
        await setup.locator('[name=avsFund]').fill('Caisse AVS de recette corrigée');
        await setup.getByRole('button', { name: 'Continuer', exact: true }).click();
        assert.equal(await setup.locator('[name=avsFund]').isVisible(), false);
        await page.evaluate(() => sessionStorage.setItem('qa-payroll-fail-rates', '1'));
        await setup.getByRole('button', { name: 'Enregistrer et continuer', exact: true }).click();
        await setup.waitFor({ state: 'hidden' });
        const recovery = modal.getByRole('region', { name: 'Reprendre le chargement' });
        await recovery.waitFor();
        assert.equal(await salary.inputValue(), '5123.45');
        assert.equal(await button('Vérifier le salaire').isEnabled(), false);
        await button('Réessayer le chargement').click();
        await button('Réessayer le chargement').waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('.payroll-load-recovery > button')?.disabled);
        assert.equal(await button('Vérifier le salaire').isEnabled(), false);
        await page.evaluate(() => sessionStorage.removeItem('qa-payroll-fail-rates'));
        await button('Réessayer le chargement').click();
        await recovery.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-settings')).length), 1, 'Read retries cannot save the insurance again');
        await button('Vérifier le salaire').click();
        await modal.locator('[data-payroll-step="2"]:visible').waitFor();
        assert.equal(await button('Enregistrer le salaire en brouillon').isVisible(), false, 'A calculated review has one save path');
        await modal.locator('[name=notes]').fill('Salaire de septembre\nNotes conservées pendant les corrections');

        // A native refusal must point back to the salary line, not the insurance setup.
        await page.evaluate(() => sessionStorage.setItem('qa-payroll-refuse-line-once', '1'));
        await button('Enregistrer la fiche').click();
        await button('Compléter la ligne concernée').click();
        assert.equal(await modal.locator('.pay-line-list').isVisible(), true);
        assert.equal(await salary.inputValue(), '5123.45');
        await salary.fill('5250');
        await button('Vérifier le salaire').click();
        await modal.locator('[data-payroll-step="2"]:visible').waitFor();
        assert.match(await modal.locator('[name=notes]').inputValue(), /Notes conservées/);
        const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
          overflow: [...document.querySelectorAll('.payroll-dialog,.modal__body,.payroll-month-overview,.payroll-load-recovery')]
            .filter(node => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1).map(node => node.className) }));
        assert.ok(geometry.width <= geometry.viewport && !geometry.overflow.length, JSON.stringify(geometry));
        await page.screenshot({ path: `${output}/${engine}-${width}-review.png` });
        await button('Enregistrer la fiche').click();
        await modal.waitFor({ state: 'hidden' });
        const saves = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save')));
        assert.equal(saves.length, 1);
        assert.equal(saves[0].lines[0].amountCents, 525000);
        assert.ok(saves[0].selections.length > 0);
        assert.equal(saves[0].data.status, 'incomplete', 'Editing insurance must not silently validate payroll');
        assert.deepEqual(errors, []);
        report.push({ engine, width, focusedSalary: true, guidedCorrection: true, readRecovery: true, oneSavedPayslip: true });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        await writeFile(`${output}/failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`);
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
