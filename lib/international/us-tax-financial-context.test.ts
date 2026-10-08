import { describe, expect, it, vi } from 'vitest';
import type { SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import { createUsTaxFinancialContextReader, type UsTaxFinancialContextReaderOptions } from './us-tax-financial-context';

const organizationId = 'fictitious-us-financial-context';
const timestamp = '2026-10-08T12:00:00.000Z';
function actor(role: FinancialAuthority['role'] = 'owner'): FinancialAuthority {
  return { organizationId, userId: 'fictitious-financial-user', role, managementEntitled: true, timestamp };
}
/** Synthetic private read responses only. Even the provider_observation shape
 * in these tests is not a real provider/settings/registrations observation. */
function rows(): unknown[] {
  const address = { country: 'US', line1: '123 Fictitious Origin Road', city: 'New York', subdivision: 'NY', postalCode: '10001' };
  return [
    [{ organization_id: organizationId, schema_version: 1, country: 'US', currency: 'USD', revision: 2, updated_by: 'fictitious-owner', updated_at: '2026-10-08T10:00:00.123456Z', config: { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } } }],
    { status: 'configured', organizationId, revision: 3, profile: { displayName: 'Fictitious public seller', contactEmail: 'seller@example.invalid' }, updatedBy: 'fictitious-owner', updatedAt: '2026-10-08T10:01:00.123456Z' },
    { status: 'declared', organizationId, revision: 4, facts: { schemaVersion: 1, legalName: 'Fictitious private legal name', taxOrigin: address, timeZone: 'America/New_York' }, updatedBy: 'fictitious-owner', updatedAt: '2026-10-08T10:02:00.123456Z', verification: 'unverified' },
    { organizationId, accountId: 'acct_FictitiousContext', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 5, settingsSha256: 'a'.repeat(64), registrationsSha256: 'b'.repeat(64), observedAt: '2026-10-08T11:00:00.123456Z', validUntil: '2026-10-08T13:00:00.123456Z', evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' },
  ];
}
function harness(data = rows(), override: Partial<UsTaxFinancialContextReaderOptions> = {}) {
  let current = actor(), clock = timestamp, readIndex = 0;
  const calls: { name: string; parameters: unknown }[] = [];
  const read = vi.fn(async (name: string, parameters: unknown) => { calls.push({ name, parameters }); return data[readIndex++]; });
  const store: Pick<SupabaseServerClient, 'select' | 'rpc'> = {
    select: async <T>(name: string, parameters?: Parameters<SupabaseServerClient['select']>[1]): Promise<T[]> => await read(name, parameters) as T[],
    rpc: async <T>(name: string, parameters: Parameters<SupabaseServerClient['rpc']>[1]): Promise<T> => await read(name, parameters) as T,
  };
  const revalidate = vi.fn(async () => current);
  const now = vi.fn(() => clock);
  const reader = createUsTaxFinancialContextReader(store, { revalidate, now, ...override });
  return { reader, store, read, revalidate, now, calls, setActor: (value: FinancialAuthority) => { current = value; }, setClock: (value: string) => { clock = value; } };
}
function row(data: unknown[], index: number): Record<string, unknown> {
  return (index === 0 ? (data[0] as unknown[])[0] : data[index]) as Record<string, unknown>;
}
function nested(value: Record<string, unknown>, key: string): Record<string, unknown> { return value[key] as Record<string, unknown>; }

describe('private real-authority financial context reader', () => {
  it.each(['owner', 'admin', 'accountant'] as const)('admits actual %s without fabricating UI ownership or verifying declarations', async role => {
    const h = harness(); h.setActor(actor(role));
    const context = await h.reader.read(actor(role));
    expect(context.actor.role).toBe(role); expect(context.actor.userId).toBe(actor().userId);
    expect(context.countryRevision).toBe(2); expect(context.sellerRevision).toBe(3); expect(context.taxFactsRevision).toBe(4); expect(context.binding.revision).toBe(5);
    expect(context.configuration.taxConfiguration.status).toBe('unconfigured');
    expect(context.recordedAt).toBe(timestamp);
    expect(h.calls).toEqual([
      { name: 'zentra_workspace_country_configs', parameters: { select: 'organization_id,schema_version,config,country,currency,revision,updated_by,updated_at', organization_id: 'eq.' + organizationId, limit: 2 } },
      ...['zentra_read_us_seller_profile', 'zentra_read_us_tax_profile', 'zentra_read_us_tax_provider_binding'].map(name => ({ name, parameters: { p_organization: organizationId } })),
    ]);
    expect(h.revalidate).toHaveBeenCalledTimes(8); expect(h.now).toHaveBeenCalledTimes(16);
    expect(Object.keys(context).sort()).toEqual(['actor', 'binding', 'configuration', 'countryRevision', 'organizationId', 'recordedAt', 'seller', 'sellerRevision', 'taxFacts', 'taxFactsRevision'].sort());
  });
  it.each(['member', 'read_only'] as const)('denies %s before any Auth/storage read', async role => {
    const h = harness(); await expect(h.reader.read(actor(role))).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 });
    expect(h.read).not.toHaveBeenCalled(); expect(h.revalidate).not.toHaveBeenCalled();
  });
  it('denies a missing entitlement before any private read', async () => {
    const h = harness(); await expect(h.reader.read({ ...actor(), managementEntitled: false })).rejects.toMatchObject({ status: 402 }); expect(h.read).not.toHaveBeenCalled();
  });
  it.each(['member', 'read_only'] as const)('never grants submitted owner authority when real admission is %s', async role => {
    const h = harness(); h.setActor(actor(role));
    await expect(h.reader.read(actor())).rejects.toMatchObject({ status: 403 }); expect(h.read).not.toHaveBeenCalled();
  });
  it('never grants submitted entitlement when real admission has lost it', async () => {
    const h = harness(); h.setActor({ ...actor(), managementEntitled: false });
    await expect(h.reader.read(actor())).rejects.toMatchObject({ status: 402 }); expect(h.read).not.toHaveBeenCalled();
  });
  it('requires explicit fixture injection; accepting it leaves fixture mode intact', async () => {
    const data = rows(); row(data, 3).evidenceKind = 'test_fixture';
    await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ code: 'binding_unavailable', status: 409 });
    const context = await harness(data, { allowTestFixtures: true }).reader.read(actor());
    expect(context.binding.evidenceKind).toBe('test_fixture'); expect(context.binding.mode).toBe('test');
  });
  it('detaches and freezes the actor before its first admission wait', async () => {
    const supplied = { ...actor() }, h = harness();
    h.revalidate.mockImplementation(async () => { supplied.organizationId = 'other'; supplied.userId = 'other'; supplied.role = 'member'; return actor(); });
    const context = await h.reader.read(supplied);
    expect(context.actor.organizationId).toBe(organizationId); expect(context.actor.role).toBe('owner'); expect(h.calls.every(call => JSON.stringify(call).includes(organizationId))).toBe(true);
  });
  it.each([0, 1, 2, 3])('detaches storage response %i before waiting on post-read admission', async index => {
    const data = rows(), h = harness(data);
    h.revalidate.mockImplementation(async () => { if (h.read.mock.calls.length === index + 1) row(data, index).revision = 999; return actor(); });
    const context = await h.reader.read(actor());
    expect([context.countryRevision, context.sellerRevision, context.taxFactsRevision, context.binding.revision][index]).toBe(index + 2);
  });
  it('returns a detached deeply immutable snapshot and never mutates declarations', async () => {
    const data = rows(), before = JSON.stringify(data), context = await harness(data).reader.read(actor());
    expect(JSON.stringify(data)).toBe(before);
    nested(row(data, 2), 'facts').legalName = 'Later value';
    expect(context.taxFacts.legalName).toBe('Fictitious private legal name');
    expect(Reflect.set(context.taxFacts, 'legalName', 'changed')).toBe(false);
    expect(Reflect.set(context.taxFacts.taxOrigin, 'line1', 'changed')).toBe(false);
    expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.actor)).toBe(true); expect(Object.isFrozen(context.configuration.address)).toBe(true); expect(Object.isFrozen(context.binding)).toBe(true);
  });
  it.each([0, 1, 2, 3])('withholds all private data if financial role is revoked during read %i', async index => {
    const h = harness();
    h.read.mockImplementation(async () => { const position = h.read.mock.calls.length - 1; if (position === index) h.setActor(actor('member')); return rows()[position]; });
    await expect(h.reader.read(actor())).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 });
    expect(h.read).toHaveBeenCalledTimes(index + 1);
  });
  it.each([401, 402, 403])('preserves Auth %i during a private read, even if storage also fails', async status => {
    const denied = new ErpError('synthetic_access_refused', status), h = harness();
    h.read.mockRejectedValue(new Error('PRIVATE SQL DETAILS MUST NOT ESCAPE'));
    h.revalidate.mockImplementation(async () => { if (h.read.mock.calls.length) throw denied; return actor(); });
    await expect(h.reader.read(actor())).rejects.toBe(denied); expect(h.read).toHaveBeenCalledTimes(1);
  });
  it.each(['organizationId', 'userId', 'role'] as const)('rejects a real actor %s change after the last wait', async field => {
    const h = harness();
    h.revalidate.mockImplementation(async () => h.read.mock.calls.length === 4 ? { ...actor(), [field]: field === 'role' ? 'admin' : 'other' } : actor());
    await expect(h.reader.read(actor())).rejects.toMatchObject({ code: 'financial_authority_changed', status: 403 });
  });
  it('checks final entitlement even for an otherwise valid final binding', async () => {
    const h = harness(); h.revalidate.mockImplementation(async () => ({ ...actor(), managementEntitled: h.read.mock.calls.length !== 4 }));
    await expect(h.reader.read(actor())).rejects.toMatchObject({ status: 402 });
  });
  it('rechecks before every read, including before private facts', async () => {
    const h = harness(); h.revalidate.mockImplementation(async () => { if (h.revalidate.mock.calls.length === 5) throw new ErpError('forbidden', 403); return actor(); });
    await expect(h.reader.read(actor())).rejects.toMatchObject({ status: 403 }); expect(h.read).toHaveBeenCalledTimes(2);
  });
  it('maps storage and non-Auth callback failures to a generic unavailable invariant', async () => {
    for (const source of ['storage', 'callback']) {
      const h = harness(); (source === 'storage' ? h.read : h.revalidate).mockRejectedValue(new Error('PRIVATE LEGAL NAME / DB SECRET'));
      await expect(h.reader.read(actor())).rejects.toMatchObject({ message: 'invalid_financial_context', status: 503 });
    }
  });
  it('validates final server time, not an earlier observation', async () => {
    const h = harness(); h.revalidate.mockImplementation(async () => { if (h.read.mock.calls.length === 4) h.setClock('2026-10-08T12:00:01.123456Z'); return actor(); });
    expect((await h.reader.read(actor())).recordedAt).toBe('2026-10-08T12:00:01.123Z');
  });
  it.each(['2026-10-08T11:59:59.999Z', '2026-02-30T12:00:00.000Z', '2026-10-08T12:00:00', '0000-01-01T00:00:00Z'])('withholds data on invalid/rollback server clock %s', async clock => {
    const h = harness(); h.revalidate.mockImplementation(async () => { if (h.read.mock.calls.length) h.setClock(clock); return actor(); });
    await expect(h.reader.read(actor())).rejects.toMatchObject({ status: 503 }); expect(h.read).toHaveBeenCalledTimes(1);
  });
  it.each(['2026-10-08T12:00:00.001Z', '2026-10-08T11:59:59.999Z'])('rejects a future/rollback refreshed authority timestamp %s', async time => {
    const h = harness(); h.setActor({ ...actor(), timestamp: time });
    await expect(h.reader.read(actor())).rejects.toMatchObject({ status: 503 }); expect(h.read).not.toHaveBeenCalled();
  });
  it('does not pretend four reads are atomic; preserves independent revisions for SQL fencing', async () => {
    const data = rows(), h = harness(data);
    h.read.mockImplementation(async () => { const index = h.read.mock.calls.length - 1; if (index === 1) row(data, 0).revision = 6; return data[index]; });
    const context = await h.reader.read(actor()); expect(context.countryRevision).toBe(2); expect(row(data, 0).revision).toBe(6); expect(h.read).toHaveBeenCalledTimes(4);
  });
});

describe('strict private head projections and scopes', () => {
  it.each([0, 1, 2, 3])('rejects cross-tenant head %i without returning a context', async index => {
    const data = rows(); row(data, index)[index === 0 ? 'organization_id' : 'organizationId'] = 'other';
    await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
  });
  it.each([0, 1, 2, 3].flatMap(index => [0, -1, 1.5, Number.MAX_SAFE_INTEGER, '1'].map(value => ({ index, value }))))('rejects malformed revision $index/$value', async ({ index, value }) => {
    const data = rows(); row(data, index).revision = value;
    await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
  });
  it.each([0, 1, 2, 3])('rejects unexpected/getter/prototype fields on head %i without reading accessors', async index => {
    for (const kind of ['extra', 'getter', 'prototype']) {
      const data = rows(), value = row(data, index), accessor = vi.fn(() => 'PRIVATE');
      if (kind === 'extra') value.privateUnexpected = 'PRIVATE';
      if (kind === 'getter') Object.defineProperty(value, 'revision', { enumerable: true, get: accessor });
      if (kind === 'prototype') Object.setPrototypeOf(value, { inherited: 'PRIVATE' });
      await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 }); expect(accessor).not.toHaveBeenCalled();
    }
  });
  it.each(['extra', 'getter', 'prototype', 'symbol', 'hidden'])('refuses malformed authority %s before private I/O', async kind => {
    const value = { ...actor() }, h = harness(), getter = vi.fn(() => 'owner');
    if (kind === 'extra') Object.assign(value, { submittedGrant: true });
    if (kind === 'getter') Object.defineProperty(value, 'role', { enumerable: true, get: getter });
    if (kind === 'prototype') Object.setPrototypeOf(value, { role: 'owner' });
    if (kind === 'symbol') Object.defineProperty(value, Symbol('role'), { value: 'owner', enumerable: true });
    if (kind === 'hidden') Object.defineProperty(value, 'role', { value: 'owner', enumerable: false });
    await expect(h.reader.read(value)).rejects.toMatchObject({ status: 503 }); expect(h.read).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])('rejects nested noncanonical/getter JSON in head %i', async index => {
    const data = rows(), field = index === 0 ? 'config' : index === 1 ? 'profile' : 'facts', value = nested(row(data, index), field);
    const getter = vi.fn(() => 'Fictitious getter'); Object.defineProperty(value, 'toJSON', { enumerable: true, get: getter });
    await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 }); expect(getter).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])('rejects future, impossible or blank metadata on head %i', async index => {
    for (const time of ['2026-10-08T12:00:00.000001Z', '2026-02-30T00:00:00.000Z', '0000-01-01T00:00:00Z']) {
      const data = rows(); row(data, index)[index === 0 ? 'updated_at' : 'updatedAt'] = time;
      await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
    }
    const data = rows(); row(data, index)[index === 0 ? 'updated_by' : 'updatedBy'] = ' ';
    await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    { index: 0, value: [], code: 'country_configuration_required' },
    { index: 1, value: { status: 'unconfigured', organizationId, revision: 0 }, code: 'seller_configuration_required' },
    { index: 2, value: { status: 'unconfigured', organizationId, revision: 0, verification: 'unverified' }, code: 'tax_details_required' },
    { index: 3, value: null, code: 'binding_unavailable' },
  ])('blocks explicit absent state $code; does not invent a seller, legal identity or binding', async ({ index, value, code }) => {
    const data = rows(); data[index] = value;
    await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ code, status: 409 });
  });
  it('does not accept duplicates or a nonarray country selection', async () => {
    for (const value of [[row(rows(), 0), row(rows(), 0)], row(rows(), 0), null]) {
      const data = rows(); data[0] = value; await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
    }
  });
  it.each([
    ['schema_version', 2], ['country', 'CH'], ['currency', 'CHF'],
  ])('rejects inconsistent country metadata %s', async (key, value) => {
    const data = rows(); row(data, 0)[key as string] = value; await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
  });
  it('rejects a foreign country config tenant and noncanonical public config', async () => {
    for (const [key, value] of [['organizationId', 'other'], ['invoiceNumberPrefix', ' INV ']]) {
      const data = rows(); nested(row(data, 0), 'config')[key] = value;
      await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
    }
  });
  it('withholds private heads for a Swiss country config', async () => {
    const data = rows(), config = nested(row(data, 0), 'config');
    Object.assign(row(data, 0), { country: 'CH', currency: 'CHF' }); Object.assign(config, { country: 'CH', currency: 'CHF', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: 'Fictitious road', city: 'Geneva', subdivision: 'GE', postalCode: '1200' } });
    const h = harness(data); await expect(h.reader.read(actor())).rejects.toMatchObject({ code: 'edition_unavailable', status: 409 }); expect(h.read).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['mode', 'live'], ['scope', 'saas_billing'], ['apiVersion', '2025-01-01'], ['accountId', 'acct_bad value'], ['settingsSha256', 'A'.repeat(64)], ['registrationsSha256', 'invalid'], ['evidenceKind', 'browser_declared'],
  ])('rejects unsupported provider binding %s without inferring a grant', async (key, value) => {
    const data = rows(); row(data, 3)[key] = value; await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    ['observedAt', '2026-10-08T12:00:00.000001Z'], ['validUntil', timestamp], ['validUntil', '2026-10-08T11:00:00.123456Z'],
  ])('rejects a stale/future binding at exact microsecond %s=$value', async (key, value) => {
    const data = rows(); row(data, 3)[key] = value; await expect(harness(data).reader.read(actor())).rejects.toMatchObject({ code: 'binding_unavailable', status: 409 });
  });
  it('can use the remaining microsecond window but cannot hide expiry during final Auth wait', async () => {
    const data = rows(); row(data, 3).validUntil = '2026-10-08T12:00:00.000001Z';
    expect((await harness(data).reader.read(actor())).binding.validUntil).toBe('2026-10-08T12:00:00.000001Z');
    const h = harness(data); h.revalidate.mockImplementation(async () => { if (h.read.mock.calls.length === 4) h.setClock('2026-10-08T12:00:00.000001Z'); return actor(); });
    await expect(h.reader.read(actor())).rejects.toMatchObject({ code: 'binding_unavailable', status: 409 });
  });
  it('accepts plain-null data but does not synthesize an actor identity from private legal facts', async () => {
    const data = rows(); data[2] = Object.assign(Object.create(null), data[2]);
    const context = await harness(data).reader.read(actor()); expect(context.actor.userId).toBe('fictitious-financial-user'); expect(context.taxFacts.legalName).not.toBe(context.actor.userId);
  });
});
