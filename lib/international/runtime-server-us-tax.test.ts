import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError, sha256Hex } from '../account-security';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { nationalAdapter } from './countries/adapters';
import { canonicalErpJson } from './erp-contract';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import type { ErpReceipt, ErpRequest, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { executeUsTaxInvoiceTest } from './us-tax-invoice';

const organizationId = 'fictitious-http-tax-workspace';
const timestamp = '2026-10-08T12:00:00.000Z';
const configuration: CompanyConfiguration = {
  schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en',
  timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' },
};
const actor: FinancialAuthority = { organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp };
const invoice: ErpRequest = {
  idempotencyKey: 'fictitious-http-invoice', expectedRevision: 4,
  command: { type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-08', periodId: '2026' },
};
type Change = 'revoked' | 'user' | 'scope' | 'mode' | 'role' | 'entitlement' | 'flags' | 'configuration';
const changedResponse: Record<Change, readonly [number, string]> = {
  revoked: [401, 'unauthorized'], user: [401, 'session_changed'], scope: [401, 'session_changed'], mode: [401, 'session_changed'],
  role: [403, 'forbidden'], entitlement: [402, 'management_entitlement_required'], flags: [404, 'feature_unavailable'], configuration: [409, 'configuration_changed'],
};
async function receipt(input: ErpRequest = invoice, userId = actor.userId): Promise<ErpReceipt> {
  return { idempotencyKey: input.idempotencyKey, commandHash: await sha256Hex(canonicalErpJson([organizationId, userId, input])), revision: input.expectedRevision + 1, action: input.command.type, entityId: input.command.type === 'issue_invoice' ? input.command.id : organizationId };
}

// HTTP dispatch and response-boundary evidence only: the hook and ordinary ERP
// storage below are local fixtures. The final case uses the real TEST issuer's
// historical-receipt path, still with synthetic Auth/storage and no provider.
function fixture() {
  let open = true, current: { mode: 'browser' | 'device'; actor: FinancialAuthority } = { mode: 'browser', actor: { ...actor } };
  let currentConfig = structuredClone(configuration), denied: AccountPublicError | null = null;
  const read = vi.fn(async (): Promise<ErpState | null> => null);
  const findReceipt = vi.fn(async (): Promise<ErpReceipt | null> => null);
  const commit = vi.fn<ErpStore['commit']>(async input => input.receipt);
  const store: ErpStore = { read, receipt: findReceipt, commit };
  const hooks: { configuration?: () => void; authority?: () => void } = {};
  const authority = vi.fn(async () => {
    if (denied) throw denied;
    const captured = structuredClone(current); hooks.authority?.(); return captured;
  });
  const config = vi.fn(async () => { const captured = structuredClone(currentConfig); hooks.configuration?.(); return captured; });
  const taxProvider = vi.fn(async () => null);
  const seller = vi.fn(async () => ({ organizationId, displayName: 'Fictitious public seller' }));
  const issueInvoiceTest = vi.fn<NonNullable<ErpServerDependencies['issueInvoiceTest']>>(async (_execution, input) => ({ receipt: await receipt(input, current.actor.userId), replayed: false }));
  const diagnostic = vi.fn<ErpServerDependencies['diagnostic']>();
  const dependencies: ErpServerDependencies = {
    enabled: vi.fn(async () => open), authority, configuration: config, store: vi.fn(() => store),
    taxProvider, seller, issueInvoiceTest, rateLimit: vi.fn(async () => undefined), diagnostic,
  };
  const handlers = createErpHandlers(dependencies);
  function change(kind: Change) {
    if (kind === 'revoked') denied = new AccountPublicError('PRIVATE_FICTITIOUS_AUTH_DETAIL', 401);
    if (kind === 'user') current.actor = { ...current.actor, userId: 'another-account' };
    if (kind === 'scope') current.actor = { ...current.actor, organizationId: 'another-workspace' };
    if (kind === 'mode') current.mode = 'device';
    if (kind === 'role') current.actor = { ...current.actor, role: 'read_only' };
    if (kind === 'entitlement') current.actor = { ...current.actor, managementEntitled: false };
    if (kind === 'flags') open = false;
    if (kind === 'configuration') currentConfig = { ...currentConfig, language: 'fr' };
  }
  function restore() { open = true; denied = null; current = { mode: 'browser', actor: { ...actor } }; currentConfig = structuredClone(configuration); delete hooks.configuration; delete hooks.authority; }
  function post(input: unknown = invoice, origin = 'https://zentra.test', expectedUser = actor.userId) {
    return new Request(`https://zentra.test/api/international/workspaces/${organizationId}/erp`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Zentra-Expected-User': expectedUser }, body: JSON.stringify(input),
    });
  }
  return { dependencies, handlers, post, change, restore, hooks, read, findReceipt, commit, authority, config, taxProvider, seller, issueInvoiceTest, diagnostic,
    setActor: (value: FinancialAuthority) => { current.actor = value; }, setDevice: () => { current.mode = 'device'; } };
}
async function rejected(response: Response, status: number, error: string) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error });
  expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}
function initializedState(): ErpState {
  const customer = { id: 'customer', organizationId, name: 'Fictitious customer', kind: 'business' as const, billingAddress: configuration.address, paymentTermsDays: 30 };
  return { schemaVersion: 1, revision: 4, configuration, counters: { estimate: 1, invoice: 0 },
    ledger: createLedger({ organizationId, currency: 'USD', basis: 'accrual', accounts: nationalAdapter('US').starterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }),
    customers: [customer], invoices: [], estimates: [{ id: 'estimate', organizationId, revision: 2, currency: 'USD', number: 'EST-000001', customer, date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Fictitious service', quantityUnits: '1', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: '', status: 'accepted' }] };
}

describe('optional private TEST invoice HTTP hook', () => {
  it.each(['owner', 'admin', 'accountant'] as const)('dispatches an admitted %s with only the existing public receipt contract', async role => {
    const t = fixture(); t.setActor({ ...actor, role });
    const response = await t.handlers.POST(t.post(), organizationId);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt: await receipt(), replayed: false });
    expect(t.issueInvoiceTest).toHaveBeenCalledTimes(1);
    const [execution, input] = t.issueInvoiceTest.mock.calls[0];
    expect(Object.keys(execution).sort()).toEqual(['actor', 'configuration', 'revalidate', 'store']); expect(input).toEqual(invoice);
    expect(execution.actor.role).toBe(role); expect(t.read).not.toHaveBeenCalled(); expect(t.commit).not.toHaveBeenCalled(); expect(t.taxProvider).not.toHaveBeenCalled(); expect(t.seller).not.toHaveBeenCalled();
  });
  it.each(['member', 'read_only'] as const)('refuses %s before the private hook or storage factory', async role => {
    const t = fixture(); t.setActor({ ...actor, role });
    await rejected(await t.handlers.POST(t.post(), organizationId), 403, 'financial_permission_required');
    expect(t.issueInvoiceTest).not.toHaveBeenCalled(); expect(vi.mocked(t.dependencies.store)).not.toHaveBeenCalled();
  });
  it('keeps all effects closed when the feature is disabled', async () => {
    const t = fixture(); t.change('flags'); const request = t.post(); const body = vi.spyOn(request, 'body', 'get');
    await rejected(await t.handlers.POST(request, organizationId), 404, 'feature_unavailable');
    expect(t.authority).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled(); expect(t.issueInvoiceTest).not.toHaveBeenCalled(); expect(vi.mocked(t.dependencies.store)).not.toHaveBeenCalled();
  });
  it.each([401, 402, 403])('preserves initial Auth rejection %s before dispatch', async status => {
    const t = fixture(); t.authority.mockRejectedValue(new AccountPublicError('PRIVATE_FICTITIOUS_AUTH_DETAIL', status));
    await rejected(await t.handlers.POST(t.post(), organizationId), status, status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : 'forbidden');
    expect(t.config).not.toHaveBeenCalled(); expect(t.issueInvoiceTest).not.toHaveBeenCalled();
    expect(JSON.stringify(t.diagnostic.mock.calls)).not.toContain('PRIVATE_FICTITIOUS_AUTH_DETAIL');
  });
  it('rejects a stale account form binding before private reads', async () => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post(invoice, undefined, 'another-account'), organizationId), 401, 'session_changed');
    expect(t.config).not.toHaveBeenCalled(); expect(t.issueInvoiceTest).not.toHaveBeenCalled();
  });
  it('requires same-origin browser writes while preserving the admitted device mode', async () => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post(invoice, 'https://foreign.invalid'), organizationId), 403, 'forbidden'); expect(t.issueInvoiceTest).not.toHaveBeenCalled();
    t.setDevice(); expect((await t.handlers.POST(t.post(invoice, 'tauri://localhost'), organizationId)).status).toBe(200); expect(t.issueInvoiceTest).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...invoice, proof: 'PRIVATE_FICTITIOUS_PROOF' },
    { ...invoice, role: 'owner' },
    { ...invoice, command: { ...invoice.command, taxMinor: '0' } },
  ])('refuses client authority or tax fields before the hook', async input => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post(input), organizationId), 422, 'invalid_request'); expect(t.issueInvoiceTest).not.toHaveBeenCalled();
  });
  it('applies the existing HTTP body bound before private dispatch', async () => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post({ ...invoice, private: 'x'.repeat(262144) }), organizationId), 413, 'invalid_request'); expect(t.issueInvoiceTest).not.toHaveBeenCalled();
  });
  it('preserves ordinary ERP commands instead of routing them through the issuer', async () => {
    const t = fixture(); const input: ErpRequest = { idempotencyKey: 'ordinary-initialize', expectedRevision: 0, command: { type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] } };
    const response = await t.handlers.POST(t.post(input), organizationId);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt: await receipt(input), replayed: false }); expect(t.commit).toHaveBeenCalledTimes(1); expect(t.issueInvoiceTest).not.toHaveBeenCalled();
  });
  it('retains the default unavailable provider when no TEST hook is installed', async () => {
    const t = fixture(); delete t.dependencies.issueInvoiceTest; t.read.mockResolvedValue(initializedState());
    await rejected(await t.handlers.POST(t.post(), organizationId), 409, 'tax_configuration_required'); expect(t.taxProvider).toHaveBeenCalledTimes(1); expect(t.issueInvoiceTest).not.toHaveBeenCalled(); expect(t.commit).not.toHaveBeenCalled();
  });
  it('supplies the hook a working fresh admission that blocks effects after flags close', async () => {
    const t = fixture(); let writes = 0;
    t.issueInvoiceTest.mockImplementation(async (execution, input) => {
      t.change('flags'); await execution.revalidate(); writes++; return { receipt: await receipt(input), replayed: false };
    });
    await rejected(await t.handlers.POST(t.post(), organizationId), 404, 'feature_unavailable'); expect(writes).toBe(0); expect(t.commit).not.toHaveBeenCalled();
  });
  it.each(Object.keys(changedResponse) as Change[])('withholds a hook receipt after %s and recovers the same durable fixture receipt after restored admission', async change => {
    const t = fixture(); const original = await receipt(); let writes = 0;
    t.issueInvoiceTest.mockImplementation(async () => { if (writes === 0) { writes++; t.change(change); return { receipt: original, replayed: false }; } return { receipt: original, replayed: true }; });
    await rejected(await t.handlers.POST(t.post(), organizationId), ...changedResponse[change]); expect(writes).toBe(1); expect(t.commit).not.toHaveBeenCalled();
    t.restore(); const response = await t.handlers.POST(t.post(), organizationId);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt: original, replayed: true }); expect(writes).toBe(1); expect(t.issueInvoiceTest.mock.calls.map(call => call[1])).toEqual([invoice, invoice]);
  });
  it('checks the final flag after the last authority await', async () => {
    const t = fixture(); let completed = false;
    t.issueInvoiceTest.mockImplementation(async () => { completed = true; return { receipt: await receipt(), replayed: false }; });
    t.hooks.authority = () => { if (completed) t.change('flags'); };
    await rejected(await t.handlers.POST(t.post(), organizationId), 404, 'feature_unavailable');
  });
  it('checks role after the postflight configuration await', async () => {
    const t = fixture(); let completed = false;
    t.issueInvoiceTest.mockImplementation(async () => { completed = true; return { receipt: await receipt(), replayed: false }; });
    t.hooks.configuration = () => { if (completed) t.change('role'); };
    await rejected(await t.handlers.POST(t.post(), organizationId), 403, 'forbidden');
  });

  const malformed: [string, (value: { receipt: ErpReceipt; replayed: boolean }) => unknown][] = [
    ['private operation at root', value => ({ ...value, proof: 'PRIVATE_FICTITIOUS_PROOF' })],
    ['private SDK metadata at receipt', value => ({ ...value, receipt: { ...value.receipt, lastResponse: { accountId: 'acct_PRIVATE_FICTITIOUS' } } })],
    ['key', value => ({ ...value, receipt: { ...value.receipt, idempotencyKey: 'different' } })],
    ['hash', value => ({ ...value, receipt: { ...value.receipt, commandHash: 'b'.repeat(64) } })],
    ['action', value => ({ ...value, receipt: { ...value.receipt, action: 'save_customer' } })],
    ['invoice identity', value => ({ ...value, receipt: { ...value.receipt, entityId: 'another-invoice' } })],
    ['revision', value => ({ ...value, receipt: { ...value.receipt, revision: 99 } })],
    ['replay flag', value => ({ ...value, replayed: 'yes' })],
    ['hidden data', value => Object.defineProperty(value, 'proof', { value: 'PRIVATE_FICTITIOUS_PROOF', enumerable: false })],
    ['symbol', value => Object.assign(value, { [Symbol('private')]: 'PRIVATE_FICTITIOUS_PROOF' })],
    ['foreign prototype', value => Object.assign(Object.create({ private: 'PRIVATE_FICTITIOUS_PROOF' }), value) as unknown],
  ];
  it.each(malformed)('rejects a malformed hook %s without exposing any private content', async (_label, transform) => {
    const t = fixture(); t.issueInvoiceTest.mockResolvedValue(transform({ receipt: await receipt(), replayed: false }) as Awaited<ReturnType<NonNullable<ErpServerDependencies['issueInvoiceTest']>>>);
    const response = await t.handlers.POST(t.post(), organizationId); expect(response.status).toBe(503); expect(Object.keys(await response.json() as object)).toEqual(['error']); expect(t.authority).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(t.diagnostic.mock.calls)).not.toContain('PRIVATE_FICTITIOUS');
  });
  it('never invokes hook receipt getters and still rechecks Auth before the controlled rejection', async () => {
    const t = fixture(); const getter = vi.fn(() => 'PRIVATE_FICTITIOUS_PROOF'); const invalid = { replayed: false };
    Object.defineProperty(invalid, 'receipt', { enumerable: true, get: getter }); t.issueInvoiceTest.mockResolvedValue(invalid as Awaited<ReturnType<NonNullable<ErpServerDependencies['issueInvoiceTest']>>>);
    const response = await t.handlers.POST(t.post(), organizationId); expect(response.status).toBe(503); expect(getter).not.toHaveBeenCalled(); expect(t.authority).toHaveBeenCalledTimes(2);
  });
  it('lets a fresh Auth denial override an already malformed hook response', async () => {
    const t = fixture(); t.issueInvoiceTest.mockImplementation(async () => { t.change('revoked'); return { receipt: { private: 'PRIVATE_FICTITIOUS_PROOF' }, replayed: false }; });
    await rejected(await t.handlers.POST(t.post(), organizationId), 401, 'unauthorized'); expect(JSON.stringify(t.diagnostic.mock.calls)).not.toContain('PRIVATE_FICTITIOUS');
  });
  it('detaches the valid hook receipt before the final awaited admission', async () => {
    const t = fixture(); const returned = { receipt: { ...await receipt() }, replayed: false }, original = structuredClone(returned); let completed = false;
    t.issueInvoiceTest.mockImplementation(async () => { completed = true; return returned; }); t.hooks.authority = () => { if (completed) returned.receipt.entityId = 'mutated-after-snapshot'; };
    const response = await t.handlers.POST(t.post(), organizationId); expect(response.status).toBe(200); expect(await response.json()).toEqual(original); expect(returned.receipt.entityId).toBe('mutated-after-snapshot');
  });
  it('sanitizes a private hook exception and keeps diagnostics metadata-only', async () => {
    const t = fixture(); t.issueInvoiceTest.mockRejectedValue(new Error('PRIVATE_FICTITIOUS_PROOF acct_PRIVATE_FICTITIOUS'));
    await rejected(await t.handlers.POST(t.post(), organizationId), 503, 'service_unavailable'); expect(t.diagnostic).toHaveBeenCalledWith({ operation: 'write', code: 'service_unavailable', status: 503 });
  });
  it('can dispatch the real issuer historical path without reading current private facts or invoking a gateway', async () => {
    const t = fixture(); const original = await receipt(); t.findReceipt.mockResolvedValue(original);
    const readContext = vi.fn(async () => { throw new Error('Historical replay must not read private heads'); });
    const operations = { read: vi.fn(async () => { throw new Error('Unexpected operation read'); }), reserve: vi.fn(async () => { throw new Error('Unexpected reservation'); }), record: vi.fn(async () => { throw new Error('Unexpected record'); }), commit: vi.fn(async () => { throw new Error('Unexpected commit'); }) };
    const verify = vi.fn(async () => { throw new Error('Unexpected TEST verification'); }), calculate = vi.fn(async () => { throw new Error('Unexpected TEST calculation'); });
    t.issueInvoiceTest.mockImplementation((execution, input) => executeUsTaxInvoiceTest({ erp: execution, contexts: { read: readContext }, operations, gateway: { verify, calculate }, classifications: async () => [], transactionLocation: async () => ({ taxDateInstant: timestamp, addressSource: 'billing' }), operationId: () => 'a7000000-0000-4000-8000-000000000001', now: () => timestamp }, input));
    const response = await t.handlers.POST(t.post(), organizationId); expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt: original, replayed: true });
    expect(t.findReceipt).toHaveBeenCalledTimes(1); expect(t.read).not.toHaveBeenCalled(); expect(readContext).not.toHaveBeenCalled(); expect(operations.read).not.toHaveBeenCalled(); expect(operations.commit).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(calculate).not.toHaveBeenCalled();
  });
});
