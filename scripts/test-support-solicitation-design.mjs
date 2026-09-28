import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const base = process.env.SUPPORT_PREVIEW_URL || 'http://localhost:5348';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw Error('Local only');
const dir = '.impeccable/review/support-solicitation';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 960 },
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/support/demo', { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { name: 'Tous les tickets', exact: true })
      .waitFor();
    if (width <= 760)
      await page.getByRole('button', { name: 'Dossiers', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Dossiers des tickets' })
      .getByRole('button', { name: 'Démarchage', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Démarchage', exact: true })
      .waitFor();
    assert.equal(await page.locator('.support-ticket-row').count(), 1);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.support-sidebar')?.scrollTo(0, 0);
      document.querySelectorAll('textarea').forEach((e) => (e.scrollTop = 0));
    });
    await page.screenshot({
      path: `${dir}/folder-${width}.png`,
      fullPage: true,
    });
    await page.locator('.support-ticket-row').click();
    await page
      .getByRole('button', { name: 'Intéressé', exact: true })
      .waitFor();
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.support-sidebar')?.scrollTo(0, 0);
      document.querySelectorAll('textarea').forEach((e) => (e.scrollTop = 0));
    });
    await page.screenshot({
      path: `${dir}/message-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Ignorer', exact: true }).click();
    await page.getByRole('button', { name: 'Rétablir', exact: true }).click();
    await page.getByRole('button', { name: 'Intéressé', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Votre message', exact: true })
      .waitFor();
    const message = page.getByRole('textbox', {
      name: 'Votre message',
      exact: true,
    });
    assert.match(await message.inputValue(), /Atelier/);
    await message.fill((await message.inputValue()) + '\nMerci.');
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.support-sidebar')?.scrollTo(0, 0);
      document.querySelectorAll('textarea').forEach((e) => (e.scrollTop = 0));
    });
    await page.screenshot({
      path: `${dir}/reply-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Fermer la réponse' }).click();
    await page.getByRole('button', { name: 'STOP', exact: true }).click();
    assert.match(await message.inputValue(), /retirer|cesser|supprimer/);
    await page
      .getByRole('button', { name: 'Simuler l’envoi', exact: true })
      .click();
    await page
      .locator('.support-solicitation-actions')
      .getByText('STOP envoyé', { exact: true })
      .waitFor();
    await page.getByRole('tab', { name: 'Paramètres', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Le démarchage, à votre rythme.' })
      .waitFor();
    const alerts = page.getByRole('checkbox', { name: /Recevoir les alertes/ });
    assert.equal(await alerts.isChecked(), false);
    await alerts.check();
    await page
      .getByRole('button', { name: 'Enregistrer les préférences' })
      .click();
    await page
      .getByText('Préférences enregistrées.', { exact: true })
      .waitFor();
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.support-sidebar')?.scrollTo(0, 0);
      document.querySelectorAll('textarea').forEach((e) => (e.scrollTop = 0));
    });
    await page.screenshot({
      path: `${dir}/settings-${width}.png`,
      fullPage: true,
    });
    await page
      .getByText('Personnaliser les modèles de réponse', { exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Langue du modèle', exact: true })
      .click();
    await page.getByRole('option', { name: 'Deutsch', exact: true }).click();
    assert.match(
      await page
        .getByRole('textbox', { name: 'Texte du modèle', exact: true })
        .inputValue(),
      /Guten Tag/,
    );
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.support-sidebar')?.scrollTo(0, 0);
      document.querySelectorAll('textarea').forEach((e) => (e.scrollTop = 0));
    });
    await page.screenshot({
      path: `${dir}/templates-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('button',{name:'Enregistrer les préférences'}).click();
    await page.getByText('Préférences enregistrées.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Rétablir ce modèle'}).click();
    assert.equal(await page.getByText('Préférences enregistrées.',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Enregistrer les préférences'}).click();
    await page.getByText('Préférences enregistrées.',{exact:true}).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    report.push({
      width,
      errors,
      overflow: false,
      actions: 'ignore restore interest edit cancel STOP settings templates',
    });
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
