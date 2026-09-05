import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/workspace-recovery', { recursive: true });
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    for (const leaveForm of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => report.push({ width, leaveForm, error: error.message }));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?purchasing=1');
      const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
      if (await tour.isVisible()) await tour.click();
      const navigate = async (name) => {
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
        await page.locator('.navigation-palette').waitFor({ state: 'detached' });
      };
      const writes = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-purchase-order-attempts') || '[]'));
      const readCount = () => page.evaluate(() => Number(sessionStorage.getItem('qa-purchase-read-count') || 0));
      const releaseRead = () => page.evaluate(() => window.dispatchEvent(new Event('qa-release-workspace-read')));
      await navigate('Achats & fournisseurs');
      await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Nouvelle commande fournisseur', exact: true });
      await form.getByRole('textbox', { name: /^Titre/ }).fill('Reprise après lecture interrompue');
      await form.getByRole('combobox', { name: 'Article du catalogue', exact: true }).selectOption('product-purchase-qa');
      await form.getByRole('spinbutton', { name: /^Quantité/ }).fill('10');
      await page.evaluate(() => { sessionStorage.setItem('qa-purchase-order-failure', 'refresh_held'); sessionStorage.setItem('qa-purchase-block-reads', '1'); });
      await form.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
      await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-purchase-persisted') || '{}').orders === 1 && Number(sessionStorage.getItem('qa-purchase-read-count')) === 1);
      if (leaveForm) {
        await form.getByRole('button', { name: 'Fermer « Nouvelle commande fournisseur »', exact: true }).click();
        await navigate('Clients');
      }
      await releaseRead();
      const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
      await recovery.waitFor();
      assert.equal(await readCount(), 2);
      assert.equal((await writes()).length, 1);
      assert.equal(await page.getByRole('dialog').count(), 1, 'only recovery remains accessible');
      assert.ok(await page.locator('#root').evaluate((node) => node.hasAttribute('inert') && node.getAttribute('aria-hidden') === 'true'));
      const pausedChecks = await page.evaluate(() => {
        const before = Number(sessionStorage.getItem('qa-purchase-reminder-checks'));
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        return { before, after: Number(sessionStorage.getItem('qa-purchase-reminder-checks')) };
      });
      assert.equal(pausedChecks.after, pausedChecks.before, 'automatic reminder scans pause during recovery');
      await page.keyboard.press('Escape');
      await recovery.locator('..').dispatchEvent('mousedown');
      assert.ok(await recovery.isVisible(), 'unrefreshed workspace cannot be reopened through dismissal');
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press('Tab');
        assert.ok(await recovery.evaluate((node) => node.contains(document.activeElement)), 'focus stays in recovery');
      }
      const prefix = `${width}-${leaveForm ? 'after-navigation' : 'same-form'}`;
      await page.screenshot({ path: `.qa/workspace-recovery/${prefix}-pending.png` });
      await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
      await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
      assert.equal(await readCount(), 3);
      assert.equal((await writes()).length, 1, 'a failed manual refresh never replays the original write');
      await page.waitForFunction(() => {
        const dialog = document.querySelector('.workspace-recovery').closest('[role="dialog"]');
        const panel = dialog.querySelector('.error-panel').getBoundingClientRect();
        const header = dialog.querySelector('.modal__header').getBoundingClientRect();
        const footer = dialog.querySelector('.form-actions').getBoundingClientRect();
        return panel.top >= header.bottom && panel.bottom <= footer.top && footer.bottom <= innerHeight + 1;
      });
      await page.screenshot({ path: `.qa/workspace-recovery/${prefix}-read-refused.png` });
      await page.evaluate(() => { sessionStorage.removeItem('qa-purchase-block-reads'); sessionStorage.setItem('qa-purchase-hold-next-read', '1'); });
      await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).evaluate((button) => { button.click(); button.click(); });
      await recovery.getByRole('button', { name: 'Actualisation…', exact: true }).waitFor();
      assert.equal(await readCount(), 4, 'repeated clicks share the pending read');
      assert.equal((await writes()).length, 1);
      await releaseRead();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.ok(await page.locator('#root').evaluate((node) => !node.hasAttribute('inert') && node.getAttribute('aria-hidden') === null));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForFunction((previous) => Number(sessionStorage.getItem('qa-purchase-reminder-checks')) > previous, pausedChecks.before);
      if (leaveForm) {
        await page.getByRole('heading', { name: 'Clients', exact: true }).waitFor();
        await navigate('Achats & fournisseurs');
      }
      if (width <= 860) await page.getByRole('combobox', { name: 'Section des achats', exact: true }).selectOption('orders');
      else await page.locator('#purchase-tab-orders').click();
      await page.locator('.supplier-order-card').filter({ hasText: 'Reprise après lecture interrompue' }).waitFor();
      assert.equal(await page.locator('.supplier-order-card').count(), 1);
      assert.equal((await writes()).length, 1);
      assert.equal(await readCount(), 4);
      assert.ok(await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).isEnabled());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `.qa/workspace-recovery/${prefix}-recovered.png` });
      report.push({ width, leaveForm, result: 'PASS one acknowledged write, persistent read errors, optional form closure and navigation, accessible recovery only, read-only retries, double click guard, fresh workspace and controls restored' });
      await page.close();
    }
  }
  assert.deepEqual(report.filter((item) => item.error), []);
} catch (error) {
  report.push({ fatal: error.stack }); process.exitCode = 1;
  const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
  if (page) { await page.screenshot({ path: '.qa/workspace-recovery/failure.png' }); await writeFile('.qa/workspace-recovery/failure.html', await page.content()); }
} finally {
  await writeFile('.qa/workspace-recovery/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser.close();
}
