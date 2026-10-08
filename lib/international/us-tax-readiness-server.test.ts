import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { nationalAdapter } from './countries/adapters';
import { ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { createUsTaxReadinessHandlers, type UsTaxReadinessServerDependencies } from './us-tax-readiness-server';
import { UsTaxReadinessError, validateUsTaxReadiness, type UsTaxReadinessEvaluation, type UsTaxReadinessEvaluationInput } from './us-tax-readiness';

const organizationId = 'fictitious-readiness-http', start = Date.parse('2026-10-08T12:00:00Z') / 1000;
const privateMarker = 'PRIVATE FICTITIOUS READINESS DETAIL';
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: 'PRIVATE Fictitious Road', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } };
const initialActor: FinancialAuthority = { organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.123Z' };
/** Real handler/DTO code; Auth, D1, durable book and provider are injected here. */
function fixture(capability: ErpSchemaVersion = 4, version: ErpSchemaVersion = 4) {
  let clock = start, flags = true, currentActor = initialActor, mode: 'browser' | 'device' = 'device', denied: Error | null = null, freshCapability = capability;
  let currentConfiguration = structuredClone(configuration);
  let state: ErpState | null = { schemaVersion: version, revision: 1, configuration, counters: { estimate: 0, invoice: 0, ...(version >= 3 ? { project: 0 } : {}) }, customers: [], estimates: [], invoices: [], ...(version >= 2 ? { vendors: [], vendorBills: [], vendorPayments: [] } : {}), ...(version >= 3 ? { projects: [] } : {}), ledger: createLedger({ organizationId, currency: 'USD', basis: 'accrual', accounts: nationalAdapter('US').starterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }) };
  const authority = vi.fn(async (_request: Request, org: string) => {
    if (denied) throw denied;
    if (org !== organizationId) throw new ErpError('forbidden', 403);
    return { mode, actor: currentActor };
  });
  const read = vi.fn(async () => state), receipt = vi.fn(async () => null), commit = vi.fn<ErpStore['commit']>();
  const store = vi.fn(async () => ({ supportedSchemaVersion: capability, read, receipt, commit }));
  const evaluate = vi.fn(async (_input: UsTaxReadinessEvaluationInput): Promise<UsTaxReadinessEvaluation> => ({ status: 'ready_test', validUntil: clock + 30 }));
  const rateLimit = vi.fn(async () => {}), diagnostic = vi.fn(), config = vi.fn(async () => currentConfiguration);
  const dependencies = { enabled: async () => flags, authority, configuration: config, store, freshSupportedSchemaVersion: () => freshCapability, rateLimit, diagnostic, now: () => clock, evaluate } satisfies UsTaxReadinessServerDependencies;
  const request = (extra: HeadersInit = {}, query = '') => new Request(`https://zentraapp.ch/api/international/workspaces/${organizationId}/tax-readiness${query}`, { headers: { Authorization: 'Bearer zus_FICTITIOUS', 'X-Zentra-Expected-User': initialActor.userId, 'X-Zentra-Erp-Schema-Version': '4', ...extra } });
  return { dependencies, handlers: createUsTaxReadinessHandlers(dependencies), request, authority, read, receipt, commit, store, evaluate, config, rateLimit, diagnostic,
    setActor: (actor: FinancialAuthority) => { currentActor = actor; }, setMode: (value: 'browser' | 'device') => { mode = value; },
    deny: (value: Error) => { denied = value; }, setFlags: (value: boolean) => { flags = value; }, setCap: (value: ErpSchemaVersion) => { freshCapability = value; },
    setClock: (value: number) => { clock = value; }, setState: (value: ErpState | null) => { state = value; }, state: () => state!,
    setConfig: (value: CompanyConfiguration) => { currentConfiguration = value; },
  };
}
async function error(response: Response, code: string, status: number) {
  expect(response.status).toBe(status); const body = await response.json(); expect(body).toEqual({ error: code });
  expect(JSON.stringify(body)).not.toContain(privateMarker); expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
}
async function blocked(response: Response, reason: string) {
  expect(response.status).toBe(200); const value = validateUsTaxReadiness(await response.json()); expect(value).toMatchObject({ status: 'blocked', reason }); return value;
}

describe('authenticated read-only US tax readiness HTTP', () => {
  it('projects only the exact public TEST shape and scoped capability, without mutations', async () => {
    const t = fixture(), response = await t.handlers.GET(t.request(), organizationId), body = await response.json();
    expect(body).toEqual({ schemaVersion: 1, organizationId, currency: 'USD', effectiveSchemaVersion: 4, checkedAt: start, expiresAt: start + 30, status: 'ready_test' });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|accountId|proof|taxOrigin|binding|revision|userId/i);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(t.commit).not.toHaveBeenCalled(); expect(t.receipt).not.toHaveBeenCalled(); expect(t.authority).toHaveBeenCalledTimes(2);
  });
  it('default disconnected wiring is blocked, never ready', async () => {
    const t = fixture(), handlers = createUsTaxReadinessHandlers({ ...t.dependencies, evaluate: undefined });
    await blocked(await handlers.GET(t.request(), organizationId), 'provider_test_unavailable'); expect(t.evaluate).not.toHaveBeenCalled();
  });
  it.each(['member', 'read_only'] as const)('returns %s blocked without evaluating private/provider context', async role => {
    const t = fixture(); t.setActor({ ...initialActor, role });
    await blocked(await t.handlers.GET(t.request(), organizationId), 'financial_role_required'); expect(t.evaluate).not.toHaveBeenCalled();
  });
  it('preserves browser cookie selection and expected-user binding', async () => {
    const t = fixture(); t.setMode('browser'); const request = t.request(); request.headers.delete('Authorization');
    expect((await t.handlers.GET(request, organizationId)).status).toBe(200);
    const u = fixture(); await error(await u.handlers.GET(u.request({ 'X-Zentra-Expected-User': 'other-user' }), organizationId), 'session_changed', 401);
    expect(u.read).not.toHaveBeenCalled(); expect(u.evaluate).not.toHaveBeenCalled();
  });
  it('does not read books/private data for rejected native authority or disabled flags', async () => {
    const t = fixture(); t.deny(new AccountPublicError(privateMarker, 401));
    await error(await t.handlers.GET(t.request(), organizationId), 'unauthorized', 401); expect(t.store).not.toHaveBeenCalled();
    const u = fixture(); u.setFlags(false); await error(await u.handlers.GET(u.request(), organizationId), 'feature_unavailable', 404);
    expect(u.authority).not.toHaveBeenCalled(); expect(u.read).not.toHaveBeenCalled();
  });
  it.each(['?mode=test', '?ready=true&ready=false', '?organizationId=CH', '?'])('rejects extra/duplicate query except the empty separator: %s', async query => {
    const t = fixture(), response = await t.handlers.GET(t.request({}, query), organizationId);
    if (query === '?') expect(response.status).toBe(200); else { await error(response, 'invalid_request', 422); expect(t.authority).not.toHaveBeenCalled(); }
  });
  it.each(['5', '04', '4,3', ''])('rejects an invalid schema header %s before durable reads', async cap => {
    const t = fixture(); await error(await t.handlers.GET(t.request({ 'X-Zentra-Erp-Schema-Version': cap }), organizationId), 'invalid_request', 422);
    expect(t.read).not.toHaveBeenCalled(); expect(t.evaluate).not.toHaveBeenCalled();
  });
  it('bounds readiness by the actual book and rejects head4 for a trusted capability3', async () => {
    const t = fixture(4, 1), result = validateUsTaxReadiness(await (await t.handlers.GET(t.request(), organizationId)).json()); expect(result.effectiveSchemaVersion).toBe(1);
    const u = fixture(3, 4); await error(await u.handlers.GET(u.request(), organizationId), 'client_upgrade_required', 409); expect(u.evaluate).not.toHaveBeenCalled();
  });
  it('does not let header3 use an injected store capable4', async () => {
    const t = fixture(); await error(await t.handlers.GET(t.request({ 'X-Zentra-Erp-Schema-Version': '3' }), organizationId), 'client_upgrade_required', 409); expect(t.read).not.toHaveBeenCalled();
  });
  it('retains an informative source1 projection when an unused cap4 flag closes, but not an uninitialized ceiling4', async () => {
    const t = fixture(4, 1); t.evaluate.mockImplementation(async () => { t.setCap(3); return { status: 'ready_test', validUntil: start + 30 }; });
    const response = await t.handlers.GET(t.request(), organizationId); expect(response.status).toBe(200);
    expect(validateUsTaxReadiness(await response.json())).toMatchObject({ status: 'ready_test', effectiveSchemaVersion: 1 });
    const u = fixture(); u.setState(null); u.read.mockImplementation(async () => { u.setCap(3); return null; });
    await error(await u.handlers.GET(u.request(), organizationId), 'client_upgrade_required', 409);
  });
  it('returns explicit missing book/configuration and stale configuration reasons', async () => {
    const t = fixture(); t.setState(null); const missing = await blocked(await t.handlers.GET(t.request(), organizationId), 'workspace_uninitialized'); expect(missing.effectiveSchemaVersion).toBe(4);
    const u = fixture(); u.config.mockRejectedValue(new ErpError('country_configuration_required', 409)); await blocked(await u.handlers.GET(u.request(), organizationId), 'country_configuration_required'); expect(u.read).not.toHaveBeenCalled();
    const v = fixture(); v.setConfig({ ...configuration, language: 'fr' }); await blocked(await v.handlers.GET(v.request(), organizationId), 'configuration_outdated'); expect(v.evaluate).not.toHaveBeenCalled();
  });
  it('cannot turn a configured preference off into provider readiness', async () => {
    const t = fixture(), config = { ...configuration, taxConfiguration: { status: 'unconfigured' as const } };
    t.setConfig(config); t.setState({ ...t.state(), configuration: config }); await blocked(await t.handlers.GET(t.request(), organizationId), 'provider_test_unavailable'); expect(t.evaluate).not.toHaveBeenCalled();
  });
  it.each([['user', 'session_changed', 401], ['mode', 'session_changed', 401], ['role', 'forbidden', 403], ['entitlement', 'management_entitlement_required', 402], ['flags', 'feature_unavailable', 404], ['cap', 'client_upgrade_required', 409]] as const)('withholds success after %s changes in evaluation', async (kind, code, status) => {
    const t = fixture(); t.evaluate.mockImplementation(async () => {
      if (kind === 'user') t.setActor({ ...initialActor, userId: 'other' });
      if (kind === 'mode') t.setMode('browser'); if (kind === 'role') t.setActor({ ...initialActor, role: 'member' });
      if (kind === 'entitlement') t.setActor({ ...initialActor, managementEntitled: false }); if (kind === 'flags') t.setFlags(false); if (kind === 'cap') t.setCap(3);
      return { status: 'ready_test', validUntil: start + 120 };
    });
    await error(await t.handlers.GET(t.request(), organizationId), code, status);
  });
  it.each([401, 402, 403])('retains actual Auth %s even with simultaneous flag/config/read failures', async status => {
    const t = fixture(); t.evaluate.mockImplementation(async () => {
      t.deny(new AccountPublicError(privateMarker, status)); t.setFlags(false); t.config.mockRejectedValue(new Error(privateMarker)); throw new Error(privateMarker);
    });
    await error(await t.handlers.GET(t.request(), organizationId), status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : 'forbidden', status);
    expect(JSON.stringify(t.diagnostic.mock.calls)).not.toContain(privateMarker);
  });
  it('rechecks authority on malformed evaluation and a durable read error', async () => {
    const t = fixture(); t.evaluate.mockImplementation(async () => { t.deny(new AccountPublicError(privateMarker, 401)); return { status: 'ready_test', validUntil: start + 30, proof: privateMarker } as UsTaxReadinessEvaluation; });
    await error(await t.handlers.GET(t.request(), organizationId), 'unauthorized', 401);
    const u = fixture(); u.read.mockImplementation(async () => { u.deny(new AccountPublicError(privateMarker, 403)); throw new Error(privateMarker); });
    await error(await u.handlers.GET(u.request(), organizationId), 'forbidden', 403);
  });
  it('sanitizes unknown private failures, including foreign ErpError codes and malformed projection', async () => {
    for (const failure of [new Error(privateMarker), new ErpError(privateMarker, 503)]) {
      const t = fixture(); t.evaluate.mockRejectedValue(failure); await error(await t.handlers.GET(t.request(), organizationId), 'service_unavailable', 503);
      expect(JSON.stringify(t.diagnostic.mock.calls)).not.toContain(privateMarker); expect(t.authority).toHaveBeenCalledTimes(2);
    }
    const u = fixture(); u.evaluate.mockResolvedValue({ status: 'ready_test', validUntil: start + 30, providerAccount: privateMarker } as UsTaxReadinessEvaluation);
    await error(await u.handlers.GET(u.request(), organizationId), 'invalid_tax_readiness', 503);
    const v = fixture(); v.evaluate.mockRejectedValue(Object.assign(new UsTaxReadinessError(), { code: privateMarker }));
    await error(await v.handlers.GET(v.request(), organizationId), 'invalid_tax_readiness', 503); expect(JSON.stringify(v.diagnostic.mock.calls)).not.toContain(privateMarker);
  });
  it('caps lifetime at120 seconds and withdraws a deadline exhausted during postflight', async () => {
    const t = fixture(); t.evaluate.mockResolvedValue({ status: 'ready_test', validUntil: start + 1000 });
    expect(validateUsTaxReadiness(await (await t.handlers.GET(t.request(), organizationId)).json()).expiresAt).toBe(start + 120);
    const u = fixture(); u.authority.mockImplementationOnce(async () => ({ mode: 'device', actor: initialActor })).mockImplementation(async () => { u.setClock(start + 30); return { mode: 'device', actor: initialActor }; });
    await blocked(await u.handlers.GET(u.request(), organizationId), 'provider_observation_expired');
  });
  it('refuses backwards clock/authority stamps and does not disclose a CH configuration', async () => {
    const t = fixture(); t.evaluate.mockImplementation(async () => { t.setClock(start - 1); return { status: 'ready_test', validUntil: start + 30 }; });
    await error(await t.handlers.GET(t.request(), organizationId), 'server_clock_unavailable', 503);
    const u = fixture(); u.evaluate.mockImplementation(async () => { u.setActor({ ...initialActor, timestamp: '2026-10-08T12:00:00Z' }); return { status: 'ready_test', validUntil: start + 30 }; });
    await error(await u.handlers.GET(u.request(), organizationId), 'server_clock_unavailable', 503);
    const v = fixture(); v.setConfig({ schemaVersion: 1, organizationId, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: 'PRIVATE CH', city: 'Geneva', postalCode: '1200', subdivision: 'GE' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } });
    await error(await v.handlers.GET(v.request(), organizationId), 'edition_unavailable', 409); expect(v.read).not.toHaveBeenCalled(); expect(v.evaluate).not.toHaveBeenCalled();
  });
  it('stops storage/evaluation on quota refusal with a bounded429', async () => {
    const t = fixture(); t.rateLimit.mockRejectedValue(new AccountPublicError(privateMarker, 429));
    await error(await t.handlers.GET(t.request(), organizationId), 'rate_limited', 429); expect(t.store).not.toHaveBeenCalled(); expect(t.evaluate).not.toHaveBeenCalled();
  });
  it('never invokes an evaluation getter and checks final admission before rejecting it', async () => {
    const t = fixture(), getter = vi.fn(() => privateMarker);
    t.evaluate.mockResolvedValue(Object.defineProperty({ status: 'ready_test', validUntil: start + 30 }, 'status', { enumerable: true, get: getter }));
    await error(await t.handlers.GET(t.request(), organizationId), 'invalid_tax_readiness', 503); expect(getter).not.toHaveBeenCalled(); expect(t.authority).toHaveBeenCalledTimes(2);
    const u = fixture(), errorGetter = vi.fn(() => privateMarker);
    u.evaluate.mockRejectedValue(Object.defineProperty(new ErpError('service_unavailable', 503), 'code', { get: errorGetter }));
    await error(await u.handlers.GET(u.request(), organizationId), 'service_unavailable', 503); expect(errorGetter).not.toHaveBeenCalled(); expect(JSON.stringify(u.diagnostic.mock.calls)).not.toContain(privateMarker);
  });
});
