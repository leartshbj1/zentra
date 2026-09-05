import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/vat-received', { recursive: true });
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => report.push({ width, error: error.message }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&receivedVat=1', { waitUntil: 'domcontentloaded' });
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
    await page.locator('.navigation-palette').waitFor({ state: 'detached' });
    await page.getByLabel('Date de début de la période', { exact: true }).fill('2026-01-01');
    await page.getByLabel('Date de fin de la période', { exact: true }).fill('2026-03-31');
    if (width <= 800) await page.getByRole('combobox', { name: 'Section comptable', exact: true }).selectOption('vat');
    else await page.getByRole('tab', { name: 'TVA', exact: true }).click();
    const payments = page.locator('.vat-received-payments');
    await payments.locator('summary').click();
    const rows = payments.locator('article');
    assert.equal(await rows.count(), 25);
    assert.match(await rows.first().textContent(), /ACH-2026-031/);
    await payments.getByRole('button', { name: 'Afficher les paiements suivants', exact: true }).click();
    assert.equal(await rows.count(), 32);
    await payments.getByLabel('Type de règlement', { exact: true }).selectOption('invoice_item');
    assert.equal(await rows.count(), 16);
    await payments.getByRole('searchbox', { name: 'Rechercher un paiement', exact: true }).fill('etude');
    assert.equal(await rows.count(), 16);
    await payments.getByRole('searchbox', { name: 'Rechercher un paiement', exact: true }).fill('F-2026-030');
    assert.equal(await rows.count(), 1);
    assert.match(await rows.textContent(), /46[.,]25/);
    assert.match(await rows.textContent(), /3[.,]75/);
    await payments.getByRole('searchbox', { name: 'Rechercher un paiement', exact: true }).fill('introuvable');
    await payments.getByText('Aucun paiement ne correspond à cette recherche.', { exact: true }).waitFor();
    await payments.getByRole('searchbox', { name: 'Rechercher un paiement', exact: true }).fill('');
    await payments.getByLabel('Type de règlement', { exact: true }).selectOption('supplier_invoice_item');
    await payments.getByRole('searchbox', { name: 'Rechercher un paiement', exact: true }).fill('ACH-2026-031');
    await page.screenshot({ path: `.qa/vat-received/${width}-payments.png`, fullPage: true });
    await payments.evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 95));
    await page.screenshot({ path: `.qa/vat-received/${width}-payments-viewport.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `payment overflow ${width}`);
    const before = await page.locator('.vat-overview__totals strong').allTextContents();
    await payments.locator('summary').click();
    const preClose = page.locator('.vat-pre-closing-review');
    await preClose.locator('summary').click();
    await page.screenshot({ path: `.qa/vat-received/${width}-pre-close.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `classification overflow ${width}`);
    await page.evaluate(() => sessionStorage.setItem('qa-reject-classification', '1'));
    await preClose.getByRole('combobox').selectOption('input_materials');
    await page.getByText('Le compte de TVA est inactif. Aucune modification enregistrée.', { exact: true }).waitFor();
    assert.equal(await preClose.locator('article').count(), 1);
    await page.evaluate(() => sessionStorage.removeItem('qa-reject-classification'));
    await preClose.getByRole('combobox').selectOption('input_materials');
    await preClose.waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.vat-overview__totals strong').allTextContents(), before, 'unpaid classification does not release VAT');
    assert.ok(Number(await page.evaluate(() => sessionStorage.getItem('qa-balance-refresh'))) >= 2);
    report.push({ width, journey: 'PASS recent payments, pagination, type and accent search, cent amounts, unpaid classification refusal and retry, stable VAT totals, balance refresh, no overflow' });
    await page.close();
  }
  assert.deepEqual(report.filter((item) => item.error), []);
} catch (error) {
  report.push({ fatal: error.stack }); process.exitCode = 1;
  const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
  if (page) { await page.screenshot({ path: '.qa/vat-received/failure.png', fullPage: true }); await writeFile('.qa/vat-received/failure.html', await page.content()); }
}
finally { await writeFile('.qa/vat-received/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser.close(); }
