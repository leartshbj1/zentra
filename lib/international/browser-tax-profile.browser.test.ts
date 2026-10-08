import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { build } from 'vite';
import { AUTH_CHANGED_EVENT } from '../auth-browser-events';
import { browserTaxProfileCopy } from './browser-tax-profile-copy';
import { validateUsTaxProfileWrite, type UsTaxFacts, type UsTaxProfileReceipt, type UsTaxProfileState } from './us-tax-profile';
import type { AccountRole } from '../account-security';

const enabled = process.env.ZENTRA_BROWSER_TAX_PROFILE_QA === '1';
it.skipIf(!enabled)('checks private owner tax settings in the actual four-language workbench', async () => {
  const directory = resolve('.qa/us-tax-browser'), clientDir = resolve(directory, 'client'); await mkdir(directory, { recursive: true });
  const organizationId = 'us-private-ui', userId = 'owner-private-ui';
  const facts: UsTaxFacts = { schemaVersion: 1, legalName: 'Private Fictitious Legal Company', taxOrigin: { country: 'US', line1: '1 Fictitious Private Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, timeZone: 'America/New_York' };
  let state: UsTaxProfileState = { status: 'declared', organizationId, revision: 1, facts, verification: 'unverified', updatedBy: userId, updatedAt: new Date().toISOString() };
  let serverRole: AccountRole = 'owner', deniedPublic: 'erp' | 'seller' | null = null, dropNext = false;
  let taxGets = 0, taxCommits = 0, releaseTax: () => void = () => {}, holdTax: Promise<void> | null = null;
  const requests: { path: string; method: string; expectedUser: string | undefined; body: string }[] = [], receipts = new Map<string, { body: string; receipt: UsTaxProfileReceipt }>();
  const errors: string[] = [], views: unknown[] = [];
  await writeFile(resolve(directory, 'entry.tsx'), `import {createRoot} from 'react-dom/client';import {UsErpWorkbench} from '@/components/account/us-erp-workbench';import '@/app/compte/account.css';import '@/app/apple-account.css';const q=new URLSearchParams(location.search),root=createRoot(document.getElementById('root'));let props={organizationId:'${organizationId}',expectedUserId:'${userId}',role:q.get('role')||'owner',language:q.get('lang')||'en'};document.documentElement.lang=props.language;function paint(){root.render(<div className="account-experience account-detail" data-theme={q.get('theme')==='dark'?'dark':'light'}><main className="account-content"><UsErpWorkbench {...props}/></main></div>)}window.__setWorkbench=next=>{props={...props,...next};paint()};paint();`);
  await writeFile(resolve(directory, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local private tax UI proof</title><style>:root{--font-geist-sans:Arial,sans-serif}body{margin:0}*{box-sizing:border-box}button,input,select,textarea{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await build({ configFile: false, root: directory, resolve: { alias: { '@': resolve('.') } }, build: { outDir: clientDir, emptyOutDir: true }, logLevel: 'warn' });
  const server = createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, url = new URL(req.url || '/', origin);
      const matched = url.pathname.match(/^\/api\/international\/workspaces\/([^/]+)\/(erp|seller|tax-profile)$/);
      if (matched) {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString('utf8');
        const org = decodeURIComponent(matched[1]), channel = matched[2]; requests.push({ path: url.pathname, method: req.method ?? 'GET', expectedUser: req.headers['x-zentra-expected-user'] as string | undefined, body });
        const reply = (status: number, payload: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
        if (deniedPublic === channel) { reply(403, { error: 'forbidden' }); return; }
        if (channel === 'erp') { reply(200, { status: 'uninitialized', configuration: { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: 'Public ERP Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } } }); return; }
        if (channel === 'seller') { reply(200, { status: 'unconfigured', organizationId: org, revision: 0 }); return; }
        if (req.method === 'GET') taxGets++;
        if (serverRole !== 'owner' || req.headers['x-zentra-expected-user'] !== userId) { reply(403, { error: 'forbidden' }); return; }
        if (req.method === 'GET') {
          const snapshot = org === organizationId ? structuredClone(state) : { status: 'unconfigured', organizationId: org, revision: 0, verification: 'unverified' };
          if (holdTax) await holdTax;
          reply(200, snapshot); return;
        }
        if (req.method !== 'PUT' || org !== organizationId) { reply(422, { error: 'invalid_request' }); return; }
        const write = validateUsTaxProfileWrite(JSON.parse(body)), prior = receipts.get(write.requestId);
        if (prior) { reply(prior.body === body ? 200 : 409, prior.body === body ? { ...prior.receipt, replayed: true } : { error: 'request_id_conflict' }); return; }
        if (write.expectedRevision !== state.revision) { reply(409, { error: 'revision_conflict' }); return; }
        state = { status: 'declared', organizationId, revision: state.revision + 1, facts: write.facts, verification: 'unverified', updatedBy: userId, updatedAt: new Date().toISOString() };
        const receipt = { ...state, requestId: write.requestId, replayed: false }; receipts.set(write.requestId, { body, receipt }); taxCommits++;
        if (dropNext) { dropNext = false; reply(503, { error: 'service_unavailable' }); return; }
        reply(200, receipt); return;
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.includes('..')) { res.writeHead(404); res.end(); return; }
      let asset: Buffer; try { asset = await readFile(resolve(clientDir, file)); } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }); res.end(asset);
    } catch { if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end('Synthetic local UI fixture unavailable'); } }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const require = createRequire(import.meta.url), { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 920 }, reducedMotion: 'reduce' }); page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(origin); const panel = page.locator('.us-tax-profile'); await panel.locator('.us-tax-editor').waitFor();
    expect(await panel.locator('details').evaluate((node: HTMLDetailsElement) => node.open)).toBe(false);
    expect(await panel.locator('.us-tax-status').textContent()).toBe(browserTaxProfileCopy.en.declared);
    await panel.locator('summary').click(); await panel.getByLabel('Company legal name', { exact: true }).fill('Keep private dirty draft');
    await panel.getByRole('button', { name: 'Reload private details', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.us-tax-profile button.secondary')?.disabled);
    expect(await panel.getByLabel('Company legal name', { exact: true }).inputValue()).toBe('Keep private dirty draft');
    // Invalid US ZIP is stopped by the actual form, with no network mutation.
    const beforeInvalid = requests.filter(request => request.method === 'PUT').length;
    await panel.getByLabel('Origin ZIP code', { exact: true }).fill('1000'); await panel.getByRole('button', { name: 'Save declared details', exact: true }).click();
    expect(requests.filter(request => request.method === 'PUT').length).toBe(beforeInvalid);
    await panel.getByLabel('Origin ZIP code', { exact: true }).fill('11201');
    dropNext = true; await panel.getByRole('button', { name: 'Save declared details', exact: true }).click(); await panel.getByRole('button', { name: 'Retry same private request', exact: true }).waitFor();
    const original = requests.filter(request => request.method === 'PUT').at(-1)!.body;
    expect(taxCommits).toBe(1); expect(await page.getByRole('button', { name: 'Initialize workspace', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Save seller details', exact: true }).isDisabled()).toBe(true);
    const getBeforeRetry = taxGets;
    await panel.getByRole('button', { name: 'Retry same private request', exact: true }).click(); await panel.getByText(browserTaxProfileCopy.en.saved, { exact: true }).waitFor();
    expect(taxCommits).toBe(1); expect(taxGets).toBe(getBeforeRetry + 2); expect(requests.filter(request => request.method === 'PUT').at(-1)!.body).toBe(original);
    expect(state.verification).toBe('unverified'); expect(requests.some(request => request.method === 'POST')).toBe(false);
    // An explicit conflict preserves draft; only reloading enables a new confirmed change.
    await panel.getByLabel('Company legal name', { exact: true }).fill('New private conflict draft');
    if (state.status === 'declared') state = { ...state, revision: state.revision + 1 };
    await panel.getByRole('button', { name: 'Save declared details', exact: true }).click(); await panel.getByText(browserTaxProfileCopy.en.conflict, { exact: true }).waitFor();
    expect(await panel.getByRole('button', { name: 'Save declared details', exact: true }).isDisabled()).toBe(true);
    await panel.getByRole('button', { name: 'Reload private details', exact: true }).click(); await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('.us-tax-profile fieldset')?.disabled);
    expect(await panel.getByLabel('Company legal name', { exact: true }).inputValue()).toBe('New private conflict draft');
    dropNext = true; await panel.getByRole('button', { name: 'Save declared details', exact: true }).click(); await panel.getByRole('button', { name: 'Retry same private request', exact: true }).waitFor();
    // Shared busy fence disables sibling reloads while a private read is held.
    holdTax = new Promise<void>(done => { releaseTax = done; });
    await panel.getByRole('button', { name: 'Reload private details', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector<HTMLButtonElement>('.us-erp-toolbar button')?.disabled);
    expect(await page.getByRole('button', { name: 'Reload seller details', exact: true }).isDisabled()).toBe(true);
    const beforeAuth = taxGets; await page.evaluate((name: string) => window.dispatchEvent(new Event(name)), AUTH_CHANGED_EVENT);
    await panel.getByText(browserTaxProfileCopy.en.denied, { exact: true }).waitFor();
    expect(await panel.locator('input,select').count()).toBe(0); expect(await panel.getByRole('button', { name: 'Retry same private request', exact: true }).count()).toBe(0);
    releaseTax(); holdTax = null;
    await page.getByRole('button', { name: 'Reload data', exact: true }).click(); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.us-erp-toolbar button')?.disabled);
    expect(taxGets).toBe(beforeAuth); expect(await panel.locator('input,select').count()).toBe(0);
    expect(await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('private')))).toBe(false);
    // A non-owner role remount purges private DOM and performs no private GET.
    const beforeRole = taxGets; await page.evaluate(() => (window as unknown as { __setWorkbench: (value: unknown) => void }).__setWorkbench({ role: 'member' }));
    await panel.getByText(browserTaxProfileCopy.en.ownerOnly, { exact: true }).waitFor(); expect(taxGets).toBe(beforeRole); expect(await panel.locator('input,select').count()).toBe(0);
    // Tenant and account replacement cannot display a prior owner's facts.
    await page.evaluate(() => (window as unknown as { __setWorkbench: (value: unknown) => void }).__setWorkbench({ role: 'owner', organizationId: 'other-private-ui' }));
    await panel.locator('details').waitFor(); await panel.locator('summary').click(); expect(await panel.getByLabel('Company legal name', { exact: true }).inputValue()).toBe('');
    await page.evaluate(() => (window as unknown as { __setWorkbench: (value: unknown) => void }).__setWorkbench({ expectedUserId: 'different-account' }));
    await panel.getByText(browserTaxProfileCopy.en.denied, { exact: true }).waitFor(); expect(await panel.locator('input,select').count()).toBe(0);
    // SSR owner can be stale even though public reads still admit a member.
    serverRole = 'member'; const staleOwner = await browser.newPage(); await staleOwner.goto(origin);
    await staleOwner.locator('.us-tax-profile').getByText(browserTaxProfileCopy.en.denied, { exact: true }).waitFor(); const afterOwnerRefusal = taxGets;
    await staleOwner.getByRole('button', { name: 'Reload data', exact: true }).click(); await staleOwner.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.us-erp-toolbar button')?.disabled);
    expect(taxGets).toBe(afterOwnerRefusal); expect(await staleOwner.locator('.us-tax-profile input,.us-tax-profile select').count()).toBe(0); await staleOwner.close(); serverRole = 'owner';
    // If public admission already refused this stale owner, no tax GET is made.
    for (const deniedChannel of ['erp', 'seller'] as const) {
      deniedPublic = deniedChannel; const before = taxGets; const refused = await browser.newPage(); await refused.goto(origin);
      await refused.locator('.us-tax-profile').getByText(browserTaxProfileCopy.en.denied, { exact: true }).waitFor(); expect(taxGets).toBe(before); await refused.close();
    }
    deniedPublic = null;
    for (const nonOwner of ['admin', 'accountant', 'member', 'read_only']) {
      const before = taxGets, view = await browser.newPage(); await view.goto(`${origin}/?role=${nonOwner}`); await view.locator('.us-tax-profile').getByText(browserTaxProfileCopy.en.ownerOnly, { exact: true }).waitFor();
      await view.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.us-erp-toolbar button')?.disabled); expect(taxGets).toBe(before); expect(await view.locator('.us-tax-profile input,.us-tax-profile select').count()).toBe(0); await view.close();
    }
    if (state.status === 'declared') state = { ...state, facts: { ...state.facts, legalName: 'Private Fictitious Legal Company '.repeat(7).trim() } };
    // One batch includes narrow mobile and actual root-text scaling, preserving
    // the viewport width instead of simulating zoom by shrinking the screenshot.
    const scenarios = [{ width: 320, textScale: 100 }, { width: 320, textScale: 200 }, { width: 390, textScale: 100 }, { width: 1280, textScale: 100 }];
    for (const language of ['fr', 'de', 'it', 'en'] as const) for (const theme of ['light', 'dark']) for (const { width, textScale } of scenarios) {
      const view = await browser.newPage({ viewport: { width, height: 920 }, reducedMotion: 'reduce' }); view.on('pageerror', (error: Error) => errors.push(error.message));
      await view.goto(`${origin}/?lang=${language}&theme=${theme}`); const section = view.locator('.us-tax-profile'); await section.locator('details').waitFor();
      if (textScale === 200) await view.addStyleTag({ content: 'html{font-size:200%!important}' });
      await section.locator('summary').focus(); await view.keyboard.press('Enter'); expect(await section.locator('details').evaluate((node: HTMLDetailsElement) => node.open)).toBe(true);
      expect(await section.getByLabel(browserTaxProfileCopy[language].legalName, { exact: true }).inputValue()).toBe(state.status === 'declared' ? state.facts.legalName : '');
      const stateSelect = section.getByRole('combobox', { name: browserTaxProfileCopy[language].state, exact: true }), zoneSelect = section.getByRole('combobox', { name: browserTaxProfileCopy[language].timeZone, exact: true });
      expect(await section.getByLabel(browserTaxProfileCopy[language].state, { exact: true }).getAttribute('id')).toBe(await stateSelect.getAttribute('id'));
      expect(await section.getByLabel(browserTaxProfileCopy[language].timeZone, { exact: true }).getAttribute('id')).toBe(await zoneSelect.getAttribute('id'));
      await stateSelect.selectOption('DC'); await stateSelect.focus(); await view.keyboard.press('ArrowDown'); expect(await stateSelect.inputValue()).toBe('FL');
      await zoneSelect.selectOption('America/Indiana/Indianapolis'); await zoneSelect.focus(); await view.keyboard.press('ArrowDown'); expect(await zoneSelect.inputValue()).toBe('America/Indiana/Vincennes');
      await stateSelect.selectOption('DC'); await zoneSelect.selectOption('America/Indiana/Indianapolis');
      const dimensions = await view.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth, rootFontSize: getComputedStyle(document.documentElement).fontSize, inputs: [...document.querySelectorAll<HTMLInputElement>('.us-tax-profile input,.us-tax-profile select')].map(input => ({ height: input.getBoundingClientRect().height, width: input.getBoundingClientRect().width, left: input.getBoundingClientRect().left, right: input.getBoundingClientRect().right, label: input.labels?.[0]?.textContent, labelWidth: input.labels?.[0]?.getBoundingClientRect().width, fontSize: getComputedStyle(input).fontSize, animation: getComputedStyle(input).animationName, transition: getComputedStyle(input).transitionDuration, ...(input.tagName === 'SELECT' ? { optionCount: (input as unknown as HTMLSelectElement).options.length, selectedText: (input as unknown as HTMLSelectElement).selectedOptions[0]?.text } : {}) })), controls: [...document.querySelectorAll<HTMLElement>('.us-tax-profile input,.us-tax-profile select,.us-tax-profile button,.us-tax-profile summary')].map(control => ({ tag: control.tagName, height: control.getBoundingClientRect().height, width: control.getBoundingClientRect().width, left: control.getBoundingClientRect().left, right: control.getBoundingClientRect().right })) }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport); expect(dimensions.inputs.every((input: { height: number; label: string }) => input.height >= 44 && input.label)).toBe(true);
      expect(dimensions.controls.every((control: { height: number; width: number; left: number; right: number }) => control.height >= 44 && control.width >= 44 && control.left >= 0 && control.right <= dimensions.viewport)).toBe(true);
      expect(dimensions.inputs.every((input: { width: number; labelWidth: number }) => input.width === input.labelWidth)).toBe(true);
      expect(dimensions.rootFontSize).toBe(textScale === 200 ? '32px' : '16px');
      const captureName = `${language}-${theme}-${width}${textScale === 200 ? '-text200' : ''}`;
      if (width === 320 && textScale === 200) await writeFile(resolve(directory, `${captureName}-accessibility.yaml`), await section.ariaSnapshot());
      await section.screenshot({ path: resolve(directory, `${captureName}.png`) });
      await section.evaluate((element: HTMLElement) => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await view.screenshot({ path: resolve(directory, `${captureName}-viewport.png`), fullPage: false });
      views.push({ language, theme, width, textScale, ...dimensions, panelCapture: `${captureName}.png`, viewportCapture: `${captureName}-viewport.png` }); await view.close();
    }
    expect(errors).toEqual([]); expect(requests.filter(request => request.path.endsWith('/tax-profile')).every(request => request.expectedUser)).toBe(true);
    await writeFile(resolve(directory, 'browser.json'), JSON.stringify({ success: true, scope: 'Actual React workbench, private session and CSS. Synthetic local HTTP/Auth/persistence only; no real provider, hosted database, D1, customer facts or production.', views, errors, taxGets, taxCommits, operations: ['collapsed private editor', 'four languages and two themes', 'keyboard controls', 'US validation', 'dirty draft retained', 'postcommit503 exact retry with owner GET', 'revision conflict requires explicit reload', 'shared busy and pending', 'Auth purge and late response withheld', 'role tenant account replacement', 'stale SSR owner public refusal makes no private GET', 'non-owner roles make no private GET', 'no persistent private browser storage', 'no issuance/grant'], requests: requests.map(request => ({ path: request.path, method: request.method, expectedUser: request.expectedUser })) }, null, 2));
  } finally { releaseTax(); await browser.close(); await new Promise<void>(done => server.close(() => done())); }
}, 120_000);
