import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { hashUsMailboxRequest, validateUsMailboxProjection, validateUsMailboxReceipt, validateUsMailboxRequest, type UsMailboxProjection, type UsMailboxRequest } from './us-support-mailbox-contract';
import { validateUsMailboxMessages, validateUsMailboxOffset, type UsMailboxMessages } from './us-support-mailbox-messages';

export class BrowserUsMailboxError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly denied = false) { super(code); this.name = 'BrowserUsMailboxError'; }
}
export type BrowserUsMailboxDraft = { action: 'connect'; email: string; token: string } | { action: 'disconnect' };
export interface BrowserUsMailboxSession {
  load(): Promise<UsMailboxProjection>;
  messages(offset?: number): Promise<UsMailboxMessages>;
  change(draft: BrowserUsMailboxDraft, expectedRevision: number): Promise<UsMailboxProjection>;
  retry(): Promise<UsMailboxProjection>;
  hasPending(): boolean;
  dispose(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const knownErrors = new Set(['invalid_mailbox_request', 'mailbox_revision_conflict', 'mailbox_idempotency_conflict', 'mailbox_verification_expired', 'mailbox_connection_required', 'mailbox_credentials_rejected', 'mailbox_provider_unavailable', 'mailbox_page_unavailable', 'support_workspace_required', 'configuration_changed', 'feature_unavailable', 'edition_unavailable', 'rate_limited', 'service_unavailable']);
const fail = (code = 'invalid_response', status = 503, denied = false): never => { throw new BrowserUsMailboxError(code, status, denied); };

/** Metadata polling and explicit mail reads are separate operations. The API
 * key exists only in the tab-owned exact command; no credential enters a DTO. */
export function createBrowserUsMailboxSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; workspaceId: string; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsMailboxSession {
  const { organizationId, expectedUserId, role, workspaceId } = options, timeout = options.timeoutMs ?? 30_000;
  if (![organizationId, expectedUserId, workspaceId].every(value => uuid.test(value)) || !ACCOUNT_ROLES.includes(role) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('invalid_mailbox_request', 422);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), path = `/api/international/workspaces/${organizationId}/support-mailbox`;
  let disposed = false, epoch = 0, mutation = 0, sequence = 0, scopeVersion = 0, writing = false, head: UsMailboxProjection | null = null;
  let pending: Readonly<{ request: UsMailboxRequest; body: string; hash: Promise<string>; attempts: number }> | null = null;
  const controllers = new Set<AbortController>(), cancellations = new Set<() => void>();
  const alive = (stamp = epoch) => { if (disposed || stamp !== epoch) return fail('session_changed', 401, true); };
  function dispose() { if (disposed) return; disposed = true; epoch++; scopeVersion++; pending = null; head = null; for (const cancel of cancellations) cancel(); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  function projection(raw: unknown): UsMailboxProjection {
    let value: UsMailboxProjection; try { value = validateUsMailboxProjection(raw); } catch { return fail(); }
    if (value.organizationId !== organizationId || value.userId !== expectedUserId || value.role !== role || value.workspaceId !== workspaceId) { dispose(); return fail('session_changed', 401, true); }
    return value;
  }
  function adopt(value: UsMailboxProjection) {
    if (head && (value.revision < head.revision || value.revision === head.revision && canonicalErpJson(value) !== canonicalErpJson(head))) return fail();
    if (!head || value.revision !== head.revision || value.connection?.id !== head.connection?.id) scopeVersion++;
    head = value; return value;
  }
  async function request(url: string, method: 'GET' | 'POST', body?: string, mail = false): Promise<unknown> {
    const stamp = epoch; alive(stamp); const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsMailboxError('service_unavailable')); }, timeout); });
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsMailboxError('session_changed', 401, true)); cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const response = await wait(fetcher(url, { method, headers: { Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(stamp);
      if ([401, 402, 403].includes(response.status)) { void response.body?.cancel().catch(() => {}); dispose(); return fail('access_lost', response.status, true); }
      const max = response.ok ? mail ? 4 * 1024 * 1024 : 16_384 : 4096, length = response.headers.get('Content-Length');
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
        const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && 'error' in raw ? raw.error : null;
        const code = typeof candidate === 'string' && knownErrors.has(candidate) ? candidate : 'service_unavailable';
        if (response.status === 404 && code === 'feature_unavailable' || response.status === 409 && code === 'edition_unavailable') { dispose(); return fail(code, response.status, true); }
        return fail(code, response.status);
      }
      return raw;
    } catch (reason) { if (reason instanceof BrowserUsMailboxError) throw reason; alive(stamp); return fail('service_unavailable'); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send(): Promise<UsMailboxProjection> {
    alive(); if (writing || !pending) return fail('pending_operation', 409);
    writing = true; mutation++; scopeVersion++; const original = pending;
    pending = Object.freeze({ ...original, attempts: original.attempts + 1 });
    try {
      const hash = await original.hash; alive(); const raw = await request(path, 'POST', original.body); alive();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'projection,receipt,replayed' || !('projection' in raw) || !('receipt' in raw) || !('replayed' in raw) || typeof raw.replayed !== 'boolean') return fail();
      const value = projection(raw.projection); let receipt;
      try { receipt = validateUsMailboxReceipt(raw.receipt, organizationId); } catch { return fail(); }
      const input = original.request;
      if (receipt.workspaceId !== workspaceId || receipt.actorUserId !== expectedUserId || receipt.requestId !== input.requestId || receipt.requestHash !== hash || receipt.action !== input.action || receipt.expectedRevision !== input.expectedRevision || receipt.revision !== input.expectedRevision + 1 || value.revision < receipt.revision) return fail();
      // Historical replay returns today's head. Never turn its old connection
      // receipt into the editable/current connection shown in the UI.
      if (value.revision === receipt.revision && (input.action === 'connect' ? value.connection?.id !== receipt.connectionId || value.connection.email !== input.email : value.connection !== null)) return fail();
      adopt(value); pending = null; return value;
    } catch (reason) {
      // A first-attempt 422 precedes this invocation's commit. A later 422
      // cannot rule out an earlier timed-out invocation still committing.
      if (original.attempts === 0 && reason instanceof BrowserUsMailboxError && reason.status === 422 && ['invalid_mailbox_request', 'mailbox_credentials_rejected'].includes(reason.code)) pending = null;
      throw reason;
    }
    finally { writing = false; mutation++; }
  }
  return {
    async load() { alive(); const version = mutation, read = ++sequence, value = projection(await request(path, 'GET')); alive(); if (version !== mutation || read !== sequence) return fail('stale_read', 0); return adopt(value); },
    async messages(offset = 0) {
      alive(); try { validateUsMailboxOffset(String(offset)); } catch { return fail('invalid_mailbox_request', 422); }
      if (!head?.canManage || !head.connection || writing || pending) return fail('read_required', 409);
      const captured = head, connectionId = head.connection.id, version = scopeVersion;
      const raw = await request(`${path}/messages?offset=${offset}`, 'GET', undefined, true); alive();
      if (scopeVersion !== version || head?.revision !== captured.revision || head.connection?.id !== connectionId) return fail('stale_messages', 0);
      let value: UsMailboxMessages; try { value = validateUsMailboxMessages(raw); } catch { return fail(); }
      if (value.organizationId !== organizationId || value.userId !== expectedUserId || value.role !== role || value.workspaceId !== workspaceId) { dispose(); return fail('session_changed', 401, true); }
      if (value.connectionId !== connectionId || value.revision !== captured.revision || value.offset !== offset) return fail('stale_messages', 409);
      return value;
    },
    async change(draft, expectedRevision) {
      alive(); if (pending || writing) return fail('pending_operation', 409); if (!head?.canManage || head.revision !== expectedRevision || draft.action === 'disconnect' && !head.connection) return fail('read_required', 409);
      let input: UsMailboxRequest; try { input = validateUsMailboxRequest({ ...draft, schemaVersion: 1, requestId: (options.newId ?? (() => crypto.randomUUID()))(), expectedRevision }); } catch { return fail('invalid_mailbox_request', 422); }
      pending = Object.freeze({ request: input, body: JSON.stringify(input), hash: hashUsMailboxRequest(organizationId, expectedUserId, input), attempts: 0 }); return send();
    },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}
