import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const { [engine]: driver } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const folder = '.qa/document-word';
await mkdir(folder, { recursive: true });
const report = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 1000 }, reducedMotion: 'reduce' });
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('clipboard-test.invalid')) external.push(request.url()); });
    await page.route('**/native-design-fixture/*.pdf', async route => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1);
      assert.match(file, /^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
      await route.fulfill({ contentType: 'application/pdf', body: await readFile(`.qa/composition-pdfs/${file}`) });
    });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/document-design-harness.html`);
    const ready = () => page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({ state: 'attached', timeout: 30_000 });
    const draft = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('design-draft')).documentComposition.invoices);
    await ready();
    const parser = await page.evaluate(async () => {
      const { richTextFromClipboard: parse } = await import('/src/richTextClipboard.ts');
      return {
        docs: parse('<b style="font-weight:normal"><p style="text-align:center"><span style="font-family:Arial;font-size:16px;font-weight:700;color:rgb(121,60,50);background-color:#fff0a6">Conditions</span></p><p><i>Merci</i> de votre confiance.</p></b>'),
        list: parse('<ol start="3"><li><p>Premier point</p></li><li>Second point</li></ol><ul><li><p>Dernier point</p></li></ul>'),
        table: parse('<table><tr><td>Nom</td><td>Valeur</td></tr><tr><td>Exemple</td><td>120</td></tr></table>'),
        dangerous: parse('<link href="https://clipboard-test.invalid/style.css" rel="stylesheet"><script>window.clipboardExecuted=true</script><img src="https://clipboard-test.invalid/image" onerror="window.clipboardExecuted=true"><iframe src="https://clipboard-test.invalid/frame"></iframe><p onclick="alert(1)" style="background-image:url(https://clipboard-test.invalid/bg)">Texte conservé</p>'),
        empty: parse('<img src="https://clipboard-test.invalid/empty">'),
        oversized: parse('<p>' + 'a'.repeat(200_001) + '</p>'),
      };
    });
    assert.equal(parser.docs[0].align, 'center');
    assert.deepEqual(parser.docs[0].runs[0], { text: 'Conditions', bold: true, italic: false, underline: false, color: '#793c32', highlight: '#fff0a6', fontFamily: 'helvetica', fontSize: 12 });
    assert.equal(parser.docs[1].runs[0].italic, true);
    assert.equal(parser.docs[1].runs[1].bold, false);
    const plain = value => value.map(p => p.runs.map(r => r.text).join('')).join('\n');
    assert.equal(plain(parser.list), '3. Premier point\n4. Second point\nDernier point');
    assert.equal(parser.list[2].bullet, true);
    assert.equal(plain(parser.table), 'Nom  Valeur\nExemple  120');
    assert.equal(plain(parser.dangerous), 'Texte conservé');
    assert.equal(parser.empty, null); assert.equal(parser.oversized, null);
    assert.equal(await page.evaluate(() => !!window.clipboardExecuted), false);
    const map = page.getByRole('navigation', { name: 'Éléments du document' });
    await map.getByRole('button', { name: /^Logo / }).click();
    await page.getByRole('button', { name: 'Logo à droite', exact: true }).click();
    await ready(); assert.equal((await draft()).logoPosition, 'right');
    await map.getByRole('button', { name: /^Conditions / }).click();
    const editor = page.getByRole('textbox', { name: 'Conditions et message de fin', exact: true });
    await editor.fill('Avant milieu après');
    await page.getByRole('button', { name: 'Agrandir l’espace d’écriture', exact: true }).click();
    await page.locator('.design-studio--writing').waitFor();
    assert.equal(await page.locator('.design-studio__preview').isVisible(), false);
    const select = async (start, end) => editor.evaluate((el, { start, end }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const point = offset => { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; } return [nodes.at(-1), nodes.at(-1).length]; };
      el.focus(); const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end)); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, { start, end });
    const paste = async (html, text) => editor.evaluate((el, { html, text }) => { const data = new DataTransfer(); data.setData('text/html', html); data.setData('text/plain', text); el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, { html, text });
    await select(6, 12);
    await paste('<p style="text-align:center"><strong style="font-family:Georgia;font-size:18pt">Conditions</strong></p><p><u>Merci</u></p>', 'Conditions\nMerci');
    let rich = (await draft()).closing;
    assert.equal(plain(rich), 'Avant Conditions\nMerci après');
    assert.equal(rich[0].runs[1].fontFamily, 'times'); assert.equal(rich[0].runs[1].fontSize, 18);
    assert.equal(rich[1].runs[0].underline, true);
    const copiedBack = await editor.evaluate(async el => (await import('/src/richTextClipboard.ts')).richTextFromClipboard(el.innerHTML));
    assert.equal(plain(copiedBack), plain(rich));
    assert.equal(copiedBack[0].runs[1].fontSize, 18);
    assert.equal(copiedBack[0].runs[1].fontFamily, 'times');
    await page.getByRole('button', { name: 'Annuler la modification du texte', exact: true }).click();
    assert.equal(plain((await draft()).closing), 'Avant milieu après');
    await page.getByRole('button', { name: 'Rétablir la modification du texte', exact: true }).click();
    assert.equal(plain((await draft()).closing), 'Avant Conditions\nMerci après');
    await select(0, 0);
    await page.getByRole('button', { name: 'Titre de section', exact: true }).click();
    assert.ok((await draft()).closing[0].runs.every(run => run.fontSize === 18 && run.bold));
    await editor.fill('');
    await page.getByRole('button', { name: 'Sous-titre', exact: true }).click();
    await editor.pressSequentially('Conditions de paiement');
    assert.equal((await draft()).closing[0].runs[0].fontSize, 12);
    await page.getByRole('button', { name: 'Texte normal', exact: true }).click();
    assert.equal((await draft()).closing[0].runs[0].fontSize, undefined);
    await page.getByLabel('Conserver la mise en forme du texte collé', { exact: true }).uncheck();
    await select(0, 22);
    await paste('<strong>Texte simple</strong>', 'Texte simple');
    assert.equal(plain((await draft()).closing), 'Texte simple');
    assert.ok((await draft()).closing[0].runs.every(run => !run.bold));
    await page.getByLabel('Conserver la mise en forme du texte collé', { exact: true }).check();
    await paste('<p>' + 'a'.repeat(5001) + '</p>', 'a'.repeat(5001));
    await page.getByText(/5000 caractères au maximum/).waitFor();
    assert.equal(plain((await draft()).closing), 'Texte simple');
    await select(0, 12);
    await paste('<p><strong style="color:#182b49">Conditions de paiement</strong></p><p>Merci pour votre confiance.</p>', 'Conditions de paiement\nMerci pour votre confiance.');
    await page.screenshot({ path: `${folder}/${engine}-${width}-writing.png`, fullPage: true });
    await page.getByRole('button', { name: 'Voir le rendu PDF', exact: true }).click();
    await ready(); assert.ok(await page.locator('.design-studio__preview').isVisible());
    await page.getByRole('button', { name: 'Enregistrer les présentations', exact: true }).click();
    await page.reload(); await ready();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('design-settings')));
    assert.equal(saved.documentComposition.invoices.logoPosition, 'right');
    assert.equal(plain(saved.documentComposition.invoices.closing), 'Conditions de paiement\nMerci pour votre confiance.');
    await page.getByText('Réutiliser cette présentation', { exact: true }).click();
    for (const [kind, label] of [['quotes', 'Devis'], ['accounts', 'Bilan'], ['payslips', 'Fiches de salaire']]) {
      await page.getByLabel('Copier vers', { exact: true }).selectOption(kind);
      await page.getByRole('button', { name: 'Copier la présentation', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click(); await ready();
      await page.getByRole('button', { name: 'Exporter cet exemple', exact: true }).click();
      const exported = await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-export')));
      assert.equal(exported.kind, kind); assert.equal(exported.style.composition.closing[0].runs[0].bold, true);
      await page.getByRole('button', { name: 'Factures', exact: true }).click(); await ready();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: `${folder}/${engine}-${width}-studio.png`, fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    report.push({ width, parser: true, formattedPaste: true, styles: true, preservedText: true, undo: true, plainPaste: true, limitRecovery: true, writingMode: true, logo: true, saveReload: true, allCategoriesExport: true, noOverflow: true });
    await page.close();
  }
} finally {
  await writeFile(`${folder}/${engine}-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ engine, report }));
