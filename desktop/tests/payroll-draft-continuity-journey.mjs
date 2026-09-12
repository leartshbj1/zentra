// Synthetic UI acceptance; the native draft round-trip test checks SQLite persistence.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5196';
const output = '.qa/payroll-draft-continuity';
await mkdir(output, { recursive: true });
const results = [];
const calls = (page) =>
  page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('qa-payroll-save') || '[]'),
  );
async function open(page, setup = true) {
  await page.goto(
    `${base}/tests/mobile-harness.html?payroll=1${setup ? '&payrollSetup=1' : ''}`,
  );
  await page
    .getByRole('button', { name: 'Fermer le guide automatique', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Aller à un écran', exact: true })
    .click();
  await page
    .getByRole('searchbox', { name: 'Rechercher un écran' })
    .fill('Équipe & salaires');
  await page
    .locator('.navigation-palette__results button')
    .filter({ has: page.getByText('Équipe & salaires', { exact: true }) })
    .click();
  await page
    .locator('.team-navigation')
    .getByRole('button', { name: /Fiches de salaire/ })
    .click();
  await page
    .getByRole('button', { name: 'Nouvelle fiche', exact: true })
    .click();
  const modal = page.locator('.payroll-dialog');
  await modal
    .getByRole('combobox', { name: /^Collaborateur/ })
    .selectOption('elodie');
  await modal.locator('[name=period]').fill('2026-09');
  await modal.locator('[name=paymentDate]').fill('2026-09-30');
  await modal.getByRole('button', { name: 'Continuer', exact: true }).click();
  return modal;
}
async function geometry(page) {
  const result = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    overflowing: [
      ...document.querySelectorAll(
        '.payroll-save-later,.payroll-dialog,.modal__body',
      ),
    ]
      .filter(
        (node) =>
          node.getBoundingClientRect().width &&
          node.scrollWidth > node.clientWidth + 1,
      )
      .map((node) => node.className),
  }));
  assert.ok(
    result.document <= result.width && !result.overflowing.length,
    JSON.stringify(result),
  );
}
for (const [engine, type, widths] of [
  ['edge', chromium, [320, 390, 1440]],
  ['webkit', webkit, [390]],
]) {
  const browser = await type.launch({
    headless: true,
    ...(engine === 'edge' && process.platform === 'win32'
      ? { channel: 'msedge' }
      : {}),
  });
  try {
    for (const width of widths) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        reducedMotion: 'reduce',
      });
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        const modal = await open(page);
        const salary = modal.getByRole('spinbutton', {
          name: 'Salaire brut du mois (CHF)',
          exact: true,
        });
        const draft = modal.getByRole('button', {
          name: 'Enregistrer le salaire en brouillon',
          exact: true,
        });
        await salary.fill('5123.45');
        // This action is available without first triggering a validation failure.
        await draft.click();
        await modal.waitFor({ state: 'hidden' });
        const savedId = await page.evaluate(() =>
          sessionStorage.getItem('qa-payroll-saved-id'),
        );
        await page
          .getByRole('button', { name: 'Reprendre', exact: true })
          .click();
        await modal
          .getByRole('button', { name: 'Continuer', exact: true })
          .click();
        assert.equal(await salary.inputValue(), '5123.45');
        await salary.fill('5345.67');
        await modal
          .getByRole('button', { name: 'Vérifier le salaire', exact: true })
          .click();
        await modal.locator('.payroll-preparation').waitFor();
        await geometry(page);
        await draft.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${output}/${engine}-${width}-resume.png`,
        });
        await page.evaluate(() =>
          sessionStorage.setItem('qa-payroll-refuse-save', '1'),
        );
        await draft.click();
        await modal.locator('.payroll-problem').first().waitFor();
        assert.equal(await salary.inputValue(), '5345.67');
        await page.evaluate(() => {
          sessionStorage.removeItem('qa-payroll-refuse-save');
          sessionStorage.setItem('qa-payroll-hold-save', '1');
        });
        // Rapid clicks while SQLite/write+refresh is pending must remain one logical save.
        await draft.evaluate((button) => {
          button.click();
          button.click();
        });
        await page.waitForFunction(
          () => sessionStorage.getItem('qa-payroll-waiting-save') === '1',
        );
        assert.equal((await calls(page)).length, 3); // creation, failed edit, successful edit
        await page.keyboard.press('Escape');
        assert.ok(await modal.isVisible());
        await page.evaluate(() =>
          sessionStorage.removeItem('qa-payroll-hold-save'),
        );
        await modal.waitFor({ state: 'hidden' });
        const writes = await calls(page);
        assert.equal(writes.at(-1).existingId, savedId);
        assert.equal(writes.at(-1).lines[0].amountCents, 534567);
        assert.equal(writes.at(-1).data.status, 'draft');
        assert.deepEqual(writes.at(-1).selections, []);
        await page.getByRole('combobox', { name: 'État des fiches de salaire', exact: true }).selectOption('draft');
        assert.equal(await page.locator('.payslip-list > article').count(), 1);
        assert.equal(await page.locator(`[data-payslip-id="${savedId}"]`).count(), 1);
        assert.ok(await page.getByText('À calculer', { exact: true }).isVisible());
        await page
          .getByRole('button', { name: 'Reprendre', exact: true })
          .click();
        await modal
          .getByRole('button', { name: 'Continuer', exact: true })
          .click();
        assert.equal(await salary.inputValue(), '5345.67');
        assert.deepEqual(errors, []);
        results.push({
          engine,
          width,
          resumableDraft: true,
          failedEditPreserved: true,
          noDuplicate: true,
          busyClosePrevented: true,
        });
      } catch (error) {
        await page.screenshot({
          path: `${output}/${engine}-${width}-failure.png`,
        });
        throw error;
      } finally {
        await page.close();
      }
    }
    // An already calculated slip must never offer the partial save that omits contributions.
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    try {
      const modal = await open(page, false);
      await modal
        .getByRole('button', { name: 'Vérifier le salaire', exact: true })
        .click();
      await modal.locator('[data-payroll-step="2"]').waitFor();
      await modal.locator('[name=validated]').uncheck();
      await modal
        .getByRole('button', { name: 'Enregistrer la fiche', exact: true })
        .click();
      await modal.waitFor({ state: 'hidden' });
      assert.ok((await calls(page))[0].selections.length > 0);
      const row = page.locator('.payslip-list > article').first();
      await row.getByRole('button', { name: 'Modifier', exact: true }).click();
      await modal
        .getByRole('button', { name: 'Continuer', exact: true })
        .click();
      assert.equal(
        await modal
          .getByRole('button', {
            name: 'Enregistrer le salaire en brouillon',
            exact: true,
          })
          .count(),
        0,
      );
      results.push({ engine, storedContributionsProtected: true });
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(`${output}/report.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
