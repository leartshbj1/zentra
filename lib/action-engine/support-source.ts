import { sha256Hex } from '@/lib/account-security';
import { database } from '@/lib/runtime';
import { senderAddress } from '@/lib/support/sender-policies';
import type { SourceTicket } from '@/lib/support/types';
import type { QuoteLedgerPredicate } from './ledger-types';
import { connectorSenderName, quoteMailBody } from './source-envelope';
import {
  ActionEngineError,
  type ActionActor,
  type ActionSource,
} from './types';
import { actionIdentifier, captureActor } from './validation';

export type SupportQuoteSourcePurpose = 'read' | 'progression';
export type SupportQuoteSourceCapability = Readonly<{
  source: ActionSource;
  workspaceId: string;
  revision: string;
  /** Private server capability, not an HTTP DTO or an authorization by itself. */
  predicate: (purpose: SupportQuoteSourcePurpose) => QuoteLedgerPredicate;
}>;
export type SupportQuoteAccessCapability = Readonly<{
  sourceId: string;
  workspaceId: string;
  predicate: () => QuoteLedgerPredicate;
}>;

type SourceRow = {
  id: string;
  workspace_id: string;
  connection_id: string;
  external_id: string;
  subject: string;
  body: string;
  source_json: string;
  fingerprint: string;
  revision: number;
  connected_by: string;
  link_created_at: number;
  connection_created_at: number;
  provider: string;
};
const SOURCE_KEYS = [
  'id',
  'workspace_id',
  'connection_id',
  'external_id',
  'subject',
  'body',
  'source_json',
  'fingerprint',
  'revision',
  'connected_by',
  'link_created_at',
  'connection_created_at',
  'provider',
] as const;
const DELEGATION = `JOIN support_workspaces w ON w.id=l.workspace_id
  JOIN organization_members m ON m.organization_id=l.organization_id
    AND m.user_id=l.connected_by AND m.revoked_at IS NULL AND m.role IN ('owner','admin')`;
const SUPPORT_PERMISSION = `(w.owner_id=l.connected_by OR EXISTS(SELECT 1 FROM support_members sm
  WHERE sm.workspace_id=w.id AND lower(sm.email)=lower(m.email) AND sm.role='admin'))`;
const SOURCE_FROM = `FROM support_tickets t
  JOIN support_connections c ON c.id=t.connection_id AND c.workspace_id=t.workspace_id AND c.active=1
  JOIN support_gestion_links l ON l.workspace_id=t.workspace_id AND l.enabled=1
  ${DELEGATION}`;
const MAX_BINDING_CHARS = 65536;
const MAX_PREDICATE_BINDINGS = 64;
const MAX_PREDICATE_SQL = 16000;
const invalid = (): never => {
  throw new ActionEngineError('invalid_context');
};

/** Current delegated access to a historical source, without reinterpreting its
 * edited/closed body or requiring its connector to remain active. This grants
 * no device/business permission; compose it with fresh device authority. */
export async function readSupportQuoteAccess(
  rawActor: ActionActor,
  rawSourceId: string,
): Promise<SupportQuoteAccessCapability> {
  const actor = captureActor(rawActor),
    sourceId = actionIdentifier(rawSourceId);
  const from = `FROM support_tickets t JOIN support_gestion_links l ON l.workspace_id=t.workspace_id AND l.enabled=1 ${DELEGATION}`;
  const row = ownRecord(
    await database()
      .prepare(
        `SELECT t.id,t.workspace_id ${from} WHERE t.id=? AND l.organization_id=? AND ${SUPPORT_PERMISSION}`,
      )
      .bind(sourceId, actor.organizationId)
      .first(),
  );
  if (Object.keys(row).length !== 2 || row.id?.value !== sourceId)
    return invalid();
  const workspaceId = actionIdentifier(row.workspace_id?.value);
  return Object.freeze({
    sourceId,
    workspaceId,
    predicate: () =>
      combineQuotePredicates({
        sql: `EXISTS(SELECT 1 ${from} WHERE t.id=? AND t.workspace_id=? AND l.organization_id=? AND ${SUPPORT_PERMISSION})`,
        bindings: [sourceId, workspaceId, actor.organizationId],
      }),
  });
}

function ownRecord(raw: unknown): Record<string, PropertyDescriptor> {
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(raw).some((key) => typeof key !== 'string'))
      return invalid();
    for (const descriptor of Object.values(descriptors))
      if (!descriptor.enumerable || !('value' in descriptor)) return invalid();
    return descriptors;
  } catch {
    return invalid();
  }
}

/** Capture the complete hash material synchronously, before its first digest. */
function captureSourceRow(raw: unknown, sourceId: string): Readonly<SourceRow> {
  const fields = ownRecord(raw);
  if (
    Object.keys(fields).length !== SOURCE_KEYS.length ||
    SOURCE_KEYS.some((key) => !fields[key])
  )
    return invalid();
  const result: Record<string, string | number> = {};
  for (const key of SOURCE_KEYS) {
    const value: unknown = fields[key].value;
    if (
      key === 'revision' ||
      key === 'link_created_at' ||
      key === 'connection_created_at'
    ) {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < (key === 'revision' ? 1 : 0)
      )
        return invalid();
    } else if (
      typeof value !== 'string' ||
      value.length > (key === 'source_json' ? 256000 : MAX_BINDING_CHARS)
    ) {
      return invalid();
    }
    result[key] = value as string | number;
  }
  if (result.id !== sourceId) return invalid();
  for (const key of [
    'id',
    'workspace_id',
    'connection_id',
    'connected_by',
  ] as const)
    actionIdentifier(result[key]);
  return Object.freeze(result) as Readonly<SourceRow>;
}

function capturePredicate(raw: QuoteLedgerPredicate): QuoteLedgerPredicate {
  const fields = ownRecord(raw);
  if (Object.keys(fields).length !== 2 || !fields.sql || !fields.bindings)
    return invalid();
  const sql: unknown = fields.sql.value,
    values: unknown = fields.bindings.value;
  if (
    typeof sql !== 'string' ||
    !sql.trim() ||
    sql.length > MAX_PREDICATE_SQL ||
    sql.includes(';') ||
    sql.includes(String.fromCharCode(0)) ||
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(values),
    length: unknown = Object.getOwnPropertyDescriptor(values, 'length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > MAX_PREDICATE_BINDINGS ||
    Reflect.ownKeys(values).length !== length + 1
  )
    return invalid();
  const bindings: (string | number | null)[] = [];
  for (let at = 0; at < length; at++) {
    const field = descriptors[String(at)];
    if (!field || !field.enumerable || !('value' in field)) return invalid();
    const value: unknown = field.value;
    if (
      value !== null &&
      !(typeof value === 'string' && value.length <= MAX_BINDING_CHARS) &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return invalid();
    bindings.push(value as string | number | null);
  }
  return Object.freeze({ sql, bindings: Object.freeze(bindings) });
}

/** All operands are private, trusted SQL. Data remains bound, never interpolated.
 * Enforces the REAL aggregate limits of both durable repositories. */
export function combineQuotePredicates(
  ...raw: readonly QuoteLedgerPredicate[]
): QuoteLedgerPredicate {
  try {
    if (!raw.length || raw.length > MAX_PREDICATE_BINDINGS) return invalid();
    const captured = raw.map(capturePredicate);
    const sql = captured.map((value) => `(${value.sql})`).join(' AND ');
    const bindings = captured.flatMap((value) => [...value.bindings]);
    if (
      sql.length > MAX_PREDICATE_SQL ||
      bindings.length > MAX_PREDICATE_BINDINGS
    )
      return invalid();
    return Object.freeze({ sql, bindings: Object.freeze(bindings) });
  } catch {
    return invalid();
  }
}

/** Binding boundaries preserve surrogate pairs: concatenation cannot turn an
 * emoji into replacement characters while each parameter stays within 64KiB. */
function textEquality(
  column: string,
  value: string,
  bindings: (string | number | null)[],
): string {
  const segments: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + MAX_BINDING_CHARS, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end--;
    segments.push(value.slice(start, end));
    start = end;
  }
  if (!segments.length) segments.push('');
  bindings.push(...segments);
  return `${column}=(${segments.map(() => '?').join('||')})`;
}

/** Existing delegated Support source reader, with a detached SQL capability.
 * This checks no device, payment, catalogue or publication authority by itself. */
export async function readSupportQuoteSource(
  rawActor: ActionActor,
  rawSourceId: string,
): Promise<SupportQuoteSourceCapability> {
  const actor = captureActor(rawActor),
    sourceId = actionIdentifier(rawSourceId);
  const found = await database()
    .prepare(`SELECT t.id,t.workspace_id,t.connection_id,t.external_id,
    t.subject,t.body,t.source_json,t.fingerprint,t.revision,l.connected_by,
    l.created_at AS link_created_at,c.created_at AS connection_created_at,c.provider
    ${SOURCE_FROM} WHERE t.id=? AND l.organization_id=? AND ${SUPPORT_PERMISSION}`)
    .bind(sourceId, actor.organizationId)
    .first<SourceRow>();
  const row = captureSourceRow(found, sourceId);
  let envelope: SourceTicket;
  try {
    envelope = JSON.parse(row.source_json) as SourceTicket;
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      envelope.externalId !== row.external_id ||
      envelope.subject !== row.subject ||
      envelope.body !== row.body ||
      envelope.closed !== false ||
      envelope.incomplete === true ||
      envelope.mail?.bodyIncomplete === true ||
      envelope.senderIdentityAmbiguous === true
    )
      return invalid();
  } catch {
    return invalid();
  }
  let senderEmail: string;
  try {
    senderEmail = senderAddress(envelope);
  } catch {
    return invalid();
  }
  const senderName = connectorSenderName(envelope.senderName) ?? '';
  const material = JSON.stringify([
    'action-source-v1',
    ...SOURCE_KEYS.map((key) => row[key]),
  ]);
  const revision = await sha256Hex(material);
  const source: ActionSource = Object.freeze({
    id: sourceId,
    revision,
    organizationId: actor.organizationId,
    senderEmail,
    senderName,
    subject: row.subject,
    body: quoteMailBody(
      row.body,
      senderEmail,
      row.provider,
      Boolean(envelope.mail),
    ),
  });
  function predicate(purpose: SupportQuoteSourcePurpose): QuoteLedgerPredicate {
    if (purpose === 'read')
      return combineQuotePredicates({
        sql: `EXISTS(SELECT 1 FROM support_gestion_links l ${DELEGATION}
        WHERE l.workspace_id=? AND l.organization_id=? AND l.enabled=1 AND ${SUPPORT_PERMISSION})`,
        bindings: [row.workspace_id, actor.organizationId],
      });
    if (purpose !== 'progression') return invalid();
    const bindings: (string | number | null)[] = [actor.organizationId];
    const columns = [
      't.id',
      't.workspace_id',
      't.connection_id',
      't.external_id',
      't.subject',
      't.body',
      't.source_json',
      't.fingerprint',
      't.revision',
      'l.connected_by',
      'l.created_at',
      'c.created_at',
      'c.provider',
    ];
    const comparisons = SOURCE_KEYS.map((key, index) => {
      const value = row[key];
      if (typeof value === 'string')
        return textEquality(columns[index], value, bindings);
      bindings.push(value);
      return `${columns[index]}=?`;
    });
    return combineQuotePredicates({
      sql: `EXISTS(SELECT 1 ${SOURCE_FROM} WHERE l.organization_id=? AND ${SUPPORT_PERMISSION}
        AND w.mode IN ('automatic','review')
        AND ${comparisons.join(' AND ')})`,
      bindings,
    });
  }
  // The raw stamp stays in the closure. No raw SQL is ever accepted in a body.
  return Object.freeze({
    source,
    workspaceId: row.workspace_id,
    revision,
    predicate,
  });
}
