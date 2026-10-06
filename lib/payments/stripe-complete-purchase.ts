import { digest } from '@/lib/support/crypto';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { database, runtimeValue } from '@/lib/runtime';
import { PublicError, randomBase64Url, sha256 } from '@/lib/stripe';
import { currentSiteLanguage } from '@/lib/site-language-server';
import { buildZentraCheckoutParams } from '@/lib/stripe-checkout';
import { stripeReferenceId, stripeSecretKeyLivemode } from '@/lib/stripe-event';
import { automationStripe } from '@/lib/automation/billing';
import { ensureCompletePrice, validCompletePrice } from '@/lib/complete/stripe';
import {
  COMPLETE_PRODUCT,
  COMPLETE_TERMS_VERSION,
  completePlan,
  type CompletePlan,
} from '@/lib/complete/plans';
import {
  D1PurchaseIntents,
  PurchaseIntentError,
  type PurchaseIntent,
} from './purchase-intents';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export const STRIPE_COMPLETE_CATALOG_VERSION = 'zentra-complet-monthly-v1';
export type StripeCompleteConfiguration = {
  secretKey: string;
  livemode: boolean;
};
export type StripeCompleteTransport = {
  price(plan: CompletePlan): Promise<Stripe.Price>;
  create(
    parameters: Stripe.Checkout.SessionCreateParams,
    key: string,
  ): Promise<Stripe.Checkout.Session>;
  retrieve(id: string): Promise<Stripe.Checkout.Session>;
  list(
    from: number,
    until: number,
  ): Promise<{ data: Stripe.Checkout.Session[]; has_more: boolean }>;
  expire(id: string): Promise<Stripe.Checkout.Session>;
};
export type StripeCompletePurchaseInput = {
  user: ZentraUser;
  plan: CompletePlan;
  origin: string;
  automaticTax: boolean;
  organizationId?: unknown;
};
export type StripeCompleteTarget = {
  organization_id: string;
  subscription_id: string;
  created_by_user_id: string;
  workspace_id: string;
  trial_subscription_id: string | null;
};
export type StripeCompleteRequest = {
  request_id: string;
  owner_id: string;
  organization_id: string;
  workspace_id: string;
  previous_subscription_id: string;
  trial_subscription_id: string | null;
  environment: 'TEST' | 'PRODUCTION';
  provider_scope: string;
  plan_id: string;
  account_email: string;
  account_name: string;
  origin: string;
  legal_version: string;
  catalog_json: string;
  claim_hash: string;
  parameters_json: string;
  intent_id: string | null;
  session_id: string | null;
  session_url: string | null;
  subscription_id: string | null;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
};
export function stripeCompleteCatalog(plan: CompletePlan, priceId: string) {
  return {
    version: STRIPE_COMPLETE_CATALOG_VERSION,
    planId: plan.id,
    priceId,
    productId: plan.productId,
    lookupKey: plan.lookupKey,
    priceChfCents: plan.priceChfCents,
    gestionPlanId: plan.gestion,
    licensePlan: plan.licensePlan,
    seats: plan.seats,
    supportPlanId: plan.support,
    analyses: plan.analyses,
    includedProducts: ['gestion', 'support', 'automation'],
  };
}
const conflict = (
  message = 'Un paiement Complet est déjà préparé. Reprenez-le ou annulez-le avant de choisir une autre offre.',
) => new PublicError(message, 409);
const uncertain = () =>
  conflict(
    'Ce paiement doit être vérifié. Aucun second paiement ne sera créé.',
  );

/** Server-only preparation and receipt binding. No session or local reservation
 * grants an entitlement. An unknown merchant result never expires locally. */
export class D1StripeCompletePurchase {
  constructor(
    private readonly db: Database,
    private readonly configuration: StripeCompleteConfiguration,
    private readonly transport: StripeCompleteTransport,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  private environment() {
    const live = stripeSecretKeyLivemode(this.configuration.secretKey);
    if (live === null || live !== this.configuration.livemode)
      throw new PublicError('Le paiement doit être configuré.', 503);
    return live ? ('PRODUCTION' as const) : ('TEST' as const);
  }
  private scope() {
    return sha256(this.configuration.secretKey).then((v) => 'stripe_key_' + v);
  }
  private current(ownerId: string, environment: string) {
    return this.db
      .prepare(
        'SELECT * FROM stripe_complete_purchase_requests WHERE owner_id=? AND environment=? AND closed_at IS NULL',
      )
      .bind(ownerId, environment)
      .first<StripeCompleteRequest>();
  }
  private async owned(id: string, user: ZentraUser) {
    const row = await this.db
      .prepare(`SELECT o.organization_id,o.subscription_id,o.created_by_user_id FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
      WHERE o.organization_id=? AND o.created_by_user_id=? AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM account_session_policy a WHERE a.user_id=? AND a.deleted_at IS NOT NULL)`)
      .bind(id, user.userId, user.userId, user.userId)
      .first<{
        organization_id: string;
        subscription_id: string;
        created_by_user_id: string;
      }>();
    if (!row)
      throw new PublicError(
        'Seul le propriétaire peut choisir cette entreprise.',
        403,
      );
    return row;
  }
  private async draft(user: ZentraUser, environment: string) {
    const now = this.clock();
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO stripe_complete_purchase_drafts(owner_id,environment,organization_id,original_subscription_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,environment) DO NOTHING',
        )
        .bind(
          user.userId,
          environment,
          'org_' + crypto.randomUUID(),
          'draft_' + crypto.randomUUID(),
          now,
        ),
      this.db
        .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,seat_limit)
        SELECT original_subscription_id,original_subscription_id,'draft-no-paid-price','incomplete',0,?,?,1 FROM stripe_complete_purchase_drafts WHERE owner_id=? AND environment=? ON CONFLICT(subscription_id) DO NOTHING`)
        .bind(
          Number(environment === 'PRODUCTION'),
          now,
          user.userId,
          environment,
        ),
      this.db
        .prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
        SELECT organization_id,'Mon entreprise',original_subscription_id,owner_id,?,? FROM stripe_complete_purchase_drafts WHERE owner_id=? AND environment=? ON CONFLICT(organization_id) DO NOTHING`)
        .bind(now, now, user.userId, environment),
      this.db
        .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
        SELECT ?,d.organization_id,d.owner_id,?,?,'owner',? FROM stripe_complete_purchase_drafts d JOIN organizations o ON o.organization_id=d.organization_id AND o.created_by_user_id=d.owner_id WHERE d.owner_id=? AND d.environment=? ON CONFLICT(organization_id,user_id) DO NOTHING`)
        .bind(
          'mem_' + crypto.randomUUID(),
          user.email.toLowerCase(),
          user.displayName,
          now,
          user.userId,
          environment,
        ),
    ]);
    const row = await this.db
      .prepare(
        'SELECT organization_id FROM stripe_complete_purchase_drafts WHERE owner_id=? AND environment=?',
      )
      .bind(user.userId, environment)
      .first<{ organization_id: string }>();
    if (!row) throw conflict();
    return this.owned(row.organization_id, user);
  }
  private async target(
    input: StripeCompletePurchaseInput,
    environment: string,
    current: StripeCompleteRequest | null,
  ): Promise<StripeCompleteTarget> {
    let organization;
    if (input.organizationId !== undefined && input.organizationId !== null) {
      if (
        typeof input.organizationId !== 'string' ||
        input.organizationId.length < 1 ||
        input.organizationId.length > 180
      )
        throw new PublicError('Choisissez une entreprise.');
      organization = await this.owned(input.organizationId, input.user);
    } else if (current)
      organization = await this.owned(current.organization_id, input.user);
    else {
      const candidates = await this.db
        .prepare(`SELECT o.organization_id FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
        WHERE o.created_by_user_id=? AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL ORDER BY o.created_at,o.organization_id LIMIT 2`)
        .bind(input.user.userId, input.user.userId)
        .all<{ organization_id: string }>();
      if (candidates.results.length > 1)
        throw conflict(
          'Vous avez plusieurs entreprises. Choisissez celle à utiliser avant de payer.',
        );
      organization = candidates.results[0]
        ? await this.owned(candidates.results[0].organization_id, input.user)
        : await this.draft(input.user, environment);
    }
    await this.db
      .prepare(
        `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) SELECT ?,created_by_user_id,name,?,? FROM organizations WHERE organization_id=? AND created_by_user_id=? ON CONFLICT(owner_id) DO NOTHING`,
      )
      .bind(
        'support_' + crypto.randomUUID(),
        this.clock(),
        this.clock(),
        organization.organization_id,
        input.user.userId,
      )
      .run();
    const workspace = await this.db
      .prepare('SELECT id FROM support_workspaces WHERE owner_id=?')
      .bind(input.user.userId)
      .first<{ id: string }>();
    if (!workspace) throw conflict();
    const links = await this.db
      .prepare(
        'SELECT workspace_id,organization_id FROM support_gestion_links WHERE workspace_id=? OR organization_id=?',
      )
      .bind(workspace.id, organization.organization_id)
      .all<{ workspace_id: string; organization_id: string }>();
    if (
      links.results.some(
        (l) =>
          l.workspace_id !== workspace.id ||
          l.organization_id !== organization.organization_id,
      )
    )
      throw conflict(
        'Support est déjà relié à une autre entreprise. Aucun espace ni aucune donnée ne sera déplacé.',
      );
    const trial = await this.db
      .prepare(
        'SELECT subscription_id FROM account_trials WHERE user_id=? AND organization_id=? AND subscription_id=? AND converted_subscription_id IS NULL',
      )
      .bind(
        input.user.userId,
        organization.organization_id,
        organization.subscription_id,
      )
      .first<{ subscription_id: string }>();
    return {
      ...organization,
      workspace_id: workspace.id,
      trial_subscription_id: trial?.subscription_id ?? null,
    };
  }
  private validateRequest(
    row: StripeCompleteRequest,
    target: StripeCompleteTarget,
    scope: string,
    input?: StripeCompletePurchaseInput,
  ) {
    if (
      row.owner_id !== target.created_by_user_id ||
      row.organization_id !== target.organization_id ||
      row.workspace_id !== target.workspace_id ||
      row.previous_subscription_id !== target.subscription_id ||
      row.trial_subscription_id !== target.trial_subscription_id ||
      row.provider_scope !== scope ||
      (input &&
        (row.plan_id !== input.plan.id ||
          row.origin !== input.origin ||
          row.legal_version !== COMPLETE_TERMS_VERSION ||
          JSON.parse(row.parameters_json).automatic_tax?.enabled !==
            input.automaticTax))
    )
      throw conflict();
  }
  private validateSession(
    row: StripeCompleteRequest,
    session: Stripe.Checkout.Session,
  ) {
    const params = JSON.parse(
      row.parameters_json,
    ) as Stripe.Checkout.SessionCreateParams;
    if (
      !/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(session.id) ||
      session.mode !== 'subscription' ||
      session.livemode !== (row.environment === 'PRODUCTION') ||
      session.client_reference_id !== row.claim_hash ||
      session.expires_at !== row.expires_at ||
      session.metadata?.complete_request_id !== row.request_id ||
      session.metadata.account_user_id !== row.owner_id ||
      session.metadata.organization_id !== row.organization_id ||
      session.metadata.workspace_id !== row.workspace_id ||
      session.metadata.activation_claim_hash !== row.claim_hash ||
      session.metadata.service !== COMPLETE_PRODUCT ||
      session.metadata.bundle_plan !== row.plan_id ||
      session.metadata.plan !== params.metadata?.plan ||
      session.metadata.price_id !== params.line_items?.[0]?.price ||
      (row.session_id !== null && row.session_id !== session.id)
    )
      throw new PublicError(
        'Ce paiement ne correspond pas à votre entreprise.',
        403,
      );
  }
  private async intent(row: StripeCompleteRequest) {
    const intent = await new D1PurchaseIntents(this.db, this.clock).reserve({
      ownerId: row.owner_id,
      environment: row.environment,
      provider: 'stripe',
      providerScope: row.provider_scope,
      product: 'complete',
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      planId: row.plan_id,
      parameters: {
        requestId: row.request_id,
        previousSubscriptionId: row.previous_subscription_id,
        trialSubscriptionId: row.trial_subscription_id,
        catalog: JSON.parse(row.catalog_json),
        stripeParameters: JSON.parse(row.parameters_json),
      },
      terms: {
        version: row.legal_version,
        consentVersion: null,
        origin: row.origin,
      },
    });
    if (row.intent_id && row.intent_id !== intent.intentId) throw conflict();
    await this.db
      .prepare(
        'UPDATE stripe_complete_purchase_requests SET intent_id=? WHERE request_id=? AND (intent_id IS NULL OR intent_id=?)',
      )
      .bind(intent.intentId, row.request_id, intent.intentId)
      .run();
    return intent;
  }
  private async record(
    row: StripeCompleteRequest,
    intent: PurchaseIntent,
    session: Stripe.Checkout.Session,
  ) {
    this.validateSession(row, session);
    const subscription = stripeReferenceId(session.subscription);
    if (subscription && !/^sub_[A-Za-z0-9_]+$/.test(subscription))
      throw uncertain();
    await new D1PurchaseIntents(this.db, this.clock).bindProviderReference(
      intent,
      session.id,
    );
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE stripe_complete_purchase_requests SET session_id=?,session_url=coalesce(session_url,?),subscription_id=coalesce(subscription_id,?) WHERE request_id=? AND (session_id IS NULL OR session_id=?) AND (subscription_id IS NULL OR subscription_id IS ?)',
        )
        .bind(
          session.id,
          session.url ?? null,
          subscription || null,
          row.request_id,
          session.id,
          subscription || null,
        ),
      this.db
        .prepare(
          'INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at,account_user_id,account_email,account_name) VALUES(?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
        )
        .bind(
          row.claim_hash,
          session.id,
          row.created_at,
          row.created_at + 365 * 86400,
          row.owner_id,
          row.account_email,
          row.account_name,
        ),
      this.db
        .prepare(
          'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
        )
        .bind(
          crypto.randomUUID(),
          row.owner_id,
          row.legal_version,
          'complete_checkout_requested',
          row.plan_id,
          session.id,
          row.origin,
          new Date(row.created_at * 1000).toISOString(),
        ),
    ]);
  }
  private async recover(row: StripeCompleteRequest) {
    const list = await this.transport.list(
      row.created_at - 60,
      row.expires_at + 60,
    );
    const matches = list.data.filter(
      (s) => s.metadata?.complete_request_id === row.request_id,
    );
    if (list.has_more || matches.length !== 1) throw uncertain();
    this.validateSession(row, matches[0]);
    return matches[0];
  }
  private async expire(
    row: StripeCompleteRequest,
    intent: PurchaseIntent,
    session: Stripe.Checkout.Session,
  ) {
    this.validateSession(row, session);
    if (session.status === 'complete')
      throw conflict(
        'Ce paiement est terminé. Retrouvez votre abonnement dans votre compte.',
      );
    await this.record(row, intent, session);
    if (session.status === 'open') {
      try {
        session = await this.transport.expire(session.id);
      } catch {
        session = await this.transport.retrieve(session.id);
      }
      this.validateSession(row, session);
    }
    if (session.status !== 'expired') throw uncertain();
    const intents = new D1PurchaseIntents(this.db, this.clock);
    await intents.finalize(await intents.read(intent), {
      providerReference: session.id,
      outcome: 'expired',
      evidenceFingerprint: await digest(
        JSON.stringify([
          row.request_id,
          row.owner_id,
          row.organization_id,
          row.workspace_id,
          row.provider_scope,
          session.id,
          'expired',
        ]),
      ),
    });
  }
  private async legacy(user: ZentraUser) {
    const old = await this.db
      .prepare('SELECT * FROM complete_checkouts WHERE user_id=?')
      .bind(user.userId)
      .first<{
        nonce: string;
        plan_id: string;
        session_id: string | null;
        expires_at: number;
      }>();
    if (!old) return;
    let session: Stripe.Checkout.Session;
    if (old.session_id) session = await this.transport.retrieve(old.session_id);
    else {
      const list = await this.transport.list(
        old.expires_at - 3600 - 60,
        old.expires_at + 60,
      );
      const matching = list.data.filter(
        (s) =>
          s.metadata?.activation_claim_hash === old.nonce &&
          s.metadata.account_user_id === user.userId &&
          s.metadata.service === COMPLETE_PRODUCT,
      );
      if (list.has_more || matching.length !== 1) throw uncertain();
      session = matching[0];
    }
    const valid = () =>
      session.mode === 'subscription' &&
      session.livemode === (this.environment() === 'PRODUCTION') &&
      session.metadata?.account_user_id === user.userId &&
      session.metadata.activation_claim_hash === old.nonce &&
      session.metadata.service === COMPLETE_PRODUCT &&
      session.metadata.bundle_plan === old.plan_id &&
      (!old.session_id || session.id === old.session_id);
    if (!valid())
      throw new PublicError('Cet ancien paiement doit être vérifié.', 403);
    if (session.status === 'open') {
      try {
        session = await this.transport.expire(session.id);
      } catch {
        session = await this.transport.retrieve(session.id);
      }
      if (!valid()) throw uncertain();
    }
    if (session.status !== 'expired')
      throw conflict(
        'Un ancien paiement existe déjà. Retrouvez-le dans votre compte.',
      );
    // Receipt and legal acceptance remain in their historical tables.
    await this.db
      .prepare('DELETE FROM complete_checkouts WHERE user_id=? AND nonce=?')
      .bind(user.userId, old.nonce)
      .run();
  }
  async checkout(input: StripeCompletePurchaseInput) {
    if (
      !completePlan(input.plan.id) ||
      JSON.stringify(completePlan(input.plan.id)) !== JSON.stringify(input.plan)
    )
      throw new PublicError('Choisissez un pack Complet.');
    const environment = this.environment(),
      scope = await this.scope();
    let row = await this.current(input.user.userId, environment);
    if (!row) await this.legacy(input.user);
    const target = await this.target(input, environment, row);
    if (!row) {
      const price = await this.transport.price(input.plan);
      if (
        !price.active ||
        !validCompletePrice(price, input.plan, this.configuration.livemode)
      )
        throw new PublicError('Le tarif du pack doit être vérifié.', 503);
      const created = this.clock(),
        requestId = 'complete_' + crypto.randomUUID(),
        claim = await sha256(randomBase64Url());
      const params = buildZentraCheckoutParams({
        origin: input.origin,
        claimHash: claim,
        priceId: price.id,
        plan: input.plan.licensePlan,
        accountUserId: input.user.userId,
        accountEmail: input.user.email,
        automaticTax: input.automaticTax,
        locale: currentSiteLanguage(),
      });
      const binding = {
        service: COMPLETE_PRODUCT,
        bundle_plan: input.plan.id,
        complete_request_id: requestId,
        organization_id: target.organization_id,
        workspace_id: target.workspace_id,
        price_id: price.id,
        catalog_version: STRIPE_COMPLETE_CATALOG_VERSION,
      };
      params.metadata = { ...params.metadata, ...binding };
      params.subscription_data!.metadata = {
        ...params.subscription_data!.metadata,
        ...binding,
      };
      params.subscription_data!.description = `Zentra Complet ${input.plan.name} · Gestion, Support et Automation`;
      params.cancel_url = `${input.origin}/complet/abonnement?formule=${input.plan.id}&paiement=annule`;
      params.expires_at = created + 3600;
      try {
        await this.db
          .prepare(`INSERT INTO stripe_complete_purchase_requests(request_id,owner_id,organization_id,workspace_id,previous_subscription_id,trial_subscription_id,environment,provider_scope,plan_id,account_email,account_name,origin,legal_version,catalog_json,claim_hash,parameters_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(
            requestId,
            input.user.userId,
            target.organization_id,
            target.workspace_id,
            target.subscription_id,
            target.trial_subscription_id,
            environment,
            scope,
            input.plan.id,
            input.user.email,
            input.user.displayName,
            input.origin,
            COMPLETE_TERMS_VERSION,
            JSON.stringify(stripeCompleteCatalog(input.plan, price.id)),
            claim,
            JSON.stringify(params),
            created,
            created + 3600,
          )
          .run();
      } catch (error) {
        const winner = await this.current(input.user.userId, environment);
        if (!winner) throw error;
        this.validateRequest(winner, target, scope, input);
      }
      row = await this.current(input.user.userId, environment);
    }
    if (!row) throw conflict();
    this.validateRequest(row, target, scope, input);
    let intent: PurchaseIntent;
    try {
      intent = await this.intent(row);
    } catch (error) {
      if (error instanceof PurchaseIntentError)
        throw conflict(
          'Un abonnement ou un paiement existe déjà pour cette entreprise. Retrouvez-le dans votre compte.',
        );
      throw error;
    }
    if (!['reserved', 'dispatched', 'uncertain'].includes(intent.state))
      throw conflict();
    let session: Stripe.Checkout.Session;
    if (row.session_id || intent.providerReference)
      session = await this.transport.retrieve(
        row.session_id ?? intent.providerReference!,
      );
    else if (this.clock() >= row.expires_at - 1800)
      session = await this.recover(row);
    else {
      const intents = new D1PurchaseIntents(this.db, this.clock);
      intent = await intents.markDispatched(intent);
      try {
        session = await this.transport.create(
          JSON.parse(row.parameters_json),
          'zentra_complete_purchase_' + row.request_id,
        );
      } catch (error) {
        await intents.markUncertain(intent);
        throw error;
      }
    }
    await this.record(row, intent, session);
    if (session.status === 'expired') {
      await this.expire(row, intent, session);
      throw conflict(
        'Ce paiement a expiré. Annulez cette demande avant de recommencer.',
      );
    }
    if (session.status === 'complete')
      return { url: `${row.origin}/compte`, completedSessionId: session.id };
    if (session.status !== 'open' || !session.url)
      throw new PublicError('La page de paiement est indisponible.', 503);
    return { url: session.url };
  }
  async cancel(user: ZentraUser) {
    const row = await this.current(user.userId, this.environment());
    if (!row) {
      await this.legacy(user);
      return { cancelled: true as const };
    }
    const plan = completePlan(row.plan_id);
    if (!plan) throw uncertain();
    const target = await this.target(
      {
        user,
        plan,
        origin: row.origin,
        automaticTax: false,
        organizationId: row.organization_id,
      },
      row.environment,
      row,
    );
    this.validateRequest(row, target, await this.scope());
    const intents = new D1PurchaseIntents(this.db, this.clock);
    let intent = await this.intent(row);
    if (intent.state === 'reserved') await intents.releaseUndispatched(intent);
    else if (['dispatched', 'uncertain'].includes(intent.state)) {
      const session =
        row.session_id || intent.providerReference
          ? await this.transport.retrieve(
              row.session_id ?? intent.providerReference!,
            )
          : await this.recover(row);
      await this.expire(row, intent, session);
      intent = await intents.read(intent);
    } else if (!['released', 'expired', 'canceled'].includes(intent.state))
      throw conflict(
        'Ce paiement est terminé. Gérez votre abonnement depuis votre compte.',
      );
    await this.db
      .prepare(
        'UPDATE stripe_complete_purchase_requests SET closed_at=? WHERE request_id=? AND closed_at IS NULL',
      )
      .bind(this.clock(), row.request_id)
      .run();
    return { cancelled: true as const };
  }
}
export function stripeCompleteController() {
  const stripe = automationStripe(),
    secretKey = runtimeValue('STRIPE_SECRET_KEY'),
    live = stripeSecretKeyLivemode(secretKey);
  if (live === null)
    throw new PublicError('Le paiement doit être configuré.', 503);
  return new D1StripeCompletePurchase(
    database(),
    { secretKey, livemode: live },
    {
      price: ensureCompletePrice,
      create: (params, key) =>
        stripe.checkout.sessions.create(params, { idempotencyKey: key }),
      retrieve: (id) => stripe.checkout.sessions.retrieve(id),
      list: (from, until) =>
        stripe.checkout.sessions.list({
          created: { gte: from, lte: until },
          limit: 100,
        }),
      expire: (id) => stripe.checkout.sessions.expire(id),
    },
  );
}
