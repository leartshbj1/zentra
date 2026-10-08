import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createSupabaseErpStore, validateErpReceipt } from './runtime-store';
import type { ErpCommit, ErpReceipt } from './runtime-types';

const organizationId = 'fictitious-us-space';
const valid: ErpReceipt = { idempotencyKey: 'save-customer:original', commandHash: 'a'.repeat(64), revision: 2, entityId: 'customer-1', action: 'save_customer' };
const fields = ['idempotencyKey','commandHash','revision','entityId','action'] as const;
const invalid = { code: 'invalid_stored_state', status: 503, message: 'invalid_stored_state' };
function rejected(input: unknown, scope = organizationId) {
  expect(() => validateErpReceipt(input, scope)).toThrow(expect.objectContaining(invalid));
}
function fixture(result: unknown) {
  const rpc = vi.fn(async () => result) as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
  const store = createSupabaseErpStore({ rpc });
  const commit: ErpCommit = {
    organizationId, expectedRevision: 1,
    header: {
      schemaVersion: 1, revision: 2,
      configuration: { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } },
      counters: { estimate: 0, invoice: 0 },
      ledger: { organizationId, currency: 'USD', basis: 'accrual', revision: 0, accounts: [{ id: 'receivables', code: '1100', name: 'Receivables', type: 'asset' }, { id: 'revenue', code: '4000', name: 'Revenue', type: 'income' }], periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] },
    },
    changes: [], ledgerAudit: [], receipt: { ...valid },
    actor: { organizationId, userId: 'fictitious-accountant', role: 'accountant', managementEntitled: true, timestamp: '2026-10-08T12:00:00Z' },
  };
  return { rpc, store, commit };
}

describe('ERP receipt privileged response boundary', () => {
  it.each(['plain', 'null prototype', 'frozen'] as const)('copies a %s receipt into only five immutable public fields', kind => {
    const input = kind === 'null prototype' ? Object.assign(Object.create(null), valid) : kind === 'frozen' ? Object.freeze({ ...valid }) : { ...valid };
    const result = validateErpReceipt(input, organizationId);
    expect(result).toEqual(valid);
    expect(result).not.toBe(input);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Reflect.ownKeys(result)).toEqual(fields);
    expect(Object.isFrozen(result)).toBe(true);
    if (kind !== 'frozen') input.entityId = 'changed-after-validation';
    expect(result.entityId).toBe(valid.entityId);
  });

  it.each(['initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period'] as const)('preserves action %s without changing financial permissions', action => {
    expect(validateErpReceipt({ ...valid, action }, organizationId).action).toBe(action);
  });

  it.each([null, undefined, false, 1, 'receipt', [], new Date(), new Map(), Object.assign([], valid)])('rejects a non-JSON object %j', input => rejected(input));
  it('rejects class instances and inherited fields', () => {
    class Receipt { constructor() { Object.assign(this, valid); } }
    rejected(new Receipt());
    rejected(Object.create(valid));
    for (const key of fields) {
      const input = Object.assign(Object.create({ [key]: valid[key] }), valid);
      delete input[key];
      rejected(input);
    }
  });

  it.each(fields)('rejects a missing or non-enumerable %s', key => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[key];
    rejected(missing);
    rejected(Object.defineProperty({ ...valid }, key, { value: valid[key], enumerable: false }));
  });

  it.each(fields)('rejects a %s accessor without calling it', key => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_GETTER_SECRET'); });
    const setter = vi.fn();
    rejected(Object.defineProperty({ ...valid }, key, { get: getter, set: setter, enumerable: true }));
    rejected(Object.defineProperty({ ...valid }, key, { set: setter, enumerable: true }));
    expect(getter).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
  });

  it.each(['facts','binding','providerRaw','organizationId','__proto__','constructor','toJSON'] as const)('rejects private or extra key %s, including hidden data', key => {
    rejected(Object.defineProperty({ ...valid }, key, { value: 'PRIVATE_RPC_SECRET', enumerable: true }));
    rejected(Object.defineProperty({ ...valid }, key, { value: 'PRIVATE_RPC_SECRET', enumerable: false }));
  });
  it('rejects symbol properties and extra getters without reading them', () => {
    rejected({ ...valid, [Symbol('private')]: 'PRIVATE_RPC_SECRET' });
    const getter = vi.fn(() => { throw new Error('PRIVATE_RPC_SECRET'); });
    rejected(Object.defineProperty({ ...valid }, 'facts', { get: getter, enumerable: true }));
    expect(getter).not.toHaveBeenCalled();
  });
  it('sanitizes descriptor/prototype enumeration failures', () => {
    rejected(new Proxy({ ...valid }, { getPrototypeOf() { throw new Error('PRIVATE_RPC_SECRET'); } }));
    rejected(new Proxy({ ...valid }, { ownKeys() { throw new Error('PRIVATE_RPC_SECRET'); } }));
    rejected(new Proxy({ ...valid }, { getOwnPropertyDescriptor() { throw new Error('PRIVATE_RPC_SECRET'); } }));
  });

  it.each([
    ['revision', 0], ['revision', -1], ['revision', 1.5], ['revision', NaN], ['revision', Infinity], ['revision', Number.MAX_SAFE_INTEGER + 1], ['revision', '2'],
    ['commandHash', 'A'.repeat(64)], ['commandHash', 'a'.repeat(63)], ['commandHash', 'g'.repeat(64)], ['commandHash', null],
    ['idempotencyKey', ''], ['idempotencyKey', 'key with spaces'], ['idempotencyKey', 'a'.repeat(233)], ['idempotencyKey', 'key\n'], ['idempotencyKey', 1],
    ['entityId', ''], ['entityId', '  '], ['entityId', 'a'.repeat(161)], ['entityId', 'id\0'], ['entityId', 'id\x7f'], ['entityId', null],
    ['action', 'fake_owner'], ['action', null], ['action', { toString: () => 'issue_invoice' }],
  ] as const)('rejects malformed %s value %j', (key, value) => rejected({ ...valid, [key]: value }));
  it('preserves safe integer and string boundaries without coercion', () => {
    const input = { ...valid, revision: Number.MAX_SAFE_INTEGER, idempotencyKey: 'a'.repeat(232), entityId: 'é'.repeat(160) };
    expect(validateErpReceipt(input, organizationId)).toEqual(input);
  });
  it.each(['', ' ', 'foreign tenant', 'a'.repeat(129)])('requires a valid RPC organization scope %j', scope => rejected(valid, scope));
});

describe('ERP store transport and receipt projection', () => {
  it('preserves read and absent receipt RPCs', async () => {
    const t = fixture(null);
    expect(await t.store.read(organizationId)).toBeNull();
    expect(await t.store.receipt(organizationId, valid.idempotencyKey)).toBeNull();
    expect(t.rpc.mock.calls).toEqual([
      ['zentra_read_us_erp', { p_organization: organizationId }],
      ['zentra_us_erp_receipt', { p_organization: organizationId, p_idempotency_key: valid.idempotencyKey }],
    ]);
  });
  it('projects a receipt lookup into a fresh object using the same RPC', async () => {
    const raw = { ...valid }, t = fixture(raw);
    const result = await t.store.receipt(organizationId, valid.idempotencyKey);
    expect(result).toEqual(valid);
    expect(result).not.toBe(raw);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_us_erp_receipt', { p_organization: organizationId, p_idempotency_key: valid.idempotencyKey });
  });
  it('rejects a receipt returned for another idempotency key', async () => {
    const t = fixture({ ...valid, idempotencyKey: 'another-command' });
    await expect(t.store.receipt(organizationId, valid.idempotencyKey)).rejects.toMatchObject(invalid);
  });
  it.each(['lookup','commit'] as const)('does not disclose privileged extra data through %s', async operation => {
    const t = fixture({ ...valid, facts: { legalName: 'PRIVATE_RPC_SECRET' } });
    await expect(operation === 'lookup' ? t.store.receipt(organizationId, valid.idempotencyKey) : t.store.commit(t.commit)).rejects.toMatchObject(invalid);
  });
  it('keeps the seven commit arguments and returns only the reconstructed receipt', async () => {
    const raw = { ...valid }, t = fixture(raw);
    const result = await t.store.commit(t.commit);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_commit_us_erp', {
      p_organization: organizationId, p_expected_revision: 1, p_header: t.commit.header, p_changes: t.commit.changes,
      p_ledger_audit: t.commit.ledgerAudit, p_receipt: valid, p_actor: t.commit.actor,
    });
    expect(result).toEqual(valid);
    expect(result).not.toBe(raw);
    expect(Reflect.ownKeys(result)).toEqual(fields);
  });
  it('refuses malformed or extra outbound receipt data before RPC I/O', async () => {
    const t = fixture(valid);
    await expect(t.store.commit({ ...t.commit, receipt: { ...valid, facts: 'PRIVATE_RPC_SECRET' } } as ErpCommit)).rejects.toMatchObject(invalid);
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(fields)('rejects a commit response with changed %s', async key => {
    const changed = { ...valid, [key]: key === 'revision' ? 3 : key === 'commandHash' ? 'b'.repeat(64) : key === 'action' ? 'issue_invoice' : 'different' };
    const t = fixture(changed);
    await expect(t.store.commit(t.commit)).rejects.toMatchObject(invalid);
  });
  it('retains SQL error translation and does not publish unknown transport details', async () => {
    const t = fixture(valid);
    t.rpc.mockRejectedValueOnce(new SupabaseServerError(409, 'PU001', 'PRIVATE_RPC_SECRET'));
    await expect(t.store.commit(t.commit)).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    t.rpc.mockRejectedValueOnce(new Error('PRIVATE_RPC_SECRET'));
    await expect(t.store.receipt(organizationId, valid.idempotencyKey)).rejects.toMatchObject({ code: 'service_unavailable', status: 503, message: 'service_unavailable' });
  });
});
