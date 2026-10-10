import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import type { FinancialAuthority } from './accounting/ledger';
import { LedgerError } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import { createUsFinancialInvoiceTestResolverV5, type UsFinancialInvoiceContextV5, type UsFinancialInvoiceOperationV5, type UsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test';
import { validateUsFinancialBookV5 } from './us-financial-kernel';
import { executeUsFinancialKernelV5, type UsFinancialRuntimeDependenciesV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotInvoiceRequest, projectUsFinancialPilotInvoicePreview, usFinancialPilotInvoiceChoicesMatch,
  validateUsFinancialPilotInvoiceRequest, validateUsFinancialPilotInvoiceIssueRequest, validateUsFinancialPilotInvoiceReceipt,
  validateUsFinancialPilotTaxCatalogue, type UsFinancialPilotInvoiceRequest } from './us-financial-pilot-invoice';
import type { UsFinancialPilotDependencies, UsFinancialPilotStore } from './us-financial-pilot-server';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import type { UsFinancialPilotInvoiceStore } from './us-financial-pilot-invoice-store';
import type { ResolvedUsTaxTestMerchant } from './us-tax-merchant-resolver';
import { validateUsTaxMerchantCredential } from './us-tax-merchant-store';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import type { CompanyConfiguration } from './types';
import { creationUuid } from './workspace-creation';

export interface UsFinancialPilotInvoiceDependencies extends UsFinancialPilotDependencies {
  invoiceStore(this: void, scope: UsFinancialPilotScope, revalidate: () => Promise<UsFinancialPilotScope>): UsFinancialPilotInvoiceStore | Promise<UsFinancialPilotInvoiceStore>;
  merchant(this: void, organizationId: string): Promise<ResolvedUsTaxTestMerchant | null>;
  operationId(this: void): string;
  now(this: void): string;
  /** Local dependency injection only; real browser bindings never enable it. */
  readonly allowTestFixtures?: boolean;
}
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot' };
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const unavailable = (): never => { throw new ErpError('financial_service_unavailable', 503); };
function ownData(value: unknown, key: string, optional = false): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field && optional) return undefined;
  if (!field || !('value' in field)) return unavailable();
  return field.value;
}
function portMethod<T>(value: unknown, key: string): T {
  const method = ownData(value, key); if (typeof method !== 'function') return unavailable();
  return method.bind(value) as T;
}
function captureMerchant(value: ResolvedUsTaxTestMerchant | null): ResolvedUsTaxTestMerchant | null {
  if (value === null) return null;
  const identity = validateUsTaxMerchantCredential({ credential: ownData(value, 'credential'), configurationFingerprint: ownData(value, 'configurationFingerprint') });
  const gateway = ownData(value, 'gateway'), catalogue = ownData(value, 'catalogue', true);
  return Object.freeze({ ...identity, observe: portMethod<ResolvedUsTaxTestMerchant['observe']>(value, 'observe'),
    gateway: Object.freeze({ verify: portMethod<ResolvedUsTaxTestMerchant['gateway']['verify']>(gateway, 'verify'), calculate: portMethod<ResolvedUsTaxTestMerchant['gateway']['calculate']>(gateway, 'calculate') }),
    ...(catalogue === undefined ? {} : { catalogue: Object.freeze({ readTaxCode: portMethod<NonNullable<ResolvedUsTaxTestMerchant['catalogue']>['readTaxCode']>(catalogue, 'readTaxCode'), listTaxCodes: portMethod<NonNullable<ResolvedUsTaxTestMerchant['catalogue']>['listTaxCodes']>(catalogue, 'listTaxCodes') }) }) });
}
const errors: Readonly<Record<string, readonly number[]>> = {
  invalid_financial_pilot_request: [422], invalid_request: [400, 413, 415, 422], invalid_financial_request: [422], invalid_financial_date: [422],
  session_changed: [401], unauthorized: [401], forbidden: [403], tenant_mismatch: [403], management_entitlement_required: [402], financial_permission_required: [403], financial_authority_changed: [403],
  financial_test_grant_required: [403], financial_test_grant_changed: [409], financial_pilot_opt_in_changed: [409], financial_configuration_changed: [409], financial_policy_unavailable: [409], financial_upgrade_required: [409],
  financial_capability_unavailable: [503], financial_book_required: [409], financial_book_too_large: [413], financial_source_changed: [409], financial_clock_reversed: [409],
  revision_conflict: [409], idempotency_conflict: [409], feature_unavailable: [404], edition_unavailable: [409], rate_limited: [429],
  tax_preparation_required: [409], tax_preparation_conflict: [409], tax_review_changed: [409], tax_calculation_expired: [409], unsupported_tax_request: [422], invalid_tax_date: [422],
  binding_unavailable: [409], tax_binding_changed: [409], tax_configuration_changed: [409], financial_invoice_fixture_disabled: [409],
  accounting_period_closed: [409], accounting_period_not_open: [409], invoice_already_issued: [409], sales_order_source_locked: [409], sales_order_confirmation_required: [409],
};
function failure(value: unknown, operation: 'read' | 'write', diagnostic: UsFinancialPilotDependencies['diagnostic']): Response {
  let status = 503, code = 'financial_service_unavailable';
  const c = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'code') : undefined;
  const s = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'status') : undefined;
  if (value instanceof ErpError && c && s && 'value' in c && 'value' in s && typeof c.value === 'string' && errors[c.value]?.includes(s.value)) { code = c.value; status = s.value; }
  else if (value instanceof RequestBodyError) { status = value.status; code = 'invalid_request'; }
  else if (value instanceof AccountPublicError) { status = value.status; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden'; }
  else if (value instanceof LedgerError && ['PERIOD_CLOSED', 'ACCOUNTING_PERIOD_CLOSED'].includes(value.message)) { status = 409; code = 'accounting_period_not_open'; }
  try { diagnostic({ operation, code, status }); } catch { /* private bounded diagnostics only */ }
  return Response.json({ error: code }, { status, headers });
}

/** Browser-only TEST prepare/review/issue. The preparation and calculation are
 * the existing durable V5 operation; only issue can append a financial event. */
export function createUsFinancialPilotInvoiceHandlers(input: UsFinancialPilotInvoiceDependencies) {
  const deps = Object.freeze({ ...input, enabled: input.enabled.bind(undefined), authority: input.authority.bind(undefined), configuration: input.configuration.bind(undefined),
    scope: input.scope.bind(undefined), store: input.store.bind(undefined), invoiceStore: input.invoiceStore.bind(undefined), merchant: input.merchant.bind(undefined),
    rateLimit: input.rateLimit.bind(undefined), diagnostic: input.diagnostic.bind(undefined), operationId: input.operationId.bind(undefined), now: input.now.bind(undefined) });
  async function run(request: Request, organizationId: string, kind: 'prepare' | 'issue' | 'catalogue'): Promise<Response> {
    const operation = kind === 'catalogue' ? 'read' : 'write';
    let trusted: ErpReadAdmission | undefined, scope: UsFinancialPilotScope | undefined, configuration: CompanyConfiguration | undefined;
    let selected: ResolvedUsTaxTestMerchant | undefined, selectedIdentity: ReturnType<typeof validateUsTaxMerchantCredential> | undefined;
    async function authority(): Promise<ErpReadAdmission> {
      const current = snapshotPrivateJson(await deps.authority(request, organizationId)) as ErpReadAdmission;
      confirmErpExpectedUser(request, current);
      if (current.mode !== 'browser' || current.actor.organizationId !== organizationId) throw new ErpError('forbidden', 403);
      if (current.actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
      if (!['owner', 'admin', 'accountant'].includes(current.actor.role)) throw new ErpError('financial_permission_required', 403);
      if (trusted) confirmErpReadAdmission(trusted, current);
      return current;
    }
    async function admission(): Promise<UsFinancialPilotScope> {
      let rejected: unknown, current: UsFinancialPilotScope | undefined;
      try {
        const fresh = await authority();
        if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
        current = captureUsFinancialPilotScope(await deps.scope(fresh.actor, scope));
        if (current.scope.organizationId !== organizationId || current.scope.actor.userId !== fresh.actor.userId || current.scope.actor.role !== fresh.actor.role || !same(current.scope.actor, fresh.actor)) return unavailable();
        if (scope) {
          if (current.scope.grantVersion !== scope.scope.grantVersion) throw new ErpError('financial_test_grant_changed', 409);
          if (current.optInVersion !== scope.optInVersion) throw new ErpError('financial_pilot_opt_in_changed', 409);
          if (!same(current.scope.policy, scope.scope.policy)) throw new ErpError('financial_policy_unavailable', 409);
        }
        if (configuration && !same(await deps.configuration(fresh.actor), configuration)) throw new ErpError('financial_configuration_changed', 409);
      } catch (error) { rejected = error; }
      // Effective session loss wins over rejected private/source operations.
      await authority();
      if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      if (rejected) throw rejected;
      return current!;
    }
    async function checked<T>(task: (actor: FinancialAuthority) => Promise<T>): Promise<T> {
      const current = await admission(); let result: T | undefined, rejected: unknown;
      try { result = await task(current.scope.actor); } catch (error) { rejected = error; }
      await admission(); if (rejected) throw rejected; return result as T;
    }
    async function merchant(): Promise<ResolvedUsTaxTestMerchant> {
      const current = await checked(async () => captureMerchant(await deps.merchant(organizationId)));
      if (!current) throw new ErpError('binding_unavailable', 409);
      const identity = validateUsTaxMerchantCredential({ credential: current.credential, configurationFingerprint: current.configurationFingerprint });
      if (selectedIdentity && !same(identity, selectedIdentity)) throw new ErpError('tax_binding_changed', 409);
      if (!selected) {
        selectedIdentity = identity;
        selected = Object.freeze({ ...current, credential: identity.credential, configurationFingerprint: identity.configurationFingerprint,
          gateway: Object.freeze({ verify: current.gateway.verify.bind(current.gateway), calculate: current.gateway.calculate.bind(current.gateway) }),
          ...(current.catalogue ? { catalogue: Object.freeze({ readTaxCode: current.catalogue.readTaxCode.bind(current.catalogue), listTaxCodes: current.catalogue.listTaxCodes.bind(current.catalogue) }) } : {}) });
      }
      return selected;
    }
    async function provider<T>(task: (merchant: ResolvedUsTaxTestMerchant) => Promise<T>): Promise<T> {
      const current = await merchant(); let result: T | undefined, rejected: unknown;
      try { result = await checked(async () => { const returned = await task(current); return returned === undefined ? returned : snapshotPrivateJson(returned) as T; }); } catch (error) { rejected = error; }
      await merchant(); if (rejected) throw rejected; return result as T;
    }
    async function verify(context: UsFinancialInvoiceContextV5): Promise<void> {
      const current = await merchant();
      if (!same(context.configuration, configuration) || !same(context.merchant, selectedIdentity) || context.binding.accountId !== current.credential.accountId) throw new ErpError('tax_binding_changed', 409);
      if (context.binding.evidenceKind !== 'provider_observation' && deps.allowTestFixtures !== true) throw new ErpError('binding_unavailable', 409);
      await provider(async port => {
        const actor = (await admission()).scope.actor;
        const mapped: UsTaxFinancialContext = { organizationId, actor, recordedAt: context.admittedAt, countryRevision: context.countryRevision, configuration: context.configuration,
          sellerRevision: context.sellerRevision, seller: context.seller, taxFactsRevision: context.taxFactsRevision, taxFacts: context.taxFacts, binding: context.binding };
        await port.gateway.verify(mapped);
      });
    }
    try {
      if (request.headers.has('Authorization')) throw new ErpError('forbidden', 403);
      if (request.method !== (operation === 'read' ? 'GET' : 'POST') || request.headers.get('X-Zentra-Financial-Pilot') !== '1' || !request.headers.get('X-Zentra-Expected-User')) throw new ErpError('invalid_financial_pilot_request', 422);
      try { creationUuid(organizationId); } catch { throw new ErpError('invalid_financial_pilot_request', 422); }
      const params = new URL(request.url).searchParams;
      if (operation === 'write' && [...params].length || operation === 'read' && ([...params].length > 1 || [...params.keys()].some(key => !['code', 'cursor'].includes(key)))) throw new ErpError('invalid_financial_pilot_request', 422);
      if (operation === 'write') requireAccountSameOrigin(request);
      if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      trusted = await authority(); await checked(actor => deps.rateLimit(request, actor, operation));
      configuration = await checked(async actor => validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(actor))));
      if (configuration.organizationId !== organizationId || configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
      scope = await admission();
      const privateAdmission = async () => { const current = await admission(); if (selected) await merchant(); return current; };
      const store: UsFinancialPilotStore = await checked(async () => {
        const raw = await deps.store(scope!, privateAdmission);
        return Object.freeze({ capability: ownData(raw, 'capability') as UsFinancialPilotStore['capability'], read: portMethod<UsFinancialPilotStore['read']>(raw, 'read'), receipt: portMethod<UsFinancialPilotStore['receipt']>(raw, 'receipt'), commit: portMethod<UsFinancialPilotStore['commit']>(raw, 'commit'), head: portMethod<UsFinancialPilotStore['head']>(raw, 'head') });
      });
      const fiscal: UsFinancialPilotInvoiceStore = await checked(async () => {
        const raw = await deps.invoiceStore(scope!, privateAdmission);
        return Object.freeze({ read: portMethod<UsFinancialPilotInvoiceStore['read']>(raw, 'read'), preflight: portMethod<UsFinancialPilotInvoiceStore['preflight']>(raw, 'preflight'), reserve: portMethod<UsFinancialPilotInvoiceStore['reserve']>(raw, 'reserve'), record: portMethod<UsFinancialPilotInvoiceStore['record']>(raw, 'record'), context: portMethod<UsFinancialPilotInvoiceStore['context']>(raw, 'context') });
      });
      if (kind === 'catalogue') {
        const code = params.get('code'), cursor = params.get('cursor');
        if (code !== null && !/^txcd_[0-9]{8}$/.test(code) || cursor !== null && !/^txcd_[0-9]{8}$/.test(cursor)) throw new ErpError('invalid_financial_pilot_request', 422);
        const context = await checked(async actor => snapshotPrivateJson(await fiscal.context(actor)) as UsFinancialInvoiceContextV5); await verify(context);
        const page = await provider(async port => {
          if (!port.catalogue) throw new ErpError('binding_unavailable', 409);
          if (code !== null) return { taxCodes: [await port.catalogue.readTaxCode(code)], hasMore: false, nextCursor: null };
          return port.catalogue.listTaxCodes(cursor ?? undefined);
        });
        if (code !== null && page.taxCodes[0]?.id !== code || page.hasMore && page.nextCursor === cursor) return unavailable();
        const result = validateUsFinancialPilotTaxCatalogue({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, ...page }, organizationId);
        const latest = await checked(async actor => snapshotPrivateJson(await fiscal.context(actor)) as UsFinancialInvoiceContextV5); if (!same(context, latest)) throw new ErpError('tax_configuration_changed', 409);
        await admission(); return Response.json(result, { headers });
      }
      const body = await checked(() => readJsonObjectWithinLimit(request, 262_144));
      const issue = kind === 'issue' ? validateUsFinancialPilotInvoiceIssueRequest(body) : undefined;
      const publicRequest: UsFinancialPilotInvoiceRequest = issue?.request ?? validateUsFinancialPilotInvoiceRequest(body);
      const internal = buildUsFinancialPilotInvoiceRequest(publicRequest, organizationId);
      if (internal.command.type !== 'erp_command' || internal.command.request.type !== 'issue_invoice') return unavailable();
      const command = internal.command.request;
      const financialCommandHash = await checked(actor => sha256Hex(canonicalErpJson([organizationId, actor.userId, internal])));
      const erpCommandHash = await checked(actor => sha256Hex(canonicalErpJson([organizationId, actor.userId, { idempotencyKey: internal.idempotencyKey, expectedRevision: internal.expectedRevision, command }])));
      const identity = { request: internal, financialCommandHash, erpCommandHash };
      const matches = (saved: UsFinancialInvoiceOperationV5): UsFinancialInvoiceOperationV5 => { const captured = snapshotPrivateJson(saved) as UsFinancialInvoiceOperationV5; if (!usFinancialPilotInvoiceChoicesMatch(captured, publicRequest)) throw new ErpError('tax_preparation_conflict', 409); return captured; };
      // Every resolver read is decorated: a racing pending operation cannot
      // bypass choice comparison when the original resolver skips its callback.
      const guardedFiscal: UsFinancialInvoiceTestStoreV5 = Object.freeze<UsFinancialInvoiceTestStoreV5>({
        async read(actor, input) { const saved = await fiscal.read(actor, input); return saved === null ? null : matches(saved); },
        async preflight(actor, input) { const result = snapshotPrivateJson(await fiscal.preflight(actor, input)) as Awaited<ReturnType<UsFinancialInvoiceTestStoreV5['preflight']>>; await verify(result.context); return result; },
        async reserve(actor, preparation, resolved) { return matches(await fiscal.reserve(actor, preparation, resolved)); },
        async record(actor, saved, calculated) { matches(saved); return matches(await fiscal.record(actor, saved, calculated)); },
      });
      async function readOperation() { return checked(actor => guardedFiscal.read(actor, identity)); }
      let saved = await readOperation();
      if (issue) {
        if (!saved || saved.status === 'reserved') throw new ErpError('tax_preparation_required', 409);
        const preview = await checked(() => projectUsFinancialPilotInvoicePreview(saved!, publicRequest, deps.allowTestFixtures === true));
        if (preview.reviewId !== issue.reviewId) throw new ErpError('tax_review_changed', 409);
      }
      const resolver = createUsFinancialInvoiceTestResolverV5({ scope: scope.scope, revalidate: async () => {
        const current = await admission(); if (selected) await merchant(); return current.scope;
      }, store: guardedFiscal, choices: async () => {
        // Catalogue presence is technical validation. Human confirmation is
        // the explicit confirmedService value in the captured presentation DTO.
        for (const code of [...new Set(publicRequest.choices.classifications.map(line => line.taxCode))].sort()) {
          const found = await provider(port => { if (!port.catalogue) throw new ErpError('binding_unavailable', 409); return port.catalogue.readTaxCode(code); });
          const page = validateUsFinancialPilotTaxCatalogue({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, taxCodes: [found], hasMore: false, nextCursor: null }, organizationId);
          if (page.taxCodes[0].id !== code) throw new ErpError('unsupported_tax_request', 422);
        }
        return { classifications: publicRequest.choices.classifications.map(line => ({ lineId: line.lineId, taxCode: line.taxCode, kind: 'service' as const, taxBehavior: 'exclusive' as const })),
          taxDateInstant: publicRequest.choices.taxDateInstant, addressSource: publicRequest.choices.addressSource };
      }, gateway: { calculate: resolved => provider(port => port.gateway.calculate(resolved)) }, operationId: deps.operationId, now: deps.now, allowTestFixtures: deps.allowTestFixtures });
      let result: unknown;
      if (kind === 'prepare') {
        if (!saved || saved.status === 'reserved') {
          const raw = await checked(async () => snapshotPrivateJson(await store.read(organizationId)));
          if (raw === null) throw new ErpError('financial_book_required', 409);
          const book = await checked(() => validateUsFinancialBookV5(raw, organizationId, scope!.scope.policy));
          if (book.revision !== internal.expectedRevision) throw new ErpError('revision_conflict', 409);
          await checked(actor => resolver({ organizationId, actor, idempotencyKey: internal.idempotencyKey, commandHash: financialCommandHash, book, command }));
          saved = await readOperation();
        }
        if (!saved || saved.status === 'reserved') return unavailable();
        result = await checked(() => projectUsFinancialPilotInvoicePreview(saved!, publicRequest, deps.allowTestFixtures === true));
      } else {
        const engine: UsFinancialRuntimeDependenciesV5 = { configuration, actor: scope.scope.actor, policy: scope.scope.policy, store,
          revalidate: async () => { const current = await admission(); if (selected) await merchant(); return { configuration: configuration!, actor: current.scope.actor, policy: scope!.scope.policy }; },
          resolveTax: async () => { throw new ErpError('financial_append_unavailable', 409); }, resolveIssuance: resolver };
        let receipt;
        try { receipt = await executeUsFinancialKernelV5(engine, internal); }
        catch (error) { if (!(error instanceof ErpError) || error.code !== 'revision_conflict' || error.status !== 409) throw error; await admission(); receipt = await executeUsFinancialKernelV5(engine, internal); }
        // Historical runtime receipts skip the issuance resolver. Re-prove the
        // same durable review and choices after every successful return.
        saved = await readOperation();
        if (!saved || saved.status !== 'committed') return unavailable();
        const preview = await checked(() => projectUsFinancialPilotInvoicePreview(saved!, publicRequest, deps.allowTestFixtures === true));
        if (preview.reviewId !== issue!.reviewId || receipt.action !== 'erp_command' || !same(receipt, saved.receipt)) return unavailable();
        result = validateUsFinancialPilotInvoiceReceipt({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: receipt.revision, entityId: receipt.entityId, action: 'issue_invoice', requestId: publicRequest.requestId }, organizationId, publicRequest);
      }
      await admission(); return Response.json(result, { headers });
    } catch (error) {
      let latest = error;
      if (trusted) try { if (scope && configuration) await admission(); else await authority(); } catch (fresh) { latest = fresh; }
      return failure(latest, operation, deps.diagnostic);
    }
  }
  return Object.freeze({ PREPARE: (request: Request, organizationId: string) => run(request, organizationId, 'prepare'), ISSUE: (request: Request, organizationId: string) => run(request, organizationId, 'issue'), CATALOGUE: (request: Request, organizationId: string) => run(request, organizationId, 'catalogue') });
}
