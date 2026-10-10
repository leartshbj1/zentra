import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { UsAuthorityError } from './saas-authority';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

const f = vi.hoisted(() => ({ env: {} as Record<string, unknown>, user: vi.fn(), access: vi.fn(), scope: vi.fn(), create: vi.fn(), country: vi.fn(), rate: vi.fn(), factory: vi.fn(), rpc: vi.fn(), get: vi.fn(), post: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: f.env }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: f.user }));
vi.mock('./saas-authority-d1', () => ({ requireUsWorkspaceAccess: f.access }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: f.rpc }) }));
vi.mock('./us-financial-pilot-store', () => ({ readUsFinancialPilotScope: f.scope, createSupabaseUsFinancialPilotStore: vi.fn(), readUsFinancialPilotPromotionStatus: vi.fn() }));
vi.mock('./us-financial-pilot-seller-store', () => ({ createSupabaseUsFinancialPilotSellerStore: f.create }));
vi.mock('./workspace-service', () => ({ getWorkspaceCountry: f.country }));
vi.mock('../account', () => ({ enforceAccountRateLimit: f.rate }));
vi.mock('./us-financial-pilot-seller-server', () => ({ createUsFinancialPilotSellerHandlers: (...args: unknown[]) => { f.factory(...args); return { GET: f.get, POST: f.post }; } }));
import { usFinancialPilotSellerDependencies as deps, usFinancialPilotSellerInstalled, usFinancialPilotSellerWriteEnabled } from './us-financial-pilot-seller-bindings';
import { GET, POST } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/seller/route';

const org = '10000000-0000-4000-8000-000000000001', userId = '20000000-0000-4000-8000-000000000001';
const flags = ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_FINANCIAL_V5_INSTALLED', 'INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED', 'ZENTRA_US_FINANCIAL_SELLER_TEST_INSTALLED'] as const;
function enable() { for (const name of flags) f.env[name] = 'true'; f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT = 'TEST'; f.env.ZENTRA_US_FINANCIAL_SELLER_TEST_ENABLED = 'true'; }
const request = (headers: Record<string, string> = {}) => new Request('https://zentra.test/private-seller', { headers });
beforeEach(() => { vi.clearAllMocks(); for (const name of Object.keys(f.env)) delete f.env[name]; f.user.mockResolvedValue({ userId }); f.access.mockResolvedValue({ organizationId: org, userId, role: 'owner' }); });

describe('seller private bindings — real admission, synthetic Auth/D1 and RPC factory', () => {
  it('defaults closed without touching a store or provisioning rights', async () => { expect(await usFinancialPilotSellerInstalled()).toBe(false); expect(await deps.enabled()).toBe(false); expect(await usFinancialPilotSellerWriteEnabled()).toBe(false); expect(f.scope).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); });
  it.each(flags)('requires exact true read gate %s', async name => { enable(); f.env[name] = 'TRUE'; expect(await deps.enabled()).toBe(false); expect(await deps.writeEnabled()).toBe(false); delete f.env[name]; expect(await deps.enabled()).toBe(false); });
  it.each(['LIVE', 'test', 'TEST ', undefined])('requires exact TEST, refuses %j', async value => { enable(); f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT = value; expect(await deps.enabled()).toBe(false); expect(await deps.writeEnabled()).toBe(false); });
  it.each([false, true, 'TRUE', undefined])('keeps compatible reads installed with new-write gate %j closed', async value => {
    enable(); f.env.ZENTRA_US_FINANCIAL_SELLER_TEST_ENABLED = value; expect(await usFinancialPilotSellerInstalled()).toBe(true); expect(await deps.enabled()).toBe(true); expect(await deps.writeEnabled()).toBe(false); expect(f.create).not.toHaveBeenCalled();
  });
  it('separates the retained installation marker from base pilot admission', async () => { enable(); expect(await deps.writeEnabled()).toBe(true); delete f.env.INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED; expect(await usFinancialPilotSellerInstalled()).toBe(true); expect(await deps.enabled()).toBe(false); expect(await deps.writeEnabled()).toBe(false); });
  it('uses read-only browser identity and effective workspace membership', async () => { enable(); expect(await deps.authority(request(), org)).toMatchObject({ mode: 'browser', actor: { organizationId: org, userId, role: 'owner', managementEntitled: true } }); expect(f.user).toHaveBeenCalledWith({ offerAccess: false }); expect(f.access).toHaveBeenCalledWith(org, userId); });
  it.each(['owner', 'admin', 'accountant'])('retains financial role %s for the handler to enforce operation-specific access', async role => { f.access.mockResolvedValue({ organizationId: org, userId, role }); expect((await deps.authority(request(), org)).actor.role).toBe(role); });
  it.each(['member', 'read_only'])('does not extend financial access to %s', async role => { f.access.mockResolvedValue({ organizationId: org, userId, role }); await expect(deps.authority(request(), org)).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 }); });
  it('refuses a device credential before browser Auth and requires a living browser session', async () => { await expect(deps.authority(request({ Authorization: 'Bearer synthetic' }), org)).rejects.toMatchObject({ code: 'forbidden', status: 403 }); expect(f.user).not.toHaveBeenCalled(); f.user.mockResolvedValue(null); await expect(deps.authority(request(), org)).rejects.toBeInstanceOf(AccountPublicError); expect(f.access).not.toHaveBeenCalled(); });
  it.each(['user', 'organization'])('refuses effective membership %s mismatch', async field => { f.access.mockResolvedValue({ organizationId: field === 'organization' ? 'different' : org, userId: field === 'user' ? 'different' : userId, role: 'owner' }); await expect(deps.authority(request(), org)).rejects.toMatchObject({ code: 'tenant_mismatch', status: 403 }); });
  it.each([402, 403, 503])('preserves current authority denial %s', async status => { f.access.mockRejectedValueOnce(new UsAuthorityError(status === 402 ? 'subscription_required' : status === 403 ? 'forbidden' : 'service_unavailable', status)); await expect(deps.authority(request(), org)).rejects.toMatchObject({ status }); });
  it('binds the exact admitted scope and fresh callback to the separate seller factory', async () => {
    const actor = (await deps.authority(request(), org)).actor, configuration = { organizationId: org, country: 'US' }, scope = { scope: { organizationId: org, actor }, optInVersion: 2 } as UsFinancialPilotScope;
    const fresh = vi.fn(async () => scope), store = { synthetic: true }; f.country.mockResolvedValue({ status: 'configured', configuration }); f.scope.mockResolvedValue(scope); f.create.mockReturnValue(store);
    expect(await deps.configuration(actor)).toBe(configuration); expect(await deps.scope(actor, scope)).toBe(scope); expect(await deps.store(scope, fresh)).toBe(store);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ rpc: f.rpc }), scope, fresh); expect(f.scope).toHaveBeenCalledWith(expect.objectContaining({ rpc: f.rpc }), actor, scope);
  });
  it('fails closed on missing country and scopes rate limits/diagnostics without profile data', async () => {
    const actor = (await deps.authority(request(), org)).actor, req = request(); f.country.mockResolvedValue({ status: 'required' }); await expect(deps.configuration(actor)).rejects.toMatchObject({ code: 'financial_configuration_changed', status: 409 });
    await deps.rateLimit(req, actor, 'read'); await deps.rateLimit(req, actor, 'write'); expect(f.rate).toHaveBeenCalledWith(req, 'international-financial-pilot-read', `${org}:${userId}`, 3600); expect(f.rate).toHaveBeenCalledWith(req, 'international-financial-pilot-write', `${org}:${userId}`, 120);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {}); try { deps.diagnostic({ operation: 'write', code: 'seller_revision_conflict', status: 409 }); expect(spy).toHaveBeenCalledWith('zentra.international.financial-pilot-seller', { operation: 'write', code: 'seller_revision_conflict', status: 409 }); } finally { spy.mockRestore(); }
  });
  it('routes GET and POST through resolved path params without injecting identity or authorization', async () => {
    const req = request(), read = new Response('read'), written = new Response('write'); f.get.mockResolvedValue(read); f.post.mockResolvedValue(written);
    expect(await GET(req, { params: Promise.resolve({ organizationId: org }) })).toBe(read); expect(await POST(req, { params: Promise.resolve({ organizationId: org }) })).toBe(written); expect(f.get).toHaveBeenCalledWith(req, org); expect(f.post).toHaveBeenCalledWith(req, org);
  });
});
