import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { creationUuid } from './workspace-creation';
import { erpClientSchemaVersion } from './erp-schema-capability';
import { UsMailboxError, sameUsMailboxContext, validateUsMailboxContext, type UsMailboxContext } from './us-support-mailbox-contract';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import {
  UsSupportTicketError, validateUsSupportTicketRequest, validateUsSupportRoutingRequest,
  validateUsSupportTicketsProjection, validateUsSupportTicketsHead,
  validateUsSupportTicketMutationResult, validateUsSupportRoutingMutationResult,
  type UsSupportTicketStore,
} from './us-support-ticket-contract';

type Operation = 'read' | 'head' | 'write' | 'routing';
export interface UsSupportTicketDependencies {
  enabled(this: void): Promise<boolean>;
  now(this: void): number;
  member(this: void, request: Request, organizationId: string): Promise<UsMailboxContext>;
  store(this: void): Promise<UsSupportTicketStore>;
  rateLimit?(this: void, request: Request, operation: Operation, key: string): Promise<void>;
  diagnostic?(this: void, event: Readonly<{ operation: Operation; code: string; status: number }>): void;
}
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const codes: Readonly<Record<string, number>> = {
  unauthorized: 401, session_changed: 401, subscription_required: 402, forbidden: 403,
  email_confirmation_required: 403, support_management_required: 403,
  feature_unavailable: 404, ticket_not_found: 404, triage_not_found: 404,
  client_upgrade_required: 409, configuration_changed: 409, support_workspace_required: 409,
  ticket_revision_conflict: 409, ticket_idempotency_conflict: 409, routing_revision_conflict: 409,
  ticket_source_conflict: 409, ticket_source_not_completed: 409, ticket_capacity_exceeded: 409,
  ticket_command_capacity_exceeded: 409,
  ticket_assignee_unavailable: 409, ticket_audit_capacity_exceeded: 409,
  invalid_ticket_request: 422, invalid_routing_request: 422, rate_limited: 429,
  invalid_ticket_record: 503, invalid_support_record: 503, invalid_support_context: 503,
  invalid_mailbox_context: 503, service_unavailable: 503,
};
function denied(code: string, status = codes[code] ?? 503): never { throw new UsSupportTicketError(code, status); }
function failure(error: unknown): { code: string; status: number } {
  if ((error instanceof UsSupportTicketError || error instanceof UsMailboxError || error instanceof UsSupportWorkspaceError) && codes[error.code] === error.status) return { code: error.code, status: error.status };
  if (error instanceof AccountPublicError && [401, 402, 403, 429].includes(error.status)) return { code: error.status === 401 ? 'unauthorized' : error.status === 402 ? 'subscription_required' : error.status === 429 ? 'rate_limited' : 'forbidden', status: error.status };
  if (error instanceof RequestBodyError) return { code: 'invalid_ticket_request', status: 422 };
  return { code: 'service_unavailable', status: 503 };
}
function expected(request: Request, context: UsMailboxContext): void {
  const user = request.headers.get('X-Zentra-Expected-User');
  if (user !== null && user !== context.authority.userId) denied('session_changed');
  if ((context.authority.credential.kind === 'device') !== request.headers.has('Authorization')) denied('unauthorized');
  let schema: ReturnType<typeof erpClientSchemaVersion>;
  try { schema = erpClientSchemaVersion(request); } catch { return denied('invalid_ticket_request'); }
  if (schema !== 4 || context.authority.credential.kind === 'device' && context.authority.credential.supportedSchemaVersion !== 4) denied('client_upgrade_required');
}
function manage(context: UsMailboxContext): void {
  if (!['owner', 'admin'].includes(context.authority.role)) denied('support_management_required');
}
function offset(request: Request, operation: Operation): number {
  const url = new URL(request.url);
  if (operation !== 'read') { if (url.search) denied('invalid_ticket_request'); return 0; }
  if (Array.from(url.searchParams.keys()).some(key => key !== 'offset') || url.searchParams.getAll('offset').length > 1) denied('invalid_ticket_request');
  const value = url.searchParams.get('offset');
  if (value === null) return 0;
  if (!/^(0|[1-9]\d{0,3})$/.test(value) || Number(value) > 500) denied('invalid_ticket_request');
  return Number(value);
}
/** Durable ticket operations only. The store loads actual H3a provenance and
 * enforces current roles/targets/CAS. No provider, mailbox body, mail send,
 * Automation grant, appointment or financial command is a service dependency. */
export function createUsSupportTicketHandlers(dependencies: UsSupportTicketDependencies) {
  function handler(operation: Operation) {
    return async (request: Request, organizationId: string): Promise<Response> => {
      let admitted: UsMailboxContext | undefined;
      const now = () => { const value = dependencies.now(); if (!Number.isSafeInteger(value) || value <= 0) denied('service_unavailable'); return value; };
      async function current(): Promise<UsMailboxContext> {
        if (!admitted) return denied('unauthorized');
        let available = false, gateError: unknown;
        try { available = await dependencies.enabled(); } catch (error) { gateError = error; }
        const next = validateUsMailboxContext(await dependencies.member(request, organizationId), organizationId, now());
        expected(request, next); sameUsMailboxContext(admitted, next);
        if (!available || !await dependencies.enabled()) denied('feature_unavailable');
        if (gateError !== undefined) throw gateError;
        return next;
      }
      try {
        try { creationUuid(organizationId); } catch { denied('invalid_ticket_request'); }
        const write = operation === 'write' || operation === 'routing';
        if (request.method !== (write ? 'POST' : 'GET')) denied('invalid_ticket_request');
        const pageOffset = offset(request, operation);
        if (!await dependencies.enabled()) denied('feature_unavailable');
        admitted = validateUsMailboxContext(await dependencies.member(request, organizationId), organizationId, now()); expected(request, admitted);
        if (write && admitted.authority.credential.kind === 'browser') requireAccountSameOrigin(request);
        await dependencies.rateLimit?.(request, operation, organizationId + ':' + admitted.authority.userId); await current();
        const store = await dependencies.store(); await current();
        if (operation === 'read') {
          const value = await store.read(await current(), pageOffset); const after = await current();
          const projection = validateUsSupportTicketsProjection(value, organizationId, after.workspaceId);
          if (projection.userId !== after.authority.userId || projection.role !== after.authority.role || projection.offset !== pageOffset) denied('invalid_ticket_record');
          return Response.json(projection, { headers });
        }
        if (operation === 'head') {
          const value = await store.head(await current()); const after = await current();
          const head = validateUsSupportTicketsHead(value, organizationId, after.workspaceId);
          if (head.userId !== after.authority.userId || head.role !== after.authority.role) denied('invalid_ticket_record');
          return Response.json(head, { headers });
        }
        if (operation === 'routing') {
          manage(await current());
          const input = validateUsSupportRoutingRequest(await readJsonObjectWithinLimit(request, 16_384));
          const value = await store.saveRouting(await current(), input, current); const after = await current(); manage(after);
          const result = validateUsSupportRoutingMutationResult(value, organizationId, after.workspaceId);
          if (result.receipt.requestId !== input.requestId || result.receipt.actorUserId !== after.authority.userId || result.receipt.revision !== input.expectedRevision + 1) denied('invalid_ticket_record');
          return Response.json(result, { headers });
        }
        const input = validateUsSupportTicketRequest(await readJsonObjectWithinLimit(request, 8192));
        const context = await current();
        if (input.action !== 'set_status') manage(context);
        else if (!['owner', 'admin', 'member'].includes(context.authority.role)) denied('support_management_required');
        const value = await store.commit(context, input, current); const after = await current();
        const result = validateUsSupportTicketMutationResult(value, organizationId, after.workspaceId);
        if (result.receipt.requestId !== input.requestId || result.receipt.actorUserId !== after.authority.userId || result.receipt.action !== input.action
          || input.action !== 'create' && (result.receipt.entityId !== input.ticketId || result.receipt.revision !== input.expectedRevision + 1)) denied('invalid_ticket_record');
        return Response.json(result, { headers });
      } catch (error) {
        let outgoing = failure(error);
        if (admitted) { try { await current(); } catch (late) { const denial = failure(late); if ([401, 402, 403, 404].includes(denial.status)) outgoing = denial; } }
        try { dependencies.diagnostic?.({ operation, ...outgoing }); } catch { /* No ticket, source, decision or credential in diagnostics. */ }
        return Response.json({ error: outgoing.code }, { status: outgoing.status, headers });
      }
    };
  }
  return { read: handler('read'), head: handler('head'), write: handler('write'), routing: handler('routing') };
}
