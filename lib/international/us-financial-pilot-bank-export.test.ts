import { beforeAll, describe, expect, it, vi } from 'vitest';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { applyUsBankCommand } from './us-bank-reconciliation';
import { postUsManualJournal } from './accounting/us-journal';
import { validateStoredErp } from './runtime-validation';
import { applyUsFinancialOperationV5, promoteUsFinancialBookV5, projectUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import type { UsFinancialBookV5, UsFinancialErpCommandV5 } from './us-financial-kernel-types';
import { canonicalErpJson, ErpError } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { appendUsFinancialPilotBankRegister, applyUsFinancialPilotBank, buildUsFinancialPilotBankProof, validateUsFinancialPilotBankRequest, type UsFinancialPilotBankCommand, type UsFinancialPilotBankRegister } from './us-financial-pilot-bank';
import { projectUsFinancialPilotBankStatement, projectUsFinancialPilotBankMovements } from './us-financial-pilot-bank-projection';
import { buildUsFinancialPilotBankExportSnapshot, validateUsFinancialPilotBankExportSnapshot, renderUsFinancialPilotBankExportCsv, createUsFinancialPilotBankExportHandler, type UsFinancialPilotBankExportDependencies } from './us-financial-pilot-bank-export';
import { validateUsFinancialPilotBankExportSelector, browserUsFinancialPilotBankExportUrl, US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS as headers, US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES, type UsFinancialPilotBankExportSelector } from './browser-us-financial-pilot-bank-input';
import { browserUsFinancialPilotBankCopy as bankCopy } from './browser-us-financial-pilot-bank-copy';
import { financialPilotCsvDecimal, financialPilotCsvTextCell, financialPilotCsvQuoted } from './us-financial-pilot-csv';
import { buildUsFinancialPilotExportSnapshot } from './us-financial-pilot-export-projection';
import { renderUsFinancialPilotExportCsv } from './us-financial-pilot-export-renderer';

const org = '0a7ec0b8-a465-4df9-b756-e99aca4439ce', id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = <T>(v: T): T => structuredClone(v);
type MutableDependencies = { -readonly [K in keyof UsFinancialPilotBankExportDependencies]: UsFinancialPilotBankExportDependencies[K] };
let seed: Awaited<ReturnType<typeof financialKernelFixture>>, book: UsFinancialBookV5, completed: UsFinancialPilotBankRegister;
const empty = (): UsFinancialPilotBankRegister => ({ schemaVersion: 1, organizationId: org, bankRevision: 0, records: [], operations: [] });
const imported: UsFinancialPilotBankCommand = { type: 'create_statement', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', openingMinor: '0', closingMinor: '10000', lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Exact référence 🌍 ' }] };
async function step(register: UsFinancialPilotBankRegister, command: UsFinancialPilotBankCommand, n: number, source = book) {
  const statementId = command.type === 'create_statement' ? id(n) : command.statementId, request = validateUsFinancialPilotBankRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: id(n), expectedRevision: source.revision, expectedBankRevision: register.bankRevision, expectedStatementRevision: command.type === 'create_statement' ? null : register.records.find(r => r.record.reconciliation.statement.id === statementId)!.record.reconciliation.revision, command });
  const record = applyUsFinancialPilotBank(request, await projectUsFinancialBookV5(source), register, seed.actor), proof = await buildUsFinancialPilotBankProof(request, source, seed.actor, record); return appendUsFinancialPilotBankRegister(register, record, proof);
}
const selector = (source = book, register = completed, language: 'fr' | 'de' | 'it' | 'en' = 'en', n = 1, origin: 'financial-v5' | 'legacy-frozen' = 'financial-v5'): UsFinancialPilotBankExportSelector => validateUsFinancialPilotBankExportSelector({ consumer: 'financial-pilot', schemaVersion: 1, kind: 'bank_reconciliation', organizationId: org, revision: source.revision, bankRevision: register.bankRevision, statementRevision: register.records.find(r => r.record.reconciliation.statement.id === id(n))!.record.reconciliation.revision, statementId: id(n), origin, format: 'csv', language });
const dtoQuery = (s: UsFinancialPilotBankExportSelector) => ({ revision: s.revision, bankRevision: s.bankRevision, statementId: s.statementId, origin: s.origin });
beforeAll(async () => {
  const original = await financialKernelFixture({ paid: '10000', tax: '0' }); seed = JSON.parse(JSON.stringify(original).replaceAll(original.actor.organizationId, org)) as typeof original;
  book = await promoteUsFinancialBookV5(seed.baseline, seed.policy, seed.actor); const view = await projectUsFinancialBookV5(book);
  completed = await step(empty(), imported, 1); completed = await step(completed, { type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [view.ledger.entries.find(e => e.paymentDate)!.revision] }, 2); completed = await step(completed, { type: 'complete', statementId: id(1) }, 3);
});
async function finance(source: UsFinancialBookV5, command: UsFinancialErpCommandV5) { return (await applyUsFinancialOperationV5(source, { type: 'erp_command', idempotencyKey: 'export-finance-' + source.revision, command, facts: { kind: 'none' } }, seed.actor, usFinancialErpEntityIdV5(command, org))).book; }
function legacy(n: number, complete = false, voided = false, actor = seed.actor) {
  const statementId = id(n), envelope = { schemaVersion: 1 as const, idempotencyKey: 'legacy-create-' + n, reconciliationId: statementId, expectedErpRevision: seed.baseline.revision, expectedReconciliationRevision: null };
  let record = applyUsBankCommand(null, { ...envelope, command: { type: 'create_statement', statement: { id: statementId, organizationId: org, externalConnectionId: 'PRIVATE-legacy-connection', currency: 'USD', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: { currency: 'USD', minorUnits: '0' }, closing: { currency: 'USD', minorUnits: '10000' }, lines: [{ id: statementId + ':1', date: '2026-10-10', amount: { currency: 'USD', minorUnits: '10000' }, reference: 'Frozen legacy facts' }] } } }, seed.baseline.ledger, actor, []);
  if (complete) { record = applyUsBankCommand(record, { ...envelope, idempotencyKey: 'legacy-match-' + n, expectedReconciliationRevision: 0, command: { type: 'approve_match', id: id(n + 100), statementLineIds: [statementId + ':1'], ledgerEntryIds: [seed.baseline.ledger.entries.find(e => e.paymentDate)!.id] } }, seed.baseline.ledger, actor, [record]); record = applyUsBankCommand(record, { ...envelope, idempotencyKey: 'legacy-complete-' + n, expectedReconciliationRevision: 1, command: { type: 'complete' } }, seed.baseline.ledger, actor, [record]); }
  if (voided) record = applyUsBankCommand(record, { ...envelope, idempotencyKey: 'legacy-void-' + n, expectedReconciliationRevision: 0, command: { type: 'void_statement', reason: 'Frozen cancellation' } }, seed.baseline.ledger, actor, [record]);
  return { origin: 'legacy-frozen' as const, record };
}
function memory(source = book, register = completed, exportSelector = selector(source, register)) {
  const scope = { scope: { organizationId: org, actor: seed.actor, policy: seed.policy, grantVersion: 1 }, optInVersion: 1 };
  const store = { read: vi.fn(async () => ({ book: clone(source), register: clone(register) })), head: vi.fn(async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: source.revision, bankRevision: register.bankRevision })), receipt: vi.fn(), commit: vi.fn() };
  const deps = { enabled: vi.fn(() => true), authority: vi.fn(async () => ({ mode: 'browser' as const, actor: clone(seed.actor) })), configuration: vi.fn(async () => clone(seed.configuration)), scope: vi.fn(async () => clone(scope)), store: vi.fn(() => store), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn() };
  const q = exportSelector, request = (query = q, init: RequestInit = {}) => { const h = new Headers({ 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': seed.actor.userId, 'Sec-Fetch-Site': 'same-origin' }); new Headers(init.headers).forEach((v, k) => h.set(k, v)); return new Request('https://zentraapp.ch' + browserUsFinancialPilotBankExportUrl(query), { ...init, headers: h }); };
  const run = (extra: Partial<UsFinancialPilotBankExportDependencies> = {}, req = request()) => createUsFinancialPilotBankExportHandler({ ...deps, ...extra })(req, org, q.statementId);
  return { deps, store, scope, q, request, run };
}
function parseCsv(bytes: Uint8Array): string[][] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (c === ',' && !quoted) { row.push(cell); cell = ''; } else if (c === '\r' && text[i + 1] === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += c; }
  expect(quoted).toBe(false); expect(cell).toBe(''); return rows;
}

describe('bank complete V5 export snapshot', () => {
  it('matches Stage1 detail/movements and carries distinct F/L, immutable completion and no private facts', async () => {
    const q = selector(), before = canonicalErpJson([book, completed]), result = await buildUsFinancialPilotBankExportSnapshot(book, completed, q), detail = await projectUsFinancialPilotBankStatement(book, completed, dtoQuery(q)), movements = await projectUsFinancialPilotBankMovements(book, completed, dtoQuery(q));
    expect(result.statement).toEqual(detail.statement); expect(result.lines).toEqual(detail.lines.items); expect(result.matches).toEqual(detail.matches.items); expect(result.movements).toEqual(movements.items); expect(result.current).toEqual(detail.current); expect(result.ledgerRevision).not.toBe(result.revision);
    for (const value of ['bookSha256', 'commandHash', 'idempotencyKey', 'fingerprint', 'externalConnectionId', completed.operations[0].source.bookSha256, book.policy.approval.reference]) expect(JSON.stringify(result)).not.toContain(value);
    expect(canonicalErpJson([book, completed])).toBe(before); expect(Object.isFrozen(result.lines[0])).toBe(true);
  });
  it('exports every line beyond page25 and retains exact grouped sums and normalized identities', async () => {
    const command = { ...imported, lines: Array.from({ length: 40 }, (_, i) => ({ date: '2026-10-10', amountMinor: '250', reference: 'Row ' + i })) } as UsFinancialPilotBankCommand;
    let register = await step(empty(), command, 1); const payment = (await projectUsFinancialBookV5(book)).ledger.entries.find(e => e.paymentDate)!;
    register = await step(register, { type: 'approve_match', statementId: id(1), statementLineIds: register.records[0].record.reconciliation.statement.lines.map(l => l.id), journalRevisions: [payment.revision] }, 2);
    const q = selector(book, register), result = await buildUsFinancialPilotBankExportSnapshot(book, register, q), page1 = await projectUsFinancialPilotBankStatement(book, register, dtoQuery(q)), page2 = await projectUsFinancialPilotBankStatement(book, register, { ...dtoQuery(q), lineCursor: page1.lines.nextCursor });
    expect(result.lines).toHaveLength(40); expect(result.lines.slice(0, 25)).toEqual(page1.lines.items); expect(result.lines.slice(25)).toEqual(page2.lines.items); expect(result.matches[0].amountMinor).toBe('10000');
    const rows = parseCsv(renderUsFinancialPilotBankExportCsv(result)); expect(rows.filter(r => r[0] === id(2) && r.length === 2)).toHaveLength(41); expect(rows.filter(r => r[0] === id(2) && r.length === 5)).toHaveLength(1);
  });
  it('exports matches and movements beyond page25 from independently replayable baseline journals', async () => {
    let ledger = seed.baseline.ledger;
    for (let i = 0; i < 40; i++) ledger = postUsManualJournal(ledger, { id: 'complete-export-' + i, transactionDate: '2026-10-11', accountingDate: '2026-10-11', periodId: '2026', description: 'Recorded baseline movement ' + i, sourceReference: 'Public source ' + i, cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '1', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '1' }] }, 'baseline-export-key-' + i, seed.actor, ledger.revision);
    const baseline = validateStoredErp({ ...seed.baseline, revision: seed.baseline.revision + 40, ledger }, org), source = await promoteUsFinancialBookV5(baseline, seed.policy, seed.actor), view = await projectUsFinancialBookV5(source), entries = view.ledger.entries.filter(e => e.paymentDate || e.source.type === 'manual_journal');
    const lines = entries.map(e => ({ date: e.paymentDate ?? e.transactionDate, amountMinor: e.paymentDate ? '10000' : '1', reference: 'Statement ' + e.revision })); let register = await step(empty(), { ...imported, closingMinor: '10040', lines } as UsFinancialPilotBankCommand, 1, source);
    for (let i = 0; i < entries.length; i++) register = await step(register, { type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':' + (i + 1)], journalRevisions: [entries[i].revision] }, i + 2, source);
    register = await step(register, { type: 'complete', statementId: id(1) }, 100, source); const q = selector(source, register), result = await buildUsFinancialPilotBankExportSnapshot(source, register, q), detail = await projectUsFinancialPilotBankStatement(source, register, dtoQuery(q)), next = await projectUsFinancialPilotBankStatement(source, register, { ...dtoQuery(q), lineCursor: detail.lines.nextCursor, matchCursor: detail.matches.nextCursor }), moves = await projectUsFinancialPilotBankMovements(source, register, dtoQuery(q)), nextMoves = await projectUsFinancialPilotBankMovements(source, register, { ...dtoQuery(q), cursor: moves.nextCursor });
    expect(result.matches).toHaveLength(41); expect(result.movements).toHaveLength(41); expect(result.matches.slice(25)).toEqual(next.matches.items); expect(result.lines.slice(25)).toEqual(next.lines.items); expect(result.movements!.slice(25)).toEqual(nextMoves.items); expect(result.current!.ready).toBe(true); expect(result.matches.reduce((n, m) => n + BigInt(m.amountMinor), BigInt(0))).toBe(BigInt(10040));
    const duplicateJournal = { ...result, matches: result.matches.map((m, i) => i === 25 ? { ...m, journalRevisions: result.matches[1].journalRevisions } : m) }; expect(() => validateUsFinancialPilotBankExportSnapshot(duplicateJournal)).toThrow(expect.objectContaining({ status: 503 }));
  }, 20_000);
  it('refuses a full export exceeding decoded UTF8 budget although book and register are independently readable', async () => {
    let ledger = seed.baseline.ledger;
    for (let i = 0; i < 380; i++) ledger = postUsManualJournal(ledger, { id: 'large-export-' + i, transactionDate: '2026-10-11', accountingDate: '2026-10-11', periodId: '2026', description: '🌍'.repeat(1000), sourceReference: 'Public ' + i, cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '1', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '1' }] }, 'large-export-key-' + i, seed.actor, ledger.revision);
    const baseline = validateStoredErp({ ...seed.baseline, revision: seed.baseline.revision + 380, ledger }, org), source = await promoteUsFinancialBookV5(baseline, seed.policy, seed.actor), register = await step(empty(), { ...imported, closingMinor: '1000', lines: Array.from({ length: 1000 }, () => ({ date: '2026-10-10', amountMinor: '1', reference: '🌍'.repeat(128) })) } as UsFinancialPilotBankCommand, 1, source);
    await expect(buildUsFinancialPilotBankExportSnapshot(source, register, selector(source, register))).rejects.toMatchObject({ code: 'financial_pilot_bank_export_too_large', status: 413 });
  });
  it('keeps historical completion after finance-only close and distinguishes later cash', async () => {
    const closed = await finance(book, { type: 'close_period', periodId: '2026' }), unchanged = await buildUsFinancialPilotBankExportSnapshot(closed, completed, selector(closed)); expect(unchanged.statement.completion!.source!.revision).toBe(book.revision); expect(unchanged.cashChangedSinceCompletion).toBe(false);
    const opened = await finance(closed, { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }), changed = await finance(opened, { type: 'post_manual_journal', id: 'export-cash', transactionDate: '2026-10-11', accountingDate: '2027-01-01', periodId: '2027', description: 'Later cash', sourceReference: 'Public cash reference', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '7', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '7' }] });
    const current = await buildUsFinancialPilotBankExportSnapshot(changed, completed, selector(changed)); expect(current.cashChangedSinceCompletion).toBe(true); expect(current.current).toMatchObject({ unmatchedMovementCount: 1, endingDifferenceMinor: '7', ready: false }); expect(current.statement.completion).toEqual(unchanged.statement.completion);
    const reversed = await finance(changed, { type: 'reverse_manual_journal', entryId: 'export-cash', id: 'export-reverse', periodId: '2027', accountingDate: '2027-01-02', transactionDate: '2026-10-12', reason: 'Exact reverse' });
    const snapshot = await buildUsFinancialPilotBankExportSnapshot(reversed, completed, selector(reversed)), reversal = snapshot.movements!.find(m => m.source.kind === 'manual_reversal')!; expect(reversal.amountMinor).toBe('-7'); expect(reversal.source.journalRevision).toBe(current.movements!.find(m => m.description === 'Later cash')!.journalRevision); expect(snapshot.current!.endingDifferenceMinor).toBe('0'); expect(snapshot.cashChangedSinceCompletion).toBe(true);
    let register = await step(empty(), { ...imported, lines: [...(imported.type === 'create_statement' ? imported.lines : []), { date: '2026-10-11', amountMinor: '7', reference: 'Incoming' }, { date: '2026-10-12', amountMinor: '-7', reference: 'Exact outgoing' }] } as UsFinancialPilotBankCommand, 1, reversed);
    register = await step(register, { type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':1'], journalRevisions: [snapshot.movements![0].journalRevision] }, 2, reversed); register = await step(register, { type: 'approve_match', statementId: id(1), statementLineIds: [id(1) + ':2', id(1) + ':3'], journalRevisions: snapshot.movements!.slice(1).map(m => m.journalRevision) }, 3, reversed); register = await step(register, { type: 'complete', statementId: id(1) }, 4, reversed); const grouped = await buildUsFinancialPilotBankExportSnapshot(reversed, register, selector(reversed, register)); expect(grouped.matches[1].amountMinor).toBe('0'); expect(grouped.current!.ready).toBe(true);
  });
  it.each([[false, false], [true, false], [false, true]])('legacy complete=%s void=%s remains recorded-only', async (complete, voided) => {
    const register = { ...empty(), records: [legacy(50, complete, voided)] }, q = selector(book, register, 'en', 50, 'legacy-frozen'), result = await buildUsFinancialPilotBankExportSnapshot(book, register, q), detail = await projectUsFinancialPilotBankStatement(book, register, dtoQuery(q));
    expect(result.statement).toEqual(detail.statement); expect(result.matches).toEqual(detail.matches.items); expect(result.movements).toBeNull(); expect(result.current).toBeNull(); expect(result.cashChangedSinceCompletion).toBeNull(); if (complete) { expect(result.statement.completion!.source).toBeNull(); expect(result.matches[0].sourceRevision).toBeNull(); }
    const csv = new TextDecoder().decode(renderUsFinancialPilotBankExportCsv(result)); expect(csv).toContain(bankCopy.en.csv.legacyUnavailable); expect(csv).not.toContain('PRIVATE-legacy-connection');
  });
  it('captures sources before its first await and rejects stale F/B/R/origin/id', async () => {
    const source = clone(book), register = clone(completed), task = buildUsFinancialPilotBankExportSnapshot(source, register, selector()); (source as { revision: number }).revision++; (register as { bankRevision: number }).bankRevision++; expect((await task).revision).toBe(book.revision);
    for (const patch of [{ revision: book.revision + 1 }, { bankRevision: 2 }, { statementRevision: 1 }, { statementId: id(9) }, { origin: 'legacy-frozen' }]) await expect(buildUsFinancialPilotBankExportSnapshot(book, completed, { ...selector(), ...patch } as UsFinancialPilotBankExportSelector)).rejects.toMatchObject({ status: [id(9), 'legacy-frozen'].includes(Object.values(patch)[0] as string) ? 404 : 409 });
  });
  it('rejects global cross-page duplicate claims, wrong sums/current/shape and accessors without execution', async () => {
    const result = await buildUsFinancialPilotBankExportSnapshot(book, completed, selector());
    for (const patch of [{ bookSha256: 'PRIVATE' }, { lines: [{ ...result.lines[0], matchId: null }] }, { matches: [{ ...result.matches[0], amountMinor: '9999' }] }, { movements: [{ ...result.movements![0], status: 'available' }] }, { current: { ...result.current, endingDifferenceMinor: '1' } }, { cashChangedSinceCompletion: true }, { selector: { ...result.selector, organizationId: id(99) } }]) expect(() => validateUsFinancialPilotBankExportSnapshot({ ...result, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
    let calls = 0; const getter = { ...result }; Object.defineProperty(getter, 'lines', { enumerable: true, get() { calls++; return result.lines; } }); expect(() => validateUsFinancialPilotBankExportSnapshot(getter)).toThrow(); expect(calls).toBe(0); expect(() => validateUsFinancialPilotBankExportSnapshot(Object.create(result))).toThrow();
    const q = selector(), register = clone(completed); (register.operations[0].source as { bookSha256: string }).bookSha256 = 'a'.repeat(64); await expect(buildUsFinancialPilotBankExportSnapshot(book, register, q)).rejects.toMatchObject({ status: 503 });
    for (const reference of ['\ud800', 'bad\0text']) expect(() => validateUsFinancialPilotBankExportSnapshot({ ...result, lines: [{ ...result.lines[0], reference }] })).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe('quoted exact CSV and unchanged shared financial primitives', () => {
  it.each(['fr', 'de', 'it', 'en'] as const)('renders complete %s labels, USD, ISO and UTF8 BOM/CRLF', async language => {
    const result = await buildUsFinancialPilotBankExportSnapshot(book, completed, selector(book, completed, language)), bytes = renderUsFinancialPilotBankExportCsv(result), rows = parseCsv(bytes), c = bankCopy[language].csv;
    expect(bytes.slice(0, 3)).toEqual(new Uint8Array([239, 187, 191])); expect(bytes.slice(-2)).toEqual(new Uint8Array([13, 10])); expect(rows).toContainEqual([c.opening, '0.00']); expect(rows).toContainEqual([c.closing, '100.00']); expect(rows).toContainEqual([c.createdBy, result.statement.createdBy]); expect(rows).toContainEqual([c.createdAt, result.statement.createdAt]); expect(rows.some(r => r.includes('2026-10-10'))).toBe(true); expect(rows.some(r => r.includes('Exact référence 🌍 '))).toBe(true); expect(rows[0]).toEqual([c.title]); expect(bytes.byteLength).toBeGreaterThan(new TextDecoder().decode(bytes).length);
  });
  it.each(['=SUM(A1)', '+1', '-1', '@x', '\u200b=1', '\u00a0\ufeff@x', '\t-1'])('neutralizes Unicode-prefixed text %j without changing monetary negatives', text => { expect(financialPilotCsvTextCell(text)).toBe("'" + text); expect(financialPilotCsvDecimal('-900719925474099301')).toBe('-9007199254740993.01'); expect(financialPilotCsvQuoted('a,"b"')).toBe('"a,""b"""'); });
  it('protects actual imported references and quotes exact accents/double quotes', async () => {
    const register = await step(empty(), { ...imported, lines: [{ date: '2026-10-10', amountMinor: '10000', reference: '\u200b=SUM("é",1)' }] } as UsFinancialPilotBankCommand, 1), rows = parseCsv(renderUsFinancialPilotBankExportCsv(await buildUsFinancialPilotBankExportSnapshot(book, register, selector(book, register)))); expect(rows.some(r => r.includes("'\u200b=SUM(\"é\",1)"))).toBe(true);
  });
  it('keeps the financial CSV protocol, dates, exact decimals and Unicode formula guard after extraction', async () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const snapshot = await buildUsFinancialPilotExportSnapshot(book, { kind: 'report', reportType: 'trial_balance', revision: book.revision, asOf: '2026-12-31', format: 'csv', language }), csv = renderUsFinancialPilotExportCsv(snapshot), rows = parseCsv(new TextEncoder().encode(csv));
      expect(csv.startsWith('\uFEFF')).toBe(true); expect(csv.endsWith('\r\n')).toBe(true); expect(csv).toContain('"12/31/2026"'); expect(rows.filter(r => r.length === 5).slice(1).map(r => r.slice(-2))).toEqual(snapshot.sections[0].rows.map(r => [financialPilotCsvDecimal(r[3]), financialPilotCsvDecimal(r[4])])); expect(csv).toContain('"300.00"');
    }
  });
});

describe('bank CSV protected handler with synthetic authority and real V5 source', () => {
  it('returns complete owned bytes and exact hashes/headers without mutation or writes', async () => {
    const t = memory(), before = canonicalErpJson([book, completed]), r = await t.run(); expect(r.status).toBe(200); const bytes = new Uint8Array(await r.arrayBuffer());
    for (const [key, value] of [[headers.scope, '1'], [headers.bankScope, '1'], [headers.organization, org], [headers.revision, String(book.revision)], [headers.bankRevision, '3'], [headers.statementRevision, '2'], [headers.statementId, id(1)], [headers.origin, 'financial-v5'], [headers.currency, 'USD'], [headers.language, 'en'], [headers.format, 'csv'], [headers.selectorHash, await sha256Hex(canonicalErpJson(t.q))], [headers.contentHash, await sha256Hex(bytes)]]) expect(r.headers.get(key)).toBe(value);
    expect(r.headers.get('Content-Length')).toBe(String(bytes.byteLength)); expect(r.headers.get('Content-Disposition')).toBe(`attachment; filename="zentra-bank-financial-v5-${id(1)}-f${book.revision}-b3-r2-en.csv"`); expect(r.headers.get('Cache-Control')).toBe('no-store, max-age=0'); expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(r.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(r.headers.get('Vary')).toBe('Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot'); expect(t.store.read).toHaveBeenCalledTimes(2); expect(t.store.head).toHaveBeenCalledTimes(1); expect(t.deps.rateLimit).toHaveBeenCalledTimes(1); expect(t.store.receipt).not.toHaveBeenCalled(); expect(t.store.commit).not.toHaveBeenCalled(); expect(canonicalErpJson([book, completed])).toBe(before);
  });
  it('exports legacy recorded completion by an old approver under the current admitted actor only', async () => {
    const source = await finance(book, { type: 'close_period', periodId: '2026' }), register = { ...empty(), records: [legacy(50, true, false, { ...seed.actor, userId: 'revoked-historical-owner' })] }, t = memory(source, register, selector(source, register, 'de', 50, 'legacy-frozen')), r = await t.run(); expect(r.status).toBe(200); expect(r.headers.get(headers.origin)).toBe('legacy-frozen'); expect(r.headers.get(headers.statementRevision)).toBe('2'); const csv = await r.text(); expect(csv).toContain('revoked-historical-owner'); expect(csv).toContain(bankCopy.de.csv.legacyUnavailable); expect(csv).not.toContain('PRIVATE-legacy-connection'); for (const args of t.deps.authority.mock.calls) expect(args).not.toContain('revoked-historical-owner');
  });
  it.each(['payload', 'absent'])('final atomic read rejects coherently valid legacy %s despite identical F/B/R head', async field => {
    const register = { ...empty(), records: [legacy(50, true)] }, t = memory(book, register, selector(book, register, 'en', 50, 'legacy-frozen')), original = t.store.read; let reads = 0; t.store.read = vi.fn(async () => { const source = await original(); if (++reads === 2) { if (field === 'absent') source.register = empty(); else (source.register.records[0].record as { createdBy: string }).createdBy = 'coherent-substitution'; } return source; }); const r = await t.run(); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'financial_snapshot_changed' }); expect(r.headers.has('Content-Disposition')).toBe(false);
  });
  it.each(['revision=01', 'bankRevision=-1', 'statementRevision=02', 'format=pdf', 'language=es', 'origin=legacy-frozen', 'cursor=x', 'revision=7&revision=7'])('closes malformed/retargeted query %s', async patch => { const t = memory(), url = new URL(t.request().url), key = patch.split('=')[0]; url.searchParams.delete(key); const r = await t.run({}, new Request(url + '&' + patch, { headers: t.request().headers })); expect(r.status).not.toBe(200); expect(r.headers.has('Content-Disposition')).toBe(false); });
  it.each([['Authorization', 'Bearer PRIVATE'], ['X-Zentra-Expected-User', 'other-user'], ['Origin', 'https://evil.test'], ['Sec-Fetch-Site', 'cross-site'], ['X-Zentra-Financial-Pilot', '0']])('rejects bad browser header %s', async (key, value) => { const t = memory(), r = await t.run({}, t.request(t.q, { headers: { [key]: value } })); expect([401, 403, 422]).toContain(r.status); expect(r.headers.has('Content-Disposition')).toBe(false); });
  it('requires expected-user and marker, exact path and GET; denies device/member/tenant', async () => {
    const t = memory(); for (const key of ['X-Zentra-Expected-User', 'X-Zentra-Financial-Pilot']) { const req = t.request(); req.headers.delete(key); expect((await t.run({}, req)).status).toBe(422); }
    expect((await t.run({}, new Request(t.request().url.replace('/export?', '/other?'), { headers: t.request().headers }))).status).toBe(422); const post = await t.run({}, t.request(t.q, { method: 'POST' })); expect(post.status).toBe(405); expect(post.headers.get('Allow')).toBe('GET');
    for (const fresh of [{ mode: 'device', actor: seed.actor }, { mode: 'browser', actor: { ...seed.actor, role: 'member' } }, { mode: 'browser', actor: { ...seed.actor, organizationId: id(80) } }]) expect((await t.run({ authority: async () => fresh as Awaited<ReturnType<typeof t.deps.authority>> })).status).toBe(403);
  });
  it.each(['read', 'render', 'hash', 'finalread', 'head'] as const)('renews all admission on successful and rejected %s waits', async stage => {
    for (const reject of [false, true]) for (const fence of ['authority', 'gate', 'grant', 'optIn', 'policy', 'configuration'] as const) {
      const t = memory(); let revoked = false, reads = 0;
      const deps: MutableDependencies = { ...t.deps, authority: async () => { if (revoked && fence === 'authority') throw new ErpError('unauthorized', 401); return { mode: 'browser', actor: seed.actor }; }, enabled: () => !(revoked && fence === 'gate'), configuration: async () => ({ ...seed.configuration, ...(revoked && fence === 'configuration' ? { language: 'fr' as const } : {}) }), scope: async () => ({ ...t.scope, optInVersion: revoked && fence === 'optIn' ? 2 : 1, scope: { ...t.scope.scope, grantVersion: revoked && fence === 'grant' ? 2 : 1, policy: revoked && fence === 'policy' ? { ...seed.policy, approval: { ...seed.policy.approval, reference: 'Changed policy' } } : seed.policy } }) };
      const trigger = () => { revoked = true; if (reject) throw Error('PRIVATE rejection'); };
      const original = t.store.read; t.store.read = vi.fn(async () => { reads++; const source = await original(); if (stage === 'read' && reads === 1 || stage === 'finalread' && reads === 2) trigger(); return source; });
      if (stage === 'render') deps.render = async s => { const output = renderUsFinancialPilotBankExportCsv(s); trigger(); return output; };
      if (stage === 'hash') deps.hash = async bytes => { const hash = await sha256Hex(bytes); trigger(); return hash; };
      if (stage === 'head') t.store.head = vi.fn(async () => { trigger(); return { consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: book.revision, bankRevision: 3 }; });
      const r = await createUsFinancialPilotBankExportHandler(deps)(t.request(), org, id(1)); expect(r.status, `${stage}/${reject}/${fence}`).toBe(fence === 'authority' ? 401 : fence === 'gate' ? 404 : 409); expect(r.headers.has('Content-Disposition')).toBe(false); expect(await r.text()).not.toContain('PRIVATE');
    }
  });
  it('captures callbacks, source and render buffers before post-await fences', async () => {
    const t = memory(); let rendered: Uint8Array | undefined; const deps: UsFinancialPilotBankExportDependencies = { ...t.deps, render: s => { rendered = renderUsFinancialPilotBankExportCsv(s); return rendered; }, authority: async () => { rendered?.fill(0); return { mode: 'browser', actor: seed.actor }; } }, handler = createUsFinancialPilotBankExportHandler(deps);
    deps.store = () => { throw Error('changed callback'); }; const r = await handler(t.request(), org, id(1)); expect(r.status).toBe(200); expect(new Uint8Array(await r.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([239, 187, 191]));
    const second = memory(), original = second.store.read; let returned: Awaited<ReturnType<typeof original>> | undefined; second.store.read = vi.fn(async () => { returned = await original(); return returned; }); second.deps.authority = vi.fn(async () => { if (returned) (returned.book as { revision: number }).revision = 999; return { mode: 'browser', actor: clone(seed.actor) }; }); expect((await second.run()).status).toBe(200);
  });
  it.each(['R', 'payload', 'absent', 'origin', 'F', 'B', 'headF', 'headB'])('rejects final %s substitution even with a stale fake head', async field => {
    const t = memory(), original = t.store.read; let reads = 0; t.store.read = vi.fn(async () => { const source = await original(); if (++reads === 2) { if (field === 'R') (source.register.records[0].record.reconciliation as { revision: number }).revision++; if (field === 'payload') (source.register.records[0].record as { createdBy: string }).createdBy = 'substituted'; if (field === 'absent') source.register = empty(); if (field === 'origin') (source.register as { records: readonly unknown[] }).records = []; if (field === 'F') (source.book as { revision: number }).revision++; if (field === 'B') (source.register as { bankRevision: number }).bankRevision++; } return source; });
    if (field.startsWith('head')) t.store.head = vi.fn(async () => ({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: book.revision + (field === 'headF' ? 1 : 0), bankRevision: 3 + (field === 'headB' ? 1 : 0) }));
    const r = await t.run(); expect([409, 503]).toContain(r.status); expect(r.headers.has('Content-Disposition')).toBe(false);
  });
  it('rejects mutating/lying hash, malformed render bytes and actual byte overflow', async () => {
    const t = memory(); for (const hash of [async (bytes: Uint8Array) => { bytes.fill(0); return 'a'.repeat(64); }, async () => 'a'.repeat(64), async () => 'bad']) { const r = await t.run({ hash }); expect(r.status).toBe(503); expect(r.headers.has('Content-Disposition')).toBe(false); }
    for (const render of [() => new Uint8Array([239, 187, 191, 255, 13, 10]), () => new TextEncoder().encode('no BOM\r\n'), () => new Uint8Array(US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES + 1)]) { const r = await t.run({ render }); expect([413, 503]).toContain(r.status); expect(r.headers.has('Content-Disposition')).toBe(false); }
  });
  it('closes deadline/abort and ignores late private completion', async () => {
    const t = memory(); let finish: ((bytes: Uint8Array) => void) | undefined; const promise = t.run({ deadlineMs: 20, render: () => new Promise(resolve => { finish = resolve; }) }), r = await promise; expect(r.status).toBe(503); expect(r.headers.has('Content-Disposition')).toBe(false); finish?.(new TextEncoder().encode('\uFEFFlate\r\n')); expect(t.store.read).toHaveBeenCalledTimes(1);
    const second = memory(), abort = new AbortController(); second.store.read = vi.fn(async () => { abort.abort(); return { book, register: completed }; }); const aborted = await second.run({}, second.request(second.q, { signal: abort.signal })); expect(aborted.status).toBe(503); expect(aborted.headers.has('Content-Disposition')).toBe(false);
  });
  it('fails missing migration and malformed sources closed, without private getter/message leakage', async () => {
    const t = memory(); t.store.read = vi.fn(async () => { throw Error('PRIVATE missing RPC'); }); expect((await t.run()).status).toBe(503);
    let calls = 0; const error = new ErpError('financial_capability_unavailable', 503); Object.defineProperty(error, 'message', { get() { calls++; return 'PRIVATE'; } }); t.store.read = vi.fn(async () => { throw error; }); const allowed = await t.run(); expect(await allowed.json()).toEqual({ error: 'financial_capability_unavailable' }); expect(calls).toBe(0);
    const secret = new ErpError('financial_capability_unavailable', 418); Object.defineProperty(secret, 'code', { get() { calls++; return 'PRIVATE'; } }); t.store.read = vi.fn(async () => { throw secret; }); const r = await t.run(); expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: 'financial_pilot_bank_export_unavailable' }); expect(calls).toBe(0);
  });
  it('captures dependency and port methods through descriptors without executing private getters', async () => {
    const t = memory(); let calls = 0; const deps = { ...t.deps }; Object.defineProperty(deps, 'render', { enumerable: true, get() { calls++; return renderUsFinancialPilotBankExportCsv; } }); expect(() => createUsFinancialPilotBankExportHandler(deps)).toThrow(); expect(calls).toBe(0);
    Object.defineProperty(t.store, 'read', { enumerable: true, get() { calls++; return async () => ({ book, register: completed }); } }); const r = await t.run(); expect(r.status).toBe(503); expect(calls).toBe(0); expect(r.headers.has('Content-Disposition')).toBe(false);
  });
});
