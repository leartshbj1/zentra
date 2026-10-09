import Stripe from 'stripe';
import { sha256Hex } from '../account-security';
import { canonicalErpJson, ErpError } from './erp-contract';
import { STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';
import { createStripeTaxTestGateway, observeStripeTaxTestConfiguration, type StripeTaxTestConfigurationObservation, type StripeTaxTestSdkClient, type StripeTaxTestGateway } from './stripe-tax-test-gateway';
import type { UsTaxInvoiceTestGateway } from './us-tax-invoice';
import type { USAddress } from './types';

export interface UsTaxMerchantCredentialIdentity {
  readonly reference: string;
  readonly revision: number;
  readonly accountId: string;
}
export interface ResolvedUsTaxTestMerchant {
  readonly credential: UsTaxMerchantCredentialIdentity;
  /** Private rotation fence, never a credential or an admission grant. */
  readonly configurationFingerprint: string;
  observe(this: void, taxOrigin: USAddress): Promise<StripeTaxTestConfigurationObservation>;
  readonly gateway: UsTaxInvoiceTestGateway;
  readonly catalogue?: Pick<StripeTaxTestGateway, 'readTaxCode' | 'listTaxCodes'>;
}
export interface UsTaxTestMerchantResolverOptions {
  readonly organizationId: string;
  readonly configurationJson: string;
  readonly credentialsJson: string;
  readonly forbiddenSaasKeys?: readonly string[];
  now(this: void): string;
  createClient?(this: void, key: string): StripeTaxTestSdkClient;
}
type Descriptor = UsTaxMerchantCredentialIdentity & Readonly<{ organizationId: string }>;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maximumJsonBytes = 65_536, maximumMerchants = 128;
function invalid(): never { throw new ErpError('binding_unavailable', 409); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}
function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = object(input);
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return invalid();
  return value;
}
function scope(input: unknown): string {
  if (typeof input !== 'string' || input !== input.trim() || !scopePattern.test(input)) return invalid();
  return input;
}
/** JSON.parse discards duplicate object members. Check the original, already
 * parsed grammar too, including escaped aliases such as "ref"/"\u0072ef". */
function parse(input: string): unknown {
  if (new TextEncoder().encode(input).byteLength > maximumJsonBytes) return invalid();
  let value: unknown;
  try { value = JSON.parse(input); } catch { return invalid(); }
  const stack: (Set<string> | null)[] = [];
  for (let cursor = 0; cursor < input.length; cursor++) {
    const character = input[cursor];
    if (character === '{' || character === '[') {
      stack.push(character === '{' ? new Set() : null);
      if (stack.length > 16) return invalid();
    } else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = cursor++;
      for (; cursor < input.length; cursor++) {
        if (input[cursor] === '\\') cursor++;
        else if (input[cursor] === '"') break;
      }
      let next = cursor + 1;
      while (/\s/.test(input[next] ?? '') && next < input.length) next++;
      if (input[next] === ':') {
        const members = stack.at(-1), key = JSON.parse(input.slice(start, cursor + 1)) as string;
        if (!members || members.has(key)) return invalid();
        members.add(key);
      }
    }
  }
  return value;
}
function sdkClient(key: string): StripeTaxTestSdkClient {
  return new Stripe(key, {
    apiVersion: STRIPE_TAX_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    timeout: 20_000,
    typescript: true,
  });
}

/** Server-only private configuration. No environment lookup, shared SaaS
 * client, connected-account override or default merchant is available here.
 * Resolution makes no provider call and does not activate tax configuration. */
export async function resolveUsTaxTestMerchant(options: UsTaxTestMerchantResolverOptions): Promise<ResolvedUsTaxTestMerchant | null> {
  try {
    if (typeof window !== 'undefined') return invalid();
    // Capture every input before the fingerprint await. Caller mutation cannot
    // swap the selected key, workspace, clock or SDK factory during resolution.
    const organizationId = scope(options.organizationId), configurationJson = options.configurationJson, credentialsJson = options.credentialsJson;
    const now = options.now, createClient = options.createClient ?? sdkClient;
    const forbidden = options.forbiddenSaasKeys ?? [];
    if (typeof configurationJson !== 'string' || typeof credentialsJson !== 'string' || typeof now !== 'function' || typeof createClient !== 'function' || !Array.isArray(forbidden) || forbidden.length > 1_000 || forbidden.some(key => typeof key !== 'string' || key.length > 512)) return invalid();
    // The legacy SaaS configuration trims deployment secrets. Compare the
    // effective key too, so whitespace cannot defeat account separation.
    const forbiddenKeys = new Set(forbidden.map(key => key.trim()));
    if (!configurationJson.trim() || !credentialsJson.trim()) {
      if (!configurationJson.trim() && !credentialsJson.trim()) return null;
      return invalid();
    }
    const configuration = exact(parse(configurationJson), ['schemaVersion', 'merchants']), credentials = object(parse(credentialsJson));
    if (configuration.schemaVersion !== 1 || !Array.isArray(configuration.merchants) || configuration.merchants.length > maximumMerchants) return invalid();
    const organizations = new Set<string>(), accounts = new Set<string>(), references = new Set<string>(), keys = new Set<string>();
    let selected: Descriptor | undefined;
    for (const input of configuration.merchants) {
      const row = exact(input, ['organizationId', 'reference', 'revision', 'accountId']);
      const descriptor: Descriptor = Object.freeze({ organizationId: scope(row.organizationId), reference: scope(row.reference), revision: row.revision as number, accountId: row.accountId as string });
      if (!Number.isSafeInteger(descriptor.revision) || descriptor.revision < 1 || descriptor.revision >= Number.MAX_SAFE_INTEGER || typeof descriptor.accountId !== 'string' || descriptor.accountId !== descriptor.accountId.trim() || !/^acct_[A-Za-z0-9]{1,95}$/.test(descriptor.accountId)) return invalid();
      if (organizations.has(descriptor.organizationId) || accounts.has(descriptor.accountId) || references.has(descriptor.reference)) return invalid();
      organizations.add(descriptor.organizationId); accounts.add(descriptor.accountId); references.add(descriptor.reference);
      if (!Object.hasOwn(credentials, descriptor.reference)) return invalid();
      const key = credentials[descriptor.reference];
      if (typeof key !== 'string' || key !== key.trim() || !/^rk_test_[A-Za-z0-9]{1,256}$/.test(key) || keys.has(key) || forbiddenKeys.has(key)) return invalid();
      keys.add(key);
      if (descriptor.organizationId === organizationId) selected = descriptor;
    }
    // Orphan credentials and malformed unrelated mappings also fail closed.
    if (Object.keys(credentials).length !== references.size || Object.keys(credentials).some(reference => !references.has(reference))) return invalid();
    if (!selected) return null;
    const key = credentials[selected.reference] as string;
    const credential: UsTaxMerchantCredentialIdentity = Object.freeze({ reference: selected.reference, revision: selected.revision, accountId: selected.accountId });
    const configurationFingerprint = await sha256Hex(canonicalErpJson(['us-tax-merchant-test-v1', STRIPE_TAX_API_VERSION, organizationId, credential, key]));
    let client: StripeTaxTestSdkClient;
    try { client = createClient(key); } catch { throw new ErpError('service_unavailable', 503); }
    const gatewayOptions = Object.freeze({ client, organizationId, accountId: credential.accountId, now, allowTestFixtures: false as const });
    const gateway = createStripeTaxTestGateway(gatewayOptions);
    return Object.freeze({
      credential, configurationFingerprint, gateway, catalogue: gateway,
      observe: (taxOrigin: USAddress) => observeStripeTaxTestConfiguration({ ...gatewayOptions, taxOrigin }),
    });
  } catch (error) {
    if (error instanceof ErpError && error.code === 'binding_unavailable') throw new ErpError('binding_unavailable', 409);
    throw new ErpError('service_unavailable', 503);
  }
}
