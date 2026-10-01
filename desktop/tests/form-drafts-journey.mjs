import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5275';
const folder = `.qa/form-drafts-${engine}`, report = []; await mkdir(folder, { recursive: true });
const retained = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('zentra.forms.drafts.v1.')).length);
async function open(page, kind) { await page.getByRole('button', { name: kind, exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.waitFor(); return dialog; }
async function resume(page, kind) { const dialog = await open(page, kind); await dialog.getByRole('button', { name: 'Reprendre ma saisie', exact: true }).click(); return dialog; }
async function saveFailure(page, dialog, label) {
  await page.evaluate(() => { window.formDraftsFixture.fail = true; });
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await dialog.locator('.error-guidance').waitFor();
  assert.equal(await retained(page), 1, 'failed mutations preserve the draft');
  await page.evaluate(() => { window.formDraftsFixture.fail = false; });
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await retained(page), 0, 'only acknowledged success clears recovery');
}
try {
  for (const width of [320, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 780 : 1000 } }); page.setDefaultTimeout(12000);
    const errors = [], dialogs = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.goto(`${origin}/tests/form-drafts.html`);
    let dialog = await open(page, 'catalog');
    await dialog.locator('[name=name]').fill('Dernière frappe catalogue é'); await dialog.locator('[name=salesPrice]').fill('95,50');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(dialogs.length, 0);
    await page.reload(); dialog = await resume(page, 'catalog');
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Dernière frappe catalogue é'); assert.equal(await dialog.locator('[name=salesPrice]').inputValue(), '95,50');
    await page.screenshot({ path: `${folder}/${width}-catalog.png` }); await saveFailure(page, dialog, 'Ajouter au catalogue');

    dialog = await open(page, 'time'); await dialog.locator('[name=projectId]').selectOption('project-1'); await dialog.locator('[name=employeeId]').selectOption('employee-1');
    await dialog.locator('[name=hours]').fill('2'); await dialog.locator('[name=billable]').selectOption('yes'); await dialog.locator('[name=billingRate]').fill('95,50'); await dialog.locator('[name=note]').fill('Dernière frappe heures');
    await page.keyboard.press('Escape'); await page.reload(); dialog = await resume(page, 'time');
    assert.equal(await dialog.locator('[name=note]').inputValue(), 'Dernière frappe heures'); assert.equal(await dialog.locator('[name=hours]').inputValue(), '2');
    await page.screenshot({ path: `${folder}/${width}-time.png` }); await saveFailure(page, dialog, 'Enregistrer les heures');

    dialog = await open(page, 'document'); await dialog.locator('[name=title]').fill('Document conservé'); await dialog.locator('[name=clientId]').selectOption('client-1');
    await dialog.getByRole('button', { name: 'Continuer', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Dernière prestation'); await dialog.locator('input[aria-label="Unité"]').fill('heure');
    await dialog.getByRole('textbox', { name: 'Quantité', exact: true }).fill('2'); await dialog.getByRole('textbox', { name: 'Prix unitaire', exact: true }).fill('95,');
    await page.keyboard.press('Escape'); await page.reload(); dialog = await resume(page, 'document');
    assert.equal(await dialog.getByRole('textbox', { name: 'Prix unitaire', exact: true }).inputValue(), '95,'); assert.equal(await dialog.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Dernière prestation');
    await dialog.getByRole('textbox', { name: 'Prix unitaire', exact: true }).fill('95,50'); await dialog.getByRole('button', { name: 'Continuer', exact: true }).click();
    await dialog.getByRole('button', { name: 'Continuer', exact: true }).click(); await page.screenshot({ path: `${folder}/${width}-document.png` });
    await saveFailure(page, dialog, 'Enregistrer le brouillon');

    dialog = await open(page, 'client'); await dialog.locator('[name=contactPerson]').fill('Client à reprendre'); await dialog.locator('[name=street]').fill('Rue du Test');
    await dialog.locator('[name=postalCode]').fill('28001'); await dialog.locator('[name=city]').fill('Madrid'); await dialog.locator('[name=country]').selectOption('__other'); await dialog.locator('[name=countryCustom]').fill('ES');
    await page.keyboard.press('Escape'); await page.reload(); dialog = await resume(page, 'client');
    assert.equal(await dialog.locator('[name=contactPerson]').inputValue(), 'Client à reprendre'); assert.equal(await dialog.locator('[name=country]').inputValue(), '__other'); assert.equal(await dialog.locator('[name=countryCustom]').inputValue(), 'ES');
    await page.screenshot({ path: `${folder}/${width}-client.png` }); await saveFailure(page, dialog, 'Enregistrer');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
    report.push({ engine, width, catalog: true, time: true, document: true, client: true, closePrompts: 0 }); await page.close();
  }
  for (const [language, resumeText] of [['fr', 'Reprendre ma saisie'], ['de', 'Meinen Entwurf öffnen'], ['it', 'Riprendi la mia bozza'], ['en', 'Resume my draft']]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/tests/form-drafts.html?language=${language}`); let dialog = await open(page, 'catalog'); await dialog.locator('[name=name]').fill('Saisie locale');
    await page.keyboard.press('Escape'); dialog = await open(page, 'catalog'); await dialog.getByRole('button', { name: resumeText, exact: true }).click();
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Saisie locale');
    report.push({ engine, language, resumeCopy: true }); await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/tests/form-drafts.html?organization=organization-a`); let dialog = await open(page, 'catalog');
    await dialog.locator('[name=name]').fill('Saisie privée entreprise A'); await page.keyboard.press('Escape');
    await page.goto(`${origin}/tests/form-drafts.html?organization=organization-b`); dialog = await open(page, 'catalog');
    assert.equal(await dialog.getByRole('button', { name: 'Reprendre ma saisie', exact: true }).count(), 0);
    assert.equal(await dialog.locator('[name=name]').inputValue(), '');
    await dialog.locator('[name=name]').fill('Saisie privée entreprise B'); await page.keyboard.press('Escape');
    await page.goto(`${origin}/tests/form-drafts.html?organization=organization-a`); dialog = await resume(page, 'catalog');
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Saisie privée entreprise A'); await page.keyboard.press('Escape');
    await page.goto(`${origin}/tests/form-drafts.html?organization=organization-b`); dialog = await resume(page, 'catalog');
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Saisie privée entreprise B');
    report.push({ engine, organizationRelinkIsolation: true }); await page.close();
  }
} catch (error) { report.push({ error: String(error.stack || error) }); process.exitCode = 1; }
finally { await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); }
