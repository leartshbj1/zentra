import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { build } from 'vite';
import { AUTH_CHANGED_EVENT } from '../auth-browser-events';
import { AccountPublicError, type AccountRole } from '../account-security';
import { browserPurchasingCopy } from './browser-purchasing-copy';
import { browserWorkbenchCopy } from './browser-workbench-copy';
import { createErpHandlers } from './runtime-server';
import { createUsSellerProfileHandlers } from './seller-profile-server';
import { createUsTaxProfileHandlers } from './us-tax-profile-server';
import { ErpError } from './erp-contract';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { applyErpDelta, type ErpEvent } from './runtime-sync';
import type { ErpCommit, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';

// Opt-in local browser proof: actual React, HTTP, engine, delta and validation.
// Auth and CAS persistence are explicit synthetic RAM fixtures. There is no
// PostgreSQL, tax provider, bank transfer, hosted deployment or production proof.
it.skipIf(process.env.ZENTRA_BROWSER_PURCHASING_QA !== '1')('runs the real purchasing UI through manual approval, partial payments and exact recovery', async () => {
  const directory = resolve('.qa/us-purchasing-browser'), clientDir = resolve(directory, 'client');
  await mkdir(directory, { recursive: true });
  const organizationId = '10000000-0000-4000-8000-000000000051', userId = '10000000-0000-4000-8000-000000000052';
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Example Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
  let state: ErpState | null = null, commits = 0, role: AccountRole = 'owner', revoked = false, dropNext = false, holdNextRead = false;
  let heldReached: (() => void) | null = null, releaseRead: (() => void) | null = null, taxCalls = 0, sellerCalls = 0;
  const releaseHeldRead = () => releaseRead?.();
  const receipts = new Map<string, ErpReceipt>(), writes: string[] = [], requests: { method: string; capability: string | null; expectedUser: string | null }[] = [];
  const store: ErpStore = {
    supportedSchemaVersion: 2,
    read: async org => { if (org !== organizationId) throw new ErpError('tenant_mismatch', 403); return structuredClone(state); },
    receipt: async (org, key) => { if (org !== organizationId) throw new ErpError('tenant_mismatch', 403); return structuredClone(receipts.get(key) ?? null); },
    commit: async (input: ErpCommit) => {
      if (input.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      const earlier = receipts.get(input.receipt.idempotencyKey);
      if (earlier) { if (earlier.commandHash !== input.receipt.commandHash) throw new ErpError('idempotency_conflict', 409); return structuredClone(earlier); }
      if ((state?.revision ?? 0) !== input.expectedRevision) throw new ErpError('revision_conflict', 409);
      const event: ErpEvent = { schemaVersion: input.header.schemaVersion, organizationId, revision: input.header.revision, header: input.header, changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: input.actor.userId, occurredAt: input.actor.timestamp };
      state = applyErpDelta(state, { schemaVersion: event.schemaVersion, organizationId, fromRevision: input.expectedRevision, toRevision: input.header.revision, headRevision: input.header.revision, hasMore: false, resetRequired: false, events: [event] }, organizationId, 2);
      receipts.set(input.receipt.idempotencyKey, structuredClone(input.receipt)); commits++;
      return structuredClone(input.receipt);
    },
  };
  const authority = async () => { if (revoked) throw new AccountPublicError('Synthetic Auth refusal', 401); return { mode: 'browser' as const, actor: { organizationId, userId, role, managementEntitled: true, timestamp: new Date().toISOString() } }; };
  const shared = { enabled: () => true, authority, configuration: async () => configuration, rateLimit: async () => {}, diagnostic: () => {} };
  const handlers = createErpHandlers({ ...shared, store: clientCapability => ({ ...store, supportedSchemaVersion: clientCapability ?? 1 }), taxProvider: async () => { taxCalls++; return null; }, seller: async () => { sellerCalls++; return null; } });
  // Real setup HTTP/services, read-only unconfigured RPC fixtures. Neither
  // successful seller configuration nor tax declarations are prerequisites.
  const sellerHandlers = createUsSellerProfileHandlers({ ...shared, store: () => ({ rpc: async <T>(name: string): Promise<T> => {
    if (name !== 'zentra_read_us_seller_profile') throw new Error('No seller write expected');
    return { status: 'unconfigured', organizationId, revision: 0 } as T;
  } }) });
  const taxHandlers = createUsTaxProfileHandlers({ ...shared, store: () => ({ rpc: async <T>(name: string): Promise<T> => {
    if (name !== 'zentra_read_us_tax_profile') throw new Error('No private tax write expected');
    return { status: 'unconfigured', organizationId, revision: 0, verification: 'unverified' } as T;
  } }) });
  await writeFile(resolve(directory, 'entry.tsx'), `import {createRoot} from 'react-dom/client';import {UsErpWorkbench} from '@/components/account/us-erp-workbench';import '@/app/compte/account.css';import '@/app/apple-account.css';const q=new URLSearchParams(location.search);const language=['fr','de','it','en'].includes(q.get('lang')||'')?q.get('lang'):'en';const role=['owner','admin','accountant','member','read_only'].includes(q.get('role')||'')?q.get('role'):'owner';document.documentElement.style.fontSize=q.get('large')==='1'?'200%':'100%';createRoot(document.getElementById('root')).render(<div className="account-experience account-detail" data-theme={q.get('theme')==='dark'?'dark':'light'}><main className="account-content"><UsErpWorkbench organizationId="${organizationId}" expectedUserId="${userId}" role={role} language={language} supportedSchemaVersion={q.get('legacy')==='1'?1:2}/></main></div>);`);
  await writeFile(resolve(directory, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fictitious local purchase proof</title><style>:root{--font-geist-sans:Arial,sans-serif}body{margin:0}*{box-sizing:border-box}button,input,select,textarea{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await build({ configFile: false, root: directory, resolve: { alias: { '@': resolve('.') } }, build: { outDir: clientDir, emptyOutDir: true }, logLevel: 'warn' });
  const server = createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith(`/api/international/workspaces/${organizationId}/`)) {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString('utf8');
        const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(['POST', 'PUT'].includes(req.method ?? '') ? { body } : {}) });
        const isErp = url.pathname.endsWith('/erp');
        if (isErp) { requests.push({ method: request.method, capability: request.headers.get(ERP_SCHEMA_HEADER), expectedUser: request.headers.get('X-Zentra-Expected-User') }); if (req.method === 'POST') writes.push(body); }
        const response = isErp ? req.method === 'POST' ? await handlers.POST(request, organizationId) : await handlers.GET(request, organizationId) : url.pathname.endsWith('/seller') ? await sellerHandlers.GET(request, organizationId) : await taxHandlers.GET(request, organizationId);
        const responseBody = await response.text();
        if (isErp && req.method === 'GET' && holdNextRead) { holdNextRead = false; await new Promise<void>(done => { releaseRead = done; heldReached?.(); }); }
        // Explicit simulation: a real commit followed by HTTP503, not a socket
        // loss or a claim about Chromium automatic network retry behavior.
        if (isErp && req.method === 'POST' && dropNext && response.status === 200) { dropNext = false; res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"service_unavailable"}'); return; }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(responseBody); return;
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.includes('..')) { res.writeHead(404); res.end(); return; }
      let asset: Buffer; try { asset = await readFile(resolve(clientDir, file)); } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }); res.end(asset);
    } catch { if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end('Local fixture unavailable'); } }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true }), views: unknown[] = [], summaryFocus: unknown[] = [], errors: string[] = [];
  const saved = (): ErpState => { if (!state) throw new Error('Uninitialized fixture'); return state; };
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 920 }, reducedMotion: 'reduce' }); page.on('pageerror', (error: Error) => errors.push(error.message));
    const p = browserPurchasingCopy.en, c = browserWorkbenchCopy.en;
    const open = async (summary: string) => { const detail = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: summary }) }); if (!await detail.evaluate((node: HTMLDetailsElement) => node.open)) await detail.locator('summary').click(); };
    const idle = async () => { await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('.us-erp-toolbar button'); return !!button && !button.disabled; }); };
    const checkClosedSummaryFocus = async (language: keyof typeof browserPurchasingCopy, theme: string, width: number, text: string) => {
      const copy = browserPurchasingCopy[language];
      for (const [index, label] of [copy.newVendor, copy.newBill, copy.newPayment].entries()) {
        const detail = page.locator('.us-erp-purchasing details').filter({ has: page.locator('summary').filter({ hasText: label }) }), summary = detail.locator('summary');
        expect(await detail.evaluate((node: HTMLDetailsElement) => node.open)).toBe(false);
        let reached = false;
        // Real sequential Tab navigation: no locator.focus() or synthetic focus
        // event can make this pass while the closed disclosure is untabbable.
        for (let step = 0; step < 60; step++) {
          await page.keyboard.press('Tab');
          if (await summary.evaluate((node: Element) => document.activeElement === node)) { reached = true; break; }
        }
        expect(reached).toBe(true);
        const indicator = await summary.evaluate((node: HTMLElement) => {
          const style = getComputedStyle(node), rect = node.getBoundingClientRect(), parent = node.parentElement!, clip = parent.getBoundingClientRect(), parentStyle = getComputedStyle(parent);
          const outlineWidth = parseFloat(style.outlineWidth), offset = parseFloat(style.outlineOffset), outside = outlineWidth + offset;
          const insideClip = rect.left - outside >= clip.left + parseFloat(parentStyle.borderLeftWidth) && rect.right + outside <= clip.right - parseFloat(parentStyle.borderRightWidth)
            && rect.top - outside >= clip.top + parseFloat(parentStyle.borderTopWidth) && rect.bottom + outside <= clip.bottom - parseFloat(parentStyle.borderBottomWidth);
          return { focusVisible: node.matches(':focus-visible'), outlineWidth, offset, style: style.outlineStyle, color: style.outlineColor, radius: parseFloat(style.borderTopLeftRadius), insideClip, parentOverflow: parentStyle.overflow };
        });
        expect(indicator.focusVisible).toBe(true); expect(indicator.outlineWidth).toBe(3); expect(indicator.offset + indicator.outlineWidth).toBeLessThanOrEqual(0); expect(indicator.style).toBe('solid'); expect(indicator.color).not.toBe('rgba(0, 0, 0, 0)'); expect(indicator.radius).toBe(14); expect(indicator.insideClip).toBe(true);
        expect(await detail.evaluate((node: HTMLDetailsElement) => node.open)).toBe(false);
        summaryFocus.push({ language, theme, width, text, summary: label, keyboard: 'Tab', closed: true, ...indicator });
        if (language === 'en' && width === 390 && text === '100%') await detail.screenshot({ path: resolve(directory, `focus-en-390-${theme}-${index + 1}.png`) });
      }
    };
    await page.goto(`${origin}/?legacy=1`); await page.getByRole('button', { name: c.initialize, exact: true }).waitFor();
    expect(await page.locator('.us-erp-purchasing').count()).toBe(0); expect(commits).toBe(0);
    await page.goto(origin); await page.getByLabel(c.periodStart, { exact: true }).fill('2026-01-01'); await page.getByLabel(c.periodEnd, { exact: true }).fill('2026-12-31'); await page.getByRole('button', { name: c.initialize, exact: true }).click(); await page.locator('.us-erp-purchasing').waitFor(); await idle();
    expect(saved().schemaVersion).toBe(1); expect(commits).toBe(1);
    await open(p.newVendor);
    const countryControl = page.getByRole('combobox', { name: p.country, exact: true }); await countryControl.focus(); await countryControl.press('ArrowDown'); expect(await countryControl.inputValue()).toBe('CH'); await countryControl.press('ArrowUp'); expect(await countryControl.inputValue()).toBe('US');
    expect(await countryControl.evaluate((node: HTMLElement) => getComputedStyle(node).outlineWidth)).toBe('3px');
    await page.getByLabel(p.vendorName, { exact: true }).fill('Fixture Supplier'); await page.getByLabel(p.address, { exact: true }).fill('1 Example Street'); await page.getByLabel(p.city, { exact: true }).fill('Brooklyn'); await page.getByLabel(p.subdivision, { exact: true }).selectOption('NY'); await page.getByLabel(p.postalCode, { exact: true }).fill('11201'); await page.getByLabel(p.terms, { exact: true }).fill('30');
    await page.getByRole('button', { name: p.saveVendor, exact: true }).click(); await page.getByRole('region', { name: p.vendors, exact: true }).getByText('Fixture Supplier', { exact: true }).waitFor(); await idle();
    expect(saved().schemaVersion).toBe(2); expect(commits).toBe(2); expect(await page.getByLabel(p.vendorName, { exact: true }).inputValue()).toBe('');
    // Keep an unrelated draft while the bill succeeds or is uncertain.
    await page.getByLabel(p.vendorName, { exact: true }).fill('Keep this supplier draft');
    const fillBill = async (reference: string) => { await open(p.newBill); await page.getByLabel(p.vendor, { exact: true }).selectOption(saved().vendors![0].id); await page.getByLabel(p.reference, { exact: true }).fill(reference); await page.getByLabel(p.sourceReference, { exact: true }).fill('Fixture source document'); await page.getByLabel(p.date, { exact: true }).fill('2026-10-08'); await page.getByLabel(p.dueDate, { exact: true }).fill('2026-11-08'); await page.getByLabel(p.accountingDate, { exact: true }).first().fill('2026-10-09'); await page.getByLabel(p.period, { exact: true }).first().selectOption(saved().ledger.periods[0].id); await page.getByLabel(p.net, { exact: true }).fill('100.00'); await page.getByLabel(p.tax, { exact: true }).fill('8.25'); };
    await fillBill('BILL-42'); await page.getByRole('button', { name: p.reviewBill, exact: true }).click(); await page.getByRole('region', { name: p.approvalTitle, exact: true }).waitFor(); expect(commits).toBe(2); expect(writes).toHaveLength(2);
    await page.getByLabel(p.net, { exact: true }).fill('101.00'); expect(await page.locator('.us-purchase-confirm').count()).toBe(0); expect(commits).toBe(2);
    await page.getByRole('button', { name: p.reviewBill, exact: true }).click(); await page.getByRole('region', { name: p.approvalTitle, exact: true }).getByText('$101.00', { exact: true }).waitFor();
    await page.getByLabel(p.net, { exact: true }).fill('100.00'); expect(await page.locator('.us-purchase-confirm').count()).toBe(0); await page.getByRole('button', { name: p.reviewBill, exact: true }).click();
    dropNext = true; await page.getByRole('button', { name: p.approveBill, exact: true }).click(); await page.getByRole('button', { name: c.retry, exact: true }).waitFor(); expect(commits).toBe(3); expect(saved().vendorBills).toHaveLength(1);
    expect(await page.getByRole('button', { name: p.saveVendor, exact: true }).isDisabled()).toBe(true); expect(await page.getByLabel(p.reference, { exact: true }).inputValue()).toBe('BILL-42');
    const interrupted = writes.at(-1); await page.getByRole('button', { name: c.retry, exact: true }).click(); await page.getByRole('region', { name: p.bills, exact: true }).getByText('BILL-42', { exact: true }).waitFor(); await idle();
    expect(writes.at(-1)).toBe(interrupted); expect(commits).toBe(3); expect(await page.getByLabel(p.reference, { exact: true }).inputValue()).toBe(''); expect(await page.getByLabel(p.vendorName, { exact: true }).inputValue()).toBe('Keep this supplier draft');
    const fillPayment = async (amount: string, reference: string) => { await open(p.newPayment); await page.getByLabel(p.bill, { exact: true }).selectOption(saved().vendorBills![0].id); await page.getByLabel(p.amount, { exact: true }).fill(amount); await page.getByLabel(p.paymentDate, { exact: true }).fill('2026-10-10'); await page.getByLabel(p.accountingDate, { exact: true }).last().fill('2026-10-11'); await page.getByLabel(p.period, { exact: true }).last().selectOption(saved().ledger.periods[0].id); await page.getByLabel(p.paymentReference, { exact: true }).fill(reference); };
    await fillPayment('50.00', 'PAY-1'); await page.getByRole('button', { name: p.recordPayment, exact: true }).click(); await page.getByRole('region', { name: p.payments, exact: true }).getByText('PAY-1', { exact: true }).waitFor(); await idle();
    await fillPayment('58.26', 'TOO-MUCH'); const beforeOverpayment = writes.length; await page.getByRole('button', { name: p.recordPayment, exact: true }).click(); await page.getByRole('alert').waitFor(); expect(writes).toHaveLength(beforeOverpayment);
    await fillPayment('58.25', 'PAY-2'); dropNext = true; await page.getByRole('button', { name: p.recordPayment, exact: true }).click(); await page.getByRole('button', { name: c.retry, exact: true }).waitFor(); const interruptedPayment = writes.at(-1); expect(saved().vendorPayments).toHaveLength(2);
    await page.getByRole('button', { name: c.retry, exact: true }).click(); await page.getByRole('region', { name: p.payments, exact: true }).getByText('PAY-2', { exact: true }).waitFor(); await idle(); expect(writes.at(-1)).toBe(interruptedPayment); expect(saved().vendorPayments).toHaveLength(2); expect(commits).toBe(5);
    expect(saved().ledger.entries).toHaveLength(3); expect(saved().vendorBills![0].total.minorUnits).toBe('10825'); expect(saved().vendorPayments!.map(item => item.amount.minorUnits)).toEqual(['5000', '5825']); expect(await page.getByLabel(p.amount, { exact: true }).inputValue()).toBe('');
    // A peer write makes the approved review stale. No automatic resubmission.
    await fillBill('BILL-43'); await page.getByRole('button', { name: p.reviewBill, exact: true }).click();
    const endpoint = `${origin}/api/international/workspaces/${organizationId}/erp`;
    const peer = await page.request.post(endpoint, { headers: { Origin: origin, [ERP_SCHEMA_HEADER]: '2', 'X-Zentra-Expected-User': userId }, data: { idempotencyKey: 'fixture-peer-vendor', expectedRevision: saved().revision, command: { type: 'save_vendor', vendor: { ...saved().vendors![0], name: 'S'.repeat(160) } } } }); expect(peer.status()).toBe(200);
    await page.getByRole('button', { name: p.approveBill, exact: true }).click(); await page.getByRole('alert').waitFor(); await idle(); expect(saved().vendorBills).toHaveLength(1); expect(await page.locator('.us-purchase-confirm').count()).toBe(0); expect(await page.getByLabel(p.reference, { exact: true }).inputValue()).toBe('BILL-43');
    const beforeReload = writes.length; await page.getByRole('button', { name: c.reload, exact: true }).click(); await idle(); expect(writes).toHaveLength(beforeReload); expect(await page.getByLabel(p.reference, { exact: true }).inputValue()).toBe('BILL-43');
    expect(taxCalls).toBe(0); expect(sellerCalls).toBe(0); expect(saved().configuration.taxConfiguration.status).toBe('unconfigured');
    // Read-only financial roles get the records, not purchase forms. The same
    // synthetic real handler still refuses a forged member write.
    for (const financialRole of ['admin', 'accountant', 'member', 'read_only'] as const) {
      role = financialRole; await page.goto(`${origin}/?role=${financialRole}`); await page.getByRole('region', { name: p.bills, exact: true }).waitFor(); await idle();
      expect(await page.getByText(p.newVendor, { exact: true }).count()).toBe(financialRole === 'admin' || financialRole === 'accountant' ? 1 : 0);
      if (financialRole === 'member') { const denied = await page.request.post(endpoint, { headers: { Origin: origin, [ERP_SCHEMA_HEADER]: '2', 'X-Zentra-Expected-User': userId }, data: { idempotencyKey: 'fixture-member-forgery', expectedRevision: saved().revision, command: { type: 'save_vendor', vendor: saved().vendors![0] } } }); expect(denied.status()).toBe(403); }
    }
    role = 'owner';
    for (const language of ['fr', 'de', 'it', 'en'] as const) for (const theme of ['light', 'dark']) for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 920 }); await page.goto(`${origin}/?lang=${language}&theme=${theme}`); const copy = browserPurchasingCopy[language]; await page.getByRole('region', { name: copy.bills, exact: true }).waitFor(); await idle();
      await checkClosedSummaryFocus(language, theme, width, '100%');
      for (const summary of [copy.newVendor, copy.newBill, copy.newPayment]) await open(summary);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); expect(overflow).toBe(false);
      const sizes = await page.locator('.us-erp-purchasing button, .us-erp-purchasing input, .us-erp-purchasing select').evaluateAll((nodes: Element[]) => nodes.map(node => node.getBoundingClientRect().height)); expect(sizes.every((height: number) => height >= 44)).toBe(true);
      views.push({ language, theme, width, text: '100%', overflow, controls: sizes.length });
      if (language === 'en' && width === 390) await page.locator('.us-erp-purchasing').screenshot({ path: resolve(directory, `purchases-en-390-${theme}.png`) });
      if (width === 320) {
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false); views.push({ language, theme, width, text: '200%', overflow: false });
        for (const label of [copy.newVendor, copy.newBill, copy.newPayment]) await page.locator('.us-erp-purchasing summary').filter({ hasText: label }).click();
        await checkClosedSummaryFocus(language, theme, width, '200%');
      }
    }
    await page.setViewportSize({ width: 320, height: 920 }); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; document.querySelector('.us-erp-purchasing')?.scrollIntoView({ block: 'start' }); });
    await page.screenshot({ path: resolve(directory, 'purchases-320-dark-200.png'), fullPage: false });
    // A stale owner render does not authorize a financial write after the real
    // synthetic server role becomes member. The private exact ERP envelope is
    // retained for explicit retry, but displayed drafts are purged immediately.
    await page.goto(origin); await page.getByRole('region', { name: p.bills, exact: true }).waitFor(); await idle(); await fillBill('BILL-DRAFT'); await open(p.newPayment); await page.getByLabel(p.paymentReference, { exact: true }).fill('Payment draft to purge'); await open(p.newVendor);
    await page.getByLabel(p.vendorName, { exact: true }).fill('Supplier draft to purge'); await page.getByLabel(p.address, { exact: true }).fill('1 Example Street'); await page.getByLabel(p.city, { exact: true }).fill('Brooklyn'); await page.getByLabel(p.subdivision, { exact: true }).selectOption('NY'); await page.getByLabel(p.postalCode, { exact: true }).fill('11201'); await page.getByLabel(p.terms, { exact: true }).fill('30');
    role = 'member'; await page.getByRole('button', { name: p.saveVendor, exact: true }).click(); await page.locator('.us-erp-workbench > .us-erp-notice[role="alert"]').waitFor(); await idle();
    expect(await page.locator('.us-erp-purchasing').count()).toBe(0); const deniedBody = writes.at(-1); const beforeRecovery = commits;
    role = 'owner'; await page.getByRole('button', { name: c.retry, exact: true }).click(); await page.getByRole('region', { name: p.vendors, exact: true }).getByText('Supplier draft to purge', { exact: true }).waitFor(); await idle();
    expect(writes.at(-1)).toBe(deniedBody); expect(commits).toBe(beforeRecovery + 1); expect(await page.getByLabel(p.reference, { exact: true }).inputValue()).toBe(''); expect(await page.getByLabel(p.paymentReference, { exact: true }).inputValue()).toBe(''); await open(p.newVendor); expect(await page.getByRole('button', { name: p.saveVendor, exact: true }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: c.reload, exact: true }).click(); await idle(); expect(await page.getByRole('button', { name: p.saveVendor, exact: true }).isDisabled()).toBe(true);
    await page.goto(origin); await page.getByRole('region', { name: p.bills, exact: true }).waitFor(); await idle(); await open(p.newVendor); await page.getByLabel(p.vendorName, { exact: true }).fill('Private unsaved supplier draft'); revoked = true; await page.getByRole('button', { name: c.reload, exact: true }).click(); await page.locator('.us-erp-workbench > .us-erp-notice[role="alert"]').waitFor();
    expect(await page.locator('.us-erp-purchasing').count()).toBe(0); expect(await page.getByText('BILL-42', { exact: true }).count()).toBe(0); expect(await page.getByText('Private unsaved supplier draft', { exact: true }).count()).toBe(0);
    // Late authorized GET cannot republish financial records after an Auth event.
    revoked = false; await page.goto(origin); await page.getByRole('region', { name: p.bills, exact: true }).waitFor(); await idle(); holdNextRead = true; const held = new Promise<void>(done => { heldReached = done; }); await page.getByRole('button', { name: c.reload, exact: true }).click(); await held; await page.evaluate((eventName: string) => window.dispatchEvent(new Event(eventName)), AUTH_CHANGED_EVENT); releaseHeldRead(); await idle(); expect(await page.locator('.us-erp-purchasing').count()).toBe(0);
    expect(requests.filter(item => item.method === 'POST').every(item => item.capability === '2' && item.expectedUser === userId)).toBe(true); expect(errors).toEqual([]);
    await writeFile(resolve(directory, 'browser.json'), JSON.stringify({ success: true, scope: 'Actual React + real HTTP/service/ERP/delta validation; synthetic Auth and CAS RAM storage. Unconfigured seller and private tax read fixtures. No SQL, tax provider, bank transfer, native app or production evidence.', commits, views, summaryFocus, errors, operations: ['capability1 unchanged, initialize1 then first supplier promotes2', 'supplier and manually reviewed/approved bill', 'editing a reviewed amount cancels old approval and requires new review', 'two exact partial payments', 'local overpayment refusal without POST', 'postcommit HTTP503 simulation and exact same-body retry without duplicate', 'draft reset only after confirmed receipt', 'peer revision conflict requires reload and explicit review', 'admin/accountant UI and member/read_only no purchase actions', 'member forged write refused by actual handler', 'stale owner financial403 purges all drafts, exact retry after real owner recovery keeps new writes locked', 'Auth denial clears records and drafts', 'late GET withheld after Auth event', 'exact select accessible name, keyboard arrows and visible focus', 'real Tab navigation to all three closed purchase disclosures with outline contained inside clipping bounds', '4 languages × 2 themes × 3 widths + 8 views at 200% text'], taxProviderCalls: taxCalls, sellerHookCalls: sellerCalls }, null, 2));
  } catch (error) {
    await writeFile(resolve(directory, 'browser-failure.json'), JSON.stringify({ reason: String(error), commits, errors, writeCount: writes.length, revision: (state as ErpState | null)?.revision }, null, 2)); throw error;
  } finally { releaseHeldRead(); await browser.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 180000);
