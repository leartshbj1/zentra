import { describe, expect, it, vi } from 'vitest';
import { createBrowserBankSession, readBrowserBankResponse } from './browser-bank-session';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { createLedger, postJournal, type FinancialAuthority } from './accounting/ledger';
import { usStarterChart } from './countries/us/accounting';
import { parseUsBankStatementCsv } from './us-bank-csv';
import { applyUsBankCommand, validateUsBankRequest } from './us-bank-reconciliation';
import type { UsBankRecord, UsBankReceipt, UsBankRequest } from './us-bank-contract';
import { browserBankCopy, browserBankError } from './browser-bank-copy';

const organizationId = 'browser-bank-fictitious', userId = 'fictitious-accountant', id = '10000000-0000-4000-8000-000000000001', matchId = '10000000-0000-4000-8000-000000000002';
const actor: FinancialAuthority = { organizationId, userId, role: 'accountant', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
function fixture() {
  const initial = createLedger({ organizationId, currency: 'USD', basis: 'accrual', accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  const ledger = postJournal(initial, { id: 'funds', idempotencyKey: 'funds', organizationId, currency: 'USD', basis: 'accrual', transactionDate: '2026-09-30', accountingDate: '2026-10-02', paymentDate: '2026-10-01', periodId: '2026', description: 'Fictitious capital receipt', source: { type: 'manual_journal', id: 'CAPITAL-1' }, cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '10000', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '10000' }] }, actor, 0);
  const statement = parseUsBankStatementCsv({ text: 'date,amount,reference\n2026-10-01,100.00,Fictitious funds', id, organizationId, externalConnectionId: 'opaque-fictitious-source', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: '0.00', closing: '100.00' });
  return { ledger, statement };
}
function port() {
  const { ledger, statement } = fixture(); let records: UsBankRecord[] = [], lost = false, error: string | null = null, errorStatus = 503, erpRevision = 50, commits = 0;
  const receipts = new Map<string, UsBankReceipt>(), bodies: string[] = [], requests: RequestInit[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(url).toBe(`/api/international/workspaces/${organizationId}/bank-reconciliations`); requests.push(init!);
    if (init?.method === 'GET') return Response.json({ schemaVersion: 1, organizationId, erpRevision, ledgerRevision: ledger.revision, records });
    const body = typeof init?.body === 'string' ? init.body : ''; bodies.push(body); const request = validateUsBankRequest(JSON.parse(body), organizationId), hash = await sha256Hex(canonicalErpJson([organizationId, userId, request]));
    const prior = receipts.get(request.idempotencyKey); if (prior) return Response.json({ receipt: prior, replayed: true });
    if (error) return Response.json({ error }, { status: errorStatus });
    const record = applyUsBankCommand(records.find(r => r.reconciliation.statement.id === request.reconciliationId) ?? null, request, ledger, actor, records);
    records = [...records.filter(r => r.reconciliation.statement.id !== request.reconciliationId), record]; commits++;
    const receipt: UsBankReceipt = { schemaVersion: 1, organizationId, actorId: userId, commandHash: hash, idempotencyKey: request.idempotencyKey, reconciliationId: request.reconciliationId, action: request.command.type, revision: record.reconciliation.revision, erpRevision: request.expectedErpRevision }; receipts.set(request.idempotencyKey, receipt);
    if (lost) { lost = false; return Response.json({ error: 'configuration_changed' }, { status: 409 }); }
    return Response.json({ receipt, replayed: false });
  };
  let keys = 0; const session = createBrowserBankSession({ organizationId, expectedUserId: userId, role: 'accountant', supportedSchemaVersion: 4, fetch: fetcher, newId: () => `browser-key-${++keys}` });
  return { session, ledger, statement, bodies, requests, lose: () => { lost = true; }, reject: (code: string, status = 503) => { error = code; errorStatus = status; }, clear: () => { error = null; }, advance: () => { erpRevision++; }, commits: () => commits, records: () => records, keys: () => keys };
}
describe('browser protected bank transport', () => {
  it('uses exact cookie-bound cap4 headers and the distinct ERP revision through the real pure lifecycle', async () => {
    const p = port(), before = canonicalErpJson(p.ledger); await expect(p.session.submit({ type: 'create_statement', statement: p.statement }, id, 50, null)).rejects.toMatchObject({ code: 'read_required' });
    await p.session.load(); const receipt = await p.session.submit({ type: 'create_statement', statement: p.statement }, id, 50, null);
    expect(receipt).toMatchObject({ replayed: false, receipt: { revision: 0, erpRevision: 50, actorId: userId } });
    await expect(p.session.submit({ type: 'complete' }, id, 50, 0)).rejects.toMatchObject({ code: 'read_required' });
    await p.session.load(); await p.session.submit({ type: 'approve_match', id: matchId, statementLineIds: [`${id}:1`], ledgerEntryIds: ['funds'] }, id, 50, 0); await p.session.load(); await p.session.submit({ type: 'complete' }, id, 50, 1);
    expect(p.records()[0].reconciliation).toMatchObject({ revision: 2, completedLedgerRevision: 1, completedBy: userId }); expect(canonicalErpJson(p.ledger)).toBe(before);
    for (const init of p.requests) { expect(init).toMatchObject({ mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); expect(init.headers).toMatchObject({ 'X-Zentra-Expected-User': userId, 'X-Zentra-Erp-Schema-Version': '4' }); expect(init.headers).not.toHaveProperty('Authorization'); }
    expect(p.commits()).toBe(3); p.session.dispose();
  });
  it('retains the exact immutable body after an actual commit followed by configuration_changed', async () => {
    const p = port(); await p.session.load(); p.lose(); const command = { type: 'create_statement' as const, statement: structuredClone(p.statement) };
    await expect(p.session.submit(command, id, 50, null)).rejects.toMatchObject({ code: 'configuration_changed', outcome: 'uncertain' });
    expect(p.session.hasPending()).toBe(true); (command.statement.lines[0].amount as { minorUnits: string }).minorUnits = '999'; p.advance();
    expect((await p.session.load()).erpRevision).toBe(51); await expect(p.session.submit({ type: 'complete' }, id, 51, 0)).rejects.toMatchObject({ code: 'pending_operation' });
    const replay = await p.session.retry(); expect(replay).toMatchObject({ replayed: true, receipt: { erpRevision: 50 } }); expect(p.bodies[1]).toBe(p.bodies[0]); expect(p.commits()).toBe(1); expect(p.keys()).toBe(1); expect(p.session.hasPending()).toBe(false); expect((await p.session.load()).erpRevision).toBe(51); p.session.dispose();
  });
  it.each(['bank_revision_conflict', 'bank_erp_revision_conflict', 'bank_idempotency_conflict', 'bank_statement_overlap', 'bank_statement_closed'])('releases a proven precommit %s only at HTTP409 and requires a fresh read', async code => {
    const p = port(); await p.session.load(); p.reject(code, 409); await expect(p.session.submit({ type: 'create_statement', statement: p.statement }, id, 50, null)).rejects.toMatchObject({ code, outcome: 'rejected' }); expect(p.session.hasPending()).toBe(false);
    await expect(p.session.submit({ type: 'create_statement', statement: p.statement }, id, 50, null)).rejects.toMatchObject({ code: 'read_required' }); p.clear(); await p.session.load(); await p.session.submit({ type: 'create_statement', statement: p.statement }, id, 50, null); p.session.dispose();
  });
  it.each([['bank_revision_conflict', 503], ['configuration_changed', 409], ['rate_limited', 429], ['service_unavailable', 503], ['unrecognized_private_text', 409]] as const)('retains the same envelope for %s/%i', async (code, status) => { const p = port(); await p.session.load(); p.reject(code, status); await expect(p.session.submit({ type: 'create_statement', statement: p.statement }, id, 50, null)).rejects.toMatchObject({ outcome: 'uncertain' }); expect(p.session.hasPending()).toBe(true); p.clear(); await p.session.retry(); expect(p.bodies[1]).toBe(p.bodies[0]); p.session.dispose(); });
  it.each([401, 402, 403])('revokes immediately at HTTP%i without reading a hanging body', async status => { let read = false; const session = createBrowserBankSession({ organizationId, expectedUserId: userId, role: 'owner', supportedSchemaVersion: 4, fetch: async () => ({ status, ok: false, get body() { read = true; return new ReadableStream({ start() {} }); } }) as Response }); await expect(session.load()).rejects.toMatchObject({ outcome: 'unauthorized', status }); expect(read).toBe(false); expect(session.hasPending()).toBe(false); });
  it('settles a hanging streamed body immediately on dispose and rejects late output', async () => { const session = createBrowserBankSession({ organizationId, expectedUserId: userId, role: 'owner', supportedSchemaVersion: 4, fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }) }); const load = session.load(); await new Promise(resolve => setTimeout(resolve, 0)); session.dispose(); await expect(load).rejects.toMatchObject({ code: 'session_changed' }); });
  it('bounds response bytes and rejects malformed/current-head cross-tenant reads without replacing data', async () => {
    for (const response of [new Response('x', { headers: { 'Content-Type': 'text/html' } }), Response.json({ schemaVersion: 1, organizationId: 'different', erpRevision: 50, ledgerRevision: 1, records: [] }), new Response(new Uint8Array(2_621_441), { headers: { 'Content-Type': 'application/json' } })]) { const session = createBrowserBankSession({ organizationId, expectedUserId: userId, role: 'admin', supportedSchemaVersion: 4, fetch: async () => response }); await expect(session.load()).rejects.toMatchObject({ code: 'invalid_response' }); session.dispose(); }
  });
  it('does not turn a spoofed receipt into confirmed success', async () => {
    const p = port(); const response = { schemaVersion: 1, organizationId, erpRevision: 50, ledgerRevision: 1, records: [] }; const session = createBrowserBankSession({ organizationId, expectedUserId: userId, role: 'owner', supportedSchemaVersion: 4, fetch: async (_url, init) => init?.method === 'GET' ? Response.json(response) : Response.json({ receipt: { organizationId: 'other' }, replayed: false }) }); await session.load(); await expect(session.submit({ type: 'create_statement', statement: p.statement }, id, 50, null)).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' }); expect(session.hasPending()).toBe(true); session.dispose();
  });
  it('rejects local unauthorized capability/roles before any fetch', () => { const fetcher = vi.fn(); for (const role of ['member', 'read_only'] as const) expect(() => createBrowserBankSession({ organizationId, expectedUserId: userId, role, supportedSchemaVersion: 4, fetch: fetcher })).toThrow(); expect(() => createBrowserBankSession({ organizationId, expectedUserId: userId, role: 'owner', supportedSchemaVersion: 3, fetch: fetcher })).toThrow(); expect(fetcher).not.toHaveBeenCalled(); });
  it('rejects descriptors, extra fields, invalid revision relationships and duplicate records', () => { const p = port(), request: UsBankRequest = { schemaVersion: 1, idempotencyKey: 'fixture', reconciliationId: id, expectedErpRevision: 50, expectedReconciliationRevision: null, command: { type: 'create_statement', statement: p.statement } }, record = applyUsBankCommand(null, request, p.ledger, actor, []); for (const input of [{ schemaVersion: 1, organizationId, erpRevision: 1, ledgerRevision: 2, records: [] }, { schemaVersion: 1, organizationId, erpRevision: 50, ledgerRevision: 1, records: [record, record] }, { schemaVersion: 1, organizationId, erpRevision: 50, ledgerRevision: 1, records: [], grant: true }, { schemaVersion: 1, organizationId, erpRevision: 50, ledgerRevision: 1, get records() { throw new Error('do not call'); } }]) expect(() => readBrowserBankResponse(input, organizationId)).toThrow(); });
  it('provides every bank message and safe recovery in all four languages', () => { for (const language of ['fr', 'de', 'it', 'en'] as const) { expect(Object.keys(browserBankCopy[language])).toEqual(Object.keys(browserBankCopy.en)); for (const value of Object.values(browserBankCopy[language])) expect(value.length).toBeGreaterThan(1); expect(browserBankError(language, 'private server details')).toBe(browserBankCopy[language].service); expect(browserBankError(language, 'bank_statement_overlap')).toBe(browserBankCopy[language].overlap); } });
});
