import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5, type UsFinancialRuntimeDependenciesV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialErpCommandV5 } from './us-financial-kernel-types';
import { appendUsFinancialPilotBankRegister, validateUsFinancialPilotBankHistory, type UsFinancialPilotBankCommand, type UsFinancialPilotBankRegister, type UsFinancialPilotBankRequest } from './us-financial-pilot-bank';
import { createUsFinancialPilotBankHandlers, type UsFinancialPilotBankDependencies as HttpBankDependencies } from './us-financial-pilot-bank-server';
import { createUsFinancialPilotBankExportHandler } from './us-financial-pilot-bank-export';
import { financialPilotBankCursor, projectUsFinancialPilotBankContext, projectUsFinancialPilotBankStatement, projectUsFinancialPilotBankMovements, type UsFinancialPilotBankDetailQuery } from './us-financial-pilot-bank-projection';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { createUsFinancialPilotAccountingHandlers } from './us-financial-pilot-accounting-server';
import { createBrowserUsFinancialPilotSession, type BrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import {
  BankInputError, buildBankImportReview, buildBankCommandReview, captureBankOperationRequest,
  validateUsFinancialPilotBankExportSelector, browserUsFinancialPilotBankExportUrl, US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS,
  US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES, US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES,
  type BankImportDraft, type BankReviewScope, type BankCommandEvidence, type BankInputErrorCode,
} from './browser-us-financial-pilot-bank-input';
import { browserUsFinancialPilotBankCopy, browserUsFinancialPilotBankErrorCopy } from './browser-us-financial-pilot-bank-copy';

const org = '0a7ec0b8-a465-4df9-b756-e99aca4439ce', origin = 'https://zentraapp.ch';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = <T>(value: T): T => structuredClone(value);
const imported: BankImportDraft = { text: 'date,amount,reference\r\n2026-10-10,100.00," Exact référence 🌍 "\r\n', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: '0', closing: '100.00' };
const command: UsFinancialPilotBankCommand = { type: 'create_statement', cashAccountId: 'cash', start: imported.start, end: imported.end, openingMinor: '0', closingMinor: '10000', lines: [{ date: '2026-10-10', amountMinor: '10000', reference: ' Exact référence 🌍 ' }] };
const payment = { type: 'customer_payment' as const, invoiceId: 'invoice-1', amountMinor: '1', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic session payment' };
const sessions: BrowserUsFinancialPilotSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function flush() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function inputReject(action: () => unknown, code: BankInputErrorCode) { expect(action).toThrow(BankInputError); try { action(); } catch (error) { expect(error).toMatchObject({ code }); } }

/** Real kernel, projections, sidecar transitions/proofs/history and handlers.
 * Auth/D1 and browser scheduling are synthetic; only transport boundaries are
 * delayed or damaged. No PostgreSQL, UI, provider or production is exercised. */
async function fixture(initialBook?: UsFinancialBookV5) {
  const original = await financialKernelFixture({ paid: '10000', tax: '0' }), data = JSON.parse(JSON.stringify(original).replaceAll(original.actor.organizationId, org)) as typeof original;
  const book = initialBook ?? await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), financial = await createInMemoryUsFinancialKernelStoreV5(book, data.policy, actor => actor);
  let register: UsFinancialPilotBankRegister = { schemaVersion: 1, organizationId: org, bankRevision: 0, records: [], operations: [] }, bankUnavailable = false, denied = 0;
  const readBook = async () => await financial.read(org) as UsFinancialBookV5;
  const store = {
    read: vi.fn(async () => { if (bankUnavailable) throw Error('Synthetic bank source unavailable'); return { book: await readBook(), register: clone(register) }; }),
    head: vi.fn(async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: (await readBook()).revision, bankRevision: register.bankRevision })),
    receipt: vi.fn(async (requestId: string) => clone(register.operations.find(p => p.request.requestId === requestId) ?? null)),
    commit: vi.fn(async (input: Parameters<import('./us-financial-pilot-bank').UsFinancialPilotBankPort['commit']>[0]) => {
      const prior = register.operations.find(p => p.request.requestId === input.request.requestId);
      if (prior) { if (canonicalErpJson(prior) !== canonicalErpJson(input.proof)) throw new ErpError('idempotency_conflict', 409); return clone(prior); }
      if (input.request.expectedRevision !== (await readBook()).revision || input.request.expectedBankRevision !== register.bankRevision) throw new ErpError('revision_conflict', 409);
      const next = appendUsFinancialPilotBankRegister(register, input.record, input.proof); await validateUsFinancialPilotBankHistory(await readBook(), next); register = next; return clone(input.proof);
    }),
  };
  const scope = { scope: { organizationId: org, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const shared = { enabled: () => true, authority: async () => { if (denied) throw new AccountPublicError('Synthetic denial', denied); return { mode: 'browser' as const, actor: data.actor }; }, configuration: async () => data.configuration, scope: async () => scope, rateLimit: async () => {}, diagnostic: () => {} };
  const financialDeps: UsFinancialPilotDependencies = { ...shared, store: () => ({ ...financial, head: async () => ({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: (await readBook()).revision }) }) };
  const bankDeps: HttpBankDependencies = { ...shared, store: () => store };
  const financeHandlers = createUsFinancialPilotHandlers(financialDeps), bankHandlers = createUsFinancialPilotBankHandlers(bankDeps), accountingHandlers = createUsFinancialPilotAccountingHandlers(financialDeps), exportHandler = createUsFinancialPilotBankExportHandler(bankDeps);
  const base = `/api/international/workspaces/${org}/financial-pilot`;
  async function dispatch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.slice(base.length);
    if (path === '/head') return financeHandlers.HEAD(req, org);
    if (path === '/snapshot') return financeHandlers.SNAPSHOT(req, org);
    if (path === '/operations') return financeHandlers.POST(req, org);
    if (path === '/accounting/operations') return accountingHandlers.POST(req, org);
    if (path === '/bank/head') return bankHandlers.HEAD(req, org);
    if (path === '/bank/context') return bankHandlers.CONTEXT(req, org);
    if (path === '/bank/statements') return bankHandlers.STATEMENTS(req, org);
    if (path === '/bank/operations') return bankHandlers.POST(req, org);
    const match = path.match(/^\/bank\/statements\/([^/]+)(?:\/(movements|export))?$/);
    if (match) return match[2] === 'export' ? exportHandler(req, org, match[1]) : match[2] === 'movements' ? bankHandlers.MOVEMENTS(req, org, match[1]) : bankHandlers.STATEMENT(req, org, match[1]);
    throw Error('Unexpected synthetic route: ' + path);
  }
  type Intercept = (request: Request, next: () => Promise<Response>) => Promise<Response>;
  let interceptor: Intercept | undefined, visible = true, online = true, wake = () => {}, sequence = 100;
  const requests: Pick<Request, 'url' | 'method' | 'text'>[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin');
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const req = new Request(new URL(address, origin), { ...init, headers }); requests.push(req.clone());
    return interceptor ? interceptor(req, () => dispatch(req)) : dispatch(req);
  }) as unknown as typeof fetch;
  const newId = vi.fn(() => id(++sequence));
  const session = createBrowserUsFinancialPilotSession({ organizationId: org, expectedUserId: data.actor.userId, fetch: fetcher, newId, environment: { isVisible: () => visible, isOnline: () => online, subscribe: listener => { wake = listener; return () => { wake = () => {}; }; } } }); sessions.push(session);
  let externalId = 1000;
  async function external(operation: UsFinancialPilotBankCommand) {
    const request: UsFinancialPilotBankRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: id(++externalId), expectedRevision: (await readBook()).revision, expectedBankRevision: register.bankRevision, expectedStatementRevision: operation.type === 'create_statement' ? null : register.records.find(r => r.record.reconciliation.statement.id === operation.statementId)!.record.reconciliation.revision, command: operation };
    const req = new Request(origin + base + '/bank/operations', { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': data.actor.userId, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    const response = await bankHandlers.POST(req, org); expect(await response.clone().text()).not.toContain('financial_service_unavailable'); expect(response.status).toBe(200); return await response.json() as import('./us-financial-pilot-bank').UsFinancialPilotBankReceipt;
  }
  const engine: UsFinancialRuntimeDependenciesV5 = { ...data, store: financial, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }), resolveTax: async () => { throw Error('No provider in browser test'); } };
  const finance = async (operation: UsFinancialErpCommandV5) => executeUsFinancialKernelV5(engine, { idempotencyKey: 'browser-finance-' + (await readBook()).revision, expectedRevision: (await readBook()).revision, command: { type: 'erp_command', request: operation } });
  const ready = async () => { await session.load(); await session.refreshBank(); return session.readBankContext(); };
  const query = (statementId: string): UsFinancialPilotBankDetailQuery => ({ revision: session.getState().bank.head!.revision, bankRevision: session.getState().bank.head!.bankRevision, statementId, origin: 'financial-v5' });
  return { ...data, book, readBook, register: () => clone(register), store, session, fetcher, newId, requests, external, finance, ready, query, intercept: (value?: Intercept) => { interceptor = value; }, unavailable: (value: boolean) => { bankUnavailable = value; }, deny: (value: number) => { denied = value; }, visibility: (value: boolean) => { visible = value; wake(); }, online: (value: boolean) => { online = value; wake(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function reviewScope(t: Fixture, R: number | null = null, requestId = id(5)): BankReviewScope { return { organizationId: org, requestId, head: { consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision: t.book.revision, bankRevision: t.register().bankRevision }, expected: { revision: t.book.revision, bankRevision: t.register().bankRevision, statementRevision: R } }; }
async function pureImport(t: Fixture, draft = imported) { return buildBankImportReview({ scope: reviewScope(t), context: await projectUsFinancialPilotBankContext(t.book, t.register(), { revision: t.book.revision, bankRevision: t.register().bankRevision }), draft }); }
async function pureCommand(t: Fixture, operation: Exclude<UsFinancialPilotBankCommand, { type: 'create_statement' }>, evidence?: BankCommandEvidence) {
  const q = { revision: t.book.revision, bankRevision: t.register().bankRevision, statementId: operation.statementId, origin: 'financial-v5' as const }, statement = await projectUsFinancialPilotBankStatement(t.book, t.register(), q), movements = await projectUsFinancialPilotBankMovements(t.book, t.register(), q);
  return { scope: reviewScope(t, statement.statement.statementRevision), context: await projectUsFinancialPilotBankContext(t.book, t.register(), { revision: q.revision, bankRevision: q.bankRevision }), command: operation, evidence: evidence ?? { statement: { query: q, value: statement }, linePages: [], movementPages: [{ query: q, value: movements }] } };
}
const manual = (n: number, amount = '1', date = '2026-10-10'): UsFinancialErpCommandV5 => ({ type: 'post_manual_journal', id: 'browser-manual-' + n, transactionDate: date, accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic actual cash ' + n, sourceReference: 'Synthetic manual source ' + n, cashFlowCategory: 'financing', lines: BigInt(amount) > 0 ? [{ accountId: 'cash', debitMinor: amount, creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: amount }] : [{ accountId: 'cash', debitMinor: '0', creditMinor: (-BigInt(amount)).toString() }, { accountId: 'equity', debitMinor: (-BigInt(amount)).toString(), creditMinor: '0' }] });
let multipageBook: UsFinancialBookV5;
beforeAll(async () => {
  const t = await fixture(); multipageBook = t.book;
  for (let n = 1; n <= 26; n++) { const operation = manual(n); multipageBook = (await applyUsFinancialOperationV5(multipageBook, { type: 'erp_command', idempotencyKey: 'multipage-' + n, command: operation, facts: { kind: 'none' } }, t.actor, usFinancialErpEntityIdV5(operation, org))).book; }
});
const manyDraft: BankImportDraft = { ...imported, text: 'date,amount,reference\n2026-10-10,100.00,payment\n' + Array.from({ length: 26 }, (_, n) => `2026-10-10,0.01,manual ${n + 1}\n`).join(''), closing: '100.26' };

describe('bank pure input — captured exact statements and page evidence', () => {
  it('keeps row order, exact Unicode/whitespace, signed USD totals and no original CSV in a frozen review', async () => {
    const t = await fixture(), draft = { ...imported, text: '\uFEFFdate,amount,reference\r\n2026-10-11,-2.50," second, "\r\n2026-10-10,2.50," first 🌍 "\r\n', closing: '0' };
    const review = await pureImport(t, draft); expect(review.request.command).toMatchObject({ lines: [{ date: '2026-10-11', amountMinor: '-250', reference: ' second, ' }, { date: '2026-10-10', amountMinor: '250', reference: ' first 🌍 ' }] });
    expect(review.importTotals).toEqual({ lineCount: 2, openingMinor: '0', statementNetMinor: '0', closingMinor: '0' }); expect(review.body).toBe(JSON.stringify(review.request)); expect(Object.isFrozen(review.request.command)).toBe(true); expect(Object.isFrozen(review)).toBe(true); draft.text = 'changed'; expect(JSON.stringify(review)).not.toContain('date,amount,reference'); expect(review.body).toContain(' first 🌍 ');
  });
  it.each(['Date,amount,reference\n2026-10-10,100.00,x', 'date,amount,reference\n10/10/2026,100.00,x', 'date,amount,reference\n2026-10-10,1e2,x', 'date,amount,reference\n2026-10-10,-0,x', 'date,amount,reference\n2026-10-10,100.001,x', 'date,amount,reference\n2026-10-10,100.00,"line\nbreak"'])('rejects strict CSV violation %s', async text => { const t = await fixture(), context = await t.ready(); inputReject(() => buildBankImportReview({ scope: reviewScope(t), context, draft: { ...imported, text } }), 'invalid_bank_statement'); });
  it('checks UTF8 bytes before parser, not JS length, and rejects malformed Unicode', async () => {
    const t = await fixture(), context = await t.ready(), text = '🌍'.repeat(131073); expect(text.length).toBeLessThan(US_FINANCIAL_PILOT_BANK_IMPORT_MAX_BYTES);
    inputReject(() => buildBankImportReview({ scope: reviewScope(t), context, draft: { ...imported, text } }), 'bank_csv_too_large'); inputReject(() => buildBankImportReview({ scope: reviewScope(t), context, draft: { ...imported, text: '\ud800' } }), 'invalid_bank_statement');
  });
  it('never reads wrapper/draft/array accessors and does not leak their exceptions', async () => {
    const t = await fixture(), context = await t.ready(); let getters = 0;
    const draft = { ...imported }; Object.defineProperty(draft, 'text', { enumerable: true, get() { getters++; throw Error('private'); } });
    inputReject(() => buildBankImportReview({ scope: reviewScope(t), context, draft }), 'bank_input_invalid'); expect(getters).toBe(0);
    const bad = { scope: reviewScope(t), context, draft: imported }; Object.defineProperty(bad, 'scope', { enumerable: true, get() { getters++; return reviewScope(t); } }); inputReject(() => buildBankImportReview(bad), 'bank_input_invalid'); expect(getters).toBe(0);
  });
  it('enforces exact heads, separate100 records/1000 operations and the legacy account blocker', async () => {
    const t = await fixture(), context = await t.ready(), scope = reviewScope(t);
    inputReject(() => buildBankImportReview({ scope: { ...scope, expected: { ...scope.expected, revision: scope.expected.revision + 1 } }, context, draft: imported }), 'bank_review_changed');
    inputReject(() => buildBankImportReview({ scope, context: { ...context, statementCount: 100 }, draft: imported }), 'bank_statement_limit_reached');
    inputReject(() => buildBankImportReview({ scope: { ...scope, head: { ...scope.head, bankRevision: 1000 }, expected: { ...scope.expected, bankRevision: 1000 } }, context, draft: imported }), 'bank_operation_limit_reached');
    inputReject(() => buildBankImportReview({ scope, context: { ...context, statementCount: 1, legacyPending: [{ statementId: id(90), cashAccountId: 'cash' }] }, draft: imported }), 'bank_legacy_pending');
  });
  it('captures an exact canonical request independently and refuses excess fields/body', async () => {
    const t = await fixture(), original = clone((await pureImport(t)).request), captured = captureBankOperationRequest(original); (original.command as unknown as { lines: { reference: string }[] }).lines[0].reference = 'changed'; expect(captured.request.command).toEqual(command); expect(captured.body).toBe(JSON.stringify(captured.request));
    inputReject(() => captureBankOperationRequest({ ...original, actor: 'private' }), 'bank_input_invalid');
    const lines = Array.from({ length: 1000 }, () => ({ date: '2026-10-10', amountMinor: '1', reference: '🌍'.repeat(256) })); inputReject(() => captureBankOperationRequest({ ...original, command: { ...command, lines, closingMinor: '1000' } }), 'bank_input_too_large');
  });
  it('includes selected rows off page and rejects missing page, forged cursor, duplicate pages/selectors and different metadata', async () => {
    const t = await fixture(multipageBook), created = await t.external({ ...command, lines: Array.from({ length: 27 }, (_, n) => ({ date: '2026-10-10', amountMinor: n ? '1' : '10000', reference: 'row' + n })), closingMinor: '10026' }), q = { revision: t.book.revision, bankRevision: 1, statementId: created.statementId, origin: 'financial-v5' as const };
    const first = await projectUsFinancialPilotBankStatement(t.book, t.register(), q), q2 = { ...q, lineCursor: first.lines.nextCursor }, second = await projectUsFinancialPilotBankStatement(t.book, t.register(), q2), move1 = await projectUsFinancialPilotBankMovements(t.book, t.register(), q), mq2 = { ...q, cursor: move1.nextCursor }, move2 = await projectUsFinancialPilotBankMovements(t.book, t.register(), mq2);
    const operation = { type: 'approve_match' as const, statementId: created.statementId, statementLineIds: [second.lines.items[1].lineId], journalRevisions: [move2.items[1].journalRevision] }, input = await pureCommand(t, operation, { statement: { query: q, value: first }, linePages: [{ query: q2, value: second }], movementPages: [{ query: mq2, value: move2 }] });
    expect(buildBankCommandReview(input).matchTotals).toEqual({ statementLineCount: 1, movementCount: 1, statementMinor: '1', movementMinor: '1', differenceMinor: '0' });
    inputReject(() => buildBankCommandReview({ ...input, evidence: { ...input.evidence, linePages: [] } }), 'bank_review_evidence_required');
    inputReject(() => buildBankCommandReview({ ...input, evidence: { ...input.evidence, linePages: [{ query: q, value: second }] } }), 'bank_review_changed');
    inputReject(() => buildBankCommandReview({ ...input, evidence: { ...input.evidence, linePages: [input.evidence.linePages[0], input.evidence.linePages[0]] } }), 'bank_review_changed');
    inputReject(() => buildBankCommandReview({ ...input, command: { ...operation, statementLineIds: [operation.statementLineIds[0], operation.statementLineIds[0]] } }), 'bank_selection_duplicate');
    inputReject(() => buildBankCommandReview({ ...input, evidence: { ...input.evidence, linePages: [{ query: q2, value: { ...second, current: { ...second.current!, endingDifferenceMinor: '9' } } }] } }), 'bank_review_changed');
  }, 20_000);
  it('requires complete/void facts and no superfluous page evidence', async () => {
    const t = await fixture(), created = await t.external(command), base = await pureCommand(t, { type: 'complete', statementId: created.statementId });
    inputReject(() => buildBankCommandReview({ ...base, evidence: { ...base.evidence, movementPages: [] } }), 'reconciliation_incomplete');
    const voided = buildBankCommandReview({ ...base, command: { type: 'void_statement', statementId: created.statementId, reason: ' Exact reason ' }, evidence: { ...base.evidence, movementPages: [] } }); expect(voided.request.command).toMatchObject({ reason: ' Exact reason ' });
    inputReject(() => buildBankCommandReview({ ...base, command: { type: 'void_statement', statementId: created.statementId, reason: 'x' } }), 'bank_input_invalid');
  });
  it('matches actual signed amounts above safe Number exactly, including a nonempty net-zero group', async () => {
    const seed = await fixture(), huge = '900719925474099312345'; let source = seed.book;
    for (const [n, amount] of [[51, huge], [52, '-' + huge]] as const) { const operation = manual(n, amount); source = (await applyUsFinancialOperationV5(source, { type: 'erp_command', idempotencyKey: 'large-' + n, command: operation, facts: { kind: 'none' } }, seed.actor, usFinancialErpEntityIdV5(operation, org))).book; }
    const t = await fixture(source), created = await t.external({ ...command, closingMinor: '0', lines: [{ date: '2026-10-10', amountMinor: huge, reference: 'Large positive' }, { date: '2026-10-10', amountMinor: '-' + huge, reference: 'Large negative' }] }), query = { revision: source.revision, bankRevision: 1, statementId: created.statementId, origin: 'financial-v5' as const }, movements = await projectUsFinancialPilotBankMovements(source, t.register(), query);
    const operation = { type: 'approve_match' as const, statementId: created.statementId, statementLineIds: [created.statementId + ':2', created.statementId + ':1'], journalRevisions: movements.items.filter(m => m.source.kind === 'manual_journal').map(m => m.journalRevision).reverse() }, input = await pureCommand(t, operation), review = buildBankCommandReview(input);
    expect(review.matchTotals).toEqual({ statementLineCount: 2, movementCount: 2, statementMinor: '0', movementMinor: '0', differenceMinor: '0' }); expect(review.request.command).toMatchObject({ statementLineIds: [created.statementId + ':1', created.statementId + ':2'], journalRevisions: [...operation.journalRevisions].sort((a, b) => a - b) });
    const positive = { ...operation, statementLineIds: [created.statementId + ':1'], journalRevisions: [Math.min(...operation.journalRevisions)] }; expect(buildBankCommandReview({ ...input, command: positive }).matchTotals?.movementMinor).toBe(huge);
    inputReject(() => buildBankCommandReview({ ...input, command: { ...positive, statementLineIds: [created.statementId + ':2'] } }), 'reconciliation_amount_mismatch');
  });
  it('rejects legacy mutation, excess evidence and page-array accessors without reading them', async () => {
    const t = await fixture(), created = await t.external(command), input = await pureCommand(t, { type: 'approve_match', statementId: created.statementId, statementLineIds: [created.statementId + ':1'], journalRevisions: [(await projectUsFinancialBookV5(t.book)).ledger.entries.find(e => e.paymentDate)!.revision] });
    const base = input.evidence.statement.value, legacy = { ...base, statement: { ...base.statement, origin: 'legacy-frozen' as const }, lines: { ...base.lines, origin: 'legacy-frozen' as const }, matches: { ...base.matches, origin: 'legacy-frozen' as const }, current: null };
    inputReject(() => buildBankCommandReview({ ...input, evidence: { ...input.evidence, statement: { query: { ...input.evidence.statement.query, origin: 'legacy-frozen' }, value: legacy } } }), 'bank_legacy_immutable');
    inputReject(() => buildBankCommandReview({ ...input, evidence: { ...input.evidence, linePages: Array.from({ length: 40 }, () => input.evidence.statement) } }), 'bank_input_too_large');
    let getters = 0; const pages = [input.evidence.statement]; Object.defineProperty(pages, '0', { enumerable: true, get() { getters++; return input.evidence.statement; } }); inputReject(() => buildBankCommandReview({ ...input, evidence: { ...input.evidence, linePages: pages } }), 'bank_input_invalid'); expect(getters).toBe(0);
  });
  it('captures40 public pages separately but applies the strict UTF8 budget to the selected compact facts', async () => {
    const t = await fixture(), created = await t.external(command), baseInput = await pureCommand(t, { type: 'approve_match', statementId: created.statementId, statementLineIds: [created.statementId + ':1'], journalRevisions: [1] }), base = baseInput.evidence.statement.value, baseMovement = baseInput.evidence.movementPages[0].value;
    // Boundary-only DTO amplification from real projected shapes. Monetary
    // workflow truth is covered above; these deliberately large public pages
    // exercise capture budgets without1000 actual financial writes.
    const head = { consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: 1001, bankRevision: 1, ledgerRevision: 1000 }, q = { revision: 1001, bankRevision: 1, statementId: created.statementId, origin: 'financial-v5' as const }, cursor = (kind: 'bank_lines' | 'bank_movements', offset: number) => offset ? financialPilotBankCursor(kind, org, 1001, 1, offset, 'financial-v5', created.statementId) : null;
    const pages = Array.from({ length: 40 }, (_, page) => {
      const offset = page * 25, items = Array.from({ length: 25 }, (_, n) => ({ ordinal: offset + n + 1, lineId: created.statementId + ':' + (offset + n + 1), date: '2026-10-10', amountMinor: '1', reference: 'Boundary line', matchId: null }));
      return { query: { ...q, lineCursor: cursor('bank_lines', offset) }, value: { ...base, ...head, statement: { ...base.statement, lineCount: 1000, closingMinor: '1000' }, lines: { ...base.lines, ...head, total: 1000, items, nextCursor: offset + 25 < 1000 ? cursor('bank_lines', offset + 25) : null }, matches: { ...base.matches, ...head }, current: { outstandingLineCount: 1000, unmatchedMovementCount: 1000, beginningDifferenceMinor: '0', endingDifferenceMinor: '0', ready: false } } };
    });
    const movements = Array.from({ length: 40 }, (_, page) => {
      const offset = page * 25, items = Array.from({ length: 25 }, (_, n) => ({ journalRevision: offset + n + 1, transactionDate: '2026-10-10', accountingDate: '2026-10-10', paymentDate: null, bankDate: '2026-10-10', amountMinor: '1', description: '界'.repeat(700), source: { kind: 'other' as const, entityId: null, reference: null, journalRevision: null }, status: 'available' as const }));
      return { query: { ...q, cursor: cursor('bank_movements', offset) }, value: { ...baseMovement, ...head, total: 1000, items, nextCursor: offset + 25 < 1000 ? cursor('bank_movements', offset + 25) : null } };
    });
    const input = { ...baseInput, scope: { ...baseInput.scope, head: { ...baseInput.scope.head, revision: 1001 }, expected: { ...baseInput.scope.expected, revision: 1001 } }, context: { ...baseInput.context, revision: 1001, ledgerRevision: 1000 }, evidence: { statement: pages[0], linePages: pages.slice(1), movementPages: movements } };
    expect(buildBankCommandReview(input).matchTotals?.movementMinor).toBe('1');
    inputReject(() => buildBankCommandReview({ ...input, command: { ...input.command, type: 'approve_match', statementLineIds: pages.flatMap(p => p.value.lines.items.map(l => l.lineId)), journalRevisions: movements.flatMap(p => p.value.items.map(m => m.journalRevision)) } }), 'bank_input_too_large');
  }, 20_000);
  it('keeps selector tenant/F/B/R/origin/language closed, frozen and encoded without data', async () => {
    const t = await fixture(), selector = { consumer: 'financial-pilot' as const, schemaVersion: 1 as const, kind: 'bank_reconciliation' as const, organizationId: org, revision: t.book.revision, bankRevision: 0, statementRevision: 0, statementId: id(1), origin: 'legacy-frozen' as const, format: 'csv' as const, language: 'de' as const }, result = validateUsFinancialPilotBankExportSelector(selector, org);
    expect(Object.isFrozen(result)).toBe(true); expect(browserUsFinancialPilotBankExportUrl(result)).toBe(`/api/international/workspaces/${org}/financial-pilot/bank/statements/${id(1)}/export?revision=${t.book.revision}&bankRevision=0&statementRevision=0&origin=legacy-frozen&format=csv&language=de`);
    for (const bad of [{ ...selector, organizationId: 'wrong' }, { ...selector, origin: undefined }, { ...selector, cursor: 'x' }, { ...selector, format: 'pdf' }, { ...selector, revision: '1' }, { ...selector, language: 'FR' }, { ...selector, bankRevision: 1001 }]) inputReject(() => validateUsFinancialPilotBankExportSelector(bad), 'invalid_financial_pilot_bank_export_selector');
    expect(US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS.selectorHash).toBe('X-Zentra-Export-Selector-SHA256'); expect(US_FINANCIAL_PILOT_BANK_EXPORT_MAX_BYTES).toBe(12 * 1024 * 1024);
  });
  it('has complete independently translated frozen groups and explicit RAM-loss text in four languages', () => {
    const english = browserUsFinancialPilotBankCopy.en;
    for (const language of ['fr', 'de', 'it', 'en'] as const) { const copy = browserUsFinancialPilotBankCopy[language]; for (const key of Object.keys(english) as (keyof typeof english)[]) { expect(Object.keys(copy[key]).sort()).toEqual(Object.keys(english[key]).sort()); expect(Object.values(copy[key]).every(v => typeof v === 'string' && v.length > 0)).toBe(true); expect(Object.isFrozen(copy[key])).toBe(true); } expect(copy.notices.reloadRamLoss.length).toBeGreaterThan(100); expect(browserUsFinancialPilotBankErrorCopy(language, 'private provider secret')).toBe(copy.errors.unavailable); expect(browserUsFinancialPilotBankErrorCopy(language, '__proto__')).toBe(copy.errors.unavailable); if (language !== 'en') expect(copy.notices.reloadRamLoss).not.toBe(english.notices.reloadRamLoss); }
  });
});

describe('bank browser — real cumulative V5 and shared session', () => {
  it('imports, matches and completes without changing finance, then keeps historical completion after real later finance', async () => {
    const t = await fixture(); await t.ready(); const snapshot = t.session.getState().snapshot, before = canonicalErpJson(await t.readBook()), first = t.session.reviewBankImport(imported);
    await expect(t.session.submitBank(first, false)).rejects.toMatchObject({ code: 'bank_review_changed' }); expect(t.register().bankRevision).toBe(0);
    const created = await t.session.submitBank(first, true); await flush(); expect(t.session.getState().snapshot).toBe(snapshot); expect(t.requests.filter(r => new URL(r.url).pathname.endsWith('/snapshot'))).toHaveLength(1); expect(t.session.getState().requiresRefresh).toBe(false);
    await t.session.readBankContext(); let detail = await t.session.readBankStatement(t.query(created.statementId)); const movements = await t.session.readBankMovements(t.query(created.statementId));
    const match = t.session.reviewBank({ type: 'approve_match', statementId: created.statementId, statementLineIds: [detail.lines.items[0].lineId], journalRevisions: [movements.items[0].journalRevision] }, { statement: detail, linePages: [], movementPages: [movements] }); expect(match.matchTotals?.statementMinor).toBe('10000'); await t.session.submitBank(match, true); await flush();
    await t.session.readBankContext(); detail = await t.session.readBankStatement(t.query(created.statementId)); expect(detail.current?.ready).toBe(true); const complete = t.session.reviewBank({ type: 'complete', statementId: created.statementId }, { statement: detail, linePages: [], movementPages: [] }); await t.session.submitBank(complete, true); await flush();
    expect(canonicalErpJson(await t.readBook())).toBe(before); expect(t.register().bankRevision).toBe(3); const proof = canonicalErpJson(t.register().operations[2]), recorded = (await t.session.readBankStatement(t.query(created.statementId))).statement.completion;
    await t.finance({ type: 'close_period', periodId: '2026' }); await t.session.refreshBank(); detail = await t.session.readBankStatement(t.query(created.statementId)); expect(detail.statement.completion).toEqual(recorded); expect(detail.current).toMatchObject({ endingDifferenceMinor: '0', ready: true }); expect(detail.cashChangedSinceCompletion).toBe(false); expect(canonicalErpJson(t.register().operations[2])).toBe(proof); expect(detail.ledgerRevision).toBe(recorded!.ledgerRevision + 1);
  });
  it.each(['lost', 'revision_conflict', 'invalid_financial_pilot_request', 'bad-success'] as const)('keeps the exact common pending after durable write with %s and recovers historical receipt without source read', async failure => {
    const t = await fixture(); await t.ready(); const review = t.session.reviewBankImport(imported); let first = true;
    t.intercept(async (req, next) => { const response = await next(); if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/bank/operations') && first) { first = false; expect(response.status).toBe(200); if (failure === 'lost') throw Error('Synthetic lost browser response'); if (failure === 'bad-success') return Response.json({ ...await response.json() as Record<string, unknown>, requestId: id(999) }); return Response.json({ error: failure }, { status: failure === 'revision_conflict' ? 409 : 422 }); } return response; });
    await expect(t.session.submitBank(review, true)).rejects.toMatchObject({ outcome: 'uncertain' }); expect(t.register().bankRevision).toBe(1); expect(t.session.getState()).toMatchObject({ pending: true, pendingKind: 'bank' });
    for (const action of [() => t.session.recordPayment(payment), () => t.session.commercial({} as never), () => t.session.purchasing({} as never), () => t.session.accounting({} as never), () => t.session.prepareInvoice({} as never, {} as never), () => t.session.issueInvoice(), () => t.session.exportBank({} as never, 'en'), () => t.session.retry()]) await expect(Promise.resolve().then<unknown>(() => action())).rejects.toMatchObject({ code: 'pending_operation' });
    await t.external({ type: 'void_statement', statementId: review.request.requestId, reason: 'Synthetic later statement action' }); await t.finance({ type: 'close_period', periodId: '2026' }); await t.session.refreshBank(); const currentHead = t.session.getState().bank.head!; expect(currentHead.bankRevision).toBe(2); expect(currentHead.revision).toBeGreaterThan(review.request.expectedRevision);
    t.unavailable(true); const readCalls = t.store.read.mock.calls.length; const receipt = await t.session.retryBank(); await flush(); expect(t.store.read.mock.calls).toHaveLength(readCalls); expect(receipt).toMatchObject({ revision: review.request.expectedRevision, bankRevision: 1, statementRevision: 0 }); expect(t.register().bankRevision).toBe(2); expect(t.session.hasPending()).toBe(false); expect(t.session.getState().bank.lastReceipt).toEqual(receipt); expect(t.session.getState().snapshot!.revision).toBe(currentHead.revision); expect(t.session.getState().bank.head).toEqual(currentHead);
    const posts = t.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/bank/operations')); expect(posts).toHaveLength(2); expect(await posts[0].text()).toBe(review.body); expect(await posts[1].text()).toBe(review.body); expect(t.newId).toHaveBeenCalledOnce();
  });
  it('does not recreate pending when a corroborated receipt is followed by HEAD503', async () => {
    const t = await fixture(); await t.ready(); const review = t.session.reviewBankImport(imported); t.intercept(async (req, next) => new URL(req.url).pathname.endsWith('/bank/head') ? Response.json({ error: 'financial_service_unavailable' }, { status: 503 }) : next());
    const receipt = await t.session.submitBank(review, true); await flush(); expect(t.session.hasPending()).toBe(false); expect(t.session.getState().bank).toMatchObject({ lastReceipt: receipt, requiresRefresh: true }); expect(t.session.getState().bank.error).not.toBeNull(); await expect(t.session.retryBank()).rejects.toMatchObject({ code: 'no_pending_operation' });
  });
  it('keeps a real CAS conflict without receipt locked until an explicit lifecycle reload and history read', async () => {
    const t = await fixture(); await t.ready(); const review = t.session.reviewBankImport(imported), external = await t.external(command);
    await expect(t.session.submitBank(review, true)).rejects.toMatchObject({ outcome: 'uncertain' }); await t.session.refreshBank(); await expect(t.session.retryBank()).rejects.toMatchObject({ outcome: 'uncertain' }); expect(t.session.hasPending()).toBe(true); expect(t.register().operations.some(p => p.request.requestId === review.request.requestId)).toBe(false);
    const posts = t.requests.filter(r => r.method === 'POST'); expect(posts).toHaveLength(2); expect(await posts[0].text()).toBe(await posts[1].text()); t.session.stop(); expect(t.session.hasPending()).toBe(false); t.session.start(); await t.session.load(); await t.session.refreshBank(); expect((await t.session.readBankStatements()).items.map(s => s.statementId)).toEqual([external.statementId]); expect(t.register().bankRevision).toBe(1);
  });
  it('rejects subscriber retry reentry while starting one bank write', async () => {
    const t = await fixture(); await t.ready(); const review = t.session.reviewBankImport(imported), reentry: Promise<unknown>[] = []; let attempted = false;
    const unsubscribe = t.session.subscribe(() => { if (!attempted && t.session.getState().writing && t.session.getState().pendingKind === 'bank') { attempted = true; reentry.push(t.session.retryBank().catch(error => error)); } }); await t.session.submitBank(review, true); unsubscribe(); await flush(); expect(await reentry[0]).toMatchObject({ code: 'pending_operation' }); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(1); expect(t.register().bankRevision).toBe(1);
  });
  it('publishes stop atomically against subscriber writes and restart, with no hidden pending', async () => {
    const t = await fixture(); await t.ready(); let attempted = false; const errors: unknown[] = [];
    const unsubscribe = t.session.subscribe(() => { if (attempted || t.session.getState().bank.head !== null) return; attempted = true; try { const request = t.session.recordPayment(payment); void request.catch(error => { errors.push(error); }); } catch (error) { errors.push(error); } try { t.session.start(); } catch (error) { errors.push(error); } }); t.session.stop(); unsubscribe(); await flush(); expect(attempted).toBe(true); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0); expect(t.session.hasPending()).toBe(false); expect(t.session.getState().status).toBe('stopped'); expect(errors.length).toBeGreaterThan(0); t.session.start(); await t.session.load(); expect(t.session.hasPending()).toBe(false);
  });
  it('does not readopt a B-only head after a subscriber stops during bank invalidation', async () => {
    const t = await fixture(); await t.ready(); const snapshot = t.session.getState().snapshot, snapshots = t.requests.filter(r => new URL(r.url).pathname.endsWith('/snapshot')).length;
    await t.external(command); expect(t.session.getState().bank.head?.bankRevision).toBe(0); expect(t.register().bankRevision).toBe(1); let attempted = false, snapshotAtStop: unknown;
    const unsubscribe = t.session.subscribe(() => {
      const state = t.session.getState();
      if (attempted || !state.bank.refreshing || state.bank.head !== null) return;
      attempted = true; snapshotAtStop = state.snapshot; t.session.stop();
    });
    const result = await t.session.refreshBank().catch(error => error); unsubscribe(); await flush();
    expect(attempted).toBe(true); expect(snapshotAtStop).toBe(snapshot); expect(result).toMatchObject({ code: 'session_disposed' }); expect(t.session.getState()).toMatchObject({ status: 'stopped', snapshot: null, pending: false, writing: false, bank: { head: null, pendingReview: null, lastReceipt: null } }); expect(t.session.hasPending()).toBe(false);
    expect(t.requests.filter(r => new URL(r.url).pathname.endsWith('/snapshot'))).toHaveLength(snapshots); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it('does not readopt a loaded snapshot after a subscriber stops during financial observation', async () => {
    const t = await fixture(); await t.ready(); const snapshot = t.session.getState().snapshot!; expect(t.session.getState().requiresRefresh).toBe(false);
    await t.finance({ type: 'close_period', periodId: '2026' }); expect((await t.readBook()).revision).toBeGreaterThan(snapshot.revision); let attempted = false;
    const unsubscribe = t.session.subscribe(() => {
      const state = t.session.getState();
      if (attempted || !state.requiresRefresh || state.snapshot !== snapshot) return;
      attempted = true; t.session.stop();
    });
    const result = await t.session.load().catch(error => error); unsubscribe(); await flush();
    expect(attempted).toBe(true); expect(result).toMatchObject({ code: 'session_disposed' }); expect(t.session.getState()).toMatchObject({ status: 'stopped', snapshot: null, pending: false, writing: false, bank: { head: null, pendingReview: null, lastReceipt: null } }); expect(t.session.hasPending()).toBe(false); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it('does not reactivate bank after a subscriber stops during activation invalidation', async () => {
    const t = await fixture(); await t.ready(); let attempted = false; const requests = t.requests.length;
    const unsubscribe = t.session.subscribe(() => { if (attempted || t.session.getState().bank.head !== null) return; attempted = true; t.session.stop(); });
    expect(() => t.session.setBankActive(true)).toThrow('session_disposed'); unsubscribe(); await flush();
    expect(attempted).toBe(true); expect(t.session.getState()).toMatchObject({ status: 'stopped', snapshot: null, pending: false, bank: { active: false, head: null } }); expect(t.session.hasPending()).toBe(false); expect(t.requests).toHaveLength(requests);
  });
  it('allows same-F financial fallback after bank success without reloading finance or clearing bank debt', async () => {
    const t = await fixture(); await t.ready(); vi.useFakeTimers(); t.session.start(); await vi.advanceTimersByTimeAsync(0); t.session.setBankActive(true); await vi.advanceTimersByTimeAsync(0); await t.session.refreshBank(); await t.session.readBankContext(); const snapshot = t.session.getState().snapshot, snapshotCount = t.requests.filter(r => new URL(r.url).pathname.endsWith('/snapshot')).length;
    t.intercept(async (req, next) => new URL(req.url).pathname.endsWith('/bank/head') ? Response.json({ error: 'financial_service_unavailable' }, { status: 503 }) : next()); await t.session.submitBank(t.session.reviewBankImport(imported), true); await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(3000);
    expect(t.session.getState().snapshot).toBe(snapshot); expect(t.requests.filter(r => new URL(r.url).pathname.endsWith('/snapshot'))).toHaveLength(snapshotCount); expect(t.session.getState().requiresRefresh).toBe(false); expect(t.session.getState().bank.requiresRefresh).toBe(true); expect(t.session.getState().bank.error).not.toBeNull(); t.intercept(); await t.session.recordPayment(payment); expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(2);
  });
  it('requires session-owned pages/reviews and invalidates them after B-only change while preserving the financial snapshot', async () => {
    const t = await fixture(); await t.ready(); const review = t.session.reviewBankImport(imported); await expect(t.session.submitBank(clone(review), true)).rejects.toMatchObject({ code: 'bank_review_changed' });
    const created = await t.external(command), snapshot = t.session.getState().snapshot; await t.session.refreshBank(); await expect(t.session.submitBank(review, true)).rejects.toMatchObject({ code: 'bank_review_changed' }); expect(t.session.getState().snapshot).toBe(snapshot);
    await t.session.readBankContext(); const detail = await t.session.readBankStatement(t.query(created.statementId)), movements = await t.session.readBankMovements(t.query(created.statementId)), operation = { type: 'approve_match' as const, statementId: created.statementId, statementLineIds: [detail.lines.items[0].lineId], journalRevisions: [movements.items[0].journalRevision] };
    expect(() => t.session.reviewBank(operation, { statement: clone(detail), linePages: [], movementPages: [movements] })).toThrow('bank_review_evidence_required');
    const approved = t.session.reviewBank(operation, { statement: detail, linePages: [], movementPages: [movements] }); await t.session.accounting({ type: 'open_period', start: '2027-01-01', end: '2027-12-31' }); await flush(); await expect(t.session.submitBank(approved, true)).rejects.toMatchObject({ code: 'bank_review_changed' }); expect(t.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/bank/operations'))).toHaveLength(0);
  });
  it.each(['/head', '/bank/head'])('discards %s begun before a write but returned after its completion', async path => {
    const t = await fixture(); await t.ready(); const review = t.session.reviewBankImport(imported), arrived = deferred<void>(), release = deferred<void>(); let held = true;
    t.intercept(async (req, next) => { const response = await next(); if (held && new URL(req.url).pathname.endsWith(path) && (path !== '/head' || !new URL(req.url).pathname.endsWith('/bank/head'))) { held = false; arrived.resolve(); await release.promise; } return response; });
    const old = (path === '/head' ? t.session.refresh() : t.session.refreshBank()).catch(error => error); await arrived.promise; await t.session.submitBank(review, true); release.resolve(); expect(await old).toMatchObject({ code: 'stale_read' }); await flush(); expect(t.session.getState().bank.head?.bankRevision).toBe(1);
  });
  it('rejects an old composite pair after a financial F advance and never manufactures max(F),max(B)', async () => {
    const t = await fixture(); await t.ready(); const old = { ...t.session.getState().bank.head!, bankRevision: 9 }; await t.finance({ type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }); await t.session.refresh();
    t.intercept(async (req, next) => new URL(req.url).pathname.endsWith('/bank/head') ? Response.json(old) : next()); await expect(t.session.refreshBank()).rejects.toMatchObject({ code: 'stale_read' }); expect(t.session.getState().bank.head).toBeNull(); expect(t.session.getState().snapshot!.revision).toBeGreaterThan(old.revision);
    t.intercept(); await t.session.refreshBank(); expect(t.session.getState().bank.head).toMatchObject({ revision: (await t.readBook()).revision, bankRevision: 0 });
  });
  it('blocks every financial intent immediately when HEAD advances F but the new snapshot is deferred and fails', async () => {
    const t = await fixture(); await t.ready(); await t.finance({ type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }); const arrived = deferred<void>(), release = deferred<void>();
    t.intercept(async (req, next) => { if (new URL(req.url).pathname.endsWith('/snapshot')) { arrived.resolve(); await release.promise; return Response.json({ error: 'financial_service_unavailable' }, { status: 503 }); } return next(); }); const loading = t.session.refreshBank().catch(error => error); await arrived.promise;
    for (const action of [() => t.session.recordPayment(payment), () => t.session.commercial({} as never), () => t.session.purchasing({} as never), () => t.session.accounting({} as never), () => t.session.prepareInvoice({} as never, {} as never)]) await expect(Promise.resolve().then<unknown>(() => action())).rejects.toMatchObject({ code: 'read_required' }); expect(t.requests.some(r => r.method === 'POST')).toBe(false); release.resolve(); expect(await loading).toMatchObject({ status: 503 }); expect(t.session.getState().requiresRefresh).toBe(true);
  });
  it('uses the bank response byte limit and deadline for the stream, not the larger financial limit', async () => {
    const t = await fixture(); await t.ready(); t.intercept(async (req, next) => new URL(req.url).pathname.endsWith('/bank/statements') ? new Response(' '.repeat(2_621_441), { headers: { 'Content-Type': 'application/json' } }) : next()); await expect(t.session.readBankStatements()).rejects.toMatchObject({ code: 'invalid_response' });
    vi.useFakeTimers(); t.intercept(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'application/json' } })); const waiting = t.session.readBankStatements().catch(error => error); await vi.advanceTimersByTimeAsync(30_000); expect(await waiting).toMatchObject({ code: 'response_timeout' });
  });
  it('polls only one composite HEAD per relevant tick and preserves bank error after a single financial fallback', async () => {
    const t = await fixture(); await t.ready(); vi.useFakeTimers(); t.session.start(); await vi.advanceTimersByTimeAsync(0); t.session.setBankActive(true); await vi.advanceTimersByTimeAsync(0); await t.session.refreshBank(); t.requests.length = 0;
    await vi.advanceTimersByTimeAsync(3000); expect(t.requests.map(r => new URL(r.url).pathname.split('/financial-pilot')[1])).toEqual(['/bank/head']);
    t.requests.length = 0; t.intercept(async (req, next) => new URL(req.url).pathname.endsWith('/bank/head') ? Response.json({ error: 'financial_service_unavailable' }, { status: 503 }) : next()); await vi.advanceTimersByTimeAsync(3000); expect(t.requests.map(r => new URL(r.url).pathname.split('/financial-pilot')[1])).toEqual(['/bank/head', '/head']); expect(t.session.getState().bank.requiresRefresh).toBe(true); expect(t.session.getState().bank.error).not.toBeNull();
    t.visibility(false); t.requests.length = 0; await vi.advanceTimersByTimeAsync(9000); expect(t.requests).toHaveLength(0);
  });
  it.each([401, 402, 403])('purges on composite denial%s with no financial fallback or late restore', async status => {
    const t = await fixture(); await t.ready(); vi.useFakeTimers(); t.session.start(); await vi.advanceTimersByTimeAsync(0); t.session.setBankActive(true); await vi.advanceTimersByTimeAsync(0); await t.session.refreshBank(); t.requests.length = 0; t.deny(status); await vi.advanceTimersByTimeAsync(3000);
    expect(t.requests.map(r => new URL(r.url).pathname.split('/financial-pilot')[1])).toEqual(['/bank/head']); expect(t.session.getState()).toMatchObject({ status: 'denied', snapshot: null, pending: false, bank: { head: null, pendingReview: null, lastReceipt: null } });
  });
  it('exports every real line and movement beyond page25 and downloads only a current owned file with revoked URL', async () => {
    const t = await fixture(multipageBook); await t.ready(); const review = t.session.reviewBankImport(manyDraft), created = await t.session.submitBank(review, true); await flush(); const detail = await t.session.readBankStatement(t.query(created.statementId)); expect(detail.lines.items).toHaveLength(25);
    const file = await t.session.exportBank(detail, 'fr'), csv = await file.blob.text(); expect(csv).toContain('manual 26'); expect(csv).toContain('Synthetic actual cash 26'); expect(csv).toContain(browserUsFinancialPilotBankCopy.fr.csv.current); expect(file.bankRevision).toBe(1);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-owned'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}), click = vi.fn(); vi.stubGlobal('document', { createElement: () => ({ click, href: '', download: '', rel: '' }) });
    expect(() => t.session.downloadBank({ ...file })).toThrow('invalid_bank_export_response'); expect(create).not.toHaveBeenCalled(); t.session.downloadBank(file); expect(click).toHaveBeenCalledOnce(); t.session.stop(); expect(revoke).toHaveBeenCalledWith('blob:synthetic-owned'); expect(() => t.session.downloadBank(file)).toThrow();
  }, 20_000);
  it.each(['bankRevision', 'origin', 'contentHash', 'selectorHash'] as const)('rejects altered export %s before creating a download URL', async field => {
    const t = await fixture(); await t.ready(); const created = await t.session.submitBank(t.session.reviewBankImport(imported), true); await flush(); const detail = await t.session.readBankStatement(t.query(created.statementId));
    t.intercept(async (req, next) => { const response = await next(); if (new URL(req.url).pathname.endsWith('/export')) { const headers = new Headers(response.headers); headers.set(US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS[field], field === 'bankRevision' ? '999' : 'foreign'); return new Response(await response.arrayBuffer(), { headers }); } return response; });
    await expect(t.session.exportBank(detail, 'en')).rejects.toMatchObject({ code: 'invalid_bank_export_response' });
  });
  it('cancels and aborts a forged export response before obtaining its body reader', async () => {
    const t = await fixture(); await t.ready(); const created = await t.session.submitBank(t.session.reviewBankImport(imported), true); await flush(); const detail = await t.session.readBankStatement(t.query(created.statementId)), cancelled = vi.fn(); let signal: AbortSignal | undefined;
    t.intercept(async (req, next) => { const response = await next(); if (!new URL(req.url).pathname.endsWith('/export')) return response; signal = req.signal; const headers = new Headers(response.headers); headers.set(US_FINANCIAL_PILOT_BANK_EXPORT_HEADERS.organization, id(90)); return new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers }); });
    await expect(t.session.exportBank(detail, 'en')).rejects.toMatchObject({ code: 'invalid_bank_export_response' }); expect(cancelled).toHaveBeenCalledOnce(); expect(signal?.aborted).toBe(true);
  });
});
