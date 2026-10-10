import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { creationUuid } from './workspace-creation';
import {
  UsSupportWorkspaceError, sameUsSupportWorkspaceContext, validateUsSupportWorkspace,
  validateUsSupportWorkspaceContext, validateUsSupportWorkspaceProjection,
  validateUsSupportWorkspaceRequest, validateUsSupportWorkspaceResult,
  type UsSupportWorkspace, type UsSupportWorkspaceContext, type UsSupportWorkspaceProjection,
  type UsSupportWorkspaceStore,
} from './us-support-workspace-contract';

export interface UsSupportWorkspaceDependencies {
  enabled(): Promise<boolean>; now(): number;
  member(request: Request, organizationId: string): Promise<UsSupportWorkspaceContext>;
  store(): Promise<UsSupportWorkspaceStore>;
  rateLimit?(request: Request, operation: 'read' | 'create', key: string): Promise<void>;
  diagnostic?(event: Readonly<{ operation: 'read' | 'create'; code: string; status: number }>): void;
}
const codes: Readonly<Record<string, number>> = {
  unauthorized: 401, session_changed: 401, subscription_required: 402, forbidden: 403,
  email_confirmation_required: 403, support_management_required: 403, tenant_mismatch: 403,
  feature_unavailable: 404, support_workspace_conflict: 409, support_idempotency_conflict: 409,
  configuration_changed: 409, invalid_support_request: 422, rate_limited: 429,
  invalid_support_context: 503, invalid_support_record: 503, service_unavailable: 503,
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function safeError(error: unknown): { code: string; status: number } {
  if (error instanceof UsSupportWorkspaceError && codes[error.code] === error.status) return { code: error.code, status: error.status };
  if (error instanceof AccountPublicError && [401,403,429].includes(error.status)) return { code: error.status === 401 ? 'unauthorized' : error.status === 429 ? 'rate_limited' : 'forbidden', status: error.status };
  if (error instanceof RequestBodyError) return { code: 'invalid_support_request', status: 422 };
  return { code: 'service_unavailable', status: 503 };
}
function expectedUser(request: Request, context: UsSupportWorkspaceContext): void {
  const expected = request.headers.get('X-Zentra-Expected-User');
  if (expected !== null && expected !== context.userId) throw new UsSupportWorkspaceError('session_changed', 401);
  if ((context.credential.kind === 'device') !== request.headers.has('Authorization')) throw new UsSupportWorkspaceError('unauthorized', 401);
}
function projection(context: UsSupportWorkspaceContext, workspace: UsSupportWorkspace | null): UsSupportWorkspaceProjection {
  if (workspace && workspace.ownerUserId !== context.ownerUserId) throw new UsSupportWorkspaceError('invalid_support_record', 503);
  return validateUsSupportWorkspaceProjection({ schemaVersion: 1, organizationId: context.organizationId,
    userId: context.userId, role: context.role, canCreate: !workspace && ['owner','admin'].includes(context.role),
    stage: 'registry_only', mailboxAvailable: false, classificationAvailable: false, workspace }, context.organizationId);
}
/** Private preparation only. Never grants a mailbox, classification budget,
 * legacy Support access, financial action or entitlement on its own. */
export function createUsSupportWorkspaceHandlers(dependencies: UsSupportWorkspaceDependencies) {
  async function run(request: Request, organizationId: string, operation: 'read' | 'create'): Promise<Response> {
    let admitted: UsSupportWorkspaceContext | undefined;
    const clock = () => { const now = dependencies.now(); if (!Number.isSafeInteger(now) || now <= 0) throw new UsSupportWorkspaceError('service_unavailable', 503); return now; };
    async function current(): Promise<UsSupportWorkspaceContext> {
      if (!admitted) throw new UsSupportWorkspaceError('unauthorized', 401);
      const next = validateUsSupportWorkspaceContext(await dependencies.member(request, organizationId), organizationId, clock());
      expectedUser(request, next); sameUsSupportWorkspaceContext(admitted, next);
      if (!await dependencies.enabled()) throw new UsSupportWorkspaceError('feature_unavailable', 404);
      return next;
    }
    try {
      try { creationUuid(organizationId); } catch { throw new UsSupportWorkspaceError('invalid_support_request', 422); }
      if (new URL(request.url).search || request.method !== (operation === 'read' ? 'GET' : 'POST')) throw new UsSupportWorkspaceError('invalid_support_request', 422);
      if (!await dependencies.enabled()) throw new UsSupportWorkspaceError('feature_unavailable', 404);
      admitted = validateUsSupportWorkspaceContext(await dependencies.member(request, organizationId), organizationId, clock());
      expectedUser(request, admitted);
      if (operation === 'create') {
        if (admitted.credential.kind === 'browser') requireAccountSameOrigin(request);
        if (!['owner','admin'].includes(admitted.role)) throw new UsSupportWorkspaceError('support_management_required', 403);
      }
      await dependencies.rateLimit?.(request, operation, admitted.organizationId + ':' + admitted.userId);
      const store = await dependencies.store();
      if (operation === 'read') {
        const before = await current(), result = await store.read(before);
        const workspace = result === null ? null : validateUsSupportWorkspace(result, organizationId);
        const after = await current();
        return Response.json(projection(after, workspace), { headers });
      }
      const input = validateUsSupportWorkspaceRequest(await readJsonObjectWithinLimit(request, 4096));
      const before = await current(), result = validateUsSupportWorkspaceResult(await store.create(before, input, current), organizationId);
      if (result.receipt.actorUserId !== before.userId || result.receipt.requestId !== input.requestId || result.workspace.name !== input.name) throw new UsSupportWorkspaceError('invalid_support_record', 503);
      const after = await current();
      return Response.json({ projection: projection(after, result.workspace), receipt: result.receipt, replayed: result.replayed }, { headers });
    } catch (error) {
      let safe = safeError(error);
      if (admitted) { try { await current(); } catch (delayed) { const fresh = safeError(delayed); if ([401,402,403,404].includes(fresh.status)) safe = fresh; } }
      try { dependencies.diagnostic?.({ operation, ...safe }); } catch { /* Diagnostics cannot alter public failure. */ }
      return Response.json({ error: safe.code }, { status: safe.status, headers });
    }
  }
  return { read: (request: Request, org: string) => run(request, org, 'read'), create: (request: Request, org: string) => run(request, org, 'create') };
}
