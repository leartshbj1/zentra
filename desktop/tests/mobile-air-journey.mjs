import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5273';
const out = '.qa/mobile-air';
await mkdir(out, { recursive: true });
const report = [];
const screens = [
  ['dashboard', 'Tableau de bord'], ['agenda', 'Agenda'], ['projects', 'Projets'],
  ['clients', 'Clients'], ['catalog', 'Produits & services'], ['quotes', 'Ventes'],
  ['reminders', 'Relances'], ['time', 'Temps'], ['team', 'Équipe & salaires'],
  ['expenses', 'Achats & fournisseurs'], ['bank', 'Banque'], ['reports', 'Rapports'],
  ['accounting', 'Comptabilité'], ['settings', 'Paramètres'],
];
const core = new Set(['dashboard', 'projects', 'quotes', 'team', 'accounting', 'settings']);
let page;
async function translate(text) { return page.evaluate(async text => (await import('/src/language.ts')).t(text), text); }
async function navigate(label) {
  await page.locator('.menu-button').click();
  const localized = await translate(label);
  const result = page.locator('.sidebar__nav button').filter({ hasText: localized }).first();
  await result.click();
  await page.waitForTimeout(100);
}
async function settle() {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.activeElement?.blur?.();
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    await new Promise(requestAnimationFrame);
  });
}
async function theme(value) {
  await page.evaluate(async value => (await import('/src/appearance.ts')).setAppearance(value), value);
  await page.waitForTimeout(220);
  await settle();
}
async function palette() {
  return page.locator('.page-content').evaluate(root => [...root.querySelectorAll('*')].map(el => {
    const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderTopColor, s.boxShadow];
  }));
}
async function layout(label) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: page overflow`);
  const clipped = await page.locator('.page-content').evaluate(root => [...root.querySelectorAll('button,summary,input,select,h1,h2,h3,strong')].filter(el => {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return false;
    // Wide ledgers may intentionally scroll inside their own table panel.
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth + 1) return false;
    }
    return r.left < -2 || r.right > innerWidth + 2;
  }).map(el => el.className + ':' + el.textContent.slice(0, 70)));
  assert.deepEqual(clipped, [], `${label}: clipped controls or titles`);
}
for (const engine of ['chromium', 'webkit']) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const cases = process.env.ZENTRA_QA_DETAILS_ONLY ? [] : engine === 'chromium'
      ? [[390,844,'fr'],[320,568,'de'],[390,844,'it'],[390,844,'en'],[844,390,'fr']]
      : [[390,844,'fr'],[320,568,'de']];
    for (const [width,height,lang] of cases) {
      page = await browser.newPage({ viewport: { width,height }, hasTouch: true, reducedMotion: 'reduce' });
      page.setDefaultTimeout(12000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(lang => localStorage.setItem('zentra.interface.language.v1', lang), lang);
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
      await page.getByRole('button', { name: await translate('Fermer le guide automatique'), exact: true }).click();
      for (const [id,label] of screens.filter(([id]) => width === 390 && lang === 'fr' || core.has(id))) {
        if (id !== 'dashboard') await navigate(label);
        await settle();
        await layout(`${engine}/${width}/${lang}/${id}`);
        await theme('light'); const light = await palette();
        await theme('dark');
        await layout(`${engine}/${width}/${lang}/${id}/dark`);
        if (width === 390 && lang === 'fr') await page.screenshot({ path: `${out}/${engine}-${id}-dark.png` });
        await theme('light');
        assert.deepEqual(await palette(), light, `${id}: light palette restored completely`);
        if (core.has(id)) await page.screenshot({ path: `${out}/${engine}-${width}-${lang}-${id}.png` });
        report.push({ engine,width,height,lang,screen:id,overflow:false,themeRoundTrip:true });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    page = await browser.newPage({ viewport: { width:390,height:844 }, hasTouch:true, reducedMotion:'reduce' });
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&companyCreators=1`);
    await page.getByRole('button', { name: 'Fermer le guide automatique', exact:true }).click();
    const currency = page.getByLabel('Devise du résumé');
    const initial = await page.locator('.mobile-home__amount').innerText();
    await currency.selectOption('EUR');
    assert.notEqual(await page.locator('.mobile-home__amount').innerText(), initial, 'currencies are separate');
    const breakdown = page.locator('.mobile-home__balance details');
    await breakdown.locator('summary').click();
    assert.ok(await breakdown.getByText(/solde bancaire/).isVisible());
    await navigate('Ventes');
    const first = page.locator('.sales-documents tbody tr').first();
    const firstId = await first.locator('.sales-document__identity').innerText();
    assert.equal(await first.locator('.document-actions .button--icon').first().isVisible(), false);
    await first.locator('summary').click();
    assert.ok(await first.locator('.mobile-document-metadata').isVisible());
    assert.ok(await first.locator('.document-actions .button--icon').first().isVisible());
    await first.locator('summary').click();
    assert.equal(await first.locator('.sales-document__identity').innerText(), firstId);
    await first.locator('.document-preview-action').click();
    await page.locator('[data-touch-document]').waitFor();
    assert.ok(await page.locator('[data-touch-document]').isVisible());
    await page.getByRole('button', { name:/Fermer/ }).first().click();
    await first.locator('summary').click();
    await first.locator('.document-actions .button--icon').first().click();
    await page.locator('.document-assistant').waitFor();
    assert.ok(await page.locator('.document-assistant').isVisible(), 'existing edit handler remains reachable');
    await page.close();
    report.push({ engine,documentActions:true,documentPreview:true,separateCurrencies:true });
    page = await browser.newPage({ viewport: { width:320,height:568 }, hasTouch:true, reducedMotion:'reduce' });
    await page.addInitScript(() => localStorage.setItem('zentra.interface.language.v1', 'de'));
    await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
    await page.getByRole('button', { name:await translate('Fermer le guide automatique'), exact:true }).click();
    await navigate('Ventes');
    const actions = page.locator('.document-actions').first();
    await actions.locator('summary').click();
    await actions.locator('.button--icon[title="Bearbeiten"]').waitFor();
    await layout(`${engine}: translated expanded actions`);
    await page.evaluate(async () => {
      const api = window.__qaDesktopApi;
      const continuity = await api.getAccountingContinuity();
      const income = await api.getIncomeStatement({});
      api.getAccountingContinuity = async () => ({ ...continuity,enabled:true,mappingReady:true,journalEntryCount:4 });
      api.getIncomeStatement = async () => ({ ...income,revenueCents:123456789012,expenseCents:234567890123,profitCents:-111111101111 });
    });
    await navigate('Comptabilité');
    await page.waitForFunction(() => document.querySelectorAll('.finance-overview__figures article').length === 3);
    await layout(`${engine}: large accounting amounts`);
    const amounts = await page.locator('.finance-overview__figures strong').allTextContents();
    assert.ok(amounts.every(amount => amount.includes('CHF')), 'the currency remains visible');
    await page.screenshot({ path:`${out}/${engine}-large-amounts.png` });
    await page.locator('.finance-overview > details > summary').click();
    assert.ok(await page.locator('.finance-overview__learn dl').isVisible(), 'definitions remain available');
    await page.close();
    report.push({ engine,largeAmounts:true,translatedActions:true,financialDefinitions:true });
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path:`${out}/failure-${engine}.png` });
      await writeFile(`${out}/failure-${engine}.txt`, await page.locator('body').innerText());
    }
    throw error;
  } finally { await browser.close(); await writeFile(`${out}/${process.env.ZENTRA_QA_DETAILS_ONLY ? 'details-report' : 'report'}.json`, JSON.stringify(report,null,2)); }
}
console.log(JSON.stringify({ passed:report.length,report }));
