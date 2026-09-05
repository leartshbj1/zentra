import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/vat-received-credit', { recursive: true });
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => report.push({ width, error: error.message }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&receivedVat=1&receivedCredits=1');
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
    await page.getByLabel('Date de début de la période', { exact: true }).fill('2026-01-01');
    await page.getByLabel('Date de fin de la période', { exact: true }).fill('2026-03-31');
    if (width <= 800) await page.getByRole('combobox', { name: 'Section comptable', exact: true }).selectOption('vat');
    else await page.getByRole('tab', { name: 'TVA', exact: true }).click();
    const panel = page.locator('.vat-received-payments');
    const rows = panel.locator('article');
    await panel.locator('summary').click();
    assert.match(await panel.locator('summary').innerText(), /3 règlements · 15 lignes/);
    assert.equal(await rows.count(), 15);
    assert.match(await rows.first().innerText(), /Paiement fournisseur/);
    const totals = await page.locator('.vat-overview__totals strong').allTextContents();
    const capture = async (name, target = rows.first()) => {
      await target.evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 95));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${name} overflows`);
      await page.screenshot({ path: `.qa/vat-received-credit/${width}-${name}.png` });
    };
    await panel.getByLabel('Type de règlement', { exact: true }).selectOption('credits');
    assert.equal(await rows.count(), 12);
    assert.match(await rows.first().innerText(), /Extourne/);
    await capture('paired-events');
    await panel.getByRole('searchbox', { name: 'Rechercher un règlement', exact: true }).fill('extourne');
    assert.equal(await rows.count(), 6);
    assert.equal(await rows.filter({ hasText: /Extourne · Avoir/ }).count(), 3);
    assert.equal(await rows.filter({ hasText: /Extourne · Facture/ }).count(), 3);
    await capture('reversal');
    await panel.getByRole('searchbox', { name: 'Rechercher un règlement', exact: true }).fill('');
    await panel.getByLabel('Type de règlement', { exact: true }).selectOption('supplier_credit_note_item');
    assert.equal(await rows.count(), 6);
    const application = rows.filter({ hasText: /Compensation · Avoir/ }).first();
    assert.match(await application.innerText(), /-54[.,]05/);
    assert.match(await application.innerText(), /-4[.,]05/);
    assert.match(await application.innerText(), /Pièce liée : FA-2026/);
    await capture('credit-signs', application);
    await panel.getByRole('searchbox', { name: 'Rechercher un règlement', exact: true }).fill('FA-2026-COMPENSATION');
    assert.equal(await rows.count(), 6, 'search follows the linked invoice reference');
    assert.deepEqual(await page.locator('.vat-overview__totals strong').allTextContents(), totals, 'filters do not change the return');
    report.push({ width, result: 'PASS event count without duplicated compensation, paired signed lines, reversal search, linked reference and stable totals', captures: 3 });
    await page.close();
  }
  assert.deepEqual(report.filter((row) => row.error), []);
} catch (error) { report.push({ fatal: error.stack }); process.exitCode = 1; }
finally { await writeFile('.qa/vat-received-credit/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser.close(); }
