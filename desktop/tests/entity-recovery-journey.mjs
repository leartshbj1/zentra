import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5196';
const output = '.qa/entity-recovery';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
});
const report = [];
try {
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 844 },
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${base}/tests/mobile-harness.html?entityRecovery=1`);
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
        .fill('Clients');
      await page
        .locator('.navigation-palette__results button')
        .filter({ has: page.getByText('Clients', { exact: true }) })
        .click();
      await page
        .getByRole('button', { name: 'Nouveau client', exact: true })
        .click();
      const modal = page.getByRole('dialog', {
        name: 'Nouveau client',
        exact: true,
      });
      for (const [name, value] of Object.entries({
        contactPerson: 'Camille Exemple',
        company: 'Atelier Continuité',
        street: 'Rue du test',
        postalCode: '1000',
        city: 'Lausanne',
      })) {
        await modal.locator(`[name=${name}]`).fill(value);
      }
      await modal
        .getByRole('button', { name: 'Enregistrer', exact: true })
        .click();
      const recovery = page.getByRole('dialog', {
        name: 'Enregistrement effectué',
        exact: true,
      });
      await recovery.waitFor();
      const writeCount = () =>
        page.evaluate(
          () => JSON.parse(sessionStorage.getItem('qa-entity-writes')).length,
        );
      assert.equal(await writeCount(), 1);
      await recovery
        .getByRole('button', { name: 'Actualiser les données', exact: true })
        .click();
      await recovery
        .getByText('Actualisation impossible', { exact: true })
        .waitFor();
      await page.keyboard.press('Escape');
      assert.ok(await recovery.isVisible());
      assert.equal(await writeCount(), 1);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({ path: `${output}/${width}-read-retry.png` });
      await page.evaluate(() =>
        sessionStorage.removeItem('qa-entity-block-reads'),
      );
      await recovery
        .getByRole('button', { name: 'Actualiser les données', exact: true })
        .click();
      await recovery.waitFor({ state: 'hidden' });
      await modal.waitFor({ state: 'hidden' });
      assert.equal(await writeCount(), 1);
      const edit = page.getByRole('button', { name: 'Modifier Atelier Continuité', exact: true });
      assert.equal(await edit.count(), 1);
      await edit.click();
      const restored = page.getByRole('dialog', { name: 'Modifier le client', exact: true });
      assert.equal(await restored.locator('[name=contactPerson]').inputValue(), 'Camille Exemple');
      assert.equal(await restored.locator('[name=city]').inputValue(), 'Lausanne');
      assert.deepEqual(errors, []);
      report.push({
        width,
        oneClientCreated: true,
        persistentReadFailureHandled: true,
        sameDataRecovered: true,
      });
    } catch (error) {
      await page.screenshot({ path: `${output}/${width}-failure.png` });
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
