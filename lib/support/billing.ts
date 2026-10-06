import Stripe from 'stripe';
import { currentSiteLanguage } from '@/lib/site-language-server';
import { completeSupportSubscription } from '@/lib/complete/access';
import { completePlan } from '@/lib/complete/plans';
import { supportCompleteTrial } from '@/lib/complete/trial';
import { transitionAccess } from '@/lib/complete/bridge';
import { completePortal } from '@/lib/complete/stripe';
import { database, runtimeValue } from '@/lib/runtime';
import {
  STRIPE_API_VERSION,
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
} from '@/lib/stripe';
import {
  stripeSecretKeyLivemode,
  stripeReferenceId,
  subscriptionIdFromStripeEvent,
} from '@/lib/stripe-event';
import type { ZentraUser } from '@/app/zentra-auth';
import { digest } from './crypto';
import { SupportError, type Workspace } from './types';
import { supportGrant } from './founder-access';
import {
  isPrepaidContractId,
  prepaidSupportAccess,
  type PrepaidAccess,
} from '@/lib/payments/prepaid-access';
import {
  SUPPORT_PRODUCT,
  SUPPORT_PLANS,
  supportPlan,
  type SupportPlanId,
  type SupportBillingState,
} from './plans';

type BillingConfig = {
  productId: string;
  prices: Record<SupportPlanId, string>;
  portalId: string;
  livemode: boolean;
  keyBinding: string;
};
export type SubscriptionRow = {
  provider?: 'postfinance';
  prepaidPeriodId?: string;
  bundlePlan?: string;
  workspace_id: string;
  subscription_id: string;
  customer_id: string;
  plan_id: string;
  status: string;
  paid_from: number;
  paid_until: number;
  paid_plan_id: string | null;
  last_paid_invoice_id: string | null;
  cancel_at_period_end: number;
  livemode: number;
  updated_at: number;
};
const verifiedPrepaidRows = new WeakSet<object>();
const now = () => Math.floor(Date.now() / 1000);
const ref = (value: unknown) =>
  stripeReferenceId(value as string | { id: string } | null);
function client() {
  const key = runtimeValue('STRIPE_SECRET_KEY');
  if (stripeSecretKeyLivemode(key) === null)
    throw new SupportError(
      'Le paiement est en cours de configuration par Zentra.',
      503,
    );
  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    timeout: 20000,
  });
}
async function configuration(): Promise<BillingConfig | null> {
  const row = await database()
    .prepare(
      "SELECT configuration FROM support_billing_config WHERE id='stripe'",
    )
    .first<{ configuration: string }>();
  if (!row) return null;
  const config = JSON.parse(row.configuration) as BillingConfig;
  if (
    config.keyBinding !== (await digest(runtimeValue('STRIPE_SECRET_KEY'))) ||
    config.livemode !==
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'))
  )
    return null;
  return config;
}
export async function rememberSupportOwner(user: ZentraUser) {
  const email = runtimeValue('ZENTRA_OWNER_EMAIL').toLowerCase();
  if (
    user.provider === 'supabase' &&
    user.emailConfirmed &&
    email &&
    user.email.toLowerCase() === email
  )
    await database()
      .prepare(
        'INSERT INTO support_billing_config(id,configuration,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,updated_at=excluded.updated_at',
      )
      .bind(`owner:${user.userId}`, await digest(email), now())
      .run();
}
export async function isSupportOwner(workspace: Pick<Workspace, 'owner_id'>) {
  if (
    runtimeValue('OWNER_ACCOUNT_USER_ID') &&
    workspace.owner_id === runtimeValue('OWNER_ACCOUNT_USER_ID')
  )
    return true;
  const email = runtimeValue('ZENTRA_OWNER_EMAIL').toLowerCase();
  if (!email) return false;
  const row = await database()
    .prepare('SELECT configuration FROM support_billing_config WHERE id=?')
    .bind(`owner:${workspace.owner_id}`)
    .first<{ configuration: string }>();
  return row?.configuration === (await digest(email));
}
async function subscriptionRow(workspaceId: string) {
  // Tenant authorization precedes this function. These independent read-only
  // sources share one request barrier; they never share a cross-request cache.
  const [prepaid, link, projected] = await Promise.all([
    prepaidSupportAccess(workspaceId),
    database()
      .prepare(
        'SELECT l.organization_id,o.subscription_id FROM support_gestion_links l JOIN organizations o ON o.organization_id=l.organization_id WHERE l.workspace_id=?',
      )
      .bind(workspaceId)
      .first<{ organization_id: string; subscription_id: string }>(),
    database()
      .prepare(`SELECT s.workspace_id,s.subscription_id,s.customer_id,s.plan_id,s.status,s.paid_from,
      CASE WHEN f.invoice_id IS NOT NULL THEN 0 ELSE s.paid_until END AS paid_until,
      s.paid_plan_id,s.last_paid_invoice_id,s.cancel_at_period_end,s.livemode,s.updated_at
      FROM support_subscriptions s LEFT JOIN support_refunds f ON f.invoice_id=s.last_paid_invoice_id AND f.customer_id=s.customer_id AND f.livemode=s.livemode
      WHERE s.workspace_id=?`)
      .bind(workspaceId)
      .first<SubscriptionRow>(),
  ]);
  if (prepaid?.catalog.support) return prepaidSupportRow(workspaceId, prepaid);
  if (
    (projected && isPrepaidContractId(projected.subscription_id)) ||
    (link && isPrepaidContractId(link.subscription_id))
  ) {
    // Keep the provider identity visible, but never resurrect its mutable cache,
    // transition, trial or offered-access fallback after the proof stops applying.
    return {
      workspace_id: workspaceId,
      subscription_id: projected?.subscription_id ?? link!.subscription_id,
      customer_id: '',
      plan_id: '',
      paid_plan_id: null,
      status: 'expired',
      paid_from: 0,
      paid_until: 0,
      last_paid_invoice_id: null,
      cancel_at_period_end: 0,
      livemode: 1,
      updated_at: 0,
      provider: 'postfinance',
    } satisfies SubscriptionRow;
  }
  const transition = link ? await transitionAccess(link.organization_id) : null;
  if (transition?.supportPlan)
    return {
      workspace_id: workspaceId,
      subscription_id: transition.primary,
      customer_id: transition.sources[0].customer,
      plan_id: transition.supportPlan,
      paid_plan_id: transition.supportPlan,
      status: 'active',
      paid_from: transition.supportFrom,
      paid_until: transition.until,
      last_paid_invoice_id: null,
      cancel_at_period_end: 0,
      livemode: Number(transition.live),
      updated_at: 0,
    };
  const bundle = await completeSupportSubscription(workspaceId);
  if (bundle)
    return {
      workspace_id: workspaceId,
      subscription_id: bundle.subscription_id,
      customer_id: bundle.customer_id,
      plan_id: completePlan(bundle.plan_id)!.support,
      paid_plan_id: completePlan(bundle.paid_plan_id)?.support ?? null,
      status: bundle.status,
      paid_from: bundle.paid_from,
      paid_until: bundle.refunded
        ? 0
        : Math.min(bundle.paid_until, bundle.entitlement_valid_until),
      last_paid_invoice_id: bundle.last_paid_invoice_id,
      cancel_at_period_end: bundle.cancel_at_period_end,
      livemode: bundle.livemode,
      updated_at: 0,
      bundlePlan: completePlan(bundle.paid_plan_id ?? bundle.plan_id)?.name,
    };
  return projected;
}

function prepaidSupportRow(
  workspaceId: string,
  access: PrepaidAccess,
): SubscriptionRow {
  const plan = access.catalog.support!.planId;
  const row: SubscriptionRow = {
    provider: 'postfinance',
    prepaidPeriodId: access.periodId,
    workspace_id: workspaceId,
    subscription_id: access.contractId,
    customer_id: access.contractId,
    plan_id: plan,
    paid_plan_id: plan,
    status: 'active',
    paid_from: access.paidFrom,
    paid_until: access.paidUntil,
    last_paid_invoice_id: access.periodId,
    cancel_at_period_end: Number(access.cancelAtPeriodEnd),
    livemode: 1,
    updated_at: 0,
    ...(access.productKind === 'complete'
      ? { bundlePlan: completePlan(access.catalog.planId)?.name }
      : {}),
  };
  verifiedPrepaidRows.add(row);
  return row;
}
export function paidAccess(
  row: SubscriptionRow | null,
  live: boolean | null,
  time = now(),
) {
  return (
    !!row &&
    (row.provider === 'postfinance'
      ? verifiedPrepaidRows.has(row) && !!row.prepaidPeriodId
      : live !== null && row.livemode === (live ? 1 : 0)) &&
    !!supportPlan(row.paid_plan_id) &&
    row.paid_from <= time &&
    row.paid_until > time &&
    ['active', 'past_due'].includes(row.status)
  );
}
export async function billingState(
  workspace: Pick<Workspace, 'id' | 'owner_id'>,
): Promise<SupportBillingState> {
  const [config, row, ownerAccess] = await Promise.all([
    configuration(),
    subscriptionRow(workspace.id),
    isSupportOwner(workspace),
  ]);
  const paid = paidAccess(
      row,
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    ),
    offered =
      row?.provider !== 'postfinance' && !ownerAccess && !paid
        ? await supportGrant(workspace)
        : null,
    plan = offered?.plan ?? supportPlan(row?.paid_plan_id);
  const usage = offered
    ? await database()
        .prepare(
          "SELECT COUNT(*) AS used FROM founder_support_usage WHERE workspace_id=? AND period_start=? AND state='charged'",
        )
        .bind(workspace.id, offered.start)
        .first<{ used: number }>()
    : row
      ? await database()
          .prepare(
            "SELECT COUNT(*) AS used FROM support_analysis_usage WHERE workspace_id=? AND period_start=? AND state='charged'",
          )
          .bind(workspace.id, row.paid_from)
          .first<{ used: number }>()
      : null;
  const trial =
    row?.provider !== 'postfinance' && !ownerAccess && !paid && !offered
      ? await supportCompleteTrial(workspace.id)
      : null;
  if (trial) {
    const used = await database()
      .prepare(
        "SELECT COUNT(*) AS used FROM support_analysis_usage WHERE workspace_id=? AND period_start=? AND state='charged'",
      )
      .bind(workspace.id, trial.started_at)
      .first<{ used: number }>();
    return {
      active: !!trial.active,
      bundlePlan: 'Essai Complet',
      ownerAccess: false,
      ready: !!config,
      testMode: config?.livemode === false,
      plan: 'team',
      status: trial.active ? 'trialing' : 'trial_expired',
      used: used?.used ?? 0,
      limit: trial.analyses,
      periodEnd: trial.ends_at,
      cancelAtPeriodEnd: false,
      hasSubscription: false,
    };
  }
  return {
    active: ownerAccess || paid || !!offered,
    bundlePlan: row && 'bundlePlan' in row ? row.bundlePlan : undefined,
    ownerAccess,
    offeredAccess: !!offered,
    offeredUntil: offered?.expiresAt ?? null,
    ready: row?.provider === 'postfinance' ? paid : !!config,
    testMode:
      row?.provider === 'postfinance' ? false : config?.livemode === false,
    plan: plan?.id ?? null,
    status: offered ? 'offered' : (row?.status ?? 'none'),
    used: usage?.used ?? 0,
    limit: plan?.analyses ?? 0,
    periodEnd: offered?.end ?? (row?.paid_until || null),
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
    hasSubscription:
      !!row && !['canceled', 'incomplete_expired'].includes(row.status),
  };
}
export async function requireSupportSubscription(
  workspace: Pick<Workspace, 'id' | 'owner_id'>,
) {
  if (await isSupportOwner(workspace)) return;
  const row = await subscriptionRow(workspace.id);
  if (
    !paidAccess(
      row,
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    ) &&
    (row?.provider === 'postfinance' ||
      (!(await supportGrant(workspace)) &&
        !(await supportCompleteTrial(workspace.id))?.active))
  )
    throw new SupportError(
      'Activez un abonnement dans Abonnement pour utiliser le tri et le routage. Vos tickets restent dans votre logiciel de support.',
      402,
    );
}
// Shared by reservation creation and the read-only check at delayed effects.
// This retains the existing paid/pack/trial/offered period resolution.
async function analysisQuotaContext(workspace: Workspace) {
  const paidRow = await subscriptionRow(workspace.id);
  const trial =
    paidRow?.provider !== 'postfinance' &&
    !paidAccess(
      paidRow,
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    ) &&
    !(await supportGrant(workspace))
      ? await supportCompleteTrial(workspace.id)
      : null;
  if (trial?.active) return { kind: 'trial' as const, trial };
  const row = await subscriptionRow(workspace.id),
    offered =
      row?.provider !== 'postfinance' &&
      !paidAccess(
        row,
        stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
      )
        ? await supportGrant(workspace)
        : null,
    plan = offered?.plan ?? supportPlan(row?.paid_plan_id);
  if (offered) return { kind: 'offered' as const, offered };
  if (
    !row ||
    !plan ||
    !paidAccess(row, stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')))
  )
    throw new SupportError('L’abonnement doit être actualisé.', 402);
  return { kind: 'paid' as const, row, plan };
}

export async function analysisReservationAdmission(
  workspace: Workspace,
  ticketId: string,
  reservation: string,
) {
  const founder = reservation.startsWith('founder:');
  const table = founder ? 'founder_support_usage' : 'support_analysis_usage';
  const row = await database()
    .prepare(
      `SELECT workspace_id,ticket_id,period_start,state,expires_at FROM ${table} WHERE id=?`,
    )
    .bind(founder ? reservation.slice(8) : reservation)
    .first<{
      workspace_id: string;
      ticket_id: string;
      period_start: number;
      state: string;
      expires_at: number;
    }>();
  if (
    !row ||
    row.workspace_id !== workspace.id ||
    row.ticket_id !== ticketId ||
    !['reserved', 'released', 'charged'].includes(row.state)
  )
    throw new SupportError(
      'La réservation de cette analyse doit être vérifiée avant de reprendre.',
      409,
    );
  await requireSupportSubscription(workspace);
  if (row.state === 'charged')
    return {
      state: 'charged' as const,
      admitted: true,
      periodStart: row.period_start,
    };
  if (row.state === 'released')
    return {
      state: 'released' as const,
      admitted: false,
      periodStart: row.period_start,
    };
  if (await isSupportOwner(workspace))
    return {
      state: 'reserved' as const,
      admitted: false,
      periodStart: row.period_start,
    };
  const context = await analysisQuotaContext(workspace);
  const currentFounder = context.kind === 'offered';
  const period =
    context.kind === 'trial'
      ? context.trial.started_at
      : context.kind === 'offered'
        ? context.offered.start
        : context.row.paid_from;
  const limit =
    context.kind === 'trial'
      ? context.trial.analyses
      : context.kind === 'offered'
        ? context.offered.plan.analyses
        : context.plan.analyses;
  const time = now();
  if (
    founder !== currentFounder ||
    row.period_start !== period ||
    row.expires_at <= time
  )
    return {
      state: 'reserved' as const,
      admitted: false,
      periodStart: row.period_start,
    };
  const usage = await database()
    .prepare(
      `SELECT COUNT(*) AS used FROM ${table} WHERE workspace_id=? AND period_start=? AND (state='charged' OR (state='reserved' AND expires_at>?))`,
    )
    .bind(workspace.id, period, time)
    .first<{ used: number }>();
  return {
    state: 'reserved' as const,
    admitted: !!usage && usage.used <= limit,
    periodStart: row.period_start,
  };
}

export async function reserveAnalysis(
  workspace: Workspace,
  ticketId: string,
  lease: string,
) {
  if (await isSupportOwner(workspace)) return null;
  await requireSupportSubscription(workspace);
  const context = await analysisQuotaContext(workspace);
  if (context.kind === 'trial') {
    const { trial } = context;
    const time = now();
    const result = await database()
      .prepare(`INSERT INTO support_analysis_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at)
      SELECT ?,?,?,?,'reserved',?,? WHERE EXISTS(SELECT 1 FROM account_trials t JOIN complete_trials c ON c.user_id=t.user_id JOIN organizations o ON o.organization_id=c.organization_id AND o.subscription_id=t.subscription_id WHERE c.organization_id=? AND t.ends_at>? AND t.converted_subscription_id IS NULL)
      AND (SELECT COUNT(*) FROM support_analysis_usage WHERE workspace_id=? AND period_start=? AND (state='charged' OR (state='reserved' AND expires_at>?)))<?`)
      .bind(
        lease,
        workspace.id,
        trial.started_at,
        ticketId,
        time + 180,
        time,
        trial.organization_id,
        time,
        workspace.id,
        trial.started_at,
        time,
        trial.analyses,
      )
      .run();
    if (!result.meta.changes)
      throw new SupportError(
        'Les 250 analyses de votre essai sont utilisées ou votre essai est terminé. Choisissez un pack pour continuer. Aucun montant ne sera prélevé automatiquement.',
        402,
      );
    return lease;
  }
  if (context.kind === 'offered') {
    const { offered } = context;
    const time = now();
    const result = await database()
      .prepare(`INSERT INTO founder_support_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at)
      SELECT ?,?,?,?,'reserved',?,? WHERE EXISTS(SELECT 1 FROM founder_support_grants WHERE workspace_id=? AND user_id=? AND revision=? AND revoked_at IS NULL AND valid_until>?)
      AND (SELECT COUNT(*) FROM founder_support_usage WHERE workspace_id=? AND period_start=? AND (state='charged' OR (state='reserved' AND expires_at>?)))<?`)
      .bind(
        lease,
        workspace.id,
        offered.start,
        ticketId,
        time + 180,
        time,
        workspace.id,
        workspace.owner_id,
        offered.revision,
        time,
        workspace.id,
        offered.start,
        time,
        offered.plan.analyses,
      )
      .run();
    if (!result.meta.changes)
      throw new SupportError(
        'Le volume d’analyses offert est atteint ou l’accès a changé. Actualisez votre espace. Aucun supplément ne sera facturé.',
        402,
      );
    return 'founder:' + lease;
  }
  const { row, plan } = context;
  const time = now();
  const prepaidFence =
    row.provider === 'postfinance'
      ? ` AND EXISTS(
    SELECT 1 FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
    JOIN prepaid_settlement_proofs proof ON proof.period_id=p.period_id
    JOIN support_workspaces w ON w.id=? AND w.owner_id=c.owner_id
    WHERE p.period_id=? AND c.contract_id=? AND c.environment='PRODUCTION'
    AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch()
    AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
    AND ((json_extract(p.catalog_json,'$.productKind')='support' AND c.workspace_id=w.id)
      OR (json_extract(p.catalog_json,'$.productKind')='complete' AND EXISTS(
        SELECT 1 FROM prepaid_current_company_rights rights JOIN support_gestion_links l ON l.organization_id=rights.organization_id
        WHERE rights.period_id=p.period_id AND rights.owner_id=w.owner_id AND l.workspace_id=w.id
        AND (rights.workspace_id IS NULL OR rights.workspace_id=w.id))))
  )`
      : row.last_paid_invoice_id
        ? ` AND NOT EXISTS(SELECT 1 FROM support_refunds WHERE invoice_id=? AND customer_id=? AND livemode=?)`
        : '';
  const result = await database()
    .prepare(
      `INSERT INTO support_analysis_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at) SELECT ?,?,?,?,'reserved',?,? WHERE (SELECT COUNT(*) FROM support_analysis_usage WHERE workspace_id=? AND period_start=? AND (state='charged' OR (state='reserved' AND expires_at>?)))<?${prepaidFence}`,
    )
    .bind(
      lease,
      workspace.id,
      row.paid_from,
      ticketId,
      time + 180,
      time,
      workspace.id,
      row.paid_from,
      time,
      plan.analyses,
      ...(row.provider === 'postfinance'
        ? [workspace.id, row.prepaidPeriodId!, row.subscription_id]
        : row.last_paid_invoice_id
          ? [row.last_paid_invoice_id, row.customer_id, row.livemode]
          : []),
    )
    .run();
  if (!result.meta.changes)
    throw new SupportError(
      'Le volume mensuel d’analyses est atteint. Aucun supplément ne sera facturé. Vos nouveaux tickets restent dans votre outil jusqu’au renouvellement.',
      402,
    );
  return lease;
}
export async function finishAnalysis(
  reservation: string | null,
  success: boolean,
) {
  if (reservation)
    await database()
      .prepare(
        `UPDATE ${reservation.startsWith('founder:') ? 'founder_support_usage' : 'support_analysis_usage'} SET state=? WHERE id=? AND state='reserved'`,
      )
      .bind(
        success ? 'charged' : 'released',
        reservation.startsWith('founder:') ? reservation.slice(8) : reservation,
      )
      .run();
}

export type CaptureAnalysisSettlement = {
  workspaceId: string;
  sourceSha256: string;
  ownerToken: string;
  state: 'preparing' | 'analyzed';
  periodStart: number | null;
};
/** The same reservation transition, fenced by the current capture owner in
 * the UPDATE itself. The historical finishAnalysis API remains unchanged. */
export async function finishCapturedAnalysis(
  reservation: string | null,
  success: boolean,
  capture: CaptureAnalysisSettlement,
) {
  if (!reservation) return true;
  if (capture.periodStart === null) return false;
  const table = reservation.startsWith('founder:')
    ? 'founder_support_usage'
    : 'support_analysis_usage';
  const id = reservation.startsWith('founder:')
    ? reservation.slice(8)
    : reservation;
  const fence = `workspace_id=? AND ticket_id=? AND period_start=?
    AND EXISTS(SELECT 1 FROM supplier_capture_analyses a
      WHERE a.workspace_id=? AND a.source_sha256=? AND a.owner_token=?
      AND a.state=? AND a.reservation=? AND a.owner_until>unixepoch())`;
  const params = [
    capture.workspaceId,
    `invoice:${capture.sourceSha256}`,
    capture.periodStart,
    capture.workspaceId,
    capture.sourceSha256,
    capture.ownerToken,
    capture.state,
    reservation,
  ];
  const next = success ? 'charged' : 'released';
  const updated = await database()
    .prepare(`UPDATE ${table} SET state=? WHERE id=? AND state='reserved'
    AND ${fence}${success ? ' AND expires_at>unixepoch()' : ''}`)
    .bind(next, id, ...params)
    .run();
  if (updated.meta.changes) return true;
  // A known previous settlement is acknowledged only under the same fence.
  return !!(await database()
    .prepare(`SELECT 1 FROM ${table} WHERE id=? AND state=? AND ${fence}`)
    .bind(id, next, ...params)
    .first());
}

function validPrice(price: Stripe.Price, planId: SupportPlanId, live: boolean) {
  const plan = supportPlan(planId)!;
  return (
    price.active &&
    price.livemode === live &&
    price.currency === 'chf' &&
    price.unit_amount === plan.priceChfCents &&
    price.type === 'recurring' &&
    price.recurring?.interval === 'month' &&
    price.recurring.interval_count === 1 &&
    price.tax_behavior === 'inclusive' &&
    price.metadata.service === SUPPORT_PRODUCT &&
    price.metadata.plan === planId
  );
}
export async function provisionSupportBilling() {
  const stripe = client(),
    live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'))!;
  const account = await stripe.accounts.retrieve(null);
  if (live && (!account.charges_enabled || !account.details_submitted))
    throw new SupportError(
      'Terminez l’activation du compte vendeur Stripe avant d’ouvrir les abonnements.',
      503,
    );
  const webhookId = runtimeValue('STRIPE_WEBHOOK_ENDPOINT_ID');
  const hook = await stripe.webhookEndpoints.retrieve(webhookId);
  if (
    hook.status !== 'enabled' ||
    hook.livemode !== live ||
    hook.api_version !== STRIPE_API_VERSION ||
    hook.url !== runtimeValue('PUBLIC_SITE_URL') + '/api/stripe/webhook' ||
    !REQUIRED_STRIPE_WEBHOOK_EVENTS.every(
      (e) =>
        hook.enabled_events.includes('*') || hook.enabled_events.includes(e),
    )
  )
    throw new SupportError(
      'Le webhook de paiement Zentra doit être actif et recevoir les événements d’abonnement.',
      503,
    );
  const previous = await configuration();
  const product = previous
    ? await stripe.products.retrieve(previous.productId)
    : await stripe.products
        .create(
          {
            id: 'zentra_support_20260919',
            name: 'Zentra Support',
            description:
              'Tri et routage des tickets support. Abonnement mensuel par entreprise.',
            metadata: { service: SUPPORT_PRODUCT },
          },
          { idempotencyKey: 'zentra-support-product-v1' },
        )
        .catch(async (error) => {
          if ((error as { code?: string }).code === 'resource_already_exists')
            return stripe.products.retrieve('zentra_support_20260919');
          throw error;
        });
  if (
    !product.active ||
    product.metadata.service !== SUPPORT_PRODUCT ||
    product.livemode !== live
  )
    throw new SupportError('Le produit Stripe Support doit être vérifié.', 503);
  const prices = {} as BillingConfig['prices'];
  for (const plan of SUPPORT_PLANS) {
    const lookup = `zentra-support-${plan.id}-chf-${plan.priceChfCents}-v1`;
    const existing = await stripe.prices.list({
      lookup_keys: [lookup],
      limit: 2,
    });
    if (existing.data.length > 1)
      throw new SupportError(
        'Plusieurs tarifs Stripe correspondent à cette formule.',
        503,
      );
    const price =
      existing.data[0] ??
      (await stripe.prices.create(
        {
          product: product.id,
          currency: 'chf',
          unit_amount: plan.priceChfCents,
          recurring: { interval: 'month' },
          tax_behavior: 'inclusive',
          lookup_key: lookup,
          nickname: `${plan.name} · ${plan.analyses} analyses`,
          metadata: {
            service: SUPPORT_PRODUCT,
            plan: plan.id,
            analyses: String(plan.analyses),
          },
        },
        { idempotencyKey: lookup },
      ));
    if (!validPrice(price, plan.id, live) || ref(price.product) !== product.id)
      throw new SupportError(
        'Le tarif Stripe ne correspond pas à l’offre affichée.',
        503,
      );
    prices[plan.id] = price.id;
  }
  const portal = previous
    ? await stripe.billingPortal.configurations.retrieve(previous.portalId)
    : await stripe.billingPortal.configurations.create(
        {
          business_profile: {
            headline: 'Gérer Zentra Support',
            privacy_policy_url:
              runtimeValue('PUBLIC_SITE_URL') + '/confidentialite',
            terms_of_service_url:
              runtimeValue('PUBLIC_SITE_URL') + '/support/conditions',
          },
          features: {
            customer_update: {
              enabled: true,
              allowed_updates: ['email', 'name', 'address'],
            },
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: 'at_period_end' },
            subscription_update: { enabled: false },
          },
          metadata: { service: SUPPORT_PRODUCT },
        },
        { idempotencyKey: 'zentra-support-portal-v1' },
      );
  const config: BillingConfig = {
    productId: product.id,
    prices,
    portalId: portal.id,
    livemode: live,
    keyBinding: await digest(runtimeValue('STRIPE_SECRET_KEY')),
  };
  await database()
    .prepare(
      "INSERT INTO support_billing_config(id,configuration,updated_at) VALUES('stripe',?,?) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,updated_at=excluded.updated_at",
    )
    .bind(JSON.stringify(config), now())
    .run();
  return { ready: true, livemode: live, plans: SUPPORT_PLANS };
}
export async function supportBillingAdminState() {
  const config = await configuration();
  return {
    ready: !!config,
    livemode:
      config?.livemode ??
      stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY')),
    plans: SUPPORT_PLANS,
  };
}

// Private operational check: create then expire each checkout, without customer,
// subscription, consent, payment or entitlement. Never return a payable URL.
export async function verifySupportBilling() {
  const config = await configuration();
  if (!config)
    throw new SupportError('Configurez d’abord les formules Stripe.', 503);
  const stripe = client(),
    results: {
      plan: string;
      amount: number;
      expired: boolean;
      paymentMethodTypes: string[];
      twintEligible: boolean;
    }[] = [];
  for (const plan of SUPPORT_PLANS) {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      locale: currentSiteLanguage(),
      billing_address_collection: 'required',
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      line_items: [{ price: config.prices[plan.id], quantity: 1 }],
      metadata: { service: 'zentra-support-preview' },
      subscription_data: {
        metadata: { service: 'zentra-support-preview' },
        billing_mode: { type: 'flexible' },
      },
      success_url: runtimeValue('PUBLIC_SITE_URL') + '/support/admin',
      cancel_url: runtimeValue('PUBLIC_SITE_URL') + '/support/admin',
      expires_at: now() + 1860,
      custom_text: {
        submit: { message: 'Vérification interne Zentra. Ne pas payer.' },
      },
    });
    let validationError: unknown;
    try {
      if (
        !session.url ||
        session.livemode !== config.livemode ||
        session.amount_total !== plan.priceChfCents ||
        session.currency !== 'chf' ||
        session.mode !== 'subscription'
      )
        throw new SupportError(
          'Le paiement Stripe ne correspond pas à la formule.',
          503,
        );
      const page = await fetch(session.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      if (!page.ok)
        throw new SupportError('La page Stripe ne s’ouvre pas.', 503);
    } catch (error) {
      validationError = error;
    }
    const expired = await stripe.checkout.sessions.expire(session.id);
    if (expired.status !== 'expired')
      throw new SupportError(
        'Le paiement de vérification doit être fermé dans Stripe.',
        503,
      );
    if (validationError) throw validationError;
    const paymentMethodTypes = [...(session.payment_method_types ?? [])];
    results.push({
      plan: plan.id,
      amount: plan.priceChfCents,
      expired: true,
      paymentMethodTypes,
      twintEligible: paymentMethodTypes.includes('twint'),
    });
  }
  return {
    verified: true,
    livemode: config.livemode,
    checkouts: results,
    twintEligible: results.every((result) => result.twintEligible),
    paymentTaken: false,
  };
}

// Entitlements come only from a complete, paid invoice for our exact Price.
export function paidSupportPeriod(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  config: BillingConfig,
) {
  const line = invoice.lines.data[0];
  const priceId = ref(line?.pricing?.price_details?.price),
    plan = SUPPORT_PLANS.find((p) => config.prices[p.id] === priceId);
  if (
    !plan ||
    invoice.status !== 'paid' ||
    invoice.livemode !== config.livemode ||
    invoice.currency !== 'chf' ||
    invoice.amount_paid !== plan.priceChfCents ||
    invoice.amount_due !== plan.priceChfCents ||
    invoice.total !== plan.priceChfCents ||
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1 ||
    ref(invoice.customer) !== ref(subscription.customer) ||
    invoice.parent?.type !== 'subscription_details' ||
    ref(invoice.parent.subscription_details?.subscription) !==
      subscription.id ||
    !['subscription_create', 'subscription_cycle'].includes(
      invoice.billing_reason || '',
    ) ||
    line.parent?.type !== 'subscription_item_details' ||
    line.parent.subscription_item_details?.proration !== false ||
    line.parent.subscription_item_details.subscription !== subscription.id ||
    line.currency !== 'chf' ||
    line.quantity !== 1 ||
    line.subtotal !== plan.priceChfCents ||
    !Number.isSafeInteger(line.period.start) ||
    !Number.isSafeInteger(line.period.end) ||
    line.period.end <= line.period.start ||
    line.period.end - line.period.start > 32 * 86400 ||
    line.period.start > now() + 300
  )
    return null;
  return {
    plan: plan.id,
    start: line.period.start,
    end: line.period.end,
    invoiceId: invoice.id,
  };
}
async function reconcileSubscription(
  subscription: Stripe.Subscription,
  invoice?: Stripe.Invoice | null,
) {
  const config = await configuration();
  if (!config || subscription.metadata.service !== SUPPORT_PRODUCT)
    return false;
  if (subscription.livemode !== config.livemode)
    throw new SupportError('Mode du paiement incohérent.', 503);
  const workspace = await database()
    .prepare('SELECT * FROM support_workspaces WHERE id=?')
    .bind(subscription.metadata.workspace_id || '')
    .first<Workspace>();
  if (!workspace || subscription.metadata.owner_id !== workspace.owner_id)
    throw new SupportError('Le paiement ne correspond pas à cet espace.', 409);
  const { provisionStripeSupportPurchase, verifyStripeSupportCash } =
    await import('@/lib/payments/stripe-support-provisioning');
  if (
    await provisionStripeSupportPurchase(
      subscription,
      invoice,
      config,
      client(),
      runtimeValue('STRIPE_SECRET_KEY'),
    )
  )
    return true;
  const item = subscription.items.data[0],
    plan = SUPPORT_PLANS.find(
      (candidate) => config.prices[candidate.id] === item?.price.id,
    );
  if (
    !plan ||
    !supportPlan(subscription.metadata.plan) ||
    subscription.items.data.length !== 1 ||
    item.quantity !== 1 ||
    item.price.id !== config.prices[plan.id] ||
    !validPrice(item.price, plan.id, config.livemode)
  )
    throw new SupportError('La formule du paiement doit être vérifiée.', 503);
  const existing = await subscriptionRow(workspace.id);
  if (
    existing &&
    existing.subscription_id !== subscription.id &&
    (existing.paid_until > now() ||
      !['canceled', 'incomplete_expired'].includes(existing.status))
  )
    throw new SupportError('Un abonnement existe déjà pour cet espace.', 409);
  const paid = invoice
    ? paidSupportPeriod(invoice, subscription, config)
    : null;
  if (invoice?.status === 'paid' && !paid)
    throw new SupportError(
      'Le paiement ne correspond pas à la formule attendue.',
      503,
    );
  if (invoice && paid) {
    const stripe = client();
    const cash = await verifyStripeSupportCash(invoice, subscription, {
      payments: (invoiceId) =>
        stripe.invoicePayments.list({
          invoice: invoiceId,
          status: 'paid',
          limit: 5,
        }),
      paymentIntent: (id) => stripe.paymentIntents.retrieve(id),
      charge: (id) => stripe.charges.retrieve(id),
    });
    if (cash.refunded)
      await database()
        .prepare(
          'INSERT INTO support_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING',
        )
        .bind(invoice.id!, cash.customerId, Number(cash.livemode), now())
        .run();
    if (
      cash.refunded ||
      (await database()
        .prepare(
          'SELECT 1 FROM support_refunds WHERE invoice_id=? AND customer_id=? AND livemode=?',
        )
        .bind(invoice.id!, cash.customerId, Number(cash.livemode))
        .first())
    )
      return true;
  }
  // Never move a paid period backwards when Stripe retries an older event.
  await database()
    .prepare(
      `INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,status,paid_from,paid_until,paid_plan_id,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,plan_id=excluded.plan_id,status=excluded.status,paid_from=CASE WHEN excluded.paid_until>support_subscriptions.paid_until THEN excluded.paid_from ELSE support_subscriptions.paid_from END,paid_until=MAX(excluded.paid_until,support_subscriptions.paid_until),paid_plan_id=CASE WHEN excluded.paid_until>support_subscriptions.paid_until THEN excluded.paid_plan_id ELSE support_subscriptions.paid_plan_id END,last_paid_invoice_id=CASE WHEN excluded.paid_until>support_subscriptions.paid_until THEN excluded.last_paid_invoice_id ELSE support_subscriptions.last_paid_invoice_id END,cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,updated_at=excluded.updated_at`,
    )
    .bind(
      workspace.id,
      subscription.id,
      ref(subscription.customer),
      plan.id,
      subscription.status,
      paid?.start ?? 0,
      paid?.end ?? 0,
      paid?.plan ?? null,
      paid?.invoiceId ?? null,
      subscription.cancel_at_period_end ? 1 : 0,
      config.livemode ? 1 : 0,
      now(),
    )
    .run();
  return true;
}
async function reconcileSupportRefund(event: Stripe.Event) {
  const config = await configuration();
  if (!config || event.livemode !== config.livemode) return false;
  const stripe = client(),
    charge = await stripe.charges.retrieve(
      (event.data.object as Stripe.Charge).id,
    );
  if (
    charge.livemode !== config.livemode ||
    (!charge.refunded && charge.amount_refunded <= 0)
  )
    return false;
  const paymentIntent = ref(charge.payment_intent);
  if (!paymentIntent) return false; // Subscription Checkouts use PaymentIntents.
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntent },
    status: 'paid',
    limit: 5,
  });
  if (payments.has_more || payments.data.length > 5)
    throw new SupportError('Le remboursement Support doit être vérifié.', 503);
  const { verifyStripeSupportCash } =
    await import('@/lib/payments/stripe-support-provisioning');
  let handled = false;
  for (const invoiceId of new Set(
    payments.data.map((payment) => ref(payment.invoice)),
  )) {
    const invoice = await stripe.invoices.retrieve(invoiceId),
      subscriptionId = ref(invoice.parent?.subscription_details?.subscription);
    if (
      !subscriptionId ||
      invoice.livemode !== config.livemode ||
      ref(invoice.customer) !== ref(charge.customer)
    )
      continue;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    if (
      subscription.metadata.service !== SUPPORT_PRODUCT ||
      subscription.livemode !== config.livemode ||
      ref(subscription.customer) !== ref(charge.customer)
    )
      continue;
    const cash = await verifyStripeSupportCash(invoice, subscription, {
      payments: (id) =>
        stripe.invoicePayments.list({ invoice: id, status: 'paid', limit: 5 }),
      paymentIntent: (id) => stripe.paymentIntents.retrieve(id),
      charge: (id) => stripe.charges.retrieve(id),
    });
    if (!cash.refunded) continue;
    await database()
      .prepare(
        'INSERT INTO support_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING',
      )
      .bind(invoiceId, cash.customerId, Number(cash.livemode), now())
      .run();
    handled = true;
  }
  return handled;
}
export async function persistSupportStripeEvent(event: Stripe.Event) {
  if (event.type === 'charge.refunded') return reconcileSupportRefund(event);
  const id = subscriptionIdFromStripeEvent(event);
  if (!id) return false;
  const object = event.data.object as unknown as {
    metadata?: Record<string, string>;
    parent?: { subscription_details?: { metadata?: Record<string, string> } };
  };
  const metadata =
    object.metadata?.service === SUPPORT_PRODUCT ||
    object.parent?.subscription_details?.metadata?.service === SUPPORT_PRODUCT;
  const known = await database()
    .prepare(
      'SELECT workspace_id FROM support_subscriptions WHERE subscription_id=?',
    )
    .bind(id)
    .first();
  if (!metadata && !known) return false;
  const stripe = client(),
    subscription = await stripe.subscriptions.retrieve(id);
  if (subscription.metadata.service !== SUPPORT_PRODUCT) return false;
  const invoice =
    event.type === 'invoice.paid'
      ? await stripe.invoices.retrieve((event.data.object as Stripe.Invoice).id)
      : null;
  return reconcileSubscription(subscription, invoice);
}
export async function createSupportCheckout(
  workspace: Workspace,
  user: ZentraUser,
  body: Record<string, unknown>,
  origin = runtimeValue('PUBLIC_SITE_URL'),
) {
  const { stripeSupportPurchase } =
    await import('@/lib/payments/stripe-support-purchase');
  try {
    return await stripeSupportPurchase(workspace.id, user, body, origin);
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      typeof error.status === 'number'
    )
      throw new SupportError(error.message, error.status);
    throw error;
  }
}
export async function cancelSupportCheckout(
  workspace: Workspace,
  user: ZentraUser,
) {
  const { cancelStripeSupportPurchase } =
    await import('@/lib/payments/stripe-support-purchase');
  try {
    return await cancelStripeSupportPurchase(workspace.id, user);
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      typeof error.status === 'number'
    )
      throw new SupportError(error.message, error.status);
    throw error;
  }
}
export async function refreshSupportPayment(
  workspace: Workspace,
  user: ZentraUser,
  sessionId?: string,
) {
  if (workspace.owner_id !== user.userId)
    throw new SupportError(
      'Seul le titulaire peut actualiser le paiement.',
      403,
    );
  if (await completeSupportSubscription(workspace.id))
    return { updated: false };
  const row = await subscriptionRow(workspace.id);
  if (row?.provider === 'postfinance') return { updated: false };
  const stripe = client(),
    config = await configuration();
  if (!config)
    throw new SupportError('Le paiement est en cours de configuration.', 503);
  let id = row?.subscription_id;
  if (sessionId) {
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId))
      throw new SupportError('Lien de paiement invalide.');
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.metadata?.service !== SUPPORT_PRODUCT ||
      session.metadata.workspace_id !== workspace.id ||
      session.metadata.owner_id !== user.userId ||
      session.client_reference_id !== workspace.id ||
      session.livemode !== config.livemode
    )
      throw new SupportError('Ce paiement appartient à un autre espace.', 403);
    if (session.status !== 'complete' || session.payment_status !== 'paid')
      throw new SupportError(
        'Le paiement n’est pas encore confirmé. Votre accès s’activera après confirmation.',
        409,
      );
    id = ref(session.subscription);
  }
  if (!id) return { updated: false };
  const subscription = await stripe.subscriptions.retrieve(id);
  if (
    subscription.metadata.workspace_id !== workspace.id ||
    subscription.metadata.owner_id !== user.userId
  )
    throw new SupportError('Abonnement non autorisé.', 403);
  const invoice = ref(subscription.latest_invoice)
    ? await stripe.invoices.retrieve(ref(subscription.latest_invoice))
    : null;
  await reconcileSubscription(
    subscription,
    invoice?.status === 'paid' ? invoice : null,
  );
  return { updated: true };
}
export async function createSupportPortal(
  workspace: Workspace,
  user: ZentraUser,
) {
  if (workspace.owner_id !== user.userId)
    throw new SupportError('Le titulaire de l’espace gère l’abonnement.', 403);
  const row = await subscriptionRow(workspace.id),
    config = await configuration();
  if (row?.provider === 'postfinance')
    throw new SupportError(
      'Cette offre ne se gère pas dans le portail Stripe.',
      409,
    );
  if (row && 'bundlePlan' in row)
    return completePortal(
      row.customer_id,
      `${runtimeValue('PUBLIC_SITE_URL')}/support/espace?section=billing`,
    );
  if (!row || !config || row.livemode !== (config.livemode ? 1 : 0))
    throw new SupportError('Aucun abonnement à gérer pour cet espace.', 404);
  const session = await client().billingPortal.sessions.create({
    customer: row.customer_id,
    ...('bundlePlan' in row ? {} : { configuration: config.portalId }),
    return_url: `${runtimeValue('PUBLIC_SITE_URL')}/support/espace?workspace=${workspace.id}&section=billing`,
  });
  return { url: session.url };
}
