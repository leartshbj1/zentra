import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const out = '.impeccable/review/financial-first-steps';
await mkdir(out, { recursive: true });
const results = [];

async function boot(browser, config, options = {}) {
  const page = await browser.newPage({ viewport: { width: config.width, height: 900 }, hasTouch: true, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith(origin) || r.request().url().startsWith('data:') ? r.continue() : r.abort());
  await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&financialStart=1&language=${config.lang}&theme=${config.theme}${options.bank ? '&bank=1&bankNoAccounting=1' : ''}`);
  await page.locator('.desktop-app').waitFor();
  const tr = source => page.evaluate(async source => (await import('/src/language.ts')).t(source), source);
  const later = page.getByRole('button', { name: await tr('Découvrir plus tard'), exact: true });
  if (await later.isVisible()) await later.click();
  if (config.scale) await page.evaluate(async () => (await import('/src/textSize.ts')).setTextSize(200));
  if (options.bank) await page.evaluate(async () => { const {desktopApi: api} = await import('/src/bridge.ts'); const workspace = await api.loadWorkspace(); (await import('/tests/bank-fixture.ts')).installBankFixture(() => workspace); api.loadWorkspace = async () => structuredClone(workspace); await window.__qaFinancialRefresh(); });
  if (options.readOnly) await page.evaluate(() => window.__qaSetReadOnly(true));
  const nav = async view => {
    if (view === 'reminders') {
      if (config.width <= 860) await page.locator('.menu-button').click();
      await page.locator('.sidebar__nav button').filter({ hasText: await tr('Relances') }).click();
    } else await page.evaluate(view => window.dispatchEvent(new CustomEvent('zentra-automation-navigate', { detail: view })), view);
    await page.locator(`.desktop-app[data-view=${view}]`).waitFor();
  };
  const capture = async name => {
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: overflow`);
    assert.deepEqual(errors, [], `${name}: JS errors`);
    if (!process.argv.includes('--verify-only') || name === 'bank-existing-unconfigured') await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    results.push({ name, ...config, errors: [...errors], overflow: false });
  };
  return { page, nav, tr, capture };
}

for (const config of [
  { engine: 'webkit', width: 390, theme: 'light', lang: 'fr' },
  { engine: 'webkit', width: 390, theme: 'dark', lang: 'de' },
  { engine: 'edge', width: 1440, theme: 'light', lang: 'it' },
  { engine: 'edge', width: 1440, theme: 'dark', lang: 'en' },
  { engine: 'webkit', width: 320, theme: 'dark', lang: 'de', scale: 2 },
]) {
  const browser = await (config.engine === 'edge' ? chromium : webkit).launch(config.engine === 'edge' ? { channel: 'msedge' } : {});
  try {
    const { page, nav, tr, capture } = await boot(browser, config);
    const prefix = `${config.engine}-${config.width}-${config.theme}-${config.lang}${config.scale ? '-200' : ''}`;
    await nav('accounting');
    await page.getByRole('heading', { name: await tr('Préparez votre comptabilité'), exact: true }).waitFor();
    assert.equal(await page.locator('.finance-overview__figures,.finance-overview__notice').count(), 0);
    if (config.lang !== 'fr') assert.notEqual(await tr('Préparez votre comptabilité'), 'Préparez votre comptabilité');
    await capture(`${prefix}-accounting`);
    await page.getByRole('button', { name: await tr('Préparer les comptes'), exact: true }).click();
    await page.locator('.accounting-setup').waitFor();
    await nav('bank'); await page.locator('.bank-screen .finance-first-step').waitFor();
    assert.equal(await page.locator('.bank-summary,.bank-movement-search,.bank-imports-panel').count(), 0);
    await capture(`${prefix}-bank`);
    await page.getByRole('button', { name: await tr('Importer un relevé XML'), exact: true }).click();
    await page.locator('.bank-workflow-modal').waitFor();
    await page.waitForFunction(() => document.querySelector('.bank-workflow-modal')?.contains(document.activeElement));
    await page.keyboard.press('Escape'); await page.locator('.bank-workflow-modal').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: await tr('Configurer la comptabilité'), exact: true }).click();
    await page.locator('.accounting-setup').waitFor();
    await nav('reminders'); await page.locator('.reminders-screen .finance-first-step').waitFor();
    assert.equal(await page.locator('.reminder-overview,.reminder-toolbar input[type=date],.reminder-command-center').count(), 0);
    await capture(`${prefix}-reminders`);
    await page.getByRole('button', { name: await tr('Configurer les relances'), exact: true }).click();
    await page.locator('.reminder-setup-step').waitFor();
    assert.equal(await page.locator('.reminder-setup-step input').count(), 1);
    await page.close();
  } finally { await browser.close(); }
}

const config = { engine: 'webkit', width: 390, theme: 'dark', lang: 'fr' };
const browser = await webkit.launch();
try {
  for (const state of ['paused', 'not-scanned', 'checked', 'existing-without-template', 'load-error', 'loading', 'read-only']) {
    const { page, nav, tr, capture } = await boot(browser, config, { readOnly: state === 'read-only' });
    await page.evaluate(async state => {
      const { desktopApi: api } = await import('/src/bridge.ts');
      let fail = state === 'load-error';
      api.getReminderSettings = async () => {
        if (state === 'loading') await new Promise(resolve => window.__releaseReminderRead = resolve);
        if (fail) { fail = false; throw new Error('Lecture de test interrompue.'); }
        return { enabled: state !== 'paused', senderName: 'Atelier test', lastScanAt: state === 'checked' ? '2026-09-27' : '' };
      };
      api.listReminderTemplates = async () => ['existing-without-template', 'read-only'].includes(state) ? [] : [{ id: 'template', level: 1, name: 'Rappel', subject: 'Rappel', body: 'Texte', daysAfterDue: 7, paymentDeadlineDays: 14, active: true }];
      api.listReminders = async () => state === 'existing-without-template' ? [{ id: 'existing', invoiceId: 'invoice', templateId: null, level: 1, scheduledDate: '2026-01-08', status: 'due', subject: 'Texte client conservé', body: 'Corps conservé', notes: '', invoiceNumber: 'F-NE-PAS-MASQUER', clientName: 'Client existant', dueDate: '2026-01-01', currency: 'CHF', invoiceTotalCents: 10000, balanceCents: 10000, liveBalanceCents: 10000, paymentDeadlineDays: 14 }] : [];
    }, state);
    await nav('reminders');
    if (state === 'loading') {
      await page.getByText(await tr('Chargement des relances…'), { exact: true }).waitFor();
      assert.equal(await page.locator('.reminders-screen .finance-first-step,.reminders-screen .empty-state').count(), 0);
      await capture('reminders-loading');
      await page.evaluate(() => window.__releaseReminderRead());
      await page.getByRole('heading', { name: 'Prêt pour le premier contrôle' }).waitFor();
    } else if (state === 'load-error') {
      await page.getByRole('button', { name: 'Réessayer le chargement' }).waitFor();
      assert.equal(await page.locator('.reminders-screen .finance-first-step,.reminders-screen .empty-state').count(), 0);
      await capture('reminders-error');
      await page.getByRole('button', { name: 'Réessayer le chargement' }).click();
      await page.getByRole('heading', { name: 'Prêt pour le premier contrôle' }).waitFor();
    } else if (state === 'existing-without-template') {
      await page.getByText('F-NE-PAS-MASQUER', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Prévisualiser', exact: true }).isEnabled(), true);
      await capture('reminders-existing-without-template');
    } else if (state === 'read-only') {
      await page.getByText('Un administrateur peut choisir les délais et les textes de relance.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Configurer les relances', exact: true }).count(), 0);
      await capture('reminders-read-only');
    } else {
      await page.getByRole('heading', { name: state === 'paused' ? 'Les relances sont en pause' : state === 'checked' ? 'Aucune relance à valider' : 'Prêt pour le premier contrôle' }).waitFor();
      await capture(`reminders-${state}`);
      if (state === 'paused') {
        assert.equal(await page.getByRole('button', { name: 'Vérifier maintenant' }).isDisabled(), true);
        await page.getByRole('button', { name: 'Ouvrir les réglages' }).click();
        await page.locator('#reminder-panel-settings').waitFor();
      }
    }
    await page.close();
  }
  for (const state of ['existing', 'load-error', 'read-only']) {
    const { page, nav, capture } = await boot(browser, config, { readOnly: state === 'read-only' });
    await page.evaluate(async state => {
      const { desktopApi: api } = await import('/src/bridge.ts');
      const original = api.getAccountingContinuity; let fail = state === 'load-error';
      api.getAccountingContinuity = async () => {
        if (fail) { fail = false; throw new Error('Lecture comptable de test interrompue.'); }
        return { ...await original(), journalEntryCount: state === 'existing' ? 2 : 0 };
      };
      const originalIncome = api.getIncomeStatement;
      api.getIncomeStatement = async (...args) => ({ ...await originalIncome(...args), revenueCents: 124500, expenseCents: 70000, profitCents: 54500 });
    }, state);
    await nav('accounting');
    if (state === 'existing') {
      await page.locator('.finance-overview__figures strong').first().filter({ hasText: '1' }).waitFor();
      assert.equal(await page.locator('.finance-first-step').count(), 0);
      assert.match(await page.locator('.finance-overview__figures').innerText(), /545/);
    } else if (state === 'load-error') {
      await page.getByText('Lecture comptable de test interrompue.', { exact: false }).waitFor();
      assert.equal(await page.locator('.finance-first-step,.finance-overview__figures').count(), 0);
      await capture('accounting-error-before-retry');
      await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
      await page.locator('.finance-first-step').waitFor();
    } else {
      await page.getByRole('button', { name: 'Voir la configuration', exact: true }).click();
      await page.locator('.accounting-setup').waitFor();
      assert.equal(await page.locator('.accounting-setup input:not([disabled]),.accounting-setup select:not([disabled])').count(), 0);
    }
    await capture(`accounting-${state}`); await page.close();
  }
  const { page, nav, capture } = await boot(browser, config, { bank: true });
  await nav('bank'); await page.locator('.bank-screen .finance-first-step').waitFor();
  await page.getByRole('button', { name: 'Importer un relevé XML', exact: true }).click();
  await page.getByRole('button', { name: 'Choisir le relevé XML', exact: true }).click();
  await page.locator('.bank-import-option input').uncheck();
  await page.getByRole('button', { name: 'Importer ce relevé', exact: true }).click();
  await page.getByRole('button', { name: 'Voir les mouvements à vérifier', exact: true }).click();
  await page.locator('.bank-movement').first().waitFor();
  assert.equal(await page.locator('.finance-first-step').count(), 0);
  assert.equal(await page.locator('.bank-movement-search').isVisible(), true);
  await page.getByText('Comptabilité requise pour rapprocher', { exact: true }).waitFor();
  await capture('bank-existing-unconfigured'); await page.close();
} finally { await browser.close(); }
await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ passed: results.length, results }));
