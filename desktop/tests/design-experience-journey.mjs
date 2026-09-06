import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const useWebKit = process.env.ZENTRA_QA_BROWSER === 'webkit';
const out = fileURLToPath(new URL(useWebKit ? '../../.qa/design-experience-webkit' : '../../.qa/design-experience', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await (useWebKit ? webkit : chromium).launch({ headless: true, ...(!useWebKit && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
try {
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 940 }, hasTouch: width < 800 });
    page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(60000);
    const errors = []; page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5191'}/tests/mobile-harness.html?browsing=1&design=1`);
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (width > 860) {
      await tour.waitFor({ state: 'visible' });
      await tour.click();
    }
    const navigate = async name => {
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
      await page.locator('.navigation-palette').waitFor({ state: 'detached' });
    };
    const capture = async stage => {
      // Observe current finite animations; replaced transitions and changing spinners must not leave a stale promise pending.
      await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).every(animation => animation.playState === 'finished' || animation.playState === 'idle'), null, { timeout: 5000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${stage} outer overflow`);
      await page.screenshot({ path: `${out}/${width}-${stage}.png` });
    };
    await capture('dashboard');
    if (width === 1440) assert.ok((await page.locator('.page-content').boundingBox()).x < 340, 'desktop content should sit beside the navigation');
    for (const name of ['Devis', 'Factures']) {
      await navigate(name);
      assert.match(await page.locator('.page-content').evaluate(el => getComputedStyle(el).animationName), /experience-page-in/);
      await capture(name === 'Devis' ? 'quotes' : 'invoices');
      const previewButton = page.locator('.sales-documents .document-actions button').filter({ has: page.locator('svg.lucide-eye') }).first();
      // Some sales actions use their accessible title without an eye icon.
      const buttons = await page.locator('.sales-documents .document-actions button').evaluateAll(els => els.map(el => ({ label: el.getAttribute('aria-label'), title: el.title, text: el.textContent })));
      await writeFile(`${out}/${width}-actions.json`, JSON.stringify(buttons));
      await previewButton.click();
      const dialog = page.getByRole('dialog', { name: new RegExp(name === 'Devis' ? 'Devis' : 'Facture') });
      await dialog.waitFor();
      assert.ok(await page.locator('#root').evaluate(el => el.inert), 'background should be inert');
      assert.equal(await dialog.locator('.print-table tbody tr').count(), 3);
      await dialog.getByRole('button', { name: 'Lecture', exact: true }).click();
      const viewport = dialog.locator('.document-preview__viewport');
      assert.ok(await viewport.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${width} reading overflow`);
      await capture(name === 'Devis' ? 'quote-reading' : 'invoice-reading');
      await dialog.getByRole('button', { name: /^Aller au total du document/ }).click();
      await page.waitForFunction(() => { const total = document.querySelector('.document-preview .print-totals').getBoundingClientRect(); const viewport = document.querySelector('.document-preview__viewport').getBoundingClientRect(); return total.top < viewport.bottom && total.bottom > viewport.top; });
      await dialog.getByRole('button', { name: 'Mise en page', exact: true }).click();
      await dialog.getByRole('button', { name: 'Ajuster à la largeur' }).click();
      await page.waitForFunction(() => { const el = document.querySelector('.document-preview__viewport'); return el.scrollWidth <= el.clientWidth + 1; });
      const before = await dialog.locator('output').innerText();
      await dialog.getByRole('button', { name: 'Agrandir le document' }).click();
      assert.notEqual(await dialog.locator('output').innerText(), before);
      await dialog.getByRole('button', { name: 'Ajuster à la largeur' }).click();
      await capture(name === 'Devis' ? 'quote-page' : 'invoice-page');
      await page.evaluate(() => sessionStorage.setItem('design-export-fail', '1'));
      await dialog.getByRole('button', { name: 'Exporter le PDF' }).click();
      await dialog.getByRole('alert').filter({ hasText: 'Le fichier est déjà ouvert' }).waitFor();
      await page.evaluate(() => sessionStorage.removeItem('design-export-fail'));
      await dialog.getByRole('button', { name: 'Exporter le PDF' }).click();
      await dialog.getByRole('status').filter({ hasText: '2 pages' }).waitFor();
      assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem('design-export'))).entity, name === 'Devis' ? 'quotes' : 'invoices');
      // Focus is trapped in the preview, Escape closes and restores the opener.
      await dialog.getByRole('button', { name: 'Exporter le PDF' }).focus();
      await page.keyboard.press('Tab');
      assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)));
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#root').evaluate(el => el.inert), false);
      assert.ok(await page.evaluate(() => document.activeElement?.closest('.document-actions')));
    }
    for (const name of ['Projets', 'Clients', 'Achats & fournisseurs', 'Comptabilité', 'Paramètres']) {
      await navigate(name); await capture(name.toLowerCase());
    }
    await navigate('Devis');
    await page.getByRole('button', { name: 'Nouveau devis', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Nouveau devis', exact: true });
    await editor.waitFor();
    assert.ok(await editor.locator('.modal__body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'document editor must fit the viewport');
    await capture('editor');
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await navigate('Devis');
    assert.equal(await page.locator('.page-content').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.deepEqual(errors, []);
    report.push({ width, passed: true, previewModes: ['reading', 'page'], exportRetry: true, focusRestored: true, reducedMotion: true });
    await page.close();
  }
} finally { await browser.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
