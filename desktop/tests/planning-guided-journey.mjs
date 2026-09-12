import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/planning-guided';
await mkdir(output, { recursive: true });
const reports = [];
async function navigate(page, title) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(title);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(title, { exact: true }) }).click();
}
async function planning(page) { await navigate(page, 'Projets'); await page.getByRole('button', { name: 'Tâches & jalons', exact: true }).click(); }
async function screenshot(page, name) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: `${output}/${name}.png` }); }
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(14000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${base}/tests/mobile-harness.html?browsing=1&planningGuided=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await planning(page);
        await page.getByRole('button', { name: 'Nouvelle tâche', exact: true }).click();
        const form = page.getByRole('dialog', { name: 'Nouvelle tâche', exact: true });
        await form.getByRole('button', { name: 'Enregistrer la tâche', exact: true }).click();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'title');
        assert.equal(await page.evaluate(() => window.planningFixture.attempts.length), 0);
        await form.locator('[name=title]').fill('Préparer la livraison');
        await form.locator('[name=projectId]').selectOption('planning-project');
        await form.locator('[name=employeeId]').selectOption('planning-person');
        await form.locator('[name=milestoneId]').selectOption('stage-open');
        await form.locator('[name=projectId]').selectOption('planning-other');
        assert.equal(await form.locator('[name=milestoneId]').inputValue(), '');
        assert.equal(await form.locator('[name=employeeId]').inputValue(), 'planning-person');
        assert.equal(await form.locator('[name=title]').inputValue(), 'Préparer la livraison');
        await form.locator('[name=projectId]').selectOption('planning-project');
        await form.locator('[name=milestoneId]').selectOption('stage-open');
        await form.locator('[name=dueDate]').fill('2026-10-01');
        await form.getByRole('button', { name: 'Enregistrer la tâche', exact: true }).click();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'dueDate');
        assert.equal(await page.evaluate(() => window.planningFixture.attempts.length), 0);
        assert.equal(await form.locator('.field__error').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true, 'Date explanation fits the viewport');
        const correctionBounds = await form.locator('.planning-date-suggestion').evaluate(node => { const rect = node.getBoundingClientRect(), body = node.closest('.modal__body').getBoundingClientRect(), footer = node.closest('form').querySelector('.form-actions').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, visibleTop: Math.max(0, body.top), visibleBottom: Math.min(innerHeight, body.bottom, footer.top) }; });
        assert.ok(correctionBounds.top >= correctionBounds.visibleTop && correctionBounds.bottom <= correctionBounds.visibleBottom, `Suggested correction is visible: ${JSON.stringify(correctionBounds)}`);
        await screenshot(page, `${engine}-${width}-date-help`);
        await form.getByRole('button', { name: /Utiliser le/ }).click();
        assert.equal(await form.locator('[name=dueDate]').inputValue(), '2026-09-30');
        await form.locator('summary').click();
        await form.locator('[name=priority]').selectOption('high');
        await form.locator('[name=description]').fill('Contrôler les documents\nPrévoir le matériel');
        await page.evaluate(() => { window.planningFixture.reject = true; });
        await form.getByRole('button', { name: 'Enregistrer la tâche', exact: true }).click();
        await form.getByText('L’enregistrement n’a pas abouti', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
        assert.equal(await form.locator('[name=description]').inputValue(), 'Contrôler les documents\nPrévoir le matériel');
        await screenshot(page, `${engine}-${width}-save-help`);
        await page.evaluate(() => { window.planningFixture.reject = false; window.planningFixture.hold = true; window.planningFixture.readAfterWrite = true; });
        await form.getByRole('button', { name: 'Enregistrer la tâche', exact: true }).click();
        await page.waitForFunction(() => window.planningFixture.attempts.length === 2);
        assert.equal(await form.locator('[name=title]').isDisabled(), true);
        await page.keyboard.press('Escape');
        assert.equal(await form.isVisible(), true);
        await form.locator('form').evaluate(node => { node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        assert.equal(await page.evaluate(() => window.planningFixture.attempts.length), 2);
        await page.evaluate(() => { window.planningFixture.hold = false; window.planningFixture.release(); });
        const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await recovery.waitFor();
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.waitFor({ state: 'detached' });
        await form.waitFor({ state: 'detached' });
        const created = page.locator('.planning-task').filter({ hasText: 'Préparer la livraison' });
        await created.waitFor();
        assert.equal(await page.evaluate(() => window.planningFixture.stored.projectTasks.filter(row => row.title === 'Préparer la livraison').length), 1);
        assert.equal(await page.evaluate(() => window.planningFixture.attempts.length), 2);
        const stage = page.locator('.milestone-list > article').filter({ hasText: 'Livraison de recette' });
        assert.equal(await stage.locator('.milestone-list__top strong').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 14), true, 'Stage title is readable');
        assert.equal(await created.locator('.planning-task__body strong').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 14), true, 'Task title is readable');
        await stage.getByRole('button', { name: 'Modifier le jalon Livraison de recette', exact: true }).click();
        const editStage = page.getByRole('dialog', { name: 'Modifier l’étape', exact: true });
        await editStage.locator('[name=dueDate]').fill('2026-09-19');
        await editStage.getByRole('button', { name: 'Enregistrer l’étape', exact: true }).click();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'dueDate');
        await editStage.getByRole('button', { name: /Utiliser le/ }).click();
        await editStage.getByRole('button', { name: 'Enregistrer l’étape', exact: true }).click();
        await editStage.waitFor({ state: 'detached' });
        const advanceStage = stage.getByRole('button', { name: 'Changer l’état du jalon Livraison de recette', exact: true });
        assert.equal(await advanceStage.isEnabled(), true, 'A stage can start with open tasks');
        await advanceStage.click();
        await page.waitForFunction(() => window.planningFixture.stored.projectMilestones.find(row => row.id === 'stage-open').status === 'in_progress');
        assert.equal(await advanceStage.isDisabled(), true, 'Close waits for all linked tasks');
        await stage.getByRole('button', { name: 'Voir les tâches à terminer', exact: true }).click();
        assert.equal(await page.locator('.planning-task').count(), 2);
        assert.equal(await page.getByRole('region', { name: 'Résumé des tâches' }).locator('article').filter({ has: page.getByText('Ouvertes', { exact: true }) }).locator('strong').innerText(), '2', 'Counters follow the selected stage');
        for (const title of ['Vérifier les mesures', 'Préparer la livraison']) {
          await page.getByRole('button', { name: `Commencer ${title}`, exact: true }).click();
          await page.getByRole('button', { name: `Terminer ${title}`, exact: true }).click();
        }
        assert.equal(await advanceStage.isEnabled(), true);
        await advanceStage.click();
        await page.locator('.planning-filters').getByRole('combobox', { name: 'État', exact: true }).selectOption('done');
        await page.getByRole('button', { name: 'Toutes les tâches du projet', exact: true }).click();
        const finished = page.locator('.planning-task').filter({ hasText: 'Étude de faisabilité' });
        assert.equal(await finished.getByRole('button', { name: 'Rouvrir Étude de faisabilité', exact: true }).isDisabled(), true);
        await finished.getByRole('button', { name: 'Voir l’étape à rouvrir', exact: true }).click();
        await page.getByRole('button', { name: 'Changer l’état du jalon Étude terminée', exact: true }).click();
        await finished.getByRole('button', { name: 'Rouvrir Étude de faisabilité', exact: true }).click();
        await finished.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Nouveau jalon', exact: true }).click();
        const createStage = page.getByRole('dialog', { name: 'Nouvelle étape clé', exact: true });
        await createStage.locator('[name=title]').fill('Préparer le dossier');
        await createStage.getByRole('button', { name: 'Enregistrer l’étape', exact: true }).click();
        await createStage.waitFor({ state: 'detached' });
        await page.locator('.milestone-list > article').filter({ hasText: 'Préparer le dossier' }).waitFor();
        assert.equal(await page.locator('.planning-filters').getByRole('combobox', { name: 'État', exact: true }).inputValue(), 'open');
        const timerTask = page.locator('.planning-task').filter({ hasText: 'Intervention chronométrée' });
        assert.equal(await timerTask.getByRole('button', { name: 'Terminer Intervention chronométrée', exact: true }).isDisabled(), true);
        await screenshot(page, `${engine}-${width}-planning`);
        await timerTask.getByRole('button', { name: 'Ouvrir le chronomètre', exact: true }).click();
        await page.getByLabel('Temps', { exact: true }).getByRole('button', { name: 'Saisir des heures', exact: true }).waitFor();
        await page.goto(`${base}/tests/mobile-harness.html?browsing=1&planningGuided=1&readOnly=1`);
        await planning(page);
        assert.equal(await page.getByRole('button', { name: 'Nouvelle tâche', exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Nouveau jalon', exact: true }).isDisabled(), true);
        assert.deepEqual(errors, []);
        reports.push({ engine, width, height, result: 'PASS task and milestone creation, field corrections, preserved edits, post-write read recovery, milestone filter, closure and reopening, timer shortcut and read-only' });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        await writeFile(`${output}/${engine}-${width}-failure.html`, await page.content());
        reports.push({ engine, width, height, error: error.stack }); throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2)); }
}
console.log(JSON.stringify(reports, null, 2));
