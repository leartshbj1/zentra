import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Exercises the real settings/editor; native writes and PDF responses are isolated fixtures. */
export async function checkDocumentEditor({ page, width, language, tools, output, caseId }) {
  const keys = ['Créer ce modèle','Donnez un nom à ce modèle, par exemple « Devis classique ».','Nom du modèle','Appliquer {target}','aux factures','Plus d’outils : listes, styles, recherche…','Rechercher et remplacer','Rechercher un texte','Remplacer par','Tout remplacer','Fermer la recherche','Gras','Réduire : {label}','Augmenter : {label}','Taille du texte','Corriger ce passage','Les présentations sont enregistrées.','Message technique','Ouvrir le grand atelier','Factures','Devis','Bilan','Fiches de salaire','Trouvez votre outil'];
  const copy = await page.evaluate(async keys => { const { t } = await import('/src/language.ts'); return Object.fromEntries(keys.map(key => [key, t(key, key === 'Appliquer {target}' ? { target: t('aux factures') } : key.includes('{label}') ? { label: t('Taille du texte') } : undefined)])); }, keys);
  await page.getByRole('button', { name: copy['Ouvrir le grand atelier'], exact: true }).filter({ visible: true }).click();
  const search = page.getByRole('searchbox', { name: copy['Trouvez votre outil'], exact: true });
  const choose = async id => {
    const label = tools.find(tool => tool.id === id).translated;
    await search.fill(label);
    await page.locator('.design-navigator__results button').filter({ has: page.getByText(label, { exact: true }) }).click();
  };
  const ready = () => page.locator('.design-studio__preview[aria-busy=false] img').first().waitFor({ state: 'attached' });
  await choose('font');
  await page.locator('[data-design-control="Police du document"]').selectOption('inter');
  const library = page.locator('.document-template-library');
  await library.locator('summary').click();
  await library.getByRole('button', { name: copy['Créer ce modèle'], exact: true }).click();
  assert.equal(await library.getByRole('alert').innerText(), copy['Donnez un nom à ce modèle, par exemple « Devis classique ».']);
  await library.getByLabel(copy['Nom du modèle'], { exact: true }).fill('Factures / Kunden 42');
  await library.getByRole('button', { name: copy['Créer ce modèle'], exact: true }).click();
  assert.equal(await library.locator('.document-template-library__card strong').innerText(), 'Factures / Kunden 42');
  assert.match(await library.locator('.document-template-library__card').innerText(), /Inter/);
  await page.locator('[data-design-control="Police du document"]').selectOption('times');
  await library.getByRole('button', { name: copy['Appliquer {target}'], exact: true }).click();
  assert.equal(await page.locator('[data-design-control="Police du document"]').inputValue(), 'inter');
  // Precisely change a native numeric property; labels do not become stored values.
  await page.locator('.design-studio__panel:not([hidden]) .design-studio__precision summary').click();
  const size = page.locator('[data-design-control="Taille du texte"]');
  const beforeSize = Number(await size.inputValue());
  await page.getByRole('button', { name: copy['Augmenter : {label}'], exact: true }).click();
  assert.equal(Number(await size.inputValue()), beforeSize + 0.5);
  await page.getByRole('button', { name: copy['Réduire : {label}'], exact: true }).click();
  assert.equal(Number(await size.inputValue()), beforeSize);
  await choose('closing');
  const editor = page.locator('.rich-editor__surface');
  await editor.fill('Factures CHF 500. Factures CHF 500.');
  await editor.evaluate(async element => (await import('/src/RichTextEditor.tsx')).selectRichTextRange(element, { start: 0, end: 8 }));
  await page.getByRole('button', { name: copy.Gras, exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: copy['Plus d’outils : listes, styles, recherche…'], exact: true }).click();
  await page.getByRole('button', { name: copy['Rechercher et remplacer'], exact: true }).click();
  await page.getByLabel(copy['Rechercher un texte'], { exact: true }).fill('Factures');
  await page.getByLabel(copy['Remplacer par'], { exact: true }).fill('Devis');
  await page.locator('.rich-search__actions button').nth(1).click();
  assert.equal(await editor.innerText(), 'Devis CHF 500. Devis CHF 500.');
  await page.getByRole('button', { name: copy['Fermer la recherche'], exact: true }).click();
  const save = page.locator('.design-studio__commandbar .design-studio__save-shortcut');
  await editor.fill('Merci 🧾'); await ready();
  const beforeSaves = await page.evaluate(() => window.__documentEditorQa.saved.length);
  await save.click();
  const problems = page.locator('.design-studio__problems');
  await problems.waitFor();
  assert.equal(await page.evaluate(() => window.__documentEditorQa.saved.length), beforeSaves);
  assert.equal(await editor.innerText(), 'Merci 🧾');
  assert.match(await problems.innerText(), /🧾/);
  await problems.getByRole('button', { name: copy['Corriger ce passage'], exact: true }).first().click();
  await page.waitForFunction(() => window.getSelection().toString() === '🧾');
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '🧾');
  await editor.fill('Merci. CHF 500 reste CHF 500.'); await ready();
  await page.evaluate(() => window.__documentEditorQa.failure = 'Le pied de page prend trop de place.');
  await save.click(); await problems.waitFor();
  if (language !== 'fr') {
    const details = problems.locator('details');
    assert.equal(await details.locator('summary').innerText(), copy['Message technique']);
    assert.equal(await details.getAttribute('open'), null);
    await details.locator('summary').click();
    assert.equal(await details.locator('p').innerText(), 'Le pied de page prend trop de place.');
  }
  await problems.scrollIntoViewIfNeeded();
  const inspect = async suffix => {
    const viewport = await page.evaluate(() => Object.fromEntries(['dialog[open]', '.document-workbench__header', '.document-workbench > div', '.design-studio__panel:not([hidden])'].map(selector => {
      const el = document.querySelector(selector), rect = el.getBoundingClientRect(), css = getComputedStyle(el);
      return [selector, { top: rect.top, bottom: rect.bottom, height: rect.height, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflow: css.overflow, display: css.display }];
    })));
    await writeFile(`${output}/${caseId}-${suffix}-viewport.json`, JSON.stringify(viewport, null, 2));
    assert.ok(viewport['.document-workbench__header'].top >= 0 && viewport['.document-workbench__header'].bottom <= 1000, `${caseId}/${suffix} return button scrolled out of view`);
    assert.equal(viewport['dialog[open]'].scrollTop, 0, `${caseId}/${suffix} outer dialog scrolled`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('dialog[open]').scrollWidth > innerWidth + 1), false, `${caseId}/${suffix} overflow`);
    if (language === 'de' || language === 'fr') await page.screenshot({ path: `${output}/${caseId}-${suffix}.png` });
  };
  await inspect('validation');
  await page.evaluate(() => window.__documentEditorQa.failure = null);
  await save.click();
  await page.waitForFunction(count => window.__documentEditorQa.saved.length === count + 1, beforeSaves);
  const saved = await page.evaluate(() => window.__documentEditorQa.saved.at(-1));
  assert.equal(saved.documentComposition.invoices.fontFamily, 'inter');
  assert.equal(saved.documentComposition.invoices.closing[0].runs.map(run => run.text).join(''), 'Merci. CHF 500 reste CHF 500.');
  assert.equal(saved.documentDesignTemplates.at(-1).name, 'Factures / Kunden 42');
  const rendered = await page.evaluate(() => [...new Set(window.__documentEditorQa.inputs.map(input => input.kind))]);
  assert.deepEqual(rendered.sort(), ['accounts', 'invoices', 'payslips', 'quotes']);
  // Inspect the longest advanced form in its final language, also at larger type.
  await choose('margins');
  for (const node of await page.locator('.design-studio__panel:not([hidden]) details').all()) {
    if (await node.getAttribute('open') === null) await node.locator('summary').click();
  }
  await page.locator('.design-studio__panel:not([hidden])').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await inspect('layout');
  if (language === 'de' && width === 320) {
    await page.evaluate(async () => (await import('/src/textSize.ts')).setTextSize(200));
    await page.locator('.document-page-format').evaluate(el => el.scrollIntoView({ block: 'center' }));
    const formats = await page.locator('.document-page-format button').evaluateAll(elements => elements.map(el => ({ width: el.getBoundingClientRect().width, top: el.getBoundingClientRect().top })));
    assert.ok(formats[0].width > 260 && formats[1].top > formats[0].top);
    await inspect('large-text');
  }
  return { templateFont: true, customerTextPreserved: true, preciseSizes: true, richTextReplacement: true, localErrorSelectsPassage: true, nativeErrorDetails: true, saveAfterRecovery: true, allFourRenderers: true };
}
