import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const { [engine]: driver } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const folder = '.qa/document-tools';
await mkdir(folder, { recursive: true });
const report = [];
try {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 1000]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/native-design-fixture/*.pdf', async route => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1);
      assert.match(file, /^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
      await route.fulfill({ contentType: 'application/pdf', body: await readFile(`.qa/composition-pdfs/${file}`) });
    });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html?tools=1`);
    const ready = () => page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({ state: 'attached', timeout: 30_000 });
    const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('design-draft')));
    const text = value => value.map(p => p.runs.map(r => r.text).join('')).join('\n');
    const history = page.getByRole('group', { name: 'Historique de la présentation' });
    await ready();
    await page.evaluate(async () => {
      const { normalizeComposition } = await import('/src/documentComposition.ts');
      const documentComposition = Object.fromEntries(['invoices', 'quotes', 'accounts', 'payslips'].map(kind => [kind, normalizeComposition({
        fontFamily: kind === 'invoices' ? 'times' : 'helvetica', logoPosition: kind === 'invoices' ? 'right' : 'left',
        intro: [{ runs: [{ text: `Introduction ${kind}` }] }],
        closing: [{ align: 'center', runs: [{ text: 'Délai', bold: true, color: '#793c32', fontFamily: 'times', fontSize: 18 }, { text: ' de paiement ; délai ; DÉLAI.', italic: true }] }],
        footerText: [{ runs: [{ text: `Contact ${kind}` }] }],
      })]));
      window.dispatchEvent(new CustomEvent('design-fixture-update', { detail: { settings: { documentComposition } } }));
    });
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('design-draft') || '{}').documentComposition?.invoices);
    for (const [kind, label] of [['invoices', 'Factures'], ['quotes', 'Devis'], ['accounts', 'Bilan'], ['payslips', 'Fiches de salaire']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('navigation', { name: 'Éléments du document' }).getByRole('button', { name: kind === 'accounts' ? /^Commentaire / : /^Conditions / }).click();
      const editor = page.getByRole('textbox', { name: kind === 'accounts' ? 'Commentaire après les comptes' : 'Conditions et message de fin', exact: true });
      await page.getByRole('button', { name: 'Rechercher et remplacer', exact: true }).click();
      const search = page.getByRole('group', { name: 'Rechercher et remplacer dans cette zone' });
      await search.getByLabel('Rechercher un texte', { exact: true }).fill('délai');
      await search.getByText('Résultat 1 sur 3', { exact: true }).waitFor();
      await search.getByLabel('Respecter les majuscules et minuscules').check();
      await search.getByText('Résultat 1 sur 1', { exact: true }).waitFor();
      await search.getByLabel('Respecter les majuscules et minuscules').uncheck();
      await search.getByRole('button', { name: 'Sélectionner le résultat dans le texte' }).click();
      assert.equal(await page.evaluate(() => getSelection().toString()), 'Délai');
      await search.getByRole('button', { name: 'Résultat suivant', exact: true }).click();
      assert.equal(await page.evaluate(() => getSelection().toString()), 'délai');
      await editor.press('Control+f');
      assert.equal(await page.getByLabel('Rechercher un texte', { exact: true }).inputValue(), 'délai');
      await search.getByRole('button', { name: 'Résultat suivant', exact: true }).click();
      await search.getByLabel('Remplacer par', { exact: true }).fill('Conditions');
      await search.getByRole('button', { name: 'Remplacer ce résultat', exact: true }).click();
      assert.equal(text((await state()).documentComposition[kind].closing), 'Délai de paiement ; Conditions ; DÉLAI.');
      await page.getByRole('button', { name: 'Annuler la modification du texte', exact: true }).click();
      assert.equal(text((await state()).documentComposition[kind].closing), 'Délai de paiement ; délai ; DÉLAI.');
      await search.getByRole('button', { name: 'Tout remplacer (3)', exact: true }).click();
      const result = (await state()).documentComposition[kind];
      assert.equal(text(result.closing), 'Conditions de paiement ; Conditions ; Conditions.');
      assert.equal(result.closing[0].runs[0].fontSize, 18); assert.equal(result.closing[0].runs[0].bold, true);
      assert.equal(result.closing[0].align, 'center'); assert.equal(text(result.intro), `Introduction ${kind}`);
      await search.getByText('Aucun résultat dans cette zone.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Annuler la modification du texte', exact: true }).click();
      assert.equal(text((await state()).documentComposition[kind].closing), 'Délai de paiement ; délai ; DÉLAI.');
      await history.getByRole('button', { name: 'Annuler', exact: true }).click();
      assert.equal(text((await state()).documentComposition[kind].closing), 'Conditions de paiement ; Conditions ; Conditions.');
      assert.equal(await page.getByRole('button', { name: 'Rétablir la modification du texte', exact: true }).isDisabled(), true);
      await search.getByLabel('Rechercher un texte', { exact: true }).fill('Conditions');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('design-fixture-update', { detail: { busy: true } })));
      await page.waitForFunction(() => document.querySelector('.rich-editor__surface').getAttribute('aria-disabled') === 'true');
      assert.equal(await search.getByRole('button', { name: 'Tout remplacer (3)', exact: true }).isDisabled(), true);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('design-fixture-update', { detail: { busy: false } })));
      await search.getByRole('button', { name: 'Fermer la recherche', exact: true }).click();
      await editor.press('Control+f');
      await page.getByLabel('Rechercher un texte', { exact: true }).waitFor();
      await page.getByLabel('Rechercher un texte', { exact: true }).press('Escape');
      assert.equal(await search.count(), 0);
    }
    // Footer limit: replacement is atomic and recoverable.
    await page.getByRole('navigation', { name: 'Éléments du document' }).getByRole('button', { name: /^Pied de page / }).click();
    const footer = page.getByRole('textbox', { name: 'Pied de page mis en forme', exact: true });
    await footer.fill('aa');
    await page.getByRole('button', { name: 'Rechercher et remplacer', exact: true }).click();
    await page.getByLabel('Rechercher un texte', { exact: true }).fill('a');
    await page.getByLabel('Remplacer par', { exact: true }).fill('b'.repeat(100));
    await page.getByRole('button', { name: 'Tout remplacer (2)', exact: true }).click();
    await page.getByText(/180 caractères au maximum/).waitFor();
    assert.equal(text((await state()).documentComposition.payslips.footerText), 'aa');
    await page.getByLabel('Remplacer par', { exact: true }).fill('Merci');
    await page.getByRole('button', { name: 'Tout remplacer (2)', exact: true }).click();
    assert.equal(text((await state()).documentComposition.payslips.footerText), 'MerciMerci');
    await page.screenshot({ path: `${folder}/${engine}-${width}-search.png`, fullPage: true });
    // Reuse keeps each category's own text until the explicit checkbox is selected.
    await page.getByRole('button', { name: 'Factures', exact: true }).click();
    await page.getByText('Réutiliser cette présentation', { exact: true }).click();
    await page.getByLabel('Copier vers', { exact: true }).selectOption('accounts');
    assert.equal(await page.getByLabel('Copier aussi les textes', { exact: true }).isChecked(), false);
    const accountBefore = (await state()).documentComposition.accounts;
    await page.getByRole('button', { name: 'Copier la présentation', exact: true }).click();
    assert.deepEqual((await state()).documentComposition.accounts.intro, accountBefore.intro);
    assert.equal((await state()).documentComposition.accounts.fontFamily, 'times');
    await page.getByLabel('Copier aussi les textes', { exact: true }).check();
    await page.getByRole('button', { name: 'Copier la présentation', exact: true }).click();
    assert.equal(text((await state()).documentComposition.accounts.intro), 'Introduction invoices');
    await history.getByRole('button', { name: 'Annuler', exact: true }).click();
    assert.equal(text((await state()).documentComposition.accounts.intro), 'Introduction accounts');
    // Reinitialization keeps texts; company data updated elsewhere survives history.
    await page.getByText('Revenir au style de départ', { exact: true }).click();
    await page.getByRole('button', { name: 'Réinitialiser factures', exact: true }).click();
    assert.equal(text((await state()).documentComposition.invoices.intro), 'Introduction invoices');
    assert.equal((await state()).documentComposition.invoices.fontFamily, 'helvetica');
    await page.evaluate(() => {
      const settings = JSON.parse(sessionStorage.getItem('design-draft'));
      window.dispatchEvent(new CustomEvent('design-fixture-update', { detail: { settings: { organization: { ...settings.organization, legalName: 'Entreprise actualisée' } } } }));
    });
    await history.getByRole('button', { name: 'Annuler', exact: true }).click();
    assert.equal((await state()).organization.legalName, 'Entreprise actualisée');
    assert.equal((await state()).documentComposition.invoices.fontFamily, 'times');
    await page.getByLabel('Effacer aussi les textes modèles', { exact: true }).check();
    await page.getByRole('button', { name: 'Réinitialiser factures', exact: true }).click();
    assert.equal((await state()).documentComposition.invoices, undefined);
    await history.getByRole('button', { name: 'Annuler', exact: true }).click();
    assert.equal(text((await state()).documentComposition.invoices.intro), 'Introduction invoices');
    await ready();
    await page.getByRole('button', { name: 'Enregistrer les présentations', exact: true }).click();
    const saved = await state(); await page.reload(); await ready();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('design-settings'))), saved);
    for (const [kind, label] of [['invoices', 'Factures'], ['quotes', 'Devis'], ['accounts', 'Bilan'], ['payslips', 'Fiches de salaire']]) {
      await page.getByRole('button', { name: label, exact: true }).click(); await ready();
      await page.getByRole('button', { name: 'Exporter cet exemple', exact: true }).click();
      const exported = await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-export')));
      assert.equal(exported.kind, kind); assert.deepEqual(exported.style.composition, saved.documentComposition[kind]);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    report.push({ width, height, allFourKinds: true, searchSelection: true, singleAndAllReplace: true, styleKept: true, scopedSearch: true, undoIsolation: true, writeLock: true, footerLimitRecovery: true, copyTextChoice: true, resetRecovery: true, companyUpdateKept: true, saveReload: true, exportContract: true, noOverflow: true });
    await page.close();
  }
} finally { await writeFile(`${folder}/${engine}-report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
console.log(JSON.stringify({ engine, report }));
