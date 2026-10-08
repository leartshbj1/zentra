import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion, requireErpClientSchema, type ErpSchemaVersion } from './erp-schema-capability';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import type { CompanyConfiguration } from './types';
import {
  blockedUsTaxReadiness, UsTaxReadinessError, usTaxReadinessSeconds,
  validateUsTaxReadiness, validateUsTaxReadinessEvaluation,
  type UsTaxReadinessEvaluation, type UsTaxReadinessEvaluator,
} from './us-tax-readiness';

export type UsTaxReadinessServerDependencies = Pick<ErpServerDependencies,
  'enabled' | 'authority' | 'configuration' | 'store' | 'freshSupportedSchemaVersion' | 'rateLimit' | 'diagnostic'
> & {
  /** Trusted UTC epoch seconds. Never the actor's/client's date. */
  now(this: void): number;
  readonly evaluate?: UsTaxReadinessEvaluator;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const publicErrors: Readonly<Record<string, number>> = Object.freeze({
  invalid_request: 422, unauthorized: 401, session_changed: 401, management_entitlement_required: 402,
  forbidden: 403, financial_permission_required: 403, financial_authority_changed: 403, tenant_mismatch: 403,
  feature_unavailable: 404, edition_unavailable: 409, client_upgrade_required: 409,
  configuration_changed: 409, rate_limited: 429, service_unavailable: 503,
  invalid_tax_readiness: 503, server_clock_unavailable: 503,
});
function normalized(error: unknown): { error: string; status: number } {
  try {
    // No foreign message/code getter is allowed to run during error projection.
    const codeDescriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const statusDescriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
    const code = codeDescriptor && 'value' in codeDescriptor && typeof codeDescriptor.value === 'string' ? codeDescriptor.value : '';
    const rawStatus = statusDescriptor && 'value' in statusDescriptor ? statusDescriptor.value : 503;
    if (error instanceof UsTaxReadinessError) return { error: code === 'server_clock_unavailable' ? 'server_clock_unavailable' : 'invalid_tax_readiness', status: 503 };
    if (error instanceof ErpError && Object.hasOwn(publicErrors, code)) return { error: code, status: publicErrors[code] };
    const status = error instanceof AccountPublicError || error instanceof ErpError ? rawStatus : 503;
    if (status === 401) return { error: 'unauthorized', status };
    if (status === 402) return { error: 'management_entitlement_required', status };
    if (status === 403) return { error: 'forbidden', status };
    if (error instanceof AccountPublicError && status === 429) return { error: 'rate_limited', status };
  } catch { /* Reflection failure is private, too. */ }
  return { error: 'service_unavailable', status: 503 };
}
function admission(input: unknown, organizationId: string): ErpReadAdmission {
  const value = snapshotPrivateJson(input) as ErpReadAdmission;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'mode') || !Object.hasOwn(value, 'actor') || !['browser', 'device'].includes(value.mode)) throw new ErpError('service_unavailable', 503);
  const actor = value.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || Object.keys(actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(key => Object.hasOwn(actor, key))) throw new ErpError('service_unavailable', 503);
  if (actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 256 || Array.from(actor.userId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(actor.role)) throw new ErpError('service_unavailable', 503);
  if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  try { parseInstant(actor.timestamp); } catch { throw new ErpError('service_unavailable', 503); }
  return value;
}
/** Authenticated volatile information only. GET cannot reserve, calculate,
 * approve or commit an invoice, or change configuration/provider bindings. */
export function createUsTaxReadinessHandlers(dependencies: UsTaxReadinessServerDependencies) {
  return {
    async GET(request: Request, organizationId: string): Promise<Response> {
      let trusted: ErpReadAdmission | undefined, configuration: CompanyConfiguration | undefined;
      let clientCapability: ErpSchemaVersion = 1, capturedCapability: ErpSchemaVersion | undefined;
      let sourceCapability: ErpSchemaVersion | undefined;
      let previousClock: number | undefined, previousAuthorityTime: number | undefined;
      function clock(): number {
        const now = usTaxReadinessSeconds(dependencies.now());
        if (previousClock !== undefined && now < previousClock) throw new UsTaxReadinessError('server_clock_unavailable');
        previousClock = now; return now;
      }
      function observeActor(actor: FinancialAuthority): void {
        const timestamp = parseInstant(actor.timestamp).getTime();
        // Seconds clock rounds down; allow that second's millisecond stamp.
        if (timestamp >= (clock() + 1) * 1000 || previousAuthorityTime !== undefined && timestamp < previousAuthorityTime) throw new UsTaxReadinessError('server_clock_unavailable');
        previousAuthorityTime = timestamp;
      }
      async function revalidate(): Promise<FinancialAuthority> {
        if (!trusted) throw new ErpError('service_unavailable', 503);
        let changed: unknown;
        // Even a failed config/capability read must not conceal a revoked session.
        if (configuration) {
          try {
            const latest = validateCompanyConfiguration(snapshotPrivateJson(await dependencies.configuration(trusted.actor)));
            if (canonicalErpJson(latest) !== canonicalErpJson(configuration)) throw new ErpError('configuration_changed', 409);
          } catch (error) { changed = error; }
        }
        if (capturedCapability !== undefined && dependencies.freshSupportedSchemaVersion) {
          try { requireErpClientSchema(sourceCapability ?? capturedCapability, await dependencies.freshSupportedSchemaVersion(clientCapability)); }
          catch (error) { changed = error; }
        }
        let fresh: ErpReadAdmission | undefined, authorityFailure: unknown;
        try {
          fresh = admission(await dependencies.authority(request, organizationId), organizationId);
          confirmErpExpectedUser(request, fresh); confirmErpReadAdmission(trusted, fresh); observeActor(fresh.actor);
        } catch (error) { changed = error; authorityFailure = error; }
        // Read flags after the last admission await; no cached result is a grant.
        try { if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404); }
        catch (error) { changed = error; }
        try { clock(); } catch (error) { changed = error; }
        // Native/browser callers must purge on actual admission loss even if
        // configuration/capability/flags fail at the same time.
        if (authorityFailure && [401, 402, 403].includes(normalized(authorityFailure).status)) throw authorityFailure;
        if (changed) throw changed;
        return fresh!.actor;
      }
      try {
        if (!await dependencies.enabled()) return json({ error: 'feature_unavailable' }, 404);
        clock();
        if (request.method !== 'GET' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || [...new URL(request.url).searchParams].length !== 0) throw new ErpError('invalid_request', 422);
        trusted = admission(await dependencies.authority(request, organizationId), organizationId);
        confirmErpExpectedUser(request, trusted); observeActor(trusted.actor);
        await dependencies.rateLimit(request, trusted.actor, 'read'); clock();
        clientCapability = erpClientSchemaVersion(request);
        const store = await dependencies.store(clientCapability); clock();
        capturedCapability = store.supportedSchemaVersion ?? 1;
        requireErpClientSchema(capturedCapability, clientCapability);
        if (dependencies.freshSupportedSchemaVersion) requireErpClientSchema(capturedCapability, await dependencies.freshSupportedSchemaVersion(clientCapability));
        let evaluated: UsTaxReadinessEvaluation, effectiveSchemaVersion = capturedCapability;
        try {
          configuration = validateCompanyConfiguration(snapshotPrivateJson(await dependencies.configuration(trusted.actor))); clock();
        } catch (error) {
          if (!(error instanceof ErpError) || error.code !== 'country_configuration_required') throw error;
        }
        if (!configuration) evaluated = blockedUsTaxReadiness('country_configuration_required');
        else {
          if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
          if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
          const state = await store.read(organizationId); clock();
          if (state) {
            requireErpClientSchema(state.schemaVersion, capturedCapability);
            sourceCapability = state.schemaVersion;
            effectiveSchemaVersion = state.schemaVersion;
            if (state.configuration.organizationId !== organizationId || state.configuration.country !== 'US' || state.configuration.currency !== 'USD') throw new ErpError('service_unavailable', 503);
          }
          if (!['owner', 'admin', 'accountant'].includes(trusted.actor.role)) evaluated = blockedUsTaxReadiness('financial_role_required');
          else if (!state) evaluated = blockedUsTaxReadiness('workspace_uninitialized');
          else if (canonicalErpJson(state.configuration) !== canonicalErpJson(configuration)) evaluated = blockedUsTaxReadiness('configuration_outdated');
          else if (configuration.taxConfiguration.status !== 'configured' || !dependencies.evaluate) evaluated = blockedUsTaxReadiness('provider_test_unavailable');
          else evaluated = validateUsTaxReadinessEvaluation(await dependencies.evaluate({ actor: trusted.actor, configuration, state, effectiveSchemaVersion, revalidate }));
        }
        await revalidate();
        const checkedAt = clock();
        if (evaluated.status === 'ready_test' && evaluated.validUntil <= checkedAt) evaluated = blockedUsTaxReadiness('provider_observation_expired');
        const expiresAt = evaluated.status === 'ready_test' ? Math.min(checkedAt + 120, evaluated.validUntil) : checkedAt + 120;
        const base = { schemaVersion: 1, organizationId, currency: 'USD', effectiveSchemaVersion, checkedAt, expiresAt };
        const result = validateUsTaxReadiness(evaluated.status === 'ready_test' ? { ...base, status: 'ready_test' } : { ...base, status: 'blocked', reason: evaluated.reason });
        return json(result);
      } catch (error) {
        let current = error;
        if (trusted) try { await revalidate(); } catch (lateError) { current = lateError; }
        const publicFailure = normalized(current);
        try { dependencies.diagnostic({ operation: 'read', code: publicFailure.error, status: publicFailure.status }); } catch { /* Bounded telemetry only, never raw error/payload. */ }
        return json({ error: publicFailure.error }, publicFailure.status);
      }
    },
  };
}
