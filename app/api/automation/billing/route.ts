import { getZentraUser } from '@/app/zentra-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  requireBrowserMembership,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { requireSameOrigin } from '@/lib/stripe';
import {
  createAutomationCheckout,
  automationPortal,
  refreshAutomationPayment,
  automationBillingState,
} from '@/lib/automation/billing';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request),
      user = await getZentraUser({ refreshSession: true });
    if (!user) throw new AccountPublicError('Connectez-vous à Zentra.', 401);
    const body = await readJsonObjectWithinLimit(request, 4096);
    if (typeof body.organizationId !== 'string')
      throw new AccountPublicError('Choisissez votre entreprise.');
    await requireBrowserMembership(user.userId, body.organizationId);
    const result =
      body.action === 'checkout'
        ? await createAutomationCheckout(
            body.organizationId,
            user,
            body,
            origin,
          )
        : body.action === 'portal'
          ? await automationPortal(body.organizationId, user, origin)
          : body.action === 'refresh'
            ? await refreshAutomationPayment(body.organizationId, user)
            : body.action === 'state'
              ? await automationBillingState(body.organizationId)
              : null;
    if (!result) throw new AccountPublicError('Action indisponible.');
    return Response.json(result, { headers: accountNoStoreHeaders() });
  } catch (error) {
    return accountJsonError(error);
  }
}
