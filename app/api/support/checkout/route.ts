import { getZentraUser } from '@/app/zentra-auth';
import { enforceAccountRateLimit } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  jsonError,
  noStoreHeaders,
  PublicError,
  requireSameOrigin,
} from '@/lib/stripe';
import {
  cancelStripeSupportPurchase,
  stripeSupportPurchase,
} from '@/lib/payments/stripe-support-purchase';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    if (!user || !user.emailConfirmed)
      throw new PublicError(
        'Connectez-vous à votre compte Zentra confirmé.',
        401,
      );
    const body = await readJsonObjectWithinLimit(request, 4_096);
    if (
      typeof body.workspaceId !== 'string' ||
      !body.workspaceId ||
      body.workspaceId.length > 180
    )
      throw new PublicError('Choisissez votre espace Support.');
    if (
      body.action !== undefined &&
      (typeof body.action !== 'string' ||
        !['checkout', 'cancelCheckout'].includes(body.action))
    )
      throw new PublicError('Cette action est inconnue.');
    await enforceAccountRateLimit(request, 'support-billing', user.userId, 30);
    const result =
      body.action === 'cancelCheckout'
        ? await cancelStripeSupportPurchase(body.workspaceId, user)
        : await stripeSupportPurchase(body.workspaceId, user, body, origin);
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
