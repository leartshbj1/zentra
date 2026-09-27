import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { checkDocumentEditor } from './document-editor-checks.mjs';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5359';
const fixtures = process.env.ZENTRA_DESIGN_PDF_FIXTURES || '.qa/composition-pdfs';
const advanced = process.env.ZENTRA_QA_DOCUMENT_ADVANCED === '1';
const output = advanced ? '.qa/document-editor-languages' : '.qa/document-navigation-languages';
await mkdir(output, { recursive: true });
const report = [];
for (const engine of ['chromium', 'webkit']) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try { for (const width of [320, 1440]) for (const language of ['fr', 'de', 'it', 'en']) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const caseId = `${engine}-${width}-${language}`;
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith(`${origin}/native-design-fixture/`)) {
        const file = url.split('/').at(-1);
        assert.match(file, /^(quotes|invoices|accounts|payslips)-(signature|minimal|helvetica|times|courier)\.pdf$/);
        return route.fulfill({ contentType: 'application/pdf', body: await readFile(`${fixtures}/${file}`) });
      }
      return url.startsWith(origin) || url.startsWith('data:') ? route.continue() : route.abort();
    });
    try {
      await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&language=${language}&theme=${width === 320 ? 'dark' : 'light'}`);
      await page.locator(width <= 860 ? '.mobile-home__balance' : '.workspace-finances').waitFor();
      const copy = await page.evaluate(async () => {
        const { t } = await import('/src/language.ts');
        const keys = ['Aller à un écran', 'Rechercher un écran', 'Paramètres', 'Mes réglages', 'Ouvrir le grand atelier', 'Atelier de personnalisation des documents', 'Revenir aux paramètres', 'Trouvez votre outil', 'Éléments du document', 'Effacer la recherche d’outil'];
        return Object.fromEntries(keys.map(key => [key, t(key)]));
      });
      await page.evaluate(async advanced => {
        const { desktopApi } = await import('/src/bridge.ts');
        window.__documentEditorQa = { saved: [], inputs: [], failure: null };
        desktopApi.documentDesignExample = async input => {
          window.__documentEditorQa.inputs.push(input);
          if (window.__documentEditorQa.failure && input.kind === 'invoices') throw new Error(window.__documentEditorQa.failure);
          const font = input.style.composition?.fontFamily || input.style.layout;
          const fixtureFont = font === 'inter' ? 'helvetica' : font === 'literata' ? 'times' : font;
          return [...new Uint8Array(await (await fetch(`/native-design-fixture/${input.kind}-${fixtureFont}.pdf`)).arrayBuffer())];
        };
        if (advanced) {
          const workspace = await desktopApi.loadWorkspace();
          desktopApi.saveSettings = async settings => { window.__documentEditorQa.saved.push(structuredClone(settings)); return { ...workspace, settings }; };
        }
      }, advanced);
      await page.getByRole('button', { name: copy['Aller à un écran'], exact: true }).click();
      await page.getByRole('searchbox', { name: copy['Rechercher un écran'] }).fill(copy.Paramètres);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(copy.Paramètres, { exact: true }) }).click();
      await page.locator('[data-settings-link="documents"]').click();
      await page.locator('.design-studio__preview[aria-busy=false] img').first().waitFor();
      if (width <= 900) await page.getByRole('button', { name: copy['Mes réglages'], exact: true }).click();
      await page.locator("[data-design-control=\"Police du document\"]").selectOption('times');
      const open = page.getByRole('button', { name: copy['Ouvrir le grand atelier'], exact: true }).filter({ visible: true });
      await open.click();
      const dialog = page.getByRole('dialog', { name: copy['Atelier de personnalisation des documents'], exact: true });
      await dialog.waitFor();
      const search = page.getByRole('searchbox', { name: copy['Trouvez votre outil'], exact: true });
      const tools = await page.evaluate(async () => {
        const { documentDesignTools } = await import('/src/documentDesignTools.ts');
        const { t } = await import('/src/language.ts');
        return documentDesignTools.map(tool => ({ ...tool, translated: t(tool.label), description: t(tool.description) }));
      });
      for (const tool of tools) {
        await search.fill(tool.translated);
        const result = page.locator('.design-navigator__results button').filter({ has: page.getByText(tool.translated, { exact: true }) });
        assert.equal(await result.count(), 1, `${caseId}/${tool.id}`);
        await result.click();
        await page.waitForFunction(selector => document.querySelector('.design-studio__tools')?.querySelector(selector) === document.activeElement, tool.selector);
        assert.equal(await page.locator('.design-studio__tool-hint strong').innerText(), tool.translated);
      }
      // Search results navigate only: previously chosen appearance remains intact.
      await search.fill(tools.find(tool => tool.id === 'font').translated);
      await page.locator('.design-navigator__results button').filter({ has: page.getByText(tools.find(tool => tool.id === 'font').translated, { exact: true }) }).click();
      assert.equal(await page.locator("[data-design-control=\"Police du document\"]").inputValue(), 'times');
      await search.fill(tools.find(tool => tool.id === 'title-font').translated);
      await search.press('Enter');
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-design-control") === 'Police du titre');
      await search.fill('logo'); await search.press('ArrowDown');
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.design-navigator__results')));
      await search.press('Escape'); assert.equal(await search.inputValue(), ''); assert.ok(await dialog.isVisible());
      await search.fill('zzzz-no-result');
      assert.equal(await page.locator('.design-navigator__results button').count(), 0);
      assert.ok(await page.locator('.design-navigator__results [role=status]').innerText());
      await page.getByRole('button', { name: copy['Effacer la recherche d’outil'], exact: true }).click();
      await page.locator('.design-studio__section-guide summary').click();
      await page.getByRole('navigation', { name: copy['Éléments du document'], exact: true }).getByRole('button').nth(1).click();
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-design-control") === 'Taille du titre');
      // Check long translations and both appearance modes in the real settings shell.
      await search.fill(language === 'de' ? 'Farbe' : language === 'it' ? 'colore' : language === 'en' ? 'colour' : 'couleur');
      await page.locator('.design-navigator').evaluate(el => el.scrollIntoView({ block: 'start' }));
      const inspect = async suffix => {
        const sizes = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, dialog: document.querySelector('dialog[open]').scrollWidth }));
        assert.ok(sizes.document <= width + 1 && sizes.dialog <= width + 1, `${caseId}/${suffix} horizontal overflow ${JSON.stringify(sizes)}`);
        const clipped = await page.locator('.design-navigator__results button').evaluateAll(elements => elements.flatMap(el => {
          const box = el.getBoundingClientRect();
          const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const bad = [];
          while (nodes.nextNode()) {
            const range = document.createRange(); range.selectNodeContents(nodes.currentNode);
            if ([...range.getClientRects()].some(rect => rect.left < box.left - 1 || rect.right > box.right + 1)) bad.push(nodes.currentNode.textContent);
          }
          return bad;
        }));
        assert.deepEqual(clipped, [], `${caseId}/${suffix} clipped result`);
        if (language === 'de' || language === 'fr') await page.screenshot({ path: `${output}/${caseId}-${suffix}.png` });
      };
      await inspect('initial');
      await page.evaluate(async () => (await import('/src/appearance.ts')).setAppearance('light'));
      await inspect('light');
      await search.press('Escape');
      await dialog.locator('.document-workbench__header').getByRole('button', { name: copy['Revenir aux paramètres'], exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await open.evaluate(el => el === document.activeElement), true, await page.evaluate(() => JSON.stringify({ active: document.activeElement?.outerHTML.slice(0, 500) })));
      assert.equal(await page.locator("[data-design-control=\"Police du document\"]").inputValue(), 'times');
      const advancedResult = advanced ? await checkDocumentEditor({ page, width, language, tools, output, caseId }) : {};
      assert.deepEqual(errors, []);
      report.push({ engine, width, language, targets: tools.length, keyboard: true, map: true, noOverflow: true, themeSwitch: true, draftPreserved: true, closeRestoresFocus: true, ...advancedResult });
    } catch (error) {
      await page.screenshot({ path: `${output}/FAILED-${caseId}.png` });
      report.push({ caseId, error: String(error.stack || error) }); throw error;
    } finally { await writeFile(`${output}/proof.json`, JSON.stringify(report, null, 2)); await page.close(); }
  } } finally { await browser.close(); }
}
console.log(JSON.stringify({ scenarios: report.length, proof: `${output}/proof.json` }));
