import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/accounting-setup-entry', reports = [];
await mkdir(output, { recursive: true });
for (const [engine, driver] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await driver.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(14000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => { errors.push('Unexpected native confirmation'); await dialog.dismiss(); });
      try {
        await page.goto(`${base}/tests/mobile-harness.html?accountingSetup=starter`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
        await page.getByRole('button', { name: 'Configurer simplement', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Configurer mes finances', exact: true });
        await settings.getByRole('radio').first().check();
        await settings.getByRole('button', { name: 'Vérifier mes choix', exact: true }).click();
        await settings.getByRole('button', { name: 'Appliquer ces réglages', exact: true }).click();
        await page.getByRole('button', { name: 'Préparer les comptes suisses', exact: true }).click();
        const starter = page.getByRole('dialog', { name: 'Démarrer la comptabilité', exact: true });
        await starter.waitFor();
        assert.equal(await page.getByRole('dialog').count(), 1);
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-accounting-setup')).writes.length), 0);
        await starter.getByRole('button', { name: 'Revenir aux réglages', exact: true }).click();
        await page.getByRole('heading', { name: 'Comptes de liaison', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Installer la base essentielle', exact: true }).click();
        await starter.getByRole('button', { name: 'Créer les comptes et activer', exact: true }).click();
        await page.getByRole('dialog', { name: 'La configuration est enregistrée', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-accounting-setup')).writes.length), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: `${output}/${engine}-${width}.png` });
        assert.deepEqual(errors, []);
        reports.push({ engine, width, result: 'PASS commercial defaults to accounting review, one dialog, cancel without write, explicit activation' });
        console.log(JSON.stringify(reports.at(-1)));
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2)); }
}
