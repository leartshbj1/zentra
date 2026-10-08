import { snapshotPrivateJson } from './private-json';

export interface StripeTaxSdkMetadata {
  readonly requestId?: string;
  readonly apiVersion?: string;
  readonly stripeAccount?: string;
  readonly idempotencyKey?: string;
}
export interface StripeTaxSdkExpectedMetadata {
  readonly accountId: string;
  readonly apiVersion: string;
  readonly idempotencyKey: string;
}
export interface StripeTaxSdkBody {
  readonly body: unknown;
  readonly metadata: StripeTaxSdkMetadata;
}
export class StripeTaxSdkBodyError extends Error {
  readonly status = 503;
  constructor(readonly code: 'invalid_stripe_sdk_response' | 'stripe_sdk_metadata_mismatch') {
    super(code); this.name = 'StripeTaxSdkBodyError';
  }
}
const metadataFields = ['requestId', 'apiVersion', 'stripeAccount', 'idempotencyKey'] as const;
function invalid(): never { throw new StripeTaxSdkBodyError('invalid_stripe_sdk_response'); }
function text(input: unknown, limit: number): string {
  if (typeof input !== 'string' || !input || input !== input.trim() || input.length > limit || Array.from(input).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return invalid();
  return snapshotPrivateJson(input) as string;
}
function field(key: typeof metadataFields[number], input: unknown): string {
  const value = text(input, key === 'idempotencyKey' ? 255 : key === 'apiVersion' ? 128 : 160);
  if (key === 'stripeAccount' && !/^acct_[A-Za-z0-9]+$/.test(value)) return invalid();
  return value;
}
/** Stripe22.6 attaches raw Node IncomingMessage/Fetch Response as lastResponse.
 * Its host prototype, headers, socket and other fields are deliberately opaque:
 * enumerate NONE of them, read only the four own DATA properties added by SDK
 * RequestSender._addHeadersDirectlyToObject. Undefined headers mean absent.
 * Metadata cannot identify a credential, TEST mode, a registration or a grant. */
function metadata(input: unknown): StripeTaxSdkMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const result: Record<string, string> = Object.create(null);
  for (const key of metadataFields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || !descriptor.enumerable) return invalid();
    if (descriptor.value !== undefined) result[key] = field(key, descriptor.value);
  }
  return Object.freeze(result);
}
/** Extract synchronously BEFORE an await. Only the installed SDK's exact
 * non-enumerable, non-writable, non-configurable DATA lastResponse is omitted.
 * The remaining body is bounded, detached and deeply frozen by private-json;
 * getters, symbols, foreign prototypes and all other hidden fields stay denied.
 * Plain JSON fixtures may omit lastResponse. No provider call or Auth occurs. */
export function extractStripeTaxSdkBody(input: unknown): StripeTaxSdkBody {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 50_001) return invalid();
    const body: Record<string, unknown> = Object.create(null);
    let observed: StripeTaxSdkMetadata = Object.freeze({});
    for (const key of keys) {
      if (typeof key !== 'string') return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) return invalid();
      if (key === 'lastResponse') {
        if (descriptor.enumerable || descriptor.writable || descriptor.configurable) return invalid();
        observed = metadata(descriptor.value);
      } else {
        if (!descriptor.enumerable) return invalid();
        body[key] = descriptor.value;
      }
    }
    return Object.freeze({ body: snapshotPrivateJson(body), metadata: observed });
  } catch { return invalid(); }
}
/** Compare observations with an independently verified server request context.
 * Missing metadata is NOT proof of a matching account. This only rejects a
 * present mismatch; the gateway still must verify credentials/account/TEST mode.
 * Copy both arguments first; never accept provider metadata as expected context. */
export function assertStripeTaxSdkMetadata(input: StripeTaxSdkMetadata, expectedInput: StripeTaxSdkExpectedMetadata): void {
  try {
    const observed = snapshotPrivateJson(input), expected = snapshotPrivateJson(expectedInput);
    if (!observed || typeof observed !== 'object' || Array.isArray(observed) || !expected || typeof expected !== 'object' || Array.isArray(expected)) return invalid();
    const values = observed as Record<string, unknown>, scope = expected as Record<string, unknown>;
    if (Object.keys(values).some(key => !metadataFields.includes(key as typeof metadataFields[number])) || Object.keys(scope).length !== 3 || !['accountId', 'apiVersion', 'idempotencyKey'].every(key => Object.hasOwn(scope, key))) return invalid();
    const accountId = field('stripeAccount', scope.accountId), apiVersion = field('apiVersion', scope.apiVersion), idempotencyKey = field('idempotencyKey', scope.idempotencyKey);
    for (const key of metadataFields) if (Object.hasOwn(values, key)) field(key, values[key]);
    if ((values.stripeAccount !== undefined && values.stripeAccount !== accountId) || (values.apiVersion !== undefined && values.apiVersion !== apiVersion) || (values.idempotencyKey !== undefined && values.idempotencyKey !== idempotencyKey)) throw new StripeTaxSdkBodyError('stripe_sdk_metadata_mismatch');
  } catch (error) {
    if (error instanceof StripeTaxSdkBodyError) throw error;
    return invalid();
  }
}
