import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const reports = [];
await mkdir('.qa/quote-folder-payment', { recursive: true });
for (const [engine, browserType] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      page.setDefaultTimeout(10000);
      try {
        const withCredit = width === 390;
        await page.goto(`${base}/tests/mobile-harness.html?quotePair=1${withCredit ? '&folderCredit=1' : ''}`);
        await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Devis');
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Devis', { exact: true }) }).click();
        await page.getByRole('button', { name: 'Créer la facture', exact: true }).click();
        await page.getByRole('checkbox', { name: /Créer une facture d’acompte/ }).check();
        await page.getByRole('textbox', { name: 'Pourcentage de l’acompte', exact: true }).fill('40');
        await page.getByRole('button', { name: 'Créer les deux factures', exact: true }).click();
        const folder = page.locator('.quote-invoice-folder');
        const deposit = folder.locator('[data-invoice-id=deposit-pair]');
        const balance = folder.locator('[data-invoice-id=balance-pair]');
        async function assertTotals(received, open) {
          await folder.waitFor();
          const totals = folder.locator('.quote-invoice-folder__totals');
          assert.match(await totals.locator('div').nth(1).innerText(), received);
          assert.match(await totals.locator('div').nth(2).innerText(), open);
        }
        async function snapshot(stage) {
          const modal = page.getByRole('dialog');
          assert.ok(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.querySelector('.modal__body').scrollWidth <= node.querySelector('.modal__body').clientWidth + 1));
          for (const button of await folder.locator('button').all()) assert.ok((await button.boundingBox()).height >= 44);
          await page.screenshot({ path: `.qa/quote-folder-payment/${engine}-${width}-${stage}.png` });
        }
        await assertTotals(/0.00/, /0.00/);
        await folder.getByText(/2 brouillons à préparer/).waitFor();
        for (const [card, name] of [[deposit, 'Ouvrir l’acompte'], [balance, 'Ouvrir le solde']]) {
          await card.getByRole('button', { name, exact: true }).click();
          await page.getByLabel('Début de prestation', { exact: false }).fill('2026-09-01');
          await page.getByRole('button', { name: 'Enregistrer et voir le dossier', exact: true }).click();
          await folder.waitFor();
        }
        assert.equal(await balance.getByRole('button', { name: 'Émettre le solde', exact: true }).count(), 0);
        await balance.getByText(/Émettez d’abord la facture d’acompte/).waitFor();
        await page.evaluate(() => sessionStorage.setItem('qa-pair-refuse-issue', '1'));
        await deposit.getByRole('button', { name: 'Émettre l’acompte', exact: true }).click();
        await folder.getByText('La période de facturation est fermée. Vérifiez la date d’émission.', { exact: true }).waitFor();
        await page.evaluate(() => { sessionStorage.removeItem('qa-pair-refuse-issue'); sessionStorage.setItem('qa-pair-hold-issue', '1'); });
        await deposit.getByRole('button', { name: 'Émettre l’acompte', exact: true }).click();
        assert.equal(await folder.locator('button:not(:disabled)').count(), 0);
        assert.equal(await page.getByRole('button', { name: /Fermer « Dossier/ }).count(), 0);
        await page.keyboard.press('Escape');
        assert.ok(await folder.isVisible());
        await page.evaluate(() => { sessionStorage.removeItem('qa-pair-hold-issue'); window.dispatchEvent(new Event('qa-release-pair-issue')); });
        await deposit.getByText('F-2026-0042', { exact: true }).waitFor();
        await assertTotals(/0.00/, /432.40/);
        await folder.getByText(/1 brouillon à préparer/).waitFor();
        await snapshot('deposit-issued');
        await page.evaluate(() => window.__qaSetReadOnly(true));
        await page.waitForFunction(() => document.querySelector('[data-invoice-id=deposit-pair] .quote-invoice-folder__actions button')?.disabled);
        assert.ok(await deposit.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).isDisabled());
        assert.ok(await balance.getByRole('button', { name: 'Émettre le solde', exact: true }).isDisabled());
        assert.ok(await deposit.getByRole('button', { name: 'Ouvrir l’acompte', exact: true }).isEnabled());
        await page.evaluate(() => window.__qaSetReadOnly(false));
        await deposit.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).click();
        const payment = page.getByRole('dialog', { name: 'Enregistrer un paiement', exact: true });
        assert.equal(await payment.locator('[name=amount]').inputValue(), '432.40');
        await payment.locator('[name=amount]').fill('100');
        await payment.locator('[name=notes]').fill('Premier versement reçu');
        await page.evaluate(() => sessionStorage.setItem('qa-pair-refuse-payment', '1'));
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        await payment.getByText('Le paiement n’a pas été enregistré. Réessayez.', { exact: true }).waitFor();
        assert.equal(await payment.locator('[name=amount]').inputValue(), '100');
        assert.equal(await payment.locator('[name=notes]').inputValue(), 'Premier versement reçu');
        await page.evaluate(() => sessionStorage.removeItem('qa-pair-refuse-payment'));
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        await assertTotals(/100.00/, /332.40/);
        await balance.getByRole('button', { name: 'Émettre le solde', exact: true }).click();
        await balance.getByText('F-2026-0043', { exact: true }).waitFor();
        await assertTotals(/100.00/, withCredit ? /781.00/ : /981.00/);
        if (withCredit) await folder.getByText(/Avoirs appliqués · 200.00/).waitFor();
        await deposit.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).click();
        assert.equal(await payment.locator('[name=amount]').inputValue(), '332.40');
        await payment.getByRole('button', { name: 'Annuler', exact: true }).click();
        await assertTotals(/100.00/, withCredit ? /781.00/ : /981.00/);
        await deposit.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).click();
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        await assertTotals(/432.40/, withCredit ? /448.60/ : /648.60/);
        assert.equal(await deposit.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).count(), 0);
        await balance.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).click();
        assert.equal(await payment.locator('[name=amount]').inputValue(), withCredit ? '448.60' : '648.60');
        await page.evaluate(() => sessionStorage.setItem('qa-pair-recover', 'payment'));
        await payment.getByRole('button', { name: 'Enregistrer le paiement', exact: true }).click();
        const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
        await recovery.waitFor();
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
        await page.evaluate(() => { sessionStorage.removeItem('qa-pair-recover'); sessionStorage.removeItem('qa-pair-block-reads'); });
        await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
        await recovery.waitFor({ state: 'hidden' });
        await assertTotals(withCredit ? /881.00/ : /1.?081.00/, /0.00/);
        assert.equal(await folder.getByRole('button', { name: 'Enregistrer un paiement', exact: true }).count(), 0);
        const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-pair-snapshot')));
        assert.deepEqual(state.invoices.map(invoice => invoice.status), ['paid', 'paid']);
        assert.equal(state.payments.length, 3);
        assert.equal(state.payments.reduce((sum, payment) => sum + payment.amountCents, 0), withCredit ? 88100 : 108100);
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-pair-writes')).filter(kind => kind === 'issue').length), 2);
        await snapshot('paid');
        assert.deepEqual(errors, []);
        reports.push({ engine, width, height, conversion: true, issueOrder: true, paymentRetry: true, returnToFolder: true, recoveryWithoutDuplicate: true, readOnly: true, totals: true, externalCredit: withCredit });
        console.log(JSON.stringify(reports.at(-1)));
      } catch (error) {
        await page.screenshot({ path: `.qa/quote-folder-payment/${engine}-${width}-failure.png` });
        await writeFile(`.qa/quote-folder-payment/${engine}-${width}-failure.txt`, await page.locator('body').innerText());
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile('.qa/quote-folder-payment/report.json', JSON.stringify(reports, null, 2));
