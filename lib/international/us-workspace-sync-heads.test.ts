import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AccountPublicError } from '../account-security';
import { SupabaseServerError } from '../supabase-server';
import { ErpError } from './erp-contract';
import { validateUsWorkspaceSyncHeads, type UsWorkspaceSyncHeads } from './us-workspace-sync-heads';
import { createUsWorkspaceSyncHeadsHandlers, type UsWorkspaceSyncHeadsDependencies } from './us-workspace-sync-heads-server';
import { createD1UsWorkspaceTeamHeadStore, createSupabaseUsWorkspaceSyncHeadsStore, type UsWorkspaceSyncSelection } from './us-workspace-sync-heads-store';
import { invite, teamFixture } from './us-team-test-fixture';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';

const organizationId = randomUUID(), userId = randomUUID(), token = 'a'.repeat(64);
const actor: FinancialAuthority = { organizationId, userId, role: 'owner', managementEntitled: true, timestamp: '2026-10-09T12:00:00Z' };
const selection: UsWorkspaceSyncSelection = { supplierProposals: false, bankReconciliations: false, supplierAnalysis: false, team: true, analysisConfigurationHash: null, grant: null };
const heads = (): UsWorkspaceSyncHeads => ({ schemaVersion: 1, organizationId, role: 'owner', erp: { schemaVersion: 4, organizationId, revision: 3 }, channels: { supplierProposals: null, bankReconciliations: null, sellerProfile: token, taxProfile: token, team: null, supplierAnalysis: null } });
const request = () => new Request(`https://zentra.test/api/international/workspaces/${organizationId}/sync-heads`, { headers: { 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': userId } });
function fixture() {
  const configuration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD' } as CompanyConfiguration;
  const headsStore = vi.fn(async () => ({ supportedSchemaVersion: 4 as const, read: vi.fn(async () => heads()) })), teamHead = vi.fn(async () => token);
  const deps: UsWorkspaceSyncHeadsDependencies = {
    enabled: vi.fn(() => true), authority: vi.fn(async () => ({ mode: 'browser' as const, actor })), configuration: vi.fn(async () => configuration),
    freshSupportedSchemaVersion: vi.fn(async () => 4 as const), selection: vi.fn(async () => selection),
    headsStore,
    teamHead, rateLimit: vi.fn(async () => {}), diagnostic: vi.fn(),
  };
  const run = () => createUsWorkspaceSyncHeadsHandlers(deps).GET(request(), organizationId);
  return { deps, configuration, run, headsStore, teamHead };
}
describe('US compact workspace heads closed projection', () => {
  it('accepts only the exact immutable six-channel DTO', () => {
    const v = validateUsWorkspaceSyncHeads(heads(), organizationId);
    expect(v).toEqual(heads()); expect(Object.isFrozen(v.channels)).toBe(true);
    for (const bad of [{ ...heads(), grant: {} }, { ...heads(), channels: { ...heads().channels, email: 'private@example.test' } }, { ...heads(), channels: { ...heads().channels, team: 'A'.repeat(64) } }, { ...heads(), erp: { ...heads().erp, documentText: 'private' } }, { ...heads(), schemaVersion: 2 }, { ...heads(), organizationId: randomUUID() }]) expect(() => validateUsWorkspaceSyncHeads(bad, organizationId)).toThrow();
  });
  it('rejects owner profile heads for every other role and enforces ERP capability', () => {
    for (const role of ['admin', 'accountant', 'member', 'read_only']) expect(() => validateUsWorkspaceSyncHeads({ ...heads(), role }, organizationId)).toThrow();
    expect(() => validateUsWorkspaceSyncHeads(heads(), organizationId, 3)).toThrowError('client_upgrade_required');
    expect(validateUsWorkspaceSyncHeads({ ...heads(), role: 'member', erp: null, channels: { ...heads().channels, sellerProfile: null, taxProfile: null } }, organizationId).erp).toBeNull();
  });
  it('never invokes a getter while validating a private response', () => {
    let reads = 0; expect(() => validateUsWorkspaceSyncHeads({ ...heads(), get role() { reads++; return 'owner'; } }, organizationId)).toThrow(); expect(reads).toBe(0);
  });
});
describe('US compact head HTTP admission', () => {
  it('combines PG and D1 hints behind fresh scope and no-store headers', async () => {
    const f = fixture(), response = await f.run(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...heads(), channels: { ...heads().channels, team: token } });
    expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(f.deps.authority).toHaveBeenCalledTimes(3);
    expect(f.teamHead).toHaveBeenCalledWith(organizationId);
  });
  it('keeps the disabled endpoint closed before any private read', async () => {
    const f = fixture(); f.deps.enabled = () => false; expect((await f.run()).status).toBe(404); expect(f.deps.authority).not.toHaveBeenCalled();
  });
  it.each([401, 402, 403] as const)('fresh denial %s outranks delayed storage failure', async status => {
    const f = fixture(); let denied = false;
    f.deps.authority = async () => { if (denied) throw new AccountPublicError('Private TEST failure', status); return { mode: 'browser', actor }; };
    f.deps.headsStore = async () => ({ supportedSchemaVersion: 4, read: async () => { denied = true; throw Error('private document and token'); } });
    const response = await f.run(); expect(response.status).toBe(status); expect(JSON.stringify(await response.json())).not.toContain('private');
  });
  it.each([401, 402, 403] as const)('fresh denial %s also outranks failure before the first actor returns', async status => {
    const f = fixture(); let calls = 0;
    f.deps.authority = async () => { if (++calls === 1) throw Error('Private delayed D1 failure'); throw new AccountPublicError('TEST fresh access loss', status); };
    expect((await f.run()).status).toBe(status); expect(f.headsStore).not.toHaveBeenCalled();
  });
  it.each(['user', 'role', 'mode', 'workspace', 'capability', 'configuration', 'selection', 'gate'] as const)('withholds a delayed candidate after %s changes', async change => {
    const f = fixture();
    f.deps.teamHead = async () => {
      if (change === 'user') f.deps.authority = async () => ({ mode: 'browser', actor: { ...actor, userId: randomUUID() } });
      if (change === 'role') f.deps.authority = async () => ({ mode: 'browser', actor: { ...actor, role: 'admin' } });
      if (change === 'mode') f.deps.authority = async () => ({ mode: 'device', actor });
      if (change === 'workspace') f.deps.authority = async () => ({ mode: 'browser', actor: { ...actor, organizationId: randomUUID() } });
      if (change === 'capability') f.deps.freshSupportedSchemaVersion = () => 3;
      if (change === 'configuration') f.deps.configuration = async () => ({ ...f.configuration, language: 'fr' });
      if (change === 'selection') f.deps.selection = async () => ({ ...selection, team: false });
      if (change === 'gate') f.deps.enabled = () => false;
      return token;
    };
    const response = await f.run(); expect(response.status).toBe(change === 'user' || change === 'mode' || change === 'workspace' ? 401 : change === 'role' ? 403 : change === 'gate' ? 404 : 409); expect(await response.json()).not.toHaveProperty('channels');
  });
  it('rejects malformed or unadmitted port channels and wrong captured capability', async () => {
    const f = fixture(); f.deps.headsStore = async () => ({ supportedSchemaVersion: 4, read: async () => ({ ...heads(), channels: { ...heads().channels, supplierAnalysis: token } }) }); expect((await f.run()).status).toBe(503);
    f.deps.headsStore = async () => ({ supportedSchemaVersion: 3, read: async () => heads() }); expect((await f.run()).status).toBe(409);
  });
});
describe('US compact store adapters', () => {
  it('uses exactly one fixed RPC and rejects private excess fields', async () => {
    const rpc = vi.fn(async (_name: string, _input: unknown) => heads()), store = createSupabaseUsWorkspaceSyncHeadsStore({ rpc } as never, { supportedSchemaVersion: 4 });
    expect(await store.read(actor, selection)).toEqual(heads()); expect(rpc).toHaveBeenCalledTimes(1); expect(rpc.mock.calls[0][0]).toBe('zentra_us_workspace_sync_heads');
    rpc.mockResolvedValueOnce({ ...heads(), source: 'private' } as never); await expect(store.read(actor, selection)).rejects.toMatchObject({ code: 'invalid_sync_state' });
  });
  it('maps the schema guard without exposing storage errors', async () => {
    const rpc = vi.fn(async () => { throw new SupabaseServerError(400, 'PW008', 'private'); });
    await expect(createSupabaseUsWorkspaceSyncHeadsStore({ rpc }, { supportedSchemaVersion: 4 }).read(actor, selection)).rejects.toMatchObject({ code: 'client_upgrade_required', status: 409 });
  });
  it('reads durable D1 head and expiry counts without loading secrets or lists', async () => {
    const f = await teamFixture(); try {
      let now = f.now(); const store = createD1UsWorkspaceTeamHeadStore(f.database, () => now), org = f.intent.organizationId;
      const before = await store.read(org), invitation = await invite(f), created = await store.read(org);
      expect(created).not.toBe(before); expect(await store.read(org)).toBe(created);
      if (invitation.q.action !== 'create_invitation') throw Error('TEST'); now = invitation.q.expiresAt;
      expect(await store.read(org)).not.toBe(created); expect(await store.read(org)).toMatch(/^[a-f0-9]{64}$/);
      await expect(store.read(randomUUID())).rejects.toBeInstanceOf(ErpError);
    } finally { f.sql.close(); }
  });
});
