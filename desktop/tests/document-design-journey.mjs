import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine = process.env.ZENTRA_QA_ENGINE || 'chromium';
const { [engine]: driver } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await driver.launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const folder = `.qa/document-design-${engine}`;
await mkdir(folder, { recursive: true });
const errors = [], report = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/native-design-fixture/*.pdf', async route => {
  const file = new URL(route.request().url()).pathname.split('/').at(-1);
  assert.match(file, /^(quotes|invoices|accounts)-(signature|minimal)\.pdf$/);
  await route.fulfill({ status: 200, contentType: 'application/pdf', body: await readFile(`.qa/composition-pdfs/${file}`) });
});
async function ready() { await page.locator('.design-studio__preview[aria-busy=false] .design-studio__pages img').first().waitFor({ timeout: 20000 }); }
async function request() { return page.evaluate(() => JSON.parse(sessionStorage.getItem('design-request'))); }
try {
  await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/document-design-harness.html`);
  await ready();
  for (const [kind,label] of [['invoices','Factures'],['quotes','Devis'],['accounts','Bilan']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Épurée Des lignes simples et légères', exact: true }).click();
    await page.getByRole('button', { name: 'Couleur #d7b878', exact: true }).click();
    await page.getByRole('button', { name: 'Mise en page', exact: true }).click();
    await page.getByLabel('Taille du logo', { exact: true }).selectOption('150');
    await page.getByRole('button', { name: 'Textes', exact: true }).click();
    if (!(await page.locator('.design-studio__panel details').evaluate(el => el.open))) await page.getByText('Pied de page simple', { exact: true }).click();
    await page.getByLabel('Une phrase en pied de page').fill('Merci pour votre confiance.');
    await ready();
    const input = await request();
    assert.equal(input.kind, kind);
    assert.deepEqual(input.style, { accentColor: '#d7b878', layout: 'minimal', logoWidth: 150, footer: 'Merci pour votre confiance.' });
    assert.equal(await page.locator('.design-studio__pages img').count(), kind === 'accounts' ? 2 : 1);
    await page.getByRole('button', { name: 'Exporter cet exemple' }).click();
    const exported = await page.evaluate(() => JSON.parse(sessionStorage.getItem('design-export')));
    assert.deepEqual(exported, input);
    report.push({ kind, nativePdfRendered: true, exportArguments: true });
  }
  await page.getByRole('button', { name: 'Enregistrer les présentations' }).click();
  await page.reload(); await ready();
  assert.deepEqual((await request()).style, { accentColor: '#d7b878', layout: 'minimal', logoWidth: 150, footer: 'Merci pour votre confiance.' });
  await page.getByRole('button', { name: 'Réinitialiser factures', exact: true }).click(); await ready();
  assert.equal((await request()).style.layout, 'signature');
  await page.getByRole('button', { name: 'Devis', exact: true }).click(); await ready();
  assert.equal((await request()).style.layout, 'minimal', 'reset only changes the selected document');
  await page.getByRole('button', { name: 'Textes', exact: true }).click();
  await page.getByText('Pied de page simple', { exact: true }).click();
  await page.getByLabel('Une phrase en pied de page').fill('Erreur de recette');
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Exporter cet exemple' }).isDisabled(), true);
  await page.getByLabel('Une phrase en pied de page').fill('Merci pour votre confiance.'); await ready();
  for (const width of [1440,1024,768,390,320]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(() => scrollTo(0,0));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow,false, `no horizontal overflow at ${width}`);
    await page.screenshot({ path: `${folder}/${width}-tools.png`, fullPage: true });
    if (width <= 900) {
      await page.getByRole('button', { name: 'Voir le résultat', exact: true }).click();
      await page.waitForFunction(() => {
        const preview = document.querySelector('.design-studio__preview').getBoundingClientRect();
        return preview.top < innerHeight * .55 && preview.bottom > 0;
      });
      await page.getByRole('button', { name: 'Agrandir l’aperçu', exact: true }).click();
      await page.locator('.design-studio__pages--zoomed').waitFor();
      const zoom = await page.locator('.design-studio__pages').evaluate(el => ({ outer: el.clientWidth, inner: el.scrollWidth, image: el.querySelector('img').getBoundingClientRect().width, css: getComputedStyle(el.querySelector('img')).maxInlineSize }));
      assert.ok(zoom.inner > zoom.outer, JSON.stringify({ width, zoom }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),false);
      await page.getByRole('button', { name: 'Ajuster l’aperçu', exact: true }).click();
      await page.locator('.design-studio__pages--zoomed').waitFor({ state: 'detached' });
    }
    report.push({ width, noOverflow: true });
  }
  assert.deepEqual(errors,[]);
  await writeFile(`${folder}/report.json`,JSON.stringify({ engine, report, errors }, null, 2));
  console.log(JSON.stringify({ engine, checks: report.length, errors }));
} finally { await browser.close(); }
