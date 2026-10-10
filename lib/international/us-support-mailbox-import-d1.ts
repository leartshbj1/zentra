import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsMailboxError, sameUsMailboxContext, validateUsMailboxContext, type UsMailboxContext } from './us-support-mailbox-contract';
import { validateUsSupplierDocumentRecord, type UsSupplierDocumentRecord } from './us-supplier-document-contract';
import {
  UsMailboxImportError, hashUsMailboxImportRequest, hashUsMailboxImportSource,
  validateUsMailboxImportRequest, validateUsMailboxImportSource, validateUsMailboxImportClaim,
  validateUsMailboxImportReservation, validateUsMailboxImportCompletion, validateUsMailboxImportResult,
  type UsMailboxImportClaim, type UsMailboxImportResult, type UsMailboxImportStore,
} from './us-support-mailbox-import-contract';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Row = Record<string, unknown>;
const invalid = (): never => { throw new UsMailboxImportError('invalid_mailbox_import_record', 503); };
const conflict = (): never => { throw new UsMailboxImportError('mailbox_import_idempotency_conflict', 409); };
function row(input: unknown): Row {
  const v = snapshotPrivateJson(input);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid();
  return v as Row;
}
function json(input: unknown): unknown {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > 16_384) return invalid();
  const v: unknown = JSON.parse(input);
  if (canonicalErpJson(v) !== input) return invalid();
  return v;
}
function identity(requestId: string, requestHash: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId) || !/^[0-9a-f]{64}$/.test(requestHash)) throw new UsMailboxImportError('invalid_mailbox_import_request', 422);
}
function mapped(error: unknown): UsMailboxImportError {
  if (error instanceof UsMailboxImportError) return error;
  if (error instanceof UsMailboxError || error instanceof UsSupportWorkspaceError) return new UsMailboxImportError(error.code, error.status);
  const message = error instanceof Error ? error.message : '';
  const markers: readonly [string, string, number][] = [
    ['us_mail_import_idempotency_conflict','mailbox_import_idempotency_conflict',409],
    ['us_mail_import_source_conflict','mailbox_import_source_conflict',409],
    ['us_mail_import_connection_changed','mailbox_import_connection_changed',409],
    ['us_mail_import_capacity_exceeded','mailbox_import_capacity_exceeded',409],
    ['us_mail_import_subscription_required','subscription_required',402],
    ['us_mail_import_forbidden','forbidden',403], ['us_mail_import_unauthorized','unauthorized',401],
    ['us_mail_import_invalid_record','invalid_mailbox_import_record',503], ['us_mail_import_immutable','invalid_mailbox_import_record',503],
  ];
  const match = markers.find(([marker]) => message.includes(marker));
  return match ? new UsMailboxImportError(match[1], match[2]) : new UsMailboxImportError('service_unavailable',503);
}

/** Service-only reconciliation port. SQL corroborates current US admission,
 * membership, v4 native sessions and claims' current connection. Auth, gates,
 * provider origin and verified PG/R2 bytes belong to the trusted service. No
 * cross-store transaction, plaintext credential, message body or blob is kept. */
export function d1UsMailboxImportStore(database: Database, options: { now?: () => number } = {}): UsMailboxImportStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const workspaces = d1UsSupportWorkspaceStore(database, { now });
  async function context(input: unknown): Promise<UsMailboxContext> {
    const c = validateUsMailboxContext(input, undefined, now());
    const workspace = await workspaces.read(c.authority);
    if (!workspace || workspace.workspaceId !== c.workspaceId || !['owner','admin'].includes(c.authority.role)) throw new UsMailboxImportError('forbidden',403);
    if (c.authority.credential.kind === 'device' && c.authority.credential.supportedSchemaVersion !== 4) throw new UsMailboxImportError('client_schema_required',409);
    return c;
  }
  async function retainedClaim(v: Row, organizationId: string): Promise<UsMailboxImportClaim> {
    const source = validateUsMailboxImportSource(json(v.source_json));
    const captured = validateUsMailboxContext(json(v.first_context_json), organizationId), request = validateUsMailboxImportRequest(json(v.first_request_json));
    const claim = validateUsMailboxImportClaim({ schemaVersion: 1, organizationId: v.organization_id, workspaceId: v.workspace_id, sourceHash: v.source_hash,
      connectionId: v.connection_id, mailboxRevision: v.mailbox_revision, suggestedDocumentId: v.suggested_document_id, source, claimedBy: v.claimed_by, claimedAt: v.claimed_at }, organizationId);
    if (captured.workspaceId !== claim.workspaceId || captured.authority.userId !== claim.claimedBy || captured.authority.checkedAt !== claim.claimedAt
      || v.first_actor_user_id !== claim.claimedBy || v.first_created_at !== claim.claimedAt || v.first_connection_id !== claim.connectionId || v.first_mailbox_revision !== claim.mailboxRevision
      || v.first_source_json !== v.source_json || request.connectionId !== claim.connectionId || request.expectedMailboxRevision !== claim.mailboxRevision
      || request.uid !== source.uid || request.attachmentId !== source.attachmentId || request.expectedMessageVersion !== source.messageVersion
      || v.provider !== source.provider || v.mailbox_id !== source.mailboxId || v.folder_id !== source.folderId || v.uid !== source.uid || v.attachment_id !== source.attachmentId
      || claim.sourceHash !== await hashUsMailboxImportSource(organizationId, claim.workspaceId, source)
      || v.first_request_hash !== await hashUsMailboxImportRequest(organizationId, claim.claimedBy, request)) return invalid();
    return claim;
  }
  async function lookup(c: UsMailboxContext, requestId: string, requestHash: string): Promise<UsMailboxImportResult | null> {
    const org = c.authority.organizationId;
    const saved = await database.prepare('SELECT * FROM international_us_support_mail_import_requests WHERE organization_id=? AND workspace_id=? AND actor_user_id=? AND request_id=?')
      .bind(org, c.workspaceId, c.authority.userId, requestId).first();
    if (!saved) return null;
    const v = row(saved), request = validateUsMailboxImportRequest(json(v.request_json)), captured = validateUsMailboxContext(json(v.context_json), org);
    if (v.organization_id !== org || v.workspace_id !== c.workspaceId || v.actor_user_id !== c.authority.userId || v.request_id !== requestId
      || captured.workspaceId !== c.workspaceId || captured.authority.userId !== c.authority.userId || captured.authority.checkedAt !== v.created_at
      || request.requestId !== requestId || request.connectionId !== v.connection_id || request.expectedMailboxRevision !== v.mailbox_revision
      || v.request_hash !== await hashUsMailboxImportRequest(org,c.authority.userId,request)) return invalid();
    if (v.request_hash !== requestHash) return conflict();
    const savedSource = await database.prepare(`SELECT s.*,r.context_json AS first_context_json,r.request_json AS first_request_json,r.source_json AS first_source_json,
      r.request_hash AS first_request_hash,r.actor_user_id AS first_actor_user_id,r.created_at AS first_created_at,r.connection_id AS first_connection_id,r.mailbox_revision AS first_mailbox_revision
      FROM international_us_support_mail_import_sources s JOIN international_us_support_mail_import_requests r ON r.command_id=s.first_command_id
      WHERE s.organization_id=? AND s.workspace_id=? AND s.source_hash=?`).bind(org,c.workspaceId,v.source_hash).first();
    if (!savedSource) return invalid();
    const sourceRow = row(savedSource), claim = await retainedClaim(sourceRow,org);
    if (claim.workspaceId !== c.workspaceId || claim.sourceHash !== v.source_hash || v.source_json !== sourceRow.source_json) return invalid();
    const reservation = validateUsMailboxImportReservation({ schemaVersion:1,organizationId:org,workspaceId:c.workspaceId,actorUserId:c.authority.userId,
      requestId,requestHash,request,claim,createdAt:v.created_at },org);
    const savedCompletion = await database.prepare(`SELECT d.*,r.actor_user_id AS request_actor,r.created_at AS request_created_at FROM international_us_support_mail_import_completions d
      JOIN international_us_support_mail_import_requests r ON r.command_id=d.command_id AND r.organization_id=d.organization_id AND r.workspace_id=d.workspace_id AND r.source_hash=d.source_hash
      WHERE d.organization_id=? AND d.workspace_id=? AND d.source_hash=?`).bind(org,c.workspaceId,claim.sourceHash).first();
    let completion = null;
    if (savedCompletion) {
      const d = row(savedCompletion), at = validateUsMailboxContext(json(d.context_json),org);
      completion = validateUsMailboxImportCompletion({ schemaVersion:1,organizationId:d.organization_id,workspaceId:d.workspace_id,sourceHash:d.source_hash,
        documentId:d.document_id,contentSha256:d.content_sha256,sizeBytes:d.size_bytes,mediaType:d.media_type,completedBy:d.completed_by,completedAt:d.completed_at },org);
      if (at.workspaceId !== c.workspaceId || at.authority.userId !== completion.completedBy || at.authority.checkedAt !== completion.completedAt
        || d.request_actor !== completion.completedBy || typeof d.request_created_at !== 'number' || d.request_created_at > completion.completedAt) return invalid();
    }
    return validateUsMailboxImportResult({ reservation,completion,replayed:true },org);
  }
  return {
    async find(input,requestId,requestHash) {
      try { identity(requestId,requestHash); const c = await context(input), result = await lookup(c,requestId,requestHash); await context(c); return result; }
      catch (error) { throw mapped(error); }
    },
    async claim(input,commandInput,revalidate) {
      const captured = validateUsMailboxContext(input,undefined,now()), command = row(commandInput);
      if (Object.keys(command).length !== 3 || !['request','source','suggestedDocumentId'].every(k => Object.hasOwn(command,k))) return invalid();
      const q = validateUsMailboxImportRequest(command.request), source = validateUsMailboxImportSource(command.source);
      const candidate = validateUsMailboxImportClaim({ schemaVersion:1,organizationId:captured.authority.organizationId,workspaceId:captured.workspaceId,
        sourceHash:await hashUsMailboxImportSource(captured.authority.organizationId,captured.workspaceId,source),connectionId:q.connectionId,mailboxRevision:q.expectedMailboxRevision,
        suggestedDocumentId:command.suggestedDocumentId,source,claimedBy:captured.authority.userId,claimedAt:captured.authority.checkedAt },captured.authority.organizationId);
      if (q.uid !== source.uid || q.attachmentId !== source.attachmentId || q.expectedMessageVersion !== source.messageVersion) throw new UsMailboxImportError('mailbox_import_source_conflict',409);
      const requestHash = await hashUsMailboxImportRequest(captured.authority.organizationId,captured.authority.userId,q);
      let c = captured;
      async function fresh() { const next = validateUsMailboxContext(await revalidate(),captured.authority.organizationId,now()); sameUsMailboxContext(captured,next); c = await context(next); }
      async function replay() {
        const saved = await lookup(c,q.requestId,requestHash);
        if (saved && canonicalErpJson(saved.reservation.claim.source) !== canonicalErpJson(source)) throw new UsMailboxImportError('mailbox_import_source_conflict',409);
        return saved;
      }
      try {
        c = await context(c); await fresh(); const previous = await replay();
        if (previous) { await fresh(); return previous; }
        await fresh(); const commandId = crypto.randomUUID(), org = c.authority.organizationId;
        const statements = [database.prepare(`INSERT INTO international_us_support_mail_import_requests(command_id,organization_id,workspace_id,actor_user_id,request_id,request_hash,
          connection_id,mailbox_revision,source_hash,request_json,source_json,context_json,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(commandId,org,c.workspaceId,c.authority.userId,q.requestId,requestHash,q.connectionId,q.expectedMailboxRevision,candidate.sourceHash,canonicalErpJson(q),canonicalErpJson(source),canonicalErpJson(c),c.authority.checkedAt),
        database.prepare(`INSERT INTO international_us_support_mail_import_sources(organization_id,workspace_id,source_hash,first_command_id,connection_id,mailbox_revision,suggested_document_id,
          provider,mailbox_id,folder_id,uid,attachment_id,source_json,claimed_by,claimed_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM international_us_support_mail_import_sources WHERE organization_id=? AND workspace_id=? AND source_hash=?)`)
          .bind(org,c.workspaceId,candidate.sourceHash,commandId,q.connectionId,q.expectedMailboxRevision,candidate.suggestedDocumentId,source.provider,source.mailboxId,source.folderId,source.uid,source.attachmentId,canonicalErpJson(source),c.authority.userId,c.authority.checkedAt,org,c.workspaceId,candidate.sourceHash)];
        try { const results = await database.batch(statements); if (!results.every(r => r.success) || results[0]?.meta.changes !== 1) throw new UsMailboxImportError('service_unavailable',503); }
        catch (error) { await fresh(); const completed = await replay(); if (completed) { await fresh(); return completed; } throw mapped(error); }
        await fresh(); const result = await replay(); if (!result) return invalid(); await fresh(); return validateUsMailboxImportResult({ ...result,replayed:false },org);
      } catch (error) { throw mapped(error); }
    },
    async complete(input,commandInput,revalidate) {
      const captured = validateUsMailboxContext(input,undefined,now()), command = row(commandInput);
      if (Object.keys(command).length !== 3 || !['requestId','requestHash','document'].every(k => Object.hasOwn(command,k)) || typeof command.requestId !== 'string' || typeof command.requestHash !== 'string') return invalid();
      const { requestId,requestHash } = command; identity(requestId,requestHash);
      let document: UsSupplierDocumentRecord;
      try { document = validateUsSupplierDocumentRecord(command.document,captured.authority.organizationId); } catch { return invalid(); }
      if (!document.stored) return invalid();
      let c = captured;
      async function fresh() { const next = validateUsMailboxContext(await revalidate(),captured.authority.organizationId,now()); sameUsMailboxContext(captured,next); c = await context(next); }
      async function retained() {
        const saved = await lookup(c,requestId,requestHash);
        if (!saved) throw new UsMailboxImportError('mailbox_import_not_reserved',409);
        const s = saved.reservation.claim.source;
        if (document.contentSha256 !== s.contentSha256 || document.sizeBytes !== s.sizeBytes || document.mediaType !== s.mediaType
          || saved.completion && saved.completion.documentId !== document.id) throw new UsMailboxImportError('mailbox_import_source_conflict',409);
        return saved;
      }
      try {
        c = await context(c); await fresh(); const previous = await retained();
        if (previous.completion) { await fresh(); return previous; }
        await fresh(); const org = c.authority.organizationId, sourceHash = previous.reservation.claim.sourceHash;
        const statement = database.prepare(`INSERT INTO international_us_support_mail_import_completions(organization_id,workspace_id,source_hash,command_id,document_id,
          content_sha256,size_bytes,media_type,completed_by,completed_at,context_json)
          SELECT ?,?,?,command_id,?,?,?,?,?,?,? FROM international_us_support_mail_import_requests WHERE organization_id=? AND workspace_id=? AND actor_user_id=? AND request_id=? AND request_hash=?`)
          .bind(org,c.workspaceId,sourceHash,document.id,document.contentSha256,document.sizeBytes,document.mediaType,c.authority.userId,c.authority.checkedAt,canonicalErpJson(c),org,c.workspaceId,c.authority.userId,requestId,requestHash);
        try { const results = await database.batch([statement]); if (!results[0]?.success || results[0].meta.changes !== 1) throw new UsMailboxImportError('service_unavailable',503); }
        catch (error) { await fresh(); const saved = await retained(); if (saved.completion) { await fresh(); return saved; } throw mapped(error); }
        await fresh(); const result = await retained(); if (!result.completion) return invalid(); await fresh(); return validateUsMailboxImportResult({ ...result,replayed:false },org);
      } catch (error) { throw mapped(error); }
    },
  };
}
