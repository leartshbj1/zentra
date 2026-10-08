import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { usStarterChart } from './countries/us/accounting';
import { canonicalErpJson, ErpError } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { validateUsSupplierExtraction, US_SUPPLIER_FIELDS } from './us-supplier-extraction';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { createUsSupplierHandlers, type UsSupplierServerDependencies } from './us-supplier-server';
import type { UsSupplierApprovalRequest, UsSupplierProposal, UsSupplierRecording, UsSupplierStore } from './us-supplier-contract';
import type { ErpCommit, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';

const org = '54b7ee3b-5753-4af1-98f6-b2a568fb3890', user = '53e1704e-9cc6-431b-ac4d-2186c5fe5f6d', proposalId = 'af6e5eae-23c8-4535-bb3c-a8eafc1bf8a7';
const actor: FinancialAuthority = { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const documentText = 'Supplier: Harbor Supplies LLC\nInvoice Number US-1043\nInvoice Date: 04/05/2026\nDue Date: May 5, 2026\nCurrency: USD\nSubtotal 1,000.00\nSales Tax 82.50\nTotal USD 1,082.50';
const extraction = validateUsSupplierExtraction({ schemaVersion: 1, kind: 'vendor_invoice', confidence: 0.99,
  fields: { supplierName: 'Harbor Supplies LLC', reference: 'US-1043', invoiceDate: '2026-04-05', dueDate: '2026-05-05', currency: 'USD', netMinor: '100000', printedTaxMinor: '8250', totalMinor: '108250' },
  evidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 'Printed fixture evidence'])), fieldConfidence: Object.fromEntries(US_SUPPLIER_FIELDS.map(field => [field, 0.99])), issues: [] });
const approval: UsSupplierApprovalRequest = { schemaVersion: 1, idempotencyKey: '4b4b7b38-3138-456e-baf1-b05fc767cb93', proposalId, expectedProposalRevision: 0, expectedErpRevision: 10, confirmed: true, taxReviewed: true,
  review: { vendorId: 'vendor-existing', reference: 'US-1043-REVIEWED', date: '2026-04-05', accountingDate: '2026-04-06', dueDate: '2026-05-05', periodId: '2026', netMinor: '100000', printedTaxMinor: '8250' } };

/** Actual HTTP and ERP engine; fictitious admission and in-memory transaction.
 * Independent PostgreSQL tests cover durable atomicity and RLS. */
function fixture(basis: 'accrual' | 'cash' = 'accrual') {
  const config = { ...configuration, accountingBasis: basis };
  let state: ErpState = { schemaVersion: 4, revision: 10, configuration: config, counters: { estimate: 0, invoice: 0, project: 0 },
    ledger: createLedger({ organizationId: org, currency: 'USD', basis, accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }),
    customers: [], estimates: [], invoices: [], projects: [], vendorBills: [], vendorPayments: [], vendors: [{ id: 'vendor-existing', organizationId: org, kind: 'business', name: 'Harbor Supplies LLC', billingAddress: config.address, paymentTermsDays: 30 }] };
  const rows = new Map<string, UsSupplierProposal>(), events: ErpCommit[] = [];
  const erpStore: ErpStore = { supportedSchemaVersion: 4, read: vi.fn(async () => structuredClone(state)), receipt: vi.fn(async () => null), commit: vi.fn(async () => { throw new Error('Standalone commit forbidden'); }) };
  const supplierStore: UsSupplierStore = { supportedSchemaVersion: 4,
    list: vi.fn(async () => structuredClone([...rows.values()])),
    read: vi.fn(async (_actor, id) => structuredClone(rows.get(id) ?? null)),
    findSource: vi.fn(async (_actor, hash) => structuredClone([...rows.values()].find(row => row.source.sha256 === hash) ?? null)),
    create: vi.fn(async (_actor, proposal) => { rows.set(proposal.id, structuredClone(proposal)); return structuredClone(proposal); }),
    approve: vi.fn(async (input: Parameters<UsSupplierStore['approve']>[0]) => {
      const proposal = rows.get(input.request.proposalId)!;
      if (proposal.state !== 'review' || state.revision !== input.erp.expectedRevision) throw new ErpError('supplier_revision_conflict', 409);
      const recording: UsSupplierRecording = { idempotencyKey: input.request.idempotencyKey, requestHash: input.requestHash, by: input.actor.userId, at: input.actor.timestamp, review: input.request.review, erpReceipt: input.erp.receipt };
      const after = validateUsSupplierProposal({ ...proposal, revision: 1, state: 'recorded', recording }, org);
      const commits = input.erp.changes;
      const bills = commits.filter(row => row.kind === 'vendor_bill').map(row => row.payload) as NonNullable<ErpState['vendorBills']>;
      const entries = commits.filter(row => row.kind === 'journal').map(row => row.payload) as ErpState['ledger']['entries'];
      state = { ...state, ...input.erp.header, ledger: { ...input.erp.header.ledger, entries: [...state.ledger.entries, ...entries], audit: [...state.ledger.audit, ...input.erp.ledgerAudit] }, vendorBills: [...state.vendorBills!, ...bills] };
      events.push(structuredClone(input.erp)); rows.set(proposal.id, after); return structuredClone(recording);
    }),
  };
  const analyze = vi.fn(async () => structuredClone(extraction));
  const dependencies: UsSupplierServerDependencies = { enabled: () => true, authority: vi.fn(async () => ({ mode: 'browser' as const, actor: structuredClone(actor) })), configuration: vi.fn(async () => structuredClone(config)), store: () => erpStore,
    supplierStore: () => supplierStore, freshSupportedSchemaVersion: () => 4, automationAccess: vi.fn(async () => {}), analyzer: vi.fn(async () => analyze), newId: () => proposalId, diagnostic: vi.fn(), rateLimit: vi.fn(async () => {}) };
  const handlers = createUsSupplierHandlers(dependencies), url = `https://zentra.test/api/international/workspaces/${org}/supplier-proposals`;
  const post = (input: unknown = { schemaVersion: 1, action: 'prepare', consent: true, fileName: 'fictitious.txt', documentText }, origin = 'https://zentra.test', cap = '4') => new Request(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Zentra-Erp-Schema-Version': cap, 'X-Zentra-Expected-User': user }, body: JSON.stringify(input) });
  const get = (cap = '4') => new Request(url, { headers: { 'X-Zentra-Erp-Schema-Version': cap, 'X-Zentra-Expected-User': user } });
  const prepare = () => handlers.POST(post(), org);
  const approve = (input: unknown = approval) => handlers.POST(post({ schemaVersion: 1, action: 'approve', request: input }), org);
  return { dependencies, handlers, supplierStore, erpStore, analyze, rows, events, post, get, prepare, approve, state: () => state, replaceState: (value: ErpState) => { state = value; } };
}
async function rejected(response: Response, code: string, status: number) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
  expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}
describe('US supplier proposal source, review and financial engine', () => {
  it('reads a fresh empty registry, then stores a bounded source with no financial change', async () => {
    const t = fixture(), original = canonicalErpJson(t.state());
    expect(await (await t.handlers.GET(t.get(), org)).json()).toEqual({ schemaVersion: 1, organizationId: org, erpRevision: 10, proposals: [] });
    const response = await t.prepare(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: false, proposal: { state: 'review', revision: 0, source: { sha256: await sha256Hex(documentText), documentText } } });
    expect(canonicalErpJson(t.state())).toBe(original); expect(t.events).toHaveLength(0); expect(t.erpStore.commit).not.toHaveBeenCalled();
  });
  it.each(['accrual', 'cash'] as const)('records explicit corrected values with %s accounting using the existing ERP', async basis => {
    const t = fixture(basis); await t.prepare(); const response = await t.approve(); expect(response.status).toBe(200);
    const result = await response.json(); expect(result).toMatchObject({ replayed: false, recording: { by: user, review: approval.review, erpReceipt: { action: 'record_vendor_bill', revision: 11, entityId: `us-mail-bill:${proposalId}` } } });
    expect(t.state().vendorBills).toHaveLength(1); expect(t.state().vendorBills![0]).toMatchObject({ reference: 'US-1043-REVIEWED', approvalSource: 'manual_entry', validatedBy: user, net: { minorUnits: '100000' }, tax: { minorUnits: '8250' }, total: { minorUnits: '108250' } });
    expect(t.events).toHaveLength(1); expect(t.events[0].changes.some(row => row.kind === 'journal')).toBe(basis === 'accrual');
    expect(t.state().ledger.entries.length).toBe(basis === 'accrual' ? 1 : 0); expect(t.state().ledger.entries.flatMap(entry => entry.lines).some(line => /vat|tax_receivable/.test(line.accountId))).toBe(false);
    expect(t.rows.get(proposalId)?.extraction.fields.reference).toBe('US-1043'); expect(t.erpStore.commit).not.toHaveBeenCalled();
  });
  it('deduplicates source before analysis and preserves its original filename', async () => {
    const t = fixture(); await t.prepare(); const response = await t.handlers.POST(t.post({ schemaVersion: 1, action: 'prepare', consent: true, fileName: 'renamed.txt', documentText }), org);
    expect(await response.json()).toMatchObject({ replayed: true, proposal: { source: { fileName: 'fictitious.txt' } } }); expect(t.analyze).toHaveBeenCalledTimes(1); expect(t.rows.size).toBe(1);
  });
  it('recovers the original approval after later ERP changes without another journal', async () => {
    const t = fixture(); await t.prepare(); const first = await (await t.approve()).json() as Record<string, unknown>; t.replaceState({ ...t.state(), revision: 99 });
    expect(await (await t.approve()).json()).toEqual({ ...first, replayed: true }); expect(t.events).toHaveLength(1); expect(t.state().revision).toBe(99);
    await rejected(await t.approve({ ...approval, review: { ...approval.review, netMinor: '1' } }), 'supplier_idempotency_conflict', 409);
  });
  it('uses a server-generated final ERP stamp while independently rechecking advancing Auth clocks', async () => {
    const t = fixture(); await t.prepare(); let count = 0;
    t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, timestamp: new Date(Date.parse(actor.timestamp) + (++count * 1000)).toISOString() } });
    expect((await t.approve()).status).toBe(200); const erp = t.events[0]; expect(erp.actor.timestamp).not.toBe(actor.timestamp);
    expect(t.rows.get(proposalId)?.recording?.at).toBe(erp.actor.timestamp); expect(t.state().vendorBills![0].approvedAt).toBe(erp.actor.timestamp);
  });
  it('withholds a committed reply after rights are revoked and recovers it on an exact authorized retry', async () => {
    const t = fixture(); await t.prepare(); const original = t.supplierStore.approve; let revoked = false;
    t.supplierStore.approve = async value => { const result = await original(value); revoked = true; return result; };
    t.dependencies.automationAccess = async () => { if (revoked) throw new ErpError('automation_entitlement_required', 402); };
    await rejected(await t.approve(), 'automation_entitlement_required', 402); expect(t.events).toHaveLength(1);
    revoked = false; expect(await (await t.approve()).json()).toMatchObject({ replayed: true }); expect(t.events).toHaveLength(1);
  });
  it.each(['revoked', 'user', 'role', 'mode', 'automation', 'country', 'flag'] as const)('rejects delayed source work after %s changes', async change => {
    const t = fixture(), original = t.dependencies.authority;
    t.analyze.mockImplementation(async () => {
      if (change === 'revoked') t.dependencies.authority = async () => { throw new AccountPublicError('SECRET', 401); };
      if (change === 'user') t.dependencies.authority = async () => ({ ...await original(t.get(), org), actor: { ...actor, userId: 'someone-else' } });
      if (change === 'role') t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, role: 'read_only' } });
      if (change === 'mode') t.dependencies.authority = async () => ({ mode: 'device', actor });
      if (change === 'automation') t.dependencies.automationAccess = async () => { throw new ErpError('automation_entitlement_required', 402); };
      if (change === 'country') t.dependencies.configuration = async () => ({ ...configuration, timeZone: 'America/Chicago' });
      if (change === 'flag') t.dependencies.enabled = () => false;
      return structuredClone(extraction);
    });
    const response = await t.prepare(); expect(response.status).toBe(change === 'role' ? 403 : change === 'automation' ? 402 : change === 'country' ? 409 : change === 'flag' ? 404 : 401);
    expect(JSON.stringify(await response.json())).not.toContain('Harbor'); expect(t.rows.size).toBe(0); expect(t.events).toHaveLength(0);
  });
  it.each([1, 2, 3])('refuses older protocol%s before proposals', async cap => {
    const t = fixture(); await rejected(await t.handlers.GET(t.get(String(cap)), org), 'supplier_upgrade_required', 409); expect(t.supplierStore.list).not.toHaveBeenCalled();
  });
  it('denies cross-origin requests, another tenant and missing Automation before provider access', async () => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post(undefined, 'https://evil.test'), org), 'forbidden', 403);
    await rejected(await t.handlers.POST(t.post(), 'b7a66481-43f4-4f92-bbce-5c3a477f9995'), 'tenant_mismatch', 403);
    t.dependencies.automationAccess = async () => { throw new ErpError('automation_entitlement_required', 402); };
    await rejected(await t.prepare(), 'automation_entitlement_required', 402); expect(t.analyze).not.toHaveBeenCalled();
  });
  it.each([
    { consent: false }, { documentText: 'é'.repeat(8193) }, { documentText: 'text\u0000secret' }, { fileName: 'bad\nname' }, { role: 'owner' }, { source: { sha256: 'a'.repeat(64) } },
  ])('rejects malformed or caller-supplied source/authority %j', async patch => {
    const t = fixture(); const response = await t.handlers.POST(t.post({ schemaVersion: 1, action: 'prepare', consent: true, fileName: 'x.txt', documentText, ...patch }), org);
    expect(response.status).toBe(422); expect(t.rows.size).toBe(0); expect(t.analyze).not.toHaveBeenCalled();
  });
  it.each(['confirmed', 'taxReviewed'] as const)('requires explicit human review %s', async flag => {
    const t = fixture(); await t.prepare(); await rejected(await t.approve({ ...approval, [flag]: false }), 'supplier_review_required', 422); expect(t.events).toHaveLength(0);
  });
  it('rejects a changed ERP revision, missing vendor and closed accounting period without partial approval', async () => {
    const t = fixture(); await t.prepare();
    await rejected(await t.approve({ ...approval, expectedErpRevision: 9 }), 'supplier_erp_revision_conflict', 409);
    await rejected(await t.approve({ ...approval, review: { ...approval.review, vendorId: 'unknown' } }), 'vendor_required', 422);
    await rejected(await t.approve({ ...approval, review: { ...approval.review, periodId: 'closed' } }), 'accounting_period_not_open', 409);
    expect(t.events).toHaveLength(0); expect(t.rows.get(proposalId)?.state).toBe('review');
  });
  it('leaves the real analysis unavailable unless a quota-metered trusted port is installed', async () => {
    const t = fixture(); t.dependencies.analyzer = async () => null;
    await rejected(await t.prepare(), 'supplier_analysis_unavailable', 503); expect(t.analyze).not.toHaveBeenCalled(); expect(t.rows.size).toBe(0);
  });
  it.each(['EUR', 'CHF', 'CAD'])('keeps a detected %s source for review without converting or recording it as USD', async currency => {
    const t = fixture(); t.analyze.mockImplementation(async () => structuredClone(validateUsSupplierExtraction({ ...extraction, fields: { ...extraction.fields, currency } })));
    expect((await t.prepare()).status).toBe(200);
    await rejected(await t.approve(), 'supplier_currency_unsupported', 422);
    expect(t.events).toHaveLength(0); expect(t.rows.get(proposalId)?.state).toBe('review');
  });
  it('sanitizes private errors and diagnostics, and withholds stale read projections', async () => {
    const t = fixture(); t.supplierStore.list = async () => { throw new Error('SECRET API TOKEN'); };
    await rejected(await t.handlers.GET(t.get(), org), 'service_unavailable', 503);
    expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toContain('SECRET');
    t.supplierStore.list = async () => { t.replaceState({ ...t.state(), revision: 11 }); return []; };
    await rejected(await t.handlers.GET(t.get(), org), 'supplier_erp_revision_conflict', 409);
  });
});
