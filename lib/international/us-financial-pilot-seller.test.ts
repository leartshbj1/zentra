import { describe, expect, it, vi } from 'vitest';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import {
  US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES, US_FINANCIAL_PILOT_SELLER_MAX_CHANGES, US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES,
  applyUsFinancialPilotSellerProof, buildUsFinancialPilotSellerProof, projectUsFinancialPilotSellerReceipt,
  usFinancialPilotSellerCommandContent, usFinancialPilotSellerCommandHash, usFinancialPilotSellerProfile,
  validateUsFinancialPilotSellerHead, validateUsFinancialPilotSellerPresentation, validateUsFinancialPilotSellerProof,
  validateUsFinancialPilotSellerRead, validateUsFinancialPilotSellerReceipt, validateUsFinancialPilotSellerRequest,
  executeUsFinancialPilotSeller, type UsFinancialPilotSellerDependencies, type UsFinancialPilotSellerAppend,
  type UsFinancialPilotSellerExpectation, type UsFinancialPilotSellerProof, type UsFinancialPilotSellerRead, type UsFinancialPilotSellerRequest,
} from './us-financial-pilot-seller';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const copy = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const organizationId = 'fictitious-us-seller-b0';
const id = (number: number) => `abcdef00-0000-4000-8000-${String(number).padStart(12, '0')}`;
const owner = (): FinancialAuthority => ({ organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-10T12:00:00.124Z' });
function request(): UsFinancialPilotSellerRequest {
  return { consumer: 'financial-pilot', schemaVersion: 1, requestId: id(1), expectedRevision: 9, expectedSellerRevision: 7,
    command: { type: 'update_seller_presentation', displayName: 'Fictitious Company 🧪', contactEmail: 'sales@example.test', contactPhone: null } };
}
function source(): UsFinancialPilotSellerRead {
  return { head: { consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: 9, bankRevision: 4, sellerRevision: 7 },
    presentation: { origin: 'legacy-frozen', baseSellerRevision: 7, sellerRevision: 7, changeCount: 0,
      profile: { displayName: 'Historical Fictitious Company', contactEmail: 'old@example.test', contactPhone: '+1 212 555 0100' },
      updatedBy: 'fictitious-legacy-owner', updatedAt: '2026-10-10T08:00:00.123456-04:00', changeSha256: null } };
}
const expected = (): UsFinancialPilotSellerExpectation => ({ request: request(), actor: owner() });
const invalidPublic = (value: unknown) => expect(() => validateUsFinancialPilotSellerRequest(value)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_request', status: 422 }));
const invalidPrivate = { code: 'invalid_financial_seller_data', status: 503, message: 'invalid_financial_seller_data' };
async function seal(value: UsFinancialPilotSellerProof): Promise<UsFinancialPilotSellerProof> {
  const captured = copy(value);
  captured.commandHash = await sha256Hex(canonicalErpJson(['zentra:us:financial-pilot:seller:v1', captured.organizationId, captured.actor.userId, captured.request]));
  const { changeSha256, ...payload } = captured; void changeSha256;
  return { ...payload, changeSha256: await sha256Hex(canonicalErpJson(payload)) };
}
function allFrozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(allFrozen);
}

describe('B0 seller public command and canonical identity', () => {
  it('owns exact printable values and makes explicit null remove contacts', () => {
    const value = copy(request()), captured = validateUsFinancialPilotSellerRequest(value);
    value.command.displayName = 'Changed after capture'; value.command.contactEmail = null;
    expect(captured).toEqual(request()); expect(allFrozen(captured)).toBe(true);
    expect(usFinancialPilotSellerProfile(captured.command)).toEqual({ displayName: request().command.displayName, contactEmail: 'sales@example.test' });
    expect(usFinancialPilotSellerProfile({ ...captured.command, contactEmail: null, contactPhone: '+1 212 555 0101' })).toEqual({ displayName: request().command.displayName, contactPhone: '+1 212 555 0101' });
    expect(usFinancialPilotSellerProfile({ ...captured.command, contactEmail: null })).not.toHaveProperty('contactEmail');
  });
  it('reuses the exact profile limits without trimming or translating data', () => {
    const displayName = 'N'.repeat(256), contactEmail = 'e'.repeat(241) + '@example.test', contactPhone = 'P'.repeat(80);
    expect(contactEmail).toHaveLength(254);
    const value = { ...request(), command: { ...request().command, displayName, contactEmail, contactPhone } };
    expect(validateUsFinancialPilotSellerRequest(value).command).toEqual(value.command);
    for (const patch of [{ displayName: displayName + 'N' }, { contactEmail: 'e' + contactEmail }, { contactPhone: contactPhone + 'P' },
      { displayName: ' Seller' }, { displayName: 'Seller ' }, { contactEmail: ' sales@example.test' }, { contactPhone: '+1 212 ' }]) invalidPublic({ ...value, command: { ...value.command, ...patch } });
  });
  it.each(['address', 'legalName', 'country', 'ein', 'currency', 'taxConfiguration', 'binding', 'merchant', 'organizationId', 'role', 'authority'])('refuses %s even if its value appears harmless', field => {
    invalidPublic({ ...request(), command: { ...request().command, [field]: null } });
    invalidPublic({ ...request(), [field]: null });
  });
  it.each([
    ['missing contact', () => { const value = copy(request()) as unknown as { command: Record<string, unknown> }; delete value.command.contactPhone; return value; }],
    ['undefined contact', () => ({ ...request(), command: { ...request().command, contactEmail: undefined } })],
    ['empty contact', () => ({ ...request(), command: { ...request().command, contactEmail: '' } })],
    ['wrong email', () => ({ ...request(), command: { ...request().command, contactEmail: 'not-email' } })],
    ['empty name', () => ({ ...request(), command: { ...request().command, displayName: '' } })],
    ['wrong consumer', () => ({ ...request(), consumer: 'erp' })],
    ['wrong schema', () => ({ ...request(), schemaVersion: 5 })],
    ['uppercase UUID', () => ({ ...request(), requestId: id(1).toUpperCase() })],
    ['non UUID', () => ({ ...request(), requestId: 'not-a-uuid' })],
    ['F zero', () => ({ ...request(), expectedRevision: 0 })],
    ['S zero', () => ({ ...request(), expectedSellerRevision: 0 })],
    ['F unsafe', () => ({ ...request(), expectedRevision: Number.MAX_SAFE_INTEGER })],
    ['S fractional', () => ({ ...request(), expectedSellerRevision: 7.5 })],
    ['wrong action', () => ({ ...request(), command: { ...request().command, type: 'update_seller' } })],
    ['NUL', () => ({ ...request(), command: { ...request().command, displayName: 'hidden\u0000name' } })],
    ['isolated surrogate', () => ({ ...request(), command: { ...request().command, displayName: '\ud800' } })],
    ['control', () => ({ ...request(), command: { ...request().command, displayName: 'name\nline' } })],
  ] as const)('rejects %s', (_label, value) => invalidPublic(value()));
  it('bounds UTF8 after structural capture and rejects hostiles without evaluating accessors', () => {
    const value = { ...request(), extra: '🌍'.repeat(US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES) };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES); invalidPublic(value);
    const getter = vi.fn(() => request().command), hostile = Object.defineProperty({ ...request() }, 'command', { enumerable: true, get: getter });
    invalidPublic(hostile); expect(getter).not.toHaveBeenCalled();
    invalidPublic({ ...request(), [Symbol('secret')]: true }); invalidPublic(Object.assign(Object.create({ inherited: true }) as object, request()));
    invalidPublic(Object.defineProperty({ ...request() }, 'hidden', { value: 'private' }));
    const cycle: Record<string, unknown> = { ...request() }; cycle.self = cycle; invalidPublic(cycle);
    invalidPublic({ ...request(), toJSON: vi.fn() });
    const trap = new Proxy({}, { ownKeys() { throw new Error('PRIVATE PROVIDER SECRET'); } }); invalidPublic(trap);
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); invalidPublic(revoked.proxy);
    const get = vi.fn(() => { throw new Error('Must use descriptors'); });
    expect(validateUsFinancialPilotSellerRequest(new Proxy(request(), { get }))).toEqual(request()); expect(get).not.toHaveBeenCalled();
  });
  it('namespaces the complete canonical request and captures it before asynchronous hashing', async () => {
    const value = copy(request()), original = copy(value), pending = usFinancialPilotSellerCommandHash(organizationId, owner().userId, value);
    value.command.displayName = 'Alias mutation'; value.expectedSellerRevision++; value.requestId = id(2);
    const content = canonicalErpJson(['zentra:us:financial-pilot:seller:v1', organizationId, owner().userId, original]);
    expect(usFinancialPilotSellerCommandContent(organizationId, owner().userId, original)).toBe(content);
    expect(await pending).toBe(await sha256Hex(content));
    expect(await pending).not.toBe(await sha256Hex(canonicalErpJson([organizationId, owner().userId, original])));
    const base = await usFinancialPilotSellerCommandHash(organizationId, owner().userId, original);
    for (const [org, user, changed] of [[organizationId + '-other', owner().userId, original], [organizationId, 'other-owner', original],
      [organizationId, owner().userId, { ...original, requestId: id(3) }], [organizationId, owner().userId, { ...original, expectedRevision: 10 }],
      [organizationId, owner().userId, { ...original, expectedSellerRevision: 8 }], [organizationId, owner().userId, { ...original, command: { ...original.command, contactPhone: '+1 555 0101' } }]] as const) {
      expect(await usFinancialPilotSellerCommandHash(org, user, changed)).not.toBe(base);
    }
  });
});

describe('B1 private seller execution — controlled memory port, not PostgreSQL authority', () => {
  async function runtime() {
    let current = source(); const receipts = new Map<string, UsFinancialPilotSellerProof>();
    const policy = (await financialKernelFixture()).policy;
    const store = {
      read: vi.fn(async () => copy(current)), head: vi.fn(async () => copy(current.head)),
      receipt: vi.fn(async (requestId: string) => copy(receipts.get(requestId) ?? null)),
      append: vi.fn(async (input: UsFinancialPilotSellerAppend) => { current = await applyUsFinancialPilotSellerProof(current, input.proof); receipts.set(input.request.requestId, input.proof); return copy(input.proof); }),
    };
    const fresh = vi.fn(async () => ({ actor: owner(), policy })), writeEnabled = vi.fn(async () => true);
    const deps: UsFinancialPilotSellerDependencies = { organizationId, actor: owner(), policy, store, revalidate: fresh, writeEnabled };
    return { deps, store, fresh, writeEnabled, current: () => current, setCurrent: (value: UsFinancialPilotSellerRead) => { current = value; } };
  }
  it('advances only S once and recovers a historical receipt before F/S/read/write-off checks', async () => {
    const t = await runtime(), receipt = await executeUsFinancialPilotSeller(t.deps, request());
    expect(receipt).toMatchObject({ sourceRevision: 9, sellerRevision: 8, replayed: false }); expect(t.current().head).toEqual({ ...source().head, sellerRevision: 8 });
    t.setCurrent({ ...t.current(), head: { ...t.current().head, revision: 100, bankRevision: 40 } }); t.writeEnabled.mockResolvedValue(false);
    t.store.read.mockClear(); t.store.append.mockClear(); t.writeEnabled.mockClear();
    expect(await executeUsFinancialPilotSeller(t.deps, request())).toEqual({ ...receipt, replayed: true });
    expect(t.store.read).not.toHaveBeenCalled(); expect(t.store.append).not.toHaveBeenCalled(); expect(t.writeEnabled).not.toHaveBeenCalled();
  });
  it('rejects a new write while paused and a changed request under an old UUID', async () => {
    const t = await runtime(); t.writeEnabled.mockResolvedValue(false);
    await expect(executeUsFinancialPilotSeller(t.deps, request())).rejects.toMatchObject({ code: 'seller_writes_disabled', status: 409 }); expect(t.store.append).not.toHaveBeenCalled();
    t.writeEnabled.mockResolvedValue(true); await executeUsFinancialPilotSeller(t.deps, request());
    await expect(executeUsFinancialPilotSeller(t.deps, { ...request(), command: { ...request().command, displayName: 'Different' } })).rejects.toMatchObject({ code: 'seller_idempotency_conflict', status: 409 }); expect(t.store.append).toHaveBeenCalledTimes(1);
  });
  it('reprobes an exact committed receipt after a lost append response without another append', async () => {
    const t = await runtime(), append = t.store.append.getMockImplementation()!;
    t.store.append.mockImplementation(async input => { await append(input); throw new Error('PRIVATE LOST RESPONSE'); });
    expect(await executeUsFinancialPilotSeller(t.deps, request())).toMatchObject({ replayed: true, sellerRevision: 8 }); expect(t.store.append).toHaveBeenCalledOnce();
  });
  it('keeps an uncertain failure when receipt recovery fails, then recovers after restoration', async () => {
    const t = await runtime(), append = t.store.append.getMockImplementation()!, lookup = t.store.receipt.getMockImplementation()!; let offline = false;
    t.store.append.mockImplementation(async input => { await append(input); offline = true; throw new Error('Lost response'); });
    t.store.receipt.mockImplementation(async id => { if (offline) throw new ErpError('financial_service_unavailable', 503); return lookup(id); });
    await expect(executeUsFinancialPilotSeller(t.deps, request())).rejects.toMatchObject({ status: 503 }); offline = false;
    expect(await executeUsFinancialPilotSeller(t.deps, request())).toMatchObject({ replayed: true }); expect(t.store.append).toHaveBeenCalledOnce();
  });
  it('renews owner entitlement and authority after a source rejection rather than disclosing stale errors', async () => {
    const t = await runtime(); let revoked = false;
    t.store.read.mockImplementation(async () => { revoked = true; throw new ErpError('seller_revision_conflict', 409); });
    t.fresh.mockImplementation(async () => { if (revoked) throw new ErpError('forbidden', 403); return { actor: owner(), policy: t.deps.policy }; });
    await expect(executeUsFinancialPilotSeller(t.deps, request())).rejects.toMatchObject({ code: 'forbidden', status: 403 }); expect(t.store.append).not.toHaveBeenCalled();
  });
  it('captures request, dependencies and port methods synchronously and forbids non-owner execution', async () => {
    const t = await runtime(), value = copy(request()), deps = { ...t.deps }, store = { ...t.store }; deps.store = store;
    const pending = executeUsFinancialPilotSeller(deps, value); value.command.displayName = 'Changed'; store.append = vi.fn(async () => { throw new Error('Swapped method'); }); deps.writeEnabled = async () => false;
    expect(await pending).toMatchObject({ sellerRevision: 8 }); expect(t.current().presentation.profile.displayName).toBe(request().command.displayName);
    await expect(executeUsFinancialPilotSeller({ ...t.deps, actor: { ...owner(), role: 'admin' } }, request())).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 });
    await expect(executeUsFinancialPilotSeller(new Proxy(t.deps, { getOwnPropertyDescriptor() { throw new Error('PRIVATE PROXY'); } }), request())).rejects.toMatchObject({ code: 'invalid_financial_seller_data', status: 503 });
  });
});

describe('B0 closed current presentation observations', () => {
  it('preserves historical contacts and PostgreSQL microseconds without inventing a seller', () => {
    const value = copy(source()), captured = validateUsFinancialPilotSellerRead(value, organizationId);
    value.presentation.profile.displayName = 'Mutated'; value.head.bankRevision++;
    expect(captured).toEqual(source()); expect(allFrozen(captured)).toBe(true);
    const withoutContacts = { ...source().presentation, profile: { displayName: 'Historic name only' } };
    expect(validateUsFinancialPilotSellerPresentation(withoutContacts).profile).toEqual({ displayName: 'Historic name only' });
  });
  it('checks S0 + count exactly rather than clamping, rounding or trusting origin', () => {
    const value = { ...source().presentation, origin: 'financial-v5', baseSellerRevision: 2, changeCount: 1000, sellerRevision: 1002, changeSha256: 'a'.repeat(64) };
    expect(validateUsFinancialPilotSellerPresentation(value).sellerRevision).toBe(1002);
    expect(validateUsFinancialPilotSellerPresentation({ ...value, baseSellerRevision: Number.MAX_SAFE_INTEGER - 2, changeCount: 1, sellerRevision: Number.MAX_SAFE_INTEGER - 1 }).sellerRevision).toBe(Number.MAX_SAFE_INTEGER - 1);
    for (const patch of [{ sellerRevision: 1001 }, { changeCount: 1001, sellerRevision: 1003 }, { origin: 'legacy-frozen' }, { changeCount: 0, sellerRevision: 2 },
      { changeSha256: null }, { changeSha256: 'A'.repeat(64) }, { baseSellerRevision: Number.MAX_SAFE_INTEGER - 1, changeCount: 1, sellerRevision: Number.MAX_SAFE_INTEGER },
      { changeCount: -0 }, { baseSellerRevision: 0 }]) expect(() => validateUsFinancialPilotSellerPresentation({ ...value, ...patch })).toThrow(expect.objectContaining(invalidPrivate));
    expect(() => validateUsFinancialPilotSellerPresentation({ ...source().presentation, changeSha256: 'a'.repeat(64) })).toThrow(expect.objectContaining(invalidPrivate));
  });
  it.each(['2026-10-10', '2026-10-10T12:00:00', '2026-02-30T12:00:00Z', '0000-01-01T00:00:00Z', '2026-10-10T24:00:00Z',
    '2026-10-10T12:00:00+24:00', '2026-10-10T12:00:00.1234567Z'])('refuses invalid legacy time %s', updatedAt => {
    expect(() => validateUsFinancialPilotSellerPresentation({ ...source().presentation, updatedAt })).toThrow(expect.objectContaining(invalidPrivate));
  });
  it('requires a closed correlated composite head, not a financial book or generic receipt', () => {
    for (const patch of [{ revision: 0 }, { revision: 1.5 }, { bankRevision: -1 }, { bankRevision: -0 }, { sellerRevision: 0 }, { ledgerRevision: 7 }, { authority: true }]) {
      expect(() => validateUsFinancialPilotSellerHead({ ...source().head, ...patch }, organizationId)).toThrow(expect.objectContaining(invalidPrivate));
    }
    expect(() => validateUsFinancialPilotSellerHead(source().head, 'foreign')).toThrow(expect.objectContaining(invalidPrivate));
    expect(() => validateUsFinancialPilotSellerRead({ ...source(), head: { ...source().head, sellerRevision: 8 } })).toThrow(expect.objectContaining(invalidPrivate));
    for (const patch of [{ book: {} }, { ledger: {} }, { register: {} }]) expect(() => validateUsFinancialPilotSellerRead({ ...source(), ...patch })).toThrow(expect.objectContaining(invalidPrivate));
    const value = { ...source(), oversized: '🌍'.repeat(US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES / 4) };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES);
    expect(() => validateUsFinancialPilotSellerRead(value)).toThrow(expect.objectContaining(invalidPrivate));
  });
  it('does not run accessors or expose private reflective failures in any synchronous projection', () => {
    const getter = vi.fn(() => 'PRIVATE SECRET');
    for (const validate of [validateUsFinancialPilotSellerHead, validateUsFinancialPilotSellerPresentation, validateUsFinancialPilotSellerRead]) {
      expect(() => validate(Object.defineProperty({}, 'private', { enumerable: true, get: getter }))).toThrow(expect.objectContaining(invalidPrivate));
      expect(() => validate(new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE DATABASE SECRET'); } }))).toThrow(expect.objectContaining(invalidPrivate));
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('B0 historical seller proposals without effective admission or persistence', () => {
  it('builds both deterministic hashes from the exact before and full actor, then advances S alone', async () => {
    const before = source(), textBefore = canonicalErpJson(before), proof = await buildUsFinancialPilotSellerProof(before, request(), owner());
    expect(proof).toMatchObject({ schemaVersion: 1, organizationId, request: request(), actor: owner(), before: before.presentation,
      after: { displayName: request().command.displayName, contactEmail: 'sales@example.test' }, sellerRevision: 8, changeIndex: 1, changedAt: owner().timestamp });
    expect(proof.commandHash).toBe(await sha256Hex(canonicalErpJson(['zentra:us:financial-pilot:seller:v1', organizationId, owner().userId, request()])));
    const { changeSha256, ...payload } = proof;
    expect(changeSha256).toBe(await sha256Hex(canonicalErpJson(payload))); expect(allFrozen(proof)).toBe(true);
    const applied = await applyUsFinancialPilotSellerProof(before, proof);
    expect(applied.head).toEqual({ ...before.head, sellerRevision: 8 });
    expect(applied.presentation).toEqual({ origin: 'financial-v5', baseSellerRevision: 7, sellerRevision: 8, changeCount: 1,
      profile: proof.after, updatedBy: owner().userId, updatedAt: owner().timestamp, changeSha256 });
    expect(applied.head.revision).toBe(before.head.revision); expect(applied.head.bankRevision).toBe(before.head.bankRevision);
    expect(allFrozen(applied)).toBe(true); expect(canonicalErpJson(before)).toBe(textBefore);
    await expect(applyUsFinancialPilotSellerProof(applied, proof)).rejects.toMatchObject({ code: 'seller_revision_conflict', status: 409 });
  });
  it('allows an identical profile under a new UUID, still counting every proposed change', async () => {
    const first = await buildUsFinancialPilotSellerProof(source(), request(), owner()), current = await applyUsFinancialPilotSellerProof(source(), first);
    const next = { ...request(), requestId: id(2), expectedSellerRevision: 8 };
    const second = await buildUsFinancialPilotSellerProof(current, next, owner()), after = await applyUsFinancialPilotSellerProof(current, second);
    expect(second.before.profile).toEqual(second.after); expect(second.commandHash).not.toBe(first.commandHash); expect(second.changeSha256).not.toBe(first.changeSha256);
    expect(after.presentation).toMatchObject({ baseSellerRevision: 7, sellerRevision: 9, changeCount: 2 });
    expect(after.head).toEqual({ ...source().head, sellerRevision: 9 });
  });
  it('compares real instants at microsecond precision across legacy offsets and allows equality', async () => {
    const value = copy(source()); value.presentation.updatedAt = '2026-10-10T08:00:00.123999-04:00';
    await expect(buildUsFinancialPilotSellerProof(value, request(), { ...owner(), timestamp: '2026-10-10T12:00:00.123Z' })).rejects.toMatchObject({ code: 'seller_clock_conflict', status: 409 });
    expect((await buildUsFinancialPilotSellerProof(value, request(), owner())).before.updatedAt).toBe(value.presentation.updatedAt);
    value.presentation.updatedAt = '2026-10-10T13:00:00.124000+01:00';
    expect((await buildUsFinancialPilotSellerProof(value, request(), owner())).changedAt).toBe(owner().timestamp);
    value.presentation.updatedAt = '2026-10-10T12:00:00.124001Z';
    await expect(buildUsFinancialPilotSellerProof(value, request(), owner())).rejects.toMatchObject({ code: 'seller_clock_conflict', status: 409 });
    value.presentation.updatedAt = '2026-10-10T23:59:59.999999-12:00';
    await expect(buildUsFinancialPilotSellerProof(value, request(), { ...owner(), timestamp: '2026-10-11T11:59:59.999Z' })).rejects.toMatchObject({ code: 'seller_clock_conflict', status: 409 });
    expect((await buildUsFinancialPilotSellerProof(value, request(), { ...owner(), timestamp: '2026-10-11T12:00:00.000Z' })).sellerRevision).toBe(8);
  });
  it('rejects F/S conflicts, exact count capacity and revision overflow without saturation', async () => {
    await expect(buildUsFinancialPilotSellerProof(source(), { ...request(), expectedRevision: 10 }, owner())).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    await expect(buildUsFinancialPilotSellerProof(source(), { ...request(), expectedSellerRevision: 8 }, owner())).rejects.toMatchObject({ code: 'seller_revision_conflict', status: 409 });
    const full = copy(source()); full.head.sellerRevision = 1007; full.presentation = { ...full.presentation, origin: 'financial-v5', sellerRevision: 1007, changeCount: US_FINANCIAL_PILOT_SELLER_MAX_CHANGES, changeSha256: 'a'.repeat(64) };
    await expect(buildUsFinancialPilotSellerProof(full, { ...request(), expectedSellerRevision: 1007 }, owner())).rejects.toMatchObject({ code: 'seller_limit_reached', status: 409 });
    const last = copy(source()); last.head.sellerRevision = Number.MAX_SAFE_INTEGER - 1; last.presentation.baseSellerRevision = last.head.sellerRevision; last.presentation.sellerRevision = last.head.sellerRevision;
    // Observation/request ceilings are valid; advancing beyond them is a409
    // capacity conflict, rather than a silently clamped or malformed request.
    expect(validateUsFinancialPilotSellerRequest({ ...request(), expectedRevision: Number.MAX_SAFE_INTEGER - 1, expectedSellerRevision: Number.MAX_SAFE_INTEGER - 1 })).toMatchObject({ expectedRevision: Number.MAX_SAFE_INTEGER - 1, expectedSellerRevision: Number.MAX_SAFE_INTEGER - 1 });
    await expect(buildUsFinancialPilotSellerProof(last, { ...request(), expectedSellerRevision: last.head.sellerRevision }, owner())).rejects.toMatchObject({ code: 'seller_limit_reached', status: 409 });
    const oneLeft = copy(full); oneLeft.head.sellerRevision--; oneLeft.presentation.sellerRevision--; oneLeft.presentation.changeCount--;
    expect((await buildUsFinancialPilotSellerProof(oneLeft, { ...request(), expectedSellerRevision: 1006 }, owner())).changeIndex).toBe(1000);
  });
  it.each([{ role: 'admin' }, { role: 'accountant' }, { managementEntitled: false }, { organizationId: 'foreign' }, { userId: ' owner ' },
    { timestamp: '2026-10-10T12:00:00Z' }, { timestamp: '2026-10-10T08:00:00.124-04:00' }, { timestamp: '2026-10-10T12:00:00.124001Z' }, { token: 'PRIVATE' }])('rejects malformed structural actor %j without calling any authority', async patch => {
    await expect(buildUsFinancialPilotSellerProof(source(), request(), { ...owner(), ...patch } as FinancialAuthority)).rejects.toMatchObject(invalidPrivate);
  });
  it('captures request, source profile and actor aliases before the first await', async () => {
    const read = copy(source()), input = copy(request()), currentActor = copy(owner()), before = copy(read), original = copy(input), historicalActor = copy(currentActor);
    const pending = buildUsFinancialPilotSellerProof(read, input, currentActor);
    read.head.revision++; read.head.bankRevision++; read.presentation.profile.displayName = 'Changed before digest';
    input.command.displayName = 'Changed command'; input.requestId = id(20); currentActor.userId = 'other-owner'; currentActor.timestamp = '2026-10-11T00:00:00.000Z';
    const proof = await pending; expect(proof.before).toEqual(before.presentation); expect(proof.request).toEqual(original); expect(proof.actor).toEqual(historicalActor);
    expect(proof).toEqual(await buildUsFinancialPilotSellerProof(before, original, historicalActor));
  });
  it('captures proof and optional expectations synchronously while preserving the historical actor clock', async () => {
    const proof = copy(await buildUsFinancialPilotSellerProof(source(), request(), owner())), original = copy(proof), expectation = copy(expected());
    expectation.actor.timestamp = '2026-10-12T12:00:00.000Z';
    const pending = validateUsFinancialPilotSellerProof(proof, organizationId, expectation);
    proof.before.profile.displayName = 'Changed'; proof.after.displayName = 'Changed'; proof.actor.userId = 'Changed';
    expectation.request.command.displayName = 'Changed'; expectation.actor.userId = 'Changed'; expectation.actor.timestamp = '2026-10-13T00:00:00.000Z';
    expect(await pending).toEqual(original);
    expect((await pending).actor.timestamp).toBe(owner().timestamp);
  });
  it('binds all semantic correlations even when a caller recomputes both untrusted hashes', async () => {
    const original = await buildUsFinancialPilotSellerProof(source(), request(), owner());
    const patches: readonly ((value: Mutable<UsFinancialPilotSellerProof>) => void)[] = [
      value => { value.after.displayName = 'Not the command'; }, value => { value.sellerRevision++; }, value => { value.changeIndex++; },
      value => { value.request.expectedSellerRevision++; }, value => { value.actor.organizationId = 'foreign'; }, value => { value.actor.role = 'admin'; },
      value => { value.changedAt = '2026-10-10T12:00:00.125Z'; }, value => { value.actor.timestamp = '2026-10-10T12:00:00.123Z'; value.changedAt = value.actor.timestamp; },
      value => { value.before.changeCount = 1; },
    ];
    for (const patch of patches) { const value = copy(original); patch(value); await expect(validateUsFinancialPilotSellerProof(await seal(value))).rejects.toMatchObject(invalidPrivate); }
    for (const field of ['address', 'ein', 'currency', 'authority']) await expect(validateUsFinancialPilotSellerProof(await seal({ ...original, [field]: 'forged' }))).rejects.toMatchObject(invalidPrivate);
    await expect(validateUsFinancialPilotSellerProof({ ...original, commandHash: 'f'.repeat(64) })).rejects.toMatchObject(invalidPrivate);
    await expect(validateUsFinancialPilotSellerProof({ ...original, changeSha256: 'f'.repeat(64) })).rejects.toMatchObject(invalidPrivate);
  });
  it('validates historic evidence independently of the current head but refuses stale application', async () => {
    const proof = await buildUsFinancialPilotSellerProof(source(), request(), owner()), applied = await applyUsFinancialPilotSellerProof(source(), proof);
    const later = { ...applied, head: { ...applied.head, revision: 90, bankRevision: 14 } };
    expect(await validateUsFinancialPilotSellerProof(proof, organizationId, { ...expected(), actor: { ...owner(), timestamp: '2026-10-20T00:00:00.000Z' } })).toEqual(proof);
    await expect(applyUsFinancialPilotSellerProof(later, proof)).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    const divergent = copy(source()); divergent.presentation.profile.displayName = 'Different current identity at same S';
    await expect(applyUsFinancialPilotSellerProof(divergent, proof)).rejects.toMatchObject({ code: 'seller_revision_conflict', status: 409 });
    const newerBank = { ...source(), head: { ...source().head, bankRevision: 99 } };
    const result = await applyUsFinancialPilotSellerProof(newerBank, proof); expect(result.head.bankRevision).toBe(99); expect(result.head.revision).toBe(9);
  });
  it('captures the apply source and proof before hashing, without mutating either', async () => {
    const proof = copy(await buildUsFinancialPilotSellerProof(source(), request(), owner())), originalProof = copy(proof), read = copy(source()), originalRead = copy(read);
    const pending = applyUsFinancialPilotSellerProof(read, proof);
    read.head.bankRevision = 50; read.presentation.profile.displayName = 'Other'; proof.after.displayName = 'Other'; proof.request.expectedRevision = 100;
    expect(await pending).toEqual(await applyUsFinancialPilotSellerProof(originalRead, originalProof)); expect((await pending).head.bankRevision).toBe(4);
  });
});

describe('B0 historical receipts stay distinct from current financial heads', () => {
  it('projects historical source F even after a current head advances, including a structural replay marker', async () => {
    const proof = await buildUsFinancialPilotSellerProof(source(), request(), owner()), current = await applyUsFinancialPilotSellerProof(source(), proof);
    const receipt = await projectUsFinancialPilotSellerReceipt(proof, true);
    expect(receipt).toEqual({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, requestId: id(1), actorId: owner().userId, action: 'update_seller_presentation',
      sourceRevision: 9, sellerRevision: 8, commandHash: proof.commandHash, changeSha256: proof.changeSha256, changedAt: owner().timestamp, replayed: true });
    expect(receipt).not.toHaveProperty('revision'); expect(receipt).not.toHaveProperty('bankRevision'); expect(allFrozen(receipt)).toBe(true);
    const future = { ...current.head, revision: 100, sellerRevision: 80 };
    expect((await validateUsFinancialPilotSellerReceipt(receipt, organizationId, { ...expected(), actor: { ...owner(), timestamp: '2026-10-30T00:00:00.000Z' } })).sourceRevision).toBe(9);
    expect(future.revision).toBe(100);
    expect(() => validateUsFinancialPilotSellerHead(receipt)).toThrow(expect.objectContaining(invalidPrivate));
  });
  it('captures projection proof and receipt expectations before an asynchronous hash', async () => {
    const proof = copy(await buildUsFinancialPilotSellerProof(source(), request(), owner())), original = copy(proof), projection = projectUsFinancialPilotSellerReceipt(proof, false);
    proof.actor.userId = 'Other'; proof.request.expectedRevision = 200;
    expect(await projection).toEqual(await projectUsFinancialPilotSellerReceipt(original, false));
    const receipt = copy(await projection), snapshot = copy(receipt), expectation = copy(expected()), pending = validateUsFinancialPilotSellerReceipt(receipt, organizationId, expectation);
    receipt.sourceRevision = 900; receipt.actorId = 'Other'; expectation.request.expectedRevision = 900; expectation.actor.userId = 'Other';
    expect(await pending).toEqual(snapshot);
  });
  it('requires the full request and same structural owner identity, without comparing a current timestamp', async () => {
    const receipt = await projectUsFinancialPilotSellerReceipt(await buildUsFinancialPilotSellerProof(source(), request(), owner()));
    for (const expectation of [{ ...expected(), request: { ...request(), requestId: id(2) } }, { ...expected(), request: { ...request(), expectedRevision: 10 } },
      { ...expected(), request: { ...request(), expectedSellerRevision: 8 } }, { ...expected(), request: { ...request(), command: { ...request().command, contactPhone: '+1 555 0102' } } },
      { ...expected(), actor: { ...owner(), userId: 'different-owner' } }, { ...expected(), actor: { ...owner(), organizationId: 'foreign' } },
      { ...expected(), actor: { ...owner(), role: 'admin' as const } }]) await expect(validateUsFinancialPilotSellerReceipt(receipt, organizationId, expectation)).rejects.toMatchObject(invalidPrivate);
    for (const expectation of [{ request: request() }, { actor: owner() }, { ...expected(), authority: true }]) {
      await expect(validateUsFinancialPilotSellerReceipt(receipt, organizationId, expectation as UsFinancialPilotSellerExpectation)).rejects.toMatchObject(invalidPrivate);
    }
  });
  it('rejects generic-current revisions, invalid scalar metadata and forged request correlations', async () => {
    const receipt = await projectUsFinancialPilotSellerReceipt(await buildUsFinancialPilotSellerProof(source(), request(), owner()));
    for (const patch of [{ revision: 9 }, { bankRevision: 4 }, { ledgerRevision: 2 }, { sourceRevision: 0 }, { sourceRevision: 10 }, { sellerRevision: 1 },
      { sellerRevision: 9 }, { requestId: id(9) }, { actorId: 'Other' }, { action: 'issue_invoice' }, { changedAt: '2026-10-10T12:00:00.124001Z' },
      { replayed: 'true' }, { commandHash: 'e'.repeat(64) }, { changeSha256: 'UPPERCASE' }]) {
      await expect(validateUsFinancialPilotSellerReceipt({ ...receipt, ...patch }, organizationId, expected())).rejects.toMatchObject(invalidPrivate);
    }
    await expect(validateUsFinancialPilotSellerReceipt(receipt, 'foreign')).rejects.toMatchObject(invalidPrivate);
  });
  it('does not execute asynchronous-boundary getters/proxies or retain their secret failure text', async () => {
    const getter = vi.fn(() => 'PRIVATE TOKEN'), value = Object.defineProperty({}, 'private', { enumerable: true, get: getter });
    await expect(validateUsFinancialPilotSellerProof(value)).rejects.toMatchObject(invalidPrivate);
    await expect(validateUsFinancialPilotSellerReceipt(value)).rejects.toMatchObject(invalidPrivate);
    await expect(projectUsFinancialPilotSellerReceipt(value)).rejects.toMatchObject(invalidPrivate);
    await expect(applyUsFinancialPilotSellerProof(source(), value)).rejects.toMatchObject(invalidPrivate);
    await expect(buildUsFinancialPilotSellerProof(source(), request(), value as FinancialAuthority)).rejects.toMatchObject(invalidPrivate);
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE DATABASE DETAIL'); } });
    await expect(validateUsFinancialPilotSellerProof(proxy)).rejects.toMatchObject(invalidPrivate);
    await expect(validateUsFinancialPilotSellerReceipt(proxy)).rejects.toMatchObject(invalidPrivate);
    const proof = await buildUsFinancialPilotSellerProof(source(), request(), owner()), receipt = await projectUsFinancialPilotSellerReceipt(proof);
    const hostileExpectation = Object.defineProperty({ actor: owner() }, 'request', { enumerable: true, get: getter }) as UsFinancialPilotSellerExpectation;
    await expect(validateUsFinancialPilotSellerProof(proof, organizationId, hostileExpectation)).rejects.toMatchObject(invalidPrivate);
    await expect(validateUsFinancialPilotSellerReceipt(receipt, organizationId, hostileExpectation)).rejects.toMatchObject(invalidPrivate); expect(getter).not.toHaveBeenCalled();
    await expect(validateUsFinancialPilotSellerProof({ ...proof, private: 'x'.repeat(US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES) })).rejects.toMatchObject(invalidPrivate);
    await expect(validateUsFinancialPilotSellerReceipt({ ...receipt, private: 'x'.repeat(US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES) })).rejects.toMatchObject(invalidPrivate);
  });
  it('maps digest rejections to stable private metadata and keeps invalid public requests at422', async () => {
    const proof = await buildUsFinancialPilotSellerProof(source(), request(), owner()), receipt = await projectUsFinancialPilotSellerReceipt(proof);
    const hash = vi.spyOn(crypto.subtle, 'digest');
    try {
      const operations = [
        () => usFinancialPilotSellerCommandHash(organizationId, owner().userId, request()),
        () => buildUsFinancialPilotSellerProof(source(), request(), owner()),
        () => validateUsFinancialPilotSellerProof(proof),
        () => applyUsFinancialPilotSellerProof(source(), proof),
        () => projectUsFinancialPilotSellerReceipt(proof),
        () => validateUsFinancialPilotSellerReceipt(receipt, organizationId, expected()),
      ];
      for (const operation of operations) {
        hash.mockRejectedValueOnce(new Error('PRIVATE CRYPTO/PROVIDER DETAIL'));
        await expect(operation()).rejects.toMatchObject(invalidPrivate);
      }
      const calls = hash.mock.calls.length;
      await expect(usFinancialPilotSellerCommandHash(organizationId, owner().userId, { ...request(), expectedRevision: 0 })).rejects.toMatchObject({ code: 'invalid_financial_pilot_request', status: 422 });
      expect(hash.mock.calls).toHaveLength(calls);
    } finally { hash.mockRestore(); }
  });
});
