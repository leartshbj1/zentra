import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const out = fileURLToPath(new URL('../../.qa/accounting-entry-layout', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&payroll=1&designLedger=1`);
    await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
    await page.getByRole('button', { name: 'Saisir une écriture', exact: true }).click();
    const form = page.locator('.accounting-entry-form');
    await form.getByLabel('Description', { exact: false }).fill('Recette de mise en page');
    const first = form.getByRole('group', { name: 'Ligne 1', exact: true });
    const second = form.getByRole('group', { name: 'Ligne 2', exact: true });
    await first.getByLabel('Compte', { exact: false }).selectOption({ index: 1 });
    await second.getByLabel('Compte', { exact: false }).selectOption({ index: 2 });
    await first.getByLabel('Débit CHF', { exact: true }).fill('100.25');
    await first.getByLabel('Crédit CHF', { exact: true }).fill('50');
    assert.equal(await first.getByLabel('Débit CHF', { exact: true }).inputValue(), '');
    await first.getByLabel('Débit CHF', { exact: true }).fill('100.25');
    assert.equal(await first.getByLabel('Crédit CHF', { exact: true }).inputValue(), '');
    await second.getByLabel('Crédit CHF', { exact: true }).fill('100.25');
    assert.ok(await form.getByRole('button', { name: 'Comptabiliser', exact: true }).isEnabled());
    await first.locator('summary').click();
    await first.getByRole('combobox', { name: /^Projet/ }).selectOption({ index: 1 });
    const project = await first.getByRole('combobox', { name: /^Projet/ }).inputValue();
    await first.locator('summary').click();
    await first.getByLabel('Mémo', { exact: true }).fill('Référence conservée en refermant les rattachements');
    await first.locator('summary').click();
    assert.equal(await first.getByRole('combobox', { name: /^Projet/ }).inputValue(), project);
    await form.getByRole('button', { name: 'Ajouter une ligne', exact: true }).click();
    assert.equal(await form.getByRole('group', { name: /^Ligne [0-9]+$/ }).count(), 3);
    await form.getByRole('button', { name: 'Supprimer la ligne 3', exact: true }).click();
    assert.equal(await form.getByRole('group', { name: /^Ligne [0-9]+$/ }).count(), 2);
    assert.ok(await form.getByRole('button', { name: 'Supprimer la ligne 1', exact: true }).isDisabled());
    await second.locator('summary').click();
    const layout = await form.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('input,select,button,summary')].filter(el => el.getClientRects().length);
      return {
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        formOverflow: element.scrollWidth > element.clientWidth + 1,
        invalidControls: controls.filter(el => {
          const r = el.getBoundingClientRect();
          return r.left < rect.left - 1 || r.right > rect.right + 1 || r.height < 43 || parseFloat(getComputedStyle(el).fontSize) < 14;
        }).map(el => el.outerHTML.slice(0, 200)),
      };
    });
    assert.deepEqual(layout, { pageOverflow: false, formOverflow: false, invalidControls: [] });
    await first.screenshot({ path: `${out}/${width}-line.png` });
    await form.getByRole('button', { name: 'Annuler', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    report.push({ width, layout, amountsAndLinksPreserved: true, addRemoveAndCancel: true });
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
