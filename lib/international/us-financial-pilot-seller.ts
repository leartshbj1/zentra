import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateUsSellerProfileState, type UsSellerProfile } from './seller-profile';
import type { UsFinancialPolicyV5 } from './us-financial-kernel-types';

/** Presentation contracts grant no permission. The B1 executor below requires
 * freshly admitted private ports; PostgreSQL independently owns CAS/audit. */
export const US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES = 4096;
export const US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES = 65_536;
export const US_FINANCIAL_PILOT_SELLER_MAX_CHANGES = 1000;
export type UsFinancialPilotSellerCommand = Readonly<{
  type: 'update_seller_presentation'; displayName: string; contactEmail: string | null; contactPhone: string | null;
}>;
export interface UsFinancialPilotSellerRequest {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly requestId: string;
  readonly expectedRevision: number; readonly expectedSellerRevision: number; readonly command: UsFinancialPilotSellerCommand;
}
export interface UsFinancialPilotSellerPresentation {
  readonly origin: 'legacy-frozen' | 'financial-v5'; readonly baseSellerRevision: number; readonly sellerRevision: number;
  readonly changeCount: number; readonly profile: UsSellerProfile; readonly updatedBy: string; readonly updatedAt: string;
  readonly changeSha256: string | null;
}
export interface UsFinancialPilotSellerHead {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string;
  readonly revision: number; readonly bankRevision: number; readonly sellerRevision: number;
}
export interface UsFinancialPilotSellerRead { readonly head: UsFinancialPilotSellerHead; readonly presentation: UsFinancialPilotSellerPresentation }
export interface UsFinancialPilotSellerProof {
  readonly schemaVersion: 1; readonly organizationId: string; readonly request: UsFinancialPilotSellerRequest; readonly actor: FinancialAuthority;
  readonly commandHash: string; readonly before: UsFinancialPilotSellerPresentation; readonly after: UsSellerProfile;
  readonly sellerRevision: number; readonly changeIndex: number; readonly changedAt: string; readonly changeSha256: string;
}
export interface UsFinancialPilotSellerReceipt {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string; readonly requestId: string;
  readonly actorId: string; readonly action: 'update_seller_presentation'; readonly sourceRevision: number; readonly sellerRevision: number;
  readonly commandHash: string; readonly changeSha256: string; readonly changedAt: string; readonly replayed: boolean;
}
/** A caller expectation is detached before hashing. Its current audit time is
 * validated but never replaces or compares equal to the historical actor time. */
export interface UsFinancialPilotSellerExpectation { readonly request: UsFinancialPilotSellerRequest; readonly actor: FinancialAuthority }
export interface UsFinancialPilotSellerAppend { readonly request: UsFinancialPilotSellerRequest; readonly proof: UsFinancialPilotSellerProof }
export interface UsFinancialPilotSellerPort {
  read(this: void): Promise<UsFinancialPilotSellerRead>;
  head(this: void): Promise<UsFinancialPilotSellerHead>;
  receipt(this: void, requestId: string): Promise<UsFinancialPilotSellerProof | null>;
  append(this: void, value: UsFinancialPilotSellerAppend): Promise<UsFinancialPilotSellerProof>;
}
export interface UsFinancialPilotSellerDependencies {
  readonly organizationId: string; readonly actor: FinancialAuthority; readonly policy: UsFinancialPolicyV5; readonly store: UsFinancialPilotSellerPort;
  revalidate(this: void): Promise<Readonly<{ actor: FinancialAuthority; policy: UsFinancialPolicyV5 }>>;
  writeEnabled(this: void): Promise<boolean>;
}

const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
const COMMAND_NAMESPACE = 'zentra:us:financial-pilot:seller:v1';
const fail = (code = 'invalid_financial_seller_data', status = 503): never => { throw new ErpError(code, status); };
const invalidRequest = (): never => fail('invalid_financial_pilot_request', 422);
const same = (left: unknown, right: unknown): boolean => canonicalErpJson(left) === canonicalErpJson(right);
async function digest(content: string): Promise<string> {
  try { return await sha256Hex(content); } catch { return fail(); }
}
function captured(value: unknown, maximum = US_FINANCIAL_PILOT_SELLER_MAX_RESPONSE_BYTES): unknown {
  const result = snapshotPrivateJson(value);
  // Post-capture UTF-8 budget, in addition to private-json's structural budgets.
  // This is not a preallocation or peak-memory guarantee.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maximum) return fail();
  return result;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0, maximum = MAX_REVISION): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) return fail();
  return value;
}
function identity(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  return value;
}
function organization(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return fail();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return fail();
  return value;
}
function hash(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail(); }
/** Preserve the source text, compare the real instant at PostgreSQL precision.
 * Date only validates the whole second; fractions are never rounded to ms. */
function microseconds(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) return fail();
  const fraction = /\.([0-9]{1,6})(?=Z|[+-])/.exec(value)?.[1] ?? '';
  const seconds = parseInstant(value.replace(/\.[0-9]{1,6}(?=Z|[+-])/, '')).getTime();
  return BigInt(seconds) * BigInt(1000) + BigInt(fraction.padEnd(6, '0') || '0');
}
function actor(input: unknown, organizationId: string): FinancialAuthority {
  const value = fields(input, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (value.organizationId !== organizationId || value.role !== 'owner' || value.managementEntitled !== true || typeof value.timestamp !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value.timestamp)) return fail();
  microseconds(value.timestamp);
  return Object.freeze({ organizationId, userId: identity(value.userId), role: 'owner', managementEntitled: true, timestamp: value.timestamp });
}
function profile(value: unknown): UsSellerProfile {
  // Reuse the existing profile validator, including its canonical equality
  // check: trimming or silently dropping a field must not change user input.
  const state = validateUsSellerProfileState({ status: 'configured', organizationId: 'seller-contract-validation', revision: 1,
    profile: value, updatedBy: 'seller-contract-validation', updatedAt: '2026-01-01T00:00:00Z' }, 'seller-contract-validation');
  if (state.status !== 'configured') return fail();
  return state.profile;
}
function command(input: unknown): UsFinancialPilotSellerCommand {
  const value = fields(input, ['type', 'displayName', 'contactEmail', 'contactPhone']);
  if (value.type !== 'update_seller_presentation') return fail();
  const checked = profile({ displayName: value.displayName, ...(value.contactEmail === null ? {} : { contactEmail: value.contactEmail }),
    ...(value.contactPhone === null ? {} : { contactPhone: value.contactPhone }) });
  return Object.freeze({ type: 'update_seller_presentation', displayName: checked.displayName, contactEmail: checked.contactEmail ?? null, contactPhone: checked.contactPhone ?? null });
}
function commandProfile(value: UsFinancialPilotSellerCommand): UsSellerProfile {
  return Object.freeze({ displayName: value.displayName, ...(value.contactEmail === null ? {} : { contactEmail: value.contactEmail }), ...(value.contactPhone === null ? {} : { contactPhone: value.contactPhone }) });
}
function presentation(input: unknown): UsFinancialPilotSellerPresentation {
  const value = fields(input, ['origin', 'baseSellerRevision', 'sellerRevision', 'changeCount', 'profile', 'updatedBy', 'updatedAt', 'changeSha256']);
  const baseSellerRevision = integer(value.baseSellerRevision, 1), sellerRevision = integer(value.sellerRevision, 1), changeCount = integer(value.changeCount, 0, US_FINANCIAL_PILOT_SELLER_MAX_CHANGES);
  if (BigInt(baseSellerRevision) + BigInt(changeCount) !== BigInt(sellerRevision)) return fail();
  if (value.origin === 'legacy-frozen') { if (changeCount !== 0 || value.changeSha256 !== null) return fail(); }
  else if (value.origin === 'financial-v5') { if (changeCount === 0) return fail(); hash(value.changeSha256); }
  else return fail();
  microseconds(value.updatedAt);
  return Object.freeze({ origin: value.origin, baseSellerRevision, sellerRevision, changeCount, profile: profile(value.profile), updatedBy: identity(value.updatedBy),
    updatedAt: value.updatedAt as string, changeSha256: value.changeSha256 as string | null });
}
function head(input: unknown, expectedOrganization?: string): UsFinancialPilotSellerHead {
  const value = fields(input, ['consumer', 'schemaVersion', 'organizationId', 'revision', 'bankRevision', 'sellerRevision']);
  const organizationId = organization(value.organizationId);
  if (value.consumer !== 'financial-pilot' || value.schemaVersion !== 1 || (expectedOrganization !== undefined && organizationId !== organization(expectedOrganization))) return fail();
  return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: integer(value.revision, 1), bankRevision: integer(value.bankRevision), sellerRevision: integer(value.sellerRevision, 1) });
}
function read(input: unknown, expectedOrganization?: string): UsFinancialPilotSellerRead {
  const value = fields(input, ['head', 'presentation']), checkedHead = head(value.head, expectedOrganization), checkedPresentation = presentation(value.presentation);
  if (checkedHead.sellerRevision !== checkedPresentation.sellerRevision) return fail();
  return Object.freeze({ head: checkedHead, presentation: checkedPresentation });
}
function expectation(input: unknown, organizationId: string): UsFinancialPilotSellerExpectation | undefined {
  if (input === undefined) return undefined;
  const value = fields(captured(input), ['request', 'actor']);
  return Object.freeze({ request: validateUsFinancialPilotSellerRequest(value.request), actor: actor(value.actor, organizationId) });
}

export function validateUsFinancialPilotSellerRequest(value: unknown): UsFinancialPilotSellerRequest {
  try {
    const input = fields(captured(value, US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES), ['consumer', 'schemaVersion', 'requestId', 'expectedRevision', 'expectedSellerRevision', 'command']);
    if (input.consumer !== 'financial-pilot' || input.schemaVersion !== 1) return invalidRequest();
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, requestId: uuid(input.requestId), expectedRevision: integer(input.expectedRevision, 1),
      expectedSellerRevision: integer(input.expectedSellerRevision, 1), command: command(input.command) });
  } catch { return invalidRequest(); }
}
export function validateUsFinancialPilotSellerHead(value: unknown, organizationId?: string): UsFinancialPilotSellerHead {
  try { return head(captured(value), organizationId); } catch { return fail(); }
}
export function validateUsFinancialPilotSellerPresentation(value: unknown): UsFinancialPilotSellerPresentation {
  try { return presentation(captured(value)); } catch { return fail(); }
}
export function validateUsFinancialPilotSellerRead(value: unknown, organizationId?: string): UsFinancialPilotSellerRead {
  try { return read(captured(value), organizationId); } catch { return fail(); }
}
/** Exact public command to printable profile; null deliberately removes a contact. */
export function usFinancialPilotSellerProfile(value: unknown): UsSellerProfile {
  try { return commandProfile(command(captured(value, US_FINANCIAL_PILOT_SELLER_MAX_BODY_BYTES))); } catch { return invalidRequest(); }
}
/** Canonical identity only, never an authority or an idempotency decision. */
export function usFinancialPilotSellerCommandContent(organizationId: string, actorId: string, value: unknown): string {
  try { return canonicalErpJson([COMMAND_NAMESPACE, organization(organizationId), identity(actorId), validateUsFinancialPilotSellerRequest(value)]); } catch { return invalidRequest(); }
}
export async function usFinancialPilotSellerCommandHash(organizationId: string, actorId: string, value: unknown): Promise<string> {
  const content = usFinancialPilotSellerCommandContent(organizationId, actorId, value);
  return digest(content);
}
function proofPayload(value: UsFinancialPilotSellerProof): Omit<UsFinancialPilotSellerProof, 'changeSha256'> {
  return Object.freeze({ schemaVersion: value.schemaVersion, organizationId: value.organizationId, request: value.request, actor: value.actor, commandHash: value.commandHash,
    before: value.before, after: value.after, sellerRevision: value.sellerRevision, changeIndex: value.changeIndex, changedAt: value.changedAt });
}
function proof(input: unknown, expectedOrganization?: string): UsFinancialPilotSellerProof {
  const value = fields(input, ['schemaVersion', 'organizationId', 'request', 'actor', 'commandHash', 'before', 'after', 'sellerRevision', 'changeIndex', 'changedAt', 'changeSha256']);
  const organizationId = organization(value.organizationId);
  if (value.schemaVersion !== 1 || (expectedOrganization !== undefined && organizationId !== organization(expectedOrganization))) return fail();
  const request = validateUsFinancialPilotSellerRequest(value.request), checkedActor = actor(value.actor, organizationId), before = presentation(value.before), after = profile(value.after);
  const sellerRevision = integer(value.sellerRevision, 2), changeIndex = integer(value.changeIndex, 1, US_FINANCIAL_PILOT_SELLER_MAX_CHANGES);
  if (request.expectedSellerRevision !== before.sellerRevision || BigInt(before.sellerRevision) + BigInt(1) !== BigInt(sellerRevision) || before.changeCount + 1 !== changeIndex ||
    !same(after, commandProfile(request.command)) || value.changedAt !== checkedActor.timestamp || microseconds(value.changedAt) < microseconds(before.updatedAt)) return fail();
  return Object.freeze({ schemaVersion: 1, organizationId, request, actor: checkedActor, commandHash: hash(value.commandHash), before, after, sellerRevision, changeIndex,
    changedAt: value.changedAt as string, changeSha256: hash(value.changeSha256) });
}
/** Historical structural validation. It does not consult a current head or
 * reconstruct the chain; self-consistent hashes do not prove DB provenance. */
export async function validateUsFinancialPilotSellerProof(value: unknown, organizationId?: string, expected?: UsFinancialPilotSellerExpectation): Promise<UsFinancialPilotSellerProof> {
  let result: UsFinancialPilotSellerProof, capturedExpectation: UsFinancialPilotSellerExpectation | undefined;
  try { result = proof(captured(value), organizationId); capturedExpectation = expectation(expected, result.organizationId); } catch { return fail(); }
  const expectedHash = await usFinancialPilotSellerCommandHash(result.organizationId, result.actor.userId, result.request);
  if (result.commandHash !== expectedHash || result.changeSha256 !== await digest(canonicalErpJson(proofPayload(result)))) return fail();
  if (capturedExpectation && (!same(capturedExpectation.request, result.request) || capturedExpectation.actor.userId !== result.actor.userId)) return fail();
  return result;
}
export async function buildUsFinancialPilotSellerProof(value: unknown, requestValue: unknown, actorValue: FinancialAuthority): Promise<UsFinancialPilotSellerProof> {
  // All caller-owned arguments are captured before the first asynchronous hash.
  const source = validateUsFinancialPilotSellerRead(value), request = validateUsFinancialPilotSellerRequest(requestValue);
  let checkedActor: FinancialAuthority;
  try { checkedActor = actor(captured(actorValue), source.head.organizationId); } catch { return fail(); }
  if (source.head.revision !== request.expectedRevision) return fail('financial_snapshot_changed', 409);
  if (source.head.sellerRevision !== request.expectedSellerRevision) return fail('seller_revision_conflict', 409);
  if (source.presentation.changeCount >= US_FINANCIAL_PILOT_SELLER_MAX_CHANGES || source.head.sellerRevision >= MAX_REVISION) return fail('seller_limit_reached', 409);
  if (microseconds(checkedActor.timestamp) < microseconds(source.presentation.updatedAt)) return fail('seller_clock_conflict', 409);
  const commandHash = await usFinancialPilotSellerCommandHash(source.head.organizationId, checkedActor.userId, request);
  const payload = Object.freeze({ schemaVersion: 1 as const, organizationId: source.head.organizationId, request, actor: checkedActor, commandHash, before: source.presentation,
    after: commandProfile(request.command), sellerRevision: source.head.sellerRevision + 1, changeIndex: source.presentation.changeCount + 1, changedAt: checkedActor.timestamp });
  const changeSha256 = await digest(canonicalErpJson(payload));
  return validateUsFinancialPilotSellerProof({ ...payload, changeSha256 });
}
/** Apply only to the exact source presentation and F/S. This advances S alone;
 * a second application refuses, rather than pretending to execute a replay. */
export async function applyUsFinancialPilotSellerProof(value: unknown, proofValue: unknown): Promise<UsFinancialPilotSellerRead> {
  const source = validateUsFinancialPilotSellerRead(value);
  let capturedProof: unknown;
  try { capturedProof = captured(proofValue); } catch { return fail(); }
  const checked = await validateUsFinancialPilotSellerProof(capturedProof, source.head.organizationId);
  if (source.head.revision !== checked.request.expectedRevision) return fail('financial_snapshot_changed', 409);
  if (source.head.sellerRevision !== checked.before.sellerRevision || !same(source.presentation, checked.before)) return fail('seller_revision_conflict', 409);
  if (source.presentation.changeCount >= US_FINANCIAL_PILOT_SELLER_MAX_CHANGES || source.head.sellerRevision >= MAX_REVISION) return fail('seller_limit_reached', 409);
  if (microseconds(checked.changedAt) < microseconds(source.presentation.updatedAt)) return fail('seller_clock_conflict', 409);
  return validateUsFinancialPilotSellerRead({ head: { ...source.head, sellerRevision: checked.sellerRevision }, presentation: { origin: 'financial-v5',
    baseSellerRevision: source.presentation.baseSellerRevision, sellerRevision: checked.sellerRevision, changeCount: checked.changeIndex,
    profile: checked.after, updatedBy: checked.actor.userId, updatedAt: checked.changedAt, changeSha256: checked.changeSha256 } }, source.head.organizationId);
}
export async function projectUsFinancialPilotSellerReceipt(value: unknown, replayed = false): Promise<UsFinancialPilotSellerReceipt> {
  let capturedProof: unknown;
  try { capturedProof = captured(value); if (typeof replayed !== 'boolean') return fail(); } catch { return fail(); }
  const checked = await validateUsFinancialPilotSellerProof(capturedProof);
  return validateUsFinancialPilotSellerReceipt({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: checked.organizationId, requestId: checked.request.requestId,
    actorId: checked.actor.userId, action: 'update_seller_presentation', sourceRevision: checked.request.expectedRevision, sellerRevision: checked.sellerRevision,
    commandHash: checked.commandHash, changeSha256: checked.changeSha256, changedAt: checked.changedAt, replayed });
}
/** sourceRevision is historical F. This object is deliberately not a financial
 * receipt/head and supplies no effective replay or authorization decision. */
export async function validateUsFinancialPilotSellerReceipt(value: unknown, organizationId?: string, expected?: UsFinancialPilotSellerExpectation): Promise<UsFinancialPilotSellerReceipt> {
  let result: UsFinancialPilotSellerReceipt, capturedExpectation: UsFinancialPilotSellerExpectation | undefined;
  try {
    const input = fields(captured(value), ['consumer', 'schemaVersion', 'organizationId', 'requestId', 'actorId', 'action', 'sourceRevision', 'sellerRevision', 'commandHash', 'changeSha256', 'changedAt', 'replayed']);
    const org = organization(input.organizationId);
    if (input.consumer !== 'financial-pilot' || input.schemaVersion !== 1 || (organizationId !== undefined && org !== organization(organizationId)) || input.action !== 'update_seller_presentation' || typeof input.replayed !== 'boolean' || typeof input.changedAt !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(input.changedAt)) return fail();
    microseconds(input.changedAt);
    result = Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, requestId: uuid(input.requestId), actorId: identity(input.actorId), action: 'update_seller_presentation',
      sourceRevision: integer(input.sourceRevision, 1), sellerRevision: integer(input.sellerRevision, 2), commandHash: hash(input.commandHash), changeSha256: hash(input.changeSha256), changedAt: input.changedAt, replayed: input.replayed });
    capturedExpectation = expectation(expected, org);
  } catch { return fail(); }
  if (capturedExpectation) {
    const request = capturedExpectation.request, expectedHash = await usFinancialPilotSellerCommandHash(result.organizationId, capturedExpectation.actor.userId, request);
    if (result.requestId !== request.requestId || result.actorId !== capturedExpectation.actor.userId || result.sourceRevision !== request.expectedRevision ||
      BigInt(result.sellerRevision) !== BigInt(request.expectedSellerRevision) + BigInt(1) || result.commandHash !== expectedHash) return fail();
  }
  return result;
}

/** Receipt-first execution behind a freshly admitted, independently validated
 * private store. An unchanged historical request may recover with writes off;
 * no conflict automatically rebases its approved F/S or changes its UUID. */
export async function executeUsFinancialPilotSeller(deps: UsFinancialPilotSellerDependencies, value: unknown): Promise<UsFinancialPilotSellerReceipt> {
  const own = (object: unknown, key: string): unknown => {
    try {
      if (!object || typeof object !== 'object') return fail();
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
      return descriptor.value;
    } catch { return fail(); }
  };
  const method = <T>(object: unknown, key: string): T => { const fn = own(object, key); if (typeof fn !== 'function') return fail(); return fn as T; };
  const admittedActor = (input: unknown, org: string): FinancialAuthority => {
    const data = fields(captured(input), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
    if (data.organizationId !== org) return fail('tenant_mismatch', 403);
    if (data.managementEntitled !== true) return fail('management_entitlement_required', 402);
    if (data.role !== 'owner') return fail('financial_permission_required', 403);
    return actor(data, org);
  };
  const request = validateUsFinancialPilotSellerRequest(value), org = organization(own(deps, 'organizationId'));
  const initialActor = admittedActor(own(deps, 'actor'), org), policy = captured(own(deps, 'policy')), port = own(deps, 'store');
  const revalidate = method<UsFinancialPilotSellerDependencies['revalidate']>(deps, 'revalidate'), writeEnabled = method<UsFinancialPilotSellerDependencies['writeEnabled']>(deps, 'writeEnabled');
  const readPort = method<UsFinancialPilotSellerPort['read']>(port, 'read'), receiptPort = method<UsFinancialPilotSellerPort['receipt']>(port, 'receipt'), appendPort = method<UsFinancialPilotSellerPort['append']>(port, 'append');
  let observedAt = microseconds(initialActor.timestamp);
  async function fresh(): Promise<FinancialAuthority> {
    const current = fields(captured(await revalidate()), ['actor', 'policy']), currentActor = admittedActor(current.actor, org), instant = microseconds(currentActor.timestamp);
    if (currentActor.userId !== initialActor.userId || currentActor.role !== initialActor.role) return fail('financial_authority_changed', 403);
    if (!same(current.policy, policy)) return fail('financial_policy_unavailable', 409);
    if (instant < observedAt) return fail('financial_clock_reversed', 409);
    observedAt = instant; return currentActor;
  }
  async function guarded<T>(operation: () => Promise<T>, captureResult: (result: T) => T = result => result): Promise<T> {
    await fresh(); let outcome: { value: T } | { error: unknown };
    try { outcome = { value: captureResult(await operation()) }; } catch (error) { outcome = { error }; }
    await fresh(); if ('error' in outcome) throw outcome.error; return outcome.value;
  }
  const commandHash = await guarded(() => usFinancialPilotSellerCommandHash(org, initialActor.userId, request));
  async function replay(): Promise<UsFinancialPilotSellerReceipt | null> {
    const raw = await guarded(() => receiptPort(request.requestId), result => result === null ? null : captured(result) as UsFinancialPilotSellerProof);
    if (raw === null) return null;
    const proof = await guarded(() => validateUsFinancialPilotSellerProof(raw, org));
    if (proof.actor.userId !== initialActor.userId || proof.commandHash !== commandHash || !same(proof.request, request)) return fail('seller_idempotency_conflict', 409);
    return guarded(() => projectUsFinancialPilotSellerReceipt(proof, true));
  }
  const previous = await replay(); if (previous) return previous;
  try {
    if (await guarded(writeEnabled) !== true) return fail('seller_writes_disabled', 409);
    const read = await guarded(readPort, result => validateUsFinancialPilotSellerRead(result, org)), executionActor = await fresh();
    const proposal = await guarded(() => buildUsFinancialPilotSellerProof(read, request, executionActor));
    if (await guarded(writeEnabled) !== true) return fail('seller_writes_disabled', 409);
    const raw = await guarded(() => appendPort(Object.freeze({ request, proof: proposal })), result => captured(result) as UsFinancialPilotSellerProof);
    const saved = await guarded(() => validateUsFinancialPilotSellerProof(raw, org, { request, actor: initialActor }));
    if (saved.commandHash !== commandHash) return fail();
    if (!same(saved, proposal)) {
      const concurrent = await replay(); if (concurrent) return concurrent; return fail();
    }
    return guarded(() => projectUsFinancialPilotSellerReceipt(saved, false));
  } catch (error) {
    const recovered = await replay(); if (recovered) return recovered; throw error;
  }
}
