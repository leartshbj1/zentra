import { cookies } from 'next/headers';
import { getZentraUser } from '@/app/zentra-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  normalizedEmail,
} from '@/lib/account';
import {
  AccountPublicError,
  requireAccountSameOrigin,
} from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  activationCookieName,
  assertActivationClaim,
  assertCheckoutAccount,
  paidEntitlementForSubscription,
  PublicError,
  referenceId,
  retrieveCheckoutSession,
  retrieveInvoice,
  retrieveSubscription,
  upsertSubscription,
  validatePaidSubscription,
  validatePaidZentraInvoice,
  jsonError,
} from '@/lib/stripe';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAccountSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    if (!user) {
      throw new AccountPublicError(
        'Connectez-vous avant d’associer l’abonnement.',
        401,
      );
    }
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const sessionId =
      typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) {
      throw new AccountPublicError('La session Stripe est invalide.');
    }
    const claim =
      (await cookies()).get(activationCookieName(sessionId))?.value ?? '';
    if (!claim) {
      throw new AccountPublicError(
        'Cette session de paiement a expiré dans ce navigateur.',
        401,
      );
    }

    const session = await retrieveCheckoutSession(sessionId);
    await assertActivationClaim(session, claim);
    assertCheckoutAccount(session, user);
    const subscription = await retrieveSubscription(
      referenceId(session.subscription),
    );
    validatePaidSubscription(session, subscription);
    const paidInvoiceId = referenceId(session.invoice);
    if (!paidInvoiceId) {
      throw new AccountPublicError('La facture Stripe payée est absente.', 502);
    }
    const paidInvoice = await retrieveInvoice(paidInvoiceId);
    const paidThrough = validatePaidZentraInvoice(paidInvoice, subscription);
    await upsertSubscription(subscription, session, {
      paidInvoiceId,
      paidThrough,
      paidAt:
        paidInvoice.status_transitions?.paid_at ??
        Math.floor(Date.now() / 1000),
    });
    const entitlement = await paidEntitlementForSubscription(subscription.id);
    const organizationName = (
      session.customer_details?.business_name ??
      session.customer_details?.name ??
      entitlement.customer_name ??
      'Mon entreprise'
    )
      .trim()
      .slice(0, 160);
    const db = database();
    const existing = await db
      .prepare(
        `SELECT organization.organization_id,organization.name,
                organization.created_by_user_id
           FROM organizations organization
          WHERE organization.subscription_id=? LIMIT 1`,
      )
      .bind(subscription.id)
      .first<{
        organization_id: string;
        name: string;
        created_by_user_id: string;
      }>();
    if (existing) {
      if (existing.created_by_user_id !== user.userId) {
        throw new AccountPublicError(
          'Cet abonnement est déjà associé à un autre compte Zentra.',
          409,
        );
      }
      return Response.json(
        {
          organization: {
            id: existing.organization_id,
            name: existing.name,
          },
          alreadyLinked: true,
        },
        { headers: accountNoStoreHeaders() },
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const organizationId = `org_${crypto.randomUUID()}`;
    const membershipId = `mem_${crypto.randomUUID()}`;
    await db.batch([
      db
        .prepare(
          `INSERT INTO organizations(
             organization_id,name,subscription_id,created_by_user_id,created_at,updated_at
           ) VALUES(?,?,?,?,?,?)`,
        )
        .bind(
          organizationId,
          organizationName,
          subscription.id,
          user.userId,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO organization_members(
             membership_id,organization_id,user_id,email,display_name,role,joined_at
           ) VALUES(?,?,?,?,?,'owner',?)`,
        )
        .bind(
          membershipId,
          organizationId,
          user.userId,
          normalizedEmail(user.email),
          user.displayName.slice(0, 160),
          now,
        ),
    ]);
    return Response.json(
      {
        organization: { id: organizationId, name: organizationName },
        alreadyLinked: false,
      },
      { status: 201, headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    if (error instanceof PublicError) return jsonError(error);
    return accountJsonError(error);
  }
}
