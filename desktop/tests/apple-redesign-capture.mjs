import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5363';
const output = path.resolve(process.env.ZENTRA_QA_OUTPUT || 'outputs/apple-redesign/baseline');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const cases = [
  ['desktop-home', 1440, 1000, 'light', '', ''],
  ['desktop-sales', 1440, 1000, 'light', '', 'Devis'],
  ['desktop-automation', 1440, 1000, 'light', 'automation=active&automationDesign=1', ''],
  ['mobile-home', 390, 844, 'light', '', ''],
  ['mobile-notes', 390, 844, 'light', 'notes=1', 'Notes'],
  ['mobile-settings-dark', 390, 844, 'dark', '', 'Paramètres'],
];
const results = [];
for (const [name, width, height, theme, extra, route] of cases) {
  const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 600, hasTouch: width < 600 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&theme=${theme}&${extra}`, { waitUntil: 'networkidle' });
  const dismiss = page.getByRole('button', { name: 'Découvrir plus tard' });
  if (await dismiss.isVisible()) await dismiss.click();
  if (route) {
    await page.keyboard.press('Control+k');
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(route);
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText(route, { exact: true }) }).click();
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
    await new Promise(requestAnimationFrame);
  });
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  results.push({ name, errors, view: await page.locator('.desktop-app').getAttribute('data-view'), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) });
  await page.close();
}
await browser.close();
await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
