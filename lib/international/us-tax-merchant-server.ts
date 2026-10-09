import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import type { StripeTaxTestConfigurationObservation } from './stripe-tax-test-gateway';
import type { CompanyConfiguration } from './types';
import type { ResolvedUsTaxTestMerchant } from './us-tax-merchant-resolver';
import {
  validateCredentialIdentity, validateUsTaxMerchantContext, validateUsTaxMerchantReceipt,
  type UsTaxMerchantContext, type UsTaxMerchantReceipt, type UsTaxMerchantStore,
} from './us-tax-merchant-store';

export type UsTaxMerchantServerDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'rateLimit' | 'diagnostic'> & {
  store(this: void): UsTaxMerchantStore | Promise<UsTaxMerchantStore>;
  merchant(this: void, organizationId: string): Promise<ResolvedUsTaxTestMerchant | null>;
  /** Trusted server clock, never an actor or browser supplied date. */
  now(this: void): string;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const publicErrors: Readonly<Record<string, number>> = Object.freeze({
  invalid_request: 422, unauthorized: 401, session_changed: 401, management_entitlement_required: 402,
  forbidden: 403, owner_permission_required: 403, tenant_mismatch: 403, financial_permission_required: 403,
  feature_unavailable: 404, edition_unavailable: 409, configuration_changed: 409, tax_configuration_changed: 409,
  country_configuration_required: 409, seller_configuration_required: 409, tax_details_required: 409,
  binding_unavailable: 409, tax_binding_changed: 409, tax_merchant_request_conflict: 409,
  rate_limited: 429, service_unavailable: 503, server_clock_unavailable: 503,
});
function normalized(error: unknown): { error: string; status: number } {
  try {
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const statusDescriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
    const code = descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : '';
    const status = statusDescriptor && 'value' in statusDescriptor ? statusDescriptor.value : 503;
    if (error instanceof ErpError && Object.hasOwn(publicErrors, code)) return { error: code, status: publicErrors[code] };
    if (error instanceof RequestBodyError) return { error: 'invalid_request', status: [400, 413, 415].includes(status) ? status : 422 };
    if (error instanceof AccountPublicError || error instanceof ErpError) {
      if (status === 401) return { error: 'unauthorized', status };
      if (status === 402) return { error: 'management_entitlement_required', status };
      if (status === 403) return { error: 'forbidden', status };
      if (error instanceof AccountPublicError && status === 429) return { error: 'rate_limited', status };
    }
  } catch { /* Foreign errors, including getters and proxies, stay private. */ }
  return { error: 'service_unavailable', status: 503 };
}
function instant(input: unknown): bigint {
  if (typeof input !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(input)) throw new ErpError('server_clock_unavailable', 503);
  try {
    const fraction = /\.([0-9]{1,6})(?=Z|[+-])/.exec(input)?.[1] ?? '';
    return BigInt(parseInstant(input.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/, '$1')).getTime()) * BigInt(1000) + BigInt(fraction.padEnd(6, '0').slice(3));
  } catch { throw new ErpError('server_clock_unavailable', 503); }
}
function formatInstant(value: bigint): string {
  return new Date(Number(value / BigInt(1000))).toISOString().replace(/\.[0-9]{3}Z$/, `.${(value % BigInt(1_000_000)).toString().padStart(6, '0')}Z`);
}
function admission(input: unknown, organizationId: string): ErpReadAdmission {
  const value = snapshotPrivateJson(input) as ErpReadAdmission;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'mode') || !Object.hasOwn(value, 'actor') || !['browser', 'device'].includes(value.mode)) throw new ErpError('service_unavailable', 503);
  const actor = value.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || Object.keys(actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(key => Object.hasOwn(actor, key))) throw new ErpError('service_unavailable', 503);
  if (actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId !== actor.userId.trim() || actor.userId.length > 256 || Array.from(actor.userId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(actor.role)) throw new ErpError('service_unavailable', 503);
  if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  instant(actor.timestamp);
  return value;
}
function merchantIdentity(input: ResolvedUsTaxTestMerchant | null): string | null {
  if (input === null) return null;
  const credential = validateCredentialIdentity(input.credential);
  if (typeof input.configurationFingerprint !== 'string' || !hash.test(input.configurationFingerprint) || typeof input.observe !== 'function') throw new ErpError('service_unavailable', 503);
  return canonicalErpJson({ credential, configurationFingerprint: input.configurationFingerprint });
}
function observation(input: unknown, context: UsTaxMerchantContext, merchant: ResolvedUsTaxTestMerchant, now: bigint): StripeTaxTestConfigurationObservation {
  const value = snapshotPrivateJson(input) as StripeTaxTestConfigurationObservation;
  const keys = ['organizationId', 'accountId', 'mode', 'apiVersion', 'settingsSha256', 'registrationsSha256', 'observedAt', 'taxOrigin'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.organizationId !== context.organizationId || value.accountId !== merchant.credential.accountId || value.mode !== 'test' || value.apiVersion !== STRIPE_TAX_API_VERSION || !hash.test(value.settingsSha256) || !hash.test(value.registrationsSha256) || canonicalErpJson(value.taxOrigin) !== canonicalErpJson(context.taxFacts.taxOrigin)) throw new ErpError('service_unavailable', 503);
  const observedAt = instant(value.observedAt);
  if (observedAt > now || now - observedAt >= BigInt(120_000_000)) throw new ErpError('binding_unavailable', 409);
  return value;
}

/** Explicit owner TEST admission only. GET never contacts the provider; neither
 * handler issues invoices, mutates Stripe, or returns an issuance grant. */
export function createUsTaxMerchantHandlers(dependencies: UsTaxMerchantServerDependencies) {
  async function handle(request: Request, organizationId: string, operation: 'read' | 'write'): Promise<Response> {
    let trusted: ErpReadAdmission | undefined, configuration: CompanyConfiguration | undefined;
    let previousClock: bigint | undefined, previousAuthorityTime: bigint | undefined, observationDeadline: bigint | undefined;
    let capturedMerchant = false, merchantKey: string | null = null;
    function clock(): bigint {
      const now = instant(dependencies.now());
      if (previousClock !== undefined && now < previousClock) throw new ErpError('server_clock_unavailable', 503);
      previousClock = now;
      if (observationDeadline !== undefined && now >= observationDeadline) throw new ErpError('service_unavailable', 503);
      return now;
    }
    function observeActor(actor: FinancialAuthority): void {
      const timestamp = instant(actor.timestamp);
      if (timestamp > clock() || previousAuthorityTime !== undefined && timestamp < previousAuthorityTime) throw new ErpError('server_clock_unavailable', 503);
      previousAuthorityTime = timestamp;
    }
    async function revalidate(): Promise<FinancialAuthority> {
      if (!trusted) throw new ErpError('service_unavailable', 503);
      let changed: unknown, authorityFailure: unknown, fresh: ErpReadAdmission | undefined;
      // Collect failures so an unavailable private dependency cannot hide revoked
      // browser/device admission. Only bounded codes reach the response/log.
      if (configuration) try {
        const latest = validateCompanyConfiguration(snapshotPrivateJson(await dependencies.configuration(trusted.actor))); clock();
        if (canonicalErpJson(latest) !== canonicalErpJson(configuration)) throw new ErpError('configuration_changed', 409);
      } catch (error) { changed = error; }
      if (capturedMerchant) try {
        const latest = await dependencies.merchant(organizationId); clock();
        if (merchantIdentity(latest) !== merchantKey) throw new ErpError('tax_binding_changed', 409);
      } catch (error) { changed = error; }
      try {
        fresh = admission(await dependencies.authority(request, organizationId), organizationId);
        confirmErpExpectedUser(request, fresh); confirmErpReadAdmission(trusted, fresh);
        if (fresh.actor.role !== 'owner') throw new ErpError('owner_permission_required', 403);
        observeActor(fresh.actor);
      } catch (error) { changed = error; authorityFailure = error; }
      try { if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404); clock(); }
      catch (error) { changed = error; }
      if (authorityFailure && [401, 402, 403].includes(normalized(authorityFailure).status)) throw authorityFailure;
      if (changed) throw changed;
      return fresh!.actor;
    }
    async function checked<T>(work: (actor: FinancialAuthority) => Promise<T> | T): Promise<T> {
      const actor = await revalidate();
      let result: T | undefined, failure: unknown, failed = false;
      try { result = await work(actor); clock(); } catch (error) { failed = true; failure = error; }
      await revalidate();
      if (failed) throw failure;
      return result as T;
    }
    function verifyReceipt(input: unknown, requestId: string, merchant: ResolvedUsTaxTestMerchant): UsTaxMerchantReceipt {
      const receipt = validateUsTaxMerchantReceipt(input, organizationId, requestId, trusted!.actor.userId);
      if (canonicalErpJson(receipt.credential) !== canonicalErpJson(merchant.credential) || receipt.configurationFingerprint !== merchant.configurationFingerprint) throw new ErpError('tax_binding_changed', 409);
      return receipt;
    }
    try {
      if (!await dependencies.enabled()) return json({ error: 'feature_unavailable' }, 404);
      clock();
      if (request.method !== (operation === 'read' ? 'GET' : 'POST') || typeof organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || [...new URL(request.url).searchParams].length !== 0) throw new ErpError('invalid_request', 422);
      if (operation === 'write' && !request.headers.has('Authorization')) requireAccountSameOrigin(request);
      trusted = admission(await dependencies.authority(request, organizationId), organizationId);
      confirmErpExpectedUser(request, trusted); observeActor(trusted.actor);
      if (trusted.actor.role !== 'owner') throw new ErpError('owner_permission_required', 403);
      if (operation === 'write' && trusted.mode === 'browser') requireAccountSameOrigin(request);
      await checked(actor => dependencies.rateLimit(request, actor, operation));
      configuration = validateCompanyConfiguration(snapshotPrivateJson(await checked(actor => dependencies.configuration(actor))));
      if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
      await revalidate();
      const merchant = await checked(() => dependencies.merchant(organizationId));
      merchantKey = merchantIdentity(merchant); capturedMerchant = true;
      await revalidate();
      if (operation === 'read') {
        if (merchant) {
          const store = await checked(() => dependencies.store());
          const context = validateUsTaxMerchantContext(await checked(actor => store.readContext(actor)), organizationId);
          if (canonicalErpJson(context.configuration) !== canonicalErpJson(configuration)) throw new ErpError('configuration_changed', 409);
          await revalidate();
        }
        return json({ schemaVersion: 1, organizationId, status: merchant ? 'ready_to_observe' : 'unavailable', mode: 'test' });
      }
      const input = await checked(() => readJsonObjectWithinLimit(request, 1_024));
      if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'requestId') || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new ErpError('invalid_request', 422);
      if (!merchant) throw new ErpError('binding_unavailable', 409);
      const requestId = input.requestId, store = await checked(() => dependencies.store());
      const earlier = await checked(actor => store.readReceipt(actor, requestId));
      if (earlier !== null) {
        const receipt = verifyReceipt(earlier, requestId, merchant);
        await revalidate();
        return json({ schemaVersion: 1, organizationId, requestId, status: 'observed_test', replayed: true, configurationChanged: receipt.configurationChanged });
      }
      const context = validateUsTaxMerchantContext(await checked(actor => store.readContext(actor)), organizationId);
      if (canonicalErpJson(context.configuration) !== canonicalErpJson(configuration)) throw new ErpError('configuration_changed', 409);
      observationDeadline = clock() + BigInt(30_000_000);
      const observed = observation(await checked(() => merchant.observe(context.taxFacts.taxOrigin)), context, merchant, clock());
      const validUntil = formatInstant(instant(observed.observedAt) + BigInt(120_000_000));
      const actor = await revalidate();
      // Do not use checked here: a legitimate activation changes tax status. The
      // receipt and a fresh private context establish the new expected snapshot.
      let committed: unknown;
      try {
        committed = await store.activate(actor, { requestId, context, credential: validateCredentialIdentity(merchant.credential), configurationFingerprint: merchant.configurationFingerprint, observation: observed, validUntil });
        clock();
      } catch (error) { await revalidate(); throw error; }
      const receipt = verifyReceipt(committed, requestId, merchant);
      const configurationChanged = context.configuration.taxConfiguration.status === 'unconfigured';
      if (receipt.configurationChanged !== configurationChanged || receipt.countryRevision !== context.countryRevision + (configurationChanged ? 1 : 0) || receipt.binding.revision !== context.bindingRevision + 1 || receipt.binding.observedAt !== observed.observedAt || receipt.binding.validUntil !== validUntil || receipt.binding.settingsSha256 !== observed.settingsSha256 || receipt.binding.registrationsSha256 !== observed.registrationsSha256) throw new ErpError('service_unavailable', 503);
      configuration = validateCompanyConfiguration({ ...context.configuration, taxConfiguration: { status: 'configured' } });
      await revalidate();
      const current = validateUsTaxMerchantContext(await checked(fresh => store.readContext(fresh)), organizationId);
      const expected = { ...context, configuration, countryRevision: receipt.countryRevision, bindingRevision: receipt.binding.revision };
      if (canonicalErpJson(current) !== canonicalErpJson(expected)) throw new ErpError('tax_configuration_changed', 409);
      await revalidate();
      if (instant(receipt.binding.validUntil) <= clock()) throw new ErpError('binding_unavailable', 409);
      return json({ schemaVersion: 1, organizationId, requestId, status: 'observed_test', replayed: false, configurationChanged });
    } catch (error) {
      let current = error;
      if (trusted) try { await revalidate(); } catch (lateError) { current = lateError; }
      const failure = normalized(current);
      try { dependencies.diagnostic({ operation, code: failure.error, status: failure.status }); } catch { /* No raw exception or private payload in diagnostics. */ }
      return json({ error: failure.error }, failure.status);
    }
  }
  return {
    GET: (request: Request, organizationId: string) => handle(request, organizationId, 'read'),
    POST: (request: Request, organizationId: string) => handle(request, organizationId, 'write'),
  };
}
