import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const out = fileURLToPath(new URL('../../.qa/section-menu-layout', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&finance=1&closing=1&designLedger=1&designTrial=1`);
  await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();

  async function choose(label, value) {
    const select = page.locator(`.section-navigation select[aria-label="${label}"]`);
    const title = await select.locator(`option[value="${value}"]`).textContent();
    if (await select.isVisible()) {
      const before = await select.evaluate(el => ({ width: innerWidth, rootFont: getComputedStyle(document.documentElement).fontSize, parent: el.closest('.section-navigation').getBoundingClientRect().toJSON(), rect: el.getBoundingClientRect().toJSON() }));
      try { await select.selectOption(value, { timeout: 5000 }); }
      catch (error) {
        console.log(JSON.stringify({ label, value, before, after: await select.evaluate(el => ({ parent: el.closest('.section-navigation').getBoundingClientRect().toJSON(), rect: el.getBoundingClientRect().toJSON(), picker: getComputedStyle(el.closest('.section-navigation__mobile')).display })) }));
        await page.screenshot({ path: `${out}/failed.png` });
        throw error;
      }
    }
    else await page.getByRole('tablist', { name: label, exact: true }).getByRole('tab', { name: title, exact: true }).click();
    assert.equal(await select.inputValue(), value);
    const menu = select.locator('xpath=ancestor::div[contains(@class,"section-navigation")]');
    const picker = menu.locator('.section-navigation__picker');
    if (await picker.isVisible()) {
      assert.equal(await menu.locator('.section-navigation__current > span:nth-child(2)').textContent(), title);
      await select.focus();
      const fit = await picker.evaluate(element => {
        const box = element.getBoundingClientRect();
        const label = element.querySelector('.section-navigation__current > span:nth-child(2)');
        const text = label.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(label);
        return {
          centered: Math.abs((text.left + text.right - box.left - box.right) / 2) < 1,
          linesFit: [...range.getClientRects()].every(r => r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom),
          focusVisible: getComputedStyle(element).outlineStyle !== 'none',
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert.equal(fit.centered, true, `${title}: centered label`);
      assert.equal(fit.linesFit, true, `${title}: all lines visible`);
      assert.equal(fit.focusVisible, true, 'Native keyboard control has a visible focus ring');
      assert.ok(fit.pageOverflow <= 1, `${title}: no page overflow`);
    }
    return await picker.isVisible() ? 'picker' : 'tabs';
  }

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const textScale of [100, 200]) {
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, textScale);
      // Container queries settle after the viewport and root text-size change.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForTimeout(180);
      for (const value of ['journal', 'ledger', 'trial', 'balance', 'income', 'closing', 'accounts', 'periods', 'vat']) {
        const mode = await choose('Section comptable', value);
        report.push({ width, textScale, section: value, mode });
      }
      for (const value of ['return', 'profile', 'adjustments', 'history']) {
        const mode = await choose('Section TVA', value);
        report.push({ width, textScale, section: `vat-${value}`, mode });
      }
      await choose('Section comptable', 'closing');
      if ([320, 390, 1440].includes(width)) await page.locator('.accounting-toolbar').screenshot({ path: `${out}/${width}-${textScale}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ layouts: report.length, errors }));
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
