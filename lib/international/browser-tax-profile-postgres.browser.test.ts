import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { build } from 'vite';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { AccountRole } from '../account-security';
import type { CompanyConfiguration } from './types';
import type { FinancialAuthority } from './accounting/ledger';
import { browserTaxProfileCopy } from './browser-tax-profile-copy';
import { createUsTaxProfileHandlers } from './us-tax-profile-server';
import { resolveUsTaxConfiguration, type UsTaxFacts, type UsTaxProfileReceipt, type UsTaxProfileState } from './us-tax-profile';
import { createUsSellerProfileHandlers } from './seller-profile-server';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { createSupabaseErpStore } from './runtime-store';
import { createSupabaseErpSyncStore } from './runtime-sync-store';

// Explicit opt-in: real React/HTTP/service/SQL, but synthetic local Auth/D1.
// PGlite is one serialized in-memory PostgreSQL instance, not hosted PostgreSQL,
// PostgREST, restart/crash durability, independent connections or provider proof.
const enabled = process.env.ZENTRA_BROWSER_TAX_PROFILE_POSTGRES_QA === '1';
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
type RpcQuery = { sql: string; keys: string[] };
const migrations = [
  '202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content',
  '20261007194528_international_workspace_country_config', '20261007222349_international_us_erp_persistence',
  '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot',
  '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist',
  '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile',
];
const queries: Record<string, RpcQuery> = {
  zentra_read_us_tax_profile: { sql: 'select public.zentra_read_us_tax_profile($1) as result', keys: ['p_organization'] },
  zentra_put_us_tax_profile: { sql: 'select public.zentra_put_us_tax_profile($1,$2,$3,$4::uuid,$5::jsonb) as result', keys: ['p_organization', 'p_actor', 'p_expected_revision', 'p_request_id', 'p_facts'] },
  zentra_read_us_seller_profile: { sql: 'select public.zentra_read_us_seller_profile($1) as result', keys: ['p_organization'] },
  zentra_put_us_seller_profile: { sql: 'select public.zentra_put_us_seller_profile($1,$2,$3,$4::uuid,$5::jsonb) as result', keys: ['p_organization', 'p_actor', 'p_expected_revision', 'p_request_id', 'p_profile'] },
  zentra_read_us_erp: { sql: 'select public.zentra_read_us_erp($1) as result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { sql: 'select public.zentra_us_erp_receipt($1,$2) as result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_commit_us_erp: { sql: 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) as result', keys: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
  zentra_us_erp_revision: { sql: 'select public.zentra_us_erp_revision($1) as result', keys: ['p_organization'] },
  zentra_us_erp_delta: { sql: 'select public.zentra_us_erp_delta($1,$2,$3) as result', keys: ['p_organization', 'p_after_revision', 'p_limit'] },
};

it.skipIf(!enabled)('persists private owner facts from the actual browser through HTTP/service/PostgreSQL and recovers one committed request', async () => {
  const directory = resolve('.qa/us-tax-postgres-browser'), clientDir = resolve(directory, 'client');
  const started = performance.now(); let step = 'setup', success = false;
  const checks: string[] = [], diagnostics: unknown[] = [], pageErrors: string[] = [];
  const requests: { channel: string; method: string; body: string; expectedUser: string | undefined; status: number; deliveredStatus: number; responseLost: boolean }[] = [];
  const taxReads: UsTaxProfileState[] = [], taxReceipts: UsTaxProfileReceipt[] = [];
  const sourceFiles = [
    'components/account/us-erp-workbench.tsx', 'components/account/us-tax-profile-panel.tsx',
    'components/account/us-erp-workbench.css', 'components/account/us-seller-profile-panel.tsx',
    'app/compte/account.css', 'app/apple-account.css',
    'lib/international/browser-tax-profile-session.ts', 'lib/international/browser-tax-profile-copy.ts',
    'lib/international/us-tax-profile-server.ts', 'lib/international/us-tax-profile.ts',
    'lib/international/browser-erp-session.ts', 'lib/international/browser-seller-session.ts',
    'lib/international/runtime-server.ts', 'lib/international/runtime-store.ts',
    'lib/international/runtime-sync-server.ts', 'lib/international/runtime-sync-store.ts',
    'lib/international/seller-profile-server.ts', 'lib/international/seller-profile.ts',
    'lib/international/public-projection.ts',
    'lib/international/browser-tax-profile-postgres.browser.test.ts',
    ...migrations.map(name => `supabase/migrations/${name}.sql`),
  ];
  const hashes: Record<string, string> = {};
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  await mkdir(directory, { recursive: true });
  for (const file of sourceFiles) hashes[file] = hash(await readFile(resolve(file)));
  const organizationId = randomUUID(), userId = randomUUID();
  const facts: UsTaxFacts = { schemaVersion: 1, legalName: 'Fictitious Private Browser Company', taxOrigin: { country: 'US', line1: '987 Fictitious Private Origin Road', line2: 'Private fixture suite 17', city: 'Los Angeles', subdivision: 'CA', postalCode: '90001-1234' }, timeZone: 'America/Los_Angeles' };
  const recoveredFacts: UsTaxFacts = { ...facts, legalName: 'Fictitious Private Recovered Company' };
  const dirtyDraft = 'Fictitious Private Unsaved Draft';
  const privateMarkers = [facts.legalName, recoveredFacts.legalName, facts.taxOrigin.line1, facts.taxOrigin.line2!, dirtyDraft];
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Public Workspace Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
  let db: Database | undefined, activeServer: ReturnType<typeof createServer> | undefined, closeBrowser: (() => Promise<void>) | undefined;
  let serverRole: AccountRole = 'owner', loseNextTaxResponse = false, failureType: string | undefined;
  let auditRows = 0, headRevision = 0, replayed = false, publicReadCount = 0;
  try {
    const moduleDirectory = process.env.PGLITE_MODULE_DIR;
    if (!moduleDirectory || !isAbsolute(moduleDirectory)) throw new Error('This opt-in QA requires an absolute PGLITE_MODULE_DIR');
    expect(JSON.parse(await readFile(join(moduleDirectory, 'package.json'), 'utf8')).name).toBe('@electric-sql/pglite');
    const require = createRequire(import.meta.url);
    const { PGlite } = require(join(moduleDirectory, 'dist/index.cjs')) as { PGlite: new () => Database };
    const postgres = new PGlite(); db = postgres;
    await postgres.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    // The same reduced complete dependency order as us-tax-profile.postgres.test.ts.
    for (const name of migrations) {
      if (name === '20261008044402_international_us_tax_profile') await postgres.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant all on functions to anon,authenticated,service_role;');
      await postgres.exec(await readFile(resolve(`supabase/migrations/${name}.sql`), 'utf8'));
    }
    const sql = <T>(query: string, values: unknown[]) => postgres.transaction(async tx => { await tx.exec('set local role service_role'); return (await tx.query<T>(query, values)).rows; });
    await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [organizationId, randomUUID(), userId, randomUUID(), JSON.stringify(configuration), hash(organizationId)]);
    // Only transport adaptation: every CAS/replay/head/audit decision is made by
    // the existing SQL RPC. No hand-written tax persistence implementation.
    const client: Pick<SupabaseServerClient, 'rpc'> = { async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
      const query = queries[name]; if (!query) throw new Error('Unexpected local browser QA RPC');
      try { return (await sql<{ result: T }>(query.sql, query.keys.map(key => typeof parameters[key] === 'object' ? JSON.stringify(parameters[key]) : parameters[key])))[0].result; }
      catch (error) { throw new SupabaseServerError(400, (error as { code?: string }).code ?? 'fixture_sql'); }
    } };
    const actor = (): FinancialAuthority => ({ organizationId, userId, role: serverRole, managementEntitled: true, timestamp: new Date().toISOString() });
    const shared: Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'rateLimit' | 'diagnostic'> = {
      enabled: () => true,
      // Explicitly synthetic Auth/D1 authority. The browser prop is never read here.
      authority: async () => ({ mode: 'browser', actor: actor() }),
      configuration: async () => configuration,
      rateLimit: async () => {}, diagnostic: event => { diagnostics.push(event); },
    };
    const tax = createUsTaxProfileHandlers({ ...shared, store: () => client });
    const seller = createUsSellerProfileHandlers({ ...shared, store: () => client });
    const erp = createErpHandlers({ ...shared, store: () => createSupabaseErpStore(client), taxProvider: async () => null });
    const sync = createErpSyncHandlers({ ...shared, syncStore: () => createSupabaseErpSyncStore(client) });
    const snapshot = async () => {
      const heads = (await postgres.query<{ revision: number; facts: UsTaxFacts; updated_by: string }>('select revision,facts,updated_by from public.zentra_us_tax_profiles where organization_id=$1', [organizationId])).rows;
      const changes = (await postgres.query<{ revision: number; previous_revision: number; facts: UsTaxFacts; previous_facts: UsTaxFacts | null; request_id: string; changed_by: string }>('select revision,previous_revision,facts,previous_facts,request_id,changed_by from public.zentra_us_tax_profile_changes where organization_id=$1 order by revision', [organizationId])).rows;
      auditRows = changes.length; headRevision = heads[0]?.revision ?? 0;
      return { heads, changes };
    };
    await writeFile(resolve(directory, 'entry.tsx'), `import {createRoot} from 'react-dom/client';import {UsErpWorkbench} from '@/components/account/us-erp-workbench';import '@/app/compte/account.css';import '@/app/apple-account.css';createRoot(document.getElementById('root')).render(<div className="account-experience account-detail" data-theme="light"><main className="account-content"><UsErpWorkbench organizationId="${organizationId}" expectedUserId="${userId}" role="owner" language="en"/></main></div>);`);
    await writeFile(resolve(directory, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local PostgreSQL private tax browser QA</title><style>:root{--font-geist-sans:Arial,sans-serif}body{margin:0}*{box-sizing:border-box}button,input,select,textarea{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
    await build({ configFile: false, root: directory, resolve: { alias: { '@': resolve('.') } }, build: { outDir: clientDir, emptyOutDir: true }, logLevel: 'warn' });
    const server = createServer(async (req, res) => {
      try {
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, url = new URL(req.url || '/', origin);
        const matched = url.pathname.match(/^\/api\/international\/workspaces\/([^/]+)\/(erp|seller|tax-profile)(?:\/(changes|revision))?$/);
        if (matched) {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString('utf8'), method = req.method || 'GET', org = decodeURIComponent(matched[1]), channel = matched[2];
          const request = new Request(url, { method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) });
          let response: Response;
          if (channel === 'tax-profile' && !matched[3]) response = method === 'PUT' ? await tax.PUT(request, org) : await tax.GET(request, org);
          else if (channel === 'seller' && !matched[3]) response = method === 'PUT' ? await seller.PUT(request, org) : await seller.GET(request, org);
          else if (channel === 'erp') response = matched[3] === 'changes' ? await sync.changes(request, org) : matched[3] === 'revision' ? await sync.revision(request, org) : method === 'POST' ? await erp.POST(request, org) : await erp.GET(request, org);
          else { res.writeHead(404); res.end(); return; }
          const payload = await response.text();
          if (channel === 'tax-profile' && response.status === 200) {
            if (method === 'PUT') taxReceipts.push(JSON.parse(payload) as UsTaxProfileReceipt); else taxReads.push(JSON.parse(payload) as UsTaxProfileState);
          }
          const responseLost = channel === 'tax-profile' && method === 'PUT' && response.status === 200 && loseNextTaxResponse;
          requests.push({ channel, method, body, expectedUser: req.headers['x-zentra-expected-user'] as string | undefined, status: response.status, deliveredStatus: response.status, responseLost });
          // Replace the successful receipt only after the actual handler's SQL
          // transaction and fresh post-commit owner check. This deterministic
          // local JSON truncation avoids browser-level automatic PUT retries on
          // pre-header socket resets and exercises the user's explicit retry.
          if (responseLost) { loseNextTaxResponse = false; res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(payload.slice(0, -1)); return; }
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(payload); return;
        }
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.includes('..')) { res.writeHead(404); res.end(); return; }
        let asset: Buffer; try { asset = await readFile(resolve(clientDir, file)); } catch { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }); res.end(asset);
      } catch { if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end('{"error":"local_fixture_unavailable"}'); } }
    });
    activeServer = server;
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    const browser = await chromium.launch({ channel: 'msedge', headless: true }); closeBrowser = () => browser.close();
    const page = await browser.newPage({ viewport: { width: 390, height: 920 }, reducedMotion: 'reduce' });
    page.on('pageerror', (error: Error) => pageErrors.push(error.message));
    const c = browserTaxProfileCopy.en;
    step = 'owner_initial_read'; await page.goto(origin);
    const panel = page.locator('.us-tax-profile'); await panel.locator('details').waitFor();
    expect(taxReads.at(-1)).toEqual({ status: 'unconfigured', organizationId, revision: 0, verification: 'unverified' });
    expect((await snapshot()).heads).toEqual([]); expect(auditRows).toBe(0);
    await panel.locator('summary').click();
    await panel.getByLabel(c.legalName, { exact: true }).fill(facts.legalName);
    await panel.getByLabel(c.line1, { exact: true }).fill(facts.taxOrigin.line1);
    await panel.getByLabel(c.line2, { exact: true }).fill(facts.taxOrigin.line2);
    await panel.getByLabel(c.city, { exact: true }).fill(facts.taxOrigin.city);
    await panel.getByLabel(c.state, { exact: true }).selectOption(facts.taxOrigin.subdivision);
    await panel.getByLabel(c.postalCode, { exact: true }).fill(facts.taxOrigin.postalCode);
    await panel.getByLabel(c.timeZone, { exact: true }).selectOption(facts.timeZone);
    step = 'browser_save_real_sql'; await panel.getByRole('button', { name: c.save, exact: true }).click();
    await panel.getByText(c.saved, { exact: true }).waitFor();
    const first = await snapshot(); expect(first.heads).toEqual([{ revision: 1, facts, updated_by: userId }]);
    expect(first.changes).toHaveLength(1); expect(first.changes[0]).toMatchObject({ revision: 1, previous_revision: 0, previous_facts: null, facts, changed_by: userId });
    expect(taxReceipts.at(-1)).toMatchObject({ revision: 1, facts, verification: 'unverified', replayed: false, requestId: first.changes[0].request_id });
    checks.push('Actual UI save reached owner HTTP/service and real PostgreSQL head/audit revision 1');
    step = 'reload_real_revision'; const readsBefore = taxReads.length;
    await panel.getByRole('button', { name: c.reload, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('.us-tax-profile fieldset')?.disabled);
    expect(taxReads).toHaveLength(readsBefore + 1); expect(taxReads.at(-1)).toMatchObject({ revision: 1, facts, verification: 'unverified' });
    expect(await panel.getByLabel(c.legalName, { exact: true }).inputValue()).toBe(facts.legalName);
    checks.push('Explicit reload read SQL revision 1 and displayed its private facts; numeric revision is not shown in current panel');
    // Initialize only accounting, with a chosen period. This is not invoice issuance.
    step = 'real_public_erp_initialize';
    await page.getByLabel('Period start', { exact: true }).fill('2026-01-01'); await page.getByLabel('Period end', { exact: true }).fill('2026-12-31');
    await page.getByRole('button', { name: 'Initialize workspace', exact: true }).click();
    await page.locator('.us-erp-toolbar').getByText('Data revision 1', { exact: true }).waitFor();
    const publicReads = async () => {
      const values: unknown[] = [];
      for (const path of ['erp', 'erp/changes?after=0&limit=100', 'erp/revision', 'seller']) {
        const response = await page.request.get(`${origin}/api/international/workspaces/${organizationId}/${path}`, { headers: { 'X-Zentra-Expected-User': userId } });
        expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store'); values.push(await response.json()); publicReadCount++;
      }
      const serialized = JSON.stringify(values);
      for (const marker of privateMarkers) expect(serialized).not.toContain(marker);
      for (const key of ['legalName', 'taxOrigin', 'facts', 'verification']) expect(serialized).not.toContain(`"${key}"`);
      expect(values[0]).toMatchObject({ status: 'ready', state: { revision: 1, invoices: [], configuration: { taxConfiguration: { status: 'unconfigured' } } } });
      expect(values[1]).not.toBeNull();
    };
    await publicReads(); checks.push('Real SQL-backed ERP state/delta/revision and seller projections contain no private tax facts');
    step = 'withhold_committed_receipt';
    await panel.getByLabel(c.legalName, { exact: true }).fill(recoveredFacts.legalName); loseNextTaxResponse = true;
    await panel.getByRole('button', { name: c.save, exact: true }).click(); await panel.getByRole('button', { name: c.retry, exact: true }).waitFor();
    const lost = requests.filter(request => request.channel === 'tax-profile' && request.method === 'PUT').at(-1)!;
    expect(lost.responseLost).toBe(true); expect(lost.status).toBe(200); expect(lost.deliveredStatus).toBe(200);
    const afterLost = await snapshot(); expect(afterLost.heads).toEqual([{ revision: 2, facts: recoveredFacts, updated_by: userId }]); expect(afterLost.changes).toHaveLength(2);
    expect(afterLost.changes[1]).toMatchObject({ previous_revision: 1, previous_facts: facts, facts: recoveredFacts });
    expect(await page.getByRole('button', { name: 'Save seller details', exact: true }).isDisabled()).toBe(true);
    const originalReceipt = taxReceipts.at(-1)!;
    step = 'retry_exact_real_receipt'; const requestOffset = requests.length;
    await panel.getByRole('button', { name: c.retry, exact: true }).click(); await panel.getByText(c.saved, { exact: true }).waitFor();
    const retryRequests = requests.slice(requestOffset).filter(request => request.channel === 'tax-profile');
    expect(retryRequests.map(request => request.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(retryRequests[1].body).toBe(lost.body); expect(taxReceipts.at(-1)).toEqual({ ...originalReceipt, replayed: true }); replayed = true;
    expect(await snapshot()).toEqual(afterLost); expect(taxReads.at(-1)).toMatchObject({ revision: 2, facts: recoveredFacts, verification: 'unverified' });
    expect(await panel.getByLabel(c.legalName, { exact: true }).inputValue()).toBe(recoveredFacts.legalName);
    checks.push('Real committed receipt JSON deliberately truncated after its HTTP200 headers; explicit retry made fresh owner GET then byte-identical PUT and replayed exact receipt without another SQL revision/history row');
    await publicReads();
    expect(await resolveUsTaxConfiguration(client, actor())).toEqual({ status: 'blocked', reason: 'provider_verification_required', organizationId, revision: 2 });
    expect((await postgres.query('select * from public.zentra_us_erp_records where organization_id=$1 and kind in (\'invoice\',\'journal\')', [organizationId])).rows).toEqual([]);
    checks.push('Private declarations remain unverified; resolver blocked, provider null, no invoice/journal issued');
    step = 'owner_loss_http_403_purge';
    await panel.getByLabel(c.legalName, { exact: true }).fill(dirtyDraft); serverRole = 'member';
    await panel.getByRole('button', { name: c.reload, exact: true }).click(); await panel.getByText(c.denied, { exact: true }).waitFor();
    expect(requests.at(-1)).toMatchObject({ channel: 'tax-profile', method: 'GET', status: 403 });
    expect(await panel.locator('input,select').count()).toBe(0); expect(await panel.getByRole('button', { name: c.retry, exact: true }).count()).toBe(0);
    const html = await page.content(); for (const marker of privateMarkers) expect(html).not.toContain(marker);
    const taxReadCountAfterDenial = requests.filter(request => request.channel === 'tax-profile').length;
    // A member's successful public GET must not reopen the stale SSR owner panel.
    await page.getByRole('button', { name: 'Reload data', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.us-erp-toolbar button')?.disabled);
    expect(requests.filter(request => request.channel === 'tax-profile')).toHaveLength(taxReadCountAfterDenial);
    expect(await panel.locator('input,select').count()).toBe(0); expect(await page.getByRole('button', { name: 'Save seller details', exact: true }).count()).toBe(0);
    expect(await snapshot()).toEqual(afterLost); await publicReads();
    checks.push('Actual owner-only HTTP 403 purged private facts/draft DOM; a later accepted public member GET could not reopen private UI or change history');
    const storage = await page.evaluate(() => ({ local: Object.values(localStorage), session: Object.values(sessionStorage) }));
    for (const marker of privateMarkers) expect(JSON.stringify(storage)).not.toContain(marker);
    expect(requests.every(request => request.expectedUser === userId)).toBe(true); expect(pageErrors).toEqual([]);
    for (const marker of privateMarkers) expect(JSON.stringify(diagnostics)).not.toContain(marker);
    expect(requests.filter(request => request.channel === 'erp' && request.method === 'POST')).toHaveLength(1);
    expect(requests.filter(request => request.channel === 'tax-profile' && request.method === 'PUT')).toHaveLength(3);
    for (const file of sourceFiles) expect(hash(await readFile(resolve(file)))).toBe(hashes[file]);
    checks.push('Expected-user header on all channels, no persistent private browser storage, no private diagnostics or page errors, source snapshot unchanged');
    step = 'complete'; success = true;
  } catch (error) { failureType = error instanceof Error ? error.name : 'unknown'; throw error; }
  finally {
    await closeBrowser?.(); activeServer?.closeAllConnections();
    if (activeServer?.listening) await new Promise<void>(done => activeServer!.close(() => done()));
    await db?.close();
    await writeFile(resolve(directory, 'browser.json'), JSON.stringify({ success, step, failureType, durationMs: Math.round(performance.now() - started), scope: 'Actual React UsErpWorkbench and private browser session -> loopback Node HTTP -> createUsTaxProfileHandlers -> private service -> existing PostgreSQL RPC. ERP/seller/sync handlers also use real SQL RPC. Synthetic local Auth/D1 admission, flags and postcommit receipt loss (successful HTTP200 body deliberately truncated as incomplete JSON). One serialized RAM PGlite PostgreSQL, no hosted Supabase/PostgREST, independent connections, restart/crash durability or provider/production proof. All entered facts are fictitious; no Stripe access, issuance or grant.', flags: ['ZENTRA_BROWSER_TAX_PROFILE_POSTGRES_QA=1', 'PGLITE_MODULE_DIR=<absolute installed @electric-sql/pglite directory>'], checks, postgres: { taxHeadRevision: headRevision, taxHistoryRows: auditRows, exactReceiptReplayed: replayed }, publicReadCount, pageErrorCount: pageErrors.length, requests: requests.map(request => ({ channel: request.channel, method: request.method, status: request.status, deliveredStatus: request.deliveredStatus, responseLost: request.responseLost, ...(request.responseLost ? { responseFault: 'truncated_json_after_commit' } : {}), expectedUserBound: request.expectedUser === userId, ...(request.body ? { bodySha256: hash(request.body) } : {}) })), sourceSha256: hashes }, null, 2));
  }
}, 180_000);
