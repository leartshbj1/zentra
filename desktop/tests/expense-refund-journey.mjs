import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/expense-refund', { recursive: true });
try {
  for (const width of [320,390,768,1024,1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?expenseRefund=1');
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true }); if (await tour.isVisible()) await tour.click();
    const navigate = async name => {
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
      await page.locator('.navigation-palette').waitFor({ state: 'detached' });
    };
    const documents = async () => { if (width <= 860) await page.getByRole('combobox', { name: 'Section des achats', exact: true }).selectOption('documents'); else await page.locator('#purchase-tab-documents').click(); };
    const capture = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${name}: page overflow`);
      const dialog = page.getByRole('dialog');
      if (await dialog.isVisible()) assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.querySelector('.modal__body').scrollWidth <= node.querySelector('.modal__body').clientWidth + 1), `${width} ${name}: dialog overflow`);
      await page.screenshot({ path: `.qa/expense-refund/${width}-${name}.png` });
    };
    await navigate('Achats & fournisseurs'); await documents();
    await page.locator('.purchase-document-card.is-legacy').getByRole('button', { name: 'Consulter', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.locator('.purchase-document-card.is-legacy').getByRole('button', { name: 'Consulter', exact: true }).click();
    assert.ok(await page.locator('.supplier-document-summary span').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 13));
    await page.getByRole('button', { name: 'Enregistrer un remboursement', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Enregistrer un remboursement', exact: true });
    await form.getByLabel('Date de l’avoir', { exact: false }).fill('2026-04-20');
    await form.getByLabel('Date du remboursement reçu', { exact: false }).fill('2026-07-05');
    await form.getByLabel('Référence de l’avoir', { exact: false }).fill('AV-2026-RETOUR-MARCHANDISES-001');
    await form.getByLabel('Montant TTC remboursé (CHF)', { exact: false }).fill('54.05');
    await form.getByLabel('Dont TVA selon l’avoir (CHF)', { exact: false }).fill('4.05');
    await form.getByLabel('Motif du remboursement', { exact: false }).fill('Retour de la moitié des marchandises du projet.');
    await capture('form');
    const submit = form.getByRole('button', { name: 'Enregistrer le remboursement reçu', exact: true });
    if (width <= 768) assert.ok(await submit.evaluate(node => node.getBoundingClientRect().height >= 44));
    await page.evaluate(() => sessionStorage.setItem('qa-refund-deny','1'));
    await submit.click();
    await form.getByRole('alert').filter({ hasText: 'clôturée' }).waitFor();
    assert.equal(await form.getByLabel('Montant TTC remboursé (CHF)', { exact: false }).inputValue(),'54.05');
    assert.equal(await form.getByLabel('Date de l’avoir', { exact: false }).inputValue(),'2026-04-20');
    await page.waitForFunction(() => { const panel = document.querySelector('[role="dialog"] [role="alert"]'); const footer = document.querySelector('[role="dialog"] .form-actions'); if (!panel || !footer) return false; const rect = panel.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= footer.getBoundingClientRect().top; });
    await capture('refusal');
    await submit.click();
    await form.getByRole('alert').filter({ hasText: 'Réponse perdue' }).waitFor();
    await submit.click();
    await form.waitFor({ state: 'hidden' });
    const refresh = page.getByRole('button', { name: 'Actualiser les données', exact: true });
    await refresh.waitFor(); await capture('read-recovery'); await refresh.click(); await refresh.waitFor({ state: 'hidden' });
    const card = page.locator('.purchase-document-card.is-legacy');
    await card.getByText('Remboursé en partie', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-refund-commits')),'1');
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-refund-attempts')));
    assert.equal(attempts.length,3); assert.equal(new Set(attempts.map(row => row.requestId)).size,1);
    assert.equal(attempts[0].netCents,5000); assert.equal(attempts[0].vatCents,405);
    await navigate('Rapports');
    assert.match((await page.locator('.report-card footer').innerText()).replace(/\s/g,''),/-50\.00CHF/);
    await navigate('Achats & fournisseurs'); await documents();
    await page.locator('.purchase-document-card.is-legacy').getByRole('button', { name: 'Consulter', exact: true }).click();
    await page.getByLabel('Historique des remboursements', { exact: true }).waitFor();
    await capture('history');
    await page.getByRole('button', { name: 'Corriger une saisie erronée', exact: true }).click();
    const correction = page.getByRole('dialog', { name: 'Corriger un remboursement', exact: true });
    await correction.getByLabel('Date de correction de l’avoir', { exact: false }).fill('2026-08-01');
    await correction.getByLabel('Date de correction bancaire', { exact: false }).fill('2026-08-01');
    assert.ok(await correction.getByLabel('Montant TTC remboursé (CHF)', { exact: false }).isDisabled());
    await correction.getByLabel('Motif de la correction', { exact: false }).fill('Ce remboursement a été saisi sur le mauvais achat.');
    await capture('correction'); await correction.getByRole('button', { name: 'Corriger la saisie', exact: true }).click(); await correction.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-refund-commits')),'2');
    await navigate('Rapports');
    assert.match((await page.locator('.report-card footer').innerText()).replace(/\s/g,''),/-100\.00CHF/);
    await capture('restored');
    assert.deepEqual(errors,[]);
    report.push({ width, result: 'PASS: partial refund, distinct dates, preserved refusal, lost response replay, confirmed-write read recovery, one commit, project cost reduction, dated correction, original cost restored, Escape closes detail, readable summary, mobile action height and no overflow', screenshots: 6 });
    await page.close();
  }
} catch (error) {
  process.exitCode = 1; report.push({ fatal: error.stack });
  const page = browser.contexts().flatMap(context => context.pages()).at(-1);
  if (page) { await page.screenshot({ path: '.qa/expense-refund/failure.png' }); await writeFile('.qa/expense-refund/failure.html',await page.content()); }
} finally {
  await writeFile('.qa/expense-refund/report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); await browser.close();
}
