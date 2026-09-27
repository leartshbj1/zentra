import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5367';
const largeOnly = process.env.ZENTRA_QA_LARGE_ONLY === 'true';
const out = largeOnly ? '.qa/updater-languages-large-final' : '.qa/updater-languages';
await mkdir(out, { recursive: true });
const report = [];
const configs = ['fr', 'de', 'it', 'en'].flatMap(language => [320, 1440].map(width => ({ language, width, mode: 'desktop', scale: 100 })));
configs.push({ language: 'de', width: 320, mode: 'desktop', scale: 200 });
configs.push(...['fr', 'de', 'it', 'en'].map(language => ({ language, width: 390, mode: 'mobile', scale: 100 })));
for (const engine of ['chromium', 'webkit']) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'msedge' } : {}) });
  try {
    for (const config of configs.filter(config => !largeOnly || config.scale === 200)) {
      const { language, width, mode, scale } = config;
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const tr = (source, values) => page.evaluate(async ({ source, values }) => (await import('/src/language.ts')).t(source, values), { source, values });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const name = `${engine}-${language}-${width}-${mode}-${scale}`;
      async function shot(state) {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Viewport fits');
        const clipped = await page.locator('.app-updater button,.app-updater__steps strong,.app-updater__facts strong').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && n.scrollWidth > n.clientWidth + 2).map(n => n.textContent));
        assert.deepEqual(clipped, [], 'Update controls retain their full labels');
        await page.screenshot({ path: `${out}/${name}-${state}.png`, animations: 'disabled' });
      }
      try {
        await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
        await page.addInitScript(({ language, scale }) => {
          localStorage.setItem('zentra.interface.language.v1', language);
          localStorage.setItem('zentra.appearance.v1', ['de', 'en'].includes(language) ? 'dark' : 'light');
          localStorage.setItem('zentra.text-size.v1', String(scale));
        }, { language, scale });
        await page.goto(`${base}/tests/mobile-harness.html?updaterBadge=1${mode === 'mobile' ? '&releaseHistory=mobile' : ''}`);
        await page.waitForFunction(async language => { const state = (await import('/src/language.ts')).getLanguageState(); return state.ready && state.language === language; }, language);
        await page.locator('.guided-tour__card > header > button').click();
        if (mode !== 'mobile') await page.locator('.update-launcher__badge').waitFor();
        if (mode === 'mobile') {
          await page.getByRole('button', { name: await tr('Ouvrir la navigation'), exact: true }).click();
          await page.locator('.sidebar__updates').click();
        } else await page.locator('.update-launcher').click();
        const dialog = page.getByRole('dialog', { name: await tr('Mise à jour de Zentra'), exact: true });
        await dialog.waitFor();
        if (mode === 'mobile') {
          await dialog.getByRole('heading', { name: await tr('Mises à jour mobiles'), exact: true }).waitFor();
          const source = 'Les mises à jour mobiles ne s’installent pas depuis cet écran. Utilisez la boutique ou l’outil avec lequel vous avez installé Zentra.';
          await dialog.getByText(await tr(source), { exact: true }).waitFor();
          assert.equal(await dialog.locator('.app-updater__actions').count(), 0);
          assert.equal(await page.evaluate(() => window.__updaterQA.installs), 0);
          assert.ok(!(await dialog.innerText()).includes('Google Play'));
          await shot('instructions');
        } else {
          const ready = await tr('Zentra {version} est prête à télécharger.', { version: '1.30.0' });
          await dialog.getByText(ready, { exact: true }).waitFor();
          if (language !== 'fr') assert.ok(!ready.includes('prête à télécharger'));
          await shot('ready');
          await dialog.getByRole('button', { name: await tr('Préparer l’installation {version}', { version: '1.30.0' }), exact: true }).click();
          const install = dialog.getByRole('button', { name: await tr('Installer et redémarrer'), exact: true });
          await install.scrollIntoViewIfNeeded(); await shot('confirmation');
          await install.click();
          await dialog.getByRole('progressbar').waitFor();
          assert.equal(await page.evaluate(() => window.__updaterQA.installs), 1);
          await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true);
          const detail = 'Contrôle Windows : erreur connue (os error 4551).';
          await page.evaluate(detail => window.__updaterQA.refuse(detail), detail);
          const explanation = 'Windows bloque cet installateur avec sa protection des applications. Contactez le support Zentra pour obtenir une version reconnue. Gardez les protections Windows activées ; réessayer le même fichier ne corrigera pas ce refus.';
          await dialog.getByRole('alert').getByText(await tr(explanation), { exact: true }).waitFor();
          assert.equal(await dialog.getByText(detail, { exact: true }).isVisible(), false);
          const technical = dialog.locator('.app-updater__technical summary');
          await technical.click(); await dialog.getByText(detail, { exact: true }).waitFor();
          await dialog.locator('.app-updater__technical').scrollIntoViewIfNeeded(); await shot('technical');
          await technical.click(); await dialog.getByRole('alert').scrollIntoViewIfNeeded(); await shot('refusal');
          await page.evaluate(() => { window.__updaterQA.available = false; });
          await dialog.getByRole('button', { name: await tr('Réessayer la recherche'), exact: true }).click();
          await dialog.getByText(await tr('Zentra {version} est déjà à jour.', { version: '1.29.0' }), { exact: true }).waitFor();
          assert.equal(await dialog.getByText(detail, { exact: true }).count(), 0);
          assert.equal(await page.evaluate(() => window.__updaterQA.installs), 1);
        }
        assert.deepEqual(errors, []);
        report.push({ engine, ...config, passed: true });
      } catch (error) {
        await page.screenshot({ path: `${out}/${name}-failure.png` });
        report.push({ engine, ...config, error: String(error.stack) });
      } finally { await page.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); }
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify(report));
if (report.some(row => !row.passed)) process.exitCode = 1;
