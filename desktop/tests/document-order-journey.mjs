import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const playwright = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const folder = `.qa/document-order-${engine}`;
await mkdir(folder, { recursive: true });
const errors = [], report = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
const url = `${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?documentOrder=1`;
async function go(label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
  await page.evaluate(() => scrollTo(0, 0));
}
async function numbers() {
  return page.locator('.sales-documents tbody .sales-document__identity .document-cell > div > strong').allTextContents().then(rows => rows.map(value => Number(value.trim().slice(-4))));
}
const created = Array.from({ length: 32 }, (_, i) => i + 1);
const issued = [...created].sort((a, b) => (((a - 1) * 7) % 32) - (((b - 1) * 7) % 32));
const expectedOrders = { 'created-desc': [...created].reverse(), 'created-asc': created, 'date-desc': [...issued].reverse(), 'date-asc': issued };
async function assertRows(expected) { assert.deepEqual(await numbers(), expected); }
async function assertSidebar(width) {
  if (width <= 860) await page.getByRole('button', { name: 'Tous les modules', exact: true }).click();
  const selected = page.locator('.sidebar__nav button[aria-current=page]');
  assert.equal(await selected.count(), 1);
  for (const state of ['normal', 'hover', 'focus']) {
    if (state === 'hover') await selected.hover();
    if (state === 'focus') await selected.focus();
    const colors = await selected.evaluate(el => ({ text: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, icon: getComputedStyle(el.querySelector('svg')).color }));
    assert.equal(colors.background, 'rgb(237, 243, 237)', `${width} ${state}: light selection`);
    assert.equal(colors.text, 'rgb(24, 60, 44)');
    assert.equal(colors.icon, colors.text, 'Icon shares readable text color');
  }
  await page.screenshot({ path: `${folder}/${width}-menu.png` });
  if (width <= 860) await page.getByRole('button', { name: 'Fermer la navigation', exact: true }).click();
}
try {
  await page.goto(url);
  const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
  if (await tour.isVisible()) await tour.click();
  for (const entity of ['Factures', 'Devis']) {
    await go(entity);
    const sorter = page.getByRole('combobox', { name: `Classement des ${entity.toLowerCase()}` });
    assert.equal(await sorter.inputValue(), 'created-desc', 'Each list defaults to creation, most recent first');
    for (const [order, expected] of Object.entries(expectedOrders)) {
      await sorter.selectOption(order);
      await assertRows(expected.slice(0, 25));
      assert.equal(await page.getByRole('button', { name: 'Page précédente' }).isDisabled(), true, 'Changing sort resets page');
      await page.getByRole('button', { name: 'Page suivante' }).click();
      await assertRows(expected.slice(25));
    }
    await sorter.selectOption('created-desc');
    await page.getByRole('button', { name: 'Page suivante' }).click();
    await page.getByRole('combobox', { name: `État des ${entity.toLowerCase()}` }).selectOption('issued');
    await assertRows(expectedOrders['created-desc'].filter(number => number % 2 === 0));
    await page.getByRole('combobox', { name: `État des ${entity.toLowerCase()}` }).selectOption('all');
    await sorter.selectOption(entity === 'Devis' ? 'date-asc' : 'date-desc');
  }
  await page.reload();
  for (const entity of ['Factures', 'Devis']) {
    await go(entity);
    const order = entity === 'Devis' ? 'date-asc' : 'date-desc';
    assert.equal(await page.getByRole('combobox', { name: `Classement des ${entity.toLowerCase()}` }).inputValue(), order, 'Choice survives reload separately for quotes/invoices');
    await assertRows(expectedOrders[order].slice(0, 25));
  }
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await go('Factures');
    await assertSidebar(width);
    await page.screenshot({ path: `${folder}/${width}-factures.png` });
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, selects: [...document.querySelectorAll('.sales-list-toolbar select')].map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })) }));
    assert.ok(geometry.scroll <= width, `No overflow at ${width}px`);
    assert.ok(geometry.selects.every(control => control.height >= 44 && control.width > 150), 'Usable touch controls');
    report.push(geometry);
  }
  assert.deepEqual(errors, []);
  report.push({ result: 'PASS', engine, checks: 'Both lists: four chronological orders across pagination, filters reset page, independent persisted choices; readable selected menu normal/hover/focus at five widths.' });
} catch (error) {
  report.push({ error: error.stack });
  await page.screenshot({ path: `${folder}/failure.png`, fullPage: true });
  process.exitCode = 1;
} finally {
  await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.at(-1)));
  await browser.close();
}
