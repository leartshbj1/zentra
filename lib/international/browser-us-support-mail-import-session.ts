import type { AccountRole } from '../account-security';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { hashUsMailboxImportRequest, validateUsMailboxImportRequest, type UsMailboxImportRequest } from './us-support-mailbox-import-contract';
import { validateBrowserUsSupplierDocument } from './browser-us-supplier-documents-session';
import type { UsSupplierDocument } from './us-supplier-document-contract';

export class BrowserUsMailImportError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly denied = false) { super(code); this.name = 'BrowserUsMailImportError'; }
}
export type BrowserUsMailImportDraft = Omit<UsMailboxImportRequest, 'schemaVersion' | 'requestId'>;
export interface BrowserUsMailImportResult { readonly document: UsSupplierDocument; readonly replayed: boolean }
export interface BrowserUsMailImportSession {
  import(draft: BrowserUsMailImportDraft): Promise<BrowserUsMailImportResult>;
  retry(): Promise<BrowserUsMailImportResult>;
  hasPending(): boolean;
  dispose(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errors = new Set(['invalid_mailbox_import_request', 'invalid_mailbox_request', 'invalid_supplier_document', 'invalid_request', 'mailbox_credentials_rejected', 'mailbox_attachment_unavailable', 'configuration_changed', 'mailbox_revision_conflict', 'mailbox_connection_required', 'support_workspace_required', 'mailbox_import_idempotency_conflict', 'mailbox_source_conflict', 'mailbox_import_limit_reached', 'supplier_document_conflict', 'mailbox_import_source_conflict', 'mailbox_import_connection_changed', 'mailbox_import_capacity_exceeded', 'mailbox_import_not_reserved', 'client_schema_required', 'supplier_upgrade_required', 'client_upgrade_required', 'edition_unavailable', 'country_configuration_required', 'workspace_unavailable', 'supplier_document_limit_reached', 'rate_limited', 'service_unavailable', 'mailbox_provider_unavailable', 'supplier_document_archive_unavailable', 'feature_unavailable']);
const beforeWriteRejections = new Set(['invalid_mailbox_import_request', 'invalid_mailbox_request', 'invalid_supplier_document', 'invalid_request', 'mailbox_credentials_rejected', 'mailbox_attachment_unavailable']);
const fail = (code = 'invalid_response', status = 503, denied = false): never => { throw new BrowserUsMailImportError(code, status, denied); };

/** A secret-free exact envelope. A changed mailbox never rewrites this request:
 * historical recovery needs no browser copy of a provider key or attachment. */
export function createBrowserUsMailImportSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; workspaceId: string; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsMailImportSession {
  const { organizationId, expectedUserId, role, workspaceId } = options, timeout = options.timeoutMs ?? 30_000;
  if (![organizationId, expectedUserId, workspaceId].every(value => uuid.test(value)) || !['owner', 'admin'].includes(role) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('access_lost', 403, true);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), path = `/api/international/workspaces/${organizationId}/support-mailbox/import`;
  let disposed = false, epoch = 0, writing = false;
  let pending: Readonly<{ input: UsMailboxImportRequest; body: string; hash: Promise<string>; attempts: number }> | null = null;
  const controllers = new Set<AbortController>(), cancellations = new Set<() => void>();
  const alive = (stamp = epoch) => { if (disposed || stamp !== epoch) return fail('session_changed', 401, true); };
  function dispose() { if (disposed) return; disposed = true; epoch++; pending = null; for (const cancel of cancellations) cancel(); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  async function request(body: string): Promise<unknown> {
    const stamp = epoch; alive(stamp); const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsMailImportError('service_unavailable')); }, timeout); });
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsMailImportError('session_changed', 401, true)); cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const response = await wait(fetcher(path, { method: 'POST', body, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': expectedUserId, [ERP_SCHEMA_HEADER]: '4' }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(stamp);
      if ([401, 402, 403].includes(response.status)) { void response.body?.cancel().catch(() => {}); dispose(); return fail('access_lost', response.status, true); }
      const max = response.ok ? 16_384 : 4096, length = response.headers.get('Content-Length');
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > max)) { void response.body?.cancel().catch(() => {}); return fail(); }
      const reader = response.body?.getReader(); let bytes: Uint8Array;
      if (reader) {
        const parts: Uint8Array[] = []; let size = 0;
        try { for (;;) { const part = await wait(reader.read()); alive(stamp); if (part.done) break; size += part.value.byteLength; if (size > max) return fail(); parts.push(part.value); } bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } }
        catch (reason) { void reader.cancel().catch(() => {}); throw reason; }
        finally { reader.releaseLock(); }
      } else { bytes = new Uint8Array(await wait(response.arrayBuffer())); alive(stamp); if (bytes.length > max) return fail(); }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); } alive(stamp);
      if (!response.ok) {
        const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && 'error' in raw ? raw.error : null, code = typeof candidate === 'string' && errors.has(candidate) ? candidate : 'service_unavailable';
        if (response.status === 404 && code === 'feature_unavailable') { dispose(); return fail(code, response.status, true); }
        return fail(code, response.status);
      }
      return raw;
    } catch (reason) { if (reason instanceof BrowserUsMailImportError) throw reason; alive(stamp); return fail('service_unavailable'); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send(): Promise<BrowserUsMailImportResult> {
    alive(); if (writing || !pending) return fail('pending_operation', 409);
    writing = true; const original = pending; pending = Object.freeze({ ...original, attempts: original.attempts + 1 });
    try {
      const hash = await original.hash; alive(); const raw = await request(original.body); alive();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'document,organizationId,replayed,requestHash,requestId,role,schemaVersion,userId,workspaceId' || !('document' in raw) || !('organizationId' in raw) || !('userId' in raw) || !('role' in raw) || !('workspaceId' in raw) || !('schemaVersion' in raw) || !('requestId' in raw) || !('requestHash' in raw) || !('replayed' in raw)) return fail();
      if (raw.organizationId !== organizationId || raw.userId !== expectedUserId || raw.role !== role || raw.workspaceId !== workspaceId) { dispose(); return fail('session_changed', 401, true); }
      if (raw.schemaVersion !== 1 || raw.requestId !== original.input.requestId || raw.requestHash !== hash || typeof raw.replayed !== 'boolean') return fail();
      let document: UsSupplierDocument; try { document = validateBrowserUsSupplierDocument(raw.document, organizationId); } catch { return fail(); }
      if (!document.stored || !['application/pdf', 'image/png', 'image/jpeg'].includes(document.mediaType)) return fail();
      pending = null; return Object.freeze({ document, replayed: raw.replayed });
    } catch (reason) {
      // A 422 after an earlier uncertainty cannot rule out that earlier call
      // still committing. Only an authoritative first rejection releases it.
      if (original.attempts === 0 && reason instanceof BrowserUsMailImportError && reason.status === 422 && beforeWriteRejections.has(reason.code)) pending = null;
      throw reason;
    } finally { writing = false; }
  }
  return {
    async import(draft) {
      alive(); if (writing || pending) return fail('pending_operation', 409);
      let input: UsMailboxImportRequest; try { input = validateUsMailboxImportRequest({ ...draft, schemaVersion: 1, requestId: (options.newId ?? (() => crypto.randomUUID()))() }); } catch { return fail('invalid_mailbox_import_request', 422); }
      pending = Object.freeze({ input, body: JSON.stringify(input), hash: hashUsMailboxImportRequest(organizationId, expectedUserId, input), attempts: 0 }); return send();
    },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}
