import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
await mkdir('.qa/project-costs', { recursive: true });
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', error => report.push({ width, error: error.message }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${process.env.ZENTRA_QA_BASE_URL || 'http://127.0.0.1:5175'}/tests/mobile-harness.html?projectCosts=1`, { waitUntil: 'domcontentloaded' });
    const tour = page.getByRole('button', { name: 'Ne plus afficher automatiquement', exact: true });
    if (await tour.isVisible()) await tour.click();
    const navigate = async name => {
      await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
      await page.locator('.navigation-palette').waitFor({ state: 'detached' });
    };
    const capture = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${name}: horizontal overflow`);
      await page.screenshot({ path: `.qa/project-costs/${width}-${name}.png` });
    };
    const compact = async locator => (await locator.innerText()).replace(/\s/g, '');
    await navigate('Rapports');
    const cards = page.locator('.report-card');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 3, 'zero-cost activity remains visible');
    const main = cards.filter({ has: page.getByRole('heading', { name: 'Rénovation des espaces de travail et de la salle de réunion', exact: true }) });
    assert.match(await compact(main.locator('.report-card__figures')), /270\.25CHF/);
    assert.match(await compact(main.locator('footer')), /729\.75CHF/);
    const disclosure = main.locator('summary');
    assert.ok((await disclosure.boundingBox()).height >= 44);
    await disclosure.focus();
    await page.keyboard.press('Enter');
    assert.ok(await main.locator('details').evaluate(element => element.open));
    assert.match(await compact(main.locator('dl')), /324\.30CHF.*54\.05CHF.*20\.25CHF/s);
    await main.scrollIntoViewIfNeeded();
    await capture('report');
    const zero = cards.filter({ has: page.getByRole('heading', { name: 'Projet intégralement crédité', exact: true }) });
    assert.match(await compact(zero.locator('footer')), /0\.00CHF/);
    const review = cards.filter({ has: page.getByRole('heading', { name: 'Projet avec TVA à contrôler', exact: true }) });
    assert.equal(await review.locator('footer strong').innerText(), 'Coût des achats à contrôler');
    const control = review.getByRole('button', { name: 'Contrôler les achats', exact: true });
    assert.ok((await control.boundingBox()).height >= 44);
    await control.scrollIntoViewIfNeeded();
    await capture('review');
    await control.click();
    await page.getByRole('heading', { name: 'Comptabilité', exact: true }).waitFor();
    await navigate('Projets');
    const project = page.locator('.project-card').filter({ hasText: 'Rénovation des espaces de travail et de la salle de réunion' });
    await project.waitFor();
    assert.match(await compact(project), /729\.75CHF/);
    const pending = page.locator('.project-card').filter({ hasText: 'Projet avec TVA à contrôler' });
    assert.match(await pending.innerText(), /Coût des achats à contrôler/);
    const zeroProject = page.locator('.project-card').filter({ hasText: 'Projet intégralement crédité' });
    assert.match(await compact(zeroProject), /0\.00CHF/);
    await pending.scrollIntoViewIfNeeded();
    await capture('projects');
    report.push({ width, result: 'PASS: posted costs, non-deductible VAT, supplier credit deducted once, drafts excluded, zero cost shown, review blocks margin, accounting navigation, keyboard disclosure, 44px controls, no overflow', screenshots: 3 });
    await page.close();
  }
  assert.deepEqual(report.filter(row => row.error), []);
} catch (error) {
  process.exitCode = 1;
  report.push({ fatal: error.stack });
  const page = browser.contexts().flatMap(context => context.pages()).at(-1);
  if (page) {
    await page.screenshot({ path: '.qa/project-costs/failure.png' });
    await writeFile('.qa/project-costs/failure.html', await page.content());
  }
} finally {
  await writeFile('.qa/project-costs/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
