import type { FinancialAuthority } from './accounting/ledger';
import { validDate } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { invoiceBalance, lineTotals } from './invoicing';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { ErpState, ErpStore } from './runtime-types';
import { validateStoredErp } from './runtime-validation';
import type { CompanyConfiguration } from './types';
import { prepareUsCustomerCreditAllocation, validateUsCustomerCreditSource } from './us-customer-credit-allocation';
import type { UsCustomerCreditAllocation, UsCustomerCreditSelection, UsCustomerCreditSource } from './us-customer-credit-types';

export interface UsCustomerCreditPreparationRequest {
  readonly expectedErpRevision: number;
  readonly invoiceId: string;
  readonly transactionDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly reason: string;
  readonly selections: readonly UsCustomerCreditSelection[];
}
export type UsCustomerCreditBlocker = 'financial_contract_required' | 'tax_adjustment_required' | 'cash_recognition_policy_required' | 'customer_credit_policy_required';
export interface UsCustomerCreditPreparation {
  readonly schemaVersion: 1;
  readonly status: 'preparation_only';
  readonly canIssue: false;
  readonly financialState: 'unchanged';
  readonly organizationId: string;
  readonly preparedBy: string;
  readonly preparedAt: string;
  readonly sourceErpRevision: number;
  readonly source: UsCustomerCreditSource;
  readonly paymentFingerprint: string;
  readonly request: UsCustomerCreditPreparationRequest;
  readonly allocation: UsCustomerCreditAllocation;
  readonly preparationFingerprint: string;
  readonly accountingBasis: 'cash' | 'accrual';
  readonly taxStatus: 'historical_candidate_only';
  readonly blockers: readonly UsCustomerCreditBlocker[];
  /** Arithmetic at the observed ERP revision only. These are neither new
   * balances nor available credits and must never authorize an encashment. */
  readonly preview: Readonly<{
    receivedMinor: string;
    outstandingBeforeMinor: string;
    receivableReductionCandidateMinor: string;
    outstandingAfterCandidateMinor: string;
    unappliedCreditCandidateMinor: string;
    refundRecordedMinor: '0';
  }>;
}
export interface UsCustomerCreditPreparationDependencies {
  readonly configuration: CompanyConfiguration;
  readonly actor: FinancialAuthority;
  /** Deliberately no commit, receipt, tax provider, payment or mail port. */
  readonly store: Pick<ErpStore, 'read' | 'supportedSchemaVersion'>;
  revalidate(this: void): Promise<Readonly<{
    configuration: CompanyConfiguration;
    actor: FinancialAuthority;
    supportedSchemaVersion: ErpSchemaVersion;
  }>>;
}
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const fail = (code = 'invalid_credit_request', status = 422): never => { throw new ErpError(code, status); };
function detached(input: unknown, code: string, status: number): unknown {
  try { return snapshotPrivateJson(input); } catch { return fail(code, status); }
}
function exact(input: unknown, keys: readonly string[], code = 'invalid_credit_request', status = 422): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return fail(code, status);
  return input as Record<string, unknown>;
}
function text(input: unknown, maximum = 160): string {
  if (typeof input !== 'string' || !input.trim() || input !== input.trim() || input.length > maximum || Array.from(input).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return input;
}
function date(input: unknown): string {
  if (typeof input !== 'string' || input.startsWith('0000-') || !validDate(input)) return fail('invalid_credit_date');
  return input;
}
export function validateUsCustomerCreditPreparationRequest(input: unknown): UsCustomerCreditPreparationRequest {
  const v = exact(detached(input, 'invalid_credit_request', 422), ['expectedErpRevision', 'invoiceId', 'transactionDate', 'accountingDate', 'periodId', 'reason', 'selections']);
  if (typeof v.expectedErpRevision !== 'number' || !Number.isSafeInteger(v.expectedErpRevision) || v.expectedErpRevision < 1 || v.expectedErpRevision >= Number.MAX_SAFE_INTEGER || !Array.isArray(v.selections) || v.selections.length < 1 || v.selections.length > 1000) return fail();
  const ids = new Set<string>();
  const selections = v.selections.map(input => {
    const row = exact(input, ['lineId', 'quantityUnits']), lineId = text(row.lineId);
    if (ids.has(lineId) || typeof row.quantityUnits !== 'string' || !/^[1-9][0-9]{0,35}$/.test(row.quantityUnits)) return fail('invalid_credit_selection');
    ids.add(lineId);
    return Object.freeze({ lineId, quantityUnits: row.quantityUnits });
  });
  return Object.freeze({ expectedErpRevision: v.expectedErpRevision, invoiceId: text(v.invoiceId), transactionDate: date(v.transactionDate), accountingDate: date(v.accountingDate), periodId: text(v.periodId), reason: text(v.reason, 500), selections: Object.freeze(selections) });
}
function configuration(input: unknown, organizationId: string): CompanyConfiguration {
  let value: CompanyConfiguration;
  try { value = validateCompanyConfiguration(detached(input, 'service_unavailable', 503)); } catch { return fail('service_unavailable', 503); }
  if (value.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (value.country !== 'US' || value.currency !== 'USD') return fail('edition_unavailable', 409);
  return value;
}
function authority(input: unknown, organizationId: string): FinancialAuthority {
  const v = exact(detached(input, 'service_unavailable', 503), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'], 'service_unavailable', 503) as unknown as FinancialAuthority;
  if (typeof v.organizationId !== 'string' || !v.organizationId.trim() || v.organizationId !== v.organizationId.trim() || v.organizationId.length > 160 || Array.from(v.organizationId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail('service_unavailable', 503);
  if (v.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (v.managementEntitled !== true) return fail('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(v.role)) return fail('financial_permission_required', 403);
  try {
    text(v.userId, 256);
    if (typeof v.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v.timestamp)) return fail('service_unavailable', 503);
    parseInstant(v.timestamp);
  } catch { return fail('service_unavailable', 503); }
  return v;
}
function stateAtRevision(input: unknown, organizationId: string, request: UsCustomerCreditPreparationRequest, config: CompanyConfiguration): ErpState {
  if (input === null) return fail('workspace_not_initialized', 409);
  const state = validateStoredErp(detached(input, 'invalid_stored_state', 503), organizationId);
  if (state.schemaVersion !== 4) return fail('credit_preparation_upgrade_required', 409);
  if (state.revision !== request.expectedErpRevision) return fail('revision_conflict', 409);
  if (!same(state.configuration, config)) return fail('configuration_changed', 409);
  return state;
}
/** Internal read-only preparation, not a financial command or public API.
 * No caller-supplied proof can turn canIssue into true. All current schema4
 * books remain blocked until the complete financial capability is delivered. */
export async function prepareUsCustomerCredit(dependencies: UsCustomerCreditPreparationDependencies, input: unknown): Promise<UsCustomerCreditPreparation> {
  // Capture caller-owned objects before the first await, including authority.
  const request = validateUsCustomerCreditPreparationRequest(input);
  const rawActor = detached(dependencies.actor, 'service_unavailable', 503) as FinancialAuthority;
  const actor = authority(rawActor, rawActor?.organizationId);
  const config = configuration(dependencies.configuration, actor.organizationId);
  if (dependencies.store.supportedSchemaVersion !== 4) return fail('credit_preparation_upgrade_required', 409);
  let lastActor = actor;
  async function current(): Promise<FinancialAuthority> {
    const fresh = exact(detached(await dependencies.revalidate(), 'service_unavailable', 503), ['configuration', 'actor', 'supportedSchemaVersion'], 'service_unavailable', 503);
    // Recheck authority first so an unavailable configuration cannot disclose
    // stale facts after a concurrent revocation.
    const admitted = authority(fresh.actor, actor.organizationId);
    if (admitted.userId !== actor.userId) return fail('session_changed', 401);
    if (admitted.role !== actor.role) return fail('financial_authority_changed', 403);
    if (Date.parse(admitted.timestamp) < Date.parse(lastActor.timestamp)) return fail('credit_clock_reversed', 409);
    if (fresh.supportedSchemaVersion !== 4 || dependencies.store.supportedSchemaVersion !== 4) return fail('credit_preparation_upgrade_required', 409);
    if (!same(configuration(fresh.configuration, actor.organizationId), config)) return fail('configuration_changed', 409);
    lastActor = admitted;
    return admitted;
  }
  async function read(): Promise<ErpState> {
    await current();
    let result: unknown, failure: unknown, failed = false;
    try { result = detached(await dependencies.store.read(actor.organizationId), 'invalid_stored_state', 503); }
    catch (error) { failed = true; failure = error; }
    await current();
    if (failed) throw failure;
    return stateAtRevision(result, actor.organizationId, request, config);
  }
  const state = await read();
  const invoice = state.invoices.find(invoice => invoice.id === request.invoiceId);
  if (!invoice) return fail('invoice_not_found', 404);
  if (request.transactionDate < invoice.date) return fail('credit_precedes_invoice', 422);
  if (Date.parse(lastActor.timestamp) < Date.parse(invoice.issuedAt)) return fail('credit_clock_reversed', 409);
  const period = state.ledger.periods.find(period => period.id === request.periodId);
  if (!period || period.status !== 'open' || request.accountingDate < period.start || request.accountingDate > period.end) return fail('accounting_period_not_open', 409);
  const { payments, ...immutableInvoice } = invoice;
  const invoiceFingerprint = await sha256Hex(canonicalErpJson(immutableInvoice));
  const paymentFingerprint = await sha256Hex(canonicalErpJson(payments));
  const sourceLines = await Promise.all(invoice.lines.map(async line => {
    const proof = invoice.taxAssessment.lines.find(proof => proof.id === line.id);
    if (!proof) return fail('invalid_stored_state', 503);
    // A provider evidence reference can embed its private calculation/line
    // identifiers. Retain a stable digest, not that raw reference, even in
    // this internal preparation. A future fiscal port must read the original.
    const evidenceReference = `sha256:${await sha256Hex(proof.evidenceReference)}`;
    return { lineId: line.id, quantityUnits: line.quantityUnits, quantityScale: line.quantityScale, netMinor: lineTotals(line, invoice.currency).net.minorUnits, taxMinor: proof.taxMinor, jurisdiction: proof.jurisdiction, evidenceReference };
  }));
  const source = validateUsCustomerCreditSource({
    schemaVersion: 1, organizationId: actor.organizationId, invoiceId: invoice.id, invoiceNumber: invoice.number,
    customerId: invoice.customer.id, currency: 'USD', invoiceFingerprint,
    lines: sourceLines,
  });
  // Schemas1–4 cannot contain issued credit notes. A request cannot supply an
  // invented previous credit or an approval/tax adjustment to bypass this.
  const allocation = prepareUsCustomerCreditAllocation(source, request.selections);
  const outstanding = BigInt(invoiceBalance(invoice).minorUnits), total = BigInt(invoice.total.minorUnits), credit = BigInt(allocation.totalMinor);
  const reduction = credit < outstanding ? credit : outstanding;
  const excess = credit - reduction;
  const blockers: UsCustomerCreditBlocker[] = ['financial_contract_required'];
  if (allocation.lines.some(line => source.lines.find(source => source.lineId === line.lineId)?.taxMinor !== '0')) blockers.push('tax_adjustment_required');
  if (config.accountingBasis === 'cash') blockers.push('cash_recognition_policy_required');
  if (excess > BigInt(0)) blockers.push('customer_credit_policy_required');
  const preparationFingerprint = await sha256Hex(canonicalErpJson([actor.organizationId, actor.userId, state.revision, request, source, paymentFingerprint, allocation, blockers]));
  // Re-read the real book after asynchronous hashing. A same-revision altered
  // payload is also refused; a revision alone is not a content proof.
  const freshState = await read();
  if (!same(freshState, state)) return fail('credit_source_changed', 409);
  const preparedBy = await current();
  return Object.freeze({ schemaVersion: 1, status: 'preparation_only', canIssue: false, financialState: 'unchanged', organizationId: actor.organizationId,
    preparedBy: preparedBy.userId, preparedAt: preparedBy.timestamp, sourceErpRevision: state.revision, source, paymentFingerprint, request, allocation, preparationFingerprint,
    accountingBasis: config.accountingBasis, taxStatus: 'historical_candidate_only', blockers: Object.freeze(blockers),
    preview: Object.freeze({ receivedMinor: (total - outstanding).toString(), outstandingBeforeMinor: outstanding.toString(), receivableReductionCandidateMinor: reduction.toString(), outstandingAfterCandidateMinor: (outstanding - reduction).toString(), unappliedCreditCandidateMinor: excess.toString(), refundRecordedMinor: '0' }),
  });
}
