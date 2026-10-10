import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { snapshotPrivateJson } from './private-json';
import type { UsMailboxContext } from './us-support-mailbox-contract';
import type { UsSupplierDocumentRecord } from './us-supplier-document-contract';

export class UsMailboxImportError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'UsMailboxImportError'; }
}
export const US_MAILBOX_IMPORT_MAX_SOURCES = 500;
export const US_MAILBOX_IMPORT_MAX_REQUESTS = 2000;
export type UsMailboxImportMedia = 'application/pdf' | 'image/png' | 'image/jpeg';
export interface UsMailboxImportRequest {
  readonly schemaVersion: 1; readonly requestId: string; readonly connectionId: string; readonly expectedMailboxRevision: number;
  readonly uid: string; readonly attachmentId: string; readonly expectedMessageVersion: string;
}
/** Provider IDs and metadata stay private. Neither shape nor a digest proves
 * provider origin; the service verifies the fixed endpoint and actual bytes. */
export interface UsMailboxImportSource {
  readonly provider: 'infomaniak'; readonly mailboxId: string; readonly folderId: string; readonly uid: string; readonly attachmentId: string;
  readonly messageVersion: string; readonly messageSha256: string; readonly sourceName: string; readonly documentName: string;
  readonly receivedAt: number; readonly contentSha256: string; readonly sizeBytes: number; readonly mediaType: UsMailboxImportMedia;
}
export interface UsMailboxImportClaim {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string; readonly sourceHash: string;
  readonly connectionId: string; readonly mailboxRevision: number; readonly suggestedDocumentId: string;
  readonly source: UsMailboxImportSource; readonly claimedBy: string; readonly claimedAt: number;
}
export interface UsMailboxImportReservation {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string; readonly actorUserId: string;
  readonly requestId: string; readonly requestHash: string; readonly request: UsMailboxImportRequest;
  readonly claim: UsMailboxImportClaim; readonly createdAt: number;
}
/** Append-only confirmation of an already stored canonical PG original. The
 * service must reread R2 bytes first; D1 cannot verify another store or a blob. */
export interface UsMailboxImportCompletion {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string; readonly sourceHash: string;
  readonly documentId: string; readonly contentSha256: string; readonly sizeBytes: number; readonly mediaType: UsMailboxImportMedia;
  readonly completedBy: string; readonly completedAt: number;
}
export interface UsMailboxImportResult { readonly reservation: UsMailboxImportReservation; readonly completion: UsMailboxImportCompletion | null; readonly replayed: boolean }
export interface UsMailboxImportStore {
  find(this: void, context: UsMailboxContext, requestId: string, requestHash: string): Promise<UsMailboxImportResult | null>;
  claim(this: void, context: UsMailboxContext, input: { readonly request: UsMailboxImportRequest; readonly source: UsMailboxImportSource; readonly suggestedDocumentId: string }, revalidate: () => Promise<UsMailboxContext>): Promise<UsMailboxImportResult>;
  complete(this: void, context: UsMailboxContext, input: { readonly requestId: string; readonly requestHash: string; readonly document: UsSupplierDocumentRecord }, revalidate: () => Promise<UsMailboxContext>): Promise<UsMailboxImportResult>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const controls = /[\p{Cc}\p{Cf}]/u;
const requestKeys = ['schemaVersion','requestId','connectionId','expectedMailboxRevision','uid','attachmentId','expectedMessageVersion'] as const;
const sourceKeys = ['provider','mailboxId','folderId','uid','attachmentId','messageVersion','messageSha256','sourceName','documentName','receivedAt','contentSha256','sizeBytes','mediaType'] as const;
const fail = (code = 'invalid_mailbox_import_request', status = 422): never => { throw new UsMailboxImportError(code, status); };
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = snapshotPrivateJson(input);
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))
    || new TextEncoder().encode(canonicalErpJson(v)).length > 32_768) return fail();
  return v as Record<string, unknown>;
}
function id(v: unknown): v is string { return typeof v === 'string' && uuid.test(v); }
function digest(v: unknown): v is string { return typeof v === 'string' && hex.test(v); }
function integer(v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max; }
function second(v: unknown): v is number { return integer(v, 1, 253_402_300_799); }
function text(v: unknown, max: number): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max && !controls.test(v); }
function uid(v: unknown): v is string { return typeof v === 'string' && /^\d{1,20}$/.test(v); }
function part(v: unknown): v is string { return text(v, 200) && !/[\s/\\]/u.test(v); }
function privateValue<T>(read: () => T): T { try { return read(); } catch { return fail('invalid_mailbox_import_record', 503); } }

/** Preserve the raw mail filename separately, while deriving one bounded name
 * for the supplier vault. A canonical duplicate can retain a different name. */
export function usMailboxImportDocumentName(sourceName: string): string {
  if (!text(sourceName, 180) || /[/\\]/u.test(sourceName)) return fail();
  const match = /^(.*)\.(pdf|png|jpe?g)$/iu.exec(sourceName);
  if (!match) return fail();
  const extension = '.' + match[2].toLowerCase(), stem = match[1].normalize('NFC').trim() || 'attachment';
  return stem.slice(0, 160 - extension.length).replace(/[\uD800-\uDBFF]$/u, '') + extension;
}
export function validateUsMailboxImportRequest(input: unknown): UsMailboxImportRequest {
  try {
    const v = exact(input, requestKeys);
    if (v.schemaVersion !== 1 || !id(v.requestId) || !id(v.connectionId) || !integer(v.expectedMailboxRevision, 1, Number.MAX_SAFE_INTEGER - 1)
      || !uid(v.uid) || !part(v.attachmentId) || !text(v.expectedMessageVersion, 200)) return fail();
    return v as unknown as UsMailboxImportRequest;
  } catch { return fail(); }
}
export function validateUsMailboxImportSource(input: unknown): UsMailboxImportSource {
  return privateValue(() => {
    const v = exact(input, sourceKeys);
    if (v.provider !== 'infomaniak' || !text(v.mailboxId, 200) || v.mailboxId !== v.mailboxId.trim() || !text(v.folderId, 200) || v.folderId !== v.folderId.trim()
      || !uid(v.uid) || !part(v.attachmentId) || !text(v.messageVersion, 200) || !digest(v.messageSha256) || !text(v.sourceName, 180)
      || !text(v.documentName, 160) || v.documentName !== usMailboxImportDocumentName(v.sourceName) || !second(v.receivedAt) || !digest(v.contentSha256)
      || !integer(v.sizeBytes, 1, 6 * 1024 * 1024) || !['application/pdf','image/png','image/jpeg'].includes(String(v.mediaType))) return fail();
    const ext = v.documentName.toLowerCase().split('.').at(-1);
    if (v.mediaType !== (ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg')) return fail();
    return v as unknown as UsMailboxImportSource;
  });
}
export function validateUsMailboxImportClaim(input: unknown, organizationId?: string): UsMailboxImportClaim {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','workspaceId','sourceHash','connectionId','mailboxRevision','suggestedDocumentId','source','claimedBy','claimedAt']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.workspaceId) || !digest(v.sourceHash)
      || !id(v.connectionId) || !integer(v.mailboxRevision, 1, Number.MAX_SAFE_INTEGER - 1) || !id(v.suggestedDocumentId) || !id(v.claimedBy) || !second(v.claimedAt)) return fail();
    return Object.freeze({ ...v, source: validateUsMailboxImportSource(v.source) }) as unknown as UsMailboxImportClaim;
  });
}
export function validateUsMailboxImportReservation(input: unknown, organizationId?: string): UsMailboxImportReservation {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','workspaceId','actorUserId','requestId','requestHash','request','claim','createdAt']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.workspaceId)
      || !id(v.actorUserId) || !id(v.requestId) || !digest(v.requestHash) || !second(v.createdAt)) return fail();
    const request = validateUsMailboxImportRequest(v.request), claim = validateUsMailboxImportClaim(v.claim, v.organizationId);
    if (request.requestId !== v.requestId || claim.workspaceId !== v.workspaceId || claim.claimedAt > v.createdAt || request.uid !== claim.source.uid
      || request.attachmentId !== claim.source.attachmentId || request.expectedMessageVersion !== claim.source.messageVersion) return fail();
    return Object.freeze({ ...v, request, claim }) as unknown as UsMailboxImportReservation;
  });
}
export function validateUsMailboxImportCompletion(input: unknown, organizationId?: string): UsMailboxImportCompletion {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','workspaceId','sourceHash','documentId','contentSha256','sizeBytes','mediaType','completedBy','completedAt']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.workspaceId) || !digest(v.sourceHash)
      || !id(v.documentId) || !digest(v.contentSha256) || !integer(v.sizeBytes, 1, 6 * 1024 * 1024) || !['application/pdf','image/png','image/jpeg'].includes(String(v.mediaType))
      || !id(v.completedBy) || !second(v.completedAt)) return fail();
    return v as unknown as UsMailboxImportCompletion;
  });
}
export function validateUsMailboxImportResult(input: unknown, organizationId?: string): UsMailboxImportResult {
  return privateValue(() => {
    const v = exact(input, ['reservation','completion','replayed']), reservation = validateUsMailboxImportReservation(v.reservation, organizationId);
    const completion = v.completion === null ? null : validateUsMailboxImportCompletion(v.completion, reservation.organizationId), claim = reservation.claim;
    if (typeof v.replayed !== 'boolean' || completion && (completion.workspaceId !== reservation.workspaceId || completion.sourceHash !== claim.sourceHash
      || completion.contentSha256 !== claim.source.contentSha256 || completion.sizeBytes !== claim.source.sizeBytes || completion.mediaType !== claim.source.mediaType
      || completion.completedAt < claim.claimedAt)) return fail();
    return Object.freeze({ reservation, completion, replayed: v.replayed });
  });
}
export async function hashUsMailboxImportRequest(organizationId: string, actorUserId: string, input: UsMailboxImportRequest): Promise<string> {
  const request = validateUsMailboxImportRequest(input);
  if (!id(organizationId) || !id(actorUserId)) return fail();
  return sha256Hex(canonicalErpJson({ domain: 'zentra:us-support-mail-import:request:v1', organizationId, actorUserId, request }));
}
/** Stable locator, deliberately excluding version/content facts: reused or
 * changed UID/part under this mailbox/folder must conflict, not create a source. */
export async function hashUsMailboxImportSource(organizationId: string, workspaceId: string, input: UsMailboxImportSource): Promise<string> {
  const s = validateUsMailboxImportSource(input);
  if (!id(organizationId) || !id(workspaceId)) return fail();
  return sha256Hex(canonicalErpJson({ domain: 'zentra:us-support-mail-import:source:v1', organizationId, workspaceId,
    provider: s.provider, mailboxId: s.mailboxId, folderId: s.folderId, uid: s.uid, attachmentId: s.attachmentId }));
}
