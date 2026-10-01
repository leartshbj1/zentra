import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5275', folder = `.qa/native-form-drafts-${engine}`, report = [];
await mkdir(folder, { recursive: true });
let activePage;
async function screen(page, label) { await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click(); await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label); await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click(); }
const retained = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('zentra.forms.drafts.v1.')).length);
try {
  for (const width of [320, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 800 : 1000 } }); activePage = page; page.setDefaultTimeout(15000);
    await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
    const errors = [], prompts = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); });
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&formDrafts=1`);
    const later = page.getByRole('button', { name: 'Découvrir plus tard', exact: true }); if (await later.isVisible()) await later.click();
    await screen(page, 'Projets'); await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click(); let dialog = page.getByRole('dialog');
    await dialog.locator('[name=name]').fill('Projet brouillon'); await dialog.locator('[name=clientId]').selectOption('client-qa'); await dialog.locator('summary').filter({ hasText: 'Adresse, dates' }).click(); await dialog.locator('[name=notes]').fill('Dernière frappe projet'); await dialog.locator('[name=budget]').fill('1250.55');
    await page.keyboard.press('Escape'); await page.reload(); await screen(page, 'Projets'); await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Reprendre ma saisie', exact: true }).click();
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Projet brouillon'); assert.equal(await dialog.locator('[name=notes]').inputValue(), 'Dernière frappe projet'); assert.equal(await dialog.locator('[name=budget]').inputValue(), '1250.55');
    await page.evaluate(() => { const original = window.__qaDesktopApi.saveProject; window.__qaDesktopApi.saveProject = async (...args) => { window.__qaDesktopApi.saveProject = original; throw new Error('Network connection lost'); }; });
    await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await dialog.locator('.error-guidance').waitFor(); assert.equal(await retained(page), 1);
    await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(await retained(page), 0);

    await screen(page, 'Équipe & salaires'); await page.getByRole('button', { name: 'Nouvelle fiche de personnel', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.locator('[name=name]').fill('Camille Brouillon'); await dialog.locator('[name=role]').fill('Responsable'); await dialog.getByRole('button', { name: 'Continuer', exact: true }).click();
    await dialog.locator('[name=employmentRate]').fill('80'); await dialog.locator('[name=employmentContractKind]').selectOption('indefinite'); await dialog.locator('[name=salaryMode]').selectOption('monthly'); await dialog.locator('[name=grossSalary]').fill('4200.50');
    await dialog.getByRole('button', { name: 'Continuer', exact: true }).click(); await dialog.locator('[name=notes]').fill('Dernière frappe collaborateur');
    await dialog.getByText('Réglages de paie particuliers · pension, reprise et retraite', { exact: true }).click(); await dialog.getByRole('button', { name: 'Compléter ce réglage plus tard', exact: true }).click();
    await page.keyboard.press('Escape'); await page.reload(); await screen(page, 'Équipe & salaires'); await page.getByRole('button', { name: 'Nouvelle fiche de personnel', exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Reprendre ma saisie', exact: true }).click();
    assert.equal(await dialog.locator('[data-employee-step="2"]').isVisible(), true); assert.equal(await dialog.locator('[name=name]').inputValue(), 'Camille Brouillon'); assert.equal(await dialog.locator('[name=grossSalary]').inputValue(), '4200.50'); assert.equal(await dialog.locator('[name=notes]').inputValue(), 'Dernière frappe collaborateur'); assert.equal(await dialog.locator('.employee-annual-fields').evaluate(element => element.disabled), true);
    await page.evaluate(async () => {
      const api = window.__qaDesktopApi, workspace = await api.loadWorkspace(); let failure = true;
      api.createEntity = async (entity, input) => { if (failure) { failure = false; throw new Error('Network connection lost'); } return { ...workspace, employees: [...workspace.employees, { ...input, id: 'saved-employee', salaryMode: 'monthly', active: true, grossSalaryCents: input.monthlySalaryCents, hourlyCostCents: input.hourlyRateCents }] }; };
    });
    await dialog.getByRole('button', { name: 'Ajouter le collaborateur', exact: true }).click(); await dialog.locator('.error-guidance').waitFor(); assert.equal(await retained(page), 1);
    await page.screenshot({ path: `${folder}/${width}-employee.png` }); await dialog.getByRole('button', { name: 'Ajouter le collaborateur', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(await retained(page), 0);
    assert.deepEqual(errors, []); assert.deepEqual(prompts, []); report.push({ engine, width, project: true, employee: true, salaryModeAndRawSalary: true, step: true, deferAnnual: true }); await page.close();
  }
} catch (error) { report.push({ error: String(error.stack || error) }); if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: `${folder}/failure.png` }); await writeFile(`${folder}/failure.html`, await activePage.content()); } process.exitCode = 1; }
finally { await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); }
