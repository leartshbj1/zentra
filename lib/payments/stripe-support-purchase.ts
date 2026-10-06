import Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { database, runtimeValue, stripeConfiguration } from '@/lib/runtime';
import { currentSiteLanguage } from '@/lib/site-language-server';
import { STRIPE_API_VERSION, PublicError, sha256 } from '@/lib/stripe';
import { stripeSecretKeyLivemode, stripeReferenceId } from '@/lib/stripe-event';
import { stripeTestAccessAllowed } from '@/lib/stripe-test-access';
import { digest } from '@/lib/support/crypto';
import {
  SUPPORT_LEGAL_VERSION,
  SUPPORT_PRODUCT,
  supportPlan,
  type SupportPlanId,
} from '@/lib/support/plans';
import { SupportError, type Workspace } from '@/lib/support/types';
import {
  D1PurchaseIntents,
  PurchaseIntentError,
  type PurchaseIntent,
} from './purchase-intents';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export type StripeSupportConfiguration = {
  secretKey: string;
  productId: string;
  prices: Record<SupportPlanId, string>;
  livemode: boolean;
};
export type StripeSupportTransport = {
  price(id: string): Promise<Stripe.Price>;
  create(
    parameters: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ): Promise<Stripe.Checkout.Session>;
  retrieve(id: string): Promise<Stripe.Checkout.Session>;
  list(
    from: number,
    until: number,
  ): Promise<{ data: Stripe.Checkout.Session[]; has_more: boolean }>;
  expire(id: string): Promise<Stripe.Checkout.Session>;
};
export type StripeSupportPurchaseInput = {
  user: ZentraUser;
  workspaceId: string;
  planId: SupportPlanId;
  origin: string;
  legalVersion: string;
};
type Target = { id: string; owner_id: string; organization_id: string | null };
type RequestRow = {
  request_id: string;
  workspace_id: string;
  organization_id: string | null;
  owner_id: string;
  environment: 'TEST' | 'PRODUCTION';
  provider_scope: string;
  plan_id: SupportPlanId;
  account_email: string;
  origin: string;
  legal_version: string;
  accepted_at: number;
  parameters_json: string;
  intent_id: string | null;
  session_id: string | null;
  session_url: string | null;
  subscription_id: string | null;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
};
type Legacy = {
  nonce: string;
  owner_id: string;
  plan_id: string;
  session_id: string | null;
  accepted_version: string;
  accepted_at: number;
};
const conflict = (
  message = 'Un paiement Support est déjà préparé. Reprenez-le ou annulez-le avant de changer de formule.',
) => new PublicError(message, 409);
const uncertain = () =>
  conflict(
    'Ce paiement doit être vérifié. Aucun second paiement ne sera créé.',
  );

/** Internal controller: HTTP authenticates the account, never accepts a provider
 * or price from the browser. A receipt is not a paid entitlement. */
export class D1StripeSupportPurchase {
  constructor(
    private readonly db: Database,
    private readonly configuration: StripeSupportConfiguration,
    private readonly transport: StripeSupportTransport,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  private environment() {
    const live = stripeSecretKeyLivemode(this.configuration.secretKey);
    if (live === null || live !== this.configuration.livemode)
      throw new PublicError('Le paiement Support doit être configuré.', 503);
    return live ? ('PRODUCTION' as const) : ('TEST' as const);
  }
  private scope() {
    return sha256(this.configuration.secretKey).then(
      (value) => 'stripe_key_' + value,
    );
  }
  private async target(workspaceId: string, user: ZentraUser) {
    const row = await this.db
      .prepare(`SELECT w.id,w.owner_id,l.organization_id FROM support_workspaces w
      LEFT JOIN support_gestion_links l ON l.workspace_id=w.id WHERE w.id=? AND w.owner_id=?`)
      .bind(workspaceId, user.userId)
      .first<Target>();
    if (!row)
      throw new PublicError(
        'Seul le titulaire de cet espace peut gérer son abonnement.',
        403,
      );
    if (
      row.organization_id &&
      !(await this.db
        .prepare(`SELECT 1 FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
      WHERE o.organization_id=? AND o.created_by_user_id=? AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL`)
        .bind(row.organization_id, user.userId, user.userId)
        .first())
    )
      throw new PublicError(
        'La liaison de cet espace à votre entreprise doit être vérifiée.',
        403,
      );
    return row;
  }
  private current(workspaceId: string, environment: string) {
    return this.db
      .prepare(
        'SELECT * FROM stripe_support_purchase_requests WHERE workspace_id=? AND environment=? AND closed_at IS NULL',
      )
      .bind(workspaceId, environment)
      .first<RequestRow>();
  }
  private validateRequest(
    row: RequestRow,
    target: Target,
    scope: string,
    input?: StripeSupportPurchaseInput,
  ) {
    if (
      row.owner_id !== target.owner_id ||
      row.workspace_id !== target.id ||
      row.organization_id !== target.organization_id ||
      row.provider_scope !== scope ||
      (input &&
        (row.plan_id !== input.planId ||
          row.legal_version !== input.legalVersion ||
          row.origin !== input.origin))
    )
      throw conflict();
  }
  private validateSession(row: RequestRow, session: Stripe.Checkout.Session) {
    const parameters = JSON.parse(
      row.parameters_json,
    ) as Stripe.Checkout.SessionCreateParams;
    if (
      !/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(session.id) ||
      session.mode !== 'subscription' ||
      session.livemode !== (row.environment === 'PRODUCTION') ||
      session.client_reference_id !== row.workspace_id ||
      session.expires_at !== row.expires_at ||
      session.metadata?.service !== SUPPORT_PRODUCT ||
      session.metadata.workspace_id !== row.workspace_id ||
      session.metadata.owner_id !== row.owner_id ||
      session.metadata.support_request_id !== row.request_id ||
      session.metadata.plan !== row.plan_id ||
      (session.metadata.organization_id ?? null) !== row.organization_id ||
      session.metadata.price_id !== parameters.line_items?.[0]?.price ||
      (row.session_id !== null && session.id !== row.session_id)
    )
      throw new PublicError(
        'Cette page de paiement ne correspond pas à votre espace Support.',
        403,
      );
  }
  private async intent(row: RequestRow) {
    const intent = await new D1PurchaseIntents(this.db, this.clock).reserve({
      ownerId: row.owner_id,
      environment: row.environment,
      provider: 'stripe',
      providerScope: row.provider_scope,
      product: 'support',
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      planId: row.plan_id,
      parameters: {
        requestId: row.request_id,
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
        'UPDATE stripe_support_purchase_requests SET intent_id=? WHERE request_id=? AND (intent_id IS NULL OR intent_id=?)',
      )
      .bind(intent.intentId, row.request_id, intent.intentId)
      .run();
    return intent;
  }
  private async record(
    row: RequestRow,
    intent: PurchaseIntent,
    session: Stripe.Checkout.Session,
  ) {
    this.validateSession(row, session);
    const subscription = stripeReferenceId(session.subscription);
    if (subscription && !/^sub_[A-Za-z0-9_]+$/.test(subscription))
      throw new PublicError('Cet abonnement doit être vérifié.', 403);
    if (row.subscription_id && subscription !== row.subscription_id)
      throw new PublicError('Cet abonnement doit être vérifié.', 403);
    await new D1PurchaseIntents(this.db, this.clock).bindProviderReference(
      intent,
      session.id,
    );
    await this.db.batch([
      this.db
        .prepare(`UPDATE stripe_support_purchase_requests SET session_id=?,session_url=coalesce(session_url,?),subscription_id=coalesce(subscription_id,?)
        WHERE request_id=? AND (session_id IS NULL OR session_id=?) AND (subscription_id IS NULL OR subscription_id IS ?)`)
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
          'INSERT INTO support_checkout_acceptances(session_id,workspace_id,owner_id,plan_id,legal_version,accepted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING',
        )
        .bind(
          session.id,
          row.workspace_id,
          row.owner_id,
          row.plan_id,
          row.legal_version,
          row.accepted_at,
        ),
      this.db
        .prepare(
          'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
        )
        .bind(
          crypto.randomUUID(),
          row.owner_id,
          row.legal_version,
          'support_checkout_requested',
          row.plan_id,
          session.id,
          row.origin,
          new Date(row.accepted_at * 1000).toISOString(),
        ),
    ]);
  }
  private async recover(row: RequestRow) {
    const list = await this.transport.list(
      row.created_at - 60,
      row.expires_at + 60,
    );
    if (list.has_more) throw uncertain();
    const matches = list.data.filter(
      (session) => session.metadata?.support_request_id === row.request_id,
    );
    if (matches.length !== 1) throw uncertain();
    this.validateSession(row, matches[0]);
    return matches[0];
  }
  private async expireVerified(
    row: RequestRow,
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
        // The payment may have won the race with expiration. Retrieve only;
        // neither a timeout nor a missing response authorizes a replacement.
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
          row.workspace_id,
          row.provider_scope,
          session.id,
          session.status,
        ]),
      ),
    });
  }
  private async legacy(target: Target, planId?: SupportPlanId) {
    const row = await this.db
      .prepare(
        'SELECT nonce,owner_id,plan_id,session_id,accepted_version,accepted_at FROM support_checkouts WHERE workspace_id=?',
      )
      .bind(target.id)
      .first<Legacy>();
    if (!row) return null;
    if (row.owner_id !== target.owner_id || (planId && planId !== row.plan_id))
      throw conflict();
    if (!row.session_id) throw uncertain();
    const validate = (session: Stripe.Checkout.Session) => {
      if (
        session.id !== row.session_id ||
        session.mode !== 'subscription' ||
        session.livemode !== (this.environment() === 'PRODUCTION') ||
        session.client_reference_id !== target.id ||
        session.metadata?.service !== SUPPORT_PRODUCT ||
        session.metadata.workspace_id !== target.id ||
        session.metadata.owner_id !== target.owner_id ||
        session.metadata.plan !== row.plan_id
      )
        throw new PublicError(
          'Cet ancien paiement ne correspond pas à votre espace.',
          403,
        );
    };
    let session = await this.transport.retrieve(row.session_id);
    validate(session);
    if (session.status === 'open') {
      try {
        session = await this.transport.expire(session.id);
      } catch {
        session = await this.transport.retrieve(session.id);
      }
      validate(session);
    }
    if (session.status === 'complete') {
      await this.db
        .prepare(
          'INSERT INTO support_checkout_acceptances(session_id,workspace_id,owner_id,plan_id,legal_version,accepted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING',
        )
        .bind(
          session.id,
          target.id,
          row.owner_id,
          row.plan_id,
          row.accepted_version,
          row.accepted_at,
        )
        .run();
      return session;
    }
    if (session.status === 'open')
      throw new PublicError(
        'Le lien de paiement se met à jour. Réessayez dans quelques instants.',
        503,
      );
    if (session.status !== 'expired') throw uncertain();
    // Preserve the historical session and original acceptance. The unsafe
    // legacy creator must be guarded against resetting it by the migration.
    await this.db
      .prepare(
        'UPDATE support_checkouts SET expires_at=0 WHERE workspace_id=? AND nonce=? AND session_id=?',
      )
      .bind(target.id, row.nonce, session.id)
      .run();
    return null;
  }
  async checkout(input: StripeSupportPurchaseInput) {
    if (
      !supportPlan(input.planId) ||
      input.legalVersion !== SUPPORT_LEGAL_VERSION
    )
      throw new PublicError(
        'Acceptez les conditions de Zentra Support avant de continuer.',
      );
    const target = await this.target(input.workspaceId, input.user),
      environment = this.environment(),
      scope = await this.scope();
    let row = await this.current(target.id, environment);
    if (!row) {
      const legacy = await this.legacy(target, input.planId);
      if (legacy)
        return {
          url: `${input.origin}/support/espace?workspace=${encodeURIComponent(target.id)}&section=billing`,
          legacySessionId: legacy.id,
        };
      const plan = supportPlan(input.planId)!,
        price = await this.transport.price(
          this.configuration.prices[input.planId],
        );
      if (
        !price.active ||
        price.livemode !== this.configuration.livemode ||
        price.currency !== 'chf' ||
        price.unit_amount !== plan.priceChfCents ||
        price.type !== 'recurring' ||
        price.recurring?.interval !== 'month' ||
        price.recurring.interval_count !== 1 ||
        price.tax_behavior !== 'inclusive' ||
        price.metadata.service !== SUPPORT_PRODUCT ||
        price.metadata.plan !== plan.id ||
        typeof price.product === 'string' ||
        !price.product ||
        price.product.deleted ||
        !price.product.active ||
        price.product.id !== this.configuration.productId ||
        price.id !== this.configuration.prices[input.planId]
      )
        throw new PublicError('Ce tarif Support n’est pas disponible.', 503);
      const created = this.clock(),
        requestId = 'support_' + crypto.randomUUID();
      const metadata = {
        service: SUPPORT_PRODUCT,
        workspace_id: target.id,
        owner_id: target.owner_id,
        plan: plan.id,
        support_request_id: requestId,
        price_id: price.id,
        product_id: this.configuration.productId,
        payment_methods: 'dynamic-v1',
        ...(target.organization_id
          ? { organization_id: target.organization_id }
          : {}),
      };
      const parameters: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        locale: currentSiteLanguage(),
        customer_email: input.user.email,
        client_reference_id: target.id,
        billing_address_collection: 'required',
        automatic_tax: { enabled: false },
        allow_promotion_codes: false,
        line_items: [{ price: price.id, quantity: 1 }],
        metadata,
        subscription_data: {
          metadata,
          description: `Zentra Support ${plan.name} · ${plan.analyses} analyses/mois`,
          billing_mode: { type: 'flexible' },
        },
        expires_at: created + 3600,
        success_url: `${input.origin}/support/espace?workspace=${encodeURIComponent(target.id)}&section=billing&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${input.origin}/support/espace?workspace=${encodeURIComponent(target.id)}&section=billing&paiement=annule`,
      };
      try {
        await this.db
          .prepare(`INSERT INTO stripe_support_purchase_requests(request_id,workspace_id,organization_id,owner_id,environment,provider_scope,plan_id,account_email,origin,legal_version,accepted_at,parameters_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(
          requestId,
          target.id,
          target.organization_id,
          target.owner_id,
          environment,
          scope,
          plan.id,
          input.user.email,
          input.origin,
          input.legalVersion,
          created,
          JSON.stringify(parameters),
          created,
          created + 3600,
        )
          .run();
      } catch (error) {
        // Prepared-target guards run before ON CONFLICT. A simultaneous click
        // resumes only the identical winner; it never creates another checkout.
        const winner = await this.current(target.id, environment);
        if (winner) this.validateRequest(winner, target, scope, input);
        else if (/stripe_support_|purchase_footprint/.test(String(error)))
          throw conflict();
        else throw error;
      }
      row = await this.current(target.id, environment);
    }
    if (!row) throw conflict();
    this.validateRequest(row, target, scope, input);
    let intent: PurchaseIntent;
    try {
      intent = await this.intent(row);
    } catch (error) {
      if (error instanceof PurchaseIntentError)
        throw conflict(
          'Un abonnement ou un paiement existe déjà pour cet espace. Retrouvez-le dans Compte → Abonnement.',
        );
      throw error;
    }
    if (!['reserved', 'dispatched', 'uncertain'].includes(intent.state))
      throw conflict(
        'Cette demande est terminée. Annulez-la explicitement avant de préparer un nouveau paiement.',
      );
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
          'zentra_support_purchase_' + row.request_id,
        );
      } catch (error) {
        await intents.markUncertain(intent);
        throw error;
      }
    }
    this.validateSession(row, session);
    await this.record(row, intent, session);
    if (session.status === 'expired') {
      await this.expireVerified(row, intent, session);
      throw conflict(
        'Ce paiement a expiré. Annulez cette demande avant de préparer un nouveau paiement.',
      );
    }
    if (session.status === 'complete')
      return {
        url: `${row.origin}/support/espace?workspace=${encodeURIComponent(row.workspace_id)}&section=billing`,
        completedSessionId: session.id,
      };
    if (session.status !== 'open' || !session.url)
      throw new PublicError('La page de paiement n’est pas disponible.', 503);
    return { url: session.url };
  }
  async cancel(input: { user: ZentraUser; workspaceId: string }) {
    const target = await this.target(input.workspaceId, input.user),
      environment = this.environment(),
      scope = await this.scope();
    const row = await this.current(target.id, environment);
    if (!row) {
      if (await this.legacy(target))
        throw conflict(
          'Ce paiement est terminé. Retrouvez votre abonnement dans votre compte.',
        );
      return { canceled: true as const };
    }
    this.validateRequest(row, target, scope);
    let intent = await this.intent(row);
    const intents = new D1PurchaseIntents(this.db, this.clock);
    if (intent.state === 'reserved') await intents.releaseUndispatched(intent);
    else if (['dispatched', 'uncertain'].includes(intent.state)) {
      const session =
        row.session_id || intent.providerReference
          ? await this.transport.retrieve(
              row.session_id ?? intent.providerReference!,
            )
          : await this.recover(row);
      await this.expireVerified(row, intent, session);
      intent = await intents.read(intent);
    } else if (!['released', 'expired', 'canceled'].includes(intent.state))
      throw conflict(
        'Ce paiement est terminé. Gérez votre abonnement depuis votre compte.',
      );
    await this.db
      .prepare(
        'UPDATE stripe_support_purchase_requests SET closed_at=? WHERE request_id=? AND closed_at IS NULL',
      )
      .bind(this.clock(), row.request_id)
      .run();
    return { canceled: true as const };
  }
}

async function runtimeController() {
  const key = runtimeValue('STRIPE_SECRET_KEY'),
    live = stripeSecretKeyLivemode(key);
  const row = await database()
    .prepare(
      "SELECT configuration FROM support_billing_config WHERE id='stripe'",
    )
    .first<{ configuration: string }>();
  if (!row || live === null)
    throw new PublicError('Le paiement Support doit être configuré.', 503);
  let stored: {
    productId: string;
    prices: Record<SupportPlanId, string>;
    livemode: boolean;
    keyBinding: string;
  };
  try {
    stored = JSON.parse(row.configuration);
  } catch {
    throw new PublicError('Le paiement Support doit être configuré.', 503);
  }
  if (stored.keyBinding !== (await digest(key)) || stored.livemode !== live)
    throw new PublicError('Le paiement Support doit être configuré.', 503);
  const stripe = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  return new D1StripeSupportPurchase(
    database(),
    { ...stored, secretKey: key },
    {
      price: (id) => stripe.prices.retrieve(id, { expand: ['product'] }),
      create: (parameters, idempotencyKey) =>
        stripe.checkout.sessions.create(parameters, { idempotencyKey }),
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
export async function stripeSupportPurchase(
  workspaceId: string,
  user: ZentraUser,
  body: Record<string, unknown>,
  origin: string,
) {
  if (!stripeTestAccessAllowed(stripeConfiguration(), user))
    throw new PublicError('Le paiement est encore en test privé.', 403);
  const workspace = await database()
    .prepare('SELECT * FROM support_workspaces WHERE id=? AND owner_id=?')
    .bind(workspaceId, user.userId)
    .first<Workspace>();
  if (!workspace)
    throw new PublicError(
      'Seul le titulaire de cet espace peut gérer son abonnement.',
      403,
    );
  const plan = supportPlan(body.plan);
  if (
    !plan ||
    body.acceptTerms !== true ||
    body.legalVersion !== SUPPORT_LEGAL_VERSION
  )
    throw new PublicError(
      'Choisissez une formule et acceptez les conditions de Zentra Support.',
    );
  const { billingState, refreshSupportPayment } =
    await import('@/lib/support/billing');
  const state = await billingState(workspace);
  if (state.hasSubscription || (!state.ownerAccess && state.active))
    throw conflict('Un abonnement existe déjà. Ouvrez Gérer mon abonnement.');
  try {
    const result = await (
      await runtimeController()
    ).checkout({
      user,
      workspaceId,
      planId: plan.id,
      origin,
      legalVersion: SUPPORT_LEGAL_VERSION,
    });
    const completed =
      'completedSessionId' in result
        ? result.completedSessionId
        : 'legacySessionId' in result
          ? result.legacySessionId
          : null;
    if (completed) await refreshSupportPayment(workspace, user, completed);
    return { url: result.url };
  } catch (error) {
    if (error instanceof SupportError)
      throw new PublicError(error.message, error.status);
    throw error;
  }
}
export async function cancelStripeSupportPurchase(
  workspaceId: string,
  user: ZentraUser,
) {
  if (!stripeTestAccessAllowed(stripeConfiguration(), user))
    throw new PublicError('Le paiement est encore en test privé.', 403);
  return (await runtimeController()).cancel({ user, workspaceId });
}
