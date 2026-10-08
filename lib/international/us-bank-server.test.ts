import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError, sha256Hex } from '../account-security';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { postUsManualJournal } from './accounting/us-journal';
import { usStarterChart } from './countries/us/accounting';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { CompanyConfiguration } from './types';
import type { ErpState, ErpStore } from './runtime-types';
import type { UsBankRecord, UsBankRequest, UsBankReceipt, UsBankStore } from './us-bank-contract';
import { createUsBankHandlers, type UsBankServerDependencies } from './us-bank-server';
import { applyUsBankCommand, validateUsBankRecord } from './us-bank-reconciliation';

const org = 'b0c5564a-7e15-4c52-a29a-22598e04bf75', user = '28f8b272-af88-41bd-8708-1634f2af86f2';
const statementId = 'bd18217f-4af3-46ec-9fce-a9bb25067cbe', matchId = '44b823c6-dd8f-48eb-9a35-860754035be1';
const actor: FinancialAuthority = { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const ledger = postUsManualJournal(createLedger({ organizationId: org, currency: 'USD', basis: 'accrual', accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }), { id: 'capital', transactionDate: '2026-10-08', accountingDate: '2026-10-09', periodId: '2026', description: 'Fictitious opening capital', sourceReference: 'FICTITIOUS-APPROVAL', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '10000', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '10000' }] }, 'fictitious-capital', actor, 0);
const initialBook: ErpState = { schemaVersion: 4, revision: 10, configuration, counters: { estimate: 0, invoice: 0, project: 0 }, ledger, customers: [], estimates: [], invoices: [], vendors: [], vendorBills: [], vendorPayments: [], projects: [] };
const create: UsBankRequest = { schemaVersion: 1, idempotencyKey: 'bank-create', reconciliationId: statementId, expectedErpRevision: 10, expectedReconciliationRevision: null, command: { type: 'create_statement', statement: { id: statementId, organizationId: org, externalConnectionId: 'manual-reviewed-cash', currency: 'USD', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: { currency: 'USD', minorUnits: '0' }, closing: { currency: 'USD', minorUnits: '10000' }, lines: [{ id: `${statementId}:1`, date: '2026-10-08', amount: { currency: 'USD', minorUnits: '10000' }, reference: 'Fictitious capital reference' }] } } };
const approve: UsBankRequest = { ...create, idempotencyKey: 'bank-approve', expectedReconciliationRevision: 0, command: { type: 'approve_match', id: matchId, statementLineIds: [`${statementId}:1`], ledgerEntryIds: ['capital'] } };
const complete: UsBankRequest = { ...create, idempotencyKey: 'bank-complete', expectedReconciliationRevision: 1, command: { type: 'complete' } };
/** Actual HTTP + pure transition with fictitious admission and RAM CAS only.
 * Root's separate PostgreSQL tests establish durability; no real bank/provider. */
function fixture(mode: 'browser' | 'device' = 'browser') {
  let state = structuredClone(initialBook);
  const rows = new Map<string, UsBankRecord>(), receipts = new Map<string, UsBankReceipt>();
  const erpStore: ErpStore = { supportedSchemaVersion: 4, read: vi.fn(async () => structuredClone(state)), receipt: vi.fn(async () => null), commit: vi.fn(async () => { throw new Error('Must never mutate journal'); }) };
  const bankStore: UsBankStore = { supportedSchemaVersion: 4,
    list: vi.fn(async () => structuredClone([...rows.values()])),
    read: vi.fn(async (_actor, id) => structuredClone(rows.get(id) ?? null)),
    receipt: vi.fn(async (_actor, key) => structuredClone(receipts.get(key) ?? null)),
    commit: vi.fn(async input => {
      if (input.expectedErpRevision !== state.revision) throw new ErpError('bank_erp_revision_conflict', 409);
      const current = rows.get(input.record.reconciliation.statement.id);
      if ((current?.reconciliation.revision ?? null) !== input.expectedReconciliationRevision) throw new ErpError('bank_revision_conflict', 409);
      rows.set(input.record.reconciliation.statement.id, structuredClone(input.record)); receipts.set(input.receipt.idempotencyKey, structuredClone(input.receipt));
      return structuredClone(input.receipt);
    }),
  };
  const dependencies: UsBankServerDependencies = { enabled: () => true, authority: vi.fn(async () => ({ mode, actor: structuredClone(actor) })), configuration: vi.fn(async () => structuredClone(configuration)), store: vi.fn(() => erpStore), bankStore: vi.fn(() => bankStore), freshSupportedSchemaVersion: vi.fn(() => 4 as const), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn() };
  const handlers = createUsBankHandlers(dependencies);
  const post = (input: unknown = create, origin = 'https://zentraapp.ch', cap = '4') => new Request(`https://zentraapp.ch/api/international/workspaces/${org}/bank-reconciliations`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Zentra-Erp-Schema-Version': cap, 'X-Zentra-Expected-User': user }, body: JSON.stringify(input) });
  const get = (query = '', cap = '4') => new Request(`https://zentraapp.ch/api/international/workspaces/${org}/bank-reconciliations${query}`, { headers: { 'X-Zentra-Erp-Schema-Version': cap, 'X-Zentra-Expected-User': user } });
  return { state: () => state, replaceBook: (value: ErpState) => { state = value; }, rows, receipts, dependencies, erpStore, bankStore, handlers, post, get };
}
async function error(response: Response, code: string, status: number): Promise<void> {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
  expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}
describe('isolated US bank review HTTP', () => {
  it('reads an empty scoped registry with actual book and ledger revisions', async () => {
    const t = fixture(); const response = await t.handlers.GET(t.get(), org);
    expect(await response.json()).toEqual({ schemaVersion: 1, organizationId: org, erpRevision: 10, ledgerRevision: 1, records: [] }); expect(response.status).toBe(200);
    expect(t.erpStore.commit).not.toHaveBeenCalled(); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it('creates, approves and completes through the real core without a journal or money transfer', async () => {
    const t = fixture(), original = canonicalErpJson(t.state());
    for (const [input, revision] of [[create, 0], [approve, 1], [complete, 2]] as const) {
      const response = await t.handlers.POST(t.post(input), org); expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ receipt: { schemaVersion: 1, organizationId: org, actorId: user, commandHash: await sha256Hex(canonicalErpJson([org, user, input])), idempotencyKey: input.idempotencyKey, reconciliationId: statementId, action: input.command.type, revision, erpRevision: 10 }, replayed: false });
    }
    const response = await t.handlers.GET(t.get(), org), body = await response.json() as { records: UsBankRecord[] };
    expect(body.records).toHaveLength(1); expect(body.records[0].reconciliation).toMatchObject({ revision: 2, completedBy: user, completedLedgerRevision: 1 });
    expect(t.bankStore.commit).toHaveBeenCalledTimes(3); expect(t.erpStore.commit).not.toHaveBeenCalled(); expect(canonicalErpJson(t.state())).toBe(original);
  });
  it('captures the freshly admitted final actor timestamp for the approved record and SQL commit', async () => {
    const t = fixture(); let count = 0; t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, timestamp: ++count === 1 ? actor.timestamp : '2026-10-08T13:00:00.000Z' } });
    expect((await t.handlers.POST(t.post(), org)).status).toBe(200); expect(t.rows.get(statementId)?.createdAt).toBe('2026-10-08T13:00:00.000Z'); expect(vi.mocked(t.bankStore.commit).mock.calls[0][0].actor.timestamp).toBe('2026-10-08T13:00:00.000Z');
  });
  it('reports incomplete review and can audit-void an unmatched import without deleting it', async () => {
    const t = fixture(); await t.handlers.POST(t.post(), org);
    await error(await t.handlers.POST(t.post({ ...complete, expectedReconciliationRevision: 0 }), org), 'reconciliation_incomplete', 409);
    const request: UsBankRequest = { ...create, idempotencyKey: 'bank-void', expectedReconciliationRevision: 0, command: { type: 'void_statement', reason: 'Fictitious reviewed wrong statement import' } };
    expect((await t.handlers.POST(t.post(request), org)).status).toBe(200); expect(t.rows.size).toBe(1); expect(t.rows.get(statementId)?.voided).toEqual({ by: user, at: actor.timestamp, reason: request.command.type === 'void_statement' ? request.command.reason : '' });
    await error(await t.handlers.POST(t.post(approve), org), 'reconciliation_voided', 409); expect(t.bankStore.commit).toHaveBeenCalledTimes(2); expect(t.erpStore.commit).not.toHaveBeenCalled();
  });
  it('does not void an import that already contains an approved association', async () => {
    const t = fixture(); await t.handlers.POST(t.post(), org); await t.handlers.POST(t.post(approve), org);
    await error(await t.handlers.POST(t.post({ ...create, idempotencyKey: 'cannot-void', expectedReconciliationRevision: 1, command: { type: 'void_statement', reason: 'Fictitious correction' } }), org), 'statement_not_voidable', 409); expect(t.bankStore.commit).toHaveBeenCalledTimes(2);
  });
  it('refuses overlapping periods even with another opaque connection reference', async () => {
    const t = fixture(); await t.handlers.POST(t.post(), org); const id = 'c27e8b8e-e3fd-4fe0-b4e0-9bb241927f81';
    if (create.command.type !== 'create_statement') throw new Error('fixture');
    await error(await t.handlers.POST(t.post({ ...create, idempotencyKey: 'overlap', reconciliationId: id, command: { type: 'create_statement', statement: { ...create.command.statement, id, externalConnectionId: 'another-opaque-reference', lines: [{ ...create.command.statement.lines[0], id: `${id}:1`, reference: 'Another fictitious import' }] } } }), org), 'bank_statement_overlap', 409); expect(t.rows.size).toBe(1);
  });
  it('refuses reusing one cash entry in a second non-overlapping imported period', async () => {
    const t = fixture(); await t.handlers.POST(t.post(), org); await t.handlers.POST(t.post(approve), org); const id = '7d77e874-bdfa-47a5-9e08-174fc1538e8c';
    if (create.command.type !== 'create_statement') throw new Error('fixture');
    const second: UsBankRequest = { ...create, reconciliationId: id, idempotencyKey: 'second-import', command: { type: 'create_statement', statement: { ...create.command.statement, id, start: '2026-09-01', end: '2026-09-30', lines: [{ ...create.command.statement.lines[0], id: `${id}:1`, date: '2026-09-25' }] } } };
    expect((await t.handlers.POST(t.post(second), org)).status).toBe(200);
    await error(await t.handlers.POST(t.post({ ...approve, reconciliationId: id, idempotencyKey: 'double-match', command: { ...approve.command, type: 'approve_match', id: '68879fc6-0bc6-49ae-bb6b-acacb6feb302', statementLineIds: [`${id}:1`], ledgerEntryIds: ['capital'] } }), org), 'bank_entry_already_matched', 409); expect(t.bankStore.commit).toHaveBeenCalledTimes(3);
  });
  it('exposes a reviewed timestamp moving backwards as a controlled precommit conflict', async () => {
    const t = fixture(); await t.handlers.POST(t.post(), org); t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, timestamp: '2026-10-08T11:00:00.000Z' } });
    await error(await t.handlers.POST(t.post(approve), org), 'bank_clock_reversed', 409); expect(t.bankStore.commit).toHaveBeenCalledTimes(1);
  });
  it('recovers an exact receipt after a newer ERP revision without a second mutation or latest CAS', async () => {
    const t = fixture(); await t.handlers.POST(t.post(), org); t.replaceBook({ ...t.state(), revision: 11 });
    const response = await t.handlers.POST(t.post(), org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replayed: true, receipt: { revision: 0, erpRevision: 10 } }); expect(t.bankStore.commit).toHaveBeenCalledTimes(1);
  });
  it('retains a commit after a lost reply and recovers it with the identical body and key', async () => {
    const t = fixture(), real = t.bankStore.commit; t.bankStore.commit = vi.fn(async input => { await real(input); throw new Error('Fictitious lost network reply'); });
    await error(await t.handlers.POST(t.post(), org), 'service_unavailable', 503); expect(t.rows.size).toBe(1);
    const response = await t.handlers.POST(t.post(), org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ replayed: true }); expect(t.bankStore.commit).toHaveBeenCalledTimes(1);
  });
  it('rejects changed content with a previously committed key even after a later ERP revision', async () => {
    const t = fixture(); await t.handlers.POST(t.post(), org); t.replaceBook({ ...t.state(), revision: 11 });
    await error(await t.handlers.POST(t.post({ ...create, expectedErpRevision: 11 }), org), 'bank_idempotency_conflict', 409); expect(t.bankStore.commit).toHaveBeenCalledTimes(1);
  });
  it.each(['member', 'read_only'] as const)('refuses %s financial reads and writes before opening a store', async role => {
    const t = fixture(); t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, role } });
    await error(await t.handlers.GET(t.get(), org), 'financial_permission_required', 403); await error(await t.handlers.POST(t.post(), org), 'financial_permission_required', 403); expect(t.dependencies.store).not.toHaveBeenCalled(); expect(t.dependencies.bankStore).not.toHaveBeenCalled();
  });
  it.each([401, 402, 403, 429])('sanitizes upstream admission status%s without revealing its private reason', async status => {
    const t = fixture(); t.dependencies.authority = async () => { throw new AccountPublicError('PRIVATE_TOKEN_OR_MAILBOX', status); };
    await error(await t.handlers.POST(t.post(), org), status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden', status); expect(t.dependencies.bankStore).not.toHaveBeenCalled();
  });
  it('refuses cross-origin browser writes and admits a separately verified device without cookies', async () => {
    const browser = fixture(); await error(await browser.handlers.POST(browser.post(create, 'https://evil.invalid'), org), 'forbidden', 403); expect(browser.bankStore.commit).not.toHaveBeenCalled();
    const device = fixture('device'); expect((await device.handlers.POST(device.post(create, 'tauri://localhost'), org)).status).toBe(200); expect(device.bankStore.commit).toHaveBeenCalledTimes(1);
  });
  it('enforces a stable expected user and tenant without taking identity from request JSON', async () => {
    const t = fixture(); t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, userId: 'different' } }); await error(await t.handlers.POST(t.post(), org), 'session_changed', 401);
    t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, organizationId: 'different' } }); await error(await t.handlers.POST(t.post(), org), 'tenant_mismatch', 403); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it.each(['GET', 'POST'] as const)('refuses %s when the feature is closed without opening persistence', async method => {
    const t = fixture(); t.dependencies.enabled = () => false; await error(await t.handlers[method](method === 'GET' ? t.get() : t.post(), org), 'feature_unavailable', 404); expect(t.dependencies.authority).not.toHaveBeenCalled();
  });
  it.each(['1', '2', '3', '5'])('refuses client capability%s without upgrading a stored credential', async cap => {
    const t = fixture(); await error(await t.handlers.POST(t.post(create, undefined, cap), org), cap === '5' ? 'invalid_request' : 'bank_upgrade_required', cap === '5' ? 422 : 409); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it.each(['erp', 'bank'] as const)('refuses a captured %s store with ceiling3 even when the header declares4', async source => {
    const t = fixture(); if (source === 'erp') t.dependencies.store = () => ({ ...t.erpStore, supportedSchemaVersion: 3 }); else t.dependencies.bankStore = () => ({ ...t.bankStore, supportedSchemaVersion: 3 });
    await error(await t.handlers.POST(t.post(), org), 'bank_upgrade_required', 409); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3] as const)('refuses actual book%s even for an exact receipt replay', async schemaVersion => {
    const t = fixture(); await t.handlers.POST(t.post(), org); t.replaceBook({ ...t.state(), schemaVersion }); await error(await t.handlers.POST(t.post(), org), 'bank_upgrade_required', 409); expect(t.bankStore.commit).toHaveBeenCalledTimes(1);
  });
  it('keeps CH configurations and currencies outside this surface', async () => {
    const t = fixture(); t.dependencies.configuration = async () => ({ schemaVersion: 1, organizationId: org, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } }); await error(await t.handlers.GET(t.get(), org), 'edition_unavailable', 409); expect(t.dependencies.store).not.toHaveBeenCalled();
  });
  it.each(['GET', 'POST'] as const)('rejects query parameters on %s rather than accepting extra authority/selectors', async method => {
    const t = fixture(); const request = method === 'GET' ? t.get('?organizationId=other') : new Request(`${t.post().url}?role=owner`, { method: 'POST', headers: t.post().headers, body: JSON.stringify(create) }); await error(await t.handlers[method](request, org), 'invalid_request', 422); expect(t.dependencies.authority).not.toHaveBeenCalled();
  });
  it('bounds streamed and declared request bodies and accepts JSON only', async () => {
    const t = fixture(); await error(await t.handlers.POST(t.post({ ...create, privatePassword: 'x'.repeat(1_048_576) }), org), 'invalid_bank_request', 413);
    const declared = new Request(t.post().url, { method: 'POST', headers: { ...Object.fromEntries(t.post().headers), 'Content-Length': '1048577' }, body: JSON.stringify(create) }); await error(await t.handlers.POST(declared, org), 'invalid_bank_request', 413);
    const wrongType = new Request(t.post().url, { method: 'POST', headers: { ...Object.fromEntries(t.post().headers), 'Content-Type': 'text/plain' }, body: JSON.stringify(create) }); await error(await t.handlers.POST(wrongType, org), 'invalid_bank_request', 415); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it('rejects extra body authority fields and records only public operation/code/status diagnostics', async () => {
    const t = fixture(); await error(await t.handlers.POST(t.post({ ...create, role: 'owner', password: 'SECRET' }), org), 'invalid_bank_request', 422); expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toContain('SECRET'); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it('checks expected ERP revision separately from ledger revision before a new mutation', async () => {
    const t = fixture(); await error(await t.handlers.POST(t.post({ ...create, expectedErpRevision: 1 }), org), 'bank_erp_revision_conflict', 409); expect(t.bankStore.read).not.toHaveBeenCalled(); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it('relies on the atomic store ERP fence for a revision change immediately before commit', async () => {
    const t = fixture(), real = t.bankStore.commit; t.bankStore.commit = vi.fn(async input => { t.replaceBook({ ...t.state(), revision: 11 }); return real(input); }); await error(await t.handlers.POST(t.post(), org), 'bank_erp_revision_conflict', 409); expect(t.rows.size).toBe(0); expect(t.erpStore.commit).not.toHaveBeenCalled();
  });
  it('refuses a changed ERP snapshot during list retrieval rather than mixing revisions', async () => {
    const t = fixture(); t.bankStore.list = vi.fn(async () => { t.replaceBook({ ...t.state(), revision: 11 }); return []; }); await error(await t.handlers.GET(t.get(), org), 'bank_erp_revision_conflict', 409);
  });
  it.each(['revoke', 'actor', 'mode', 'role', 'entitlement', 'configuration', 'capability', 'flag'] as const)('withholds a late read after %s changes', async change => {
    const t = fixture(); let phase = false; t.bankStore.list = vi.fn(async () => { phase = true; return []; });
    const originalAuthority = t.dependencies.authority; t.dependencies.authority = async (request, organizationId) => {
      if (phase && change === 'revoke') throw new AccountPublicError('private revoked', 401);
      const value = await originalAuthority(request, organizationId); if (!phase) return value;
      if (change === 'actor') return { ...value, actor: { ...value.actor, userId: 'different' } };
      if (change === 'mode') return { ...value, mode: 'device' };
      if (change === 'role') return { ...value, actor: { ...value.actor, role: 'read_only' } };
      if (change === 'entitlement') return { ...value, actor: { ...value.actor, managementEntitled: false } };
      return value;
    };
    if (change === 'configuration') t.dependencies.configuration = async () => ({ ...configuration, language: phase ? 'fr' : 'en' });
    if (change === 'capability') t.dependencies.freshSupportedSchemaVersion = () => phase ? 3 : 4;
    if (change === 'flag') t.dependencies.enabled = () => !phase;
    const expected = change === 'role' ? ['forbidden', 403] : change === 'entitlement' ? ['management_entitlement_required', 402] : change === 'configuration' ? ['configuration_changed', 409] : change === 'capability' ? ['bank_upgrade_required', 409] : change === 'flag' ? ['feature_unavailable', 404] : ['session_changed', 401];
    if (change === 'revoke') expected[0] = 'unauthorized'; await error(await t.handlers.GET(t.get(), org), expected[0] as string, expected[1] as number);
  });
  it('gives fresh authorization failure priority over a simultaneous private configuration error', async () => {
    const t = fixture(); let phase = false; t.bankStore.list = vi.fn(async () => { phase = true; throw new Error('PRIVATE_BANK_SECRET'); }); t.dependencies.configuration = async () => { if (phase) throw new Error('PRIVATE_CONFIG'); return configuration; }; t.dependencies.authority = async () => { if (phase) throw new AccountPublicError('PRIVATE_REVOKED', 401); return { mode: 'browser', actor }; }; await error(await t.handlers.GET(t.get(), org), 'unauthorized', 401);
  });
  it('checks authority after the final asynchronous capability/flag lookup too', async () => {
    const t = fixture(); let enabledCalls = 0, revoked = false;
    t.dependencies.enabled = async () => { if (++enabledCalls > 1) revoked = true; return true; };
    t.dependencies.authority = async () => { if (revoked) throw new AccountPublicError('private revoked during flag lookup', 401); return { mode: 'browser', actor }; };
    await error(await t.handlers.GET(t.get(), org), 'unauthorized', 401);
  });
  it('rechecks both store factory ceilings when no dynamic capability hook is configured', async () => {
    const t = fixture(); delete t.dependencies.freshSupportedSchemaVersion;
    let closed = false; t.bankStore.list = async () => { closed = true; return []; };
    t.dependencies.bankStore = () => ({ ...t.bankStore, supportedSchemaVersion: closed ? 3 : 4 });
    await error(await t.handlers.GET(t.get(), org), 'bank_upgrade_required', 409);
  });
  it('checks admission on storage failures and exact receipt failures instead of echoing private data', async () => {
    const t = fixture(); let phase = false; t.bankStore.receipt = vi.fn(async () => { phase = true; throw new Error('PRIVATE_BANK_SECRET'); }); t.dependencies.authority = async () => { if (phase) throw new AccountPublicError('PRIVATE_REVOKED', 401); return { mode: 'browser', actor }; }; await error(await t.handlers.POST(t.post(), org), 'unauthorized', 401); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it('blocks a late precommit revocation without recording anything', async () => {
    const t = fixture(); let phase = false; t.bankStore.list = vi.fn(async () => { phase = true; return []; }); t.dependencies.authority = async () => { if (phase) throw new AccountPublicError('revoked', 401); return { mode: 'browser', actor }; }; await error(await t.handlers.POST(t.post(), org), 'unauthorized', 401); expect(t.rows.size).toBe(0); expect(t.bankStore.commit).not.toHaveBeenCalled();
  });
  it('withholds a durable receipt after postcommit revocation and recovers after fresh authentication', async () => {
    const t = fixture(), real = t.bankStore.commit; let revoked = false;
    t.bankStore.commit = vi.fn(async input => { const result = await real(input); revoked = true; return result; }); t.dependencies.authority = async () => { if (revoked) throw new AccountPublicError('revoked', 401); return { mode: 'browser', actor }; };
    await error(await t.handlers.POST(t.post(), org), 'unauthorized', 401); expect(t.rows.size).toBe(1); revoked = false;
    const recovered = await t.handlers.POST(t.post(), org); expect(recovered.status).toBe(200); expect(await recovered.json()).toMatchObject({ replayed: true }); expect(t.bankStore.commit).toHaveBeenCalledTimes(1);
  });
  it.each(['extra', 'revision', 'actorId', 'organizationId', 'action', 'hash'] as const)('withholds a corrupt store receipt (%s) after an already durable mutation', async field => {
    const t = fixture(), real = t.bankStore.commit; t.bankStore.commit = vi.fn(async input => {
      const saved = await real(input); return { ...saved, ...(field === 'extra' ? { privateToken: 'SECRET' } : field === 'revision' ? { revision: 99 } : field === 'actorId' ? { actorId: 'other' } : field === 'organizationId' ? { organizationId: 'other' } : field === 'action' ? { action: 'complete' } : { commandHash: '0'.repeat(64) }) } as UsBankReceipt;
    }); await error(await t.handlers.POST(t.post(), org), 'invalid_bank_record', 503); expect(t.rows.size).toBe(1); expect(t.erpStore.commit).not.toHaveBeenCalled();
  });
  it('does not publish malformed/foreign/duplicate records or more than100 imported records', async () => {
    const t = fixture(), record = applyUsBankCommand(null, create, ledger, actor, []);
    t.bankStore.list = async () => [{ ...record, privateToken: 'SECRET' } as UsBankRecord]; await error(await t.handlers.GET(t.get(), org), 'invalid_bank_record', 503);
    t.bankStore.list = async () => [record, record]; await error(await t.handlers.GET(t.get(), org), 'invalid_bank_record', 503);
    t.bankStore.list = async () => Array.from({ length: 101 }, () => record); await error(await t.handlers.GET(t.get(), org), 'bank_store_limit', 503);
    t.bankStore.list = async () => [{ ...record, reconciliation: { ...record.reconciliation, organizationId: 'other' } }]; await error(await t.handlers.GET(t.get(), org), 'invalid_bank_record', 503);
  });
  it('bounds the encoded full list to2.5MiB rather than publishing an oversized financial body', async () => {
    const t = fixture(); t.bankStore.list = async () => Array.from({ length: 10 }, (_, n) => {
      const id = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
      return validateUsBankRecord({ schemaVersion: 1, reconciliation: { organizationId: org, revision: 0, matches: [], statement: { ...(create.command.type === 'create_statement' ? create.command.statement : {}), id, lines: Array.from({ length: 1000 }, (_, i) => ({ id: `${id}:${i}`, date: '2026-10-08', amount: { currency: 'USD', minorUnits: '10' }, reference: 'x'.repeat(256) })) } }, createdBy: user, createdAt: actor.timestamp }, org);
    }); await error(await t.handlers.GET(t.get(), org), 'bank_store_limit', 503);
  });
  it('sanitizes unknown/mismatched public errors and isolates a broken diagnostic sink', async () => {
    const t = fixture(); t.bankStore.list = async () => { throw new ErpError('PRIVATE_SECRET_CODE', 409); }; t.dependencies.diagnostic = () => { throw new Error('Telemetry unavailable'); }; await error(await t.handlers.GET(t.get(), org), 'service_unavailable', 503);
    t.bankStore.list = async () => { throw new ErpError('bank_revision_conflict', 503); }; await error(await t.handlers.GET(t.get(), org), 'service_unavailable', 503);
  });
});
