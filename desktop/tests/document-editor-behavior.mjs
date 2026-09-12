import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const driver = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright')[engine];
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/native-design-fixture/*.pdf', async route => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1);
      assert.match(file, /^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
      await route.fulfill({ contentType: 'application/pdf', body: await readFile(`.qa/composition-pdfs/${file}`) });
    });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271'}/tests/document-design-harness.html`);
    await page.getByRole('button', { name: 'Textes', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Conditions et message de fin', exact: true });
    const toolbar = page.getByRole('group', { name: 'Mise en forme : Conditions et message de fin', exact: true });
    const button = name => toolbar.getByRole('button', { name, exact: true });
    const rich = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('design-draft')).documentComposition.invoices.closing);
    const plain = async () => (await rich()).map(p => p.runs.map(r => r.text).join('')).join('\n');
    const caret = async (paragraph, offset) => editor.evaluate((el, { paragraph, offset }) => {
      const p = el.querySelectorAll('.rich-editor__paragraph')[paragraph];
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) { if (offset <= node.length) break; offset -= node.length; }
      const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
      el.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
    }, { paragraph, offset });
    await editor.fill(''); await editor.focus();
    await button('Gras').click(); assert.equal(await button('Gras').getAttribute('aria-pressed'), 'true');
    await editor.pressSequentially('Titre');
    assert.equal(await plain(), 'Titre'); assert.ok((await rich())[0].runs.every(r => r.bold));
    await button('Gras').click(); await editor.pressSequentially(' normal');
    assert.deepEqual((await rich())[0].runs.map(r => [r.text, r.bold]), [['Titre', true], [' normal', false]]);
    await button('Italique').click(); await button('Souligner').click(); await editor.pressSequentially(' fin');
    assert.ok((await rich())[0].runs.some(r => r.text === ' fin' && r.italic && r.underline && !r.bold));
    await editor.fill('Première\nSeconde'); assert.equal(await plain(), 'Première\nSeconde'); await caret(0, 2);
    await button('Liste à puces').click(); assert.equal((await rich())[0].bullet, true); assert.equal((await rich())[1].bullet, false);
    await button('Liste à puces').click(); assert.equal((await rich())[0].bullet, false);
    await caret(1, 0); await editor.press('Backspace'); assert.equal(await plain(), 'PremièreSeconde');
    await editor.press('Control+z'); assert.equal(await plain(), 'Première\nSeconde');
    await editor.press('Control+y'); assert.equal(await plain(), 'PremièreSeconde');
    await editor.press('Control+End'); await editor.press('Enter'); await editor.press('Enter'); await editor.pressSequentially('Après');
    assert.equal(await plain(), 'PremièreSeconde\n\nAprès');
    const previous = await rich();
    await editor.evaluate(el => {
      const data = new DataTransfer(); data.setData('text/plain', Array.from({ length: 65 }, (_, i) => `Ligne ${i}`).join('\n'));
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await page.getByText(/60 paragraphes au maximum/).waitFor();
    assert.deepEqual(await rich(), previous); assert.equal(await editor.locator('.rich-editor__paragraph').count(), 3);
    await page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor();
    await page.evaluate(() => sessionStorage.setItem('design-export-mode', 'error'));
    await page.getByRole('button', { name: 'Exporter cet exemple', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'L’export n’a pas abouti' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Enregistrer les présentations', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Exporter cet exemple', exact: true }).isEnabled(), true);
    await page.evaluate(() => sessionStorage.setItem('design-export-mode', 'share-error'));
    await page.getByRole('button', { name: 'Exporter cet exemple', exact: true }).click();
    const share = page.getByRole('button', { name: 'Partager le PDF', exact: true });
    await share.click(); await page.getByText(/Votre PDF est conservé/).waitFor();
    await share.click(); await page.getByText('Partage du PDF ouvert.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('design-export-count')), '2');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('design-share-count')), '2');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('design-share-path')), 'example.pdf');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []); await page.close(); console.log(JSON.stringify({ engine, width, typedMarks: true, bulletToggle: true, undo: true, blankLines: true, oversizedPasteRetained: true }));
  }
} finally { await browser.close(); }
