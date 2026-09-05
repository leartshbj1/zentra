import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = []; await mkdir('.qa/refund-readonly', { recursive: true });
try {
  for (const width of [320,390,768,1024,1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&bank=1&bankRefund=1&readOnly=1');
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
    await page.screenshot({ path: `.qa/refund-readonly/${width}-consultation.png` });
    await detail.getByRole('button', { name: 'Fermer', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    assert.deepEqual(errors,[]); report.push({ width, result: 'PASS: source accessible, receipt opens, attachment/refund/unlink writes disabled, detail closes and no overflow' });
    await page.close();
  }
} catch(error) { process.exitCode = 1; report.push({ fatal: error.stack }); }
finally { await writeFile('.qa/refund-readonly/report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); await browser.close(); }
