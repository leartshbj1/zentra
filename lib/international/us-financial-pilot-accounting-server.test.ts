import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { LedgerError } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpCommand } from './runtime-types';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5, type UsFinancialRuntimeDependenciesV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { validateUsFinancialPilotAccountingReceipt, usFinancialPilotAccountingEntityId, type UsFinancialPilotAccountingCommand, type UsFinancialPilotAccountingRequest } from './us-financial-pilot-accounting';
import { validateUsFinancialPilotAccountingContext, validateUsFinancialPilotJournalDetail, validateUsFinancialPilotPeriodDetail } from './us-financial-pilot-accounting-projection';
import { createUsFinancialPilotAccountingHandlers } from './us-financial-pilot-accounting-server';
import type { UsFinancialPilotDependencies } from './us-financial-pilot-server';

const org = '0a7ec0b8-a465-4df9-b756-e99aca4439ce';
const envelope = (revision: number, command: UsFinancialPilotAccountingCommand, requestId = randomUUID()): UsFinancialPilotAccountingRequest => ({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: revision, command });
function journal(fields: Partial<Extract<UsFinancialPilotAccountingCommand, { type: 'post_manual_journal' }>> = {}): Extract<UsFinancialPilotAccountingCommand, { type: 'post_manual_journal' }> {
  return { type: 'post_manual_journal', transactionDate: '2026-10-09', accountingDate: '2026-10-10', periodId: '2026', description: 'Declared manual cash contribution', sourceReference: 'Synthetic original note', lines: [{ accountId: 'cash', debitMinor: '9007199254740993', creditMinor: '0', description: 'Exact debit' }, { accountId: 'equity', debitMinor: '0', creditMinor: '9007199254740993' }], cashFlowCategory: 'financing', ...fields };
}
const reversal = (journalRevision: number): UsFinancialPilotAccountingCommand => ({ type: 'reverse_manual_journal', journalRevision, transactionDate: '2026-10-08', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic reversal reason' });
async function fixture() {
  const raw = await financialKernelFixture(), data = JSON.parse(JSON.stringify(raw).replaceAll(raw.actor.organizationId, org)) as typeof raw;
  const book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), memory = await createInMemoryUsFinancialKernelStoreV5(book, data.policy, actor => actor);
  const read = async () => await memory.read(org) as UsFinancialBookV5;
  const store = { ...memory, head: vi.fn(async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: (await read()).revision })), read: vi.fn(memory.read), receipt: vi.fn(memory.receipt), commit: vi.fn(memory.commit) };
  const scope = { scope: { organizationId: org, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const deps: UsFinancialPilotDependencies = { enabled: vi.fn(() => true), authority: vi.fn(async () => ({ mode: 'browser' as const, actor: data.actor })), configuration: vi.fn(async () => data.configuration), scope: vi.fn(async () => scope), store: vi.fn(() => store), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn() };
  const request = (path: string, init: RequestInit = {}) => { const headers = new Headers({ 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': data.actor.userId, 'Sec-Fetch-Site': 'same-origin' }); new Headers(init.headers).forEach((v, k) => headers.set(k, v)); return new Request(`https://zentraapp.ch/api/international/workspaces/${org}/financial-pilot/${path}`, { ...init, headers }); };
  const post = (value: unknown, headers: Record<string, string> = {}) => request('accounting/operations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://zentraapp.ch', ...headers }, body: JSON.stringify(value) });
  const handlers = createUsFinancialPilotAccountingHandlers(deps);
  const submit = async (command: UsFinancialPilotAccountingCommand) => { const input = envelope((await read()).revision, command), response = await handlers.POST(post(input), org); expect(response.status).toBe(200); return validateUsFinancialPilotAccountingReceipt(await response.json(), org, input); };
  const engine: UsFinancialRuntimeDependenciesV5 = { configuration: data.configuration, actor: data.actor, policy: data.policy, store: memory, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }), resolveTax: async ({ candidate }) => ({ schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'Synthetic TEST authorization', verifiedBy: 'synthetic-reviewer', verifiedAt: data.actor.timestamp, providerAccountReference: 'acct_synthetic', originalTaxTransactionReference: 'testtxn_synthetic', adjustmentPlanReference: 'synthetic-adjustment', authorizedTaxMinor: candidate.allocation.taxMinor }) };
  const internal = async (command: ErpCommand) => executeUsFinancialKernelV5(engine, { idempotencyKey: 'synthetic-internal-' + randomUUID(), expectedRevision: (await read()).revision, command: { type: 'erp_command', request: command } });
  return { ...data, book, memory, store, scope, deps, read, request, post, handlers, submit, internal, engine };
}

describe('accounting HTTP — real cumulative memory kernel, synthetic Auth/D1', () => {
  it('posts, resolves true V5 journal identity after interleaved credits, reverses exact lines and closes/opens periods', async () => {
    const t = await fixture();
    await executeUsFinancialKernelV5(t.engine, { idempotencyKey: 'synthetic-credit', expectedRevision: t.book.revision, command: { type: 'customer_credit', id: 'credit-1', invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
    await t.internal({ type: 'save_customer', customer: { id: 'other', organizationId: org, kind: 'business', name: 'Synthetic second customer', billingAddress: t.configuration.address, paymentTermsDays: 30 } });
    const posted = await t.submit(journal()), before = await projectUsFinancialBookV5(await t.read()), original = before.ledger.entries.find(e => e.id === posted.entityId)!;
    expect(original.revision).not.toBe(posted.revision); expect(original.revision).toBe(3);
    const sourceSnapshot = canonicalErpJson(original), counterSnapshot = canonicalErpJson(before.counters), reversed = await t.submit(reversal(original.revision));
    const after = await projectUsFinancialBookV5(await t.read()), entry = after.ledger.entries.find(e => e.id === reversed.entityId)!;
    expect(entry.reversesEntryId).toBe(original.id); expect(entry.cashFlowCategory).toBe(original.cashFlowCategory); expect(entry.lines).toEqual(original.lines.map(l => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor })));
    expect(canonicalErpJson(after.ledger.entries.find(e => e.id === original.id))).toBe(sourceSnapshot); expect(canonicalErpJson(after.counters)).toBe(counterSnapshot);
    const detail = validateUsFinancialPilotJournalDetail(await (await t.handlers.JOURNAL(t.request(`journals/${original.revision}?revision=${after.revision}`), org, String(original.revision))).json(), org);
    expect(detail.canReverse).toBe(false); expect(detail.journal.reversedByJournalRevision).toBe(entry.revision);
    await t.submit({ type: 'close_period', periodId: '2026' }); const opened = await t.submit({ type: 'open_period', start: '2027-01-01', end: '2027-12-31' });
    const current = await t.read(), context = validateUsFinancialPilotAccountingContext(await (await t.handlers.CONTEXT(t.request(`accounting/context?revision=${current.revision}`), org)).json(), org);
    expect(context.accounts).toHaveLength(7); expect(context.accounts.find(a => a.accountId === 'cash')?.cash).toBe(true); expect(context.earliestOpenPeriod?.id).toBe(opened.entityId);
    expect(validateUsFinancialPilotPeriodDetail(await (await t.handlers.PERIOD(t.request(`periods/2026?revision=${current.revision}`), org, '2026')).json(), org).canClose).toBe(false);
  });
  it('refuses subregister originals, missing sources and second new reversals without mutation', async () => {
    const t = await fixture(), before = canonicalErpJson(await t.read());
    for (const [id, status, code] of [[1, 409, 'manual_journal_required'], [999, 404, 'entry_not_found']] as const) { const r = await t.handlers.POST(t.post(envelope(t.book.revision, reversal(id))), org); expect(r.status).toBe(status); expect(await r.json()).toEqual({ error: code }); expect(canonicalErpJson(await t.read())).toBe(before); }
    await t.submit(journal()); const source = (await projectUsFinancialBookV5(await t.read())).ledger.entries.at(-1)!; await t.submit(reversal(source.revision)); const snapshot = canonicalErpJson(await t.read());
    for (const id of [source.revision, source.revision + 1]) { const r = await t.handlers.POST(t.post(envelope((await t.read()).revision, reversal(id))), org); expect(r.status).toBe(409); expect(canonicalErpJson(await t.read())).toBe(snapshot); }
  });
  it('preserves deterministic journal/period collisions and permits a later period before prior closure', async () => {
    const t = await fixture(), id = randomUUID(), create = envelope(t.book.revision, journal(), id), expectedId = usFinancialPilotAccountingEntityId(create);
    await t.internal({ ...journal(), id: expectedId }); const before = canonicalErpJson(await t.read());
    const collision = await t.handlers.POST(t.post({ ...create, expectedRevision: (await t.read()).revision }), org); expect(collision.status).toBe(409); expect(await collision.json()).toEqual({ error: 'entry_id_conflict' }); expect(canonicalErpJson(await t.read())).toBe(before);
    const open = await t.submit({ type: 'open_period', start: '2027-01-01', end: '2027-12-31' }); const close = await t.handlers.POST(t.post(envelope(open.revision, { type: 'close_period', periodId: open.entityId })), org); expect(close.status).toBe(409); expect(await close.json()).toEqual({ error: 'accounting_period_order_conflict' });
    const periodId = randomUUID(); await t.internal({ type: 'open_period', id: 'pilot-period:' + periodId, start: '2028-01-01', end: '2028-12-31' }); const r = await t.handlers.POST(t.post(envelope((await t.read()).revision, { type: 'open_period', start: '2029-01-01', end: '2029-12-31' }, periodId)), org); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'period_already_exists' });
  });
  it.each(['lostReply', 'late409'] as const)('replays all four exact receipts after %s and later reversal/closure', async kind => {
    const t = await fixture(); let armed = true; const commit = t.store.commit;
    t.store.commit = vi.fn(async input => { const r = await commit(input); if (armed) { armed = false; if (kind === 'late409') throw new ErpError('financial_source_changed', 409); throw Error('Lost reply after commit'); } return r; }); const h = createUsFinancialPilotAccountingHandlers(t.deps);
    const post = envelope(t.book.revision, journal()); expect((await h.POST(t.post(post), org)).status).toBe(kind === 'late409' ? 409 : 503);
    const source = (await projectUsFinancialBookV5(await t.read())).ledger.entries.at(-1)!, reverse = envelope((await t.read()).revision, reversal(source.revision)); expect((await h.POST(t.post(reverse), org)).status).toBe(200);
    const close = envelope((await t.read()).revision, { type: 'close_period', periodId: '2026' }); expect((await h.POST(t.post(close), org)).status).toBe(200);
    const open = envelope((await t.read()).revision, { type: 'open_period', start: '2027-01-01', end: '2027-12-31' }); expect((await h.POST(t.post(open), org)).status).toBe(200); await t.submit({ type: 'close_period', periodId: usFinancialPilotAccountingEntityId(open) });
    const before = canonicalErpJson(await t.read()); for (const input of [post, reverse, close, open]) { const r = await h.POST(t.post(input), org); expect(r.status).toBe(200); expect(validateUsFinancialPilotAccountingReceipt(await r.json(), org, input).revision).toBe(input.expectedRevision + 1); expect(canonicalErpJson(await t.read())).toBe(before); }
    for (const changed of [{ ...post, expectedRevision: post.expectedRevision + 1 }, { ...post, command: journal({ description: 'Changed UUID payload' }) }]) { const r = await h.POST(t.post(changed), org); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'idempotency_conflict' }); }
  });
  it('recovers a real reversal committed between receipt probe and immutable source read', async () => {
    const t = await fixture(); await t.submit(journal()); const original = (await projectUsFinancialBookV5(await t.read())).ledger.entries.at(-1)!, input = envelope((await t.read()).revision, reversal(original.revision));
    const read = t.store.read; let once = true; t.store.read = vi.fn(async company => { if (once) { once = false; expect((await t.handlers.POST(t.post(input), org)).status).toBe(200); await t.submit({ type: 'close_period', periodId: '2026' }); } return read(company); });
    const r = await createUsFinancialPilotAccountingHandlers(t.deps).POST(t.post(input), org); expect(r.status).toBe(200); expect((await t.read()).events).toHaveLength(3);
  });
  it('reprobes a missing-source rejection and reconstructs identity after a real intervening commit', async () => {
    const t = await fixture(), input = envelope(t.book.revision + 1, reversal(2)); let once = true; const read = t.store.read;
    t.store.read = vi.fn(async company => { if (once) { once = false; const captured = await read(company); await t.submit(journal()); expect((await t.handlers.POST(t.post(input), org)).status).toBe(200); await t.submit({ type: 'close_period', periodId: '2026' }); return captured; } return read(company); });
    const r = await createUsFinancialPilotAccountingHandlers(t.deps).POST(t.post(input), org); expect(r.status).toBe(200); expect(validateUsFinancialPilotAccountingReceipt(await r.json(), org, input).revision).toBe(input.expectedRevision + 1); expect((await t.read()).events).toHaveLength(3);
  });
  it('performs one bounded receipt-first CAS recovery with unchanged envelope', async () => {
    const t = await fixture(); t.store.commit = vi.fn(async () => { throw new ErpError('revision_conflict', 409); }); const input = envelope(t.book.revision, journal()), r = await createUsFinancialPilotAccountingHandlers(t.deps).POST(t.post(input), org); expect(r.status).toBe(409); expect(t.store.commit).toHaveBeenCalledTimes(2); expect(t.store.commit.mock.calls[0][0].receipt.commandHash).toBe(t.store.commit.mock.calls[1][0].receipt.commandHash); expect((await t.read()).events).toHaveLength(0);
  });
  it.each(['user', 'role', 'grant', 'optIn', 'policy', 'configuration', 'flag', 'device'] as const)('renews full admission after private read: %s', async kind => {
    const t = await fixture(); let changed = false; t.store.read.mockImplementation(async company => { const result = await t.memory.read(company); changed = true; return result; });
    t.deps.authority = async () => ({ mode: changed && kind === 'device' ? 'device' : 'browser', actor: { ...t.actor, ...(changed && kind === 'user' ? { userId: 'another' } : {}), ...(changed && kind === 'role' ? { role: 'admin' as const } : {}) } });
    t.deps.scope = async () => ({ ...t.scope, optInVersion: changed && kind === 'optIn' ? 2 : 1, scope: { ...t.scope.scope, grantVersion: changed && kind === 'grant' ? 2 : 1, policy: changed && kind === 'policy' ? { ...t.policy, approval: { ...t.policy.approval, reference: 'different' } } : t.policy } });
    t.deps.configuration = async () => changed && kind === 'configuration' ? { ...t.configuration, language: 'fr' } : t.configuration; t.deps.enabled = () => !(changed && kind === 'flag');
    const r = await createUsFinancialPilotAccountingHandlers(t.deps).CONTEXT(t.request(`accounting/context?revision=${t.book.revision}`), org); expect([401, 403, 404, 409]).toContain(r.status); expect(Object.keys(await r.json() as object)).toEqual(['error']); expect((await t.read()).events).toHaveLength(0);
  });
  it.each(['read', 'receipt', 'commit', 'head'] as const)('authority failure wins over rejected private %s', async method => {
    const t = await fixture(); let changed = false; const broken = async () => { changed = true; throw new ErpError('entry_not_found', 404); }; Object.assign(t.store, { [method]: vi.fn(broken) });
    t.deps.authority = async () => { if (changed) throw new AccountPublicError('Synthetic revoked', 401); return { mode: 'browser', actor: t.actor }; }; const h = createUsFinancialPilotAccountingHandlers(t.deps);
    const r = method === 'head' || method === 'read' ? await h.CONTEXT(t.request(`accounting/context?revision=${t.book.revision}`), org) : await h.POST(t.post(envelope(t.book.revision, journal())), org); expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: 'unauthorized' });
  });
  it('withholds a committed receipt after logout and recovers exactly after restored authority', async () => {
    const t = await fixture(); let revoked = false; const commit = t.store.commit; t.store.commit = vi.fn(async input => { const r = await commit(input); revoked = true; return r; }); t.deps.authority = async () => { if (revoked) throw new AccountPublicError('Logout', 401); return { mode: 'browser', actor: t.actor }; }; const h = createUsFinancialPilotAccountingHandlers(t.deps), input = envelope(t.book.revision, journal()); expect((await h.POST(t.post(input), org)).status).toBe(401); revoked = false; expect((await h.POST(t.post(input), org)).status).toBe(200); expect((await t.read()).events).toHaveLength(1);
  });
  it('checks current head after projection and rejects closed/retargeted route queries', async () => {
    const t = await fixture(); t.store.head.mockResolvedValue({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: t.book.revision + 1 }); const r = await t.handlers.CONTEXT(t.request(`accounting/context?revision=${t.book.revision}`), org); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'financial_snapshot_changed' });
    for (const suffix of ['&revision=5', '&unknown=x', '&lineCursor=x']) expect((await t.handlers.CONTEXT(t.request(`accounting/context?revision=${t.book.revision}${suffix}`), org)).status).toBe(422);
    for (const value of ['0', '01', '+1', '1e0', '1.0', '9007199254740992', '1/2']) expect((await t.handlers.JOURNAL(t.request(`journals/${value}?revision=${t.book.revision}`), org, value)).status).toBe(422);
    expect((await t.handlers.POST(t.post(envelope(t.book.revision, journal())), 'bad-tenant')).status).toBe(422);
  });
  it('bounds raw JSON and preserves security headers while refusing foreign origin/native/user', async () => {
    const t = await fixture(), input = envelope(t.book.revision, journal()); for (const [headers, value, status] of [[{ Origin: 'https://evil.test' }, input, 403], [{ 'Content-Type': 'text/plain' }, input, 415], [{ Authorization: 'Bearer synthetic' }, input, 403], [{ 'X-Zentra-Expected-User': 'another' }, input, 401], [{}, { ...input, padding: 'é'.repeat(140000) }, 413]] as const) { const r = await t.handlers.POST(t.post(value, headers), org); expect(r.status).toBe(status); expect(r.headers.get('Cache-Control')).toBe('no-store, max-age=0'); expect(r.headers.get('Vary')).toBe('Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot'); expect(r.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff'); }
    expect(t.store.read).not.toHaveBeenCalled(); expect((await t.read()).events).toHaveLength(0);
  });
  it.each([['UNKNOWN_ACCOUNT', 'unknown_account', 422], ['INVALID_JOURNAL_LINE', 'invalid_journal_line', 422], ['UNBALANCED_JOURNAL', 'unbalanced_journal', 422], ['CASH_FLOW_CLASSIFICATION_REQUIRED', 'cash_flow_classification_required', 422], ['INVALID_REVERSAL', 'invalid_reversal', 409], ['ACCOUNTING_PERIOD_CLOSED', 'accounting_period_closed', 409], ['SECRET_SQL', 'financial_service_unavailable', 503]] as const)('maps only own LedgerError code %s', async (code, expected, status) => {
    const t = await fixture(), error = new LedgerError(code); Object.defineProperty(error, 'message', { get() { throw Error('Never read message'); } }); t.store.read.mockRejectedValue(error); const r = await t.handlers.CONTEXT(t.request(`accounting/context?revision=${t.book.revision}`), org); expect(r.status).toBe(status); expect(await r.json()).toEqual({ error: expected });
  });
  it('closes hostile errors/accessor dependencies and captures dependency methods', async () => {
    const t = await fixture(), error = new ErpError('SECRET', 503); let getterCalls = 0; Object.defineProperty(error, 'code', { get() { getterCalls++; throw Error('secret'); } }); t.store.read.mockRejectedValue(error); const r = await t.handlers.CONTEXT(t.request(`accounting/context?revision=${t.book.revision}`), org); expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: 'financial_service_unavailable' }); expect(getterCalls).toBe(0);
    const bad = { ...t.deps }; Object.defineProperty(bad, 'enabled', { get() { throw Error('not called'); } }); expect(() => createUsFinancialPilotAccountingHandlers(bad)).toThrow();
    t.deps.enabled = () => false; expect((await createUsFinancialPilotAccountingHandlers(t.deps).POST(t.post(envelope(t.book.revision, journal())), org)).status).toBe(404);
    const method = await t.handlers.POST(t.request('accounting/operations'), org); expect(method.status).toBe(405); expect(method.headers.get('Allow')).toBe('POST');
  });
});
