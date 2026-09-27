import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5367';
const out = '.qa/updater-policy-refusal';
const detail = 'Mise à jour refusée : l’installateur signé n’a pas pu être lancé (Une stratégie de contrôle d’application a bloqué ce fichier. (os error 4551)).';
await mkdir(out, { recursive: true });
const results = [];
for (const engine of ['chromium', 'webkit']) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
        await page.goto(`${base}/tests/mobile-harness.html?updaterBadge=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.locator('.update-launcher__badge').waitFor();
        await page.locator('.update-launcher').click();
        const dialog = page.getByRole('dialog', { name: 'Mise à jour de Zentra', exact: true });
        await dialog.getByRole('button', { name: 'Préparer l’installation 1.30.0', exact: true }).click();
        await dialog.getByRole('button', { name: 'Installer et redémarrer', exact: true }).click();
        await page.waitForFunction(() => window.__updaterQA.installs === 1);
        await page.evaluate(detail => window.__updaterQA.refuse(detail), detail);
        const alert = dialog.getByRole('alert');
        await alert.getByText(/Windows bloque cet installateur/).waitFor();
        assert.match(await alert.innerText(), /Gardez les protections Windows activées/);
        assert.ok(!(await alert.innerText()).includes('os error 4551'));
        assert.equal(await dialog.getByText(detail, { exact: true }).isVisible(), false);
        await dialog.locator('.app-updater__technical summary').click();
        assert.equal(await dialog.getByText(detail, { exact: true }).innerText(), detail);
        await dialog.locator('.app-updater__technical summary').click();
        await alert.scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: `${out}/${engine}-${width}.png` });
        await dialog.getByRole('button', { name: 'Réessayer la recherche', exact: true }).click();
        await dialog.getByRole('button', { name: 'Préparer l’installation 1.30.0', exact: true }).waitFor();
        assert.equal(await dialog.getByText(detail, { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.__updaterQA.installs), 1);
        assert.deepEqual(errors, []);
        results.push({ engine, width, passed: true, installs: 1, originalDetailPreserved: true });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await writeFile(`${out}/report.json`, JSON.stringify(results, null, 2)); }
}
console.log(JSON.stringify(results));
