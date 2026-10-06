import { getZentraUser, type ZentraUser } from '@/app/zentra-auth';
import { database } from '@/lib/runtime';
import {
  readJsonObjectWithinLimit,
  RequestBodyError,
} from '@/lib/request-body';
import {
  enforceCheckoutRateLimit,
  noStoreHeaders,
  PublicError,
  requireSameOrigin,
} from '@/lib/stripe';
import {
  cancelPrepaidRenewal,
  PrepaidCancellationError,
} from './prepaid-cancellation';

/** Cancellation stays available even when new merchant payments are disabled.
 * Neither current terms nor a usable payment credential is needed to stop
 * future billing; the refreshed owner and immutable company binding are. */
export async function runPostFinanceCancellation(
  request: Request,
  dependencies: {
    database?: () => Pick<D1Database, 'prepare'>;
    user?: () => Promise<ZentraUser | null>;
    rateLimit?: (request: Request) => Promise<void>;
    now?: () => number;
  } = {},
) {
  const headers = noStoreHeaders();
  const answer = (error: string, status: number) =>
    Response.json({ error }, { status, headers });
  try {
    requireSameOrigin(request);
    const user = await (
      dependencies.user ?? (() => getZentraUser({ refreshSession: true }))
    )();
    if (!user || !user.emailConfirmed)
      return answer('Connectez-vous à votre compte Zentra.', 401);
    const body = await readJsonObjectWithinLimit(request, 1024);
    if (
      Object.keys(body).some((k) => k !== 'contractId') ||
      typeof body.contractId !== 'string'
    )
      return answer(
        'Choisissez l’abonnement à arrêter depuis votre compte.',
        400,
      );
    await (dependencies.rateLimit ?? enforceCheckoutRateLimit)(request);
    const result = await cancelPrepaidRenewal(
      (dependencies.database ?? database)(),
      user,
      body.contractId,
      dependencies.now?.(),
    );
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof PublicError || error instanceof RequestBodyError)
      return answer(error.message, error.status);
    if (error instanceof PrepaidCancellationError)
      return answer(
        error.code === 'authentication'
          ? 'Reconnectez-vous à votre compte Zentra.'
          : 'Cet abonnement ne peut pas être modifié depuis ce compte.',
        error.code === 'authentication'
          ? 401
          : error.code === 'ownership'
            ? 403
            : 400,
      );
    console.warn('zentra_payment_cancellation', {
      provider: 'postfinance',
      code: 'local_cancellation_unavailable',
    });
    return answer(
      'L’arrêt du renouvellement doit être vérifié. Réessayez dans quelques instants.',
      503,
    );
  }
}
