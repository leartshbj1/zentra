import type { AccountRole } from '../account-security';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { hashUsSupportTriageRequest, US_SUPPORT_TRIAGE_RECIPE_VERSION, validateUsSupportTriageDecision, validateUsSupportTriageRequest, type UsSupportTriageDecision, type UsSupportTriageRequest } from './us-support-triage-contract';

export class BrowserUsSupportTriageError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly denied = false) { super(code); this.name = 'BrowserUsSupportTriageError'; }
}
export interface BrowserUsSupportTriageReadiness {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string; readonly role: AccountRole; readonly workspaceId: string;
  readonly processingPolicyVersion: string; readonly recipeVersion: string; readonly usage: Readonly<{ limit: number; used: number; remaining: number }>;
}
export interface BrowserUsSupportTriageResult {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string; readonly role: AccountRole; readonly workspaceId: string;
  readonly requestId: string; readonly requestHash: string; readonly replayed: boolean; readonly state: 'reserved' | 'uncertain' | 'completed';
  readonly jobId: string; readonly createdAt: number; readonly result: UsSupportTriageDecision | null;
}
export type BrowserUsSupportTriageDraft = Omit<UsSupportTriageRequest, 'schemaVersion' | 'requestId'>;
export interface BrowserUsSupportTriageSession {
  load(): Promise<BrowserUsSupportTriageReadiness>;
  classify(input: BrowserUsSupportTriageDraft): Promise<BrowserUsSupportTriageResult>;
  retry(): Promise<BrowserUsSupportTriageResult>;
  hasPending(): boolean;
  dispose(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errors = new Set(['invalid_triage_request', 'triage_source_unavailable', 'triage_policy_changed', 'triage_quota_exceeded', 'triage_budget_unavailable', 'triage_source_conflict', 'triage_idempotency_conflict', 'triage_dispatch_conflict', 'triage_not_reserved', 'triage_not_dispatched', 'triage_connection_changed', 'triage_grant_expired', 'triage_capacity_exceeded', 'mailbox_revision_conflict', 'mailbox_connection_required', 'support_workspace_required', 'mailbox_credentials_rejected', 'configuration_changed', 'client_schema_required', 'client_upgrade_required', 'feature_unavailable', 'edition_unavailable', 'rate_limited', 'service_unavailable', 'mailbox_provider_unavailable', 'triage_provider_unavailable', 'invalid_triage_record', 'invalid_triage_policy']);
const fail = (code = 'invalid_response', status = 503, denied = false): never => { throw new BrowserUsSupportTriageError(code, status, denied); };
function exact(input: unknown, keys: string[]): Record<string, unknown> {
  let value: unknown; try { value = snapshotPrivateJson(input); } catch { return fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Explicit, text-only requests. Historical status checks retain the original
 * policy, mailbox and request ID; readiness never acknowledges a pending POST. */
export function createBrowserUsSupportTriageSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; workspaceId: string; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsSupportTriageSession {
  const { organizationId, expectedUserId, role, workspaceId } = options, timeout = options.timeoutMs ?? 30_000;
  if (![organizationId, expectedUserId, workspaceId].every(value => uuid.test(value)) || !['owner', 'admin'].includes(role) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('access_lost', 403, true);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), path = `/api/international/workspaces/${organizationId}/support-mailbox/triage`;
  let disposed = false, epoch = 0, mutation = 0, sequence = 0, writing = false;
  let head: BrowserUsSupportTriageReadiness | null = null;
  let pending: Readonly<{ input: UsSupportTriageRequest; body: string; hash: Promise<string> }> | null = null;
  const controllers = new Set<AbortController>(), cancellations = new Set<() => void>();
  const alive = (stamp = epoch) => { if (disposed || stamp !== epoch) return fail('session_changed', 401, true); };
  function dispose() { if (disposed) return; disposed = true; epoch++; head = null; pending = null; for (const cancel of cancellations) cancel(); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  function scope(value: Record<string, unknown>) {
    if (value.organizationId !== organizationId || value.userId !== expectedUserId || value.role !== role || value.workspaceId !== workspaceId) { dispose(); return fail('session_changed', 401, true); }
  }
  async function request(method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const stamp = epoch; alive(stamp); const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsSupportTriageError('service_unavailable')); }, timeout); });
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsSupportTriageError('session_changed', 401, true)); cancellations.add(cancel); });
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
        catch (reason) { void reader.cancel().catch(() => {}); throw reason; }
        finally { reader.releaseLock(); }
      } else { bytes = new Uint8Array(await wait(response.arrayBuffer())); alive(stamp); if (bytes.length > max) return fail(); }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); } alive(stamp);
      if (!response.ok) {
        const value = exact(raw, ['error']), code = typeof value.error === 'string' && errors.has(value.error) ? value.error : 'service_unavailable';
        if (response.status === 404 && code === 'feature_unavailable' || response.status === 409 && code === 'edition_unavailable') { dispose(); return fail(code, response.status, true); }
        return fail(code, response.status);
      }
      return raw;
    } catch (reason) { if (reason instanceof BrowserUsSupportTriageError) throw reason; alive(stamp); return fail('service_unavailable'); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send(): Promise<BrowserUsSupportTriageResult> {
    alive(); if (writing || !pending) return fail('pending_operation', 409);
    writing = true; mutation++; const original = pending;
    try {
      const hash = await original.hash; alive(); const raw = await request('POST', original.body); alive();
      const value = exact(raw, ['schemaVersion', 'organizationId', 'userId', 'role', 'workspaceId', 'requestId', 'requestHash', 'replayed', 'state', 'jobId', 'createdAt', 'result']); scope(value);
      if (value.schemaVersion !== 1 || value.requestId !== original.input.requestId || value.requestHash !== hash || typeof value.replayed !== 'boolean' || typeof value.jobId !== 'string' || !uuid.test(value.jobId) || !integer(value.createdAt) || value.createdAt < 1 || value.createdAt > 253_402_300_799 || !['reserved', 'uncertain', 'completed'].includes(String(value.state))) return fail();
      let result: UsSupportTriageDecision | null = null;
      if (value.state === 'completed') { try { result = validateUsSupportTriageDecision(value.result); } catch { return fail(); } if (result.recipeVersion !== US_SUPPORT_TRIAGE_RECIPE_VERSION) return fail(); }
      else if (value.result !== null) return fail();
      if (value.state === 'completed') pending = null;
      return Object.freeze({ ...value, result }) as unknown as BrowserUsSupportTriageResult;
    } finally { writing = false; mutation++; }
  }
  return {
    async load() {
      alive(); const version = mutation, read = ++sequence, raw = await request('GET'); alive();
      const value = exact(raw, ['schemaVersion', 'organizationId', 'userId', 'role', 'workspaceId', 'processingPolicyVersion', 'recipeVersion', 'usage']); scope(value);
      const usage = exact(value.usage, ['limit', 'used', 'remaining']);
      if (value.schemaVersion !== 1 || typeof value.processingPolicyVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.processingPolicyVersion) || value.recipeVersion !== US_SUPPORT_TRIAGE_RECIPE_VERSION || !integer(usage.limit) || usage.limit < 1 || usage.limit > 1_000_000 || !integer(usage.used) || !integer(usage.remaining) || usage.remaining !== Math.max(0, usage.limit - usage.used)) return fail();
      if (version !== mutation || read !== sequence) return fail('stale_read', 0);
      head = Object.freeze({ ...value, usage }) as unknown as BrowserUsSupportTriageReadiness; return head;
    },
    async classify(draft) {
      alive(); if (writing || pending) return fail('pending_operation', 409);
      let input: UsSupportTriageRequest; try { const captured = exact(draft, ['connectionId', 'expectedMailboxRevision', 'uid', 'expectedMessageVersion', 'processingPolicyVersion', 'consent']); input = validateUsSupportTriageRequest({ ...captured, schemaVersion: 1, requestId: (options.newId ?? (() => crypto.randomUUID()))() }); } catch { return fail('invalid_triage_request', 422); }
      if (!head || input.processingPolicyVersion !== head.processingPolicyVersion || head.usage.remaining === 0) return fail('read_required', 409);
      pending = Object.freeze({ input, body: JSON.stringify(input), hash: hashUsSupportTriageRequest(organizationId, workspaceId, expectedUserId, input) }); return send();
    },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}
