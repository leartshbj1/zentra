import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsAuthorityError } from './saas-authority';
import { UsDeviceError } from './us-device-contract';
import { UsTeamError, type UsTeamContext, type UsTeamInvitation } from './us-team-contract';

const f = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>, user: vi.fn(), device: vi.fn(), access: vi.fn(),
  prepare: vi.fn(), bind: vi.fn(), first: vi.fn(), batch: vi.fn(), rate: vi.fn(), ch: vi.fn(), rpc: vi.fn(),
  store: { read: vi.fn(), revision: vi.fn(), find: vi.fn(), invitation: vi.fn(), receipt: vi.fn(), commit: vi.fn() },
}));
vi.mock('cloudflare:workers', () => ({ env: f.env }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: f.user }));
vi.mock('./us-device-bindings', () => ({ requireUsDeviceSession: f.device }));
vi.mock('../runtime', () => ({ database: () => ({ prepare: f.prepare, batch: f.batch }) }));
vi.mock('../account', () => ({ enforceAccountRateLimit: f.rate, requireDeviceSession: f.ch, requireBrowserMembership: f.ch }));
vi.mock('../team-seats', () => ({ teamSeats: f.ch }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: f.rpc }) }));
vi.mock('./us-team-store', () => ({ d1UsTeamStore: () => f.store }));
vi.mock('./saas-authority-d1', async importOriginal => ({
  ...await importOriginal<typeof import('./saas-authority-d1')>(),
  d1UsAuthorityStore: () => ({ access: f.access }),
}));
import { usTeamDependencies as binding, usTeamEnabled } from './us-team-bindings';
import { GET as readTeam, POST as writeTeam } from '../../app/api/international/workspaces/[organizationId]/team/route';
import { POST as resolveInvitation } from '../../app/api/international/team-invitations/resolve/route';
import { POST as acceptInvitation } from '../../app/api/international/team-invitations/accept/route';

const org = '11111111-1111-4111-8111-111111111111', owner = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333', invitationId = '44444444-4444-4444-8444-444444444444';
const membershipId = '55555555-5555-4555-8555-555555555555', requestId = '66666666-6666-4666-8666-666666666666';
const stamp = 1_791_500_000, token = 'zui_' + 'A'.repeat(43);
const flagNames = ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_TEAM_ENABLED'];
const offer = { kind: 'saas_subscription', catalogVersion: 'fixture-US-team', country: 'US', currency: 'USD', module: 'gestion', plan: 'fixture-team-plan', priceId: 'price_fixture_US_team', productId: 'prod_fixture_US_team', environment: 'TEST', unitAmountMinor: '1000', interval: 'month', intervalCount: 1, taxBehavior: 'exclusive' };
function source() { return { organization_id: org, owner_user_id: owner, company_name: 'Fictitious TEST Workspace', subscription_id: 'sub_fixture_US_team', environment: 'TEST', catalog_version: offer.catalogVersion, price_id: offer.priceId, seat_limit: 3, starts_at: stamp - 60, ends_at: stamp + 3600, checked_at: stamp }; }
function auth() { return { userId, email: 'RECIPIENT@Example.TEST', emailConfirmed: true, provider: 'supabase', displayName: 'unused account alias' }; }
function invitation(): UsTeamInvitation { return { schemaVersion: 1, organizationId: org, invitationId, email: 'recipient@example.test', role: 'accountant', tokenHash: 'a'.repeat(64), createdBy: owner, createdAt: stamp - 60, expiresAt: stamp + 600, status: 'pending', revokedAt: null, acceptedBy: null, acceptedAt: null, membershipId: null }; }
function projection(context: UsTeamContext) { return { schemaVersion: 1, organizationId: org, revision: 0, role: context.role, seatLimit: 3, activeMembers: 1, reservedInvitations: 0, remainingSeats: 2, checkedAt: stamp, members: [{ membershipId, userId: owner, role: 'owner', displayName: null, joinedAt: stamp - 60 }], invitations: [] }; }
function request(body?: unknown, headers: Record<string, string> = {}) {
  return new Request('https://zentra.example.test/api/international/team', { method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'https://zentra.example.test', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const routeContext = () => ({ params: Promise.resolve({ organizationId: org }) });
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(stamp * 1000);
  for (const key of Object.keys(f.env)) delete f.env[key];
  for (const key of flagNames) f.env[key] = 'true';
  f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT = 'TEST';
  f.env.INTERNATIONAL_US_SAAS_CATALOG_JSON = JSON.stringify([{ offer, seatLimit: 3 }]);
  f.user.mockResolvedValue(auth()); f.first.mockResolvedValue(source());
  f.bind.mockImplementation(() => ({ first: f.first })); f.prepare.mockImplementation(() => ({ bind: f.bind }));
  f.device.mockResolvedValue({ organizationId: org, userId, role: 'admin', subscriptionId: source().subscription_id, sessionId: 'usd_' + membershipId, supportedSchemaVersion: 4 });
  f.access.mockImplementation(async (organizationId: string, actor: string, policy: { catalog: readonly unknown[] }) => {
    if (!policy.catalog.length) throw new UsAuthorityError('invalid_authority', 422);
    return { organizationId, userId: actor, role: actor === owner ? 'owner' : 'admin', subscriptionId: source().subscription_id, seatLimit: 3 };
  });
  f.rate.mockResolvedValue(undefined); f.store.read.mockImplementation(async (c: UsTeamContext) => projection(c));
  f.store.find.mockResolvedValue(invitation()); f.store.revision.mockResolvedValue(0);
  f.store.receipt.mockResolvedValue(null); f.store.invitation.mockResolvedValue(null);
  f.store.commit.mockRejectedValue(new UsTeamError('team_revision_conflict', 409));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Actual US Team bindings/routes with mock Auth, D1, catalog and session ports', () => {
  it.each(flagNames)('keeps every public route closed without %s before Auth or SQL', async missing => {
    delete f.env[missing]; expect(await usTeamEnabled()).toBe(false);
    expect((await readTeam(request(), routeContext())).status).toBe(404);
    expect((await writeTeam(request({}), routeContext())).status).toBe(404);
    expect((await resolveInvitation(request({ schemaVersion: 1, token }))).status).toBe(404);
    expect((await acceptInvitation(request({}))).status).toBe(404);
    expect(f.user).not.toHaveBeenCalled(); expect(f.device).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.store.find).not.toHaveBeenCalled();
  });
  it.each(['false', 'TRUE', '1', 'true '])('requires exact true flags, not %s', async value => {
    f.env.INTERNATIONAL_US_TEAM_ENABLED = value; expect(await usTeamEnabled()).toBe(false); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('uses fresh Supabase Auth with no offered grant and no CH or ERP initialization', async () => {
    const c = await binding.member(request(), org);
    expect(c).toMatchObject({ mode: 'member', role: 'admin', user: { userId, email: 'recipient@example.test', emailConfirmed: true }, credential: { kind: 'browser' } });
    expect(f.user).toHaveBeenCalledWith({ offerAccess: false, refreshSession: true });
    expect(f.access).toHaveBeenCalledWith(org, userId, expect.objectContaining({ environment: 'TEST', catalog: [{ offer, seatLimit: 3 }], now: stamp }), 'gestion');
    expect(f.bind).toHaveBeenCalledWith(org); expect(f.batch).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
    expect(f.prepare.mock.calls.every(([query]) => String(query).includes('international_effective_saas_authorities'))).toBe(true);
  });
  it('takes the renewed effective period for members and matched recipients', async () => {
    const renewed = { ...source(), starts_at: stamp - 30, ends_at: stamp + 86400 };
    f.first.mockResolvedValue(renewed);
    expect(await binding.member(request(), org)).toMatchObject({ validStartsAt: renewed.starts_at, validEndsAt: renewed.ends_at });
    expect(await binding.recipient(request(), invitation())).toMatchObject({ context: { validStartsAt: renewed.starts_at, validEndsAt: renewed.ends_at } });
    expect(f.batch).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
  });
  it('withholds a Team read if its effective period changes while the roster is awaited', async () => {
    f.store.read.mockImplementation(async (c: UsTeamContext) => { f.first.mockResolvedValue({ ...source(), ends_at: stamp + 86400 }); return projection(c); });
    const response = await readTeam(request(), routeContext());
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'configuration_changed' }); expect(f.store.commit).not.toHaveBeenCalled();
  });
  it.each([null, { ...auth(), provider: 'sites' }, { ...auth(), emailConfirmed: false }])('rejects missing, foreign-provider or unconfirmed browser Auth before SQL', async user => {
    f.user.mockResolvedValue(user); await expect(binding.member(request(), org)).rejects.toMatchObject({ status: user?.emailConfirmed === false ? 403 : 401 });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.access).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
  });
  it('rejects wrong expected browser actor before team list or mutations', async () => {
    const response = await readTeam(request(undefined, { 'X-Zentra-Expected-User': owner }), routeContext());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'session_changed' }); expect(f.store.read).not.toHaveBeenCalled(); expect(f.store.commit).not.toHaveBeenCalled();
  });
  it('takes only the separate US bearer reader with nullable e-mail and immutable session cap', async () => {
    const c = await binding.member(request(undefined, { Authorization: 'Bearer zus_fictitious' }), org);
    expect(c).toMatchObject({ mode: 'member', user: { userId, email: null, emailConfirmed: false }, credential: { kind: 'device', sessionId: 'usd_' + membershipId, supportedSchemaVersion: 4 } });
    expect(f.device).toHaveBeenCalledOnce(); expect(f.user).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
  });
  it('a foreign US device scope fails before authority SQL with no cookie or CH fallback', async () => {
    f.device.mockResolvedValue({ organizationId: owner, userId, role: 'owner', subscriptionId: source().subscription_id });
    await expect(binding.member(request(undefined, { Authorization: 'Bearer zus_fictitious' }), org)).rejects.toMatchObject({ code: 'tenant_mismatch', status: 403 });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.access).not.toHaveBeenCalled(); expect(f.user).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
  });
  it.each([401, 403])('does not recover rejected bearer %s from browser or CHF', async status => {
    f.device.mockRejectedValue(new UsDeviceError('arbitrary private message', status));
    await expect(binding.member(request(undefined, { Authorization: 'Bearer invalid' }), org)).rejects.toMatchObject({ status, code: status === 401 ? 'unauthorized' : 'forbidden' });
    expect(f.user).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
  });
  it('refuses stale device roles and subscription identities after current US access', async () => {
    for (const patch of [{ role: 'read_only' }, { subscriptionId: 'sub_another' }]) {
      f.access.mockResolvedValue({ organizationId: org, userId, role: 'admin', subscriptionId: source().subscription_id, seatLimit: 3, ...patch });
      await expect(binding.member(request(undefined, { Authorization: 'Bearer zus_fictitious' }), org)).rejects.toMatchObject({ status: patch.subscriptionId ? 409 : 403 });
    }
    expect(f.user).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, 5, '4'])('rejects malformed captured device capability %s', async supportedSchemaVersion => {
    f.device.mockResolvedValue({ organizationId: org, userId, role: 'admin', subscriptionId: source().subscription_id, sessionId: 'usd_' + membershipId, supportedSchemaVersion });
    await expect(binding.member(request(undefined, { Authorization: 'Bearer zus_fictitious' }), org)).rejects.toMatchObject({ code: 'invalid_team_context', status: 503 });
  });
  it('recipient direct access requires verified equal e-mail before any organization read', async () => {
    f.user.mockResolvedValue({ ...auth(), email: 'foreign@example.test' });
    await expect(binding.recipient(request(), invitation())).rejects.toMatchObject({ code: 'invitation_recipient_mismatch', status: 403 });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.access).not.toHaveBeenCalled();
  });
  it.each([false, true])('recipient rejects Authorization before Auth or SQL (accepted=%s)', async accepted => {
    const inv = accepted ? { ...invitation(), status: 'accepted' as const, acceptedBy: userId, acceptedAt: stamp, membershipId } : invitation();
    await expect(binding.recipient(request({}, { Authorization: 'Bearer zus_fictitious' }), inv)).rejects.toMatchObject({ status: 401 });
    await expect(binding.recipientUser(request({}, { Authorization: 'Bearer zus_fictitious' }))).rejects.toMatchObject({ status: 401 });
    expect(f.user).not.toHaveBeenCalled(); expect(f.device).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('matched recipient uses existing owner authority and invitation role without guessing a membership or name', async () => {
    const result = await binding.recipient(request(), invitation());
    expect(result).toMatchObject({ organizationName: source().company_name, context: { mode: 'recipient', role: 'accountant', user: { userId, email: 'recipient@example.test', emailConfirmed: true }, credential: { kind: 'browser' } } });
    expect(f.access).toHaveBeenCalledWith(org, owner, expect.any(Object), 'gestion'); expect(f.batch).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled();
  });
  it.each([{ status: 'revoked' as const, revokedAt: stamp }, { status: 'accepted' as const, acceptedBy: owner, acceptedAt: stamp, membershipId }])('rejects unavailable recipient history before company read', async patch => {
    await expect(binding.recipient(request(), { ...invitation(), ...patch })).rejects.toMatchObject({ code: 'invitation_unavailable', status: 409 }); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('same recipient can obtain historic acceptance context but receives no team list from the binding', async () => {
    expect(await binding.recipient(request(), { ...invitation(), status: 'accepted', acceptedBy: userId, acceptedAt: stamp, membershipId })).toMatchObject({ context: { mode: 'recipient' } });
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.store.commit).not.toHaveBeenCalled();
  });
  it('empty current catalog is forwarded to US authority and fails without any CHF grant', async () => {
    f.env.INTERNATIONAL_US_SAAS_CATALOG_JSON = '[]';
    await expect(binding.member(request(), org)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(f.access).toHaveBeenCalledWith(org, userId, expect.objectContaining({ catalog: [] }), 'gestion'); expect(f.ch).not.toHaveBeenCalled();
  });
  it.each(['CHF', '', undefined])('rejects unknown billing environment %s before authority', async environment => {
    f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT = environment;
    await expect(binding.member(request(), org)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 }); expect(f.access).not.toHaveBeenCalled();
  });
  it.each([{ country: 'CH', currency: 'CHF' }, { environment: 'PRODUCTION' }, { seatLimit: 0 }])('does not approve malformed or foreign current offer %j', async patch => {
    f.env.INTERNATIONAL_US_SAAS_CATALOG_JSON = JSON.stringify([{ offer: { ...offer, ...(patch.seatLimit === undefined ? patch : {}) }, seatLimit: patch.seatLimit ?? 3 }]);
    await expect(binding.member(request(), org)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 }); expect(f.access).not.toHaveBeenCalled();
  });
  it.each([402, 403, 503])('normalizes unavailable current US rights %s and never copies an old CH license', async status => {
    f.access.mockRejectedValue(new UsAuthorityError(status === 402 ? 'subscription_required' : status === 403 ? 'forbidden' : 'service_unavailable', status));
    await expect(binding.member(request(), org)).rejects.toMatchObject({ status, code: status === 402 ? 'subscription_required' : status === 403 ? 'forbidden' : 'service_unavailable' }); expect(f.ch).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
  });
  it('does not grant manager mutation to accountant/member/read_only from a client role', async () => {
    for (const role of ['accountant', 'member', 'read_only']) {
      f.access.mockResolvedValue({ organizationId: org, userId, role, subscriptionId: source().subscription_id, seatLimit: 3 });
      const response = await writeTeam(request({ schemaVersion: 1, requestId, expectedTeamRevision: 0, action: 'create_invitation', email: 'member@example.test', role: 'member' }), routeContext());
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'team_management_required' });
    }
    expect(f.store.commit).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
  });
  it('admin cannot create another manager even when client claims approved seats', async () => {
    const response = await writeTeam(request({ schemaVersion: 1, requestId, expectedTeamRevision: 0, action: 'create_invitation', email: 'member@example.test', role: 'accountant' }), routeContext());
    expect(response.status).toBe(403); expect(f.store.commit).not.toHaveBeenCalled();
  });
  it('does not expose roster after Auth changes while the private team read waits', async () => {
    f.store.read.mockImplementation(async (c: UsTeamContext) => { f.user.mockResolvedValue({ ...auth(), userId: owner }); return projection(c); });
    const response = await readTeam(request(), routeContext()); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'session_changed' }); expect(f.store.commit).not.toHaveBeenCalled();
  });
  it('a flag closing while team data awaits withholds the public projection', async () => {
    f.store.read.mockImplementation(async (c: UsTeamContext) => { f.env.INTERNATIONAL_US_TEAM_ENABLED = 'false'; return projection(c); });
    const response = await readTeam(request(), routeContext()); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'feature_unavailable' });
  });
  it('Auth refusal outranks a delayed flag close and private storage failure', async () => {
    f.store.read.mockImplementation(async () => { f.user.mockResolvedValue(null); f.env.INTERNATIONAL_US_TEAM_ENABLED = 'false'; throw new Error('private row secret@example.test'); });
    const response = await readTeam(request(), routeContext()); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
  it('revalidates initial recipient identity when token lookup fails after logout', async () => {
    f.store.find.mockImplementation(async () => { f.user.mockResolvedValue(null); throw new Error('private row secret@example.test'); });
    const response = await resolveInvitation(request({ schemaVersion: 1, token }));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' }); expect(f.store.commit).not.toHaveBeenCalled();
  });
  it('revalidates browser identity after a source-query failure before member admission returns', async () => {
    f.first.mockImplementation(async () => { f.user.mockResolvedValue(null); throw new Error('private authority row'); });
    const response = await readTeam(request(), routeContext());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' }); expect(f.store.read).not.toHaveBeenCalled();
  });
  it('revalidates US bearer after source-query failure without consulting browser cookies', async () => {
    f.first.mockImplementation(async () => { f.device.mockRejectedValue(new UsDeviceError('revoked device', 401)); throw new Error('private authority row'); });
    const response = await readTeam(request(undefined, { Authorization: 'Bearer zus_fictitious' }), routeContext());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' }); expect(f.user).not.toHaveBeenCalled(); expect(f.ch).not.toHaveBeenCalled(); expect(f.store.read).not.toHaveBeenCalled();
  });
  it('forged SDK/DB message remains generic in public response and bounded diagnostics', async () => {
    f.access.mockRejectedValue(new Error('DB SECRET SECRET secret@example.test')); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await readTeam(request(), routeContext()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(warning.mock.calls).toEqual([['zentra.international.us-team', { operation: 'read', code: 'service_unavailable', status: 503 }]]);
  });
});
