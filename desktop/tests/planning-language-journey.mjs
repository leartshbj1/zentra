import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5367';
const largeText = process.env.ZENTRA_QA_LARGE_TEXT === 'true';
const out = largeText ? '.qa/planning-languages-large' : '.qa/planning-languages'; await mkdir(out, { recursive: true });
const report = [];
for (const engine of ['chromium', 'webkit']) {
 const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'msedge' } : {}) });
 try {
  for (const language of largeText ? ['de', 'en'] : ['fr', 'de', 'it', 'en']) for (const width of largeText ? [320] : [320, 1440]) {
   const theme = language === 'de' || language === 'en' ? 'dark' : 'light';
   const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
   const errors = []; page.on('pageerror', e => errors.push(e.message));
   const tr = (source, values) => page.evaluate(async ({ source, values }) => (await import('/src/language.ts')).t(source, values), { source, values });
   const name = `${engine}-${language}-${width}`;
   async function shot(state) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No viewport overflow');
    const clipped = await page.locator('.planning-layout button,.planning-editor button').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && n.scrollWidth > n.clientWidth + 2).map(n => n.textContent));
    assert.deepEqual(clipped, [], 'Planning buttons retain their full labels');
    const clippedMetrics = await page.locator('.planning-overview small').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && n.scrollWidth > n.clientWidth + 1).map(n => n.textContent));
    assert.deepEqual(clippedMetrics, [], 'Planning counters retain translated labels');
    await page.screenshot({ path: `${out}/${name}-${state}.png`, animations: 'disabled' });
   }
   try {
    await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await page.addInitScript(({ language, theme, largeText }) => { localStorage.setItem('zentra.interface.language.v1', language); localStorage.setItem('zentra.appearance.v1', theme); localStorage.setItem('zentra.text-size.v1', largeText ? '200' : '100'); }, { language, theme, largeText });
    await page.goto(`${base}/tests/mobile-harness.html?browsing=1&planningGuided=1`);
    await page.waitForFunction(async expected => { const state = (await import('/src/language.ts')).getLanguageState(); return state.ready && state.language === expected; }, language);
    await page.getByRole('button', { name: await tr('Fermer le guide automatique'), exact: true }).click();
    await page.getByRole('button', { name: await tr('Aller à un écran'), exact: true }).click();
    await page.getByRole('searchbox').fill(await tr('Projets'));
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText(await tr('Projets'), { exact: true }) }).click();
    await page.getByRole('button', { name: await tr('Tâches & jalons'), exact: true }).click();
    await page.getByRole('button', { name: await tr('Nouvelle tâche'), exact: true }).click();
    const form = page.getByRole('dialog', { name: await tr('Nouvelle tâche'), exact: true });
    await form.locator('[name=title]').waitFor();
    const headline = { fr: 'Nouvelle tâche', de: 'Neue Aufgabe', it: 'Nuova attività', en: 'New task' }[language];
    assert.equal(await form.locator('h2').innerText(), headline);
    await shot('editor');
    await form.getByRole('button', { name: await tr('Enregistrer la tâche'), exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'title');
    const title = ('Nouvelle tâche · façade Müller & Figli — ' + 'Vérification '.repeat(9)).trim();
    await form.locator('[name=title]').fill(title);
    await form.locator('[name=projectId]').selectOption('planning-project');
    await form.locator('[name=milestoneId]').selectOption('stage-open');
    await form.locator('[name=dueDate]').fill('2026-10-01');
    await form.getByRole('button', { name: await tr('Enregistrer la tâche'), exact: true }).click();
    const message = await form.locator('.field__error').innerText();
    assert.ok(message.includes('Livraison de recette'), 'Business title is preserved inside translated error');
    if (language !== 'fr') assert.ok(!message.startsWith('L’étape'), message);
    assert.equal(await page.evaluate(() => window.planningFixture.attempts.length), 0);
    await shot('date-error');
    await form.locator('.planning-date-suggestion').click();
    assert.equal(await form.locator('[name=dueDate]').inputValue(), '2026-09-30');
    await form.locator('summary').click();
    await form.locator('[name=description]').fill('Nouvelle tâche\nNotes privées conservées');
    await page.evaluate(() => { window.planningFixture.reject = true; });
    await form.getByRole('button', { name: await tr('Enregistrer la tâche'), exact: true }).click();
    await form.locator('.planning-form-error').waitFor();
    if (language !== 'fr') assert.ok(!(await form.locator('.planning-form-error').innerText()).includes('Le planning a changé'), 'Known conflict is translated');
    assert.equal(await form.locator('[name=title]').inputValue(), title);
    assert.equal(await form.locator('[name=description]').inputValue(), 'Nouvelle tâche\nNotes privées conservées');
    await shot('save-error');
    await page.evaluate(() => { window.planningFixture.reject = false; });
    await form.getByRole('button', { name: await tr('Enregistrer la tâche'), exact: true }).click();
    await form.waitFor({ state: 'detached' });
    await page.getByText(await tr('La tâche a été ajoutée au planning.'), { exact: true }).waitFor();
    const row = page.locator('.planning-task').filter({ hasText: title });
    await row.waitFor(); assert.equal(await row.locator('strong').innerText(), title);
    const stored = await page.evaluate(() => window.planningFixture.stored.projectTasks.find(t => t.id.startsWith('new-task-')));
    assert.equal(stored.title, title); assert.equal(stored.description, 'Nouvelle tâche\nNotes privées conservées');
    await page.getByRole('button', { name: await tr('Nouveau jalon'), exact: true }).click();
    const milestone = page.getByRole('dialog', { name: await tr('Nouvelle étape clé'), exact: true });
    await milestone.locator('[name=title]').fill('Jalon client non traduit');
    await milestone.getByRole('button', { name: await tr('Enregistrer l’étape'), exact: true }).click();
    await milestone.waitFor({ state: 'detached' });
    await page.getByText(await tr('Le jalon a été ajouté au projet.'), { exact: true }).waitFor();
    await page.locator('.milestone-list').getByText('Jalon client non traduit', { exact: true }).waitFor();
    await page.getByRole('heading', { name: await tr('Projets'), exact: true }).scrollIntoViewIfNeeded(); await shot('planning');
    assert.deepEqual(errors, []);
    report.push({ engine, language, width, theme, passed: true, writes: await page.evaluate(() => window.planningFixture.commits) });
   } catch (error) {
    await page.screenshot({ path: `${out}/${name}-failure.png`, animations: 'disabled' });
    report.push({ engine, language, width, error: String(error.stack) });
   } finally { await page.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); }
  }
 } finally { await browser.close(); }
}
console.log(JSON.stringify(report));
if (report.some(r => !r.passed)) process.exitCode = 1;
