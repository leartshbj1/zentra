import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const isWebKit = process.env.ZENTRA_QA_BROWSER === 'webkit';
const browser = await (isWebKit ? webkit : chromium).launch({ headless: true, ...(!isWebKit && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const out = `.qa/read-only-actions-${isWebKit ? 'webkit' : 'edge'}`;
await mkdir(out, { recursive: true });
const report = [];
try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 900 });
    page.setDefaultTimeout(12000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&designQr=1&readOnlyAudit=1&readOnly=1`);
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (viewport.width > 860) await tour.click();
    const navigate = async name => {
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
      await page.locator('.navigation-palette').waitFor({ state: 'detached' });
    };
    const disabled = async name => {
      const buttons = page.getByRole('button', { name });
      assert.ok(await buttons.count(), `button missing: ${name}`);
      for (const button of await buttons.all()) assert.ok(await button.isDisabled(), `${viewport.width}: ${name} must be disabled`);
    };
    const capture = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${viewport.width} ${name}: overflow`);
      await page.screenshot({ path: `${out}/${viewport.width}-${name}.png` });
    };
    await navigate('Projets');
    await disabled(/^Modifier$/); await disabled(/^Supprimer le projet/);
    await page.getByRole('button', { name: 'Ouvrir le dossier', exact: true }).first().click();
    await page.locator('.project-folder').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Ajouter des documents', exact: true }).count(), 0);
    await disabled(/^Nouveau devis$/); await disabled(/^Nouvelle facture$/);
    await capture('project-folder');
    await navigate('Clients');
    await disabled(/^Modifier /); await disabled(/^Archiver /);
    await page.getByRole('button', { name: 'Dossier', exact: true }).first().click();
    await disabled(/Modifier/);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.getByRole('button', { name: /^Archivés/ }).click(); await disabled(/^Réactiver$/);
    await navigate('Produits & services');
    for (const name of [/^Nouvelle référence$/, /^Importer Excel$/, /^Modifier Produit/, /^Archiver Produit/, /^Entrée$/, /^Sortie$/, /^Correction$/]) await disabled(name);
    await page.getByRole('button', { name: /Historique/ }).click();
    await capture('catalogue');
    await page.locator('.catalog-filters select').last().selectOption('archived');
    await disabled(/^Réactiver Produit/);
    await navigate('Temps');
    for (const name of [/^Facturer les heures/, /^Démarrer$/, /Modifier/, /Supprimer|Archiver/]) await disabled(name);
    await navigate('Équipe & salaires');
    for (const name of [/^Nouveau collaborateur$/, /^Modifier/, /Désactiver|Supprimer/]) await disabled(name);
    await navigate('Devis');
    for (const name of [/^Modifier le devis/, /^Créer une version modifiable/, /^Émettre le devis/, /^Supprimer le brouillon/, /^Marquer le devis/, /^Créer la facture$/, /^Planifier$/, /^Annuler l.acceptation$/]) await disabled(name);
    await page.getByRole('button', { name: /Aperçu du devis Aménagement/ }).click();
    await page.locator('.document-preview').waitFor();
    await page.locator('.document-preview').getByRole('button', { name: 'Exporter le PDF', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('design-export') || '{}').entity === 'quotes');
    await capture('quote-preview');
    await page.keyboard.press('Escape');
    await navigate('Factures');
    for (const name of [/^Modifier$/, /^Archiver .*coffre Zentra$/]) await disabled(name);
    await page.getByRole('button', { name: 'Aperçu de F-DEMO-2026-0042', exact: true }).click();
    await page.getByRole('button', { name: 'Ouvrir l’aperçu figé', exact: true }).click();
    await page.locator('.document-preview').waitFor(); await capture('invoice-preview');
    await page.locator('.document-preview').getByRole('button', { name: 'Exporter le PDF', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('design-export') || '{}').entity === 'invoices');
    await page.keyboard.press('Escape');
    // Revocation while a populated form is open preserves the typed draft and
    // prevents submit. Restoring write access saves exactly once.
    await page.evaluate(() => window.__qaSetReadOnly(false));
    await navigate('Clients');
    await page.getByRole('button', { name: /^Actifs/ }).click();
    await page.getByRole('button', { name: 'Modifier Résidence Bellevue', exact: true }).click();
    await page.getByRole('dialog').locator('input[name=company]').fill('Client modifié de recette');
    for (const [name, value] of [['street', 'Rue de recette'], ['postalCode', '1000'], ['city', 'Lausanne'], ['country', 'CH']]) await page.getByRole('dialog').locator(`input[name=${name}]`).fill(value);
    assert.ok(await page.getByRole('dialog').locator('form').evaluate(form => form.checkValidity()));
    await page.evaluate(() => window.__qaSetReadOnly(true));
    await page.getByText('Mode lecture seule : les modifications ne peuvent pas être enregistrées.', { exact: true }).waitFor();
    await disabled(/^Enregistrer$/);
    await capture('revoked-form');
    await page.getByRole('dialog').locator('form').evaluate(form => form.requestSubmit());
    await page.locator('.notice--error').waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('readonly-mutation-calls') || '[]')), []);
    assert.equal(await page.getByRole('dialog').locator('input[name=company]').inputValue(), 'Client modifié de recette');
    assert.ok(await page.getByRole('button', { name: 'Annuler', exact: true }).isEnabled());
    await page.evaluate(() => window.__qaSetReadOnly(false));
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal((await page.evaluate(() => JSON.parse(sessionStorage.getItem('readonly-mutation-calls') || '[]'))).length, 1);
    await page.getByRole('button', { name: 'Modifier Client modifié de recette', exact: true }).waitFor();
    for (const [screen, editor] of [['Agenda', 'Ajouter'], ['Projets', 'Nouvelle tâche'], ['Projets', 'Nouveau jalon']]) {
      await navigate(screen);
      if (screen === 'Projets') await page.getByRole('button', { name: 'Tâches & jalons', exact: true }).click();
      await page.getByRole('button', { name: editor, exact: true }).click();
      const input = page.getByRole('dialog').getByRole('textbox').first();
      await input.fill('Saisie conservée');
      await page.evaluate(() => window.__qaSetReadOnly(true));
      await page.getByText('Mode lecture seule : les modifications ne peuvent pas être enregistrées.', { exact: true }).waitFor();
      await disabled(/^Enregistrer$/);
      assert.equal(await input.inputValue(), 'Saisie conservée');
      assert.ok(await page.getByRole('button', { name: 'Annuler', exact: true }).isEnabled());
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      await page.evaluate(() => window.__qaSetReadOnly(false));
    }
    assert.deepEqual(errors, []);
    report.push({ viewport, passed: true, errors }); await page.close();
  }
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const page = browser.contexts().flatMap(context => context.pages()).at(-1);
  if (page) {
    await page.screenshot({ path: `${out}/failure.png` });
    await writeFile(`${out}/failure-buttons.json`, JSON.stringify(await page.getByRole('button').evaluateAll(buttons => buttons.map(button => ({ name: button.getAttribute('aria-label') || button.textContent || button.title, title: button.title, disabled: button.disabled }))), null, 2));
  }
  throw error;
} finally { await browser.close(); }
