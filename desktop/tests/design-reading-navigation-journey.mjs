import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const useWebKit = process.env.ZENTRA_QA_BROWSER === 'webkit';
const out = fileURLToPath(new URL(`../../.qa/design-reading-${useWebKit ? 'webkit' : 'edge'}`, import.meta.url));
await mkdir(out, { recursive: true });
const browser = await (useWebKit ? webkit : chromium).launch({ headless: true, ...(!useWebKit && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 900 });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&designQr=1`);
    if (viewport.width > 860) await page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true }).click();
    const navigate = async name => {
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
    };
    for (const [shortcut, destination] of [['Devis en préparation', 'quotes'], ['Factures à encaisser', 'invoices'], ['Projets actifs', 'projects']]) {
      await page.locator('.activity-shortcuts').getByRole('button', { name: new RegExp(shortcut) }).click();
      await page.locator(`.desktop-app[data-view="${destination}"]`).waitFor();
      await navigate('Tableau de bord');
    }
    await navigate('Factures');
    await page.getByRole('button', { name: 'Aperçu de F-DEMO-2026-0042', exact: true }).click();
    await page.getByRole('button', { name: 'Ouvrir l’aperçu figé', exact: true }).click();
    const dialog = page.locator('.document-preview');
    await dialog.waitFor();
    const nav = dialog.getByRole('navigation', { name: 'Sections du document' });
    await nav.getByRole('button', { name: 'Paiement', exact: true }).waitFor();
    assert.equal(await nav.getByRole('button').count(), 5);
    const content = dialog.locator('.document-preview__viewport');
    const assertVisible = async selector => {
      await page.waitForFunction(selector => {
        const target = document.querySelector(selector).getBoundingClientRect();
        const area = document.querySelector('.document-preview__viewport').getBoundingClientRect();
        return target.top < area.bottom && target.bottom > area.top;
      }, selector);
    };
    for (const mode of ['Lecture', 'Mise en page']) {
      await dialog.getByRole('button', { name: mode, exact: true }).click();
      assert.ok((await content.boundingBox()).height >= 110, 'reading area should remain usable on short screens');
      for (const [name, selector] of [['Prestations', '.print-table'], ['Totaux', '.print-totals'], ['Paiement', '.swiss-qr-section']]) {
        await nav.getByRole('button', { name, exact: true }).click();
        await assertVisible(selector);
        await page.waitForFunction(name => document.querySelector('.document-preview__outline [aria-current]')?.textContent?.endsWith(name), name);
        assert.ok((await dialog.locator('.document-preview__header').boundingBox()).y >= -.5, 'section navigation must not scroll the header off screen');
      }
      await content.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.document-preview__progress span')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
      await nav.getByRole('button', { name: 'Document', exact: true }).click();
      await assertVisible('.print-header');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await dialog.getByRole('button', { name: 'Lecture', exact: true }).click();
    await nav.getByRole('button', { name: 'Totaux', exact: true }).click();
    await assertVisible('.print-totals');
    await page.waitForFunction(() => document.querySelector('.document-preview__outline [aria-current]')?.textContent?.endsWith('Totaux'));
    assert.ok(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no outer horizontal reading scroll');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const exportBounds = await dialog.getByRole('button', { name: 'Exporter le PDF', exact: true }).boundingBox();
    assert.ok(exportBounds.y >= 0 && exportBounds.y + exportBounds.height <= viewport.height + 1, 'export stays in the viewport');
    await page.screenshot({ path: `${out}/${viewport.width}x${viewport.height}-totals.png`, fullPage: false });
    await nav.getByRole('button', { name: 'Prestations', exact: true }).click();
    await assertVisible('.print-table');
    await page.waitForFunction(() => document.querySelector('.document-preview__outline [aria-current]')?.textContent?.endsWith('Prestations'));
    if (viewport.width > 860) {
      assert.notEqual(await dialog.locator('.print-table th').first().evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'reading table headings need contrasting text');
    }
    await page.screenshot({ path: `${out}/${viewport.width}x${viewport.height}-items.png`, fullPage: false });
    await page.emulateMedia({ media: 'print' });
    assert.equal(await nav.isVisible(), false, 'navigation never appears in the printed invoice');
    assert.equal(await dialog.locator('.document-preview__paper').evaluate(el => getComputedStyle(el).transform), 'none');
    await page.emulateMedia({ media: 'screen' });
    await dialog.getByRole('button', { name: 'Fermer l’aperçu', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#root').evaluate(el => el.inert), false);
    assert.deepEqual(errors, []);
    report.push({ ...viewport, shortcuts: true, navigation: true, scrollProgress: true, exportVisible: true, printClean: true });
    await page.close();
  }
} finally { await browser.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
