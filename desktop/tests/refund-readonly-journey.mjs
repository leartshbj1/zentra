import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_BROWSER || 'chromium';
const playwright = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const output = `.qa/refund-readonly-${engine}`;
const report = []; await mkdir(output, { recursive: true });
try {
  for (const width of [320,390,768,1024,1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5175'}/tests/mobile-harness.html?finance=1&bank=1&bankRefund=1&readOnly=1`);
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true }); if (await tour.isVisible()) await tour.click();
    const navigate = async name => { await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click(); await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name); await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click(); await page.locator('.navigation-palette').waitFor({ state: 'hidden' }); };
    await navigate('Banque');
    await page.getByRole('tab', { name: /^Rapprochés/ }).click();
    const source = page.getByRole('button', { name: 'Voir la dépense d’origine', exact: true });
    assert.ok(await source.isEnabled());
    assert.ok(await page.getByRole('button', { name: 'Dissocier du relevé', exact: true }).isDisabled());
    await source.click();
    const detail = page.getByRole('dialog', { name: 'Dépense', exact: true });
    await detail.getByText('RECU-0', { exact: true }).waitFor();
    assert.ok(await detail.getByRole('button', { name: 'Joindre un justificatif', exact: true }).isDisabled());
    assert.ok(await detail.getByRole('button', { name: 'Enregistrer un remboursement', exact: true }).isDisabled());
    await detail.getByRole('button', { name: 'Ouvrir avoir-consultable.pdf', exact: true }).click();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-read-only-opened')),'read-only-receipt');
    assert.ok(await detail.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.querySelector('.modal__body').scrollWidth <= node.querySelector('.modal__body').clientWidth + 1));
    await page.screenshot({ path: `${output}/${width}-consultation.png` });
    // A revoked permission is not an in-flight save: retain the receipt/draft,
    // prohibit writes, and let the user leave the form.
    await page.evaluate(() => window.__qaSetReadOnly(false));
    await detail.getByRole('button', { name: 'Joindre un justificatif', exact: true }).click();
    const attachment = page.getByRole('dialog', { name: 'Joindre un justificatif au remboursement', exact: true });
    const receipt = { name: 'avoir-test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 synthetic receipt') };
    await attachment.locator('input[type=file]').setInputFiles(receipt);
    await page.evaluate(() => {
      window.__qaRefundAttachmentCalls = 0;
      window.__qaDesktopApi.addExpenseRefundAttachment = async () => {
        window.__qaRefundAttachmentCalls++;
        return window.__qaDesktopApi.loadWorkspace();
      };
      window.__qaSetReadOnly(true);
    });
    await attachment.getByRole('status').filter({ hasText: 'Mode lecture seule' }).waitFor();
    assert.ok(await attachment.getByRole('button', { name: 'Annuler', exact: true }).isEnabled());
    assert.ok(await attachment.getByRole('button', { name: 'Ajouter le justificatif', exact: true }).isDisabled());
    assert.ok(await attachment.locator('input[type=file]').isDisabled());
    assert.equal(await attachment.getByText('avoir-test.pdf', { exact: true }).count(), 1);
    await attachment.locator('form').dispatchEvent('submit');
    assert.equal(await page.evaluate(() => window.__qaRefundAttachmentCalls), 0);
    await page.screenshot({ path: `${output}/${width}-revoked-attachment.png` });
    await attachment.getByRole('button', { name: 'Annuler', exact: true }).click();
    await detail.waitFor();
    await page.evaluate(() => window.__qaSetReadOnly(false));
    await detail.getByRole('button', { name: 'Enregistrer un remboursement', exact: true }).click();
    const refund = page.getByRole('dialog', { name: 'Enregistrer un remboursement', exact: true });
    await refund.getByLabel('Référence de l’avoir', { exact: false }).fill('REFERENCE-CONSERVEE');
    await page.evaluate(() => window.__qaSetReadOnly(true));
    await refund.getByRole('status').filter({ hasText: 'Mode lecture seule' }).waitFor();
    assert.ok(await refund.getByRole('button', { name: 'Annuler', exact: true }).isEnabled());
    assert.ok(await refund.getByRole('button', { name: 'Enregistrer le remboursement reçu', exact: true }).isDisabled());
    assert.equal(await refund.getByLabel('Référence de l’avoir', { exact: false }).inputValue(), 'REFERENCE-CONSERVEE');
    await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]'));
    await page.keyboard.press('Escape');
    await refund.waitFor({ state: 'hidden' });
    await detail.waitFor();
    // Restoration permits exactly one attachment mutation from this form.
    await page.evaluate(() => window.__qaSetReadOnly(false));
    await detail.getByRole('button', { name: 'Joindre un justificatif', exact: true }).click();
    await attachment.locator('input[type=file]').setInputFiles(receipt);
    await attachment.getByRole('button', { name: 'Ajouter le justificatif', exact: true }).click();
    await detail.waitFor();
    assert.equal(await page.evaluate(() => window.__qaRefundAttachmentCalls), 1);
    await detail.getByRole('button', { name: 'Fermer', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    assert.deepEqual(errors,[]); report.push({ width, result: 'PASS: read-only consultation, receipt and refund drafts retained on revocation, cancellation/Escape allowed, no unauthorized write, one attachment after restoration, no overflow' });
    await page.close();
  }
} catch(error) { process.exitCode = 1; report.push({ fatal: error.stack }); }
finally { await writeFile(`${output}/report.json`,JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); await browser.close(); }
