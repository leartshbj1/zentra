import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { UsAuthorityError } from './saas-authority';
const f = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, auth: vi.fn(), rpc: vi.fn(), authority: vi.fn(), configuration: vi.fn(), automation: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: f.env }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: f.auth }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: f.rpc }) }));
vi.mock('./runtime-bindings', () => ({ erpServerDependencies: { authority: f.authority, configuration: f.configuration }, usPurchasingSchemaVersion: async () => 4 }));
vi.mock('./saas-authority-d1', () => ({ requireUsWorkspaceAutomationAuthority: f.automation }));
vi.mock('../account', () => ({ enforceAccountRateLimit: async () => {} }));
vi.mock('../runtime', () => ({ runtimeValue: () => '', database: () => { throw Error('Unexpected TEST D1 read'); } }));
import { usWorkspaceSyncEnabled, usWorkspaceSyncHeadsHandlers } from './us-workspace-sync-heads-bindings';
const flags = ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_BACKGROUND_SYNC_ENABLED'];
beforeEach(() => { for (const key of Object.keys(f.env)) delete f.env[key]; vi.resetAllMocks(); });
describe('US background sync gate', () => {
  it.each(flags)('requires exact independently enabled %s', async absent => {
    for (const key of flags) f.env[key] = 'true'; delete f.env[absent];
    expect(await usWorkspaceSyncEnabled()).toBe(false);
    expect((await usWorkspaceSyncHeadsHandlers.GET(new Request('https://zentra.test/sync-heads'), 'bad')).status).toBe(404);
    expect(f.auth).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false', 'TRUE', '1', 'true '])('does not infer an enablement from %j', async value => {
    for (const key of flags) f.env[key] = 'true'; f.env.INTERNATIONAL_US_BACKGROUND_SYNC_ENABLED = value; expect(await usWorkspaceSyncEnabled()).toBe(false);
  });
  it('reports readiness only when all three gates agree', async () => { for (const key of flags) f.env[key] = 'true'; expect(await usWorkspaceSyncEnabled()).toBe(true); });
});
describe('US compact binding uses current Auth and independent Automation entitlement', () => {
  function admitted() {
    for (const key of flags) f.env[key] = 'true';
    const organizationId = randomUUID(), userId = randomUUID(), actor = { organizationId, userId, role: 'owner', managementEntitled: true, timestamp: new Date().toISOString() };
    f.auth.mockResolvedValue({ provider: 'supabase', userId, emailConfirmed: true });
    f.authority.mockResolvedValue({ mode: 'browser', actor });
    f.configuration.mockResolvedValue({ schemaVersion: 1, organizationId, country: 'US', currency: 'USD' });
    f.rpc.mockResolvedValue({ schemaVersion: 1, organizationId, role: 'owner', erp: { schemaVersion: 4, organizationId, revision: 1 }, channels: { supplierProposals: null, bankReconciliations: null, sellerProfile: 'a'.repeat(64), taxProfile: 'b'.repeat(64), team: null, supplierAnalysis: null } });
    const request = new Request('https://zentra.test/sync-heads', { headers: { 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': userId } });
    return { organizationId, userId, request, run: () => usWorkspaceSyncHeadsHandlers.GET(request, organizationId) };
  }
  it('reuses fresh ERP authority before and after the private read without token refresh side effects', async () => {
    const v = admitted(), response = await v.run(); expect(response.status).toBe(200);
    expect(f.authority).toHaveBeenCalledTimes(3); expect(f.auth).not.toHaveBeenCalled();
    expect(f.automation).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('withholds the projection if fresh Auth returns another expected account', async () => {
    const v = admitted(); f.authority.mockImplementation(async () => ({ mode: 'browser', actor: { organizationId: v.organizationId, userId: randomUUID(), role: 'owner', managementEntitled: true, timestamp: new Date().toISOString() } }));
    const response = await v.run(); expect(response.status).toBe(401); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('leaves supplier proposals and analysis null when Management exists but Automation is unavailable', async () => {
    const v = admitted(); f.env.INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED = 'true'; f.automation.mockRejectedValue(new UsAuthorityError('subscription_required', 402));
    const response = await v.run(); expect(response.status).toBe(200); expect((await response.json() as { channels: unknown }).channels).toMatchObject({ supplierProposals: null, supplierAnalysis: null });
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_supplier: false, p_analysis: false, p_grant: null, p_analysis_configuration_hash: null });
  });
  it('withholds a candidate on Automation loss, then returns both supplier channels null', async () => {
    const v = admitted(); f.env.INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED = 'true';
    f.automation.mockResolvedValue({ organizationId: v.organizationId, userId: v.userId, role: 'owner', environment: 'TEST', catalogVersion: 'TEST', priceId: 'price_TEST', subscriptionId: 'TEST-sub', authorityReference: 'TEST-proof' });
    f.rpc.mockImplementation(async (_name: string, params: { p_supplier: boolean; p_analysis: boolean }) => {
      f.automation.mockRejectedValue(new UsAuthorityError('subscription_required', 402));
      return { schemaVersion: 1, organizationId: v.organizationId, role: 'owner', erp: { schemaVersion: 4, organizationId: v.organizationId, revision: 1 }, channels: { supplierProposals: params.p_supplier ? 'c'.repeat(64) : null, bankReconciliations: null, sellerProfile: 'a'.repeat(64), taxProfile: 'b'.repeat(64), team: null, supplierAnalysis: params.p_analysis ? 'd'.repeat(64) : null } };
    });
    const response = await v.run(); expect(response.status).toBe(409); expect(await response.json()).not.toHaveProperty('channels');
    const fresh = await v.run(); expect(fresh.status).toBe(200); const body = await fresh.json() as { channels: unknown }; expect(body.channels).toMatchObject({ supplierProposals: null, supplierAnalysis: null });
    expect(f.rpc.mock.calls[1][1]).toMatchObject({ p_supplier: false, p_analysis: false, p_grant: null });
    expect(JSON.stringify(body)).not.toMatch(/grant|subscriptionId|authorityReference|TEST-proof/);
  });
  it('keeps member Management reads valid without admitting supplier channels', async () => {
    const v = admitted(); f.env.INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED = 'true';
    f.authority.mockResolvedValue({ mode: 'browser', actor: { organizationId: v.organizationId, userId: v.userId, role: 'member', managementEntitled: true, timestamp: new Date().toISOString() } });
    f.rpc.mockResolvedValue({ schemaVersion: 1, organizationId: v.organizationId, role: 'member', erp: { schemaVersion: 4, organizationId: v.organizationId, revision: 1 }, channels: { supplierProposals: null, bankReconciliations: null, sellerProfile: null, taxProfile: null, team: null, supplierAnalysis: null } });
    expect((await v.run()).status).toBe(200); expect(f.automation).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_supplier: false, p_analysis: false, p_grant: null });
  });
});
