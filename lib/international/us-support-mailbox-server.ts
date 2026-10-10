import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { decryptSecret, encryptSecret } from '../support/crypto';
import { creationUuid } from './workspace-creation';
import { sha256Hex } from './canonical-hash';
import {
  UsMailboxError, hashUsMailboxRequest, sameUsMailboxContext, usMailboxEncryptionContext,
  validateUsMailboxContext, validateUsMailboxPrivateCommand, validateUsMailboxProjection,
  validateUsMailboxReceipt, validateUsMailboxResult, validateUsMailboxState, validateUsMailboxRequest,
  type UsMailboxContext, type UsMailboxConnection, type UsMailboxProjection, type UsMailboxStore,
} from './us-support-mailbox-contract';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { validateUsMailboxMessages, validateUsMailboxOffset, type UsMailboxMessage } from './us-support-mailbox-messages';

export interface UsMailboxDependencies {
  enabled(this: void): Promise<boolean>; now(this: void): number; member(this: void, request: Request, org: string): Promise<UsMailboxContext>;
  store(this: void): Promise<UsMailboxStore>; encryptionKey(this: void): Promise<string>;
  verify(this: void, email: string, token: string, check: () => Promise<unknown>): Promise<{ mailboxId: string; folderId: string }>;
  messages(this: void, context: UsMailboxContext, connection: UsMailboxConnection, token: string, offset: number, check: () => Promise<unknown>): Promise<{ messages: readonly UsMailboxMessage[]; nextOffset: number | null }>;
  newId?(this: void): string; rateLimit?(this: void, request: Request, operation: Operation, key: string): Promise<void>;
  diagnostic?(this: void, event: Readonly<{ operation: Operation; code: string; status: number }>): void;
}
type Operation = 'read' | 'write' | 'messages';
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const codes: Readonly<Record<string, number>> = {
  unauthorized: 401, session_changed: 401, subscription_required: 402, forbidden: 403, email_confirmation_required: 403,
  support_management_required: 403, tenant_mismatch: 403, feature_unavailable: 404,
  configuration_changed: 409, mailbox_revision_conflict: 409, mailbox_idempotency_conflict: 409, mailbox_verification_expired: 409,
  mailbox_connection_required: 409, support_workspace_required: 409,
  invalid_mailbox_request: 422, mailbox_credentials_rejected: 422, rate_limited: 429,
  invalid_mailbox_context: 503, invalid_mailbox_record: 503, invalid_support_context: 503,
  invalid_support_record: 503, service_unavailable: 503, mailbox_provider_unavailable: 503, mailbox_page_unavailable: 503,
};
function safe(error: unknown) {
  if ((error instanceof UsMailboxError || error instanceof UsSupportWorkspaceError) && codes[error.code] === error.status) return { code: error.code, status: error.status };
  if (error instanceof AccountPublicError && [401,403,429].includes(error.status)) return { code: error.status === 401 ? 'unauthorized' : error.status === 429 ? 'rate_limited' : 'forbidden', status: error.status };
  if (error instanceof RequestBodyError) return { code: 'invalid_mailbox_request', status: 422 };
  return { code: 'service_unavailable', status: 503 };
}
function expected(request: Request, context: UsMailboxContext) {
  const user = request.headers.get('X-Zentra-Expected-User');
  if (user !== null && user !== context.authority.userId) throw new UsMailboxError('session_changed', 401);
  if ((context.authority.credential.kind === 'device') !== request.headers.has('Authorization')) throw new UsMailboxError('unauthorized', 401);
}
function manage(context: UsMailboxContext) { if (!['owner','admin'].includes(context.authority.role)) throw new UsMailboxError('support_management_required', 403); }
function project(context: UsMailboxContext, input: unknown): UsMailboxProjection {
  const state = validateUsMailboxState(input, context.authority.organizationId);
  if (state.workspaceId !== context.workspaceId) throw new UsMailboxError('invalid_mailbox_record', 503);
  const c = state.currentConnection;
  return validateUsMailboxProjection({ schemaVersion: 1, organizationId: context.authority.organizationId, userId: context.authority.userId,
    role: context.authority.role, workspaceId: context.workspaceId, revision: state.revision, canManage: ['owner','admin'].includes(context.authority.role),
    connection: c ? { id: c.id, provider: c.provider, email: c.email, verifiedAt: c.verifiedAt } : null }, context.authority.organizationId);
}
/** Tenant-scoped preparation and explicit metadata reading only. No ingestion,
 * classification, SMTP send, acknowledgement or automatic financial effect. */
export function createUsMailboxHandlers(dependencies: UsMailboxDependencies) {
  async function run(request: Request, org: string, operation: Operation): Promise<Response> {
    let admitted: UsMailboxContext | undefined, writeAttempted = false;
    function now() { const value = dependencies.now(); if (!Number.isSafeInteger(value) || value <= 0) throw new UsMailboxError('service_unavailable', 503); return value; }
    async function current(): Promise<UsMailboxContext> {
      if (!admitted) throw new UsMailboxError('unauthorized', 401);
      const next = validateUsMailboxContext(await dependencies.member(request, org), org, now());
      expected(request, next); sameUsMailboxContext(admitted, next);
      if (!await dependencies.enabled()) throw new UsMailboxError('feature_unavailable', 404);
      if (operation !== 'read') manage(next);
      return next;
    }
    try {
      try { creationUuid(org); } catch { throw new UsMailboxError('invalid_mailbox_request', 422); }
      const url = new URL(request.url);
      if (request.method !== (operation === 'write' ? 'POST' : 'GET') || operation !== 'messages' && url.search) throw new UsMailboxError('invalid_mailbox_request', 422);
      if (operation === 'messages' && (Array.from(url.searchParams.keys()).some(k => k !== 'offset') || url.searchParams.getAll('offset').length > 1)) throw new UsMailboxError('invalid_mailbox_request', 422);
      const offset = operation === 'messages' ? validateUsMailboxOffset(url.searchParams.get('offset')) : 0;
      if (!await dependencies.enabled()) throw new UsMailboxError('feature_unavailable', 404);
      admitted = validateUsMailboxContext(await dependencies.member(request, org), org, now()); expected(request, admitted);
      if (operation !== 'read') manage(admitted);
      if (operation === 'write' && admitted.authority.credential.kind === 'browser') requireAccountSameOrigin(request);
      await dependencies.rateLimit?.(request, operation, org + ':' + admitted.authority.userId);
      const store = await dependencies.store();
      if (operation === 'read') {
        const state = await store.read(await current()), after = await current();
        return Response.json(project(after, state), { headers });
      }
      if (operation === 'write') {
        const input = validateUsMailboxRequest(await readJsonObjectWithinLimit(request, 12_288));
        const context = await current(), hash = await hashUsMailboxRequest(org, context.authority.userId, input);
        const existing = await store.receipt(await current(), input.requestId, hash); await current();
        if (existing) {
          const receipt = validateUsMailboxReceipt(existing, org);
          if (receipt.actorUserId !== context.authority.userId || receipt.requestId !== input.requestId || receipt.requestHash !== hash || receipt.workspaceId !== context.workspaceId || receipt.action !== input.action || receipt.expectedRevision !== input.expectedRevision) throw new UsMailboxError('invalid_mailbox_record', 503);
          const state = await store.read(await current()), after = await current();
          return Response.json({ projection: project(after, state), receipt, replayed: true }, { headers });
        }
        const head = validateUsMailboxState(await store.read(await current()), org); await current();
        if (head.workspaceId !== context.workspaceId) throw new UsMailboxError('invalid_mailbox_record', 503);
        if (head.revision !== input.expectedRevision) throw new UsMailboxError('mailbox_revision_conflict', 409);
        let command;
        if (input.action === 'connect') {
          // Key stays inside this request. The durable command contains only an
          // authenticated ciphertext and its private material digest.
          const source = await dependencies.verify(input.email, input.token, current); await current();
          const connectionId = (dependencies.newId ?? (() => crypto.randomUUID()))(), verifiedAt = now();
          const key = await dependencies.encryptionKey(); await current();
          const ciphertext = await encryptSecret(key, input.token, usMailboxEncryptionContext(context, connectionId, input.expectedRevision + 1)); await current();
          command = validateUsMailboxPrivateCommand({ schemaVersion: 1, requestId: input.requestId, expectedRevision: input.expectedRevision, action: 'connect', email: input.email,
            tokenSha256: await sha256Hex(input.token), connectionId, provider: 'infomaniak', mailboxId: source.mailboxId, folderId: source.folderId, credentialsCiphertext: ciphertext, verifiedAt });
        } else command = validateUsMailboxPrivateCommand(input);
        const committing = await current(); writeAttempted = true;
        const result = validateUsMailboxResult(await store.commit(committing, command, current), org); const after = await current();
        if (result.receipt.requestId !== input.requestId || result.receipt.actorUserId !== after.authority.userId || result.receipt.workspaceId !== after.workspaceId || result.receipt.requestHash !== hash || result.receipt.action !== input.action || result.receipt.expectedRevision !== input.expectedRevision) throw new UsMailboxError('invalid_mailbox_record', 503);
        return Response.json({ projection: project(after, result.state), receipt: result.receipt, replayed: result.replayed }, { headers });
      }
      const context = await current(), head = validateUsMailboxState(await store.read(context), org); await current();
      if (head.workspaceId !== context.workspaceId) throw new UsMailboxError('invalid_mailbox_record', 503);
      const connection = head.currentConnection;
      if (!connection || !connection.credentialsCiphertext) throw new UsMailboxError('mailbox_connection_required', 409);
      async function connected() {
        const fresh = await current(), latest = validateUsMailboxState(await store.read(fresh), org); await current();
        if (latest.workspaceId !== context.workspaceId || latest.revision !== head.revision || latest.currentConnection?.id !== connection!.id || latest.currentConnection.credentialsCiphertext !== connection!.credentialsCiphertext) throw new UsMailboxError('mailbox_revision_conflict', 409);
        return fresh;
      }
      const key = await dependencies.encryptionKey(); await connected();
      const token = await decryptSecret(key, connection.credentialsCiphertext, usMailboxEncryptionContext(context, connection.id, connection.revision)); await connected();
      if (await sha256Hex(token) !== connection.tokenSha256) throw new UsMailboxError('invalid_mailbox_record', 503);
      const page = await dependencies.messages(context, connection, token, offset, connected); await connected();
      const result = validateUsMailboxMessages({ schemaVersion: 1, organizationId: org, userId: context.authority.userId, role: context.authority.role,
        workspaceId: context.workspaceId, connectionId: connection.id, revision: head.revision, offset, nextOffset: page.nextOffset, messages: page.messages }, org);
      return Response.json(result, { headers });
    } catch (error) {
      let failure = safe(error);
      // A 422 can only describe this invocation before commit was attempted.
      // A client already uncertain about an earlier in-flight invocation must
      // still retain its exact envelope even when a retry rejects credentials.
      if (writeAttempted && ['invalid_mailbox_request','mailbox_credentials_rejected'].includes(failure.code)) failure = { code: 'service_unavailable', status: 503 };
      if (admitted) { try { await current(); } catch (late) { const denial = safe(late); if ([401,402,403,404].includes(denial.status)) failure = denial; } }
      try { dependencies.diagnostic?.({ operation, ...failure }); } catch { /* No address, key or mail in diagnostics. */ }
      return Response.json({ error: failure.code }, { status: failure.status, headers });
    }
  }
  return { read: (request: Request, org: string) => run(request, org, 'read'), write: (request: Request, org: string) => run(request, org, 'write'), messages: (request: Request, org: string) => run(request, org, 'messages') };
}
