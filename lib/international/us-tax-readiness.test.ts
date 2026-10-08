import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import {
  createUsTaxReadinessEvaluator, US_TAX_READINESS_REASONS, validateUsTaxReadiness,
  type UsTaxReadinessEvaluationInput,
} from './us-tax-readiness';

const organizationId = 'fictitious-readiness', now = Date.parse('2026-10-08T12:00:00Z') / 1000;
const address = { country: 'US' as const, line1: 'PRIVATE Fictitious Origin', city: 'New York', subdivision: 'NY', postalCode: '10001' };
const configuration = { schemaVersion: 1 as const, organizationId, country: 'US' as const, currency: 'USD' as const, language: 'en' as const, timeZone: 'America/New_York', address, accountingBasis: 'accrual' as const, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' as const } };
const actor: FinancialAuthority = { organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.123Z' };
const publicReadiness = { schemaVersion: 1, organizationId, currency: 'USD', effectiveSchemaVersion: 4, checkedAt: now, expiresAt: now + 120, status: 'ready_test' };
/** These are injected observations, not actual Stripe/settings evidence. */
function fixture() {
  let clock = now, current = actor;
  const context: UsTaxFinancialContext = { organizationId, actor, recordedAt: '2026-10-08T12:00:00.123456Z', countryRevision: 1, configuration, sellerRevision: 1, seller: { displayName: 'Fictitious public seller' }, taxFactsRevision: 1, taxFacts: { schemaVersion: 1, legalName: 'PRIVATE Fictitious Entity', taxOrigin: address, timeZone: 'America/New_York' }, binding: { organizationId, accountId: 'acct_FictitiousReadiness', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'a'.repeat(64), registrationsSha256: 'b'.repeat(64), observedAt: '2026-10-08T11:59:59.999999Z', validUntil: '2026-10-08T12:00:10.123456Z', evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' } };
  const read = vi.fn(async () => structuredClone(context)), verify = vi.fn(async (_context: UsTaxFinancialContext) => {});
  const revalidate = vi.fn(async () => current);
  const input = { actor, configuration, state: {} as UsTaxReadinessEvaluationInput['state'], effectiveSchemaVersion: 4, revalidate } satisfies UsTaxReadinessEvaluationInput;
  const evaluate = createUsTaxReadinessEvaluator({ contexts: { read }, gateway: { verify }, now: () => clock });
  return { context, read, verify, revalidate, input, evaluate, setClock: (value: number) => { clock = value; }, setActor: (value: FinancialAuthority) => { current = value; } };
}

describe('tax readiness exact public projection', () => {
  it.each(US_TAX_READINESS_REASONS)('accepts only the bounded blocked reason %s', reason => {
    const value = validateUsTaxReadiness({ ...publicReadiness, status: 'blocked', reason });
    expect(Object.isFrozen(value)).toBe(true); expect(Object.keys(value)).toHaveLength(8);
  });
  it('accepts a short integer-second TEST lifetime', () => {
    expect(validateUsTaxReadiness({ ...publicReadiness, expiresAt: now + 1 })).toEqual({ ...publicReadiness, expiresAt: now + 1 });
  });
  it.each([
    { schemaVersion: 2 }, { currency: 'CHF' }, { organizationId: '../CH' }, { effectiveSchemaVersion: 5 },
    { effectiveSchemaVersion: '4' }, { checkedAt: now + .5 }, { expiresAt: now }, { expiresAt: now + 121 },
    { status: 'ready' }, { reason: 'PRIVATE' }, { providerAccount: 'acct_PRIVATE' }, { proof: 'PRIVATE' },
  ])('rejects malformed or additional public fields %j', patch => {
    expect(() => validateUsTaxReadiness({ ...publicReadiness, ...patch })).toThrowError(expect.objectContaining({ code: 'invalid_tax_readiness' }));
  });
  it('does not evaluate an accessor or serialize an unknown prototype', () => {
    const get = vi.fn(() => 'PRIVATE');
    expect(() => validateUsTaxReadiness(Object.defineProperty({ ...publicReadiness }, 'status', { enumerable: true, get }))).toThrow();
    expect(get).not.toHaveBeenCalled(); expect(() => validateUsTaxReadiness(Object.assign(Object.create({ proof: 'PRIVATE' }), publicReadiness))).toThrow();
  });
});

describe('read-only observed TEST readiness evaluator', () => {
  it('defaults to blocked without reading private facts or verifying a provider', async () => {
    const t = fixture(), evaluate = createUsTaxReadinessEvaluator({ now: () => now });
    expect(await evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_test_unavailable' }); expect(t.read).not.toHaveBeenCalled();
  });
  it.each(['member', 'read_only'] as const)('blocks %s without owner-private reads', async role => {
    const t = fixture(); expect(await t.evaluate({ ...t.input, actor: { ...actor, role } })).toEqual({ status: 'blocked', reason: 'financial_role_required' });
    expect(t.read).not.toHaveBeenCalled(); expect(t.verify).not.toHaveBeenCalled();
  });
  it.each(['owner', 'admin', 'accountant'] as const)('only verifies the actual %s context and returns no private fields', async role => {
    const t = fixture(), admitted = { ...actor, role }; t.setActor(admitted); Object.assign(t.context, { actor: admitted });
    expect(await t.evaluate({ ...t.input, actor: admitted })).toEqual({ status: 'ready_test', validUntil: now + 10 });
    expect(t.verify).toHaveBeenCalledTimes(1); expect(t.verify.mock.calls[0][0]).toEqual(t.context); expect(t.revalidate).toHaveBeenCalledTimes(4);
  });
  it.each([
    { evidenceKind: 'test_fixture', reason: 'provider_test_unavailable' },
    { mode: 'live', reason: 'provider_test_unavailable' },
    { apiVersion: 'obsolete', reason: 'provider_test_unavailable' },
    { scope: 'billing', reason: 'scope_not_supported' },
    { validUntil: '2026-10-08T12:00:00.999999Z', reason: 'provider_observation_expired' },
    { observedAt: '2026-10-08T12:00:01Z', reason: 'provider_test_unavailable' },
  ])('rejects non-observed or unsupported binding before verify %j', ({ reason, ...patch }) => {
    const t = fixture(); Object.assign(t.context.binding, patch);
    return expect(t.evaluate(t.input)).resolves.toEqual({ status: 'blocked', reason }).then(() => expect(t.verify).not.toHaveBeenCalled());
  });
  it('withdraws readiness if the observation expires during verify', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { t.setClock(now + 10); });
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: 'provider_observation_expired' });
  });
  it.each(['seller_configuration_required', 'tax_details_required', 'country_configuration_required'] as const)('maps a known missing setup %s after fresh admission', async code => {
    const t = fixture(); t.read.mockRejectedValue(new ErpError(code, 409));
    expect(await t.evaluate(t.input)).toEqual({ status: 'blocked', reason: code }); expect(t.revalidate).toHaveBeenCalledTimes(2); expect(t.verify).not.toHaveBeenCalled();
  });
  it('preserves Auth refusal after even a private read error', async () => {
    const t = fixture(), denied = new AccountPublicError('PRIVATE', 401);
    t.read.mockImplementation(async () => { t.revalidate.mockRejectedValue(denied); throw new Error('PRIVATE'); });
    await expect(t.evaluate(t.input)).rejects.toBe(denied); expect(t.verify).not.toHaveBeenCalled();
  });
  it('rejects a role change during verify and any reversed trusted clock', async () => {
    const t = fixture(); t.verify.mockImplementation(async () => { t.setActor({ ...actor, role: 'member' }); });
    await expect(t.evaluate(t.input)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const u = fixture(); u.read.mockImplementation(async () => { u.setClock(now - 1); return u.context; });
    await expect(u.evaluate(u.input)).rejects.toMatchObject({ code: 'server_clock_unavailable', status: 503 });
  });
  it('rejects private getters without invocation and never treats a foreign tenant as verified', async () => {
    const t = fixture(), getter = vi.fn(() => 'PRIVATE');
    t.read.mockResolvedValue(Object.defineProperty({ ...t.context }, 'binding', { get: getter, enumerable: true }));
    await expect(t.evaluate(t.input)).rejects.toThrow(); expect(getter).not.toHaveBeenCalled(); expect(t.verify).not.toHaveBeenCalled();
    const u = fixture(); Object.assign(u.context.binding, { organizationId: 'CH-other' });
    await expect(u.evaluate(u.input)).rejects.toThrow(); expect(u.verify).not.toHaveBeenCalled();
  });
  it('snapshots caller/context before provider await so mutable inputs cannot switch tenant or grant a role', async () => {
    const t = fixture(), input = { ...t.input, actor: { ...actor } };
    t.read.mockImplementation(async () => { input.actor.organizationId = 'other-tenant'; return t.context; });
    expect(await t.evaluate(input)).toEqual({ status: 'ready_test', validUntil: now + 10 });
    expect(t.verify.mock.calls[0][0].organizationId).toBe(organizationId);
    const u = fixture(); u.verify.mockImplementation(async () => { Object.assign(u.context.binding, { evidenceKind: 'test_fixture' }); });
    expect(await u.evaluate(u.input)).toEqual({ status: 'ready_test', validUntil: now + 10 });
    expect(u.verify.mock.calls[0][0].binding.evidenceKind).toBe('provider_observation'); expect(Object.isFrozen(u.verify.mock.calls[0][0].binding)).toBe(true);
  });
  it('refuses cross-tenant configuration before reading private context', async () => {
    const t = fixture(); await expect(t.evaluate({ ...t.input, configuration: { ...configuration, organizationId: 'other' } })).rejects.toMatchObject({ code: 'invalid_tax_readiness' });
    expect(t.read).not.toHaveBeenCalled(); expect(t.verify).not.toHaveBeenCalled();
  });
});
