import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { SupabaseServerError } from '../supabase-server';
import { countryConfiguration } from './country-config';
import {
  getUsTaxProfile,
  putUsTaxProfile,
  resolveUsTaxConfiguration,
  validateUsTaxFacts,
  validateUsTaxProfileWrite,
  validateUsTaxProfileState,
  validateUsTaxProfileReceipt,
  type TaxProfileStore,
} from './us-tax-profile';

const actor = { organizationId: 'fictitious-us-tax', userId: 'fictitious-owner', role: 'owner' as const };
const facts = {
  schemaVersion: 1 as const,
  legalName: 'Fictitious US Seller',
  taxOrigin: { country: 'US' as const, line1: '1 Example Street', line2: 'Suite 2', postalCode: '10001-1234', city: 'New York', subdivision: 'NY' },
  timeZone: 'America/New_York',
};
const write = { expectedRevision: 0, requestId: 'a1000000-0000-4000-8000-000000000001', facts };
const declared = {
  status: 'declared', organizationId: actor.organizationId, revision: 1, facts,
  updatedBy: actor.userId, updatedAt: '2026-10-08T12:00:00.123456+00:00', verification: 'unverified',
};
const empty = { status: 'unconfigured', organizationId: actor.organizationId, revision: 0, verification: 'unverified' };
function fixture(value: unknown = { ...declared, requestId: write.requestId, replayed: false }) {
  const rpc = vi.fn(async (_name: string, _parameters: Readonly<Record<string, unknown>>): Promise<unknown> => structuredClone(value));
  const store: TaxProfileStore = { async rpc<T>(name: string, parameters: Readonly<Record<string, unknown>>): Promise<T> { return await rpc(name, parameters) as T; } };
  return { rpc, store };
}
function rawStore(value: unknown): TaxProfileStore {
  return { async rpc<T>(): Promise<T> { return value as T; } };
}

describe('private US declarative tax facts', () => {
  it('copies and deeply freezes canonical facts without confirming them', () => {
    const input = structuredClone({ ...write, requestId: write.requestId.toUpperCase(), facts: { ...facts, legalName: '\u00a0  Société Fictive  \ufeff' } });
    const result = validateUsTaxProfileWrite(input);
    expect(result).toEqual({ ...write, facts: { ...facts, legalName: 'Société Fictive' } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.facts)).toBe(true);
    expect(Object.isFrozen(result.facts.taxOrigin)).toBe(true);
    input.facts.taxOrigin.line1 = 'Changed address';
    input.facts.legalName = 'Changed name';
    expect(result.facts.taxOrigin.line1).toBe(facts.taxOrigin.line1);
    expect(result.facts.legalName).toBe('Société Fictive');
  });
  it('uses UTF16 limits without rejecting an allowed boundary', () => {
    expect(validateUsTaxFacts({ ...facts, legalName: '🟢'.repeat(128) }).legalName).toHaveLength(256);
    expect(() => validateUsTaxFacts({ ...facts, legalName: '🟢'.repeat(129) })).toThrow('invalid_request');
    expect(() => validateUsTaxFacts({ ...facts, legalName: ' '.repeat(256) + 'x' })).toThrow('invalid_request');
  });
  it.each((['legalName', 'line1', 'line2', 'city'] as const).flatMap(field =>
    ['\ud800', '\udc00'].map(surrogate => ({ field, surrogate })),
  ))('refuses isolated UTF16 $field before admission or RPC, surrogate=$surrogate', async ({ field, surrogate }) => {
    const malformed = `Bad${surrogate}Value`;
    const input = field === 'legalName' ? { ...facts, legalName: malformed } : { ...facts, taxOrigin: { ...facts.taxOrigin, [field]: malformed } };
    const t = fixture(), beforeWrite = vi.fn(async () => {});
    expect(() => validateUsTaxFacts(input)).toThrow('invalid_request');
    await expect(putUsTaxProfile(t.store, actor, { ...write, facts: input }, beforeWrite)).rejects.toMatchObject({ code: 'invalid_request', status: 422 });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([['legalName', 256], ['line1', 200], ['line2', 200], ['city', 120]] as const)('retains valid emoji pairs and the existing UTF16 boundary for %s', async (field, maximum) => {
    const boundary = '🟢'.repeat(maximum / 2);
    const input = field === 'legalName' ? { ...facts, legalName: boundary } : { ...facts, taxOrigin: { ...facts.taxOrigin, [field]: boundary } };
    const t = fixture({ ...declared, facts: input, requestId: write.requestId, replayed: false });
    expect((await putUsTaxProfile(t.store, actor, { ...write, facts: input })).facts).toEqual(input);
    expect(t.rpc).toHaveBeenCalledOnce();
    const excessive = field === 'legalName' ? { ...facts, legalName: `${boundary}x` } : { ...facts, taxOrigin: { ...facts.taxOrigin, [field]: `${boundary}x` } };
    expect(() => validateUsTaxFacts(excessive)).toThrow('invalid_request');
  });
  it.each(countryConfiguration('US').timeZones)('accepts the explicit US registry zone %s', timeZone => {
    expect(validateUsTaxFacts({ ...facts, timeZone }).timeZone).toBe(timeZone);
  });
  it('accepts an omitted optional address line without introducing a field', () => {
    const { line2: _line2, ...taxOrigin } = facts.taxOrigin;
    expect(validateUsTaxFacts({ ...facts, taxOrigin }).taxOrigin).toEqual(taxOrigin);
  });
  it.each(['organizationId', 'userId', 'role', 'verification', 'provider', 'providerAccount', 'environment', 'registrations', 'exemptions', 'taxRate', 'ein', 'authority', 'evidence', 'logoUrl'])('rejects injected facts field %s', field => {
    expect(() => validateUsTaxFacts({ ...facts, [field]: 'forged' })).toThrow('invalid_request');
  });
  it.each([
    null, [], {}, { ...facts, schemaVersion: 2 }, { ...facts, legalName: '' }, { ...facts, legalName: '\u00a0\ufeff' },
    { ...facts, legalName: 'x'.repeat(257) }, { ...facts, legalName: 'Legal\nName' }, { ...facts, legalName: 'Legal\u007fName' },
    { ...facts, timeZone: 'UTC' }, { ...facts, timeZone: 'Europe/Zurich' }, { ...facts, timeZone: 'America/New_York ' },
    { ...facts, taxOrigin: null }, { ...facts, taxOrigin: [] }, { ...facts, taxOrigin: { ...facts.taxOrigin, country: 'CH' } },
    { ...facts, taxOrigin: { ...facts.taxOrigin, subdivision: 'GE' } }, { ...facts, taxOrigin: { ...facts.taxOrigin, postalCode: '1001' } },
    { ...facts, taxOrigin: { ...facts.taxOrigin, city: ' New York' } }, { ...facts, taxOrigin: { ...facts.taxOrigin, line2: '' } },
    { ...facts, taxOrigin: { ...facts.taxOrigin, line2: null } }, { ...facts, taxOrigin: { ...facts.taxOrigin, line1: 'x'.repeat(201) } },
    { ...facts, taxOrigin: { ...facts.taxOrigin, city: 'x'.repeat(121) } }, { ...facts, taxOrigin: { ...facts.taxOrigin, taxCode: 'forged' } },
    { ...facts, taxOrigin: { ...facts.taxOrigin, city: 'New\tYork' } },
  ])('rejects malformed facts %j', input => {
    expect(() => validateUsTaxFacts(input)).toThrow('invalid_request');
  });
  it.each(['facts', 'taxOrigin', 'line1', 'schemaVersion'] as const)('never evaluates input getters at %s', field => {
    const getter = vi.fn(() => { throw new Error('private getter'); });
    const input = structuredClone(write);
    const target = field === 'facts' ? input : field === 'line1' ? input.facts.taxOrigin : input.facts;
    Object.defineProperty(target, field, { enumerable: true, get: getter });
    expect(() => validateUsTaxProfileWrite(input)).toThrow('invalid_request');
    expect(getter).not.toHaveBeenCalled();
  });
  it('refuses hidden, symbol and inherited fields without treating them as a grant', () => {
    expect(() => validateUsTaxFacts({ ...facts, [Symbol('authority')]: true })).toThrow('invalid_request');
    expect(() => validateUsTaxFacts(Object.defineProperty(structuredClone(facts), 'provider', { value: 'private' }))).toThrow('invalid_request');
    expect(() => validateUsTaxFacts(Object.assign(Object.create({ verification: 'verified' }), facts))).toThrow('invalid_request');
    expect(validateUsTaxFacts(Object.assign(Object.create(null), facts))).toEqual(facts);
  });
  it.each([
    null, [], {}, { ...write, expectedRevision: -1 }, { ...write, expectedRevision: 0.1 },
    { ...write, expectedRevision: Number.MAX_SAFE_INTEGER - 1 }, { ...write, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...write, expectedRevision: NaN }, { ...write, requestId: 'not-uuid' }, { ...write, requestId: ` ${write.requestId}` },
    { ...write, requestId: 'a1000000-0000-4000-7000-000000000001' }, { ...write, organizationId: actor.organizationId },
    { ...write, actor }, { ...write, verification: 'verified' },
  ])('rejects malformed envelope %j', input => {
    expect(() => validateUsTaxProfileWrite(input)).toThrow('invalid_request');
  });
  it('accepts the last exact safe expected revision', () => {
    expect(validateUsTaxProfileWrite({ ...write, expectedRevision: Number.MAX_SAFE_INTEGER - 2 }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER - 2);
  });
});

describe('owner-only private tax service and blocked resolver', () => {
  it('reads only its scoped private RPC and keeps verification unverified', async () => {
    const t = fixture(declared);
    expect(await getUsTaxProfile(t.store, actor)).toEqual(declared);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_read_us_tax_profile', { p_organization: actor.organizationId });
  });
  it.each(['admin', 'accountant', 'member', 'read_only'] as const)('refuses %s GET, PUT and resolver before SQL or hook', async role => {
    const t = fixture(), beforeWrite = vi.fn(async () => {}), unprivileged = { ...actor, role };
    await expect(getUsTaxProfile(t.store, unprivileged)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(putUsTaxProfile(t.store, unprivileged, write, beforeWrite)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(resolveUsTaxConfiguration(t.store, unprivileged)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { ...actor, organizationId: 'other tenant' }, { ...actor, organizationId: '' }, { ...actor, userId: '' },
    { ...actor, userId: 'owner\ncontrol' }, { ...actor, userId: 'owner\u007fcontrol' }, { ...actor, userId: 'x'.repeat(257) },
    { ...actor, role: 'superuser' },
  ])('refuses malformed internal identity %j before SQL', async invalidActor => {
    const t = fixture();
    await expect(getUsTaxProfile(t.store, invalidActor as typeof actor)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('captures internal identity descriptors without calling a role getter', async () => {
    const getter = vi.fn(() => 'owner');
    const unsafe = Object.defineProperty({ ...actor }, 'role', { enumerable: true, get: getter });
    const t = fixture();
    await expect(getUsTaxProfile(t.store, unsafe)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(getter).not.toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('accepts extra trusted financial metadata without using it as provider authority', async () => {
    const t = fixture(empty);
    const authority = { ...actor, managementEntitled: true, timestamp: '2026-10-08T12:00:00Z' };
    expect(await getUsTaxProfile(t.store, authority)).toEqual(empty);
  });
  it('validates and copies before fresh admission, then uses a single exact RPC', async () => {
    const t = fixture(), input = structuredClone(write), mutableActor = { ...actor };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const beforeWrite = vi.fn(() => held);
    const result = putUsTaxProfile(t.store, mutableActor, input, beforeWrite);
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(t.rpc).not.toHaveBeenCalled();
    input.requestId = 'a1000000-0000-4000-8000-000000000002';
    input.facts.legalName = 'Changed name';
    input.facts.taxOrigin.city = 'Changed city';
    mutableActor.organizationId = 'foreign';
    mutableActor.userId = 'other-owner';
    release();
    expect(await result).toEqual({ ...declared, requestId: write.requestId, replayed: false });
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_put_us_tax_profile', {
      p_organization: actor.organizationId, p_actor: actor.userId, p_expected_revision: 0, p_request_id: write.requestId, p_facts: facts,
    });
  });
  it('refuses malformed writes before evaluating fresh admission', async () => {
    const t = fixture(), beforeWrite = vi.fn(async () => {});
    await expect(putUsTaxProfile(t.store, actor, { ...write, facts: { ...facts, verification: 'verified' } }, beforeWrite)).rejects.toMatchObject({ code: 'invalid_request', status: 422 });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([401, 402, 403, 503])('preserves prewrite Auth error %i intact', async status => {
    const t = fixture(), revoked = new AccountPublicError('private auth metadata', status);
    await expect(putUsTaxProfile(t.store, actor, write, async () => { throw revoked; })).rejects.toBe(revoked);
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['PT001', 'revision_conflict', 409], ['PT002', 'request_id_conflict', 409], ['PT003', 'workspace_unavailable', 409],
    ['PT004', 'invalid_request', 422], ['PT005', 'service_unavailable', 503], ['private-sql-error', 'service_unavailable', 503],
  ] as const)('maps SQL %s to stable metadata, without privileged content', async (state, code, status) => {
    const t = fixture();
    t.rpc.mockRejectedValue(new SupabaseServerError(400, state));
    await expect(putUsTaxProfile(t.store, actor, write)).rejects.toMatchObject({ code, status, message: code });
    await expect(getUsTaxProfile(t.store, actor)).rejects.toMatchObject({ code, status, message: code });
  });
  it('does not treat missing schema or network failure as an unconfigured profile', async () => {
    const t = fixture();
    t.rpc.mockRejectedValue(new Error('private schema/password/provider response'));
    await expect(resolveUsTaxConfiguration(t.store, actor)).rejects.toMatchObject({ code: 'service_unavailable', status: 503, message: 'service_unavailable' });
    expect(t.rpc).toHaveBeenCalledOnce();
  });
  it('returns an exact old receipt, never a fabricated newer head', async () => {
    const t = fixture({ ...declared, requestId: write.requestId, replayed: true });
    expect(await putUsTaxProfile(t.store, actor, write)).toEqual({ ...declared, requestId: write.requestId, replayed: true });
    expect(t.rpc).toHaveBeenCalledOnce();
  });
  it.each([
    [empty, 'tax_details_required', 0], [declared, 'provider_verification_required', 1],
  ] as const)('resolves %j only to blocked metadata', async (state, reason, revision) => {
    const t = fixture(state);
    const result = await resolveUsTaxConfiguration(t.store, actor);
    expect(result).toEqual({ status: 'blocked', reason, organizationId: actor.organizationId, revision });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(facts.legalName);
    expect(Object.keys(result).sort()).toEqual(['organizationId', 'reason', 'revision', 'status']);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_read_us_tax_profile', { p_organization: actor.organizationId });
  });
});

describe('strict private tax projections and historical receipts', () => {
  it('owns immutable projections without sharing nested privileged objects', () => {
    const input = structuredClone(declared);
    const result = validateUsTaxProfileState(input, actor.organizationId);
    expect(result).toEqual(declared);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== 'declared') throw new Error('fixture must be declared');
    expect(Object.isFrozen(result.facts.taxOrigin)).toBe(true);
    input.facts.taxOrigin.line1 = 'Changed address';
    expect(result.facts.taxOrigin.line1).toBe(facts.taxOrigin.line1);
  });
  it.each([
    '2026-10-08', '2026-10-08T12:00:00', '2026-02-30T12:00:00Z', '2026-10-08T24:00:00Z',
    '2026-10-08T12:00:00+24:00', '2026-10-08T12:00:00.1234567Z', '0000-10-08T12:00:00Z', '2026-10-08T12:00:60Z',
  ])('refuses ambiguous or invalid timestamp %s', async updatedAt => {
    await expect(getUsTaxProfile(fixture({ ...declared, updatedAt }).store, actor)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
  });
  it.each(['2026-10-08T12:00:00.123456+00:00', '2026-10-08T12:00:00.1-04:00', '2026-10-08T12:00:00Z', '2024-02-29T23:59:59.999999Z'])('preserves valid original timestamp %s', async updatedAt => {
    const result = await putUsTaxProfile(fixture({ ...declared, updatedAt, requestId: write.requestId, replayed: true }).store, actor, write);
    expect(result.updatedAt).toBe(updatedAt);
  });
  it.each([
    null, { ...declared, organizationId: 'foreign' }, { ...declared, status: 'configured' }, { ...declared, verification: 'verified' },
    { ...declared, revision: 0 }, { ...declared, revision: 1.5 }, { ...declared, revision: Number.MAX_SAFE_INTEGER },
    { ...declared, facts: { ...facts, legalName: ' Padded' } }, { ...declared, facts: { ...facts, provider: 'forged' } },
    { ...declared, updatedBy: 'actor\ncontrol' }, { ...declared, updatedBy: '' }, { ...declared, authority: 'private' },
    { ...empty, organizationId: 'foreign' }, { ...empty, verification: 'verified' }, { ...empty, revision: 1 }, { ...empty, facts },
    { ...empty, updatedBy: actor.userId },
  ])('refuses malformed privileged read %j', async row => {
    await expect(getUsTaxProfile(fixture(row).store, actor)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
  });
  it('does not invoke nested privileged getters', async () => {
    const getter = vi.fn(() => 'Private legal name');
    const row = structuredClone(declared);
    Object.defineProperty(row.facts.taxOrigin, 'line1', { enumerable: true, get: getter });
    await expect(getUsTaxProfile(rawStore(row), actor)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    { organizationId: 'foreign' }, { revision: 2 }, { facts: { ...facts, legalName: 'Different' } },
    { updatedBy: 'other-owner' }, { requestId: write.requestId.toUpperCase() }, { requestId: 'a1000000-0000-4000-8000-000000000002' },
    { replayed: 'true' }, { verification: 'verified' }, { providerProof: 'private' },
  ])('refuses a receipt inconsistent with the immutable write %j', async changes => {
    const row = { ...declared, requestId: write.requestId, replayed: false, ...changes };
    await expect(putUsTaxProfile(fixture(row).store, actor, write)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
  });
  it('validates a historical receipt against exact actor, key, revision and canonical facts', () => {
    expect(validateUsTaxProfileReceipt({ ...declared, requestId: write.requestId, replayed: true }, actor.organizationId, actor.userId, write)).toEqual({ ...declared, requestId: write.requestId, replayed: true });
    expect(() => validateUsTaxProfileReceipt({ ...declared, requestId: write.requestId, replayed: true }, actor.organizationId, 'other-owner', write)).toThrow();
  });
});
