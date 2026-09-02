import { cookies } from 'next/headers';
import { getZentraUser } from '@/app/zentra-auth';
import { issueLicense } from '@/lib/license-token';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  activationCookieName,
  assertActivationClaim,
  assertCheckoutAccount,
  jsonError,
  noStoreHeaders,
  paidEntitlementForSubscription,
  PublicError,
  referenceId,
  requireSameOrigin,
  retrieveCheckoutSession,
  retrieveInvoice,
  retrieveSubscription,
  upsertSubscription,
  validatePaidZentraInvoice,
  validatePaidSubscription,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    const body = await readJsonObjectWithinLimit(request, 16_384);
    const sessionId =
      typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const installationId =
      typeof body.installationId === 'string' ? body.installationId.trim() : '';
    const claim =
      (await cookies()).get(activationCookieName(sessionId))?.value ?? '';
    if (!claim)
      throw new PublicError(
        'Cette session d’activation n’est plus reconnue. Reprenez le paiement depuis ce navigateur.',
        401,
      );
    const session = await retrieveCheckoutSession(sessionId);
    await assertActivationClaim(session, claim);
    assertCheckoutAccount(session, user);
    const subscription = await retrieveSubscription(
      referenceId(session.subscription),
    );
    validatePaidSubscription(session, subscription);
    const paidInvoiceId = referenceId(session.invoice);
    if (!paidInvoiceId)
      throw new PublicError('La facture Stripe payée est absente.', 502);
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
    const customerName =
      session.customer_details?.business_name ??
      session.customer_details?.name ??
      entitlement.customer_name;
    const license = await issueLicense({
      subscriptionId: subscription.id,
      installationId,
      customerName,
      periodEnd: entitlement.entitlement_valid_until,
      channel: 'checkout',
    });
    return Response.json(license, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
