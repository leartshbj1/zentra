import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const report = [];
await page.emulateMedia({ reducedMotion: 'reduce' });
await mkdir('.qa/sales', { recursive: true });
page.on('pageerror', (error) => report.push({ error: error.message }));
page.setDefaultTimeout(10000);
async function go(label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
  await page.evaluate(() => scrollTo(0, 0));
}
async function capture(name) {
  await page.screenshot({ path: `.qa/sales/${name}.png`, fullPage: false });
  const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, rowHeights: [...document.querySelectorAll('.sales-documents tbody tr')].map((row) => Math.round(row.getBoundingClientRect().height)) }));
  assert.ok(geometry.document <= geometry.width, name + ': no page overflow');
  report.push({ screen: name, ...geometry });
}
try {
  await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?browsing=1');
  const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
  if (await tour.isVisible()) await tour.click();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const label of ['Devis', 'Factures']) {
      await go(label);
      await page.locator('.sales-documents tbody tr').first().waitFor();
      await capture(`${width}-${label}`);
      const rows = page.locator('.sales-documents tbody tr');
      assert.equal(await rows.count(), 3);
      assert.match(await rows.first().innerText(), /EUR|€/);
      if (width <= 860) assert.ok((await rows.first().boundingBox()).height < 420, 'Invoice card stays compact');
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const filter = page.getByRole('combobox', { name: 'État des factures' });
  for (const [value, count] of [['overdue', 1], ['open', 1], ['paid', 1], ['draft', 1], ['cancelled', 0], ['all', 3]]) {
    await filter.selectOption(value);
    assert.equal(await page.locator('.sales-documents tbody tr').count(), count, value);
    if (value === 'overdue') assert.match(await page.locator('.sales-documents tbody tr').innerText(), /2026-001/);
  }
  const search = page.getByRole('searchbox', { name: /Rechercher dans ventes/i });
  await search.fill('rf18\u00a05390 0754 7034 1');
  assert.equal(await page.locator('.sales-documents tbody tr').count(), 1);
  await search.fill('');
  await page.locator('.sales-documents tbody tr').first().getByRole('button', { name: 'Modifier', exact: true }).click();
  await page.getByRole('textbox', { name: 'Titre du document' }).fill('Brouillon conservé en EUR');
  assert.equal(await page.getByRole('textbox', { name: 'Devise', exact: true }).inputValue(), 'EUR');
  assert.equal(await page.locator('select[name=projectId]').inputValue(), 'project-qa');
  assert.equal(await page.locator('select[name=projectId] option[value=project-other]').count(), 0);
  await page.locator('select[name=clientId]').selectOption('client-other');
  assert.equal(await page.locator('select[name=projectId]').inputValue(), '');
  assert.equal(await page.locator('select[name=projectId] option[value=project-qa]').count(), 0);
  await page.locator('select[name=clientId]').selectOption('client-qa');
  await page.locator('select[name=projectId]').selectOption('project-qa');
  await page.getByRole('button', { name: /Enregistrer.*brouillon/i }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const saved = page.locator('.sales-documents tbody tr').filter({ hasText: 'Brouillon conservé en EUR' });
  assert.match(await saved.locator('.sales-document__total').innerText(), /EUR|€/);
  assert.doesNotMatch(await saved.innerText(), /CHF/);
  await capture('390-facture-eur-enregistree');
  await go('Devis');
  await page.locator('.sales-documents tbody tr').first().getByRole('button', { name: /Modifier le devis/ }).click();
  await page.getByRole('textbox', { name: 'Titre du document' }).fill('Devis conservé en EUR');
  await page.getByRole('button', { name: /Enregistrer.*brouillon/i }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.match(await page.locator('.sales-documents tbody tr').filter({ hasText: 'Devis conservé en EUR' }).locator('.sales-document__total').innerText(), /EUR|€/);
  await go('Factures');
  await page.getByRole('button', { name: 'Nouvelle facture', exact: true }).click();
  await page.getByLabel('Type de document').selectOption('credit_note');
  await page.getByLabel('Facture originale', { exact: false }).selectOption('invoice-2');
  assert.equal(await page.locator('select[name=clientId]').inputValue(), 'client-other');
  assert.equal(await page.locator('select[name=projectId]').inputValue(), 'project-other');
  assert.equal(await page.getByRole('textbox', { name: 'Devise', exact: true }).inputValue(), 'EUR');
  assert.equal(await page.locator('select[name=clientId]').isDisabled(), true);
  await capture('390-avoir-lie');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?volume=1');
  await go('Factures');
  assert.equal(await page.locator('.sales-documents tbody tr').count(), 25);
  assert.match(await page.locator('.sales-documents tbody tr').first().innerText(), /F-2026-0080/);
  await page.getByRole('button', { name: 'Page suivante', exact: true }).click();
  assert.match(await page.locator('.sales-documents tbody tr').first().innerText(), /F-2026-0055/);
  await page.getByRole('button', { name: 'Page suivante', exact: true }).click();
  await page.getByRole('button', { name: 'Page suivante', exact: true }).click();
  assert.equal(await page.locator('.sales-documents tbody tr').count(), 5);
  assert.equal(await page.getByRole('button', { name: 'Page suivante', exact: true }).isDisabled(), true);
  await capture('390-pagination-80-factures');
  await page.getByRole('searchbox', { name: /Rechercher dans ventes/i }).fill('F-2026-0080');
  assert.equal(await page.locator('.sales-documents tbody tr').count(), 1, 'Search resets pagination');
  assert.match(await page.locator('.sales-documents tbody tr').innerText(), /F-2026-0080/);
  assert.deepEqual(report.filter((item) => item.error), []);
  report.push({ journey: 'PASS sales status filters + pasted reference + EUR invoice and quote edits + responsive cards' });
} catch (error) { report.push({ fatal: error.stack }); await page.screenshot({ path: '.qa/sales/failure.png', fullPage: true }); process.exitCode = 1; }
finally { await writeFile('.qa/sales/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.filter((item) => item.error || item.fatal || item.journey), null, 2)); await browser.close(); }
