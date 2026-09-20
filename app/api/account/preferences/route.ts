import { getZentraUser } from '@/app/zentra-auth';
import { accountPreferences, saveAccountPreferences } from '@/lib/account-preferences';
import { enforceAccountRateLimit } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { authJsonError, authNoStoreHeaders, AuthPublicError, requireAuthSameOrigin } from '@/lib/supabase-auth-http';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const user = await getZentraUser({ refreshSession: true });
    if (!user) throw new AuthPublicError('Connectez-vous pour retrouver vos réglages.', 401);
    return Response.json(await accountPreferences(user.userId), { headers: authNoStoreHeaders() });
  } catch (error) { return authJsonError(error); }
}
export async function PUT(request: Request) {
  try {
    requireAuthSameOrigin(request, { requireOrigin: true });
    const user = await getZentraUser({ refreshSession: true });
    if (!user) throw new AuthPublicError('Reconnectez-vous avant d’enregistrer.', 401);
    await enforceAccountRateLimit(request, 'account-preferences', user.userId, 40);
    const body = await readJsonObjectWithinLimit(request, 4096);
    return Response.json(await saveAccountPreferences(user.userId, body), { headers: authNoStoreHeaders() });
  } catch (error) { return authJsonError(error); }
}
