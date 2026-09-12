import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/time-flow';
await mkdir(output, { recursive: true });
const reports = [];
async function navigate(page, title) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(title);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(title, { exact: true }) }).click();
}
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(12000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${base}/tests/mobile-harness.html?browsing=1&timeFlow=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await navigate(page, 'Temps');
        const row = page.locator('tbody tr').filter({ hasText: 'Projet du client de recette' }).first();
        await row.getByRole('button', { name: 'Modifier', exact: true }).click();
        const form = page.getByRole('dialog', { name: 'Modifier les heures', exact: true });
        assert.equal(await form.locator('[name=hours]').inputValue(), '1');
        assert.equal(await form.locator('[name=minutes]').inputValue(), '1');
        await form.locator('[name=minutes]').fill('90');
        await form.getByRole('button', { name: 'Enregistrer les heures', exact: true }).click();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'minutes');
        assert.equal(await page.evaluate(() => window.timeFlow.attempts.length), 0);
        await form.locator('[name=minutes]').fill('1');
        await form.locator('[name=billingRate]').fill('95,50');
        await form.locator('[name=billable]').selectOption('no');
        await form.locator('[name=billable]').selectOption('yes');
        assert.equal(await form.locator('[name=billingRate]').inputValue(), '95,50');
        await form.locator('[name=costRate]').fill('45,00');
        await page.evaluate(() => { window.timeFlow.rejectEntry = true; });
        await form.getByRole('button', { name: 'Enregistrer les heures', exact: true }).click();
        await form.getByText('L’enregistrement n’a pas abouti', { exact: true }).waitFor();
        assert.equal(await form.getByText('L’enregistrement n’a pas abouti', { exact: true }).evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
        assert.equal(await form.locator('[name=minutes]').inputValue(), '1');
        assert.equal(await form.locator('[name=billingRate]').inputValue(), '95,50');
        await form.screenshot({ path: `${output}/${engine}-${width}-correction.png` });
        await page.evaluate(() => { window.timeFlow.holdEntry = true; });
        await form.getByRole('button', { name: 'Enregistrer les heures', exact: true }).click();
        await page.waitForFunction(() => window.timeFlow.attempts.length === 2);
        assert.equal(await form.locator('[name=minutes]').isDisabled(), true);
        await page.keyboard.press('Escape');
        assert.equal(await form.isVisible(), true);
        await page.evaluate(() => window.timeFlow.release());
        await form.waitFor({ state: 'detached' });
        const saved = await page.evaluate(() => window.timeFlow.stored.timeEntries.find(row => row.id === 'minute-61'));
        assert.deepEqual([saved.minutes, saved.breakMinutes, saved.billingRateCents, saved.hourlyCostCents], [61, 30, 9550, 4500]);

        await page.getByRole('button', { name: 'Saisir des heures', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'Saisir des heures', exact: true });
        await create.locator('[name=projectId]').selectOption('project-qa');
        await create.locator('[name=employeeId]').selectOption('time-worker');
        assert.equal(await create.locator('[name=costRate]').inputValue(), '45.00');
        await create.locator('[name=minutes]').fill('45');
        await create.locator('[name=billable]').selectOption('no');
        await create.locator('[name=note]').fill('Travail interne à vérifier');
        assert.equal(await create.locator('[name=status]').inputValue(), 'entered');
        await create.getByRole('button', { name: 'Enregistrer les heures', exact: true }).click();
        await create.waitFor({ state: 'detached' });
        const created = await page.evaluate(() => window.timeFlow.attempts[2]);
        assert.equal(created.id, undefined);
        assert.deepEqual([created.data.minutes, created.data.breakMinutes, created.data.billingRateCents, created.data.costRateCents, created.data.status], [45, 0, 0, 4500, 'entered']);

        await page.getByRole('button', { name: /^Facturer les heures/ }).click();
        const billing = page.getByRole('dialog', { name: 'Facturer les heures', exact: true });
        await billing.getByRole('combobox', { name: /^Projet à facturer/ }).selectOption('project-qa');
        const check = id => billing.locator('.time-billing-list label').filter({ hasText: `Prestation ${id}` }).getByRole('checkbox');
        await check('second-time').uncheck();
        await billing.getByRole('combobox', { name: /^Projet à facturer/ }).selectOption('project-other');
        await billing.getByRole('combobox', { name: /^Projet à facturer/ }).selectOption('project-qa');
        assert.equal(await check('second-time').isChecked(), false);
        await billing.locator('[name=title]').fill('Temps de conseil vérifié');
        await billing.locator('[name=notes]').fill('Première intervention\nConditions conservées');
        await page.evaluate(() => { window.timeFlow.rejectInvoice = true; });
        await billing.getByRole('button', { name: 'Créer la facture brouillon', exact: true }).click();
        await billing.getByText('La facture n’a pas pu être créée', { exact: true }).waitFor();
        assert.equal(await billing.getByText('La facture n’a pas pu être créée', { exact: true }).evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true);
        assert.equal(await check('second-time').isChecked(), false);
        assert.equal(await check('new-during-refresh').isChecked(), false);
        assert.equal(await billing.locator('[name=notes]').inputValue(), 'Première intervention\nConditions conservées');
        await billing.screenshot({ path: `${output}/${engine}-${width}-selection.png` });
        await page.evaluate(() => { window.timeFlow.invoiceReadFailure = true; });
        await billing.getByRole('button', { name: 'Créer la facture brouillon', exact: true }).click();
        const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await recovery.waitFor();
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.waitFor({ state: 'detached' });
        await billing.waitFor({ state: 'detached' });
        const invoiceState = await page.evaluate(() => ({ attempts: window.timeFlow.invoiceAttempts, writes: window.timeFlow.invoiceWrites }));
        assert.equal(invoiceState.writes.length, 1);
        assert.equal(invoiceState.attempts.length, 2);
        assert.deepEqual(invoiceState.attempts[1].timeEntryIds, ['minute-61']);
        assert.equal(invoiceState.attempts[1].title, 'Temps de conseil vérifié');
        await navigate(page, 'Temps');
        await page.getByRole('button', { name: 'Démarrer', exact: true }).click();
        const timer = page.getByRole('dialog', { name: 'Démarrer un pointage', exact: true });
        await timer.locator('[name=projectId]').selectOption('project-qa');
        await timer.locator('[name=employeeId]').selectOption('time-worker');
        assert.equal(await timer.locator('[name=costRate]').inputValue(), '45.00');
        await timer.locator('[name=billable]').selectOption('yes');
        await timer.locator('[name=billingRate]').fill('110,25');
        await timer.locator('[name=billable]').selectOption('no');
        await timer.locator('[name=billable]').selectOption('yes');
        assert.equal(await timer.locator('[name=billingRate]').inputValue(), '110,25');
        await timer.screenshot({ path: `${output}/${engine}-${width}-timer.png` });
        await page.evaluate(() => { window.timeFlow.holdTimer = true; });
        await timer.getByRole('button', { name: 'Démarrer le chronomètre', exact: true }).click();
        await page.waitForFunction(() => window.timeFlow.timers.length === 1);
        assert.equal(await timer.locator('[name=billingRate]').isDisabled(), true);
        await page.keyboard.press('Escape');
        assert.equal(await timer.isVisible(), true);
        await page.evaluate(() => window.timeFlow.release());
        await timer.waitFor({ state: 'detached' });
        assert.deepEqual(await page.evaluate(() => [window.timeFlow.timers[0].billingRateCents, window.timeFlow.timers[0].costRateCents]), [11025, 4500]);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        reports.push({ engine, width, height, passed: true });
      } catch (error) { await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` }); throw error; }
      finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
console.log(`${reports.length} parcours de temps et facturation réussis.`);
