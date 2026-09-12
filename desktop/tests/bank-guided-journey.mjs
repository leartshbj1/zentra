import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/bank-guided';
await mkdir(output, { recursive: true });
const reports = [];
async function navigate(page, title) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(title);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(title, { exact: true }) }).click();
}
const flag = (page, key, value) => page.evaluate(([key, value]) => value ? sessionStorage.setItem(key, '1') : sessionStorage.removeItem(key), [key, value]);
const count = (page, key) => page.evaluate(key => Number(sessionStorage.getItem(key) || 0), key);
async function openImport(page) {
  await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).click();
  return page.getByRole('dialog', { name: 'Importer un relevé bancaire', exact: true });
}
async function readable(page, dialog, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page fits viewport');
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'Dialog fits viewport');
  await page.screenshot({ path: `${output}/${name}.png` });
}
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(14000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${base}/tests/mobile-harness.html?finance=1&bank=1&bankUnlinked=1`);
        await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
        await navigate(page, 'Banque');
        const importer = await openImport(page);
        assert.equal(await importer.getByRole('button', { name: 'Importer ce relevé', exact: true }).isDisabled(), true);
        await flag(page, 'qa-bank-cancel-file', true);
        await importer.getByRole('button', { name: 'Choisir le relevé XML', exact: true }).click();
        assert.equal(await count(page, 'qa-bank-import-attempts'), 0);
        assert.equal(await importer.getByRole('button', { name: 'Importer ce relevé', exact: true }).isDisabled(), true);
        await flag(page, 'qa-bank-cancel-file', false);
        await importer.getByRole('button', { name: 'Choisir le relevé XML', exact: true }).click();
        await importer.getByRole('checkbox').uncheck();
        await flag(page, 'qa-bank-reject-file', true);
        await importer.getByRole('button', { name: 'Importer ce relevé', exact: true }).click();
        await importer.getByText('Le format du relevé doit être vérifié', { exact: true }).waitFor();
        assert.equal(await importer.getByRole('checkbox').isChecked(), false);
        assert.equal(await importer.getByText('releve-recette.xml', { exact: true }).isVisible(), true);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
        assert.equal(await importer.locator('[role=alert]').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true);
        await readable(page, importer, `${engine}-${width}-import-help`);
        await flag(page, 'qa-bank-reject-file', false);
        await flag(page, 'qa-bank-fail-import-refresh', true);
        await importer.getByRole('button', { name: 'Importer ce relevé', exact: true }).click();
        await importer.getByText('Import enregistré, affichage à actualiser', { exact: true }).waitFor();
        assert.equal(await count(page, 'qa-bank-import-attempts'), 2);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-bank-import-automatic')), 'false');
        await importer.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        assert.equal(await count(page, 'qa-bank-import-attempts'), 2);
        await page.evaluate(() => ['qa-bank-fail-import-refresh', 'qa-bank-workspace-refresh-fail', 'qa-bank-refresh-fail'].forEach(key => sessionStorage.removeItem(key)));
        await importer.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await importer.getByRole('button', { name: 'Vérifier les comptes du relevé', exact: true }).click();
        await importer.waitFor({ state: 'detached' });
        assert.equal(await page.locator('.bank-accounts .is-unlinked').count(), 1);
        const accounts = page.locator('.bank-accounts');
        await accounts.getByRole('button', { name: 'Associer ce compte', exact: true }).click();
        const associate = page.getByRole('dialog', { name: 'Associer le compte bancaire', exact: true });
        await associate.getByRole('button', { name: 'Revenir aux mouvements', exact: true }).click();
        assert.equal(await accounts.locator('.is-unlinked').count(), 1);
        const customer = page.locator('.bank-movement').filter({ hasText: 'Client acompte' });
        await customer.getByRole('button', { name: 'Vérifier ce compte', exact: true }).click();
        await associate.getByRole('button', { name: 'Associer ce compte', exact: true }).click();
        await associate.waitFor({ state: 'detached' });
        await customer.getByRole('button', { name: 'Confirmer l’encaissement', exact: true }).click();
        const confirm = page.getByRole('dialog', { name: 'Encaissement client', exact: true });
        assert.match(await confirm.locator('dl').textContent(), /50.00/);
        assert.match(await confirm.locator('dl').textContent(), /Reste dû après.*58.10/);
        await readable(page, confirm, `${engine}-${width}-payment-summary`);
        await flag(page, 'qa-bank-reject', true);
        await confirm.getByRole('button', { name: 'Enregistrer l’encaissement', exact: true }).click();
        await confirm.getByText('La période de ce paiement est clôturée', { exact: true }).waitFor();
        assert.equal(await confirm.getByRole('button', { name: 'Vérifier la comptabilité', exact: true }).isVisible(), true);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
        await readable(page, confirm, `${engine}-${width}-payment-repair`);
        await confirm.getByRole('button', { name: 'Vérifier la comptabilité', exact: true }).click();
        await page.locator('.accounting-screen').waitFor();
        assert.equal(await page.getByRole('combobox', { name: 'Autres outils comptables', exact: true }).inputValue(), 'periods');
        await navigate(page, 'Banque');
        await customer.getByRole('button', { name: 'Confirmer l’encaissement', exact: true }).click();
        await flag(page, 'qa-bank-reject', false);
        await flag(page, 'qa-bank-hold-payment', true);
        await flag(page, 'qa-bank-fail-after-save', true);
        await confirm.getByRole('button', { name: 'Enregistrer l’encaissement', exact: true }).click();
        await page.waitForFunction(() => Number(sessionStorage.getItem('qa-bank-customer-attempts')) === 2);
        assert.equal(await confirm.getByRole('button', { name: 'Enregistrer l’encaissement', exact: true }).isDisabled(), true);
        await page.keyboard.press('Escape');
        assert.equal(await confirm.isVisible(), true);
        await confirm.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        assert.equal(await count(page, 'qa-bank-customer-attempts'), 2);
        await page.evaluate(() => window.bankFixture.release());
        await confirm.waitFor({ state: 'detached' });
        await page.getByText('Rapprochement confirmé', { exact: true }).waitFor();
        assert.equal(await customer.getByRole('button', { name: 'Confirmer l’encaissement', exact: true }).isDisabled(), true);
        await page.evaluate(() => ['qa-bank-hold-payment', 'qa-bank-refresh-fail', 'qa-bank-fail-after-save'].forEach(key => sessionStorage.removeItem(key)));
        await page.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await customer.waitFor({ state: 'detached' });
        assert.equal(await count(page, 'qa-bank-customer-attempts'), 2);
        const supplier = page.locator('.bank-movement').filter({ hasText: 'Fournitures du Léman' });
        await supplier.getByRole('button', { name: 'Confirmer le règlement', exact: true }).click();
        const supplierDialog = page.getByRole('dialog', { name: 'Règlement fournisseur', exact: true });
        assert.match(await supplierDialog.locator('dl').textContent(), /ACH-2026-45.*Reste dû après.*0.00.*Reste dû avant.*54.05/);
        await supplierDialog.getByRole('button', { name: 'Enregistrer le règlement', exact: true }).click();
        await supplier.waitFor({ state: 'detached' });
        assert.equal(await count(page, 'qa-bank-supplier-attempts'), 1);
        const repeated = await openImport(page);
        await repeated.getByRole('button', { name: 'Choisir le relevé XML', exact: true }).click();
        assert.equal(await repeated.getByRole('checkbox').isChecked(), false);
        await repeated.getByRole('button', { name: 'Importer ce relevé', exact: true }).click();
        await repeated.getByText('Ce relevé est déjà enregistré', { exact: true }).waitFor();
        await repeated.getByRole('button', { name: 'Voir les mouvements à vérifier', exact: true }).click();
        await page.getByRole('tab', { name: /^Rapprochés/ }).click();
        assert.equal(await page.locator('.bank-movement').count(), 2);
        assert.equal(await count(page, 'qa-bank-customer-attempts'), 2);
        await page.goto(`${base}/tests/mobile-harness.html?finance=1&bank=1&readOnly=1`);
        await navigate(page, 'Banque');
        assert.equal(await page.locator('.bank-hero button').isDisabled(), true);
        await page.goto(`${base}/tests/mobile-harness.html?finance=1&bank=1&bankNoAccounting=1`);
        await navigate(page, 'Banque');
        await page.getByRole('button', { name: 'Ouvrir Plan & liaisons', exact: true }).click();
        await page.locator('.accounting-screen').waitFor();
        assert.equal(await page.getByRole('combobox', { name: 'Autres outils comptables', exact: true }).inputValue(), 'accounts');
        assert.deepEqual(errors, []);
        reports.push({ engine, width, height, result: 'PASS import guide, cancellation, preserved file and option after rejection, read-only retry, account association, partial balance, refusal help, single write while pending, supplier and duplicate import, read-only access' });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png` });
        await writeFile(`${output}/${engine}-${width}-failure.html`, await page.content());
        reports.push({ engine, width, height, error: error.stack });
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2)); }
}
console.log(JSON.stringify(reports, null, 2));
