import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const out = '.qa/supplier-review'; await mkdir(out, { recursive: true });
const report = [];
for (const [engine, driver] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await driver.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      const errors = [], confirmations = []; page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => { confirmations.push(dialog.message()); await dialog.dismiss(); });
      const docs = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-purchase-documents') || '[]'));
      const attempts = operation => page.evaluate(operation => JSON.parse(sessionStorage.getItem(`qa-purchase-${operation}-attempts`) || '[]'), operation);
      const mode = (operation, failure) => page.evaluate(([operation, failure]) => sessionStorage.setItem(`qa-purchase-${operation}-failure`, failure), [operation, failure]);
      const patch = data => page.evaluate(async data => { sessionStorage.setItem('qa-purchase-workspace-patch', JSON.stringify(data)); await window.__qaReloadPurchases(); }, data);
      const review = () => page.getByRole('dialog', { name: 'Vérifier la facture fournisseur', exact: true });
      const resume = async () => { await page.getByRole('button', { name: 'Reprendre la facture fournisseur', exact: true }).click(); await review().waitFor(); };
      const start = async (multi = false) => {
        if (multi) await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${base}/tests/mobile-harness.html?purchasing=1&supplierReview=1${multi ? '&multiOrders=1' : ''}`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Achats');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Achats & fournisseurs', { exact: true }) }).click();
        await page.locator('#purchase-tab-documents').waitFor({ state: 'attached' });
        if (width <= 860) await page.getByRole('combobox', { name: 'Section des achats', exact: true }).selectOption('documents');
        else await page.locator('#purchase-tab-documents').click();
      };
      const capture = async name => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('.modal,.modal__body')].some(el => el.scrollWidth > el.clientWidth + 1)), false, `${engine} ${width} ${name}: overflow`);
        await page.screenshot({ path: `${out}/${engine}-${width}-${name}.png` });
      };
      try {
        await start();
        await page.locator('.purchase-document-card').first().getByRole('button', { name: 'Valider', exact: true }).click();
        await review().getByText('Ajoutez le numéro de la facture', { exact: true }).waitFor();
        assert.equal(await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).isDisabled(), true);
        assert.equal((await attempts('validate')).length, 0);
        await review().getByRole('button', { name: 'Compléter la référence', exact: true }).click();
        const edit = page.getByRole('dialog', { name: 'Modifier le brouillon fournisseur', exact: true });
        await edit.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'reference');
        await edit.locator('[name=reference]').fill('REVUE-ACHAT');
        await edit.getByRole('button', { name: 'Mettre à jour le brouillon', exact: true }).click();
        await edit.getByRole('button', { name: 'Terminer', exact: true }).click();
        await resume();
        assert.equal(await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).isDisabled(), true);
        await review().getByRole('button', { name: 'Joindre le PDF ou la photo', exact: true }).click();
        await edit.waitFor();
        await page.waitForFunction(() => document.activeElement?.querySelector('.supplier-attachments'));
        await edit.getByRole('button', { name: 'Ajouter un justificatif', exact: true }).click();
        await edit.getByText('facture-originale.pdf', { exact: true }).waitFor();
        await edit.getByRole('button', { name: 'Terminer', exact: true }).click();
        await resume();
        assert.equal(await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).isEnabled(), true);
        await page.evaluate(() => window.__qaSetReadOnly(true));
        await review().getByText(/L’application est en lecture seule/).waitFor();
        assert.equal(await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).isDisabled(), true);
        await page.evaluate(() => window.__qaSetReadOnly(false));
        await mode('validate', 'reject');
        await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).click();
        await review().getByText('La date est dans une période fermée', { exact: true }).waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert');
        await capture('period-refusal');
        await review().getByRole('button', { name: 'Vérifier les exercices', exact: true }).click();
        await page.locator('.accounting-periods').waitFor();
        await resume();
        await mode('validate', 'accounts');
        await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).click();
        await review().getByText('Un compte comptable est à vérifier', { exact: true }).waitFor();
        await review().getByRole('button', { name: 'Vérifier les comptes', exact: true }).click();
        await page.locator('.accounting-setup').waitFor();
        await resume();
        const settings = await page.evaluate(async () => (await window.__qaReloadPurchases()).accountingSettings);
        await patch({ accountingSettings: { ...settings, enabled: false } });
        await review().getByText('Préparez les comptes pour cet achat', { exact: true }).waitFor();
        assert.equal(await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).isDisabled(), true);
        await patch({ accountingSettings: settings });
        await capture('ready');
        await mode('validate', 'refresh_held');
        await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).dblclick();
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-purchase-documents'))[0].documentStatus === 'validated');
        await page.keyboard.press('Escape'); assert.equal(await review().isVisible(), true);
        await page.evaluate(() => window.dispatchEvent(new Event('qa-release-workspace-read')));
        const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await recovery.waitFor();
        await page.evaluate(() => sessionStorage.setItem('qa-purchase-block-reads', '1'));
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
        await page.evaluate(() => sessionStorage.removeItem('qa-purchase-block-reads'));
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        const completed = page.getByRole('dialog', { name: 'Facture fournisseur validée', exact: true });
        await completed.waitFor();
        if (width <= 860) await page.waitForFunction(() => {
          const dialog = document.querySelector('.supplier-review-modal');
          const actions = dialog?.querySelector('.form-actions')?.getBoundingClientRect();
          const header = dialog?.querySelector('.modal__header')?.getBoundingClientRect();
          const amount = dialog?.querySelector('.supplier-review__total strong')?.getBoundingClientRect();
          return actions && header && amount && actions.bottom <= innerHeight + 1 && actions.top >= header.bottom - 1 && amount.top >= header.bottom - 1 && amount.bottom <= actions.top + 1;
        });
        assert.equal((await attempts('validate')).length, 3); assert.equal((await docs())[0].payments.length, 0);
        await capture('validated');
        await completed.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).click();
        const payment = page.getByRole('dialog', { name: 'Enregistrer un paiement fournisseur', exact: true });
        await payment.getByRole('textbox', { name: /^Montant payé/ }).fill('50');
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        await payment.waitFor({ state: 'hidden' });
        assert.equal((await docs())[0].balanceCents, 16620); assert.equal((await docs())[0].payments.length, 1);
        // Standalone confirmation and direct navigation into the matching editor.
        await start(true);
        await page.getByRole('button', { name: 'Valider comme autonome', exact: true }).click();
        await review().waitFor();
        await review().getByLabel('Je valide sans justificatif joint.', { exact: true }).check();
        assert.equal(await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).isDisabled(), true);
        await review().getByRole('button', { name: 'Voir le rapprochement', exact: true }).click();
        const matching = page.getByRole('dialog', { name: 'Rapprocher commande, réception et facture', exact: true });
        await matching.waitFor(); await matching.getByRole('button', { name: 'Annuler', exact: true }).click();
        await resume();
        await review().getByLabel('Je valide sans justificatif joint.', { exact: true }).check();
        await review().getByLabel('Je garde cette facture indépendante de la commande.', { exact: true }).check();
        const current = (await docs())[0];
        await patch({ supplierInvoices: [{ ...current, matchStatus: 'mismatch' }] });
        await review().getByText('Le rapprochement présente un écart', { exact: true }).waitFor();
        assert.equal(await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).isDisabled(), true);
        assert.equal((await attempts('validate')).length, 0);
        await patch({ supplierInvoices: [current] });
        await review().getByText('Le rapprochement présente un écart', { exact: true }).waitFor({ state: 'hidden' });
        assert.equal(await review().getByLabel('Je valide sans justificatif joint.', { exact: true }).isChecked(), false);
        await review().getByLabel('Je valide sans justificatif joint.', { exact: true }).check();
        await review().getByLabel('Je garde cette facture indépendante de la commande.', { exact: true }).check();
        await mode('validate', 'lost_response');
        await review().getByRole('button', { name: 'Valider et comptabiliser', exact: true }).click();
        await completed.waitFor();
        assert.equal((await attempts('validate')).length, 1);
        await completed.getByRole('button', { name: 'Terminer', exact: true }).click();
        assert.deepEqual(errors, []); assert.deepEqual(confirmations, []);
        report.push({ engine, width, height, result: 'PASS reference, receipt, read-only, totals, refusal focus, accounts/periods/matching links, resume, mismatch block, no-receipt/standalone choices, double click, acknowledged read recovery, lost response, payment handoff, no overflow' });
      } catch (error) { await page.screenshot({ path: `${out}/${engine}-${width}-failure.png` }); await writeFile(`${out}/${engine}-${width}-failure.html`, await page.content()); throw error; }
      finally { await page.close(); }
    }
  } catch (error) { report.push({ engine, fatal: error.stack }); process.exitCode = 1; }
  finally { await browser.close(); }
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
