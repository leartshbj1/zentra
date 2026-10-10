import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { creationUuid } from './workspace-creation';
import { erpClientSchemaVersion } from './erp-schema-capability';
import { UsMailboxError, sameUsMailboxContext, validateUsMailboxContext, type UsMailboxContext } from './us-support-mailbox-contract';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsSupportWorkerError, validateUsSupportWorkerManageRequest, validateUsSupportWorkerManageResult, validateUsSupportWorkerProjection, type UsSupportWorkerStore } from './us-support-worker-contract';

export interface UsSupportWorkerHandlerDependencies {
  enabled(this: void): Promise<boolean>; now(this: void): number;
  member(this: void, request: Request, organizationId: string): Promise<UsMailboxContext>;
  store(this: void): Promise<UsSupportWorkerStore>;
  rateLimit?(this: void, request: Request, operation: 'read' | 'manage', key: string): Promise<void>;
  diagnostic?(this: void, event: Readonly<{ operation: 'read' | 'manage'; code: string; status: number }>): void;
}
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const codes: Readonly<Record<string, number>> = { unauthorized: 401, session_changed: 401, subscription_required: 402, forbidden: 403, email_confirmation_required: 403, support_management_required: 403, feature_unavailable: 404, client_upgrade_required: 409, configuration_changed: 409, worker_revision_conflict: 409, worker_idempotency_conflict: 409, worker_policy_changed: 409, worker_connection_changed: 409, mailbox_connection_required: 409, mailbox_revision_conflict: 409, worker_capacity_exceeded: 409, invalid_worker_request: 422, rate_limited: 429, service_unavailable: 503, invalid_worker_record: 503, invalid_support_context: 503, invalid_mailbox_context: 503, invalid_support_record: 503 };
function failure(error: unknown) {
  if ((error instanceof UsSupportWorkerError || error instanceof UsMailboxError || error instanceof UsSupportWorkspaceError) && codes[error.code] === error.status) return { code: error.code, status: error.status };
  if (error instanceof AccountPublicError && [401, 402, 403, 429].includes(error.status)) return { code: error.status === 401 ? 'unauthorized' : error.status === 402 ? 'subscription_required' : error.status === 429 ? 'rate_limited' : 'forbidden', status: error.status };
  if (error instanceof RequestBodyError) return { code: 'invalid_worker_request', status: 422 };
  return { code: 'service_unavailable', status: 503 };
}
function expected(request: Request, c: UsMailboxContext) {
  if (request.headers.get('X-Zentra-Expected-User') !== null && request.headers.get('X-Zentra-Expected-User') !== c.authority.userId) throw new UsSupportWorkerError('session_changed', 401);
  if ((c.authority.credential.kind === 'device') !== request.headers.has('Authorization')) throw new UsSupportWorkerError('unauthorized', 401);
  if (erpClientSchemaVersion(request) !== 4 || c.authority.credential.kind === 'device' && c.authority.credential.supportedSchemaVersion !== 4) throw new UsSupportWorkerError('client_upgrade_required', 409);
}
/** Interactive delegation management only. No public lease/worker-context or
 * scheduler trigger endpoint exists. POST always requires current human Auth. */
export function createUsSupportWorkerHandlers(d: UsSupportWorkerHandlerDependencies) {
  const run = async (request: Request, organizationId: string, operation: 'read' | 'manage') => {
    let admitted: UsMailboxContext | undefined;
    const current = async () => {
      if (!admitted) throw new UsSupportWorkerError('unauthorized', 401);
      const available = await d.enabled(), c = validateUsMailboxContext(await d.member(request, organizationId), organizationId, d.now());
      expected(request, c); sameUsMailboxContext(admitted, c);
      if (!available || !await d.enabled()) throw new UsSupportWorkerError('feature_unavailable', 404);
      return c;
    };
    try {
      try { creationUuid(organizationId); } catch { throw new UsSupportWorkerError('invalid_worker_request', 422); }
      if (new URL(request.url).search || request.method !== (operation === 'read' ? 'GET' : 'POST')) throw new UsSupportWorkerError('invalid_worker_request', 422);
      if (!await d.enabled()) throw new UsSupportWorkerError('feature_unavailable', 404);
      admitted = validateUsMailboxContext(await d.member(request, organizationId), organizationId, d.now()); expected(request, admitted);
      if (operation === 'manage') {
        if (!['owner', 'admin'].includes(admitted.authority.role)) throw new UsSupportWorkerError('support_management_required', 403);
        if (admitted.authority.credential.kind === 'browser') requireAccountSameOrigin(request);
      }
      await d.rateLimit?.(request, operation, organizationId + ':' + admitted.authority.userId); await current();
      const store = await d.store(); await current();
      if (operation === 'read') {
        const value = validateUsSupportWorkerProjection(await store.read(await current()), organizationId, admitted.workspaceId), c = await current();
        if (value.userId !== c.authority.userId || value.role !== c.authority.role) throw new UsSupportWorkerError('invalid_worker_record', 503);
        return Response.json(value, { headers });
      }
      const input = validateUsSupportWorkerManageRequest(await readJsonObjectWithinLimit(request, 8192));
      const value = validateUsSupportWorkerManageResult(await store.manage(await current(), input, current), organizationId, admitted.workspaceId), c = await current();
      if (value.receipt.requestId !== input.requestId || value.receipt.actorUserId !== c.authority.userId || value.projection.userId !== c.authority.userId || value.projection.role !== c.authority.role || value.receipt.revision !== input.expectedRevision + 1) throw new UsSupportWorkerError('invalid_worker_record', 503);
      return Response.json(value, { headers });
    } catch (error) {
      let safe = failure(error);
      if (admitted) { try { await current(); } catch (late) { const next = failure(late); if ([401, 402, 403, 404].includes(next.status)) safe = next; } }
      try { d.diagnostic?.({ operation, ...safe }); } catch { /* A diagnostic cannot replace the public response. */ }
      return Response.json({ error: safe.code }, { status: safe.status, headers });
    }
  };
  return { read: (request: Request, organizationId: string) => run(request, organizationId, 'read'), manage: (request: Request, organizationId: string) => run(request, organizationId, 'manage') };
}
