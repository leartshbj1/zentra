import { describe, expect, it, vi } from 'vitest';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { createUsTaxMerchantReadinessEvaluator } from './us-tax-merchant-readiness';
import type { ResolvedUsTaxTestMerchant } from './us-tax-merchant-resolver';
import type { UsTaxMerchantStore } from './us-tax-merchant-store';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import type { UsTaxReadinessEvaluationInput } from './us-tax-readiness';

const organizationId = 'fictitious-merchant-readiness';
const origin = { country: 'US' as const, line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
const configuration = { schemaVersion: 1 as const, organizationId, country: 'US' as const, currency: 'USD' as const, language: 'en' as const, timeZone: 'America/New_York', address: origin, accountingBasis: 'accrual' as const, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' as const } };
const credential = { reference: 'fictitious-test-only', revision: 1, accountId: 'acct_FictitiousMerchant' };
const fingerprint = 'a'.repeat(64);

/** Injected private observations only: no real Stripe account or credential. */
function fixture(role: FinancialAuthority['role'] = 'owner') {
  let clock = Date.parse('2026-10-10T10:00:00.000Z'), currentRole = role, entitled = true, userId = 'fictitious-user';
  let gate = true;
  const now = () => new Date(clock).toISOString();
  const actor = (): FinancialAuthority => ({ organizationId, userId, role: currentRole, managementEntitled: entitled, timestamp: now() });
  const context: UsTaxFinancialContext = { organizationId, actor: actor(), recordedAt: now(), countryRevision: 2, configuration, sellerRevision: 1, seller: { displayName: 'Fictitious Seller' }, taxFactsRevision: 1, taxFacts: { schemaVersion: 1, legalName: 'Private Fictitious Entity', taxOrigin: origin, timeZone: configuration.timeZone }, binding: { organizationId, accountId: credential.accountId, mode: 'test', apiVersion: '2026-08-26.dahlia', revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: now(), validUntil: '2026-10-10T10:02:00.000Z', evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' } };
  const verify = vi.fn(async (_context: UsTaxFinancialContext) => {});
  const observe = vi.fn();
  const originalMerchant: ResolvedUsTaxTestMerchant = { credential, configurationFingerprint: fingerprint, observe, gateway: { verify, calculate: vi.fn() } };
  let selected: ResolvedUsTaxTestMerchant | null = originalMerchant;
  const merchant = vi.fn(async () => selected);
  const read = vi.fn(async () => structuredClone(context));
  const readCredential = vi.fn(async () => ({ credential, configurationFingerprint: fingerprint }) as { credential: typeof credential; configurationFingerprint: string } | null);
  const store = { readCredential } as unknown as UsTaxMerchantStore;
  const contexts = vi.fn(async () => ({ read }));
  const revalidate = vi.fn(async () => actor());
  const input: UsTaxReadinessEvaluationInput = { actor: actor(), configuration, state: {} as UsTaxReadinessEvaluationInput['state'], effectiveSchemaVersion: 4, revalidate };
  const evaluate = createUsTaxMerchantReadinessEvaluator({ enabled: () => gate, merchant, contexts, store: async () => store, now });
  return { input, evaluate, merchant, contexts, context, read, readCredential, verify, observe, revalidate, originalMerchant,
    setRole: (value: FinancialAuthority['role']) => { currentRole = value; },
    setEntitled: (value: boolean) => { entitled = value; }, setUser: (value: string) => { userId = value; },
    setGate: (value: boolean) => { gate = value; }, setMerchant: (value: ResolvedUsTaxTestMerchant | null) => { selected = value; },
    advance: (milliseconds: number) => { clock += milliseconds; },
  };
}

describe('admitted TEST merchant readiness wiring', () => {
  it.each(['owner', 'admin', 'accountant'] as const)('keeps the actual financial %s and verifies the current merchant', async role => {
    const t = fixture(role);
    expect(await t.evaluate(t.input)).toEqual({ status: 'ready_test', validUntil: Date.parse(t.context.binding.validUntil) / 1000 });
    expect(t.readCredential).toHaveBeenCalledWith(expect.objectContaining({ role }), 1);
    expect(t.verify).toHaveBeenCalledOnce(); expect(t.observe).not.toHaveBeenCalled();
    expect(t.revalidate.mock.results.length).toBeGreaterThan(5);
  });
  it.each(['member', 'read_only'] as const)('does not resolve private resources for %s', async role => {
    const t = fixture(role); expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'financial_role_required' });
    expect(t.merchant).not.toHaveBeenCalled(); expect(t.read).not.toHaveBeenCalled();
  });
  it('blocks absent merchant without financial storage or provider calls', async () => {
    const t = fixture(); t.setMerchant(null);
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' });
    expect(t.contexts).not.toHaveBeenCalled(); expect(t.verify).not.toHaveBeenCalled();
  });
  it('does not accept a legacy binding with no immutable activation receipt', async () => {
    const t = fixture(); t.readCredential.mockResolvedValue(null);
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' }); expect(t.verify).not.toHaveBeenCalled();
  });
  it.each([
    { credential: { ...credential, accountId: 'acct_OtherMerchant' }, configurationFingerprint: fingerprint },
    { credential: { ...credential, revision: 2 }, configurationFingerprint: fingerprint },
    { credential: { ...credential, reference: 'other' }, configurationFingerprint: fingerprint },
    { credential, configurationFingerprint: 'd'.repeat(64) },
  ])('rejects rotated or mismatched admitted provenance %j', async changed => {
    const t = fixture(); t.readCredential.mockResolvedValue(changed);
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' }); expect(t.verify).not.toHaveBeenCalled();
  });
  it('rejects a financial context from another provider account', async () => {
    const t = fixture(); (t.context.binding as { accountId: string }).accountId = 'acct_Other';
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' }); expect(t.verify).not.toHaveBeenCalled();
  });
  it('rejects key rotation while a provider call is in flight', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { t.setMerchant({ ...t.originalMerchant, configurationFingerprint: 'd'.repeat(64) }); });
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' });
  });
  it.each(['countryRevision', 'sellerRevision', 'taxFactsRevision'] as const)('rereads durable %s after the provider returns', async field => {
    const t = fixture(); t.verify.mockImplementation(async () => { (t.context as unknown as Record<string, number>)[field] += 1; });
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'configuration_outdated' });
    expect(t.read).toHaveBeenCalledTimes(2); expect(t.readCredential).toHaveBeenCalledTimes(2);
  });
  it('rejects changed facts even if a broken store reuses the revision', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { (t.context.taxFacts.taxOrigin as { line1: string }).line1 = 'Different origin'; });
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'configuration_outdated' });
  });
  it('rejects a concurrent binding renewal after provider verification', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { (t.context.binding as { revision: number }).revision += 1; });
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'configuration_outdated' });
  });
  it('allows only read/authority timestamp renewal after the provider', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { t.advance(1); (t.context as { recordedAt: string }).recordedAt = '2026-10-10T10:00:00.001Z'; (t.context as { actor: FinancialAuthority }).actor = { ...t.input.actor, timestamp: '2026-10-10T10:00:00.001Z' }; });
    expect(await t.evaluate(t.input)).toEqual({ status: 'ready_test', validUntil: Date.parse(t.context.binding.validUntil) / 1000 });
  });
  it.each([
    ['role', (t: ReturnType<typeof fixture>) => t.setRole('read_only'), 'forbidden', 403],
    ['entitlement', (t: ReturnType<typeof fixture>) => t.setEntitled(false), 'management_entitlement_required', 402],
    ['session', (t: ReturnType<typeof fixture>) => t.setUser('different-user'), 'session_changed', 401],
    ['gate', (t: ReturnType<typeof fixture>) => t.setGate(false), 'feature_unavailable', 404],
  ] as const)('withholds successful reads after loss of %s', async (_name, change, code, status) => {
    const t = fixture(); t.verify.mockImplementation(async () => { change(t); });
    await expect(t.evaluate(t.input)).rejects.toMatchObject({ code, status });
  });
  it('prioritizes revoked admission over a failed provider', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { t.setUser('revoked'); throw new ErpError('binding_unavailable', 409); });
    await expect(t.evaluate(t.input)).rejects.toMatchObject({ code: 'session_changed', status: 401 });
  });
  it('prioritizes revoked admission over a resolver failure', async () => {
    const t = fixture(); t.merchant.mockImplementation(async () => { t.setEntitled(false); throw new Error('PRIVATE KEY'); });
    await expect(t.evaluate(t.input)).rejects.toMatchObject({ code: 'management_entitlement_required', status: 402 });
    expect(t.read).not.toHaveBeenCalled();
  });
  it('refuses a provider response completing at the total deadline', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { t.advance(30_000); });
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' });
  });
  it('detects a backwards clock without granting readiness', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { t.advance(-1); });
    await expect(t.evaluate(t.input)).rejects.toMatchObject({ code: 'server_clock_unavailable', status: 503 });
  });
  it('keeps the generic provider error rather than fabricating zero tax', async () => {
    const t = fixture(); t.verify.mockRejectedValue(new ErpError('binding_unavailable', 409));
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' });
    expect(t.originalMerchant.gateway.calculate).not.toHaveBeenCalled();
  });
});
