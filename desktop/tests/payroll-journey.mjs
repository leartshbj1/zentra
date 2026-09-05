import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
const destination = '.qa/payroll';
await mkdir(destination, { recursive: true });
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5175';
async function go(page, label) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(label);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
}
async function set(page, key, value = '1') { await page.evaluate(([key, value]) => sessionStorage.setItem(`qa-payroll-${key}`, value), [key, value]); }
async function calls(page, key) { return page.evaluate((key) => JSON.parse(sessionStorage.getItem(`qa-payroll-${key}`) || '[]'), key); }
async function capture(page, name) {
  await page.screenshot({ path: `${destination}/${name}.png` });
  const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('.modal,.modal__body,.payroll-print-preview,.payroll-print-preview .print-preview__toolbar')].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => ({ class: node.className, width: node.clientWidth, scroll: node.scrollWidth })) }));
  report.push({ capture: name, ...geometry });
  assert.ok(geometry.document <= geometry.width && !geometry.overflow.length, `${name}: horizontal overflow`);
}
let activePage;
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = activePage = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width <= 768 });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => report.push({ error: error.stack }));
    page.on('dialog', (dialog) => dialog.accept());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${base}/tests/mobile-harness.html?payroll=1`);
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    await go(page, 'Équipe & salaires');
    await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
    await modal.locator('input[name=period]').fill('2026-09');
    await modal.getByRole('button', { name: 'Gain', exact: true }).click();
    await modal.getByPlaceholder('Libellé réel').fill('Salaire mensuel');
    await modal.locator('.pay-line-list .money-input input').fill('5000');
    await page.waitForFunction(() => document.querySelectorAll('.contribution-selection-list > article').length === 13);
    for (const checkbox of await modal.locator('.contribution-selection-list input[type="checkbox"]').all()) await checkbox.check();
    for (const code of ['AAP_TEST', 'AANP_TEST', 'CAF_TEST']) {
      await modal.locator('.contribution-selection-list > article').filter({ hasText: code }).getByRole('spinbutton', { name: /^Base de calcul/ }).fill('5000');
    }
    await modal.getByRole('button', { name: 'Calculer les cotisations', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-payroll-calculate') || '[]').length === 1);
    await modal.locator('.payroll-calculation').waitFor();
    await modal.locator('.document-totals').scrollIntoViewIfNeeded();
    await capture(page, `${width}-calculated-net`);
    assert.match(await modal.locator('.document-totals').textContent(), /4.?380[.,]00/);
    await modal.getByRole('checkbox', { name: /Valider cette fiche/ }).check();
    await set(page, 'refuse-save');
    await modal.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await modal.getByText(/Le compte des salaires à payer est inactif/).waitFor();
    assert.equal(await modal.getByPlaceholder('Libellé réel').inputValue(), 'Salaire mensuel');
    await capture(page, `${width}-save-refusal`);
    await set(page, 'refuse-save', '0');
    await set(page, 'recover-save');
    await modal.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true }).waitFor();
    await set(page, 'fail-reads', '0');
    await page.getByRole('button', { name: /Actualiser les données/ }).click();
    await page.locator('.workspace-recovery').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /Comptabiliser et verrouiller/ }).waitFor();
    assert.equal((await calls(page, 'save')).length, 2, 'One refusal and one acknowledged save');
    await set(page, 'recover-post');
    await page.getByRole('button', { name: /Comptabiliser et verrouiller/ }).click();
    await page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true }).waitFor();
    await set(page, 'fail-reads', '0');
    await page.getByRole('button', { name: /Actualiser les données/ }).click();
    await page.getByRole('button', { name: 'Marquer payé', exact: true }).waitFor();
    assert.equal((await calls(page, 'post')).length, 1);
    await page.getByText(/Des comptes généraux ont été utilisés/).waitFor();
    await page.getByRole('button', { name: 'Marquer payé', exact: true }).click();
    await modal.locator('input[name=paymentDate]').fill('2026-09-30');
    await modal.getByLabel(/Référence/).fill('SALAIRE-SEPTEMBRE-2026');
    await set(page, 'refuse-pay');
    await modal.getByRole('button', { name: 'Confirmer le paiement', exact: true }).click();
    await modal.getByText(/Le compte bancaire est inactif/).waitFor();
    await capture(page, `${width}-payment-refusal`);
    await set(page, 'refuse-pay', '0');
    await set(page, 'recover-pay');
    await modal.getByRole('button', { name: 'Confirmer le paiement', exact: true }).click();
    await page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true }).waitFor();
    await set(page, 'fail-reads', '0');
    await page.getByRole('button', { name: /Actualiser les données/ }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal((await calls(page, 'pay')).length, 2);
    await page.locator('.payslip-list > article').first().scrollIntoViewIfNeeded();
    assert.match(await page.locator('.payslip-list > article').first().textContent(), /2026-09.*payé/s);
    await capture(page, `${width}-paid`);
    await page.locator('.payslip-list > article').first().getByRole('button', { name: 'Imprimer', exact: true }).click();
    await page.getByText('Aperçu de la fiche détaillée', { exact: true }).waitFor();
    await set(page, 'refuse-pdf');
    await page.getByRole('button', { name: 'Exporter le PDF', exact: true }).click();
    await page.getByText(/Le dossier de destination est momentanément inaccessible/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Exporter le PDF', exact: true }).isEnabled(), true, 'A refused PDF export can be retried');
    await set(page, 'refuse-pdf', '0');
    await page.getByRole('button', { name: 'Exporter le PDF', exact: true }).click();
    await page.getByRole('button', { name: 'Partager le PDF', exact: true }).waitFor();
    await capture(page, `${width}-pdf-share-warning`);
    await set(page, 'refuse-share');
    await page.getByRole('button', { name: 'Partager le PDF', exact: true }).click();
    await page.getByText(/Le partage est momentanément indisponible/).waitFor();
    await set(page, 'refuse-share', '0');
    await page.getByRole('button', { name: 'Partager le PDF', exact: true }).click();
    await page.getByText('Le PDF existant a été proposé au partage.', { exact: true }).waitFor();
    assert.equal((await calls(page, 'pdf')).length, 2, 'One refusal and one PDF; sharing never regenerates it');
    assert.equal((await calls(page, 'share-pdf')).length, 2);
    await capture(page, `${width}-pdf`);
    const preview = page.getByRole('dialog', { name: 'Aperçu de la fiche de salaire', exact: true });
    const controls = await preview.locator('.print-preview__toolbar button').evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { label: button.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight }; }));
    assert.ok(controls.every((box) => box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height), 'Every PDF action is inside the visible screen');
    await page.getByRole('button', { name: 'Fermer l’aperçu de la fiche de salaire', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Exporter le PDF', exact: true }).evaluate((button) => button === document.activeElement), true, 'Keyboard focus stays inside the preview');
    await preview.locator('.print-totals').scrollIntoViewIfNeeded();
    await capture(page, `${width}-pdf-net`);
    await page.emulateMedia({ media: 'print' });
    await page.waitForFunction(() => matchMedia('print').matches && Math.abs(document.querySelector('.payroll-print-preview .print-sheet').getBoundingClientRect().width - 793.7) < 2);
    const printGeometry = await preview.locator('.print-sheet').evaluate((node) => ({ width: node.getBoundingClientRect().width, styleWidth: getComputedStyle(node).width, maxWidth: getComputedStyle(node).maxWidth, transform: getComputedStyle(node).transform }));
    assert.ok(Math.abs(printGeometry.width - 793.7) < 2, `The printable page retains its A4 width: ${JSON.stringify(printGeometry)}`);
    await page.emulateMedia({ media: 'screen' });
    await page.getByRole('button', { name: 'Fermer l’aperçu de la fiche de salaire', exact: true }).click();
    report.push({ journey: 'PASS configured payroll: calculate, reject/save/recover, post/recover, reject/pay/recover, PDF/share recovery, mobile preview and keyboard focus', width });
    await page.close();
  }
  assert.deepEqual(report.filter((row) => row.error), []);
} catch (error) {
  report.push({ fatal: error.stack }); process.exitCode = 1;
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: `${destination}/failure.png` });
} finally {
  await writeFile(`${destination}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.filter((row) => row.error || row.fatal || row.journey), null, 2));
  await browser.close();
}
