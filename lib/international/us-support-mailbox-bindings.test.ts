import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsMailboxMember, usSupportMailboxEnabled } from './us-support-mailbox-bindings';
import type { UsSupportWorkspaceContext, UsSupportWorkspaceStore } from './us-support-workspace-contract';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('cloudflare:workers', () => ({ env: runtime.env }));
afterEach(() => { for (const key of Object.keys(runtime.env)) delete runtime.env[key]; });
function setup() {
  const now = 1791600000, user = randomUUID(), org = randomUUID();
  let context: UsSupportWorkspaceContext = { schemaVersion: 1, organizationId: org, userId: user, role: 'owner', ownerUserId: user, subscriptionId: 'sub_Test', environment: 'TEST', catalogVersion: 'test', priceId: 'price_Test', authorityReference: 'in_Test', validStartsAt: now - 100, validEndsAt: now + 1000, seatLimit: 3, checkedAt: now, credential: { kind: 'browser' } };
  const workspace = { schemaVersion: 1 as const, organizationId: org, workspaceId: randomUUID(), ownerUserId: user, connectedBy: user, name: 'Test US Support', revision: 1 as const, createdAt: now };
  const read = vi.fn(async () => workspace);
  const store: UsSupportWorkspaceStore = { read, create: async () => { throw Error('unused'); } };
  const dependencies = { member: vi.fn(async () => context), registry: async () => store, now: () => now };
  return { org, context: () => context, actor: (v: UsSupportWorkspaceContext) => { context = v; }, workspace, store, read, dependencies, resolve: createUsMailboxMember(dependencies) };
}
describe('US mailbox H1 registry admission binding', () => {
  it('binds the real registry ID and fresh H1 authority twice without legacy owner lookup', async () => {
    const t = setup(); expect(await t.resolve(new Request('https://example.test'), t.org)).toMatchObject({ workspaceId: t.workspace.workspaceId, authority: { organizationId: t.org } }); expect(t.read).toHaveBeenCalledTimes(2); expect(t.dependencies.member).toHaveBeenCalledTimes(2);
  });
  it('does not invent a workspace when H1 is absent', async () => {
    const t = setup(); t.store.read = async () => null; await expect(t.resolve(new Request('https://example.test'), t.org)).rejects.toMatchObject({ code: 'support_workspace_required', status: 409 });
  });
  it.each(['user','role','period','workspace'] as const)('rejects %s changes around a registry read', async kind => {
    const t = setup(); let reads = 0; t.store.read = async () => { reads++; const c = t.context();
      if (reads === 1 && kind !== 'workspace') t.actor(kind === 'user' ? { ...c, userId: randomUUID(), role: 'admin' } : kind === 'role' ? { ...c, userId: randomUUID(), role: 'member' } : { ...c, authorityReference: 'in_Renewed' });
      return reads === 2 && kind === 'workspace' ? { ...t.workspace, workspaceId: randomUUID() } : t.workspace;
    };
    await expect(t.resolve(new Request('https://example.test'), t.org)).rejects.toHaveProperty('code');
  });
  it('all four gates default closed and are required', async () => {
    expect(await usSupportMailboxEnabled()).toBe(false);
    Object.assign(runtime.env, { INTERNATIONAL_CORE_ENABLED: 'true', INTERNATIONAL_US_ERP_ENABLED: 'true', INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED: 'true', INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED: 'true' });
    expect(await usSupportMailboxEnabled()).toBe(true);
    for (const key of Object.keys(runtime.env)) { delete runtime.env[key]; expect(await usSupportMailboxEnabled()).toBe(false); runtime.env[key] = 'true'; }
  });
  it.each(['logout','switch','subscription','role'] as const)('late %s dominates an initial registry failure', async kind => {
    const t = setup(); t.store.read = async () => {
      if (kind === 'switch') t.actor({ ...t.context(), userId: randomUUID(), role: 'admin' });
      else t.dependencies.member.mockImplementation(async () => { throw new UsSupportWorkspaceError(kind === 'logout' ? 'unauthorized' : kind === 'subscription' ? 'subscription_required' : 'forbidden', kind === 'logout' ? 401 : kind === 'subscription' ? 402 : 403); });
      throw Error('private registry failure');
    };
    await expect(t.resolve(new Request('https://example.test'), t.org)).rejects.toMatchObject({ status: kind === 'subscription' ? 402 : kind === 'role' ? 403 : 401 });
  });
});
