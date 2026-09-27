import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const output = '.impeccable/review/shared-mail';
await mkdir(output, { recursive: true });
const results = [];
for (const [engine, type] of [
  ['edge', chromium],
  ['webkit', webkit],
]) {
  const browser = await type.launch({
    headless: true,
    ...(engine === 'edge' && process.platform === 'win32'
      ? { channel: 'msedge' }
      : {}),
  });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 950 },
        reducedMotion: 'reduce',
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const theme = width === 390 ? 'dark' : 'light';
      const open = (query) =>
        page.goto(
          `${origin}/tests/outgoing-mail-preview.html?theme=${theme}&${query}`,
        );
      await open('');
      await page
        .getByLabel('Clé API Infomaniak', { exact: false })
        .fill('SYNTHETIC-FIXTURE-ONLY');
      await page
        .getByRole('button', {
          name: 'Connecter pour l’entreprise',
          exact: true,
        })
        .click();
      await page
        .getByText('Adresse vérifiée pour l’entreprise.', { exact: false })
        .waitFor();
      assert.equal(
        await page.getByText('Nom vérifié Infomaniak', { exact: true }).count(),
        1,
      );
      assert.equal(await page.locator('input[type=password]').count(), 0);
      assert.equal(
        await page.evaluate(() => window.__mailQa.sharedConnections),
        1,
      );
      await page.screenshot({
        path: `${output}/settings-${engine}-${width}.png`,
        fullPage: true,
      });
      await page
        .getByRole('button', {
          name: 'Déconnecter pour l’entreprise',
          exact: true,
        })
        .click();
      assert.equal(
        await page.evaluate(() => window.__mailQa.sharedDisconnects),
        0,
      );
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      assert.equal(
        await page.evaluate(() => window.__mailQa.sharedDisconnects),
        0,
      );
      await page
        .getByRole('button', {
          name: 'Déconnecter pour l’entreprise',
          exact: true,
        })
        .click();
      await page
        .getByRole('button', { name: 'Confirmer la déconnexion', exact: true })
        .click();
      await page
        .getByText('Messagerie déconnectée pour l’entreprise.', { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => window.__mailQa.sharedDisconnects),
        1,
      );
      await open('shared&composer&connected&logo');
      const dialog = page.getByRole('dialog');
      const send = dialog.getByRole('button', {
        name: 'Envoyer l’e-mail',
        exact: true,
      });
      await dialog
        .getByText('equipe@example.invalid', { exact: true })
        .waitFor();
      assert.equal(
        await dialog
          .getByRole('combobox', { name: 'Adresse utilisée pour l’envoi' })
          .inputValue(),
        'company',
      );
      await dialog
        .getByRole('textbox', { name: /^Message/ })
        .fill('Texte propre au client. Ne jamais traduire ce contenu.');
      await page.screenshot({
        path: `${output}/composer-${engine}-${width}.png`,
        fullPage: true,
      });
      await send.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/composer-actions-${engine}-${width}.png`, fullPage: true });
      await send.evaluate((button) => {
        button.click();
        button.click();
      });
      await page.getByRole('dialog', { name: 'E-mail transmis' }).waitFor();
      assert.equal(await page.evaluate(() => window.__mailQa.sharedSends), 1);
      assert.equal(await page.evaluate(() => window.__mailQa.sends), 0);
      assert.equal(
        await page.evaluate(() => window.__mailQa.inputs[0].body),
        'Texte propre au client. Ne jamais traduire ce contenu.',
      );
      await open('shared&composer&connected&uncertain');
      await dialog
        .getByText('equipe@example.invalid', { exact: true })
        .waitFor();
      await send.click();
      await dialog
        .getByText('L’envoi n’a pas pu être confirmé.', { exact: false })
        .waitFor();
      assert.equal(await send.isDisabled(), true);
      assert.equal(
        await dialog
          .getByRole('combobox', { name: 'Adresse utilisée pour l’envoi' })
          .isDisabled(),
        true,
      );
      await dialog
        .getByRole('button', {
          name: 'Vérifier l’état de l’envoi',
          exact: true,
        })
        .click();
      await page.getByRole('dialog', { name: 'E-mail transmis' }).waitFor();
      assert.equal(await page.evaluate(() => window.__mailQa.sharedSends), 1);
      assert.equal(await page.evaluate(() => window.__mailQa.recoveries), 1);
      assert.equal(await page.evaluate(() => window.__mailQa.sends), 0);
      await open('shared&composer&pending');
      await dialog
        .getByText('equipe@example.invalid', { exact: true })
        .waitFor();
      await send.click();
      await dialog
        .getByText('Envoi non confirmé — à vérifier avant de renvoyer', {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.getByRole('dialog', { name: 'E-mail transmis' }).count(),
        0,
      );
      await dialog
        .getByRole('button', { name: 'Fermer', exact: true })
        .last()
        .click();
      await page
        .getByRole('button', { name: 'Préparer un e-mail', exact: true })
        .click();
      await dialog.locator('summary').click();
      await dialog
        .getByRole('button', {
          name: 'Vérifier l’état de l’envoi',
          exact: true,
        })
        .click();
      await dialog
        .getByText('Accepté par le serveur', { exact: false })
        .waitFor();
      assert.equal(await page.evaluate(() => window.__mailQa.sharedSends), 1);
      assert.equal(
        await page.getByRole('dialog', { name: 'E-mail transmis' }).count(),
        0,
      ); // recovered an older message, not this new draft
      await open('shared&composer&connected&offline');
      await dialog
        .getByText('La messagerie partagée est indisponible.', { exact: false })
        .waitFor();
      assert.equal(await send.isDisabled(), true);
      await dialog
        .getByRole('combobox', { name: 'Adresse utilisée pour l’envoi' })
        .selectOption('device');
      assert.equal(await send.isEnabled(), true); // deliberate local choice only
      await send.click();
      await page.getByRole('dialog', { name: 'E-mail transmis' }).waitFor();
      assert.equal(await page.evaluate(() => window.__mailQa.sends), 1);
      assert.equal(await page.evaluate(() => window.__mailQa.sharedSends), 0);
      await open('shared&composer&readOnly');
      await dialog
        .getByText('Votre compte ne peut pas envoyer', { exact: false })
        .waitFor();
      assert.equal(await send.isDisabled(), true);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      assert.deepEqual(errors, []);
      results.push({
        engine,
        width,
        theme,
        sharedConnection: true,
        confirmedCompanyDisconnect: true,
        senderShown: true,
        singleSubmission: true,
        recoveryWithoutResend: true,
        reopenRecovery: true,
        pendingNotSuccess: true,
        explicitLocalFallback: true,
        readOnly: true,
        errors,
      });
      await page.close();
    }
    if (engine === 'edge')
      for (const lang of ['de', 'it', 'en']) {
        const page = await browser.newPage({
          viewport: { width: 390, height: 950 },
        });
        await page.goto(
          `${origin}/tests/outgoing-mail-preview.html?lang=${lang}`,
        );
        await page
          .locator('.mail-shared-settings input[type=password]')
          .waitFor();
        await page.waitForFunction(
          () => document.documentElement.lang !== 'fr',
        );
        await page.screenshot({
          path: `${output}/settings-${lang}-390.png`,
          fullPage: true,
        });
        const visible = await page.locator('main').innerText();
        assert(
          !visible.includes('Clé API Infomaniak') &&
            !visible.includes('Une adresse pour toute'),
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          ),
          false,
        );
        results.push({ lang, width: 390, translated: true, overflow: false });
        await page.close();
      }
  } finally {
    await browser.close();
  }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
