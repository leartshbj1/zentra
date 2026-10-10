import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { CompanyConfiguration } from './types';
import {
  executeUsFinancialPilotSeller, US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES, US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES,
  validateUsFinancialPilotSellerHead, validateUsFinancialPilotSellerRead, validateUsFinancialPilotSellerReceipt, validateUsFinancialPilotSellerRequest,
  type UsFinancialPilotSellerPort,
} from './us-financial-pilot-seller';
import type { UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import { creationUuid } from './workspace-creation';

export type UsFinancialPilotSellerServerDependencies = Omit<UsFinancialPilotDependencies, 'store'> & {
  store(this: void, scope: UsFinancialPilotScope, revalidate: () => Promise<UsFinancialPilotScope>): Promise<UsFinancialPilotSellerPort> | UsFinancialPilotSellerPort;
  writeEnabled(this: void): Promise<boolean>;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot' };
const fail = (code = 'financial_service_unavailable', status = 503): never => { throw new ErpError(code, status); };
const codes: Readonly<Record<string, readonly number[]>> = {
  unauthorized: [401], session_changed: [401], forbidden: [403], tenant_mismatch: [403], management_entitlement_required: [402], financial_permission_required: [403],
  feature_unavailable: [404], financial_pilot_unavailable: [404], financial_pilot_opt_in_required: [403], financial_pilot_opt_in_changed: [409],
  financial_test_grant_required: [403], financial_test_grant_changed: [409], financial_authority_changed: [403], financial_configuration_changed: [409],
  financial_policy_unavailable: [409], financial_upgrade_required: [409], financial_capability_unavailable: [409, 503], financial_snapshot_changed: [409],
  financial_book_required: [409], financial_source_changed: [409], financial_clock_reversed: [409], financial_append_unavailable: [409],
  invalid_financial_pilot_request: [422], invalid_financial_pilot_query: [422], invalid_financial_seller_data: [503], financial_service_unavailable: [503],
  financial_pilot_seller_required: [409], seller_revision_conflict: [409], seller_idempotency_conflict: [409], seller_clock_conflict: [409], seller_limit_reached: [409], seller_writes_disabled: [409],
  revision_conflict: [409], idempotency_conflict: [409], rate_limited: [429], invalid_request: [400, 413, 415, 422], edition_unavailable: [409], method_not_allowed: [405],
};
function failure(error: unknown, operation: 'read' | 'write', diagnostic: UsFinancialPilotDependencies['diagnostic']): Response {
  let status = 503, code = 'financial_service_unavailable';
  try {
    const s = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
    const c = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (error instanceof AccountPublicError && s && 'value' in s && [401, 402, 403, 429].includes(s.value as number)) { status = s.value as number; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden'; }
    else if (error instanceof RequestBodyError && s && 'value' in s && [400, 413, 415].includes(s.value as number)) { status = s.value as number; code = 'invalid_request'; }
    else if (error instanceof ErpError && c && s && 'value' in c && 'value' in s && typeof c.value === 'string' && Object.hasOwn(codes, c.value) && codes[c.value].includes(s.value as number)) { code = c.value; status = s.value as number; }
  } catch { /* Private exception fields are never evaluated. */ }
  try { diagnostic({ operation, code, status }); } catch { /* Diagnostics cannot grant access. */ }
  return Response.json({ error: code }, { status, headers: { ...headers, ...(status === 405 ? { Allow: operation === 'write' ? 'POST' : 'GET' } : {}) } });
}
function admissionSnapshot(value: unknown): ErpReadAdmission {
  const data = snapshotPrivateJson(value) as ErpReadAdmission;
  if (!data || Reflect.ownKeys(data).length !== 2 || !Object.hasOwn(data, 'mode') || !Object.hasOwn(data, 'actor') || !['browser', 'device'].includes(data.mode) || !data.actor || Reflect.ownKeys(data.actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(key => Object.hasOwn(data.actor, key))) return fail();
  const actor = data.actor;
  if (typeof actor.organizationId !== 'string' || typeof actor.userId !== 'string' || !actor.userId || actor.userId !== actor.userId.trim() || actor.userId.length > 256 || Array.from(actor.userId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || typeof actor.managementEntitled !== 'boolean' || typeof actor.timestamp !== 'string' || !Number.isFinite(Date.parse(actor.timestamp)) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(actor.role)) return fail();
  return data;
}
function capturedStore(value: UsFinancialPilotSellerPort): UsFinancialPilotSellerPort {
  const method = <K extends keyof UsFinancialPilotSellerPort>(key: K): UsFinancialPilotSellerPort[K] => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return fail();
    return descriptor.value.bind(undefined) as UsFinancialPilotSellerPort[K];
  };
  return Object.freeze({ read: method('read'), head: method('head'), receipt: method('receipt'), append: method('append') });
}
function query(request: Request, write: boolean): 'head' | Readonly<{ revision: number; sellerRevision: number }> | undefined {
  if (request.method !== (write ? 'POST' : 'GET')) return fail('method_not_allowed', 405);
  if (request.url.length > 4096) return fail('invalid_financial_pilot_query', 422);
  const parameters = new URL(request.url).searchParams;
  const keys = [...parameters.keys()];
  if (write) { if (keys.length) return fail('invalid_financial_pilot_query', 422); return undefined; }
  if (keys.length === 1 && parameters.get('view') === 'head') return 'head';
  if (keys.length !== 2 || keys.some(key => !['revision', 'sellerRevision'].includes(key) || parameters.getAll(key).length !== 1)) return fail('invalid_financial_pilot_query', 422);
  const number = (key: string): number => { const raw = parameters.get(key); if (!raw || !/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) >= Number.MAX_SAFE_INTEGER) return fail('invalid_financial_pilot_query', 422); return Number(raw); };
  return Object.freeze({ revision: number('revision'), sellerRevision: number('sellerRevision') });
}
export function createUsFinancialPilotSellerHandlers(input: UsFinancialPilotSellerServerDependencies) {
  const bind = <K extends keyof UsFinancialPilotSellerServerDependencies>(key: K): UsFinancialPilotSellerServerDependencies[K] => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return fail();
    return descriptor.value.bind(undefined) as UsFinancialPilotSellerServerDependencies[K];
  };
  const deps = Object.freeze({ enabled: bind('enabled'), writeEnabled: bind('writeEnabled'), authority: bind('authority'), configuration: bind('configuration'), scope: bind('scope'), store: bind('store'), rateLimit: bind('rateLimit'), diagnostic: bind('diagnostic') });
  async function run(supplied: Request, organizationId: string, write: boolean): Promise<Response> {
    const request = new Request(supplied), operation = write ? 'write' : 'read';
    let trusted: ErpReadAdmission | undefined, scope: UsFinancialPilotScope | undefined, configuration: CompanyConfiguration | undefined;
    async function authority(): Promise<ErpReadAdmission> {
      const fresh = admissionSnapshot(await deps.authority(request, organizationId)); confirmErpExpectedUser(request, fresh);
      if (fresh.mode !== 'browser') return fail('forbidden', 403);
      if (fresh.actor.organizationId !== organizationId) return fail('tenant_mismatch', 403);
      if (!fresh.actor.managementEntitled) return fail('management_entitlement_required', 402);
      if (write ? fresh.actor.role !== 'owner' : !['owner', 'admin', 'accountant'].includes(fresh.actor.role)) return fail('financial_permission_required', 403);
      if (trusted) confirmErpReadAdmission(trusted, fresh); return fresh;
    }
    async function admission(): Promise<UsFinancialPilotScope> {
      const fresh = await authority(); if (!await deps.enabled()) return fail('feature_unavailable', 404);
      const config = validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(fresh.actor)));
      if (config.organizationId !== organizationId || config.country !== 'US' || config.currency !== 'USD' || config.accountingBasis !== 'accrual') return fail('edition_unavailable', 409);
      if (configuration && canonicalErpJson(configuration) !== canonicalErpJson(config)) return fail('financial_configuration_changed', 409);
      const current = captureUsFinancialPilotScope(await deps.scope(fresh.actor, scope));
      if (current.scope.organizationId !== organizationId || current.scope.actor.userId !== fresh.actor.userId || current.scope.actor.role !== fresh.actor.role) return fail('financial_authority_changed', 403);
      if (scope && current.optInVersion !== scope.optInVersion) return fail('financial_pilot_opt_in_changed', 409);
      if (scope && current.scope.grantVersion !== scope.scope.grantVersion) return fail('financial_test_grant_changed', 409);
      if (scope && canonicalErpJson(current.scope.policy) !== canonicalErpJson(scope.scope.policy)) return fail('financial_policy_unavailable', 409);
      await authority(); if (!await deps.enabled()) return fail('feature_unavailable', 404);
      if (request.signal.aborted) return fail(); return current;
    }
    try {
      if (request.headers.has('Authorization')) return fail('forbidden', 403);
      if (request.headers.get('X-Zentra-Financial-Pilot') !== '1' || !request.headers.get('X-Zentra-Expected-User')) return fail('invalid_financial_pilot_request', 422);
      try { creationUuid(organizationId); } catch { return fail('invalid_financial_pilot_request', 422); }
      const parsed = query(request, write), url = new URL(request.url);
      if (url.pathname !== `/api/international/workspaces/${organizationId}/financial-pilot/seller`) return fail('invalid_financial_pilot_request', 422);
      if (write) requireAccountSameOrigin(request);
      const site = request.headers.get('Sec-Fetch-Site'), origin = request.headers.get('Origin');
      if (origin ? origin !== url.origin : !['same-origin', 'none'].includes(site ?? '')) return fail('forbidden', 403);
      if (site && !['same-origin', 'none'].includes(site)) return fail('forbidden', 403);
      if (!await deps.enabled()) return fail('feature_unavailable', 404);
      trusted = await authority(); await deps.rateLimit(request, trusted.actor, operation);
      configuration = validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(trusted.actor)));
      scope = await admission(); const store = capturedStore(await deps.store(scope, admission)); await admission();
      let result: unknown;
      if (write) {
        const requestBody = validateUsFinancialPilotSellerRequest(await readJsonObjectWithinLimit(request, US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES)); await admission();
        const receipt = await executeUsFinancialPilotSeller({ organizationId, actor: scope.scope.actor, policy: scope.scope.policy, store, writeEnabled: deps.writeEnabled,
          revalidate: async () => { const current = await admission(); return { actor: current.scope.actor, policy: current.scope.policy }; } }, requestBody);
        result = await validateUsFinancialPilotSellerReceipt(receipt, organizationId, { request: requestBody, actor: scope.scope.actor });
      } else if (parsed === 'head') result = validateUsFinancialPilotSellerHead(await store.head(), organizationId);
      else {
        if (!parsed) return fail();
        const read = validateUsFinancialPilotSellerRead(await store.read(), organizationId); await admission();
        if (read.head.revision !== parsed.revision) return fail('financial_snapshot_changed', 409);
        if (read.head.sellerRevision !== parsed.sellerRevision) return fail('seller_revision_conflict', 409);
        const head = validateUsFinancialPilotSellerHead(await store.head(), organizationId); await admission();
        if (head.revision !== parsed.revision) return fail('financial_snapshot_changed', 409);
        if (head.sellerRevision !== parsed.sellerRevision) return fail('seller_revision_conflict', 409);
        result = read;
      }
      const body = JSON.stringify(result); if (new TextEncoder().encode(body).byteLength > US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES) return fail();
      await admission(); return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json' } });
    } catch (error) {
      let latest = error; if (trusted) try { await admission(); } catch (fresh) { latest = fresh; }
      return failure(latest, operation, deps.diagnostic);
    }
  }
  return Object.freeze({ GET: (request: Request, organizationId: string) => run(request, organizationId, false), POST: (request: Request, organizationId: string) => run(request, organizationId, true) });
}
