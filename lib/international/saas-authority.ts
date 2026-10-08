import { isAccountRole, type AccountRole } from '../account-security';
import { canonicalCreationJson, creationUuid, validateCreationReceipt, type WorkspaceCreationIntent } from './workspace-creation';
import { resolveSubscriptionOffer, subscriptionRights, validateSubscriptionOffer, verifyServerStripePrice, type SaasModule, type SaasSubscriptionAuthority, type SaasSubscriptionOffer, type ServerStripePrice, type SubscriptionEnvironment } from './subscriptions';

export class UsAuthorityError extends Error {
  constructor(readonly code: 'invalid_authority' | 'subscription_required' | 'forbidden' | 'admission_conflict' | 'service_unavailable', readonly status: number) { super(code); }
}
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(name => typeof name !== 'string' || !keys.includes(name))) throw new UsAuthorityError('invalid_authority', 422);
  return value as Record<string, unknown>;
}
const offerKeys = ['kind','catalogVersion','country','currency','module','plan','priceId','productId','environment','unitAmountMinor','interval','intervalCount','taxBehavior'];
export function parseUsSubscriptionAuthority(value: unknown): SaasSubscriptionAuthority {
  const fields = exact(value, ['kind','organizationId','subscriptionId','offer','status','evidence']);
  const offer = validateSubscriptionOffer(exact(fields.offer, offerKeys) as unknown as SaasSubscriptionOffer);
  const proof = exact(fields.evidence, ['kind','referenceId','organizationId','subscriptionId','environment','catalogVersion','priceId','currency','startsAt','endsAt','revoked']);
  if (fields.kind !== 'saas_subscription_authority' || !key(fields.organizationId) || !key(fields.subscriptionId) || !['active','past_due','trialing','canceled','expired','incomplete'].includes(String(fields.status)) || !['verified_payment','authorized_trial'].includes(String(proof.kind)) || !key(proof.referenceId) || !instant(proof.startsAt) || !instant(proof.endsAt) || proof.endsAt <= proof.startsAt || typeof proof.revoked !== 'boolean') throw new UsAuthorityError('invalid_authority', 422);
  // Construct the exact DTO: no private provider objects or unknown JSON fields persist.
  return Object.freeze({ ...fields, offer, evidence: Object.freeze({ ...proof }) }) as unknown as SaasSubscriptionAuthority;
}
export interface UsSaasPolicy {
  readonly catalog: readonly { readonly offer: SaasSubscriptionOffer; readonly seatLimit: number }[];
  readonly environment: SubscriptionEnvironment;
  readonly now: number;
}
export interface UsAuthorityRecord {
  readonly organizationId: string;
  readonly creationId: string;
  readonly ownerUserId: string;
  readonly authority: SaasSubscriptionAuthority;
  readonly seatLimit: number;
  readonly revision: 1;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
}
const admissionBrand = Symbol('server-validated-us-admission');
export interface UsAuthorityAdmission extends UsAuthorityRecord {
  readonly [admissionBrand]: true;
  readonly configurationFingerprint: string;
}
function approvedAuthority(intent: WorkspaceCreationIntent, record: UsAuthorityRecord, policy: UsSaasPolicy): SaasSubscriptionAuthority {
  try {
    for (const id of [record.organizationId, record.creationId, record.ownerUserId]) creationUuid(id);
    if (intent.state === 'reserved' || !intent.receipt || record.organizationId !== intent.organizationId || record.creationId !== intent.creationId || record.ownerUserId !== intent.actorUserId || intent.configuration.country !== 'US' || intent.configuration.currency !== 'USD' || record.revision !== 1 || !instant(record.updatedAt) || !Number.isSafeInteger(record.seatLimit) || record.seatLimit < 1 || record.seatLimit > 1000 || (record.revokedAt !== null && (!instant(record.revokedAt) || record.revokedAt < record.updatedAt))) throw new Error('Invalid scope');
    validateCreationReceipt(intent.receipt, intent);
    const authority = parseUsSubscriptionAuthority(record.authority);
    const offer = resolveSubscriptionOffer(intent.configuration, { plan: authority.offer.plan, module: authority.offer.module, environment: policy.environment }, policy.catalog.map(entry => entry.offer));
    const entry = policy.catalog.find(entry => canonicalCreationJson(entry.offer) === canonicalCreationJson(offer));
    if (!entry || !Number.isSafeInteger(entry.seatLimit) || entry.seatLimit !== record.seatLimit || canonicalCreationJson(offer) !== canonicalCreationJson(authority.offer) || authority.organizationId !== intent.organizationId) throw new Error('Unapproved offer');
    return authority;
  } catch { throw new UsAuthorityError('invalid_authority', 422); }
}
/** Internal server boundary only. Provider objects/evidence must already come
 * from a verified webhook and server retrieval, never from a public request.
 * A successful price check alone is not payment or signature verification. */
export function prepareUsAuthorityAdmission(intent: WorkspaceCreationIntent, input: { readonly authority: unknown; readonly seatLimit: number }, policy: UsSaasPolicy, serverPrice: ServerStripePrice): UsAuthorityAdmission {
  const authority = parseUsSubscriptionAuthority(input.authority);
  const candidate: UsAuthorityRecord = { organizationId: intent.organizationId, creationId: intent.creationId, ownerUserId: intent.actorUserId, authority, seatLimit: input.seatLimit, revision: 1, updatedAt: policy.now, revokedAt: null };
  approvedAuthority(intent, candidate, policy);
  verifyServerStripePrice(authority.offer, serverPrice);
  // No trial issuer has been authorized by this phase, even with a valid USD price.
  if (authority.evidence?.kind !== 'verified_payment' || subscriptionRights(intent.configuration, authority, { module: 'gestion', environment: policy.environment, now: policy.now }).access !== 'read_write') throw new UsAuthorityError('subscription_required', 402);
  return Object.freeze({ ...candidate, configurationFingerprint:intent.fingerprint, [admissionBrand]: true as const });
}
export function assertUsAuthorityAdmission(candidate: UsAuthorityAdmission): void {
  if (candidate?.[admissionBrand] !== true) throw new UsAuthorityError('invalid_authority', 422);
}
export interface UsMembership {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: AccountRole;
  readonly joinedAt: number;
  readonly revokedAt: number | null;
}
export function usWorkspaceAccess(intent: WorkspaceCreationIntent, record: UsAuthorityRecord, membership: UsMembership, policy: UsSaasPolicy, module: SaasModule = 'gestion') {
  const authority = approvedAuthority(intent, record, policy);
  if (intent.state !== 'ready' || intent.ownSubscriptionId !== authority.subscriptionId || record.revokedAt !== null) throw new UsAuthorityError('subscription_required', 402);
  if (membership.organizationId !== intent.organizationId || !isAccountRole(membership.role) || !instant(membership.joinedAt) || membership.revokedAt !== null || !key(membership.userId) || !key(membership.membershipId)) throw new UsAuthorityError('forbidden', 403);
  if (subscriptionRights(intent.configuration, authority, { module, environment: policy.environment, now: policy.now }).access !== 'read_write') throw new UsAuthorityError('subscription_required', 402);
  return Object.freeze({ organizationId: intent.organizationId, userId: membership.userId, role: membership.role, subscriptionId: authority.subscriptionId, seatLimit: record.seatLimit });
}
