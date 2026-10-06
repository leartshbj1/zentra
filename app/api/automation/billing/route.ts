import { getZentraUser } from '@/app/zentra-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  requireBrowserMembership,
  enforceAccountRateLimit,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { PublicError, requireSameOrigin } from '@/lib/stripe';
import {
  createAutomationCheckout,
  cancelAutomationCheckout,
  automationPortal,
  refreshAutomationPayment,
  automationBillingState,
} from '@/lib/automation/billing';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request),
      user = await getZentraUser({ refreshSession: true });
    if (!user || !user.emailConfirmed)
      throw new AccountPublicError(
        'Connectez-vous à votre compte Zentra confirmé.',
        401,
      );
    const body = await readJsonObjectWithinLimit(request, 4096);
    if (
      typeof body.organizationId !== 'string' ||
      !body.organizationId ||
      body.organizationId.length > 180
    )
      throw new AccountPublicError('Choisissez votre entreprise.');
    await requireBrowserMembership(user.userId, body.organizationId);
    if (body.action !== 'state')
      await enforceAccountRateLimit(
        request,
        'automation-billing',
        user.userId,
        30,
      );
    const result =
      body.action === 'checkout'
        ? await createAutomationCheckout(
            body.organizationId,
            user,
            body,
            origin,
          )
        : body.action === 'cancelCheckout'
          ? await cancelAutomationCheckout(body.organizationId, user)
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
    return accountJsonError(
      error instanceof PublicError
        ? new AccountPublicError(error.message, error.status)
        : error,
    );
  }
}
