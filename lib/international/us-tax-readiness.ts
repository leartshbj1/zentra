import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateUsSellerProfileWrite } from './seller-profile';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import type { ErpState } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { UsTaxFinancialContext, UsTaxFinancialContextReader } from './us-tax-financial-context';
import type { UsTaxInvoiceTestGateway } from './us-tax-invoice';
import { validateUsTaxFacts } from './us-tax-profile';

export const US_TAX_READINESS_REASONS = Object.freeze([
  'financial_role_required', 'workspace_uninitialized', 'country_configuration_required',
  'configuration_outdated', 'seller_configuration_required', 'tax_details_required',
  'provider_test_unavailable', 'provider_observation_expired', 'scope_not_supported',
] as const);
export type UsTaxReadinessReason = typeof US_TAX_READINESS_REASONS[number];
type ReadinessBase = Readonly<{
  schemaVersion: 1; organizationId: string; currency: 'USD';
  effectiveSchemaVersion: ErpSchemaVersion; checkedAt: number; expiresAt: number;
}>;
export type UsTaxReadiness = ReadinessBase & (
  Readonly<{ status: 'ready_test' }> | Readonly<{ status: 'blocked'; reason: UsTaxReadinessReason }>
);
/** This internal deadline only narrows the public lifetime. It is not proof. */
export type UsTaxReadinessEvaluation = Readonly<{ status: 'ready_test'; validUntil: number }> |
  Readonly<{ status: 'blocked'; reason: UsTaxReadinessReason }>;
export interface UsTaxReadinessEvaluationInput {
  readonly actor: FinancialAuthority;
  readonly configuration: CompanyConfiguration;
  readonly state: ErpState;
  readonly effectiveSchemaVersion: ErpSchemaVersion;
  /** Real Auth/D1/configuration/capability/flag admission, never body claims. */
  revalidate(this: void): Promise<FinancialAuthority>;
}
export type UsTaxReadinessEvaluator = (input: UsTaxReadinessEvaluationInput) => Promise<UsTaxReadinessEvaluation>;
export class UsTaxReadinessError extends Error {
  readonly status = 503;
  constructor(readonly code: 'invalid_tax_readiness' | 'server_clock_unavailable' = 'invalid_tax_readiness') {
    super(code); this.name = 'UsTaxReadinessError';
  }
}
const invalid = (): never => { throw new UsTaxReadinessError(); };
export function usTaxReadinessSeconds(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > 253402300679) throw new UsTaxReadinessError('server_clock_unavailable');
  return input as number;
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = snapshotPrivateJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function reason(input: unknown): UsTaxReadinessReason {
  if (!US_TAX_READINESS_REASONS.includes(input as UsTaxReadinessReason)) return invalid();
  return input as UsTaxReadinessReason;
}
export function validateUsTaxReadinessEvaluation(input: unknown): UsTaxReadinessEvaluation {
  try {
    const value = snapshotPrivateJson(input) as Record<string, unknown>;
    if (value?.status === 'blocked') {
      const row = object(value, ['status', 'reason']);
      return Object.freeze({ status: 'blocked', reason: reason(row.reason) });
    }
    const row = object(value, ['status', 'validUntil']);
    if (row.status !== 'ready_test') return invalid();
    return Object.freeze({ status: 'ready_test', validUntil: usTaxReadinessSeconds(row.validUntil) });
  } catch { return invalid(); }
}
/** Exact public projection. No provider, private facts, revision or grant. */
export function validateUsTaxReadiness(input: unknown): UsTaxReadiness {
  try {
    const copied = snapshotPrivateJson(input) as Record<string, unknown>;
    const row = object(copied, ['schemaVersion', 'organizationId', 'currency', 'effectiveSchemaVersion', 'checkedAt', 'expiresAt', 'status', ...(copied?.status === 'blocked' ? ['reason'] : [])]);
    if (row.schemaVersion !== 1 || row.currency !== 'USD' || typeof row.organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.organizationId) || ![1, 2, 3, 4].includes(row.effectiveSchemaVersion as number)) return invalid();
    const checkedAt = usTaxReadinessSeconds(row.checkedAt), expiresAt = usTaxReadinessSeconds(row.expiresAt);
    if (expiresAt <= checkedAt || expiresAt - checkedAt > 120) return invalid();
    const base = { schemaVersion: 1 as const, organizationId: row.organizationId, currency: 'USD' as const, effectiveSchemaVersion: row.effectiveSchemaVersion as ErpSchemaVersion, checkedAt, expiresAt };
    if (row.status === 'ready_test') return Object.freeze({ ...base, status: 'ready_test' });
    if (row.status === 'blocked') return Object.freeze({ ...base, status: 'blocked', reason: reason(row.reason) });
    return invalid();
  } catch { return invalid(); }
}
export const blockedUsTaxReadiness = (reason: UsTaxReadinessReason): UsTaxReadinessEvaluation => Object.freeze({ status: 'blocked', reason });
function contextInstant(input: unknown): bigint {
  if (typeof input !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) return invalid();
  try {
    const date = parseInstant(input.replace(/(\.\d{3})\d{1,3}(?=Z|[+-])/, '$1'));
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return invalid();
    const fraction = /\.([0-9]+)(?=Z|[+-])/.exec(input)?.[1] ?? '';
    return BigInt(date.getTime()) * BigInt(1000) + BigInt(fraction.padEnd(6, '0').slice(3));
  } catch { return invalid(); }
}
function revision(input: unknown): boolean { return Number.isSafeInteger(input) && (input as number) > 0 && (input as number) < Number.MAX_SAFE_INTEGER; }
function contextReason(input: UsTaxFinancialContext, admitted: FinancialAuthority, configuration: CompanyConfiguration, now: number): UsTaxReadinessReason | null {
  const context = object(input, ['organizationId', 'actor', 'recordedAt', 'countryRevision', 'configuration', 'sellerRevision', 'seller', 'taxFactsRevision', 'taxFacts', 'binding']) as unknown as UsTaxFinancialContext;
  object(context.actor, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (context.organizationId !== admitted.organizationId || context.actor.organizationId !== admitted.organizationId || context.actor.userId !== admitted.userId || context.actor.role !== admitted.role || context.actor.managementEntitled !== true) throw new ErpError('financial_authority_changed', 403);
  const contextAuthorityTime = parseInstant(context.actor.timestamp).getTime();
  if (contextAuthorityTime < parseInstant(admitted.timestamp).getTime() || contextAuthorityTime >= (now + 1) * 1000) return invalid();
  if (canonicalErpJson(validateCompanyConfiguration(context.configuration)) !== canonicalErpJson(configuration)) return 'configuration_outdated';
  // The public/server clock has second precision. A legitimate microsecond
  // observation may fall anywhere inside that second, never in the next one.
  if (![context.countryRevision, context.sellerRevision, context.taxFactsRevision].every(revision) || contextInstant(context.recordedAt) >= BigInt(now + 1) * BigInt(1000000)) return invalid();
  if (canonicalErpJson(validateUsTaxFacts(context.taxFacts)) !== canonicalErpJson(context.taxFacts)) return invalid();
  const profile = validateUsSellerProfileWrite({ expectedRevision: 0, requestId: '00000000-0000-4000-8000-000000000000', profile: context.seller }).profile;
  if (canonicalErpJson(profile) !== canonicalErpJson(context.seller)) return invalid();
  const binding = object(context.binding, ['organizationId', 'accountId', 'mode', 'apiVersion', 'revision', 'settingsSha256', 'registrationsSha256', 'observedAt', 'validUntil', 'evidenceKind', 'scope']) as unknown as UsTaxFinancialContext['binding'];
  if (binding.organizationId !== admitted.organizationId) return invalid();
  if (binding.mode !== 'test' || binding.apiVersion !== STRIPE_TAX_API_VERSION || binding.evidenceKind !== 'provider_observation') return 'provider_test_unavailable';
  if (binding.scope !== 'erp_invoice_tax') return 'scope_not_supported';
  if (!revision(binding.revision) || typeof binding.accountId !== 'string' || !/^acct_[A-Za-z0-9]{1,95}$/.test(binding.accountId) || ![binding.settingsSha256, binding.registrationsSha256].every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))) return invalid();
  const observed = contextInstant(binding.observedAt), until = contextInstant(binding.validUntil), clock = BigInt(now) * BigInt(1000000);
  if (observed >= BigInt(now + 1) * BigInt(1000000) || until <= observed) return 'provider_test_unavailable';
  if (until <= clock || until / BigInt(1000000) <= BigInt(now)) return 'provider_observation_expired';
  return null;
}
function knownBlocked(error: unknown): UsTaxReadinessReason | null {
  if (!(error instanceof ErpError)) return null;
  const reasons: Readonly<Record<string, UsTaxReadinessReason>> = {
    country_configuration_required: 'country_configuration_required', seller_configuration_required: 'seller_configuration_required',
    tax_details_required: 'tax_details_required', binding_unavailable: 'provider_test_unavailable', tax_binding_unavailable: 'provider_test_unavailable',
    tax_configuration_changed: 'configuration_outdated', unsupported_tax_request: 'scope_not_supported',
    provider_observation_expired: 'provider_observation_expired', provider_test_unavailable: 'provider_test_unavailable',
  };
  return Object.hasOwn(reasons, error.code) ? reasons[error.code] : null;
}
/** Read-only observed-provider evaluation. No gateway/reader by default and no
 * fixture override. Readiness never approves a line classification or invoice:
 * the issuer must independently resolve and validate the exact command. */
export function createUsTaxReadinessEvaluator(dependencies: {
  readonly contexts?: UsTaxFinancialContextReader;
  readonly gateway?: Pick<UsTaxInvoiceTestGateway, 'verify'>;
  now(this: void): number;
}): UsTaxReadinessEvaluator {
  return async input => {
    const initialActor = snapshotPrivateJson(input.actor) as FinancialAuthority;
    const configuration = validateCompanyConfiguration(snapshotPrivateJson(input.configuration));
    const revalidate = input.revalidate;
    if (configuration.organizationId !== initialActor.organizationId || configuration.country !== 'US' || configuration.currency !== 'USD') return invalid();
    if (initialActor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
    if (!['owner', 'admin', 'accountant'].includes(initialActor.role)) return blockedUsTaxReadiness('financial_role_required');
    if (!dependencies.contexts || !dependencies.gateway) return blockedUsTaxReadiness('provider_test_unavailable');
    let previousClock = usTaxReadinessSeconds(dependencies.now()), previousAuthorityTime = parseInstant(initialActor.timestamp).getTime();
    function clock(): number {
      const current = usTaxReadinessSeconds(dependencies.now());
      if (current < previousClock) throw new UsTaxReadinessError('server_clock_unavailable');
      previousClock = current; return current;
    }
    async function admitted(): Promise<FinancialAuthority> {
      clock(); const fresh = snapshotPrivateJson(await revalidate()) as FinancialAuthority; clock();
      if (fresh.organizationId !== initialActor.organizationId || fresh.userId !== initialActor.userId) throw new ErpError('session_changed', 401);
      if (!fresh.managementEntitled) throw new ErpError('management_entitlement_required', 402);
      if (fresh.role !== initialActor.role) throw new ErpError('forbidden', 403);
      const authorityTime = parseInstant(fresh.timestamp).getTime();
      if (authorityTime < previousAuthorityTime || authorityTime >= (previousClock + 1) * 1000) throw new UsTaxReadinessError('server_clock_unavailable');
      previousAuthorityTime = authorityTime;
      return fresh;
    }
    async function guarded<T>(read: (actor: FinancialAuthority) => Promise<T>): Promise<T> {
      const actor = await admitted(); let value: T;
      try { value = await read(actor); } catch (error) { await admitted(); throw error; }
      await admitted(); return value;
    }
    try {
      const context = await guarded(async actor => snapshotPrivateJson(await dependencies.contexts!.read(actor)) as UsTaxFinancialContext);
      let unavailable = contextReason(context, initialActor, configuration, clock());
      if (unavailable) return blockedUsTaxReadiness(unavailable);
      await guarded(() => dependencies.gateway!.verify(context));
      unavailable = contextReason(context, initialActor, configuration, clock());
      if (unavailable) return blockedUsTaxReadiness(unavailable);
      return Object.freeze({ status: 'ready_test', validUntil: Number(contextInstant(context.binding.validUntil) / BigInt(1000000)) });
    } catch (error) {
      const unavailable = knownBlocked(error);
      if (unavailable) return blockedUsTaxReadiness(unavailable);
      throw error;
    }
  };
}
