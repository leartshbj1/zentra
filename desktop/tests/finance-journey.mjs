import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const report = [];
await page.emulateMedia({ reducedMotion: 'reduce' });
await mkdir('.qa/finance', { recursive: true });
page.on('pageerror', (error) => report.push({ error: error.message, stack: error.stack }));
page.setDefaultTimeout(15000);
async function go(label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}
async function capture(name) {
  await page.screenshot({ path: `.qa/finance/${name}.png`, fullPage: true });
  report.push({ screen: name, ...await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth })) });
}
async function section(id, name) {
  if ((await page.viewportSize()).width <= 800) await page.getByRole('combobox', { name: 'Section comptable', exact: true }).selectOption(id);
  else await page.getByRole('tab', { name, exact: true }).click();
}
try {
  await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1');
  const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
  if (await tour.isVisible()) await tour.click();
  for (const label of ['Devis', 'Factures']) {
    await go(label);
    const rows = await page.locator('.table-panel tbody tr').allTextContents();
    assert.equal(rows.length, 3);
    assert.match(rows[0], /2026-09-05/);
    assert.match(rows[1], /2026-06-05/);
    assert.match(rows[2], /2026-01-05/);
    if (label === 'Factures') assert.equal(await page.locator('.invoice-payment-reference').count(), 3);
    await capture(`390-${label}`);
  }
  await go('Comptabilité');
  await page.getByLabel('Date de début de la période', { exact: true }).fill('2026-01-01');
  await page.getByLabel('Date de fin de la période', { exact: true }).fill('2026-03-31');
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await section('balance', 'Bilan');
    await page.getByRole('button', { name: /Exporter le bilan.*PDF/i }).waitFor();
    await capture(`${width}-bilan`);
    await section('vat', 'TVA');
    await page.getByRole('region', { name: 'TVA due et récupérable' }).waitFor();
    const totals = await page.locator('.vat-overview__totals strong').allTextContents();
    assert.match(totals[0], /81[.,]00/);
    assert.match(totals[1], /40[.,]50/);
    assert.match(totals[2], /40[.,]50/);
    await capture(`${width}-tva`);
    for (const [id, name] of [['profile', 'Méthode & autorisation'], ['adjustments', 'Ajustements'], ['history', 'Exports']]) {
      if (width <= 800) await page.getByRole('combobox', { name: 'Section TVA', exact: true }).selectOption(id);
      else await page.locator('.vat-navigation').getByRole('tab').filter({ hasText: name }).click();
      await page.locator(`#vat-panel-${id}`).waitFor();
      await capture(`${width}-tva-${id}`);
    }
  }
  await section('balance', 'Bilan');
  await page.getByRole('button', { name: /Exporter le bilan.*PDF/i }).click();
  await page.getByText(/Bilan et résultat exportés en PDF/).waitFor();
  const tabs = page.getByRole('tablist', { name: 'Section comptable', exact: true });
  await tabs.getByRole('tab', { name: 'Bilan', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.getByRole('tab', { name: 'Résultat', exact: true }).getAttribute('aria-selected'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('Achats & fournisseurs');
  await page.getByRole('button', { name: 'Facture fournisseur', exact: true }).click();
  await page.getByLabel('Traitement TVA de ces achats').selectOption('input_materials');
  await page.getByRole('textbox', { name: /^Description/ }).fill('Marchandises à revendre');
  await page.getByRole('textbox', { name: /^Unité/ }).fill('pièce');
  await page.getByRole('spinbutton', { name: /^Quantité/ }).fill('1');
  await page.getByRole('combobox', { name: /^Catégorie/ }).selectOption('Marchandises');
  await page.getByRole('spinbutton', { name: /Prix unitaire/i }).fill('500');
  await capture('390-achat-marchandises');
  await page.getByRole('button', { name: /Enregistrer le brouillon/i }).click();
  await page.waitForFunction(() => sessionStorage.getItem('qa-vat-classification'));
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-vat-classification')).treatment), 'input_materials');
  assert.deepEqual(report.filter((item) => item.error || item.document > item.width), []);
  report.push({ journey: 'PASS recent documents + references + VAT amounts + responsive sections + PDF action + purchase classification' });
} catch (error) { report.push({ fatal: error.stack }); await page.screenshot({ path: '.qa/finance/failure.png', fullPage: true }); process.exitCode = 1; }
finally { await writeFile('.qa/finance/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.filter((item) => item.error || item.fatal || item.journey || item.document > item.width), null, 2)); await browser.close(); }
