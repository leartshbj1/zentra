import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5193';
const reports = [];
await mkdir('.qa/employee-corrections', { recursive: true });
for (const [engine, browserType] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}/tests/mobile-harness.html?browsing=1&design=1`);
      await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
      await page.evaluate(async () => {
        const { desktopApi } = await import('/src/bridge.ts');
        const workspace = await desktopApi.loadWorkspace();
        window.employeeAttempts = [];
        desktopApi.createEntity = async (entity, data) => {
          if (entity !== 'employees') throw new Error('Unexpected entity');
          window.employeeAttempts.push(data);
          if (window.employeeAttempts.length === 1) {
            await new Promise((resolve, reject) => { window.rejectEmployeeSave = () => reject(new Error('IBAN invalide')); });
          }
          return { ...workspace, employees: [...workspace.employees, { ...data, id: 'employee-new', active: data.status === 'actif', salaryMode: 'monthly', grossSalaryCents: data.monthlySalaryCents, hourlyCostCents: data.hourlyRateCents }] };
        };
      });
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
      await page.getByRole('button', { name: 'Nouveau collaborateur', exact: true }).click();
      const modal = page.getByRole('dialog');
      const next = modal.getByRole('button', { name: 'Continuer', exact: true });
      const save = modal.getByRole('button', { name: 'Ajouter le collaborateur', exact: true });
      async function guided(name) {
        const field = modal.locator(`[name="${name}"]`);
        await modal.locator(`[name="${name}"][aria-invalid="true"]`).waitFor();
        await page.waitForFunction(name => document.activeElement?.getAttribute('name') === name, name);
        assert.equal(await field.isVisible(), true, `${engine} ${width}: ${name} visible`);
        const box = await field.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= height, `${name} inside viewport`);
        assert.equal(await modal.locator('.payroll-inline-error').count(), 1);
        const explanation = await modal.locator('.payroll-inline-error').boundingBox();
        const body = await modal.locator('.modal__body').boundingBox();
        if (height >= 568) assert.ok(explanation.y >= body.y && explanation.y + explanation.height <= height, `${name} explanation visible`);
        assert.equal(await field.evaluate(el => (el.getAttribute('aria-describedby') || '').split(' ').some(id => document.getElementById(id)?.textContent?.trim())), true);
        assert.equal(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      }
      await next.click();
      await guided('name');
      await modal.locator('[name=name]').fill('Camille Exemple');
      await modal.locator('[name=role]').fill('Responsable de projet');
      const emailDetails = modal.locator('details').filter({ has: page.locator('[name=email]') });
      await emailDetails.locator('summary').click();
      await modal.locator('[name=email]').fill('adresse-incomplete');
      await emailDetails.locator('summary').click();
      await next.click();
      await guided('email');
      assert.match(await modal.locator('.payroll-inline-error').innerText(), /adresse e-mail complète/);
      await modal.locator('[name=email]').fill('');
      await next.click();
      await modal.locator('[name=employmentRate]').fill('80');
      await modal.locator('[name=contractualWeeklyHours]').fill('32');
      await modal.locator('[name=employmentContractKind]').selectOption('fixed');
      await modal.locator('[name=salaryMode]').selectOption('monthly');
      await modal.locator('[name=grossSalary]').fill('4200');
      await modal.locator('[name=salaryMode]').selectOption('hourly');
      await modal.locator('[name=salaryMode]').selectOption('monthly');
      assert.equal(await modal.locator('[name=grossSalary]').inputValue(), '4200');
      await next.click();
      await guided('employmentStart');
      await modal.locator('[name=employmentStart]').fill('2026-09-01');
      await next.click();
      await guided('employmentEnd');
      await modal.locator('[name=employmentEnd]').fill('2026-08-31');
      await next.click();
      await guided('employmentEnd');
      assert.match(await modal.locator('.payroll-inline-error').innerText(), /avant son début/);
      await modal.locator('[name=employmentEnd]').fill('2026-09-30');
      await next.click();
      await modal.locator('[name=notes]').fill('Contrat signé\nConserver ces informations');
      const advanced = modal.getByText('Réglages de paie particuliers · pension, reprise et retraite', { exact: true });
      await advanced.click();
      await modal.locator('[name=lppAssessmentYear]').fill('2026');
      await modal.locator('[name=acOpeningYear]').fill('2026');
      await modal.locator('[name=laaOpeningYear]').fill('2026');
      await advanced.click();
      for (const [name, value] of [['lppAnnualSalary', '50400'], ['acOpeningBasis', '0'], ['laaOpeningBasis', '2000.25']]) {
        await save.click();
        await guided(name);
        if (name === 'lppAnnualSalary') await page.screenshot({ path: `.qa/employee-corrections/${engine}-${width}-pension.png` });
        await modal.locator(`[name=${name}]`).fill(value);
        await advanced.click();
      }
      assert.equal(await page.evaluate(() => window.employeeAttempts.length), 0);
      await save.click();
      await page.waitForFunction(() => window.employeeAttempts.length === 1);
      assert.equal(await modal.locator('input:not(:disabled),select:not(:disabled),textarea:not(:disabled)').count(), 0);
      assert.equal(await modal.getByRole('button', { name: /Fermer «/ }).count(), 0);
      assert.equal(await modal.getByRole('button', { name: 'Enregistrement…', exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await modal.isVisible(), true);
      await modal.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
      assert.equal(await page.evaluate(() => window.employeeAttempts.length), 1);
      await page.evaluate(() => window.rejectEmployeeSave());
      await guided('iban');
      assert.equal(await modal.locator('[name=iban]').isEnabled(), true);
      assert.match(await modal.locator('.payroll-inline-error').innerText(), /coordonnées bancaires/);
      assert.equal(await modal.locator('[name=notes]').inputValue(), 'Contrat signé\nConserver ces informations');
      await page.screenshot({ path: `.qa/employee-corrections/${engine}-${width}-bank.png` });
      await modal.locator('[name=iban]').fill('CH9300762011623852957');
      await save.click();
      await modal.waitFor({ state: 'hidden' });
      const attempts = await page.evaluate(() => window.employeeAttempts);
      assert.equal(attempts.length, 2);
      const [before, after] = attempts;
      assert.deepEqual({ ...before, iban: after.iban }, after);
      assert.equal(after.monthlySalaryCents, 420000);
      assert.equal(after.lppAnnualSalaryCents, 5040000);
      assert.equal(after.acOpeningBasisCents, 0);
      assert.equal(after.laaOpeningBasisCents, 200025);
      assert.equal(after.employmentStartDate, '2026-09-01');
      assert.equal(after.employmentEndDate, '2026-09-30');
      assert.deepEqual(errors, []);
      reports.push({ engine, width, height, guidedCorrections: true, retainedSalary: true, savingProtected: true, retryPayloadPreserved: true });
      console.log(JSON.stringify(reports.at(-1)));
      await page.close();
    }
  } finally { await browser.close(); }
}
await writeFile('.qa/employee-corrections/report.json', JSON.stringify(reports, null, 2));
