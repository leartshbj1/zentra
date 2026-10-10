import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

const f = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, enabled: vi.fn(), authority: vi.fn(), configuration: vi.fn(), scope: vi.fn(), store: vi.fn(), invoiceStore: vi.fn(), merchant: vi.fn(), rpc: vi.fn(), rate: vi.fn(), factory: vi.fn(), prepare: vi.fn(), issue: vi.fn(), catalogue: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: f.env }));
vi.mock('./us-financial-pilot-bindings', () => ({ usFinancialPilotDependencies: { enabled: f.enabled, authority: f.authority, configuration: f.configuration, scope: f.scope, store: f.store } }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: f.rpc }) }));
vi.mock('./us-financial-pilot-invoice-store', () => ({ createSupabaseUsFinancialPilotInvoiceStore: f.invoiceStore }));
vi.mock('./us-tax-merchant-resolver', () => ({ resolveUsTaxTestMerchant: f.merchant }));
vi.mock('../account', () => ({ enforceAccountRateLimit: f.rate }));
vi.mock('./us-financial-pilot-invoice-server', () => ({ createUsFinancialPilotInvoiceHandlers: (...args: unknown[]) => { f.factory(...args); return { PREPARE: f.prepare, ISSUE: f.issue, CATALOGUE: f.catalogue }; } }));
import { usFinancialPilotInvoiceDependencies as deps, usFinancialPilotInvoiceMerchant } from './us-financial-pilot-invoice-bindings';
import { POST as prepareRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/invoices/prepare/route';
import { POST as issueRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/invoices/issue/route';
import { GET as catalogueRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/tax-codes/route';
import { createBrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';

const org = '10000000-0000-4000-8000-000000000001', user = '20000000-0000-4000-8000-000000000001';
const flags = ['INTERNATIONAL_US_TAX_TEST_MERCHANT_ENABLED', 'INTERNATIONAL_US_TAX_TEST_INVOICE_ENABLED'] as const;
let originalSaasKey: string | undefined;
beforeEach(() => { vi.clearAllMocks(); originalSaasKey = process.env.STRIPE_SECRET_KEY; for (const key of Object.keys(f.env)) delete f.env[key]; f.enabled.mockReturnValue(true); f.merchant.mockReturnValue({ synthetic: true }); });
afterEach(() => { if (originalSaasKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = originalSaasKey; });
function open() { for (const flag of flags) f.env[flag] = 'true'; }

describe('invoice real bindings — synthetic private ports, no provider or network calls', () => {
  it('reuses the existing pilot Auth/configuration/scope/book authority and resolves no merchant at initialization', () => {
    expect(deps.enabled).toBe(f.enabled); expect(deps.authority).toBe(f.authority); expect(deps.configuration).toBe(f.configuration); expect(deps.scope).toBe(f.scope); expect(deps.store).toBe(f.store);
    expect(f.merchant).not.toHaveBeenCalled(); expect(deps.allowTestFixtures).toBeUndefined();
  });
  it('keeps the merchant lazy and closed when the enclosing pilot is closed', async () => { open(); f.enabled.mockReturnValue(false); expect(await usFinancialPilotInvoiceMerchant(org)).toBeNull(); expect(f.merchant).not.toHaveBeenCalled(); });
  it.each(flags)('requires exact dedicated TEST flag %s', async flag => { open(); for (const value of [undefined, 'TRUE', 'false', 'true ']) { f.env[flag] = value; expect(await deps.merchant(org)).toBeNull(); } expect(f.merchant).not.toHaveBeenCalled(); });
  it('passes only dedicated merchant configuration and explicitly forbids both SaaS keys', async () => {
    open(); f.env.INTERNATIONAL_US_TAX_TEST_MERCHANTS_JSON = 'synthetic-dedicated-config'; f.env.INTERNATIONAL_US_TAX_TEST_CREDENTIALS_JSON = 'synthetic-dedicated-credentials'; f.env.STRIPE_SECRET_KEY = 'synthetic-worker-saas'; process.env.STRIPE_SECRET_KEY = 'synthetic-process-saas';
    expect(await deps.merchant(org)).toEqual({ synthetic: true }); expect(f.merchant).toHaveBeenCalledWith({ organizationId: org, configurationJson: 'synthetic-dedicated-config', credentialsJson: 'synthetic-dedicated-credentials', forbiddenSaasKeys: ['synthetic-worker-saas', 'synthetic-process-saas'], now: expect.any(Function) });
  });
  it('does not manufacture missing dedicated credentials or fall back to a SaaS key', async () => { open(); f.env.STRIPE_SECRET_KEY = 'synthetic-saas-only'; f.merchant.mockReturnValue(null); expect(await deps.merchant(org)).toBeNull(); expect(f.merchant).toHaveBeenCalledWith(expect.objectContaining({ configurationJson: '', credentialsJson: '', forbiddenSaasKeys: expect.arrayContaining(['synthetic-saas-only']) })); });
  it('closes malformed dedicated merchant resolution without leaking its private failure', async () => { open(); f.merchant.mockImplementation(() => { throw Error('PRIVATE synthetic secret'); }); expect(await deps.merchant(org)).toBeNull(); });
  it('constructs only the pilot-admitted SQL fiscal adapter, with no fixture option', async () => {
    const scope = { scope: { organizationId: org }, optInVersion: 1 } as UsFinancialPilotScope, revalidate = vi.fn(async () => scope), store = { synthetic: 'fiscal' }; f.invoiceStore.mockReturnValue(store);
    expect(await deps.invoiceStore(scope, revalidate)).toBe(store); expect(f.invoiceStore).toHaveBeenCalledWith(expect.objectContaining({ rpc: f.rpc }), scope, revalidate); expect(f.merchant).not.toHaveBeenCalled();
  });
  it('rates catalogue reads separately from preparation/issue writes with exact tenant and user scope', async () => {
    const request = new Request('https://zentra.test/invoice'), actor = { organizationId: org, userId: user, role: 'owner' as const, managementEntitled: true as const, timestamp: '2026-10-10T12:00:00.000Z' };
    await deps.rateLimit(request, actor, 'read'); await deps.rateLimit(request, actor, 'write'); expect(f.rate).toHaveBeenCalledWith(request, 'international-financial-pilot-invoice-read', `${org}:${user}`, 120); expect(f.rate).toHaveBeenCalledWith(request, 'international-financial-pilot-invoice-write', `${org}:${user}`, 24);
  });
  it('passes only resolved organization parameters to all three thin routes', async () => {
    const request = new Request('https://zentra.test/invoice'), prepare = new Response('prepare'), issue = new Response('issue'), catalogue = new Response('catalogue'); f.prepare.mockResolvedValue(prepare); f.issue.mockResolvedValue(issue); f.catalogue.mockResolvedValue(catalogue);
    expect(await prepareRoute(request, { params: Promise.resolve({ organizationId: org }) })).toBe(prepare); expect(await issueRoute(request, { params: Promise.resolve({ organizationId: org }) })).toBe(issue); expect(await catalogueRoute(request, { params: Promise.resolve({ organizationId: org }) })).toBe(catalogue);
    for (const method of [f.prepare, f.issue, f.catalogue]) expect(method).toHaveBeenCalledWith(request, org);
  });
  it('connects the browser catalogue URL to the actual tax-codes route file', async () => {
    f.catalogue.mockResolvedValue(Response.json({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, taxCodes: [{ id: 'txcd_10000000', name: 'Synthetic service', description: 'Synthetic only' }], hasMore: false, nextCursor: null }));
    const fetcher: typeof globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe(`/api/international/workspaces/${org}/financial-pilot/tax-codes?code=txcd_10000000`);
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store' });
      return catalogueRoute(new Request(new URL(String(url), 'https://zentra.test'), init), { params: Promise.resolve({ organizationId: org }) });
    });
    const session = createBrowserUsFinancialPilotSession({ organizationId: org, expectedUserId: user, fetch: fetcher, environment: { isVisible: () => true, isOnline: () => true, subscribe: () => () => {} } });
    try { expect(await session.readTaxCodes({ code: 'txcd_10000000' })).toMatchObject({ organizationId: org, taxCodes: [{ id: 'txcd_10000000' }] }); expect(f.catalogue).toHaveBeenCalledOnce(); } finally { session.dispose(); }
  });
});
