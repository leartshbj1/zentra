import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, readTextBodyWithinLimit, RequestBodyError } from '../request-body';
import { snapshotPrivateJson } from './private-json';
import { prepareUsAuthorityAdmission, UsAuthorityError, type UsSaasPolicy, type UsAuthorityAdmission } from './saas-authority';
import { resolveSubscriptionOffer, SubscriptionContractError } from './subscriptions';
import { canonicalCreationJson, creationUuid, publicWorkspaceCreation, WorkspaceCreationError, type WorkspaceCreationIntent, type WorkspaceCreationStore } from './workspace-creation';
import { UsTestBillingError, validateUsTestPurchase, validatedUsTestCheckoutUrl, assertUsTestSession, assertUsTestPaidProof, type UsTestPurchase, type UsTestSession, type UsTestPaidProof, type UsTestGateway } from './us-saas-test-contract';
import type { UsTestPublicState } from './us-saas-test-public';

export interface UsTestBillingConfiguration {
  readonly policy: UsSaasPolicy;
  readonly providerAccountId: string;
  readonly siteOrigin: string;
}
export interface UsTestPurchaseStore {
  find(this: void, actorUserId: string, requestId: string): Promise<UsTestPurchase | null>;
  bySession(this: void, sessionId: string): Promise<UsTestPurchase | null>;
  reserve(this: void, intent: WorkspaceCreationIntent, purchase: UsTestPurchase, revalidate: () => Promise<void>): Promise<UsTestPurchase>;
  bind(this: void, purchase: UsTestPurchase, session: UsTestSession, revalidate: () => Promise<void>): Promise<UsTestSession>;
  session(this: void, purchaseId: string): Promise<UsTestSession | null>;
  admit(this: void, intent: WorkspaceCreationIntent, purchase: UsTestPurchase, session: UsTestSession, proof: UsTestPaidProof, candidate: UsAuthorityAdmission, revalidate: () => Promise<void>): Promise<WorkspaceCreationIntent>;
}
export interface UsTestBillingDependencies {
  enabled(this: void): boolean | Promise<boolean>;
  configuration(this: void): UsTestBillingConfiguration | Promise<UsTestBillingConfiguration>;
  user(this: void): Promise<{ userId: string } | null>;
  creations(this: void): WorkspaceCreationStore | Promise<WorkspaceCreationStore>;
  purchases(this: void): UsTestPurchaseStore | Promise<UsTestPurchaseStore>;
  gateway(this: void): UsTestGateway | Promise<UsTestGateway>;
  confirmCreation(this: void, intent: WorkspaceCreationIntent, revalidate: () => Promise<void>): Promise<WorkspaceCreationIntent>;
  verifyEvent(this: void, rawBody: string, signature: string): Promise<unknown>;
  rateLimit(this: void, request: Request, userId: string, operation: 'read' | 'checkout' | 'recover'): Promise<void>;
  now(this: void): number;
  allocateId(this: void): string;
  integrationIdentifier(this: void): string;
  diagnostic(this: void, event: { operation: string; code: string; status: number }): void;
}
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function contract(config: UsTestBillingConfiguration): string {
  return canonicalCreationJson({ policy: { environment: config.policy.environment, catalog: config.policy.catalog }, providerAccountId: config.providerAccountId, siteOrigin: config.siteOrigin });
}
function exactBody(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key))) throw new UsTestBillingError('invalid_request', 422);
}
export function createUsTestBillingHandlers(dependencies: UsTestBillingDependencies) {
  async function currentConfiguration(request: Request) {
    if (!await dependencies.enabled()) throw new UsTestBillingError('feature_unavailable', 404);
    const config = snapshotPrivateJson(await dependencies.configuration()) as UsTestBillingConfiguration;
    if (config.policy.environment !== 'TEST' || new URL(request.url).origin !== config.siteOrigin || !/^acct_[A-Za-z0-9]+$/.test(config.providerAccountId) || !Number.isSafeInteger(config.policy.now)) throw new UsTestBillingError('service_unavailable', 503);
    return config;
  }
  async function user(request: Request) {
    if (request.headers.has('Authorization')) throw new UsTestBillingError('browser_session_required', 401);
    const actor = await dependencies.user();
    if (!actor) throw new UsTestBillingError('unauthorized', 401);
    try { creationUuid(actor.userId); } catch { throw new UsTestBillingError('unauthorized', 401); }
    const expected = request.headers.get('X-Zentra-Expected-User');
    if (expected !== null && expected !== actor.userId) throw new UsTestBillingError('session_changed', 401);
    return actor;
  }
  async function owned(request: Request, requestId: string, operation: 'read' | 'checkout' | 'recover', rememberActor: (userId: string) => void) {
    const config = await currentConfiguration(request), actor = await user(request);
    rememberActor(actor.userId);
    await dependencies.rateLimit(request, actor.userId, operation);
    const creations = await dependencies.creations(), purchases = await dependencies.purchases();
    let intent = await creations.find(actor.userId, requestId);
    if (!intent) throw new UsTestBillingError('not_found', 404);
    if (intent.actorUserId !== actor.userId || intent.requestId !== requestId) throw new UsTestBillingError('service_unavailable', 503);
    const original = intent;
    const revalidate = async () => {
      const currentActor = await user(request);
      if (currentActor.userId !== actor.userId) throw new UsTestBillingError('session_changed', 401);
      const fresh = await currentConfiguration(request);
      if (contract(fresh) !== contract(config)) throw new UsTestBillingError('configuration_changed', 409);
      const stored = await creations.find(actor.userId, requestId);
      if (!stored || stored.creationId !== original.creationId || stored.organizationId !== original.organizationId || stored.fingerprint !== original.fingerprint || stored.companyName !== original.companyName || canonicalCreationJson(stored.configuration) !== canonicalCreationJson(original.configuration)) throw new UsTestBillingError('creation_changed', 409);
    };
    await revalidate();
    return { config, actor, creations, purchases, get intent() { return intent!; }, setIntent(value: WorkspaceCreationIntent) { intent = value; }, revalidate };
  }
  function publicState(intent: WorkspaceCreationIntent, config: UsTestBillingConfiguration, purchase: UsTestPurchase | null, checkoutUrl?: string | null): UsTestPublicState {
    return { workspace: publicWorkspaceCreation(intent), offers: config.policy.catalog.filter(entry => ['gestion', 'complet'].includes(entry.offer.module)).map(({ offer, seatLimit }) => ({ module: offer.module as 'gestion' | 'complet', plan: offer.plan, catalogVersion: offer.catalogVersion, amountMinor: offer.unitAmountMinor, currency: 'USD', interval: offer.interval, intervalCount: offer.intervalCount, seatLimit })), purchase: { state: intent.state === 'ready' ? 'ready' : purchase ? 'checkout_pending' : 'not_started', ...(purchase ? { expiresAt: purchase.expiresAt, module: purchase.offer.module as 'gestion' | 'complet', plan: purchase.offer.plan } : {}) }, ...(checkoutUrl === undefined ? {} : { checkoutUrl }) };
  }
  async function validatePurchaseContext(purchase: UsTestPurchase, intent: WorkspaceCreationIntent, config: UsTestBillingConfiguration) {
    validateUsTestPurchase(purchase, intent);
    const offer = resolveSubscriptionOffer(intent.configuration, { plan: purchase.offer.plan, module: purchase.offer.module, environment: 'TEST' }, config.policy.catalog.map(entry => entry.offer));
    if (purchase.providerAccountId !== config.providerAccountId || purchase.siteOrigin !== config.siteOrigin || canonicalCreationJson(offer) !== canonicalCreationJson(purchase.offer) || !config.policy.catalog.some(entry => entry.seatLimit === purchase.seatLimit && canonicalCreationJson(entry.offer) === canonicalCreationJson(offer))) throw new UsTestBillingError('configuration_changed', 409);
  }
  async function fulfill(intent: WorkspaceCreationIntent, purchase: UsTestPurchase, session: UsTestSession, config: UsTestBillingConfiguration, purchases: UsTestPurchaseStore, revalidate: () => Promise<void>, eventId: string) {
    await validatePurchaseContext(purchase, intent, config);
    await revalidate();
    const proof = await (await dependencies.gateway()).verify(purchase, session, eventId);
    assertUsTestPaidProof(proof);
    if (proof.sessionId !== session.sessionId || proof.purchaseId !== purchase.purchaseId || proof.providerAccountId !== purchase.providerAccountId) throw new UsTestBillingError('payment_mismatch', 422);
    await revalidate();
    const candidate = prepareUsAuthorityAdmission(intent, { authority: proof.authority, seatLimit: purchase.seatLimit }, { ...config.policy, now: dependencies.now() }, proof.serverPrice);
    const result = await purchases.admit(intent, purchase, session, proof, candidate, revalidate);
    await revalidate();
    return result;
  }
  function failure(error: unknown, operation: string) {
    let code = 'service_unavailable', status = 503;
    if (error instanceof UsTestBillingError || error instanceof WorkspaceCreationError) { code = error.code; status = error.status; }
    else if (error instanceof RequestBodyError) { code = 'invalid_request'; status = error.status; }
    else if (error instanceof AccountPublicError) { status = error.status; code = status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'forbidden'; }
    else if (error instanceof UsAuthorityError) { status = error.status === 422 ? 503 : error.status; code = error.status === 422 ? 'service_unavailable' : error.code; }
    else if (error instanceof SubscriptionContractError) { code = 'offer_unavailable'; status = 409; }
    try { dependencies.diagnostic({ operation, code, status }); } catch { /* Never change authorization or disclose submitted fields/provider errors. */ }
    return json({ error: code }, status);
  }
  async function browserFailure(error: unknown, request: Request, operation: string, actorUserId?: string) {
    // A failed provider/configuration await must not hide a concurrent account loss.
    // No retry or write is performed: the browser can clear its scoped draft on 401.
    if (actorUserId) {
      try {
        if ((await user(request)).userId !== actorUserId) throw new UsTestBillingError('session_changed', 401);
      } catch (authError) { return failure(authError, operation); }
    }
    return failure(error, operation);
  }
  return {
    async GET(this: void, request: Request): Promise<Response> {
      let actorUserId: string | undefined;
      try {
        const requestId = creationUuid(new URL(request.url).searchParams.get('requestId'));
        const context = await owned(request, requestId, 'read', value => { actorUserId = value; });
        const purchase = await context.purchases.find(context.actor.userId, requestId);
        if (purchase) await validatePurchaseContext(purchase, context.intent, context.config);
        await context.revalidate();
        return json(publicState(context.intent, context.config, purchase));
      } catch (error) { return browserFailure(error, request, 'read', actorUserId); }
    },
    async POST(this: void, request: Request): Promise<Response> {
      let actorUserId: string | undefined;
      try {
        requireAccountSameOrigin(request);
        const body = await readJsonObjectWithinLimit(request, 2048);
        exactBody(body, ['requestId', 'module', 'plan', 'confirmTest']);
        if (body.confirmTest !== true || !['gestion', 'complet'].includes(String(body.module)) || typeof body.plan !== 'string') throw new UsTestBillingError('invalid_request', 422);
        const context = await owned(request, creationUuid(body.requestId), 'checkout', value => { actorUserId = value; });
        if (context.intent.state === 'reserved') throw new UsTestBillingError('workspace_confirmation_required', 409);
        let purchase = await context.purchases.find(context.actor.userId, context.intent.requestId);
        if (context.intent.state === 'ready') { await context.revalidate(); return json(publicState(context.intent, context.config, purchase, null)); }
        const offer = resolveSubscriptionOffer(context.intent.configuration, { plan: body.plan, module: body.module as 'gestion' | 'complet', environment: 'TEST' }, context.config.policy.catalog.map(entry => entry.offer));
        const entry = context.config.policy.catalog.find(entry => canonicalCreationJson(entry.offer) === canonicalCreationJson(offer));
        if (!entry) throw new UsTestBillingError('offer_unavailable', 409);
        if (purchase && (canonicalCreationJson(purchase.offer) !== canonicalCreationJson(offer) || purchase.seatLimit !== entry.seatLimit)) throw new UsTestBillingError('purchase_conflict', 409);
        if (!purchase) {
          const now = dependencies.now();
          purchase = await context.purchases.reserve(context.intent, validateUsTestPurchase({ purchaseId: dependencies.allocateId(), creationId: context.intent.creationId, organizationId: context.intent.organizationId, actorUserId: context.actor.userId, requestId: context.intent.requestId, configurationFingerprint: context.intent.fingerprint, receipt: context.intent.receipt!, offer, seatLimit: entry.seatLimit, providerAccountId: context.config.providerAccountId, siteOrigin: context.config.siteOrigin, integrationIdentifier: dependencies.integrationIdentifier(), createdAt: now, expiresAt: now + 3600 }, context.intent), context.revalidate);
        }
        await validatePurchaseContext(purchase, context.intent, context.config);
        await context.revalidate();
        const checkout = await (await dependencies.gateway()).create(purchase);
        assertUsTestSession(checkout.session);
        await context.revalidate();
        await context.purchases.bind(purchase, checkout.session, context.revalidate);
        await context.revalidate();
        return json(publicState(context.intent, context.config, purchase, validatedUsTestCheckoutUrl(checkout.url)));
      } catch (error) { return browserFailure(error, request, 'checkout', actorUserId); }
    },
    async RECOVER(this: void, request: Request): Promise<Response> {
      let actorUserId: string | undefined;
      try {
        requireAccountSameOrigin(request);
        const body = await readJsonObjectWithinLimit(request, 1024); exactBody(body, ['requestId']);
        const context = await owned(request, creationUuid(body.requestId), 'recover', value => { actorUserId = value; });
        if (context.intent.state === 'reserved') {
          context.setIntent(await dependencies.confirmCreation(context.intent, context.revalidate));
          await context.revalidate();
        }
        const purchase = await context.purchases.find(context.actor.userId, context.intent.requestId);
        if (!purchase) { await context.revalidate(); return json(publicState(context.intent, context.config, null, null)); }
        await validatePurchaseContext(purchase, context.intent, context.config);
        let session = await context.purchases.session(purchase.purchaseId);
        if (!session) {
          const checkout = await (await dependencies.gateway()).create(purchase);
          assertUsTestSession(checkout.session); await context.revalidate();
          session = await context.purchases.bind(purchase, checkout.session, context.revalidate);
        }
        const ready = await fulfill(context.intent, purchase, session, context.config, context.purchases, context.revalidate, 'recovery');
        return json(publicState(ready, context.config, purchase, null));
      } catch (error) { return browserFailure(error, request, 'recover', actorUserId); }
    },
    async WEBHOOK(this: void, request: Request): Promise<Response> {
      try {
        const config = await currentConfiguration(request);
        if (request.headers.has('Authorization')) throw new UsTestBillingError('invalid_event', 400);
        const signature = request.headers.get('Stripe-Signature');
        if (!signature || signature.length > 4096) throw new UsTestBillingError('invalid_signature', 400);
        const event = await dependencies.verifyEvent(await readTextBodyWithinLimit(request, 1_048_576), signature);
        const locator = await (await dependencies.gateway()).locate(event);
        if (!locator) return json({ received: true, disposition: 'ignored' });
        const purchases = await dependencies.purchases(), creations = await dependencies.creations();
        const purchase = await purchases.bySession(locator.sessionId);
        // A create response can be lost, or the webhook can beat the session binding.
        // The provider must retry; metadata and return URLs never confer ownership.
        if (!purchase) throw new UsTestBillingError('binding_pending', 503);
        const intent = await creations.find(purchase.actorUserId, purchase.requestId);
        if (!intent) throw new UsTestBillingError('creation_changed', 409);
        const revalidate = async () => {
          const fresh = await currentConfiguration(request);
          if (contract(fresh) !== contract(config)) throw new UsTestBillingError('configuration_changed', 409);
          const current = await creations.find(purchase.actorUserId, purchase.requestId);
          if (!current || current.creationId !== intent.creationId || current.organizationId !== intent.organizationId || current.fingerprint !== intent.fingerprint || canonicalCreationJson(current.receipt) !== canonicalCreationJson(intent.receipt)) throw new UsTestBillingError('creation_changed', 409);
        };
        const session = await purchases.session(purchase.purchaseId);
        if (!session || session.sessionId !== locator.sessionId) throw new UsTestBillingError('binding_pending', 503);
        await fulfill(intent, purchase, session, config, purchases, revalidate, locator.eventId);
        return json({ received: true, disposition: 'admitted' });
      } catch (error) { return failure(error, 'webhook'); }
    },
  };
}
