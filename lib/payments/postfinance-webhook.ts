import { database, runtimeValue } from '@/lib/runtime';
import { RequestBodyError, readBytesBodyWithinLimit } from '@/lib/request-body';
import {
  acceptWebhook,
  CheckoutUnavailable,
  CheckoutApiError,
  PostFinanceCheckoutClient,
} from './postfinance-client';
import {
  D1PostFinanceWebhookInbox,
  PostFinanceJournalError,
} from './postfinance-store';
import {
  postFinanceWebhookConfiguration,
  type PostFinanceWebhookBinding,
} from './postfinance-runtime';

const headers = { 'Cache-Control': 'no-store, max-age=0' };
const signaturePattern =
  /^algorithm=SHA256withECDSA,\s*keyId=([A-Za-z0-9-]{1,128}),\s*signature=([A-Za-z0-9+/=]+)$/;
class ReceiptUnavailable extends Error {}

/** Ack only after authenticated bytes and durable queue insertion. Never use
 * the webhook's state or a browser return to grant a paid period. */
export async function receivePostFinanceWebhook(
  request: Request,
  dependencies: {
    read?: (name: PostFinanceWebhookBinding) => string;
    database?: () => Pick<D1Database, 'prepare'>;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<Response> {
  try {
    const config = postFinanceWebhookConfiguration(
      dependencies.read ?? runtimeValue,
    );
    if (!config)
      throw new CheckoutUnavailable('PostFinance webhook receipt is disabled.');
    if (
      request.headers
        .get('Content-Type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    )
      throw new RequestBodyError('Le corps doit être au format JSON.', 415);
    const signature = request.headers.get('x-signature') ?? '';
    if (signature.length > 1024 || !signaturePattern.test(signature))
      return Response.json(
        { error: 'Confirmation de paiement non authentifiée.' },
        { status: 401, headers },
      );
    const bytes = await readBytesBodyWithinLimit(request, 65_536);
    const client = new PostFinanceCheckoutClient(config.connection, {
      fetch: dependencies.fetch,
      now: dependencies.now,
    });
    // Construct the inbox only after authentication. Invalid requests must not
    // consume database work or look up data for another company.
    let inbox: D1PostFinanceWebhookInbox | undefined;
    const result = await acceptWebhook(bytes, signature, {
      apiOrigin: config.apiOrigin,
      spaceId: config.spaceId,
      allowedListenerIds: config.listeners.map((listener) => listener.id),
      now: dependencies.now,
      keyResolver: async (keyId) => {
        try {
          return await client.webhookPublicKey(keyId);
        } catch (error) {
          if (error instanceof CheckoutApiError && error.status === 404)
            throw new PostFinanceJournalError(
              'invalid_event',
              'Unrecognized webhook key.',
            );
          throw new ReceiptUnavailable();
        }
      },
      inbox: {
        acceptOnce: async (scope, event) => {
          // Entity/Space checks belong to authentication, before storage errors
          // become retriable. Normalize the signed event with the same store rules.
          const listener = config.listeners.find(
            (value) => value.id === event.webhookListenerId,
          );
          if (
            !listener ||
            event.listenerEntityId !== listener.entityId ||
            (listener.technicalName !== undefined &&
              event.listenerEntityTechnicalName !== listener.technicalName)
          )
            throw new Error('Unapproved webhook entity.');
          try {
            inbox ??= new D1PostFinanceWebhookInbox(
              (dependencies.database ?? database)(),
              config,
              dependencies.now
                ? () => Math.floor(dependencies.now!() / 1000)
                : undefined,
            );
            return await inbox.acceptOnce(scope, event);
          } catch (error) {
            if (error instanceof PostFinanceJournalError) throw error;
            throw new ReceiptUnavailable();
          }
        },
      },
    });
    return Response.json(
      { received: true, duplicate: result.duplicate },
      { headers },
    );
  } catch (error) {
    if (error instanceof PostFinanceJournalError)
      return Response.json(
        { error: 'Confirmation de paiement refusée.' },
        { status: error.kind === 'replay_conflict' ? 409 : 401, headers },
      );
    if (error instanceof RequestBodyError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers },
      );
    if (
      error instanceof CheckoutUnavailable ||
      error instanceof ReceiptUnavailable
    ) {
      // Fixed diagnostic fields only. No exception, request, key, ID or body.
      console.warn('zentra_payment_receipt', {
        provider: 'postfinance',
        code: 'receipt_unavailable',
      });
      return Response.json(
        { error: 'Confirmation de paiement temporairement indisponible.' },
        { status: 503, headers: { ...headers, 'Retry-After': '60' } },
      );
    }
    return Response.json(
      { error: 'Confirmation de paiement non authentifiée.' },
      { status: 401, headers },
    );
  }
}
