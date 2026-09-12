import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/accounting-setup';
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, driver] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await driver.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const [width, height, payroll, received, required] of [[320, 568, false, false, 7], [390, 844, false, true, 8], [844, 390, true, false, 11], [1440, 900, true, true, 12]]) {
      for (const mode of ['mapping', 'starter']) {
        const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(14000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => { errors.push(`Unexpected native confirmation: ${dialog.message()}`); await dialog.dismiss(); });
        const snapshot = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-accounting-setup')));
        const writes = async () => (await snapshot()).writes.length;
        const capture = async label => { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: `${output}/${engine}-${width}-${mode}-${label}.png` }); };
        const navigate = async (firstVisit = false) => {
          const guide = page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }); if (firstVisit || await guide.count()) await guide.click();
          await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
          await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
          await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
          await page.getByRole('button', { name: /^(Préparer les comptes|Vérifier ma configuration)$/ }).click();
          await page.getByRole('heading', { name: 'Comptes de liaison', exact: true }).waitFor();
          await page.waitForFunction(() => !document.querySelector('.accounting-setup__actions button')?.disabled);
        };
        try {
          await page.goto(`${base}/tests/mobile-harness.html?accountingSetup=${mode}${payroll ? '&setupPayroll=1' : ''}${received ? '&setupReceived=1' : ''}`);
          await navigate(true);
          assert.ok((await page.locator('.accounting-setup__progress').innerText()).includes(`sur ${required} comptes`));
          assert.equal(await page.locator('.accounting-account-plan').getAttribute('open'), null);
          await page.evaluate(() => window.__qaSetReadOnly(true));
          await page.waitForFunction(() => document.querySelector('.accounting-setup__actions button')?.disabled);
          assert.equal(await writes(), 0);
          await page.evaluate(() => window.__qaSetReadOnly(false));
          const openReview = () => page.getByRole('button', { name: mode === 'starter' ? 'Installer la base essentielle' : 'Vérifier avant d’enregistrer', exact: true }).click();
          if (mode === 'mapping') {
            const ar = page.locator('[data-mapping-key=arAccountId]');
            assert.equal(await ar.inputValue(), 'expense');
            assert.deepEqual(await ar.locator('option:not([disabled])').evaluateAll(options => options.map(option => option.value)), ['', 'ar', 'bank', 'vatInput']);
            await openReview();
            await page.waitForFunction(() => document.activeElement?.getAttribute('data-mapping-key') === 'arAccountId');
            assert.equal(await page.getByRole('dialog').count(), 0);
            await capture('field-error');
            await ar.selectOption('ar');
            await page.getByRole('button', { name: 'Créer un compte manquant', exact: true }).click();
            await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'code');
            const account = page.locator('.account-inline-form');
            await account.locator('[name=code]').fill('6010'); await account.locator('[name=name]').fill('Frais administratifs de recette');
            await account.locator('[name=accountType]').selectOption('expense');
            await account.locator('[name=normalBalance]').selectOption('debit');
            await account.locator('[name=reportSection]').selectOption('other_operating_expense');
            await account.getByRole('button', { name: 'Enregistrer', exact: true }).click();
            await account.waitFor({ state: 'detached' });
            assert.equal(await ar.inputValue(), 'ar'); // Creating a missing account keeps the mapping draft.
            await openReview();
            await page.waitForFunction(() => document.activeElement?.getAttribute('data-mapping-key') === 'expenseAccountId');
            await page.locator('[data-mapping-key=expenseAccountId]').selectOption('new-account');
            if (received) {
              await page.getByRole('button', { name: /^TVA Ranger/ }).click();
              await page.locator('[data-mapping-key=vatDeferredPayableAccountId]').selectOption('');
              await openReview();
              await page.waitForFunction(() => document.activeElement?.getAttribute('data-mapping-key') === 'vatDeferredPayableAccountId');
              await page.locator('[data-mapping-key=vatDeferredPayableAccountId]').selectOption('vatDeferred');
            }
            if (payroll) {
              await page.getByRole('button', { name: /^Salaires et cotisations/ }).click();
              await page.locator('[data-mapping-key=wagesPayableAccountId]').selectOption('');
              await openReview();
              await page.waitForFunction(() => document.activeElement?.getAttribute('data-mapping-key') === 'wagesPayableAccountId');
              await page.locator('[data-mapping-key=wagesPayableAccountId]').selectOption('wagesDue');
            }
          }
          await openReview();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          assert.ok((await dialog.innerText()).includes('périodes fermées'));
          if (mode === 'starter') assert.ok((await dialog.innerText()).includes('12 comptes'));
          const submit = () => dialog.getByRole('button', { name: mode === 'starter' ? 'Créer les comptes et activer' : 'Enregistrer ces réglages', exact: true });
          await page.evaluate(() => window.__qaSetReadOnly(true));
          await page.waitForFunction(() => document.querySelector('.accounting-setup-review button[type=submit]')?.disabled);
          await submit().evaluate(button => button.click()); assert.equal(await writes(), 0);
          await page.evaluate(() => { window.__qaSetReadOnly(false); sessionStorage.setItem('qa-setup-refuse-write', '1'); });
          await submit().click();
          await dialog.getByText('Vérifions ce point', { exact: true }).waitFor();
          assert.equal(await writes(), 1);
          assert.equal((await snapshot()).saved, false);
          await dialog.getByRole('button', { name: 'Revenir aux réglages', exact: true }).click();
          if (mode === 'mapping') { assert.equal(await page.locator('[data-mapping-key=arAccountId]').inputValue(), 'ar'); assert.equal(await page.locator('[data-mapping-key=expenseAccountId]').inputValue(), 'new-account'); }
          await openReview();
          await capture('confirmation');
          await page.evaluate(() => { sessionStorage.removeItem('qa-setup-refuse-write'); sessionStorage.setItem('qa-setup-hold-write', '1'); sessionStorage.setItem('qa-setup-recover', '1'); });
          await submit().click();
          await page.waitForFunction(() => typeof window.__qaReleaseSetup === 'function');
          await dialog.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
          await page.keyboard.press('Escape'); assert.ok(await dialog.isVisible());
          assert.equal(await writes(), 2);
          await page.evaluate(() => window.__qaReleaseSetup());
          await page.getByRole('dialog', { name: 'Enregistré, affichage à actualiser', exact: true }).waitFor();
          assert.equal((await snapshot()).saved, true);
          assert.equal(await writes(), 2);
          await page.keyboard.press('Escape'); assert.ok(await dialog.isVisible());
          await capture('saved-refresh');
          await page.evaluate(() => window.__qaSetReadOnly(true));
          const refresh = () => dialog.getByRole('button', { name: 'Actualiser les données', exact: true });
          await refresh().click();
          await refresh().waitFor(); assert.equal(await writes(), 2);
          await page.evaluate(() => { sessionStorage.removeItem('qa-setup-block-reads'); sessionStorage.setItem('qa-setup-block-reports', '1'); });
          await refresh().click();
          await dialog.getByText(/Certains états n’ont pas pu être actualisés/).waitFor();
          assert.equal(await writes(), 2);
          await page.evaluate(() => sessionStorage.removeItem('qa-setup-block-reports'));
          await refresh().click();
          await page.getByRole('dialog', { name: 'La configuration est enregistrée', exact: true }).waitFor();
          await dialog.getByRole('button', { name: 'Voir mes comptes', exact: true }).click();
          await page.evaluate(() => { window.__qaSetReadOnly(false); sessionStorage.removeItem('qa-setup-hold-write'); sessionStorage.removeItem('qa-setup-recover'); });
          await page.reload(); await navigate();
          assert.equal(await writes(), 2);
          const saved = await snapshot();
          assert.equal(saved.settings.enabled, true);
          if (mode === 'mapping') { assert.equal(saved.settings.expenseAccountId, 'new-account'); assert.equal(saved.settings.vatDeferredPayableAccountId, received ? 'vatDeferred' : ''); }
          else assert.equal(saved.accounts.length, 12);
          assert.equal(await page.getByRole('button', { name: 'Installer la base essentielle', exact: true }).count(), 0);
          assert.ok(await page.getByRole('checkbox', { name: /Activer les écritures automatiques/ }).isDisabled());
          await capture('persisted');
          assert.deepEqual(errors, []);
          reports.push({ engine, width, height, mode, required, result: 'PASS typed accounts, guided errors, draft preserved, explicit confirmation, single write while pending, read-only recovery, reports retry, retained configuration' });
          console.log(JSON.stringify(reports.at(-1)));
        } catch (error) { await page.screenshot({ path: `${output}/${engine}-${width}-${mode}-failure.png` }); await writeFile(`${output}/${engine}-${width}-${mode}-failure.txt`, await page.locator('body').innerText()); reports.push({ engine, width, height, mode, error: error.stack }); throw error; }
        finally { await page.close(); }
      }
    }
  } finally { await browser.close(); await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2)); }
}
