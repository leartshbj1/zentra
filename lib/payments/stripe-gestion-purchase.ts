import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { database, stripeConfiguration } from '@/lib/runtime';
import { planById, type PlanId } from '@/lib/plans';
import { LEGAL_VERSION } from '@/lib/legal';
import { currentSiteLanguage } from '@/lib/site-language-server';
import { stripeAutomaticTaxRequired } from '@/lib/stripe-test-access';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';
import { buildZentraCheckoutParams } from '@/lib/stripe-checkout';
import {
  base64Url,
  fromBase64Url,
  createCheckoutSession,
  expireGestionCheckoutSession,
  listGestionCheckoutSessions,
  PublicError,
  randomBase64Url,
  retrieveCheckoutSession,
  sha256,
} from '@/lib/stripe';
import {
  D1PurchaseIntents,
  PurchaseIntentError,
  type PurchaseIntent,
} from './purchase-intents';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Referral = {
  claimId: string;
  couponId: string;
  existingSessionId?: string;
  previousSessionId?: string;
};
type ReferralRetry = { organizationId: string; requestId: string };
type Configuration = ReturnType<typeof stripeConfiguration>;
export type GestionPurchaseInput = {
  user: ZentraUser;
  planId: PlanId;
  origin: string;
  organizationId?: unknown;
  referralCode?: unknown;
  abandon?: boolean;
};
type Target = {
  organization_id: string;
  subscription_id: string;
  created_by_user_id: string;
};
type Draft = {
  organization_id: string;
  original_subscription_id: string;
  referral_code: string | null;
  referral_claim_id: string | null;
  coupon_id: string | null;
};
type RequestRow = {
  request_id: string;
  owner_id: string;
  organization_id: string;
  previous_subscription_id: string;
  environment: 'TEST' | 'PRODUCTION';
  provider_scope: string;
  plan_id: PlanId;
  account_email: string;
  account_name: string;
  origin: string;
  legal_version: string;
  referral_code: string | null;
  referral_claim_id: string | null;
  coupon_id: string | null;
  claim_hash: string;
  sealed_claim: string;
  parameters_json: string;
  intent_id: string | null;
  session_id: string | null;
  session_url: string | null;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
};
export type GestionStripeTransport = {
  create(
    row: RequestRow,
    parameters: Stripe.Checkout.SessionCreateParams,
  ): Promise<Stripe.Checkout.Session>;
  retrieve(id: string): Promise<Stripe.Checkout.Session>;
  list(
    from: number,
    until: number,
  ): Promise<{ data: Stripe.Checkout.Session[]; has_more: boolean }>;
  expire(id: string): Promise<Stripe.Checkout.Session>;
};
const encode = new TextEncoder();
function conflict(
  message = 'Un paiement est déjà préparé. Reprenez-le ou annulez-le avant de choisir une autre formule.',
) {
  return new PublicError(message, 409);
}
function referralCode(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^ZT-[A-F0-9]{16}$/.test(value.trim().toUpperCase())
  )
    throw new PublicError('Le code de parrainage est invalide.');
  return value.trim().toUpperCase();
}
async function encryptionKey(configuration: Configuration, context: string) {
  let raw: Uint8Array;
  try {
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(configuration.signingKey))
      throw new Error();
    raw = new Uint8Array(fromBase64Url(configuration.signingKey));
    if (base64Url(raw) !== configuration.signingKey) throw new Error();
    await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(raw).buffer,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
  } catch {
    throw new PublicError(
      'La signature de Zentra doit être configurée avant le paiement.',
      503,
    );
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(raw).buffer,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode.encode('zentra-gestion-checkout-secrets-v1'),
      info: encode.encode(context),
    },
    key,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
function secretContext(
  row: Pick<
    RequestRow,
    | 'request_id'
    | 'owner_id'
    | 'organization_id'
    | 'environment'
    | 'provider_scope'
  >,
) {
  return JSON.stringify([
    'zentra-gestion-claim-v1',
    row.request_id,
    row.owner_id,
    row.organization_id,
    row.environment,
    row.provider_scope,
  ]);
}
async function seal(
  configuration: Configuration,
  claim: string,
  row: Parameters<typeof secretContext>[0],
) {
  const context = secretContext(row),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const value = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encode.encode(context) },
    await encryptionKey(configuration, context),
    encode.encode(claim),
  );
  return 'v1.' + base64Url(iv) + '.' + base64Url(new Uint8Array(value));
}
async function unseal(configuration: Configuration, row: RequestRow) {
  try {
    const parts = row.sealed_claim.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error();
    const context = secretContext(row);
    const value = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(fromBase64Url(parts[1])).buffer,
        additionalData: encode.encode(context),
      },
      await encryptionKey(configuration, context),
      new Uint8Array(fromBase64Url(parts[2])).buffer,
    );
    const claim = new TextDecoder().decode(value);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(claim) ||
      (await sha256(claim)) !== row.claim_hash
    )
      throw new Error();
    return claim;
  } catch {
    throw new PublicError(
      'Cette demande de paiement doit être vérifiée par Zentra.',
      503,
    );
  }
}

/** Real Gestion controller core. Authentication/legal acceptance stay in the
 * HTTP route; transports are injectable for offline tests, never browser input.
 * Unknown dispatches retain their reservation and never restart after expiry. */
export class D1StripeGestionPurchase {
  constructor(
    private readonly db: Database,
    private readonly configuration: Configuration,
    private readonly transport: GestionStripeTransport,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  private environment() {
    const live = stripeSecretKeyLivemode(this.configuration.secretKey);
    if (live === null)
      throw new PublicError('Le paiement doit être configuré.', 503);
    return live ? ('PRODUCTION' as const) : ('TEST' as const);
  }
  private async scope() {
    return 'stripe_key_' + (await sha256(this.configuration.secretKey));
  }
  private current(organizationId: string, environment: string) {
    return this.db
      .prepare(
        'SELECT * FROM gestion_purchase_requests WHERE organization_id=? AND environment=? AND closed_at IS NULL',
      )
      .bind(organizationId, environment)
      .first<RequestRow>();
  }
  private async owned(id: string, user: ZentraUser) {
    const target = await this.db
      .prepare(`SELECT o.organization_id,o.subscription_id,o.created_by_user_id FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
      WHERE o.organization_id=? AND o.created_by_user_id=? AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL`)
      .bind(id, user.userId, user.userId)
      .first<Target>();
    if (!target)
      throw new PublicError(
        'Seul le propriétaire peut choisir cette entreprise.',
        403,
      );
    return target;
  }
  private async target(
    input: GestionPurchaseInput,
    environment: string,
  ): Promise<Target | null> {
    if (input.organizationId !== undefined && input.organizationId !== null) {
      if (
        typeof input.organizationId !== 'string' ||
        input.organizationId.length < 1 ||
        input.organizationId.length > 180
      )
        throw new PublicError('Choisissez une entreprise.');
      return this.owned(input.organizationId, input.user);
    }
    const trial = await this.db
      .prepare(`SELECT t.organization_id FROM account_trials t JOIN organizations o ON o.organization_id=t.organization_id AND o.subscription_id=t.subscription_id
      WHERE t.user_id=? AND t.converted_subscription_id IS NULL`)
      .bind(input.user.userId)
      .first<{ organization_id: string }>();
    // A frozen trial purchase remains resumable if a second company appeared
    // later. Before the first request, multiple companies require a choice.
    if (trial && (await this.current(trial.organization_id, environment)))
      return this.owned(trial.organization_id, input.user);
    const result = await this.db
      .prepare(`SELECT o.organization_id FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
      LEFT JOIN gestion_purchase_drafts d ON d.organization_id=o.organization_id
      WHERE o.created_by_user_id=? AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL AND (d.organization_id IS NULL OR d.environment=?) ORDER BY o.created_at,o.organization_id LIMIT 3`)
      .bind(input.user.userId, input.user.userId, environment)
      .all<{ organization_id: string }>();
    if (result.results.length > 1)
      throw conflict(
        'Vous avez plusieurs entreprises. Choisissez celle à utiliser avant de payer.',
      );
    return result.results[0]
      ? this.owned(result.results[0].organization_id, input.user)
      : null;
  }
  private async draft(
    user: ZentraUser,
    environment: string,
    code: string | null,
    referral: Referral | null,
  ) {
    const organizationId = 'org_' + crypto.randomUUID(),
      subscriptionId = 'draft_' + crypto.randomUUID(),
      now = this.clock();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO gestion_purchase_drafts(owner_id,environment,organization_id,original_subscription_id,referral_code,referral_claim_id,coupon_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,environment) DO NOTHING`,
        )
        .bind(
          user.userId,
          environment,
          organizationId,
          subscriptionId,
          code,
          referral?.claimId ?? null,
          referral?.couponId ?? null,
          now,
        ),
      this.db
        .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,seat_limit)
        SELECT original_subscription_id,original_subscription_id,'draft-no-paid-price','incomplete',0,?, ?,1 FROM gestion_purchase_drafts WHERE owner_id=? AND environment=? ON CONFLICT(subscription_id) DO NOTHING`)
        .bind(
          environment === 'PRODUCTION' ? 1 : 0,
          now,
          user.userId,
          environment,
        ),
      this.db
        .prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
        SELECT organization_id,?,original_subscription_id,owner_id,?,? FROM gestion_purchase_drafts WHERE owner_id=? AND environment=? ON CONFLICT(organization_id) DO NOTHING`)
        .bind('Mon entreprise', now, now, user.userId, environment),
      this.db
        .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
        SELECT ?,d.organization_id,d.owner_id,?,?,'owner',? FROM gestion_purchase_drafts d JOIN organizations o ON o.organization_id=d.organization_id AND o.created_by_user_id=d.owner_id
        WHERE d.owner_id=? AND d.environment=? ON CONFLICT(organization_id,user_id) DO NOTHING`)
        .bind(
          'mem_' + crypto.randomUUID(),
          user.email.toLowerCase(),
          user.displayName,
          now,
          user.userId,
          environment,
        ),
    ]);
    const row = (await this.db
      .prepare(
        'SELECT * FROM gestion_purchase_drafts WHERE owner_id=? AND environment=?',
      )
      .bind(user.userId, environment)
      .first<Draft>())!;
    if (
      row.referral_code !== code ||
      row.referral_claim_id !== (referral?.claimId ?? null)
    )
      throw conflict();
    return this.owned(row.organization_id, user);
  }
  private validateRequest(
    row: RequestRow,
    input: GestionPurchaseInput,
    scope: string,
    code: string | null,
  ) {
    if (
      row.owner_id !== input.user.userId ||
      row.provider_scope !== scope ||
      row.origin !== input.origin ||
      (!input.abandon &&
        (row.plan_id !== input.planId ||
          row.legal_version !== LEGAL_VERSION ||
          row.referral_code !== code))
    )
      throw conflict();
  }
  private async intent(row: RequestRow) {
    const intent = await new D1PurchaseIntents(this.db, this.clock).reserve({
      ownerId: row.owner_id,
      environment: row.environment,
      provider: 'stripe',
      providerScope: row.provider_scope,
      product: 'gestion',
      organizationId: row.organization_id,
      workspaceId: null,
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
        'UPDATE gestion_purchase_requests SET intent_id=? WHERE request_id=? AND (intent_id IS NULL OR intent_id=?)',
      )
      .bind(intent.intentId, row.request_id, intent.intentId)
      .run();
    return intent;
  }
  private validateSession(row: RequestRow, session: Stripe.Checkout.Session) {
    const parameters = JSON.parse(
      row.parameters_json,
    ) as Stripe.Checkout.SessionCreateParams;
    if (
      session.mode !== 'subscription' ||
      session.livemode !== (row.environment === 'PRODUCTION') ||
      session.client_reference_id !== row.claim_hash ||
      session.expires_at !== row.expires_at ||
      session.metadata?.account_user_id !== row.owner_id ||
      session.metadata?.activation_claim_hash !== row.claim_hash ||
      session.metadata?.organization_id !== row.organization_id ||
      session.metadata?.gestion_request_id !== row.request_id ||
      session.metadata?.plan !== parameters.metadata?.plan ||
      (session.metadata?.referral_claim ?? null) !== row.referral_claim_id ||
      !/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(session.id)
    )
      throw new PublicError(
        'Cette page de paiement ne correspond pas à votre entreprise.',
        403,
      );
  }
  private async record(
    row: RequestRow,
    intent: PurchaseIntent,
    session: Stripe.Checkout.Session,
  ) {
    this.validateSession(row, session);
    await new D1PurchaseIntents(this.db, this.clock).bindProviderReference(
      intent,
      session.id,
    );
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE gestion_purchase_requests SET session_id=?,session_url=coalesce(session_url,?) WHERE request_id=? AND (session_id IS NULL OR session_id=?)',
        )
        .bind(session.id, session.url ?? null, row.request_id, session.id),
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
          'checkout_requested',
          row.plan_id,
          session.id,
          row.origin,
          new Date(row.created_at * 1000).toISOString(),
        ),
      ...(row.referral_claim_id
        ? [
            this.db
              .prepare(
                "UPDATE referral_claims SET checkout_session_id=? WHERE id=? AND referred_user_id=? AND state='pending'",
              )
              .bind(session.id, row.referral_claim_id, row.owner_id),
          ]
        : []),
    ]);
  }
  private async recover(row: RequestRow) {
    const list = await this.transport.list(
      row.created_at - 60,
      row.expires_at + 60,
    );
    if (list.has_more)
      throw conflict(
        'Ce paiement doit être vérifié. Aucun second paiement ne sera ouvert.',
      );
    const matches = list.data.filter(
      (session) => session.metadata?.gestion_request_id === row.request_id,
    );
    if (matches.length !== 1)
      throw conflict(
        'La réponse du paiement doit être vérifiée. Aucun second paiement ne sera ouvert.',
      );
    this.validateSession(row, matches[0]);
    return matches[0];
  }
  async checkout(
    input: GestionPurchaseInput,
    prepareReferral: (
      code: unknown,
      user: ZentraUser,
      canceledGestionDraft?: ReferralRetry,
    ) => Promise<Referral | null>,
  ) {
    const environment = this.environment(),
      scope = await this.scope(),
      code = referralCode(input.referralCode);
    await encryptionKey(this.configuration, 'zentra-gestion-configuration-v1');
    let target = await this.target(input, environment),
      row = target
        ? await this.current(target.organization_id, environment)
        : null;
    if (input.abandon && !row) return { canceled: true as const };
    if (row) this.validateRequest(row, input, scope, code);
    if (!row) {
      let referral: Referral | null = null;
      const savedDraft = target
        ? await this.db
            .prepare(
              'SELECT * FROM gestion_purchase_drafts WHERE organization_id=? AND owner_id=? AND environment=?',
            )
            .bind(target.organization_id, input.user.userId, environment)
            .first<Draft>()
        : null;
      if (savedDraft) {
        const previous = await this.db
          .prepare(`SELECT r.request_id FROM gestion_purchase_requests r JOIN purchase_intents i ON i.intent_id=r.intent_id
          WHERE r.organization_id=? AND r.environment=? AND r.owner_id=? AND r.closed_at IS NOT NULL AND i.state IN ('released','expired','canceled')
          AND NOT EXISTS(SELECT 1 FROM purchase_intent_footprints f WHERE f.intent_id=i.intent_id AND f.released_at IS NULL)
          ORDER BY r.created_at DESC,r.request_id DESC LIMIT 1`)
          .bind(target!.organization_id, environment, input.user.userId)
          .first<{ request_id: string }>();
        if (previous) {
          // This is a new request after a definitive cancellation, not a retry
          // of the old snapshot. The referral service checks the draft exception
          // against the ledger and retains the one-sponsor-per-account rule.
          referral = await prepareReferral(input.referralCode, input.user, {
            organizationId: target!.organization_id,
            requestId: previous.request_id,
          });
        } else {
          if (savedDraft.referral_code !== code) throw conflict();
          if (savedDraft.referral_claim_id)
            referral = {
              claimId: savedDraft.referral_claim_id,
              couponId: savedDraft.coupon_id!,
            };
        }
      } else referral = await prepareReferral(input.referralCode, input.user);
      if (referral?.existingSessionId) {
        const session = await this.transport.retrieve(
          referral.existingSessionId,
        );
        const attempt = await this.db
          .prepare(
            'SELECT account_user_id,claim_hash FROM checkout_attempts WHERE checkout_session_id=?',
          )
          .bind(session.id)
          .first<{ account_user_id: string; claim_hash: string }>();
        if (
          attempt?.account_user_id !== input.user.userId ||
          session.metadata?.account_user_id !== input.user.userId ||
          session.metadata?.referral_claim !== referral.claimId ||
          session.metadata?.activation_claim_hash !== attempt.claim_hash
        )
          throw new PublicError(
            'Ce paiement appartient à une autre demande.',
            403,
          );
        throw conflict(
          'Reprenez ou annulez votre ancien paiement depuis votre compte avant de préparer cette entreprise.',
        );
      }
      if (!target)
        target = await this.draft(input.user, environment, code, referral);
      const requestId = 'gpr_' + crypto.randomUUID(),
        now = this.clock(),
        claim = randomBase64Url(),
        claimHash = await sha256(claim),
        plan = planById(input.planId)!;
      const priceId = this.configuration.priceIds[plan.id];
      if (!/^price_[A-Za-z0-9_]+$/.test(priceId))
        throw new PublicError('Le tarif doit être configuré.', 503);
      const parameters = buildZentraCheckoutParams({
        origin: input.origin,
        claimHash,
        priceId,
        plan: plan.licensePlan,
        accountUserId: input.user.userId,
        accountEmail: input.user.email,
        locale: currentSiteLanguage(),
        automaticTax: stripeAutomaticTaxRequired(this.configuration),
        referral: referral ?? undefined,
      });
      parameters.expires_at = now + 3600;
      parameters.metadata = {
        ...parameters.metadata,
        organization_id: target.organization_id,
        gestion_request_id: requestId,
        service: 'zentra-gestion',
      };
      parameters.subscription_data!.metadata = {
        ...parameters.subscription_data!.metadata,
        organization_id: target.organization_id,
        gestion_request_id: requestId,
        service: 'zentra-gestion',
      };
      const sealedClaim = await seal(this.configuration, claim, {
        request_id: requestId,
        owner_id: input.user.userId,
        organization_id: target.organization_id,
        environment,
        provider_scope: scope,
      });
      try {
        await this.db
          .prepare(`INSERT INTO gestion_purchase_requests(request_id,owner_id,organization_id,previous_subscription_id,environment,provider_scope,plan_id,account_email,account_name,origin,legal_version,referral_code,referral_claim_id,coupon_id,claim_hash,sealed_claim,parameters_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(
            requestId,
            input.user.userId,
            target.organization_id,
            target.subscription_id,
            environment,
            scope,
            plan.id,
            input.user.email,
            input.user.displayName,
            input.origin,
            LEGAL_VERSION,
            code,
            referral?.claimId ?? null,
            referral?.couponId ?? null,
            claimHash,
            sealedClaim,
            JSON.stringify(parameters),
            now,
            now + 3600,
          )
          .run();
      } catch (error) {
        // Resume only an identical winner of a concurrent target reservation.
        const winner = await this.current(target.organization_id, environment);
        if (winner) {
          this.validateRequest(winner, input, scope, code);
        } else if (
          error instanceof Error &&
          /gestion_purchase_(paid|complete|target)/.test(error.message)
        )
          throw conflict(
            'Votre entreprise possède un abonnement ou un paiement en cours. Gérez sa formule dans Compte → Abonnement.',
          );
        else throw error;
      }
      row = (await this.current(target.organization_id, environment))!;
      if (!row) throw conflict();
      this.validateRequest(row, input, scope, code);
    }
    let intent: PurchaseIntent;
    try {
      intent = await this.intent(row);
    } catch (error) {
      if (error instanceof PurchaseIntentError)
        throw conflict(
          'Votre entreprise possède un abonnement ou un changement en cours. Gérez sa formule dans Compte → Abonnement.',
        );
      throw error;
    }
    const intents = new D1PurchaseIntents(this.db, this.clock);
    if (input.abandon) {
      if (intent.state === 'reserved')
        await intents.releaseUndispatched(intent);
      else if (['dispatched', 'uncertain'].includes(intent.state)) {
        let session =
          row.session_id || intent.providerReference
            ? await this.transport.retrieve(
                row.session_id ?? intent.providerReference!,
              )
            : await this.recover(row);
        this.validateSession(row, session);
        if (session.status === 'complete')
          throw conflict(
            'Ce paiement est terminé. Retrouvez votre entreprise dans le compte.',
          );
        await this.record(row, intent, session);
        intent = await intents.read(intent);
        if (session.status === 'open') {
          session = await this.transport.expire(session.id);
          this.validateSession(row, session);
        }
        if (session.status !== 'expired') throw conflict();
        await intents.finalize(intent, {
          providerReference: session.id,
          outcome: 'expired',
          evidenceFingerprint: await hexDigest(
            JSON.stringify([
              session.id,
              session.status,
              row.request_id,
              row.claim_hash,
            ]),
          ),
        });
      } else if (!['released', 'expired', 'canceled'].includes(intent.state))
        throw conflict();
      await this.db
        .prepare(
          'UPDATE gestion_purchase_requests SET closed_at=? WHERE request_id=? AND closed_at IS NULL',
        )
        .bind(this.clock(), row.request_id)
        .run();
      return { canceled: true as const };
    }
    if (!['reserved', 'dispatched', 'uncertain'].includes(intent.state))
      throw conflict(
        'Cette demande est terminée. Annulez-la explicitement avant de préparer un nouveau paiement.',
      );
    const claim = await unseal(this.configuration, row);
    let session: Stripe.Checkout.Session;
    if (row.session_id || intent.providerReference)
      session = await this.transport.retrieve(
        row.session_id ?? intent.providerReference!,
      );
    // Stripe accepts a new expiry only at least 30 minutes ahead. After that
    // frozen-parameter window, read/reconcile; never rebuild or POST anew.
    else if (this.clock() >= row.expires_at - 1800)
      session = await this.recover(row);
    else {
      intent = await intents.markDispatched(intent);
      try {
        session = await this.transport.create(
          row,
          JSON.parse(row.parameters_json),
        );
      } catch (error) {
        await intents.markUncertain(intent);
        throw error;
      }
    }
    this.validateSession(row, session);
    await this.record(row, intent, session);
    if (session.status === 'expired') {
      await intents.finalize(intent, {
        providerReference: session.id,
        outcome: 'expired',
        evidenceFingerprint: await hexDigest(
          JSON.stringify([
            session.id,
            session.status,
            row.request_id,
            row.claim_hash,
          ]),
        ),
      });
      throw conflict(
        'Ce paiement a expiré. Annulez cette demande avant de préparer un nouveau paiement.',
      );
    }
    if (session.status !== 'open' && session.status !== 'complete')
      throw conflict();
    if (session.status === 'open' && !session.url)
      throw new PublicError('La page de paiement est indisponible.', 503);
    return {
      sessionId: session.id,
      claim,
      url:
        session.status === 'complete' ? input.origin + '/compte' : session.url!,
      organizationId: row.organization_id,
    };
  }
}
async function hexDigest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export function stripeGestionPurchase(
  input: GestionPurchaseInput,
  prepareReferral: (
    code: unknown,
    user: ZentraUser,
    canceledGestionDraft?: ReferralRetry,
  ) => Promise<Referral | null>,
) {
  const configuration = stripeConfiguration();
  return new D1StripeGestionPurchase(database(), configuration, {
    create: (row, parameters) =>
      createCheckoutSession(
        row.origin,
        row.claim_hash,
        { userId: row.owner_id, email: row.account_email },
        row.plan_id,
        row.referral_claim_id
          ? { claimId: row.referral_claim_id, couponId: row.coupon_id! }
          : undefined,
        { parameters },
      ),
    retrieve: retrieveCheckoutSession,
    list: listGestionCheckoutSessions,
    expire: expireGestionCheckoutSession,
  }).checkout(input, prepareReferral);
}
