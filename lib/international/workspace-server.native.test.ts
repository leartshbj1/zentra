import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { createWorkspaceCountryHandlers, workspaceCountryDependencies, type WorkspaceCountryDependencies } from './workspace-server';
import type { CompanyConfiguration } from './types';
import type { WorkspaceCountryStore } from './workspace-service';

const org = 'fictitious-country-native';
const url = `https://zentraapp.ch/api/international/workspaces/${org}/country`;
const configuration: CompanyConfiguration = {
  schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
  address: { country: 'US', line1: '100 Fictitious Avenue', postalCode: '10001', city: 'New York', subdivision: 'NY' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, ein: '12-3456789',
};
const body = { expectedRevision: 4, requestId: '10000000-0000-4000-8000-000000000009', configuration };
const device = { organizationId: org, userId: 'owner-native', role: 'owner' as const, sessionId: 'session-a', installationId: 'installation-a', subscriptionId: 'subscription-a' };
const request = (method: 'GET' | 'PUT' = 'GET', native = true, value: unknown = body) => new Request(url, {
  method, headers: { ...(native ? { Authorization: 'Bearer zds_fictitious' } : { Origin: 'https://zentraapp.ch' }), ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) },
  ...(method === 'PUT' ? { body: JSON.stringify(value) } : {}),
});
const row = (config = configuration, revision = 4) => ({ organization_id: org, schema_version: 1, config, country: config.country, currency: config.currency, revision, updated_by: device.userId, updated_at: '2026-10-08T12:00:00Z' });
function setup() {
  const select = vi.fn().mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : [row()]);
  const rpc = vi.fn().mockResolvedValue({ organizationId: org, revision: 5, configuration, updatedBy: device.userId, updatedAt: '2026-10-08T12:00:00Z', replayed: false });
  const ports = {
    enabled: vi.fn().mockResolvedValue(true), user: vi.fn().mockResolvedValue({ userId: device.userId }),
    membership: vi.fn().mockResolvedValue({ organizationId: org, role: 'owner' }), deviceSession: vi.fn().mockResolvedValue(device),
    management: vi.fn().mockResolvedValue(true), rateLimit: vi.fn().mockResolvedValue(undefined),
    requireInitialUsAdmission: vi.fn().mockResolvedValue(undefined), store: vi.fn().mockReturnValue({ select, rpc } as unknown as WorkspaceCountryStore),
  } satisfies WorkspaceCountryDependencies;
  return { ...ports, select, rpc, handlers: createWorkspaceCountryHandlers(ports) };
}

describe('native country transport and fresh authorization', () => {
  it('keeps the disabled flag ahead of both native auth and privileged persistence', async () => {
    const s = setup(); s.enabled.mockResolvedValue(false);
    expect((await s.handlers.GET(request(), org)).status).toBe(404);
    expect((await s.handlers.PUT(request('PUT'), org)).status).toBe(404);
    expect(s.deviceSession).not.toHaveBeenCalled(); expect(s.user).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it('reads exact native scope without cookies and revalidates before exposing a private response', async () => {
    const s = setup(); const response = await s.handlers.GET(request(), org);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ organizationId: org, revision: 4, configuration: { country: 'US', currency: 'USD' } });
    expect(s.deviceSession).toHaveBeenCalledTimes(2); expect(s.user).not.toHaveBeenCalled(); expect(s.membership).not.toHaveBeenCalled();
    expect(s.management).toHaveBeenNthCalledWith(1, org); expect(s.management).toHaveBeenNthCalledWith(2, org);
    expect(s.rateLimit).toHaveBeenCalledWith(expect.any(Request), { organizationId: org, userId: device.userId, role: 'owner' }, 'read');
    expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
  it('accepts an owner device write without a browser Origin and protects the stored EIN', async () => {
    const s = setup(); const response = await s.handlers.PUT(request('PUT'), org);
    expect(response.status).toBe(200); const result = await response.json() as { configuration: CompanyConfiguration }; expect(result.configuration.ein).toBeUndefined();
    expect(s.rpc).toHaveBeenCalledWith('zentra_put_workspace_country_config', expect.objectContaining({ p_organization: org, p_actor: device.userId, p_config: expect.objectContaining({ ein: '12-3456789' }) }));
    expect(s.deviceSession).toHaveBeenNthCalledWith(1, expect.any(Request), ['owner']); expect(s.deviceSession).toHaveBeenNthCalledWith(2, expect.any(Request), ['owner']);
    expect(s.requireInitialUsAdmission).not.toHaveBeenCalled(); expect(s.user).not.toHaveBeenCalled();
  });
  it.each(['Basic invalid', '', 'Bearer invalid', 'Bearer zds_revoked'])('does not fall back to cookies for rejected native credentials: %s', async header => {
    const s = setup(); s.deviceSession.mockRejectedValue(new AccountPublicError('Secret token details', 401));
    const req = request('PUT'); req.headers.set('Authorization', header); const response = await s.handlers.PUT(req, org);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(s.user).not.toHaveBeenCalled(); expect(s.membership).not.toHaveBeenCalled(); expect(s.management).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it('rejects a foreign device scope before loading access rights or country data', async () => {
    const s = setup(); s.deviceSession.mockResolvedValue({ ...device, organizationId: 'foreign-org' });
    expect((await s.handlers.GET(request(), org)).status).toBe(403); expect(s.management).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it.each(['admin', 'accountant', 'member', 'read_only'])('denies native PUT to role %s even if an adapter returns it', async role => {
    const s = setup(); s.deviceSession.mockResolvedValue({ ...device, role });
    expect((await s.handlers.PUT(request('PUT'), org)).status).toBe(403); expect(s.store).not.toHaveBeenCalled(); expect(s.rpc).not.toHaveBeenCalled();
  });
  it.each(['owner', 'admin', 'accountant', 'member', 'read_only'])('allows an active scoped %s to read only the public configuration', async role => {
    const s = setup(); s.deviceSession.mockResolvedValue({ ...device, role });
    const response = await s.handlers.GET(request(), org); expect(response.status).toBe(200);
    expect((await response.json() as { configuration: CompanyConfiguration }).configuration.ein).toBeUndefined(); expect(s.rpc).not.toHaveBeenCalled();
  });
  it.each([true, false])('requires effective Gestion access, rather than just a seat (native=%s)', async native => {
    const s = setup(); s.management.mockResolvedValue(false);
    const response = await s.handlers.PUT(request('PUT', native), org); expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: 'management_entitlement_required' }); expect(s.store).not.toHaveBeenCalled();
  });
  it('rate limits every read/write operation before opening the Supabase store', async () => {
    const s = setup(); s.rateLimit.mockRejectedValue(new AccountPublicError('Rate limit details', 429));
    const get = await s.handlers.GET(request(), org); const put = await s.handlers.PUT(request('PUT'), org);
    expect(get.status).toBe(429); expect(put.status).toBe(429); expect(await put.json()).toEqual({ error: 'rate_limited' });
    expect(s.rateLimit.mock.calls.map(call => call[2])).toEqual(['read', 'write']); expect(s.store).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.test', 'null', ''])('keeps browser CSRF protection with origin %s', async origin => {
    const s = setup(); const req = request('PUT', false); if (origin) req.headers.set('Origin', origin); else req.headers.delete('Origin');
    expect((await s.handlers.PUT(req, org)).status).toBe(403); expect(s.user).not.toHaveBeenCalled(); expect(s.deviceSession).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it('does not use a valid cookie to compensate for a rejected bearer on a browser-origin request', async () => {
    const s = setup(); s.deviceSession.mockRejectedValue(new AccountPublicError('revoked', 401)); const req = request('PUT', false); req.headers.set('Authorization', 'Bearer invalid');
    expect((await s.handlers.PUT(req, org)).status).toBe(401); expect(s.user).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it.each(['sessionId', 'installationId', 'subscriptionId', 'userId'])('rejects device identity replacement after awaited reads: %s', async field => {
    const s = setup(); s.deviceSession.mockResolvedValueOnce(device).mockResolvedValue({ ...device, [field]: 'replacement' });
    const response = await s.handlers.PUT(request('PUT'), org); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'session_changed' }); expect(s.rpc).not.toHaveBeenCalled();
  });
  it('rejects an expired/revoked device before returning data read during the request', async () => {
    const s = setup(); s.deviceSession.mockResolvedValueOnce(device).mockRejectedValue(new AccountPublicError('revoked during read', 401));
    const response = await s.handlers.GET(request(), org); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' }); expect(s.select).toHaveBeenCalled();
  });
  it.each([true, false])('rechecks revoked membership/seat after storage waits (native=%s)', async native => {
    const s = setup(); const port = native ? s.deviceSession : s.membership;
    port.mockReset();
    port.mockResolvedValueOnce(native ? device : { organizationId: org, role: 'owner' }).mockRejectedValue(new AccountPublicError('seat or membership revoked', 403));
    expect((await s.handlers.PUT(request('PUT', native), org)).status).toBe(403); expect(s.select).toHaveBeenCalled(); expect(s.rpc).not.toHaveBeenCalled();
  });
  it.each([true, false])('rechecks expired Gestion access after storage waits (native=%s)', async native => {
    const s = setup(); s.management.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await s.handlers.PUT(request('PUT', native), org)).status).toBe(402); expect(s.rpc).not.toHaveBeenCalled();
  });
  it('rejects browser identity changes before the country write', async () => {
    const s = setup(); s.user.mockResolvedValueOnce({ userId: device.userId }).mockResolvedValue({ userId: 'other-owner' });
    expect((await s.handlers.PUT(request('PUT', false), org)).status).toBe(401); expect(s.rpc).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT'] as const)('rejects a role change across waits on %s', async method => {
    const s = setup(); s.deviceSession.mockResolvedValueOnce(device).mockResolvedValue({ ...device, role: 'read_only' });
    expect((await s.handlers[method](request(method), org)).status).toBe(403); expect(s.rpc).not.toHaveBeenCalled();
  });
  it('detects a configuration edit while waiting, without overwriting a newer revision', async () => {
    const s = setup(); let reads = 0;
    s.select.mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : [row(configuration, ++reads === 1 ? 4 : 5)]);
    const response = await s.handlers.PUT(request('PUT'), org); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'configuration_changed' }); expect(s.rpc).not.toHaveBeenCalled();
  });
  it('keeps an exact durable idempotent replay valid after a newer configuration was already committed', async () => {
    const s = setup(); s.select.mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : [row(configuration, 8)]);
    s.rpc.mockResolvedValue({ organizationId: org, revision: 5, configuration, updatedBy: device.userId, updatedAt: '2026-10-08T12:00:00Z', replayed: true });
    const response = await s.handlers.PUT(request('PUT'), org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ revision: 5, replayed: true });
  });
  it('checks the flag again after awaited work and does not write when it was disabled', async () => {
    const s = setup(); s.enabled.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await s.handlers.PUT(request('PUT'), org)).status).toBe(404); expect(s.rpc).not.toHaveBeenCalled();
  });
  it('cannot trust a client claim of initial US admission', async () => {
    const s = setup(); expect((await s.handlers.PUT(request('PUT', true, { ...body, initialUsAdmitted: true }), org)).status).toBe(422); expect(s.store).not.toHaveBeenCalled();
  });
});

describe('first US configuration admission remains closed in production', () => {
  it('does not treat an unknown legacy country as a new US workspace', async () => {
    const s = setup(); s.requireInitialUsAdmission.mockImplementation((actor, config, state) => workspaceCountryDependencies.requireInitialUsAdmission(actor, config, state));
    s.select.mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : []);
    const response = await s.handlers.PUT(request('PUT', true, { ...body, expectedRevision: 0 }), org);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'legacy_review_required' }); expect(s.rpc).not.toHaveBeenCalled();
  });
  it('allows only an injected server attestation in a fictitious local test', async () => {
    const s = setup(); s.select.mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : []);
    s.rpc.mockResolvedValue({ organizationId: org, revision: 1, configuration, updatedBy: device.userId, updatedAt: '2026-10-08T12:00:00Z', replayed: false });
    const response = await s.handlers.PUT(request('PUT', true, { ...body, expectedRevision: 0 }), org); expect(response.status).toBe(200);
    expect(s.requireInitialUsAdmission).toHaveBeenCalledWith({ organizationId: org, userId: device.userId, role: 'owner' }, configuration, expect.objectContaining({ status: 'unconfigured', country: 'unknown', requiresAdministrativeReview: true }));
  });
  it('rejects a configuration created while the server attestation was awaited', async () => {
    const s = setup(); let admitted = false;
    s.select.mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: org }] : admitted ? [row(configuration, 1)] : []);
    s.requireInitialUsAdmission.mockImplementation(async () => { admitted = true; });
    const response = await s.handlers.PUT(request('PUT', true, { ...body, expectedRevision: 0 }), org); expect(response.status).toBe(409); expect(s.rpc).not.toHaveBeenCalled();
  });
});
