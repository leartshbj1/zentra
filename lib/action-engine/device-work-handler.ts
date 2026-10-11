import {
  accountNoStoreHeaders,
  enforceSyncRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { readTextBodyWithinLimit, RequestBodyError } from '@/lib/request-body';
import { parseFlatDeviceJson } from './device-flat-json';
import { discoverDeviceSupportQuoteWork } from './device-work-discovery';
import { prepareDeviceSupportQuote } from './device-preparation';
import {
  captureWorkRequest,
  encodeDiscoveredWork,
  encodePreparedWork,
} from './device-work-contract';
import { QuoteLedgerError } from './ledger-types';
import { QuotePreparationError } from './intake-types';
import { ActionEngineError } from './types';

// A dedicated work envelope can carry the 4096-character discovery cursor.
// A10 execution keeps its existing 2048-byte limit; account/global limits stay.
const MAX_WORK_REQUEST_BYTES = 8192;
type FailureCode =
  | 'invalid_request'
  | 'forbidden'
  | 'stale_plan'
  | 'review_required'
  | 'busy'
  | 'uncertain'
  | 'service_unavailable';

function failure(code: FailureCode, status: number): Response {
  const headers = new Headers(accountNoStoreHeaders());
  if (status === 405) headers.set('Allow', 'POST');
  const message =
    code === 'forbidden'
      ? 'Reconnectez votre compte ou vérifiez vos accès à cette entreprise.'
      : code === 'stale_plan'
        ? 'Les informations ont changé. Vérifiez la proposition.'
        : code === 'busy'
          ? 'Cette demande est déjà en cours de préparation.'
          : code === 'uncertain'
            ? 'Cette préparation doit être vérifiée. Elle ne sera pas relancée automatiquement.'
            : code === 'review_required'
              ? 'Cette demande doit être vérifiée. Vos données sont conservées.'
              : code === 'invalid_request'
                ? 'La demande Automation est invalide.'
                : 'Automation est momentanément indisponible. Vos données sont conservées.';
  return Response.json(
    { schemaVersion: 1, state: 'error', code, message },
    { status, headers },
  );
}

/** Private work bridge to real A12 discovery/preparation. No app/api route,
 * native IPC, scheduler or worker calls it before native/staging validation.
 * Discovery gives selectors; preparation gives a closed proposal summary.
 * Neither performs a native write, confirms, sends or issues a document. */
export async function handleDeviceQuoteWork(
  request: Request,
): Promise<Response> {
  try {
    if (request.method !== 'POST') return failure('invalid_request', 405);
    if (new URL(request.url).search) return failure('invalid_request', 400);
    const headers = new Headers(request.headers);
    if (!/^Bearer [^\s]+$/.test(headers.get('Authorization') ?? ''))
      return failure('forbidden', 401);
    const captured = new Request(request.url, { headers });
    const session = await requireDeviceSession(captured);
    await enforceSyncRateLimit(
      captured,
      'action-engine-device-work',
      session.organizationId + ':' + session.installationId,
      500,
    );
    if (
      headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new RequestBodyError('Le corps doit être au format JSON.', 415);
    const text = await readTextBodyWithinLimit(request, MAX_WORK_REQUEST_BYTES);
    const input = (() => {
      try {
        return captureWorkRequest(parseFlatDeviceJson(text));
      } catch {
        throw new RequestBodyError('La demande Automation est invalide.', 400);
      }
    })();
    const result =
      input.operation === 'discover'
        ? encodeDiscoveredWork(
            await discoverDeviceSupportQuoteWork(captured, {
              limit: input.limit,
              cursor: input.cursor,
            }),
            input.limit,
          )
        : encodePreparedWork(
            await prepareDeviceSupportQuote(captured, input.sourceId),
            { organizationId: session.organizationId, userId: session.userId },
            input.sourceId,
          );
    return Response.json(result, { headers: accountNoStoreHeaders() });
  } catch (error) {
    if (error instanceof RequestBodyError)
      return failure('invalid_request', error.status);
    if (error instanceof AccountPublicError) {
      if ([401, 402, 403].includes(error.status))
        return failure('forbidden', error.status === 401 ? 401 : 403);
      return failure('service_unavailable', error.status === 429 ? 429 : 503);
    }
    if (error instanceof QuotePreparationError) {
      if (error.code === 'held') return failure('busy', 409);
      if (error.code === 'uncertain') return failure('uncertain', 409);
      if (error.code === 'forbidden') return failure('forbidden', 403);
      if (error.code === 'service_unavailable')
        return failure('service_unavailable', 503);
      return failure('review_required', 409);
    }
    if (error instanceof ActionEngineError) {
      if (error.code === 'forbidden') return failure('forbidden', 403);
      return failure(
        error.code === 'stale_plan' ? 'stale_plan' : 'review_required',
        409,
      );
    }
    if (error instanceof QuoteLedgerError) {
      if (error.code === 'forbidden') return failure('forbidden', 403);
      return failure(
        error.code === 'service_unavailable'
          ? 'service_unavailable'
          : 'review_required',
        error.code === 'service_unavailable' ? 503 : 409,
      );
    }
    return failure('service_unavailable', 503);
  }
}
