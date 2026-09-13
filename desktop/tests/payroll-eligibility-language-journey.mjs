import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium', origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5271';
const { [engine]: driver } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const languages = (process.env.ZENTRA_QA_LANGUAGES || 'fr,de,it,en').split(','), output = `.qa/payroll-eligibility-language-${engine}`, report = [];
await mkdir(output, { recursive: true });
async function tr(page, source, values) { return page.evaluate(async ({ source, values }) => { const url = performance.getEntriesByType('resource').map(entry => entry.name).findLast(url => new URL(url).pathname === '/src/language.ts') || '/src/language.ts'; return (await import(url)).t(source, values); }, { source, values }); }
async function change(page, language) { await page.evaluate(language => { const key = 'zentra.interface.language.v1'; localStorage.setItem(key, language); window.dispatchEvent(new StorageEvent('storage', { key, newValue: language })); }, language); await page.waitForFunction(language => document.documentElement.lang === `${language}-CH`, language); }
const calls = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-payroll-calculate') || '[]'));
const format = (page, value, language, options) => page.evaluate(({ value, language, options }) => value.toLocaleString(`${language}-CH`, options), { value, language, options });
const scenario = (page, name) => page.evaluate(name => window.dispatchEvent(new CustomEvent('qa-eligibility-scenario', { detail: name })), name);
async function geometry(page, label) {
  const issues = await page.locator('.payroll-dialog').evaluate(root => {
    const errors = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('document');
    for (const el of root.querySelectorAll('.modal__body,.payroll-eligibility,.payroll-eligibility__facts,.payroll-eligibility__facts span,.payroll-eligibility__facts strong,.payroll-eligibility__issues p,.payroll-problem,button,summary')) {
      if (!el.getClientRects().length || !el.clientWidth) continue;
      if (el.scrollWidth > el.clientWidth + 2) errors.push(`${el.className}: ${el.textContent.slice(0, 80)}`);
      if (el.matches('.payroll-eligibility__facts span,.payroll-eligibility__facts strong') && getComputedStyle(el).whiteSpace === 'nowrap') errors.push('fact would truncate');
    }
    return errors;
  });
  assert.deepEqual(issues, [], label);
}
try { for (const [width, height] of [[320,568], [390,844], [844,390], [1440,1000]]) for (const language of languages) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' }), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(language => localStorage.setItem('zentra.interface.language.v1', language), language);
  try {
    await page.goto(`${origin}/tests/payroll-eligibility-language.html`);
    const modal = page.locator('.payroll-dialog');
    const button = async (name, scope = modal) => scope.getByRole('button', { name: await tr(page, name), exact: true });
    await (await button('Continuer')).click();
    const salary = modal.locator('[data-payroll-salary-entry] .payroll-salary input');
    await salary.fill('5123.45'); await (await button('Vérifier le salaire')).click();
    await modal.locator('.payroll-net').waitFor();
    await modal.locator('[name=notes]').fill('Texte utilisateur {v0}\nÀ confirmer');
    const details = modal.locator('details').filter({ has: page.locator('summary').filter({ hasText: await tr(page, 'Contrôles détaillés') }) }).last();
    await details.locator(':scope > summary').click();
    const facts = modal.locator('.payroll-eligibility__facts');
    await facts.waitFor(); assert.equal(await facts.locator(':scope > div').count(), 13);
    const fact = async source => facts.locator(':scope > div').filter({ has: page.locator('span', { hasText: await tr(page, source) }) }).locator('strong');
    assert.equal(await (await fact('Salaire annuel LPP confirmé')).innerText(), await format(page, 60000, language, { style: 'currency', currency: 'CHF' }));
    assert.equal(await (await fact('Horaire contractuel')).innerText(), await tr(page, '{v0} h/semaine', { v0: await format(page, 2395 / 60, language, { maximumFractionDigits: 2 }) }));
    assert.ok((await (await fact('Décision petits salaires')).innerText()).includes(await tr(page, 'Seuil annuel de {v0} dépassé', { v0: await format(page, 2500, language, { style: 'currency', currency: 'CHF' }) })));
    const initialCalls = await calls(page), alternate = language === 'de' ? 'it' : 'de';
    await change(page, alternate); assert.equal(await modal.locator('[name=notes]').inputValue(), 'Texte utilisateur {v0}\nÀ confirmer'); assert.equal(await salary.inputValue(), '5123.45');
    await change(page, language); assert.deepEqual(await calls(page), initialCalls);
    await facts.scrollIntoViewIfNeeded(); await geometry(page, 'complete facts'); await page.screenshot({ path: `${output}/${language}-${width}-facts.png` });
    await scenario(page, 'expired');
    const reference = 'Police-{v0}-{v2}-' + 'RéférenceLongue'.repeat(10);
    const expired = await tr(page, 'La date réglementaire {v0} sort de la fenêtre du règlement LPP {v1} ({v2} à {v3}).', { v0: '2026-09-30', v1: reference, v2: '2026-01-01', v3: '2026-08-31' });
    await modal.locator('.payroll-eligibility__issues.is-blocking p').filter({ hasText: expired }).waitFor();
    const problem = modal.locator('.payroll-problem').first();
    await problem.getByText(await tr(page, 'Voir le message détaillé'), { exact: true }).click();
    assert.ok((await problem.innerText()).includes(expired));
    await change(page, alternate);
    const alternateExpired = await tr(page, 'La date réglementaire {v0} sort de la fenêtre du règlement LPP {v1} ({v2} à {v3}).', { v0: '2026-09-30', v1: reference, v2: '2026-01-01', v3: '2026-08-31' });
    assert.ok((await problem.innerText()).includes(alternateExpired));
    await change(page, language);
    await geometry(page, 'long contract reference'); await modal.locator('.payroll-eligibility__issues.is-blocking').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${output}/${language}-${width}-expired.png` });
    await problem.getByRole('button').click(); await modal.locator('.payroll-setup [name=contractNumber]').waitFor();
    assert.equal(await modal.locator('[name=contractNumber]').inputValue(), reference);
    await modal.locator('.payroll-setup-return').count().then(async count => { if (count) await modal.locator('.payroll-setup-return').click(); else await (await button('← Revenir au salaire')).click(); });
    await facts.waitFor();
    for (const [name, message] of [
      ['reference-age', 'Dès 64 ans, renseignez une date/validation explicite de l’âge de référence confirmée par la caisse ou la fiduciaire; Zentra ne la déduit pas du sexe.'],
      ['missing-person', 'La date de naissance manque; Zentra ne peut pas contrôler AVS, AC et LPP.'],
    ]) { await scenario(page, name); await modal.locator('.payroll-eligibility__issues.is-blocking p').filter({ hasText: await tr(page, message) }).waitFor(); await geometry(page, name); }
    assert.equal(await modal.locator('[name=notes]').inputValue(), 'Texte utilisateur {v0}\nÀ confirmer');
    assert.equal(await salary.inputValue(), '5123.45'); assert.deepEqual(await calls(page), initialCalls); assert.deepEqual(errors, []);
    report.push({ language, width, height, facts: 13, longReferencePreserved: true, pensionCorrectionNavigation: true, languageKeepsDraftAndCalculation: true, noHorizontalOverflow: true });
    console.log(`${engine} ${language} ${width}: passed`);
  } catch (error) { await page.screenshot({ path: `${output}/failure-${language}-${width}.png` }); await writeFile(`${output}/failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}`); throw error; }
  finally { await page.close(); }
} } finally { await writeFile(`${output}/report${languages.length === 4 ? '' : '-' + languages.join('-')}.json`, JSON.stringify(report, null, 2)); await browser.close(); }
