import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/vat-credits', { recursive: true });
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => report.push({ width, error: error.message }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&creditVat=1');
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
    await page.getByLabel('Date de début de la période', { exact: true }).fill('2026-01-01');
    await page.getByLabel('Date de fin de la période', { exact: true }).fill('2026-03-31');
    if (width <= 800) await page.getByRole('combobox', { name: 'Section comptable', exact: true }).selectOption('vat');
    else await page.getByRole('tab', { name: 'TVA', exact: true }).click();
    await page.locator('.vat-overview__pending').waitFor();
    await page.getByRole('combobox', { name: 'Traitement TVA de Avoir fournisseur · Retour de vis', exact: true }).selectOption('input_materials');
    await page.getByText('Le traitement TVA est enregistré.', { exact: true }).waitFor();
    assert.equal(await page.locator('.vat-overview__pending').count(), 0);
    let totals = await page.locator('.vat-overview__totals strong').allTextContents();
    assert.match(totals[1], /36[.,]45/);
    assert.match(totals[2], /44[.,]55/);
    await page.locator('.vat-purchase-review summary').click();
    const row = page.locator('.vat-purchase-review article').filter({ hasText: 'Avoir fournisseur · Retour de vis' });
    assert.match(await row.textContent(), /-50[.,]00/);
    assert.match(await row.textContent(), /-4[.,]05/);
    await row.getByRole('combobox').selectOption('non_deductible');
    await page.waitForFunction(() => document.querySelector('.vat-purchase-review select[aria-label*="Retour de vis"]')?.value === 'non_deductible');
    totals = await page.locator('.vat-overview__totals strong').allTextContents();
    assert.match(totals[1], /40[.,]50/);
    await page.screenshot({ path: `.qa/vat-credits/${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.push({ width, journey: 'PASS unclassified credit + signed reduction + deductible and non-deductible totals' });
    await page.close();
  }
  assert.deepEqual(report.filter((item) => item.error), []);
} catch (error) { report.push({ fatal: error.stack }); process.exitCode = 1; }
finally { await writeFile('.qa/vat-credits/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser.close(); }
