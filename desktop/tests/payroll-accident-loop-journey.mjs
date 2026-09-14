import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/payroll-accident-loop';
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 1440]) for (const scenario of ['missing', 'new', 'duplicates']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(12000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      try {
        await page.goto(`${base}/tests/mobile-harness.html?payroll=1&payrollAccidentLoop=${scenario}`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
        await page.locator('.team-navigation').getByRole('button', { name: /Fiches de salaire/ }).click();
        await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
        const modal = page.locator('.payroll-dialog'), guide = modal.locator('.payroll-preparation'), setup = modal.locator('.payroll-setup');
        await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
        await modal.locator('[name=period]').fill('2026-09');
        await modal.locator('[name=paymentDate]').fill('2026-09-30');
        await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
        await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true }).fill('5123.45');
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await guide.waitFor();
        if (scenario !== 'duplicates') {
          await guide.getByRole('button', { name: 'Renseigner le nom de l’assureur', exact: true }).click();
          assert.equal(await setup.locator('[name=accidentInsurer]:visible').count(), 1);
          assert.equal(await setup.locator('[name=pensionFund]:visible, [name=contractNumber]:visible').count(), 0);
          await setup.locator('[name=accidentInsurer]').fill('Assureur accidents de recette');
          // A refused write must not claim success or erase the entered insurer.
          await page.evaluate(() => sessionStorage.setItem('qa-payroll-refuse-settings', '1'));
          await setup.getByRole('button', { name: 'Enregistrer et continuer', exact: true }).click();
          await setup.locator('.payroll-problem').waitFor();
          assert.equal(await setup.locator('[name=accidentInsurer]').inputValue(), 'Assureur accidents de recette');
          await page.evaluate(() => sessionStorage.removeItem('qa-payroll-refuse-settings'));
          await setup.getByRole('button', { name: 'Enregistrer et continuer', exact: true }).click();
          await guide.waitFor();
          const savedSettings = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-settings')).at(-1).payroll);
          assert.equal(savedSettings.pensionFund, 'Fondation de recette');
          assert.equal(savedSettings.avsFund, 'Caisse de recette');
          assert.equal(savedSettings.lppPlanEvidence.contractNumber, 'QA-LPP-2026');
        }
        if (scenario !== 'missing') {
          await guide.getByRole('button', { name: 'Ouvrir cette assurance', exact: true }).click();
          if (scenario === 'duplicates') {
            assert.equal(await setup.locator('.payroll-contracts form:visible').count(), 0);
            await setup.locator('.payroll-callout > div').filter({ hasText: 'AAP TEST' }).getByRole('button', { name: 'Utiliser cette cotisation', exact: true }).click();
          } else {
            const form = setup.locator('.payroll-contracts form:visible');
            await form.locator('[name=rate]').fill('1.20');
            await form.locator('[name=from]').fill('2026-09-15');
            await form.locator('[name=to]').fill('2026-12-31');
            await form.locator('[name=source]').fill('Police accidents QA 2026, classe de recette');
            await form.locator('input[type=checkbox]').check();
            await form.locator('[name=from]').fill('2026-10-01');
            await form.getByRole('button', { name: 'Enregistrer cette cotisation', exact: true }).click();
            await form.locator('[name=from][aria-invalid=true]').waitFor();
            assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-definition') || '[]').length), 0);
            await form.locator('[name=from]').fill('2026-09-15');
            await form.getByRole('button', { name: 'Enregistrer cette cotisation', exact: true }).click();
          }
          await guide.waitFor();
        }
        await guide.getByRole('button', { name: 'Calculer le net', exact: true }).click();
        await modal.locator('[data-payroll-step="2"]:visible').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `${output}/${engine}-${width}-${scenario}.png` });
        await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        const result = await page.evaluate(() => ({ save: JSON.parse(sessionStorage.getItem('qa-payroll-save')), calculate: JSON.parse(sessionStorage.getItem('qa-payroll-calculate')), writes: JSON.parse(sessionStorage.getItem('qa-payroll-definition') || '[]') }));
        assert.equal(result.save.length, 1);
        assert.equal(result.save[0].lines[0].amountCents, 512345);
        assert.equal(result.writes.length, scenario === 'new' ? 1 : 0);
        const selection = result.calculate.at(-1).items.filter(item => item.definitionId.startsWith('AAP') || result.writes.some(d => d.category === 'aap' && d.id === item.definitionId));
        assert.equal(selection.length, 1);
        assert.equal(selection[0].basisCents, 512345);
        assert.deepEqual(errors, []);
        reports.push({ engine, width, scenario, payslipCreated: true, aapCount: 1, duplicateWrites: false });
      } catch (error) {
        await page.screenshot({ path: `${output}/failure.png` });
        await writeFile(`${output}/failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`);
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
console.log(JSON.stringify({ result: 'PASS', reports }));
