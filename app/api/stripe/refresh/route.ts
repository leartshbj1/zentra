import { refreshLicense } from '@/lib/license-token';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  enforceLicenseRefreshRateLimit,
  jsonError,
  noStoreHeaders,
  PublicError,
  requireSameOrigin,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // Les appels du site doivent rester same-origin. L’application native ne
    // transmet pas d’en-tête Origin et contacte uniquement l’URL HTTPS figée.
    if (request.headers.get('Origin')) requireSameOrigin(request);
    const body = await readJsonObjectWithinLimit(request, 12_288);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw new PublicError('Le jeton de licence est requis.', 400);
    await enforceLicenseRefreshRateLimit(request, token);
    const license = await refreshLicense(token);
    return Response.json(license, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
