import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const out = '.qa/app-opening';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const reports = [];
try {
  for (const width of [320, 390, 1440]) {
    for (const blocked of ['native_ready', 'get_app_state', 'get_cloud_account_state', 'get_license_state']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 500 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install();
      await page.addInitScript(({ blocked }) => {
        window.qaOpening = { blocked, calls: [], release: [], retry: false };
        window.__ZENTRA_NATIVE_READY__ = blocked !== 'native_ready';
        window.__TAURI_INTERNALS__ = {
          invoke: async (command) => {
            const qa = window.qaOpening;
            qa.calls.push(command);
            if (command === qa.blocked && !qa.retry) {
              return new Promise((resolve, reject) => qa.release.push({ resolve, reject }));
            }
            if (command === 'get_app_state') return { onboarding_completed: false, schema_version: 49 };
            if (command === 'get_cloud_account_state') return { status: 'disconnected' };
            if (command === 'get_license_state') return { status: 'not_configured', enforcement_configured: false, read_only: false };
            if (command === 'get_noga_catalog') return { sections: [] };
            throw new Error(`Unexpected command in isolated opening test: ${command}`);
          },
        };
      }, { blocked });
      await page.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle' });
      await page.getByRole('status').filter({ hasText: 'Ouverture de votre espace' }).waitFor();
      assert.ok(await page.evaluate(() => window.qaOpening.blocked === 'native_ready'
        ? window.qaOpening.calls.length === 0 : window.qaOpening.release.length > 0));
      await page.clock.fastForward(75_001);
      await page.getByText(/L’ouverture prend trop de temps/).waitFor();
      const retry = page.getByRole('button', { name: 'Réessayer', exact: true });
      assert.equal(await retry.evaluate(button => button === document.activeElement), true);
      const box = await retry.boundingBox();
      assert.ok(box.height >= 44, `Touch target too small: ${box.height}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `${out}/${width}-${blocked}.png`, fullPage: true });
      await page.evaluate(() => { window.qaOpening.retry = true; window.__ZENTRA_NATIVE_READY__ = true; });
      await retry.click();
      await page.getByText('Restaurer une sauvegarde', { exact: true }).waitFor();
      // A late failure from the expired native call must not replace the recovered UI.
      await page.evaluate(() => { window.qaOpening.release.forEach(({ reject }) => reject(new Error('Ancienne erreur native'))); });
      await page.clock.fastForward(1000);
      assert.equal(await page.getByText('Restaurer une sauvegarde', { exact: true }).isVisible(), true);
      assert.equal(await page.getByText('Ancienne erreur native', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      reports.push({ width, blocked, timeoutVisible: true, retryRecovered: true, lateFailureIgnored: true, errors });
      await writeFile(`${out}/report.json`, JSON.stringify(reports, null, 2));
      await page.close();
    }
  }
  console.log(JSON.stringify(reports));
} finally { await browser.close(); }
