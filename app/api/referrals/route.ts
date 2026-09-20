import { getZentraUser } from '@/app/zentra-auth';
import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { requireSameOrigin } from '@/lib/stripe';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { referralState } from '@/lib/referrals';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    if (!user) throw new AccountPublicError('Connectez-vous à Zentra.', 401);
    const body = await readJsonObjectWithinLimit(request, 2048);
    if (typeof body.organizationId !== 'string')
      throw new AccountPublicError('Choisissez une entreprise.');
    return Response.json(
      await referralState(body.organizationId, user.userId),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
