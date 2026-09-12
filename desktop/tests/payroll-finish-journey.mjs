// Synthetic acceptance: correct pension fields in place, keep the salary, then reach PDF export.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5267';
const output = '.qa/payroll-finish';
await mkdir(output, { recursive: true });
const reports = [];
async function team(page) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
  await page.locator('.team-navigation').getByRole('button', { name: /Fiches de salaire/ }).click();
}
async function geometry(page) {
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.modal,.modal__body,.payroll-setup,.payslip-list,.payroll-inline-error')]
    .filter(node => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1).map(node => node.className)), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}
for (const [engine, type] of (process.env.ZENTRA_QA_SMOKE ? [['edge', chromium]] : [['edge', chromium], ['webkit', webkit]])) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of (process.env.ZENTRA_QA_SMOKE ? [320] : [320, 390, 1440])) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(16000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      try {
        await page.goto(`${base}/tests/mobile-harness.html?payroll=1&payrollPensionSetup=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await team(page);
        await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
        const modal = page.locator('.payroll-dialog'), guide = modal.locator('.payroll-preparation'), setup = modal.locator('.payroll-setup');
        const button = name => setup.getByRole('button', { name, exact: true });
        await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
        await modal.locator('[name=period]').fill('2026-09');
        await modal.locator('[name=paymentDate]').fill('2026-10-01');
        await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
        const salary = modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true, includeHidden: true });
        await salary.fill('5123.45');
        await modal.getByText('Mes cotisations et assurances', { exact: true }).click();
        await modal.getByText('Vérifier les cotisations et leurs bases', { exact: true }).click();
        await modal.locator('.contribution-selection-list > article').filter({ hasText: 'AANP_TEST' }).getByRole('spinbutton', { name: /^Base de calcul/ }).fill('5000');
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await guide.getByRole('button', { name: 'Renseigner le salaire annuel', exact: true }).click();
        await setup.locator('[name=lppAnnualSalary]').fill('60000');
        await button('Enregistrer et continuer').click();
        await guide.getByRole('button', { name: 'Compléter la caisse de pension', exact: true }).click();
        await button('Enregistrer et continuer').click();
        await setup.locator('[name=pensionFund][aria-invalid=true]').waitFor();
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-settings') || '[]').length), 0);
        await setup.locator('[name=pensionFund]').fill('Caisse pension de recette');
        assert.equal(await setup.locator('[name=pensionFund]').inputValue(), 'Caisse pension de recette');
        await setup.locator('[name=contractNumber]').fill('PENSION-TEST-2026');
        await setup.locator('[name=regulationReference]').fill('Bref');
        await setup.locator('[name=lppFrom]').fill('2026-01-01');
        await setup.locator('[name=lppTo]').fill('2026-12-31');
        await setup.locator('[name=lppParity]').check();
        await button('Enregistrer et continuer').click();
        await setup.locator('[name=regulationReference][aria-invalid=true]').waitFor();
        await setup.locator('.payroll-inline-error').getByText(/titre précis/).waitFor();
        await setup.locator('[name=regulationReference]').fill('Règlement de prévoyance TEST 2026');
        await setup.locator('.payroll-inline-error').waitFor({ state: 'detached' });
        await setup.locator('[name=lppTo]').fill('2025-12-31');
        await button('Enregistrer et continuer').click();
        await setup.locator('.payroll-inline-error').getByText(/avant le début/).waitFor();
        await setup.locator('[name=lppTo]').fill('2026-09-30');
        await button('Enregistrer et continuer').click();
        await setup.locator('[name=lppTo][aria-invalid=true]').waitFor();
        await setup.locator('.payroll-inline-error').getByText(/01.10.2026/).waitFor();
        assert.equal(await setup.locator('[name=contractNumber]').inputValue(), 'PENSION-TEST-2026');
        assert.equal(await salary.inputValue(), '5123.45');
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-settings') || '[]').length), 0);
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-date-correction.png` });
        await setup.locator('[name=lppTo]').fill('2026-12-31');
        await button('Enregistrer et continuer').click();
        await guide.getByRole('button', { name: 'Régler les montants de pension', exact: true }).click();
        const pair = setup.locator('.payroll-pension-pair');
        await pair.locator('[name=employee]').fill('245.50');
        await pair.locator('[name=employer]').fill('260');
        await pair.locator('[name=component]').selectOption('combined');
        await pair.locator('input[type=checkbox]').check();
        await page.evaluate(() => sessionStorage.setItem('qa-payroll-fail-rates-after-pension', '1'));
        await pair.getByRole('button', { name: 'Enregistrer les deux montants', exact: true }).click();
        await modal.getByRole('region', { name: 'Reprendre le chargement' }).waitFor();
        assert.equal(await guide.getByRole('button', { name: 'Calculer le net', exact: true }).count(), 0);
        await page.evaluate(() => sessionStorage.removeItem('qa-payroll-fail-rates'));
        await modal.getByRole('button', { name: 'Réessayer le chargement', exact: true }).click();
        await guide.getByRole('button', { name: 'Calculer le net', exact: true }).click();
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-definition')).filter(d => d.category === 'lpp').length), 2);
        await modal.locator('[data-payroll-step="2"]:visible').waitFor();
        await modal.locator('[name=notes]').fill('Recette : salaire conservé après correction');
        await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        const savedId = await page.evaluate(() => sessionStorage.getItem('qa-payroll-saved-id'));
        let row = page.locator(`[data-payslip-id="${savedId}"]`);
        await row.getByRole('button', { name: 'Contrôler la fiche', exact: true }).waitFor();
        assert.equal(await row.getByRole('button', { name: 'Voir le PDF', exact: true }).count(), 0);
        await row.scrollIntoViewIfNeeded();
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-saved.png` });
        await page.getByRole('button', { name: 'Ouvrir les paramètres de paie', exact: true }).click();
        const validation = page.locator('#settings-payroll-review');
        await validation.waitFor();
        assert.equal(await validation.isChecked(), false, 'A correction must never claim a fiduciary review');
        await page.waitForFunction(() => document.activeElement?.id === 'settings-payroll-review');
        await page.waitForFunction(() => {
          const field = document.getElementById('settings-payroll-review')?.closest('label')?.getBoundingClientRect();
          const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
          const dock = document.querySelector('.mobile-navigation')?.getBoundingClientRect();
          return field && field.top >= top && field.bottom <= (dock?.height ? dock.top : innerHeight);
        });
        await page.screenshot({ path: `${output}/${engine}-${width}-review-settings.png` });
        // This is a synthetic enterprise: explicitly confirm the review in its test data.
        await validation.check();
        await page.getByRole('button', { name: 'Enregistrer la paie', exact: true }).click();
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-payroll-settings')).at(-1)?.payroll.fiduciaryValidated === true);
        await team(page);
        row = page.locator(`[data-payslip-id="${savedId}"]`);
        await row.getByRole('button', { name: 'Contrôler la fiche', exact: true }).click();
        await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
        assert.equal(await salary.inputValue(), '5123.45');
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await modal.locator('[name=validated]').check();
        await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        await row.getByRole('button', { name: 'Voir le PDF', exact: true }).click();
        await page.getByText('Aperçu de la fiche détaillée', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Exporter le PDF', exact: true }).click();
        await page.getByRole('button', { name: 'Partager le PDF', exact: true }).waitFor();
        const saves = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save')));
        assert.equal(saves.length, 2);
        assert.equal(saves[1].existingId, savedId);
        assert.equal(saves[1].selections.length, 13);
        assert.equal(saves[1].selections.find(selection => selection.definitionId === 'AANP_TEST').basisCents, 500000, 'An existing manual basis survives all setup corrections');
        assert.equal(saves[1].data.status, 'validated');
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-pdf.png` });
        assert.deepEqual(errors, []);
        reports.push({ engine, width, precisePensionFields: true, datesValidatedBeforeWrite: true, readRetryWithoutDuplicate: true, samePayslip: true, reviewToPdf: true });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        await writeFile(`${output}/failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`);
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
