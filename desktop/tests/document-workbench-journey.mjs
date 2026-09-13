import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const { [engine]: driver } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const out = `.qa/document-workbench-${engine}`;
await mkdir(out, { recursive: true });
const report = [];
try {
  for (const [width, height] of [[320,568], [390,844], [844,390], [1440,1000]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/native-design-fixture/*.pdf', async route => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1);
      assert.match(file, /^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
      await route.fulfill({ contentType: 'application/pdf', body: await readFile(`.qa/composition-pdfs/${file}`) });
    });
    try {
      await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html?tools=1&validation=1`);
      const ready = () => page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({ state: 'attached', timeout: 30000 });
      const draft = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('design-draft')));
      const search = page.getByRole('searchbox', { name: 'Trouvez votre outil' });
      const choose = async (query, label) => { await search.fill(query); await page.locator('.design-navigator__results').getByRole('button', { name: new RegExp('^' + label) }).click(); };
      await ready();
      await choose('police', 'Police du document');
      await page.getByLabel('Police du document', { exact:true }).selectOption('times');
      await ready();
      await choose('conditions', 'Mettre en forme les conditions');
      const editor = page.getByRole('textbox', { name: 'Conditions et message de fin', exact:true });
      await editor.fill('Paiement sous 30 jours.\nMerci pour votre confiance.');
      const select = async (start, end) => editor.evaluate(async (el, range) => { (await import('/src/RichTextEditor.tsx')).selectRichTextRange(el, range); }, { start, end });
      await select(0, 22);
      await page.getByRole('button', { name: 'Gras', exact:true }).click();
      const before = (await draft()).documentComposition.invoices;
      assert.ok(before.closing[0].runs[0].bold);
      const node = await editor.elementHandle();
      await page.getByRole('button', { name: 'Ouvrir le grand atelier', exact:true }).click();
      const modal = page.getByRole('dialog', { name: 'Atelier de personnalisation des documents' });
      await modal.waitFor();
      assert.equal(await node.evaluate(el => el.isConnected && !!el.closest('dialog[open]')), true);
      assert.deepEqual((await draft()).documentComposition.invoices, before);
      assert.equal(await page.getByRole('button', { name:'Liste à puces', exact:true }).isVisible(), false);
      await page.getByRole('button', { name:'Plus d’outils : listes, styles, recherche…', exact:true }).click();
      assert.ok(await page.getByRole('button', { name:'Liste à puces', exact:true }).isVisible());
      await page.getByRole('button', { name:'Revenir aux outils essentiels', exact:true }).click();
      await editor.press('Control+f');
      assert.ok(await page.getByRole('button', { name:'Rechercher et remplacer', exact:true }).isVisible());
      await page.getByRole('button', { name:'Revenir aux outils essentiels', exact:true }).click();
      await page.getByRole('button', { name: 'Annuler la modification du texte', exact:true }).click();
      assert.equal((await draft()).documentComposition.invoices.closing[0].runs[0].bold, false);
      await page.getByRole('button', { name: 'Rétablir la modification du texte', exact:true }).click();
      assert.deepEqual((await draft()).documentComposition.invoices, before);
      await search.fill('logo'); await search.press('Escape');
      assert.equal(await search.inputValue(), ''); assert.ok(await modal.isVisible());
      await choose('espace sous logo', 'Espace sous le logo');
      const gap = page.getByLabel('Espace sous le logo', { exact:true });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Espace sous le logo');
      assert.equal(await gap.evaluate(el => document.activeElement === el && el.closest('details').open), true);
      await gap.selectOption('24');
      await choose('deplacer logo', 'Déplacer le logo');
      await page.getByLabel('Position du logo', { exact:true }).selectOption('right');
      await choose('totaux', 'Position des totaux');
      await page.getByLabel('Position des totaux', { exact:true }).selectOption('beforeNotes');
      // Every search result must open a real, visible control, including nested advanced sections.
      const tools = await page.evaluate(async () => (await import('/src/documentDesignTools.ts')).documentDesignTools);
      for (const tool of tools) {
        await choose(tool.label, tool.label);
        await page.waitForFunction(selector => { const el = document.querySelector('.design-studio__tools')?.querySelector(selector); return el && !!el.getClientRects().length && document.activeElement === el; }, tool.selector);
        assert.equal(await page.locator('.design-studio__tools').locator(tool.selector).first().evaluate(el => !!el.getClientRects().length && document.activeElement === el), true, tool.id);
      }
      await page.getByRole('button', { name: 'Bilan', exact:true }).click();
      await search.fill('position totaux'); await page.getByText('Aucun outil trouvé.', { exact:false }).waitFor();
      await choose('commentaire', 'Mettre en forme le commentaire');
      await page.getByRole('textbox', { name: 'Commentaire après les comptes', exact:true }).fill('Commentaires sur les comptes annuels.');
      await page.getByRole('button', { name: 'Factures', exact:true }).click();
      await choose('conditions', 'Mettre en forme les conditions');
      assert.equal(await node.evaluate(el => el.isConnected), false); // Kind change intentionally starts another text editor.
      await page.getByRole('button', { name: 'Agrandir l’espace d’écriture', exact:true }).click();
      await ready();
      await editor.scrollIntoViewIfNeeded();
      if (width > 900) {
        const box = await page.locator('.design-studio__tools').boundingBox();
        assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 2, 'Writing area should be centered');
      }
      await page.screenshot({ path: `${out}/${width}-writing.png` });
      await page.getByRole('button', { name: 'Revenir aux paramètres', exact:true }).click();
      await modal.waitFor({ state:'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.includes('Ouvrir le grand atelier')), true);
      // The rich editor and its changes stay mounted while switching workspaces.
      const restored = await editor.elementHandle();
      await page.getByRole('button', { name: 'Ouvrir le grand atelier', exact:true }).click();
      assert.equal(await restored.evaluate(el => el.isConnected && !!el.closest('dialog[open]')), true);
      await page.evaluate(() => sessionStorage.setItem('design-save-fail', '1'));
      await ready(); await editor.press('Control+s');
      await page.getByText('Enregistrement momentanément indisponible.', { exact:false }).waitFor();
      assert.ok((await draft()).documentComposition.invoices.closing[0].runs[0].bold);
      await page.evaluate(() => { sessionStorage.removeItem('design-save-fail'); sessionStorage.setItem('design-check-hold', '1'); });
      await editor.press('Control+s');
      await page.getByText('Vérification des quatre présentations…', { exact:true }).waitFor();
      assert.ok(await page.getByRole('button', { name: 'Revenir aux paramètres', exact:true }).isDisabled());
      await page.keyboard.press('Escape'); assert.ok(await modal.isVisible());
      await page.evaluate(() => { sessionStorage.removeItem('design-check-hold'); window.dispatchEvent(new Event('design-check-release')); });
      await page.getByText('Les présentations sont enregistrées.', { exact:true }).waitFor();
      await page.getByRole('button', { name: 'Voir le rendu PDF', exact:true }).click(); await ready();
      await page.screenshot({ path: `${out}/${width}-preview.png` });
      await page.getByRole('button', { name: 'Revenir aux réglages', exact:true }).click();
      for (const label of ['Factures','Devis','Bilan','Fiches de salaire']) {
        await page.getByRole('button', { name: label, exact:true }).click(); await ready();
        await page.getByRole('button', { name: 'Exporter cet exemple', exact:true }).click();
        const output = await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-export')));
        if (label === 'Factures') { assert.equal(output.style.composition.logoPosition, 'right'); assert.ok(output.style.composition.closing[0].runs[0].bold); }
      }
      await search.fill('zzzz'); await search.press('Escape'); await search.press('Escape');
      await modal.waitFor({ state:'hidden' });
      await page.reload(); await ready();
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('design-settings')));
      assert.equal(saved.documentComposition.invoices.fontFamily, 'times');
      assert.equal(saved.documentComposition.invoices.logoPosition, 'right');
      assert.equal(saved.documentComposition.invoices.logoGap, 24);
      assert.ok(saved.documentComposition.invoices.closing[0].runs[0].bold);
      await page.getByRole('button', { name:'Ouvrir le grand atelier', exact:true }).click();
      await choose('logo', 'Déplacer le logo');
      await page.getByRole('button', { name:'Importer ou changer mon logo', exact:true }).click();
      await modal.waitFor({ state:'hidden' });
      await page.waitForFunction(() => sessionStorage.getItem('design-company-target') === 'logo');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      report.push({ width, height, preservedEditorAndUndo:true, toolNavigation:tools.length, nestedToolsFocus:true, balanceSheetTools:true, saveRecovery:true, saveShortcut:true, allCategoryExports:true, saveReload:true, noOverflow:true });
    } catch (error) { await page.screenshot({ path:`${out}/${width}-failure.png` }); throw error; }
    finally { await page.close(); }
  }
} catch (error) { report.push({ error:String(error.stack || error) }); process.exitCode=1; }
finally { await writeFile(`${out}/report.json`, JSON.stringify(report,null,2)); await browser.close(); }
console.log(JSON.stringify({ engine, report }));
