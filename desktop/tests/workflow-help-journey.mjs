import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5196';
const output = '.qa/workflow-help';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
async function navigate(page, name) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
}
try {
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    try {
      await page.goto(`${base}/tests/mobile-harness.html?workflowHelp=1`);
      await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
      await navigate(page, 'Projets');
      const help = page.locator('.creation-action__help');
      await help.getByText('Ajoutez d’abord un client.', { exact: true }).waitFor();
      assert.ok(await page.locator('.creation-action > button').isDisabled());
      await page.screenshot({ path: `${output}/${width}-project-start.png` });
      await help.getByRole('button', { name: 'Ajouter le client', exact: true }).click();
      const client = page.getByRole('dialog', { name: 'Nouveau client', exact: true });
      for (const [name, value] of Object.entries({ contactPerson: 'Alex Départ', company: 'Atelier Départ', street: 'Rue du test', postalCode: '1000', city: 'Lausanne', country: 'CH' })) await client.locator(`[name=${name}]`).fill(value);
      await client.getByRole('button', { name: 'Enregistrer', exact: true }).click();
      await client.waitFor({ state: 'hidden' });
      assert.equal(await help.count(), 0);
      assert.ok(await page.locator('.creation-action > button').isEnabled());
      await navigate(page, 'Devis');
      await help.getByRole('button', { name: 'Compléter la facturation', exact: true }).click();
      await page.locator('#settings-company-billing').waitFor();
      await page.waitForFunction(() => {
        const target = document.getElementById('settings-company-billing').getBoundingClientRect();
        const topbar = document.querySelector('.topbar').getBoundingClientRect();
        const dock = document.querySelector('.mobile-navigation').getBoundingClientRect();
        return target.top >= topbar.bottom && target.bottom <= (dock.height ? dock.top : innerHeight);
      });
      await page.screenshot({ path: `${output}/${width}-billing-target.png` });
      assert.ok(await page.locator('#settings-company-billing').isVisible());
      await navigate(page, 'Achats & fournisseurs');
      await help.getByRole('button', { name: 'Ajouter le fournisseur', exact: true }).click();
      await page.getByRole('dialog', { name: 'Nouveau fournisseur', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await navigate(page, 'Temps');
      await help.getByRole('button', { name: 'Ouvrir les projets', exact: true }).click();
      assert.ok(await page.locator('.creation-action > button').isEnabled());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      report.push({ width, clientUnblocksProject: true, exactBillingSettings: true, supplierShortcut: true, projectShortcut: true });
    } catch (error) {
      await page.screenshot({ path: `${output}/${width}-failure.png` });
      throw error;
    } finally { await page.close(); }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${base}/tests/mobile-harness.html?workflowHelp=1&readOnly=1`);
    await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
    await navigate(page, 'Projets');
    assert.ok(await page.locator('.creation-action > button').isDisabled());
    assert.equal(await page.locator('.creation-action__help').count(), 0);
    report.push({ readOnlyPreserved: true });
  } finally { await page.close(); }
} finally { await browser.close(); }
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
