import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ env: {} as Record<string, string>, database: null as unknown as D1Database, user: vi.fn(), select: vi.fn(), rate: vi.fn(), legacyDevice: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: runtime.env }));
vi.mock('../runtime', () => ({ database: () => runtime.database }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ select: runtime.select }) }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: runtime.user }));
vi.mock('../account', () => ({ enforceAccountRateLimit: runtime.rate, requireDeviceSession: runtime.legacyDevice }));

import { lifecycleFixture } from './us-saas-test-lifecycle-test-fixture';
import { verifiedUsTestLifecycleObservation } from './us-saas-test-lifecycle-contract';
import { usDeviceHandlers, requireUsDeviceSession } from './us-device-bindings';
import { US_DEVICE_PROTOCOL, hashUsDeviceSecret, type UsDeviceSession } from './us-device-contract';
import { usTeamDependencies } from './us-team-bindings';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';

type Fixture = Awaited<ReturnType<typeof lifecycleFixture>>;
const fixtures: Fixture[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(runtime.env)) delete runtime.env[key];
  runtime.rate.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) fixture.sql.close(); });

async function fixture() {
  const value = await lifecycleFixture(); fixtures.push(value); runtime.database = value.database;
  Object.assign(runtime.env, { INTERNATIONAL_CORE_ENABLED: 'true', INTERNATIONAL_US_ERP_ENABLED: 'true', INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED: 'true', INTERNATIONAL_US_PURCHASING_V2_ENABLED: 'true', INTERNATIONAL_US_PROJECTS_V3_ENABLED: 'true', INTERNATIONAL_US_ACCOUNTING_V4_ENABLED: 'true', INTERNATIONAL_US_TEAM_ENABLED: 'true', INTERNATIONAL_US_BILLING_ENVIRONMENT: 'TEST', INTERNATIONAL_US_SAAS_CATALOG_JSON: JSON.stringify(value.policy.catalog) });
  runtime.user.mockResolvedValue({ provider: 'supabase', userId: value.intent.actorUserId, email: 'owner@example.test', emailConfirmed: true });
  runtime.select.mockImplementation(async (table: string, query: Record<string, unknown>) => {
    if (query.organization_id !== 'eq.' + value.intent.organizationId) throw new Error('Unexpected TEST organization');
    if (table === 'zentra_workspaces') return [{ organization_id: value.intent.organizationId }];
    if (table === 'zentra_workspace_country_configs') return [{ organization_id: value.intent.organizationId, schema_version: 1, config: value.intent.configuration, country: 'US', currency: 'USD', revision: 1, updated_by: value.intent.actorUserId, updated_at: value.intent.createdAt }];
    throw new Error('Unexpected private TEST read');
  });
  vi.spyOn(Date, 'now').mockImplementation(() => value.now() * 1000);
  return value;
}
function request(path: string, body?: unknown, token?: string) {
  return new Request('https://zentraapp.ch/api/international/device/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(path === 'approve' ? { Origin: 'https://zentraapp.ch' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function approved(f: Fixture, schema: ErpSchemaVersion) {
  const installationId = randomUUID(), sessionToken = 'zus_' + randomBytes(32).toString('base64url'), sessionTokenHash = await hashUsDeviceSecret('session', sessionToken);
  const response = await usDeviceHandlers.START(request('start', { protocol: US_DEVICE_PROTOCOL, installationId, sessionTokenHash, supportedSchemaVersion: schema }));
  expect(response.status).toBe(201);
  const challenge = await response.json() as { userCode: string; deviceCode: string };
  expect((await usDeviceHandlers.APPROVE(request('approve', { protocol: US_DEVICE_PROTOCOL, userCode: challenge.userCode, organizationId: f.intent.organizationId }))).status).toBe(200);
  const exchange = () => usDeviceHandlers.EXCHANGE(request('exchange', { protocol: US_DEVICE_PROTOCOL, deviceCode: challenge.deviceCode, installationId, sessionToken }));
  return { challenge, exchange, sessionToken, me: () => request('me', undefined, sessionToken) };
}
const browser = () => new Request('https://zentraapp.ch/api/international/workspaces/team');
const teamContext = (f: Fixture) => usTeamDependencies.member(browser(), f.intent.organizationId);
function renewal(f: Fixture) {
  const invoiceId = 'in_ConsumerRenewal';
  return f.paid({ invoiceId, sourceId: invoiceId, authority: { ...f.authority, evidence: { ...f.authority.evidence!, referenceId: invoiceId, startsAt: f.now(), endsAt: f.authority.evidence!.endsAt + 3600 } } });
}
async function commit(team: ReturnType<typeof d1UsTeamStore>, context: UsTeamContext, command: UsTeamPrivateCommand) {
  return team.commit({ context, command, requestHash: await hashUsTeamCommand(context.organizationId, context.user.userId, command) });
}
function sessions(f: Fixture) {
  return { legacy: f.sql.prepare('SELECT * FROM international_us_device_sessions').all(), v4: f.sql.prepare('SELECT * FROM international_us_device_v4_sessions').all() };
}

describe('real 0000..0092 paid renewal through Team and native bindings', () => {
  it.each([1, 2, 3, 4] as const)('keeps capability %s bounds and exact replay immutable, then requires new pairing at its own expiry', async schema => {
    const f = await fixture(), pairing = await approved(f, schema), response = await pairing.exchange(); expect(response.status).toBe(200);
    const captured = await response.json() as UsDeviceSession, before = sessions(f), base = f.sql.prepare('SELECT * FROM international_saas_authorities').all();
    const observation = renewal(f); expect(await f.store.apply(f.binding, observation, async () => {})).toBe('paid_period');
    expect(observation.authority!.evidence!.endsAt).toBeGreaterThan(captured.entitlementValidUntil);
    expect(await requireUsDeviceSession(pairing.me())).toEqual(captured);
    expect(await (await pairing.exchange()).json()).toEqual(captured);
    expect(sessions(f)).toEqual(before); expect(f.sql.prepare('SELECT * FROM international_saas_authorities').all()).toEqual(base);
    const renewedTeam = await teamContext(f); expect(renewedTeam.validEndsAt).toBe(observation.authority!.evidence!.endsAt);
    f.setNow(captured.expiresAt);
    await expect(requireUsDeviceSession(pairing.me())).rejects.toMatchObject({ status: 401 });
    expect((await pairing.exchange()).status).toBe(401);
    expect((await d1UsTeamStore(f.database, { now: f.now }).read(await teamContext(f))).activeMembers).toBe(1);
    const replacement = await approved(f, schema), next = await replacement.exchange(); expect(next.status).toBe(200);
    const metadata = await next.json() as UsDeviceSession;
    expect(metadata.entitlementValidUntil).toBe(observation.authority!.evidence!.endsAt); expect(metadata.expiresAt).toBeGreaterThan(captured.expiresAt);
    expect(runtime.legacyDevice).not.toHaveBeenCalled(); expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([3, 4] as const)('consumes an approved capability %s challenge across renewal without upgrading its captured end', async schema => {
    const f = await fixture(), pairing = await approved(f, schema), source = schema === 4 ? 'international_us_device_v4_challenges' : 'international_us_device_challenges';
    const original = f.sql.prepare(`SELECT entitlement_valid_until FROM ${source} WHERE user_code=?`).get(pairing.challenge.userCode)!;
    await f.store.apply(f.binding, renewal(f), async () => {});
    const response = await pairing.exchange(); expect(response.status).toBe(200);
    expect((await response.json() as UsDeviceSession).entitlementValidUntil).toBe(original.entitlement_valid_until);
    expect(f.sql.prepare(`SELECT entitlement_valid_until FROM ${source} WHERE user_code=?`).get(pairing.challenge.userCode)).toEqual(original);
  });

  it.each([3, 4] as const)('does not consume an approved capability %s challenge after its captured entitlement expires', async schema => {
    const f = await fixture(), pairing = await approved(f, schema);
    await f.store.apply(f.binding, renewal(f), async () => {}); f.setNow(f.authority.evidence!.endsAt);
    expect((await pairing.exchange()).status).toBe(410);
    expect((await usDeviceHandlers.APPROVE(request('approve', { protocol: US_DEVICE_PROTOCOL, userCode: pairing.challenge.userCode, organizationId: f.intent.organizationId }))).status).toBe(410);
    expect(sessions(f)).toEqual({ legacy: [], v4: [] });
  });

  it('rejects stale Team context, preserves exact invitation replay and admits a fresh command using the renewed period', async () => {
    const f = await fixture(), team = d1UsTeamStore(f.database, { now: f.now }), captured = await teamContext(f);
    const command: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: 0, action: 'create_invitation', email: 'recipient@example.test', role: 'member', invitationId: randomUUID(), tokenHash: await hashUsTeamToken(newUsTeamToken()), expiresAt: f.now() + 604800 };
    const initial = await commit(team, captured, command); expect(initial.firstApplied).toBe(true);
    await f.store.apply(f.binding, renewal(f), async () => {});
    await expect(team.read(captured)).rejects.toMatchObject({ code: 'configuration_changed', status: 409 });
    const renewed = await teamContext(f), replay = await commit(team, renewed, command);
    expect(replay).toEqual({ receipt: initial.receipt, replayed: true, firstApplied: false });
    const next: UsTeamPrivateCommand = { ...command, requestId: randomUUID(), expectedTeamRevision: 1, invitationId: randomUUID(), email: 'another@example.test', tokenHash: await hashUsTeamToken(newUsTeamToken()) };
    expect((await commit(team, renewed, next)).firstApplied).toBe(true);
    expect((await team.read(renewed)).reservedInvitations).toBe(2);
    expect(f.sql.prepare('SELECT count(*) AS total FROM international_us_team_commands').get()).toEqual({ total: 2 });
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([3, 4] as const)('revokes capability %s and Team access terminally after a previously admitted renewal', async schema => {
    const f = await fixture(), pairing = await approved(f, schema); expect((await pairing.exchange()).status).toBe(200);
    const paid = renewal(f); await f.store.apply(f.binding, paid, async () => {});
    const revoked = verifiedUsTestLifecycleObservation(f.binding, { ...paid, action: 'revoke', reason: 'refunded', authority: null, serverPrice: null });
    expect(await f.store.apply(f.binding, revoked, async () => {})).toBe('revoked');
    await expect(requireUsDeviceSession(pairing.me())).rejects.toMatchObject({ status: 402 });
    expect((await pairing.exchange()).status).toBe(402);
    await expect(teamContext(f)).rejects.toMatchObject({ status: 402 });
  });
});
