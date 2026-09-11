import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(import.meta.url)(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5193';
const report = [],
  errors = [];
await mkdir('.qa/payroll-repair', { recursive: true });
for (const [engine, type] of [
  ['edge', chromium],
  ['webkit', webkit],
]) {
  const browser = await type.launch({
    ...(engine === 'edge' && process.platform === 'win32'
      ? { channel: 'msedge' }
      : {}),
  });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      page.setDefaultTimeout(12000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (/same key/.test(message.text())) errors.push(message.text());
      });
      try {
        await page.goto(
          `${base}/tests/mobile-harness.html?payroll=1&payrollHistoryError=1`,
        );
        await page
          .getByRole('button', {
            name: 'Fermer le guide automatique',
            exact: true,
          })
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
        const modal = page.locator('.payroll-dialog'),
          setup = modal.locator('.payroll-setup');
        await modal
          .getByRole('combobox', { name: /^Collaborateur/ })
          .selectOption('elodie');
        await modal.locator('[name=period]').fill('2026-09');
        await modal
          .getByRole('button', { name: 'Continuer', exact: true })
          .click();
        await modal
          .getByRole('spinbutton', {
            name: 'Salaire brut du mois (CHF)',
            exact: true,
          })
          .fill('5123.45');
        await modal
          .getByText('Vérifier les cotisations et leurs bases', { exact: true })
          .click();
        const basis = modal.getByRole('spinbutton', {
          name: 'Base de calcul (CHF) · AAP TEST',
          exact: false,
        });
        await basis.fill('4999.50');
        await basis.fill('');
        assert.equal(
          await basis.inputValue(),
          '',
          'An unknown basis must not become zero',
        );
        await modal
          .getByRole('button', { name: 'Vérifier le salaire', exact: true })
          .click();
        await modal.locator('.payroll-field-guide').waitFor();
        assert.equal(await basis.getAttribute('aria-invalid'), 'true');
        await basis.fill('4999.50');
        await modal
          .getByRole('button', { name: 'Vérifier le salaire', exact: true })
          .click();
        await modal
          .getByRole('button', {
            name: 'Corriger la date de confirmation',
            exact: true,
          })
          .click();
        const decision = setup.locator('[name=decisionDate]');
        assert.equal(
          await decision.evaluate((node) => node === document.activeElement),
          true,
        );
        await setup
          .getByRole('button', {
            name: 'Enregistrer et continuer',
            exact: true,
          })
          .click();
        await setup.locator('.payroll-field-guide').waitFor();
        assert.match(
          await setup.locator('.payroll-field-guide').innerText(),
          /2026/,
        );
        assert.equal(await decision.getAttribute('aria-invalid'), 'true');
        await setup.locator('.payroll-field-guide').scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `.qa/payroll-repair/${engine}-${width}-guide.png`,
        });
        await decision.fill('2026-01-15');
        await setup
          .getByRole('button', {
            name: 'Enregistrer et continuer',
            exact: true,
          })
          .click();
        await setup.waitFor({ state: 'hidden' });
        await modal.getByRole('button', { name: 'Continuer vers mon salaire', exact: true }).click();
        await modal
          .getByRole('button', { name: 'Vérifier le salaire', exact: true })
          .click();
        await modal.locator('[name=notes]').fill('Salaire corrigé\nNotes conservées');
        assert.equal(await modal.locator('.payroll-issues').count(), 0);
        await modal
          .locator('.modal__body')
          .evaluate((node) => node.scrollTo({ top: 0 }));
        await page.screenshot({
          path: `.qa/payroll-repair/${engine}-${width}.png`,
        });
        const overflow = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.modal,.modal__body,.payroll-field-guide,.payroll-next-action',
            ),
          ]
            .filter(
              (node) =>
                node.getClientRects().length &&
                node.scrollWidth > node.clientWidth + 1,
            )
            .map((node) => node.className),
        );
        assert.deepEqual(overflow, []);
        await modal
          .getByRole('button', { name: 'Enregistrer la fiche', exact: true })
          .click();
        await modal.waitFor({ state: 'hidden' });
        const saved = await page.evaluate(() =>
          JSON.parse(sessionStorage.getItem('qa-payroll-save') || '[]').at(-1),
        );
        assert.equal(saved.lines[0].amountCents, 512345);
        assert.equal(
          saved.selections.find((item) => item.definitionId === 'AAP_TEST')
            .basisCents,
          499950,
        );
        assert.equal(saved.data.notes, 'Salaire corrigé\nNotes conservées');
        report.push({
          engine,
          width,
          result:
            'PASS empty basis, field focus, annual-date repair, recalculation and save, preserved custom basis and notes',
        });
      } catch (error) {
        await page.screenshot({
          path: `.qa/payroll-repair/${engine}-${width}-failure.png`,
        });
        throw error;
      } finally {
        await page.close();
      }
    }
  } catch (error) {
    report.push({ engine, fatal: error.stack });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
if (errors.length) {
  report.push({ errors });
  process.exitCode = 1;
}
await writeFile(
  '.qa/payroll-repair/report.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
