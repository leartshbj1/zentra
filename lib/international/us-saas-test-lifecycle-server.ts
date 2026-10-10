import { readTextBodyWithinLimit, RequestBodyError } from '../request-body';
import { canonicalCreationJson, WorkspaceCreationError, type WorkspaceCreationStore } from './workspace-creation';
import { snapshotPrivateJson } from './private-json';
import { UsAuthorityError } from './saas-authority';
import { SubscriptionContractError } from './subscriptions';
import { UsTestBillingError } from './us-saas-test-contract';
import { assertUsTestLifecycleObservation, validateUsTestLifecycleBinding, validateUsTestLifecycleLocator, type UsTestLifecycleBinding, type UsTestLifecycleGateway, type UsTestLifecycleObservation } from './us-saas-test-lifecycle-contract';
import type { UsTestBillingConfiguration } from './us-saas-test-server';

export interface UsTestLifecycleStore {
  bySubscription(this: void, subscriptionId: string): Promise<UsTestLifecycleBinding | null>;
  apply(this: void, binding: UsTestLifecycleBinding, observation: UsTestLifecycleObservation, revalidate: () => Promise<void>): Promise<'paid_period' | 'observed' | 'revoked' | 'replayed'>;
}
export interface UsTestLifecycleDependencies {
  enabled(this: void): boolean | Promise<boolean>;
  configuration(this: void): UsTestBillingConfiguration | Promise<UsTestBillingConfiguration>;
  gateway(this: void): UsTestLifecycleGateway | Promise<UsTestLifecycleGateway>;
  store(this: void): UsTestLifecycleStore | Promise<UsTestLifecycleStore>;
  creations(this: void): WorkspaceCreationStore | Promise<WorkspaceCreationStore>;
  verifyEvent(this: void, rawBody: string, signature: string): Promise<unknown>;
  now(this: void): number;
  diagnostic(this: void, value: { operation: string; code: string; status: number }): void;
}
const responseHeaders = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: responseHeaders });
function configIdentity(value: UsTestBillingConfiguration): string { return canonicalCreationJson({ environment: value.policy.environment, catalog: value.policy.catalog, providerAccountId: value.providerAccountId, siteOrigin: value.siteOrigin }); }
export function createUsTestLifecycleHandlers(dependencies: UsTestLifecycleDependencies) {
  async function configuration(request: Request): Promise<UsTestBillingConfiguration> {
    if (!await dependencies.enabled()) throw new UsTestBillingError('feature_unavailable', 404);
    const value = snapshotPrivateJson(await dependencies.configuration()) as UsTestBillingConfiguration;
    if (value.policy.environment !== 'TEST' || !/^acct_[A-Za-z0-9]+$/.test(value.providerAccountId) || new URL(request.url).origin !== value.siteOrigin) throw new UsTestBillingError('service_unavailable', 503);
    return value;
  }
  /** Internal composition boundary: the caller MUST have verified the signature
   * with the dedicated SaaS TEST account/version. Not a public JSON endpoint. */
  async function process(request: Request, verifiedEvent: unknown) {
    const config = await configuration(request);
    const gateway = await dependencies.gateway(), located = await gateway.locate(verifiedEvent);
    if (!located) return null;
    const locator = validateUsTestLifecycleLocator(located), store = await dependencies.store();
    const originalBinding = await store.bySubscription(locator.subscriptionId);
    if (!originalBinding) return null;
    const binding = validateUsTestLifecycleBinding(originalBinding), purchase = binding.purchase;
    if (purchase.providerAccountId !== config.providerAccountId || purchase.siteOrigin !== config.siteOrigin || binding.subscriptionId !== locator.subscriptionId) throw new UsTestBillingError('lifecycle_mismatch', 422);
    const creations = await dependencies.creations();
    const revalidate = async () => {
      if (configIdentity(await configuration(request)) !== configIdentity(config)) throw new UsTestBillingError('configuration_changed', 409);
      const current = await store.bySubscription(locator.subscriptionId);
      if (!current || canonicalCreationJson(current) !== canonicalCreationJson(binding)) throw new UsTestBillingError('binding_changed', 409);
      const intent = await creations.find(purchase.actorUserId, purchase.requestId);
      if (!intent || intent.state !== 'ready' || intent.creationId !== purchase.creationId || intent.organizationId !== purchase.organizationId || intent.actorUserId !== purchase.actorUserId || intent.ownSubscriptionId !== binding.subscriptionId || intent.fingerprint !== purchase.configurationFingerprint || canonicalCreationJson(intent.receipt) !== canonicalCreationJson(purchase.receipt)) throw new UsTestBillingError('creation_changed', 409);
    };
    await revalidate();
    const observation = await gateway.observe(binding, locator);
    assertUsTestLifecycleObservation(observation);
    if (canonicalCreationJson({ eventId: observation.eventId, subscriptionId: observation.subscriptionId, sourceType: observation.sourceType, sourceId: observation.sourceId }) !== canonicalCreationJson(locator) || observation.purchaseId !== purchase.purchaseId || observation.organizationId !== purchase.organizationId || observation.customerId !== binding.customerId || observation.providerAccountId !== purchase.providerAccountId) throw new UsTestBillingError('lifecycle_mismatch', 422);
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || observation.observedAt > now || observation.observedAt < now - 60) throw new UsTestBillingError('observation_stale', 409);
    // Revocation does not require the old Price to remain active/in catalogue.
    if (observation.action === 'paid_period' && !config.policy.catalog.some(entry => entry.seatLimit === purchase.seatLimit && canonicalCreationJson(entry.offer) === canonicalCreationJson(purchase.offer))) throw new UsTestBillingError('offer_unavailable', 409);
    await revalidate();
    const disposition = await store.apply(binding, observation, revalidate);
    await revalidate();
    return { received: true as const, disposition };
  }
  function failure(error: unknown) {
    let code = 'service_unavailable', status = 503;
    if (error instanceof UsTestBillingError || error instanceof WorkspaceCreationError || error instanceof RequestBodyError || error instanceof UsAuthorityError) { status = error.status; code = error instanceof RequestBodyError ? 'invalid_request' : error.code; }
    else if (error instanceof SubscriptionContractError) { code = 'offer_unavailable'; status = 409; }
    try { dependencies.diagnostic({ operation: 'lifecycle_webhook', code, status }); } catch { /* Logging never grants or leaks provider objects. */ }
    return json({ error: code }, status);
  }
  return {
    PROCESS: process,
    async WEBHOOK(this: void, request: Request): Promise<Response> {
      try {
        await configuration(request);
        if (request.headers.has('Authorization')) throw new UsTestBillingError('invalid_event', 400);
        const signature = request.headers.get('Stripe-Signature');
        if (!signature || signature.length > 4096) throw new UsTestBillingError('invalid_signature', 400);
        const event = await dependencies.verifyEvent(await readTextBodyWithinLimit(request, 1_048_576), signature);
        return json(await process(request, event) ?? { received: true, disposition: 'ignored' });
      } catch (error) { return failure(error); }
    },
  };
}
