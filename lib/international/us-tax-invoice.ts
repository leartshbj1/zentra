import { AccountPublicError, sha256Hex } from '../account-security';
import { LedgerError, type FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { buildTaxRequest, validatePublicSellerSnapshot, type Estimate } from './invoicing';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { executeErp, type ErpExecutionDependencies } from './runtime';
import { validateErpReceipt } from './runtime-store';
import type { ErpCommand, ErpReceipt, ErpState } from './runtime-types';
import { validateStripeTaxCalculation, validateStoredStripeTaxCalculation, StripeTaxCalculationError, type StripeTaxCalculationObservation, type ValidatedStripeTaxCalculation } from './stripe-tax-calculation';
import { prepareStripeTaxResolvedRequest, validateResolvedStripeTaxRequest, StripeTaxResolvedRequestError, type ResolvedStripeTaxRequest, type StripeTaxServiceClassification } from './stripe-tax-resolved-request';
import type { UsTaxFinancialContext, UsTaxFinancialContextReader } from './us-tax-financial-context';
import type { StoredUsTaxOperation, UsTaxOperationStore } from './us-tax-operation-store';

type InvoiceCommand = Extract<ErpCommand, { type: 'issue_invoice' }>;
/** Injected trusted server gateway. verify must observe the scoped TEST account,
 * origin, settings, registrations and classifications; DTO hashes or SDK headers
 * alone are not authentication or a legal determination. No default gateway. */
export interface UsTaxInvoiceTestGateway {
  verify(context: UsTaxFinancialContext): Promise<void>;
  calculate(resolved: ResolvedStripeTaxRequest): Promise<StripeTaxCalculationObservation>;
}
export interface UsTaxInvoiceTestDependencies {
  readonly erp: Pick<ErpExecutionDependencies, 'store' | 'configuration' | 'actor' | 'revalidate'>;
  readonly contexts: UsTaxFinancialContextReader;
  readonly operations: UsTaxOperationStore;
  readonly gateway: UsTaxInvoiceTestGateway;
  /** Fresh, explicitly confirmed classifications, in stable line order. */
  classifications(context: UsTaxFinancialContext, estimate: Estimate): Promise<readonly StripeTaxServiceClassification[]>;
  /** Only a new operation resolves its explicit invoice instant/location.
   * A retry retains the saved date, source address, parameters and provider key. */
  transactionLocation(context: UsTaxFinancialContext, command: InvoiceCommand): Promise<Readonly<{ taxDateInstant: string; addressSource: 'billing' | 'shipping' }>>;
  operationId(): string;
  now(): string;
  /** Explicit fixture injection for local QA only; defaults to false. */
  readonly allowTestFixtures?: boolean;
}
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const publicErpFailures: Readonly<Record<string, number>> = Object.freeze({
  invalid_stored_tax_operation: 503, session_changed: 401, unauthorized: 401,
  management_entitlement_required: 402, financial_permission_required: 403, forbidden: 403,
  service_unavailable: 503, country_configuration_required: 409, edition_unavailable: 409,
  tax_configuration_changed: 409, tax_binding_unavailable: 409, tax_classification_changed: 409,
  revision_conflict: 409, tax_operation_expired: 409, server_clock_unavailable: 503,
  invalid_tax_date: 422, invalid_request: 422, feature_unavailable: 404, idempotency_conflict: 409,
  configuration_changed: 409, estimate_revision_conflict: 409, estimate_not_found: 404,
  invoice_already_issued: 409, workspace_not_initialized: 409, accounting_period_not_open: 409,
  number_sequence_exhausted: 409, seller_configuration_required: 409, tax_details_required: 409,
  binding_unavailable: 409, financial_authority_changed: 403, invalid_financial_context: 503,
  invalid_state: 422, immutable_record: 409, workspace_unavailable: 409, invalid_tax_operation: 422,
  tax_operation_conflict: 409, event_too_large: 413, tenant_mismatch: 403,
  invalid_stored_state: 503, invalid_receipt: 503, tax_configuration_required: 409,
  estimate_acceptance_required: 409, invalid_date: 422,
  invalid_tax_calculation: 409, tax_calculation_expired: 409, tax_binding_changed: 409,
  unsupported_tax_calculation: 409, unsupported_tax_request: 422,
  invoice_permission_required: 403, tax_assessment_expired: 409, stale_tax_assessment: 409,
  client_upgrade_required: 409, accounting_period_closed: 409,
  tax_preparation_required: 409, tax_preparation_changed: 409,
  tax_preparation_expired: 409, invalid_tax_preparation: 422,
  invalid_stored_tax_preparation: 503,
});
function invalid(): never { throw new ErpError('invalid_stored_tax_operation', 503); }
function actor(input: unknown, organizationId: string): FinancialAuthority {
  const value = snapshotPrivateJson(input) as FinancialAuthority;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(k => Object.hasOwn(value, k))) return invalid();
  if (value.organizationId !== organizationId) throw new ErpError('session_changed', 401);
  if (value.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(value.role)) throw new ErpError('financial_permission_required', 403);
  if (typeof value.userId !== 'string' || !value.userId.trim() || value.userId.length > 256 || Array.from(value.userId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return invalid();
  try { parseInstant(value.timestamp); } catch { return invalid(); }
  return value;
}
function controlled(error: unknown): ErpError {
  if (error instanceof ErpError) {
    if (Object.hasOwn(publicErpFailures, error.code)) return new ErpError(error.code, publicErpFailures[error.code]);
    // A foreign port may throw this class with private text in its code.
    // Preserve an actual Auth refusal's status without disclosing that text.
    if ([401, 402, 403].includes(error.status)) return new ErpError(error.status === 401 ? 'unauthorized' : error.status === 402 ? 'management_entitlement_required' : 'forbidden', error.status);
  }
  if (error instanceof AccountPublicError && [401, 402, 403].includes(error.status)) return new ErpError(error.status === 401 ? 'unauthorized' : error.status === 402 ? 'management_entitlement_required' : 'forbidden', error.status);
  if (error instanceof StripeTaxCalculationError || error instanceof StripeTaxResolvedRequestError) {
    if (Object.hasOwn(publicErpFailures, error.code)) return new ErpError(error.code, publicErpFailures[error.code]);
    return new ErpError('service_unavailable', 503);
  }
  // Public, known domain failures only. An arbitrary LedgerError message from
  // an injected port must never become a browser error or diagnostic payload.
  if (error instanceof LedgerError) {
    const statuses: Record<string, number> = { TENANT_MISMATCH: 403, MANAGEMENT_ENTITLEMENT_REQUIRED: 402, FINANCIAL_PERMISSION_REQUIRED: 403, INVOICE_PERMISSION_REQUIRED: 403, ESTIMATE_ACCEPTANCE_REQUIRED: 409, INVALID_DATE: 422, TAX_CONFIGURATION_REQUIRED: 409, TAX_ASSESSMENT_EXPIRED: 409, STALE_TAX_ASSESSMENT: 409, ACCOUNTING_PERIOD_CLOSED: 409 };
    if (Object.hasOwn(statuses, error.message)) return new ErpError(error.message.toLowerCase(), statuses[error.message]);
  }
  return new ErpError('service_unavailable', 503);
}
class CommittedReplay extends Error {
  constructor(readonly receipt: ErpReceipt) { super('committed_replay'); }
}

/** Private TEST issuer using the established document/accounting engine. The
 * scoped runtime composition owns preparation/merchant admission; no CH path,
 * live provider or SaaS billing credential is admitted by this engine.
 * Pending evidence is fresh; a committed receipt is historical. No auto retry.
 * Composed reads are not an atomic pre-provider fence: SQL owns final admission. */
export async function executeUsTaxInvoiceTest(dependencies: UsTaxInvoiceTestDependencies, input: unknown): Promise<Readonly<{ receipt: ErpReceipt; replayed: boolean }>> {
  const config = validateCompanyConfiguration(snapshotPrivateJson(dependencies.erp.configuration));
  if (config.country !== 'US') throw new ErpError('edition_unavailable', 409);
  const initialActor = actor(dependencies.erp.actor, config.organizationId);
  const request = validateErpRequest(snapshotPrivateJson(input), config.organizationId);
  if (request.command.type !== 'issue_invoice') throw new ErpError('invalid_request', 422);
  const command = request.command;
  const commandHash = await sha256Hex(canonicalErpJson([config.organizationId, initialActor.userId, request]));
  let lastClock = -Infinity;
  function clock(): string {
    try {
      const value = dependencies.now(), parsed = parseInstant(value);
      if (parsed.getTime() < lastClock) throw new Error('clock_reversed');
      lastClock = parsed.getTime(); return value;
    } catch { throw new ErpError('server_clock_unavailable', 503); }
  }
  async function fresh(): Promise<FinancialAuthority> {
    try {
      const value = actor(await dependencies.erp.revalidate(), config.organizationId);
      clock();
      if (value.userId !== initialActor.userId) throw new ErpError('session_changed', 401);
      if (value.role !== initialActor.role) throw new ErpError('forbidden', 403);
      return value;
    } catch (error) { throw controlled(error); }
  }
  async function guarded<T>(task: (admitted: FinancialAuthority) => Promise<T>): Promise<T> {
    const admitted = await fresh();
    let result: T;
    try { result = await task(admitted); }
    catch (error) { await fresh(); throw controlled(error); }
    await fresh(); return result;
  }
  function receipt(inputReceipt: unknown): ErpReceipt {
    const value = validateErpReceipt(inputReceipt, config.organizationId);
    if (value.idempotencyKey !== request.idempotencyKey || value.commandHash !== commandHash || value.action !== 'issue_invoice' || value.entityId !== command.id || value.revision !== request.expectedRevision + 1) return invalid();
    return value;
  }
  let capturedEstimate: Estimate | null = null, activeContext: UsTaxFinancialContext | null = null;
  let activeResolved: ResolvedStripeTaxRequest | null = null, activeCalculation: ValidatedStripeTaxCalculation | null = null;

  async function readContext(): Promise<UsTaxFinancialContext> {
    const context = await guarded(async admitted => snapshotPrivateJson(await dependencies.contexts.read(admitted)) as unknown as UsTaxFinancialContext);
    const contextActor = actor(context.actor, config.organizationId);
    if (context.organizationId !== config.organizationId || contextActor.userId !== initialActor.userId || contextActor.role !== initialActor.role || !same(context.configuration, config)) throw new ErpError('tax_configuration_changed', 409);
    if (context.binding.evidenceKind === 'test_fixture' && dependencies.allowTestFixtures !== true) throw new ErpError('tax_binding_unavailable', 409);
    return context;
  }
  async function classifications(context: UsTaxFinancialContext): Promise<readonly StripeTaxServiceClassification[]> {
    if (!capturedEstimate) return invalid();
    return guarded(async () => snapshotPrivateJson(await dependencies.classifications(context, capturedEstimate!)) as readonly StripeTaxServiceClassification[]);
  }
  function contextMatches(resolved: ResolvedStripeTaxRequest, context: UsTaxFinancialContext): void {
    if (resolved.organizationId !== config.organizationId || resolved.actorUserId !== initialActor.userId || resolved.erpIdempotencyKey !== request.idempotencyKey || resolved.commandHash !== commandHash || resolved.invoiceId !== command.id || resolved.invoiceDate !== command.date || resolved.expectedErpRevision !== request.expectedRevision || resolved.sourceEstimateId !== command.estimateId || resolved.sourceEstimateRevision !== command.expectedEstimateRevision
      || resolved.countryRevision !== context.countryRevision || resolved.sellerRevision !== context.sellerRevision || resolved.taxFactsRevision !== context.taxFactsRevision || !same(resolved.binding, context.binding) || !same(resolved.snapshots.configuration, context.configuration) || !same(resolved.snapshots.taxFacts, context.taxFacts) || !same(resolved.snapshots.estimate, capturedEstimate)) throw new ErpError('tax_configuration_changed', 409);
  }
  async function current(resolved: ResolvedStripeTaxRequest): Promise<UsTaxFinancialContext> {
    const context = await readContext(); contextMatches(resolved, context);
    if (!same(await classifications(context), resolved.classifications)) throw new ErpError('tax_classification_changed', 409);
    // ERP state is already validated by its port. Retain only this estimate,
    // never impose private-JSON array limits on the whole historical book.
    const state = await guarded(() => dependencies.erp.store.read(config.organizationId));
    if (!state || state.revision !== request.expectedRevision) throw new ErpError('revision_conflict', 409);
    if (!same(state.configuration, config) || !same(state.estimates.find(e => e.id === command.estimateId), capturedEstimate)) throw new ErpError('tax_configuration_changed', 409);
    return context;
  }
  function operationMatches(saved: StoredUsTaxOperation): void {
    if (saved.organizationId !== config.organizationId || saved.actorUserId !== initialActor.userId || saved.erpIdempotencyKey !== request.idempotencyKey || saved.commandHash !== commandHash) return invalid();
  }
  function retryOpen(saved: StoredUsTaxOperation): void {
    if (parseInstant(saved.retryUntil).getTime() <= parseInstant(clock()).getTime()) throw new ErpError('tax_operation_expired', 409);
  }
  async function pendingProof(): Promise<void> {
    if (!activeResolved || !activeCalculation) return invalid();
    activeResolved = await guarded(async () => validateResolvedStripeTaxRequest(activeResolved!, clock()));
    activeContext = await current(activeResolved);
    await guarded(() => dependencies.gateway.verify(activeContext!));
    activeContext = await current(activeResolved);
    activeCalculation = await guarded(async () => validateStoredStripeTaxCalculation(activeResolved!, { proofBody: activeCalculation!.proofBody, proofSha256: activeCalculation!.proofSha256, assessment: activeCalculation!.assessment }, clock()));
  }

  try {
    const result = await executeErp({
      store: {
        // This private wrapper adds guarded observations, not a different book
        // protocol. Preserve the trusted purchasing port's exact capability.
        supportedSchemaVersion: dependencies.erp.store.supportedSchemaVersion,
        async receipt(organizationId, key) {
          const saved = await guarded(() => dependencies.erp.store.receipt(organizationId, key));
          return saved === null ? null : receipt(saved);
        },
        async read(organizationId): Promise<ErpState | null> {
          const state = await guarded(() => dependencies.erp.store.read(organizationId));
          // The core checks revision, estimate status, uniqueness and period
          // before calling the provider. Snapshot this one document only.
          const estimate = state?.estimates.find(e => e.id === command.estimateId);
          capturedEstimate = estimate ? snapshotPrivateJson(estimate) as Estimate : null;
          return state;
        },
        async commit(commit) {
          if (!activeResolved || !activeCalculation) return invalid();
          receipt(commit.receipt);
          await pendingProof();
          const saved = await guarded(() => dependencies.operations.commit(activeResolved!.operationId, commit));
          return receipt(saved);
        },
      },
      configuration: config, actor: initialActor,
      async revalidate() {
        if (activeCalculation) await pendingProof();
        return fresh();
      },
      async seller() {
        if (!activeContext) return invalid();
        return validatePublicSellerSnapshot({ organizationId: config.organizationId, ...activeContext.seller }, config.organizationId);
      },
      async taxProvider() {
        const saved = await guarded(async admitted => {
          const value = await dependencies.operations.read(admitted, request.idempotencyKey, commandHash);
          return value === null ? null : snapshotPrivateJson(value) as StoredUsTaxOperation;
        });
        if (saved) {
          operationMatches(saved);
          // A concurrent commit after ERP receipt=null remains historical.
          // No old settings/classifications or provider call are required.
          if (saved.status === 'committed') throw new CommittedReplay(receipt(saved.receipt));
        }
        // Reject a draft before reserving or charging for an external tax call.
        // Historical receipts above remain replayable without this precondition.
        if (!capturedEstimate || capturedEstimate.status !== 'accepted') throw new ErpError('estimate_acceptance_required', 409);
        if (command.dueDate < command.date) throw new ErpError('invalid_date', 422);
        if (config.taxConfiguration.status !== 'configured') throw new ErpError('tax_configuration_required', 409);
        activeContext = await readContext();
        return { id: 'zentra-private-stripe-tax-test', async calculate(publicRequest) {
          if (!capturedEstimate || !same(publicRequest, buildTaxRequest(config, capturedEstimate, command.date))) return invalid();
          if (!activeContext) return invalid();
          let operation: StoredUsTaxOperation;
          if (saved) {
            activeResolved = await guarded(async () => validateResolvedStripeTaxRequest(saved.resolved, clock()));
            contextMatches(activeResolved, activeContext);
            if (!same(await classifications(activeContext), activeResolved.classifications)) throw new ErpError('tax_classification_changed', 409);
            operation = saved;
          } else {
            const selected = await guarded(async () => snapshotPrivateJson(await dependencies.transactionLocation(activeContext!, command)) as { taxDateInstant: string; addressSource: 'billing' | 'shipping' });
            if (!selected || Reflect.ownKeys(selected).length !== 2 || !Object.hasOwn(selected, 'taxDateInstant') || !Object.hasOwn(selected, 'addressSource')) throw new ErpError('invalid_tax_date', 422);
            const confirmed = await classifications(activeContext);
            activeResolved = await guarded(async () => prepareStripeTaxResolvedRequest({ organizationId: config.organizationId, operationId: dependencies.operationId(), invoiceId: command.id, actorUserId: initialActor.userId, erpIdempotencyKey: request.idempotencyKey, commandHash, expectedErpRevision: request.expectedRevision, countryRevision: activeContext!.countryRevision, sellerRevision: activeContext!.sellerRevision, taxFactsRevision: activeContext!.taxFactsRevision, configuration: config, estimate: capturedEstimate!, taxFacts: activeContext!.taxFacts, binding: activeContext!.binding, classifications: confirmed, invoiceDate: command.date, taxDateInstant: selected.taxDateInstant, taxDatePolicy: 'caller_supplied_invoice_instant', now: clock(), addressSource: selected.addressSource }));
            operation = await guarded(async admitted => snapshotPrivateJson(await dependencies.operations.reserve(admitted, activeResolved!)) as StoredUsTaxOperation);
            operationMatches(operation);
            if (operation.status === 'committed') throw new CommittedReplay(receipt(operation.receipt));
            if (!same(operation.resolved, activeResolved)) return invalid();
          }
          activeContext = await current(activeResolved);
          await guarded(() => dependencies.gateway.verify(activeContext!));
          activeContext = await current(activeResolved);
          if (operation.status === 'reserved') {
            retryOpen(operation);
            const observation = await guarded(async () => snapshotPrivateJson(await dependencies.gateway.calculate(activeResolved!)) as unknown as StripeTaxCalculationObservation);
            retryOpen(operation);
            activeContext = await current(activeResolved);
            activeCalculation = await guarded(async () => validateStripeTaxCalculation(activeResolved!, observation, clock()));
            retryOpen(operation);
            const recorded = await guarded(async admitted => snapshotPrivateJson(await dependencies.operations.record(admitted, activeResolved!, activeCalculation!)) as StoredUsTaxOperation);
            operationMatches(recorded);
            if (recorded.status === 'committed') throw new CommittedReplay(receipt(recorded.receipt));
            if (recorded.status !== 'calculated' || !same(recorded.resolved, activeResolved) || !recorded.calculation) return invalid();
            activeCalculation = await guarded(async () => validateStoredStripeTaxCalculation(activeResolved!, recorded.calculation, clock()));
          } else {
            if (operation.status !== 'calculated' || !operation.calculation) return invalid();
            activeCalculation = await guarded(async () => validateStoredStripeTaxCalculation(activeResolved!, operation.calculation, clock()));
          }
          await fresh(); return activeCalculation.assessment;
        } };
      },
    }, request);
    await fresh(); return Object.freeze({ receipt: receipt(result.receipt), replayed: result.replayed });
  } catch (error) {
    await fresh();
    if (error instanceof CommittedReplay) return Object.freeze({ receipt: receipt(error.receipt), replayed: true });
    throw controlled(error);
  }
}
