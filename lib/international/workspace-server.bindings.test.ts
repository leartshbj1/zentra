import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { UsAuthorityError } from './saas-authority';
const f = vi.hoisted(() => ({ device: vi.fn(), membership: vi.fn(), user: vi.fn(), seats: vi.fn(), rate: vi.fn(), select: vi.fn(), rpc: vi.fn(), client: vi.fn(), usMarker:vi.fn(), usAccess:vi.fn() }));
vi.mock('../account', () => ({ requireDeviceSession: f.device, requireBrowserMembership: f.membership, enforceAccountRateLimit: f.rate }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: f.user }));
vi.mock('../team-seats', () => ({ teamSeats: f.seats }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: f.client }));
vi.mock('./saas-authority-d1', () => ({ isUsWorkspaceAdmission:f.usMarker, requireUsWorkspaceAccess:f.usAccess }));
import { createWorkspaceCountryHandlers, workspaceCountryDependencies as binding } from './workspace-server';
import type { CompanyConfiguration } from './types';

const org = 'fictitious-country-bindings';
const actor = { organizationId: org, userId: 'owner-a', role: 'owner' as const };
const session = { ...actor, sessionId: 'session-a', installationId: 'installation-a', subscriptionId: 'subscription-a' };
const configuration = {
  schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/Chicago',
  address: { country: 'US', line1: '1 Example Road', postalCode: '60601', city: 'Chicago', subdivision: 'IL' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, ein: '12-3456789',
};
const input = { expectedRevision: 1, requestId: '10000000-0000-4000-8000-000000000021', configuration };
const request = (method: 'GET' | 'PUT' = 'GET', native = true) => new Request(`https://zentraapp.ch/api/international/workspaces/${org}/country`, {
  method, headers: { ...(native ? { Authorization: `Bearer zds_${'a'.repeat(43)}` } : { Origin: 'https://zentraapp.ch' }), ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) },
  ...(method === 'PUT' ? { body: JSON.stringify(input) } : {}),
});
const handlers = () => createWorkspaceCountryHandlers({ ...binding, enabled: () => true });
beforeEach(() => {
  vi.resetAllMocks();
  f.device.mockResolvedValue(session); f.membership.mockResolvedValue({ organizationId: org, role: 'owner' }); f.user.mockResolvedValue({ userId: actor.userId });
  f.seats.mockResolvedValue({ subscriptionActive: true }); f.rate.mockResolvedValue(undefined);
  f.usMarker.mockResolvedValue(false);f.usAccess.mockResolvedValue({organizationId:org,userId:actor.userId,role:'owner'});
  f.select.mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : [{ organization_id: org, schema_version: 1, config: configuration, country: 'US', currency: 'USD', revision: 1, updated_by: actor.userId, updated_at: '2026-10-08T12:00:00Z' }]);
  f.rpc.mockResolvedValue({ organizationId: org, revision: 2, configuration, updatedBy: actor.userId, updatedAt: '2026-10-08T12:00:00Z', replayed: false });
  f.client.mockReturnValue({ select: f.select, rpc: f.rpc });
});

describe('actual country admission bindings', () => {
  it('dispatches a new US browser membership to its own USD authority without a CHF fallback',async()=>{f.usMarker.mockResolvedValue(true);expect(await binding.membership(actor.userId,org,['owner'])).toEqual({organizationId:org,role:'owner'});expect(await binding.management(org,actor)).toBe(true);expect(f.usAccess).toHaveBeenCalledTimes(2);expect(f.membership).not.toHaveBeenCalled();expect(f.seats).not.toHaveBeenCalled();});
  it('does not fall back to a paid CH plan for an expired new US workspace',async()=>{f.usMarker.mockResolvedValue(true);f.usAccess.mockRejectedValue(new UsAuthorityError('subscription_required',402));expect((await handlers().GET(request('GET',false),org)).status).toBe(402);expect(f.seats).not.toHaveBeenCalled();expect(f.client).not.toHaveBeenCalled();});
  it('denies a US owner operation when the current role is a member',async()=>{f.usMarker.mockResolvedValue(true);f.usAccess.mockResolvedValue({organizationId:org,userId:actor.userId,role:'member'});expect((await handlers().PUT(request('PUT',false),org)).status).toBe(403);expect(f.rpc).not.toHaveBeenCalled();});
  it('fails closed if US marker lookup fails, rather than selecting a Swiss fallback',async()=>{f.usMarker.mockRejectedValue(new UsAuthorityError('service_unavailable',503));expect((await handlers().GET(request('GET',false),org)).status).toBe(503);expect(f.seats).not.toHaveBeenCalled();expect(f.client).not.toHaveBeenCalled();});
  it('uses read-only browser identity checks without automatically claiming offered grants', async () => {
    await binding.user(); expect(f.user).toHaveBeenCalledWith({ offerAccess: false });
  });
  it('passes exact organization and owner permissions to browser membership/seat authority', async () => {
    await binding.membership(actor.userId, org, ['owner']); expect(f.membership).toHaveBeenCalledWith(actor.userId, org, ['owner']);
  });
  it('delegates device session validation, revocation and owner permissions to the existing account authority', async () => {
    const req = request('PUT'); expect(await binding.deviceSession(req, ['owner'])).toEqual(session); expect(f.device).toHaveBeenCalledWith(req, ['owner']);
  });
  it.each([true, false, undefined, 'true'])('requires the real effective Gestion teamSeats flag to be true: %s', async active => {
    f.seats.mockResolvedValue({ subscriptionActive: active }); expect(await binding.management(org)).toBe(active === true); expect(f.seats).toHaveBeenCalledWith(org);
  });
  it.each([['read', 3600], ['write', 120]] as const)('rate limits %s by exact enterprise/user with its own operation scope', async (operation, maximum) => {
    const req = request(); await binding.rateLimit(req, actor, operation);
    expect(f.rate).toHaveBeenCalledWith(req, `international-country-${operation}`, `${org}:${actor.userId}`, maximum);
  });
  it('loads the existing privileged Supabase adapter without exposing it to the client', async () => {
    expect(await binding.store()).toEqual({ select: f.select, rpc: f.rpc }); expect(f.client).toHaveBeenCalledOnce();
  });
  it('runs a native owner request through the actual authority and rate bindings, without any cookie identity', async () => {
    const response = await handlers().PUT(request('PUT'), org); expect(response.status).toBe(200); expect((await response.json() as { configuration: CompanyConfiguration }).configuration.ein).toBeUndefined();
    expect(f.device).toHaveBeenCalledTimes(2); expect(f.user).not.toHaveBeenCalled(); expect(f.membership).not.toHaveBeenCalled(); expect(f.seats).toHaveBeenCalledTimes(2);
    expect(f.rpc).toHaveBeenCalledWith('zentra_put_workspace_country_config', expect.objectContaining({ p_actor: actor.userId, p_organization: org, p_config: expect.objectContaining({ ein: '12-3456789' }) }));
    expect(f.select).toHaveBeenCalledWith('zentra_workspace_country_configs', expect.objectContaining({ organization_id: `eq.${org}`, limit: 1 }));
  });
  it('preserves browser-origin writes with fresh account/membership checks', async () => {
    expect((await handlers().PUT(request('PUT', false), org)).status).toBe(200); expect(f.user).toHaveBeenCalledTimes(2); expect(f.membership).toHaveBeenCalledTimes(2); expect(f.device).not.toHaveBeenCalled();
  });
  it('denies a rejected bearer without cookie fallback through the actual production bindings', async () => {
    f.device.mockRejectedValue(new AccountPublicError('private revoked session', 401));
    const response = await handlers().PUT(request('PUT'), org); expect(response.status).toBe(401); expect(f.user).not.toHaveBeenCalled(); expect(f.membership).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled();
  });
  it.each([true, false])('denies expired effective Gestion access before Supabase (native=%s)', async native => {
    f.seats.mockResolvedValue({ subscriptionActive: false }); expect((await handlers().GET(request('GET', native), org)).status).toBe(402); expect(f.client).not.toHaveBeenCalled();
  });
  it('revalidates device revocation after configuration reads and never commits with stale admission', async () => {
    f.device.mockResolvedValueOnce(session).mockRejectedValue(new AccountPublicError('revoked after read', 401));
    expect((await handlers().PUT(request('PUT'), org)).status).toBe(401); expect(f.select).toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('revalidates browser membership/seat revocation after configuration reads', async () => {
    f.membership.mockResolvedValueOnce({ organizationId: org, role: 'owner' }).mockRejectedValue(new AccountPublicError('seat revoked after read', 403));
    expect((await handlers().PUT(request('PUT', false), org)).status).toBe(403); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('leaves initial US admission closed for unknown/legacy data despite an owner and active access', async () => {
    f.select.mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : []);
    const req = request('PUT'); const response = await handlers().PUT(req, org);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'legacy_review_required' }); expect(f.rpc).not.toHaveBeenCalled();
  });
});
