import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { postUsManualJournal } from './accounting/us-journal';
import { usStarterChart } from './countries/us/accounting';
import { ErpError, canonicalErpJson } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsBankCommit, UsBankReceipt, UsBankRecord, UsBankRequest } from './us-bank-contract';
import { applyUsBankCommand } from './us-bank-reconciliation';
import { createSupabaseUsBankStore, validateUsBankReceipt } from './us-bank-store';

const organizationId = 'b0c5564a-7e15-4c52-a29a-22598e04bf75';
const foreignOrganization = '05821e92-37d8-4b3b-8dc5-85d1c5cb4629';
const userId = '28f8b272-af88-41bd-8708-1634f2af86f2';
const reconciliationId = 'bd18217f-4af3-46ec-9fce-a9bb25067cbe';
const actor: FinancialAuthority = { organizationId, userId, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const ledger = postUsManualJournal(createLedger({ organizationId, currency: 'USD', basis: 'accrual', accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }), { id: 'capital', transactionDate: '2026-10-08', accountingDate: '2026-10-09', periodId: '2026', description: 'Fictitious opening capital', sourceReference: 'FICTITIOUS-STORE-TEST', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '10000', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '10000' }] }, 'fictitious-capital', actor, 0);
const create: UsBankRequest = { schemaVersion: 1, idempotencyKey: 'bank-create', reconciliationId, expectedErpRevision: 10, expectedReconciliationRevision: null, command: { type: 'create_statement', statement: { id: reconciliationId, organizationId, externalConnectionId: 'manual-reviewed-cash', currency: 'USD', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: { currency: 'USD', minorUnits: '0' }, closing: { currency: 'USD', minorUnits: '10000' }, lines: [{ id: `${reconciliationId}:1`, date: '2026-10-08', amount: { currency: 'USD', minorUnits: '10000' }, reference: 'Fictitious capital reference' }] } } };
const created = applyUsBankCommand(null, create, ledger, actor, []);
const approve: UsBankRequest = { ...create, idempotencyKey: 'bank-approve', expectedReconciliationRevision: 0, command: { type: 'approve_match', id: '44b823c6-dd8f-48eb-9a35-860754035be1', statementLineIds: [`${reconciliationId}:1`], ledgerEntryIds: ['capital'] } };
const approved = applyUsBankCommand(created, approve, ledger, actor, [created]);
const completed = applyUsBankCommand(approved, { ...create, idempotencyKey: 'bank-complete', expectedReconciliationRevision: 1, command: { type: 'complete' } }, ledger, actor, [approved]);
const voided = applyUsBankCommand(created, { ...create, idempotencyKey: 'bank-void', expectedReconciliationRevision: 0, command: { type: 'void_statement', reason: 'Fictitious reviewed import correction' } }, ledger, actor, [created]);
const receipt: UsBankReceipt = { schemaVersion: 1, organizationId, idempotencyKey: 'bank-create', commandHash: 'a'.repeat(64), actorId: userId, reconciliationId, action: 'create_statement', revision: 0, erpRevision: 10 };
const commit: UsBankCommit = { actor, expectedErpRevision: 10, expectedReconciliationRevision: null, record: created, receipt };
const receiptFields = ['schemaVersion', 'organizationId', 'idempotencyKey', 'commandHash', 'actorId', 'reconciliationId', 'action', 'revision', 'erpRevision'] as const;
const actorFields = ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'] as const;
const operations = ['list', 'read', 'receipt', 'commit'] as const;
type Operation = typeof operations[number];
const invalid = { code: 'invalid_bank_record', status: 503, message: 'invalid_bank_record' };
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Field in keyof T]: Mutable<T[Field]> } : T;
function mutable<T>(value: T): Mutable<T> { return structuredClone(value) as Mutable<T>; }

/** Real core records and service adapter; the RPC transport is fictitious.
 * These tests do not establish PostgreSQL atomicity, hosted admission or a bank connection. */
function fixture(result: unknown, capability: ErpSchemaVersion = 4) {
  const rpc = vi.fn(async () => result) as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
  return { rpc, store: createSupabaseUsBankStore({ rpc }, { supportedSchemaVersion: capability }) };
}
function sentParameters(t: ReturnType<typeof fixture>): Record<string, unknown> {
  const value = t.rpc.mock.calls[0]?.[1];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Fictitious RPC parameters missing');
  return value as Record<string, unknown>;
}
function perform(t: ReturnType<typeof fixture>, operation: Operation, freshActor: FinancialAuthority = actor) {
  if (operation === 'list') return t.store.list(freshActor);
  if (operation === 'read') return t.store.read(freshActor, reconciliationId);
  if (operation === 'receipt') return t.store.receipt(freshActor, receipt.idempotencyKey);
  return t.store.commit({ ...commit, actor: freshActor });
}
function baseParameters(freshActor: FinancialAuthority = actor) { return { p_organization: freshActor.organizationId, p_actor: freshActor, p_supported_schema_version: 4 }; }
function rejectedReceipt(input: unknown, scope = organizationId) { expect(() => validateUsBankReceipt(input, scope)).toThrow(expect.objectContaining(invalid)); }
function row(index: number): UsBankRecord {
  const id = `${index.toString(16).padStart(8, '0')}-1111-4111-8111-000000000001`;
  return { ...created, reconciliation: { ...created.reconciliation, statement: { ...created.reconciliation.statement, id, lines: created.reconciliation.statement.lines.map(line => ({ ...line, id: `${id}:1` })) } } };
}

describe('US bank receipt private projection', () => {
  it.each(['plain', 'null prototype', 'frozen'] as const)('captures only nine detached immutable fields from a %s receipt', kind => {
    const input = kind === 'null prototype' ? Object.assign(Object.create(null), receipt) : kind === 'frozen' ? Object.freeze({ ...receipt }) : { ...receipt };
    const result = validateUsBankReceipt(input, organizationId);
    expect(result).toEqual(receipt); expect(result).not.toBe(input);
    expect(Reflect.ownKeys(result)).toEqual(receiptFields); expect(Object.isFrozen(result)).toBe(true);
    if (kind !== 'frozen') input.commandHash = 'b'.repeat(64);
    expect(result.commandHash).toBe(receipt.commandHash);
  });
  it.each(['create_statement', 'approve_match', 'complete', 'void_statement'] as const)('accepts the controlled action %s', action => {
    expect(validateUsBankReceipt({ ...receipt, action }, organizationId).action).toBe(action);
  });
  it.each([null, undefined, false, 1, 'receipt', [], new Date(), new Map()])('refuses a non-JSON receipt %j', input => rejectedReceipt(input));
  it('refuses inherited fields and class instances', () => {
    class Receipt { constructor() { Object.assign(this, receipt); } }
    rejectedReceipt(new Receipt()); rejectedReceipt(Object.create(receipt));
    const inherited = Object.assign(Object.create({ action: receipt.action }), receipt); delete inherited.action; rejectedReceipt(inherited);
  });
  it.each(receiptFields)('refuses missing, hidden or accessor field %s without invoking code', field => {
    const missing: Record<string, unknown> = { ...receipt }; delete missing[field]; rejectedReceipt(missing);
    rejectedReceipt(Object.defineProperty({ ...receipt }, field, { value: receipt[field], enumerable: false }));
    const getter = vi.fn(() => { throw new Error('PRIVATE_GETTER_SECRET'); });
    rejectedReceipt(Object.defineProperty({ ...receipt }, field, { get: getter, enumerable: true })); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['facts', 'providerRaw', 'binding', 'constructor', 'toJSON'] as const)('refuses privileged or extra %s data, including hidden fields', field => {
    rejectedReceipt({ ...receipt, [field]: 'PRIVATE_RPC_SECRET' });
    rejectedReceipt(Object.defineProperty({ ...receipt }, field, { value: 'PRIVATE_RPC_SECRET', enumerable: false }));
  });
  it('refuses symbols, cyclic input and throwing descriptor/prototype traps without leaking details', () => {
    rejectedReceipt({ ...receipt, [Symbol('private')]: 'PRIVATE_RPC_SECRET' });
    const cycle = { ...receipt, self: null as unknown }; cycle.self = cycle; rejectedReceipt(cycle);
    for (const handler of [{ getPrototypeOf() { throw new Error('PRIVATE_RPC_SECRET'); } }, { ownKeys() { throw new Error('PRIVATE_RPC_SECRET'); } }, { getOwnPropertyDescriptor() { throw new Error('PRIVATE_RPC_SECRET'); } }]) rejectedReceipt(new Proxy({ ...receipt }, handler));
  });
  it.each([
    ['schemaVersion', 2], ['organizationId', foreignOrganization], ['reconciliationId', 'not-a-uuid'],
    ['actorId', ''], ['actorId', '   '], ['actorId', 'a'.repeat(257)], ['actorId', 'actor\x7f'], ['actorId', '\ud800'],
    ['idempotencyKey', ''], ['idempotencyKey', 'with spaces'], ['idempotencyKey', 'a'.repeat(241)], ['idempotencyKey', 7],
    ['commandHash', 'A'.repeat(64)], ['commandHash', 'a'.repeat(63)], ['commandHash', 'g'.repeat(64)],
    ['action', 'bank_transfer'], ['action', null], ['revision', -1], ['revision', 0.5], ['revision', '0'], ['revision', Number.MAX_SAFE_INTEGER],
    ['erpRevision', 0], ['erpRevision', -1], ['erpRevision', Infinity], ['erpRevision', NaN], ['erpRevision', Number.MAX_SAFE_INTEGER],
  ] as const)('refuses malformed %s=%j', (field, value) => rejectedReceipt({ ...receipt, [field]: value }));
  it('preserves valid maximum boundaries without coercing monetary or revision data', () => {
    const input = { ...receipt, actorId: 'é'.repeat(256), idempotencyKey: 'a'.repeat(240), revision: Number.MAX_SAFE_INTEGER - 1, erpRevision: Number.MAX_SAFE_INTEGER - 1 };
    expect(validateUsBankReceipt(input, organizationId)).toEqual(input);
  });
  it.each(['', 'not-a-uuid', organizationId.toUpperCase(), foreignOrganization])('requires the exact canonical organization scope %s', scope => rejectedReceipt(receipt, scope));
});

describe('US bank store four fixed service RPCs', () => {
  it('lists only detached scoped records and sends the captured ceiling and actor', async () => {
    const raw = mutable([created]), t = fixture(raw), actual = await t.store.list(actor);
    expect(actual).toEqual([created]); expect(actual).not.toBe(raw); expect(actual[0]).not.toBe(raw[0]);
    expect(Object.isFrozen(actual)).toBe(true); expect(Object.isFrozen(actual[0].reconciliation.statement.lines)).toBe(true);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_list_us_bank_reconciliations', baseParameters());
    raw[0].createdBy = 'changed-after-return'; expect(actual[0].createdBy).toBe(userId);
  });
  it('reads one exact record and permits null absence through the fixed read RPC', async () => {
    const t = fixture(created);
    expect(await t.store.read(actor, reconciliationId)).toEqual(created);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_read_us_bank_reconciliation', { ...baseParameters(), p_id: reconciliationId });
    t.rpc.mockResolvedValueOnce(null); expect(await t.store.read(actor, reconciliationId)).toBeNull();
  });
  it('reads the exact actor/key receipt and permits null absence through the fixed receipt RPC', async () => {
    const raw = { ...receipt }, t = fixture(raw), actual = await t.store.receipt(actor, receipt.idempotencyKey);
    expect(actual).toEqual(receipt); expect(actual).not.toBe(raw);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_us_bank_receipt', { ...baseParameters(), p_idempotency_key: receipt.idempotencyKey });
    t.rpc.mockResolvedValueOnce(null); expect(await t.store.receipt(actor, receipt.idempotencyKey)).toBeNull();
  });
  it.each([
    ['create_statement', created, null, 0], ['approve_match', approved, 0, 1], ['complete', completed, 1, 2], ['void_statement', voided, 0, 1],
  ] as const)('commits the real %s record with both revision fences and the exact receipt', async (action, record, expectedReconciliationRevision, revision) => {
    const expected: UsBankReceipt = { ...receipt, action, revision, idempotencyKey: `bank-${action}` }, t = fixture(expected);
    const input: UsBankCommit = { ...commit, record, expectedReconciliationRevision, receipt: expected };
    const actual = await t.store.commit(input);
    expect(actual).toEqual(expected); expect(actual).not.toBe(expected);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_commit_us_bank_reconciliation', { ...baseParameters(), p_expected_erp_revision: 10, p_expected_reconciliation_revision: expectedReconciliationRevision, p_record: record, p_receipt: expected });
    const params = sentParameters(t); expect(Object.isFrozen(params.p_actor)).toBe(true); expect(Object.isFrozen(params.p_record)).toBe(true); expect(Object.isFrozen(params.p_receipt)).toBe(true);
  });
  it('captures caller-owned actor, record and receipt synchronously before a pending RPC', async () => {
    const input = mutable(commit), t = fixture(receipt);
    let resolve!: (value: unknown) => void; const pending = new Promise<unknown>(done => { resolve = done; }); t.rpc.mockReturnValueOnce(pending);
    const response = t.store.commit(input), sent = sentParameters(t);
    input.actor.role = 'read_only'; input.record.createdBy = 'changed-after-send'; input.receipt.commandHash = 'b'.repeat(64);
    expect(sent).toMatchObject({ p_actor: actor, p_record: created, p_receipt: receipt });
    resolve({ ...receipt }); expect(await response).toEqual(receipt);
  });
  it.each(['owner', 'admin', 'accountant'] as const)('preserves approved financial actor role %s without asserting hosted authority', async role => {
    const t = fixture([]), freshActor = { ...actor, role }; await t.store.list(freshActor);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_list_us_bank_reconciliations', baseParameters(freshActor));
  });
  it.each([undefined, 1, 2, 3] as const)('refuses every operation with captured capability %j before RPC', async supportedSchemaVersion => {
    const rpc = vi.fn(async () => null) as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
    const store = createSupabaseUsBankStore({ rpc }, supportedSchemaVersion === undefined ? {} : { supportedSchemaVersion });
    expect(store.supportedSchemaVersion).toBe(supportedSchemaVersion ?? 1);
    for (const operation of operations) await expect(perform({ rpc, store }, operation)).rejects.toMatchObject({ code: 'bank_upgrade_required', status: 409 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('never promotes the captured ceiling after options or exposed descriptor mutation', async () => {
    const rpc = vi.fn(async () => []) as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
    const options: { supportedSchemaVersion: ErpSchemaVersion } = { supportedSchemaVersion: 3 };
    const store = createSupabaseUsBankStore({ rpc }, options); options.supportedSchemaVersion = 4;
    Object.assign(store, { supportedSchemaVersion: 4 });
    await expect(store.list(actor)).rejects.toMatchObject({ code: 'bank_upgrade_required', status: 409 }); expect(rpc).not.toHaveBeenCalled();
    const activeOptions: { supportedSchemaVersion: ErpSchemaVersion } = { supportedSchemaVersion: 4 };
    const active = createSupabaseUsBankStore({ rpc }, activeOptions); activeOptions.supportedSchemaVersion = 1;
    await active.list(actor); expect(sentParameters({ rpc, store: active }).p_supported_schema_version).toBe(4);
  });
  it.each([0, 5, '4', NaN, Infinity])('refuses invalid factory ceiling %j', ceiling => {
    const rpc = vi.fn() as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
    expect(() => createSupabaseUsBankStore({ rpc }, { supportedSchemaVersion: ceiling as ErpSchemaVersion })).toThrow(expect.objectContaining({ code: 'invalid_request', status: 422 })); expect(rpc).not.toHaveBeenCalled();
  });
  it('treats a runtime null ceiling as the least-capable default and never permits bank I/O', async () => {
    const rpc = vi.fn(async () => null) as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
    const store = createSupabaseUsBankStore({ rpc }, { supportedSchemaVersion: null as unknown as ErpSchemaVersion });
    expect(store.supportedSchemaVersion).toBe(1);
    for (const operation of operations) await expect(perform({ rpc, store }, operation)).rejects.toMatchObject({ code: 'bank_upgrade_required', status: 409 }); expect(rpc).not.toHaveBeenCalled();
  });
});

describe('US bank store actor and input boundaries', () => {
  it.each(['member', 'read_only', 'fake_owner'] as const)('refuses role %s for all four RPCs before I/O', async role => {
    const t = fixture(null), invalidActor = { ...actor, role } as FinancialAuthority;
    for (const operation of operations) await expect(perform(t, operation, invalidActor)).rejects.toMatchObject({ code: 'bank_permission_required', status: 403 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([false, 'true', 1, null])('requires actual entitlement true, not %j', async managementEntitled => {
    const t = fixture(null), invalidActor = { ...actor, managementEntitled } as FinancialAuthority;
    await expect(t.store.list(invalidActor)).rejects.toMatchObject({ code: 'bank_permission_required', status: 403 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['organizationId', 'org_legacy'], ['organizationId', organizationId.toUpperCase()], ['userId', ''], ['userId', '  '], ['userId', 'a'.repeat(257)], ['userId', 'user\x7f'], ['timestamp', 'not-an-instant'],
  ] as const)('refuses malformed actor %s before any RPC', async (field, value) => {
    const t = fixture(null); await expect(t.store.list({ ...actor, [field]: value } as FinancialAuthority)).rejects.toMatchObject({ status: 503 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(actorFields)('refuses an actor accessor %s without invoking it or sending a request', async field => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_ACTOR_SECRET'); });
    const t = fixture(null), input = Object.defineProperty({ ...actor }, field, { get: getter, enumerable: true });
    await expect(t.store.list(input)).rejects.toMatchObject({ status: 503 }); expect(getter).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('refuses extra private actor data and inherited actor fields', async () => {
    const t = fixture(null);
    for (const input of [{ ...actor, token: 'PRIVATE_ACTOR_SECRET' }, Object.create(actor)]) await expect(t.store.list(input)).rejects.toMatchObject({ status: 503 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['2026-10-08T12:00:00+00:00', '2026-10-08T12:00:00.0Z', '2026-10-08T12:00:00.000000Z', '0000-10-08T12:00:00Z', '2026-02-30T12:00:00Z'])('requires a real canonical UTC actor timestamp rather than %s', async timestamp => {
    const t = fixture(null); await expect(t.store.list({ ...actor, timestamp })).rejects.toMatchObject({ status: 503 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['2026-10-08T12:00:00Z', '2026-10-08T12:00:00.000Z'])('preserves the admitted actor instant %s exactly', async timestamp => {
    const t = fixture([]), freshActor = { ...actor, timestamp }; await t.store.list(freshActor);
    expect(sentParameters(t).p_actor).toMatchObject({ timestamp });
  });
  it.each(['read', 'receipt'] as const)('refuses malformed string parameters for %s before RPC', async method => {
    const t = fixture(null);
    const values = method === 'read' ? ['', 'not-a-uuid', reconciliationId.toUpperCase()] : ['', 'with spaces', 'a'.repeat(241), 'key\n'];
    for (const value of values) await expect(t.store[method](actor, value)).rejects.toMatchObject({ code: 'invalid_bank_request', status: 422 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['read', 'receipt'] as const)('refuses coercible object input for %s without running toString or RPC', async method => {
    const toString = vi.fn(() => method === 'read' ? reconciliationId : receipt.idempotencyKey), input = { toString };
    const t = fixture(null);
    await expect(t.store[method](actor, input as unknown as string)).rejects.toMatchObject({ code: 'invalid_bank_request', status: 422 }); expect(toString).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['actor', 'record', 'receipt', 'expectedErpRevision', 'expectedReconciliationRevision'] as const)('refuses a commit envelope accessor %s without invoking code or RPC', async field => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_COMMIT_SECRET'); }), t = fixture(receipt);
    const input = Object.defineProperty({ ...commit }, field, { get: getter, enumerable: true });
    await expect(t.store.commit(input)).rejects.toMatchObject({ status: 503 }); expect(getter).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('refuses extra, missing, hidden, inherited and class commit envelope fields before RPC', async () => {
    class Commit { constructor() { Object.assign(this, commit); } }
    const missing: Record<string, unknown> = { ...commit }; delete missing.expectedErpRevision;
    const hidden = Object.defineProperty({ ...commit }, 'actor', { value: actor, enumerable: false });
    const t = fixture(receipt);
    for (const input of [{ ...commit, bearer: 'PRIVATE_COMMIT_SECRET' }, missing]) await expect(t.store.commit(input as unknown as UsBankCommit)).rejects.toMatchObject({ code: 'invalid_bank_request', status: 422 });
    for (const input of [hidden, Object.create(commit), new Commit()]) await expect(t.store.commit(input as UsBankCommit)).rejects.toMatchObject({ status: 503 });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['expectedErpRevision', 0], ['expectedErpRevision', -1], ['expectedErpRevision', '10'], ['expectedErpRevision', Number.MAX_SAFE_INTEGER],
    ['expectedReconciliationRevision', -1], ['expectedReconciliationRevision', '0'], ['expectedReconciliationRevision', 0.1], ['expectedReconciliationRevision', Number.MAX_SAFE_INTEGER],
  ] as const)('refuses invalid commit fence %s=%j before RPC', async (field, value) => {
    const t = fixture(receipt); await expect(t.store.commit({ ...commit, [field]: value } as UsBankCommit)).rejects.toMatchObject({ code: 'invalid_bank_request', status: 422 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['erpRevision', 11], ['actorId', 'other-actor'], ['reconciliationId', foreignOrganization], ['revision', 1], ['action', 'approve_match'],
  ] as const)('refuses outbound receipt %s mismatching the captured actor/record/fence', async (field, value) => {
    const t = fixture(receipt); await expect(t.store.commit({ ...commit, receipt: { ...receipt, [field]: value } as UsBankReceipt })).rejects.toMatchObject({ code: 'invalid_bank_request', status: 422 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('refuses both foreign records and foreign receipts without RPC', async () => {
    const t = fixture(receipt), record = mutable(created); record.reconciliation.organizationId = foreignOrganization; record.reconciliation.statement.organizationId = foreignOrganization;
    await expect(t.store.commit({ ...commit, record })).rejects.toMatchObject(invalid);
    await expect(t.store.commit({ ...commit, receipt: { ...receipt, organizationId: foreignOrganization } })).rejects.toMatchObject(invalid); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('requires the next reconciliation revision and disallows a create receipt on an existing record', async () => {
    const t = fixture(receipt);
    await expect(t.store.commit({ ...commit, record: approved, expectedReconciliationRevision: 1, receipt: { ...receipt, action: 'approve_match', revision: 1 } })).rejects.toMatchObject({ code: 'invalid_bank_request', status: 422 });
    await expect(t.store.commit({ ...commit, record: approved, expectedReconciliationRevision: 0, receipt: { ...receipt, action: 'create_statement', revision: 1 } })).rejects.toMatchObject({ code: 'invalid_bank_request', status: 422 }); expect(t.rpc).not.toHaveBeenCalled();
  });
});

describe('US bank store privileged response and transport errors', () => {
  it('accepts 100 unique valid records but rejects 101 and duplicates', async () => {
    const raw = Array.from({ length: 100 }, (_, index) => row(index)), t = fixture(raw);
    expect(await t.store.list(actor)).toHaveLength(100);
    t.rpc.mockResolvedValueOnce([...raw, row(100)]); await expect(t.store.list(actor)).rejects.toMatchObject(invalid);
    t.rpc.mockResolvedValueOnce([raw[0], structuredClone(raw[0])]); await expect(t.store.list(actor)).rejects.toMatchObject(invalid);
  });
  it.each([null, undefined, {}, 'records', [null], [undefined]])('refuses malformed list result %j', async value => {
    const t = fixture(value); await expect(t.store.list(actor)).rejects.toMatchObject({ status: 503 });
  });
  it('refuses sparse or extra-property record lists and array getters without invoking them', async () => {
    const sparse = Array(1), extra = Object.assign([created], { facts: 'PRIVATE_RPC_SECRET' }), getter = vi.fn(() => created);
    const accessor = Object.defineProperty([created], '0', { get: getter, enumerable: true });
    for (const input of [sparse, extra, accessor]) { const t = fixture(input); await expect(t.store.list(actor)).rejects.toMatchObject({ status: 503 }); } expect(getter).not.toHaveBeenCalled();
  });
  it.each(['read', 'list'] as const)('refuses a foreign tenant record returned by %s', async method => {
    const foreign = mutable(created); foreign.reconciliation.organizationId = foreignOrganization; foreign.reconciliation.statement.organizationId = foreignOrganization;
    const t = fixture(method === 'read' ? foreign : [foreign]); await expect(method === 'read' ? t.store.read(actor, reconciliationId) : t.store.list(actor)).rejects.toMatchObject(invalid);
  });
  it('refuses a valid record returned for another requested ID', async () => {
    const t = fixture(row(1)); await expect(t.store.read(actor, reconciliationId)).rejects.toMatchObject(invalid);
  });
  it.each(['read', 'list'] as const)('refuses private record fields and getters from %s without exposing or executing them', async method => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_RECORD_SECRET'); }), raw = Object.defineProperty(structuredClone(created), 'facts', { get: getter, enumerable: true });
    const t = fixture(method === 'read' ? raw : [raw]);
    await expect(method === 'read' ? t.store.read(actor, reconciliationId) : t.store.list(actor)).rejects.toMatchObject(method === 'read' ? invalid : { code: 'service_unavailable', status: 503, message: 'service_unavailable' }); expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    ['organizationId', foreignOrganization], ['actorId', 'other-actor'], ['idempotencyKey', 'different-command'],
  ] as const)('refuses a receipt lookup for changed %s', async (field, value) => {
    const t = fixture({ ...receipt, [field]: value }); await expect(t.store.receipt(actor, receipt.idempotencyKey)).rejects.toMatchObject(invalid);
  });
  it.each(receiptFields)('refuses a commit response whose %s is not the exact sent value', async field => {
    const changed = { ...receipt, [field]: field === 'schemaVersion' ? 2 : field === 'revision' ? 1 : field === 'erpRevision' ? 11 : field === 'commandHash' ? 'b'.repeat(64) : field === 'action' ? 'complete' : 'different' };
    const t = fixture(changed); await expect(t.store.commit(commit)).rejects.toMatchObject(invalid);
  });
  it.each(['receipt', 'commit'] as const)('refuses privileged extra receipt fields from %s', async method => {
    const t = fixture({ ...receipt, facts: { rawProvider: 'PRIVATE_RPC_SECRET' } });
    await expect(method === 'receipt' ? t.store.receipt(actor, receipt.idempotencyKey) : t.store.commit(commit)).rejects.toMatchObject(invalid);
  });
  it.each([
    ['PB001', 'bank_revision_conflict', 409], ['PB002', 'bank_idempotency_conflict', 409], ['PB003', 'bank_statement_overlap', 409], ['PB004', 'bank_entry_already_matched', 409],
    ['PB005', 'invalid_bank_request', 422], ['PB006', 'bank_erp_revision_conflict', 409], ['PB007', 'bank_permission_required', 403], ['PB008', 'bank_upgrade_required', 409],
    ['PB009', 'bank_limit_reached', 409], ['PB010', 'invalid_bank_record', 503], ['PB011', 'bank_statement_closed', 409], ['PB012', 'bank_statement_duplicate', 409],
  ] as const)('maps only controlled SQL code %s into %s without exposing private resource information', async (sqlCode, code, status) => {
    const t = fixture(null);
    for (const operation of operations) {
      t.rpc.mockRejectedValueOnce(new SupabaseServerError(503, sqlCode, 'PRIVATE_RPC_RESOURCE'));
      await expect(perform(t, operation)).rejects.toMatchObject({ code, status, message: code });
    }
  });
  it.each(operations)('sanitizes unknown transport details in %s without treating a lookalike error as a grant', async operation => {
    const t = fixture(null);
    for (const source of [new Error('PRIVATE_RPC_SECRET'), new SupabaseServerError(500, 'XX999', 'PRIVATE_RPC_RESOURCE'), { code: 'PB007', status: 403, message: 'PRIVATE_LOOKALIKE' }]) {
      t.rpc.mockRejectedValueOnce(source); await expect(perform(t, operation)).rejects.toMatchObject({ code: 'service_unavailable', status: 503, message: 'service_unavailable' });
    }
  });
  it('preserves an already controlled ERP conflict without attaching transport details', async () => {
    const t = fixture(null); t.rpc.mockRejectedValueOnce(new ErpError('bank_erp_revision_conflict', 409));
    await expect(t.store.commit(commit)).rejects.toMatchObject({ code: 'bank_erp_revision_conflict', status: 409, message: 'bank_erp_revision_conflict' });
  });
  it('keeps the receipt projection canonical regardless of harmless object insertion order', async () => {
    const reordered = Object.fromEntries(Object.entries(receipt).reverse()), t = fixture(reordered);
    const actual = await t.store.commit(commit); expect(canonicalErpJson(actual)).toBe(canonicalErpJson(receipt));
  });
});
