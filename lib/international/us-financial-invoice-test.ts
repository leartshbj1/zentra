import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { Estimate, TaxAssessment } from './invoicing';
import { validatePublicSellerSnapshot } from './invoicing';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { ErpRequest } from './runtime-types';
import { prepareStripeTaxResolvedRequest, STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest, type StripeTaxServiceClassification, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import { validateStoredStripeTaxCalculation, validateStripeTaxCalculation, type StripeTaxCalculationObservation, type ValidatedStripeTaxCalculation } from './stripe-tax-calculation';
import { projectUsFinancialBookV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import { validateUsFinancialReceiptV5, validateUsFinancialRequestV5, type UsFinancialReceiptV5, type UsFinancialRequestV5, type UsFinancialRuntimeDependenciesV5 } from './us-financial-kernel-runtime';
import { captureUsFinancialTestScopeV5, type UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { validateUsTaxInvoiceTime } from './us-tax-invoice-time';
import { validateUsTaxMerchantContext, validateUsTaxMerchantCredential, type UsTaxMerchantCredential } from './us-tax-merchant-store';
import { validateUsSellerProfileState, type UsSellerProfile } from './seller-profile';
import type { UsTaxFacts } from './us-tax-profile';
import type { CompanyConfiguration } from './types';

export interface UsFinancialInvoiceLegacyContextV5 {
  readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number;
  readonly countryRevision: number; readonly configuration: CompanyConfiguration;
  readonly sellerRevision: number; readonly seller: UsSellerProfile;
  readonly taxFactsRevision: number; readonly taxFacts: UsTaxFacts;
  readonly binding: StripeTaxTestBinding; readonly merchant: UsTaxMerchantCredential;
  readonly admittedBy: string; readonly admittedAt: string; readonly contextSha256: string;
}
/** Commercial identity is independently corroborated in PostgreSQL. The common
 * seller fields above remain the original fiscal identity used by the gateway. */
export interface UsFinancialInvoicePresentationV5 {
  readonly schemaVersion: 1; readonly baseContextRevision: number; readonly baseContextSha256: string;
  readonly origin: 'legacy-frozen' | 'financial-v5'; readonly sellerRevision: number;
  readonly sellerChangeSha256: string | null; readonly profile: UsSellerProfile;
}
export type UsFinancialInvoiceContextV5 = UsFinancialInvoiceLegacyContextV5 | Readonly<
  Omit<UsFinancialInvoiceLegacyContextV5, 'schemaVersion'> & { schemaVersion: 2; presentation: UsFinancialInvoicePresentationV5 }
>;
export interface UsFinancialInvoicePreparationV5 {
  readonly schemaVersion: 1; readonly organizationId: string; readonly actorId: string;
  readonly request: UsFinancialRequestV5; readonly financialCommandHash: string;
  readonly erpRequest: ErpRequest; readonly erpCommandHash: string;
  readonly previousBookFingerprint: string; readonly context: UsFinancialInvoiceContextV5;
  readonly estimate: Estimate; readonly estimateSha256: string;
  readonly classifications: readonly StripeTaxServiceClassification[];
  readonly taxDateInstant: string; readonly addressSource: 'billing' | 'shipping';
  readonly preparedAt: string; readonly preparationSha256: string;
}
export interface UsFinancialInvoiceOperationV5 {
  readonly schemaVersion: 1; readonly status: 'reserved' | 'calculated' | 'committed';
  readonly organizationId: string; readonly operationId: string;
  readonly preparation: UsFinancialInvoicePreparationV5;
  readonly resolvedBody: string; readonly resolvedSha256: string;
  readonly paramsBody: string; readonly paramsSha256: string; readonly providerKey: string;
  readonly reservedAt: string; readonly retryUntil: string;
  readonly proofBody: string | null; readonly proofSha256: string | null;
  readonly assessment: TaxAssessment | null; readonly receipt: UsFinancialReceiptV5 | null;
}
export interface UsFinancialInvoicePreflightV5 {
  readonly context: UsFinancialInvoiceContextV5; readonly estimate: Estimate;
  readonly bookRevision: number; readonly bookFingerprint: string;
}
export interface UsFinancialInvoicePreflightInputV5 {
  readonly request: UsFinancialRequestV5; readonly financialCommandHash: string;
  readonly erpCommandHash: string; readonly previousBookFingerprint: string;
}
/** Private evidence persistence only. No context provisioning, financial append,
 * merchant secret, SDK or provider action is exposed by this port. */
export interface UsFinancialInvoiceTestStoreV5 {
  read(actor: FinancialAuthority, input: Readonly<{ request: UsFinancialRequestV5; financialCommandHash: string; erpCommandHash: string }>): Promise<UsFinancialInvoiceOperationV5 | null>;
  preflight(actor: FinancialAuthority, input: UsFinancialInvoicePreflightInputV5): Promise<UsFinancialInvoicePreflightV5>;
  reserve(actor: FinancialAuthority, preparation: UsFinancialInvoicePreparationV5, resolved: ResolvedStripeTaxRequest): Promise<UsFinancialInvoiceOperationV5>;
  record(actor: FinancialAuthority, operation: UsFinancialInvoiceOperationV5, calculated: ValidatedStripeTaxCalculation): Promise<UsFinancialInvoiceOperationV5>;
}
export interface UsFinancialInvoiceChoicesV5 {
  readonly classifications: readonly Pick<StripeTaxServiceClassification, 'lineId' | 'taxCode' | 'kind' | 'taxBehavior'>[];
  readonly taxDateInstant: string; readonly addressSource: 'billing' | 'shipping';
}
export interface UsFinancialInvoiceResolverDependenciesV5 {
  readonly scope: UsFinancialTestScopeV5;
  revalidate(): Promise<UsFinancialTestScopeV5>;
  readonly store: UsFinancialInvoiceTestStoreV5;
  /** Human-confirmed choices/catalogue lookup, invoked only after SQL preflight. */
  choices(input: Readonly<{ actor: FinancialAuthority; preflight: UsFinancialInvoicePreflightV5; request: UsFinancialRequestV5 }>): Promise<UsFinancialInvoiceChoicesV5>;
  readonly gateway: Readonly<{ calculate(resolved: ResolvedStripeTaxRequest): Promise<StripeTaxCalculationObservation> }>;
  operationId(): string; now(): string;
  /** Explicit local QA; never changes fixture evidence into a real observation. */
  readonly allowTestFixtures?: boolean;
}
const contextFields = ['schemaVersion', 'organizationId', 'revision', 'countryRevision', 'configuration', 'sellerRevision', 'seller', 'taxFactsRevision', 'taxFacts', 'binding', 'merchant', 'admittedBy', 'admittedAt', 'contextSha256'];
const preparationFields = ['schemaVersion', 'organizationId', 'actorId', 'request', 'financialCommandHash', 'erpRequest', 'erpCommandHash', 'previousBookFingerprint', 'context', 'estimate', 'estimateSha256', 'classifications', 'taxDateInstant', 'addressSource', 'preparedAt', 'preparationSha256'];
const operationFields = ['schemaVersion', 'status', 'organizationId', 'operationId', 'preparation', 'resolvedBody', 'resolvedSha256', 'paramsBody', 'paramsSha256', 'providerKey', 'reservedAt', 'retryUntil', 'proofBody', 'proofSha256', 'assessment', 'receipt'];
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const fail = (code = 'invalid_financial_invoice_private_data', status = 503): never => { throw new ErpError(code, status); };
function capture<T>(value: T): T { try { return snapshotPrivateJson(value) as T; } catch { return fail(); } }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) return fail();
  return value as Record<string, unknown>;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail(); return value; }
function text(value: unknown, max = 256): string { if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail(); return value; }
function instant(value: unknown): number { if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return fail(); try { return parseInstant(value).getTime(); } catch { return fail(); } }
function revision(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) return fail(); }
function body(value: Record<string, unknown>, excluded: string): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([k]) => k !== excluded)); }
function issueRequest(value: unknown, org: string): UsFinancialRequestV5 {
  const request = validateUsFinancialRequestV5(capture(value), org);
  if (request.command.type !== 'erp_command' || request.command.request.type !== 'issue_invoice' || request.command.request.dueDate < request.command.request.date) return fail('invalid_financial_request', 422);
  if (!same(request, value)) return fail(); return capture(request);
}
function inner(request: UsFinancialRequestV5): ErpRequest {
  if (request.command.type !== 'erp_command') return fail();
  return Object.freeze({ idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision, command: request.command.request });
}
export async function financialInvoiceClassificationEvidenceV5(org: string, actorId: string, financialHash: string, lineId: string, taxCode: string): Promise<string> {
  return 'ztaxprep_' + await sha256Hex(canonicalErpJson(['zentra:us:financial:invoice:classification:v5', org, actorId, financialHash, lineId, taxCode]));
}
/** Validates historical evidence at its original admission time. Freshness is a
 * separate new-action gate; the hash is not proof of DB-owner provenance. */
async function validateLegacyContext(input: unknown, org: string, allowTestFixtures: boolean): Promise<UsFinancialInvoiceLegacyContextV5> {
  const v = exact(capture(input), contextFields), binding = exact(v.binding, ['organizationId', 'accountId', 'mode', 'apiVersion', 'revision', 'settingsSha256', 'registrationsSha256', 'observedAt', 'validUntil', 'evidenceKind', 'scope']);
  if (v.schemaVersion !== 1 || v.organizationId !== org) return fail(); revision(v.revision);
  validateUsTaxMerchantContext({ organizationId: org, countryRevision: v.countryRevision, configuration: v.configuration, sellerRevision: v.sellerRevision, seller: v.seller, taxFactsRevision: v.taxFactsRevision, taxFacts: v.taxFacts, bindingRevision: binding.revision }, org);
  const merchant = validateUsTaxMerchantCredential(v.merchant), cfg = v.configuration as CompanyConfiguration;
  if (cfg.accountingBasis !== 'accrual' || cfg.taxConfiguration.status !== 'configured' || binding.organizationId !== org || binding.accountId !== merchant.credential.accountId || binding.mode !== 'test' || binding.apiVersion !== STRIPE_TAX_API_VERSION || binding.scope !== 'erp_invoice_tax' || !['test_fixture', 'provider_observation'].includes(binding.evidenceKind as string)) return fail();
  if (binding.evidenceKind === 'test_fixture' && !allowTestFixtures) return fail('financial_invoice_fixture_disabled', 409);
  revision(binding.revision); hash(binding.settingsSha256); hash(binding.registrationsSha256); text(v.admittedBy);
  const admitted = instant(v.admittedAt), observed = instant(binding.observedAt), until = instant(binding.validUntil);
  if (observed > admitted || admitted >= until || until - observed > 120_000 || until <= observed) return fail();
  if (hash(v.contextSha256) !== await sha256Hex(canonicalErpJson(body(v, 'contextSha256')))) return fail();
  return v as unknown as UsFinancialInvoiceLegacyContextV5;
}
/** Recover the exact immutable DB-owner context; never substitute commercial S
 * in provider requests, merchant admission, observation or retry windows. */
export function usFinancialInvoiceBaseContextV5(context: UsFinancialInvoiceContextV5): UsFinancialInvoiceLegacyContextV5 {
  const captured = capture(context);
  if (captured.schemaVersion === 1) return captured;
  const { presentation, ...common } = captured;
  return Object.freeze({ ...common, schemaVersion: 1, contextSha256: presentation.baseContextSha256 });
}
export function usFinancialInvoiceSellerProfileV5(context: UsFinancialInvoiceContextV5): UsSellerProfile {
  const captured = capture(context);
  return captured.schemaVersion === 2 ? captured.presentation.profile : captured.seller;
}
export async function validateUsFinancialInvoiceContextV5(input: unknown, org: string, allowTestFixtures = false): Promise<UsFinancialInvoiceContextV5> {
  const captured = capture(input) as Record<string, unknown>;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return fail();
  if (captured.schemaVersion === 1) return validateLegacyContext(captured, org, allowTestFixtures);
  const v = exact(captured, [...contextFields, 'presentation']);
  if (v.schemaVersion !== 2 || v.organizationId !== org) return fail();
  const p = exact(v.presentation, ['schemaVersion', 'baseContextRevision', 'baseContextSha256', 'origin', 'sellerRevision', 'sellerChangeSha256', 'profile']);
  if (p.schemaVersion !== 1 || p.baseContextRevision !== v.revision || !['legacy-frozen', 'financial-v5'].includes(p.origin as string)) return fail();
  revision(p.baseContextRevision); revision(p.sellerRevision); hash(p.baseContextSha256);
  if (p.origin === 'legacy-frozen') { if (p.sellerChangeSha256 !== null) return fail(); }
  else hash(p.sellerChangeSha256);
  try {
    const seller = validateUsSellerProfileState({ status: 'configured', organizationId: org, revision: p.sellerRevision,
      profile: p.profile, updatedBy: 'private-presentation-validation', updatedAt: '2026-01-01T00:00:00Z' }, org);
    if (seller.status !== 'configured') return fail();
  } catch { return fail(); }
  const { presentation: _presentation, ...common } = v; void _presentation;
  await validateLegacyContext({ ...common, schemaVersion: 1, contextSha256: p.baseContextSha256 }, org, allowTestFixtures);
  if (hash(v.contextSha256) !== await sha256Hex(canonicalErpJson(body(v, 'contextSha256')))) return fail();
  return v as unknown as UsFinancialInvoiceContextV5;
}
export async function resolveUsFinancialInvoicePreparationV5(preparation: UsFinancialInvoicePreparationV5, operationId: string, now: string): Promise<ResolvedStripeTaxRequest> {
  const p = capture(preparation), command = p.erpRequest.command, c = p.context;
  if (command.type !== 'issue_invoice') return fail();
  return prepareStripeTaxResolvedRequest({ organizationId: p.organizationId, operationId, invoiceId: command.id, actorUserId: p.actorId, erpIdempotencyKey: p.request.idempotencyKey, commandHash: p.erpCommandHash, expectedErpRevision: p.request.expectedRevision, countryRevision: c.countryRevision, sellerRevision: c.sellerRevision, taxFactsRevision: c.taxFactsRevision, configuration: c.configuration, estimate: p.estimate, taxFacts: c.taxFacts, binding: c.binding, classifications: p.classifications, invoiceDate: command.date, taxDateInstant: p.taxDateInstant, taxDatePolicy: 'caller_supplied_invoice_instant', now, addressSource: p.addressSource });
}
export async function validateUsFinancialInvoicePreparationV5(input: unknown, org: string, allowTestFixtures = false): Promise<UsFinancialInvoicePreparationV5> {
  const v = exact(capture(input), preparationFields), request = issueRequest(v.request, org), actorId = text(v.actorId);
  if (v.schemaVersion !== 1 || v.organizationId !== org || !same(v.erpRequest, inner(request))) return fail();
  if (hash(v.financialCommandHash) !== await sha256Hex(canonicalErpJson([org, actorId, request])) || hash(v.erpCommandHash) !== await sha256Hex(canonicalErpJson([org, actorId, inner(request)]))) return fail();
  hash(v.previousBookFingerprint); const context = await validateUsFinancialInvoiceContextV5(v.context, org, allowTestFixtures);
  const prepared = instant(v.preparedAt); if (prepared < instant(context.admittedAt) || prepared >= instant(context.binding.validUntil)) return fail();
  if (hash(v.estimateSha256) !== await sha256Hex(canonicalErpJson(v.estimate))) return fail();
  if (!Array.isArray(v.classifications)) return fail();
  for (const item of v.classifications) {
    const cls = exact(item, ['lineId', 'taxCode', 'kind', 'taxBehavior', 'revision', 'evidenceReference']);
    if (cls.revision !== 1 || cls.evidenceReference !== await financialInvoiceClassificationEvidenceV5(org, actorId, v.financialCommandHash as string, text(cls.lineId), text(cls.taxCode))) return fail();
  }
  const p = v as unknown as UsFinancialInvoicePreparationV5, command = p.erpRequest.command;
  if (command.type !== 'issue_invoice' || p.estimate.id !== command.estimateId || p.estimate.revision !== command.expectedEstimateRevision) return fail();
  const resolved = await resolveUsFinancialInvoicePreparationV5(p, '00000000-0000-4000-8000-000000000000', p.preparedAt);
  if (!same(resolved.classifications, p.classifications) || hash(v.preparationSha256) !== await sha256Hex(canonicalErpJson(body(v, 'preparationSha256')))) return fail();
  return p;
}
/** Operation validation never turns a calculation into a tax transaction or
 * admits an expired pending request. Completed history uses its stored time. */
export async function validateUsFinancialInvoiceOperationV5(input: unknown, org: string, allowTestFixtures = false): Promise<UsFinancialInvoiceOperationV5> {
  const v = exact(capture(input), operationFields);
  if (v.schemaVersion !== 1 || v.organizationId !== org || !['reserved', 'calculated', 'committed'].includes(v.status as string) || typeof v.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.operationId)) return fail();
  const p = await validateUsFinancialInvoicePreparationV5(v.preparation, org, allowTestFixtures), reserved = instant(v.reservedAt);
  if (reserved < instant(p.preparedAt) || instant(v.retryUntil) !== reserved + 23 * 3_600_000) return fail();
  const resolved = await resolveUsFinancialInvoicePreparationV5(p, v.operationId, v.reservedAt as string);
  if (v.resolvedBody !== resolved.resolvedBody || v.resolvedSha256 !== resolved.resolvedSha256 || v.paramsBody !== resolved.paramsBody || v.paramsSha256 !== resolved.paramsSha256 || v.providerKey !== resolved.idempotencyKey) return fail();
  if (v.status === 'reserved') { if (v.proofBody !== null || v.proofSha256 !== null || v.assessment !== null || v.receipt !== null) return fail(); }
  else {
    if (typeof v.proofBody !== 'string') return fail();
    let proof: Record<string, unknown>; try { proof = JSON.parse(v.proofBody) as Record<string, unknown>; } catch { return fail(); }
    const calculatedAt = instant(proof.calculatedAt);
    if (calculatedAt < reserved || calculatedAt >= instant(v.retryUntil)) return fail();
    await validateStoredStripeTaxCalculation(resolved, { proofBody: v.proofBody, proofSha256: v.proofSha256, assessment: v.assessment }, proof.calculatedAt as string);
    if (v.status === 'calculated') { if (v.receipt !== null) return fail(); }
    else {
      const r = validateUsFinancialReceiptV5(v.receipt);
      if (r.actorId !== p.actorId || r.idempotencyKey !== p.request.idempotencyKey || r.commandHash !== p.financialCommandHash || r.revision !== p.request.expectedRevision + 1 || r.entityId !== resolved.invoiceId || r.action !== 'erp_command') return fail();
    }
  }
  return v as unknown as UsFinancialInvoiceOperationV5;
}

export function createUsFinancialInvoiceTestResolverV5(dependencies: UsFinancialInvoiceResolverDependenciesV5): NonNullable<UsFinancialRuntimeDependenciesV5['resolveIssuance']> {
  const bound = captureUsFinancialTestScopeV5(dependencies.scope), store = dependencies.store;
  const revalidate = dependencies.revalidate.bind(dependencies), choices = dependencies.choices.bind(dependencies), calculate = dependencies.gateway.calculate.bind(dependencies.gateway), operationId = dependencies.operationId.bind(dependencies), now = dependencies.now.bind(dependencies), allowFixtures = dependencies.allowTestFixtures === true;
  const read = store.read.bind(store), preflightCall = store.preflight.bind(store), reserve = store.reserve.bind(store), record = store.record.bind(store);
  let previousClock = 0, lastAuthority = instant(bound.actor.timestamp);
  function clock(): string { const result = now(), stamp = instant(result); if (stamp < previousClock) return fail('financial_clock_reversed', 409); previousClock = stamp; return result; }
  async function fresh(minimum: FinancialAuthority): Promise<FinancialAuthority> {
    const scope = captureUsFinancialTestScopeV5(await revalidate());
    if (scope.organizationId !== bound.organizationId || scope.actor.userId !== bound.actor.userId || scope.actor.role !== bound.actor.role) return fail('financial_authority_changed', 403);
    if (scope.grantVersion !== bound.grantVersion) return fail('financial_test_grant_changed', 409);
    if (!same(scope.policy, bound.policy)) return fail('financial_policy_unavailable', 409);
    const stamp = instant(scope.actor.timestamp); if (stamp < lastAuthority || stamp < instant(minimum.timestamp) || stamp > instant(clock())) return fail('financial_clock_reversed', 409);
    lastAuthority = stamp; return scope.actor;
  }
  return async original => {
    const input = capture(original), actor = capture(input.actor);
    exact(input, ['organizationId', 'actor', 'idempotencyKey', 'commandHash', 'book', 'command']);
    if (input.organizationId !== bound.organizationId || actor.organizationId !== bound.organizationId || actor.userId !== bound.actor.userId || actor.role !== bound.actor.role) return fail('tenant_mismatch', 403);
    const request = issueRequest({ idempotencyKey: input.idempotencyKey, expectedRevision: input.book.revision, command: { type: 'erp_command', request: input.command } }, bound.organizationId);
    let live = await fresh(actor);
    async function guarded<T>(call: () => Promise<T>): Promise<T> {
      live = await fresh(live); let result: T | undefined, caught: unknown, failed = false;
      try { result = capture(await call()); } catch (error) { caught = error; failed = true; }
      live = await fresh(live); if (failed) throw caught; return result as T;
    }
    const financialHash = await guarded(() => sha256Hex(canonicalErpJson([bound.organizationId, actor.userId, request]))), erpHash = await guarded(() => sha256Hex(canonicalErpJson([bound.organizationId, actor.userId, inner(request)])));
    if (input.commandHash !== financialHash) return fail('idempotency_conflict', 409);
    const book = await guarded(() => validateUsFinancialBookV5(input.book, bound.organizationId, bound.policy));
    const bookHash = await guarded(() => sha256Hex(canonicalErpJson(book)));
    let operation = await guarded(() => read(live, { request, financialCommandHash: financialHash, erpCommandHash: erpHash }));
    if (operation) {
      operation = await guarded(() => validateUsFinancialInvoiceOperationV5(operation, bound.organizationId, allowFixtures));
      if (!same(operation.preparation.request, request) || operation.preparation.actorId !== actor.userId || operation.preparation.financialCommandHash !== financialHash || operation.preparation.erpCommandHash !== erpHash) return fail('idempotency_conflict', 409);
      if (operation.status === 'committed') {
        // The financial runtime, not this facts resolver, handles completed
        // replay against a fresh book before entering resolveIssuance. A race
        // which committed after our captured prefix requires that exact retry.
        return fail('revision_conflict', 409);
      }
      if (operation.preparation.previousBookFingerprint !== bookHash || operation.preparation.request.expectedRevision !== book.revision) return fail('revision_conflict', 409);
    }
    // The SQL preflight is required even on a pending exact retry, before any
    // human/catalogue callback or gateway observation/calculation.
    const preflight = await guarded(() => preflightCall(live, { request, financialCommandHash: financialHash, erpCommandHash: erpHash, previousBookFingerprint: bookHash }));
    const context = await guarded(() => validateUsFinancialInvoiceContextV5(preflight.context, bound.organizationId, allowFixtures));
    const view = await guarded(() => projectUsFinancialBookV5(book)), source = view.estimates.find(e => e.id === input.command.estimateId);
    if (preflight.bookRevision !== book.revision || preflight.bookFingerprint !== bookHash || !source || !same(preflight.estimate, source) || source.status !== 'accepted' || source.revision !== input.command.expectedEstimateRevision || !same(context.configuration, book.baseline.configuration)) return fail('revision_conflict', 409);
    const preflightTime = instant(clock());
    if (instant(context.admittedAt) > preflightTime || instant(context.binding.observedAt) > preflightTime || preflightTime >= instant(context.binding.validUntil)) return fail('binding_unavailable', 409);
    const period = view.ledger.periods.find(p => p.id === input.command.periodId);
    if (!period || period.status !== 'open' || input.command.accountingDate < period.start || input.command.accountingDate > period.end) return fail('accounting_period_closed', 409);
    if (view.invoices.some(i => i.id === input.command.id || i.sourceEstimateId === source.id)) return fail('invoice_already_issued', 409);
    if (!operation) {
      const selected = exact(await guarded(() => choices({ actor: live, preflight, request })), ['classifications', 'taxDateInstant', 'addressSource']) as unknown as UsFinancialInvoiceChoicesV5;
      if (!Array.isArray(selected.classifications) || selected.classifications.length !== source.lines.length) return fail('unsupported_tax_request', 422);
      const classifications: StripeTaxServiceClassification[] = [];
      for (const [index, raw] of selected.classifications.entries()) {
        const cls = exact(raw, ['lineId', 'taxCode', 'kind', 'taxBehavior']);
        if (cls.lineId !== source.lines[index].id || cls.kind !== 'service' || cls.taxBehavior !== 'exclusive' || typeof cls.taxCode !== 'string') return fail('unsupported_tax_request', 422);
        classifications.push({ ...raw, revision: 1, evidenceReference: await guarded(() => financialInvoiceClassificationEvidenceV5(bound.organizationId, actor.userId, financialHash, raw.lineId, raw.taxCode)) });
      }
      const preparedAt = clock(), taxDateInstant = validateUsTaxInvoiceTime({ taxDateInstant: selected.taxDateInstant, invoiceDate: input.command.date, timeZone: context.configuration.timeZone, now: preparedAt });
      const payload = { schemaVersion: 1 as const, organizationId: bound.organizationId, actorId: actor.userId, request, financialCommandHash: financialHash, erpRequest: inner(request), erpCommandHash: erpHash, previousBookFingerprint: bookHash, context, estimate: source, estimateSha256: await guarded(() => sha256Hex(canonicalErpJson(source))), classifications, taxDateInstant, addressSource: selected.addressSource, preparedAt };
      const preparationSha256 = await guarded(() => sha256Hex(canonicalErpJson(payload)));
      const preparation = await guarded(() => validateUsFinancialInvoicePreparationV5({ ...payload, preparationSha256 }, bound.organizationId, allowFixtures));
      const resolved = await guarded(() => resolveUsFinancialInvoicePreparationV5(preparation, operationId(), clock()));
      operation = await guarded(() => reserve(live, preparation, resolved));
      operation = await guarded(() => validateUsFinancialInvoiceOperationV5(operation, bound.organizationId, allowFixtures));
      if (!same(operation.preparation, preparation) || operation.resolvedBody !== resolved.resolvedBody) return fail();
    } else if (!same(operation.preparation.context, context) || !same(operation.preparation.estimate, source)) return fail('tax_configuration_changed', 409);
    if (instant(operation.reservedAt) > instant(clock()) || instant(clock()) >= instant(operation.retryUntil)) return fail('tax_calculation_expired', 409);
    const resolved = await guarded(() => resolveUsFinancialInvoicePreparationV5(operation!.preparation, operation!.operationId, clock()));
    if (operation.status === 'reserved') {
      const observation = await guarded(() => calculate(resolved));
      const calculated = await guarded(() => validateStripeTaxCalculation(resolved, observation, clock()));
      const previous = operation;
      operation = await guarded(() => record(live, previous, calculated));
      operation = await guarded(() => validateUsFinancialInvoiceOperationV5(operation, bound.organizationId, allowFixtures));
      if (!same(operation.preparation, previous.preparation) || operation.operationId !== previous.operationId || operation.status !== 'calculated' || operation.proofBody !== calculated.proofBody || operation.proofSha256 !== calculated.proofSha256 || !same(operation.assessment, calculated.assessment)) return fail();
    }
    const calculated = await guarded(() => validateStoredStripeTaxCalculation(resolved, { proofBody: operation!.proofBody, proofSha256: operation!.proofSha256, assessment: operation!.assessment }, clock()));
    return Object.freeze({ kind: 'invoice_issuance', sellerSnapshot: validatePublicSellerSnapshot({ organizationId: bound.organizationId, ...usFinancialInvoiceSellerProfileV5(context) }, bound.organizationId), taxAssessment: calculated.assessment });
  };
}
