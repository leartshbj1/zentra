import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { build } from 'vite';
import { invoicePreparationFixture } from './us-tax-invoice-preparation.test-fixtures';
import { createUsTaxInvoicePreparationHandlers } from './us-tax-invoice-preparation-server';
import { createErpHandlers } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { applyErpDelta, type ErpEvent } from './runtime-sync';
import { ErpError } from './erp-contract';
import { browserUsTaxInvoiceCopy } from './browser-us-tax-invoice-copy';
import { browserSalesCopy } from './browser-sales-copy';
import { AUTH_CHANGED_EVENT } from '../auth-browser-events';
import type { AccountRole } from '../account-security';
import type { ErpReceipt, ErpRequest } from './runtime-types';
import type { UsTaxInvoicePreparation } from './us-tax-invoice-preparation-store';

// Real React, HTTP, preparation handler/serializer, ERP commands and deltas.
// Auth, private context, catalogue, tax calculation and persistence are explicitly
// fictitious RAM ports. These captures are desktop browser emulation only.
it.skipIf(process.env.ZENTRA_BROWSER_US_TAX_INVOICE_QA !== '1')('issues reviewed TEST invoices, recovers exact requests and purges access loss through the workbench', async () => {
  const directory = resolve('.qa/us-tax-invoice/browser'), client = resolve(directory, 'client'); await mkdir(directory, { recursive: true });
  const f = invoicePreparationFixture(), organizationId = f.organizationId, userId = f.actor.userId;
  let role: AccountRole = 'owner', preparationEnabled = true, holdPreparation = false, dropIssue = false, commits = 0, calculations = 0;
  f.setRole(role); f.editState(state => ({ ...state, counters: { ...state.counters, estimate: 3 }, estimates: ['estimate', 'estimate-retry', 'estimate-revoke'].map((id, index) => ({ ...state.estimates[0], id, number: `EST-00000${index + 1}` })) }));
  let reached: (() => void) | undefined, release: (() => void) | undefined;
  const receipts = new Map<string, ErpReceipt>(), preparations = new Map<string, UsTaxInvoicePreparation>(), events: ErpEvent[] = [], requests: { path: string; method: string; body: string; status?: number }[] = [], views: unknown[] = [], errors: string[] = [];
  f.rpc.mockImplementation(async (name, input) => {
    if (name === 'zentra_read_us_tax_invoice_preparation') return structuredClone(preparations.get(input.p_erp_idempotency_key as string) ?? null);
    if (name !== 'zentra_create_us_tax_invoice_preparation') throw new Error('Unexpected fixture RPC');
    const parsed = JSON.parse(input.p_preparation_body as string) as UsTaxInvoicePreparation, saved = { ...parsed, preparationSha256: input.p_preparation_sha256 as string, preparedAt: f.dependencies.now() };
    preparations.set(parsed.request.idempotencyKey, saved); return structuredClone(saved);
  });
  f.erpStore.receipt = async (_org, key) => structuredClone(receipts.get(key) ?? null);
  f.erpStore.commit = async input => {
    const existing = receipts.get(input.receipt.idempotencyKey); if (existing) { if (existing.commandHash !== input.receipt.commandHash) throw new ErpError('idempotency_conflict', 409); return existing; }
    const before = f.state(); if (before.revision !== input.expectedRevision) throw new ErpError('revision_conflict', 409);
    const event: ErpEvent = { schemaVersion: input.header.schemaVersion, organizationId, revision: input.header.revision, header: input.header, changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: userId, occurredAt: input.actor.timestamp };
    const next = applyErpDelta(before, { schemaVersion: input.header.schemaVersion, organizationId, fromRevision: input.expectedRevision, toRevision: input.header.revision, headRevision: input.header.revision, hasMore: false, resetRequired: false, events: [event] }, organizationId, 4); if (!next) throw new Error('Missing fixture delta');
    f.editState(() => next); events.push(event); receipts.set(input.receipt.idempotencyKey, input.receipt); commits++; return input.receipt;
  };
  const shared = { ...f.dependencies, enabled: () => true };
  const erp = createErpHandlers({ ...shared, store: () => f.erpStore, seller: async () => ({ organizationId, displayName: 'Fictitious public seller' }), taxProvider: async () => ({ id: 'FICTITIOUS-TEST-ONLY', calculate: async request => { calculations++; return { ...request, source: 'external-provider', providerReference: 'FICTITIOUS-TEST-ONLY', determinedAt: '2026-10-10T11:00:00.000Z', validUntil: '2026-10-10T13:00:00.000Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: '165', jurisdiction: 'Fictitious example', evidenceReference: 'Not a real tax determination' })) }; } }) });
  const preparation = createUsTaxInvoicePreparationHandlers({ ...f.dependencies, enabled: () => preparationEnabled });
  const sync = createErpSyncHandlers({ ...shared, syncStore: () => ({ supportedSchemaVersion: 4, revision: async () => ({ schemaVersion: 4, organizationId, revision: f.state().revision }), changes: async (_org, after, limit) => { const selected = events.filter(event => event.revision > after).slice(0, limit); return { schemaVersion: 4, organizationId, fromRevision: after, toRevision: selected.at(-1)?.revision ?? after, headRevision: f.state().revision, hasMore: selected.at(-1)?.revision !== f.state().revision, resetRequired: false, events: selected }; } }) });
  await writeFile(resolve(directory, 'entry.tsx'), `import{createRoot}from'react-dom/client';import{UsErpWorkbench}from'@/components/account/us-erp-workbench';import'@/app/compte/account.css';import'@/app/apple-account.css';const q=new URLSearchParams(location.search);createRoot(document.getElementById('root')).render(<div className="account-experience account-detail" data-theme={q.get('theme')||'light'}><main className="account-content"><UsErpWorkbench organizationId="${organizationId}" expectedUserId="${userId}" role={q.get('role')||'owner'} language={q.get('lang')||'en'} supportedSchemaVersion={4} salesEnabled taxInvoiceTestEnabled syncEnabled/></main></div>);`);
  await writeFile(resolve(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--font-geist-sans:Arial,sans-serif}body{margin:0}*{box-sizing:border-box}button,input,select{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await build({ configFile: false, root: directory, resolve: { alias: { '@': resolve('.') } }, build: { outDir: client, emptyOutDir: true }, logLevel: 'warn' });
  const server = createServer(async (incoming, outgoing) => { try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, url = new URL(incoming.url ?? '/', origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString('utf8'), record = { path: url.pathname + url.search, method: incoming.method ?? 'GET', body, status: 0 }; requests.push(record);
      const request = new Request(url, { method: incoming.method, headers: incoming.headers as Record<string, string>, ...(body ? { body } : {}) }); let response: Response;
      if (url.pathname.endsWith('/tax-invoice-preparation')) { if (holdPreparation) { holdPreparation = false; reached?.(); await new Promise<void>(done => { release = done; }); } response = await preparation.POST(request, organizationId); }
      else if (url.pathname.endsWith('/tax-catalogue')) response = await preparation.CATALOGUE_GET(request, organizationId);
      else if (url.pathname.endsWith('/erp/revision')) response = await sync.revision(request, organizationId);
      else if (url.pathname.endsWith('/erp/changes')) response = await sync.changes(request, organizationId);
      else if (url.pathname.endsWith('/erp')) {
        const envelope = body ? JSON.parse(body) as ErpRequest : null;
        response = incoming.method === 'POST' && envelope && !preparations.has(envelope.idempotencyKey) && !receipts.has(envelope.idempotencyKey) ? Response.json({ error: 'tax_preparation_required' }, { status: 409 }) : incoming.method === 'POST' ? await erp.POST(request, organizationId) : await erp.GET(request, organizationId);
        if (incoming.method === 'POST' && response.ok && dropIssue) { dropIssue = false; response = Response.json({ error: 'service_unavailable' }, { status: 503 }); }
      }
      else if (url.pathname.endsWith('/sync-heads')) response = Response.json({ schemaVersion: 1, organizationId, role, erp: { schemaVersion: 4, organizationId, revision: f.state().revision }, channels: { sellerProfile: role === 'owner' ? 'a'.repeat(64) : null, taxProfile: role === 'owner' ? 'b'.repeat(64) : null, supplierProposals: null, supplierAnalysis: null, bankReconciliations: null, team: null } });
      else if (url.pathname.endsWith('/seller')) response = Response.json({ status: 'unconfigured', organizationId, revision: 0 });
      else if (url.pathname.endsWith('/tax-profile')) response = Response.json({ status: 'unconfigured', organizationId, revision: 0, verification: 'unverified' });
      else response = Response.json({ error: 'feature_unavailable' }, { status: 404 });
      record.status = response.status; outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const path = resolve(client, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)); if (!path.startsWith(client + '/') && !path.startsWith(client + '\\')) throw new Error('Unsafe fixture path');
    outgoing.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html'); outgoing.end(await readFile(path));
  } catch { outgoing.writeHead(500); outgoing.end('Fictitious local fixture unavailable'); } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const require = createRequire(import.meta.url), { chromium } = require('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'), browser = await chromium.launch({ channel: 'msedge', headless: true });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, context = await browser.newContext({ locale: 'en-US', timezoneId: 'Europe/Zurich', reducedMotion: 'reduce' }), page = await context.newPage(); page.setDefaultTimeout(12_000); page.on('pageerror', (error: Error) => errors.push(error.message));
  try {
    const idle = async () => page.waitForFunction(() => { const toolbar = document.querySelector<HTMLButtonElement>('.us-erp-toolbar button'); return !!toolbar && !toolbar.disabled; });
    const panel = page.locator('.us-tax-invoice'), c = browserUsTaxInvoiceCopy.en;
    const fill = async (estimateId: string, language: keyof typeof browserUsTaxInvoiceCopy = 'en') => { const copy = browserUsTaxInvoiceCopy[language]; if (!await panel.locator('details').evaluate((node: HTMLDetailsElement) => node.open)) await panel.locator('details>summary').click(); await panel.getByLabel(copy.estimate, { exact: true }).selectOption(estimateId); await panel.getByLabel(copy.date, { exact: true }).fill('2026-10-10'); await panel.getByLabel(copy.time, { exact: true }).fill('12:00:00'); await panel.getByLabel(copy.accountingDate, { exact: true }).fill('2026-10-10'); await panel.getByLabel(copy.dueDate, { exact: true }).fill('2026-11-10'); await panel.getByLabel(copy.period, { exact: true }).selectOption('2026'); await panel.getByLabel(copy.confirmZone, { exact: true }).check(); await panel.getByLabel(copy.service, { exact: true }).fill('txcd_99999999'); await panel.getByRole('button', { name: copy.lookup, exact: true }).click(); await panel.getByLabel(copy.confirmService, { exact: true }).check(); await panel.getByRole('radio', { name: new RegExp(`^${copy.billing}`) }).check(); await panel.getByRole('button', { name: copy.review, exact: true }).click(); await panel.getByRole('button', { name: copy.confirm, exact: true }).waitFor(); await page.waitForFunction(() => document.activeElement?.matches('.us-tax-invoice-review')); expect(await panel.locator('details').evaluate((node: HTMLDetailsElement) => node.open)).toBe(false); };
    await page.setViewportSize({ width: 1280, height: 1000 }); await page.goto(origin); await panel.waitFor(); await idle(); expect(await panel.locator('input:checked').count()).toBe(0); expect(calculations).toBe(0); expect(await page.locator('.us-sales-editors summary').getByText(browserSalesCopy.en.newInvoice, { exact: true }).count()).toBe(0);
    await panel.getByLabel(c.date, { exact: true }).fill('2026-03-08'); await panel.getByLabel(c.time, { exact: true }).fill('02:30:00'); await panel.getByText(c.gap, { exact: true }).waitFor();
    await panel.getByLabel(c.date, { exact: true }).fill('2026-11-01'); await panel.getByLabel(c.time, { exact: true }).fill('01:30:00'); expect(await panel.getByLabel(c.offset, { exact: true }).inputValue()).toBe(''); expect(await panel.getByLabel(c.offset, { exact: true }).locator('option').count()).toBe(3);
    await fill('estimate'); expect(commits).toBe(0); expect(await panel.locator('.us-tax-invoice-review').innerText()).toContain('2026-10-10T16:00:00.000Z');
    await panel.getByRole('button', { name: c.cancel, exact: true }).click(); await page.waitForFunction(() => document.activeElement === document.querySelector('.us-tax-invoice details select')); expect(await panel.locator('details').evaluate((node: HTMLDetailsElement) => node.open)).toBe(true); expect(await panel.getByLabel(c.estimate, { exact: true }).inputValue()).toBe('estimate'); expect(await panel.getByLabel(c.service, { exact: true }).inputValue()).toBe('txcd_99999999'); expect(await panel.getByLabel(c.confirmService, { exact: true }).isChecked()).toBe(true); await panel.getByRole('button', { name: c.review, exact: true }).click(); await page.waitForFunction(() => document.activeElement?.matches('.us-tax-invoice-review')); expect(await panel.locator('details').evaluate((node: HTMLDetailsElement) => node.open)).toBe(false); await panel.screenshot({ path: resolve(directory, 'en-light-desktop-review.png') });
    holdPreparation = true; const waiting = new Promise<void>(done => { reached = done; }); await panel.getByRole('button', { name: c.confirm, exact: true }).click(); await waiting;
    expect(await page.locator('.us-erp-toolbar button').first().isDisabled()).toBe(true); expect(await page.locator('.us-erp-workbench>div>details.us-erp-editor fieldset input').first().isDisabled()).toBe(true); expect(commits).toBe(0); release?.();
    await page.locator('.us-erp-sales').getByText('INV-000001', { exact: true }).waitFor(); await idle(); expect(commits).toBe(1); expect(calculations).toBe(1); expect(await panel.getByLabel(c.estimate, { exact: true }).inputValue()).toBe('');
    await fill('estimate-retry'); dropIssue = true; await panel.getByRole('button', { name: c.confirm, exact: true }).click(); await panel.getByRole('button', { name: c.retry, exact: true }).waitFor(); expect(commits).toBe(2);
    const beforeRetry = requests.filter(request => request.method === 'POST'), originalIssue = beforeRetry.at(-1)!.body, prepareCount = beforeRetry.filter(request => request.path.endsWith('/tax-invoice-preparation')).length, readCount = requests.filter(request => request.method === 'GET' && /\/erp(?:\/|$)/.test(request.path)).length;
    await page.waitForTimeout(3300); expect(requests.filter(request => request.method === 'GET' && /\/erp(?:\/|$)/.test(request.path)).length).toBe(readCount); expect(await page.locator('.us-erp-toolbar button').first().isDisabled()).toBe(true);
    preparationEnabled = false; await panel.getByRole('button', { name: c.retry, exact: true }).click(); await page.locator('.us-erp-sales').getByText('INV-000002', { exact: true }).waitFor(); await idle(); expect(commits).toBe(2); expect(calculations).toBe(2); expect(requests.filter(request => request.path.endsWith('/tax-invoice-preparation') && request.method === 'POST')).toHaveLength(prepareCount); expect(requests.filter(request => request.path.endsWith('/erp') && request.method === 'POST').at(-1)!.body).toBe(originalIssue); preparationEnabled = true;
    for (const language of ['en', 'fr', 'de', 'it'] as const) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 375, height: 920 }); await page.goto(`${origin}/?lang=${language}&theme=${theme}`); await panel.waitFor(); await idle(); await fill('estimate-revoke', language);
      const dimensions = await page.evaluate(() => ({ width: innerWidth, contentWidth: document.documentElement.scrollWidth })); expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.width + 1); const screenshot = `${language}-${theme}-mobile-review.png`; await panel.screenshot({ path: resolve(directory, screenshot) }); views.push({ language, theme, ...dimensions, screenshot });
    }
    for (const nextRole of ['admin', 'accountant', 'member', 'read_only'] as const) { role = nextRole; f.setRole(role); await page.goto(`${origin}/?role=${role}`); await page.locator('.us-erp-sales').waitFor(); await idle(); expect(await panel.count()).toBe(role === 'admin' || role === 'accountant' ? 1 : 0); }
    role = 'owner'; f.setRole(role); await page.setViewportSize({ width: 1280, height: 1000 }); await page.goto(origin); await panel.waitFor(); await idle(); await fill('estimate-revoke'); await panel.screenshot({ path: resolve(directory, 'en-light-desktop-final-review.png') }); dropIssue = true; await panel.getByRole('button', { name: c.confirm, exact: true }).click(); await panel.getByRole('button', { name: c.retry, exact: true }).waitFor(); expect(commits).toBe(3);
    const postsAtRevocation = requests.filter(request => request.method === 'POST').length; f.revoke(); await page.evaluate((event: string) => window.dispatchEvent(new Event(event)), AUTH_CHANGED_EVENT); await page.locator('.us-erp-workbench>div>.us-erp-notice[role=alert]').waitFor(); expect(await panel.count()).toBe(0); expect(await page.getByRole('button', { name: c.retry, exact: true }).count()).toBe(0); await page.waitForTimeout(100); expect(requests.filter(request => request.method === 'POST')).toHaveLength(postsAtRevocation);
    expect(errors).toEqual([]); const privateTokens = ['PRIVATE Fictitious Entity', 'acct_FictitiousPreparation', 'fictitious-merchant', 'sk_test_']; expect(privateTokens.some(token => requests.filter(request => request.method === 'POST').some(request => request.body.includes(token)))).toBe(false);
    await writeFile(resolve(directory, 'evidence.json'), JSON.stringify({ scope: 'Local Edge desktop browser emulation; real React/HTTP/preparation handler+serializer/ERP engine+delta; synthetic Auth/private context/catalogue/tax/RAM store. No real provider, PostgreSQL, hosted or physical-device claim.', commits, calculations, exactRetry: true, erpFirstReplayWhilePreparationClosed: true, pendingPausesErpSync: true, automaticInvoiceRefresh: true, pendingAccessPurge: true, dstGapAndFoldExplicit: true, reviewClosesEditorAndReceivesFocus: true, backReopensEditorPreservesChoicesAndFocusesFirstField: true, deviceZone: 'Europe/Zurich', companyZone: 'America/New_York', views, errors, requests: requests.map(({ path, method, status }) => ({ path, method, status })) }, null, 2));
  } catch (error) { await page.screenshot({ path: resolve(directory, `failure-${Date.now()}.png`), fullPage: true }); await writeFile(resolve(directory, `failure-${Date.now()}.json`), JSON.stringify({ errors, requests, text: await page.locator('body').innerText(), inputs: await page.locator('.us-tax-invoice input').evaluateAll((nodes: HTMLInputElement[]) => nodes.map(node => ({ type: node.type, value: node.value }))) }, null, 2)); throw error; }
  finally { release?.(); await browser.close(); await new Promise<void>(done => server.close(() => done())); }
}, 180_000);
