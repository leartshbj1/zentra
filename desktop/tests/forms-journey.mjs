import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const report = [];
await page.emulateMedia({ reducedMotion: 'reduce' });
await mkdir('.qa/forms', { recursive: true });
page.on('pageerror', (error) => report.push({ error: error.message }));
page.setDefaultTimeout(10000);
async function go(label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
  await page.locator('.settings-cloud-status').filter({ hasText: /Ouverture/ }).waitFor({ state: 'detached' });
  await page.evaluate(() => scrollTo(0, 0));
}
async function capture(name) {
  await page.screenshot({ path: `.qa/forms/${name}.png`, fullPage: false });
  const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, dialog: document.querySelector('[role=dialog]')?.getBoundingClientRect().width || 0, dialogScroll: document.querySelector('.modal__body')?.scrollWidth || 0, dialogClient: document.querySelector('.modal__body')?.clientWidth || 0 }));
  assert.ok(geometry.document <= geometry.width && geometry.dialog <= geometry.width && geometry.dialogScroll <= geometry.dialogClient + 1, name + ': no horizontal overflow');
  report.push({ screen: name, ...geometry });
}
try {
  await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1');
  const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
  if (await tour.isVisible()) await tour.click();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [module, button, slug] of [
      ['Clients', 'Nouveau client', 'client'], ['Produits & services', 'Nouvelle référence', 'catalogue'],
      ['Équipe & salaires', 'Nouveau collaborateur', 'collaborateur'], ['Agenda', 'Ajouter', 'agenda'],
      ['Achats & fournisseurs', 'Nouvelle commande', 'commande-achat'], ['Achats & fournisseurs', 'Facture fournisseur', 'facture-achat'],
    ]) {
      await go(module);
      await page.getByRole('button', { name: button, exact: true }).first().click();
      await page.getByRole('dialog').waitFor();
      await capture(`${width}-${slug}`);
      // Keyboard users must stay inside the active form, including at its edges.
      await page.getByRole('dialog').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.querySelector('[role=dialog]').contains(document.activeElement)), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.querySelector('[role=dialog]').contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    }
    await go('Achats & fournisseurs');
    for (const id of ['inbox', 'orders', 'receipts', 'documents', 'suppliers']) {
      if (width <= 860) await page.getByRole('combobox', { name: 'Section des achats', exact: true }).selectOption(id);
      else await page.locator(`#purchase-tab-${id}`).click();
      assert.equal(await page.locator('#purchase-panel').getAttribute('aria-labelledby'), `purchase-tab-${id}`);
      await capture(`${width}-achats-${id}`);
    }
    await page.getByRole('button', { name: 'Nouveau fournisseur', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await capture(`${width}-fournisseur`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  assert.deepEqual(report.filter((item) => item.error), []);
  report.push({ journey: 'PASS 7 creation forms + 5 purchase sections at 5 sizes + modal keyboard containment' });
} catch (error) { report.push({ fatal: error.stack }); await page.screenshot({ path: '.qa/forms/failure.png', fullPage: true }); process.exitCode = 1; }
finally { await writeFile('.qa/forms/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.filter((item) => item.error || item.fatal || item.journey), null, 2)); await browser.close(); }
