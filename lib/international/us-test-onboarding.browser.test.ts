import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { build } from 'vite';
import { usTestOnboardingCopy } from './us-test-onboarding-copy';

/** Actual React UI, synthetic in-memory API responses. Backend SQL composition
 * is tested separately. No hosted Auth/provider/payment or native-device claim. */
it.skipIf(process.env.ZENTRA_US_ONBOARDING_BROWSER_QA !== '1')('checks explicit recovery, auth purge, keyboard and four-language light/dark layouts', async () => {
  const directory = resolve('.qa/us-saas-test/browser'), client = resolve(directory, 'client');
  await mkdir(directory, { recursive: true });
  await build({ configFile: false, publicDir: false, resolve: { alias: { '@': resolve('.') } }, build: { outDir: client, emptyOutDir: true, rolldownOptions: { input: resolve('tests/us-test-onboarding-preview.html') } }, logLevel: 'warn' });
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const path = resolve(client, '.' + pathname);
      if (!path.startsWith(client + sep)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html'); res.end(await readFile(path));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const require = createRequire(import.meta.url);
  const { chromium } = require('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce' }), page = await context.newPage();
  const errors: string[] = [], captures: string[] = [], metrics: unknown[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const open = async (query = '') => { await page.goto(origin + '/tests/us-test-onboarding-preview.html?' + query); await page.evaluate(() => document.fonts.ready); await expect.poll(() => page.locator('fieldset[disabled]').count()).toBe(0); };
  const fixture = async (action: 'setPaid' | 'dropNextCreation' | 'dropNextCheckout' | 'revoke') => page.evaluate((name: string) => { (window as unknown as { __US_TEST_ONBOARDING_FIXTURE__: Record<string, () => void> }).__US_TEST_ONBOARDING_FIXTURE__[name](); }, action);
  const requests = async () => page.evaluate(() => (window as unknown as { __US_TEST_ONBOARDING_FIXTURE__: { requests: { method: string; path: string; body: string }[] } }).__US_TEST_ONBOARDING_FIXTURE__.requests);
  try {
    const c = usTestOnboardingCopy.en; await page.setViewportSize({ width: 1280, height: 900 }); await open();
    expect((await requests()).length).toBe(0);
    await page.getByRole('button', { name: c.create, exact: true }).click();
    await expect.poll(() => page.locator('[aria-invalid=true]').count()).toBe(7);
    expect(await page.locator('input[name=companyName]').evaluate((el: HTMLElement) => el === document.activeElement)).toBe(true);
    await page.locator('input[name=companyName]').fill('Fictitious UI Company'); await page.keyboard.press('Tab');
    expect(await page.locator('input[name=line1]').evaluate((el: HTMLElement) => el === document.activeElement)).toBe(true);
    await page.locator('input[name=line1]').fill('1 Example Street'); await page.locator('input[name=city]').fill('New York');
    await page.locator('select[name=subdivision]').selectOption('NY'); await page.locator('input[name=postalCode]').fill('10001');
    await page.locator('select[name=timeZone]').selectOption('America/New_York'); await page.locator('select[name=accountingBasis]').selectOption('accrual');
    await page.getByLabel(c.confirmCompany, { exact: true }).check(); await fixture('dropNextCreation'); await page.getByRole('button', { name: c.create, exact: true }).click();
    await page.getByRole('button', { name: c.retryCreation, exact: true }).waitFor(); await page.getByRole('button', { name: c.retryCreation, exact: true }).click();
    await page.getByRole('heading', { name: c.offers, exact: true }).waitFor();
    const creationRequests = (await requests()).filter((row: { path: string }) => row.path === '/api/international/workspaces'); expect(creationRequests.length).toBe(2); expect(creationRequests[0].body).toBe(creationRequests[1].body);
    await page.getByRole('radio').check(); await page.getByLabel(c.confirmTest, { exact: true }).check(); await fixture('dropNextCheckout');
    await page.getByRole('button', { name: c.continue, exact: true }).click(); await page.getByRole('button', { name: c.retryCheckout, exact: true }).waitFor();
    await page.getByRole('button', { name: c.retryCheckout, exact: true }).click(); await page.getByRole('link', { name: c.checkout, exact: true }).waitFor();
    const checkoutRequests = (await requests()).filter((row: { path: string }) => row.path === '/api/international/billing/test'); expect(checkoutRequests.length).toBe(2); expect(checkoutRequests[0].body).toBe(checkoutRequests[1].body);
    expect(await page.getByRole('link', { name: c.checkout, exact: true }).getAttribute('href')).toBe('https://checkout.stripe.com/c/pay/cs_test_LocalFictitiousOnly');
    await page.getByRole('button', { name: c.recover, exact: true }).click(); await page.getByText(c.paymentUnconfirmed, { exact: true }).waitFor(); expect(await page.getByRole('link', { name: c.open, exact: true }).count()).toBe(0);
    await fixture('setPaid'); await page.getByRole('button', { name: c.recover, exact: true }).click(); await page.getByRole('link', { name: c.open, exact: true }).waitFor();
    expect(await page.evaluate(() => Object.values(sessionStorage).length)).toBe(1);
    expect(await page.evaluate(() => Object.values(sessionStorage).every(value => /^[0-9a-f-]{36}$/.test(value)))).toBe(true);
    await fixture('revoke'); await page.getByText(c.denied, { exact: true }).waitFor(); expect(await page.locator('.us-test-company').count()).toBe(0); expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    await open('scenario=pending'); expect((await requests()).every((row: { method: string }) => row.method === 'GET')).toBe(true);
    await page.getByRole('button', { name: c.reopenCheckout, exact: true }).click(); await page.getByRole('link', { name: c.checkout, exact: true }).waitFor();
    const reopened = (await requests()).filter((row: { method: string }) => row.method === 'POST'); expect(reopened.length).toBe(1); expect(JSON.parse(reopened[0].body)).toMatchObject({module:'gestion',plan:'synthetic-monthly',confirmTest:true});
    await open('scenario=expired'); expect(await page.getByRole('button', { name: c.reopenCheckout, exact: true }).count()).toBe(0); expect((await requests()).every((row: { method: string }) => row.method === 'GET')).toBe(true);
    await open('scenario=returned'); expect(await page.getByRole('link', { name: c.open, exact: true }).count()).toBe(0); expect((await requests()).every((row: { method: string }) => row.method === 'GET')).toBe(true);
    await open('scenario=reserved'); await page.getByRole('button', { name: c.recover, exact: true }).click(); await page.getByRole('heading', { name: c.offers, exact: true }).waitFor();
    for (const language of ['fr','de','it','en'] as const) for (const theme of ['light','dark'] as const) for (const scenario of ['offers','pending','ready'] as const) {
      await page.setViewportSize({ width: 320, height: 900 }); await open(`lang=${language}&theme=${theme}&scenario=${scenario}`);
      await page.addStyleTag({ content: 'html{font-size:200%}' });
      const metric = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, controls: Array.from(document.querySelectorAll('.us-test-onboarding button,.us-test-onboarding a.account-button,.us-test-onboarding input:not([type=radio]):not([type=checkbox]),.us-test-onboarding select')).filter(el => (el as HTMLElement).getBoundingClientRect().width > 0).map(el => ({ height: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right, left: el.getBoundingClientRect().left })), color: getComputedStyle(document.querySelector('.us-test-onboarding')!).color }));
      expect(metric.scrollWidth).toBeLessThanOrEqual(320); expect(metric.controls.every((control: { height: number; left: number; right: number }) => control.height >= 44 && control.left >= 0 && control.right <= 320)).toBe(true);
      metrics.push({ language, theme, scenario, ...metric });
      if (scenario === 'offers') { const name = `offers-${language}-${theme}-320-text200.png`; await page.screenshot({ path: resolve(directory, name), fullPage: true }); captures.push(name); }
    }
    await page.evaluate(() => sessionStorage.clear());
    for (const theme of ['light','dark']) { await page.setViewportSize({ width: 1280, height: 900 }); await open('lang=en&theme='+theme); const name = `creation-en-${theme}-1280.png`; await page.screenshot({ path: resolve(directory,name), fullPage:true }); captures.push(name); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280); }
    expect(errors).toEqual([]);
    await writeFile(resolve(directory, 'evidence.json'), JSON.stringify({ scope: 'Actual React UI with synthetic in-memory HTTP; backend HTTP/SQLite tested separately; no provider/hosted/native proof.', exactCreationReplay:true, exactCheckoutReplay:true, noAutomaticPostOnReloadOrReturn:true, explicitSameCheckoutReopen:true, unpaidDoesNotShowReady:true, syntheticPaidRecovery:true, expiredNoNewPurchase:true, reservedResume:true, opaqueOnlySessionStorage:true, authPurge:true, keyboardAndInvalidFieldFocus:true, captures, metrics, errors }, null, 2));
  } catch (error) { await writeFile(resolve(directory,'failure.txt'),String(error)); await page.screenshot({ path:resolve(directory,'failure.png'),fullPage:true }); throw error; }
  finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
}, 120_000);
