import {
  accountNoStoreHeaders,
  enforceSyncRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { readTextBodyWithinLimit, RequestBodyError } from '@/lib/request-body';
import { reserveDeviceSupportQuote } from './device-reservation';
import { confirmDeviceSupportQuote } from './device-confirmation';
import {
  captureRequest,
  encodeReservation,
  encodeConfirmation,
} from './device-execution-contract';
import { ActionEngineError } from './types';
import { QuoteLedgerError } from './ledger-types';
import { CanonicalQuoteError } from './canonical-quote';
import { parseFlatDeviceJson } from './device-flat-json';

const MAX_REQUEST_BYTES = 2048;

function invalid(): never {
  throw new RequestBodyError('La demande Automation est invalide.', 400);
}

function failure(code: string, status: number, retryAfter?: string): Response {
  const headers = new Headers(accountNoStoreHeaders());
  if (status === 405) headers.set('Allow', 'POST');
  if (retryAfter && /^\d{1,6}$/.test(retryAfter))
    headers.set('Retry-After', retryAfter);
  const message =
    code === 'forbidden'
      ? 'Reconnectez votre compte ou vérifiez vos accès à cette entreprise.'
      : code === 'stale_plan'
        ? 'Les informations ont changé. Vérifiez la proposition.'
        : code === 'review_required'
          ? 'Ce devis doit être vérifié. Vos données sont conservées.'
          : code === 'invalid_request'
            ? 'La demande Automation est invalide.'
            : 'Automation est momentanément indisponible. Vos données sont conservées.';
  return Response.json(
    { schemaVersion: 1, state: 'error', code, message },
    { status, headers },
  );
}

/** Real A8/A7 handler, intentionally NOT exported from an app/api route.
 * No UI/IPC/Support trigger calls it until native and staging validation.
 * Device bearer authentication is mandatory; a website cookie is insufficient.
 * It has no provider/AI, issue, send, payment or generic SQL operation.
 */
export async function handleDeviceQuoteExecution(
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
      'action-engine-device-execution',
      session.organizationId + ':' + session.installationId,
      500,
    );
    if (
      headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new RequestBodyError('Le corps doit être au format JSON.', 415);
    const text = await readTextBodyWithinLimit(request, MAX_REQUEST_BYTES);
    const input = (() => {
      try {
        return captureRequest(parseFlatDeviceJson(text));
      } catch (error) {
        if (error instanceof RequestBodyError) throw error;
        return invalid();
      }
    })();
    // Encoding is synchronous: no read-only await after A8's final full fence.
    const result =
      input.operation === 'reserve'
        ? encodeReservation(
            await reserveDeviceSupportQuote(captured, {
              sourceId: input.sourceId,
              proposalId: input.proposalId,
            }),
          )
        : encodeConfirmation(
            {
              sourceId: input.sourceId,
              proposalId: input.proposalId,
              reservationId: input.reservationId,
              publicationSnapshotId: input.publicationSnapshotId,
            },
            await confirmDeviceSupportQuote(captured, {
              sourceId: input.sourceId,
              proposalId: input.proposalId,
              reservationId: input.reservationId,
              publicationSnapshotId: input.publicationSnapshotId,
            }),
          );
    return Response.json(result, { headers: accountNoStoreHeaders() });
  } catch (error) {
    if (error instanceof RequestBodyError)
      return failure('invalid_request', error.status);
    if (error instanceof AccountPublicError)
      return failure(
        error.status === 429
          ? 'service_unavailable'
          : [401, 402, 403].includes(error.status)
            ? 'forbidden'
            : 'service_unavailable',
        error.status === 429
          ? 429
          : [401, 402, 403].includes(error.status)
            ? error.status === 401
              ? 401
              : 403
            : 503,
      );
    if (error instanceof ActionEngineError)
      return failure(
        error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'stale_plan'
            ? 'stale_plan'
            : 'review_required',
        error.code === 'forbidden' ? 403 : 409,
      );
    if (
      error instanceof QuoteLedgerError &&
      error.code !== 'service_unavailable'
    )
      return failure(
        error.code === 'forbidden' ? 'forbidden' : 'review_required',
        error.code === 'forbidden' ? 403 : 409,
      );
    if (error instanceof CanonicalQuoteError)
      return failure('review_required', 409);
    return failure('service_unavailable', 503);
  }
}
