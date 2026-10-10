import { canonicalCreationJson } from './workspace-creation';
import { snapshotPrivateJson } from './private-json';
import { UsTestBillingError, validateUsTestPurchase, verifiedUsTestPaidProof, type UsTestPurchase, type UsTestSession } from './us-saas-test-contract';
import type { SaasSubscriptionAuthority, ServerStripePrice } from './subscriptions';

/** Persisted admission identity, not an entitlement obtained from metadata. */
export interface UsTestLifecycleBinding {
  readonly purchase: UsTestPurchase;
  readonly session: UsTestSession;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly initialInvoiceId: string;
}
export interface UsTestLifecycleLocator {
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly sourceType: 'invoice' | 'subscription' | 'charge' | 'dispute';
  readonly sourceId: string;
}
export interface UsTestLifecycleObservation extends UsTestLifecycleLocator {
  readonly purchaseId: string;
  readonly organizationId: string;
  readonly customerId: string;
  readonly providerAccountId: string;
  readonly observedAt: number;
  readonly action: 'paid_period' | 'observe' | 'revoke';
  readonly reason: 'paid' | 'payment_pending' | 'canceled_paid_through' | 'refunded' | 'disputed' | 'restricted';
  readonly invoiceId: string | null;
  readonly authority: SaasSubscriptionAuthority | null;
  readonly serverPrice: ServerStripePrice | null;
}
export interface UsTestLifecycleGateway {
  /** Called only after signature verification; ownership is resolved in storage. */
  locate(this: void, event: unknown): Promise<UsTestLifecycleLocator | null>;
  /** Re-read provider resources. An event body is never a payment proof. */
  observe(this: void, binding: UsTestLifecycleBinding, locator: UsTestLifecycleLocator): Promise<UsTestLifecycleObservation>;
}
const observations = new WeakSet<object>();
const prefixes = { invoice: 'in', subscription: 'sub', charge: 'ch', dispute: 'dp' } as const;
function validId(value: unknown, prefix: string): boolean { return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value) && value.length <= 128; }
function fail(): never { throw new UsTestBillingError('lifecycle_mismatch', 422); }
function exact(value: object, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || Object.keys(value).some(field => !fields.includes(field))) fail(); }
export function validateUsTestLifecycleLocator(input: UsTestLifecycleLocator): UsTestLifecycleLocator {
  const value = snapshotPrivateJson(input) as UsTestLifecycleLocator;
  exact(value, ['eventId', 'subscriptionId', 'sourceType', 'sourceId']);
  if (!validId(value.eventId, 'evt') || !validId(value.subscriptionId, 'sub') || !Object.hasOwn(prefixes, value.sourceType) || !validId(value.sourceId, prefixes[value.sourceType])) fail();
  return Object.freeze(value);
}
export function validateUsTestLifecycleBinding(input: UsTestLifecycleBinding): UsTestLifecycleBinding {
  const value = snapshotPrivateJson(input) as UsTestLifecycleBinding;
  exact(value, ['purchase', 'session', 'customerId', 'subscriptionId', 'initialInvoiceId']);
  const purchase = validateUsTestPurchase(value.purchase), session = value.session;
  exact(session, ['purchaseId', 'sessionId', 'customerId', 'subscriptionId', 'createdAt', 'expiresAt']);
  if (!validId(value.customerId, 'cus') || !validId(value.subscriptionId, 'sub') || !validId(value.initialInvoiceId, 'in') || !validId(session.sessionId, 'cs_test') || session.purchaseId !== purchase.purchaseId || session.expiresAt !== purchase.expiresAt || !Number.isSafeInteger(session.createdAt) || session.createdAt < purchase.createdAt || session.createdAt >= purchase.expiresAt || (session.customerId !== null && session.customerId !== value.customerId) || (session.subscriptionId !== null && session.subscriptionId !== value.subscriptionId)) fail();
  return Object.freeze(value);
}
/** Private server factory. Price validation alone never authorizes this call. */
export function verifiedUsTestLifecycleObservation(input: UsTestLifecycleBinding, fields: UsTestLifecycleObservation): UsTestLifecycleObservation {
  const binding = validateUsTestLifecycleBinding(input), value = snapshotPrivateJson(fields) as UsTestLifecycleObservation;
  exact(value, ['eventId', 'subscriptionId', 'sourceType', 'sourceId', 'purchaseId', 'organizationId', 'customerId', 'providerAccountId', 'observedAt', 'action', 'reason', 'invoiceId', 'authority', 'serverPrice']);
  validateUsTestLifecycleLocator({ eventId: value.eventId, subscriptionId: value.subscriptionId, sourceType: value.sourceType, sourceId: value.sourceId });
  const { purchase, session } = binding;
  if (value.purchaseId !== purchase.purchaseId || value.organizationId !== purchase.organizationId || value.customerId !== binding.customerId || value.subscriptionId !== binding.subscriptionId || value.providerAccountId !== purchase.providerAccountId || !Number.isSafeInteger(value.observedAt) || value.observedAt < purchase.createdAt || (value.invoiceId !== null && !validId(value.invoiceId, 'in'))) fail();
  if (value.action === 'paid_period') {
    if (value.reason !== 'paid' || value.invoiceId === null || value.authority === null || value.serverPrice === null) fail();
    verifiedUsTestPaidProof(purchase, { purchaseId: purchase.purchaseId, sessionId: session.sessionId, customerId: binding.customerId, subscriptionId: binding.subscriptionId, invoiceId: value.invoiceId, eventId: value.eventId, providerAccountId: purchase.providerAccountId, authority: value.authority, serverPrice: value.serverPrice, verifiedAt: value.observedAt });
    if (value.authority.evidence!.startsAt < purchase.createdAt) fail();
  } else {
    if (value.authority !== null || value.serverPrice !== null) fail();
    if (value.action === 'observe' ? !['payment_pending', 'canceled_paid_through'].includes(value.reason) : value.action === 'revoke' ? !['refunded', 'disputed', 'restricted'].includes(value.reason) || value.invoiceId === null : true) fail();
  }
  Object.freeze(value); observations.add(value); return value;
}
export function assertUsTestLifecycleObservation(value: UsTestLifecycleObservation): void { if (!value || !observations.has(value)) throw new UsTestBillingError('unverified_lifecycle', 422); }
/** Event retries preserve the first observation time; a newly observed risk on
 * the same event is a different fact, so replay never masks a refund/dispute. */
export function usTestLifecycleMaterial(value: UsTestLifecycleObservation): string {
  const { observedAt: _observedAt, ...material } = value;
  return canonicalCreationJson(material);
}
