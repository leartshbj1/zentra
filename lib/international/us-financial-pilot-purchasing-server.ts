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
import { buildUsFinancialPilotPurchasingRequest, validateUsFinancialPilotPurchasingReceipt, validateUsFinancialPilotPurchasingRequest } from './us-financial-pilot-purchasing';
import { projectUsFinancialPilotVendor, projectUsFinancialPilotVendorBills, projectUsFinancialPilotVendorBill, validateUsFinancialPilotVendorDetail, validateUsFinancialPilotPurchasingPage, validateUsFinancialPilotVendorBillDetail, validateUsFinancialPilotVendorBillsQuery, validateUsFinancialPilotVendorDetailQuery, validateUsFinancialPilotVendorBillDetailQuery } from './us-financial-pilot-purchasing-projection';
import { UsFinancialPilotError, validateUsFinancialPilotHead } from './us-financial-pilot-contract';
import type { UsFinancialPilotDependencies, UsFinancialPilotStore } from './us-financial-pilot-server';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import { creationUuid } from './workspace-creation';

export type UsFinancialPilotPurchasingDependencies = UsFinancialPilotDependencies;
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot' };
const publicCodes: Readonly<Record<string, readonly number[]>> = {
  unauthorized: [401], session_changed: [401], forbidden: [403], tenant_mismatch: [403], management_entitlement_required: [402], financial_permission_required: [403],
  feature_unavailable: [404], financial_pilot_unavailable: [404], financial_pilot_opt_in_required: [403], financial_pilot_opt_in_changed: [409],
  financial_test_grant_required: [403], financial_test_grant_changed: [409], financial_authority_changed: [403], financial_configuration_changed: [409],
  financial_policy_unavailable: [409], financial_upgrade_required: [409], financial_capability_unavailable: [409, 503], financial_book_too_large: [413],
  financial_snapshot_changed: [409], financial_book_required: [409], financial_source_changed: [409], financial_clock_reversed: [409], financial_immutable: [409],
  financial_append_unavailable: [409], invalid_financial_pilot_request: [422], invalid_financial_pilot_query: [422], invalid_financial_request: [422], invalid_financial_date: [422],
  revision_conflict: [409], idempotency_conflict: [409], accounting_period_not_open: [409], overpayment: [409],
  financial_pilot_record_not_found: [404], vendor_required: [422], vendor_already_exists: [409], vendor_bill_already_recorded: [409], vendor_bill_not_found: [404], vendor_payment_already_recorded: [409], invalid_amount: [422], invalid_date: [422], purchase_account_required: [422],
  rate_limited: [429], invalid_request: [400, 413, 415, 422], edition_unavailable: [409], configuration_changed: [409], method_not_allowed: [405],
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
      if (m && 'value' in m && ['INVALID_VENDOR_BILL', 'VENDOR_BILL_TOTAL_MISMATCH', 'INVALID_VENDOR_PAYMENT', 'INVALID_MINOR_AMOUNT', 'INVALID_DATE'].includes(m.value as string)) { code = 'invalid_financial_pilot_request'; status = 422; }
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
type ReadKind = 'bills' | 'bill' | 'vendor';
function parameters(request: Request, operation: 'read' | 'write', kind?: ReadKind): { revision: number; cursor?: string } | undefined {
  if (request.method !== (operation === 'write' ? 'POST' : 'GET')) throw new ErpError('method_not_allowed', 405);
  if (request.url.length > 4096) throw new ErpError('invalid_financial_pilot_request', 422);
  const params = new URL(request.url).searchParams, cursorKey = kind === 'bills' ? 'cursor' : kind === 'bill' ? 'paymentCursor' : undefined;
  for (const key of params.keys()) if (operation === 'write' || (key !== 'revision' && key !== cursorKey) || params.getAll(key).length !== 1) throw new ErpError('invalid_financial_pilot_request', 422);
  if (operation === 'write') return undefined;
  const value = params.get('revision'), cursor = cursorKey ? params.get(cursorKey) : null;
  if (value === null || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= Number.MAX_SAFE_INTEGER || (cursor !== null && (!cursor || cursor.length > 512))) throw new ErpError('invalid_financial_pilot_request', 422);
  return { revision: Number(value), ...(cursor === null ? {} : { cursor }) };
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
/** Three manual purchasing intentions only. The existing private PG wrappers retain
 * their cumulative engine; no browser supplied ledger, role or tax facts enter it. */
export function createUsFinancialPilotPurchasingHandlers(input: UsFinancialPilotPurchasingDependencies) {
  const bind = <K extends keyof UsFinancialPilotDependencies>(key: K): UsFinancialPilotDependencies[K] => {
    const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !('value' in d) || typeof d.value !== 'function') return unavailable();
    return d.value.bind(undefined) as UsFinancialPilotDependencies[K];
  };
  const deps = Object.freeze({ enabled: bind('enabled'), authority: bind('authority'), configuration: bind('configuration'), scope: bind('scope'), store: bind('store'), rateLimit: bind('rateLimit'), diagnostic: bind('diagnostic') });
  async function run(supplied: Request, organizationId: string, operation: 'read' | 'write', kind?: ReadKind, entityId?: string): Promise<Response> {
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
      const query = parameters(request, operation, kind); origin(request, operation);
      if (operation === 'read') {
        if (kind !== 'bills' && (!entityId || entityId !== entityId.trim() || entityId.length > 160 || Array.from(entityId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) throw new ErpError('invalid_financial_pilot_request', 422);
        if (kind === 'bills') validateUsFinancialPilotVendorBillsQuery({ revision: query!.revision, ...(query!.cursor ? { cursor: query!.cursor } : {}) });
        else if (kind === 'bill') validateUsFinancialPilotVendorBillDetailQuery({ revision: query!.revision, billId: entityId, ...(query!.cursor ? { paymentCursor: query!.cursor } : {}) });
        else validateUsFinancialPilotVendorDetailQuery({ revision: query!.revision, vendorId: entityId });
      }
      if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      trusted = await authority(); await deps.rateLimit(request, trusted.actor, operation);
      configuration = validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(trusted.actor)));
      scope = await admission(); const store = capturedStore(await deps.store(scope, admission)); await admission();
      let result: unknown;
      if (operation === 'write') {
        const publicRequest = validateUsFinancialPilotPurchasingRequest(await readJsonObjectWithinLimit(request, 256 * 1024)); await admission();
        const internal = buildUsFinancialPilotPurchasingRequest(publicRequest, organizationId);
        if (publicRequest.command.type === 'save_vendor') {
          // The kernel owns CAS and historical replay. A presentation create
          // cannot overwrite a legacy ID; an edit must select a current vendor.
          const existing = snapshotPrivateJson(await store.receipt(organizationId, internal.idempotencyKey)); await admission();
          if (existing === null) {
            const source = snapshotPrivateJson(await store.read(organizationId)); await admission();
            if (source === null) throw new ErpError('financial_book_required', 409);
            const view = await projectUsFinancialBookV5(await validateUsFinancialBookV5(source, organizationId, scope.scope.policy)); await admission();
            if (view.revision === publicRequest.expectedRevision) {
              if (internal.command.type !== 'erp_command' || internal.command.request.type !== 'save_vendor') return unavailable();
              const vendorId = internal.command.request.vendor.id, found = view.vendors.some(vendor => vendor.id === vendorId);
              const rejected = publicRequest.command.vendorId === null ? (found ? new ErpError('vendor_already_exists', 409) : undefined) : (!found ? new ErpError('vendor_required', 422) : undefined);
              if (rejected) {
                // Reprobe a rejection: the original may have committed between
                // the earlier receipt probe and the source read.
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
        result = validateUsFinancialPilotPurchasingReceipt({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, requestId: publicRequest.requestId, revision: receipt.revision, entityId: receipt.entityId, action: publicRequest.command.type }, organizationId, publicRequest);
      } else {
        const book = snapshotPrivateJson(await store.read(organizationId)); await admission();
        if (book === null) throw new ErpError('financial_book_required', 409);
        const revision = query!.revision;
        if (kind === 'bills') result = validateUsFinancialPilotPurchasingPage(await projectUsFinancialPilotVendorBills(book, { revision, ...(query!.cursor ? { cursor: query!.cursor } : {}) }), organizationId, revision, 'vendor_bills');
        else if (kind === 'bill') result = validateUsFinancialPilotVendorBillDetail(await projectUsFinancialPilotVendorBill(book, { revision, billId: entityId!, ...(query!.cursor ? { paymentCursor: query!.cursor } : {}) }), organizationId, revision, entityId);
        else result = validateUsFinancialPilotVendorDetail(await projectUsFinancialPilotVendor(book, { revision, vendorId: entityId! }), organizationId, revision, entityId);
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
  return Object.freeze({
    POST: (request: Request, organizationId: string) => run(request, organizationId, 'write'),
    BILLS: (request: Request, organizationId: string) => run(request, organizationId, 'read', 'bills'),
    BILL: (request: Request, organizationId: string, billId: string) => run(request, organizationId, 'read', 'bill', billId),
    VENDOR: (request: Request, organizationId: string, vendorId: string) => run(request, organizationId, 'read', 'vendor', vendorId),
  });
}
