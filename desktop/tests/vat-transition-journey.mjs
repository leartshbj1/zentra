import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/vat-transition', { recursive: true });
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => report.push({ width, error: error.message }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5175/tests/mobile-harness.html?finance=1&transitionVat=1', { waitUntil: 'domcontentloaded' });
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Comptabilité');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Comptabilité', { exact: true }) }).click();
    await page.locator('.navigation-palette').waitFor({ state: 'detached' });
    await page.getByLabel('Date de début de la période', { exact: true }).fill('2026-01-01');
    await page.getByLabel('Date de fin de la période', { exact: true }).fill('2026-03-31');
    if (width <= 800) await page.getByRole('combobox', { name: 'Section comptable', exact: true }).selectOption('vat');
    else await page.getByRole('tab', { name: 'TVA', exact: true }).click();
    const issues = page.getByLabel('Points à vérifier avant export', { exact: true });
    await issues.getByText('Changement de mode TVA à préparer', { exact: true }).waitFor();
    assert.match(await issues.innerText(), /58\.10 CHF/);
    assert.doesNotMatch(await issues.innerText(), /vat_reporting_transition_open_balance/);
    assert.ok(await page.getByRole('button', { name: 'Générer l’XML', exact: false }).isDisabled());
    await issues.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `issue overflow ${width}`);
    await page.screenshot({ path: `.qa/vat-transition/${width}-blocked-export.png` });
    const tab = async (value, name) => {
      const selector = page.getByRole('combobox', { name: 'Section TVA', exact: true });
      if (await selector.isVisible()) await selector.selectOption(value);
      else await page.getByRole('tab', { name, exact: true }).click();
    };
    await tab('profile', 'Méthode & autorisation');
    await page.locator('input[name="effectiveFrom"]').fill('2027-01-01');
    await page.getByRole('combobox', { name: /^Mode de décompte/ }).selectOption('received');
    await page.locator('input[name="authorization"]').check();
    await page.locator('input[name="closePrevious"]').check();
    const oldProfiles = await page.locator('.vat-profile-list').innerText();
    await page.getByRole('button', { name: 'Enregistrer cette version', exact: true }).click();
    const error = page.getByText(/Changement de mode TVA non enregistré : une reprise/);
    await error.waitFor();
    assert.equal(await page.locator('input[name="effectiveFrom"]').inputValue(), '2027-01-01');
    assert.equal(await page.getByRole('combobox', { name: /^Mode de décompte/ }).inputValue(), 'received');
    assert.equal(await page.locator('.vat-profile-list').innerText(), oldProfiles);
    assert.equal(await page.locator('.notice--success').count(), 0);
    await error.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `profile error overflow ${width}`);
    await page.screenshot({ path: `.qa/vat-transition/${width}-profile-preserved.png` });
    await tab('return', 'Décompte');
    await issues.waitFor();
    report.push({ width, result: 'PASS readable transition issue, long reference wraps, XML disabled, rejected profile preserves input and prior version, navigation remains usable' });
    await page.close();
  }
  assert.deepEqual(report.filter((item) => item.error), []);
} catch (error) {
  report.push({ fatal: error.stack }); process.exitCode = 1;
  const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
  if (page) await page.screenshot({ path: '.qa/vat-transition/failure.png', fullPage: true });
} finally {
  await writeFile('.qa/vat-transition/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
