import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { LedgerError } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5, projectUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5, type UsFinancialRuntimeDependenciesV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { appendUsFinancialPilotBankRegister, validateUsFinancialPilotBankHistory, validateUsFinancialPilotBankReceipt, type UsFinancialPilotBankCommand, type UsFinancialPilotBankRegister, type UsFinancialPilotBankRequest } from './us-financial-pilot-bank';
import { createUsFinancialPilotBankHandlers, type UsFinancialPilotBankDependencies } from './us-financial-pilot-bank-server';

const org = '0a7ec0b8-a465-4df9-b756-e99aca4439ce';
const imported: UsFinancialPilotBankCommand = { type: 'create_statement', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', openingMinor: '0', closingMinor: '10000', lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Synthetic deposit' }] };
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
async function fixture() {
  const original = await financialKernelFixture({ paid: '10000' }), data = JSON.parse(JSON.stringify(original).replaceAll(original.actor.organizationId, org)) as typeof original;
  const book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), financial = await createInMemoryUsFinancialKernelStoreV5(book, data.policy, actor => actor);
  let register: UsFinancialPilotBankRegister = { schemaVersion: 1, organizationId: org, bankRevision: 0, records: [], operations: [] };
  const readBook = async () => await financial.read(org) as UsFinancialBookV5;
  const store = {
    read: vi.fn(async () => ({ book: await readBook(), register: clone(register) })),
    head: vi.fn(async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: (await readBook()).revision, bankRevision: register.bankRevision })),
    receipt: vi.fn(async (id: string) => clone(register.operations.find(p => p.request.requestId === id) ?? null)),
    commit: vi.fn(async (input: { request: UsFinancialPilotBankRequest; record: Parameters<typeof appendUsFinancialPilotBankRegister>[1]; proof: Parameters<typeof appendUsFinancialPilotBankRegister>[2] }) => {
      const prior = register.operations.find(p => p.request.requestId === input.request.requestId);
      if (prior) { if (canonicalErpJson(prior) !== canonicalErpJson(input.proof)) throw new ErpError('idempotency_conflict', 409); return clone(prior); }
      if (input.request.expectedRevision !== (await readBook()).revision || input.request.expectedBankRevision !== register.bankRevision) throw new ErpError('revision_conflict', 409);
      const next = appendUsFinancialPilotBankRegister(register, input.record, input.proof); await validateUsFinancialPilotBankHistory(await readBook(), next); register = next; return clone(input.proof);
    }),
  };
  const scope = { scope: { organizationId: org, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const deps: UsFinancialPilotBankDependencies = { enabled: vi.fn(() => true), authority: vi.fn(async () => ({ mode: 'browser' as const, actor: data.actor })), configuration: vi.fn(async () => data.configuration), scope: vi.fn(async () => scope), store: vi.fn(() => store), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn() };
  const request = (path: string, init: RequestInit = {}) => { const headers = new Headers({ 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': data.actor.userId, 'Sec-Fetch-Site': 'same-origin' }); new Headers(init.headers).forEach((v, k) => headers.set(k, v)); return new Request(`https://zentraapp.ch/api/international/workspaces/${org}/financial-pilot/bank/${path}`, { ...init, headers }); };
  const post = (input: unknown, headers: Record<string, string> = {}) => request('operations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://zentraapp.ch', ...headers }, body: JSON.stringify(input) });
  const envelope = async (command: UsFinancialPilotBankCommand, requestId = randomUUID()): Promise<UsFinancialPilotBankRequest> => ({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: (await readBook()).revision, expectedBankRevision: register.bankRevision, expectedStatementRevision: command.type === 'create_statement' ? null : register.records.find(r => r.record.reconciliation.statement.id === command.statementId)!.record.reconciliation.revision, command });
  const handlers = createUsFinancialPilotBankHandlers(deps);
  const submit = async (command: UsFinancialPilotBankCommand) => { const input = await envelope(command), response = await handlers.POST(post(input), org); expect(await response.clone().text(), `status ${response.status}`).not.toContain('financial_service_unavailable'); expect(response.status).toBe(200); return { input, receipt: validateUsFinancialPilotBankReceipt(await response.json(), org, input) }; };
  const engine: UsFinancialRuntimeDependenciesV5 = { configuration: data.configuration, actor: data.actor, policy: data.policy, store: financial, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }), resolveTax: async () => { throw Error('No tax provider in bank test'); } };
  return { ...data, book, financial, readBook, register: () => clone(register), store, scope, deps, request, post, envelope, handlers, submit, engine };
}

describe('bank HTTP — real private domain and true V5 memory book, synthetic Auth/D1', () => {
  it('imports, approves and completes without changing finance, then retains history after later finance', async () => {
    const t = await fixture(), before = canonicalErpJson(await t.readBook()), view = await projectUsFinancialBookV5(await t.readBook()), payment = view.ledger.entries.find(e => e.id.includes('payment'))!;
    expect(payment).toBeDefined(); expect(payment.revision).not.toBe(t.book.revision);
    const created = await t.submit(imported), id = created.receipt.statementId;
    expect(created.receipt).toMatchObject({ revision: t.book.revision, bankRevision: 1, statementRevision: 0, statementId: created.input.requestId });
    const matched = await t.submit({ type: 'approve_match', statementId: id, statementLineIds: [id + ':1'], journalRevisions: [payment.revision] });
    const complete = await t.submit({ type: 'complete', statementId: id }); expect(complete.receipt).toMatchObject({ revision: t.book.revision, bankRevision: 3, statementRevision: 2 });
    expect(canonicalErpJson(await t.readBook())).toBe(before);
    await executeUsFinancialKernelV5(t.engine, { idempotencyKey: 'synthetic-close', expectedRevision: t.book.revision, command: { type: 'erp_command', request: { type: 'close_period', periodId: '2026' } } });
    const currentFinance = canonicalErpJson(await t.readBook()), currentRegister = canonicalErpJson(t.register());
    for (const item of [created, matched, complete]) { const response = await t.handlers.POST(t.post(item.input), org); expect(response.status).toBe(200); expect(await response.json()).toEqual(item.receipt); }
    expect(canonicalErpJson(await t.readBook())).toBe(currentFinance); expect(canonicalErpJson(t.register())).toBe(currentRegister);
    const q = `revision=${(await t.readBook()).revision}&bankRevision=3`, read = await t.handlers.STATEMENT(t.request(`statements/${id}?${q}&origin=financial-v5`), org, id); expect(read.status).toBe(200);
    const body = await read.text(); for (const secret of ['commandHash', 'bookSha256', 'idempotencyKey', 'SYNTHETIC-LOCAL-POLICY']) expect(body).not.toContain(secret);
  });
  it('voids a pending statement and replays all exact receipts without a new financial effect', async () => {
    const t = await fixture(), created = await t.submit(imported), voided = await t.submit({ type: 'void_statement', statementId: created.receipt.statementId, reason: 'Synthetic duplicate source cancelled' });
    const before = canonicalErpJson(t.register()); expect(voided.receipt.statementRevision).toBe(1);
    for (const item of [created, voided]) { const response = await t.handlers.POST(t.post(item.input), org); expect(response.status).toBe(200); expect(await response.json()).toEqual(item.receipt); }
    expect(canonicalErpJson(t.register())).toBe(before); expect((await t.readBook()).events).toHaveLength(0);
  });
  it.each(['lostReply', 'late409'] as const)('recovers the exact durable import after %s and later bank progress', async kind => {
    const t = await fixture(), input = await t.envelope(imported), originalCommit = t.store.commit; let first = true;
    t.store.commit = vi.fn(async candidate => { const proof = await originalCommit(candidate); if (first) { first = false; if (kind === 'late409') throw new ErpError('financial_source_changed', 409); throw Error('Lost synthetic response after real memory commit'); } return proof; });
    const h = createUsFinancialPilotBankHandlers(t.deps), initial = await h.POST(t.post(input), org); expect(initial.status).toBe(200); expect(t.register().bankRevision).toBe(1);
    await t.submit({ type: 'void_statement', statementId: input.requestId, reason: 'Synthetic subsequent action' }); const snapshot = canonicalErpJson(t.register()), replay = await h.POST(t.post(input), org);
    expect(replay.status).toBe(200); expect(validateUsFinancialPilotBankReceipt(await replay.json(), org, input).bankRevision).toBe(1); expect(canonicalErpJson(t.register())).toBe(snapshot);
  });
  it('rejects changed original heads or content under the same UUID and another actor', async () => {
    const t = await fixture(), created = await t.submit(imported), before = canonicalErpJson(t.register());
    for (const changed of [{ ...created.input, expectedRevision: created.input.expectedRevision + 1 }, { ...created.input, expectedBankRevision: 1 }, { ...created.input, command: { ...imported, closingMinor: '9999' } }]) { const response = await t.handlers.POST(t.post(changed), org); expect([409, 422]).toContain(response.status); expect(Object.keys(await response.json() as object)).toEqual(['error']); }
    const actor = { ...t.actor, userId: 'another-authorized-owner' }; t.deps.authority = async () => ({ mode: 'browser', actor }); t.deps.scope = async () => ({ ...t.scope, scope: { ...t.scope.scope, actor } });
    const r = await createUsFinancialPilotBankHandlers(t.deps).POST(t.post(created.input, { 'X-Zentra-Expected-User': actor.userId }), org); expect(r.status).toBe(409); expect(canonicalErpJson(t.register())).toBe(before);
  });
  it('withholds a committed receipt after logout and recovers when current authority is restored', async () => {
    const t = await fixture(), input = await t.envelope(imported), commit = t.store.commit; let revoked = false;
    t.store.commit = vi.fn(async candidate => { const result = await commit(candidate); revoked = true; return result; }); t.deps.authority = async () => { if (revoked) throw new AccountPublicError('Synthetic logout', 401); return { mode: 'browser', actor: t.actor }; };
    const h = createUsFinancialPilotBankHandlers(t.deps); expect((await h.POST(t.post(input), org)).status).toBe(401); expect(t.register().bankRevision).toBe(1); revoked = false;
    expect((await h.POST(t.post(input), org)).status).toBe(200); expect(t.register().operations).toHaveLength(1);
  });
  it('keeps a lost response uncertain while receipt lookup is unavailable, then recovers once', async () => {
    const t = await fixture(), input = await t.envelope(imported), commit = t.store.commit, receipt = t.store.receipt; let unavailable = false;
    t.store.commit = vi.fn(async candidate => { await commit(candidate); unavailable = true; throw Error('Synthetic reply lost'); }); t.store.receipt = vi.fn(async id => { if (unavailable) throw Error('Synthetic receipt outage'); return receipt(id); });
    const h = createUsFinancialPilotBankHandlers(t.deps); expect((await h.POST(t.post(input), org)).status).toBe(503); expect(t.register().operations).toHaveLength(1); unavailable = false;
    expect((await h.POST(t.post(input), org)).status).toBe(200); expect(t.register().operations).toHaveLength(1); expect(t.store.commit).toHaveBeenCalledTimes(1);
  });
  it('reprobes after a real matching commit lands between receipt probe and CAS', async () => {
    const t = await fixture(), input = await t.envelope(imported), read = t.store.read; let first = true;
    t.store.read = vi.fn(async () => { const captured = await read(); if (first) { first = false; expect((await createUsFinancialPilotBankHandlers(t.deps).POST(t.post(input), org)).status).toBe(200); } return captured; });
    const r = await createUsFinancialPilotBankHandlers(t.deps).POST(t.post(input), org); expect(r.status).toBe(200); expect(validateUsFinancialPilotBankReceipt(await r.json(), org, input).bankRevision).toBe(1); expect(t.register().operations).toHaveLength(1);
  });
  it.each(['revision_conflict', 'bank_revision_conflict'])('bounds repeated CAS recovery for %s without changing the envelope', async code => {
    const t = await fixture(), input = await t.envelope(imported); t.store.commit = vi.fn(async () => { throw new ErpError(code, 409); });
    const r = await createUsFinancialPilotBankHandlers(t.deps).POST(t.post(input), org); expect(r.status).toBe(409); expect(t.store.commit).toHaveBeenCalledTimes(2); expect(t.store.commit.mock.calls[0][0]).toEqual(t.store.commit.mock.calls[1][0]); expect(t.register().bankRevision).toBe(0);
  });
  it('fences the composite financial and bank heads independently after projections', async () => {
    const t = await fixture(); for (const field of ['revision', 'bankRevision'] as const) {
      t.store.head.mockResolvedValue({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: t.book.revision + (field === 'revision' ? 1 : 0), bankRevision: field === 'bankRevision' ? 1 : 0 });
      const r = await t.handlers.CONTEXT(t.request(`context?revision=${t.book.revision}&bankRevision=0`), org); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'financial_snapshot_changed' });
    }
  });
  it.each(['user', 'role', 'grant', 'optIn', 'policy', 'configuration', 'gate', 'device', 'entitlement'] as const)('renews full admission after a private read changes %s', async kind => {
    const t = await fixture(); let changed = false; const read = t.store.read; t.store.read = vi.fn(async () => { const result = await read(); changed = true; return result; });
    t.deps.authority = async () => ({ mode: changed && kind === 'device' ? 'device' : 'browser', actor: { ...t.actor, ...(changed && kind === 'user' ? { userId: 'different' } : {}), ...(changed && kind === 'role' ? { role: 'admin' as const } : {}), ...(changed && kind === 'entitlement' ? { managementEntitled: false } : {}) } });
    t.deps.scope = async () => ({ ...t.scope, optInVersion: changed && kind === 'optIn' ? 2 : 1, scope: { ...t.scope.scope, grantVersion: changed && kind === 'grant' ? 2 : 1, policy: changed && kind === 'policy' ? { ...t.policy, approval: { ...t.policy.approval, reference: 'different' } } : t.policy } });
    t.deps.configuration = async () => changed && kind === 'configuration' ? { ...t.configuration, language: 'fr' } : t.configuration; t.deps.enabled = () => !(changed && kind === 'gate');
    const r = await createUsFinancialPilotBankHandlers(t.deps).CONTEXT(t.request(`context?revision=${t.book.revision}&bankRevision=0`), org); expect([401, 402, 403, 404, 409]).toContain(r.status); expect(Object.keys(await r.json() as object)).toEqual(['error']); expect(t.register().bankRevision).toBe(0);
  });
  it.each(['read', 'receipt', 'commit', 'head'] as const)('authority rejection takes precedence after failed private %s await', async method => {
    const t = await fixture(); let changed = false; Object.assign(t.store, { [method]: vi.fn(async () => { changed = true; throw new ErpError('bank_record_not_found', 404); }) });
    t.deps.authority = async () => { if (changed) throw new AccountPublicError('Revoked', 401); return { mode: 'browser', actor: t.actor }; }; const h = createUsFinancialPilotBankHandlers(t.deps);
    const r = method === 'head' ? await h.HEAD(t.request('head'), org) : method === 'read' ? await h.CONTEXT(t.request(`context?revision=${t.book.revision}&bankRevision=0`), org) : await h.POST(t.post(await t.envelope(imported)), org);
    expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: 'unauthorized' });
  });
  it.each(['rateLimit', 'configuration', 'scope'] as const)('rechecks the installation gate even after initial rejected %s await', async method => {
    const t = await fixture(); let closed = false; t.deps.enabled = () => !closed;
    Object.assign(t.deps, { [method]: vi.fn(async () => { closed = true; throw new ErpError('bank_record_not_found', 404); }) });
    const r = await createUsFinancialPilotBankHandlers(t.deps).HEAD(t.request('head'), org); expect(r.status).toBe(404); expect(await r.json()).toEqual({ error: 'feature_unavailable' }); expect(t.store.head).not.toHaveBeenCalled();
  });
  it('refuses malformed private data or missing migration instead of pretending an empty bank', async () => {
    const t = await fixture(); t.store.read.mockRejectedValueOnce(new Error('RPC does not exist')); let r = await t.handlers.CONTEXT(t.request(`context?revision=${t.book.revision}&bankRevision=0`), org); expect(r.status).toBe(503);
    t.store.head.mockResolvedValueOnce({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: t.book.revision, bankRevision: -1 }); r = await t.handlers.HEAD(t.request('head'), org); expect(r.status).toBe(503);
    t.deps.enabled = () => false; r = await createUsFinancialPilotBankHandlers(t.deps).HEAD(t.request('head'), org); expect(r.status).toBe(404); expect(await r.json()).toEqual({ error: 'feature_unavailable' });
  });
  it.each(['-0', '01', '+1', '1e0', '1.0', '9007199254740992', ''])('refuses noncanonical bank revision query %j before private read', async value => {
    const t = await fixture(), r = await t.handlers.CONTEXT(t.request(`context?revision=${t.book.revision}&bankRevision=${encodeURIComponent(value)}`), org); expect(r.status).toBe(422); expect(t.store.read).not.toHaveBeenCalled();
  });
  it('refuses retargeted, duplicate, missing and extra queries or mismatched paths', async () => {
    const t = await fixture(), query = `revision=${t.book.revision}&bankRevision=0`;
    for (const suffix of ['&revision=1', '&bankRevision=0', '&unknown=x', '&origin=financial-v5', '&cursor=']) expect((await t.handlers.CONTEXT(t.request('context?' + query + suffix), org)).status).toBe(422);
    const id = randomUUID(); expect((await t.handlers.STATEMENT(t.request(`statements/${id}?${query}`), org, id)).status).toBe(422); expect((await t.handlers.STATEMENT(t.request(`statements/${id}?${query}&origin=financial-v5`), org, randomUUID())).status).toBe(422);
    expect((await t.handlers.CONTEXT(t.request('context/?' + query), org)).status).toBe(422); expect((await t.handlers.HEAD(t.request('head?revision=1'), org)).status).toBe(422);
    expect(t.store.read).not.toHaveBeenCalled();
  });
  it('refuses foreign origins, native auth, missing identity, raw oversized JSON and unsupported methods', async () => {
    const t = await fixture(), input = await t.envelope(imported);
    for (const [headers, value, status] of [[{ Origin: 'https://evil.test' }, input, 403], [{ Origin: 'https://zentraapp.ch', 'Sec-Fetch-Site': 'cross-site' }, input, 403], [{ 'Content-Type': 'text/plain' }, input, 415], [{ Authorization: '' }, input, 403], [{ 'X-Zentra-Expected-User': '' }, input, 422], [{ 'X-Zentra-Expected-User': 'different' }, input, 401], [{}, { ...input, extra: 'é'.repeat(524288) }, 413]] as const) {
      const r = await t.handlers.POST(t.post(value, headers), org); expect(r.status).toBe(status); expect(Object.keys(await r.json() as object)).toEqual(['error']); expect(r.headers.get('Cache-Control')).toBe('no-store, max-age=0'); expect(r.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(r.headers.get('Vary')).toBe('Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot');
    }
    const post = await t.handlers.POST(t.request('operations'), org); expect(post.status).toBe(405); expect(post.headers.get('Allow')).toBe('POST'); const head = await t.handlers.HEAD(t.request('head', { method: 'POST' }), org); expect(head.status).toBe(405); expect(head.headers.get('Allow')).toBe('GET'); expect(t.store.read).not.toHaveBeenCalled();
  });
  it('captures dependency methods and never executes exception accessors or leaks SQL text', async () => {
    const t = await fixture(), error = new ErpError('SECRET_SQL', 503); let getterCalls = 0; Object.defineProperty(error, 'code', { get() { getterCalls++; throw Error('Private secret'); } }); Object.defineProperty(error, 'message', { get() { getterCalls++; throw Error('Private message'); } });
    t.store.read.mockRejectedValue(error); const r = await t.handlers.CONTEXT(t.request(`context?revision=${t.book.revision}&bankRevision=0`), org); expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: 'financial_service_unavailable' }); expect(getterCalls).toBe(0);
    const bad = { ...t.deps }; Object.defineProperty(bad, 'enabled', { get() { getterCalls++; throw Error('Never'); } }); expect(() => createUsFinancialPilotBankHandlers(bad)).toThrow(); expect(getterCalls).toBe(0);
    const captured = createUsFinancialPilotBankHandlers(t.deps); t.deps.enabled = () => false; expect((await captured.HEAD(t.request('head'), org)).status).toBe(200);
  });
  it.each([['INVALID_STATEMENT_AMOUNT', 'invalid_statement_amount', 422], ['RECONCILIATION_INCOMPLETE', 'reconciliation_incomplete', 409], ['SECRET_SQL', 'financial_service_unavailable', 503]] as const)('maps only own safe LedgerError code %s', async (code, expected, status) => {
    const t = await fixture(), error = new LedgerError(code); Object.defineProperty(error, 'message', { get() { throw Error('Never inspect text'); } }); t.store.read.mockRejectedValue(error); const r = await t.handlers.CONTEXT(t.request(`context?revision=${t.book.revision}&bankRevision=0`), org); expect(r.status).toBe(status); expect(await r.json()).toEqual({ error: expected });
  });
});
