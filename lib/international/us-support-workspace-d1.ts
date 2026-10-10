import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import {
  UsSupportWorkspaceError, hashUsSupportWorkspaceRequest, sameUsSupportWorkspaceContext,
  validateUsSupportWorkspace, validateUsSupportWorkspaceContext, validateUsSupportWorkspaceReceipt,
  validateUsSupportWorkspaceRequest, validateUsSupportWorkspaceResult,
  type UsSupportWorkspace, type UsSupportWorkspaceContext, type UsSupportWorkspaceReceipt,
  type UsSupportWorkspaceRequest, type UsSupportWorkspaceStore,
} from './us-support-workspace-contract';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Row = Record<string, unknown>;
const invalid = (): never => { throw new UsSupportWorkspaceError('invalid_support_record', 503); };
function row(input: unknown): Row {
  const value = snapshotPrivateJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Row;
}
function json(input: unknown): unknown {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > 16384) return invalid();
  const value: unknown = JSON.parse(input);
  if (canonicalErpJson(value) !== input) return invalid();
  return value;
}
function mapped(error: unknown): UsSupportWorkspaceError {
  if (error instanceof UsSupportWorkspaceError) return error;
  const message = error instanceof Error ? error.message : '';
  const markers: readonly [string, string, number][] = [
    ['us_support_idempotency_conflict', 'support_idempotency_conflict', 409],
    ['us_support_workspace_conflict', 'support_workspace_conflict', 409],
    ['us_support_subscription_required', 'subscription_required', 402],
    ['us_support_forbidden', 'forbidden', 403],
    ['us_support_unauthorized', 'unauthorized', 401],
    ['us_support_invalid_record', 'invalid_support_record', 503],
  ];
  const match = markers.find(([marker]) => message.includes(marker));
  return match ? new UsSupportWorkspaceError(match[1], match[2]) : new UsSupportWorkspaceError('service_unavailable', 503);
}

/** Private server port. Auth and the approved catalogue are established by the
 * caller; every read/write corroborates the SAME retained US invoice, period,
 * membership and optional native session. No legacy Support parent is created. */
export function d1UsSupportWorkspaceStore(database: Database, options: { now?: () => number } = {}): UsSupportWorkspaceStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  async function context(input: unknown): Promise<UsSupportWorkspaceContext> {
    const c = validateUsSupportWorkspaceContext(input, undefined, now());
    const device = c.credential.kind === 'device' ? c.credential : null;
    const sessions = device?.supportedSchemaVersion === 4 ? 'international_us_device_v4_sessions' : 'international_us_device_sessions';
    const credential = device ? `EXISTS(SELECT 1 FROM ${sessions} s WHERE s.session_id=? AND s.organization_id=? AND s.user_id=? AND s.role=?
      AND s.subscription_id=? AND s.supported_schema_version=? AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())` : '1';
    const saved = await database.prepare(`SELECT m.role,m.revoked_at AS member_revoked_at,a.organization_id AS admitted_organization,
      a.owner_user_id,a.subscription_id,a.environment,a.catalog_version,a.price_id,a.authority_reference,a.valid_starts_at,a.valid_ends_at,a.seat_limit,
      ${credential} AS credential_current,unixepoch() AS checked_at
      FROM international_workspace_members m LEFT JOIN international_us_support_admissible a ON a.organization_id=m.organization_id AND a.user_id=m.user_id
      WHERE m.organization_id=? AND m.user_id=?`).bind(
      ...(device ? [device.sessionId, c.organizationId, c.userId, c.role, c.subscriptionId, device.supportedSchemaVersion] : []), c.organizationId, c.userId,
    ).first();
    if (!saved) throw new UsSupportWorkspaceError('forbidden', 403);
    const v = row(saved);
    if (v.member_revoked_at !== null || v.role !== c.role) throw new UsSupportWorkspaceError('forbidden', 403);
    if (v.credential_current !== 1) throw new UsSupportWorkspaceError('unauthorized', 401);
    if (v.admitted_organization !== c.organizationId) throw new UsSupportWorkspaceError('subscription_required', 402);
    const matches: readonly [string, keyof UsSupportWorkspaceContext][] = [
      ['owner_user_id', 'ownerUserId'], ['subscription_id', 'subscriptionId'], ['environment', 'environment'],
      ['catalog_version', 'catalogVersion'], ['price_id', 'priceId'], ['authority_reference', 'authorityReference'],
      ['valid_starts_at', 'validStartsAt'], ['valid_ends_at', 'validEndsAt'], ['seat_limit', 'seatLimit'],
    ];
    if (matches.some(([column, key]) => v[column] !== c[key])) throw new UsSupportWorkspaceError('configuration_changed', 409);
    if (typeof v.checked_at !== 'number' || !Number.isSafeInteger(v.checked_at) || c.checkedAt > v.checked_at || v.checked_at - c.checkedAt > 30) throw new UsSupportWorkspaceError('configuration_changed', 409);
    return c;
  }
  async function validatedReceipt(v: Row, organizationId: string, actorUserId: string, requestId: string) {
    const command = validateUsSupportWorkspaceRequest(json(v.command_json));
    const captured = validateUsSupportWorkspaceContext(json(v.context_json), organizationId);
    const receipt = validateUsSupportWorkspaceReceipt(json(v.receipt_json), organizationId);
    if (canonicalErpJson(command) !== v.command_json || v.organization_id !== organizationId || v.actor_user_id !== actorUserId || v.request_id !== requestId
      || command.requestId !== requestId || command.name !== v.name || captured.userId !== actorUserId || captured.checkedAt !== v.created_at
      || receipt.requestId !== requestId || receipt.actorUserId !== actorUserId || receipt.workspaceId !== v.workspace_id || receipt.createdAt !== v.created_at
      || v.request_hash !== await hashUsSupportWorkspaceRequest(organizationId, actorUserId, command)) return invalid();
    return { command, captured, receipt, requestHash: v.request_hash as string };
  }
  async function workspace(c: UsSupportWorkspaceContext): Promise<UsSupportWorkspace | null> {
    const saved = await database.prepare(`SELECT w.*,r.command_id,r.actor_user_id,r.request_id,r.request_hash,r.command_json,r.context_json,r.receipt_json,
      r.name AS receipt_name,r.created_at AS receipt_created_at FROM international_us_support_workspaces w
      JOIN international_us_support_workspace_receipts r ON r.command_id=w.created_command_id AND r.organization_id=w.organization_id AND r.workspace_id=w.workspace_id
      WHERE w.organization_id=?`).bind(c.organizationId).first();
    if (!saved) return null;
    const v = row(saved);
    const result = validateUsSupportWorkspace({ schemaVersion: 1, organizationId: v.organization_id, workspaceId: v.workspace_id,
      ownerUserId: v.owner_user_id, connectedBy: v.connected_by, name: v.name, revision: v.revision, createdAt: v.created_at }, c.organizationId);
    const first = await validatedReceipt({ ...v, name: v.receipt_name, created_at: v.receipt_created_at }, c.organizationId, result.connectedBy, v.request_id as string);
    if (result.ownerUserId !== c.ownerUserId || v.command_id !== v.created_command_id || result.name !== first.command.name
      || result.createdAt !== first.receipt.createdAt || first.captured.ownerUserId !== result.ownerUserId) return invalid();
    return result;
  }
  async function receipt(c: UsSupportWorkspaceContext, requestId: string): Promise<null | { receipt: UsSupportWorkspaceReceipt; requestHash: string; command: UsSupportWorkspaceRequest }> {
    const saved = await database.prepare('SELECT * FROM international_us_support_workspace_receipts WHERE organization_id=? AND actor_user_id=? AND request_id=?')
      .bind(c.organizationId, c.userId, requestId).first();
    if (!saved) return null;
    return validatedReceipt(row(saved), c.organizationId, c.userId, requestId);
  }
  return {
    async read(input) {
      try { const c = await context(input), result = await workspace(c); await context(c); return result; }
      catch (error) { throw mapped(error); }
    },
    async create(input, requestInput, revalidate) {
      let c = validateUsSupportWorkspaceContext(input, undefined, now());
      const captured = c, q = validateUsSupportWorkspaceRequest(requestInput);
      const requestHash = await hashUsSupportWorkspaceRequest(c.organizationId, c.userId, q);
      async function fresh() {
        const next = validateUsSupportWorkspaceContext(await revalidate(), captured.organizationId, now());
        sameUsSupportWorkspaceContext(captured, next);
        c = await context(next);
      }
      async function replay() {
        const saved = await receipt(c, q.requestId);
        if (!saved) return null;
        if (saved.requestHash !== requestHash) throw new UsSupportWorkspaceError('support_idempotency_conflict', 409);
        const retained = await workspace(c);
        if (!retained || retained.name !== q.name) return invalid();
        return validateUsSupportWorkspaceResult({ workspace: retained, receipt: saved.receipt, replayed: true }, c.organizationId);
      }
      try {
        await context(c);
        if (!['owner', 'admin'].includes(c.role)) throw new UsSupportWorkspaceError('forbidden', 403);
        await fresh();
        const previous = await replay();
        if (previous) { await fresh(); return previous; }
        const retained = await workspace(c);
        if (retained && retained.name !== q.name) throw new UsSupportWorkspaceError('support_workspace_conflict', 409);
        await fresh();
        const commandId = crypto.randomUUID(), workspaceId = retained?.workspaceId ?? crypto.randomUUID();
        const statements = [
          database.prepare(`WITH target AS (SELECT COALESCE((SELECT workspace_id FROM international_us_support_workspaces WHERE organization_id=?),?) AS id)
            INSERT INTO international_us_support_workspace_receipts(command_id,organization_id,actor_user_id,request_id,workspace_id,name,request_hash,command_json,context_json,receipt_json,created_at)
            SELECT ?,?,?,?,target.id,?,?,?,?,json_object('actorUserId',?,'createdAt',CAST(? AS INTEGER),'organizationId',?,'requestId',?,'schemaVersion',1,'workspaceId',target.id),? FROM target`)
            .bind(c.organizationId, workspaceId, commandId, c.organizationId, c.userId, q.requestId, q.name, requestHash, canonicalErpJson(q), canonicalErpJson(c), c.userId, c.checkedAt, c.organizationId, q.requestId, c.checkedAt),
          database.prepare(`INSERT INTO international_us_support_workspaces(workspace_id,organization_id,owner_user_id,connected_by,name,revision,created_at,created_command_id)
            SELECT r.workspace_id,r.organization_id,json_extract(r.context_json,'$.ownerUserId'),r.actor_user_id,r.name,1,r.created_at,r.command_id
            FROM international_us_support_workspace_receipts r WHERE r.command_id=? AND NOT EXISTS(SELECT 1 FROM international_us_support_workspaces w WHERE w.organization_id=r.organization_id)`)
            .bind(commandId),
        ];
        let applied = false;
        try {
          const results = await database.batch(statements);
          if (!results.every(result => result.success) || results[0]?.meta.changes !== 1) throw new UsSupportWorkspaceError('service_unavailable', 503);
          applied = true;
        } catch (error) {
          await fresh();
          const completed = await replay();
          if (completed) { await fresh(); return completed; }
          throw mapped(error);
        }
        await fresh();
        const completed = await replay();
        if (!completed) return invalid();
        await fresh();
        return validateUsSupportWorkspaceResult({ ...completed, replayed: !applied }, c.organizationId);
      } catch (error) { throw mapped(error); }
    },
  };
}
