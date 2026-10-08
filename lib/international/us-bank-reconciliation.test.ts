import { describe, expect, it } from 'vitest';
import { createLedger, postJournal, type FinancialAuthority, type Ledger } from './accounting/ledger';
import { reconciliationStatus, type BankStatement } from './accounting/reconciliation';
import { usStarterChart } from './countries/us/accounting';
import { canonicalErpJson } from './erp-contract';
import type { UsBankCommand, UsBankRecord, UsBankRequest } from './us-bank-contract';
import { applyUsBankCommand, validateUsBankRecord, validateUsBankRequest } from './us-bank-reconciliation';

const org = 'bank-local-test';
const statementId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const matchId = '00000000-0000-4000-8000-000000000003';
const actor: FinancialAuthority = { organizationId: org, userId: 'accountant-local', role: 'accountant', managementEntitled: true, timestamp: '2026-10-08T12:00:00Z' };
function ledger(): Ledger {
  const empty = createLedger({ organizationId: org, currency: 'USD', basis: 'accrual', accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  return postJournal(empty, { id: 'received', idempotencyKey: 'received', organizationId: org, currency: 'USD', basis: 'accrual', transactionDate: '2026-09-30', accountingDate: '2026-10-02', paymentDate: '2026-10-01', periodId: '2026', source: { type: 'manual_journal', id: 'receipt-review' }, description: 'Local cash movement', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '10000', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '10000' }] }, actor, 0);
}
function statement(): BankStatement { return { id: statementId, organizationId: org, externalConnectionId: 'opaque-ref', currency: 'USD', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: { currency: 'USD', minorUnits: '0' }, closing: { currency: 'USD', minorUnits: '10000' }, lines: [{ id: `${statementId}:1`, date: '2026-10-01', amount: { currency: 'USD', minorUnits: '10000' }, reference: 'Received funds' }] }; }
function request(command: UsBankCommand, revision: number | null, key: string = command.type, id = statementId): UsBankRequest { return { schemaVersion: 1, idempotencyKey: key, reconciliationId: id, expectedErpRevision: 50, expectedReconciliationRevision: revision, command }; }
function create(s = statement(), book = ledger(), siblings: readonly UsBankRecord[] = []): UsBankRecord { return applyUsBankCommand(null, request({ type: 'create_statement', statement: s }, null, 'create', s.id), book, actor, siblings); }
function approve(record: UsBankRecord, book = ledger(), siblings: readonly UsBankRecord[] = [record]): UsBankRecord { return applyUsBankCommand(record, request({ type: 'approve_match', id: matchId, statementLineIds: [`${statementId}:1`], ledgerEntryIds: ['received'] }, record.reconciliation.revision, 'approve'), book, actor, siblings); }
const copy = <T>(value: T): T => structuredClone(value);
function error(operation: () => unknown, code: string, status: number) { expect(operation).toThrow(expect.objectContaining({ code, status, message: code })); }

describe('isolated US bank review lifecycle', () => {
  it('captures immutable statement, human approval and completion without changing ERP or ledger', () => {
    const book = ledger(), before = canonicalErpJson(book), imported = statement(), original = create(imported, book);
    (imported as unknown as { lines: { amount: { minorUnits: string } }[] }).lines[0].amount.minorUnits = '999';
    expect(original.reconciliation.statement.lines[0].amount.minorUnits).toBe('10000');
    const matched = approve(original, book), complete = applyUsBankCommand(matched, request({ type: 'complete' }, 1), book, { ...actor, timestamp: '2026-10-08T12:00:01.000Z' }, [matched]);
    expect(original.reconciliation).toMatchObject({ revision: 0, matches: [] });
    expect(matched.reconciliation.matches[0]).toMatchObject({ approvedBy: actor.userId, approvedAt: actor.timestamp, idempotencyKey: 'approve' });
    expect(complete.reconciliation).toMatchObject({ revision: 2, completedLedgerRevision: book.revision, completedBy: actor.userId });
    expect(Object.isFrozen(complete.reconciliation.statement.lines[0].amount)).toBe(true);
    expect(Object.isFrozen(complete.reconciliation.matches[0].ledgerEntryIds)).toBe(true);
    expect(canonicalErpJson(book)).toBe(before);
    expect(reconciliationStatus(complete.reconciliation, book).ready).toBe(true);
    // expectedErpRevision=50 deliberately differs from ledger.revision=1.
    expect(complete.reconciliation.completedLedgerRevision).toBe(1);
  });
  it('uses paymentDate for bank matching while accounting date remains distinct, including closed periods', () => {
    const book = ledger(), closed = { ...book, periods: book.periods.map(p => ({ ...p, status: 'closed' as const })) };
    const record = create(statement(), closed);
    expect(approve(record, closed).reconciliation.matches).toHaveLength(1);
    expect(book.entries[0].transactionDate).toBe('2026-09-30');
    expect(book.entries[0].accountingDate).toBe('2026-10-02');
  });
  it('requires exact amounts and fresh reconciliation CAS before approving', () => {
    const r = create(), command: UsBankCommand = { type: 'approve_match', id: matchId, statementLineIds: [`${statementId}:1`], ledgerEntryIds: ['received'] };
    error(() => applyUsBankCommand(r, request(command, 1), ledger(), actor, [r]), 'bank_revision_conflict', 409);
    const smaller = create({ ...statement(), closing: { currency: 'USD', minorUnits: '9999' }, lines: [{ ...statement().lines[0], amount: { currency: 'USD', minorUnits: '9999' } }] });
    error(() => applyUsBankCommand(smaller, request(command, 0), ledger(), actor, [smaller]), 'reconciliation_amount_mismatch', 422);
    error(() => applyUsBankCommand(r, request({ ...command, ledgerEntryIds: ['missing'] }, 0), ledger(), actor, [r]), 'ledger_entry_required', 422);
    error(() => applyUsBankCommand(r, request({ ...command, statementLineIds: ['missing'] }, 0), ledger(), actor, [r]), 'statement_line_required', 422);
  });
  it('does not treat a repeated match or complete as another approved mutation', () => {
    const r = approve(create());
    error(() => approve(r), 'idempotency_conflict', 409);
    const changed: UsBankCommand = { type: 'approve_match', id: secondId, statementLineIds: [`${statementId}:1`], ledgerEntryIds: ['received'] };
    error(() => applyUsBankCommand(r, request(changed, 1, 'other'), ledger(), actor, [r]), 'reconciliation_already_matched', 409);
    const done = applyUsBankCommand(r, request({ type: 'complete' }, 1), ledger(), actor, [r]);
    error(() => applyUsBankCommand(done, request({ type: 'complete' }, 2, 'other'), ledger(), actor, [done]), 'reconciliation_closed', 409);
  });
  it('does not complete unapproved statements, invented opening balances, or newly unmatched movements', () => {
    const r = create();
    error(() => applyUsBankCommand(r, request({ type: 'complete' }, 0), ledger(), actor, [r]), 'reconciliation_incomplete', 409);
    const opening = create({ ...statement(), opening: { currency: 'USD', minorUnits: '1' }, closing: { currency: 'USD', minorUnits: '10001' } });
    const matched = approve(opening);
    error(() => applyUsBankCommand(matched, request({ type: 'complete' }, 1), ledger(), actor, [matched]), 'reconciliation_incomplete', 409);
    const exact = approve(r), old = ledger();
    const changed = postJournal(old, { id: 'new-cash', idempotencyKey: 'new-cash', organizationId: org, currency: 'USD', basis: 'accrual', transactionDate: '2026-10-03', accountingDate: '2026-10-03', periodId: '2026', source: { type: 'manual_journal', id: 'new-cash' }, description: 'Movement after review', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '1', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '1' }] }, actor, old.revision);
    error(() => applyUsBankCommand(exact, request({ type: 'complete' }, 1), changed, actor, [exact]), 'reconciliation_incomplete', 409);
  });
  it('supports explicitly approved many-bank-lines to one entry and preserves canonical sorted identities', () => {
    const s = { ...statement(), lines: [{ ...statement().lines[0], id: 'line-z', amount: { currency: 'USD' as const, minorUnits: '6000' } }, { ...statement().lines[0], id: 'line-a', amount: { currency: 'USD' as const, minorUnits: '4000' } }] };
    const r = create(s), approved = applyUsBankCommand(r, request({ type: 'approve_match', id: matchId, statementLineIds: ['line-z', 'line-a'], ledgerEntryIds: ['received'] }, 0), ledger(), actor, [r]);
    expect(approved.reconciliation.matches[0].statementLineIds).toEqual(['line-a', 'line-z']);
    expect(applyUsBankCommand(approved, request({ type: 'complete' }, 1), ledger(), actor, [approved]).reconciliation.revision).toBe(2);
  });
  it('reconciles exact signed outgoing cash without creating a balancing adjustment', () => {
    const incoming = ledger();
    const book = postJournal(incoming, { id: 'paid', idempotencyKey: 'paid', organizationId: org, currency: 'USD', basis: 'accrual', transactionDate: '2026-10-03', accountingDate: '2026-10-04', paymentDate: '2026-10-03', periodId: '2026', source: { type: 'manual_journal', id: 'expense-paid' }, description: 'Actual outgoing cash', cashFlowCategory: 'operating', lines: [{ accountId: 'purchases', debitMinor: '2550', creditMinor: '0' }, { accountId: 'cash', debitMinor: '0', creditMinor: '2550' }] }, actor, incoming.revision);
    const s = { ...statement(), closing: { currency: 'USD' as const, minorUnits: '7450' }, lines: [...statement().lines, { id: 'outgoing', date: '2026-10-03', amount: { currency: 'USD' as const, minorUnits: '-2550' }, reference: 'Already paid expense' }] };
    const r = create(s, book), matched = applyUsBankCommand(r, request({ type: 'approve_match', id: matchId, statementLineIds: [`${statementId}:1`, 'outgoing'], ledgerEntryIds: ['received', 'paid'] }, 0), book, actor, [r]);
    expect(applyUsBankCommand(matched, request({ type: 'complete' }, 1), book, actor, [matched]).reconciliation.completedLedgerRevision).toBe(2);
    expect(book.entries).toHaveLength(2);
  });
  it('voids only an unmatched unfinished import and retains the original statement and attribution', () => {
    const r = create(), before = canonicalErpJson(r.reconciliation.statement);
    const voided = applyUsBankCommand(r, request({ type: 'void_statement', reason: 'Wrong period selected' }, 0), ledger(), { ...actor, userId: 'owner-local', role: 'owner', timestamp: '2026-10-08T12:00:02Z' }, [r]);
    expect(voided).toMatchObject({ createdBy: actor.userId, createdAt: actor.timestamp, voided: { by: 'owner-local', reason: 'Wrong period selected' }, reconciliation: { revision: 1, matches: [] } });
    expect(canonicalErpJson(voided.reconciliation.statement)).toBe(before);
    expect(r.voided).toBeUndefined();
    error(() => applyUsBankCommand(voided, request({ type: 'complete' }, 1), ledger(), actor, [voided]), 'reconciliation_voided', 409);
    const matched = approve(r);
    error(() => applyUsBankCommand(matched, request({ type: 'void_statement', reason: 'Cannot erase approval' }, 1), ledger(), actor, [matched]), 'statement_not_voidable', 409);
  });
  it('bounds timestamps monotonically while preserving equivalent UTC Z/.000 forms', () => {
    const r = create();
    const exact = applyUsBankCommand(r, request({ type: 'void_statement', reason: 'Same instant' }, 0), ledger(), { ...actor, timestamp: '2026-10-08T12:00:00.000Z' }, [r]);
    expect(exact.voided?.at).toBe('2026-10-08T12:00:00.000Z');
    error(() => applyUsBankCommand(r, request({ type: 'void_statement', reason: 'Clock moved backwards' }, 0), ledger(), { ...actor, timestamp: '2026-10-08T11:59:59Z' }, [r]), 'bank_clock_reversed', 409);
  });
  it('refuses a new approval before its durable journal timestamp, even after a valid import timestamp', () => {
    const r = create(), book = ledger(), late = { ...book, entries: book.entries.map(entry => ({ ...entry, postedAt: '2026-10-08T12:00:01Z' })) };
    error(() => approve(r, late), 'bank_clock_reversed', 409);
    const approved = applyUsBankCommand(r, request({ type: 'approve_match', id: matchId, statementLineIds: [`${statementId}:1`], ledgerEntryIds: ['received'] }, 0), late, { ...actor, timestamp: '2026-10-08T12:00:01.000Z' }, [r]);
    expect(approved.reconciliation.matches[0].approvedAt).toBe('2026-10-08T12:00:01.000Z');
  });
  it.each(['member', 'read_only'] as const)('refuses %s authority without changing either state', role => {
    error(() => applyUsBankCommand(null, request({ type: 'create_statement', statement: statement() }, null), ledger(), { ...actor, role }, []), 'financial_permission_required', 403);
  });
  it('rejects missing entitlement, foreign authority and a CHF ledger', () => {
    error(() => applyUsBankCommand(null, request({ type: 'create_statement', statement: statement() }, null), ledger(), { ...actor, managementEntitled: false }, []), 'management_entitlement_required', 402);
    error(() => applyUsBankCommand(null, request({ type: 'create_statement', statement: statement() }, null), ledger(), { ...actor, organizationId: 'foreign' }, []), 'tenant_mismatch', 403);
    error(() => applyUsBankCommand(null, request({ type: 'create_statement', statement: statement() }, null), { ...ledger(), currency: 'CHF' }, actor, []), 'edition_unavailable', 409);
  });
});

describe('cross-statement integrity', () => {
  it('rejects duplicate immutable content even with different IDs, connections and line IDs', () => {
    const existing = create(), duplicate = { ...statement(), id: secondId, externalConnectionId: 'another-connection', lines: [{ ...statement().lines[0], id: 'different-line-id' }] };
    error(() => create(duplicate, ledger(), [existing]), 'bank_statement_duplicate', 409);
    const voided = applyUsBankCommand(existing, request({ type: 'void_statement', reason: 'Import voided' }, 0), ledger(), actor, [existing]);
    error(() => create(duplicate, ledger(), [voided]), 'bank_statement_duplicate', 409);
  });
  it('refuses inclusive cash-account overlap across different connections, including completed statements', () => {
    const first = create(), overlapping = { ...statement(), id: secondId, externalConnectionId: 'other-ref', start: '2026-10-31', end: '2026-11-30', lines: [{ ...statement().lines[0], date: '2026-10-31', reference: 'Different import' }] };
    error(() => create(overlapping, ledger(), [first]), 'bank_statement_overlap', 409);
    const matched = approve(first), completed = applyUsBankCommand(matched, request({ type: 'complete' }, 1), ledger(), actor, [matched]);
    error(() => create(overlapping, ledger(), [completed]), 'bank_statement_overlap', 409);
    const voided = applyUsBankCommand(first, request({ type: 'void_statement', reason: 'Wrong dates' }, 0), ledger(), actor, [first]);
    expect(create(overlapping, ledger(), [voided]).reconciliation.revision).toBe(0);
  });
  it('blocks reusing one cash journal across two accounts and connection IDs', () => {
    const empty = createLedger({ organizationId: org, currency: 'USD', basis: 'accrual', accounts: [...usStarterChart, { id: 'bank2', code: '1001', name: 'Second cash account', type: 'asset', cash: true }], periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
    const book = postJournal(empty, { id: 'received', idempotencyKey: 'received', organizationId: org, currency: 'USD', basis: 'accrual', transactionDate: '2026-10-01', accountingDate: '2026-10-01', periodId: '2026', source: { type: 'manual_journal', id: 'review' }, description: 'Two cash movements in one journal', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '10000', creditMinor: '0' }, { accountId: 'bank2', debitMinor: '10000', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '20000' }] }, actor, 0);
    const first = approve(create(statement(), book), book), second = create({ ...statement(), id: secondId, externalConnectionId: 'bank2-ref', cashAccountId: 'bank2', lines: [{ ...statement().lines[0], id: `${secondId}:1` }] }, book, [first]);
    error(() => applyUsBankCommand(second, request({ type: 'approve_match', id: matchId, statementLineIds: [`${secondId}:1`], ledgerEntryIds: ['received'] }, 0, 'match-bank2', secondId), book, actor, [first, second]), 'bank_entry_already_matched', 409);
  });
  it('bounds all historical records including voids and refuses stale/foreign sibling projections', () => {
    const first = create(), all = Array.from({ length: 100 }, (_, i) => { const r = copy(first); return { ...r, reconciliation: { ...r.reconciliation, statement: { ...r.reconciliation.statement, id: `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}` } } }; });
    error(() => create({ ...statement(), id: secondId }, ledger(), all), 'bank_statement_limit_reached', 409);
    error(() => approve(first, ledger(), [{ ...first, createdBy: 'unexpected-owner' }]), 'bank_revision_conflict', 409);
    error(() => approve(first, ledger(), [{ ...first, reconciliation: { ...first.reconciliation, organizationId: 'other' } }]), 'invalid_bank_record', 503);
    let calls = 0; const hidden: UsBankRecord[] = [first]; Object.defineProperty(hidden, '0', { enumerable: true, get() { calls++; throw new Error('secret'); } });
    error(() => approve(first, ledger(), hidden), 'invalid_bank_record', 503); expect(calls).toBe(0);
  });
});

describe('strict untrusted requests and durable projections', () => {
  it('canonicalizes twelve match IDs lexically before hashing without changing caller or CSV order', () => {
    const s = { ...statement(), lines: Array.from({ length: 12 }, (_, i) => ({ id: `${statementId}:${i + 1}`, date: '2026-10-01', amount: { currency: 'USD' as const, minorUnits: i === 11 ? '1200' : '800' }, reference: `Explicit row ${i + 1}` })) };
    const input = request({ type: 'approve_match', id: matchId, statementLineIds: s.lines.map(line => line.id), ledgerEntryIds: ['received'] }, 0, 'stable-set-key'), original = canonicalErpJson(input);
    const normalized = validateUsBankRequest(input, org);
    expect(normalized.command).toMatchObject({ statementLineIds: [`${statementId}:1`, `${statementId}:10`, `${statementId}:11`, `${statementId}:12`, ...Array.from({ length: 8 }, (_, i) => `${statementId}:${i + 2}`)] });
    expect(canonicalErpJson(input)).toBe(original);
    const imported = create(s), approved = applyUsBankCommand(imported, normalized, ledger(), actor, [imported]);
    expect(approved.reconciliation.statement.lines.map(line => line.id)).toEqual(s.lines.map(line => line.id));
    if (normalized.command.type !== 'approve_match') throw new Error('Expected match');
    expect(approved.reconciliation.matches[0].fingerprint).toBe(JSON.stringify([org, statementId, 'USD', 'cash', normalized.command.statementLineIds, normalized.command.ledgerEntryIds]));
    const reordered = validateUsBankRequest({ ...input, command: { ...input.command, statementLineIds: s.lines.map(line => line.id).reverse() } }, org);
    // Same canonical request/actor gives the same exact replay identity. Receipt
    // lookup and historical replay itself remain the durable service's duty.
    expect(canonicalErpJson([org, actor.userId, reordered])).toBe(canonicalErpJson([org, actor.userId, normalized]));
    error(() => applyUsBankCommand(approved, normalized, ledger(), actor, [approved]), 'bank_revision_conflict', 409);
  });
  it('canonicalizes Unicode sets in the engine UTF16 order and keeps both arrays immutable', () => {
    const lineIds = ['\ue000', '😀'], entryIds = ['journal:\ue000', 'journal:😀'];
    const normalized = validateUsBankRequest(request({ type: 'approve_match', id: matchId, statementLineIds: lineIds, ledgerEntryIds: entryIds }, 0), org);
    expect(normalized.command).toMatchObject({ statementLineIds: ['😀', '\ue000'], ledgerEntryIds: ['journal:😀', 'journal:\ue000'] });
    expect(lineIds).toEqual(['\ue000', '😀']); expect(entryIds).toEqual(['journal:\ue000', 'journal:😀']);
    if (normalized.command.type !== 'approve_match') throw new Error('Expected match');
    expect(Object.isFrozen(normalized.command.statementLineIds)).toBe(true); expect(Object.isFrozen(normalized.command.ledgerEntryIds)).toBe(true);
  });
  it.each(['USD1', 'CHF', 'usd'])('refuses statement currency %s', currency => {
    const s = { ...statement(), currency };
    error(() => validateUsBankRequest({ ...request({ type: 'create_statement', statement: statement() }, null), command: { type: 'create_statement', statement: s } }, org), 'invalid_bank_request', 422);
  });
  it.each(['-0', '00', '01', '1.2', '1e2', 'Infinity', '9'.repeat(37)])('refuses noncanonical or unbounded minor amount %s', minorUnits => {
    const s = { ...statement(), closing: { currency: 'USD', minorUnits }, lines: [{ ...statement().lines[0], amount: { currency: 'USD', minorUnits } }] };
    error(() => validateUsBankRequest(request({ type: 'create_statement', statement: s as BankStatement }, null), org), 'invalid_bank_request', 422);
  });
  it.each(['2026-02-30', '0000-01-01', '2026-10-1', '2026-10-01T00:00:00Z'])('rejects invalid civil statement date %s', start => {
    error(() => validateUsBankRequest(request({ type: 'create_statement', statement: { ...statement(), start } }, null), org), 'invalid_bank_request', 422);
  });
  it('rejects unknown fields, caller approval/grants, inherited values and accessors without invoking them', () => {
    const base = request({ type: 'create_statement', statement: statement() }, null);
    for (const value of [{ ...base, role: 'owner' }, { ...base, command: { ...base.command, approvedBy: 'owner' } }, Object.assign(Object.create({ role: 'owner' }) as object, base)]) error(() => validateUsBankRequest(value, org), 'invalid_bank_request', 422);
    let calls = 0; const getter = { ...base }; Object.defineProperty(getter, 'command', { enumerable: true, get() { calls++; throw new Error('secret'); } });
    error(() => validateUsBankRequest(getter, org), 'invalid_bank_request', 422); expect(calls).toBe(0);
  });
  it.each(['Bad\u0000value', 'bad\u007fvalue', 'bad\ud800value', 'bad\udc00value'])('rejects unrepresentable text %#', reference => {
    const s = { ...statement(), lines: [{ ...statement().lines[0], reference }] };
    error(() => validateUsBankRequest(request({ type: 'create_statement', statement: s }, null), org), 'invalid_bank_request', 422);
  });
  it('accepts well-formed emoji and the exact 240-character key without trimming payload', () => {
    const s = { ...statement(), lines: [{ ...statement().lines[0], reference: '  Paid 😀  ' }] };
    const parsed = validateUsBankRequest(request({ type: 'create_statement', statement: s }, null, 'k'.repeat(240)), org);
    expect(parsed.command.type === 'create_statement' && parsed.command.statement.lines[0].reference).toBe('  Paid 😀  ');
    error(() => validateUsBankRequest(request({ type: 'create_statement', statement: s }, null, 'k'.repeat(241)), org), 'invalid_bank_request', 422);
  });
  it('accepts 1000 lines but rejects 1001 and duplicate/missing bank identities', () => {
    const s = { ...statement(), closing: { currency: 'USD' as const, minorUnits: '1000' }, lines: Array.from({ length: 1000 }, (_, i) => ({ id: `line-${i}`, date: '2026-10-01', amount: { currency: 'USD' as const, minorUnits: '1' }, reference: 'Explicit row' })) };
    expect(validateUsBankRequest(request({ type: 'create_statement', statement: s }, null), org).command.type).toBe('create_statement');
    error(() => validateUsBankRequest(request({ type: 'create_statement', statement: { ...s, lines: [...s.lines, s.lines[0]] } }, null), org), 'invalid_bank_request', 422);
    error(() => validateUsBankRequest(request({ type: 'approve_match', id: matchId, statementLineIds: ['a', 'a'], ledgerEntryIds: ['received'] }, 0), org), 'invalid_bank_request', 422);
    error(() => validateUsBankRequest(request({ type: 'complete' }, null), org), 'invalid_bank_request', 422);
    error(() => validateUsBankRequest({ ...request({ type: 'create_statement', statement: statement() }, null), expectedErpRevision: 0 }, org), 'invalid_bank_request', 422);
  });
  it('rejects forged revisions, approval fingerprint, completion/void combinations and clock stamps', () => {
    const r = approve(create());
    const malformed: unknown[] = [
      { ...r, role: 'owner' }, { ...r, reconciliation: { ...r.reconciliation, revision: 10 } },
      { ...r, reconciliation: { ...r.reconciliation, matches: [{ ...r.reconciliation.matches[0], fingerprint: 'fake' }] } },
      { ...r, reconciliation: { ...r.reconciliation, completedAt: actor.timestamp } },
      { ...r, voided: { by: actor.userId, at: actor.timestamp, reason: 'Hide a match' } },
      { ...r, createdAt: '2026-02-30T12:00:00Z' }, { ...r, createdAt: '2026-10-08' },
      { ...r, reconciliation: { ...r.reconciliation, matches: [{ ...r.reconciliation.matches[0], approvedAt: '2026-10-08T11:00:00Z' }] } },
    ];
    malformed.forEach(value => error(() => validateUsBankRecord(value, org), 'invalid_bank_record', 503));
    error(() => validateUsBankRecord(r, 'foreign'), 'invalid_bank_record', 503);
  });
  it('validates an immutable historical completion without pretending its old ledger revision is current', () => {
    const r = approve(create()), done = applyUsBankCommand(r, request({ type: 'complete' }, 1), ledger(), actor, [r]);
    expect(validateUsBankRecord(done, org)).toEqual(done);
    expect(done.reconciliation.completedLedgerRevision).toBe(1);
    const missingLines = { ...done, reconciliation: { ...done.reconciliation, matches: [], revision: 1 } };
    error(() => validateUsBankRecord(missingLines, org), 'invalid_bank_record', 503);
  });
});
