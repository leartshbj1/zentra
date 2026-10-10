import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsSupportWorkspaceMember, readUsSupportWorkspaceAuthority, usSupportWorkspacesEnabled } from './us-support-workspace-bindings';
import { lifecycleFixture } from './us-saas-test-lifecycle-test-fixture';
import { UsTeamError, type UsTeamContext } from './us-team-contract';
import type { SaasSubscriptionAuthority } from './subscriptions';
const state = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('cloudflare:workers', () => ({ env: state.env }));
type Fixture = Awaited<ReturnType<typeof lifecycleFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } for (const key of Object.keys(state.env)) delete state.env[key]; });
async function fixture() { const f = await lifecycleFixture(); fixtures.push(f); return f; }
function member(f: Fixture): UsTeamContext {
  const row = f.sql.prepare('SELECT authority_json FROM international_effective_saas_authorities WHERE organization_id=?').get(f.intent.organizationId)!;
  const a = JSON.parse(row.authority_json as string) as SaasSubscriptionAuthority;
  return { schemaVersion: 1, organizationId: f.intent.organizationId, mode: 'member', role: 'owner', user: { userId: f.actor, email: 'owner@example.test', emailConfirmed: true }, subscriptionId: a.subscriptionId, environment: a.offer.environment, catalogVersion: a.offer.catalogVersion, priceId: a.offer.priceId, seatLimit: f.policy.catalog[0].seatLimit, validStartsAt: a.evidence!.startsAt, validEndsAt: a.evidence!.endsAt, checkedAt: f.now(), credential: { kind: 'browser' } };
}
const request = () => new Request('https://example.invalid/api/support-workspace');
describe('US Support authority binding with real local SQLite lifecycle and fictitious Auth/catalogue', () => {
  it('reads current Complet USD provenance, never an initial-only grant', async () => {
    const f = await fixture(), c = await readUsSupportWorkspaceAuthority(f.database, member(f), { ...f.policy, now: f.now() });
    expect(c).toMatchObject({ organizationId: f.intent.organizationId, userId: f.actor, ownerUserId: f.actor, role: 'owner', authorityReference: f.authority.evidence!.referenceId, environment: 'TEST' });
    f.setNow(f.authority.evidence!.endsAt + 1); const renewal = f.paid(); await f.store.apply(f.binding, renewal, async () => {});
    expect(await readUsSupportWorkspaceAuthority(f.database, member(f), { ...f.policy, now: f.now() })).toMatchObject({ authorityReference: renewal.invoiceId, validEndsAt: renewal.authority!.evidence!.endsAt });
  });
  it('refuses a foreign/CH identity before private authority disclosure', async () => {
    const f = await fixture(), m = member(f);
    await expect(readUsSupportWorkspaceAuthority(f.database, { ...m, organizationId: randomUUID() }, f.policy)).rejects.toMatchObject({ status: 403 });
    await expect(readUsSupportWorkspaceAuthority(f.database, { ...m, user: { ...m.user, userId: randomUUID() } }, f.policy)).rejects.toMatchObject({ status: 403 });
  });
  it('catalogue removal cannot be replaced by legacy Support or a retained invoice', async () => {
    const f = await fixture(); await expect(readUsSupportWorkspaceAuthority(f.database, member(f), { ...f.policy, catalog: [] })).rejects.toMatchObject({ status: 503 });
  });
  it('terminal revocation denies the currently paid period', async () => {
    const f = await fixture(); f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(f.now(), f.intent.organizationId);
    await expect(readUsSupportWorkspaceAuthority(f.database, member(f), f.policy)).rejects.toMatchObject({ status: 403 });
  });
  it('a renewal during the final Auth await cannot return the preceding invoice/period', async () => {
    const f = await fixture(); let calls = 0;
    const resolve = createUsSupportWorkspaceMember({ database: async () => f.database, policy: async () => ({ ...f.policy, now: f.now() }), now: f.now, member: async () => {
      if (++calls === 2) { f.setNow(f.authority.evidence!.endsAt + 1); await f.store.apply(f.binding, f.paid(), async () => {}); }
      return member(f);
    } });
    await expect(resolve(request(), f.intent.organizationId)).rejects.toMatchObject({ code: 'configuration_changed', status: 409 });
  });
  it('account switch during the final Auth await is session_changed', async () => {
    const f = await fixture(); let calls = 0;
    const resolve = createUsSupportWorkspaceMember({ database: async () => f.database, policy: async () => f.policy, now: f.now, member: async () => { const m = member(f); return ++calls >= 2 ? { ...m, user: { ...m.user, userId: randomUUID() } } : m; } });
    await expect(resolve(request(), f.intent.organizationId)).rejects.toMatchObject({ code: 'session_changed', status: 401 });
  });
  it('logout dominates a delayed database exception', async () => {
    const f = await fixture(); let calls = 0;
    const resolve = createUsSupportWorkspaceMember({ database: async () => { throw Error('private sql server information'); }, policy: async () => f.policy, now: f.now, member: async () => { if (++calls >= 2) throw new UsTeamError('unauthorized', 401); return member(f); } });
    await expect(resolve(request(), f.intent.organizationId)).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });
  it('all three flags are required and default closed', async () => {
    expect(await usSupportWorkspacesEnabled()).toBe(false);
    Object.assign(state.env, { INTERNATIONAL_CORE_ENABLED: 'true', INTERNATIONAL_US_ERP_ENABLED: 'true', INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED: 'true' });
    expect(await usSupportWorkspacesEnabled()).toBe(true);
    for (const key of Object.keys(state.env)) { const saved = state.env[key]; delete state.env[key]; expect(await usSupportWorkspacesEnabled()).toBe(false); state.env[key] = saved; }
  });
});
