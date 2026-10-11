import { AccountPublicError } from '@/lib/account-security';
import { database } from '@/lib/runtime';
import { QuoteLedgerError } from './ledger-types';
import { createDeviceQuoteAuthority } from './production-admission';
import { publicationCoordinationEnabled } from './publication-gateway';
import {
  bindingExact,
  bindingInteger,
  bindingRecord,
} from './reservation-binding';
import { combineQuotePredicates } from './support-source';
import { actionIdentifier } from './validation';

export type DeviceQuoteWorkDiscovery = Readonly<{
  sourceIds: readonly string[];
  nextCursor: string | null;
}>;

const MAX_PAGE = 50;
const MAX_TIME = 253402300799;
const MAX_CURSOR = 4096;
const invalid = (): never => {
  throw new QuoteLedgerError('invalid_record');
};
const unavailable = (): never => {
  throw new QuoteLedgerError('service_unavailable');
};

function array(raw: unknown, maximum: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    return invalid();
  const length: unknown = Object.getOwnPropertyDescriptor(raw, 'length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    Reflect.ownKeys(raw).length !== length + 1
  )
    return invalid();
  const copy: unknown[] = [];
  for (let at = 0; at < length; at++) {
    const field = Object.getOwnPropertyDescriptor(raw, String(at));
    if (!field?.enumerable || !('value' in field)) return invalid();
    copy.push(field.value);
  }
  return copy;
}

function options(raw: unknown) {
  let fields: Record<string, unknown>;
  try {
    fields = bindingRecord(raw);
  } catch {
    return invalid();
  }
  if (Object.keys(fields).some((key) => key !== 'limit' && key !== 'cursor'))
    return invalid();
  const limit = Object.hasOwn(fields, 'limit')
    ? bindingInteger(fields.limit, 1, MAX_PAGE)
    : 20;
  const cursor = Object.hasOwn(fields, 'cursor') ? fields.cursor : null;
  if (
    cursor !== null &&
    (typeof cursor !== 'string' ||
      cursor.length < 1 ||
      cursor.length > MAX_CURSOR ||
      !/^[A-Za-z0-9_-]+$/.test(cursor))
  )
    return invalid();
  return Object.freeze({ limit, cursor: cursor as string | null });
}

function readCursor(raw: string | null, identity: readonly string[]) {
  if (raw === null) return Object.freeze({ createdAt: 0, sourceId: '' });
  try {
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    const values = array(JSON.parse(decoded), 6);
    if (
      values.length !== 6 ||
      values[0] !== 1 ||
      values.slice(1, 4).some((value, at) => value !== identity[at]) ||
      encodeCursor(values) !== raw
    )
      return invalid();
    return Object.freeze({
      createdAt: bindingInteger(values[4], 1, MAX_TIME),
      sourceId: actionIdentifier(values[5]),
    });
  } catch {
    return invalid();
  }
}

function nextCursor(
  identity: readonly string[],
  row: Readonly<{ createdAt: number; sourceId: string }>,
) {
  return encodeCursor([1, ...identity, row.createdAt, row.sourceId]);
}

function encodeCursor(values: readonly unknown[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  if (encoded.length > MAX_CURSOR) return invalid();
  return encoded;
}

function identityValue(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !raw.trim() ||
    raw.length > 160 ||
    Array.from(raw).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return invalid();
  return raw;
}

function boundedError(error: unknown): QuoteLedgerError {
  try {
    if (error instanceof QuoteLedgerError) {
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      if (
        code === 'forbidden' ||
        code === 'invalid_record' ||
        code === 'conflict'
      )
        return new QuoteLedgerError(code);
    }
    if (
      error instanceof AccountPublicError &&
      Object.getOwnPropertyDescriptor(error, 'status')?.value === 403
    )
      return new QuoteLedgerError('forbidden');
    const message =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'message')
        : undefined;
    if (
      message &&
      'value' in message &&
      typeof message.value === 'string' &&
      message.value.length <= 2000 &&
      message.value.includes('action_engine_denied')
    )
      return new QuoteLedgerError('forbidden');
  } catch {
    // Do not expose database text, tokens or traps from a rejected port.
  }
  return new QuoteLedgerError('service_unavailable');
}

/** Private, read-only work discovery; never a provider call or execution grant.
 * Persistent Support tickets/intake/proposals are the queue of record. A caller
 * must follow every page, then start a new round with cursor=null: classification
 * can finish later and a preparing lease can expire without updating a ticket.
 * The cursor is a bound selector, not a signed permission or durable watermark.
 * Existing proposals remain visible under historical access after source edits,
 * connector deactivation or Automation pause; A8/A7 decide their actual recovery.
 * A canonically confirmed proposal is no longer work. Lost local ACK recovery
 * must first use A11's durable local outbox, independently of this listing.
 * Authorization and rows are read in one D1 batch, followed by a fresh batch.
 * No route, scheduler, acknowledgement, business mutation or AI is installed.
 */
export async function discoverDeviceSupportQuoteWork(
  request: Request,
  rawOptions: unknown = {},
): Promise<DeviceQuoteWorkDiscovery> {
  const selection = options(rawOptions),
    captured = new Request(request.url, {
      headers: new Headers(request.headers),
    });
  const authority = await createDeviceQuoteAuthority(captured);
  const actorFields = bindingExact(authority.actor, [
    'organizationId',
    'userId',
  ]);
  const actor = Object.freeze({
    organizationId: identityValue(actorFields.organizationId),
    userId: identityValue(actorFields.userId),
  });
  const identity = Object.freeze([
    actor.organizationId,
    actor.userId,
    identityValue(authority.installationId),
  ]);
  const cursor = readCursor(selection.cursor, identity);
  const db = database(),
    prepare = db.prepare.bind(db),
    batch = db.batch.bind(db);
  const country = Object.freeze({
    sql: "NOT EXISTS(SELECT 1 FROM international_workspace_creation_intents WHERE organization_id=? AND country_code='US')",
    bindings: Object.freeze([actor.organizationId]),
  });
  const readGate = () =>
    combineQuotePredicates(authority.predicate('read'), country, {
      sql: `EXISTS(SELECT 1 FROM support_gestion_links l
        JOIN support_workspaces w ON w.id=l.workspace_id
        JOIN organization_members m ON m.organization_id=l.organization_id
          AND m.user_id=l.connected_by AND m.revoked_at IS NULL AND m.role IN ('owner','admin')
        WHERE l.organization_id=? AND l.enabled=1
          AND (w.owner_id=l.connected_by OR EXISTS(SELECT 1 FROM support_members sm
            WHERE sm.workspace_id=w.id AND lower(sm.email)=lower(m.email) AND sm.role='admin')))`,
      bindings: [actor.organizationId],
    });
  const progressionGate = () =>
    publicationCoordinationEnabled(actor.organizationId)
      ? authority.predicate('progression')
      : Object.freeze({ sql: '0', bindings: Object.freeze([]) });

  async function read(guardOnly: boolean) {
    const progress = progressionGate();
    const gate = readGate();
    const query = guardOnly
      ? prepare('SELECT 1 AS admitted')
      : prepare(`WITH permission AS (SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed),
        progress AS (SELECT CASE WHEN (${progress.sql}) THEN 1 ELSE 0 END AS allowed)
        SELECT t.id AS source_id,t.created_at,
          CASE WHEN q.id IS NULL THEN 1 ELSE 0 END AS new_work
        FROM support_tickets t
        JOIN support_gestion_links l ON l.workspace_id=t.workspace_id AND l.enabled=1
        JOIN support_workspaces w ON w.id=l.workspace_id
        JOIN organization_members m ON m.organization_id=l.organization_id
          AND m.user_id=l.connected_by AND m.revoked_at IS NULL AND m.role IN ('owner','admin')
        LEFT JOIN support_connections c ON c.id=t.connection_id AND c.workspace_id=t.workspace_id
        LEFT JOIN action_engine_quote_proposals q ON q.organization_id=l.organization_id
          AND q.source_id=t.id AND q.action_kind='prepare_quote_draft'
        LEFT JOIN action_engine_quote_intake i ON i.organization_id=l.organization_id
          AND i.source_id=t.id AND i.action_kind='prepare_quote_draft'
        CROSS JOIN progress
        CROSS JOIN permission
        WHERE permission.allowed=1 AND l.organization_id=?
          AND (w.owner_id=l.connected_by OR EXISTS(SELECT 1 FROM support_members sm
            WHERE sm.workspace_id=w.id AND lower(sm.email)=lower(m.email) AND sm.role='admin'))
          AND (t.created_at,t.id COLLATE BINARY)>(?,?)
          AND NOT EXISTS(SELECT 1 FROM action_engine_quote_reservations r
            JOIN action_engine_quote_events event ON event.organization_id=r.organization_id
              AND event.proposal_id=r.proposal_id AND event.fingerprint=r.fingerprint
              AND event.event_type='receipt_confirmed' AND event.actor_user_id=r.user_id
              AND event.created_at=r.confirmed_at
            JOIN action_engine_quote_publication_evidence e ON e.organization_id=r.organization_id
              AND e.reservation_id=r.id AND e.proposal_id=r.proposal_id AND e.source_id=t.id
              AND e.fingerprint=r.fingerprint AND e.user_id=r.user_id AND e.installation_id=r.installation_id
              AND e.customer_id=r.customer_id AND e.quote_id=r.quote_id AND e.receipt_json=r.receipt_json
              AND e.validator_version='quote-canonical-v1' AND e.created_at<=r.confirmed_at
            JOIN action_engine_quote_reservation_bindings b ON b.reservation_id=r.id
              AND b.organization_id=r.organization_id AND b.proposal_id=r.proposal_id AND b.fingerprint=r.fingerprint
            JOIN action_engine_publication_attempts p ON p.id=e.publication_attempt_id
              AND p.organization_id=e.organization_id AND p.user_id=e.user_id AND p.installation_id=e.installation_id
              AND p.created_at>=r.created_at AND e.revision>b.planning_revision
              AND p.snapshot_id=e.snapshot_id AND p.base_revision=e.base_revision
              AND p.archive_sha256=e.archive_sha256 AND p.manifest_sha256=e.manifest_sha256
              AND p.state='committed' AND json_extract(p.result_json,'$.committed')=1
              AND json_extract(p.result_json,'$.revision')=e.revision AND json_extract(p.result_json,'$.snapshotId')=e.snapshot_id
            JOIN action_engine_publication_attempts h ON h.organization_id=b.organization_id
              AND h.snapshot_id=b.planning_snapshot_id AND h.base_revision=b.planning_base_revision
              AND h.archive_sha256=b.planning_archive_sha256 AND h.manifest_sha256=b.planning_manifest_sha256
              AND h.state='committed' AND json_extract(h.result_json,'$.committed')=1
              AND json_extract(h.result_json,'$.revision')=b.planning_revision
              AND json_extract(h.result_json,'$.snapshotId')=h.snapshot_id
            WHERE r.organization_id=q.organization_id AND r.proposal_id=q.id AND r.fingerprint=q.fingerprint
              AND r.receipt_json IS NOT NULL AND r.confirmed_at IS NOT NULL)
          AND (q.id IS NOT NULL OR (
            progress.allowed=1 AND c.active=1 AND w.mode IN ('automatic','review')
            AND t.state IN ('review','ready','routed')
            AND CASE WHEN json_valid(t.decision_json) THEN
              json_type(t.decision_json)='object'
              AND json_extract(t.decision_json,'$.category')='quote' ELSE 0 END
            AND CASE WHEN json_valid(t.source_json) THEN
              json_type(t.source_json)='object' AND json_type(t.source_json,'$.closed')='false'
              AND COALESCE(json_type(t.source_json,'$.incomplete'),'null')<>'true'
              AND COALESCE(json_type(t.source_json,'$.mail.bodyIncomplete'),'null')<>'true'
              AND COALESCE(json_type(t.source_json,'$.senderIdentityAmbiguous'),'null')<>'true' ELSE 0 END
            AND (i.id IS NULL OR i.state='finished'
              OR (i.state='preparing' AND i.lease_until<=unixepoch()))
          ))
        ORDER BY t.created_at,t.id COLLATE BINARY LIMIT ?`).bind(
          ...gate.bindings,
          ...progress.bindings,
          actor.organizationId,
          cursor.createdAt,
          cursor.sourceId,
          selection.limit + 1,
        );
    const raw = await batch([
      prepare(
        `SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`,
      ).bind(...gate.bindings),
      query,
      prepare(
        `SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`,
      ).bind(...gate.bindings),
    ]);
    try {
      const results = array(raw, 3);
      if (results.length !== 3) return unavailable();
      const rows = results.map((result) => {
        const fields = bindingExact(result, ['success', 'results', 'meta']);
        if (fields.success !== true) return unavailable();
        bindingRecord(fields.meta);
        return array(fields.results, MAX_PAGE + 1);
      });
      for (const at of [0, 2]) {
        if (rows[at].length !== 1) return unavailable();
        const allowed = bindingExact(rows[at][0], ['allowed']).allowed;
        if (allowed !== 0 && allowed !== 1) return unavailable();
        if (allowed !== 1) throw new QuoteLedgerError('forbidden');
      }
      if (
        guardOnly &&
        (rows[1].length !== 1 ||
          bindingExact(rows[1][0], ['admitted']).admitted !== 1)
      )
        return unavailable();
      return rows[1];
    } catch (error) {
      if (error instanceof QuoteLedgerError && error.code === 'forbidden')
        throw error;
      return unavailable();
    }
  }

  type Page = readonly Readonly<{
    sourceId: string;
    createdAt: number;
    newWork: boolean;
  }>[];
  function capturePage(rows: unknown[]): Page {
    const page = Object.freeze(
      rows.map((raw) => {
        const row = bindingExact(raw, ['source_id', 'created_at', 'new_work']);
        return Object.freeze({
          sourceId: actionIdentifier(row.source_id),
          createdAt: bindingInteger(row.created_at, 1, MAX_TIME),
          newWork: bindingInteger(row.new_work, 0, 1) === 1,
        });
      }),
    );
    if (page.length > selection.limit + 1) return unavailable();
    let previous = cursor;
    for (const row of page) {
      if (
        row.createdAt < previous.createdAt ||
        (row.createdAt === previous.createdAt &&
          row.sourceId <= previous.sourceId)
      )
        return unavailable();
      previous = row;
    }
    return page;
  }
  let page: Page;
  try {
    page = capturePage(await read(false));
  } catch (error) {
    try {
      await read(true);
    } catch (fresh) {
      throw boundedError(fresh);
    }
    throw boundedError(error);
  }
  const returned = page.slice(0, selection.limit);
  try {
    // Re-run the same bounded, tenant/delegation-scoped SELECT under fresh
    // permission. A global permission check alone could disclose workspace A
    // after its link was replaced by B, or return a now-closed/newly paused item.
    const fresh = capturePage(await read(false));
    if (JSON.stringify(fresh) !== JSON.stringify(page))
      throw new QuoteLedgerError('conflict');
  } catch (error) {
    throw boundedError(error);
  }
  return Object.freeze({
    sourceIds: Object.freeze(returned.map((row) => row.sourceId)),
    nextCursor:
      page.length > selection.limit
        ? nextCursor(identity, returned[returned.length - 1])
        : null,
  });
}
