import { database } from '@/lib/runtime';
import { AccountPublicError } from '@/lib/account-security';
import { planByLicense } from '@/lib/plans';

export type TeamSeats = {
  plan: string;
  planName: string;
  priceChfCents: number;
  limit: number | null;
  used: number;
  reserved: number;
  available: number | null;
  subscriptionActive: boolean;
};

export async function teamSeats(organizationId: string): Promise<TeamSeats> {
  const now = Math.floor(Date.now() / 1000);
  const row = await database()
    .prepare(`
    SELECT s.entitlement_plan_id,s.seat_limit,s.entitlement_valid_until,
      (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=o.organization_id AND m.revoked_at IS NULL) AS used,
      (SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=o.organization_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=?) AS reserved
    FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
    WHERE o.organization_id=? LIMIT 1
  `)
    .bind(now, organizationId)
    .first<{
      entitlement_plan_id: string;
      seat_limit: number | null;
      entitlement_valid_until: number;
      used: number;
      reserved: number;
    }>();
  const plan = planByLicense(row?.entitlement_plan_id);
  if (!row || !plan || row.seat_limit !== plan.seats) {
    throw new AccountPublicError(
      'La formule de cette entreprise doit être vérifiée.',
      403,
    );
  }
  return {
    plan: plan.id,
    planName: plan.name,
    priceChfCents: plan.priceChfCents,
    limit: row.seat_limit,
    used: row.used,
    reserved: row.reserved,
    available:
      row.seat_limit === null
        ? null
        : Math.max(0, row.seat_limit - row.used - row.reserved),
    subscriptionActive: row.entitlement_valid_until >= now,
  };
}

/** Stable order keeps the owner first if a paid plan is reduced externally. */
export const MEMBER_HAS_SEAT_SQL = `
  WITH ranked AS (
    SELECT m.user_id,s.seat_limit,
      ROW_NUMBER() OVER (ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
    FROM organization_members m
    JOIN organizations o ON o.organization_id=m.organization_id
    JOIN subscriptions s ON s.subscription_id=o.subscription_id
    WHERE m.organization_id=? AND m.revoked_at IS NULL
  ) SELECT user_id FROM ranked WHERE user_id=? AND (seat_limit IS NULL OR seat<=seat_limit)`;

export async function requireMemberSeat(
  organizationId: string,
  userId: string,
): Promise<void> {
  const allowed = await database()
    .prepare(MEMBER_HAS_SEAT_SQL)
    .bind(organizationId, userId)
    .first();
  if (!allowed) {
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
