import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
try {
  // Run against Vite with TAURI_ENV_PLATFORM=ios. UIKit itself is checked by NavigationTests.swift.
  for (const mode of ['available', 'old-ios', 'missing-plugin']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript((mode) => {
      let sequence = 0;
      let channel;
      window.isTauri = true;
      window.__nativeCalls = [];
      window.__TAURI_INTERNALS__ = {
        transformCallback() { return ++sequence; }, unregisterCallback() {},
        async invoke(command, args) {
          if (command === 'plugin:zentra-mobile|configure_navigation') {
            window.__nativeCalls.push({ selected: args.selected, visible: args.visible });
            channel = args.onNavigate;
            if (mode === 'missing-plugin') throw Error('Plugin unavailable in an older installation');
            return { available: mode === 'available' };
          }
          return null;
        },
      };
      window.__nativeNavigate = (id) => channel.onmessage({ id });
    }, mode);
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5189'}/tests/mobile-harness.html?browsing=1&design=1&designQr=1`);
    await page.locator('.topbar h1').waitFor();
    await page.waitForFunction(() => window.__nativeCalls.length > 0);
    if (mode === 'available') {
      await page.locator('.mobile-navigation').waitFor({ state: 'hidden' });
      await page.evaluate(() => window.__nativeNavigate('projects'));
      await page.getByRole('heading', { name: 'Projets', exact: true }).waitFor();
      await page.evaluate(() => window.__nativeNavigate('quotes'));
      await page.getByRole('button', { name: 'Nouveau devis', exact: true }).click();
      await page.waitForFunction(() => window.__nativeCalls.at(-1).visible === false);
      const heading = await page.locator('.topbar h1').innerText();
      await page.evaluate(() => window.__nativeNavigate('dashboard'));
      assert.equal(await page.locator('.topbar h1').innerText(), heading, 'modal blocks navigation');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__nativeCalls.at(-1).visible === true);
      await page.evaluate(() => window.__nativeNavigate('menu'));
      await page.locator('.sidebar.is-open').waitFor();
      await page.waitForFunction(() => window.__nativeCalls.at(-1).visible === false);
    } else {
      await page.locator('.mobile-navigation').waitFor({ state: 'visible' });
      await page.getByRole('navigation', { name: 'Navigation mobile', exact: true }).getByRole('button', { name: 'Projets' }).click();
      await page.getByRole('heading', { name: 'Projets', exact: true }).waitFor();
    }
    report.push({ mode, passed: true });
    await page.close();
  }
} finally {
  await browser.close();
  await mkdir(new URL('../../.qa/apple-native/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../.qa/apple-native/bridge.json', import.meta.url), JSON.stringify(report, null, 2));
}
console.log(report);
