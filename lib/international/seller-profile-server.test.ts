import { describe, it, expect, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { createUsSellerProfileHandlers, type SellerProfileServerDependencies } from './seller-profile-server';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';
import type { SellerProfileStore } from './seller-profile';

const organizationId = 'seller-boundary-US';
const actor: FinancialAuthority = { organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00Z' };
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Example Road', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const profile = { displayName: 'Fictitious Vendor', contactEmail: 'vendor@example.test', contactPhone: '+1 212 555 0100' };
const body = { expectedRevision: 0, requestId: 'd1c9156e-a414-4c9b-9610-007b9991a259', profile };
const url = `https://zentra.test/api/international/workspaces/${organizationId}/seller`;
const put = (input: unknown = body, headers: Record<string, string> = {}) => new Request(url, { method: 'PUT', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': actor.userId, ...headers }, body: JSON.stringify(input) });
type Change = 'user' | 'role' | 'scope' | 'mode' | 'entitlement' | 'revoked' | 'flags' | 'configuration';
function fixture() {
  let enabled = true, current = { mode: 'browser' as 'browser' | 'device', actor: { ...actor } }, config = structuredClone(configuration), revoked = false;
  let state: Record<string, unknown> = { status: 'unconfigured', organizationId, revision: 0 };
  const receipts = new Map<string, Record<string, unknown>>();
  const hooks: { read?: () => void; commit?: () => void; configuration?: (call: number) => void; authority?: (call: number) => void } = {};
  let configCalls = 0, authorityCalls = 0, commits = 0;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name.includes('read')) { const captured = structuredClone(state); hooks.read?.(); return captured; }
    if (name.includes('put')) {
      const key = args.p_request_id as string;
      const earlier = receipts.get(key);
      if (earlier) return { ...structuredClone(earlier), replayed: true };
      commits++;
      state = { status: 'configured', organizationId, revision: 1, profile: args.p_profile, updatedBy: actor.userId, updatedAt: actor.timestamp };
      const result = { ...state, requestId: key, replayed: false };
      receipts.set(key, structuredClone(result)); hooks.commit?.(); return result;
    }
    throw new Error('Unexpected RPC');
  });
  const dependencies: SellerProfileServerDependencies = {
    enabled: vi.fn(async () => enabled),
    authority: vi.fn(async () => { if (revoked) throw new AccountPublicError('private session secret', 401); const captured = structuredClone(current); hooks.authority?.(++authorityCalls); return captured; }),
    configuration: vi.fn(async () => { const captured = structuredClone(config); hooks.configuration?.(++configCalls); return captured; }),
    rateLimit: vi.fn(async () => {}), store: vi.fn(() => ({ rpc } as unknown as SellerProfileStore)), diagnostic: vi.fn(),
  };
  function change(kind: Change) {
    if (kind === 'user') current.actor.userId = 'someone-else';
    if (kind === 'scope') current.actor.organizationId = 'other-company';
    if (kind === 'role') current.actor.role = 'read_only';
    if (kind === 'mode') current.mode = 'device';
    if (kind === 'entitlement') current.actor.managementEntitled = false;
    if (kind === 'revoked') revoked = true;
    if (kind === 'flags') enabled = false;
    if (kind === 'configuration') config = { ...config, language: 'fr' };
  }
  function restore() { enabled = true; current = { mode: 'browser', actor: { ...actor } }; config = structuredClone(configuration); revoked = false; Object.keys(hooks).forEach(key => delete hooks[key as keyof typeof hooks]); }
  return { dependencies, rpc, hooks, change, restore, handler: createUsSellerProfileHandlers(dependencies), commits: () => commits, state: () => state };
}
const errors: Record<Change, [number, string]> = { user: [401, 'session_changed'], role: [403, 'forbidden'], scope: [401, 'session_changed'], mode: [401, 'session_changed'], entitlement: [402, 'management_entitlement_required'], revoked: [401, 'unauthorized'], flags: [404, 'feature_unavailable'], configuration: [409, 'configuration_changed'] };
async function rejected(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
  expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}
describe('US seller configuration HTTP admission and responses', () => {
  it('does not authenticate or open privileged storage while disabled', async () => {
    const t = fixture(); t.change('flags'); await rejected(await t.handler.GET(new Request(url), organizationId), 404, 'feature_unavailable'); await rejected(await t.handler.PUT(put(), organizationId), 404, 'feature_unavailable'); expect(t.dependencies.authority).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['invalid space', '../elsewhere', '', 'x'.repeat(129)])('rejects malformed path %s before auth', async id => {
    const t = fixture(); await rejected(await t.handler.GET(new Request(url), id), 422, 'invalid_request'); expect(t.dependencies.authority).not.toHaveBeenCalled();
  });
  it.each(['user', 'scope', 'entitlement', 'revoked'] as const)('refuses initial %s without opening storage', async kind => {
    const t = fixture(); t.change(kind); const expected = kind === 'scope' ? [403, 'tenant_mismatch'] as const : errors[kind]; await rejected(await t.handler.PUT(put(), organizationId), expected[0], expected[1]); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['admin', 'accountant', 'member', 'read_only'] as const)('allows %s to read, but refuses seller edits', async role => {
    const t = fixture(); vi.mocked(t.dependencies.authority).mockResolvedValue({ mode: 'browser', actor: { ...actor, role } });
    expect((await t.handler.GET(new Request(url), organizationId)).status).toBe(200); t.rpc.mockClear(); await rejected(await t.handler.PUT(put(), organizationId), 403, 'forbidden'); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.test', 'null', ''])('refuses browser origin %s before evaluating auth', async Origin => {
    const t = fixture(); await rejected(await t.handler.PUT(put(body, { Origin }), organizationId), 403, 'forbidden'); expect(t.dependencies.authority).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('refuses missing browser Origin and cross-site fetch metadata', async () => {
    const t = fixture(), request = put(); request.headers.delete('Origin'); await rejected(await t.handler.PUT(request, organizationId), 403, 'forbidden'); await rejected(await t.handler.PUT(put(body, { 'Sec-Fetch-Site': 'cross-site' }), organizationId), 403, 'forbidden'); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('never substitutes cookies after an invalid native session', async () => {
    const t = fixture(); vi.mocked(t.dependencies.authority).mockRejectedValue(new AccountPublicError('invalid bearer secret', 401)); await rejected(await t.handler.PUT(put(body, { Authorization: 'Bearer invalid' }), organizationId), 401, 'unauthorized'); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('denies CH edition without reading or writing any seller record', async () => {
    const t = fixture(); vi.mocked(t.dependencies.configuration).mockResolvedValue({ ...configuration, country: 'CH', currency: 'CHF', ein: undefined, timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Exemple', city: 'Genève', subdivision: 'GE', postalCode: '1201' } }); await rejected(await t.handler.PUT(put(), organizationId), 409, 'edition_unavailable'); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([{ role: 'owner' }, { userId: 'someone' }, { organizationId: 'other' }, { profile: { ...profile, ein: '12-3456789' } }, { profile: { ...profile, logoRef: { assetId: 'fake' } } }])('refuses authority or private fields %j', async extra => {
    const t = fixture(); await rejected(await t.handler.PUT(put({ ...body, ...extra }), organizationId), 422, 'invalid_request'); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('bounds and validates request format before privileged storage', async () => {
    const t = fixture(); await rejected(await t.handler.PUT(put({ ...body, padding: 'x'.repeat(4_096) }), organizationId), 413, 'invalid_request'); await rejected(await t.handler.PUT(put(body, { 'Content-Type': 'text/plain' }), organizationId), 415, 'invalid_request'); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(Object.keys(errors) as Change[])('withholds a slow GET after %s', async kind => {
    const t = fixture(); t.hooks.read = () => t.change(kind); await rejected(await t.handler.GET(new Request(url), organizationId), ...errors[kind]); expect(t.commits()).toBe(0);
  });
  it.each(Object.keys(errors) as Change[])('refuses a precommit edit after %s during country validation', async kind => {
    const t = fixture(); t.hooks.configuration = call => { if (call === (kind === 'configuration' ? 1 : 2)) t.change(kind); }; await rejected(await t.handler.PUT(put(), organizationId), ...errors[kind]); expect(t.commits()).toBe(0);
  });
  it.each(Object.keys(errors) as Change[])('withholds postcommit receipt after %s, then recovers exact request once', async kind => {
    const t = fixture(); t.hooks.commit = () => t.change(kind); await rejected(await t.handler.PUT(put(), organizationId), ...errors[kind]); expect(t.commits()).toBe(1); expect(t.state().revision).toBe(1);
    t.restore(); const response = await t.handler.PUT(put(), organizationId); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ requestId: body.requestId, revision: 1, profile, replayed: true }); expect(t.commits()).toBe(1); expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic).mock.calls)).not.toContain('secret');
  });
  it('checks flags after the final authority await, not only beforehand', async () => {
    const t = fixture(); t.hooks.authority = call => { if (call === 2) t.change('flags'); }; await rejected(await t.handler.GET(new Request(url), organizationId), 404, 'feature_unavailable');
  });
  it('returns only dedicated seller public state and receipt', async () => {
    const t = fixture(); expect(await (await t.handler.GET(new Request(url), organizationId)).json()).toEqual({ status: 'unconfigured', organizationId, revision: 0 });
    const response = await t.handler.PUT(put(), organizationId); expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'configured', organizationId, revision: 1, profile, updatedBy: actor.userId, updatedAt: actor.timestamp, requestId: body.requestId, replayed: false }); expect(t.commits()).toBe(1);
  });
  it('redacts unexpected upstream contents and tolerates telemetry failure', async () => {
    const t = fixture(); t.rpc.mockRejectedValue(new Error('password / private street / EIN')); vi.mocked(t.dependencies.diagnostic).mockImplementation(() => { throw new Error('telemetry unavailable'); }); await rejected(await t.handler.GET(new Request(url), organizationId), 503, 'service_unavailable');
  });
});
