import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { validateUsSupportWorkerManageRequest, validateUsSupportWorkerManageResult, validateUsSupportWorkerProjection, type UsSupportWorkerManageRequest, type UsSupportWorkerProjection } from './us-support-worker-contract';

export class BrowserUsSupportWorkerError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly denied = false) { super(code); this.name = 'BrowserUsSupportWorkerError'; }
}
export type BrowserUsSupportWorkerDraft = Omit<Extract<UsSupportWorkerManageRequest, { action: 'enable' }>, 'schemaVersion' | 'requestId' | 'expectedRevision'> | { readonly action: 'revoke' };
export interface BrowserUsSupportWorkerSession {
  load(): Promise<UsSupportWorkerProjection>;
  change(draft: BrowserUsSupportWorkerDraft): Promise<UsSupportWorkerProjection>;
  retry(): Promise<UsSupportWorkerProjection>;
  hasPending(): boolean;
  dispose(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errors = new Set(['feature_unavailable', 'configuration_changed', 'worker_revision_conflict', 'worker_idempotency_conflict', 'worker_policy_changed', 'worker_connection_changed', 'mailbox_revision_conflict', 'mailbox_connection_required', 'worker_capacity_exceeded', 'invalid_worker_request', 'rate_limited']);
const fail = (code = 'invalid_response', status = 503, denied = false): never => { throw new BrowserUsSupportWorkerError(code, status, denied); };
/** A metadata GET can never acknowledge a pending enable/revoke. All retries
 * retain the exact request ID, mailbox, policy, expiry and expected revision. */
export function createBrowserUsSupportWorkerSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; workspaceId: string; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsSupportWorkerSession {
  const { organizationId, expectedUserId, workspaceId, role } = options, timeout = options.timeoutMs ?? 15_000;
  if (![organizationId, expectedUserId, workspaceId].every(v => uuid.test(v)) || !ACCOUNT_ROLES.includes(role) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('access_lost', 403, true);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), path = `/api/international/workspaces/${organizationId}/support-worker`;
  let disposed = false, epoch = 0, mutation = 0, sequence = 0, writing = false, head: UsSupportWorkerProjection | null = null;
  let pending: Readonly<{ input: UsSupportWorkerManageRequest; body: string }> | null = null;
  const controllers = new Set<AbortController>(), cancellations = new Set<() => void>();
  const alive = (stamp = epoch) => { if (disposed || stamp !== epoch) return fail('access_lost', 401, true); };
  function dispose() { if (disposed) return; disposed = true; epoch++; head = null; pending = null; for (const cancel of cancellations) cancel(); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  function scope(value: UsSupportWorkerProjection) { if (value.organizationId !== organizationId || value.workspaceId !== workspaceId || value.userId !== expectedUserId || value.role !== role) { dispose(); return fail('access_lost', 401, true); } return value; }
  async function request(method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const stamp = epoch; alive(stamp); const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsSupportWorkerError('service_unavailable')); }, timeout); });
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsSupportWorkerError('access_lost', 401, true)); cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const response = await wait(fetcher(path, { method, ...(body === undefined ? {} : { body }), headers: { Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId, [ERP_SCHEMA_HEADER]: '4', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(stamp);
      if ([401, 402, 403].includes(response.status)) { void response.body?.cancel().catch(() => {}); dispose(); return fail('access_lost', response.status, true); }
      const max = response.ok ? 16_384 : 4096, length = response.headers.get('Content-Length');
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > max)) { void response.body?.cancel().catch(() => {}); return fail(); }
      const reader = response.body?.getReader(); let bytes: Uint8Array;
      if (reader) {
        const parts: Uint8Array[] = []; let size = 0;
        try { for (;;) { const part = await wait(reader.read()); alive(stamp); if (part.done) break; size += part.value.byteLength; if (size > max) return fail(); parts.push(part.value); } bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } }
        catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
      } else { bytes = new Uint8Array(await wait(response.arrayBuffer())); alive(stamp); if (bytes.length > max) return fail(); }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); } alive(stamp);
      if (!response.ok) {
        const value = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && 'error' in raw ? raw.error : null;
        const code = typeof value === 'string' && errors.has(value) ? value : 'service_unavailable';
        if (response.status === 404 && code === 'feature_unavailable') { dispose(); return fail(code, response.status, true); }
        return fail(code, response.status);
      }
      return raw;
    } catch (error) { if (error instanceof BrowserUsSupportWorkerError) throw error; alive(stamp); return fail('service_unavailable'); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send() {
    alive(); if (writing || !pending) return fail('pending_operation', 409);
    writing = true; mutation++; const original = pending;
    try {
      const raw = await request('POST', original.body); alive();
      let result; try { result = validateUsSupportWorkerManageResult(raw); } catch { return fail(); }
      const value = scope(result.projection);
      if (result.receipt.requestId !== original.input.requestId || result.receipt.actorUserId !== expectedUserId || result.receipt.revision !== original.input.expectedRevision + 1) return fail();
      head = value; pending = null; return value;
    } catch (error) { if (error instanceof BrowserUsSupportWorkerError && error.code === 'invalid_worker_request' && error.status === 422) pending = null; throw error; }
    finally { writing = false; mutation++; }
  }
  return {
    async load() { alive(); const stamp = mutation, read = ++sequence; const raw = await request('GET'); alive(); let value; try { value = validateUsSupportWorkerProjection(raw); } catch { return fail(); } scope(value); if (stamp !== mutation || read !== sequence) return fail('stale_read', 0); head = value; return value; },
    async change(draft) { alive(); if (pending || writing) return fail('pending_operation', 409); if (!head || !['owner', 'admin'].includes(role)) return fail('read_required', 409); let input; try { input = validateUsSupportWorkerManageRequest({ ...draft, schemaVersion: 1, requestId: (options.newId ?? (() => crypto.randomUUID()))(), expectedRevision: head.revision }); } catch { return fail('invalid_worker_request', 422); } pending = Object.freeze({ input, body: JSON.stringify(input) }); return send(); },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}
