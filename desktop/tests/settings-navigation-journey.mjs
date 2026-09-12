import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const folder = '.qa/apple-settings';
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const navigate = async name => {
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
    };
    const capture = async name => {
      await page.waitForTimeout(350);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${viewport.width}: ${name} overflow`);
      await page.screenshot({ path: `${folder}/${viewport.width}-${name}.png` });
    };
    const category = id => page.locator(`[data-settings-id="${id}"]`);
    const back = page.getByRole('button', { name: 'Tous les paramètres', exact: true });
    const open = async id => {
      if (viewport.width <= 1100 && await back.isVisible()) await back.click();
      await page.locator(`[data-settings-link="${id}"]`).click();
      await category(id).waitFor({ state: 'visible' });
      assert.equal(await page.locator('.settings-category[open]').count(), 1);
    };
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1`);
    await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
    await navigate('Paramètres');
    await capture('overview');
    const ids = await page.locator('[data-settings-link]').evaluateAll(elements => elements.map(el => el.dataset.settingsLink));
    assert.deepEqual(ids, ['readiness', 'account', 'company', 'assistant', 'documents', 'accounting', 'time', 'payroll', 'storage']);
    await page.locator('.settings-category').evaluateAll(elements => elements.forEach(el => el.removeAttribute('name')));
    for (const id of ids) { await open(id); await capture(id); }
    await open('documents');
    await page.locator('.design-studio__tabs').getByRole('button', { name: 'Devis', exact: true }).click();
    await open('time');
    await open('documents');
    assert.equal(await page.locator('.design-studio__tabs [aria-pressed=true]').innerText(), 'Devis', 'Lazy page retains its local selection');
    await open('company');
    await page.getByRole('textbox', { name: 'Raison sociale' }).fill('Brouillon conservé');
    await open('time');
    await open('company');
    assert.equal(await page.getByRole('textbox', { name: 'Raison sociale' }).inputValue(), 'Brouillon conservé');
    if (viewport.width <= 1100) {
      await back.click();
      assert.equal(await page.locator('[data-settings-link="company"]').evaluate(el => el === document.activeElement), true, 'Back restores focus to the category');
      await page.keyboard.press('Enter');
      await category('company').waitFor({ state: 'visible' });
    }
    await page.getByRole('button', { name: 'Ouvrir les mises à jour de Zentra', exact: true }).click();
    const updater = page.getByRole('dialog', { name: 'Mise à jour de Zentra', exact: true });
    await updater.waitFor({ state: 'visible' });
    await updater.getByRole('button', { name: 'Fermer « Mise à jour de Zentra »', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Raison sociale' }).inputValue(), 'Brouillon conservé', 'Updater dialog preserves settings drafts');
    await open('storage');
    if (viewport.width <= 1100) {
      await back.click();
      assert.equal(await page.locator('[data-settings-link="storage"]').evaluate(el => el === document.activeElement), true, 'Shortcut return focuses the actual category');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open('time');
    assert.equal(await category('time').evaluate(el => getComputedStyle(el).animationName), 'none');
    await navigate('Factures');
    await capture('invoices');
    if (viewport.width <= 860) {
      const filters = page.locator('.document-list-tools__compact button');
      assert.equal(await filters.getAttribute('aria-expanded'), 'false');
      const first = await page.locator('.sales-documents tbody tr').first().boundingBox();
      if (viewport.height >= 800) assert.ok(first.y < 500, 'First document is visible without opening filters');
      await filters.click();
      await page.getByRole('combobox', { name: 'État des factures' }).selectOption('draft');
      await page.getByRole('combobox', { name: 'Classement des factures' }).selectOption('date-asc');
      await filters.click();
      assert.equal(await filters.innerText(), 'Filtres actifs');
      assert.equal(await page.getByRole('combobox', { name: 'État des factures' }).isVisible(), false);
      await filters.click();
      assert.equal(await page.getByRole('combobox', { name: 'État des factures' }).inputValue(), 'draft');
      await capture('filters');
    }
    const sales = page.getByRole('navigation', { name: 'Cycle de vente' });
    for (const name of ['Devis', 'Commandes', 'Factures']) {
      await sales.getByRole('button', { name, exact: true }).click();
      const button = await sales.locator('[aria-current]').boundingBox();
      const indicator = await sales.locator('.sales-tabs__selection').boundingBox();
      assert.ok(Math.abs(button.x - indicator.x) <= 1 && Math.abs(button.width - indicator.width) <= 1, 'Sales selection follows its button');
    }
    assert.deepEqual(errors, []);
    results.push({ viewport, categories: ids.length, draftsPreserved: true, externalShortcut: true, reducedMotion: true, passed: true });
    await page.close();
  }
} finally { await browser.close(); await writeFile(`${folder}/results.json`, JSON.stringify(results, null, 2)); }
console.log(results);
