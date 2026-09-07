import { getZentraUser } from '@/app/zentra-auth';
import {
  authJsonError,
  authNoStoreHeaders,
  requireAuthSameOrigin,
} from '@/lib/supabase-auth-http';

export const dynamic = 'force-dynamic';

// Navigation follows the same identity as protected account pages. The
// Supabase-only session endpoint remains available to the personal sign-in form.
export async function GET(request: Request) {
  try {
    requireAuthSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    return Response.json(
      { authenticated: user !== null },
      { headers: authNoStoreHeaders() },
    );
  } catch (error) {
    return authJsonError(error);
  }
}
