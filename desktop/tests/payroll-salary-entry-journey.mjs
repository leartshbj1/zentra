// Synthetic interactions; no real employee or account is used.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5196';
const output = '.qa/payroll-salary-entry';
await mkdir(output, { recursive: true });
const reports = [];
async function open(page, flags) {
  await page.goto(`${base}/tests/mobile-harness.html?payroll=1${flags}`);
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).waitFor();
  const tutorial = page.getByRole('button', { name: 'Fermer le guide automatique', exact: true });
  if (await tutorial.isVisible()) await tutorial.click();
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
  await page.locator('.team-navigation').getByRole('button', { name: /Fiches de salaire/ }).click();
  await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
  const modal = page.locator('.payroll-dialog');
  await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
  await modal.locator('[name=period]').fill('2026-09');
  await modal.locator('[name=paymentDate]').fill('2026-09-30');
  await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
  return modal;
}
async function geometry(page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('.payroll-dialog,.modal__body,.payroll-basis-guide,.payroll-hourly')]
      .filter(node => node.getBoundingClientRect().width && node.scrollWidth > node.clientWidth + 1).map(node => node.className) }));
  assert.ok(dimensions.document <= dimensions.width && !dimensions.overflowing.length, JSON.stringify(dimensions));
}
async function answerBases(modal, amount) {
  const guide = modal.locator('.payroll-basis-guide');
  const titles = [];
  for (let turn = 0; turn < 10; turn++) {
    if (await guide.getByRole('button', { name: 'Continuer vers mon salaire', exact: true }).count()) break;
    titles.push(await guide.locator('h4').innerText());
    await guide.getByRole('textbox', { name: 'Salaire soumis à cette assurance (CHF)', exact: true }).fill(amount);
    if (turn === 1) {
      await guide.getByRole('button', { name: 'Précédent', exact: true }).click();
      assert.equal(await guide.getByRole('textbox').inputValue(), amount);
      await guide.getByRole('button', { name: 'Confirmer ce montant', exact: true }).click();
      assert.equal(await guide.getByRole('textbox').inputValue(), amount, 'Going back must preserve the unconfirmed answer too');
    }
    await guide.getByRole('button', { name: 'Confirmer ce montant', exact: true }).click();
  }
  assert.deepEqual(titles, ['AVS, AI et APG', 'Assurance chômage', 'Accidents au travail', 'Accidents hors travail', 'Caisse d’allocations familiales']);
  await guide.getByRole('button', { name: 'Continuer vers mon salaire', exact: true }).click();
}
for (const [engine, browserType] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        let modal = await open(page, '&payrollAhvBasis=1');
        await modal.getByText('Ajouter ou modifier un complément de salaire', { exact: true }).click();
        await modal.getByRole('button', { name: 'Ajouter un élément', exact: true }).click();
        await modal.getByRole('textbox', { name: 'Libellé de la ligne 2', exact: true }).fill('Prime de septembre');
        await modal.getByRole('spinbutton', { name: 'Montant de la ligne 2 (CHF)', exact: true }).fill('250');
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        const guide = modal.locator('.payroll-basis-guide');
        await guide.getByRole('button', { name: 'Confirmer ce montant', exact: true }).click();
        await guide.getByRole('alert').waitFor();
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-basis.png` });
        assert.equal(await guide.getByRole('textbox').inputValue(), '');
        await answerBases(modal, '5250');
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await modal.locator('.payroll-net').waitFor();
        let last = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-calculate')).at(-1));
        assert.equal(last.grossCents, 525000);
        assert.equal(last.items.filter(item => item.basisCents === 525000).length, 11);
        await modal.getByRole('button', { name: 'Retour', exact: true }).click();
        await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true }).fill('5100');
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await guide.getByRole('heading', { name: 'Le salaire a changé. Vérifions les montants.', exact: true }).waitFor();
        assert.equal(await guide.getByRole('textbox').inputValue(), '5250.00');
        await answerBases(modal, '5350');
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await modal.locator('[name=notes]').fill('Prime confirmée\nNotes conservées après correction.');
        await page.evaluate(() => sessionStorage.setItem('qa-payroll-refuse-save', '1'));
        await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
        await modal.locator('.payroll-problems:visible .payroll-problem').first().waitFor();
        assert.equal(await modal.locator('[name=notes]').inputValue(), 'Prime confirmée\nNotes conservées après correction.');
        await page.evaluate(() => sessionStorage.removeItem('qa-payroll-refuse-save'));
        await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save')).at(-1));
        assert.deepEqual(saved.lines.map(line => line.amountCents), [510000, 25000]);
        assert.equal(saved.selections.filter(item => item.basisCents === 535000).length, 11);
        reports.push({ engine, width, supplement: true, sharedBases: true, changedSalaryRequiresReview: true, refusedSavePreservesDraft: true });

        // Fresh page: no hourly wage is inferred from internal project cost.
        modal = await open(page, '&payrollHourly=1');
        const hourly = modal.locator('.payroll-hourly');
        assert.equal(await hourly.getByRole('textbox', { name: 'Tarif brut par heure (CHF)', exact: true }).inputValue(), '');
        await hourly.getByRole('button', { name: 'Utiliser ce montant', exact: true }).click();
        assert.equal(await hourly.getByRole('alert').count(), 2);
        await hourly.getByRole('textbox', { name: 'Heures à payer ce mois', exact: true }).fill('152,50');
        await hourly.getByRole('textbox', { name: 'Tarif brut par heure (CHF)', exact: true }).fill('30,25');
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-hourly.png` });
        await hourly.getByRole('button', { name: 'Utiliser ce montant', exact: true }).click();
        assert.equal(await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true }).inputValue(), '4613.13');
        await hourly.getByRole('textbox', { name: 'Heures à payer ce mois', exact: true }).fill('155');
        const calculationsBefore = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-calculate') || '[]').length);
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await modal.getByText('Reportez les heures dans le salaire', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-calculate') || '[]').length), calculationsBefore);
        await modal.getByRole('button', { name: 'Revenir au calcul des heures', exact: true }).click();
        assert.equal(await hourly.getByRole('textbox', { name: 'Heures à payer ce mois', exact: true }).inputValue(), '155');
        await hourly.getByRole('button', { name: 'Utiliser ce montant', exact: true }).click();
        await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
        await modal.locator('.payroll-net').waitFor();
        await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        const hourlySaved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save')).at(-1));
        assert.equal(hourlySaved.lines.length, 1);
        assert.equal(hourlySaved.lines[0].amountCents, 468875);
        assert.equal(hourlySaved.lines[0].label, 'Salaire horaire · 155 h × 30,25 CHF');
        assert.deepEqual(errors, []);
        reports.push({ engine, width, hourly: true, noCostUsedAsWage: true, replacementWithoutDuplicate: true });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
