import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5196';
const output = '.qa/sales-recovery';
await mkdir(output, { recursive: true });
const report = [];
async function navigate(page, title) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(title);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(title, { exact: true }) }).click();
}
async function recover(page, kind) {
  const dialog = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
  await dialog.waitFor();
  const writes = () => page.evaluate(kind => JSON.parse(sessionStorage.getItem('qa-sales-writes') || '[]').filter(row => row.kind === kind).length, kind);
  assert.equal(await writes(), 1);
  await dialog.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
  await dialog.getByText('Actualisation impossible', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.ok(await dialog.isVisible());
  assert.equal(await writes(), 1);
  await page.evaluate(() => sessionStorage.removeItem('qa-sales-block-reads'));
  await dialog.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await writes(), 1);
}
for (const [engine, browserType] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 390, 1440]) for (const kind of ['save', 'revision', 'correction', 'payment']) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      try {
        await page.goto(`${base}/tests/mobile-harness.html?salesRecovery=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.evaluate(kind => sessionStorage.setItem('qa-sales-recover', kind), kind);
        await navigate(page, ['save', 'revision'].includes(kind) ? 'Devis' : 'Factures');
        if (kind === 'save') {
          await page.getByRole('button', { name: 'Nouveau devis', exact: true }).click();
          const editor = page.locator('.document-editor-dialog');
          await editor.locator('[name=title]').fill('Devis conservé après interruption');
          await editor.locator('[name=clientId]').selectOption('client-qa');
          await editor.getByRole('button', { name: 'Continuer', exact: true }).click();
          await editor.getByRole('textbox', { name: 'Description', exact: true }).fill('Travail de recette');
          await editor.getByRole('textbox', { name: 'Quantité', exact: true }).fill('2');
          await editor.getByLabel('Unité', { exact: true }).fill('h');
          await editor.getByRole('textbox', { name: 'Prix unitaire', exact: true }).fill('125');
          await editor.getByRole('button', { name: 'Continuer', exact: true }).click();
          await editor.locator('[name=notes]').fill('Conditions conservées\nDeuxième ligne.');
          await editor.getByRole('button', { name: 'Continuer', exact: true }).click();
          await page.evaluate(() => sessionStorage.setItem('qa-sales-refuse-save', '1'));
          await editor.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
          await editor.getByText('Enregistrement indisponible. Vos modifications sont conservées.', { exact: true }).waitFor();
          assert.equal(await editor.locator('[name=notes]').inputValue(), 'Conditions conservées\nDeuxième ligne.');
          await page.evaluate(() => sessionStorage.removeItem('qa-sales-refuse-save'));
          await editor.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
          await recover(page, kind);
          await editor.waitFor({ state: 'hidden' });
          const snapshot = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-sales-snapshot')));
          assert.equal(snapshot.quotes.length, 2);
          assert.equal(snapshot.quotes.at(-1).notes, 'Conditions conservées\nDeuxième ligne.');
        } else if (kind === 'revision') {
          await page.getByRole('button', { name: 'Créer une version modifiable du devis D-2026-0001', exact: true }).click();
          await recover(page, kind);
          const editor = page.locator('.document-editor-dialog');
          await editor.waitFor();
          assert.equal(await editor.locator('[name=title]').inputValue(), 'Devis à modifier');
          assert.equal(await page.evaluate(() => localStorage.getItem('zentra.quote-revision-attempts.v1')), null);
        } else if (kind === 'correction') {
          await page.locator('.sales-documents tbody tr').getByRole('button', { name: 'Modifier', exact: true }).click();
          const form = page.getByRole('dialog');
          await form.locator('[name=reason]').fill('Corriger la quantité facturée');
          await page.evaluate(() => sessionStorage.setItem('qa-sales-refuse-correction', '1'));
          await form.getByRole('button', { name: 'Créer la version modifiable', exact: true }).click();
          await form.getByText('La correction est momentanément indisponible. Réessayez.', { exact: true }).waitFor();
          assert.equal(await form.locator('[name=reason]').inputValue(), 'Corriger la quantité facturée');
          await page.evaluate(() => sessionStorage.removeItem('qa-sales-refuse-correction'));
          await form.getByRole('button', { name: 'Créer la version modifiable', exact: true }).click();
          await recover(page, kind);
          const editor = page.locator('.document-editor-dialog');
          await editor.waitFor();
          assert.equal(await editor.locator('[name=title]').inputValue(), 'Facture à modifier');
          const snapshot = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-sales-snapshot')));
          assert.equal(snapshot.invoices.length, 3);
          assert.equal(snapshot.invoices[0].status, 'issued');
          assert.equal(snapshot.invoiceCorrectionWorkflows.length, 1);
        } else {
          await page.evaluate(() => sessionStorage.setItem('qa-sales-accounting-unavailable', '1'));
          await page.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).click();
          const form = page.getByRole('dialog', { name: 'Enregistrer un paiement', exact: true });
          await form.getByText('Le chargement a été interrompu', { exact: true }).waitFor();
          assert.equal(await form.locator('[name=amount]').inputValue(), '1081.00');
          assert.equal(await form.locator('[name=method]').inputValue(), 'Virement bancaire');
          await form.locator('[name=reference]').fill('VIREMENT-42');
          await page.evaluate(() => sessionStorage.removeItem('qa-sales-accounting-unavailable'));
          await form.getByRole('button', { name: 'Réessayer la vérification', exact: true }).click();
          await form.locator('[name=amount]').fill('1082');
          await form.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
          await form.getByText(/Ce montant dépasse ce qu’il reste à encaisser/).waitFor();
          await form.locator('[name=amount]').fill('1081');
          await form.locator('[name=date]').fill('2026-08-31');
          await form.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
          await form.getByText(/Le paiement ne peut pas précéder/).waitFor();
          await form.locator('[name=date]').fill('2026-09-02');
          await page.evaluate(() => sessionStorage.setItem('qa-sales-refuse-payment', '1'));
          await form.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
          await form.getByText(/La période comptable est fermée/).waitFor();
          await page.screenshot({ path: `${output}/${engine}-${width}-payment-form.png` });
          assert.ok(await form.locator('.modal__body').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
          assert.equal(await form.locator('[name=reference]').inputValue(), 'VIREMENT-42');
          await page.evaluate(() => sessionStorage.removeItem('qa-sales-refuse-payment'));
          await form.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
          await recover(page, kind);
          await form.waitFor({ state: 'hidden' });
          const snapshot = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-sales-snapshot')));
          assert.equal(snapshot.payments.length, 1);
          assert.equal(snapshot.payments[0].amountCents, 108100);
          assert.equal(snapshot.invoices[0].status, 'paid');
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `${output}/${engine}-${width}-${kind}.png` });
        report.push({ engine, width, kind, oneMutation: true, recoveryCompleted: true });
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-${kind}-failure.png` });
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
