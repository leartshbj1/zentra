import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { applyUsBankCommand } from './us-bank-reconciliation';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { validateStoredErp } from './runtime-validation';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import type { UsFinancialBookV5, UsFinancialErpCommandV5 } from './us-financial-kernel-types';
import { appendUsFinancialPilotBankRegister, applyUsFinancialPilotBank, buildUsFinancialPilotBankProof, validateUsFinancialPilotBankRequest, type UsFinancialPilotBankCommand, type UsFinancialPilotBankRegister } from './us-financial-pilot-bank';
import {
  financialPilotBankCursor, financialPilotBankCursorOffset, projectUsFinancialPilotBankContext, projectUsFinancialPilotBankList, projectUsFinancialPilotBankMovements, projectUsFinancialPilotBankStatement,
  validateUsFinancialPilotBankContext, validateUsFinancialPilotBankDetailQuery, validateUsFinancialPilotBankListQuery, validateUsFinancialPilotBankMovementQuery, validateUsFinancialPilotBankMovementsPage, validateUsFinancialPilotBankQuery, validateUsFinancialPilotBankStatementDetail, validateUsFinancialPilotBankStatementsPage,
} from './us-financial-pilot-bank-projection';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = <T>(value: T): T => structuredClone(value);
const imported = { type: 'create_statement', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', openingMinor: '0', closingMinor: '10000', lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Recorded cash 🌍 ' }] } as const;
let seed: Awaited<ReturnType<typeof financialKernelFixture>>, book: UsFinancialBookV5, completed: UsFinancialPilotBankRegister;
const empty = (): UsFinancialPilotBankRegister => ({ schemaVersion: 1, organizationId: seed.actor.organizationId, bankRevision: 0, records: [], operations: [] });
const q = (source = book, register = completed) => ({ revision: source.revision, bankRevision: register.bankRevision, statementId: id(1), origin: 'financial-v5' as const });
async function step(register: UsFinancialPilotBankRegister, command: UsFinancialPilotBankCommand, n: number, source = book) {
  const statementId = command.type === 'create_statement' ? id(n) : command.statementId, request = validateUsFinancialPilotBankRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: id(n), expectedRevision: source.revision, expectedBankRevision: register.bankRevision, expectedStatementRevision: command.type === 'create_statement' ? null : register.records.find(r => r.record.reconciliation.statement.id === statementId)!.record.reconciliation.revision, command });
  const view = await projectUsFinancialBookV5(source), record = applyUsFinancialPilotBank(request, view, register, seed.actor), proof = await buildUsFinancialPilotBankProof(request, source, seed.actor, record); return appendUsFinancialPilotBankRegister(register, record, proof);
}
async function finance(source: UsFinancialBookV5, command: UsFinancialErpCommandV5) { return (await applyUsFinancialOperationV5(source, { type: 'erp_command', idempotencyKey: 'private-finance-' + source.revision, command, facts: { kind: 'none' } }, seed.actor, usFinancialErpEntityIdV5(command, seed.actor.organizationId))).book; }
const manual = (name: string, date: string, amount = '7') => ({ type: 'post_manual_journal', id: name, transactionDate: date, accountingDate: '2027-01-01', periodId: '2027', description: 'Actual signed cash', sourceReference: 'Public source', cashFlowCategory: 'financing', lines: BigInt(amount) > 0 ? [{ accountId: 'cash', debitMinor: amount, creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: amount }] : [{ accountId: 'cash', debitMinor: '0', creditMinor: (-BigInt(amount)).toString() }, { accountId: 'equity', debitMinor: (-BigInt(amount)).toString(), creditMinor: '0' }] }) as UsFinancialErpCommandV5;
beforeAll(async () => {
  const initial = await financialKernelFixture({ paid: '10000', tax: '0' });
  seed = { ...initial, baseline: validateStoredErp({ ...initial.baseline, ledger: { ...initial.baseline.ledger, periods: [...initial.baseline.ledger.periods, { id: '2027', start: '2027-01-01', end: '2027-12-31', status: 'open' }] } }, initial.actor.organizationId) };
  book = await promoteUsFinancialBookV5(seed.baseline, seed.policy, seed.actor); const view = await projectUsFinancialBookV5(book);
  completed = await step(empty(), imported, 1); completed = await step(completed, { type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [view.ledger.entries.find(e => e.paymentDate)!.revision] }, 2); completed = await step(completed, { type: 'complete', statementId: id(1) }, 3);
});
function legacy(n: number, complete = false, voided = false) {
  const statementId = id(n), envelope = { schemaVersion: 1 as const, idempotencyKey: 'legacy-create-' + n, reconciliationId: statementId, expectedErpRevision: seed.baseline.revision, expectedReconciliationRevision: null };
  let record = applyUsBankCommand(null, { ...envelope, command: { type: 'create_statement', statement: { id: statementId, organizationId: seed.actor.organizationId, externalConnectionId: 'opaque-legacy-no-new-F', currency: 'USD', cashAccountId: 'cash', start: imported.start, end: imported.end, opening: { currency: 'USD', minorUnits: '0' }, closing: { currency: 'USD', minorUnits: '10000' }, lines: [{ id: statementId + ':1', date: '2026-10-10', amount: { currency: 'USD', minorUnits: '10000' }, reference: 'Frozen legacy facts' }] } } }, seed.baseline.ledger, seed.actor, []);
  if (complete) { record = applyUsBankCommand(record, { ...envelope, idempotencyKey: 'legacy-match-' + n, expectedReconciliationRevision: 0, command: { type: 'approve_match', id: id(n + 100), statementLineIds: [statementId + ':1'], ledgerEntryIds: [seed.baseline.ledger.entries.find(e => e.paymentDate)!.id] } }, seed.baseline.ledger, seed.actor, [record]); record = applyUsBankCommand(record, { ...envelope, idempotencyKey: 'legacy-complete-' + n, expectedReconciliationRevision: 1, command: { type: 'complete' } }, seed.baseline.ledger, seed.actor, [record]); }
  if (voided) record = applyUsBankCommand(record, { ...envelope, idempotencyKey: 'legacy-void-' + n, expectedReconciliationRevision: 0, command: { type: 'void_statement', reason: 'Frozen cancelled import' } }, seed.baseline.ledger, seed.actor, [record]);
  return { origin: 'legacy-frozen' as const, record };
}

describe('bank projections from true V5 source and separately current differences', () => {
  it('whitelists context, lines, matches and real public movement source with no private proof', async () => {
    const query = q(), detail = await projectUsFinancialPilotBankStatement(book, completed, query), movements = await projectUsFinancialPilotBankMovements(book, completed, query), view = await projectUsFinancialBookV5(book);
    expect(detail).toMatchObject({ revision: book.revision, bankRevision: 3, ledgerRevision: view.ledger.revision, statement: { statementId: id(1), statementRevision: 2, state: 'completed' }, current: { outstandingLineCount: 0, unmatchedMovementCount: 0, beginningDifferenceMinor: '0', endingDifferenceMinor: '0', ready: true }, cashChangedSinceCompletion: false });
    expect(detail.lines.items[0]).toEqual({ ordinal: 1, lineId: id(1) + ':1', date: '2026-10-10', amountMinor: '10000', reference: 'Recorded cash 🌍 ', matchId: id(2) }); expect(detail.matches.items[0]).toMatchObject({ matchId: id(2), amountMinor: '10000', sourceRevision: book.revision });
    expect(movements.items).toHaveLength(1); expect(movements.items[0]).toMatchObject({ journalRevision: view.ledger.entries.find(e => e.paymentDate)!.revision, amountMinor: '10000', status: 'matched', bankDate: '2026-10-10', source: { kind: 'customer_payment', entityId: 'invoice-1', journalRevision: null } });
    const context = await projectUsFinancialPilotBankContext(book, completed, { revision: book.revision, bankRevision: 3 }); expect(context.statementCount).toBe(1); expect(context.legacyPending).toEqual([]); expect(context.accounts.map(a => a.accountId)).toEqual(view.ledger.accounts.filter(a => a.cash).map(a => a.id));
    for (const value of [detail, movements, context, await projectUsFinancialPilotBankList(book, completed, { revision: book.revision, bankRevision: 3 })]) for (const privateName of ['commandHash', 'bookSha256', 'idempotencyKey', 'ledgerEntryIds', 'fingerprint', 'promotion', 'externalConnectionId', 'SYNTHETIC-LOCAL-POLICY']) expect(JSON.stringify(value)).not.toContain(privateName);
  });
  it('preserves completion F/SHA/L after a technical period audit advances both F and L with no cash change', async () => {
    const historicalProof = completed.operations[2], proofBefore = canonicalErpJson(historicalProof), prior = await projectUsFinancialPilotBankStatement(book, completed, q());
    expect(historicalProof.source.bookSha256).toBe(await sha256Hex(canonicalErpJson(book)));
    const closed = await finance(book, { type: 'close_period', periodId: '2026' }), closedView = await projectUsFinancialBookV5(closed), detail = await projectUsFinancialPilotBankStatement(closed, completed, q(closed));
    expect(closed.revision).toBe(book.revision + 1); expect(closedView.ledger.revision).toBe(historicalProof.source.ledgerRevision + 1); expect(closedView.ledger.entries).toHaveLength((await projectUsFinancialBookV5(book)).ledger.entries.length);
    expect(detail.current).toEqual(prior.current); expect(detail.cashChangedSinceCompletion).toBe(false); expect(detail.statement.completion).toEqual({ completedAt: seed.actor.timestamp, completedBy: seed.actor.userId, ledgerRevision: historicalProof.source.ledgerRevision, source: { revision: book.revision, ledgerRevision: historicalProof.source.ledgerRevision } }); expect(canonicalErpJson(completed.operations[2])).toBe(proofBefore);
  });
  it('computes a later in-range cash difference from money and keeps the historic completion proof untouched', async () => {
    const closed = await finance(book, { type: 'close_period', periodId: '2026' }), later = await finance(closed, manual('later-cash', '2026-10-11')), proofBefore = canonicalErpJson(completed.operations[2]), detail = await projectUsFinancialPilotBankStatement(later, completed, q(later));
    expect(detail.current).toEqual({ outstandingLineCount: 0, unmatchedMovementCount: 1, beginningDifferenceMinor: '0', endingDifferenceMinor: '7', ready: false }); expect(detail.cashChangedSinceCompletion).toBe(true); expect(detail.statement.completion!.source).toEqual({ revision: book.revision, ledgerRevision: completed.operations[2].source.ledgerRevision }); expect(canonicalErpJson(completed.operations[2])).toBe(proofBefore);
    const movements = await projectUsFinancialPilotBankMovements(later, completed, q(later)); expect(movements.items.map(m => [m.amountMinor, m.status])).toEqual([['10000', 'matched'], ['7', 'available']]); expect(movements.items[1]).toMatchObject({ transactionDate: '2026-10-11', accountingDate: '2027-01-01', source: { kind: 'manual_journal', entityId: null, reference: 'Public source', journalRevision: null } });
  });
  it('keeps cash after statement end unchanged but identifies net-zero in-range unmatched cash', async () => {
    const closed = await finance(book, { type: 'close_period', periodId: '2026' }), outside = await finance(closed, manual('after-end', '2026-11-01'));
    const unchanged = await projectUsFinancialPilotBankStatement(outside, completed, q(outside)); expect(unchanged.current).toMatchObject({ endingDifferenceMinor: '0', unmatchedMovementCount: 0, ready: true }); expect(unchanged.cashChangedSinceCompletion).toBe(false);
    const incoming = await finance(closed, manual('offset-in', '2026-10-11')), offset = await finance(incoming, manual('offset-out', '2026-10-11', '-7')), detail = await projectUsFinancialPilotBankStatement(offset, completed, q(offset));
    expect(detail.current).toMatchObject({ beginningDifferenceMinor: '0', endingDifferenceMinor: '0', unmatchedMovementCount: 2, ready: false }); expect(detail.cashChangedSinceCompletion).toBe(true);
  });
  it('exposes completed legacy baseline facts with source/current null and no invented finance provenance', async () => {
    const row = legacy(50, true), register = { ...empty(), records: [row] }, later = await finance(await finance(book, { type: 'close_period', periodId: '2026' }), manual('post-legacy-cash', '2026-10-11'));
    const detail = await projectUsFinancialPilotBankStatement(later, register, { revision: later.revision, bankRevision: 0, statementId: id(50), origin: 'legacy-frozen' });
    expect(detail.current).toBeNull(); expect(detail.cashChangedSinceCompletion).toBeNull(); expect(detail.statement.completion).toEqual({ completedAt: seed.actor.timestamp, completedBy: seed.actor.userId, ledgerRevision: seed.baseline.ledger.revision, source: null }); expect(detail.matches.items[0]).toMatchObject({ sourceRevision: null, journalRevisions: [seed.baseline.ledger.entries.find(e => e.paymentDate)!.revision], approvedBy: seed.actor.userId });
    await expect(projectUsFinancialPilotBankMovements(later, register, { revision: later.revision, bankRevision: 0, statementId: id(50), origin: 'legacy-frozen' })).rejects.toMatchObject({ code: 'bank_legacy_immutable', status: 409 });
  });
  it('reports account-specific pending legacy blockers without requiring history actor admission', async () => {
    const register = { ...empty(), records: [legacy(50), legacy(51, false, true)] }, context = await projectUsFinancialPilotBankContext(book, register, { revision: book.revision, bankRevision: 0 });
    expect(context.statementCount).toBe(2); expect(context.legacyPending).toEqual([{ statementId: id(50), cashAccountId: 'cash' }]);
    expect((await projectUsFinancialPilotBankStatement(book, register, { revision: book.revision, bankRevision: 0, statementId: id(50), origin: 'legacy-frozen' })).current).toBeNull();
    await expect(projectUsFinancialPilotBankStatement(book, register, { revision: book.revision, bankRevision: 0, statementId: id(50), origin: 'financial-v5' })).rejects.toMatchObject({ code: 'reconciliation_not_found' });
  });
});

describe('bank query scopes, bounded pages and output integrity', () => {
  it.each([
    {}, { revision: '7', bankRevision: 0 }, { revision: 1, bankRevision: 1001 }, { revision: 1, bankRevision: 0, requestId: id(1) },
  ])('rejects invalid numeric query %j', value => { expect(() => validateUsFinancialPilotBankQuery(value)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_query', status: 422 })); });
  it('requires origin and rejects getters, unknown fields and malformed scopes', () => {
    expect(() => validateUsFinancialPilotBankDetailQuery({ revision: 1, bankRevision: 0, statementId: id(1) })).toThrow(); expect(() => validateUsFinancialPilotBankMovementQuery({ ...q(), origin: 'new' })).toThrow(); expect(() => validateUsFinancialPilotBankListQuery({ revision: 1, bankRevision: 0, cursor: 1 })).toThrow();
    let reads = 0; const getter = { ...q() }; Object.defineProperty(getter, 'origin', { enumerable: true, get() { reads++; return 'financial-v5'; } }); expect(() => validateUsFinancialPilotBankDetailQuery(getter)).toThrow(); expect(reads).toBe(0);
  });
  it('binds every cursor to tenant, F/B, kind, origin and statement with canonical encoding', () => {
    const org = seed.actor.organizationId, cursor = financialPilotBankCursor('bank_lines', org, book.revision, 3, 25, 'financial-v5', id(1)); expect(financialPilotBankCursorOffset(cursor, 'bank_lines', org, book.revision, 3, 'financial-v5', id(1))).toBe(25);
    for (const tuple of [['bank_lines', 'other', book.revision, 3, 'financial-v5', id(1), 25], ['bank_lines', org, book.revision + 1, 3, 'financial-v5', id(1), 25], ['bank_lines', org, book.revision, 4, 'financial-v5', id(1), 25], ['bank_matches', org, book.revision, 3, 'financial-v5', id(1), 25], ['bank_lines', org, book.revision, 3, 'legacy-frozen', id(1), 25], ['bank_lines', org, book.revision, 3, 'financial-v5', id(2), 25], ['bank_lines', org, book.revision, 3, 'financial-v5', id(1), 26]]) expect(() => financialPilotBankCursorOffset(JSON.stringify(tuple), 'bank_lines', org, book.revision, 3, 'financial-v5', id(1))).toThrow();
    expect(() => financialPilotBankCursorOffset(' ' + cursor, 'bank_lines', org, book.revision, 3, 'financial-v5', id(1))).toThrow(); expect(() => financialPilotBankCursor('bank_statements', org, 1, 0, 25, 'financial-v5', id(1))).toThrow();
  });
  it('pages the full list and statement rows in deterministic groups of 25', async () => {
    const records = Array.from({ length: 26 }, (_, i) => legacy(1000 + i, false, true)), register = { ...empty(), records }, query = { revision: book.revision, bankRevision: 0 }, first = await projectUsFinancialPilotBankList(book, register, query);
    expect(first.items).toHaveLength(25); expect(first.total).toBe(26); const second = await projectUsFinancialPilotBankList(book, register, { ...query, cursor: first.nextCursor }); expect(second.items).toHaveLength(1); expect(second.items[0].statementId).toBe(id(1025)); expect(second.nextCursor).toBeNull();
    const command = { ...imported, closingMinor: '26', lines: Array.from({ length: 26 }, (_, i) => ({ date: '2026-10-10', amountMinor: '1', reference: 'Ordered ' + i })) } as const, linesRegister = await step(empty(), command, 1), detail = await projectUsFinancialPilotBankStatement(book, linesRegister, q(book, linesRegister));
    expect(detail.lines.items).toHaveLength(25); const next = await projectUsFinancialPilotBankStatement(book, linesRegister, { ...q(book, linesRegister), lineCursor: detail.lines.nextCursor }); expect(next.lines.items).toHaveLength(1); expect(next.lines.items[0]).toMatchObject({ ordinal: 26, lineId: id(1) + ':26', reference: 'Ordered 25' });
    expect(validateUsFinancialPilotBankStatementDetail(next, seed.actor.organizationId, { ...q(book, linesRegister), lineCursor: detail.lines.nextCursor })).toEqual(next);
    await expect(projectUsFinancialPilotBankList(book, register, { ...query, cursor: financialPilotBankCursor('bank_statements', seed.actor.organizationId, book.revision, 0, 50) })).rejects.toMatchObject({ status: 422 });
  });
  it('rejects stale composite pairs and captures source/register/query before yielding', async () => {
    await expect(projectUsFinancialPilotBankStatement(book, completed, { ...q(), revision: book.revision + 1 })).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 }); await expect(projectUsFinancialPilotBankContext(book, completed, { revision: book.revision, bankRevision: 2 })).rejects.toMatchObject({ code: 'financial_snapshot_changed' });
    const source = copy(book), register = copy(completed), query = copy(q()), pending = projectUsFinancialPilotBankStatement(source, register, query); (source as { revision: number }).revision++; (register as { bankRevision: number }).bankRevision++; query.revision++; expect((await pending).revision).toBe(book.revision);
  });
  it('rejects forged public shape, heads, origins, nested page metadata and line/match correlations', async () => {
    const detail = await projectUsFinancialPilotBankStatement(book, completed, q()), org = seed.actor.organizationId;
    const invalid = [ { ...detail, bookSha256: 'private' }, { ...detail, revision: detail.revision + 1 }, { ...detail, statement: { ...detail.statement, origin: 'legacy-frozen' } }, { ...detail, lines: { ...detail.lines, bankRevision: 2 } }, { ...detail, lines: { ...detail.lines, items: [{ ...detail.lines.items[0], ordinal: 2 }] } }, { ...detail, lines: { ...detail.lines, items: [{ ...detail.lines.items[0], matchId: null }] } }, { ...detail, matches: { ...detail.matches, items: [{ ...detail.matches.items[0], amountMinor: '9999' }] } }, { ...detail, current: { ...detail.current, endingDifferenceMinor: '1' } }, { ...detail, cashChangedSinceCompletion: true } ];
    for (const value of invalid) expect(() => validateUsFinancialPilotBankStatementDetail(value, org, q())).toThrow(expect.objectContaining({ code: 'invalid_financial_bank_data', status: 503 }));
    const context = await projectUsFinancialPilotBankContext(book, completed, { revision: book.revision, bankRevision: 3 }); expect(() => validateUsFinancialPilotBankContext({ ...context, accounts: [] }, org)).toThrow();
    const list = await projectUsFinancialPilotBankList(book, completed, { revision: book.revision, bankRevision: 3 }); expect(() => validateUsFinancialPilotBankStatementsPage({ ...list, total: 2 }, org)).toThrow();
  });
  it('rejects forged movement sources/status/dates and preserves the original journal pointer on manual reversals', async () => {
    const page = await projectUsFinancialPilotBankMovements(book, completed, q()), row = page.items[0];
    for (const changed of [{ ...row, status: 'selected' }, { ...row, bankDate: '2026-10-09' }, { ...row, source: { ...row.source, bookSha256: 'private' } }, { ...row, source: { ...row.source, journalRevision: row.journalRevision } }, { ...row, source: { kind: 'other', entityId: 'private', reference: null, journalRevision: null } }]) expect(() => validateUsFinancialPilotBankMovementsPage({ ...page, items: [changed] }, seed.actor.organizationId, q())).toThrow();
    const closed = await finance(book, { type: 'close_period', periodId: '2026' }), posted = await finance(closed, manual('reverse-cash', '2026-10-11')), original = (await projectUsFinancialBookV5(posted)).ledger.entries.at(-1)!, reversed = await finance(posted, { type: 'reverse_manual_journal', id: 'cash-reversal', entryId: original.id, transactionDate: '2026-10-11', accountingDate: '2027-01-01', periodId: '2027', reason: 'Actual reversal' });
    const result = await projectUsFinancialPilotBankMovements(reversed, completed, q(reversed)); expect(result.items.at(-1)).toMatchObject({ amountMinor: '-7', source: { kind: 'manual_reversal', entityId: null, reference: null, journalRevision: original.revision } }); expect(result.items.at(-1)!.journalRevision).toBeGreaterThan(original.revision);
  });
});
