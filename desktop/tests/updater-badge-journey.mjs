import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5199';
const report = [], errors = [];
await mkdir('.qa/updater-badge', { recursive: true });
try {
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/tests/mobile-harness.html?updaterBadge=1`);
    await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
    const badge = page.locator('.update-launcher__badge');
    await badge.waitFor({ timeout: 20000 });
    assert.equal(await badge.innerText(), '1');
    await page.getByRole('button', { name: 'Masquer la notification de mise à jour', exact: true }).click();
    assert.equal(await badge.isVisible(), true);
    const launcher = page.locator('.update-launcher');
    assert.match(await launcher.getAttribute('aria-label'), /1 mise à jour disponible/);
    const box = await badge.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0);
    await page.screenshot({ path: `.qa/updater-badge/${width}-badge.png` });
    await launcher.click();
    const dialog = page.getByRole('dialog', { name: 'Mise à jour de Zentra', exact: true });
    const prepare = dialog.getByRole('button', { name: 'Préparer l’installation 1.30.0', exact: true });
    await prepare.waitFor();
    const before = await page.evaluate(() => window.__updaterQA.checks);
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
    assert.equal(await page.evaluate(() => window.__updaterQA.checks), before);
    await prepare.click();
    await dialog.getByRole('button', { name: 'Installer et redémarrer', exact: true }).click();
    await dialog.getByRole('progressbar').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true);
    await page.evaluate(() => window.__updaterQA.refuse());
    await dialog.getByText('Téléchargement de recette interrompu.', { exact: true }).waitFor();
    assert.equal(await badge.isVisible(), true);
    await page.evaluate(() => { window.__updaterQA.offline = true; });
    await dialog.getByRole('button', { name: 'Réessayer la recherche', exact: true }).click();
    await dialog.getByText('Connexion de recette indisponible.', { exact: true }).waitFor();
    assert.equal(await badge.isVisible(), true);
    await page.evaluate(() => { window.__updaterQA.offline = false; window.__updaterQA.available = false; });
    await dialog.getByRole('button', { name: 'Réessayer la recherche', exact: true }).click();
    await badge.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__updaterQA.installs), 1);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.push({ width, badgeAfterDismiss: true, opensReady: true, preservesDuringOffline: true, withdrawnClears: true, installProtected: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', report }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await writeFile('.qa/updater-badge/report.json', JSON.stringify({ report, errors }, null, 2)); await browser.close(); }
