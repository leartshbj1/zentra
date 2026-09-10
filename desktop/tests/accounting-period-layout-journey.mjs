import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expandAccountingPeriodFilters } from './accounting-navigation.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const out = fileURLToPath(new URL('../../.qa/accounting-period-layout', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
try {
  for (const width of [320, 390, 768, 861, 1024, 1101, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&payroll=1&designLedger=1&designTrial=1`);
    await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
    const from = page.getByLabel('Date de début de la période', { exact: true });
    const to = page.getByLabel('Date de fin de la période', { exact: true });
    await from.waitFor({ state: 'attached' });
    const toggle = page.locator('.accounting-period-toggle');
    const tabs = page.getByRole('tablist', { name: 'Section comptable', exact: true });
    const section = async (value, title) => {
      if (await tabs.isVisible()) await tabs.getByRole('tab', { name: title, exact: true }).click();
      else await page.getByRole('combobox', { name: 'Section comptable', exact: true }).selectOption(value);
    };
    // A populated footer used to widen the entire screen, including its menu.
    await section('trial', 'Balance');
    const totals = page.locator('.accounting-screen tfoot');
    await totals.waitFor();
    const expectedTotals = ['Totaux', '1 234 567.89 CHF', '1 234 567.89 CHF', '12 345.67 CHF', '12 345.67 CHF', '1 246 913.56 CHF', '1 246 913.56 CHF'];
    assert.deepEqual(await totals.locator('tr > *').allTextContents(), expectedTotals);
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('.accounting-toolbar')?.getBoundingClientRect();
      return toolbar && toolbar.left >= 0 && toolbar.right <= innerWidth + 1;
    });
    if (width <= 860) {
      await page.waitForFunction(() => document.querySelector('tfoot tr > :last-child')?.getAttribute('data-label') === 'Clôture crédit');
      const bounds = await totals.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Every total stays inside the mobile screen');
      assert.equal(await totals.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      assert.deepEqual(await totals.locator('tr > :not(:first-child)').evaluateAll(cells => cells.map(cell => cell.getAttribute('data-label'))), ['Ouverture débit', 'Ouverture crédit', 'Mouvements débit', 'Mouvements crédit', 'Clôture débit', 'Clôture crédit']);
    }
    await page.setViewportSize({ width: width <= 860 ? 1440 : 390, height: 900 });
    assert.deepEqual(await totals.locator('tr > *').allTextContents(), expectedTotals, 'Changing layout preserves every amount');
    await page.setViewportSize({ width, height: 900 });
    await section('journal', 'Journal');
    assert.equal(await from.isVisible(), width > 1100);
    if (width <= 1100) {
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    } else await expandAccountingPeriodFilters(page);
    await from.fill('2026-01-01');
    await to.fill('2026-06-30');
    await page.getByRole('button', { name: 'Actualiser', exact: true }).waitFor();
    if (width <= 1100) {
      await toggle.click();
      assert.equal(await from.isVisible(), false);
      assert.match(await toggle.innerText(), /2026/);
      assert.ok(await page.getByRole('button', { name: 'Saisir une écriture', exact: true }).isVisible());
    }
    await section('balance', 'Bilan');
    await expandAccountingPeriodFilters(page);
    assert.equal(await from.inputValue(), '2026-01-01');
    assert.equal(await to.inputValue(), '2026-06-30');
    await section('accounts', 'Plan & liaisons');
    assert.equal(await from.count(), 0);
    await section('journal', 'Journal');
    await expandAccountingPeriodFilters(page);
    assert.equal(await from.inputValue(), '2026-01-01');
    if (width > 860) {
      await tabs.getByRole('tab', { name: 'Journal', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await tabs.getByRole('tab', { name: 'Grand livre', exact: true }).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      assert.equal(await tabs.getByRole('tab', { name: 'Journal', exact: true }).getAttribute('aria-selected'), 'true');
    }
    await from.focus();
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await from.isVisible(), true, 'A focused date remains reachable when the window narrows');
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('.accounting-toolbar').evaluate(element => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      clipped: [...element.querySelectorAll('button,select,input')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 2).map(el => el.outerHTML.slice(0, 160)),
    }));
    assert.ok(layout.overflow <= 1);
    assert.deepEqual(layout.clipped, []);
    assert.deepEqual(errors, []);
    await page.locator('.accounting-toolbar').screenshot({ path: `${out}/${width}-filters.png` });
    report.push({ width, filtersPreserved: true, keyboardAndResize: true, populatedTotalsPreserved: true, layout });
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
