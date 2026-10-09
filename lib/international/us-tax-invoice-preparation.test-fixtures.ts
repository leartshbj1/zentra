import { vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { nationalAdapter } from './countries/adapters';
import type { ErpRequest, ErpState, ErpStore } from './runtime-types';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import type { ResolvedUsTaxTestMerchant } from './us-tax-merchant-resolver';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import { createSupabaseUsTaxInvoicePreparationStore, type UsTaxInvoicePreparation } from './us-tax-invoice-preparation-store';
import type { UsTaxMerchantStore } from './us-tax-merchant-store';

/** Test-only fake ports; no Auth, database or provider calls. The real private
 * preparation serializer/validator is used on both sides of the fake RPC. */
export function invoicePreparationFixture() {
  const organizationId = 'fictitious-preparation', start = Date.parse('2026-10-10T12:00:00.000Z');
  let time = start, enabled = true, revoked = false, merchantAvailable = true, fingerprint = 'a'.repeat(64), role = 'accountant';
  const now = () => new Date(time).toISOString();
  const actor = { organizationId, userId: 'fictitious-accountant', role: 'accountant' as const, managementEntitled: true, timestamp: now() };
  const address = { country: 'US' as const, line1: '123 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
  const configuration = { schemaVersion: 1 as const, organizationId, country: 'US' as const, currency: 'USD' as const, language: 'en' as const, timeZone: 'America/New_York', address, accountingBasis: 'accrual' as const, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' as const } };
  const estimate = { id: 'estimate', organizationId, revision: 2, currency: 'USD' as const, number: 'EST-000001', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, notes: '', status: 'accepted' as const, customer: { id: 'customer', organizationId, kind: 'business' as const, name: 'Fictitious Customer', billingAddress: address, shippingAddress: { ...address, line1: '456 Fictitious Destination' }, paymentTermsDays: 30 }, lines: [{ id: 'line', description: 'Fictitious reviewed service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD' as const, minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' as const }] };
  const context: UsTaxFinancialContext = { organizationId, actor, recordedAt: now(), countryRevision: 1, configuration, sellerRevision: 1, seller: { displayName: 'Fictitious Seller', contactEmail: 'seller@example.test' }, taxFactsRevision: 1, taxFacts: { schemaVersion: 1, legalName: 'PRIVATE Fictitious Entity', taxOrigin: address, timeZone: 'America/New_York' }, binding: { organizationId, accountId: 'acct_FictitiousPreparation', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: new Date(start - 30_000).toISOString(), validUntil: new Date(start + 90_000).toISOString(), evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' } };
  let state: ErpState = { schemaVersion: 4, revision: 4, configuration, counters: { estimate: 1, invoice: 0, project: 0 }, customers: [estimate.customer], estimates: [estimate], invoices: [], vendors: [], vendorBills: [], vendorPayments: [], projects: [], ledger: createLedger({ organizationId, currency: 'USD', basis: 'accrual', accounts: nationalAdapter('US').starterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }) };
  const request: ErpRequest = { idempotencyKey: 'reviewed-invoice', expectedRevision: 4, command: { type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-10', periodId: '2026' } };
  const choices = { classifications: [{ lineId: 'line', taxCode: 'txcd_99999999', confirmedService: true as const }], taxDateInstant: now(), addressSource: 'billing' as const };
  let saved: UsTaxInvoicePreparation | null = null, createFailure = false;
  const rpc = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'zentra_read_us_tax_invoice_preparation') return structuredClone(saved);
    if (name !== 'zentra_create_us_tax_invoice_preparation') throw new Error('Unexpected RPC');
    saved = { ...JSON.parse(input.p_preparation_body as string), preparationSha256: input.p_preparation_sha256, preparedAt: now() } as UsTaxInvoicePreparation;
    if (createFailure) { createFailure = false; throw new Error('PRIVATE lost response'); }
    return structuredClone(saved);
  });
  const preparationStore = createSupabaseUsTaxInvoicePreparationStore({ rpc } as never, { supportedSchemaVersion: 4 });
  const erpStore: ErpStore = { supportedSchemaVersion: 4, read: vi.fn(async () => structuredClone(state)), receipt: vi.fn(async () => null), commit: vi.fn(async () => { throw new Error('No ERP write expected'); }) };
  const gateway = { verify: vi.fn(async () => {}), calculate: vi.fn(async () => { throw new Error('PRIVATE No calculation expected'); }) };
  const catalogue = { readTaxCode: vi.fn(async (id: string) => ({ id, name: 'Fictitious catalogue code', description: 'Technical existence only; human applicability still required' })), listTaxCodes: vi.fn(async () => ({ taxCodes: [{ id: 'txcd_99999999', name: 'Fictitious catalogue code', description: 'Technical catalogue entry' }], hasMore: false, nextCursor: null as string | null })) };
  const merchant = vi.fn(async (): Promise<ResolvedUsTaxTestMerchant | null> => merchantAvailable ? { credential: { reference: 'fictitious-merchant', revision: 1, accountId: context.binding.accountId }, configurationFingerprint: fingerprint, gateway, catalogue, observe: vi.fn() } : null);
  const merchantStore = { readCredential: vi.fn(async () => ({ credential: { reference: 'fictitious-merchant', revision: 1, accountId: context.binding.accountId }, configurationFingerprint: fingerprint })) } as unknown as UsTaxMerchantStore;
  const authority = vi.fn(async () => { if (revoked) throw new AccountPublicError('PRIVATE revoked', 401); return { mode: 'browser' as const, actor: { ...actor, role: role as typeof actor.role, timestamp: now() } }; });
  const dependencies = { enabled: vi.fn(async () => enabled), authority, configuration: vi.fn(async () => configuration), freshSupportedSchemaVersion: vi.fn(async () => 4 as const), rateLimit: vi.fn(async () => {}), diagnostic: vi.fn(), merchant, merchantStore: vi.fn(async () => merchantStore), contexts: vi.fn(async () => ({ read: vi.fn(async (admitted: FinancialAuthority) => structuredClone({ ...context, actor: admitted, recordedAt: now() })) })), preparations: vi.fn(async () => preparationStore), erpStore: vi.fn(async () => erpStore), now };
  const http = (body: unknown = { request, choices }, query = '', method = 'POST') => new Request(`https://zentra.example/api/international/workspaces/${organizationId}/${method === 'POST' ? 'tax-invoice-preparation' : 'tax-catalogue'}${query}`, { method, headers: { Origin: 'https://zentra.example', 'Content-Type': 'application/json', 'X-Zentra-Erp-Schema-Version': '4' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  return { organizationId, actor, configuration, context, estimate, request, choices, dependencies, erpStore, preparationStore, rpc, gateway, catalogue, merchantStore, http, saved: () => structuredClone(saved), advance: (ms: number) => { time += ms; }, revoke: () => { revoked = true; }, disable: () => { enabled = false; }, rotate: () => { fingerprint = 'd'.repeat(64); }, removeMerchant: () => { merchantAvailable = false; }, setRole: (value: string) => { role = value; }, loseCreateResponse: () => { createFailure = true; }, editState: (edit: (value: ErpState) => ErpState) => { state = edit(state); }, execution: () => ({ store: erpStore, configuration, actor, revalidate: async () => (await authority()).actor }), state: () => structuredClone(state) };
}
