import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ZENTRA_QA_BROWSER || 'edge';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const out = `.qa/bank-customer-${engine}`; await mkdir(out, { recursive: true });
const report = [], origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
async function navigate(page, name) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
}
async function start(width, extra = '', init) {
  const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 900 }, hasTouch: width < 800 });
  page.setDefaultTimeout(12000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&bankCustomerRefund=1${extra}`);
  const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
  if (width > 860) await tour.click();
  await navigate(page, 'Banque');
  return { page, errors };
}
const flag = (page, lost) => page.evaluate(lost => lost ? sessionStorage.setItem('qa-bank-customer-lost', '1') : sessionStorage.removeItem('qa-bank-customer-lost'), lost);
const state = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-bank-customer-state')));
async function capture(page, name) {
  await page.evaluate(async () => { await document.fonts.ready; await Promise.race([new Promise(resolve => setTimeout(resolve, 600)), Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))]); });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `page overflow ${name}`);
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) assert.ok(await dialog.locator('.modal__body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `dialog overflow ${name}`);
  await page.screenshot({ path: `${out}/${name}.png` });
}
async function pendingRetry(page) {
  const pending = page.getByRole('region', { name: 'Demandes bancaires à vérifier' });
  await pending.getByRole('button', { name: 'Vérifier la demande', exact: true }).click();
  await pending.waitFor({ state: 'detached' });
}
try {
  for (const width of [320, 390, 1440]) {
    console.log(`Customer refund journey ${engine} ${width}`);
    const { page, errors } = await start(width);
    await page.locator('.bank-refund-picker summary').click();
    await page.getByRole('button', { name: 'Enregistrer un remboursement client', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Enregistrer le remboursement client', exact: true });
    const submit = dialog.getByRole('button', { name: 'Enregistrer et rapprocher', exact: true });
    assert.ok(await submit.isDisabled());
    await dialog.getByRole('textbox', { name: /Motif du remboursement/ }).fill('Restitution de la prestation annulée');
    if (width !== 390) await dialog.locator('input[type=file]').setInputFiles({ name: 'preuve-client.png', mimeType: 'image/png', buffer: png });
    await capture(page, `${width}-create`);
    if (width < 600) {
      const tops = await dialog.locator('.form-actions .button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
      assert.ok(Math.abs(tops[0] - tops[1]) < 1, 'compact mobile actions');
    }
    await flag(page, true); await submit.click();
    await dialog.getByRole('alert').filter({ hasText: 'Réponse interrompue' }).waitFor();
    assert.ok(await dialog.getByRole('textbox', { name: /Motif du remboursement/ }).isDisabled());
    await dialog.getByRole('button', { name: 'Fermer', exact: true }).click();
    await capture(page, `${width}-pending`);
    await page.reload(); await navigate(page, 'Banque');
    const pending = page.getByRole('region', { name: 'Demandes bancaires à vérifier' });
    await pending.waitFor(); if (width !== 390) assert.match(await pending.innerText(), /preuve-client.png/);
    await flag(page, false); await pendingRetry(page);
    const saved = await state(page); assert.equal(saved.commits, 1);
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-bank-customer-attempts')));
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    if (width !== 390) assert.deepEqual(attempts[1].input.receipt.bytes, [...png]);
    await page.getByRole('tab', { name: /Rapprochés/ }).click();
    await page.getByRole('button', { name: 'Voir l’avoir client', exact: true }).click();
    const document = page.getByRole('dialog');
    await document.locator('.customer-credit-card__history summary').filter({ hasText: 'Historique' }).click();
    await document.getByText('Rapproché au relevé.', { exact: false }).waitFor();
    if (width !== 390) { await document.getByRole('button', { name: 'Ouvrir preuve-client.png', exact: true }).click(); assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-bank-customer-opened')), 'customer-bank-receipt'); }
    await capture(page, `${width}-linked-credit`);
    await document.getByRole('button', { name: 'Fermer « Consulter avoir »', exact: true }).click();
    await navigate(page, 'Banque'); await page.getByRole('tab', { name: /Rapprochés/ }).click();
    await page.getByRole('button', { name: 'Dissocier du relevé', exact: true }).click();
    const unlink = page.getByRole('dialog', { name: 'Dissocier le remboursement du relevé', exact: true });
    await unlink.getByRole('textbox', { name: /Motif de la dissociation/ }).fill('Le débit doit être associé à une autre pièce');
    await flag(page, true); await unlink.getByRole('button', { name: 'Dissocier le remboursement', exact: true }).click();
    await unlink.getByRole('alert').filter({ hasText: 'Réponse interrompue' }).waitFor();
    await page.reload(); await navigate(page, 'Banque'); await flag(page, false); await pendingRetry(page);
    await page.locator('.bank-refund-history summary').click(); await capture(page, `${width}-history`);
    await page.locator('.bank-refund-picker summary').click();
    assert.equal(await page.getByRole('button', { name: 'Enregistrer un remboursement client', exact: true }).count(), 0);
    await page.locator('.bank-candidate-option').click(); assert.ok(await page.getByRole('radio').isChecked()); await flag(page, true);
    await page.getByRole('button', { name: 'Associer le remboursement', exact: true }).click();
    await page.getByRole('region', { name: 'Demandes bancaires à vérifier' }).waitFor();
    await page.reload(); await navigate(page, 'Banque'); await flag(page, false); await pendingRetry(page);
    assert.equal((await state(page)).commits, 1); assert.equal((await state(page)).history.length, 1);
    assert.deepEqual(errors, []); report.push({ width, creation: true, receipt: width !== 390, reloadRecovery: true, unlink: true, relink: true });
    await page.close();
  }
  {
    const { page, errors } = await start(390, '&existingRefund=1');
    await page.locator('.bank-refund-picker summary').click(); await page.locator('.bank-candidate-option').click(); assert.ok(await page.getByRole('radio').isChecked());
    const submit = page.getByRole('button', { name: 'Associer le remboursement', exact: true }); assert.ok(await submit.isDisabled());
    await page.getByRole('textbox', { name: /Justification de l’écart de dates/ }).fill('Date de valeur différente sur le relevé');
    await capture(page, '390-date-difference'); await submit.click();
    await page.getByText('Remboursement client rapproché', { exact: true }).waitFor();
    const saved = await state(page); assert.equal(saved.commits, 0); assert.equal(saved.active.payment_date, '2026-03-14');
    assert.deepEqual(errors, []); await page.close(); report.push({ existingDateDifference: true });
  }
  {
    const { page, errors } = await start(390, '&existingRefund=1');
    await page.locator('.bank-refund-picker summary').click(); await page.locator('.bank-candidate-option').click();
    await page.getByRole('textbox', { name: /Justification de l’écart de dates/ }).fill('Date de valeur documentée');
    await flag(page, true); await page.getByRole('button', { name: 'Associer le remboursement', exact: true }).click();
    const pending = page.getByRole('region', { name: 'Demandes bancaires à vérifier' }); await pending.waitFor();
    await page.getByRole('alert').filter({ hasText: 'Réponse interrompue' }).waitFor();
    await pending.getByRole('button', { name: 'Retirer de cette liste', exact: true }).click();
    await pending.getByRole('button', { name: 'Retirer la demande locale', exact: true }).click(); await pending.waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: /Rapprochés/ }).click(); await page.getByRole('button', { name: 'Voir l’avoir client', exact: true }).waitFor();
    assert.equal((await state(page)).commits, 0); assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-bank-customer-attempts')).length), 1);
    assert.deepEqual(errors, []); await page.close(); report.push({ removeLocalCopyPreservesLink: true });
  }
  {
    const { page, errors } = await start(320, '&readOnly=1');
    await page.locator('.bank-refund-picker summary').click();
    assert.ok(await page.getByRole('button', { name: 'Enregistrer un remboursement client', exact: true }).isDisabled());
    await capture(page, '320-readonly'); assert.deepEqual(errors, []); await page.close(); report.push({ readOnly: true });
  }
  {
    const { page, errors } = await start(390, '', () => { IDBFactory.prototype.open = () => { throw new DOMException('Storage unavailable', 'InvalidStateError'); }; });
    await page.getByText('Demandes de remboursement indisponibles', { exact: true }).waitFor();
    await page.locator('.bank-refund-picker summary').click();
    assert.ok(await page.getByRole('button', { name: 'Enregistrer un remboursement client', exact: true }).isDisabled());
    assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-bank-customer-attempts')), null);
    assert.deepEqual(errors, []); await page.close(); report.push({ unavailableStorage: true });
  }
} catch (error) {
  process.exitCode = 1; report.push({ fatal: error.stack });
  const page = browser.contexts().flatMap(context => context.pages()).at(-1);
  if (page) { await page.screenshot({ path: `${out}/failure.png` }); await writeFile(`${out}/failure.html`, await page.content()); }
} finally { await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser.close(); }
