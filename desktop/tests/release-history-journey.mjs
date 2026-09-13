import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const engines = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const browser = await engines[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const output = `.qa/release-history-${engine}`; await mkdir(output, { recursive: true });
const report = [], errors = [];
try {
  for (const lang of ['fr', 'de', 'it', 'en']) for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(language => localStorage.setItem('zentra.interface.language.v1', language), lang);
    await page.goto(`${process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271'}/tests/mobile-harness.html?updater=1&releaseHistory=${width === 390 ? 'mobile' : '1.63.0'}`);
    const launch = page.getByRole('button', { name: ({ fr: 'Mise à jour', de: 'Update', it: 'Aggiornamento', en: 'Update' })[lang], exact: true });
    await launch.click();
    const history = page.locator('.release-history');
    await history.waitFor();
    const current = history.locator(':scope > details').nth(0);
    const past = history.locator(':scope > details').nth(1);
    await current.locator(':scope > summary').click();
    await history.getByText(/1.63.0/).waitFor();
    assert.equal(await current.locator('li').count(), 3);
    await past.locator(':scope > summary').click();
    assert.equal(await past.locator('.release-history__entry').count(), 4);
    for (const entry of await past.locator('.release-history__entry').all()) await entry.locator('summary').click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert(await history.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${lang}-${width}.png` });
    await page.context().setOffline(true);
    await current.locator(':scope > summary').click();
    await current.locator(':scope > summary').click();
    assert.equal(await current.locator('li').count(), 3);
    assert.equal(await page.evaluate(() => window.__updaterQA.installs), 0);
    report.push({ lang, width, mobile: width === 390, offline: true, passed: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await writeFile(`${output}/report.json`, JSON.stringify({ report, errors }, null, 2)); }
console.log(JSON.stringify(report));
