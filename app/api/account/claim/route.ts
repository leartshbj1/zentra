import { cookies } from 'next/headers';
import { getZentraUser } from '@/app/zentra-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
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
import { linkPaidCompany } from '@/lib/subscription-account';

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
    const session = await retrieveCheckoutSession(sessionId);
    assertCheckoutAccount(session, user);
    if(claim) await assertActivationClaim(session, claim);
    else {
      // A verified account can finish on another browser/device. The binding
      // was recorded at checkout creation, never inferred from a billing email.
      const attempt=await database().prepare('SELECT account_user_id FROM checkout_attempts WHERE checkout_session_id=? AND account_user_id=? LIMIT 1')
        .bind(sessionId,user.userId).first();
      if(!attempt)throw new AccountPublicError('Reconnectez-vous au compte utilisé pour cet achat, dans le navigateur du paiement.',401);
    }
    const subscription = await retrieveSubscription(
      referenceId(session.subscription),
    );
    validatePaidSubscription(session, subscription);
    const paidInvoiceId = referenceId(session.invoice);
    if (!paidInvoiceId) {
      throw new AccountPublicError('La facture Stripe payée est absente.', 502);
    }
    const paidInvoice = await retrieveInvoice(paidInvoiceId);
    const paidThrough = await validatePaidZentraInvoice(paidInvoice, subscription);
    await upsertSubscription(subscription, session, {
      paidInvoiceId,
      paidThrough,
      paidAt:
        paidInvoice.status_transitions?.paid_at ??
        Math.floor(Date.now() / 1000),
    });
    await paidEntitlementForSubscription(subscription.id);
    const organization=await linkPaidCompany(subscription.id,user);
    return Response.json({organization,alreadyLinked:true},{headers:accountNoStoreHeaders()});
  } catch (error) {
    if (error instanceof PublicError) return jsonError(error);
    return accountJsonError(error);
  }
}
