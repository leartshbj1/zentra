import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const out = fileURLToPath(new URL('../../.qa/quote-pair', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
let currentPage;
try {
  for (const width of [320, 390, 768, 1440]) {
    for (const legacy of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 500 });
      currentPage = page;
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(60000);
      page.on('dialog', dialog => dialog.accept());
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5187'}/tests/mobile-harness.html?quotePair=1${legacy ? '&legacyPair=1' : ''}`);
      await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
      const navigate = async (name) => {
        await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
        await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
        await page.locator('.navigation-palette').waitFor({ state: 'detached' });
      };
      const capture = async (stage) => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow ${width} ${stage}`);
        const modal = page.getByRole('dialog');
        if (await modal.isVisible()) assert.ok(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.querySelector('.modal__body').scrollWidth <= node.querySelector('.modal__body').clientWidth + 1), `dialog overflow ${width} ${stage}`);
        await page.screenshot({ path: `${out}/${width}-${legacy ? 'legacy' : 'new'}-${stage}.png` });
      };
      await navigate('Devis');
      if (legacy) {
        await page.getByRole('button', { name: /Voir le dossier · 1 facture/ }).click();
        await page.getByRole('button', { name: 'Créer la facture de solde', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Créer la facture', exact: true }).click();
        await page.getByRole('checkbox', { name: /Créer une facture d’acompte/ }).check();
        await page.getByRole('textbox', { name: 'Pourcentage de l’acompte', exact: true }).fill('101');
        assert.ok(await page.getByRole('button', { name: 'Créer les deux factures', exact: true }).isDisabled());
        await page.getByRole('textbox', { name: 'Pourcentage de l’acompte', exact: true }).fill('40');
        await capture('conversion');
        await page.getByRole('button', { name: 'Créer les deux factures', exact: true }).click();
      }
      await page.getByRole('heading', { name: 'Facture de solde', exact: true }).waitFor();
      assert.equal(await page.locator('.quote-invoice-folder__invoices article').count(), 2);
      for (const button of await page.locator('.quote-invoice-folder button').all()) assert.ok((await button.boundingBox()).height >= 44);
      assert.match(await page.locator('.quote-invoice-folder__invoices').innerText(), legacy ? /324.30/ : /432.40/);
      assert.match(await page.locator('.quote-invoice-folder__invoices').innerText(), legacy ? /756.70/ : /648.60/);
      assert.match(await page.locator('.quote-invoice-folder__totals').innerText(), /0.00/);
      await capture('folder');
      await page.getByRole('button', { name: 'Ouvrir le solde', exact: true }).click();
      assert.match(await page.locator('.quote-invoice-folder__lines').innerText(), /Déduction/);
      await page.getByLabel('Début de prestation', { exact: false }).fill('2026-09-01');
      await page.getByLabel('Fin de prestation', { exact: false }).fill('2026-09-30');
      await page.getByLabel('Notes', { exact: true }).fill('Conditions du solde\nDeuxième ligne conservée.');
      await capture('balance');
      await page.getByLabel('Fin de prestation', { exact: false }).fill('2026-08-31');
      await page.getByRole('button', { name: 'Enregistrer et voir le dossier', exact: true }).click();
      await page.getByText('La fin de la prestation doit être le même jour que son début ou après.', { exact: true }).waitFor();
      await page.getByLabel('Fin de prestation', { exact: false }).fill('2026-09-30');
      await page.evaluate(() => sessionStorage.setItem('qa-pair-refuse-update', '1'));
      await page.getByRole('button', { name: 'Enregistrer et voir le dossier', exact: true }).click();
      await page.getByText('Les dates n’ont pas pu être enregistrées. Réessayez.', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Notes', { exact: true }).inputValue(), 'Conditions du solde\nDeuxième ligne conservée.');
      await page.evaluate(() => { sessionStorage.removeItem('qa-pair-refuse-update'); sessionStorage.setItem('qa-pair-recover', 'update'); });
      await page.getByRole('button', { name: 'Enregistrer et voir le dossier', exact: true }).click();
      const recovery = page.getByRole('dialog', { name: 'Enregistrement effectué', exact: true });
      await recovery.waitFor();
      await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
      await recovery.getByText('Actualisation impossible', { exact: true }).waitFor();
      await page.evaluate(() => { sessionStorage.removeItem('qa-pair-block-reads'); sessionStorage.removeItem('qa-pair-recover'); });
      await recovery.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
      await recovery.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-pair-writes')).filter(kind => kind === 'update').length), 1);
      await page.getByRole('heading', { name: 'Facture de solde', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Ouvrir le solde', exact: true }).click();
      assert.equal(await page.getByLabel('Fin de prestation', { exact: false }).inputValue(), '2026-09-30');
      assert.equal(await page.getByLabel('Notes', { exact: true }).inputValue(), 'Conditions du solde\nDeuxième ligne conservée.');
      await page.getByRole('button', { name: 'Voir le dossier', exact: true }).click();
      await page.getByRole('button', { name: 'Ouvrir l’acompte', exact: true }).click();
      await page.getByLabel('Début de prestation', { exact: false }).fill('2026-09-01');
      await page.getByRole('button', { name: 'Enregistrer les dates', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await navigate('Factures');
      assert.equal(await page.locator('.sales-documents tbody tr').count(), 2);
      await page.locator('.sales-documents tbody tr').filter({ hasText: /Acompte .* %/ }).getByRole('button', { name: 'Émettre', exact: true }).click();
      await page.getByRole('dialog', { name: 'Émettre l’acompte', exact: true }).getByRole('button', { name: 'Confirmer et émettre l’acompte', exact: true }).click();
      await page.getByText('F-2026-0042', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Voir le dossier du devis', exact: true }).first().click();
      assert.match(await page.locator('.quote-invoice-folder__invoices').innerText(), /F-2026-0042/);
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await navigate('Projets');
      await page.getByRole('button', { name: 'Projet de facturation', exact: true }).click();
      await page.locator('.project-folder__section').filter({ has: page.getByRole('heading', { name: 'Dossiers de facturation', exact: true }) }).getByRole('button').click();
      await page.getByRole('heading', { name: 'Facture de solde', exact: true }).waitFor();
      assert.equal(await page.locator('.quote-invoice-folder__invoices article').count(), 2);
      assert.deepEqual(errors, []);
      await page.getByRole('button', { name: 'Ouvrir le solde', exact: true }).click();
      await page.evaluate(() => window.__qaSetReadOnly(true));
      await page.waitForFunction(() => document.querySelector('.paired-invoice-editor button[type=submit]')?.disabled);
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      report.push({ width, legacy, invoices: 2, conversion: true, datesSaved: true, depositIssued: true, projectFolder: true, noOverflow: true, errors });
      await page.close();
    }
  }
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: `${out}/failure.png` });
    await writeFile(`${out}/failure.txt`, await currentPage.locator('body').innerText());
  }
  throw error;
} finally { await browser.close(); }
