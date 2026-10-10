import { beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalErpJson, ErpError } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { applyUsBankCommand } from './us-bank-reconciliation';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialBookViewV5 } from './us-financial-kernel-types';
import {
  US_FINANCIAL_PILOT_BANK_MANUAL_MARKER, US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS,
  appendUsFinancialPilotBankRegister, applyUsFinancialPilotBank, assertUsFinancialPilotBankCapacity, buildUsFinancialPilotBankProof,
  executeUsFinancialPilotBank, usFinancialPilotBankCommandHash, usFinancialPilotBankContent,
  validateUsFinancialPilotBankHead, validateUsFinancialPilotBankHistory, validateUsFinancialPilotBankOperationProof, validateUsFinancialPilotBankReceipt, validateUsFinancialPilotBankRegister, validateUsFinancialPilotBankRequest,
  type UsFinancialPilotBankCommand, type UsFinancialPilotBankDependencies, type UsFinancialPilotBankOperationProof, type UsFinancialPilotBankPort, type UsFinancialPilotBankRegister, type UsFinancialPilotBankRequest,
} from './us-financial-pilot-bank';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = <T>(v: T): T => structuredClone(v);
const imported: UsFinancialPilotBankCommand = { type: 'create_statement', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', openingMinor: '0', closingMinor: '10000', lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Exact référence 🌍 ' }] };
let seed: Awaited<ReturnType<typeof financialKernelFixture>>, book: UsFinancialBookV5, view: UsFinancialBookViewV5;
beforeAll(async () => { seed = await financialKernelFixture({ paid: '10000', tax: '0' }); book = await promoteUsFinancialBookV5(seed.baseline, seed.policy, seed.actor); view = await projectUsFinancialBookV5(book); });
const empty = (): UsFinancialPilotBankRegister => ({ schemaVersion: 1, organizationId: seed.actor.organizationId, bankRevision: 0, records: [], operations: [] });
function request(command: UsFinancialPilotBankCommand = imported, B = 0, R: number | null = null, n = 1, F = book.revision): UsFinancialPilotBankRequest { return validateUsFinancialPilotBankRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: id(n), expectedRevision: F, expectedBankRevision: B, expectedStatementRevision: R, command }); }
async function step(register: UsFinancialPilotBankRegister, r: UsFinancialPilotBankRequest, source = book) { const v = await projectUsFinancialBookV5(source), record = applyUsFinancialPilotBank(r, v, register, seed.actor), proof = await buildUsFinancialPilotBankProof(r, source, seed.actor, record); return appendUsFinancialPilotBankRegister(register, record, proof); }
function legacy(n = 50, options: { completed?: boolean; voided?: boolean; cash?: string } = {}) {
  const statementId = id(n), cashAccountId = options.cash ?? 'cash';
  let record = applyUsBankCommand(null, { schemaVersion: 1, idempotencyKey: 'legacy-import', reconciliationId: statementId, expectedErpRevision: seed.baseline.revision, expectedReconciliationRevision: null,
    command: { type: 'create_statement', statement: { id: statementId, organizationId: seed.actor.organizationId, externalConnectionId: 'legacy-csv', currency: 'USD', cashAccountId, start: '2026-10-01', end: '2026-10-31', opening: { currency: 'USD', minorUnits: '0' }, closing: { currency: 'USD', minorUnits: '10000' }, lines: [{ id: statementId + ':1', date: '2026-10-10', amount: { currency: 'USD', minorUnits: '10000' }, reference: 'Exact référence 🌍 ' }] } } }, seed.baseline.ledger, seed.actor, []);
  if (options.completed) { record = applyUsBankCommand(record, { schemaVersion: 1, idempotencyKey: 'legacy-match', reconciliationId: statementId, expectedErpRevision: seed.baseline.revision, expectedReconciliationRevision: 0, command: { type: 'approve_match', id: id(n + 100), statementLineIds: [statementId + ':1'], ledgerEntryIds: [seed.baseline.ledger.entries.find(e => e.paymentDate)!.id] } }, seed.baseline.ledger, seed.actor, [record]); record = applyUsBankCommand(record, { schemaVersion: 1, idempotencyKey: 'legacy-complete', reconciliationId: statementId, expectedErpRevision: seed.baseline.revision, expectedReconciliationRevision: 1, command: { type: 'complete' } }, seed.baseline.ledger, seed.actor, [record]); }
  if (options.voided) record = applyUsBankCommand(record, { schemaVersion: 1, idempotencyKey: 'legacy-void', reconciliationId: statementId, expectedErpRevision: seed.baseline.revision, expectedReconciliationRevision: 0, command: { type: 'void_statement', reason: 'Synthetic legacy cancelled' } }, seed.baseline.ledger, seed.actor, [record]);
  return { origin: 'legacy-frozen' as const, record };
}
function memory(initial = empty()) {
  let register = initial, currentBook = book;
  const store: UsFinancialPilotBankPort = {
    read: vi.fn(async () => ({ book: currentBook, register })), head: vi.fn(async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: seed.actor.organizationId, revision: currentBook.revision, bankRevision: register.bankRevision })),
    receipt: vi.fn(async requestId => register.operations.find(p => p.request.requestId === requestId) ?? null),
    commit: vi.fn(async input => { register = appendUsFinancialPilotBankRegister(register, input.record, input.proof); return input.proof; }),
  };
  const deps: UsFinancialPilotBankDependencies = { organizationId: seed.actor.organizationId, actor: seed.actor, policy: seed.policy, store, revalidate: vi.fn(async () => ({ actor: seed.actor, policy: seed.policy })) };
  return { deps, store, register: () => register, setBook: (b: UsFinancialBookV5) => { currentBook = b; } };
}

describe('bank canonical request and detached proofs', () => {
  it('preserves imported row order and exact Unicode/whitespace but canonicalizes unique selected sets', async () => {
    const source = copy(request()) as unknown as { command: { lines: { reference: string }[] } }, captured = validateUsFinancialPilotBankRequest(source);
    source.command.lines[0].reference = 'changed'; expect(captured.command).toEqual(imported); expect(Object.isFrozen(captured.command)).toBe(true);
    const selected = request({ type: 'approve_match', statementId: id(1), statementLineIds: ['z', 'a'], journalRevisions: [10, 2] }, 1, 0, 2);
    expect(selected.command).toMatchObject({ statementLineIds: ['a', 'z'], journalRevisions: [2, 10] });
    const reversed = { ...selected, command: { ...selected.command, statementLineIds: ['z', 'a'], journalRevisions: [10, 2] } };
    expect(await usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, selected)).toBe(await usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, reversed));
  });
  it.each([
    { command: { ...imported, unexpected: true } }, { expectedRevision: '7' }, { expectedBankRevision: Number.MAX_SAFE_INTEGER }, { expectedStatementRevision: 0 }, { requestId: id(1).toUpperCase() + 'A' },
    { command: { ...imported, closingMinor: '9999' } }, { command: { ...imported, closingMinor: '-0' } }, { command: { ...imported, openingMinor: '1e2' } },
    { command: { ...imported, lines: [{ date: '2026-11-01', amountMinor: '10000', reference: 'outside' }] } }, { command: { ...imported, lines: [{ date: '2026-10-10', amountMinor: '0', reference: 'zero' }] } },
  ])('rejects malformed canonical envelopes %j', patch => { expect(() => validateUsFinancialPilotBankRequest({ ...request(), ...patch })).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_request', status: 422 })); });
  it.each(['statementLineIds', 'journalRevisions'] as const)('rejects duplicate %s instead of silently deduplicating', field => {
    const command = { type: 'approve_match', statementId: id(1), statementLineIds: ['a'], journalRevisions: [1], [field]: field === 'statementLineIds' ? ['a', 'a'] : [1, 1] };
    expect(() => validateUsFinancialPilotBankRequest({ ...request(), expectedStatementRevision: 0, command })).toThrow(expect.objectContaining({ status: 422 }));
  });
  it('never executes accessors/prototypes/sparse arrays and captures before asynchronous hashing', async () => {
    let calls = 0; const getter = { ...request() }; Object.defineProperty(getter, 'command', { enumerable: true, get() { calls++; return imported; } });
    expect(() => validateUsFinancialPilotBankRequest(getter)).toThrow(); expect(calls).toBe(0);
    expect(() => validateUsFinancialPilotBankRequest(Object.create(request()))).toThrow();
    const sparse: unknown[] = []; sparse.length = 1; expect(() => validateUsFinancialPilotBankRequest({ ...request(), command: { ...imported, lines: sparse } })).toThrow();
    const input = copy(request()), original = canonicalErpJson(input), pending = usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, input); (input as { expectedRevision: number }).expectedRevision++;
    expect(await pending).toBe(await sha256Hex(canonicalErpJson([seed.actor.organizationId, seed.actor.userId, JSON.parse(original)])));
  });
  it('hashes all expected revisions, tenant, actor, UUID and exact imported facts', async () => {
    const r = request(), base = await usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, r);
    for (const changed of [{ ...r, expectedRevision: r.expectedRevision + 1 }, { ...r, expectedBankRevision: 1 }, { ...r, requestId: id(2) }, { ...r, command: { ...imported, lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Exact référence 🌍' }] } }]) expect(await usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, changed)).not.toBe(base);
    expect(await usFinancialPilotBankCommandHash('another-tenant', seed.actor.userId, r)).not.toBe(base); expect(await usFinancialPilotBankCommandHash(seed.actor.organizationId, 'another-user', r)).not.toBe(base);
    const selected = request({ type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [1] }, 1, 0, 2), selectedHash = await usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, selected);
    for (const changed of [{ ...selected, expectedStatementRevision: 1 }, { ...selected, command: { ...selected.command, statementId: id(3) } }, { ...selected, command: { ...selected.command, journalRevisions: [2] } }, { ...selected, command: { ...selected.command, statementLineIds: [id(1) + ':2'] } }]) expect(await usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, changed)).not.toBe(selectedHash);
  });
  it('validates private proofs as unavailable data, including noncanonical sets', async () => {
    const register = await step(empty(), request()), proof = register.operations[0];
    expect(validateUsFinancialPilotBankOperationProof(proof)).toEqual(proof);
    for (const changed of [{ ...proof, request: { ...proof.request, unexpected: true } }, { ...proof, bankRevision: 2 }, { ...proof, source: { ...proof.source, revision: proof.source.revision + 1 } }, { ...proof, actor: { ...proof.actor, managementEntitled: false } }]) expect(() => validateUsFinancialPilotBankOperationProof(changed)).toThrow(expect.objectContaining({ code: 'invalid_financial_bank_data', status: 503 }));
  });
});

describe('bank transitions on the sole cumulative V5 ledger', () => {
  it('imports, matches grouped exact amounts and completes; F/L and financial book remain unchanged', async () => {
    const before = canonicalErpJson(book), command = { ...imported, lines: [{ date: '2026-10-10', amountMinor: '4000', reference: 'A' }, { date: '2026-10-10', amountMinor: '6000', reference: 'B' }] } as const;
    let register = await step(empty(), request(command)); const statement = register.records[0].record.reconciliation.statement;
    expect(statement).toMatchObject({ id: id(1), externalConnectionId: US_FINANCIAL_PILOT_BANK_MANUAL_MARKER }); expect(statement.lines.map(l => l.id)).toEqual([id(1) + ':1', id(1) + ':2']);
    const payment = view.ledger.entries.find(e => e.paymentDate)!; expect(payment.revision).not.toBe(book.revision);
    register = await step(register, request({ type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':2', id(1) + ':1'], journalRevisions: [payment.revision] }, 1, 0, 2));
    register = await step(register, request({ type: 'complete', statementId: id(1) }, 2, 1, 3));
    expect(register.bankRevision).toBe(3); expect(register.records[0].record.reconciliation).toMatchObject({ revision: 2, completedLedgerRevision: view.ledger.revision });
    expect(register.operations.map(p => [p.bankRevision, p.statementRevision, p.source.revision, p.source.ledgerRevision])).toEqual([[1, 0, book.revision, view.ledger.revision], [2, 1, book.revision, view.ledger.revision], [3, 2, book.revision, view.ledger.revision]]);
    expect(register.operations.every(p => p.source.bookSha256 === register.operations[0].source.bookSha256)).toBe(true); expect(canonicalErpJson(book)).toBe(before); expect(await validateUsFinancialPilotBankHistory(book, register)).toEqual(register);
  });
  it('distinguishes finance, tenant bank and statement CAS and refuses incomplete completion', async () => {
    const register = await step(empty(), request());
    expect(() => applyUsFinancialPilotBank(request({ type: 'complete', statementId: id(1) }, 1, 0, 2, book.revision + 1), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() => applyUsFinancialPilotBank(request({ type: 'complete', statementId: id(1) }, 0, 0, 2), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_revision_conflict' }));
    expect(() => applyUsFinancialPilotBank(request({ type: 'complete', statementId: id(1) }, 1, 1, 2), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_revision_conflict' }));
    expect(() => applyUsFinancialPilotBank(request({ type: 'complete', statementId: id(1) }, 1, 0, 2), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'reconciliation_incomplete' }));
  });
  it('matches signed incoming/outgoing cash by exact grouped totals without an adjustment or financial mutation', async () => {
    const result = await applyUsFinancialOperationV5(book, { type: 'erp_command', idempotencyKey: 'actual-outgoing', command: { type: 'post_manual_journal', id: 'actual-outgoing', transactionDate: '2026-10-11', accountingDate: '2026-10-12', periodId: '2026', description: 'Actual outgoing expense', sourceReference: 'Recorded payment', cashFlowCategory: 'operating', lines: [{ accountId: 'purchases', debitMinor: '2550', creditMinor: '0' }, { accountId: 'cash', debitMinor: '0', creditMinor: '2550' }] }, facts: { kind: 'none' } }, seed.actor, 'actual-outgoing');
    const before = canonicalErpJson(result.book), command = { ...imported, closingMinor: '7450', lines: [...imported.lines, { date: '2026-10-11', amountMinor: '-2550', reference: 'Actual expense' }] } as const;
    let register = await step(empty(), request(command, 0, null, 1, result.book.revision), result.book);
    const revisions = result.view.ledger.entries.filter(e => e.paymentDate || e.id === 'actual-outgoing').map(e => e.revision).reverse();
    register = await step(register, request({ type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':2', id(1) + ':1'], journalRevisions: revisions }, 1, 0, 2, result.book.revision), result.book);
    register = await step(register, request({ type: 'complete', statementId: id(1) }, 2, 1, 3, result.book.revision), result.book);
    expect(register.records[0].record.reconciliation.completedLedgerRevision).toBe(result.view.ledger.revision); expect(register.records[0].record.reconciliation.statement.closing.minorUnits).toBe('7450'); expect(canonicalErpJson(result.book)).toBe(before); expect(await validateUsFinancialPilotBankHistory(result.book, register)).toEqual(register);
  });
  it('resolves public journal revision against real ledger, not finance revision or array position', async () => {
    const register = await step(empty(), request());
    expect(() => applyUsFinancialPilotBank(request({ type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [book.revision] }, 1, 0, 2), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'ledger_entry_required' }));
    const invoice = view.ledger.entries.find(e => !e.paymentDate)!;
    expect(() => applyUsFinancialPilotBank(request({ type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [invoice.revision] }, 1, 0, 2), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'cash_movement_required' }));
  });
  it('voids only an unmatched import and preserves UUID/content reservations', async () => {
    let register = await step(empty(), request()); const original = register.records[0].record;
    register = await step(register, request({ type: 'void_statement', statementId: id(1), reason: 'Wrong source' }, 1, 0, 2));
    expect(register.records[0].record.voided).toMatchObject({ reason: 'Wrong source' }); expect(usFinancialPilotBankContent(register.records[0].record)).toBe(usFinancialPilotBankContent(original));
    expect(() => applyUsFinancialPilotBank(request(imported, 2, null, 3), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_statement_duplicate' }));
    expect(() => applyUsFinancialPilotBank(request(imported, 2, null, 1), view, register, seed.actor)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
  });
  it('keeps legacy pending account blockers, frozen UUIDs and content across origins', async () => {
    const pending = { ...empty(), records: [legacy()] };
    expect(() => applyUsFinancialPilotBank(request(), view, pending, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_legacy_pending' }));
    expect(() => applyUsFinancialPilotBank(request({ type: 'void_statement', statementId: id(50), reason: 'Cannot change legacy' }, 0, 0, 2), view, pending, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_legacy_immutable' }));
    const frozen = { ...empty(), records: [legacy(50, { voided: true })] };
    expect(() => applyUsFinancialPilotBank(request(imported, 0, null, 50), view, frozen, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_statement_duplicate' }));
    expect(() => applyUsFinancialPilotBank(request(), view, frozen, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_statement_duplicate' }));
    expect(usFinancialPilotBankContent(frozen.records[0].record)).toBe(usFinancialPilotBankContent((await step(empty(), request())).records[0].record));
  });
  it('retains old proofs after later V5 activity and detects coherent tampering against their exact prefix', async () => {
    let register = await step(empty(), request()); const payment = view.ledger.entries.find(e => e.paymentDate)!;
    register = await step(register, request({ type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [payment.revision] }, 1, 0, 2));
    const later = await applyUsFinancialOperationV5(book, { type: 'customer_payment', idempotencyKey: 'later-cash', invoiceId: 'invoice-1', amountMinor: '1', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Later real ledger entry' }, seed.actor, 'later-payment');
    expect(await validateUsFinancialPilotBankHistory(later.book, register)).toEqual(register);
    const corrupt = copy(register) as Omit<UsFinancialPilotBankRegister, 'operations'> & { operations: UsFinancialPilotBankOperationProof[] }; corrupt.operations[1] = { ...corrupt.operations[1], request: request({ type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [later.view.ledger.entries.at(-1)!.revision] }, 1, 0, 2) }; corrupt.operations[1] = { ...corrupt.operations[1], commandHash: await usFinancialPilotBankCommandHash(seed.actor.organizationId, seed.actor.userId, corrupt.operations[1].request) };
    await expect(validateUsFinancialPilotBankHistory(later.book, corrupt)).rejects.toMatchObject({ code: 'invalid_financial_bank_data', status: 503 });
    for (const changed of [{ ...register, operations: register.operations.map((p, i) => i ? { ...p, source: { ...p.source, bookSha256: '0'.repeat(64) } } : p) }, { ...register, records: register.records.map(r => ({ ...r, record: { ...r.record, createdBy: 'forged-author' } })) }]) await expect(validateUsFinancialPilotBankHistory(later.book, changed)).rejects.toMatchObject({ status: 503 });
  });
  it('does not re-admit historical actors or reinterpret old new records using later sibling work', async () => {
    let register = await step(empty(), request());
    register = await step(register, request({ type: 'void_statement', statementId: id(1), reason: 'First history' }, 1, 0, 2));
    const next = { ...imported, lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Different exact content' }] } as const;
    register = await step(register, request(next, 2, null, 3));
    expect(await validateUsFinancialPilotBankHistory(book, register)).toEqual(register); expect(register.operations[0].actor.userId).toBe(seed.actor.userId);
    expect(() => validateUsFinancialPilotBankRegister({ ...register, operations: register.operations.slice(1) })).toThrow();
  });
  it('counts every legacy/new/voided record and rejects unreadable Unicode or operation aggregates', async () => {
    const base = legacy(50, { voided: true }), records = Array.from({ length: 100 }, (_, i) => { const row = copy(base), s = row.record.reconciliation.statement; return { ...row, record: { ...row.record, reconciliation: { ...row.record.reconciliation, statement: { ...s, id: id(1000 + i), lines: s.lines.map(l => ({ ...l, id: id(1000 + i) + ':1' })) } } } }; });
    const full = validateUsFinancialPilotBankRegister({ ...empty(), records });
    expect(() => applyUsFinancialPilotBank(request({ ...imported, start: '2026-11-01', end: '2026-11-30', lines: [{ date: '2026-11-01', amountMinor: '10000', reference: 'New month' }] }), view, full, seed.actor)).toThrow(expect.objectContaining({ code: 'bank_statement_limit_reached' }));
    expect(() => validateUsFinancialPilotBankRegister({ ...empty(), records: [...records, records[0]] })).toThrow(); expect(US_FINANCIAL_PILOT_BANK_MAX_OPERATIONS).toBe(1000);
    expect(() => validateUsFinancialPilotBankRegister({ ...empty(), operations: Array.from({ length: 1001 }, () => null) })).toThrow();
    expect(() => assertUsFinancialPilotBankCapacity({ scalar: '🌍'.repeat(125001) }, true)).toThrow(expect.objectContaining({ code: 'bank_limit_reached', status: 409 }));
    expect(() => assertUsFinancialPilotBankCapacity({ values: Array.from({ length: 1000 }, () => ({ a: '🌍'.repeat(501) })) })).toThrow(expect.objectContaining({ status: 503 }));
  });
  it('checks the combined record, wrapper and proof budget before append, even when each action is valid alone', async () => {
    const base = legacy(50, { voided: true }), records = Array.from({ length: 50 }, (_, i) => {
      const statementId = id(2000 + i), s = base.record.reconciliation.statement;
      return { ...base, record: { ...base.record, reconciliation: { ...base.record.reconciliation, statement: { ...s, id: statementId, lines: Array.from({ length: 100 }, (_, n) => ({ id: `${statementId}:${n + 1}`, date: '2026-10-10', amount: { currency: 'USD' as const, minorUnits: '100' }, reference: '🌍'.repeat(64) })) } } } };
    });
    const register = validateUsFinancialPilotBankRegister({ ...empty(), records }), command = { ...imported, lines: Array.from({ length: 1000 }, (_, n) => ({ date: '2026-10-10', amountMinor: '10', reference: '🌍'.repeat(63) + String(n % 10) })) } as const;
    const r = request(command), record = applyUsFinancialPilotBank(r, view, register, seed.actor), proof = await buildUsFinancialPilotBankProof(r, book, seed.actor, record);
    expect((await step(empty(), r)).records).toHaveLength(1); const before = canonicalErpJson(register);
    expect(() => appendUsFinancialPilotBankRegister(register, record, proof)).toThrow(expect.objectContaining({ code: 'bank_limit_reached', status: 409 })); expect(canonicalErpJson(register)).toBe(before);
  });
});

describe('bank receipt-first runtime and live authority', () => {
  it('replays before source reads even after later records and unavailable current source', async () => {
    const t = memory(), r = request(), first = await executeUsFinancialPilotBank(t.deps, r); await executeUsFinancialPilotBank(t.deps, request({ type: 'void_statement', statementId: id(1), reason: 'Later bank operation' }, 1, 0, 2));
    const before = canonicalErpJson(t.register()); t.store.read = vi.fn(async () => { throw Error('Current source unavailable'); });
    expect(await executeUsFinancialPilotBank(t.deps, r)).toEqual({ receipt: first.receipt, replayed: true }); expect(t.store.read).not.toHaveBeenCalled(); expect(canonicalErpJson(t.register())).toBe(before); expect(first.receipt.bankRevision).toBe(1);
  });
  it.each(['lost-response', 'late-conflict'])('re-probes a durable receipt after %s without a second write', async kind => {
    const t = memory(), commit = t.store.commit; t.store.commit = vi.fn(async input => { await commit(input); if (kind === 'late-conflict') throw new ErpError('bank_revision_conflict', 409); throw Error('Response lost'); });
    expect((await executeUsFinancialPilotBank(t.deps, request())).replayed).toBe(true); expect(t.store.commit).toHaveBeenCalledTimes(1); expect(t.register().bankRevision).toBe(1);
  });
  it.each(['revision_conflict', 'bank_revision_conflict'])('bounds the exact retry of %s to once', async code => {
    const t = memory(), commit = t.store.commit; let attempts = 0; t.store.commit = vi.fn(async input => { if (++attempts === 1) throw new ErpError(code, 409); return commit(input); });
    expect((await executeUsFinancialPilotBank(t.deps, request())).replayed).toBe(false); expect(t.store.commit).toHaveBeenCalledTimes(2); expect(t.register().operations[0].request).toEqual(request());
    const rejected = memory(); rejected.store.commit = vi.fn(async () => { throw new ErpError(code, 409); }); await expect(executeUsFinancialPilotBank(rejected.deps, request())).rejects.toMatchObject({ code }); expect(rejected.store.commit).toHaveBeenCalledTimes(2);
  });
  it('captures request, actor, policy and callable dependencies before the first await', async () => {
    const t = memory(), r = copy(request()), savedRevalidate = t.deps.revalidate; let calls = 0;
    t.deps.revalidate = async () => { calls++; if (calls === 1) { t.deps.revalidate = async () => { throw Error('Replaced dependency'); }; t.store.read = async () => { throw Error('Replaced method'); }; (r as { expectedRevision: number }).expectedRevision++; } return savedRevalidate(); };
    expect((await executeUsFinancialPilotBank(t.deps, r)).receipt.revision).toBe(book.revision); expect(calls).toBeGreaterThan(2);
  });
  it.each(['read', 'receipt', 'commit'] as const)('detaches mutable %s output before the authority fence yields', async boundary => {
    const t = memory(), r = request(); if (boundary === 'receipt') await executeUsFinancialPilotBank(t.deps, r);
    let mutate: (() => void) | undefined;
    t.deps.revalidate = async () => { const pending = mutate; mutate = undefined; pending?.(); return { actor: seed.actor, policy: seed.policy }; };
    if (boundary === 'read') t.store.read = async () => { const value = { book: copy(book), register: copy(t.register()) }; mutate = () => { (value.book as { revision: number }).revision++; (value.register as { bankRevision: number }).bankRevision++; }; return value; };
    if (boundary === 'receipt') t.store.receipt = async () => { const value = copy(t.register().operations[0]); mutate = () => { (value as { commandHash: string }).commandHash = '0'.repeat(64); }; return value; };
    if (boundary === 'commit') { const commit = t.store.commit; t.store.commit = async input => { const value = copy(await commit(input)); mutate = () => { (value as { commandHash: string }).commandHash = '0'.repeat(64); }; return value; }; }
    expect((await executeUsFinancialPilotBank(t.deps, r)).receipt.revision).toBe(book.revision); expect(t.register().bankRevision).toBe(1);
  });
  it('does not execute accessor error metadata to decide whether to retry', async () => {
    const t = memory(); let getters = 0; const error = new ErpError('revision_conflict', 409); Object.defineProperty(error, 'code', { get() { getters++; return 'revision_conflict'; } }); Object.defineProperty(error, 'status', { get() { getters++; return 409; } });
    t.store.commit = vi.fn(async () => { throw error; }); await expect(executeUsFinancialPilotBank(t.deps, request())).rejects.toBe(error); expect(getters).toBe(0); expect(t.store.commit).toHaveBeenCalledTimes(1);
  });
  it('rejects changed payload or actor under the same durable key and never re-admits the original actor for a new reader', async () => {
    const t = memory(), r = request(); await executeUsFinancialPilotBank(t.deps, r);
    await expect(executeUsFinancialPilotBank(t.deps, { ...r, expectedBankRevision: 1 })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const actor = { ...seed.actor, userId: 'another-active-accountant', role: 'accountant' as const }, deps = { ...t.deps, actor, revalidate: async () => ({ actor, policy: seed.policy }) };
    await expect(executeUsFinancialPilotBank(deps, r)).rejects.toMatchObject({ code: 'idempotency_conflict' }); expect(await validateUsFinancialPilotBankHistory(book, t.register())).toEqual(t.register());
  });
  it('fences authority on source rejection and on receipt success', async () => {
    const t = memory(); let count = 0; t.deps.revalidate = async () => ({ actor: ++count >= 2 ? { ...seed.actor, userId: 'changed-user' } : seed.actor, policy: seed.policy });
    await expect(executeUsFinancialPilotBank(t.deps, request())).rejects.toMatchObject({ code: 'financial_authority_changed', status: 403 }); expect(t.store.commit).not.toHaveBeenCalled();
    const readFailure = memory(); readFailure.store.read = async () => { readFailure.deps.revalidate = async () => { throw new ErpError('revoked', 403); }; throw Error('Source failure'); };
    // Captured revalidation callable can still consult live authority state.
    let revoked = false; readFailure.deps.revalidate = async () => { if (revoked) throw new ErpError('revoked', 403); return { actor: seed.actor, policy: seed.policy }; }; readFailure.store.read = async () => { revoked = true; throw Error('Source failure'); };
    await expect(executeUsFinancialPilotBank(readFailure.deps, request())).rejects.toMatchObject({ code: 'revoked', status: 403 });
  });
  it('validates public receipts against the exact original envelope and bounds heads', async () => {
    const t = memory(), r = request(), result = await executeUsFinancialPilotBank(t.deps, r); expect(validateUsFinancialPilotBankReceipt(result.receipt, seed.actor.organizationId, r)).toEqual(result.receipt);
    expect(() => validateUsFinancialPilotBankReceipt({ ...result.receipt, bankRevision: 2 }, seed.actor.organizationId, r)).toThrow(); expect(() => validateUsFinancialPilotBankHead({ ...result.receipt, bankRevision: 1001 })).toThrow();
    for (const privateKey of ['bookSha256', 'commandHash', 'idempotencyKey', 'actor', 'request']) expect(Object.hasOwn(result.receipt, privateKey)).toBe(false);
  });
});
