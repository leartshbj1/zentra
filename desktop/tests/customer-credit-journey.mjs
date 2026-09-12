import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ZENTRA_QA_BROWSER === 'webkit' ? 'webkit' : 'edge';
const out = fileURLToPath(new URL(`../../.qa/customer-credit-${engine}`, import.meta.url));
await mkdir(out, { recursive: true });
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
  ...(engine !== 'webkit' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
try {
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&customerCredits=1`);
    if (width > 860) await page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true }).click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Factures');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Factures', { exact: true }) }).click();
    const row = page.locator('.sales-documents tbody tr').filter({ hasText: 'Avoir à vérifier' });
    await row.getByRole('button', { name: 'Modifier', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const date = dialog.getByLabel('Date d’émission');
    const rate = dialog.getByRole('combobox', { name: 'Taux TVA', exact: true });
    assert.equal(await date.getAttribute('min'), '2026-02-15');
    assert.equal(await date.inputValue(), '2026-02-01');
    assert.equal(await rate.inputValue(), '810', 'an existing choice must not silently change');
    assert.equal(await rate.locator('option[value="810"]').evaluate(option => option.disabled), true);
    assert.deepEqual(await rate.locator('option:not(:disabled)').evaluateAll(els => els.map(el => el.value)), ['', '250']);
    await rate.selectOption('250');
    await dialog.getByRole('button', { name: /Enregistrer.*brouillon/i }).click();
    // WebKit can expose date fields as text; the application validates the
    // same boundary when native constraint validation is unavailable.
    assert.ok(await date.evaluate(el => el.validity.rangeUnderflow)
      || await dialog.getByText('La date de l’avoir ne peut pas précéder celle de la facture originale.', { exact: true }).isVisible());
    assert.equal(await page.evaluate(() => sessionStorage.getItem('customer-credit-save')), null);
    assert.ok(await dialog.isVisible());
    // Exercise the application guard even when the browser normally stops the
    // submit first. The same error must be revealed again after a second attempt.
    await dialog.locator('form').evaluate(form => { form.noValidate = true; });
    for (let attempt = 0; attempt < 2; attempt++) {
      await dialog.getByRole('button', { name: /Enregistrer.*brouillon/i }).click();
      await page.waitForFunction(() => {
        const panel = document.querySelector('.modal .error-panel');
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        const header = document.querySelector('.modal__header').getBoundingClientRect();
        const actions = document.querySelector('.modal .form-actions').getBoundingClientRect();
        return rect.top >= header.bottom && rect.bottom <= actions.top && rect.bottom <= innerHeight;
      });
      assert.equal(await page.evaluate(() => sessionStorage.getItem('customer-credit-save')), null);
      if (attempt === 0) await dialog.getByLabel('Notes / texte complémentaire').scrollIntoViewIfNeeded();
    }
    await page.screenshot({ path: `${out}/${width}-error.png` });
    await date.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/${width}-dates.png` });
    await date.fill('2026-02-15');
    await rate.scrollIntoViewIfNeeded();
    assert.equal(await dialog.getByRole('textbox', { name: 'Prix unitaire', exact: true }).inputValue(), '100');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: `${out}/${width}-rate.png` });
    await dialog.getByRole('button', { name: /Enregistrer.*brouillon/i }).click();
    await dialog.waitFor({ state: 'detached' });
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('customer-credit-save')));
    assert.equal(saved[1].issueDate, '2026-02-15');
    assert.equal(saved[1].type, 'credit_note');
    assert.equal(saved[2][0].vatRateBp, 250);
    assert.equal(saved[2][0].unitPriceCents, 10000);
    assert.ok(saved[1].originalInvoiceId);
    await row.getByRole('button', { name: 'Modifier', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-02-15');
    assert.equal(await rate.inputValue(), '250');
    assert.deepEqual(errors, []);
    report.push({ width, oldRatePreserved: true, originalRateAvailable: true, invalidDateNotSaved: true, repeatedErrorVisibleAboveActions: true,
      correctionSavedAndReopened: true, globalAndDialogOverflow: false, pageErrors: errors });
    await page.close();
  }
  await writeFile(`${out}/report.json`, JSON.stringify({ engine, cases: report }, null, 2));
  process.stdout.write(JSON.stringify({ engine, passed: report.length }));
} catch (error) {
  const page = browser.contexts().flatMap(context => context.pages()).at(-1);
  if (page) {
    await page.screenshot({ path: `${out}/failure.png` });
    await writeFile(`${out}/failure.txt`, await page.locator('body').innerText());
  }
  throw error;
} finally { await browser.close(); }
