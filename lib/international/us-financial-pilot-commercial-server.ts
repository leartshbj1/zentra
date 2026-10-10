import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { LedgerError } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { CompanyConfiguration } from './types';
import { projectUsFinancialBookV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import { executeUsFinancialKernelV5, type UsFinancialRuntimeDependenciesV5, type UsFinancialKernelStoreV5, type UsFinancialReceiptV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotCommercialRequest, validateUsFinancialPilotCommercialReceipt, validateUsFinancialPilotCommercialRequest } from './us-financial-pilot-commercial';
import { projectUsFinancialPilotCustomer, projectUsFinancialPilotEstimate, validateUsFinancialPilotCustomerDetail, validateUsFinancialPilotEstimateDetail } from './us-financial-pilot-commercial-projection';
import { UsFinancialPilotError, validateUsFinancialPilotHead } from './us-financial-pilot-contract';
import type { UsFinancialPilotDependencies, UsFinancialPilotStore } from './us-financial-pilot-server';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import { creationUuid } from './workspace-creation';

export type UsFinancialPilotCommercialDependencies = UsFinancialPilotDependencies;
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot' };
const publicCodes: Readonly<Record<string, readonly number[]>> = {
  unauthorized: [401], session_changed: [401], forbidden: [403], tenant_mismatch: [403], management_entitlement_required: [402], financial_permission_required: [403],
  feature_unavailable: [404], financial_pilot_unavailable: [404], financial_pilot_opt_in_required: [403], financial_pilot_opt_in_changed: [409],
  financial_test_grant_required: [403], financial_test_grant_changed: [409], financial_authority_changed: [403], financial_configuration_changed: [409],
  financial_policy_unavailable: [409], financial_upgrade_required: [409], financial_capability_unavailable: [409, 503], financial_book_too_large: [413],
  financial_snapshot_changed: [409], financial_book_required: [409], financial_source_changed: [409], financial_clock_reversed: [409], financial_immutable: [409],
  financial_append_unavailable: [409], invalid_financial_pilot_request: [422], invalid_financial_request: [422], invalid_financial_date: [422],
  revision_conflict: [409], idempotency_conflict: [409], estimate_revision_conflict: [409], issued_estimate_locked: [409], sales_order_source_locked: [409],
  estimate_not_found: [404], financial_pilot_record_not_found: [404], customer_not_found: [404], customer_required: [422], customer_already_exists: [409], project_not_found: [422], project_archived: [409], project_customer_mismatch: [422],
  number_sequence_exhausted: [409], rate_limited: [429], invalid_request: [400, 413, 415, 422], edition_unavailable: [409], configuration_changed: [409], method_not_allowed: [405],
};
const unavailable = (): never => { throw new ErpError('financial_service_unavailable', 503); };
function failure(error: unknown, operation: 'read' | 'write', diagnostic: UsFinancialPilotDependencies['diagnostic']): Response {
  let status = 503, code = 'financial_service_unavailable';
  try {
    const s = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
    const c = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (error instanceof AccountPublicError && s && 'value' in s && [401, 402, 403, 429].includes(s.value as number)) {
      status = s.value as number; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden';
    } else if (error instanceof RequestBodyError && s && 'value' in s && [400, 413, 415].includes(s.value as number)) { status = s.value as number; code = 'invalid_request'; }
    else if ((error instanceof ErpError || error instanceof UsFinancialPilotError) && c && s && 'value' in c && 'value' in s && typeof c.value === 'string' && Object.hasOwn(publicCodes, c.value) && publicCodes[c.value].includes(s.value as number)) { code = c.value; status = s.value as number; }
    else if (error instanceof LedgerError) {
      const m = Object.getOwnPropertyDescriptor(error, 'message');
      if (m && 'value' in m && ['INVALID_QUANTITY', 'INVALID_UNIT_PRICE', 'INVALID_LINE', 'DUPLICATE_LINE', 'INVALID_ESTIMATE', 'INVALID_PAYMENT_TERMS', 'INVALID_NOTES', 'DOCUMENT_LINES_REQUIRED'].includes(m.value as string)) { code = 'invalid_financial_pilot_request'; status = 422; }
    }
  } catch { /* Private exception getters never become public output. */ }
  try { diagnostic({ operation, code, status }); } catch { /* Telemetry cannot change the outcome. */ }
  return Response.json({ error: code }, { status, headers: { ...headers, ...(status === 405 ? { Allow: operation === 'write' ? 'POST' : 'GET' } : {}) } });
}
function capturedAdmission(value: unknown): ErpReadAdmission {
  const a = snapshotPrivateJson(value) as ErpReadAdmission;
  if (!a || Reflect.ownKeys(a).length !== 2 || !Object.hasOwn(a, 'mode') || !Object.hasOwn(a, 'actor') || !['browser', 'device'].includes(a.mode) || !a.actor || Reflect.ownKeys(a.actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(k => Object.hasOwn(a.actor, k))) return unavailable();
  if (typeof a.actor.organizationId !== 'string' || typeof a.actor.userId !== 'string' || !a.actor.userId || a.actor.userId !== a.actor.userId.trim() || a.actor.userId.length > 256 || Array.from(a.actor.userId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || typeof a.actor.managementEntitled !== 'boolean' || typeof a.actor.timestamp !== 'string' || !Number.isFinite(Date.parse(a.actor.timestamp)) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(a.actor.role)) return unavailable();
  return a;
}
function parameters(request: Request, operation: 'read' | 'write'): number | undefined {
  if (request.method !== (operation === 'write' ? 'POST' : 'GET')) throw new ErpError('method_not_allowed', 405);
  if (request.url.length > 4096) throw new ErpError('invalid_financial_pilot_request', 422);
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (operation === 'write' || key !== 'revision' || params.getAll(key).length !== 1) throw new ErpError('invalid_financial_pilot_request', 422);
  if (operation === 'write') return undefined;
  const value = params.get('revision');
  if (value === null || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= Number.MAX_SAFE_INTEGER) throw new ErpError('invalid_financial_pilot_request', 422);
  return Number(value);
}
function origin(request: Request, operation: 'read' | 'write'): void {
  if (operation === 'write') requireAccountSameOrigin(request);
  const site = request.headers.get('Sec-Fetch-Site'), supplied = request.headers.get('Origin');
  if (supplied ? supplied !== new URL(request.url).origin : !['same-origin', 'none'].includes(site ?? '')) throw new ErpError('forbidden', 403);
  if (site && !['same-origin', 'none'].includes(site)) throw new ErpError('forbidden', 403);
}
function capturedStore(input: UsFinancialPilotStore): UsFinancialPilotStore {
  const method = <K extends 'read' | 'receipt' | 'commit' | 'head'>(key: K): UsFinancialPilotStore[K] => {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !('value' in d) || typeof d.value !== 'function') return unavailable();
    return d.value.bind(undefined) as UsFinancialPilotStore[K];
  };
  const d = Object.getOwnPropertyDescriptor(input, 'capability'); if (!d || !('value' in d)) return unavailable();
  return Object.freeze({ capability: snapshotPrivateJson(d.value) as UsFinancialKernelStoreV5['capability'], read: method('read'), receipt: method('receipt'), commit: method('commit'), head: method('head') });
}
/** Bounded commercial intentions only. The existing private PG wrappers retain
 * their cumulative engine; no browser supplied ledger, role or tax facts enter it. */
export function createUsFinancialPilotCommercialHandlers(input: UsFinancialPilotCommercialDependencies) {
  const bind = <K extends keyof UsFinancialPilotDependencies>(key: K): UsFinancialPilotDependencies[K] => {
    const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !('value' in d) || typeof d.value !== 'function') return unavailable();
    return d.value.bind(undefined) as UsFinancialPilotDependencies[K];
  };
  const deps = Object.freeze({ enabled: bind('enabled'), authority: bind('authority'), configuration: bind('configuration'), scope: bind('scope'), store: bind('store'), rateLimit: bind('rateLimit'), diagnostic: bind('diagnostic') });
  async function run(supplied: Request, organizationId: string, operation: 'read' | 'write', recordId?: string, detailKind: 'estimate' | 'customer' = 'estimate'): Promise<Response> {
    const request = new Request(supplied); let trusted: ErpReadAdmission | undefined, scope: UsFinancialPilotScope | undefined, configuration: CompanyConfiguration | undefined;
    async function authority() {
      const fresh = capturedAdmission(await deps.authority(request, organizationId)); confirmErpExpectedUser(request, fresh);
      if (fresh.mode !== 'browser') throw new ErpError('forbidden', 403);
      if (fresh.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (!fresh.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402);
      if (!['owner', 'admin', 'accountant'].includes(fresh.actor.role)) throw new ErpError('financial_permission_required', 403);
      if (trusted) confirmErpReadAdmission(trusted, fresh); return fresh;
    }
    async function admission(): Promise<UsFinancialPilotScope> {
      const fresh = await authority(); if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      const config = validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(fresh.actor)));
      if (config.organizationId !== organizationId || config.country !== 'US' || config.currency !== 'USD' || config.accountingBasis !== 'accrual') throw new ErpError('edition_unavailable', 409);
      if (configuration && canonicalErpJson(configuration) !== canonicalErpJson(config)) throw new ErpError('financial_configuration_changed', 409);
      const current = captureUsFinancialPilotScope(await deps.scope(fresh.actor, scope));
      if (current.scope.organizationId !== organizationId || current.scope.actor.userId !== fresh.actor.userId || current.scope.actor.role !== fresh.actor.role) throw new ErpError('financial_authority_changed', 403);
      if (scope && current.optInVersion !== scope.optInVersion) throw new ErpError('financial_pilot_opt_in_changed', 409);
      if (scope && current.scope.grantVersion !== scope.scope.grantVersion) throw new ErpError('financial_test_grant_changed', 409);
      if (scope && canonicalErpJson(current.scope.policy) !== canonicalErpJson(scope.scope.policy)) throw new ErpError('financial_policy_unavailable', 409);
      await authority(); if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      if (request.signal.aborted) return unavailable(); return current;
    }
    try {
      if (request.headers.has('Authorization')) throw new ErpError('forbidden', 403);
      if (request.headers.get('X-Zentra-Financial-Pilot') !== '1' || !request.headers.get('X-Zentra-Expected-User')) throw new ErpError('invalid_financial_pilot_request', 422);
      try { creationUuid(organizationId); } catch { throw new ErpError('invalid_financial_pilot_request', 422); }
      const revision = parameters(request, operation); origin(request, operation);
      if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      trusted = await authority(); await deps.rateLimit(request, trusted.actor, operation);
      configuration = validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(trusted.actor)));
      scope = await admission(); const store = capturedStore(await deps.store(scope, admission)); await admission();
      let result: unknown;
      if (operation === 'write') {
        const publicRequest = validateUsFinancialPilotCommercialRequest(await readJsonObjectWithinLimit(request, 256 * 1024)); await admission();
        const internal = buildUsFinancialPilotCommercialRequest(publicRequest, organizationId);
        if (publicRequest.command.type === 'create_customer' || publicRequest.command.type === 'update_customer' || publicRequest.command.type === 'save_estimate') {
          // Exact historical replay wins over current state. New creates cannot
          // overwrite a legacy ID, and retained line IDs come from this quote.
          // The runtime still owns the authoritative global revision/CAS check.
          const existing = snapshotPrivateJson(await store.receipt(organizationId, internal.idempotencyKey)); await admission();
          if (existing === null) {
            const source = snapshotPrivateJson(await store.read(organizationId)); await admission();
            if (source === null) throw new ErpError('financial_book_required', 409);
            const view = await projectUsFinancialBookV5(await validateUsFinancialBookV5(source, organizationId, scope.scope.policy)); await admission();
            // An original request can commit between the receipt probe and this
            // read. A changed head goes to the runtime's receipt-first path.
            if (view.revision === publicRequest.expectedRevision) {
              let rejected: unknown;
              try {
                if (publicRequest.command.type === 'create_customer') {
                  if (internal.command.type !== 'erp_command' || internal.command.request.type !== 'save_customer') return unavailable();
                  const customerId = internal.command.request.customer.id;
                  if (view.customers.some(customer => customer.id === customerId)) throw new ErpError('customer_already_exists', 409);
                } else if (publicRequest.command.type === 'update_customer') {
                  const customerId = publicRequest.command.customerId;
                  if (!view.customers.some(customer => customer.id === customerId)) throw new ErpError('customer_not_found', 404);
                } else {
                  const command = publicRequest.command, selected = command.estimateId === null ? undefined : view.estimates.find(estimate => estimate.id === command.estimateId);
                  if ((selected?.revision ?? 0) !== command.expectedEstimateRevision) throw new ErpError('estimate_revision_conflict', 409);
                  if (selected && view.invoices.some(invoice => invoice.sourceEstimateId === selected.id)) throw new ErpError('issued_estimate_locked', 409);
                  const retainedIds = new Set(selected?.lines.map(line => line.id) ?? []);
                  if (command.lines.some(line => line.id !== null && !retainedIds.has(line.id))) throw new ErpError('invalid_financial_pilot_request', 422);
                }
              } catch (error) { rejected = error; }
              if (rejected) {
                const replay = snapshotPrivateJson(await store.receipt(organizationId, internal.idempotencyKey)); await admission();
                if (replay === null) throw rejected;
              }
            }
          }
        }
        const engine: UsFinancialRuntimeDependenciesV5 = { configuration, actor: scope.scope.actor, policy: scope.scope.policy, store, revalidate: async () => { const current = await admission(); return { configuration: configuration!, actor: current.scope.actor, policy: current.scope.policy }; }, resolveTax: async () => { throw new ErpError('financial_append_unavailable', 409); } };
        let receipt: UsFinancialReceiptV5;
        try { receipt = await executeUsFinancialKernelV5(engine, internal); }
        catch (error) {
          const c = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined, s = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
          if (!(error instanceof ErpError) || !c || !s || !('value' in c) || !('value' in s) || c.value !== 'revision_conflict' || s.value !== 409) throw error;
          // One bounded receipt-first recovery. The exact envelope is retained;
          // monotone CAS prevents a new write when the head already advanced.
          await admission(); receipt = await executeUsFinancialKernelV5(engine, internal);
        }
        if (receipt.action !== 'erp_command') return unavailable();
        result = validateUsFinancialPilotCommercialReceipt({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: receipt.revision, entityId: receipt.entityId, action: publicRequest.command.type }, organizationId, publicRequest);
      } else {
        if (!recordId || recordId !== recordId.trim() || recordId.length > 160 || Array.from(recordId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new ErpError('invalid_financial_pilot_request', 422);
        const book = snapshotPrivateJson(await store.read(organizationId)); await admission();
        if (book === null) throw new ErpError('financial_book_required', 409);
        result = detailKind === 'customer'
          ? validateUsFinancialPilotCustomerDetail(await projectUsFinancialPilotCustomer(book, { revision: revision!, customerId: recordId }), organizationId, revision, recordId)
          : validateUsFinancialPilotEstimateDetail(await projectUsFinancialPilotEstimate(book, { revision: revision!, estimateId: recordId }), organizationId, revision, recordId);
        const head = validateUsFinancialPilotHead(await store.head(), organizationId); if (head.revision !== revision) throw new ErpError('financial_snapshot_changed', 409);
      }
      await admission(); return Response.json(result, { headers });
    } catch (error) {
      let latest = error;
      // A rejected async projection/read is still source-dependent. It is only
      // publishable while the full captured admission remains demonstrable.
      // A late admission outage intentionally becomes a generic closed 503.
      if (trusted) try { if (scope && configuration) await admission(); else await authority(); } catch (fresh) { latest = fresh; }
      return failure(latest, operation, deps.diagnostic);
    }
  }
  return Object.freeze({ POST: (request: Request, organizationId: string) => run(request, organizationId, 'write'), ESTIMATE: (request: Request, organizationId: string, estimateId: string) => run(request, organizationId, 'read', estimateId), CUSTOMER: (request: Request, organizationId: string, customerId: string) => run(request, organizationId, 'read', customerId, 'customer') });
}
