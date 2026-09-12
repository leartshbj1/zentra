import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/invoice-issue';
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, driver] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await driver.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(14000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => { errors.push(`Unexpected native confirmation: ${dialog.message()}`); await dialog.dismiss(); });
      const snapshot = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-pair-snapshot')));
      const attempts = () => page.evaluate(() => Number(sessionStorage.getItem('qa-pair-issue-attempts') || 0));
      const capture = async label => { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: `${output}/${engine}-${width}-${label}.png` }); };
      try {
        await page.goto(`${base}/tests/mobile-harness.html?quotePair=1&issueGuide=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Factures');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Factures', { exact: true }) }).click();
        const original = (await snapshot()).invoices[0];
        await page.getByRole('button', { name: 'Émettre', exact: true }).click();
        const issue = page.getByRole('dialog', { name: 'Émettre la facture', exact: true });
        await issue.getByText('Complétons les dates', { exact: true }).waitFor();
        assert.ok(await issue.getByRole('button', { name: 'Confirmer et émettre la facture', exact: true }).isDisabled());
        assert.equal(await attempts(), 0);
        await capture('missing-date');
        await issue.getByRole('button', { name: 'Corriger les dates', exact: true }).click();
        const conditions = page.locator('[data-document-step="2"]');
        await conditions.waitFor({ state: 'visible' });
        assert.equal(await page.getByRole('button', { name: '3. Conditions', exact: true }).getAttribute('aria-current'), 'step');
        await conditions.getByLabel('Début de la prestation', { exact: false }).fill('2026-09-01');
        await page.getByRole('button', { name: 'Continuer', exact: true }).click();
        await page.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
        await page.getByRole('button', { name: 'Reprendre la facture', exact: true }).click();
        await issue.getByText('Ajoutez le compte de paiement', { exact: true }).waitFor();
        await issue.getByRole('button', { name: 'Compléter les coordonnées bancaires', exact: true }).click();
        await page.locator('#settings-company-billing').waitFor({ state: 'visible' });
        const iban = page.locator('input[name=iban]');
        assert.ok(await iban.isVisible());
        await iban.fill('CH9300762011623852957');
        await page.getByRole('button', { name: 'Enregistrer l’entreprise', exact: true }).click();
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-pair-snapshot')).settings.billing.iban === 'CH9300762011623852957');
        await page.getByRole('button', { name: 'Reprendre la facture', exact: true }).click();
        await issue.waitFor();
        assert.equal(await issue.getByRole('alert').count(), 0);
        assert.match(await issue.locator('.invoice-issue__total').innerText(), /1[’'\s]?081.00/);
        await capture('ready');
        await page.evaluate(() => window.__qaSetReadOnly(true));
        await page.waitForFunction(() => document.querySelector('.invoice-issue button[type=submit]')?.disabled);
        await issue.getByRole('button', { name: 'Confirmer et émettre la facture', exact: true }).evaluate(button => button.click());
        assert.equal(await attempts(), 0);
        await page.evaluate(() => { window.__qaSetReadOnly(false); sessionStorage.setItem('qa-pair-issue-message', 'La liaison du compte comptable manque.'); });
        await issue.getByRole('button', { name: 'Confirmer et émettre la facture', exact: true }).click();
        await issue.getByRole('button', { name: 'Vérifier les comptes', exact: true }).waitFor();
        await capture('accounting-help');
        await issue.getByRole('button', { name: 'Vérifier les comptes', exact: true }).click();
        await page.getByRole('heading', { name: 'Comptes de liaison', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Reprendre la facture', exact: true }).click();
        await page.evaluate(() => { sessionStorage.removeItem('qa-pair-issue-message'); sessionStorage.setItem('qa-pair-recover', 'issue'); });
        await issue.getByRole('button', { name: 'Confirmer et émettre la facture', exact: true }).click();
        const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await recovery.waitFor();
        assert.equal(await attempts(), 2);
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
        assert.equal(await attempts(), 2);
        await page.evaluate(() => sessionStorage.removeItem('qa-pair-block-reads'));
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.waitFor({ state: 'detached' }); await issue.waitFor({ state: 'detached' });
        assert.equal(await page.getByRole('button', { name: 'Reprendre la facture', exact: true }).count(), 0);
        const saved = (await snapshot()).invoices[0];
        assert.equal(saved.id, original.id); assert.equal(saved.status, 'issued');
        assert.equal(saved.serviceDateFrom, '2026-09-01'); assert.equal(saved.notes, original.notes); assert.deepEqual(saved.lines, original.lines);
        assert.equal((await snapshot()).payments.length, 0);
        assert.equal(await attempts(), 2);
        assert.deepEqual(errors, []);
        reports.push({ engine, width, height, result: 'PASS dates correction, exact editor step, bank settings, accounting navigation, resume same invoice, read-only, preview amounts and read-only recovery after issue' });
        console.log(JSON.stringify(reports.at(-1)));
      } catch (error) { await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` }); await writeFile(`${output}/${engine}-${width}-failure.txt`, await page.locator('body').innerText()); reports.push({ engine, width, height, error: error.stack }); throw error; }
      finally { await page.close(); }
    }
  } finally { await browser.close(); await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2)); }
}
