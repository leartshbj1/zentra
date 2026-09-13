import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271';
const folder = `.qa/catalog-form-${engine}`; await mkdir(folder, { recursive: true });
const report = []; let activePage;
const state = page => page.evaluate(() => ({ attempts: window.catalogFixture.state.attempts, writes: window.catalogFixture.state.writes, items: window.catalogFixture.state.stored.catalog_items }));
const set = (page, patch) => page.evaluate(patch => Object.assign(window.catalogFixture.state, patch), patch);
async function navigate(page) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Produits');
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Produits & services', { exact: true }) }).click();
  await page.locator('.catalog-screen').waitFor();
}
async function screenshot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('.modal,.modal__body')].some(el => el.scrollWidth > el.clientWidth + 1)), false, 'no horizontal overflow');
  await page.screenshot({ path: `${folder}/${name}.png` });
}
try {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 1000]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' }); activePage = page; page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&catalogForm=1`);
    await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click(); await navigate(page);
    const openNew = async () => { await page.getByRole('button', { name: 'Nouvelle référence', exact: true }).click(); return page.getByRole('dialog').filter({ has: page.locator('form.catalog-form') }); };
    const submit = form => form.getByRole('button', { name: /^(Ajouter au catalogue|Enregistrer les modifications)$/ }).click();
    let form = await openNew(); await submit(form); await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'name'); assert.equal((await state(page)).attempts, 0);
    await form.locator('[name=name]').fill('Pose de recette'); await form.locator('[name=salesPrice]').fill('85,555'); await submit(form);
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'salesPrice'); assert.equal((await state(page)).attempts, 0); await screenshot(page, `${width}-price-help`);
    await form.locator('[name=salesPrice]').fill('100'); await form.locator('summary').filter({ hasText: 'Référence, description' }).click();
    await form.locator('[name=description]').fill('Première ligne\nConditions de la prestation'); await form.locator('[name=purchaseCost]').fill('invalide');
    await form.locator('summary').filter({ hasText: 'Référence, description' }).click(); await submit(form);
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'purchaseCost'); assert.equal(await form.locator('[name=description]').inputValue(), 'Première ligne\nConditions de la prestation');
    await form.locator('[name=purchaseCost]').fill(''); assert.match(await form.locator('.catalog-form-price').innerText(), /108,10 CHF/);
    await set(page, { mode: 'lost' }); await submit(form); await form.waitFor({ state: 'hidden' }); assert.equal((await state(page)).writes, 1);
    assert.equal((await state(page)).items[0].sales_price_cents, 10000); assert.equal((await state(page)).items[0].track_stock, 0);

    form = await openNew(); await form.getByRole('button', { name: /^Produit/ }).click(); assert.equal(await form.locator('[name=unit]').inputValue(), 'pièce');
    await form.locator('[name=unit]').fill('m²'); await form.getByRole('button', { name: /^Service/ }).click(); await form.getByRole('button', { name: /^Produit/ }).click(); assert.equal(await form.locator('[name=unit]').inputValue(), 'm²');
    await form.locator('[name=name]').fill('Peinture de recette'); await form.locator('[name=salesPrice]').fill('34,95'); await form.locator('[name=reorderLevel]').fill('1,0001'); await submit(form);
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'reorderLevel'); assert.equal((await state(page)).writes, 1);
    await form.locator('[name=reorderLevel]').fill('2,125'); await screenshot(page, `${width}-stock`);
    await set(page, { mode: 'ack-unreadable', hold: true }); const attempts = (await state(page)).attempts;
    await submit(form); await page.waitForFunction(n => window.catalogFixture.state.attempts === n, attempts + 1);
    await form.locator('form').dispatchEvent('submit'); await page.keyboard.press('Escape'); assert.equal(await form.locator('[name=name]').isDisabled(), true); assert.equal((await state(page)).attempts, attempts + 1);
    await page.evaluate(() => { window.catalogFixture.state.hold = false; window.catalogFixture.state.release(); });
    const acknowledged = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true }); await acknowledged.waitFor();
    await set(page, { blockRead: false, empty: true }); await acknowledged.getByRole('button', { name: 'Actualiser les données', exact: true }).click(); await acknowledged.getByText('Actualisation impossible', { exact: true }).waitFor();
    await set(page, { empty: false, omitItem: true }); await acknowledged.getByRole('button', { name: 'Actualiser les données', exact: true }).click(); await acknowledged.getByText('Actualisation impossible', { exact: true }).waitFor();
    await page.evaluate(() => window.__qaSetReadOnly(true)); await set(page, { omitItem: false }); await acknowledged.getByRole('button', { name: 'Actualiser les données', exact: true }).click(); await form.waitFor({ state: 'hidden' });
    assert.equal((await state(page)).attempts, attempts + 1); assert.equal((await state(page)).writes, 2);
    await page.evaluate(() => window.__qaSetReadOnly(false));
    const product = (await state(page)).items.find(row => row.kind === 'product'); assert.equal(product.reorder_level_milli, 2125); assert.equal(product.stock_quantity_milli, 0);
    await page.evaluate(async id => {
      window.catalogFixture.change(id, { stock_quantity_milli: 10000 });
      window.catalogFixture.state.stored.stock_movements.push({ id: 'opening', catalog_item_id: id, sequence: 1, source_type: 'opening', movement_type: 'entry', quantity_delta_milli: 10000, balance_after_milli: 10000, reason: 'Stock initial', movement_date: '2026-09-13' });
      window.catalogFixture.persist(); await window.__qaCatalogRefresh();
    }, product.id);
    await page.getByRole('button', { name: 'Modifier Peinture de recette', exact: true }).click(); form = page.getByRole('dialog').filter({ has: page.locator('form.catalog-form') });
    assert.equal(await form.getByRole('button', { name: /^Service/ }).isDisabled(), true); assert.equal(await form.locator('[name=trackStock]').isDisabled(), true);
    await form.locator('[name=salesPrice]').fill('85,50'); await set(page, { mode: 'refuse' }); await submit(form); await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'purchaseCost');
    assert.equal(await form.locator('[name=salesPrice]').inputValue(), '85,50'); await form.locator('[name=purchaseCost]').fill('20');
    await form.locator('[name=description]').fill('Ma description\nÀ conserver');
    await page.evaluate(id => window.catalogFixture.change(id, { name: 'Peinture actualisée', sales_price_cents: 9050 }), product.id);
    await submit(form); await form.getByText('La fiche a changé entre-temps', { exact: true }).waitFor(); assert.equal((await state(page)).writes, 2); await screenshot(page, `${width}-comparison`);
    await form.getByRole('button', { name: 'Conserver ma saisie', exact: true }).click();
    assert.equal(await form.locator('[name=name]').inputValue(), 'Peinture actualisée'); assert.equal(await form.locator('[name=salesPrice]').inputValue(), '85,50'); assert.equal(await form.locator('[name=description]').inputValue(), 'Ma description\nÀ conserver');
    await set(page, { mode: 'lost-unreadable' }); await submit(form);
    const unknown = page.getByRole('dialog', { name: 'Vérifier l’enregistrement', exact: true }); await unknown.waitFor(); await unknown.getByRole('button', { name: 'Vérifier maintenant', exact: true }).click(); await unknown.getByText('Vérification encore indisponible', { exact: true }).waitFor();
    const afterWrite = await state(page); await set(page, { blockRead: false }); await unknown.getByRole('button', { name: 'Vérifier maintenant', exact: true }).click(); await form.waitFor({ state: 'hidden' }); assert.equal((await state(page)).attempts, afterWrite.attempts);
    const saved = (await state(page)).items.find(row => row.id === product.id); assert.equal(saved.sales_price_cents, 8550); assert.equal(saved.purchase_cost_cents, 2000); assert.equal(saved.stock_quantity_milli, 10000);
    await page.getByRole('button', { name: 'Modifier Peinture actualisée', exact: true }).click(); form = page.getByRole('dialog').filter({ has: page.locator('form.catalog-form') });
    await page.evaluate(() => window.__qaSetReadOnly(true)); await page.waitForFunction(() => document.querySelector('form.catalog-form [name=name]')?.matches(':disabled')); assert.equal(await form.locator('[name=name]').isDisabled(), true); await form.getByRole('button', { name: 'Actualiser la fiche', exact: true }).click();
    await page.evaluate(() => window.__qaSetReadOnly(false)); await set(page, { omitItem: true }); await form.getByRole('button', { name: 'Actualiser la fiche', exact: true }).click(); await form.getByText('Cette référence n’est plus accessible', { exact: true }).waitFor();
    assert.equal(await form.getByRole('button', { name: 'Enregistrer les modifications', exact: true }).isDisabled(), true); await form.getByRole('button', { name: 'Revenir au catalogue', exact: true }).click();
    await set(page, { omitItem: false }); await page.evaluate(() => window.__qaCatalogRefresh()); await page.reload(); await navigate(page);
    await page.getByRole('button', { name: 'Modifier Peinture actualisée', exact: true }).waitFor(); await screenshot(page, `${width}-catalogue`);
    assert.deepEqual(errors, []); report.push({ engine, width, height, passed: true, writes: afterWrite.writes }); await page.close();
  }
} catch (error) {
  if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: `${folder}/failure.png` }); await writeFile(`${folder}/failure.html`, await activePage.content()); }
  report.push({ error: String(error.stack || error) }); process.exitCode = 1;
} finally { await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); }
