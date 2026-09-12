import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const folder = `.qa/document-typography-${engine}`;
await mkdir(folder, { recursive: true });
const report = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', hasTouch: width < 500 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/native-design-fixture/*.pdf', async route => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1);
      assert.match(file, /^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
      await route.fulfill({ contentType: 'application/pdf', body: await readFile(`.qa/composition-pdfs/${file}`) });
    });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html`);
    const ready = () => page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({ timeout: 30000 });
    const request = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('design-request')));
    await ready();
    await page.getByRole('button', { name: 'Textes', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'default typography controls fit');
    const editor = page.getByRole('textbox', { name: 'Conditions et message de fin', exact: true });
    const toolbar = page.getByRole('group', { name: 'Mise en forme : Conditions et message de fin', exact: true });
    await editor.fill('Conditions de paiement\nMerci de votre confiance.');
    async function selectFirstParagraph() {
      await editor.evaluate(el => {
        el.focus(); const range = document.createRange(); range.selectNodeContents(el.querySelector('.rich-editor__paragraph'));
        const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range);
      });
    }
    await selectFirstParagraph();
    await page.getByLabel('Police du passage', { exact: true }).selectOption('times');
    await page.getByLabel('Taille du passage', { exact: true }).selectOption('18');
    await toolbar.getByRole('button', { name: 'Gras', exact: true }).click();
    await ready();
    let closing = (await request()).style.composition.closing;
    assert.equal(closing.map(p => p.runs.map(r => r.text).join('')).join('\n'), 'Conditions de paiement\nMerci de votre confiance.');
    assert.ok(closing[0].runs.every(r => r.fontFamily === 'times' && r.fontSize === 18 && r.bold));
    assert.ok(closing[1].runs.every(r => !r.fontFamily && !r.fontSize && !r.bold));
    const fontMetrics = await editor.evaluate(el => [...el.querySelectorAll('.rich-editor__paragraph > span')].map(e => ({ family: getComputedStyle(e).fontFamily, size: parseFloat(getComputedStyle(e).fontSize) })));
    assert.match(fontMetrics[0].family, /Times/);
    assert.ok(fontMetrics[0].size > fontMetrics[1].size);
    await editor.press('ControlOrMeta+End');
    await page.getByLabel('Police du passage', { exact: true }).selectOption('courier');
    await page.getByLabel('Taille du passage', { exact: true }).selectOption('14');
    await editor.pressSequentially(' Votre équipe.'); await ready();
    closing = (await request()).style.composition.closing;
    assert.ok(closing[1].runs.some(r => r.text === ' Votre équipe.' && r.fontFamily === 'courier' && r.fontSize === 14));
    await selectFirstParagraph();
    await toolbar.getByRole('button', { name: 'Effacer la mise en forme', exact: true }).click(); await ready();
    assert.ok((await request()).style.composition.closing[0].runs.every(r => !r.fontFamily && !r.fontSize && !r.bold));
    await toolbar.getByRole('button', { name: 'Annuler la modification du texte', exact: true }).click(); await ready();
    assert.deepEqual((await request()).style.composition.closing, closing);
    await editor.press('ControlOrMeta+A');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Police du passage"]')?.value === 'mixed');
    assert.equal(await page.getByLabel('Taille du passage', { exact: true }).inputValue(), 'mixed');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mixed typography controls fit');
    await selectFirstParagraph();
    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByLabel('Police du document', { exact: true }).selectOption('courier');
    await page.getByRole('button', { name: 'Mise en page', exact: true }).click();
    await page.getByLabel('Position du logo', { exact: true }).selectOption('right');
    await page.getByLabel('Marges', { exact: true }).selectOption('20');
    await page.getByLabel('Interligne', { exact: true }).selectOption('1.5'); await ready();
    await page.getByRole('button', { name: 'Enregistrer les présentations', exact: true }).click();
    await page.reload(); await ready();
    const design = (await request()).style.composition;
    assert.equal(design.fontFamily, 'courier'); assert.equal(design.logoPosition, 'right'); assert.equal(design.marginMm, 20); assert.equal(design.lineSpacing, 1.5);
    assert.deepEqual(design.closing, closing);
    await page.getByText('Réutiliser cette présentation', { exact: true }).click();
    for (const target of ['quotes', 'accounts', 'payslips']) {
      await page.getByLabel('Copier vers', { exact: true }).selectOption(target);
      await page.getByRole('button', { name: 'Copier la présentation', exact: true }).click();
      const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-draft')));
      assert.deepEqual(draft.documentComposition[target], design);
    }
    await page.getByRole('button', { name: 'Enregistrer les présentations', exact: true }).click();
    for (const label of ['Devis', 'Bilan', 'Fiches de salaire']) {
      await page.getByRole('button', { name: label, exact: true }).click(); await ready();
      await page.getByRole('button', { name: 'Exporter cet exemple', exact: true }).click();
      const exported = await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-export')));
      assert.deepEqual(exported.style.composition, design);
    }
    await page.getByRole('button', { name: 'Factures', exact: true }).click(); await ready();
    await page.getByRole('button', { name: 'Textes', exact: true }).click();
    await selectFirstParagraph();
    await editor.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: `${folder}/${width}-editor.png` });
    assert.deepEqual(errors, []);
    report.push({ width, selectedFonts: true, typedStyle: true, undo: true, mixedSelection: true, savedAndCopied: true, allDocumentKinds: true, noOverflow: true });
    await page.close();
  }
  await writeFile(`${folder}/report.json`, JSON.stringify({ engine, report }, null, 2));
  console.log(JSON.stringify({ engine, report }));
} finally { await browser.close(); }
