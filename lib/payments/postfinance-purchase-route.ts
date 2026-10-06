import { getZentraUser, type ZentraUser } from '@/app/zentra-auth';
import { database, runtimeValue } from '@/lib/runtime';
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
  postFinancePurchaseConfiguration,
  postFinanceTestPurchaseAllowed,
  type PostFinancePurchaseBinding,
} from './postfinance-purchase-configuration';
import { PrepaidPurchaseAccessError } from './prepaid-purchase-access';
import {
  prepareInitialPrepaidPurchase,
  PrepaidPreparationError,
} from './prepaid-purchase-preparation';
import { runInitialPrepaidCheckout } from './prepaid-initial-checkout';
import { PurchaseIntentError } from './purchase-intents';
import type { SwissMethod } from './postfinance-client';

/** Browser checkout entrypoint. It grants no access and never trusts a return
 * page as settlement. Customer/company, terms, catalogue and dispatch are
 * checked by the real preparation/orchestration modules before a provider POST.
 * Publicly disabled until an approved merchant configuration is staged. */
export async function runPostFinancePurchase(
  request: Request,
  dependencies: {
    read?: (name: PostFinancePurchaseBinding) => string;
    database?: () => Pick<D1Database, 'prepare' | 'batch'>;
    user?: () => Promise<ZentraUser | null>;
    rateLimit?: (request: Request) => Promise<void>;
    now?: () => number;
    fetch?: typeof fetch;
  } = {},
) {
  const headers = noStoreHeaders();
  const answer = (error: string, status: number) =>
    Response.json({ error }, { status, headers });
  try {
    const read = dependencies.read ?? runtimeValue;
    const configuration = postFinancePurchaseConfiguration(read);
    if (!configuration.enabled)
      return answer('Ce moyen de paiement n’est pas encore disponible.', 503);
    // Staging only until paid projection, renewals and cancellation are wired
    // and verified with the actual merchant. Deployment flags alone cannot
    // expose a LIVE purchase that would take money without granting access.
    if (configuration.connection.prepaidEnvironment !== 'TEST')
      return answer('Ce moyen de paiement n’est pas encore disponible.', 503);
    const origin = requireSameOrigin(request);
    if (origin !== configuration.connection.returnOrigin)
      throw new PublicError(
        'Ouvrez le paiement depuis votre compte Zentra.',
        403,
      );
    const user = await (
      dependencies.user ?? (() => getZentraUser({ refreshSession: true }))
    )();
    if (!user || user.emailConfirmed !== true)
      return answer(
        'Connectez-vous à votre compte Zentra pour continuer.',
        401,
      );
    if (!postFinanceTestPurchaseAllowed(configuration, user.userId, read))
      return answer('Ce paiement est réservé aux essais privés.', 403);
    const body = await readJsonObjectWithinLimit(request, 4096);
    if (
      Object.keys(body).some(
        (key) =>
          ![
            'requestId',
            'productKey',
            'organizationId',
            'workspaceId',
            'method',
            'acceptTerms',
            'legalVersion',
            'consentVersion',
          ].includes(key),
      )
    )
      throw new PublicError(
        'Rechargez la page d’abonnement puis choisissez votre formule.',
      );
    await (dependencies.rateLimit ?? enforceCheckoutRateLimit)(request);
    const db = dependencies.database ?? database;
    const prepared = await prepareInitialPrepaidPurchase(
      configuration,
      {
        user,
        requestId: typeof body.requestId === 'string' ? body.requestId : '',
        productKey: body.productKey,
        organizationId: body.organizationId,
        workspaceId: body.workspaceId,
        method: body.method as SwissMethod,
        acceptTerms: body.acceptTerms === true,
        legalVersion:
          typeof body.legalVersion === 'string' ? body.legalVersion : '',
        consentVersion:
          typeof body.consentVersion === 'string'
            ? body.consentVersion
            : undefined,
      },
      { database: db, now: dependencies.now },
    );
    if (prepared.state !== 'prepared')
      return answer('Ce moyen de paiement n’est pas encore disponible.', 503);
    const result = await runInitialPrepaidCheckout(configuration, prepared, {
      database: db,
      now: dependencies.now,
      fetch: dependencies.fetch,
    });
    if (result.state === 'uncertain')
      return Response.json(
        {
          error:
            'Votre paiement doit être vérifié avant de réessayer. Aucun second paiement ne sera créé.',
          purchaseId: prepared.intent.intentId,
        },
        { status: 409, headers },
      );
    if (result.state !== 'payment-page')
      return answer('Ce moyen de paiement n’est pas encore disponible.', 503);
    return Response.json(
      { url: result.url, purchaseId: prepared.intent.intentId },
      { headers },
    );
  } catch (error) {
    if (error instanceof PublicError || error instanceof RequestBodyError)
      return answer(error.message, error.status);
    if (error instanceof PrepaidPurchaseAccessError) {
      if (error.code === 'authentication')
        return answer(
          'Reconnectez-vous à votre compte Zentra pour continuer.',
          401,
        );
      if (error.code === 'target')
        return answer(
          'Choisissez l’entreprise et l’espace Support concernés par cet abonnement.',
          400,
        );
      return answer(
        'Seul le propriétaire de cet espace peut souscrire cet abonnement.',
        403,
      );
    }
    if (error instanceof PrepaidPreparationError) {
      if (error.code === 'terms')
        return answer(
          'Lisez et acceptez les conditions actuelles avant de continuer.',
          400,
        );
      if (error.code === 'request')
        return answer(
          'Rechargez la page d’abonnement puis choisissez votre formule.',
          400,
        );
      if (error.code === 'state')
        return answer(
          'Ce paiement doit être vérifié depuis votre abonnement avant de recommencer.',
          409,
        );
    }
    if (error instanceof PurchaseIntentError && error.code === 'conflict')
      return answer(
        'Un abonnement ou un paiement existe déjà pour cet espace. Retrouvez-le dans votre compte.',
        409,
      );
    console.warn('zentra_payment_purchase', {
      provider: 'postfinance',
      code: 'purchase_unavailable',
    });
    return answer(
      'Le paiement est momentanément indisponible. Aucun nouvel accès n’a été activé.',
      503,
    );
  }
}
