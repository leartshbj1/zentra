/**
 * Local browser QA for the synthetic international ERP fixture.
 * Start the existing desktop Vite preview separately, then run:
 *   node scripts/international/check-browser-pilot.mjs
 * Required environment:
 *   PLAYWRIGHT_MODULE_DIR: absolute directory of the installed playwright package.
 *   QA_OUTPUT_DIR: absolute directory for result.json and eight screenshots.
 * Optional environment:
 *   PREVIEW_ORIGIN: HTTP(S) origin on localhost or 127.0.0.1; defaults to http://127.0.0.1:5371.
 *   BROWSER_EXECUTABLE: absolute browser executable; otherwise Playwright uses its Chromium.
 * No credentials, account sessions, provider calls or production endpoints are supplied.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

function absoluteEnvironmentPath(name, optional = false) {
  const value = process.env[name];
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value || !isAbsolute(value)) {
    throw new Error(name + ' must be an absolute path.');
  }
  return resolve(value);
}

function localPreviewOrigin(value) {
  let origin;
  try { origin = new URL(value); }
  catch { throw new Error('PREVIEW_ORIGIN must be a valid local HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['localhost', '127.0.0.1'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PREVIEW_ORIGIN must use localhost or 127.0.0.1, without credentials, path, query or fragment.');
  }
  return origin.origin;
}

const playwrightDirectory = absoluteEnvironmentPath('PLAYWRIGHT_MODULE_DIR');
const outputDirectory = absoluteEnvironmentPath('QA_OUTPUT_DIR');
const browserExecutable = absoluteEnvironmentPath('BROWSER_EXECUTABLE', true);
const previewOrigin = localPreviewOrigin(process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:5371');
const packageMetadata = JSON.parse(await readFile(join(playwrightDirectory, 'package.json'), 'utf8'));
if (packageMetadata.name !== 'playwright') throw new Error('PLAYWRIGHT_MODULE_DIR must identify the playwright package.');
const require = createRequire(import.meta.url);
const { chromium } = require(playwrightDirectory);

const assert = (value, message) => { if (!value) throw new Error(message); };
const settleFrames = page => page.evaluate(() => new Promise(resolveFrame => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
}));
async function openAccounting(page) {
  await page.getByRole('button', { name: 'Accounting', exact: true }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button =>
    button.textContent.trim() === 'Accounting' && button.getAttribute('aria-current') === 'page'));
  await settleFrames(page);
}
const results = [];
let screenshots = 0;
await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({
  ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  headless: true,
});

try {
  for (const basis of ['cash', 'accrual']) {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));

      await page.goto(new URL('/tests/international-erp-pilot.html', previewOrigin).href, { waitUntil: 'networkidle' });
      await page.locator('[name=country]').selectOption('US');
      await page.locator('[name=line1]').fill('18 Example Street');
      await page.locator('[name=city]').fill('Brooklyn');
      await page.locator('[name=postalCode]').fill('11201');
      await page.locator('[name=subdivision]').selectOption('NY');
      await page.locator('button[type=submit]').click();
      await page.locator('[name=timeZone]').selectOption('America/New_York');
      await page.locator('[name=accountingBasis]').selectOption(basis);
      await page.locator('[name=invoiceNumberPrefix]').fill('INV');
      await page.locator('button[type=submit]').click();
      await page.locator('button[type=submit]').click();

      await page.getByRole('button', { name: 'Add a customer', exact: true }).click();
      await page.getByRole('button', { name: 'Save customer', exact: true }).click();
      await page.getByRole('button', { name: 'Prepare accepted estimate', exact: true }).click();
      await page.getByRole('button', { name: 'Create test invoice', exact: true }).click();
      const taxAlert = page.getByRole('alert');
      assert(await taxAlert.isVisible(), 'Tax-unconfigured issuance must be blocked.');
      assert((await taxAlert.innerText()).toLowerCase().includes('tax configuration is missing.'), 'The issuance failure must identify the missing tax configuration.');
      assert(await page.getByRole('button', { name: 'Record fictitious payment', exact: true }).count() === 0, 'Missing tax configuration must not create an invoice.');
      await page.locator('input[type=checkbox]').check();
      await page.getByRole('button', { name: 'Create test invoice', exact: true }).click();
      assert(await page.getByRole('button', { name: 'Record fictitious payment', exact: true }).isEnabled(), 'Invoice must be created only under the explicit fictitious exemption review.');

      await page.getByRole('button', { name: 'View invoice / PDF', exact: true }).click();
      const documentDialog = page.getByRole('dialog', { name: 'Fictitious invoice preview', exact: true });
      await documentDialog.waitFor({ state: 'visible' });
      assert(await documentDialog.evaluate(dialog => dialog.matches(':modal')), 'Invoice preview must be a native modal dialog.');
      const closeDocument = page.getByRole('button', { name: 'Close document', exact: true });
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Close document');
      assert(await closeDocument.evaluate(button => document.activeElement === button), 'Opening the preview must focus Close document.');
      const printFrame = page.frameLocator('iframe');
      await printFrame.getByRole('heading', { name: /Invoice/ }).waitFor();
      const printed = await printFrame.locator('body').innerText();
      assert(printed.includes('$1,250.00'), 'Print projection must preserve the exact USD amount.');
      assert(!printed.includes('QR'), 'US documents must not include Swiss QR.');
      await page.keyboard.press('Escape');
      await documentDialog.waitFor({ state: 'hidden' });
      await settleFrames(page);
      assert(await page.getByRole('button', { name: 'View invoice / PDF', exact: true }).evaluate(button => document.activeElement === button), 'Escape must close the preview and restore focus to View invoice / PDF.');
      await page.getByRole('button', { name: 'View invoice / PDF', exact: true }).click();
      await documentDialog.waitFor({ state: 'visible' });
      assert(await documentDialog.evaluate(dialog => dialog.matches(':modal')), 'Reopening must preserve the native modal behavior.');
      await closeDocument.click();
      await documentDialog.waitFor({ state: 'hidden' });

      await openAccounting(page);
      let text = await page.locator('main').innerText();
      assert(text.includes((basis === 'cash' ? 0 : 1) + ' journal entries'), 'Issue posting must match the selected accounting basis.');
      await page.getByRole('button', { name: 'Sales', exact: true }).click();
      await page.getByRole('button', { name: 'Record fictitious payment', exact: true }).click();
      assert(await page.getByRole('button', { name: 'Record fictitious payment', exact: true }).isDisabled(), 'The fictitious payment must not be duplicated.');
      assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), 'Sales must have no horizontal overflow.');
      await page.screenshot({ path: join(outputDirectory, basis + '-' + width + '-sales.png'), fullPage: true });
      screenshots += 1;

      await openAccounting(page);
      text = await page.locator('main').innerText();
      assert(text.includes('Trial balance: Balanced · ' + (basis === 'cash' ? 1 : 2) + ' journal entries'), 'The final ledger must balance with the expected number of postings.');
      assert(text.includes('$1,250.00'), 'Accounting must preserve the exact USD total.');
      assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), 'Accounting must have no horizontal overflow.');
      await page.screenshot({ path: join(outputDirectory, basis + '-' + width + '-accounting.png'), fullPage: true });
      screenshots += 1;
      assert(errors.length === 0, 'The fixture must produce no JavaScript page errors.');
      results.push({ basis, width, customer: true, estimate: true, taxMissingBlocked: true, fixtureInvoice: true, exactUsdPrint: true, nativeModal: true, escapeFocusRestore: true, buttonDismiss: true, paymentOnce: true, balanced: true, errors });
      await page.close();
    }
  }
  assert(results.length === 4 && screenshots === 8, 'Expected four complete flows and eight screenshots.');
  await writeFile(join(outputDirectory, 'result.json'), JSON.stringify({
    passed: results.length,
    screenshots,
    results,
    scope: 'Shared core wired into development fixture only, synthetic authority and tax evidence; no native DB, Supabase, Stripe, mail, account provisioning or US tax compliance.',
  }, null, 2));
  console.log(JSON.stringify({ passed: results.length, screenshots }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
