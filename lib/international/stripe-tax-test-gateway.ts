import type Stripe from 'stripe';
import { sha256Hex } from '../account-security';
import { validateAddress } from './addresses';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { assertStripeTaxSdkMetadata, extractStripeTaxSdkBody, type StripeTaxSdkMetadata } from './stripe-tax-sdk-body';
import { STRIPE_TAX_API_VERSION, validateResolvedStripeTaxRequest, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import type { UsTaxInvoiceTestGateway } from './us-tax-invoice';
import { validateUsTaxFacts } from './us-tax-profile';
import type { USAddress } from './types';

/** Structural subset of the installed Stripe22.6 SDK. The protected server
 * resolver injects a dedicated TEST client; this module never reads a key,
 * constructs a client, selects a connected account or enables a runtime flag. */
export interface StripeTaxTestSdkClient {
  readonly accounts: Pick<Stripe['accounts'], 'retrieveCurrent'>;
  readonly balance: Pick<Stripe['balance'], 'retrieve'>;
  readonly tax: Readonly<{
    settings: Pick<Stripe['tax']['settings'], 'retrieve'>;
    registrations: Pick<Stripe['tax']['registrations'], 'list'>;
    calculations: Pick<Stripe['tax']['calculations'], 'create'>;
  }>;
  readonly taxCodes: Pick<Stripe['taxCodes'], 'retrieve'>;
}
export interface StripeTaxTestGatewayOptions {
  readonly client: StripeTaxTestSdkClient;
  readonly organizationId: string;
  readonly accountId: string;
  now(): string;
  /** Fixtures can never be admitted through this concrete provider gateway. */
  readonly allowTestFixtures: false;
}
export interface StripeTaxCatalogCode {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
export interface StripeTaxTestGateway extends UsTaxInvoiceTestGateway {
  /** Technical catalogue existence only. The caller must separately confirm
   * the service classification and its legal applicability; no guessing. */
  readTaxCode(code: string): Promise<StripeTaxCatalogCode>;
}
export interface StripeTaxTestConfigurationOptions extends StripeTaxTestGatewayOptions {
  readonly taxOrigin: USAddress;
}
/** Private, authenticated technical observation only. There is deliberately no
 * revision, expiry, configured status, entitlement or permission in this DTO. */
export interface StripeTaxTestConfigurationObservation {
  readonly organizationId: string;
  readonly accountId: string;
  readonly mode: 'test';
  readonly apiVersion: typeof STRIPE_TAX_API_VERSION;
  readonly settingsSha256: string;
  readonly registrationsSha256: string;
  readonly observedAt: string;
  readonly taxOrigin: USAddress;
}
type Failure = 'service_unavailable' | 'binding_unavailable' | 'tax_binding_changed' | 'server_clock_unavailable' | 'financial_permission_required' | 'management_entitlement_required' | 'tenant_mismatch';
const statuses: Readonly<Record<Failure, number>> = Object.freeze({ service_unavailable: 503, binding_unavailable: 409, tax_binding_changed: 409, server_clock_unavailable: 503, financial_permission_required: 403, management_entitlement_required: 402, tenant_mismatch: 403 });
function fail(code: Failure = 'service_unavailable'): never { throw new ErpError(code, statuses[code]); }
function safeError(error: unknown): ErpError {
  if (error instanceof ErpError && Object.hasOwn(statuses, error.code)) return new ErpError(error.code, statuses[error.code as Failure]);
  // Stripe error messages, request bodies, account details and keys stay private.
  return new ErpError('service_unavailable', 503);
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  return input as Record<string, unknown>;
}
function text(input: unknown, limit: number): string {
  if (typeof input !== 'string' || !input || input !== input.trim() || input.length > limit || Array.from(input).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return input;
}
function revision(input: unknown): void { if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) >= Number.MAX_SAFE_INTEGER) return fail(); }
function instant(input: unknown): bigint {
  try {
    if (typeof input !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(input)) return fail('server_clock_unavailable');
    const parsed = parseInstant(input.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/, '$1'));
    const fraction = /\.([0-9]+)(?=Z|[+-])/.exec(input)?.[1] ?? '';
    return BigInt(parsed.getTime()) * BigInt(1000) + BigInt(fraction.padEnd(6, '0').slice(3));
  } catch { return fail('server_clock_unavailable'); }
}
const contextFields = ['organizationId', 'actor', 'recordedAt', 'countryRevision', 'configuration', 'sellerRevision', 'seller', 'taxFactsRevision', 'taxFacts', 'binding'];
const bindingFields = ['organizationId', 'accountId', 'mode', 'apiVersion', 'revision', 'settingsSha256', 'registrationsSha256', 'observedAt', 'validUntil', 'evidenceKind', 'scope'];
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const readOptions = Object.freeze({ apiVersion: STRIPE_TAX_API_VERSION, maxNetworkRetries: 0, timeout: 20_000 });
function scopedOptions(options: StripeTaxTestGatewayOptions): { organizationId: string; accountId: string; client: StripeTaxTestSdkClient; clock: () => { iso: string; micros: bigint } } {
  const organizationId = text(options.organizationId, 128), accountId = text(options.accountId, 100), client = options.client, now = options.now.bind(options);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || !/^acct_[A-Za-z0-9]+$/.test(accountId) || options.allowTestFixtures !== false) return fail('binding_unavailable');
  let lastClock: bigint | undefined;
  return { organizationId, accountId, client, clock: () => {
    let iso: string;
    try { iso = now(); } catch { return fail('server_clock_unavailable'); }
    const micros = instant(iso);
    if (lastClock !== undefined && micros < lastClock) return fail('server_clock_unavailable');
    lastClock = micros; return { iso, micros };
  } };
}
function readBody(input: unknown, accountId: string): Record<string, unknown> {
  const extracted = extractStripeTaxSdkBody(input), metadata: StripeTaxSdkMetadata = extracted.metadata;
  // Present headers can disprove a scope/version, never authenticate one.
  if ((metadata.apiVersion !== undefined && metadata.apiVersion !== STRIPE_TAX_API_VERSION) || (metadata.stripeAccount !== undefined && metadata.stripeAccount !== accountId) || metadata.idempotencyKey !== undefined) return fail('tax_binding_changed');
  return object(extracted.body);
}
/** One read-only implementation for initial observations and re-verification.
 * Full JSON settings (excluding lastResponse) and full active registration
 * bodies, lexically sorted by id, are hashed with canonicalErpJson UTF8 SHA256.
 * Registrations cover every country; at least one US registration is required.
 * This is NOT a nexus, classification, exemption or legal compliance decision. */
async function configurationObservation(
  scoped: ReturnType<typeof scopedOptions>, taxOrigin: USAddress, check: () => void,
): Promise<StripeTaxTestConfigurationObservation> {
  const { client, accountId, organizationId, clock } = scoped;
  async function observed<T>(call: () => Promise<T>): Promise<Record<string, unknown>> {
    check(); const response = await call(), body = readBody(response, accountId); check(); return body;
  }
  const account = await observed(() => client.accounts.retrieveCurrent({}, readOptions));
  if (account.object !== 'account' || account.id !== accountId) return fail('tax_binding_changed');
  const balance = await observed(() => client.balance.retrieve({}, readOptions));
  if (balance.object !== 'balance' || balance.livemode !== false) return fail('binding_unavailable');
  const settings = await observed(() => client.tax.settings.retrieve({}, readOptions));
  if (settings.object !== 'tax.settings' || settings.livemode !== false || settings.status !== 'active') return fail('binding_unavailable');
  const defaults = object(settings.defaults);
  if (defaults.provider !== undefined && defaults.provider !== 'stripe') return fail('binding_unavailable');
  const expectedAddress = { country: 'US', line1: taxOrigin.line1, line2: taxOrigin.line2 ?? null, city: taxOrigin.city, state: taxOrigin.subdivision, postal_code: taxOrigin.postalCode };
  if (!same(object(settings.head_office).address, expectedAddress)) return fail('tax_binding_changed');
  const registrations: Record<string, unknown>[] = [], ids = new Set<string>();
  let after: string | undefined, finished = false, hasUsRegistration = false;
  for (let page = 0; page < 10; page++) {
    const body = await observed(() => client.tax.registrations.list({ status: 'active', limit: 100, ...(after ? { starting_after: after } : {}) }, readOptions));
    if (body.object !== 'list' || body.url !== '/v1/tax/registrations' || typeof body.has_more !== 'boolean' || !Array.isArray(body.data) || body.data.length > 100 || body.has_more && body.data.length === 0) return fail();
    const seconds = clock().micros / BigInt(1_000_000);
    for (const raw of body.data) {
      const registration = object(raw), id = text(registration.id, 160);
      if (!/^taxreg_[A-Za-z0-9]+$/.test(id) || ids.has(id) || registration.object !== 'tax.registration' || registration.status !== 'active' || registration.livemode !== false || typeof registration.country !== 'string' || !/^[A-Z]{2}$/.test(registration.country)) return fail('binding_unavailable');
      if (!Number.isSafeInteger(registration.active_from) || (registration.active_from as number) < 0 || BigInt(registration.active_from as number) > seconds || !Number.isSafeInteger(registration.created) || (registration.created as number) < 0 || BigInt(registration.created as number) > seconds) return fail('binding_unavailable');
      if (registration.expires_at !== null && (!Number.isSafeInteger(registration.expires_at) || BigInt(registration.expires_at as number) <= seconds)) return fail('binding_unavailable');
      object(registration.country_options); ids.add(id); registrations.push(registration); hasUsRegistration ||= registration.country === 'US';
    }
    if (!body.has_more) { finished = true; break; }
    after = text(object(body.data.at(-1)).id, 160);
  }
  if (!finished || !hasUsRegistration) return fail('binding_unavailable');
  registrations.sort((a, b) => (a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0);
  const settingsSha256 = await sha256Hex(canonicalErpJson(settings)), registrationsSha256 = await sha256Hex(canonicalErpJson(registrations));
  check(); const observedAt = clock().iso; check();
  return Object.freeze({ organizationId, accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, settingsSha256, registrationsSha256, observedAt, taxOrigin });
}

/** Server-only bootstrap observation. It never writes tax facts, settings,
 * registrations or a binding, and never marks an organization configured.
 * The protected resolver must explicitly persist its own revision/expiry. */
export async function observeStripeTaxTestConfiguration(options: StripeTaxTestConfigurationOptions): Promise<StripeTaxTestConfigurationObservation> {
  try {
    const scoped = scopedOptions(options), address = validateAddress(snapshotPrivateJson(options.taxOrigin), 'US');
    if (address.country !== 'US') return fail('binding_unavailable');
    const taxOrigin = snapshotPrivateJson(address) as USAddress;
    const check = () => { scoped.clock(); };
    check(); return await configurationObservation(scoped, taxOrigin, check);
  } catch (error) { throw safeError(error); }
}

/** Inactive by construction: no default SDK/client, credential lookup, settings
 * mutation, registration creation, provider transaction or production binding.
 * Auth/D1, catalogue confirmation and final SQL admission remain upstream. */
export function createStripeTaxTestGateway(options: StripeTaxTestGatewayOptions): StripeTaxTestGateway {
  const scoped = scopedOptions(options), { organizationId, accountId, client, clock } = scoped;
  let epoch = 0;
  let verified: Readonly<{ context: UsTaxFinancialContext; epoch: number }> | null = null;
  function contextSnapshot(input: UsTaxFinancialContext, time: bigint): UsTaxFinancialContext {
    const value = object(snapshotPrivateJson(input));
    if (Object.keys(value).length !== contextFields.length || contextFields.some(k => !Object.hasOwn(value, k))) return fail();
    if (value.organizationId !== organizationId) return fail('tenant_mismatch');
    const actor = object(value.actor);
    if (Object.keys(actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(k => Object.hasOwn(actor, k)) || actor.organizationId !== organizationId) return fail('tenant_mismatch');
    if (actor.managementEntitled !== true) return fail('management_entitlement_required');
    if (!['owner', 'admin', 'accountant'].includes(actor.role as string)) return fail('financial_permission_required');
    text(actor.userId, 256); if (instant(actor.timestamp) > time || instant(value.recordedAt) > time) return fail();
    for (const k of ['countryRevision', 'sellerRevision', 'taxFactsRevision']) revision(value[k]);
    const configuration = validateCompanyConfiguration(value.configuration), facts = validateUsTaxFacts(value.taxFacts);
    if (configuration.organizationId !== organizationId || configuration.country !== 'US' || configuration.currency !== 'USD' || configuration.taxConfiguration.status !== 'configured' || configuration.timeZone !== facts.timeZone || !same(configuration, value.configuration) || !same(facts, value.taxFacts)) return fail('binding_unavailable');
    const binding = object(value.binding);
    if (Object.keys(binding).length !== bindingFields.length || bindingFields.some(k => !Object.hasOwn(binding, k)) || binding.organizationId !== organizationId || binding.accountId !== accountId || binding.mode !== 'test' || binding.apiVersion !== STRIPE_TAX_API_VERSION || binding.scope !== 'erp_invoice_tax' || binding.evidenceKind !== 'provider_observation') return fail('binding_unavailable');
    revision(binding.revision);
    for (const k of ['settingsSha256', 'registrationsSha256']) if (typeof binding[k] !== 'string' || !/^[0-9a-f]{64}$/.test(binding[k] as string)) return fail();
    const observed = instant(binding.observedAt), until = instant(binding.validUntil);
    if (observed > time || until <= time || until <= observed) return fail('binding_unavailable');
    return value as unknown as UsTaxFinancialContext;
  }
  function active(context: UsTaxFinancialContext, expectedEpoch: number): void {
    if (expectedEpoch !== epoch) return fail('tax_binding_changed');
    contextSnapshot(context, clock().micros);
  }
  async function observed<T>(context: UsTaxFinancialContext, expectedEpoch: number, call: () => Promise<T>): Promise<Record<string, unknown>> {
    active(context, expectedEpoch);
    const response = await call(), body = readBody(response, accountId);
    active(context, expectedEpoch); return body;
  }
  async function observe(context: UsTaxFinancialContext, expectedEpoch: number): Promise<void> {
    const observation = await configurationObservation(scoped, context.taxFacts.taxOrigin, () => active(context, expectedEpoch));
    active(context, expectedEpoch);
    if (observation.settingsSha256 !== context.binding.settingsSha256 || observation.registrationsSha256 !== context.binding.registrationsSha256) return fail('tax_binding_changed');
  }
  async function catalogue(code: string, context: UsTaxFinancialContext, expectedEpoch: number): Promise<StripeTaxCatalogCode> {
    if (typeof code !== 'string' || code.length !== 13 || !/^txcd_[0-9]{8}$/.test(code)) return fail('binding_unavailable');
    const body = await observed(context, expectedEpoch, () => client.taxCodes.retrieve(code, {}, readOptions));
    if (body.object !== 'tax_code' || body.id !== code) return fail('tax_binding_changed');
    return Object.freeze({ id: code, name: text(body.name, 2000), description: text(body.description, 16_000) });
  }
  return Object.freeze({
    async verify(input: UsTaxFinancialContext): Promise<void> {
      const ownEpoch = ++epoch; verified = null;
      try {
        const context = contextSnapshot(input, clock().micros);
        await observe(context, ownEpoch); active(context, ownEpoch);
        verified = Object.freeze({ context, epoch: ownEpoch });
      } catch (error) { if (epoch === ownEpoch) verified = null; throw safeError(error); }
    },
    async readTaxCode(code: string): Promise<StripeTaxCatalogCode> {
      try {
        const captured = verified; if (!captured) return fail('binding_unavailable');
        return await catalogue(code, captured.context, captured.epoch);
      } catch (error) { throw safeError(error); }
    },
    async calculate(input: ResolvedStripeTaxRequest): Promise<StripeTaxCalculationObservation> {
      const captured = verified;
      try {
        if (!captured) return fail('binding_unavailable');
        // Validate/copy the canonical request before any SDK call. A mutable
        // caller can no longer replace lines, hashes, account or provider key.
        const detached = snapshotPrivateJson(input), resolved = await validateResolvedStripeTaxRequest(detached, clock().iso);
        active(captured.context, captured.epoch);
        const context = captured.context;
        if (resolved.organizationId !== organizationId || resolved.actorUserId !== context.actor.userId || resolved.countryRevision !== context.countryRevision || resolved.sellerRevision !== context.sellerRevision || resolved.taxFactsRevision !== context.taxFactsRevision || !same(resolved.binding, context.binding) || !same(resolved.snapshots.configuration, context.configuration) || !same(resolved.snapshots.taxFacts, context.taxFacts)) return fail('tax_binding_changed');
        await observe(context, captured.epoch);
        for (const code of [...new Set(resolved.classifications.map(c => c.taxCode))].sort()) await catalogue(code, context, captured.epoch);
        active(context, captured.epoch);
        const params = snapshotPrivateJson(resolved.params) as Stripe.Tax.CalculationCreateParams;
        const response = await client.tax.calculations.create(params, Object.freeze({ ...readOptions, idempotencyKey: resolved.idempotencyKey }));
        // Detach lastResponse/body BEFORE postflight network awaits.
        const extracted = extractStripeTaxSdkBody(response);
        assertStripeTaxSdkMetadata(extracted.metadata, { accountId, apiVersion: STRIPE_TAX_API_VERSION, idempotencyKey: resolved.idempotencyKey });
        const calculation = object(extracted.body);
        if (calculation.object !== 'tax.calculation' || calculation.livemode !== false) return fail('binding_unavailable');
        active(context, captured.epoch); await observe(context, captured.epoch);
        const observedAt = clock().iso; active(context, captured.epoch);
        return Object.freeze({ accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'provider_observation', observedAt, calculation });
      } catch (error) { if (captured && epoch === captured.epoch) verified = null; throw safeError(error); }
    },
  });
}
