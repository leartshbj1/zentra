import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5192';
const report = [];
await mkdir('.qa/payroll-guided', { recursive: true });
let page;
async function capture(name) {
  await page.locator('.modal__body').evaluate((node) => node.scrollTo({ top: 0, behavior: 'instant' }));
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: `.qa/payroll-guided/${name}.png` });
}
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => report.push({ error: error.stack }));
    await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
    await page.goto(`${base}/tests/mobile-harness.html?payroll=1`);
    const tour = page.getByRole('button', { name: 'Fermer le guide automatique', exact: true });
    await tour.waitFor();
    await tour.click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Équipe & salaires');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Équipe & salaires', { exact: true }) }).click();
    await page.locator('.team-navigation').getByRole('button', { name: /Fiches de salaire/ }).click();
    await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
    await modal.locator('input[name=period]').fill('2026-09');
    await modal.locator('input[name=paymentDate]').fill('2026-09-30');
    assert.equal(await modal.locator('.payroll-salary').isVisible(), false);
    await capture(`${width}-1-person`);
    await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
    const salary = modal.getByRole('spinbutton', { name: 'Salaire brut du mois (CHF)', exact: true });
    assert.equal(await salary.inputValue(), '5000');
    assert.equal(await modal.locator('.contribution-selection-list').isVisible(), false);
    await modal.getByRole('button', { name: 'Reprendre les réglages du profil', exact: true }).click();
    assert.equal(await modal.locator('.contribution-selection-list input:checked').count(), 13);
    await salary.fill('5100');
    await capture(`${width}-2-salary`);
    await modal.getByText('Règles et montants de mon canton · 2026', { exact: true }).click();
    const canton = modal.getByRole('combobox', { name: /^Canton à consulter/ });
    assert.equal(await canton.locator('option').count(), 27);
    await canton.selectOption('VS');
    await modal.getByText(/Valais : une cotisation CAF salarié de 0,13 %/).waitFor();
    await modal.getByText('Règles et montants de mon canton · 2026', { exact: true }).click();
    await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
    await modal.locator('.payroll-net').waitFor();
    // 5100 - 5.3% AVS/AI/APG - 1.1% AC - 1% AANP - 250 LPP = 4472.60.
    assert.match(await modal.locator('.payroll-net > strong').textContent(), /4.?472[.,]60/);
    const calculation = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-calculate')).at(-1));
    assert.equal(calculation.items.find((item) => item.definitionId === 'AAP_TEST').basisCents, 510000);
    await modal.locator('textarea[name=notes]').fill('Salaire de septembre\nMerci pour votre travail.');
    await modal.getByRole('button', { name: 'Retour', exact: true }).click();
    await salary.fill('5200');
    if (width === 390) {
      await modal.getByText('Vérifier les cotisations et leurs bases', { exact: true }).click();
      const attempt = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-calculate')).length + 1);
      await page.evaluate((attempt) => sessionStorage.setItem(`qa-payroll-hold-calculate-${attempt}`, '1'), attempt);
      await modal.getByRole('button', { name: 'Calculer les cotisations', exact: true }).click();
      await page.waitForFunction((attempt) => sessionStorage.getItem(`qa-payroll-waiting-calculate-${attempt}`) === '1', attempt);
      await salary.fill('5300');
      await modal.getByRole('button', { name: 'Calculer les cotisations', exact: true }).click();
      await page.evaluate((attempt) => sessionStorage.setItem(`qa-payroll-hold-calculate-${attempt}`, '0'), attempt);
      await page.waitForFunction((attempt) => !sessionStorage.getItem(`qa-payroll-waiting-calculate-${attempt}`), attempt);
      await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
      assert.match(await modal.locator('.payroll-net > strong').textContent(), /4.?657[.,]80/, 'A slow earlier result never replaces the latest salary');
      await modal.getByRole('button', { name: 'Retour', exact: true }).click();
      await salary.fill('5200');
    }
    await modal.getByRole('button', { name: 'Vérifier le salaire', exact: true }).click();
    assert.match(await modal.locator('.payroll-net > strong').textContent(), /4.?565[.,]20/);
    assert.match(await modal.locator('textarea[name=notes]').inputValue(), /\nMerci/);
    await capture(`${width}-3-review`);
    const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('.modal,.modal__body,.payroll-wizard')].some((node) => node.scrollWidth > node.clientWidth + 1) }));
    assert.ok(geometry.document <= width && !geometry.overflow, JSON.stringify(geometry));
    await modal.locator('input[name=validated]').check();
    await page.evaluate(() => sessionStorage.setItem('qa-payroll-refuse-save', '1'));
    await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
    await modal.getByText('Choisissez les comptes du salaire', { exact: true }).waitFor();
    await modal.locator('.payroll-problem').filter({ hasText: 'Le compte des salaires à payer est inactif' }).getByText('Voir le message détaillé', { exact: true }).click();
    await modal.getByText(/Le compte des salaires à payer est inactif/).waitFor();
    assert.match(await modal.locator('textarea[name=notes]').inputValue(), /\nMerci/);
    await page.evaluate(() => sessionStorage.setItem('qa-payroll-refuse-save', '0'));
    await modal.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-save')).at(-1));
    assert.equal(saved.data.status, 'validated');
    assert.equal(saved.data.employeeId, 'elodie');
    assert.equal(saved.data.paymentDate, '2026-09-30');
    assert.equal(saved.lines[0].amountCents, 520000);
    assert.equal(saved.selections.length, 13);
    // Switching employee clears both the old salary edit and personal LPP choices.
    await page.getByRole('button', { name: 'Nouvelle fiche', exact: true }).click();
    await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('elodie');
    await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
    await salary.fill('9900');
    await modal.getByRole('button', { name: 'Reprendre les réglages du profil', exact: true }).click();
    await modal.getByRole('button', { name: 'Retour', exact: true }).click();
    await modal.getByRole('combobox', { name: /^Collaborateur/ }).selectOption('jean');
    await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
    assert.equal(await salary.inputValue(), '5000');
    assert.equal(await modal.locator('.contribution-selection-list input:checked').count(), 11);
    assert.equal(await modal.locator('.contribution-selection-list > article').filter({ hasText: 'LPP_EMPLOYEE' }).count(), 0);
    if (width === 320) {
      await modal.getByText('Vérifier les cotisations et leurs bases', { exact: true }).click();
      const selected = modal.locator('.contribution-selection-list input:checked');
      while (await selected.count()) await selected.first().uncheck();
      await modal.getByRole('button', { name: 'Retour', exact: true }).click();
      await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
      assert.equal(await selected.count(), 0, 'Back navigation must not silently restore deliberately removed contributions');
    }
    if (width === 390) {
      await modal.getByRole('button', { name: 'Retour', exact: true }).click();
      await page.evaluate(() => sessionStorage.setItem('qa-payroll-fail-rates', '1'));
      await modal.locator('input[name=paymentDate]').fill('2026-09-28');
      await modal.getByRole('button', { name: 'Réessayer le chargement', exact: true }).waitFor();
      await modal.locator('.payroll-problem').filter({ hasText: 'Les paramètres de cotisation sont momentanément indisponibles' }).getByText('Voir le message détaillé', { exact: true }).click();
      await modal.getByText(/Les paramètres de cotisation sont momentanément indisponibles/).waitFor();
      assert.equal(await modal.getByRole('button', { name: 'Continuer', exact: true }).isEnabled(), false);
      await page.evaluate(() => sessionStorage.setItem('qa-payroll-fail-rates', '0'));
      await modal.getByRole('button', { name: 'Réessayer le chargement', exact: true }).click();
      await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
      assert.equal(await salary.inputValue(), '5000');
    }
    report.push({ width, ...geometry, result: 'PASS guided creation, canton references, recalculation, back navigation, save failure/retry, validated save and employee isolation' });
    await page.close();
  }
  assert.deepEqual(report.filter((row) => row.error), []);
} catch (error) {
  report.push({ fatal: error.stack }); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: '.qa/payroll-guided/failure.png' });
} finally { await writeFile('.qa/payroll-guided/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser.close(); }
