import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { org, orderId, salesOrderErpFixture, salesOrderFixture, user } from '../../tests/us-sales-orders-fixture';
import type { FinancialAuthority } from './accounting/ledger';
import { createBrowserErpSession } from './browser-erp-session';
import { createBrowserUsSalesOrderSession } from './browser-us-sales-order-session';
import { canonicalErpJson } from './erp-contract';
import type { TaxCalculationProvider } from './invoicing';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createSupabaseErpStore } from './runtime-store';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpState } from './runtime-types';
import { summarizeUsSalesOrder, validateUsSalesOrderRecord, validateUsSalesOrderRequest, type UsSalesOrderReceipt } from './us-sales-order-contract';
import { createUsSalesOrderHandlers } from './us-sales-order-server';
import { createSupabaseUsSalesOrderStore } from './us-sales-order-store';

const origin = 'https://zentraapp.ch';
const timestamp = '2026-10-10T12:00:00.000Z';

/** Real stores, HTTP admission, ERP engine and browser transports, with only
 * the service-role RPC boundary simulated. These tests return PostgreSQL's
 * guard SQLSTATEs; they do not claim to execute the migration or hosted Auth. */
function fixture(role: FinancialAuthority['role'] = 'owner', basis: 'cash' | 'accrual' = 'accrual') {
  const seed = salesOrderErpFixture();
  const configuration = { ...seed.configuration, accountingBasis: basis, taxConfiguration: { status: 'configured' as const } };
  let state: ErpState = { ...seed, configuration, ledger: { ...seed.ledger, basis } };
  const initialOrder = salesOrderFixture();
  let record = validateUsSalesOrderRecord({ ...initialOrder, order: { ...initialOrder.order, companyConfiguration: configuration } }, org);
  let headRevision = 1, key = 0, revoked = false;
  let actor: FinancialAuthority = { organizationId: org, userId: user, role, managementEntitled: true, timestamp };
  const receipts = new Map<string, ErpReceipt>();
  const commercialReceipts = new Map<string, UsSalesOrderReceipt>();
  const attemptedCommits: ErpCommit[] = [];
  const commercialWrites: unknown[] = [];
  const rpcCalls: string[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const diagnostics = vi.fn();
  const provider: TaxCalculationProvider = {
    id: 'fictitious-sales-order-guard-test',
    async calculate(request) {
      return { ...request, source: 'external-provider', providerReference: 'fictional-proof-not-a-real-tax-determination', determinedAt: '2026-10-10T11:00:00Z', validUntil: '2026-10-10T13:00:00Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: '825', jurisdiction: 'fictitious', evidenceReference: 'fixture-only' })) };
    },
  };
  const calculate = vi.spyOn(provider, 'calculate');
  const client: Pick<SupabaseServerClient, 'rpc'> = {
    async rpc<T>(name: string, p: Readonly<Record<string, unknown>>): Promise<T> {
      rpcCalls.push(name);
      if (p.p_organization !== org) throw new Error('The fictitious RPC must stay in its workspace.');
      let result: unknown;
      switch (name) {
        case 'zentra_read_us_erp_v4': result = state; break;
        case 'zentra_us_erp_receipt_v4': result = receipts.get(String(p.p_idempotency_key)) ?? null; break;
        case 'zentra_commit_us_erp': {
          const commit: ErpCommit = { organizationId: org, expectedRevision: p.p_expected_revision as number, header: p.p_header as ErpCommit['header'], changes: p.p_changes as ErpCommit['changes'], ledgerAudit: p.p_ledger_audit as ErpCommit['ledgerAudit'], receipt: p.p_receipt as ErpReceipt, actor: p.p_actor as FinancialAuthority };
          attemptedCommits.push(structuredClone(commit));
          if (commit.expectedRevision !== state.revision) throw new SupabaseServerError(400, 'PU001');
          // The SQL guards abort the entire transaction, including its ERP
          // receipt, sequence, journal and audit. Never partly apply a delta.
          if (record.order.state !== 'cancelled' && commit.changes.some(change => change.kind === 'estimate' && change.id === record.order.sourceEstimate.id)) throw new SupabaseServerError(400, 'PO008', 'PRIVATE_SQL_DETAIL');
          if (record.order.state === 'draft' && commit.changes.some(change => change.kind === 'invoice')) throw new SupabaseServerError(400, 'PO011', 'PRIVATE_SQL_DETAIL');
          const next = applyErpDelta(state, { schemaVersion: 4, organizationId: org, fromRevision: commit.expectedRevision, toRevision: commit.header.revision, headRevision: commit.header.revision, hasMore: false, resetRequired: false, events: [{ schemaVersion: 4, organizationId: org, revision: commit.header.revision, header: commit.header, changes: commit.changes, ledgerAudit: commit.ledgerAudit, receipt: commit.receipt, actorId: commit.actor.userId, occurredAt: commit.actor.timestamp }] }, org, 4);
          if (!next) throw new Error('A successful fictitious update must retain the initialized ERP.');
          state = next;
          receipts.set(commit.receipt.idempotencyKey, commit.receipt);
          result = commit.receipt; break;
        }
        case 'zentra_us_sales_order_head': result = { schemaVersion: 1, organizationId: org, headRevision, erpRevision: state.revision }; break;
        case 'zentra_list_us_sales_orders': result = { schemaVersion: 1, organizationId: org, headRevision, erpRevision: state.revision, total: 1, orders: [summarizeUsSalesOrder(record)], nextBeforeSequence: null }; break;
        case 'zentra_read_us_sales_order': result = p.p_order_id === orderId ? record : null; break;
        case 'zentra_us_sales_order_receipt': result = commercialReceipts.get(String(p.p_idempotency_key)) ?? null; break;
        case 'zentra_execute_us_sales_order': {
          const request = validateUsSalesOrderRequest(p.p_request, org), writer = p.p_actor as FinancialAuthority;
          if (request.expectedErpRevision !== state.revision) throw new SupabaseServerError(400, 'PO003');
          if (request.expectedHeadRevision !== headRevision || request.expectedOrderRevision !== record.order.revision) throw new SupabaseServerError(400, 'PO001');
          if (request.command.type !== 'cancel' || record.order.state !== 'draft') throw new Error('Only the fictitious cancellation scenario is supported.');
          commercialWrites.push(structuredClone(p));
          record = validateUsSalesOrderRecord({ ...record, order: { ...record.order, revision: 2, state: 'cancelled', cancellation: { reason: request.command.reason, cancelledBy: writer.userId, cancelledAt: writer.timestamp } } }, org);
          headRevision++;
          const receipt: UsSalesOrderReceipt = { schemaVersion: 1, organizationId: org, idempotencyKey: request.idempotencyKey, commandHash: p.p_command_hash as string, actorId: writer.userId, orderId, action: 'cancel', revision: 2, headRevision, erpRevision: state.revision, sequence: 1 };
          commercialReceipts.set(receipt.idempotencyKey, receipt);
          result = { receipt, replayed: false }; break;
        }
        default: throw new Error(`Unexpected fictitious RPC: ${name}`);
      }
      return structuredClone(result) as T;
    },
  };
  const erpStore = createSupabaseErpStore(client, { supportedSchemaVersion: 4 });
  const salesOrderStore = createSupabaseUsSalesOrderStore(client, { supportedSchemaVersion: 4 });
  const dependencies: ErpServerDependencies = {
    enabled: () => true,
    authority: async () => { if (revoked) throw new AccountPublicError('PRIVATE_AUTH_DETAIL', 401); return { mode: 'browser', actor }; },
    configuration: async () => configuration,
    store: () => erpStore,
    freshSupportedSchemaVersion: () => 4,
    taxProvider: async () => provider,
    seller: async () => record.order.sellerSnapshot,
    rateLimit: async () => {},
    diagnostic: diagnostics,
  };
  const erpHandlers = createErpHandlers(dependencies);
  const orderHandlers = createUsSalesOrderHandlers({ ...dependencies, newOrdersEnabled: () => true, salesOrderStore: () => salesOrderStore });
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === 'POST') headers.set('Origin', origin);
    const url = new URL(input instanceof Request ? input.url : input, origin), request = new Request(url, { ...init, headers });
    let response: Response;
    if (url.pathname.endsWith('/erp')) response = await erpHandlers[request.method === 'POST' ? 'POST' : 'GET'](request, org);
    else if (url.pathname.endsWith(`/sales-orders/${orderId}`)) response = await orderHandlers.DETAIL(request, org, orderId);
    else if (url.pathname.endsWith('/sales-orders')) response = await orderHandlers[request.method === 'POST' ? 'POST' : 'GET'](request, org);
    else throw new Error('Unexpected browser route.');
    responses.push({ status: response.status, body: await response.clone().json() });
    return response;
  };
  const newId = () => `c9000000-0000-4000-8000-${String(++key).padStart(12, '0')}`;
  const erp = createBrowserErpSession({ organizationId: org, expectedUserId: user, supportedSchemaVersion: 4, fetch: fetcher, newId });
  const orders = createBrowserUsSalesOrderSession({ organizationId: org, expectedUserId: user, role, fetch: fetcher, newId });
  const source = initialOrder.order.sourceEstimate;
  const edit: ErpCommand = { type: 'save_estimate', id: source.id, expectedEstimateRevision: source.revision, customerId: source.customer.id, date: source.date, expiresAt: source.expiresAt, paymentTermsDays: source.paymentTermsDays, lines: source.lines, notes: 'Fictitious revised scope after commercial cancellation.' };
  const issue: ErpCommand = { type: 'issue_invoice', id: 'invoice-guard-test', estimateId: source.id, expectedEstimateRevision: source.revision, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' };
  return { erp, orders, edit, issue, attemptedCommits, commercialWrites, rpcCalls, responses, receipts, commercialReceipts, diagnostics, calculate,
    state: () => state, record: () => record,
    changeActor: (change: Partial<FinancialAuthority>) => { actor = { ...actor, ...change }; },
    revoke: () => { revoked = true; },
  };
}

describe('US sales-order guards through ERP store, HTTP and browser sessions', () => {
  it.each(['owner', 'member'] as const)('PO008 rejects a %s quote edit certainly, allowing cancellation then a fresh edit', async role => {
    const t = fixture(role), before = canonicalErpJson(t.state()), frozenSource = canonicalErpJson(t.record().order.sourceEstimate);
    await t.erp.load(); await t.orders.load();
    await expect(t.erp.submit(t.edit, 10)).rejects.toMatchObject({ code: 'sales_order_source_locked', status: 409, outcome: 'rejected' });
    expect(t.erp.hasPending()).toBe(false);
    expect(t.responses.at(-1)).toEqual({ status: 409, body: { error: 'sales_order_source_locked' } });
    expect(t.attemptedCommits).toHaveLength(1);
    expect(t.attemptedCommits[0].actor.role).toBe(role);
    expect(canonicalErpJson(t.state())).toBe(before); expect(t.receipts.size).toBe(0);
    const calls = t.rpcCalls.length;
    await expect(t.erp.retry()).rejects.toMatchObject({ code: 'no_pending_operation', outcome: 'rejected' });
    await expect(t.erp.submit(t.edit, 10)).rejects.toMatchObject({ code: 'read_required', outcome: 'rejected' });
    expect(t.rpcCalls).toHaveLength(calls);

    const cancelled = await t.orders.change(orderId, 1, { type: 'cancel', reason: 'Fictitious scope revision requested.' });
    expect(cancelled.receipt).toMatchObject({ action: 'cancel', erpRevision: 10, revision: 2, actorId: user });
    expect(t.orders.hasPending()).toBe(false);
    expect(canonicalErpJson(t.state())).toBe(before);
    expect((await t.orders.read(orderId)).order.state).toBe('cancelled');
    expect(t.commercialWrites).toHaveLength(1); expect(t.commercialReceipts.size).toBe(1);

    await t.erp.load(); const edited = await t.erp.submit(t.edit, 10);
    expect(edited.receipt).toMatchObject({ action: 'save_estimate', revision: 11 });
    expect(t.erp.hasPending()).toBe(false);
    expect(t.state().estimates[0]).toMatchObject({ revision: 5, status: 'draft', notes: t.edit.notes });
    expect(canonicalErpJson(t.record().order.sourceEstimate)).toBe(frozenSource);
    expect(t.state().ledger.entries).toHaveLength(0); expect(t.state().ledger.audit).toHaveLength(0);
    expect(t.state().counters.invoice).toBe(0); expect(t.receipts.size).toBe(1);
    expect(JSON.stringify(t.responses)).not.toContain('PRIVATE_');
    expect(t.diagnostics).toHaveBeenCalledWith({ operation: 'write', code: 'sales_order_source_locked', status: 409 });
    t.erp.dispose(); t.orders.dispose();
  });

  it.each(['cash', 'accrual'] as const)('PO011 rolls back a real %s invoice attempt without trapping commercial cancellation', async basis => {
    const t = fixture('owner', basis), before = canonicalErpJson(t.state());
    await t.erp.load(); await t.orders.load();
    await expect(t.erp.submit(t.issue, 10)).rejects.toMatchObject({ code: 'sales_order_invoice_blocked', status: 409, outcome: 'rejected' });
    expect(t.calculate).toHaveBeenCalledOnce();
    expect(t.attemptedCommits).toHaveLength(1);
    expect(t.attemptedCommits[0].changes.map(change => change.kind)).toEqual(basis === 'cash' ? ['invoice'] : ['invoice', 'journal']);
    expect(t.responses.at(-1)).toEqual({ status: 409, body: { error: 'sales_order_invoice_blocked' } });
    expect(t.erp.hasPending()).toBe(false); expect(t.receipts.size).toBe(0);
    expect(canonicalErpJson(t.state())).toBe(before);
    await expect(t.erp.retry()).rejects.toMatchObject({ code: 'no_pending_operation', outcome: 'rejected' });
    await expect(t.erp.submit(t.issue, 10)).rejects.toMatchObject({ code: 'read_required', outcome: 'rejected' });
    await t.orders.change(orderId, 1, { type: 'cancel', reason: 'Fictitious internal order cancelled before invoice.' });
    expect(t.record().order.state).toBe('cancelled');
    expect(canonicalErpJson(t.state())).toBe(before);
    expect(t.state().invoices).toHaveLength(0); expect(t.state().counters.invoice).toBe(0);
    expect(t.state().ledger.entries).toHaveLength(0); expect(t.state().ledger.audit).toHaveLength(0);
    expect(t.diagnostics).toHaveBeenCalledWith({ operation: 'write', code: 'sales_order_invoice_blocked', status: 409 });
    expect(JSON.stringify(t.responses)).not.toContain('PRIVATE_');
    t.erp.dispose(); t.orders.dispose();
  });

  it('keeps member financial issuance forbidden while member commercial cancellation is allowed', async () => {
    const t = fixture('member'), before = canonicalErpJson(t.state());
    await t.erp.load(); await t.orders.load();
    await expect(t.erp.submit(t.issue, 10)).rejects.toMatchObject({ status: 403, outcome: 'unauthorized' });
    expect(t.responses.at(-1)).toEqual({ status: 403, body: { error: 'financial_permission_required' } });
    expect(t.attemptedCommits).toHaveLength(0); expect(t.calculate).not.toHaveBeenCalled();
    await t.orders.change(orderId, 1, { type: 'cancel', reason: 'Fictitious commercial-only member action.' });
    expect(t.commercialWrites).toHaveLength(1); expect(t.record().order.cancellation?.cancelledBy).toBe(user);
    expect(canonicalErpJson(t.state())).toBe(before); expect(t.receipts.size).toBe(0);
    t.erp.dispose(); t.orders.dispose();
  });

  it.each([
    ['revoked session', 401], ['different user', 401], ['read-only role', 403], ['lost entitlement', 402],
  ] as const)('does not bypass %s after a certain financial guard refusal', async (change, status) => {
    const t = fixture(), before = canonicalErpJson(t.state());
    await t.erp.load(); await t.orders.load();
    await expect(t.erp.submit(t.edit, 10)).rejects.toMatchObject({ code: 'sales_order_source_locked', status: 409, outcome: 'rejected' });
    expect(t.erp.hasPending()).toBe(false);
    if (change === 'revoked session') t.revoke();
    else if (change === 'different user') t.changeActor({ userId: 'c9000000-0000-4000-8000-000000000099' });
    else if (change === 'read-only role') t.changeActor({ role: 'read_only' });
    else t.changeActor({ managementEntitled: false });
    const calls = t.rpcCalls.length;
    await expect(t.orders.change(orderId, 1, { type: 'cancel', reason: 'Fictitious action after access loss.' })).rejects.toMatchObject({ status, outcome: 'unauthorized' });
    expect(t.orders.hasPending()).toBe(false);
    expect(t.rpcCalls).toHaveLength(calls);
    expect(t.commercialWrites).toHaveLength(0); expect(t.commercialReceipts.size).toBe(0);
    expect(t.record().order.state).toBe('draft'); expect(canonicalErpJson(t.state())).toBe(before);
    await expect(t.orders.read(orderId)).rejects.toMatchObject({ outcome: 'unauthorized' });
    expect(JSON.stringify(t.responses)).not.toContain('PRIVATE_');
    t.erp.dispose();
  });
});
