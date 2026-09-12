// Synthetic browser acceptance. Native payroll tests cover the financial engine.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5194';
const output = '.qa/payroll-first-payslip';
await mkdir(output, { recursive: true });
const reports = [];
async function openPayroll(page, flags = '') {
  await page.goto(`${base}/tests/mobile-harness.html?payroll=1${flags}`);
  await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
  await page.locator('.team-navigation').getByRole('button', { name: /Fiches de salaire/ }).click();
  await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
  return page.locator('.payroll-dialog');
}
async function start(page, modal) {
  await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
  await modal.locator('[name=period]').fill('2026-09');
  await modal.locator('[name=paymentDate]').fill('2026-09-30');
  await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
  await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true }).fill('5123.45');
  await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
}
async function geometry(page) {
  const result = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('.payroll-dialog,.modal__body,.payroll-preparation,.payroll-setup')]
      .filter(node => node.getBoundingClientRect().width && node.scrollWidth > node.clientWidth + 1)
      .map(node => node.className),
  }));
  assert.ok(result.document <= result.viewport && !result.overflowing.length, JSON.stringify(result));
}
for (const [engine, browserType] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      try {
        const modal = await openPayroll(page, '&payrollSetup=1&payrollPensionSetup=1&payrollNoFederal=1');
        const guide = modal.locator('.payroll-preparation'), setup = modal.locator('.payroll-setup');
        const button = name => setup.getByRole('button', { name, exact: true });
        await start(page, modal);
        await guide.waitFor();
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-preparation.png` });
        await guide.getByRole('button', { name: 'Compléter le collaborateur', exact: true }).click();
        assert.equal(await setup.locator('input:visible').count(), 1);
        await setup.locator('[name=birthDate]').fill('1990-01-01');
        await button('Continuer').click();
        await setup.locator('[name=weeklyHours]').fill('40');
        await button('Continuer').click();
        await setup.locator('[name=lppAnnualSalary]').fill('60000');
        await page.evaluate(() => sessionStorage.setItem('qa-payroll-fail-rates', '1'));
        await button('Enregistrer et continuer').click();
        await guide.waitFor();
        await modal.getByRole('region', { name: 'Reprendre le chargement' }).waitFor();
        assert.equal(await guide.getByText('Préparation terminée', { exact: true }).count(), 0);
        await modal.getByRole('button', { name: 'Réessayer le chargement', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.payroll-load-recovery > button')?.disabled);
        assert.equal(await guide.locator('.payroll-preparation__next > button:enabled').count(), 0);
        await page.evaluate(() => sessionStorage.removeItem('qa-payroll-fail-rates'));
        await modal.getByRole('button', { name: 'Réessayer le chargement', exact: true }).click();
        await modal.getByRole('region', { name: 'Reprendre le chargement' }).waitFor({ state: 'hidden' });
        const actions = [];
        for (let turn = 0; turn < 12; turn++) {
          if (await guide.getByRole('button', { name: 'Calculer le net', exact: true }).count()) break;
          const next = guide.locator('.payroll-preparation__next > button');
          const label = await next.innerText(); actions.push(label.trim());
          await next.click();
          if (label.includes('Utiliser ces cotisations')) continue;
          if (await setup.locator('[name=contractNumber]:visible').count()) {
            assert.equal(await setup.locator('[name=avsFund]:visible').count(), 0);
            await setup.locator('[name=pensionFund]').fill('Fondation de recette');
            await setup.locator('[name=contractNumber]').fill('QA-LPP-2026');
            await setup.locator('[name=regulationReference]').fill('Règlement de prévoyance QA 2026');
            await setup.locator('[name=lppFrom]').fill('2026-01-01');
            await setup.locator('[name=lppTo]').fill('2026-12-31');
            await setup.locator('[name=lppParity]').check();
            await button('Enregistrer et continuer').click();
            const settings = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-settings')).at(-1).payroll);
            assert.equal(settings.avsFund, 'Caisse de recette');
            assert.equal(settings.accidentInsurer, 'Assureur LAA de recette');
            assert.equal(settings.payrollCanton, 'VD');
          } else if (await setup.getByRole('combobox', { name: /Y a-t-il des salaires/ }).count()) {
            await setup.getByRole('combobox', { name: /Y a-t-il des salaires/ }).selectOption('none');
            await button('Continuer').click(); await button('Continuer').click();
            await button('Enregistrer et continuer').click();
          } else if (await setup.getByRole('button', { name: 'Préparer les cotisations suisses 2026', exact: true }).isVisible()) {
            await button('Préparer les cotisations suisses 2026').click();
          } else if (await setup.locator('.payroll-pension-pair').isVisible()) {
            await setup.locator('.payroll-pension-pair [name=employee]').fill('245.50');
            await setup.locator('.payroll-pension-pair [name=employer]').fill('260');
            await setup.locator('.payroll-pension-pair [name=component]').selectOption('combined');
            await setup.locator('.payroll-pension-pair input[type=checkbox]').check();
            await geometry(page);
            await page.screenshot({ path: `${output}/${engine}-${width}-pension.png` });
            // The two existing API writes can fail separately. Retry must not duplicate the first.
            await page.evaluate(() => sessionStorage.setItem('qa-payroll-refuse-pension-employer-once', '1'));
            await button('Enregistrer les deux montants').click();
            await setup.locator('.payroll-problem').waitFor();
            await setup.getByText('Voir le message détaillé', { exact: true }).click();
            await setup.getByText('Enregistrement momentanément indisponible. Réessayez.', { exact: true }).waitFor();
            assert.equal(await setup.locator('.payroll-pension-pair [name=employee]').inputValue(), '245.50');
            await button('Enregistrer les deux montants').click();
          } else throw Error(`Unknown preparation action: ${label}`);
          await guide.waitFor();
        }
        await guide.getByRole('button', { name: 'Calculer le net', exact: true }).click();
        await modal.locator('[data-payroll-step="2"]:visible').waitFor();
        assert.equal(await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true, includeHidden: true }).inputValue(), '5123.45');
        await modal.locator('[name=notes]').fill('Première fiche guidée\nConserver les notes');
        await geometry(page);
        await page.screenshot({ path: `${output}/${engine}-${width}-review.png` });
        await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save')));
        assert.equal(saved.length, 1); assert.equal(saved[0].lines[0].amountCents, 512345);
        assert.equal(saved[0].selections.length, 13);
        assert.equal(saved[0].data.notes, 'Première fiche guidée\nConserver les notes');
        const pensionWrites = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-definition')).filter(d => d.category === 'lpp'));
        assert.equal(pensionWrites.length, 2);
        assert.deepEqual(pensionWrites.map(d => d.fixedAmountCents), [24550, 26000]);
        assert.deepEqual(errors, []);
        reports.push({ engine, width, firstPayslip: true, salaryPreserved: true, pensionRetry: true, actions });
      } finally { await page.close(); }
    }
    // Save a useful draft before all insurance data exists, then reopen the same slip.
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      try {
        const modal = await openPayroll(page, '&payrollSetup=1');
        await start(page, modal);
        await modal.getByText('Je n’ai pas encore cette information', { exact: true }).click();
        await modal.getByRole('button', { name: 'Enregistrer le salaire en brouillon', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        const [saved] = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save')));
        assert.equal(saved.data.status, 'draft'); assert.equal(saved.lines[0].amountCents, 512345);
        assert.deepEqual(saved.selections, []);
        await page.getByText('À calculer', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Reprendre', exact: true }).click();
        await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
        assert.equal(await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true }).inputValue(), '5123.45');
        reports.push({ engine, draftSaveAndReopen: true });
      } finally { await page.close(); }
    }
    // Creating the first employee returns to the original month and payment date.
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      try {
        let modal = await openPayroll(page);
        await modal.locator('[name=period]').fill('2026-08');
        await modal.locator('[name=paymentDate]').fill('2026-08-28');
        await modal.getByRole('button', { name: 'Ajouter le collaborateur et continuer', exact: true }).click();
        const employee = page.getByRole('dialog');
        await employee.locator('[name=name]').fill('Camille Exemple');
        await employee.locator('[name=role]').fill('Responsable de projet');
        await employee.getByRole('button', { name: 'Continuer', exact: true }).click();
        await employee.locator('[name=employmentRate]').fill('80');
        await employee.locator('[name=contractualWeeklyHours]').fill('32');
        await employee.locator('[name=employmentStart]').fill('2026-08-01');
        await employee.locator('[name=employmentContractKind]').selectOption('indefinite');
        await employee.getByRole('combobox', { name: /Comment cette personne/ }).selectOption('monthly');
        await employee.locator('[name=grossSalary]').fill('4200');
        await employee.getByRole('button', { name: 'Continuer', exact: true }).click();
        await page.evaluate(() => sessionStorage.setItem('qa-payroll-refuse-employee', '1'));
        await employee.getByRole('button', { name: 'Ajouter le collaborateur', exact: true }).click();
        await employee.getByText('Le numéro de collaborateur existe déjà.', { exact: true }).waitFor();
        await page.evaluate(() => sessionStorage.removeItem('qa-payroll-refuse-employee'));
        await employee.getByRole('button', { name: 'Ajouter le collaborateur', exact: true }).click();
        modal = page.locator('.payroll-dialog');
        await modal.waitFor();
        assert.equal(await modal.locator('[name=period]').inputValue(), '2026-08');
        assert.equal(await modal.locator('[name=paymentDate]').inputValue(), '2026-08-28');
        assert.equal(await modal.getByRole('combobox', { name: /^Collaborateur/ }).locator('option:checked').textContent(), 'Camille Exemple');
        await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
        assert.equal(await modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true }).inputValue(), '4200');
        reports.push({ engine, employeeReturnToPayslip: true, employeeRetry: true });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
