import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { UsAuthorityError } from './saas-authority';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

const f = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, user: vi.fn(), access: vi.fn(), scope: vi.fn(), create: vi.fn(), country: vi.fn(), rate: vi.fn(), factory: vi.fn(), rpc: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: f.env }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: f.user }));
vi.mock('./saas-authority-d1', () => ({ requireUsWorkspaceAccess: f.access }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: f.rpc }) }));
vi.mock('./us-financial-pilot-store', () => ({ readUsFinancialPilotScope: f.scope, createSupabaseUsFinancialPilotStore: vi.fn(), readUsFinancialPilotPromotionStatus: vi.fn() }));
vi.mock('./us-financial-pilot-bank-store', () => ({ createSupabaseUsFinancialPilotBankStore: f.create }));
vi.mock('./workspace-service', () => ({ getWorkspaceCountry: f.country }));
vi.mock('../account', () => ({ enforceAccountRateLimit: f.rate }));
vi.mock('./us-financial-pilot-bank-server', () => ({ createUsFinancialPilotBankHandlers: (...args: unknown[]) => { f.factory(...args); return { POST: vi.fn() }; } }));
import { usFinancialPilotBankDependencies as deps } from './us-financial-pilot-bank-bindings';

const org = '10000000-0000-4000-8000-000000000001', userId = '20000000-0000-4000-8000-000000000001';
const flags = ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_FINANCIAL_V5_INSTALLED', 'INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED', 'ZENTRA_US_FINANCIAL_BANK_TEST_INSTALLED'] as const;
function enable() { for (const name of flags) f.env[name] = 'true'; f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT = 'TEST'; }
const request = (headers: Record<string, string> = {}) => new Request('https://zentra.test/private-bank', { headers });
beforeEach(() => { vi.clearAllMocks(); for (const name of Object.keys(f.env)) delete f.env[name]; f.user.mockResolvedValue({ userId }); f.access.mockResolvedValue({ organizationId: org, userId, role: 'owner' }); });

describe('bank private bindings — real existing admission, synthetic Auth/D1', () => {
  it('defaults closed without touching a store or manufacturing rights', async () => { expect(await deps.enabled()).toBe(false); expect(f.scope).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); });
  it.each(flags)('requires exact true flag %s', async name => { enable(); f.env[name] = 'TRUE'; expect(await deps.enabled()).toBe(false); delete f.env[name]; expect(await deps.enabled()).toBe(false); });
  it.each(['LIVE', 'test', 'TEST ', undefined])('requires exact TEST, refuses %j', async value => { enable(); f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT = value; expect(await deps.enabled()).toBe(false); });
  it('uses the effective read-only browser identity and membership', async () => { enable(); expect(await deps.enabled()).toBe(true); expect(await deps.authority(request(), org)).toMatchObject({ mode: 'browser', actor: { organizationId: org, userId, role: 'owner', managementEntitled: true } }); expect(f.user).toHaveBeenCalledWith({ offerAccess: false }); expect(f.access).toHaveBeenCalledWith(org, userId); });
  it.each(['owner', 'admin', 'accountant'])('retains admitted role %s', async role => { f.access.mockResolvedValue({ organizationId: org, userId, role }); expect((await deps.authority(request(), org)).actor.role).toBe(role); });
  it.each(['member', 'read_only'])('does not extend financial access to %s', async role => { f.access.mockResolvedValue({ organizationId: org, userId, role }); await expect(deps.authority(request(), org)).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 }); });
  it('refuses a device credential before browser Auth', async () => { await expect(deps.authority(request({ Authorization: 'Bearer synthetic' }), org)).rejects.toMatchObject({ code: 'forbidden', status: 403 }); expect(f.user).not.toHaveBeenCalled(); });
  it('requires a living session', async () => { f.user.mockResolvedValue(null); await expect(deps.authority(request(), org)).rejects.toBeInstanceOf(AccountPublicError); expect(f.access).not.toHaveBeenCalled(); });
  it.each(['user', 'organization'])('refuses effective membership %s mismatch', async field => { f.access.mockResolvedValue({ organizationId: field === 'organization' ? 'different' : org, userId: field === 'user' ? 'different' : userId, role: 'owner' }); await expect(deps.authority(request(), org)).rejects.toMatchObject({ code: 'tenant_mismatch', status: 403 }); });
  it.each([402, 403, 503])('preserves current authority denial %s', async status => { f.access.mockRejectedValueOnce(new UsAuthorityError(status === 402 ? 'subscription_required' : status === 403 ? 'forbidden' : 'service_unavailable', status)); await expect(deps.authority(request(), org)).rejects.toMatchObject({ status }); });
  it('binds the separate bank factory to the exact admitted scope and fresh callback', async () => {
    const actor = (await deps.authority(request(), org)).actor, configuration = { organizationId: org, country: 'US' }, scope = { scope: { organizationId: org, actor }, optInVersion: 2 } as UsFinancialPilotScope;
    const fresh = vi.fn(async () => scope), store = { synthetic: true }; f.country.mockResolvedValue({ status: 'configured', configuration }); f.scope.mockResolvedValue(scope); f.create.mockReturnValue(store);
    expect(await deps.configuration(actor)).toBe(configuration); expect(await deps.scope(actor, scope)).toBe(scope); expect(await deps.store(scope, fresh)).toBe(store);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ rpc: f.rpc }), scope, fresh); expect(f.scope).toHaveBeenCalledWith(expect.objectContaining({ rpc: f.rpc }), actor, scope);
  });
  it('fails closed on missing country instead of falling back to ERP4', async () => { f.country.mockResolvedValue({ status: 'required' }); await expect(deps.configuration((await deps.authority(request(), org)).actor)).rejects.toMatchObject({ code: 'financial_configuration_changed', status: 409 }); });
  it('retains tenant/user scoped rate limits and emits only bounded diagnostics', async () => {
    const actor = (await deps.authority(request(), org)).actor, req = request(); await deps.rateLimit(req, actor, 'read'); await deps.rateLimit(req, actor, 'write');
    expect(f.rate).toHaveBeenCalledWith(req, 'international-financial-pilot-read', `${org}:${userId}`, 3600); expect(f.rate).toHaveBeenCalledWith(req, 'international-financial-pilot-write', `${org}:${userId}`, 120);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {}); deps.diagnostic({ operation: 'read', code: 'financial_service_unavailable', status: 503 }); expect(spy).toHaveBeenCalledWith('zentra.international.financial-pilot-bank', { operation: 'read', code: 'financial_service_unavailable', status: 503 }); spy.mockRestore();
  });
});
