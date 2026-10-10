import { mailDate, mailRequest, readMailAttachment } from '../support/infomaniak';
import { SupportError } from '../support/types';
import { canonicalErpJson, ErpError } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { UsMailboxError, validateUsMailboxConnection, type UsMailboxConnection } from './us-support-mailbox-contract';
import { usMailboxImportDocumentName, validateUsMailboxImportRequest, type UsMailboxImportRequest, type UsMailboxImportSource } from './us-support-mailbox-import-contract';
import { supplierDocumentMedia } from './us-supplier-document-bytes';
import { US_SUPPLIER_DOCUMENT_MAX_BYTES } from './us-supplier-document-contract';

type Check = () => Promise<unknown>;
const origin = 'https://mail.infomaniak.com';
const invalid = (): never => { throw new UsMailboxError('mailbox_attachment_unavailable', 422); };
const changed = (): never => { throw new UsMailboxError('mailbox_source_conflict', 409); };
const controls = /[\p{Cc}\p{Cf}]/u;
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
}
function text(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max || controls.test(v)) return invalid();
  return v;
}
function segment(v: string): string {
  if (!v || v.length > 200 || /[\s/\\?#%]/u.test(v) || controls.test(v) || v === '.' || v === '..') return invalid();
  return encodeURIComponent(v);
}
function attachmentId(a: Record<string, unknown>, parent: string): string {
  if (a.resource !== undefined && a.resource !== null && a.resource !== '') {
    const resource = text(a.resource, 1200);
    // Inspect the locator, but never fetch a resource URL supplied by a mail.
    // Relative /mail and /api/mail are accepted; external origins and another
    // mailbox/folder/message parent are rejected, even with a usable part_id.
    let url: URL;
    try { url = new URL(resource, origin + '/api/'); } catch { return invalid(); }
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return invalid();
    const path = url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
    if (!path.startsWith(parent + '/attachment/')) return invalid();
    const id = path.slice((parent + '/attachment/').length);
    if (!id || id.includes('/')) return invalid();
    let decoded: string;
    try { decoded = decodeURIComponent(id); } catch { return invalid(); }
    if (segment(decoded) !== id) return invalid();
    return decoded;
  }
  const id = typeof a.part_id === 'number' && Number.isSafeInteger(a.part_id) ? String(a.part_id) : text(a.part_id, 200);
  segment(id); return id;
}
function observation(raw: unknown, connection: UsMailboxConnection, request: UsMailboxImportRequest) {
  const m = object(raw);
  // readMail's legacy uid field copies the requested UID. Only the actual
  // upstream compound UID corroborates the source in this strict US adapter.
  if (m.uid !== request.uid + '@' + connection.folderId) return changed();
  const version = typeof m.date === 'number' || typeof m.date === 'string' ? String(m.date) : '';
  if (version !== request.expectedMessageVersion) return changed();
  const date = mailDate(m.date);
  if (date === null || !Number.isSafeInteger(date) || date <= 0 || date > 253_402_300_799) return invalid();
  if (!Array.isArray(m.attachments) || m.attachments.length > 100) return invalid();
  const parent = `/mail/${segment(connection.mailboxId)}/folder/${segment(connection.folderId)}/message/${segment(request.uid)}`;
  const ids = new Set<string>();
  const attachments = m.attachments.map(rawPart => {
    const a = object(rawPart), id = attachmentId(a, parent);
    if (ids.has(id)) return invalid(); ids.add(id);
    const name = text(a.name, 180);
    if (/[/\\]/u.test(name) || name !== name.trim()) return invalid();
    const size = typeof a.size === 'number' ? a.size : typeof a.size === 'string' && /^\d+$/.test(a.size) ? Number(a.size) : NaN;
    if (!Number.isSafeInteger(size) || size < 0 || size > US_SUPPLIER_DOCUMENT_MAX_BYTES) return invalid();
    const mime = a.mime_type === undefined || a.mime_type === null ? null : text(a.mime_type, 120).toLowerCase();
    if (a.is_inline !== undefined && typeof a.is_inline !== 'boolean') return invalid();
    return { id, name, size, mime, inline: a.is_inline === true };
  }).sort((a,b) => a.id.localeCompare(b.id, 'en'));
  const part = attachments.find(a => a.id === request.attachmentId);
  if (!part || part.inline || !part.size) return invalid();
  const extension = /\.(pdf|png|jpe?g)$/i.exec(part.name)?.[1]?.toLowerCase();
  const mediaType: UsMailboxImportSource['mediaType'] = extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : invalid();
  if (part.mime !== null && part.mime !== mediaType && part.mime !== 'application/octet-stream') return invalid();
  const from = m.from === undefined ? [] : m.from;
  if (!Array.isArray(from) || from.length > 100) return invalid();
  const sender = from.map(rawSender => { const s = object(rawSender); return { name: s.name === undefined ? '' : text(s.name, 300, true), email: s.email === undefined ? '' : text(s.email, 254, true) }; });
  const subject = m.subject === undefined ? '' : text(m.subject, 1000, true);
  return { part, mediaType, receivedAt: date, metadata: canonicalErpJson({ uid: m.uid, version, subject, sender, attachments }) };
}
function guarded(fetcher: typeof fetch, check: Check, deadline: AbortSignal): typeof fetch {
  return async (input, init) => {
    deadline.throwIfAborted(); await check(); deadline.throwIfAborted();
    const response = await fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    try { await check(); deadline.throwIfAborted(); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    return response;
  };
}
/** Explicit read-only provider boundary. Two observations are not an atomic
 * mailbox snapshot: no UIDVALIDITY/ETag contract has been established. */
export function createUsMailboxImportProvider(fetcher: typeof fetch = fetch) {
  return async (connection: UsMailboxConnection, token: string, request: UsMailboxImportRequest, check: Check): Promise<{ source: UsMailboxImportSource; bytes: Uint8Array }> => {
    try {
      connection = validateUsMailboxConnection(connection); request = validateUsMailboxImportRequest(request);
      if (!/^\d{1,20}$/.test(request.uid)) return invalid();
      segment(request.attachmentId);
      const deadline = AbortSignal.timeout(30_000), transport = guarded(fetcher, check, deadline);
      const path = `/mail/${segment(connection.mailboxId)}/folder/${segment(connection.folderId)}/message/${segment(request.uid)}?prefered_format=html&with=auto_uncrypt,thread_context`;
      const first = observation(await mailRequest(token, path, transport), connection, request); await check(); deadline.throwIfAborted();
      const bytes = await readMailAttachment(token, connection.mailboxId, connection.folderId, request.uid, request.attachmentId, transport); await check(); deadline.throwIfAborted();
      if (bytes.length !== first.part.size || supplierDocumentMedia(bytes, first.mediaType) !== first.mediaType) return invalid();
      const second = observation(await mailRequest(token, path, transport), connection, request); await check(); deadline.throwIfAborted();
      if (second.metadata !== first.metadata) return changed();
      const source: UsMailboxImportSource = { provider: 'infomaniak', mailboxId: connection.mailboxId, folderId: connection.folderId, uid: request.uid, attachmentId: request.attachmentId,
        messageVersion: request.expectedMessageVersion, messageSha256: await sha256Hex(first.metadata), sourceName: first.part.name, documentName: usMailboxImportDocumentName(first.part.name),
        receivedAt: first.receivedAt, contentSha256: await sha256Hex(bytes), sizeBytes: bytes.length, mediaType: first.mediaType };
      await check(); deadline.throwIfAborted(); return { source, bytes };
    } catch (error) {
      if (error instanceof UsMailboxError) throw error;
      if (error instanceof SupportError && [401,403,422].includes(error.status)) throw new UsMailboxError('mailbox_credentials_rejected', 422);
      if (error instanceof ErpError && error.code === 'invalid_supplier_document') return invalid();
      throw new UsMailboxError('mailbox_provider_unavailable', 503);
    }
  };
}
