import { sha256Hex } from '@/lib/account-security';
import type {
  QuoteExecutionReservation,
  QuoteReservationBinding,
} from './ledger-types';
import { captureQuoteReservationBinding } from './reservation-binding';
import { capturePublicationAttempt } from './publication-ledger';
import type { PublicationAttempt } from './publication-ledger-types';
import { withReadonlySqlite } from './sqlite-reader';
import type { DraftQuoteReceipt, StoredQuoteProposal } from './types';
import {
  captureProposal,
  captureReceipt,
  actionIdentifier,
} from './validation';

/** Private server capability. A deserialized or spread copy is never a proof. */
export type VerifiedCanonicalQuote = Readonly<{
  organizationId: string;
  proposalId: string;
  reservationId: string;
  fingerprint: string;
  userId: string;
  installationId: string;
  customerId: string;
  quoteId: string;
  publicationAttemptId: string;
  snapshotId: string;
  baseRevision: number;
  revision: number;
  archiveSha256: string;
  manifestSha256: string;
  sqliteSha256: string;
  receiptSha256: string;
  canonicalFactsSha256: string;
  validatorVersion: 'quote-canonical-v1';
  receipt: DraftQuoteReceipt;
  reservationBinding: QuoteReservationBinding;
}>;
const verified = new WeakSet<object>();
export class CanonicalQuoteError extends Error {
  constructor(readonly code: 'invalid_publication' | 'review_required') {
    super(code);
  }
}
const invalid = (): never => {
  throw new CanonicalQuoteError('invalid_publication');
};
const review = (): never => {
  throw new CanonicalQuoteError('review_required');
};
export function captureVerifiedCanonicalQuote(
  raw: VerifiedCanonicalQuote,
): VerifiedCanonicalQuote {
  if (!raw || typeof raw !== 'object' || !verified.has(raw)) return invalid();
  return raw;
}
function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  if (Reflect.ownKeys(raw).length !== keys.length) return invalid();
  const fields = Object.getOwnPropertyDescriptors(raw),
    copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = fields[key];
    if (!field?.enumerable || !('value' in field)) return invalid();
    copy[key] = field.value;
  }
  return copy;
}
function text(raw: unknown, max = 65536): string {
  if (
    typeof raw !== 'string' ||
    raw.length > max ||
    !raw.isWellFormed() ||
    raw.includes('\0')
  )
    return invalid();
  return raw;
}
function hash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return invalid();
  return raw;
}
function integer(raw: unknown, max = 1_000_000_000_000): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    Object.is(raw, -0) ||
    raw < 0 ||
    raw > max
  )
    return invalid();
  return raw;
}
function uuid(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      raw,
    )
  )
    return invalid();
  return raw;
}
function date(raw: unknown): string {
  const value = text(raw, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    return invalid();
  return value;
}
function timestamp(raw: unknown): string {
  const value = text(raw, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid();
  return value;
}
function nullableText(raw: unknown, max = 200): string | null {
  return raw === null ? null : text(raw, max);
}
function one(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> {
  if (rows.length !== 1) return review();
  return rows[0];
}
function copyBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  const proto = Object.getPrototypeOf(Uint8Array.prototype);
  /* oxlint-disable typescript/unbound-method -- Intrinsic getters are deliberately called with raw via Reflect.apply, never without a receiver. */
  try {
    const length = Reflect.apply(
      Object.getOwnPropertyDescriptor(proto, 'byteLength')!.get!,
      raw,
      [],
    );
    const buffer = Reflect.apply(
      Object.getOwnPropertyDescriptor(proto, 'buffer')!.get!,
      raw,
      [],
    );
    const offset = Reflect.apply(
      Object.getOwnPropertyDescriptor(proto, 'byteOffset')!.get!,
      raw,
      [],
    );
    const tag = Reflect.apply(
      Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag)!.get!,
      raw,
      [],
    );
    if (
      tag !== 'Uint8Array' ||
      !(buffer instanceof ArrayBuffer) ||
      length < 100 ||
      length > 8 * 1024 * 1024
    )
      return invalid();
    const copy = new Uint8Array(length);
    Uint8Array.prototype.set.call(copy, new Uint8Array(buffer, offset, length));
    return copy;
  } catch {
    return invalid();
  }
  /* oxlint-enable typescript/unbound-method */
}
function reservation(
  raw: unknown,
  proposal: StoredQuoteProposal,
): QuoteExecutionReservation {
  const r = exact(raw, [
    'id',
    'organizationId',
    'proposalId',
    'fingerprint',
    'userId',
    'installationId',
    'customerId',
    'quoteId',
    'createdAt',
    'receipt',
  ]);
  if (
    r.organizationId !== proposal.organizationId ||
    r.proposalId !== proposal.id ||
    r.fingerprint !== proposal.fingerprint ||
    r.receipt !== null
  )
    return invalid();
  const result: QuoteExecutionReservation = Object.freeze({
    id: uuid(r.id),
    organizationId: proposal.organizationId,
    proposalId: proposal.id,
    fingerprint: proposal.fingerprint,
    userId: actionIdentifier(r.userId),
    installationId: uuid(r.installationId),
    customerId: actionIdentifier(r.customerId),
    quoteId: uuid(r.quoteId),
    createdAt: integer(r.createdAt, 253402300799),
    receipt: null,
  });
  if (
    proposal.plan.customer?.kind === 'existing'
      ? result.customerId !== proposal.plan.customer.id
      : !uuid(result.customerId)
  )
    return invalid();
  return result;
}
async function lineId(
  proposal: StoredQuoteProposal,
  quoteId: string,
  position: number,
): Promise<string> {
  const digest = await sha256Hex(
    `action-engine-quote-line-v1\n${proposal.id}\n${proposal.fingerprint}\n${quoteId}\n${position}`,
  );
  const bytes = Uint8Array.from(digest.slice(0, 32).match(/../g)!, (x) =>
    parseInt(x, 16),
  );
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * First-proof verifier. All reads come from the real, bounded SQLite file.
 * The audit/receipt only corroborate these rows; neither can replace them.
 * Edited/issued/deleted before the first proof => human review, never re-create.
 * No source body, customer name or price is retained in the evidence capability.
 * The caller must first corroborate this exact archive against the permanent PG
 * fact and verify archive/chunk hashes; the D1 writer rechecks historical identity.
 */
export async function verifyCanonicalQuotePublication(
  raw: Readonly<{
    proposal: StoredQuoteProposal;
    reservation: QuoteExecutionReservation;
    binding: QuoteReservationBinding;
    publication: PublicationAttempt;
    sqliteBytes: Uint8Array;
  }>,
): Promise<VerifiedCanonicalQuote> {
  const input = exact(raw, [
    'proposal',
    'reservation',
    'binding',
    'publication',
    'sqliteBytes',
  ]);
  // Every caller-owned field and byte is detached before the first await.
  const rawReservation = exact(input.reservation, [
    'id',
    'organizationId',
    'proposalId',
    'fingerprint',
    'userId',
    'installationId',
    'customerId',
    'quoteId',
    'createdAt',
    'receipt',
  ]);
  const proposal = captureProposal(input.proposal, {
    organizationId: actionIdentifier(rawReservation.organizationId),
    userId: actionIdentifier(rawReservation.userId),
  });
  const r = reservation(rawReservation, proposal),
    binding = captureQuoteReservationBinding(input.binding);
  const publication = capturePublicationAttempt(input.publication),
    bytes = copyBytes(input.sqliteBytes);
  const plan = proposal.plan,
    canonicalPlan = JSON.stringify(plan);
  if (
    plan.status !== 'ready' ||
    plan.currency !== 'CHF' ||
    plan.reasons.length ||
    !plan.customer ||
    plan.lines.length < 1 ||
    plan.lines.length > 8 ||
    plan.confidence === null ||
    plan.confidence < 0.95
  )
    return invalid();
  if (
    binding.planningPublication.organizationId !== r.organizationId ||
    publication.organizationId !== r.organizationId ||
    publication.userId !== r.userId ||
    publication.installationId !== r.installationId ||
    publication.state !== 'committed' ||
    !publication.result?.committed ||
    publication.result.revision <= binding.planningPublication.revision ||
    publication.createdAt < r.createdAt
  )
    return invalid();
  if ((await sha256Hex(canonicalPlan)) !== proposal.fingerprint)
    return invalid();
  const expectedReceipt = captureReceipt(
    {
      organizationId: r.organizationId,
      proposalId: r.proposalId,
      fingerprint: r.fingerprint,
      customerId: r.customerId,
      quoteId: r.quoteId,
      quoteNumber: null,
      status: 'draft',
      requiresHumanValidation: true,
    },
    proposal,
  );
  const receiptJson = JSON.stringify(expectedReceipt),
    receiptSha256 = await sha256Hex(receiptJson);
  const requestSha256 = await sha256Hex(
    JSON.stringify([
      1,
      r.organizationId,
      r.userId,
      r.installationId,
      r.proposalId,
      r.id,
      r.fingerprint,
      binding.sourceCanonicalSha256,
      binding.resourcesSha256,
      plan.contextRevision,
      r.customerId,
      r.quoteId,
    ]),
  );
  const expectedLineIds = await Promise.all(
    plan.lines.map((_, position) => lineId(proposal, r.quoteId, position)),
  );
  const rows = await withReadonlySqlite(bytes, (db) => ({
    receipt: one(
      db.query(
        'SELECT organization_id,source_id,action_kind,proposal_id,reservation_id,fingerprint,request_sha256,resources_sha256,context_revision,actor_user_id,installation_id,customer_id,quote_id,plan_json,receipt_json,receipt_sha256,created_at FROM action_engine_quote_receipts WHERE organization_id=? AND source_id=? AND action_kind=? LIMIT 2',
        [r.organizationId, plan.sourceId, plan.kind],
        2,
      ),
    ),
    customer: one(
      db.query(
        'SELECT id,name,email,country,archived_at,created_at,updated_at FROM clients WHERE id=? LIMIT 2',
        [r.customerId],
        2,
      ),
    ),
    quote: one(
      db.query(
        'SELECT id,client_id,project_id,number,title,status,issue_date,valid_until,currency,subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,snapshot_json,created_at,updated_at FROM quotes WHERE id=? LIMIT 2',
        [r.quoteId],
        2,
      ),
    ),
    lines: db.query(
      'SELECT id,quote_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at FROM quote_items WHERE quote_id=? ORDER BY position,id COLLATE BINARY LIMIT 9',
      [r.quoteId],
      9,
    ),
    audit: one(
      db.query(
        "SELECT id,occurred_at,actor,action,entity_type,entity_id,payload_json,previous_hash,entry_hash FROM audit_log WHERE entity_type='action_engine_quote' AND entity_id=? AND action='create' LIMIT 2",
        [r.quoteId],
        2,
      ),
    ),
  }));
  const native = rows.receipt;
  const identity: Record<string, unknown> = {
    organization_id: r.organizationId,
    source_id: plan.sourceId,
    action_kind: plan.kind,
    proposal_id: r.proposalId,
    reservation_id: r.id,
    fingerprint: r.fingerprint,
    request_sha256: requestSha256,
    resources_sha256: binding.resourcesSha256,
    context_revision: plan.contextRevision,
    actor_user_id: r.userId,
    installation_id: r.installationId,
    customer_id: r.customerId,
    quote_id: r.quoteId,
    plan_json: canonicalPlan,
    receipt_json: receiptJson,
    receipt_sha256: receiptSha256,
  };
  for (const [key, value] of Object.entries(identity))
    if (native[key] !== value) return invalid();
  const createdAt = timestamp(native.created_at),
    c = rows.customer,
    q = rows.quote;
  const customer = {
    id: text(c.id, 160),
    name: text(c.name, 200),
    email: nullableText(c.email, 254),
    country: text(c.country, 2),
    archivedAt: nullableText(c.archived_at, 64),
    createdAt: timestamp(c.created_at),
    updatedAt: timestamp(c.updated_at),
  };
  if (
    customer.id !== r.customerId ||
    customer.name !== plan.customer.name ||
    customer.archivedAt !== null ||
    (plan.customer.kind === 'new' &&
      (customer.email !== plan.customer.email ||
        customer.country !== 'CH' ||
        customer.createdAt !== createdAt ||
        customer.updatedAt !== createdAt))
  )
    return review();
  const quote = {
    id: text(q.id, 160),
    clientId: text(q.client_id, 160),
    projectId: nullableText(q.project_id, 160),
    number: nullableText(q.number, 160),
    title: text(q.title, 300),
    status: text(q.status, 40),
    issueDate: date(q.issue_date),
    validUntil: date(q.valid_until),
    currency: text(q.currency, 3),
    subtotalCents: integer(q.subtotal_cents),
    discountCents: integer(q.discount_cents),
    vatCents: integer(q.vat_cents),
    totalCents: integer(q.total_cents),
    notes: nullableText(q.notes, 16000),
    terms: nullableText(q.terms, 16000),
    snapshotJson: nullableText(q.snapshot_json),
    createdAt: timestamp(q.created_at),
    updatedAt: timestamp(q.updated_at),
  };
  if (
    quote.id !== r.quoteId ||
    quote.clientId !== r.customerId ||
    quote.projectId !== null ||
    quote.number !== null ||
    quote.title !== plan.title ||
    quote.status !== 'brouillon' ||
    quote.currency !== 'CHF' ||
    quote.discountCents !== 0 ||
    quote.notes !== null ||
    quote.terms !== null ||
    quote.snapshotJson !== null ||
    quote.createdAt !== createdAt ||
    quote.updatedAt !== createdAt ||
    quote.validUntil < quote.issueDate ||
    Date.parse(quote.validUntil) - Date.parse(quote.issueDate) >
      365 * 86400000 ||
    rows.lines.length !== plan.lines.length
  )
    return review();
  let net = BigInt(0),
    tax = BigInt(0),
    total = BigInt(0);
  const lines = rows.lines.map((row, position) => {
    const p = plan.lines[position],
      n =
        (BigInt(p.quantityMilli) * BigInt(p.unitPriceCents) + BigInt(500)) /
        BigInt(1000),
      v = (n * BigInt(p.taxRateBp) + BigInt(5000)) / BigInt(10000);
    const actual = {
      id: text(row.id, 160),
      quoteId: text(row.quote_id, 160),
      catalogItemId: text(row.catalog_item_id, 160),
      position: integer(row.position, 7),
      description: text(row.description, 1000),
      quantityMilli: p.quantityMilli,
      unit: text(row.unit, 40),
      unitPriceCents: integer(row.unit_price_cents),
      discountBp: integer(row.discount_bp, 10000),
      vatBp: integer(row.vat_bp, 10000),
      lineNetCents: integer(row.line_net_cents),
      lineVatCents: integer(row.line_vat_cents),
      lineTotalCents: integer(row.line_total_cents),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    };
    if (
      actual.id !== expectedLineIds[position] ||
      actual.quoteId !== r.quoteId ||
      actual.catalogItemId !== p.articleId ||
      actual.position !== position ||
      actual.description !== p.description ||
      typeof row.quantity !== 'number' ||
      !Number.isFinite(row.quantity) ||
      row.quantity !== p.quantityMilli / 1000 ||
      actual.unit !== p.unit ||
      actual.unitPriceCents !== p.unitPriceCents ||
      actual.discountBp !== 0 ||
      actual.vatBp !== p.taxRateBp ||
      BigInt(actual.lineNetCents) !== n ||
      n !== BigInt(p.netCents) ||
      BigInt(actual.lineVatCents) !== v ||
      BigInt(actual.lineTotalCents) !== n + v ||
      actual.createdAt !== createdAt ||
      actual.updatedAt !== createdAt
    )
      return review();
    net += n;
    tax += v;
    total += n + v;
    return actual;
  });
  if (
    BigInt(quote.subtotalCents) !== net ||
    net !== BigInt(plan.netCents) ||
    BigInt(quote.vatCents) !== tax ||
    BigInt(quote.totalCents) !== total
  )
    return review();
  const creationJson = JSON.stringify({
    version: 1,
    sourceCanonicalSha256: binding.sourceCanonicalSha256,
    customerCreated: plan.customer.kind === 'new',
    customer,
    quote,
    lines,
  });
  const creationSha256 = await sha256Hex(creationJson),
    a = rows.audit;
  const payloadJson = text(a.payload_json);
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch {
    return invalid();
  }
  const payload = exact(parsedPayload, [
    'receipt',
    'reservationId',
    'requestSha256',
    'quantityMilli',
    'netCents',
    'vatCents',
    'totalCents',
    'creationJson',
    'creationSha256',
  ]);
  if (
    a.actor !== 'local_user' ||
    JSON.stringify(parsedPayload) !== payloadJson ||
    JSON.stringify(captureReceipt(payload.receipt, proposal)) !== receiptJson ||
    payload.reservationId !== r.id ||
    payload.requestSha256 !== requestSha256 ||
    JSON.stringify(payload.quantityMilli) !==
      JSON.stringify(plan.lines.map((x) => x.quantityMilli)) ||
    payload.netCents !== Number(net) ||
    payload.vatCents !== Number(tax) ||
    payload.totalCents !== Number(total) ||
    payload.creationJson !== creationJson ||
    payload.creationSha256 !== creationSha256
  )
    return invalid();
  const auditHash = await sha256Hex(
    `${a.previous_hash === null ? '' : hash(a.previous_hash)}\n${uuid(a.id)}\n${timestamp(a.occurred_at)}\n${text(a.actor, 160)}\ncreate\naction_engine_quote\n${r.quoteId}\n${payloadJson}`,
  );
  if (auditHash !== a.entry_hash) return invalid();
  const result: VerifiedCanonicalQuote = Object.freeze({
    organizationId: r.organizationId,
    proposalId: r.proposalId,
    reservationId: r.id,
    fingerprint: r.fingerprint,
    userId: r.userId,
    installationId: r.installationId,
    customerId: r.customerId,
    quoteId: r.quoteId,
    publicationAttemptId: publication.id,
    snapshotId: publication.snapshotId,
    baseRevision: publication.baseRevision,
    revision: publication.result.revision,
    archiveSha256: publication.archiveSha256,
    manifestSha256: publication.manifestSha256,
    sqliteSha256: await sha256Hex(bytes),
    receiptSha256,
    canonicalFactsSha256: await sha256Hex(
      JSON.stringify([1, creationSha256, receiptSha256, requestSha256]),
    ),
    validatorVersion: 'quote-canonical-v1',
    receipt: expectedReceipt,
    reservationBinding: binding,
  });
  verified.add(result);
  return result;
}
