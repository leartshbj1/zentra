import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5263';
const out = '.qa/purchase-clear';
await mkdir(out, { recursive: true });
const report = [];
for (const [engine, browserType] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      const errors = [];
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      const mode = (operation, failure) => page.evaluate(([operation, failure]) => sessionStorage.setItem(`qa-purchase-${operation}-failure`, failure), [operation, failure]);
      const attempts = operation => page.evaluate(operation => JSON.parse(sessionStorage.getItem(`qa-purchase-${operation}-attempts`) || '[]'), operation);
      const documents = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-purchase-documents') || '[]'));
      const recovery = async (keepFailing = false) => {
        const dialog = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await dialog.waitFor();
        if (keepFailing) {
          await page.evaluate(() => sessionStorage.setItem('qa-purchase-block-reads', '1'));
          await dialog.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
          await dialog.getByText('Actualisation impossible', { exact: true }).waitFor();
          await page.keyboard.press('Escape');
          assert.ok(await dialog.isVisible());
          await page.evaluate(() => sessionStorage.removeItem('qa-purchase-block-reads'));
        }
        await dialog.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
      };
      const capture = async name => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.modal,.modal__body')].every(node => node.scrollWidth <= node.clientWidth + 1)), `${width} ${name}: horizontal overflow`);
        await page.screenshot({ path: `${out}/${engine}-${width}-${name}.png` });
      };
      try {
        await page.goto(`${base}/tests/mobile-harness.html?purchasing=1`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Achats');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Achats & fournisseurs', { exact: true }) }).click();
        await page.getByRole('button', { name: 'Facture fournisseur', exact: true }).click();
        const form = page.getByRole('dialog', { name: 'Nouvelle facture fournisseur', exact: true });
        await form.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
        await form.getByText('Ligne 1 : décrivez ce que vous avez acheté.', { exact: true }).waitFor();
        assert.equal((await attempts('invoice-draft')).length, 0);
        await form.locator('[name=reference]').fill('ACHAT-RECETTE');
        await form.getByRole('textbox', { name: /^Description/ }).fill('Papier et fournitures');
        await form.getByRole('spinbutton', { name: /^Prix unitaire net/ }).fill('100');
        await form.getByLabel(/^Date de facture/).fill('2026-09-05');
        await form.getByLabel(/^Échéance/).fill('2026-10-05');
        await form.getByLabel(/^Traitement TVA de ces achats/).selectOption('input_materials');
        await form.locator('[name=note]').fill('Dossier du mois\nJustificatif conservé.');
        await mode('invoice-draft', 'reject');
        await form.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
        await form.getByRole('alert').filter({ hasText: 'période comptable est fermée' }).waitFor();
        assert.equal(await form.locator('[name=note]').inputValue(), 'Dossier du mois\nJustificatif conservé.');
        await capture('draft-refusal');
        await mode('invoice-draft', 'refresh_held');
        await form.getByRole('button', { name: 'Enregistrer le brouillon', exact: true }).click();
        await page.waitForFunction(() => Boolean(sessionStorage.getItem('qa-purchase-documents')));
        await page.keyboard.press('Escape');
        assert.ok(await form.isVisible());
        assert.ok(await form.locator('[name=reference]').isDisabled());
        await page.evaluate(() => window.dispatchEvent(new Event('qa-release-workspace-read')));
        await recovery(true);
        await form.getByRole('button', { name: 'Terminer', exact: true }).waitFor();
        assert.equal((await attempts('invoice-draft')).length, 2);
        assert.equal((await attempts('invoice-draft'))[1].vatTreatment, 'input_materials');
        assert.equal((await documents()).filter(row => row.reference === 'ACHAT-RECETTE').length, 1);
        await capture('attachment-step');
        await mode('attachment', 'reject');
        await form.getByRole('button', { name: 'Ajouter un justificatif', exact: true }).click();
        await form.getByRole('alert').filter({ hasText: 'Refus attachment' }).waitFor();
        await mode('attachment', 'refresh_twice');
        await form.getByRole('button', { name: 'Ajouter un justificatif', exact: true }).click();
        await recovery();
        await form.getByText('facture-originale.pdf', { exact: true }).waitFor();
        assert.equal((await documents()).find(row => row.reference === 'ACHAT-RECETTE').attachments.length, 1);
        await form.getByRole('button', { name: 'Terminer', exact: true }).click();
        await form.waitFor({ state: 'hidden' });
        if (width <= 860) await page.getByRole('combobox', { name: 'Section des achats', exact: true }).selectOption('documents');
        else await page.locator('#purchase-tab-documents').click();
        const card = page.locator('.purchase-document-card').filter({ hasText: 'ACHAT-RECETTE' });
        await card.getByRole('button', { name: 'Valider', exact: true }).click();
        await card.getByRole('button', { name: 'Paiement', exact: true }).click();
        const payment = page.getByRole('dialog', { name: 'Enregistrer un paiement fournisseur', exact: true });
        await payment.getByRole('textbox', { name: /^Montant payé/ }).fill('108,11');
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        await payment.getByText(/Ce montant dépasse le solde/).waitFor();
        assert.equal((await attempts('payment')).length, 0);
        await payment.getByRole('textbox', { name: /^Montant payé/ }).fill('50,25');
        await payment.getByLabel(/^Date du paiement/).fill('2026-09-06');
        await payment.locator('[name=notes]').fill('Premier versement');
        await mode('payment', 'reject');
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        await payment.getByRole('alert').filter({ hasText: 'période comptable est fermée' }).waitFor();
        assert.equal(await payment.getByRole('textbox', { name: /^Montant payé/ }).inputValue(), '50,25');
        await capture('payment-refusal');
        await mode('payment', 'lost_response');
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        await payment.getByRole('status').filter({ hasText: 'est bien enregistré' }).waitFor();
        assert.equal((await documents()).find(row => row.reference === 'ACHAT-RECETTE').payments.length, 1);
        await capture('payment-found');
        await payment.getByRole('button', { name: 'Terminer', exact: true }).click();
        await payment.waitFor({ state: 'hidden' });
        await card.getByRole('button', { name: 'Paiement', exact: true }).click();
        assert.equal(await payment.getByRole('textbox', { name: /^Montant payé/ }).inputValue(), '57.85');
        await mode('payment', 'refresh_twice');
        await payment.getByRole('button', { name: 'Enregistrer et solder', exact: true }).click();
        await recovery(true);
        await payment.waitFor({ state: 'hidden' });
        const paid = (await documents()).find(row => row.reference === 'ACHAT-RECETTE');
        assert.equal(paid.balanceCents, 0);
        assert.equal(paid.payments.length, 2);
        assert.equal((await attempts('payment')).length, 3);
        assert.deepEqual(errors, []);
        await capture('paid');
        report.push({ engine, width, result: 'PASS draft, atomic VAT intent, inline errors, retained fields, receipt, validation, partial and full payments, lost response found by request, repeated read recovery, no duplicate or horizontal overflow' });
      } catch (error) {
        await page.screenshot({ path: `${out}/${engine}-${width}-failure.png` });
        await writeFile(`${out}/${engine}-${width}-failure.html`, await page.content());
        throw error;
      } finally { await page.close(); }
    }
  } catch (error) { report.push({ engine, fatal: error.stack }); process.exitCode = 1; }
  finally { await browser.close(); }
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
