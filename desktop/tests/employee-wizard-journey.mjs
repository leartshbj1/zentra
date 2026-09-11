import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5193';
const reports = [];
await mkdir('.qa/employee-wizard', { recursive: true });
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
        window.employeeWrites = [];
        window.failEmployeeSave = true;
        desktopApi.createEntity = async (entity, data) => {
          if (entity !== 'employees') throw new Error('Unexpected entity');
          if (window.failEmployeeSave) { window.failEmployeeSave = false; throw new Error('Enregistrement momentanément indisponible. Réessayez.'); }
          window.employeeWrites.push(data);
          return { ...workspace, employees: [...workspace.employees, { ...data, id: 'employee-new', active: data.status === 'actif', salaryMode: data.monthlySalaryCents > 0 ? 'monthly' : 'hourly', grossSalaryCents: data.monthlySalaryCents, hourlyCostCents: data.hourlyRateCents }] };
        };
      });
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
      await page.getByRole('button', { name: 'Nouveau collaborateur', exact: true }).click();
      const modal = page.getByRole('dialog');
      const next = modal.getByRole('button', { name: 'Continuer', exact: true });
      await next.click();
      assert.equal(await modal.locator('[data-employee-step="0"]').isVisible(), true);
      await modal.locator('input[name=name]').fill('Camille Exemple');
      await modal.locator('input[name=role]').fill('Responsable de projet');
      await next.click();
      await modal.locator('input[name=employmentRate]').fill('80');
      await modal.locator('input[name=contractualWeeklyHours]').fill('32');
      await modal.locator('input[name=employmentStart]').fill('2026-09-01');
      await modal.locator('select[name=employmentContractKind]').selectOption('indefinite');
      await modal.getByRole('combobox', { name: /Comment cette personne/ }).selectOption('monthly');
      await modal.locator('input[name=grossSalary]').fill('4200');
      await modal.locator('input[name=hourlyCost]').fill('38');
      await next.click();
      await modal.getByText('4200 CHF brut / mois', { exact: true }).waitFor();
      await modal.getByRole('button', { name: 'Retour', exact: true }).click();
      assert.equal(await modal.locator('input[name=grossSalary]').inputValue(), '4200');
      await next.click();
      await modal.locator('textarea[name=notes]').fill('Contrat à conserver\nDeuxième ligne');
      await modal.getByRole('button', { name: 'Ajouter le collaborateur', exact: true }).click();
      await modal.getByText('Enregistrement momentanément indisponible. Réessayez.', { exact: true }).waitFor();
      assert.equal(await modal.locator('textarea[name=notes]').inputValue(), 'Contrat à conserver\nDeuxième ligne');
      await page.screenshot({ path: `.qa/employee-wizard/${engine}-${width}.png` });
      assert.equal(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await modal.getByRole('button', { name: 'Ajouter le collaborateur', exact: true }).click();
      await modal.waitFor({ state: 'hidden' });
      const [write] = await page.evaluate(() => window.employeeWrites);
      assert.equal(write.name, 'Camille Exemple');
      assert.equal(write.monthlySalaryCents, 420000);
      assert.equal(write.contractualWeeklyMinutes, 1920);
      assert.equal(write.hourlyRateCents, 3800);
      assert.equal(write.status, 'actif');
      assert.equal(write.lppAnnualSalaryCents, null);
      assert.equal(write.notes, 'Contrat à conserver\nDeuxième ligne');
      assert.deepEqual(errors, []);
      reports.push({ engine, width, height, validation: true, draftRetained: true, saveRetry: true, payload: true });
      await page.close();
    }
  } finally { await browser.close(); }
}
await writeFile('.qa/employee-wizard/report.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
