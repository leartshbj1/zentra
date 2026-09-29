import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5377';
const output = new URL('../.qa/finance-overview-language/', import.meta.url);
await mkdir(output, { recursive: true });
const reports = [];
const layoutFailures = [];
const headings = { fr: 'Vos finances, en clair.', de: 'Ihre Finanzen, verständlich erklärt.', it: 'Le tue finanze, in chiaro.', en: 'Your finances, clearly explained.' };
const languages = ['fr', 'de', 'it', 'en'];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function geometry(page, root, state) {
  const measured = await root.evaluate(element => {
    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const nodes = [...element.querySelectorAll('button,p,h3,h4,dt,dd,summary,label,.section-navigation__current > span:nth-child(2),.finance-navigation__period-value')].filter(visible);
    return {
      language: document.documentElement.lang,
      viewport: innerWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      clipped: nodes.filter(node => node.scrollWidth > node.clientWidth + 2).map(node => ({ tag: node.tagName, text: node.textContent, width: node.clientWidth, scroll: node.scrollWidth, children: [...node.querySelectorAll('span,select')].map(child => ({ tag: child.tagName, cls: child.className, left: child.getBoundingClientRect().left, right: child.getBoundingClientRect().right, margin: getComputedStyle(child).margin, width: child.getBoundingClientRect().width, scroll: child.scrollWidth, display: getComputedStyle(child).display, opacity: getComputedStyle(child).opacity, whiteSpace: getComputedStyle(child).whiteSpace, minWidth: getComputedStyle(child).minWidth, position: getComputedStyle(child).position })) })),
      outside: nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(node => node.textContent),
    };
  });
  // Complete the language/dialogue matrix, but retain a failing exit status for
  // every geometry defect. No tolerance is widened to hide a clipped control.
  if (measured.pageOverflow || measured.clipped.length || measured.outside.length) layoutFailures.push({ state, ...measured });
  return { state, ...measured };
}

for (const engine of ['edge', 'webkit', 'webkit-tablet', 'webkit-landscape']) {
  const browser = await (engine.startsWith('webkit') ? webkit : chromium).launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const language of languages) {
      if (engine === 'webkit-tablet' && language !== 'it' || engine === 'webkit-landscape' && language !== 'en') continue;
      if (process.env.ZENTRA_QA_CASE && process.env.ZENTRA_QA_CASE !== `${engine}-${language}`) continue;
      const width = engine === 'edge' ? 1440 : engine === 'webkit-tablet' ? 800 : engine === 'webkit-landscape' ? 844 : language === 'de' ? 320 : 390;
      const scale = engine === 'edge' || engine === 'webkit-tablet' ? 100 : 200;
      const height = engine === 'webkit-landscape' ? 390 : 1000;
      const theme = ['de', 'en'].includes(language) ? 'dark' : 'light';
      const name = `${engine}-${language}-${width}-${scale}`;
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      const errors = [], checks = [];
      page.on('pageerror', error => errors.push(String(error)));
      try {
        await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
        await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
        await page.evaluate(async () => {
          const { desktopApi: api } = await import('/src/bridge.ts');
          const continuity = api.getAccountingContinuity;
          api.getAccountingContinuity = async () => ({ ...await continuity(), enabled: true, mappingReady: true, journalEntryCount: 1 });
          const income = api.getIncomeStatement;
          // The shared design fixture returns a fixed annual scope. This journey
          // needs the requested scope so its custom-period display is meaningful.
          api.getIncomeStatement = async filter => {
            const report = await income(filter);
            return { ...report, scope: { ...report.scope, ...filter } };
          };
          window.dispatchEvent(new CustomEvent('zentra-automation-navigate', { detail: 'accounting' }));
        });
        await page.waitForFunction(() => document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy') === 'false');
        await page.evaluate(async ({ language, scale, theme }) => {
          (await import('/src/textSize.ts')).setTextSize(scale);
          (await import('/src/appearance.ts')).setAppearance(theme);
          await (await import('/src/language.ts')).setAppLanguage(language);
        }, { language, scale, theme });
        const text = source => page.evaluate(async source => (await import('/src/language.ts')).t(source), source);
        const button = async (scope, source) => scope.getByRole('button', { name: await text(source), exact: true });
        // Use the real AccountingScreen controls before isolating the dialogue callbacks.
        const screen = page.locator('.accounting-screen');
        const mobilePicker = screen.getByRole('combobox', { name: await text('Section comptable'), exact: true });
        if (width <= 860) assert.equal(await mobilePicker.isVisible(), true, 'all accounting destinations must remain accessible at intermediate widths');
        if (await mobilePicker.isVisible()) {
          const sectionIds = ['overview', 'assets', 'journal', 'ledger', 'trial', 'balance', 'income', 'vat', 'closing', 'accounts', 'periods'];
          assert.deepEqual(await mobilePicker.locator('option').evaluateAll(options => options.map(option => option.value)), sectionIds);
          for (const section of sectionIds) {
            await mobilePicker.selectOption(section);
            await settle(page);
            const selectedText = await mobilePicker.locator(`option[value="${section}"]`).textContent();
            const caption = screen.locator('.finance-navigation .section-navigation__current > span:nth-child(2)');
            assert.equal(await caption.textContent(), selectedText);
            assert.ok((await caption.boundingBox()).width >= 100, `${name}: selected section has a readable column`);
          }
          await mobilePicker.selectOption('overview');
          await page.waitForFunction(() => document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy') === 'false');
          await mobilePicker.focus();
          assert.ok(await screen.locator('.finance-navigation .section-navigation__picker').evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) >= 2));
          await page.keyboard.press('Tab');
          assert.equal(await mobilePicker.evaluate(element => document.activeElement === element), false);
        }
        const selectSection = async (id, label) => {
          const picker = screen.getByRole('combobox', { name: await text('Section comptable'), exact: true });
          if (await picker.isVisible()) await picker.selectOption(id);
          else if (id === 'journal') await screen.getByRole('combobox', { name: await text('Autres outils comptables'), exact: true }).selectOption(id);
          else await screen.getByRole('tab', { name: await text(label), exact: true }).click();
        };
        const period = screen.getByRole('combobox', { name: await text('Période de la vue d’ensemble'), exact: true });
        assert.deepEqual(await period.locator('option').allTextContents(), await Promise.all(['Ce mois', 'Ce trimestre', 'Cette année', 'Période personnalisée'].map(text)));
        await period.selectOption('month');
        await page.waitForFunction(() => document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy') === 'false');
        await selectSection('income', 'Résultat');
        const refresh = await button(screen, 'Actualiser');
        await refresh.waitFor();
        await page.waitForFunction(() => !document.querySelector('.accounting-period-bar button.button')?.disabled);
        await screen.getByRole('group', { name: await text('Choisir une période rapidement'), exact: true }).getByRole('button', { name: await text('Ce trimestre'), exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.accounting-period-bar button.button')?.disabled);
        const periodToggle = screen.locator('.accounting-period-toggle');
        if (await periodToggle.isVisible()) await periodToggle.click();
        await screen.getByRole('combobox', { name: await text('Exercice ou période comptable'), exact: true }).waitFor();
        await screen.getByLabel(await text('Date de début de la période'), { exact: true }).fill('2026-01-01');
        await page.waitForFunction(() => !document.querySelector('.accounting-period-bar button.button')?.disabled);
        await screen.getByLabel(await text('Date de fin de la période'), { exact: true }).fill('2026-09-29');
        await page.waitForFunction(() => !document.querySelector('.accounting-period-bar button.button')?.disabled);
        await refresh.click();
        await screen.getByText(await text('Les états ont été actualisés.'), { exact: true }).waitFor();
        checks.push(await geometry(page, screen.locator('.accounting-toolbar'), 'actual-screen-toolbar'));
        await page.screenshot({ path: fileURLToPath(new URL(`${name}-toolbar.png`, output)) });
        await selectSection('journal', 'Journal');
        await page.waitForFunction(() => !document.querySelector('.accounting-period-bar button.button')?.disabled);
        await selectSection('overview', 'Vue d’ensemble');
        await page.waitForFunction(() => document.querySelector('.finance-overview__figures')?.getAttribute('aria-busy') === 'false');
        if (await mobilePicker.isVisible()) {
          assert.equal(await screen.getByRole('combobox', { name: await text('Période de la vue d’ensemble'), exact: true }).inputValue(), 'custom');
          assert.equal(await screen.locator('.finance-navigation__period-value').isVisible(), true);
          assert.equal(await screen.locator('.finance-navigation__period-value > span').textContent(), await text('Période personnalisée'));
          const nativePeriod = screen.getByRole('combobox', { name: await text('Période de la vue d’ensemble'), exact: true });
          await nativePeriod.focus();
          assert.ok(await screen.locator('.finance-navigation__more--period').evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) >= 2));
          await page.keyboard.press('Tab');
          assert.equal(await nativePeriod.evaluate(element => document.activeElement === element), false);
          checks.push(await geometry(page, screen.locator('.finance-navigation'), 'custom-period-navigation'));
          await screen.locator('.finance-navigation').evaluate(element => element.scrollIntoView({ block: 'center' }));
          await page.screenshot({ path: fileURLToPath(new URL(`${name}-custom-period.png`, output)) });
        }
        await page.evaluate(async () => { window.__financeFixture = await (await import('/tests/finance-overview-language.tsx')).mountFinanceLanguageTest(); });
        const root = page.locator('#finance-language-fixture');
        const showScenario = async scenario => { await page.evaluate(scenario => window.__financeFixture.render(scenario), scenario); await settle(page); };
        await root.locator('.finance-overview__intro summary').waitFor();
        // Independent expected text catches an untranslated title as well as the locale subscription.
        assert.equal(await root.locator('.finance-overview__intro summary').innerText(), headings[language]);
        const amounts = await root.locator('.finance-overview__figures strong').allTextContents();
        assert.equal(amounts.length, 3);
        const formatted = await page.evaluate(async () => { const { formatMoney } = await import('/src/utils.ts'); return [123456, 4567, 118889].map(value => formatMoney(value, 'CHF')); });
        assert.deepEqual(amounts, formatted);
        await root.locator('.finance-overview__intro summary').click();
        await root.getByText(await text('Comprenez votre résultat, préparez la TVA et avancez une étape à la fois.'), { exact: true }).waitFor();
        checks.push(await geometry(page, root, 'overview'));
        await page.screenshot({ path: fileURLToPath(new URL(`${name}-overview.png`, output)) });
        for (const source of ['Voir le détail', 'Vérifier ma configuration', 'Préparer ma TVA', 'Comprendre mon bilan', 'Préparer la fin d’année']) {
          const action = source === 'Voir le détail' ? (await button(root, source)).first() : root.getByRole('button', { name: new RegExp((await text(source)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
          await action.click();
        }
        if (width <= 860) await root.locator('.mobile-details > summary').click();
        await (await button(root, 'Consulter les opérations')).click();
        assert.deepEqual(await page.evaluate(() => window.__financeFixture.records.sections), ['income', 'accounts', 'vat', 'balance', 'closing', 'journal']);
        await (await button(root, 'Configurer simplement')).click();
        let dialog = page.getByRole('dialog', { name: await text('Configurer mes finances'), exact: true });
        await dialog.waitFor();
        assert.equal(await (await button(dialog, 'Vérifier mes choix')).isDisabled(), true);
        assert.equal(await dialog.getByRole('radio').count(), 3);
        checks.push(await geometry(page, dialog, 'choice'));
        await page.screenshot({ path: fileURLToPath(new URL(`${name}-choice.png`, output)) });
        await dialog.locator('input[value="short"]').check();
        await (await button(dialog, 'Vérifier mes choix')).click();
        await dialog.getByText(await text('Vérifiez les réglages proposés'), { exact: true }).waitFor();
        const alternate = language === 'de' ? 'it' : 'de';
        await page.evaluate(async alternate => { await (await import('/src/language.ts')).setAppLanguage(alternate); }, alternate);
        await page.getByRole('dialog', { name: await text('Configurer mes finances'), exact: true }).getByText(await text('Vérifiez les réglages proposés'), { exact: true }).waitFor();
        await page.evaluate(async language => { await (await import('/src/language.ts')).setAppLanguage(language); }, language);
        dialog = page.getByRole('dialog', { name: await text('Configurer mes finances'), exact: true });
        await (await button(dialog, 'Retour')).click();
        assert.equal(await dialog.locator('input[value="short"]').isChecked(), true);
        await (await button(dialog, 'Vérifier mes choix')).click();
        checks.push(await geometry(page, dialog, 'review'));
        await page.screenshot({ path: fileURLToPath(new URL(`${name}-review.png`, output)) });
        await page.evaluate(() => { window.__financeFixture.records.failNext = true; });
        await (await button(dialog, 'Appliquer ces réglages')).click();
        await dialog.getByRole('alert').getByText(await text('La configuration n’a pas pu être enregistrée. Vos choix sont conservés.'), { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__financeFixture.records.writes.length), 0);
        checks.push(await geometry(page, dialog, 'save-error'));
        await (await button(dialog, 'Appliquer ces réglages')).click();
        dialog = page.getByRole('dialog', { name: await text('Votre configuration est enregistrée'), exact: true });
        await dialog.waitFor();
        await dialog.getByText(await text('Vous pouvez préparer vos documents'), { exact: true }).waitFor();
        const confirmation = await page.evaluate(async () => (await import('/src/language.ts')).t('{paymentDays} jours pour régler une facture, {validityDays} jours pour accepter un devis.', { paymentDays: 14, validityDays: 30 }));
        await dialog.getByText(confirmation, { exact: true }).waitFor();
        assert.ok(!(await dialog.innerText()).includes('{paymentDays}'));
        const proof = await page.evaluate(() => ({ initial: window.__financeFixture.initial.settings, written: window.__financeFixture.records.writes[0], attempts: window.__financeFixture.records.attempts }));
        assert.deepEqual(proof.written, { ...proof.initial, billing: { ...proof.initial.billing, paymentTermsDays: 14, quoteValidityDays: 30 } });
        assert.equal(proof.attempts, 2);
        checks.push(await geometry(page, dialog, 'saved'));
        await page.screenshot({ path: fileURLToPath(new URL(`${name}-saved.png`, output)) });
        await (await button(dialog, 'Préparer les comptes suisses')).click();
        assert.equal(await page.evaluate(() => window.__financeFixture.records.installations), 1);
        await (await button(dialog, 'Terminer')).click();
        await dialog.waitFor({ state: 'hidden' });
        await (await button(root, 'Configurer simplement')).click();
        dialog = page.getByRole('dialog', { name: await text('Configurer mes finances'), exact: true });
        await (await button(dialog, 'Plus tard')).click();
        await dialog.waitFor({ state: 'hidden' });
        await showScenario('readonly');
        assert.equal(await (await button(root, 'Configurer simplement')).isDisabled(), true);
        await showScenario('setup');
        await root.getByRole('heading', { name: await text('Préparez votre comptabilité'), exact: true }).waitFor();
        await (await button(root, 'Préparer les comptes')).click();
        await root.locator('.finance-first-step__secondary summary').click();
        await (await button(root, 'Choisir mes délais')).click();
        await page.getByRole('dialog').waitFor();
        await (await button(page.getByRole('dialog'), 'Plus tard')).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        for (const [scenario, source] of [
          ['loading', 'Actualisation des écritures…'], ['multicurrency', 'Plusieurs devises sont présentes sans conversion : consultez le détail par devise.'],
          ['loss', 'Perte de la période'], ['anomalies', 'Quelques opérations sont à vérifier'],
        ]) {
          await showScenario(scenario);
          // Mobile hides explanatory figure paragraphs; inspect their translated DOM text too.
          assert.ok((await root.textContent()).includes(await text(source)), `${scenario} translation`);
        }
        assert.deepEqual(errors, []);
        reports.push({ engine, language, width, scale, theme, checks, actualScreenNavigation: true, actions: ['income', 'accounts', 'vat', 'balance', 'closing', 'journal', 'configure', 'back', 'apply', 'retry', 'prepare_accounts', 'finish', 'later'], localeChangeKeepsSelection: true, onlyBillingTermsChanged: true, attempts: 2, writes: 1, readOnlyGuard: true, additionalStates: ['setup', 'loading', 'multicurrency', 'loss', 'anomalies'], errors });
        console.log(`${name}: functional checks passed; ${checks.filter(check => check.pageOverflow || check.clipped.length || check.outside.length).length} layout failure(s)`);
      } catch (error) {
        await page.screenshot({ path: fileURLToPath(new URL(`${name}-failure.png`, output)) });
        throw error;
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await writeFile(new URL('report.json', output), JSON.stringify({ synthetic: true, actualNativeWrites: 0, layoutFailures, reports }, null, 2));
  }
}
assert.deepEqual(layoutFailures, [], 'Layout failures remain recorded; this recipe is not a visual pass.');
