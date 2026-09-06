import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const useWebKit = process.env.ZENTRA_QA_BROWSER === 'webkit';
const root = `.qa/project-files-${useWebKit ? 'webkit' : 'edge'}${process.env.ZENTRA_QA_SUFFIX || ''}`;
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192';
await mkdir(root, { recursive: true });

// Small valid, uncompressed PDF with deterministic page-specific text/colors.
function pdfFixture(count = 3) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let page = 1; page <= count; page++) {
    const stream = `q ${page % 2 ? '.1 .3 .2' : '.8 .5 .1'} rg 0 710 595 132 re f Q BT /F1 24 Tf 40 665 Td (Projet de recette - page ${page}) Tj 0 -50 Td /F1 13 Tf (Document original conserve dans le dossier du projet.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (page - 1) * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(content.length); content += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = content.length;
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(content);
}
const pdf = pdfFixture();
const protectedPdf = await readFile(new URL('./fixtures/project-protected.pdf', import.meta.url));
const imageFixture = await readFile(new URL('../src/assets/zentra-wordmark.png', import.meta.url));
const browser = await (useWebKit ? webkit : chromium).launch({ headless: true, ...(!useWebKit && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const results = [];
const pageErrors = [];
try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2, hasTouch: viewport.width < 900 });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => { errors.push(error.message); pageErrors.push({ viewport, message: error.message }); });
    if (process.env.ZENTRA_QA_MISSING_PDF_BUILTINS) {
      await page.addInitScript(mode => {
        if (mode === 'unsupported') delete Promise.withResolvers;
        delete Promise.try;
      }, process.env.ZENTRA_QA_MISSING_PDF_BUILTINS);
    }
    await page.addInitScript(() => {
      window.__qaPolicyViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__qaPolicyViolations.push({ directive: event.violatedDirective, resource: event.blockedURI }));
    });
    await page.emulateMedia({ reducedMotion: viewport.width === 320 ? 'reduce' : 'no-preference' });
    await page.goto(`${origin}/tests/project-files-harness.html`);
    const upload = async file => {
      await page.locator('input[type=file]').first().setInputFiles(file);
      await page.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
      await page.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).waitFor({ state: 'detached' });
    };
    const open = async name => {
      await page.locator('.project-document-list__open').filter({ hasText: name }).click();
      await page.getByRole('dialog').waitFor();
    };
    const ready = async number => {
      await page.locator('.pdf-attachment-preview__viewport[aria-busy=false] canvas').waitFor();
      assert.match(await page.locator('canvas').getAttribute('aria-label'), new RegExp(`page ${number} sur`));
      assert.equal(await page.locator('canvas').count(), 1);
    };
    const close = async () => {
      await page.getByRole('dialog').getByRole('button', { name: /^Fermer «/ }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    };
    const capture = async name => {
      await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))).map(animation => animation.finished.catch(() => {}))); });
      await page.screenshot({ path: `${root}/${viewport.width}-${name}.png` });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${viewport.width} ${name}: outer overflow`);
      const header = await page.locator('.attachment-preview-dialog > header').boundingBox();
      const footer = await page.locator('.attachment-preview__footer').boundingBox();
      assert.ok(header.y >= -.5 && footer.y + footer.height <= viewport.height + 1, `${viewport.width} ${name}: reader actions remain inside screen ${JSON.stringify({ header, footer })}`);
      assert.ok((await page.locator('.attachment-preview__content').boundingBox()).height >= 100, 'usable reading area');
    };
    await upload({ name: 'Plans et documents du projet.pdf', mimeType: 'application/pdf', buffer: pdf });
    await open('Plans et documents');
    if (process.env.ZENTRA_QA_MISSING_PDF_BUILTINS === 'unsupported') {
      await page.getByRole('dialog').getByText('Aperçu indisponible', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
      await page.getByRole('dialog').getByText('Aperçu indisponible', { exact: true }).waitFor();
      assert.ok(await page.getByRole('button', { name: /Ouvrir avec une application|Enregistrer ou partager/ }).isEnabled());
      await capture('unsupported-reader');
      await close();
      await page.locator('.project-folder').waitFor();
      assert.deepEqual(errors, []);
      results.push({ viewport, status: 'passed', scope: 'unsupported API keeps reader controls and project accessible', errors });
      await page.close();
      continue;
    }
    await ready(1);
    assert.equal(await page.locator('iframe').count(), 0);
    assert.ok(await page.getByRole('button', { name: 'Page précédente', exact: true }).isDisabled());
    const firstPixel = await page.locator('canvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(10, 10, 1, 1).data));
    await capture('page-1');
    await page.getByRole('button', { name: 'Page suivante', exact: true }).click(); await ready(2);
    assert.notDeepEqual(await page.locator('canvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(10, 10, 1, 1).data)), firstPixel, 'next page actually painted');
    await page.getByText('Texte de la page', { exact: true }).click();
    assert.match(await page.locator('.pdf-attachment-preview__text').innerText(), /page 2/);
    await page.getByRole('button', { name: 'Agrandir', exact: true }).click(); await ready(2);
    await page.waitForFunction(() => document.querySelector('canvas').clientWidth > document.querySelector('.pdf-attachment-preview__viewport').clientWidth || innerWidth > 1200);
    const pixels = await page.locator('canvas').evaluate(canvas => ({ area: canvas.width * canvas.height, side: Math.max(canvas.width, canvas.height) }));
    assert.ok(pixels.area <= 4_000_000 && pixels.side <= 4096);
    await capture('zoom');
    await page.getByRole('button', { name: 'Ajuster à la largeur', exact: true }).click(); await ready(2);
    await page.getByRole('button', { name: 'Page suivante', exact: true }).click(); await ready(3);
    assert.ok(await page.getByRole('button', { name: 'Page suivante', exact: true }).isDisabled());
    const external = page.getByRole('button', { name: /Ouvrir avec une application|Enregistrer ou partager/ });
    await external.click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    assert.match(await page.getByRole('dialog').getByRole('alert').innerText(), /Application de lecture indisponible/);
    await capture('error-visible');
    await external.click(); await page.getByRole('dialog').getByRole('alert').waitFor({ state: 'detached' });
    assert.equal(await page.locator('html').getAttribute('data-open-attempts'), '2');
    const downloadLink = page.getByRole('link', { name: 'Enregistrer', exact: true });
    if (await downloadLink.count()) {
      const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
      assert.deepEqual(await readFile(await download.path()), pdf, 'download original bytes after rendering and retries');
    }
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('.project-document-list__open'));
    await upload({ name: 'Document endommage.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nbroken') });
    await open('Document endommage'); await page.getByRole('dialog').getByRole('alert').waitFor();
    await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor(); await capture('invalid-pdf');
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
    await upload({ name: 'Photo incompatible.heic', mimeType: 'image/heic', buffer: Buffer.from('Invalid image fixture') });
    await open('Photo incompatible'); await page.getByRole('heading', { name: 'Aperçu indisponible', exact: true }).waitFor();
    await capture('image-fallback'); await close();
    // Leave during worker startup, then reopen without stale rendering/errors.
    await open('Plans et documents'); await close();
    await open('Plans et documents'); await ready(1);
    for (let i = 0; i < 3; i++) { await page.getByRole('button', { name: 'Page suivante', exact: true }).click(); await page.getByRole('button', { name: 'Page précédente', exact: true }).click(); }
    await ready(1);
    await close();
    await upload({ name: 'PDF protege.pdf', mimeType: 'application/pdf', buffer: protectedPdf });
    await open('PDF protege');
    await page.getByRole('dialog').getByText(/protégé par un mot de passe/).waitFor();
    await capture('protected-pdf'); await close();
    await upload({ name: 'Dossier long.pdf', mimeType: 'application/pdf', buffer: pdfFixture(80) });
    await open('Dossier long'); await ready(1);
    assert.match(await page.locator('canvas').getAttribute('aria-label'), /sur 80/);
    await close();
    await upload({ name: 'Photo du projet.png', mimeType: 'image/png', buffer: imageFixture });
    await open('Photo du projet');
    await page.waitForFunction(() => document.querySelector('.attachment-preview__image img')?.naturalWidth > 0);
    await capture('image'); await close();
    assert.deepEqual(errors, []);
    const policyViolations = await page.evaluate(() => window.__qaPolicyViolations);
    assert.deepEqual(policyViolations, []);
    results.push({ viewport, status: 'passed', pixels, errors, policyViolations });
    await page.close();
  }
  await writeFile(`${root}/report.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} catch (error) {
  const page = browser.contexts().flatMap(context => context.pages()).at(-1);
  if (page) {
    await page.screenshot({ path: `${root}/failure.png` });
    await writeFile(`${root}/failure.json`, JSON.stringify({ pageErrors, text: await page.locator('body').innerText() }, null, 2));
  }
  throw error;
} finally { await browser.close(); }
