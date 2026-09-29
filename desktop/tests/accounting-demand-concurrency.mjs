import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ZENTRA_QA_BROWSER || 'edge';
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5377';
const before = process.argv.includes('--before');
const out = new URL('../.qa/accounting-demand/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine !== 'webkit' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const results = [];
const errors = [];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function fixture(journal = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
  await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
  await page.evaluate(async journal => {
    const { desktopApi: api } = await import('/src/bridge.ts');
    const continuity = api.getAccountingContinuity;
    api.getAccountingContinuity = async () => ({ ...await continuity(), enabled: true, mappingReady: true, journalEntryCount: 1 });
    const entry = { id: 'journal-exact', number: 'J-FICTIF-42', entryDate: '2026-03-14', description: 'Écriture fictive exacte', sourceType: 'manual', sourceId: null, sourceEvent: null, status: 'posted', reversalOf: null, hasReversal: false };
    const report = await api.getJournal({});
    window.__journalCalls = 0;
    window.__reversalAttempts = 0;
    window.__journalControl = '';
    api.getJournal = async () => {
      window.__journalCalls++;
      const control = window.__journalControl;
      window.__journalControl = '';
      if (control === 'reject') throw new Error('Journal fictif indisponible.');
      if (control === 'deferred-reject') await new Promise((resolve, reject) => { window.__journalReject = () => reject(new Error('Reprise fictive du journal refusée.')); });
      return { ...report, entries: [entry], lines: [] };
    };
    api.reverseJournalEntry = async () => { window.__reversalAttempts++; window.__journalControl = 'reject'; };
    api.exportAnnualAccountsPdf = async () => ({ path: 'fictif.pdf', pages: 1, closed: false, balanced: true, deliveryWarning: 'Partage fictif requis.' });
    api.shareExistingExport = async () => new Promise(resolve => { window.__shareRelease = resolve; });
    const income = api.getIncomeStatement;
    api.getIncomeStatement = async (...args) => {
      if (window.__holdIncome) {
        window.__holdIncome = false;
        await new Promise(resolve => { window.__readRelease = resolve; });
      }
      return income(...args);
    };
    window.__focusFixture = await (await import('/tests/accounting-demand-focus.tsx')).mountFocusTest(journal ? { entryId: entry.id, entryNumber: entry.number, entryDate: entry.entryDate, paymentId: 'payment-fictif', accountingState: 'active' } : null);
  }, journal);
  const panel = page.locator('#accounting-demand-focus');
  if (journal) await page.waitForFunction(() => document.activeElement?.getAttribute('data-journal-entry-id') === 'journal-exact');
  else await page.waitForFunction(() => document.querySelector('#accounting-demand-focus .finance-overview__figures')?.getAttribute('aria-busy') === 'false');
  return { page, panel };
}

async function section(panel, tab) {
  const labels = { overview: 'Vue d’ensemble', income: 'Résultat' };
  const picker = panel.getByRole('combobox', { name: 'Section comptable', exact: true });
  if (labels[tab] && await picker.isVisible()) await picker.selectOption(tab);
  else if (labels[tab]) await panel.getByRole('tab', { name: labels[tab], exact: true }).click();
  else await panel.getByRole('combobox', { name: 'Autres outils comptables', exact: true }).selectOption(tab);
}

try {
  {
    const { page, panel } = await fixture(true);
    await panel.getByRole('button', { name: 'Extourner', exact: true }).click();
    await page.getByRole('dialog', { name: 'Extourner une écriture' }).getByRole('button', { name: 'Créer l’extourne', exact: true }).click();
    const retry = panel.getByRole('button', { name: 'Actualiser les états', exact: true });
    await retry.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('#accounting-demand-focus button')].some(button => button.textContent.trim() === 'Actualiser les états' && !button.disabled));
    await page.evaluate(() => { window.__journalControl = 'deferred-reject'; });
    await retry.click();
    await page.waitForFunction(() => typeof window.__journalReject === 'function');
    await section(panel, 'accounts');
    await page.evaluate(() => window.__journalReject());
    await settle(page);
    const guardRetained = await retry.count() === 1;
    assert.equal(guardRetained, !before, 'A superseded failed read must not clear the reversal guard');
    if (!before) {
      await panel.getByRole('alert').filter({ hasText: 'Reprise fictive du journal refusée.' }).waitFor();
      const callsBeforeRetry = await page.evaluate(() => window.__journalCalls);
      await retry.click();
      await retry.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.__journalCalls), callsBeforeRetry + 1, 'Recovery from accounts requires an explicit successful journal read');
    }
    assert.equal(await page.evaluate(() => window.__reversalAttempts), 1, 'Retry must never repeat the recorded reversal');
    results.push({ step: 'failed-journal-recovery-after-navigation', guardRetained, reversalAttempts: 1, successfulRetryVerified: !before });
    await page.close();
  }
  for (const first of ['share', 'read']) {
    const { page, panel } = await fixture();
    await section(panel, 'income');
    await panel.getByRole('button', { name: 'Exporter le bilan PDF', exact: true }).click();
    await panel.getByRole('button', { name: 'Partager le PDF', exact: true }).click();
    await page.waitForFunction(() => typeof window.__shareRelease === 'function');
    await page.evaluate(() => { window.__holdIncome = true; });
    await section(panel, 'overview');
    await page.waitForFunction(() => typeof window.__readRelease === 'function');
    const figures = panel.locator('.finance-overview__figures');
    assert.equal(await figures.getAttribute('aria-busy'), 'true');
    await page.evaluate(first => window[first === 'share' ? '__shareRelease' : '__readRelease'](), first);
    await settle(page);
    const busyAfterFirstCompletion = await figures.getAttribute('aria-busy') === 'true';
    assert.equal(busyAfterFirstCompletion, !before, `${first} completion must keep the other operation busy`);
    await page.evaluate(first => window[first === 'share' ? '__readRelease' : '__shareRelease'](), first);
    await page.waitForFunction(() => document.querySelector('#accounting-demand-focus .finance-overview__figures')?.getAttribute('aria-busy') === 'false');
    await panel.getByRole('status').filter({ hasText: 'Partage du PDF ouvert.' }).waitFor();
    results.push({ step: `pdf-share-and-navigation-${first}-finishes-first`, busyAfterFirstCompletion, busyAfterBoth: false });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL(before ? 'concurrency-before.json' : `concurrency-after-${engine}.json`, out), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
