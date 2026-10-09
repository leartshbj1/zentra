import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateUsSellerProfileWrite, type UsSellerProfile } from './seller-profile';
import { STRIPE_TAX_API_VERSION, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxTestConfigurationObservation } from './stripe-tax-test-gateway';
import type { CompanyConfiguration } from './types';
import { validateUsTaxFacts, type UsTaxFacts } from './us-tax-profile';

/** Private bootstrap snapshot. A binding need not exist yet. Never an HTTP DTO. */
export interface UsTaxMerchantContext {
  readonly organizationId: string;
  readonly countryRevision: number;
  readonly configuration: CompanyConfiguration;
  readonly sellerRevision: number;
  readonly seller: UsSellerProfile;
  readonly taxFactsRevision: number;
  readonly taxFacts: UsTaxFacts;
  readonly bindingRevision: number;
}
/** Server configuration provenance only; never contains a credential secret. */
export interface CredentialIdentity { readonly reference: string; readonly revision: number; readonly accountId: string; }
export interface UsTaxMerchantCredential { readonly credential: CredentialIdentity; readonly configurationFingerprint: string; }
export interface UsTaxMerchantActivation {
  readonly requestId: string;
  readonly context: UsTaxMerchantContext;
  readonly credential: CredentialIdentity;
  readonly configurationFingerprint: string;
  readonly observation: StripeTaxTestConfigurationObservation;
  readonly validUntil: string;
}
export interface UsTaxMerchantReceipt {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly requestId: string;
  readonly actorUserId: string;
  readonly countryRevision: number;
  readonly configurationChanged: boolean;
  readonly binding: StripeTaxTestBinding;
  readonly credential: CredentialIdentity;
  readonly configurationFingerprint: string;
}
export interface UsTaxMerchantStore {
  readContext(actor: FinancialAuthority): Promise<UsTaxMerchantContext>;
  readReceipt(actor: FinancialAuthority, requestId: string): Promise<UsTaxMerchantReceipt | null>;
  readCredential(actor: FinancialAuthority, bindingRevision: number): Promise<UsTaxMerchantCredential | null>;
  activate(actor: FinancialAuthority, input: UsTaxMerchantActivation): Promise<UsTaxMerchantReceipt>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const contextFields = ['organizationId', 'countryRevision', 'configuration', 'sellerRevision', 'seller', 'taxFactsRevision', 'taxFacts', 'bindingRevision'];
const bindingFields = ['organizationId', 'accountId', 'mode', 'apiVersion', 'revision', 'settingsSha256', 'registrationsSha256', 'observedAt', 'validUntil', 'evidenceKind', 'scope'];
function invalid(): never { throw new ErpError('invalid_stored_tax_merchant', 503); }
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function identity(input: unknown): input is string {
  return typeof input === 'string' && input === input.trim() && input.length > 0 && input.length <= 256 && !Array.from(input).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
function revision(input: unknown, zero = false): number {
  if (!Number.isSafeInteger(input) || (input as number) < (zero ? 0 : 1) || (input as number) >= Number.MAX_SAFE_INTEGER) return invalid();
  return input as number;
}
function instant(input: unknown): number {
  if (typeof input !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(input)) return invalid();
  try { return parseInstant(input.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/, '$1')).getTime(); } catch { return invalid(); }
}
function actorSnapshot(input: FinancialAuthority, financial = false): FinancialAuthority {
  const actor = object(snapshotPrivateJson(input), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (!identity(actor.organizationId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actor.organizationId) || !identity(actor.userId)) return invalid();
  if (financial ? !['owner', 'admin', 'accountant'].includes(actor.role as string) : actor.role !== 'owner') throw new ErpError(financial ? 'financial_permission_required' : 'owner_permission_required', 403);
  if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  instant(actor.timestamp);
  return actor as unknown as FinancialAuthority;
}
export function validateCredentialIdentity(input: unknown): CredentialIdentity {
  const value = object(snapshotPrivateJson(input), ['reference', 'revision', 'accountId']);
  if (!identity(value.reference) || typeof value.accountId !== 'string' || !/^acct_[A-Za-z0-9]{1,95}$/.test(value.accountId)) return invalid();
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return invalid();
  return value as unknown as CredentialIdentity;
}
export function validateUsTaxMerchantCredential(input: unknown): UsTaxMerchantCredential {
  const value = object(snapshotPrivateJson(input), ['credential', 'configurationFingerprint']);
  validateCredentialIdentity(value.credential);
  if (typeof value.configurationFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.configurationFingerprint)) return invalid();
  return value as unknown as UsTaxMerchantCredential;
}
export function validateUsTaxMerchantContext(input: unknown, organizationId: string): UsTaxMerchantContext {
  const value = object(snapshotPrivateJson(input), contextFields);
  if (value.organizationId !== organizationId) return invalid();
  revision(value.countryRevision); revision(value.sellerRevision); revision(value.taxFactsRevision); revision(value.bindingRevision, true);
  let configuration: CompanyConfiguration, seller: UsSellerProfile, facts: UsTaxFacts;
  try {
    configuration = validateCompanyConfiguration(value.configuration);
    seller = validateUsSellerProfileWrite({ expectedRevision: 0, requestId: '00000000-0000-4000-8000-000000000000', profile: value.seller }).profile;
    facts = validateUsTaxFacts(value.taxFacts);
  } catch { return invalid(); }
  if (configuration.organizationId !== organizationId || configuration.country !== 'US' || configuration.currency !== 'USD' || facts.timeZone !== configuration.timeZone || canonicalErpJson(configuration) !== canonicalErpJson(value.configuration) || canonicalErpJson(seller) !== canonicalErpJson(value.seller) || canonicalErpJson(facts) !== canonicalErpJson(value.taxFacts)) return invalid();
  return value as unknown as UsTaxMerchantContext;
}
function observation(input: unknown, context: UsTaxMerchantContext, credential: CredentialIdentity): StripeTaxTestConfigurationObservation {
  const value = object(snapshotPrivateJson(input), ['organizationId', 'accountId', 'mode', 'apiVersion', 'settingsSha256', 'registrationsSha256', 'observedAt', 'taxOrigin']);
  if (value.organizationId !== context.organizationId || value.accountId !== credential.accountId || value.mode !== 'test' || value.apiVersion !== STRIPE_TAX_API_VERSION || canonicalErpJson(value.taxOrigin) !== canonicalErpJson(context.taxFacts.taxOrigin)) return invalid();
  for (const key of ['settingsSha256', 'registrationsSha256']) if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key] as string)) return invalid();
  instant(value.observedAt);
  return value as unknown as StripeTaxTestConfigurationObservation;
}
export function validateUsTaxMerchantReceipt(input: unknown, organizationId: string, requestId: string, actorUserId: string): UsTaxMerchantReceipt {
  const value = object(snapshotPrivateJson(input), ['schemaVersion', 'organizationId', 'requestId', 'actorUserId', 'countryRevision', 'configurationChanged', 'binding', 'credential', 'configurationFingerprint']);
  if (value.schemaVersion !== 1 || value.organizationId !== organizationId || value.requestId !== requestId || !uuid.test(requestId) || value.actorUserId !== actorUserId) return invalid();
  revision(value.countryRevision);
  if (typeof value.configurationChanged !== 'boolean' || typeof value.configurationFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.configurationFingerprint)) return invalid();
  const credential = validateCredentialIdentity(value.credential), binding = object(value.binding, bindingFields);
  if (binding.organizationId !== organizationId || binding.accountId !== credential.accountId || binding.mode !== 'test' || binding.apiVersion !== STRIPE_TAX_API_VERSION || binding.scope !== 'erp_invoice_tax' || binding.evidenceKind !== 'provider_observation') return invalid();
  revision(binding.revision);
  for (const key of ['settingsSha256', 'registrationsSha256']) if (typeof binding[key] !== 'string' || !/^[0-9a-f]{64}$/.test(binding[key] as string)) return invalid();
  const observed = instant(binding.observedAt), until = instant(binding.validUntil);
  // Historical receipts remain readable after expiration; they grant nothing.
  if (until <= observed || until > observed + 120_000) return invalid();
  return value as unknown as UsTaxMerchantReceipt;
}
function safeError(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes: Record<string, [string, number]> = {
      PM001: ['tax_configuration_changed', 409], PM002: ['tax_merchant_request_conflict', 409], PM003: ['country_configuration_required', 409],
      PM004: ['invalid_tax_merchant_activation', 422], PM005: ['owner_permission_required', 403], PM006: ['binding_unavailable', 409],
      PM007: ['seller_configuration_required', 409], PM008: ['tax_details_required', 409], PM009: ['tax_merchant_request_conflict', 409],
      PX007: ['financial_permission_required', 403],
      PX001: ['tax_configuration_changed', 409], PX002: ['tax_merchant_request_conflict', 409], PZ001: ['tax_configuration_changed', 409], PZ002: ['tax_merchant_request_conflict', 409],
    };
    if (codes[error.code]) return new ErpError(...codes[error.code]);
  }
  return new ErpError('service_unavailable', 503);
}
/** Private service transport. Caller revalidates real Auth/D1, gate and dedicated
 * credential configuration around awaits. No provider call or mutation retry. */
export function createSupabaseUsTaxMerchantStore(client: Pick<SupabaseServerClient, 'rpc'>): UsTaxMerchantStore {
  return Object.freeze({
    async readContext(inputActor: FinancialAuthority) {
      const actor = actorSnapshot(inputActor);
      try { return validateUsTaxMerchantContext(await client.rpc('zentra_read_us_tax_merchant_context', { p_organization: actor.organizationId, p_actor: actor }), actor.organizationId); } catch (e) { throw safeError(e); }
    },
    async readReceipt(inputActor: FinancialAuthority, requestId: string) {
      const actor = actorSnapshot(inputActor);
      if (typeof requestId !== 'string' || !uuid.test(requestId)) return invalid();
      try { const raw = await client.rpc('zentra_read_us_tax_merchant_receipt', { p_organization: actor.organizationId, p_actor: actor, p_request_id: requestId }); return raw === null ? null : validateUsTaxMerchantReceipt(raw, actor.organizationId, requestId, actor.userId); } catch (e) { throw safeError(e); }
    },
    async readCredential(inputActor: FinancialAuthority, bindingRevision: number) {
      const actor = actorSnapshot(inputActor, true); revision(bindingRevision);
      try { const raw = await client.rpc('zentra_read_us_tax_merchant_credential', { p_organization: actor.organizationId, p_actor: actor, p_binding_revision: bindingRevision }); return raw === null ? null : validateUsTaxMerchantCredential(raw); } catch (e) { throw safeError(e); }
    },
    async activate(inputActor: FinancialAuthority, input: UsTaxMerchantActivation) {
      const actor = actorSnapshot(inputActor), value = object(snapshotPrivateJson(input), ['requestId', 'context', 'credential', 'configurationFingerprint', 'observation', 'validUntil']);
      if (typeof value.requestId !== 'string' || !uuid.test(value.requestId)) return invalid();
      const context = validateUsTaxMerchantContext(value.context, actor.organizationId), credential = validateCredentialIdentity(value.credential), observed = observation(value.observation, context, credential);
      if (typeof value.configurationFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.configurationFingerprint)) return invalid();
      const until = instant(value.validUntil), at = instant(observed.observedAt);
      if (until <= at || until > at + 120_000) return invalid();
      try {
        const receipt = validateUsTaxMerchantReceipt(await client.rpc('zentra_activate_us_tax_test_merchant', { p_organization: actor.organizationId, p_actor: actor, p_request_id: value.requestId, p_context: context, p_credential: credential, p_configuration_fingerprint: value.configurationFingerprint, p_observation: observed, p_valid_until: value.validUntil }), actor.organizationId, value.requestId, actor.userId);
        const expectedCountry = context.countryRevision + (context.configuration.taxConfiguration.status === 'unconfigured' ? 1 : 0);
        if (receipt.countryRevision !== expectedCountry || receipt.configurationChanged !== (context.configuration.taxConfiguration.status === 'unconfigured') || receipt.configurationFingerprint !== value.configurationFingerprint || receipt.binding.revision !== context.bindingRevision + 1 || canonicalErpJson(receipt.credential) !== canonicalErpJson(credential) || receipt.binding.validUntil !== value.validUntil || receipt.binding.observedAt !== observed.observedAt || receipt.binding.settingsSha256 !== observed.settingsSha256 || receipt.binding.registrationsSha256 !== observed.registrationsSha256) return invalid();
        return receipt;
      } catch (e) { throw safeError(e); }
    },
  });
}
