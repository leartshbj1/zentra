import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Start salary-certificate-mobile-preview.mjs first. The real bridge
// uses an in-memory IPC fixture; no native file, journal or share sheet opens.
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5412';
const output = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), 'zentra-salary-certificate-delivery-after');
const viewport = { width: Number(process.env.ZENTRA_QA_WIDTH || 1440), height: Number(process.env.ZENTRA_QA_HEIGHT || 1000) };
const shareRetryOnly = process.env.ZENTRA_QA_SCENARIO === 'share-retry';
await mkdir(output, { recursive: true });

function syntheticPdf() {
  const content = 'BT /F1 16 Tf 72 720 Td (SYNTHETIC CERTIFICATE) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let data = '%PDF-1.4\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(data.length); data += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = data.length;
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...Buffer.from(data)];
}

async function navigate(page, name) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(name);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(name, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}

async function fixture(browser, result, shareMode) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin !== origin || url.pathname.startsWith('/api/')) { result.blocked.push(url.origin + url.pathname); return route.abort(); } return route.continue(); });
  await page.goto(`${origin}/tests/mobile-harness.html?payroll=1`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await import('/src/mobileRuntime.ts')).isMobileRuntime()), true);
  await page.evaluate(({ bytes, shareMode }) => {
    const api = window.__qaDesktopApi;
    window.__deliveryProof = { generations: [], shares: [] };
    window.__deliveryShareMode = shareMode;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'prepare_mobile_export') return '/cache/synthetic-certificate.pdf';
      if (command === 'export_salary_certificate') { window.__deliveryProof.generations.push(structuredClone(args)); return '/cache/synthetic-certificate.pdf'; }
      if (command === 'share_mobile_export') {
        window.__deliveryProof.shares.push(structuredClone(args));
        if (window.__deliveryShareMode === 'failure') throw new Error('Partage synthétique momentanément indisponible.');
        if (window.__deliveryShareMode === 'cancel-rejection') throw new Error('Partage annulé.');
        if (window.__deliveryShareMode === 'hold') await new Promise(resolve => { window.__deliveryReleaseShare = resolve; });
        // A cancelled native share sheet can resolve without a selected target.
        return undefined;
      }
      if (command.startsWith('diagnostic') || command === 'record_diagnostic_event') return;
      throw new Error(`Synthetic transport blocks command ${command}`);
    } };
    api.salaryCertificateDraft = async (employeeId, year) => ({ employeeId, year, sourceHash: 'synthetic-source-hash', identity: { name: 'Collaboratrice fictive', address: 'Rue fictive 1, 1000 Lausanne', avsNumber: '756.1234.5678.97', birthDate: '1990-01-01', periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, employerContact: 'Entreprise fictive, Lausanne, 0210000000', placeDate: 'Lausanne, 02.10.2026' }, rows: [], sources: [], withholdingRows: [], payslipCount: 0, unpaidCount: 0 });
    api.salaryCertificatePreview = async () => bytes;
    // exportSalaryCertificate/shareExistingExport stay the real bridge methods.
  }, { bytes: syntheticPdf(), shareMode });
  await navigate(page, 'Équipe & salaires');
  await page.locator('.team-navigation').getByRole('button', { name: 'Certificats annuels', exact: true }).click();
  const certificate = page.locator('.salary-certificates');
  await certificate.getByRole('button', { name: 'Vérifier les montants', exact: true }).click();
  await certificate.getByRole('button', { name: 'Voir le certificat', exact: true }).click();
  await certificate.locator('.salary-certificates__preview img').waitFor();
  await certificate.getByRole('checkbox', { name: /^Je confirme les coordonnées/ }).check();
  return page;
}

async function savedFileAndShareRetry(browser, result) {
  const page = await fixture(browser, result, 'failure');
  const certificate = page.locator('.salary-certificates');
  const exportButton = certificate.getByRole('button', { name: 'Exporter le certificat PDF', exact: true });
  await exportButton.click(); await certificate.locator('.salary-certificates__notice').waitFor();
  await certificate.getByText('Le PDF a été créé, mais le partage n’a pas abouti. Utilisez « Partager le PDF » pour réessayer.', { exact: true }).waitFor();
  assert.equal(await certificate.getByRole('alert').count(), 0, 'Sharing failure is not a creation refusal');
  const savedLayout = await assertCertificateFits(page);
  if (shareRetryOnly) {
    await certificate.getByRole('button', { name: 'Partager le PDF', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `${result.engine}-${viewport.width}-saved-share-warning.png`), fullPage: true });
    await page.screenshot({ path: join(output, `${result.engine}-${viewport.width}-saved-share-controls.png`) });
  }
  await page.evaluate(() => { window.__deliveryShareMode = 'hold'; });
  const share = certificate.getByRole('button', { name: 'Partager le PDF', exact: true });
  await share.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => typeof window.__deliveryReleaseShare === 'function');
  assert.equal(await exportButton.isEnabled(), false, 'A share retry cannot overlap another certificate export');
  const pending = await page.evaluate(() => ({ generations: window.__deliveryProof.generations.length, shares: window.__deliveryProof.shares.length }));
  assert.deepEqual(pending, { generations: 1, shares: 2 });
  await page.evaluate(() => window.__deliveryReleaseShare());
  await certificate.getByText('Partage du PDF ouvert.', { exact: true }).waitFor();
  assert.equal(await exportButton.isEnabled(), true);
  const resumedLayout = await assertCertificateFits(page);
  if (shareRetryOnly) await page.screenshot({ path: join(output, `${result.engine}-${viewport.width}-share-resumed.png`), fullPage: true });
  result.cases.push({ name: 'saved-certificate-share-only-single-flight-retry', ...pending, savedLayout, resumedLayout });
  await page.close();
}

async function assertCertificateFits(page) {
  const layout = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    buttons: [...document.querySelectorAll('.salary-certificates button')].map(button => {
      const rect = button.getBoundingClientRect();
      return { label: button.textContent.trim(), left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }).filter(button => button.height > 0),
  }));
  assert.ok(layout.pageWidth <= layout.viewportWidth + 1, `No horizontal page overflow: ${JSON.stringify(layout)}`);
  for (const button of layout.buttons) assert.ok(button.left >= -1 && button.right <= layout.viewportWidth + 1, `Certificate button fully fits: ${JSON.stringify(button)}`);
  return layout;
}

async function cancelledShare(browser, result, rejected) {
  const page = await fixture(browser, result, rejected ? 'cancel-rejection' : 'cancel-resolved');
  const certificate = page.locator('.salary-certificates');
  await certificate.getByRole('button', { name: 'Exporter le certificat PDF', exact: true }).click();
  await certificate.locator('.salary-certificates__notice').waitFor();
  assert.equal(await certificate.getByRole('alert').count(), 0);
  const proof = await page.evaluate(() => ({ generations: window.__deliveryProof.generations.length, shares: window.__deliveryProof.shares.length }));
  assert.deepEqual(proof, { generations: 1, shares: 1 }, 'Cancellation retains the file and starts no retry loop');
  const share = certificate.getByRole('button', { name: 'Partager le PDF', exact: true });
  assert.equal(await share.isEnabled(), true);
  if (!rejected) {
    assert.equal(await certificate.getByText('Le PDF a été enregistré.', { exact: true }).count(), 1);
    await share.click(); await certificate.getByText('Partage du PDF ouvert.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__deliveryProof.generations.length), 1);
  }
  result.cases.push({ name: rejected ? 'cancelled-share-rejection-retains-file-without-creation-error-or-loop' : 'cancelled-share-resolution-retains-file-without-error-or-loop', ...proof });
  await page.close();
}

async function navigationDuringDelivery(browser, result) {
  const page = await fixture(browser, result, 'hold');
  await page.locator('.salary-certificates').getByRole('button', { name: 'Exporter le certificat PDF', exact: true }).click();
  await page.waitForFunction(() => typeof window.__deliveryReleaseShare === 'function');
  await navigate(page, 'Clients'); await page.evaluate(() => window.__deliveryReleaseShare());
  await navigate(page, 'Équipe & salaires');
  await page.locator('.team-navigation').getByRole('button', { name: 'Certificats annuels', exact: true }).click();
  const certificate = page.locator('.salary-certificates');
  await certificate.getByRole('button', { name: 'Vérifier les montants', exact: true }).waitFor();
  assert.equal(await certificate.locator('.salary-certificates__notice').count(), 0);
  assert.equal(await certificate.getByRole('button', { name: 'Partager le PDF', exact: true }).count(), 0, 'A closed export does not publish its old receipt into the new form');
  const proof = await page.evaluate(() => ({ generations: window.__deliveryProof.generations.length, shares: window.__deliveryProof.shares.length }));
  assert.deepEqual(proof, { generations: 1, shares: 1 });
  result.cases.push({ name: 'navigation-during-delivery-ignores-old-receipt-and-unlocks-new-form', ...proof });
  await page.close();
}

async function run(engine) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { executablePath: process.env.ZENTRA_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}) });
  const result = { engine, cases: [], errors: [], blocked: [] };
  try {
    await savedFileAndShareRetry(browser, result);
    if (!shareRetryOnly) {
      await cancelledShare(browser, result, false);
      await cancelledShare(browser, result, true);
      await navigationDuringDelivery(browser, result);
    }
    assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.passed = true;
  } catch (error) { result.passed = false; result.failure = error.stack; }
  finally { await browser.close(); }
  return result;
}
const results = await Promise.all(['chromium', 'webkit'].map(run));
await writeFile(join(output, 'report.json'), JSON.stringify({ origin, nativeTransport: 'synthetic-only', frontendProfile: 'ios', viewport, scenario: shareRetryOnly ? 'share-retry' : 'all', results }, null, 2));
console.log(JSON.stringify({ output, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
