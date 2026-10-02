import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real WorkspaceApp, SalaryCertificates and PDF.js, synthetic bridge only.
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5411';
const before = process.argv.includes('--before');
const output = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-salary-certificate-preview-${before ? 'before' : 'after'}`);
await mkdir(output, { recursive: true });

function syntheticPdf(text) {
  const content = `BT /F1 16 Tf 72 720 Td (${text}) Tj ET`;
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

async function fixture(browser, result, holdDraft = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) { result.blocked.push(url.origin + url.pathname); return route.abort(); }
    return route.continue();
  });
  await page.goto(`${origin}/tests/mobile-harness.html?payroll=1`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
  await page.evaluate(({ bytes, holdDraft }) => {
    const api = window.__qaDesktopApi;
    const proof = window.__certificateProof = { drafts: [], previews: [], exports: [] };
    api.salaryCertificateDraft = async (employeeId, year) => {
      proof.drafts.push({ employeeId, year });
      const row = { id: 'synthetic-row', label: 'Salaire fictif', kind: 'earning', amountCents: 500000, proposedBox: '1', fixedBox: false, count: 1 };
      const value = { employeeId, year, sourceHash: 'synthetic-source-hash', identity: { name: `Collaborateur fictif ${employeeId}`, address: 'Rue fictive 1, 1000 Lausanne', avsNumber: '756.1234.5678.97', birthDate: '1990-01-01', periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, employerContact: 'Entreprise fictive, Rue fictive 2, Lausanne, 0210000000', placeDate: 'Lausanne, 02.10.2026' }, rows: [row], sources: [{ id: 'synthetic-source', period: `${year}-09`, paymentDate: `${year}-09-30`, defaultIncluded: true, rows: [row] }], withholdingRows: [], payslipCount: 1, unpaidCount: 0 };
      if (holdDraft && employeeId === 'elodie') return new Promise(resolve => { window.__certificateReleaseDraft = () => resolve(value); });
      return value;
    };
    api.salaryCertificatePreview = async input => {
      proof.previews.push(structuredClone(input));
      if (window.__certificateFailPreview) { window.__certificateFailPreview = false; throw new Error('Préparation synthétique interrompue.'); }
      return new Promise(resolve => { window.__certificateReleasePreview = () => resolve(bytes); });
    };
    api.exportSalaryCertificate = async input => {
      proof.exports.push(structuredClone(input));
      if (window.__certificateFailExport) { window.__certificateFailExport = false; throw new Error('Export synthétique interrompu.'); }
      if (window.__certificateCancelExport) { window.__certificateCancelExport = false; return null; }
      if (window.__certificateHoldExport) { window.__certificateHoldExport = false; await new Promise(resolve => { window.__certificateReleaseExport = resolve; }); }
      return { path: 'C:/Synthetic/certificate.pdf', pages: 1 };
    };
  }, { bytes: syntheticPdf('PREVIEW OLD REMARK'), holdDraft });
  await navigate(page, 'Équipe & salaires');
  await page.locator('.team-navigation').getByRole('button', { name: 'Certificats annuels', exact: true }).click();
  if (!holdDraft) await page.locator('.salary-certificates').getByRole('button', { name: 'Vérifier les montants', exact: true }).waitFor();
  return page;
}

async function amounts(page, remark = 'PREVIEW OLD REMARK') {
  const certificate = page.locator('.salary-certificates');
  await certificate.getByRole('button', { name: 'Vérifier les montants', exact: true }).click();
  await certificate.getByRole('textbox', { name: '15 · Observations', exact: true }).fill(remark);
}

async function finishPreview(page) {
  await page.waitForFunction(() => typeof window.__certificateReleasePreview === 'function');
  await page.evaluate(() => window.__certificateReleasePreview());
  await page.locator('.salary-certificates__preview img').waitFor();
}

async function lockedMatchingExport(browser, result, engine) {
  const page = await fixture(browser, result);
  await amounts(page);
  const certificate = page.locator('.salary-certificates');
  const remarks = certificate.getByRole('textbox', { name: '15 · Observations', exact: true });
  await certificate.getByRole('button', { name: 'Voir le certificat', exact: true }).evaluate((button, before) => { button.click(); if (!before) button.click(); }, before);
  await page.waitForFunction(() => typeof window.__certificateReleasePreview === 'function');
  const editableDuringPreview = await remarks.isEnabled();
  assert.equal(editableDuringPreview, before, 'The certificate cannot change while its preview is being prepared');
  if (before) await remarks.fill('EXPORT NEW REMARK');
  else {
    for (const control of await certificate.locator('.salary-certificates__amounts input, .salary-certificates__amounts select, .salary-certificates__amounts textarea, .salary-certificates__amounts button').all()) assert.equal(await control.isEnabled(), false);
    assert.equal(await certificate.getByRole('spinbutton', { name: 'Année du certificat' }).isEnabled(), false);
    assert.equal(await page.evaluate(() => window.__certificateProof.previews.length), 1);
  }
  await finishPreview(page);
  const review = certificate.getByRole('checkbox', { name: /^Je confirme les coordonnées/ });
  await review.check();
  if (!before) await page.evaluate(() => { window.__certificateHoldExport = true; });
  const exportButton = certificate.getByRole('button', { name: 'Exporter le certificat PDF', exact: true });
  await exportButton.evaluate((button, before) => { button.click(); if (!before) button.click(); }, before);
  if (!before) {
    await page.waitForFunction(() => typeof window.__certificateReleaseExport === 'function');
    assert.equal(await review.isEnabled(), false);
    assert.equal(await page.evaluate(() => window.__certificateProof.exports.length), 1);
    await page.evaluate(() => window.__certificateReleaseExport());
  }
  await certificate.getByText('Certificat de salaire exporté. Une trace de l’édition est conservée dans le journal local.', { exact: true }).waitFor();
  const proof = await page.evaluate(() => window.__certificateProof);
  assert.equal(proof.previews[0].remarks, 'PREVIEW OLD REMARK');
  assert.equal(proof.exports[0].remarks, before ? 'EXPORT NEW REMARK' : proof.previews[0].remarks);
  result.cases.push({ name: 'preview-content-matches-explicit-export-single-flight', editableDuringPreview, previewRemark: proof.previews[0].remarks, exportRemark: proof.exports[0].remarks, previews: proof.previews.length, exports: proof.exports.length });
  await page.screenshot({ path: join(output, `${engine}-matching-export.png`), fullPage: true });
  await page.close();
}

async function previewFailureAndExplicitRetry(browser, result) {
  const page = await fixture(browser, result); await amounts(page, 'REMARK RETAINED');
  const certificate = page.locator('.salary-certificates');
  await page.evaluate(() => { window.__certificateFailPreview = true; });
  await certificate.getByRole('button', { name: 'Voir le certificat', exact: true }).click();
  await certificate.getByRole('alert').waitFor();
  assert.equal(await certificate.getByRole('textbox', { name: '15 · Observations', exact: true }).inputValue(), 'REMARK RETAINED');
  assert.equal(await certificate.getByRole('textbox', { name: '15 · Observations', exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__certificateProof.previews.length), 1);
  assert.equal(await page.evaluate(() => window.__certificateProof.exports.length), 0);
  await certificate.getByRole('button', { name: 'Voir le certificat', exact: true }).click(); await finishPreview(page);
  assert.equal(await certificate.getByRole('checkbox', { name: /^Je confirme les coordonnées/ }).isChecked(), false);
  assert.equal(await certificate.getByRole('button', { name: 'Exporter le certificat PDF', exact: true }).isEnabled(), false);
  assert.equal(await page.evaluate(() => window.__certificateProof.previews.length), 2);
  result.cases.push({ name: 'preview-failure-retains-input-and-explicit-retry-requires-review', previews: 2, exports: 0 });
  await page.close();
}

async function exportFailureCancelAndRetry(browser, result) {
  const page = await fixture(browser, result); await amounts(page);
  const certificate = page.locator('.salary-certificates');
  await certificate.getByRole('button', { name: 'Voir le certificat', exact: true }).click(); await finishPreview(page);
  await certificate.getByRole('checkbox', { name: /^Je confirme les coordonnées/ }).check();
  await page.evaluate(() => { window.__certificateFailExport = true; });
  const exportButton = certificate.getByRole('button', { name: 'Exporter le certificat PDF', exact: true });
  await exportButton.click(); await certificate.getByRole('alert').waitFor();
  assert.equal(await exportButton.isEnabled(), true); assert.equal(await certificate.locator('.salary-certificates__notice').count(), 0);
  await page.evaluate(() => { window.__certificateCancelExport = true; });
  await exportButton.click();
  await page.waitForFunction(() => window.__certificateProof.exports.length === 2);
  assert.equal(await certificate.locator('.salary-certificates__notice').count(), 0);
  await exportButton.click();
  await certificate.locator('.salary-certificates__notice').waitFor();
  assert.equal(await page.evaluate(() => window.__certificateProof.exports.length), 3);
  assert.equal(await page.evaluate(() => window.__certificateProof.previews.length), 1, 'Delivery retry does not regenerate the reviewed preview');
  result.cases.push({ name: 'export-failure-cancel-explicit-retry-no-false-success', previews: 1, exports: 3 });
  await page.close();
}

async function navigationDuringPreview(browser, result) {
  const page = await fixture(browser, result); await amounts(page, 'OLD CLOSED PREVIEW');
  await page.locator('.salary-certificates').getByRole('button', { name: 'Voir le certificat', exact: true }).click();
  await page.waitForFunction(() => typeof window.__certificateReleasePreview === 'function');
  await navigate(page, 'Clients');
  await page.evaluate(() => window.__certificateReleasePreview());
  await navigate(page, 'Équipe & salaires');
  await page.locator('.team-navigation').getByRole('button', { name: 'Certificats annuels', exact: true }).click();
  await page.locator('.salary-certificates').getByRole('button', { name: 'Vérifier les montants', exact: true }).waitFor();
  assert.equal(await page.locator('.salary-certificates__preview img').count(), 0);
  assert.equal(await page.locator('.salary-certificates__error, .salary-certificates__notice').count(), 0);
  assert.equal(await page.locator('.salary-certificates').getByRole('button', { name: 'Vérifier les montants', exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__certificateProof.exports.length), 0);
  result.cases.push({ name: 'navigation-ignores-closed-preview-and-opens-fresh-form', exports: 0 });
  await page.close();
}

async function employeeDuringDraftRead(browser, result) {
  const page = await fixture(browser, result, true);
  await page.waitForFunction(() => typeof window.__certificateReleaseDraft === 'function');
  const certificate = page.locator('.salary-certificates');
  await certificate.getByRole('combobox', { name: 'Collaborateur du certificat' }).selectOption('jean');
  const name = certificate.getByRole('textbox', { name: /^Nom complet/ });
  await name.waitFor(); assert.equal(await name.inputValue(), 'Collaborateur fictif jean');
  await page.evaluate(() => window.__certificateReleaseDraft());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await name.inputValue(), 'Collaborateur fictif jean');
  assert.equal(await page.evaluate(() => window.__certificateProof.drafts.length), 2);
  result.cases.push({ name: 'employee-selection-ignores-older-draft-read', drafts: 2 });
  await page.close();
}

async function run(engine) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { executablePath: process.env.ZENTRA_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}) });
  const result = { engine, cases: [], errors: [], blocked: [] };
  try {
    await lockedMatchingExport(browser, result, engine);
    if (!before) {
      await previewFailureAndExplicitRetry(browser, result);
      await exportFailureCancelAndRetry(browser, result);
      await navigationDuringPreview(browser, result);
      await employeeDuringDraftRead(browser, result);
    }
    assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.passed = true;
  } catch (error) { result.passed = false; result.failure = error.stack; }
  finally { await browser.close(); }
  return result;
}
const results = await Promise.all(['chromium', 'webkit'].map(run));
await writeFile(join(output, 'report.json'), JSON.stringify({ origin, before, results }, null, 2));
console.log(JSON.stringify({ output, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
