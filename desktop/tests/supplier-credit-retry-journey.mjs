import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/credit-retry', { recursive: true });
try {
  for (const width of [320, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => report.push({ width, error: error.message }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&creditRetry=1');
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Achats');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Achats & fournisseurs', { exact: true }) }).click();
    if (width <= 860) await page.getByRole('combobox', { name: 'Section des achats', exact: true }).selectOption('documents');
    else await page.locator('#purchase-tab-documents').click();
    await page.getByRole('button', { name: 'Nouvel avoir', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: /^Référence fournisseur/ }).fill('AV-TEST-01');
    await dialog.getByRole('textbox', { name: /^Description/ }).fill('Retour de marchandises');
    await dialog.getByRole('spinbutton', { name: 'Prix HT', exact: true }).fill('50');
    await dialog.getByRole('textbox', { name: 'Catégorie', exact: true }).fill('Marchandises');
    await dialog.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Brouillon enregistré, mais actualisation interrompue.' });
    await alert.waitFor();
    assert.ok(await alert.evaluate((element) => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }), 'Save error must be visible above the open modal');
    await page.screenshot({ path: `.qa/credit-retry/${width}-error.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-credit-attempts')));
    assert.equal(attempts.length, 2);
    assert.match(attempts[0].id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(attempts[1], attempts[0], 'Retry uses the same draft and line IDs');
    await page.getByText('AV-TEST-01', { exact: true }).waitFor();
    await page.screenshot({ path: `.qa/credit-retry/${width}-saved.png`, fullPage: true });
    report.push(await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll('main *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => ({ tag: element.tagName, class: element.className })).slice(0, 12) })));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.push({ width, journey: 'PASS visible save error + preserved draft + stable retry IDs + saved credit' });
    await page.close();
  }
  assert.deepEqual(report.filter((item) => item.error), []);
} catch (error) { report.push({ fatal: error.stack }); process.exitCode = 1; }
finally { await writeFile('.qa/credit-retry/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser.close(); }
