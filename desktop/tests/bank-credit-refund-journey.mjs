import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const out = fileURLToPath(
  new URL('../../.qa/bank-credit-refund', import.meta.url),
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
});
const report = [];
try {
  for (const width of [320, 390, 768, 1440])
    for (const readOnly of [false, true]) {
      const page = await browser.newPage({
        viewport: { width, height: 940 },
        hasTouch: width < 800,
      });
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(
        `${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?bankCreditRefund=1${readOnly ? '&readOnly=1' : ''}`,
      );
      const tour = page.getByRole('button', {
        name: 'Ne plus afficher automatiquement',
        exact: true,
      });
      if (await tour.isVisible()) await tour.click();
      const navigate = async (name) => {
        await page
          .getByRole('button', { name: 'Aller à un écran', exact: true })
          .click();
        await page
          .getByRole('searchbox', { name: 'Rechercher un écran' })
          .fill(name);
        await page
          .locator('.navigation-palette__results button')
          .filter({ has: page.getByText(name, { exact: true }) })
          .click();
        await page
          .locator('.navigation-palette')
          .waitFor({ state: 'detached' });
      };
      const capture = async (name) => {
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          `overflow ${width} ${name}`,
        );
        const dialog = page.getByRole('dialog');
        if (await dialog.isVisible())
          assert.ok(
            await dialog
              .locator('.modal__body')
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
            `dialog overflow ${width} ${name}`,
          );
        await page.screenshot({
          path: `${out}/${width}-${readOnly ? 'readonly' : 'write'}-${name}.png`,
        });
      };
      const flag = async (name, value) =>
        page.evaluate(
          ({ name, value }) =>
            value
              ? sessionStorage.setItem(`qa-credit-bank-${name}`, '1')
              : sessionStorage.removeItem(`qa-credit-bank-${name}`),
          { name, value },
        );
      await navigate('Banque');
      await page.locator('.bank-refund-picker summary').click();
      const create = page.getByRole('button', {
        name: 'Rembourser un avoir fournisseur',
        exact: true,
      });
      if (readOnly) {
        assert.ok(await create.isDisabled());
        await capture('blocked');
        report.push({ width, readOnly, passed: true });
        await page.close();
        continue;
      }
      await create.click();
      const modal = page.getByRole('dialog', {
        name: 'Rembourser un avoir depuis le relevé',
        exact: true,
      });
      const submit = modal.getByRole('button', {
        name: 'Créer et rapprocher le remboursement',
        exact: true,
      });
      assert.ok(await submit.isDisabled());
      assert.equal(
        await modal
          .getByRole('combobox', { name: /Avoir à rembourser/ })
          .inputValue(),
        'available-credit',
      );
      await modal
        .getByRole('textbox', { name: /Référence du remboursement/ })
        .fill('REMBOURSEMENT-AVOIR-FOURNISSEUR-2026-054');
      await modal
        .getByRole('textbox', { name: 'Motif obligatoire' })
        .fill('Retour de marchandises inutilisées sur le projet.');
      const file = modal.locator('input[type="file"]');
      await file.setInputFiles({
        name: 'incorrect.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('invalid'),
      });
      assert.ok(await submit.isDisabled());
      await file.setInputFiles({
        name: 'avoir-fournisseur.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nsynthetic'),
      });
      await capture('ready');
      await flag('deny', true);
      await submit.click();
      await modal.getByRole('alert').filter({ hasText: 'clôturée' }).waitFor();
      await flag('deny', false);
      await flag('lost', true);
      await submit.click();
      await modal
        .getByRole('alert')
        .filter({ hasText: 'Réponse interrompue' })
        .waitFor();
      await capture('lost-response');
      await flag('lost', false);
      await flag('after-save', true);
      await submit.click();
      await modal.waitFor({ state: 'detached' });
      await page
        .getByRole('button', { name: 'Actualiser les données', exact: true })
        .waitFor();
      await capture('refresh');
      const attempts = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem('qa-credit-bank-attempts')),
      );
      assert.equal(attempts.length, 3);
      assert.equal(new Set(attempts.map((row) => row.requestId)).size, 1);
      assert.equal(
        await page.evaluate(() =>
          sessionStorage.getItem('qa-credit-bank-commits'),
        ),
        '1',
      );
      await flag('read', false);
      await flag('after-save', false);
      await page
        .getByRole('button', { name: 'Actualiser les données', exact: true })
        .click();
      await page.getByRole('tab', { name: /^Rapprochés/ }).click();
      await page
        .getByRole('button', { name: 'Voir l’avoir fournisseur', exact: true })
        .click();
      const credit = page.locator('#supplier-credit-available-credit');
      await credit.waitFor();
      await credit
        .getByRole('button', {
          name: 'Ouvrir avoir-fournisseur.pdf',
          exact: true,
        })
        .click();
      assert.equal(
        await page.evaluate(() =>
          sessionStorage.getItem('qa-credit-bank-opened'),
        ),
        'credit-receipt',
      );
      await capture('source');
      await credit
        .getByRole('button', { name: 'Joindre un justificatif', exact: true })
        .click();
      const attachment = page.getByRole('dialog');
      await attachment
        .locator('input[type="file"]')
        .setInputFiles({
          name: 'confirmation-bancaire.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7\nsecond'),
        });
      await attachment
        .getByRole('button', { name: 'Ajouter le justificatif', exact: true })
        .click();
      await attachment.waitFor({ state: 'detached' });
      await credit
        .getByRole('button', {
          name: 'Ouvrir confirmation-bancaire.pdf',
          exact: true,
        })
        .waitFor();
      await navigate('Banque');
      await page.getByRole('tab', { name: /^Rapprochés/ }).click();
      await page
        .getByRole('button', { name: 'Dissocier du relevé', exact: true })
        .click();
      const unlink = page.getByRole('dialog', {
        name: 'Dissocier le remboursement du relevé',
        exact: true,
      });
      await unlink
        .getByRole('textbox', { name: /Motif de la dissociation/ })
        .fill('Correction de l’association bancaire');
      await unlink
        .getByRole('button', {
          name: 'Dissocier le remboursement',
          exact: true,
        })
        .click();
      await unlink.waitFor({ state: 'detached' });
      await page.locator('.bank-refund-picker summary').click();
      await page.locator('.bank-refund-picker .bank-candidate-option').click();
      await page
        .getByRole('button', { name: 'Associer le remboursement', exact: true })
        .click();
      await page.getByRole('tab', { name: /^Rapprochés/ }).click();
      await capture('rematched');
      assert.equal(
        (
          await page.evaluate(() =>
            JSON.parse(sessionStorage.getItem('qa-credit-bank-matches')),
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await page.evaluate(() =>
            JSON.parse(sessionStorage.getItem('qa-credit-bank-unlinks')),
          )
        ).length,
        1,
      );
      assert.equal(
        await page.evaluate(() =>
          sessionStorage.getItem('qa-credit-bank-commits'),
        ),
        '1',
      );
      assert.deepEqual(errors, []);
      report.push({
        width,
        readOnly,
        passed: true,
        atomicCreate: true,
        requestReplayed: true,
        onePayment: true,
        sourceAttachment: true,
        unlinkAndRelink: true,
      });
      await page.close();
    }
} catch (error) {
  const page = browser
    .contexts()
    .flatMap((ctx) => ctx.pages())
    .at(-1);
  if (page) {
    await page.screenshot({ path: `${out}/failure.png` });
    await writeFile(`${out}/failure.html`, await page.content());
  }
  throw error;
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
