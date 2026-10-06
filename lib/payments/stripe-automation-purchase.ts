import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { database, runtimeValue, stripeConfiguration } from '@/lib/runtime';
import { currentSiteLanguage } from '@/lib/site-language-server';
import { sha256 } from '@/lib/stripe';
import { stripeReferenceId, stripeSecretKeyLivemode } from '@/lib/stripe-event';
import {
  stripeAutomaticTaxRequired,
  stripeTestAccessAllowed,
} from '@/lib/stripe-test-access';
import { AccountPublicError } from '@/lib/account-security';
import { requireBrowserMembership } from '@/lib/account';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import {
  AUTOMATION_PRICE_CENTS,
  AUTOMATION_PRODUCT,
} from '@/lib/automation/types';
import {
  D1PurchaseIntents,
  PurchaseIntentError,
  type PurchaseIntent,
} from './purchase-intents';
import { digest } from '@/lib/support/crypto';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export type StripeAutomationConfiguration = {
  secretKey: string;
  productId: string;
  priceId: string;
  livemode: boolean;
  automaticTax: boolean;
};
export type StripeAutomationTransport = {
  price(id: string): Promise<Stripe.Price>;
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
export type StripeAutomationPurchaseInput = {
  user: ZentraUser;
  organizationId: string;
  origin: string;
  legalVersion: string;
  consentVersion: string;
};
export type AutomationRequestRow = {
  request_id: string;
  organization_id: string;
  owner_id: string;
  environment: 'TEST' | 'PRODUCTION';
  provider_scope: string;
  base_subscription_id: string;
  base_customer_id: string;
  account_email: string;
  origin: string;
  legal_version: string;
  consent_version: string;
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
type Target = {
  organization_id: string;
  owner_id: string;
  base_subscription_id: string;
  base_customer_id: string;
};
const conflict = (
  message = 'Un paiement Automation est déjà préparé. Reprenez-le ou annulez-le avant de continuer.',
) => new AccountPublicError(message, 409);
const uncertain = () =>
  conflict(
    'Ce paiement doit être vérifié. Aucun second abonnement ne sera créé.',
  );
const ref = (v: unknown) =>
  stripeReferenceId(v as string | { id: string } | null);
export class D1StripeAutomationPurchase {
  constructor(
    private readonly db: Database,
    private readonly config: StripeAutomationConfiguration,
    private readonly transport: StripeAutomationTransport,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  private environment() {
    const live = stripeSecretKeyLivemode(this.config.secretKey);
    if (live === null || live !== this.config.livemode)
      throw new AccountPublicError(
        'Le paiement Automation doit être configuré.',
        503,
      );
    return live ? ('PRODUCTION' as const) : ('TEST' as const);
  }
  private scope() {
    return sha256(this.config.secretKey).then((s) => 'stripe_key_' + s);
  }
  private async target(organizationId: string, user: ZentraUser) {
    const row = await this.db
      .prepare(`SELECT o.organization_id,o.created_by_user_id owner_id,o.subscription_id base_subscription_id,s.customer_id base_customer_id
      FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id JOIN subscriptions s ON s.subscription_id=o.subscription_id
      WHERE (o.organization_id=? AND o.created_by_user_id=? AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL)
      AND (substr(s.subscription_id,1,4)<>'pfp_' AND s.livemode=? AND s.entitlement_valid_until>? AND s.status IN ('active','past_due'))
      AND NOT EXISTS(SELECT 1 FROM account_session_policy p WHERE p.user_id=o.created_by_user_id AND p.deleted_at IS NOT NULL)`)
      .bind(
        organizationId,
        user.userId,
        user.userId,
        Number(this.config.livemode),
        this.clock(),
      )
      .first<Target>();
    if (!row)
      throw new AccountPublicError(
        'Une entreprise dont vous êtes titulaire et un abonnement Zentra Gestion actif sont nécessaires.',
        403,
      );
    if (!/^cus_[A-Za-z0-9_]+$/.test(row.base_customer_id))
      throw new AccountPublicError(
        'Le compte de paiement Gestion doit être vérifié.',
        409,
      );
    return row;
  }
  private current(organizationId: string, environment: string) {
    return this.db
      .prepare(
        'SELECT * FROM stripe_automation_purchase_requests WHERE organization_id=? AND environment=? AND closed_at IS NULL',
      )
      .bind(organizationId, environment)
      .first<AutomationRequestRow>();
  }
  private validate(
    row: AutomationRequestRow,
    target: Target,
    scope: string,
    input?: StripeAutomationPurchaseInput,
  ) {
    if (
      row.owner_id !== target.owner_id ||
      row.organization_id !== target.organization_id ||
      row.provider_scope !== scope ||
      row.base_subscription_id !== target.base_subscription_id ||
      row.base_customer_id !== target.base_customer_id ||
      (input &&
        (row.origin !== input.origin ||
          row.legal_version !== input.legalVersion ||
          row.consent_version !== input.consentVersion))
    )
      throw conflict();
  }
  private session(row: AutomationRequestRow, s: Stripe.Checkout.Session) {
    const p = JSON.parse(
      row.parameters_json,
    ) as Stripe.Checkout.SessionCreateParams;
    if (
      !/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(s.id) ||
      s.mode !== 'subscription' ||
      s.livemode !== (row.environment === 'PRODUCTION') ||
      s.expires_at !== row.expires_at ||
      s.client_reference_id !== row.organization_id ||
      s.metadata?.service !== AUTOMATION_PRODUCT ||
      s.metadata.automation_request_id !== row.request_id ||
      s.metadata.owner_id !== row.owner_id ||
      s.metadata.organization_id !== row.organization_id ||
      s.metadata.price_id !== p.line_items?.[0]?.price ||
      s.metadata.base_subscription_id !== row.base_subscription_id ||
      ref(s.customer) !== row.base_customer_id ||
      (row.session_id !== null && s.id !== row.session_id)
    )
      throw new AccountPublicError(
        'Cette page de paiement ne correspond pas à votre entreprise.',
        403,
      );
  }
  private async intent(row: AutomationRequestRow) {
    const i = await new D1PurchaseIntents(this.db, this.clock).reserve({
      ownerId: row.owner_id,
      environment: row.environment,
      provider: 'stripe',
      providerScope: row.provider_scope,
      product: 'automation',
      organizationId: row.organization_id,
      workspaceId: null,
      planId: null,
      parameters: {
        requestId: row.request_id,
        stripeParameters: JSON.parse(row.parameters_json),
        baseSubscriptionId: row.base_subscription_id,
        baseCustomerId: row.base_customer_id,
      },
      terms: {
        version: row.legal_version,
        consentVersion: row.consent_version,
        origin: row.origin,
      },
    });
    if (row.intent_id && row.intent_id !== i.intentId) throw conflict();
    await this.db
      .prepare(
        'UPDATE stripe_automation_purchase_requests SET intent_id=? WHERE request_id=? AND (intent_id IS NULL OR intent_id=?)',
      )
      .bind(i.intentId, row.request_id, i.intentId)
      .run();
    return i;
  }
  private async record(
    row: AutomationRequestRow,
    intent: PurchaseIntent,
    s: Stripe.Checkout.Session,
  ) {
    this.session(row, s);
    const sub = ref(s.subscription);
    if (sub && !/^sub_[A-Za-z0-9_]+$/.test(sub)) throw uncertain();
    if (row.subscription_id && sub !== row.subscription_id) throw uncertain();
    await new D1PurchaseIntents(this.db, this.clock).bindProviderReference(
      intent,
      s.id,
    );
    await this.db.batch([
      this.db
        .prepare(`UPDATE stripe_automation_purchase_requests SET session_id=?,session_url=coalesce(session_url,?),subscription_id=coalesce(subscription_id,?)
      WHERE request_id=? AND (session_id IS NULL OR session_id=?) AND (subscription_id IS NULL OR subscription_id IS ?)`)
        .bind(
          s.id,
          s.url ?? null,
          sub || null,
          row.request_id,
          s.id,
          sub || null,
        ),
      this.db
        .prepare(
          'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
        )
        .bind(
          crypto.randomUUID(),
          row.owner_id,
          row.legal_version,
          'automation_checkout',
          AUTOMATION_PRODUCT,
          s.id,
          row.origin,
          new Date(row.accepted_at * 1000).toISOString(),
        ),
    ]);
  }
  private async recover(row: AutomationRequestRow) {
    const l = await this.transport.list(
      row.created_at - 60,
      row.expires_at + 60,
    );
    const matches = l.data.filter(
      (s) => s.metadata?.automation_request_id === row.request_id,
    );
    if (l.has_more || matches.length !== 1) throw uncertain();
    this.session(row, matches[0]);
    return matches[0];
  }
  private async expire(
    row: AutomationRequestRow,
    i: PurchaseIntent,
    s: Stripe.Checkout.Session,
  ) {
    this.session(row, s);
    if (s.status === 'complete')
      throw conflict('Ce paiement est terminé. Actualisez votre abonnement.');
    await this.record(row, i, s);
    if (s.status === 'open') {
      try {
        s = await this.transport.expire(s.id);
      } catch {
        s = await this.transport.retrieve(s.id);
      }
      this.session(row, s);
    }
    if (s.status !== 'expired') throw uncertain();
    await new D1PurchaseIntents(this.db, this.clock).finalize(i, {
      outcome: 'expired',
      providerReference: s.id,
      evidenceFingerprint: await digest(
        JSON.stringify([row.request_id, s.id, 'verified-expired']),
      ),
    });
  }
  private async legacy(target: Target) {
    const old = await this.db
      .prepare(
        'SELECT attempt_id,user_id,session_id,expires_at,request_json,created_at FROM automation_checkouts WHERE organization_id=?',
      )
      .bind(target.organization_id)
      .first<{
        attempt_id: string;
        user_id: string;
        session_id: string | null;
        expires_at: number;
        request_json: string | null;
        created_at: number;
      }>();
    if (!old) return null;
    if (old.user_id !== target.owner_id || !old.session_id) throw uncertain();
    const check = (s: Stripe.Checkout.Session) => {
      if (
        s.id !== old.session_id ||
        s.livemode !== this.config.livemode ||
        s.mode !== 'subscription' ||
        s.metadata?.attempt_id !== old.attempt_id ||
        s.metadata?.service !== AUTOMATION_PRODUCT ||
        s.metadata.owner_id !== target.owner_id ||
        s.metadata.organization_id !== target.organization_id ||
        ref(s.customer) !== target.base_customer_id
      )
        throw uncertain();
      if (old.request_json) {
        let frozen: Stripe.Checkout.SessionCreateParams;
        try {
          frozen = JSON.parse(old.request_json);
        } catch {
          throw uncertain();
        }
        if (
          frozen.mode !== 'subscription' ||
          frozen.customer !== target.base_customer_id ||
          frozen.expires_at !== s.expires_at ||
          Object.entries(frozen.metadata ?? {}).some(
            ([key, value]) => s.metadata?.[key] !== String(value),
          )
        )
          throw uncertain();
      }
    };
    let s = await this.transport.retrieve(old.session_id);
    check(s);
    if (s.status === 'open') {
      try {
        s = await this.transport.expire(s.id);
      } catch {
        s = await this.transport.retrieve(s.id);
      }
      check(s);
    }
    if (s.status === 'complete') return s;
    if (s.status !== 'expired') throw uncertain();
    await this.db
      .prepare(
        'UPDATE automation_checkouts SET expires_at=0 WHERE organization_id=? AND attempt_id=? AND session_id=?',
      )
      .bind(target.organization_id, old.attempt_id, s.id)
      .run();
    return null;
  }
  async checkout(input: StripeAutomationPurchaseInput) {
    const { AUTOMATION_TERMS_VERSION } =
      await import('@/lib/automation/billing');
    if (
      input.legalVersion !== AUTOMATION_TERMS_VERSION ||
      input.consentVersion !== AUTOMATION_CONSENT_VERSION
    )
      throw new AccountPublicError(
        'Acceptez les conditions de l’option et le traitement des extraits nécessaires.',
      );
    const target = await this.target(input.organizationId, input.user),
      env = this.environment(),
      scope = await this.scope();
    let row = await this.current(target.organization_id, env);
    if (!row) {
      const old = await this.legacy(target);
      if (old)
        return {
          url:
            input.origin +
            '/compte/automation?entreprise=' +
            encodeURIComponent(target.organization_id),
          completedSessionId: old.id,
        };
      const price = await this.transport.price(this.config.priceId);
      if (
        price.id !== this.config.priceId ||
        !price.active ||
        price.livemode !== this.config.livemode ||
        ref(price.product) !== this.config.productId ||
        price.currency !== 'chf' ||
        price.unit_amount !== AUTOMATION_PRICE_CENTS ||
        price.type !== 'recurring' ||
        price.recurring?.interval !== 'month' ||
        price.recurring.interval_count !== 1 ||
        price.recurring.usage_type !== 'licensed' ||
        price.tax_behavior !== 'inclusive' ||
        price.metadata.service !== AUTOMATION_PRODUCT
      )
        throw new AccountPublicError(
          'Le tarif Automation doit être vérifié.',
          503,
        );
      const at = this.clock(),
        requestId = 'automation_' + crypto.randomUUID(),
        metadata = {
          service: AUTOMATION_PRODUCT,
          organization_id: target.organization_id,
          owner_id: target.owner_id,
          automation_request_id: requestId,
          base_subscription_id: target.base_subscription_id,
          price_id: price.id,
          product_id: this.config.productId,
          consent_version: input.consentVersion,
          payment_methods: 'dynamic-v1',
        };
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        locale: currentSiteLanguage(),
        customer: target.base_customer_id,
        client_reference_id: target.organization_id,
        line_items: [{ price: price.id, quantity: 1 }],
        automatic_tax: { enabled: this.config.automaticTax },
        allow_promotion_codes: false,
        expires_at: at + 3600,
        metadata,
        subscription_data: {
          description: 'Zentra Automation · 15 CHF/mois',
          metadata,
          billing_mode: { type: 'flexible' },
        },
        success_url: `${input.origin}/compte/automation?entreprise=${encodeURIComponent(target.organization_id)}&paiement=retour`,
        cancel_url: `${input.origin}/compte/automation?entreprise=${encodeURIComponent(target.organization_id)}&paiement=annule`,
      };
      try {
        await this.db
          .prepare(`INSERT INTO stripe_automation_purchase_requests(request_id,organization_id,owner_id,environment,provider_scope,base_subscription_id,base_customer_id,account_email,origin,legal_version,consent_version,accepted_at,parameters_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(
            requestId,
            target.organization_id,
            target.owner_id,
            env,
            scope,
            target.base_subscription_id,
            target.base_customer_id,
            input.user.email,
            input.origin,
            input.legalVersion,
            input.consentVersion,
            at,
            JSON.stringify(params),
            at,
            at + 3600,
          )
          .run();
      } catch (e) {
        // BEFORE INSERT fences run before ON CONFLICT: a concurrent identical
        // request may already have won. Only that exact frozen target/consent
        // can be resumed; a different product/provider is still refused.
        const winner = await this.current(target.organization_id, env);
        if (!winner) {
          if (e instanceof Error && /purchase.*conflict/.test(e.message))
            throw conflict();
          throw e;
        }
        this.validate(winner, target, scope, input);
        row = winner;
      }
      row ??= await this.current(target.organization_id, env);
    }
    if (!row) throw conflict();
    this.validate(row, target, scope, input);
    let i: PurchaseIntent;
    try {
      i = await this.intent(row);
    } catch (e) {
      if (e instanceof PurchaseIntentError) throw conflict();
      throw e;
    }
    if (!['reserved', 'dispatched', 'uncertain'].includes(i.state))
      throw conflict(
        'Cette demande est terminée. Annulez-la avant de préparer un autre paiement.',
      );
    let s: Stripe.Checkout.Session;
    if (row.session_id || i.providerReference)
      s = await this.transport.retrieve(row.session_id ?? i.providerReference!);
    else if (this.clock() >= row.expires_at - 1800) s = await this.recover(row);
    else {
      const ledger = new D1PurchaseIntents(this.db, this.clock);
      i = await ledger.markDispatched(i);
      try {
        s = await this.transport.create(
          JSON.parse(row.parameters_json),
          'zentra_automation_purchase_' + row.request_id,
        );
      } catch (e) {
        await ledger.markUncertain(i);
        throw e;
      }
    }
    this.session(row, s);
    await this.record(row, i, s);
    if (s.status === 'expired') {
      await this.expire(row, i, s);
      throw conflict(
        'Ce paiement a expiré. Annulez la demande avant de recommencer.',
      );
    }
    if (s.status === 'complete')
      return {
        url:
          row.origin +
          '/compte/automation?entreprise=' +
          encodeURIComponent(row.organization_id),
        completedSessionId: s.id,
      };
    if (s.status !== 'open' || !s.url)
      throw new AccountPublicError(
        'La page de paiement est indisponible.',
        503,
      );
    return { url: s.url };
  }
  async cancel(input: { user: ZentraUser; organizationId: string }) {
    const target = await this.target(input.organizationId, input.user),
      env = this.environment(),
      scope = await this.scope();
    const row = await this.current(target.organization_id, env);
    if (!row) {
      if (await this.legacy(target))
        throw conflict('Ce paiement est terminé. Gérez votre abonnement.');
      return { canceled: true as const };
    }
    this.validate(row, target, scope);
    let i = await this.intent(row);
    const ledger = new D1PurchaseIntents(this.db, this.clock);
    if (i.state === 'reserved') await ledger.releaseUndispatched(i);
    else if (['dispatched', 'uncertain'].includes(i.state)) {
      const s =
        row.session_id || i.providerReference
          ? await this.transport.retrieve(
              row.session_id ?? i.providerReference!,
            )
          : await this.recover(row);
      await this.expire(row, i, s);
      i = await ledger.read(i);
    } else if (!['released', 'expired', 'canceled'].includes(i.state))
      throw conflict('Ce paiement est terminé. Gérez votre abonnement.');
    await this.db
      .prepare(
        'UPDATE stripe_automation_purchase_requests SET closed_at=? WHERE request_id=? AND closed_at IS NULL',
      )
      .bind(this.clock(), row.request_id)
      .run();
    return { canceled: true as const };
  }
}
export async function stripeAutomationController() {
  const { automationBillingConfig, automationStripe } =
    await import('@/lib/automation/billing');
  const config = await automationBillingConfig();
  if (!config)
    throw new AccountPublicError(
      'Le paiement Automation doit être configuré.',
      503,
    );
  const stripe = automationStripe();
  return new D1StripeAutomationPurchase(
    database(),
    {
      ...config,
      secretKey: runtimeValue('STRIPE_SECRET_KEY'),
      automaticTax: stripeAutomaticTaxRequired(stripeConfiguration()),
    },
    {
      price: (id) => stripe.prices.retrieve(id, { expand: ['product'] }),
      create: (p, key) =>
        stripe.checkout.sessions.create(p, { idempotencyKey: key }),
      retrieve: (id) => stripe.checkout.sessions.retrieve(id),
      list: (from, to) =>
        stripe.checkout.sessions.list({
          created: { gte: from, lte: to },
          limit: 100,
        }),
      expire: (id) => stripe.checkout.sessions.expire(id),
    },
  );
}
export async function stripeAutomationCheckout(
  organizationId: string,
  user: ZentraUser,
  body: Record<string, unknown>,
  origin: string,
) {
  await requireBrowserMembership(user.userId, organizationId, ['owner']);
  // An existing or unresolved prepaid purchase belongs to this company, not
  // to every other company owned by the same account. Refuse mixing providers
  // before inspecting merchant configuration; these identities confer no access.
  const prepaid = await database()
    .prepare(`SELECT 1 FROM organizations o WHERE o.organization_id=? AND o.created_by_user_id=? AND substr(o.subscription_id,1,4)='pfp_'
      UNION ALL SELECT 1 FROM automation_subscriptions a JOIN organizations o ON o.organization_id=a.organization_id
        WHERE o.organization_id=? AND o.created_by_user_id=? AND substr(a.subscription_id,1,4)='pfp_'
      UNION ALL SELECT 1 FROM prepaid_contracts c WHERE c.organization_id=? AND c.owner_id=? AND c.environment='PRODUCTION'
        AND (c.product_key='automation' OR substr(c.product_key,1,8)='gestion:' OR substr(c.product_key,1,8)='complet:')
        AND (c.cancelled_at IS NULL OR EXISTS(SELECT 1 FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
          WHERE p.contract_id=c.contract_id AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch()
          AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id))) LIMIT 1`)
    .bind(
      organizationId,
      user.userId,
      organizationId,
      user.userId,
      organizationId,
      user.userId,
    )
    .first();
  if (prepaid)
    throw conflict(
      'Un abonnement existe déjà pour cette entreprise. Son changement de moyen de paiement doit être terminé avant d’en ouvrir un autre.',
    );
  if (!stripeTestAccessAllowed(stripeConfiguration(), user))
    throw new AccountPublicError('Le paiement est encore en test privé.', 403);
  const { AUTOMATION_TERMS_VERSION, automationBillingState } =
    await import('@/lib/automation/billing');
  if (
    body.acceptTerms !== true ||
    body.legalVersion !== AUTOMATION_TERMS_VERSION ||
    body.consentVersion !== AUTOMATION_CONSENT_VERSION
  )
    throw new AccountPublicError(
      'Acceptez les conditions de l’option et le traitement des extraits nécessaires.',
    );
  const billing = await automationBillingState(organizationId);
  if (billing.hasSubscription || billing.offeredAccess)
    throw conflict(
      'L’option possède déjà un abonnement ou un accès offert. Retrouvez-le dans Compte → Abonnement.',
    );
  const result = await (
    await stripeAutomationController()
  ).checkout({
    user,
    organizationId,
    origin,
    legalVersion: AUTOMATION_TERMS_VERSION,
    consentVersion: AUTOMATION_CONSENT_VERSION,
  });
  // A completed session remains only a receipt; the verified webhook grants the first period.
  return { url: result.url };
}
export async function cancelStripeAutomationCheckout(
  organizationId: string,
  user: ZentraUser,
) {
  await requireBrowserMembership(user.userId, organizationId, ['owner']);
  if (!stripeTestAccessAllowed(stripeConfiguration(), user))
    throw new AccountPublicError('Le paiement est encore en test privé.', 403);
  return (await stripeAutomationController()).cancel({ user, organizationId });
}
