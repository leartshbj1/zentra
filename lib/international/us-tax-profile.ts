import type { AccountRole } from '../account-security';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { validateAddress } from './addresses';
import { countryConfiguration } from './country-config';
import { canonicalErpJson } from './erp-contract';
import { parseInstant } from './localization';
import type { USAddress } from './types';

export type TaxProfileStore = Pick<SupabaseServerClient, 'rpc'>;
/** Supplied by the fresh Auth/D1 boundary, never a submitted role or grant. */
export interface TaxProfileActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: AccountRole;
}
/** Private declarations only. Saving these facts never verifies a tax setup. */
export interface UsTaxFacts {
  readonly schemaVersion: 1;
  readonly legalName: string;
  readonly taxOrigin: USAddress;
  readonly timeZone: string;
}
export interface UsTaxProfileDeclared {
  readonly status: 'declared';
  readonly organizationId: string;
  readonly revision: number;
  readonly facts: UsTaxFacts;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly verification: 'unverified';
}
export type UsTaxProfileState = UsTaxProfileDeclared | Readonly<{
  status: 'unconfigured';
  organizationId: string;
  revision: 0;
  verification: 'unverified';
}>;
export interface UsTaxProfileWrite {
  readonly expectedRevision: number;
  readonly requestId: string;
  readonly facts: UsTaxFacts;
}
export interface UsTaxProfileReceipt extends UsTaxProfileDeclared {
  readonly requestId: string;
  readonly replayed: boolean;
}
export type UsTaxConfigurationResolution = Readonly<{
  status: 'blocked';
  reason: 'tax_details_required' | 'provider_verification_required';
  organizationId: string;
  revision: number;
}>;
export class UsTaxProfileError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'forbidden' | 'revision_conflict' | 'request_id_conflict' | 'workspace_unavailable' | 'service_unavailable',
    readonly status: number,
  ) {
    super(code);
    this.name = 'UsTaxProfileError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_FIELDS = ['status', 'organizationId', 'revision', 'facts', 'updatedBy', 'updatedAt', 'verification'];
const ADDRESS_FIELDS = ['country', 'line1', 'line2', 'postalCode', 'city', 'subdivision'];
const ADDRESS_REQUIRED = ['country', 'line1', 'postalCode', 'city', 'subdivision'];

function invalid(): never { throw new UsTaxProfileError('invalid_request', 422); }
/** Snapshot own data properties once. Neither parsing nor validation invokes getters. */
function dataObject(input: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
  const value = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key))) return invalid();
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    copied[key] = descriptor.value;
  }
  return copied;
}
function hasControl(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
/** JSONB cannot store isolated UTF16 surrogates. Reject them before private RPC I/O. */
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 256 && !hasControl(value);
}
function organization(value: unknown): value is string { return typeof value === 'string' && SCOPE.test(value); }
function actorSnapshot(input: TaxProfileActor): TaxProfileActor {
  // FinancialAuthority may carry extra trusted metadata. Only these three data
  // properties participate in this service; none is read from an accessor.
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new UsTaxProfileError('forbidden', 403);
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of ['organizationId', 'userId', 'role']) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new UsTaxProfileError('forbidden', 403);
    copied[key] = descriptor.value;
  }
  if (!organization(copied.organizationId) || !identity(copied.userId) || copied.role !== 'owner') throw new UsTaxProfileError('forbidden', 403);
  return Object.freeze({ organizationId: copied.organizationId, userId: copied.userId, role: 'owner' });
}

export function validateUsTaxFacts(input: unknown): UsTaxFacts {
  const value = dataObject(input, ['schemaVersion', 'legalName', 'taxOrigin', 'timeZone'], ['schemaVersion', 'legalName', 'taxOrigin', 'timeZone']);
  if (value.schemaVersion !== 1 || typeof value.legalName !== 'string' || !value.legalName.trim() || value.legalName.length > 256 || hasControl(value.legalName) || !wellFormed(value.legalName)) return invalid();
  if (typeof value.timeZone !== 'string' || !countryConfiguration('US').timeZones.includes(value.timeZone)) return invalid();
  const address = dataObject(value.taxOrigin, ADDRESS_FIELDS, ADDRESS_REQUIRED);
  let taxOrigin: USAddress;
  try {
    const checked = validateAddress(address, 'US');
    if (checked.country !== 'US') return invalid();
    if (![checked.line1, checked.city, ...(checked.line2 === undefined ? [] : [checked.line2])].every(wellFormed)) return invalid();
    taxOrigin = checked;
  } catch { return invalid(); }
  return Object.freeze({ schemaVersion: 1, legalName: value.legalName.trim(), taxOrigin, timeZone: value.timeZone });
}

export function validateUsTaxProfileWrite(input: unknown): UsTaxProfileWrite {
  const value = dataObject(input, ['expectedRevision', 'requestId', 'facts'], ['expectedRevision', 'requestId', 'facts']);
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 || (value.expectedRevision as number) >= Number.MAX_SAFE_INTEGER - 1 || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) return invalid();
  return Object.freeze({ expectedRevision: value.expectedRevision as number, requestId: value.requestId.toLowerCase(), facts: validateUsTaxFacts(value.facts) });
}

function declared(value: Record<string, unknown>, organizationId: string): UsTaxProfileDeclared {
  if (value.status !== 'declared' || value.organizationId !== organizationId || value.verification !== 'unverified' || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || (value.revision as number) >= Number.MAX_SAFE_INTEGER || !identity(value.updatedBy) || typeof value.updatedAt !== 'string') return invalid();
  const facts = validateUsTaxFacts(value.facts);
  // Privileged reads and historical receipts must already be canonical; the
  // public write validator's trim must not conceal a different stored value.
  if (canonicalErpJson(facts) !== canonicalErpJson(value.facts)) return invalid();
  // PostgreSQL emits up to six fractional digits. Validate the calendar/offset
  // with a millisecond projection, preserving the exact original timestamp.
  if (!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value.updatedAt)) return invalid();
  try { parseInstant(value.updatedAt.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/, '$1')); }
  catch { return invalid(); }
  return Object.freeze({ status: 'declared', organizationId, revision: value.revision as number, facts, updatedBy: value.updatedBy, updatedAt: value.updatedAt, verification: 'unverified' });
}

/** Private service boundary. These facts never prove registrations or grant issuance. */
export function validateUsTaxProfileState(input: unknown, organizationId: string): UsTaxProfileState {
  if (!organization(organizationId)) return invalid();
  const value = dataObject(input, PROFILE_FIELDS, ['status', 'organizationId', 'revision', 'verification']);
  if (value.status === 'unconfigured') {
    const empty = dataObject(value, ['status', 'organizationId', 'revision', 'verification'], ['status', 'organizationId', 'revision', 'verification']);
    if (empty.organizationId !== organizationId || empty.revision !== 0 || empty.verification !== 'unverified') return invalid();
    return Object.freeze({ status: 'unconfigured', organizationId, revision: 0, verification: 'unverified' });
  }
  if (['facts', 'updatedBy', 'updatedAt'].some(key => !Object.hasOwn(value, key))) return invalid();
  return declared(value, organizationId);
}

export function validateUsTaxProfileReceipt(input: unknown, organizationId: string, userId: string, expectedWrite: UsTaxProfileWrite): UsTaxProfileReceipt {
  if (!organization(organizationId) || !identity(userId)) return invalid();
  const write = validateUsTaxProfileWrite(expectedWrite);
  const value = dataObject(input, [...PROFILE_FIELDS, 'requestId', 'replayed'], [...PROFILE_FIELDS, 'requestId', 'replayed']);
  const state = declared(value, organizationId);
  if (value.requestId !== write.requestId || typeof value.replayed !== 'boolean' || state.updatedBy !== userId || state.revision !== write.expectedRevision + 1 || canonicalErpJson(state.facts) !== canonicalErpJson(write.facts)) return invalid();
  return Object.freeze({ ...state, requestId: write.requestId, replayed: value.replayed });
}

function storageError(error: unknown): UsTaxProfileError {
  if (error instanceof SupabaseServerError) {
    const states = {
      PT001: ['revision_conflict', 409], PT002: ['request_id_conflict', 409],
      PT003: ['workspace_unavailable', 409], PT004: ['invalid_request', 422],
    } as const;
    const state = states[error.code as keyof typeof states];
    if (state) return new UsTaxProfileError(state[0], state[1]);
  }
  return new UsTaxProfileError('service_unavailable', 503);
}

export async function getUsTaxProfile(store: TaxProfileStore, actor: TaxProfileActor): Promise<UsTaxProfileState> {
  const trusted = actorSnapshot(actor);
  try {
    const result = await store.rpc<unknown>('zentra_read_us_tax_profile', { p_organization: trusted.organizationId });
    return validateUsTaxProfileState(result, trusted.organizationId);
  } catch (error) { throw storageError(error); }
}

export async function putUsTaxProfile(store: TaxProfileStore, actor: TaxProfileActor, input: unknown, beforeWrite?: () => Promise<void>): Promise<UsTaxProfileReceipt> {
  const trusted = actorSnapshot(actor), write = validateUsTaxProfileWrite(input);
  // Preserve Auth exceptions and their status. The hook's fresh admission is
  // deliberately outside the SQL/privileged-response error translation.
  if (beforeWrite) await beforeWrite();
  try {
    const result = await store.rpc<unknown>('zentra_put_us_tax_profile', {
      p_organization: trusted.organizationId, p_actor: trusted.userId, p_expected_revision: write.expectedRevision,
      p_request_id: write.requestId, p_facts: write.facts,
    });
    return validateUsTaxProfileReceipt(result, trusted.organizationId, trusted.userId, write);
  } catch (error) { throw storageError(error); }
}

/** Deliberately blocked, including after a successful declaration. No provider data escapes. */
export async function resolveUsTaxConfiguration(store: TaxProfileStore, actor: TaxProfileActor): Promise<UsTaxConfigurationResolution> {
  const state = await getUsTaxProfile(store, actor);
  return Object.freeze({ status: 'blocked', reason: state.status === 'unconfigured' ? 'tax_details_required' : 'provider_verification_required', organizationId: state.organizationId, revision: state.revision });
}
