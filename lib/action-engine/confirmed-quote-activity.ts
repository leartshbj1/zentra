import { AccountPublicError } from '@/lib/account-security';
import { database } from '@/lib/runtime';
import { QuoteLedgerError } from './ledger-types';
import { createDeviceQuoteAuthority } from './production-admission';
import {
  bindingExact,
  bindingInteger,
  bindingRecord,
  bindingUuid,
} from './reservation-binding';
import { combineQuotePredicates } from './support-source';
import { actionIdentifier } from './validation';

/** Historical creation activity, not the current status of the editable quote.
 * No mail, plan, amount, creator, installation or private reservation is exposed.
 * Opening must resolve quoteId in the current authorized local workspace; this
 * item never authorizes creating, issuing, sending or confirming a document. */
export type ConfirmedQuoteActivity = Readonly<{
  activityId: string;
  proposalId: string;
  quoteId: string;
  confirmedAt: number;
  kind: 'quote_draft_created';
  requiresHumanValidation: true;
}>;
export type ConfirmedQuoteActivityPage = Readonly<{
  organizationId: string;
  items: readonly ConfirmedQuoteActivity[];
  nextCursor: string | null;
}>;

const MAX_PAGE = 50;
const MAX_CURSOR = 4096;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_TIME = 253402300799;
const CURSOR_KIND = 'confirmed-quote-activity-v1';
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
  const fields = bindingRecord(raw);
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
function encodeCursor(values: readonly unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  if (encoded.length > MAX_CURSOR) return invalid();
  return encoded;
}
function readCursor(raw: string | null, identity: readonly string[]) {
  if (raw === null) return Object.freeze({ confirmedAt: 0, activityId: '' });
  try {
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    const values = array(JSON.parse(decoded), 6);
    if (
      values.length !== 6 ||
      values[0] !== CURSOR_KIND ||
      values.slice(1, 4).some((value, at) => value !== identity[at]) ||
      encodeCursor(values) !== raw
    )
      return invalid();
    return Object.freeze({
      confirmedAt: bindingInteger(values[4], 1, MAX_TIME),
      activityId: actionIdentifier(values[5]),
    });
  } catch {
    return invalid();
  }
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
  } catch {
    // Private SQL errors, bindings and hostile accessors never become activity.
  }
  return new QuoteLedgerError('service_unavailable');
}

/** Private company activity projection. No route, notification, callback, write
 * or scheduler. Canonical evidence + the immutable confirmation event are the
 * durable source; provider feedback and transport ACKs are never success facts.
 * The A10 local ACK is not known by this server projection. A local notification
 * needs its exact local confirmation marker separately, and must deduplicate by
 * organizationId + activityId. Company activity is readable from another
 * authorized device without transferring the execution reservation.
 *
 * Cursor is a bounded selector, not a permission or a permanent watermark.
 * Follow all pages, then start with null again: a transaction may finish later
 * with an earlier captured timestamp. A new head/catalogue or an edited/closed
 * historical mail does not invalidate an established creation fact.
 */
export async function readDeviceConfirmedQuoteActivity(
  request: Request,
  rawOptions: unknown = {},
): Promise<ConfirmedQuoteActivityPage> {
  let selection: ReturnType<typeof options>;
  try {
    selection = options(rawOptions);
  } catch {
    return invalid();
  }
  const captured = new Request(request.url, {
    headers: new Headers(request.headers),
  });
  const authority = await createDeviceQuoteAuthority(captured);
  const actor = bindingExact(authority.actor, ['organizationId', 'userId']);
  const organizationId = actionIdentifier(actor.organizationId);
  const identity = Object.freeze([
    organizationId,
    actionIdentifier(actor.userId),
    actionIdentifier(authority.installationId),
  ]);
  const cursor = readCursor(selection.cursor, identity);
  const db = database(),
    prepare = db.prepare.bind(db),
    batch = db.batch.bind(db);
  const delegation = `JOIN support_workspaces w ON w.id=l.workspace_id
    JOIN organization_members m ON m.organization_id=l.organization_id
      AND m.user_id=l.connected_by AND m.revoked_at IS NULL AND m.role IN ('owner','admin')`;
  const permission = `(w.owner_id=l.connected_by OR EXISTS(SELECT 1 FROM support_members sm
    WHERE sm.workspace_id=w.id AND lower(sm.email)=lower(m.email) AND sm.role='admin'))`;
  const gate = () =>
    combineQuotePredicates(
      authority.predicate('read'),
      {
        // Matches the current historical CH-only native boundary. Absence of a
        // US intention is not a country attestation or a new execution grant.
        sql: "NOT EXISTS(SELECT 1 FROM international_workspace_creation_intents WHERE organization_id=? AND country_code='US')",
        bindings: [organizationId],
      },
      {
        sql: `EXISTS(SELECT 1 FROM support_gestion_links l ${delegation}
          WHERE l.organization_id=? AND l.enabled=1 AND ${permission})`,
        bindings: [organizationId],
      },
    );

  async function read(guardOnly: boolean): Promise<unknown[]> {
    const current = gate();
    const query = guardOnly
      ? prepare('SELECT 1 AS admitted')
      : prepare(`WITH permission AS (SELECT CASE WHEN (${current.sql}) THEN 1 ELSE 0 END AS allowed)
        SELECT event.id AS activity_id,q.id AS proposal_id,r.quote_id,r.confirmed_at
        FROM action_engine_quote_proposals q
        JOIN action_engine_quote_reservations r ON r.organization_id=q.organization_id
          AND r.proposal_id=q.id AND r.fingerprint=q.fingerprint
        JOIN action_engine_quote_events event ON event.organization_id=r.organization_id
          AND event.proposal_id=r.proposal_id AND event.fingerprint=r.fingerprint
          AND event.event_type='receipt_confirmed' AND event.actor_user_id=r.user_id
          AND event.created_at=r.confirmed_at
        JOIN action_engine_quote_publication_evidence e ON e.organization_id=r.organization_id
          AND e.reservation_id=r.id AND e.proposal_id=r.proposal_id AND e.source_id=q.source_id
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
        JOIN support_tickets t ON t.id=q.source_id
        JOIN support_gestion_links l ON l.workspace_id=t.workspace_id AND l.organization_id=q.organization_id AND l.enabled=1
        ${delegation}
        CROSS JOIN permission
        WHERE permission.allowed=1 AND q.organization_id=? AND ${permission}
          AND q.action_kind='prepare_quote_draft' AND r.receipt_json IS NOT NULL AND r.confirmed_at IS NOT NULL
          AND (r.confirmed_at,event.id COLLATE BINARY)>(?,?)
        ORDER BY r.confirmed_at,event.id COLLATE BINARY LIMIT ?`).bind(
          ...current.bindings,
          organizationId,
          cursor.confirmedAt,
          cursor.activityId,
          selection.limit + 1,
        );
    const raw = await batch([
      prepare(
        `SELECT CASE WHEN (${current.sql}) THEN 1 ELSE 0 END AS allowed`,
      ).bind(...current.bindings),
      query,
      prepare(
        `SELECT CASE WHEN (${current.sql}) THEN 1 ELSE 0 END AS allowed`,
      ).bind(...current.bindings),
    ]);
    const results = array(raw, 3);
    if (results.length !== 3) return unavailable();
    const rows = results.map((rawResult) => {
      const result = bindingExact(rawResult, ['success', 'results', 'meta']);
      if (result.success !== true) return unavailable();
      bindingRecord(result.meta);
      return array(result.results, MAX_PAGE + 1);
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
  }
  function page(rows: unknown[]): readonly ConfirmedQuoteActivity[] {
    if (rows.length > selection.limit + 1) return unavailable();
    const capturedRows = Object.freeze(
      rows.map((raw) => {
        const row = bindingExact(raw, [
          'activity_id',
          'proposal_id',
          'quote_id',
          'confirmed_at',
        ]);
        return Object.freeze({
          activityId: actionIdentifier(row.activity_id),
          proposalId: actionIdentifier(row.proposal_id),
          quoteId: bindingUuid(row.quote_id),
          confirmedAt: bindingInteger(row.confirmed_at, 1, MAX_TIME),
          kind: 'quote_draft_created' as const,
          requiresHumanValidation: true as const,
        });
      }),
    );
    let previous = cursor;
    const seen = new Set<string>();
    const seenQuotes = new Set<string>();
    for (const row of capturedRows) {
      if (
        seen.has(row.proposalId) ||
        seenQuotes.has(row.quoteId) ||
        row.confirmedAt < previous.confirmedAt ||
        (row.confirmedAt === previous.confirmedAt &&
          row.activityId <= previous.activityId)
      )
        return unavailable();
      seen.add(row.proposalId);
      seenQuotes.add(row.quoteId);
      previous = row;
    }
    return capturedRows;
  }
  let first: readonly ConfirmedQuoteActivity[];
  try {
    first = page(await read(false));
  } catch (error) {
    try {
      await read(true);
    } catch (fresh) {
      throw boundedError(fresh);
    }
    throw boundedError(error);
  }
  try {
    if (JSON.stringify(page(await read(false))) !== JSON.stringify(first))
      throw new QuoteLedgerError('conflict');
  } catch (error) {
    try {
      await read(true);
    } catch (fresh) {
      throw boundedError(fresh);
    }
    throw boundedError(error);
  }
  const items = Object.freeze(first.slice(0, selection.limit));
  const last = items[items.length - 1];
  const result = Object.freeze({
    organizationId,
    items,
    nextCursor:
      first.length > selection.limit
        ? encodeCursor([
            CURSOR_KIND,
            ...identity,
            last.confirmedAt,
            last.activityId,
          ])
        : null,
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_RESPONSE_BYTES
  )
    return unavailable();
  return result;
}
