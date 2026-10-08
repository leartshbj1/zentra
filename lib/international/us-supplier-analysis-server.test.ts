import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { usStarterChart } from './countries/us/accounting';
import { ErpError } from './erp-contract';
import { createUsAnalysisSettingsHandlers, type UsAnalysisSettingsDependencies } from './us-supplier-analysis-server';
import type { UsAutomationGrant, UsAutomationSettings, UsAutomationSettingsRequest, UsAutomationStore } from './us-automation-contract';
import { parseUsAutomationBudgetPolicy, UsAutomationPolicyError } from './us-automation-policy';
import type { ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { ErpReadAdmission } from './read-admission';

const org = '54b7ee3b-5753-4af1-98f6-b2a568fb3890', user = '53e1704e-9cc6-431b-ac4d-2186c5fe5f6d';
const actor: FinancialAuthority = { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const now = Date.parse(actor.timestamp) / 1000;
const config: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const policy = parseUsAutomationBudgetPolicy({ schemaVersion: 1, cadence: 'utc_calendar_month', budgetPolicyVersion: 'budget-test', processingPolicyVersion: 'processing-test', entries: [{ catalogVersion: 'catalog-test', priceId: 'price_fictitious', limit: 10 }] });
const grant: UsAutomationGrant = { schemaVersion: 1, organizationId: org, environment: 'TEST', bucket: 'supplier_invoice_extract', periodId: '2026-10', periodStart: Date.UTC(2026, 9, 1) / 1000, periodEnd: Date.UTC(2026, 10, 1) / 1000, limit: 10, subscriptionId: 'sub_fictitious', authorityReference: 'test-fictitious-authority', catalogVersion: 'catalog-test', priceId: 'price_fictitious', budgetPolicyVersion: policy.budgetPolicyVersion, processingPolicyVersion: policy.processingPolicyVersion, checkedAt: now };
const requestId = '10000000-0000-4000-8000-000000000001';
const change = { schemaVersion: 1, requestId, expectedRevision: 1, mode: 'active', policyVersion: policy.processingPolicyVersion, consent: true };

/** Actual Request/Response handler; all admission/settings/quota/book ports are
 * explicit in-memory TEST fixtures. This is not hosted Auth or PostgreSQL. */
function fixture() {
  let admission: ErpReadAdmission = { mode: 'browser', actor: { ...actor } };
  let settings: UsAutomationSettings = { schemaVersion: 1, organizationId: org, revision: 1, enabled: true, consent: { processingPolicyVersion: policy.processingPolicyVersion, acceptedBy: user, acceptedAt: actor.timestamp } };
  let currentPolicy = policy, consumed = 2, held = 1;
  let book: ErpState = { schemaVersion: 4, revision: 10, configuration: config, counters: { estimate: 0, invoice: 0, project: 0 }, ledger: createLedger({ organizationId: org, currency: 'USD', basis: 'accrual', accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }), customers: [], estimates: [], invoices: [], vendors: [], vendorBills: [], vendorPayments: [], projects: [] };
  const saved = new Map<string, { input: string; settings: UsAutomationSettings }>();
  const analysis: UsAutomationStore = { supportedSchemaVersion: 4,
    readSettings: vi.fn(async () => structuredClone(settings)),
    saveSettings: vi.fn(async (who, request: UsAutomationSettingsRequest) => {
      const prior = saved.get(request.requestId), body = JSON.stringify(request);
      if (prior) { if (prior.input !== body) throw new ErpError('automation_idempotency_conflict', 409); return { settings: structuredClone(prior.settings), replayed: true }; }
      if (request.expectedRevision !== settings.revision) throw new ErpError('automation_revision_conflict', 409);
      settings = { ...settings, revision: settings.revision + 1, enabled: request.action === 'activate', consent: request.action === 'activate' ? { processingPolicyVersion: request.processingPolicyVersion, acceptedBy: who.userId, acceptedAt: who.timestamp } : settings.consent };
      saved.set(request.requestId, { input: body, settings: structuredClone(settings) }); return { settings: structuredClone(settings), replayed: false };
    }),
    usage: vi.fn<UsAutomationStore['usage']>(async (_who, current) => ({ schemaVersion: 1, organizationId: org, environment: current.environment, bucket: current.bucket, periodId: current.periodId, limit: current.limit, held, consumed, remaining: Math.max(0, current.limit - held - consumed) })),
    claim: vi.fn(async () => { throw new Error('Settings must never claim'); }), dispatch: vi.fn(async () => { throw new Error('Settings must never dispatch'); }), complete: vi.fn(async () => { throw new Error('Settings must never complete'); }), markUncertain: vi.fn(async () => { throw new Error('Settings must never mutate jobs'); }), read: vi.fn(async () => null), findSource: vi.fn(async () => null), expireHeld: vi.fn(async () => 0),
  };
  const erp: ErpStore = { supportedSchemaVersion: 4, read: vi.fn(async () => structuredClone(book)), receipt: vi.fn(async () => null), commit: vi.fn(async () => { throw new Error('No financial mutation'); }) };
  const dependencies: UsAnalysisSettingsDependencies = {
    enabled: vi.fn(() => true), authority: vi.fn(async () => structuredClone(admission)), configuration: vi.fn(async () => structuredClone(config)), store: vi.fn(async () => erp), freshSupportedSchemaVersion: vi.fn(async () => 4 as const), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn(),
    automationAccess: vi.fn(async () => {}), analysisStore: vi.fn(async () => analysis), policy: vi.fn(async () => structuredClone(currentPolicy)), grant: vi.fn(async (_who, p) => ({ ...grant, limit: p.entries[0].limit, budgetPolicyVersion: p.budgetPolicyVersion, processingPolicyVersion: p.processingPolicyVersion })), providerReady: vi.fn(async () => true), now: () => now,
  };
  const handlers = createUsAnalysisSettingsHandlers(dependencies);
  const request = (method = 'GET', body?: unknown, options: { origin?: string; cap?: string; expectedUser?: string; query?: string } = {}) => new Request(`https://zentra.test/api/international/workspaces/${org}/supplier-analysis-settings${options.query ?? ''}`, { method, headers: { 'X-Zentra-Erp-Schema-Version': options.cap ?? '4', 'X-Zentra-Expected-User': options.expectedUser ?? user, ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: options.origin ?? 'https://zentra.test' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? change) } : {}) });
  return { dependencies, analysis, erp, handlers, request, get: () => handlers.GET(request(), org), post: (body: unknown = change) => handlers.POST(request('POST', body), org), saved,
    setAdmission: (value: ErpReadAdmission) => { admission = value; }, setSettings: (value: UsAutomationSettings) => { settings = value; }, settings: () => settings,
    setPolicy: (value: typeof policy) => { currentPolicy = value; }, setUsage: (used: number, reserved: number) => { consumed = used; held = reserved; }, setBook: (value: ErpState) => { book = value; }, book: () => book,
  };
}
async function failure(response: Response, error: string, status: number) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error }); expect(response.headers.get('Cache-Control')).toContain('no-store');
}

describe('US analysis settings HTTP: authority and quota ports injected', () => {
  it('returns a minimal bounded readiness without provider/source/subscription/evidence or writes', async () => {
    const t = fixture(), response = await t.get(), body = await response.json();
    expect(response.status).toBe(200); expect(body).toEqual({ schemaVersion: 1, organizationId: org, revision: 1, mode: 'active', availability: 'ready', reason: null, mayConfigure: true, policyVersion: policy.processingPolicyVersion, acceptedPolicyVersion: policy.processingPolicyVersion, quota: { limit: 10, used: 2, reserved: 1, remaining: 7, periodStart: grant.periodStart, periodEnd: grant.periodEnd }, checkedAt: now, expiresAt: now + 120 });
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(t.analysis.saveSettings).not.toHaveBeenCalled(); expect(t.analysis.claim).not.toHaveBeenCalled(); expect(t.erp.commit).not.toHaveBeenCalled();
    for (const secret of ['subscriptionId', 'authorityReference', 'priceId', 'apiKey', 'leaseToken', 'documentText']) expect(JSON.stringify(body)).not.toContain(secret);
  });
  it.each(['paused', 'policy_unconfigured', 'quota_unconfigured', 'provider_unconfigured', 'quota_exhausted', 'consent_required'] as const)('exposes %s as a controlled blocker, never a fabricated quota grant', async reason => {
    const t = fixture();
    if (reason === 'paused') t.setSettings({ ...t.settings(), enabled: false });
    if (reason === 'policy_unconfigured') t.dependencies.policy = async () => null;
    if (reason === 'quota_unconfigured') t.dependencies.grant = async () => { throw new UsAutomationPolicyError('automation_budget_unavailable'); };
    if (reason === 'provider_unconfigured') t.dependencies.providerReady = async () => false;
    if (reason === 'quota_exhausted') t.setUsage(20, 2);
    if (reason === 'consent_required') t.setSettings({ ...t.settings(), consent: { ...t.settings().consent!, processingPolicyVersion: 'old-policy' } });
    const response = await t.get(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ availability: 'blocked', reason }); expect(t.analysis.claim).not.toHaveBeenCalled();
  });
  it.each(['member', 'read_only'] as const)('refuses %s before any settings/book/private quota reads', async role => {
    const t = fixture(); t.setAdmission({ mode: 'browser', actor: { ...actor, role } });
    await failure(await t.get(), 'financial_permission_required', 403); expect(t.dependencies.store).not.toHaveBeenCalled(); expect(t.analysis.readSettings).not.toHaveBeenCalled(); expect(t.dependencies.grant).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])('refuses captured/client capability%s without touching the analysis store', async cap => {
    const t = fixture(); await failure(await t.handlers.GET(t.request('GET', undefined, { cap: String(cap) }), org), 'automation_upgrade_required', 409); expect(t.dependencies.analysisStore).not.toHaveBeenCalled();
  });
  it('requires current Gestion and Automation rights, an initialized US book4 and enabled flags', async () => {
    const t = fixture(); t.dependencies.automationAccess = async () => { throw new ErpError('automation_entitlement_required', 402); };
    await failure(await t.get(), 'automation_entitlement_required', 402); expect(t.dependencies.store).not.toHaveBeenCalled();
    const noBook = fixture(); noBook.erp.read = async () => null; await failure(await noBook.get(), 'configuration_changed', 409); expect(noBook.analysis.readSettings).not.toHaveBeenCalled();
    const oldBook = fixture(); oldBook.setBook({ ...oldBook.book(), schemaVersion: 3 }); await failure(await oldBook.get(), 'configuration_changed', 409);
    const off = fixture(); off.dependencies.enabled = () => false; await failure(await off.get(), 'feature_unavailable', 404); expect(off.dependencies.authority).not.toHaveBeenCalled();
  });
  it('rejects cross-origin browser activation before quota or write ports', async () => {
    const t = fixture(); await failure(await t.handlers.POST(t.request('POST', change, { origin: 'https://evil.test' }), org), 'forbidden', 403); expect(t.analysis.saveSettings).not.toHaveBeenCalled(); expect(t.dependencies.store).not.toHaveBeenCalled();
  });
  it('allows the device admission mode without cookie CSRF fallback while preserving authority', async () => {
    const t = fixture(); t.setAdmission({ mode: 'device', actor });
    const response = await t.handlers.POST(t.request('POST', change, { origin: 'https://evil.test' }), org); expect(response.status).toBe(200); expect(t.analysis.saveSettings).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale expected user or cross-tenant admission before private reads', async () => {
    const t = fixture(); await failure(await t.handlers.GET(t.request('GET', undefined, { expectedUser: 'different-user' }), org), 'session_changed', 401); expect(t.dependencies.store).not.toHaveBeenCalled();
    await failure(await t.handlers.GET(t.request(), '10000000-0000-4000-8000-000000000002'), 'tenant_mismatch', 403);
  });
  it('allows only owner activation and owner/admin pause, while accountants may read quota', async () => {
    for (const role of ['admin', 'accountant'] as const) {
      const t = fixture(); t.setAdmission({ mode: 'browser', actor: { ...actor, role } });
      expect((await t.get()).status).toBe(200); await failure(await t.post(), 'automation_permission_required', 403);
      const paused = await t.post({ ...change, mode: 'paused', policyVersion: null, consent: false });
      if (role === 'admin') expect(paused.status).toBe(200); else await failure(paused, 'automation_permission_required', 403);
    }
  });
  it.each([{ consent: false }, { policyVersion: 'old-policy' }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { requestId: 'not-uuid' }, { role: 'owner' }, { quota: 1000000 }, { apiKey: 'private' }, { mode: 'other' }])('rejects malformed or caller-supplied rights %j before mutation', async patch => {
    const t = fixture(), response = await t.post({ ...change, ...patch }); expect([409, 422]).toContain(response.status); expect(t.analysis.saveSettings).not.toHaveBeenCalled();
  });
  it('rejects excess bytes and query parameters without executing settings writes', async () => {
    const t = fixture(); await failure(await t.handlers.GET(t.request('GET', undefined, { query: '?quota=100' }), org), 'invalid_request', 422);
    const response = await t.post({ ...change, private: 'x'.repeat(4096) }); expect(response.status).toBe(413); expect(t.analysis.saveSettings).not.toHaveBeenCalled();
  });
  it('returns historical CAS receipt with the current head and keeps exact request replay semantics', async () => {
    const t = fixture(); const first = await (await t.post()).json();
    expect(first).toMatchObject({ settings: { revision: 2, mode: 'active' }, receipt: { requestId, revision: 2 }, replayed: false });
    t.setSettings({ ...t.settings(), revision: 4, enabled: false });
    expect(await (await t.post()).json()).toMatchObject({ settings: { revision: 4, mode: 'paused', reason: 'paused' }, receipt: { requestId, revision: 2, mode: 'active' }, replayed: true });
    expect(t.saved.size).toBe(1); await failure(await t.post({ ...change, mode: 'paused', policyVersion: null, consent: false }), 'automation_idempotency_conflict', 409);
    await failure(await t.post({ ...change, requestId: '10000000-0000-4000-8000-000000000002' }), 'automation_revision_conflict', 409);
  });
  it('withholds a committed response on revocation then recovers the exact receipt without another mutation', async () => {
    const t = fixture(), original = t.analysis.saveSettings; let revoked = false;
    t.analysis.saveSettings = async (...args) => { const response = await original(...args); revoked = true; return response; };
    t.dependencies.automationAccess = async () => { if (revoked) throw new ErpError('automation_entitlement_required', 402); };
    await failure(await t.post(), 'automation_entitlement_required', 402); expect(t.saved.size).toBe(1);
    revoked = false; t.analysis.saveSettings = original; const response = await t.post(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replayed: true }); expect(t.saved.size).toBe(1);
  });
  it.each(['user', 'role', 'mode', 'rights', 'flag', 'cap', 'configuration'] as const)('withholds read disclosure after %s changes during quota observation', async kind => {
    const t = fixture(), original = t.analysis.usage;
    t.analysis.usage = async (...args) => { const value = await original(...args);
      if (kind === 'user') t.setAdmission({ mode: 'browser', actor: { ...actor, userId: 'another-user' } });
      if (kind === 'role') t.setAdmission({ mode: 'browser', actor: { ...actor, role: 'read_only' } });
      if (kind === 'mode') t.setAdmission({ mode: 'device', actor });
      if (kind === 'rights') t.dependencies.automationAccess = async () => { throw new ErpError('automation_entitlement_required', 402); };
      if (kind === 'flag') t.dependencies.enabled = () => false;
      if (kind === 'cap') t.dependencies.freshSupportedSchemaVersion = async () => 3 as const;
      if (kind === 'configuration') t.dependencies.configuration = async () => ({ ...config, timeZone: 'America/Chicago' }); return value;
    };
    await failure(await t.get(), kind === 'user' || kind === 'mode' ? 'session_changed' : kind === 'role' ? 'forbidden' : kind === 'rights' ? 'automation_entitlement_required' : kind === 'flag' ? 'feature_unavailable' : kind === 'cap' ? 'automation_upgrade_required' : 'configuration_changed', kind === 'user' || kind === 'mode' ? 401 : kind === 'role' ? 403 : kind === 'rights' ? 402 : kind === 'flag' ? 404 : 409);
  });
  it.each(['policy', 'pause'] as const)('refuses stale readiness after %s changes during the quota read', async kind => {
    const t = fixture(), original = t.analysis.usage;
    t.analysis.usage = async (...args) => { const value = await original(...args); if (kind === 'policy') t.setPolicy(parseUsAutomationBudgetPolicy({ ...policy, entries: [{ ...policy.entries[0], limit: 1 }] })); else t.setSettings({ ...t.settings(), enabled: false, revision: 2 }); return value; };
    await failure(await t.get(), 'configuration_changed', 409);
  });
  it('uses actual Auth rejection in preference to simultaneous flag/configuration failures, even after a private error', async () => {
    const t = fixture(); t.analysis.usage = async () => { t.dependencies.enabled = () => false; t.dependencies.configuration = async () => { throw new Error('PRIVATE SQL'); }; t.dependencies.authority = async () => { throw new AccountPublicError('PRIVATE AUTH TOKEN', 401); }; throw new Error('PRIVATE QUOTA'); };
    await failure(await t.get(), 'unauthorized', 401); expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toContain('PRIVATE');
  });
  it('rechecks flags after a slow Automation-rights read', async () => {
    const t = fixture(); let count = 0; t.dependencies.automationAccess = async () => { if (++count === 2) t.dependencies.enabled = () => false; };
    await failure(await t.get(), 'feature_unavailable', 404); expect(t.analysis.saveSettings).not.toHaveBeenCalled();
  });
  it.each(['tenant', 'revision', 'enabled', 'consent-policy', 'consent-actor'] as const)('rejects a malformed durable settings %s receipt', async kind => {
    const t = fixture(), original = t.analysis.saveSettings;
    t.analysis.saveSettings = async (...args) => { const result = await original(...args);
      if (kind === 'tenant') return { ...result, settings: { ...result.settings, organizationId: '10000000-0000-4000-8000-000000000002' } };
      if (kind === 'revision') return { ...result, settings: { ...result.settings, revision: 99 } };
      if (kind === 'enabled') return { ...result, settings: { ...result.settings, enabled: false } };
      return { ...result, settings: { ...result.settings, consent: { ...result.settings.consent!, ...(kind === 'consent-policy' ? { processingPolicyVersion: 'different-policy' } : { acceptedBy: 'different-owner' }) } } };
    };
    // A malformed internal acknowledgement is a private-record failure;
    // caller request validation remains a separate 422 boundary above.
    await failure(await t.post(), 'invalid_automation_record', 503);
  });
  it('normalizes unknown and mismatched error codes, with no raw payload in diagnostics', async () => {
    for (const error of [new Error('PRIVATE PROVIDER KEY'), new ErpError('private_database_field', 403), new ErpError('unauthorized', 503)]) {
      const t = fixture(); t.analysis.readSettings = async () => { throw error; }; await failure(await t.get(), 'service_unavailable', 503);
      expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toContain('PRIVATE'); expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toContain('database');
    }
  });
  it('keeps rate-limit status429 and does no settings/provider/quota work after refusal', async () => {
    const t = fixture(); t.dependencies.rateLimit = async () => { throw new AccountPublicError('PRIVATE RATE', 429); };
    await failure(await t.get(), 'rate_limited', 429); expect(t.dependencies.analysisStore).not.toHaveBeenCalled(); expect(t.dependencies.providerReady).not.toHaveBeenCalled();
  });
});
