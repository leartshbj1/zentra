import type { SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateUsSellerProfileState, type UsSellerProfile } from './seller-profile';
import { STRIPE_TAX_API_VERSION, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { CompanyConfiguration } from './types';
import { validateUsTaxProfileState, type UsTaxFacts } from './us-tax-profile';

/** Private backend data, never an HTTP projection or a provider/issuance grant.
 * The four reads are not an atomic snapshot. Reservation/record/commit must
 * compare these numerical revisions and contents under their SQL locks. */
export interface UsTaxFinancialContext {
  readonly organizationId: string;
  readonly actor: FinancialAuthority;
  readonly recordedAt: string;
  readonly countryRevision: number;
  readonly configuration: CompanyConfiguration;
  readonly sellerRevision: number;
  readonly seller: UsSellerProfile;
  readonly taxFactsRevision: number;
  readonly taxFacts: UsTaxFacts;
  readonly binding: StripeTaxTestBinding;
}
export interface UsTaxFinancialContextReader {
  read(actor: FinancialAuthority): Promise<UsTaxFinancialContext>;
}
export interface UsTaxFinancialContextReaderOptions {
  /** Fresh real Auth/D1 membership and entitlement, including financial role.
   * No owner-only UI service is called with a fabricated owner here. */
  revalidate(): Promise<FinancialAuthority>;
  /** Trusted server clock, read around every awaited admission/storage phase. */
  now(): string;
  /** Explicit injected QA only. Defaults to rejecting fixture observations. */
  readonly allowTestFixtures?: boolean;
}
const actorFields = ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'];
const countryFields = ['organization_id', 'schema_version', 'config', 'country', 'currency', 'revision', 'updated_by', 'updated_at'];
const bindingFields = ['organizationId', 'accountId', 'mode', 'apiVersion', 'revision', 'settingsSha256', 'registrationsSha256', 'observedAt', 'validUntil', 'evidenceKind', 'scope'];
function invalid(): never { throw new ErpError('invalid_financial_context', 503); }
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  // Every input was detached by snapshotPrivateJson before any further await.
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) return invalid();
  return value as number;
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && value === value.trim() && value.length <= 256 && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function instant(value: unknown): { micros: bigint; iso: string } {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) return invalid();
  try {
    const date = parseInstant(value.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/, '$1'));
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return invalid();
    const fraction = /\.([0-9]+)(?=Z|[+-])/.exec(value)?.[1] ?? '';
    return { micros: BigInt(date.getTime()) * BigInt(1_000) + BigInt(fraction.padEnd(6, '0').slice(3)), iso: date.toISOString() };
  } catch { return invalid(); }
}
function actorSnapshot(input: FinancialAuthority): FinancialAuthority {
  let value: Record<string, unknown>;
  try { value = object(snapshotPrivateJson(input), actorFields); } catch { return invalid(); }
  if (typeof value.organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.organizationId) || !identity(value.userId)) return invalid();
  if (typeof value.managementEntitled !== 'boolean') return invalid();
  if (!value.managementEntitled) throw new ErpError('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(value.role as string)) throw new ErpError('financial_permission_required', 403);
  // FinancialAuthority timestamps are the existing millisecond authority DTO.
  try { parseInstant(value.timestamp as string); } catch { return invalid(); }
  instant(value.timestamp);
  return value as unknown as FinancialAuthority;
}
function metadata(updatedBy: unknown, updatedAt: unknown, now: bigint): void {
  if (!identity(updatedBy) || instant(updatedAt).micros > now) return invalid();
}
function country(input: unknown, organizationId: string, now: bigint): { revision: number; configuration: CompanyConfiguration } {
  if (!Array.isArray(input) || input.length > 1) return invalid();
  if (!input.length) throw new ErpError('country_configuration_required', 409);
  const value = object(input[0], countryFields);
  if (value.organization_id !== organizationId || value.schema_version !== 1) return invalid();
  let configuration: CompanyConfiguration;
  try { configuration = validateCompanyConfiguration(value.config); } catch { return invalid(); }
  if (configuration.organizationId !== organizationId || value.country !== configuration.country || value.currency !== configuration.currency || canonicalErpJson(configuration) !== canonicalErpJson(value.config)) return invalid();
  if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
  metadata(value.updated_by, value.updated_at, now);
  return { revision: revision(value.revision), configuration };
}
function binding(input: unknown, organizationId: string, now: bigint, allowTestFixtures: boolean): StripeTaxTestBinding {
  if (input === null) throw new ErpError('binding_unavailable', 409);
  const value = object(input, bindingFields);
  if (value.organizationId !== organizationId || typeof value.accountId !== 'string' || value.accountId.length > 100 || !/^acct_[A-Za-z0-9]+$/.test(value.accountId) || value.mode !== 'test' || value.apiVersion !== STRIPE_TAX_API_VERSION || value.scope !== 'erp_invoice_tax' || !['provider_observation', 'test_fixture'].includes(value.evidenceKind as string)) return invalid();
  revision(value.revision);
  for (const key of ['settingsSha256', 'registrationsSha256']) if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key] as string)) return invalid();
  const observed = instant(value.observedAt).micros, until = instant(value.validUntil).micros;
  if (observed > now || until <= now || until <= observed || value.evidenceKind === 'test_fixture' && !allowTestFixtures) throw new ErpError('binding_unavailable', 409);
  return value as unknown as StripeTaxTestBinding;
}

/** Service-only reads. Auth exceptions remain outside storage error handling;
 * malformed/erroring storage never becomes an absent/default/verified setup. */
export function createUsTaxFinancialContextReader(
  client: Pick<SupabaseServerClient, 'select' | 'rpc'>,
  options: UsTaxFinancialContextReaderOptions,
): UsTaxFinancialContextReader {
  const revalidate = options.revalidate.bind(options), now = options.now.bind(options);
  const allowTestFixtures = options.allowTestFixtures ?? false;
  if (typeof allowTestFixtures !== 'boolean') return invalid();
  return Object.freeze({
    async read(inputActor: FinancialAuthority): Promise<UsTaxFinancialContext> {
      // Capture the caller's identity and role synchronously, before admission.
      const initial = actorSnapshot(inputActor);
      let current = initial, previousClock: bigint | undefined, clock = instant(initial.timestamp);
      let previousAuthorityTime = instant(initial.timestamp).micros;
      function freshClock(): void {
        try { clock = instant(now()); } catch { return invalid(); }
        if (previousClock !== undefined && clock.micros < previousClock) return invalid();
        previousClock = clock.micros;
      }
      async function admit(): Promise<void> {
        freshClock();
        let response: FinancialAuthority;
        try { response = await revalidate(); } catch (error) {
          const status = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
          if (status && 'value' in status && [401, 402, 403].includes(status.value)) throw error;
          return invalid();
        }
        // Detach the real returned authority before any subsequent wait.
        current = actorSnapshot(response);
        freshClock();
        if (current.organizationId !== initial.organizationId || current.userId !== initial.userId || current.role !== initial.role) throw new ErpError('financial_authority_changed', 403);
        const authorityTime = instant(current.timestamp).micros;
        if (authorityTime < previousAuthorityTime || authorityTime > clock.micros) return invalid();
        previousAuthorityTime = authorityTime;
      }
      async function guardedRead(read: () => Promise<unknown>): Promise<unknown> {
        await admit();
        let result: unknown, failed = false;
        try { result = snapshotPrivateJson(await read()); } catch { failed = true; }
        // Even a storage failure cannot conceal a concurrent Auth revocation.
        await admit();
        if (failed) return invalid();
        return result;
      }
      const organizationId = initial.organizationId;
      const storedCountry = country(await guardedRead(() => client.select<unknown>('zentra_workspace_country_configs', {
        select: countryFields.join(','), organization_id: 'eq.' + organizationId, limit: 2,
      })), organizationId, clock.micros);
      const sellerRaw = await guardedRead(() => client.rpc<unknown>('zentra_read_us_seller_profile', { p_organization: organizationId }));
      let seller;
      try { seller = validateUsSellerProfileState(sellerRaw, organizationId); } catch { return invalid(); }
      if (seller.status !== 'configured') throw new ErpError('seller_configuration_required', 409);
      metadata(seller.updatedBy, seller.updatedAt, clock.micros);
      const factsRaw = await guardedRead(() => client.rpc<unknown>('zentra_read_us_tax_profile', { p_organization: organizationId }));
      let facts;
      try { facts = validateUsTaxProfileState(factsRaw, organizationId); } catch { return invalid(); }
      if (facts.status !== 'declared') throw new ErpError('tax_details_required', 409);
      metadata(facts.updatedBy, facts.updatedAt, clock.micros);
      const storedBinding = binding(await guardedRead(() => client.rpc<unknown>('zentra_read_us_tax_provider_binding', { p_organization: organizationId })), organizationId, clock.micros, allowTestFixtures);
      // The final clock was read after the final real admission. No later await
      // can resurrect private data or widen the role that authorized this read.
      return snapshotPrivateJson({
        organizationId, actor: current, recordedAt: clock.iso,
        countryRevision: storedCountry.revision, configuration: storedCountry.configuration,
        sellerRevision: seller.revision, seller: seller.profile,
        taxFactsRevision: facts.revision, taxFacts: facts.facts, binding: storedBinding,
      }) as UsTaxFinancialContext;
    },
  });
}
