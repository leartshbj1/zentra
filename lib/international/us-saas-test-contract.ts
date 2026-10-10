import { snapshotPrivateJson } from './private-json';
import { canonicalCreationJson, creationUuid, validateCreationReceipt, type WorkspaceCreationIntent, type WorkspaceCreationReceipt } from './workspace-creation';
import { parseUsSubscriptionAuthority } from './saas-authority';
import { validateSubscriptionOffer, verifyServerStripePrice, type SaasSubscriptionAuthority, type SaasSubscriptionOffer, type ServerStripePrice } from './subscriptions';

/** Initial paid activation only. This contract is not a live billing or trial issuer. */
export class UsTestBillingError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export interface UsTestPurchase {
  readonly purchaseId: string;
  readonly creationId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly configurationFingerprint: string;
  readonly receipt: WorkspaceCreationReceipt;
  readonly offer: SaasSubscriptionOffer;
  readonly seatLimit: number;
  readonly providerAccountId: string;
  readonly siteOrigin: string;
  readonly integrationIdentifier: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface UsTestSession {
  readonly purchaseId: string;
  readonly sessionId: string;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface UsTestPaidProof {
  readonly purchaseId: string;
  readonly sessionId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly invoiceId: string;
  readonly eventId: string;
  readonly providerAccountId: string;
  readonly authority: SaasSubscriptionAuthority;
  readonly serverPrice: ServerStripePrice;
  readonly verifiedAt: number;
}
export interface UsTestGateway {
  create(this: void, purchase: UsTestPurchase): Promise<{ session: UsTestSession; url: string | null }>;
  /** The caller verifies the webhook signature first. These are locators, never grants. */
  locate(this: void, event: unknown): Promise<{ sessionId: string; eventId: string } | null>;
  verify(this: void, purchase: UsTestPurchase, session: UsTestSession, eventId: string): Promise<UsTestPaidProof>;
}
export const usTestStripeApiVersion = '2026-08-26.dahlia' as const;
export const usTestCheckoutWindowSeconds = 3600;
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function exact(value: object, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(field => !fields.includes(field))) throw new UsTestBillingError('invalid_purchase', 422);
}
export function validateUsTestPurchase(value: UsTestPurchase, intent?: WorkspaceCreationIntent): UsTestPurchase {
  try {
    const purchase = snapshotPrivateJson(value) as UsTestPurchase;
    exact(purchase, ['purchaseId','creationId','organizationId','actorUserId','requestId','configurationFingerprint','receipt','offer','seatLimit','providerAccountId','siteOrigin','integrationIdentifier','createdAt','expiresAt']);
    exact(purchase.offer, ['kind','catalogVersion','country','currency','module','plan','priceId','productId','environment','unitAmountMinor','interval','intervalCount','taxBehavior']);
    for (const id of [purchase.purchaseId, purchase.creationId, purchase.organizationId, purchase.actorUserId, purchase.requestId]) creationUuid(id);
    const offer = validateSubscriptionOffer(purchase.offer);
    const origin = new URL(purchase.siteOrigin);
    if (purchase.siteOrigin !== origin.origin || origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) || !/^acct_[A-Za-z0-9]+$/.test(purchase.providerAccountId) || !/^zentra_us_test_[a-z]{8}$/.test(purchase.integrationIdentifier) || !/^[a-f0-9]{64}$/.test(purchase.configurationFingerprint) || !instant(purchase.createdAt) || purchase.expiresAt !== purchase.createdAt + usTestCheckoutWindowSeconds || !Number.isSafeInteger(purchase.seatLimit) || purchase.seatLimit < 1 || purchase.seatLimit > 1000 || offer.country !== 'US' || offer.currency !== 'USD' || offer.environment !== 'TEST' || !['gestion', 'complet'].includes(offer.module)) throw new Error('Invalid purchase');
    const receiptIntent: WorkspaceCreationIntent = intent ?? { creationId:purchase.creationId, organizationId:purchase.organizationId, actorUserId:purchase.actorUserId, requestId:purchase.requestId, confirmationVersion:1, companyName:'Private US purchase', fingerprint:purchase.configurationFingerprint, configuration:purchase.receipt.configuration, state:'postgres_confirmed', receipt:purchase.receipt, createdAt:purchase.receipt.updatedAt, updatedAt:purchase.receipt.updatedAt };
    validateCreationReceipt(purchase.receipt, receiptIntent);
    if (purchase.receipt.creationId !== purchase.creationId || purchase.receipt.organizationId !== purchase.organizationId || purchase.receipt.actorUserId !== purchase.actorUserId || purchase.receipt.requestId !== purchase.requestId || purchase.receipt.configurationFingerprint !== purchase.configurationFingerprint || purchase.receipt.configuration.country !== 'US') throw new Error('Invalid scope');
    if (intent && (intent.state === 'reserved' || intent.creationId !== purchase.creationId || intent.organizationId !== purchase.organizationId || intent.actorUserId !== purchase.actorUserId || intent.requestId !== purchase.requestId || intent.fingerprint !== purchase.configurationFingerprint || canonicalCreationJson(intent.receipt) !== canonicalCreationJson(purchase.receipt))) throw new Error('Invalid intention');
    return Object.freeze(purchase);
  } catch { throw new UsTestBillingError('invalid_purchase', 422); }
}
export function usTestProviderIdempotencyKey(purchase: UsTestPurchase): string {
  return `zentra-us-test-${creationUuid(purchase.purchaseId)}`;
}
const sessions = new WeakSet<object>(), proofs = new WeakSet<object>();
/** Private server factory: call only after retrieval/validation by the dedicated gateway. */
export function verifiedUsTestSession(purchase: UsTestPurchase, fields: UsTestSession): UsTestSession {
  const value = snapshotPrivateJson(fields) as UsTestSession;
  exact(value, ['purchaseId','sessionId','customerId','subscriptionId','createdAt','expiresAt']);
  if (value.purchaseId !== purchase.purchaseId || !/^cs_test_[A-Za-z0-9_]+$/.test(value.sessionId) || (value.customerId !== null && !/^cus_[A-Za-z0-9_]+$/.test(value.customerId)) || (value.subscriptionId !== null && !/^sub_[A-Za-z0-9_]+$/.test(value.subscriptionId)) || !instant(value.createdAt) || value.createdAt < purchase.createdAt || value.createdAt >= purchase.expiresAt || value.expiresAt !== purchase.expiresAt) throw new UsTestBillingError('session_mismatch', 422);
  Object.freeze(value); sessions.add(value); return value;
}
export function assertUsTestSession(value: UsTestSession): void {
  if (!value || !sessions.has(value)) throw new UsTestBillingError('unverified_session', 422);
}
/** A price check alone is never sufficient to call this private payment factory. */
export function verifiedUsTestPaidProof(purchase: UsTestPurchase, fields: UsTestPaidProof): UsTestPaidProof {
  const value = snapshotPrivateJson(fields) as UsTestPaidProof;
  exact(value, ['purchaseId','sessionId','customerId','subscriptionId','invoiceId','eventId','providerAccountId','authority','serverPrice','verifiedAt']);
  exact(value.serverPrice, ['id','active','livemode','currency','unit_amount','type','tax_behavior','recurring','product']);
  if (!value.serverPrice.recurring || !value.serverPrice.product || typeof value.serverPrice.product === 'string') throw new UsTestBillingError('payment_mismatch', 422);
  exact(value.serverPrice.recurring, ['interval','interval_count','usage_type']);
  if (Object.keys(value.serverPrice.product).some(field => !['id','active','deleted'].includes(field))) throw new UsTestBillingError('payment_mismatch', 422);
  const authority = parseUsSubscriptionAuthority(value.authority);
  if (value.purchaseId !== purchase.purchaseId || value.providerAccountId !== purchase.providerAccountId || !/^cs_test_[A-Za-z0-9_]+$/.test(value.sessionId) || !/^cus_[A-Za-z0-9_]+$/.test(value.customerId) || !/^sub_[A-Za-z0-9_]+$/.test(value.subscriptionId) || !/^in_[A-Za-z0-9_]+$/.test(value.invoiceId) || !/^(evt_[A-Za-z0-9_]+|recovery)$/.test(value.eventId) || !instant(value.verifiedAt) || authority.organizationId !== purchase.organizationId || authority.subscriptionId !== value.subscriptionId || canonicalCreationJson(authority.offer) !== canonicalCreationJson(purchase.offer) || authority.status !== 'active' || authority.evidence?.kind !== 'verified_payment' || authority.evidence.referenceId !== value.invoiceId || authority.evidence.revoked || authority.evidence.environment !== 'TEST' || authority.evidence.organizationId !== purchase.organizationId || authority.evidence.subscriptionId !== value.subscriptionId || authority.evidence.priceId !== purchase.offer.priceId || authority.evidence.catalogVersion !== purchase.offer.catalogVersion || authority.evidence.currency !== 'USD' || authority.evidence.startsAt > value.verifiedAt || authority.evidence.endsAt <= value.verifiedAt) throw new UsTestBillingError('payment_mismatch', 422);
  verifyServerStripePrice(purchase.offer, value.serverPrice);
  Object.freeze(value); proofs.add(value); return value;
}
export function assertUsTestPaidProof(value: UsTestPaidProof): void {
  if (!value || !proofs.has(value)) throw new UsTestBillingError('unverified_payment', 422);
}
export function validatedUsTestCheckoutUrl(value: string | null): string | null {
  if (value === null) return null;
  try { const url = new URL(value); if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password || value.length > 4096) throw new Error('Invalid URL'); return url.href; }
  catch { throw new UsTestBillingError('session_mismatch', 503); }
}
