import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '@/lib/account-security';
import { SupabaseServerError } from '@/lib/supabase-server';
import { createWorkspaceCountryHandlers, internationalCoreEnabled } from './workspace-server';
import type { WorkspaceCountryStore } from './workspace-service';

const configuration = {
  schemaVersion: 1, organizationId: 'org-a', country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich',
  address: { country: 'CH', line1: '10 Rue Exemple', postalCode: '1201', city: 'Genève', subdivision: 'GE' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' },
};
const body = { expectedRevision: 0, requestId: '10000000-0000-4000-8000-000000000001', configuration };
const url = 'https://zentraapp.ch/api/international/workspaces/org-a/country';
function request(value: unknown = body, extraHeaders: Record<string, string> = {}) {
  return new Request(url, { method: 'PUT', headers: { Origin: 'https://zentraapp.ch', 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(value) });
}
function setup() {
  const select = vi.fn().mockImplementation(async (table: string) => table === 'zentra_workspaces' ? [{ organization_id: 'org-a' }] : []);
  const rpc = vi.fn().mockResolvedValue({ organizationId: 'org-a', revision: 1, configuration, updatedBy: 'owner-a', updatedAt: '2026-10-07T12:00:00Z', replayed: false });
  const dependencies = {
    enabled: vi.fn().mockReturnValue(true), user: vi.fn().mockResolvedValue({ userId: 'owner-a' }),
    membership: vi.fn().mockResolvedValue({ organizationId: 'org-a', role: 'owner' }),
    deviceSession: vi.fn(), management: vi.fn().mockResolvedValue(true), rateLimit: vi.fn().mockResolvedValue(undefined), requireInitialUsAdmission: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockReturnValue({ select, rpc } as unknown as WorkspaceCountryStore),
  };
  return { ...dependencies, select, rpc, handlers: createWorkspaceCountryHandlers(dependencies) };
}

describe('international country HTTP boundary', () => {
  it('defaults to disabled when the Cloudflare flag binding is unavailable', async () => {
    expect(await internationalCoreEnabled()).toBe(false);
  });
  it('does not evaluate auth or open storage while the feature is disabled', async () => {
    const s = setup(); s.enabled.mockReturnValue(false);
    expect((await s.handlers.GET(new Request(url), 'org-a')).status).toBe(404);
    expect((await s.handlers.PUT(request(), 'org-a')).status).toBe(404);
    expect(s.user).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it('rejects an unauthenticated request before the privileged store', async () => {
    const s = setup(); s.user.mockResolvedValue(null);
    const response = await s.handlers.GET(new Request(url), 'org-a');
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(s.membership).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it('rejects a cross-tenant path through the current D1 authority', async () => {
    const s = setup(); s.membership.mockRejectedValue(new AccountPublicError('Sensitive org details', 403));
    const response = await s.handlers.PUT(request(), 'org-b');
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(s.membership).toHaveBeenCalledWith('owner-a', 'org-b', ['owner']); expect(s.store).not.toHaveBeenCalled();
  });
  it('refuses a D1 membership result for a different organization', async () => {
    const s = setup(); s.membership.mockResolvedValue({ organizationId: 'org-b', role: 'owner' });
    expect((await s.handlers.GET(new Request(url), 'org-a')).status).toBe(403); expect(s.store).not.toHaveBeenCalled();
  });
  it('requests owner authority and refuses an admin despite an inconsistent adapter', async () => {
    const s = setup(); s.membership.mockResolvedValue({ organizationId: 'org-a', role: 'admin' });
    expect((await s.handlers.PUT(request(), 'org-a')).status).toBe(403); expect(s.store).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.test', 'null'])('rejects origin %s before auth/storage', async Origin => {
    const s = setup(); expect((await s.handlers.PUT(request(body, { Origin }), 'org-a')).status).toBe(403);
    expect(s.user).not.toHaveBeenCalled(); expect(s.store).not.toHaveBeenCalled();
  });
  it('rejects missing origin and cross-site fetch metadata', async () => {
    const s = setup(); const req = request(); req.headers.delete('Origin');
    expect((await s.handlers.PUT(req, 'org-a')).status).toBe(403);
    expect((await s.handlers.PUT(request(body, { 'Sec-Fetch-Site': 'cross-site' }), 'org-a')).status).toBe(403);
    expect(s.store).not.toHaveBeenCalled();
  });
  it.each([{ role: 'owner' }, { entitlements: { paid: true } }, { userId: 'attacker' }])('refuses client authority fields before storage', async extra => {
    const s = setup(); expect((await s.handlers.PUT(request({ ...body, ...extra }), 'org-a')).status).toBe(422);
    expect(s.store).not.toHaveBeenCalled();
  });
  it('refuses a body pointing to another company before storage', async () => {
    const s = setup(); expect((await s.handlers.PUT(request({ ...body, configuration: { ...configuration, organizationId: 'org-b' } }), 'org-a')).status).toBe(403);
    expect(s.store).not.toHaveBeenCalled();
  });
  it('bounds and validates JSON bodies before storage', async () => {
    const s = setup(); expect((await s.handlers.PUT(request({ ...body, padding: 'x'.repeat(17_000) }), 'org-a')).status).toBe(413);
    expect((await s.handlers.PUT(request(body, { 'Content-Type': 'text/plain' }), 'org-a')).status).toBe(415);
    expect(s.store).not.toHaveBeenCalled();
  });
  it('returns an unknown legacy jurisdiction with private, uncacheable headers', async () => {
    const s = setup(); const response = await s.handlers.GET(new Request(url), 'org-a');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'unconfigured', country: 'unknown', requiresAdministrativeReview: true });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(s.membership).toHaveBeenCalledWith('owner-a', 'org-a', undefined);
  });
  it('returns a conflict instead of replacing a newer revision', async () => {
    const s = setup(); s.rpc.mockRejectedValue(new SupabaseServerError(400, 'PZ001'));
    const response = await s.handlers.PUT(request(), 'org-a');
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'revision_conflict' });
  });
  it('confirms an exact retry through the same authenticated request', async () => {
    const s = setup(); s.rpc.mockResolvedValue({ organizationId: 'org-a', revision: 1, configuration, updatedBy: 'owner-a', updatedAt: '2026-10-07T12:00:00Z', replayed: true });
    const response = await s.handlers.PUT(request(), 'org-a');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replayed: true, revision: 1 });
    expect(s.rpc.mock.calls[0][1].p_actor).toBe('owner-a');
  });
  it('redacts upstream database/auth errors and submitted information', async () => {
    const s = setup(); s.rpc.mockRejectedValue(new Error('secret postgres url and private address'));
    const response = await s.handlers.PUT(request(), 'org-a');
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
});
