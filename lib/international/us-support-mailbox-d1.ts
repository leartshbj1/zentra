import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import {
  UsMailboxError, hashUsMailboxMaterial, hashUsMailboxPrivateCommand, sameUsMailboxContext, usMailboxCommandMaterial,
  validateUsMailboxCommandMaterial, validateUsMailboxConnection, validateUsMailboxContext, validateUsMailboxPrivateCommand,
  validateUsMailboxReceipt, validateUsMailboxResult, validateUsMailboxState,
  type UsMailboxContext, type UsMailboxReceipt, type UsMailboxState, type UsMailboxStore,
} from './us-support-mailbox-contract';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Row = Record<string, unknown>;
const invalid = (): never => { throw new UsMailboxError('invalid_mailbox_record', 503); };
function row(input: unknown): Row {
  const value = snapshotPrivateJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Row;
}
function json(input: unknown): unknown {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > 32_768) return invalid();
  const value: unknown = JSON.parse(input);
  if (canonicalErpJson(value) !== input) return invalid();
  return value;
}
function mapped(error: unknown): UsMailboxError {
  if (error instanceof UsMailboxError) return error;
  if (error instanceof UsSupportWorkspaceError) return new UsMailboxError(error.code, error.status);
  const message = error instanceof Error ? error.message : '';
  const markers: readonly [string, string, number][] = [
    ['us_mailbox_idempotency_conflict', 'mailbox_idempotency_conflict', 409],
    ['us_mailbox_revision_conflict', 'mailbox_revision_conflict', 409],
    ['us_mailbox_subscription_required', 'subscription_required', 402],
    ['us_mailbox_forbidden', 'forbidden', 403], ['us_mailbox_unauthorized', 'unauthorized', 401],
    ['us_mailbox_invalid_record', 'invalid_mailbox_record', 503], ['us_mailbox_immutable', 'invalid_mailbox_record', 503],
  ];
  const match = markers.find(([marker]) => message.includes(marker));
  return match ? new UsMailboxError(match[1], match[2]) : new UsMailboxError('service_unavailable', 503);
}

/** Private server port. Every operation corroborates H1's real registry and
 * current SQL admission. No plaintext token or legacy Support row is stored.
 * Auth/gates/provider proof are supplied by the trusted HTTP service boundary. */
export function d1UsMailboxStore(database: Database, options: { now?: () => number } = {}): UsMailboxStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const workspaces = d1UsSupportWorkspaceStore(database, { now });
  async function context(input: unknown): Promise<UsMailboxContext> {
    const c = validateUsMailboxContext(input, undefined, now());
    const workspace = await workspaces.read(c.authority);
    if (!workspace || workspace.workspaceId !== c.workspaceId) throw new UsMailboxError('forbidden', 403);
    return c;
  }
  function manager(c: UsMailboxContext): void { if (!['owner','admin'].includes(c.authority.role)) throw new UsMailboxError('forbidden', 403); }
  async function retainedReceipt(v: Row, organizationId: string): Promise<UsMailboxReceipt> {
    const material = validateUsMailboxCommandMaterial(json(v.material_json)), captured = validateUsMailboxContext(json(v.context_json), organizationId);
    const receipt = validateUsMailboxReceipt(json(v.receipt_json), organizationId);
    if (v.committed !== 1 || v.organization_id !== organizationId || v.workspace_id !== receipt.workspaceId || v.actor_user_id !== receipt.actorUserId
      || v.request_id !== receipt.requestId || v.request_hash !== receipt.requestHash || v.action !== receipt.action || v.expected_revision !== receipt.expectedRevision
      || v.revision !== receipt.revision || v.connection_id !== receipt.connectionId || v.created_at !== receipt.createdAt
      || captured.workspaceId !== receipt.workspaceId || captured.authority.userId !== receipt.actorUserId || captured.authority.checkedAt !== receipt.createdAt
      || material.requestId !== receipt.requestId || material.action !== receipt.action || material.expectedRevision !== receipt.expectedRevision
      || receipt.requestHash !== await hashUsMailboxMaterial(organizationId, receipt.actorUserId, material)) return invalid();
    return receipt;
  }
  async function receipt(c: UsMailboxContext, requestId: string, requestHash: string): Promise<UsMailboxReceipt | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId) || !/^[0-9a-f]{64}$/.test(requestHash)) throw new UsMailboxError('invalid_mailbox_request', 422);
    const saved = await database.prepare(`SELECT r.*,EXISTS(SELECT 1 FROM international_us_support_mailbox_commits done WHERE done.command_id=r.command_id) AS committed
      FROM international_us_support_mailbox_receipts r WHERE r.organization_id=? AND r.workspace_id=? AND r.actor_user_id=? AND r.request_id=?`)
      .bind(c.authority.organizationId, c.workspaceId, c.authority.userId, requestId).first();
    if (!saved) return null;
    const result = await retainedReceipt(row(saved), c.authority.organizationId);
    if (result.actorUserId !== c.authority.userId || result.workspaceId !== c.workspaceId) return invalid();
    if (result.requestHash !== requestHash) throw new UsMailboxError('mailbox_idempotency_conflict', 409);
    return result;
  }
  async function state(c: UsMailboxContext): Promise<UsMailboxState> {
    const saved = await database.prepare(`SELECT h.*,r.command_id,r.actor_user_id,r.request_id,r.request_hash,r.action,r.expected_revision,r.connection_id,
      r.material_json,r.context_json,r.receipt_json,r.created_at,EXISTS(SELECT 1 FROM international_us_support_mailbox_commits done WHERE done.command_id=r.command_id) AS committed
      FROM international_us_support_mailbox_heads h JOIN international_us_support_mailbox_receipts r ON r.command_id=h.last_command_id
      WHERE h.organization_id=? AND h.workspace_id=?`).bind(c.authority.organizationId, c.workspaceId).first();
    if (!saved) return validateUsMailboxState({ schemaVersion: 1, organizationId: c.authority.organizationId, workspaceId: c.workspaceId, revision: 0, currentConnection: null }, c.authority.organizationId);
    const v = row(saved), retained = await retainedReceipt(v, c.authority.organizationId);
    if (retained.revision !== v.revision || retained.workspaceId !== c.workspaceId || retained.connectionId !== v.current_connection_id) return invalid();
    let connection = null;
    if (retained.connectionId !== null) {
      const savedConnection = await database.prepare(`SELECT c.*,s.credentials_ciphertext,s.cleared_by_command_id FROM international_us_support_mailbox_connections c
        JOIN international_us_support_mailbox_secrets s ON s.connection_id=c.connection_id WHERE c.organization_id=? AND c.workspace_id=? AND c.connection_id=?`)
        .bind(c.authority.organizationId, c.workspaceId, retained.connectionId).first();
      if (!savedConnection) return invalid();
      const d = row(savedConnection), material = validateUsMailboxCommandMaterial(json(v.material_json));
      if (material.action !== 'connect' || d.command_id !== v.last_command_id || d.connected_by !== retained.actorUserId || d.revision !== retained.revision
        || d.email !== material.email || d.token_sha256 !== material.tokenSha256 || d.credentials_ciphertext === null || d.cleared_by_command_id !== null) return invalid();
      const full = validateUsMailboxConnection({ id: d.connection_id, provider: d.provider, email: d.email, mailboxId: d.mailbox_id, folderId: d.folder_id,
        tokenSha256: d.token_sha256, credentialsCiphertext: d.credentials_ciphertext, verifiedAt: d.verified_at, connectedBy: d.connected_by, revision: d.revision });
      if (full.verifiedAt > retained.createdAt) return invalid();
      connection = ['owner','admin'].includes(c.authority.role) ? full : validateUsMailboxConnection({ ...full, credentialsCiphertext: null });
    }
    return validateUsMailboxState({ schemaVersion: 1, organizationId: c.authority.organizationId, workspaceId: c.workspaceId, revision: retained.revision, currentConnection: connection }, c.authority.organizationId);
  }
  return {
    async read(input) {
      try { const c = await context(input), result = await state(c); await context(c); return result; }
      catch (error) { throw mapped(error); }
    },
    async receipt(input, requestId, requestHash) {
      try { const c = await context(input); manager(c); const result = await receipt(c, requestId, requestHash); await context(c); return result; }
      catch (error) { throw mapped(error); }
    },
    async commit(input, commandInput, revalidate) {
      const captured = validateUsMailboxContext(input, undefined, now()), q = validateUsMailboxPrivateCommand(commandInput);
      const requestHash = await hashUsMailboxPrivateCommand(captured.authority.organizationId, captured.authority.userId, q);
      let c = captured;
      async function fresh() {
        const next = validateUsMailboxContext(await revalidate(), captured.authority.organizationId, now());
        sameUsMailboxContext(captured, next); c = await context(next); manager(c);
      }
      async function replay() {
        const previous = await receipt(c, q.requestId, requestHash);
        if (!previous) return null;
        return validateUsMailboxResult({ state: await state(c), receipt: previous, replayed: true }, c.authority.organizationId);
      }
      try {
        c = await context(c); manager(c); await fresh();
        const previous = await replay();
        if (previous) { await fresh(); return previous; }
        const retained = await state(c);
        if (retained.revision !== q.expectedRevision) throw new UsMailboxError('mailbox_revision_conflict', 409);
        await fresh();
        if (q.action === 'connect' && (q.verifiedAt > c.authority.checkedAt || q.verifiedAt > now() || now() - q.verifiedAt > 30)) throw new UsMailboxError('mailbox_verification_expired', 409);
        const commandId = crypto.randomUUID(), connectionId = q.action === 'connect' ? q.connectionId : null;
        const savedReceipt: UsMailboxReceipt = { schemaVersion: 1, organizationId: c.authority.organizationId, workspaceId: c.workspaceId, actorUserId: c.authority.userId,
          requestId: q.requestId, requestHash, action: q.action, expectedRevision: q.expectedRevision, revision: q.expectedRevision + 1, connectionId, createdAt: c.authority.checkedAt };
        const statements = [database.prepare(`INSERT INTO international_us_support_mailbox_receipts(command_id,organization_id,workspace_id,actor_user_id,request_id,request_hash,
          action,expected_revision,revision,connection_id,material_json,context_json,receipt_json,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(commandId, c.authority.organizationId, c.workspaceId, c.authority.userId, q.requestId, requestHash, q.action, q.expectedRevision, q.expectedRevision + 1,
            connectionId, canonicalErpJson(usMailboxCommandMaterial(q)), canonicalErpJson(c), canonicalErpJson(savedReceipt), c.authority.checkedAt)];
        if (q.action === 'connect') {
          statements.push(database.prepare(`INSERT INTO international_us_support_mailbox_connections(connection_id,organization_id,workspace_id,revision,command_id,provider,email,
            mailbox_id,folder_id,token_sha256,verified_at,connected_by)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(q.connectionId, c.authority.organizationId, c.workspaceId, q.expectedRevision + 1, commandId, q.provider, q.email, q.mailboxId, q.folderId, q.tokenSha256, q.verifiedAt, c.authority.userId));
          statements.push(database.prepare('INSERT INTO international_us_support_mailbox_secrets(connection_id,credentials_ciphertext,cleared_by_command_id)VALUES(?,?,NULL)').bind(q.connectionId, q.credentialsCiphertext));
        }
        statements.push(database.prepare(`UPDATE international_us_support_mailbox_secrets SET credentials_ciphertext=NULL,cleared_by_command_id=? WHERE connection_id=
          (SELECT current_connection_id FROM international_us_support_mailbox_heads WHERE organization_id=? AND workspace_id=?) AND credentials_ciphertext IS NOT NULL`)
          .bind(commandId, c.authority.organizationId, c.workspaceId));
        statements.push(database.prepare(`INSERT INTO international_us_support_mailbox_heads(organization_id,workspace_id,revision,current_connection_id,last_command_id)
          SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_heads WHERE organization_id=?)`)
          .bind(c.authority.organizationId, c.workspaceId, q.expectedRevision + 1, connectionId, commandId, c.authority.organizationId));
        statements.push(database.prepare(`UPDATE international_us_support_mailbox_heads SET revision=?,current_connection_id=?,last_command_id=?
          WHERE organization_id=? AND workspace_id=? AND revision=?`).bind(q.expectedRevision + 1, connectionId, commandId, c.authority.organizationId, c.workspaceId, q.expectedRevision));
        statements.push(database.prepare('INSERT INTO international_us_support_mailbox_commits(command_id)VALUES(?)').bind(commandId));
        let applied = false;
        try {
          const results = await database.batch(statements);
          if (!results.every(result => result.success) || results[0]?.meta.changes !== 1 || results.at(-1)?.meta.changes !== 1) throw new UsMailboxError('service_unavailable', 503);
          applied = true;
        } catch (error) {
          await fresh(); const completed = await replay();
          if (completed) { await fresh(); return completed; }
          throw mapped(error);
        }
        await fresh(); const completed = await replay();
        if (!completed) return invalid();
        await fresh();
        return validateUsMailboxResult({ ...completed, replayed: !applied }, c.authority.organizationId);
      } catch (error) { throw mapped(error); }
    },
  };
}
