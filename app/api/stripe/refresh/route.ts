import { refreshLicense } from '@/lib/license-token';
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
    const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > 12_288) {
      throw new PublicError('Requête de renouvellement trop volumineuse.', 413);
    }
    // Les appels du site doivent rester same-origin. L’application native ne
    // transmet pas d’en-tête Origin et contacte uniquement l’URL HTTPS figée.
    if (request.headers.get('Origin')) requireSameOrigin(request);
    const rawBody = await request.text();
    if (rawBody.length > 12_288) {
      throw new PublicError('Requête de renouvellement trop volumineuse.', 413);
    }
    let body: { token?: unknown };
    try {
      body = JSON.parse(rawBody) as { token?: unknown };
    } catch {
      throw new PublicError('Requête de renouvellement invalide.', 400);
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw new PublicError('Le jeton de licence est requis.', 400);
    await enforceLicenseRefreshRateLimit(request, token);
    const license = await refreshLicense(token);
    return Response.json(license, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
