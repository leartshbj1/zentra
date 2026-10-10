import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { UsSupportWorkspaceError, type UsSupportWorkspaceContext } from './us-support-workspace-contract';
import { createUsSupportTicketHandlers, type UsSupportTicketDependencies } from './us-support-ticket-server';
import type { UsSupportTicketStore } from './us-support-ticket-contract';

/** HTTP boundary tests use an empty read projection. The composition suite
 * exercises successful commands against real SQLite records. */
function fixture() {
  const org = randomUUID(), owner = randomUUID(), workspaceId = randomUUID(), clock = 1791620000;
  let gate = true;
  let actor: UsSupportWorkspaceContext = { schemaVersion: 1, organizationId: org, userId: owner, role: 'owner', ownerUserId: owner,
    subscriptionId: 'sub_Synthetic', environment: 'TEST', catalogVersion: 'synthetic-v1', priceId: 'price_Synthetic',
    authorityReference: 'in_Synthetic', validStartsAt: clock - 100, validEndsAt: clock + 1000, seatLimit: 8, checkedAt: clock, credential: { kind: 'browser' } };
  const store: UsSupportTicketStore = {
    read: vi.fn(async (c, offset = 0) => ({ schemaVersion: 1 as const, organizationId: org, workspaceId, userId: c.authority.userId, role: c.authority.role,
      offset, nextOffset: null, tickets: [], routing: { schemaVersion: 1 as const, revision: 0, enabled: false, threshold: 0.9, routes: [] }, assignees: [], head: { revision: 0, teamRevision: 0 } })),
    head: vi.fn(async c => ({ schemaVersion: 1 as const, organizationId: org, workspaceId, userId: c.authority.userId, role: c.authority.role, revision: 0, teamRevision: 0 })),
    find: vi.fn(async () => null), commit: vi.fn(async () => { throw new Error('unexpected mutation'); }), saveRouting: vi.fn(async () => { throw new Error('unexpected routing'); }),
  };
  const d: UsSupportTicketDependencies = { enabled: vi.fn(async () => gate), now: () => clock,
    member: vi.fn(async () => ({ schemaVersion: 1 as const, authority: actor, workspaceId })), store: vi.fn(async () => store), diagnostic: vi.fn() };
  const handlers = createUsSupportTicketHandlers(d);
  const request = (method = 'GET', body?: unknown, headers: Record<string, string> = {}, suffix = '') => new Request(`https://zentra.test/api/international/workspaces/${org}/support-tickets${suffix}`, {
    method, headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': actor.userId, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { org, owner, workspaceId, d, store, handlers, request, actor: () => actor, setActor: (value: UsSupportWorkspaceContext) => { actor = value; }, gate: (value: boolean) => { gate = value; } };
}

describe('US Support ticket HTTP authorization boundaries, no network', () => {
  it.each(['read', 'head', 'write', 'routing'] as const)('closes %s before identity or storage when disabled', async operation => {
    const t = fixture(); t.gate(false);
    const response = await t.handlers[operation](t.request(operation === 'read' || operation === 'head' ? 'GET' : 'POST', operation === 'read' || operation === 'head' ? undefined : {}), t.org);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'feature_unavailable' });
    expect(t.d.member).not.toHaveBeenCalled(); expect(t.d.store).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
  it.each([401, 402, 403] as const)('preserves fresh admission denial %s without private storage', async status => {
    const t = fixture(), error = status === 401 ? 'unauthorized' : status === 402 ? 'subscription_required' : 'forbidden';
    t.d.member = async () => { throw new UsSupportWorkspaceError(error, status); };
    const response = await t.handlers.read(t.request(), t.org);
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error }); expect(t.d.store).not.toHaveBeenCalled();
  });
  it.each(['read', 'head', 'write', 'routing'] as const)('rejects an invalid company on %s', async operation => {
    const t = fixture(), mutation = operation === 'write' || operation === 'routing';
    expect((await t.handlers[operation](t.request(mutation ? 'POST' : 'GET', mutation ? {} : undefined), 'not-an-organization')).status).toBe(422);
    expect(t.d.store).not.toHaveBeenCalled();
  });
  it.each(['read', 'head', 'write', 'routing'] as const)('rejects the wrong HTTP method on %s', async operation => {
    const t = fixture(), mutation = operation === 'write' || operation === 'routing';
    expect((await t.handlers[operation](t.request(mutation ? 'GET' : 'POST', mutation ? undefined : {}), t.org)).status).toBe(422);
    expect(t.d.store).not.toHaveBeenCalled();
  });
  it.each(['?offset=-1', '?offset=1.5', '?offset=abc', '?offset=0&offset=1', '?organizationId=other', '?offset=0&extra=yes'])('rejects polluted/invalid list query %s', async suffix => {
    const t = fixture(); expect((await t.handlers.read(t.request('GET', undefined, {}, suffix), t.org)).status).toBe(422); expect(t.d.store).not.toHaveBeenCalled();
  });
  it.each(['head', 'write', 'routing'] as const)('rejects every query parameter on %s', async operation => {
    const t = fixture(), mutation = operation !== 'head';
    expect((await t.handlers[operation](t.request(mutation ? 'POST' : 'GET', mutation ? {} : undefined, {}, '?offset=0'), t.org)).status).toBe(422);
    expect(t.d.store).not.toHaveBeenCalled();
  });
  it.each(['1', '2', '3'])('requires protocol 4, refusing supported older %j before storage', async schema => {
    const t = fixture(); expect((await t.handlers.read(t.request('GET', undefined, { [ERP_SCHEMA_HEADER]: schema }), t.org)).status).toBe(409); expect(t.d.store).not.toHaveBeenCalled();
  });
  it.each(['', '04', '5'])('rejects malformed protocol %j as a request error', async schema => {
    const t = fixture(); expect((await t.handlers.read(t.request('GET', undefined, { [ERP_SCHEMA_HEADER]: schema }), t.org)).status).toBe(422); expect(t.d.store).not.toHaveBeenCalled();
  });
  it('does not reuse a browser context for an unsolicited bearer', async () => {
    const t = fixture(); expect((await t.handlers.read(t.request('GET', undefined, { Authorization: 'Bearer unrelated' }), t.org)).status).toBe(401); expect(t.d.store).not.toHaveBeenCalled();
  });
  it('does not expose another user after an expected-user mismatch', async () => {
    const t = fixture(); expect((await t.handlers.read(t.request('GET', undefined, { 'X-Zentra-Expected-User': randomUUID() }), t.org)).status).toBe(401); expect(t.d.store).not.toHaveBeenCalled();
  });
  it.each(['write', 'routing'] as const)('rejects cross-origin browser %s before storage', async operation => {
    const t = fixture(); expect((await t.handlers[operation](t.request('POST', {}, { Origin: 'https://foreign.test' }), t.org)).status).toBe(403); expect(t.d.store).not.toHaveBeenCalled();
  });
  it('requires a bearer for a native identity and grants no cookie fallback', async () => {
    const t = fixture(); t.setActor({ ...t.actor(), credential: { kind: 'device', sessionId: 'usd_' + randomUUID(), supportedSchemaVersion: 4 } });
    expect((await t.handlers.read(t.request(), t.org)).status).toBe(401); expect(t.d.store).not.toHaveBeenCalled();
    expect((await t.handlers.read(t.request('GET', undefined, { Authorization: 'Bearer synthetic-native', Origin: 'https://native.test' }), t.org)).status).toBe(200);
    expect(t.d.store).toHaveBeenCalledOnce();
  });
  it.each(['user', 'role', 'period', 'credential', 'gate'] as const)('rechecks %s after loading private storage', async change => {
    const t = fixture(); t.d.store = async () => {
      const c = t.actor();
      if (change === 'gate') t.gate(false);
      else t.setActor(change === 'user' ? { ...c, userId: randomUUID(), role: 'admin' }
        : change === 'role' ? { ...c, userId: randomUUID(), role: 'member' }
          : change === 'period' ? { ...c, authorityReference: 'in_Renewed', validEndsAt: c.validEndsAt + 100 }
            : { ...c, credential: { kind: 'device', sessionId: 'usd_' + randomUUID(), supportedSchemaVersion: 4 } });
      return t.store;
    };
    const response = await t.handlers.read(t.request(), t.org); expect([401, 403, 404, 409]).toContain(response.status);
    expect(await response.text()).not.toContain('private SQL diagnostics');
  });
  it('fresh membership revocation outranks an unrelated storage exception', async () => {
    const t = fixture(); t.d.store = async () => { t.d.member = async () => { throw new UsSupportWorkspaceError('forbidden', 403); }; throw new Error('private SQL diagnostics'); };
    const response = await t.handlers.read(t.request(), t.org); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(JSON.stringify((t.d.diagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private SQL diagnostics');
  });
  it('redacts unexpected failures even if the diagnostic port throws', async () => {
    const t = fixture(); t.d.store = async () => { throw new Error('private database password'); }; t.d.diagnostic = () => { throw new Error('broken logger'); };
    const response = await t.handlers.read(t.request(), t.org); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
  it.each(['owner', 'admin', 'member', 'accountant', 'read_only'] as const)('returns only body-free admitted read/head projections for %s', async role => {
    const t = fixture(); if (role !== 'owner') t.setActor({ ...t.actor(), userId: randomUUID(), role });
    const response = await t.handlers.read(t.request('GET', undefined, {}, '?offset=25'), t.org);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ organizationId: t.org, workspaceId: t.workspaceId, role, offset: 25, tickets: [] });
    expect((await t.handlers.head(t.request(), t.org)).status).toBe(200); expect(t.store.commit).not.toHaveBeenCalled(); expect(t.store.saveRouting).not.toHaveBeenCalled();
  });
  it.each(['read', 'head'] as const)('fresh Auth loss wins over invalid %s records', async operation => {
    const t = fixture(); t.store[operation] = vi.fn(async () => { t.d.member = async () => { throw new UsSupportWorkspaceError('forbidden', 403); }; return {} as never; });
    const response = await t.handlers[operation](t.request(), t.org); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'forbidden' });
  });
  it.each(['organization', 'workspace', 'user', 'role', 'offset', 'extra'] as const)('rejects a corrupted public projection %s', async field => {
    const t = fixture(), original = t.store.read;
    t.store.read = async (...args) => { const value = await original(...args); return { ...value, ...(field === 'organization' ? { organizationId: randomUUID() } : field === 'workspace' ? { workspaceId: randomUUID() } : field === 'user' ? { userId: randomUUID() } : field === 'role' ? { role: 'member' } : field === 'offset' ? { offset: 25 } : { body: 'private body' }) }; };
    const response = await t.handlers.read(t.request(), t.org); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'invalid_ticket_record' });
  });
});
