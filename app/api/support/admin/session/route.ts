import { createAdminSession, adminCookie } from '@/lib/support/admin-session';
import {
  requireSameOrigin,
  supportError,
  supportJson,
} from '@/lib/support/service';
import { readJsonObjectWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readJsonObjectWithinLimit(request, 1024);
    const session =
      body.logout === true ? '' : await createAdminSession(request, body.token);
    const response = supportJson({ authenticated: body.logout !== true });
    response.headers.set(
      'Set-Cookie',
      body.logout === true
        ? adminCookie(request, '', 0)
        : adminCookie(request, session),
    );
    return response;
  } catch (error) {
    return supportError(error);
  }
}
