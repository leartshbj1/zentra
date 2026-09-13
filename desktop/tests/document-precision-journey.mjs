import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const folder = `.qa/document-precision-${engine}`;
await mkdir(folder, { recursive: true });
const report = [];
try {
  for (const [width, height] of [[320,568],[390,844],[844,390],[1440,1000]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/native-design-fixture/*.pdf', async route => {
      const kind = new URL(route.request().url()).pathname.split('/').at(-1).split('-')[0];
      assert.ok(['quotes','invoices','accounts','payslips'].includes(kind));
      await route.fulfill({ contentType: 'application/pdf', body: await readFile(`.qa/precision-pdfs/${kind}-precision.pdf`) });
    });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html?tools=1`);
    const ready = () => page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({ state: 'attached', timeout: 30000 });
    const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('design-draft') || '{}'));
    const history = page.getByRole('group', { name: 'Historique de la présentation' });
    const switcher = page.getByRole('group', { name: 'Affichage de l’atelier' });
    const precision = label => page.getByRole('slider', { name: `Réglage précis : ${label}`, exact: true });
    const slide = async (label, value) => precision(label).evaluate((input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    const expand = async text => {
      const summary = page.getByText(text, { exact: true });
      if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
    };
    await ready();
    for (const [kind, label] of [['invoices','Factures'],['quotes','Devis'],['accounts','Bilan'],['payslips','Fiches de salaire']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('button', { name: 'Style', exact: true }).click();
      await expand('Réglage précis de la typographie');
      await slide('Taille du texte', 9.5); await slide('Taille du titre', 27);
      assert.equal(await page.getByLabel('Taille du texte', { exact: true }).inputValue(), '9.5');
      assert.equal(await page.getByLabel('Taille du titre', { exact: true }).inputValue(), '27');
      await precision('Taille du titre').press('ArrowRight');
      assert.equal((await state()).documentComposition[kind].titleSize, 28);
      await page.getByRole('button', { name: 'Réduire : Taille du titre', exact: true }).click();
      assert.equal((await state()).documentComposition[kind].titleSize, 27);
      await page.getByRole('button', { name: 'Mise en page', exact: true }).click();
      await expand('Réglage précis de la page');
      for (const [label, value] of [['Marges',17.5],['Interligne',1.4],['Hauteur maximale du logo',43],['Espace dans les lignes',7.5],['Début du contenu',22.5],['Espace sous le logo',17],['Espace entre les blocs',1.15]]) await slide(label,value);
      await history.getByRole('button', { name: 'Annuler', exact: true }).click();
      assert.equal((await state()).documentComposition[kind].blockSpacing, undefined);
      await history.getByRole('button', { name: 'Rétablir', exact: true }).click();
      assert.equal((await state()).documentComposition[kind].blockSpacing, 1.15);
      assert.equal(await page.getByLabel('Marges', { exact: true }).inputValue(), '17.5');
      await slide('Marges', 25);
      assert.equal(await page.getByRole('button', { name: 'Augmenter : Marges', exact: true }).isDisabled(), true);
      await slide('Marges',17.5);
      if (kind === 'invoices') {
        await precision('Marges').scrollIntoViewIfNeeded();
        const box = await precision('Marges').boundingBox();
        await page.mouse.move(box.x + box.width * .42, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2, { steps: 12 });
        await page.mouse.up();
        const moved = (await state()).documentComposition[kind].marginMm;
        assert.notEqual(moved,17.5);
        await history.getByRole('button', { name: 'Annuler', exact: true }).click();
        assert.equal((await state()).documentComposition[kind].marginMm,17.5,'one drag is one undo');
      }
      await page.getByRole('button', { name: 'Suivre les marges', exact: true }).click();
      assert.equal((await state()).documentComposition[kind].topMarginMm, undefined);
      assert.equal(await precision('Début du contenu').inputValue(),'17.5');
      await slide('Début du contenu',22.5);
      await page.getByLabel('Position du logo', { exact: true }).selectOption('right');
      const held = JSON.stringify((await state()).documentComposition[kind]);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('design-fixture-update', { detail: { busy: true } })));
      await page.waitForFunction(() => document.querySelector('[aria-label="Réglage précis : Marges"]').matches(':disabled'));
      assert.equal(await precision('Marges').isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Augmenter : Marges', exact: true }).isDisabled(), true);
      assert.equal(JSON.stringify((await state()).documentComposition[kind]),held);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('design-fixture-update', { detail: { busy: false } })));
      await page.waitForFunction(() => !document.querySelector('[aria-label="Réglage précis : Marges"]').matches(':disabled'));
      if (kind === 'invoices') {
        await page.getByText('Réglage précis de la page', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${folder}/${width}-controls.png` });
      }
      await page.getByRole('button', { name: 'Textes', exact: true }).click();
      const editor = page.getByRole('textbox', { name: kind === 'accounts' ? 'Commentaire après les comptes' : 'Conditions et message de fin', exact: true });
      await editor.fill('Votre texte reste présent.');
      await editor.press('Control+a'); await editor.press('Control+b');
      const before = (await state()).documentComposition[kind];
      await ready();
      if (width <= 900) {
        await switcher.getByRole('button', { name: 'Mon document', exact: true }).click();
        assert.equal(await page.locator('.design-studio__tools').isVisible(), false);
        assert.equal(await page.locator('.design-studio__preview').isVisible(), true);
        if (kind === 'invoices') await page.screenshot({ path: `${folder}/${width}-preview.png` });
        await switcher.getByRole('button', { name: 'Mes réglages', exact: true }).click();
        assert.equal(await editor.innerText(),'Votre texte reste présent.');
      }
      assert.deepEqual((await state()).documentComposition[kind],before);
      assert.ok(before.closing[0].runs[0].bold);
      await page.getByRole('button', { name: 'Exporter cet exemple', exact: true }).click();
      assert.deepEqual((await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-export')))).style.composition,before);
      assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('design-save-count') || 0)),0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    await ready();
    if (width <= 900) {
      await switcher.getByRole('button', { name: 'Mon document', exact: true }).click();
      await switcher.getByRole('button', { name: 'Enregistrer mes présentations', exact: true }).click();
    } else await history.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await page.getByText('Présentations enregistrées.', { exact: true }).waitFor();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('design-settings')));
    assert.equal(await page.getByText('Les présentations sont enregistrées.', { exact: true }).isVisible(), true);
    await page.reload(); await ready();
    const request = await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-request')));
    assert.deepEqual(request.style.composition, saved.documentComposition.invoices);
    await page.getByRole('button', { name: 'Textes', exact: true }).click();
    await page.getByText('Pied de page simple', { exact: true }).click();
    await page.getByLabel('Une phrase en pied de page', { exact: true }).fill('Erreur de recette');
    await page.getByRole('alert').getByText('Exemple momentanément indisponible.', { exact: true }).waitFor();
    await page.getByLabel('Une phrase en pied de page', { exact: true }).fill('Merci.'); await ready();
    if (width <= 900) {
      await switcher.getByRole('button', { name: 'Mon document', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.equal(await page.locator('.design-studio__tools').isVisible(), true);
      assert.equal(await page.locator('.design-studio__preview').isVisible(), true);
    }
    assert.deepEqual(errors, []);
    report.push({ width, height, categories: 4, engine, passed: true });
    await page.close();
  }
} catch(error) { report.push({ error: String(error.stack || error) }); process.exitCode = 1; }
finally { await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); }
