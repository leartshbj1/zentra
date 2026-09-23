import { database } from '@/lib/runtime';
import { AccountPublicError } from '@/lib/account-security';
import { planByLicense } from '@/lib/plans';
import { completePlan } from '@/lib/complete/plans';
import { offerForOrganization, grantForAccount } from '@/lib/founder-access';
import { SOLO_PLAN } from '@/lib/founder-access-policy';
import { transitionAccess } from '@/lib/complete/bridge';

export type TeamSeats = {
  plan: string;
  planName: string;
  priceChfCents: number;
  limit: number | null;
  used: number;
  reserved: number;
  available: number | null;
  subscriptionActive: boolean;
  offeredUntil?: number;
  manualAccess?: boolean;
  trialUntil?: number;
};

export async function teamSeats(organizationId: string): Promise<TeamSeats> {
  const now = Math.floor(Date.now() / 1000);
  const row = await database()
    .prepare(`
    SELECT s.entitlement_plan_id,s.seat_limit,s.entitlement_valid_until,s.subscription_id,c.paid_plan_id AS complete_plan,
      (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=o.organization_id AND m.revoked_at IS NULL) AS used,
      (SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=o.organization_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=?) AS reserved
    FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
    LEFT JOIN complete_subscriptions c ON c.subscription_id=s.subscription_id
    WHERE o.organization_id=? LIMIT 1
  `)
    .bind(now, organizationId)
    .first<{
      entitlement_plan_id: string;
      complete_plan: string | null;
      subscription_id: string;
      seat_limit: number | null;
      entitlement_valid_until: number;
      used: number;
      reserved: number;
    }>();
  const offer =
    row && row.entitlement_valid_until < now
      ? await offerForOrganization(organizationId)
      : null;
  if (offer && row) {
    row.entitlement_plan_id = SOLO_PLAN;
    row.seat_limit = 1;
    row.entitlement_valid_until = offer.valid_until;
  }
  if(row && row.entitlement_valid_until<now){const transition=await transitionAccess(organizationId);if(transition)row.entitlement_valid_until=transition.until;}
  const plan = planByLicense(row?.entitlement_plan_id);
  const bundle = completePlan(row?.complete_plan);
  const pending=await database().prepare("SELECT target_plan FROM complete_plan_changes WHERE organization_id=? AND state IN ('preparing','scheduled')").bind(organizationId).first<{target_plan:string}>();
  const futureLimit=completePlan(pending?.target_plan)?.seats;
  if (!row || !plan || row.seat_limit !== plan.seats) {
    throw new AccountPublicError(
      'La formule de cette entreprise doit être vérifiée.',
      403,
    );
  }
  return {
    plan: plan.id,
    planName:
      row.subscription_id.startsWith('trial_') ? (plan.id==='start'?'Essai Complet · 14 jours':'Essai Solo · 14 jours') : offer || row.subscription_id.startsWith('manual_')
        ? 'Accès offert'
        : bundle ? `Complet ${bundle.name}` : plan.name,
    priceChfCents:
      offer || /^(manual_|trial_)/.test(row.subscription_id)
        ? 0
        : bundle?.priceChfCents ?? plan.priceChfCents,
    ...(row.subscription_id.startsWith('manual_')
      ? { manualAccess: true }
      : {}),
    ...(offer ? { offeredUntil: offer.valid_until } : {}),
    ...(row.subscription_id.startsWith('trial_') ? { trialUntil: row.entitlement_valid_until } : {}),
    limit: row.seat_limit,
    used: row.used,
    reserved: row.reserved,
    available:
      row.seat_limit === null
        ? null
        : Math.max(0, Math.min(row.seat_limit,futureLimit??row.seat_limit) - row.used - row.reserved),
    subscriptionActive: row.entitlement_valid_until >= now,
  };
}

/** Stable order keeps the owner first if a paid plan is reduced externally. */
export const MEMBER_HAS_SEAT_SQL = `
  WITH ranked AS (
    SELECT m.user_id,s.seat_limit,s.subscription_id,
      ROW_NUMBER() OVER (ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
    FROM organization_members m
    JOIN organizations o ON o.organization_id=m.organization_id
    JOIN subscriptions s ON s.subscription_id=o.subscription_id
    WHERE m.organization_id=? AND m.revoked_at IS NULL
  ) SELECT user_id,subscription_id FROM ranked WHERE user_id=? AND (seat_limit IS NULL OR seat<=seat_limit)`;

export async function requireMemberSeat(
  organizationId: string,
  userId: string,
): Promise<void> {
  const allowed = await database()
    .prepare(MEMBER_HAS_SEAT_SQL)
    .bind(organizationId, userId)
    .first<{ subscription_id: string }>();
  if (allowed?.subscription_id.startsWith('manual_')) {
    if (await grantForAccount(allowed.subscription_id, userId)) return;
    throw new AccountPublicError(
      'L’accès offert a expiré ou a été retiré.',
      402,
    );
  }
  if (!allowed) {
    const organization = await database()
      .prepare(
        'SELECT subscription_id FROM organizations WHERE organization_id=?',
      )
      .bind(organizationId)
      .first<{ subscription_id: string }>();
    if (
      organization &&
      (await grantForAccount(organization.subscription_id, userId))
    )
      return;
    throw new AccountPublicError(
      'Votre accès dépasse le nombre de personnes incluses. Demandez au titulaire de gérer les accès ou de changer de formule.',
      403,
    );
  }
}

export async function requireInvitationCapacity(
  organizationId: string,
): Promise<TeamSeats> {
  const seats = await teamSeats(organizationId);
  if (!seats.subscriptionActive)
    throw new AccountPublicError(
      'Régularisez l’abonnement avant d’inviter une personne.',
      402,
    );
  if (seats.available === 0)
    throw new AccountPublicError(
      `La formule ${seats.planName} inclut ${seats.limit} personne${seats.limit === 1 ? '' : 's'}, titulaire compris. Retirez un accès ou une invitation en attente, ou choisissez une formule supérieure.`,
      409,
    );
  return seats;
}
