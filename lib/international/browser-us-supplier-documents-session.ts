import type { AccountRole } from '../account-security';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { creationUuid } from './workspace-creation';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import type { UsSupplierProposal } from './us-supplier-contract';
import { US_SUPPLIER_DOCUMENT_MAX_BYTES, type UsSupplierDocument, type UsSupplierDocumentMedia } from './us-supplier-document-contract';

export class BrowserUsSupplierDocumentError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized' = 'rejected') { super(code); this.name = 'BrowserUsSupplierDocumentError'; }
}
export type BrowserUsSupplierDocumentResult = { readonly action: 'import'; readonly document: UsSupplierDocument; readonly replayed: boolean } | { readonly action: 'analyze'; readonly document: UsSupplierDocument; readonly proposal: UsSupplierProposal; readonly replayed: boolean };
export interface BrowserUsSupplierDocumentsSession {
  load(): Promise<readonly UsSupplierDocument[]>;
  import(input: { fileName: string; mediaType: UsSupplierDocumentMedia; bytes: ArrayBuffer }): Promise<BrowserUsSupplierDocumentResult>;
  analyze(document: UsSupplierDocument, consent: true): Promise<BrowserUsSupplierDocumentResult>;
  download(document: UsSupplierDocument): Promise<Blob>;
  retry(): Promise<BrowserUsSupplierDocumentResult>;
  hasPending(): boolean;
  pendingAction(): 'import' | 'analyze' | null;
  dispose(): void;
}
const media = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
const known = new Set(['invalid_request', 'invalid_supplier_document', 'supplier_document_conflict', 'supplier_document_not_found', 'supplier_document_limit_reached', 'invalid_supplier_document_record', 'supplier_document_archive_unavailable', 'supplier_source_unreadable', 'supplier_source_conflict', 'supplier_analysis_unavailable', 'supplier_analysis_failed', 'automation_consent_required', 'automation_quota_exceeded', 'automation_grant_expired', 'automation_limit_reached', 'automation_busy', 'automation_dispatch_uncertain', 'automation_entitlement_required', 'automation_permission_required', 'configuration_changed', 'feature_unavailable', 'edition_unavailable', 'client_upgrade_required', 'supplier_upgrade_required', 'rate_limited', 'service_unavailable']);
const rejected = new Set(['invalid_request', 'invalid_supplier_document', 'supplier_document_conflict', 'supplier_document_limit_reached', 'supplier_source_unreadable', 'supplier_source_conflict', 'automation_consent_required', 'automation_quota_exceeded', 'automation_grant_expired', 'automation_limit_reached', 'automation_busy', 'automation_dispatch_uncertain']);
const control = (value: string) => Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; });
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('shape');
  const names = Reflect.ownKeys(input); if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('shape');
  const value: Record<string, unknown> = {};
  for (const key of keys) { const item = Object.getOwnPropertyDescriptor(input, key); if (!item?.enumerable || !('value' in item)) throw new Error('shape'); value[key] = item.value; }
  return value;
}
export function validateBrowserUsSupplierDocument(input: unknown, organizationId: string): UsSupplierDocument {
  const v = exact(input, ['schemaVersion', 'organizationId', 'id', 'contentSha256', 'sizeBytes', 'mediaType', 'fileName', 'createdBy', 'createdAt', 'stored', 'proposalId', 'readable']);
  creationUuid(v.id); if (v.proposalId !== null) creationUuid(v.proposalId);
  if (typeof v.createdBy !== 'string' || !v.createdBy.trim() || v.createdBy.length > 256 || control(v.createdBy)) throw new Error('shape');
  if (v.schemaVersion !== 1 || v.organizationId !== organizationId || typeof v.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.contentSha256) || !Number.isSafeInteger(v.sizeBytes) || (v.sizeBytes as number) < 1 || (v.sizeBytes as number) > US_SUPPLIER_DOCUMENT_MAX_BYTES || typeof v.mediaType !== 'string' || !media.has(v.mediaType) || typeof v.fileName !== 'string' || !v.fileName.trim() || v.fileName.length > 160 || !v.fileName.isWellFormed() || control(v.fileName) || typeof v.createdAt !== 'string' || v.createdAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v.createdAt) || !Number.isFinite(Date.parse(v.createdAt)) || typeof v.stored !== 'boolean' || typeof v.readable !== 'boolean' || v.proposalId !== null && (!v.stored || !v.readable)) throw new Error('shape');
  return Object.freeze(v) as unknown as UsSupplierDocument;
}
type Pending = { action: 'import'; id: string; fileName: string; mediaType: UsSupplierDocumentMedia; bytes: Uint8Array<ArrayBuffer>; digest: string } | { action: 'analyze'; document: UsSupplierDocument; body: string };
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join(''); }

/** One exact operation and binary snapshot in RAM. Reads and receipts never
 * grant access, and disposing the actor epoch aborts and purges every buffer. */
export function createBrowserUsSupplierDocumentsSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; supportedSchemaVersion: number; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsSupplierDocumentsSession {
  const { organizationId, expectedUserId } = options;
  try { creationUuid(organizationId); } catch { throw new BrowserUsSupplierDocumentError('invalid_request', 422); }
  if (!expectedUserId || expectedUserId !== expectedUserId.trim() || expectedUserId.length > 256 || control(expectedUserId) || options.supportedSchemaVersion !== 4 || !['owner', 'admin', 'accountant'].includes(options.role)) throw new BrowserUsSupplierDocumentError('forbidden', 403, 'unauthorized');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), url = `/api/international/workspaces/${encodeURIComponent(organizationId)}/supplier-documents`;
  const controllers = new Set<AbortController>(), cancels = new Set<() => void>();
  let disposed = false, epoch = 0, mutation = 0, reading = 0, writing = false, reserving = false, readRequired = true, pending: Pending | null = null, reservedBytes: Uint8Array<ArrayBuffer> | null = null;
  const alive = (started = epoch) => { if (disposed || started !== epoch) throw new BrowserUsSupplierDocumentError('session_changed', 0, 'unauthorized'); };
  function clearPending() { if (pending?.action === 'import') pending.bytes.fill(0); pending = null; }
  function dispose() { if (disposed) return; disposed = true; epoch++; clearPending(); reservedBytes?.fill(0); reservedBytes = null; for (const cancel of cancels) cancel(); cancels.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  async function response(path: string, method: 'GET' | 'PUT' | 'POST', body?: BodyInit, extra: Record<string, string> = {}, binary = false): Promise<unknown> {
    const started = epoch, write = method !== 'GET', controller = new AbortController(); alive(started); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {}, status = 0;
    const stop = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsSupplierDocumentError('session_changed', 0, 'unauthorized')); cancels.add(cancel); });
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsSupplierDocumentError('response_timeout', 0, write ? 'uncertain' : 'rejected')); }, options.timeoutMs ?? 30_000); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, stop, deadline]);
    try {
      const res = await wait(fetcher(url + path, { method, headers: { Accept: binary ? '*/*' : 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': expectedUserId, ...extra }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(started);
      status = res.status;
      if ([401, 403].includes(res.status)) { dispose(); throw new BrowserUsSupplierDocumentError(res.status === 403 ? 'forbidden' : 'unauthorized', res.status, 'unauthorized'); }
      const maximum = res.ok ? binary ? US_SUPPLIER_DOCUMENT_MAX_BYTES : 2_621_440 : 4096, length = res.headers.get('Content-Length'), contentType = res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if ((!binary || !res.ok) && contentType !== 'application/json' || binary && res.ok && !media.has(contentType ?? '') || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new BrowserUsSupplierDocumentError('invalid_response', res.status, write ? 'uncertain' : 'rejected');
      const chunks: Uint8Array[] = [], reader = res.body?.getReader(); let size = 0;
      if (reader) { try { for (;;) { const item = await wait(reader.read()); alive(started); if (item.done) break; size += item.value.byteLength; if (size > maximum) { void reader.cancel(); throw new BrowserUsSupplierDocumentError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); } chunks.push(item.value); } } finally { reader.releaseLock(); } }
      else { const bytes = new Uint8Array(await wait(res.arrayBuffer())); alive(started); size = bytes.length; if (size > maximum) throw new BrowserUsSupplierDocumentError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); chunks.push(bytes); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (binary && res.ok) return { bytes, contentType };
      let input: unknown; try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new BrowserUsSupplierDocumentError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); }
      if (!res.ok) {
        let code = 'service_unavailable'; try { const v = exact(input, ['error']); if (typeof v.error === 'string' && known.has(v.error)) code = v.error; } catch { /* No private message reaches UI. */ }
        if (res.status === 402) {
          if (method === 'POST' && path.endsWith('/analyze') && code === 'automation_entitlement_required') { clearPending(); readRequired = true; throw new BrowserUsSupplierDocumentError(code, res.status); }
          dispose(); throw new BrowserUsSupplierDocumentError('management_entitlement_required', res.status, 'unauthorized');
        }
        if (code === 'feature_unavailable' || code === 'edition_unavailable' || code === 'client_upgrade_required' || code === 'supplier_upgrade_required') { dispose(); throw new BrowserUsSupplierDocumentError(code, res.status, 'unauthorized'); }
        if (write && [409, 422].includes(res.status) && rejected.has(code)) { clearPending(); readRequired = true; throw new BrowserUsSupplierDocumentError(code, res.status); }
        throw new BrowserUsSupplierDocumentError(code, res.status, write ? 'uncertain' : 'rejected');
      }
      return input;
    } catch (error) { if (status === 402 && !(error instanceof BrowserUsSupplierDocumentError && error.code === 'automation_entitlement_required')) { dispose(); throw new BrowserUsSupplierDocumentError('management_entitlement_required', 402, 'unauthorized'); } if (error instanceof BrowserUsSupplierDocumentError) throw error; alive(started); throw new BrowserUsSupplierDocumentError('service_unavailable', 0, write ? 'uncertain' : 'rejected'); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancels.delete(cancel); }
  }
  async function send(): Promise<BrowserUsSupplierDocumentResult> {
    alive(); if (writing || !pending) throw new BrowserUsSupplierDocumentError(writing ? 'pending_operation' : 'no_pending_operation', 409);
    const saved = pending, started = epoch; writing = true; mutation++;
    try {
      const raw = saved.action === 'import' ? await response('/' + saved.id, 'PUT', saved.bytes.slice().buffer, { 'Content-Type': saved.mediaType, 'X-Zentra-File-Name': encodeURIComponent(saved.fileName) }) : await response('/' + saved.document.id + '/analyze', 'POST', saved.body, { 'Content-Type': 'application/json' }); alive(started);
      let result: BrowserUsSupplierDocumentResult;
      try {
        const v = exact(raw, saved.action === 'import' ? ['document', 'replayed'] : ['document', 'proposal', 'replayed']), document = validateBrowserUsSupplierDocument(v.document, organizationId);
        if (!document.stored || typeof v.replayed !== 'boolean') throw new Error('shape');
        if (saved.action === 'import') {
          if (document.contentSha256 !== saved.digest || document.sizeBytes !== saved.bytes.byteLength || !v.replayed && (document.id !== saved.id || document.fileName !== saved.fileName || document.mediaType !== saved.mediaType || document.createdBy !== expectedUserId)) throw new Error('shape');
          result = { action: 'import', document, replayed: v.replayed };
        } else {
          const proposal = validateUsSupplierProposal(v.proposal, organizationId);
          if (document.id !== saved.document.id || document.contentSha256 !== saved.document.contentSha256 || document.proposalId !== proposal.id || !document.readable) throw new Error('shape');
          result = { action: 'analyze', document, proposal, replayed: v.replayed };
        }
      } catch { throw new BrowserUsSupplierDocumentError('invalid_response', 503, 'uncertain'); }
      clearPending(); return Object.freeze(result);
    } finally { writing = false; readRequired = true; mutation++; }
  }
  function canStart() { alive(); if (pending || writing || reserving) throw new BrowserUsSupplierDocumentError('pending_operation', 409); if (readRequired) throw new BrowserUsSupplierDocumentError('read_required', 409); }
  return {
    async load() {
      const started = epoch, version = mutation, sequence = ++reading; alive(started); const input = await response('', 'GET'); alive(started);
      if (version !== mutation || sequence !== reading) throw new BrowserUsSupplierDocumentError('stale_read', 0);
      try { const v = exact(input, ['documents']); if (!Array.isArray(v.documents) || v.documents.length > 50) throw new Error('shape'); const documents = v.documents.map(value => validateBrowserUsSupplierDocument(value, organizationId)); if (new Set(documents.map(value => value.id)).size !== documents.length || new Set(documents.map(value => value.contentSha256)).size !== documents.length) throw new Error('shape'); readRequired = false; return Object.freeze(documents); } catch { throw new BrowserUsSupplierDocumentError('invalid_response', 503); }
    },
    async import(input) {
      canStart(); const started = epoch; reserving = true;
      try {
        if (!input || typeof input.fileName !== 'string' || !input.fileName.trim() || input.fileName.length > 160 || !input.fileName.isWellFormed() || control(input.fileName) || !media.has(input.mediaType) || !(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength < 1 || input.bytes.byteLength > US_SUPPLIER_DOCUMENT_MAX_BYTES) throw new BrowserUsSupplierDocumentError('invalid_supplier_document', 422);
        const bytes = new Uint8Array(input.bytes.slice(0)); reservedBytes = bytes;
        const hash = await digest(bytes); alive(started); const id = creationUuid(options.newId?.() ?? crypto.randomUUID());
        pending = { action: 'import', id, bytes, digest: hash, fileName: input.fileName, mediaType: input.mediaType }; return await send();
      } finally { if (reservedBytes && pending?.action !== 'import') reservedBytes.fill(0); reservedBytes = null; reserving = false; }
    },
    async analyze(input, consent) {
      canStart(); let document: UsSupplierDocument; try { document = validateBrowserUsSupplierDocument(input, organizationId); } catch { throw new BrowserUsSupplierDocumentError('invalid_supplier_document', 422); }
      if (consent !== true || !document.stored || !document.readable) throw new BrowserUsSupplierDocumentError('supplier_source_unreadable', 422);
      pending = { action: 'analyze', document, body: '{"schemaVersion":1,"action":"analyze","consent":true}' }; return send();
    },
    async download(input) {
      alive(); let document: UsSupplierDocument; try { document = validateBrowserUsSupplierDocument(input, organizationId); } catch { throw new BrowserUsSupplierDocumentError('invalid_supplier_document', 422); }
      if (!document.stored) throw new BrowserUsSupplierDocumentError('supplier_document_not_found', 404);
      const started = epoch, raw = await response('/' + document.id + '/content', 'GET', undefined, {}, true) as { bytes: Uint8Array<ArrayBuffer>; contentType: string }; alive(started);
      const hash = await digest(raw.bytes); alive(started); if (raw.bytes.length !== document.sizeBytes || hash !== document.contentSha256 || raw.contentType !== document.mediaType) throw new BrowserUsSupplierDocumentError('invalid_response', 503);
      return new Blob([raw.bytes], { type: document.mediaType });
    },
    retry: send, hasPending: () => !disposed && pending !== null, pendingAction: () => disposed ? null : pending?.action ?? null, dispose,
  };
}
