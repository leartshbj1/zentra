import type { AccountRole } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { creationUuid } from './workspace-creation';

export const US_ANALYSIS_REASONS = ['paused', 'provider_unconfigured', 'consent_required', 'quota_unconfigured', 'quota_exhausted', 'configuration_required', 'policy_unconfigured'] as const;
export type UsAnalysisReason = typeof US_ANALYSIS_REASONS[number];
export interface BrowserUsAnalysisReadiness {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly revision: number;
  readonly mode: 'active' | 'paused';
  readonly availability: 'ready' | 'blocked';
  readonly reason: UsAnalysisReason | null;
  readonly mayConfigure: boolean;
  readonly policyVersion: string | null;
  readonly acceptedPolicyVersion: string | null;
  readonly quota: null | Readonly<{ limit: number; used: number; reserved: number; remaining: number; periodStart: number; periodEnd: number }>;
  readonly checkedAt: number;
  readonly expiresAt: number;
}
export interface BrowserUsAnalysisWrite {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly mode: 'active' | 'paused';
  readonly policyVersion: string | null;
  readonly consent: boolean;
}
export class BrowserUsAnalysisError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized' = 'rejected') { super(code); this.name = 'BrowserUsAnalysisError'; }
}
const fail = (): never => { throw new BrowserUsAnalysisError('invalid_response', 503); };
const natural = (input: unknown): input is number => Number.isSafeInteger(input) && (input as number) >= 0 && (input as number) < Number.MAX_SAFE_INTEGER;
const seconds = (input: unknown): input is number => natural(input) && (input as number) > 0 && (input as number) <= 8_640_000_000_000;
const policy = (input: unknown): input is string => typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input);
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return fail();
  const value: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor?.enumerable || !('value' in descriptor)) return fail(); value[key] = descriptor.value; }
  return value;
}
/** Strict, detached public projection. This is informational freshness, never
 * a financial or provider grant. No private policy/provider facts are accepted. */
export function readBrowserUsAnalysisReadiness(input: unknown, organizationId: string, now = Math.floor(Date.now() / 1000)): BrowserUsAnalysisReadiness {
  const value = exact(input, ['schemaVersion', 'organizationId', 'revision', 'mode', 'availability', 'reason', 'mayConfigure', 'policyVersion', 'acceptedPolicyVersion', 'quota', 'checkedAt', 'expiresAt']);
  if (!seconds(now) || value.schemaVersion !== 1 || value.organizationId !== organizationId || !natural(value.revision) || typeof value.mode !== 'string' || !['active', 'paused'].includes(value.mode) || typeof value.availability !== 'string' || !['ready', 'blocked'].includes(value.availability) || typeof value.mayConfigure !== 'boolean' || value.policyVersion !== null && !policy(value.policyVersion) || value.acceptedPolicyVersion !== null && !policy(value.acceptedPolicyVersion) || value.reason !== null && !US_ANALYSIS_REASONS.includes(value.reason as UsAnalysisReason) || !seconds(value.checkedAt) || !seconds(value.expiresAt) || value.checkedAt > now || value.expiresAt <= value.checkedAt || value.expiresAt <= now || value.expiresAt - value.checkedAt > 120) return fail();
  let quota: BrowserUsAnalysisReadiness['quota'] = null;
  if (value.quota !== null) {
    const q = exact(value.quota, ['limit', 'used', 'reserved', 'remaining', 'periodStart', 'periodEnd']);
    if (![q.limit, q.used, q.reserved, q.remaining].every(natural) || (q.limit as number) < 1 || (q.limit as number) > 1_000_000 || !seconds(q.periodStart) || !seconds(q.periodEnd) || q.periodStart >= q.periodEnd || Math.max(0, (q.limit as number) - (q.used as number) - (q.reserved as number)) !== q.remaining) return fail();
    quota = Object.freeze({ limit: q.limit as number, used: q.used as number, reserved: q.reserved as number, remaining: q.remaining as number, periodStart: q.periodStart, periodEnd: q.periodEnd });
  }
  if (value.availability === 'ready' && (value.mode !== 'active' || value.reason !== null || value.policyVersion === null || value.acceptedPolicyVersion !== value.policyVersion || !quota || quota.remaining <= 0 || value.checkedAt < quota.periodStart || value.expiresAt > quota.periodEnd) || value.availability === 'blocked' && value.reason === null) return fail();
  return Object.freeze({ schemaVersion: 1, organizationId, revision: value.revision, mode: value.mode as 'active' | 'paused', availability: value.availability as 'ready' | 'blocked', reason: value.reason as UsAnalysisReason | null, mayConfigure: value.mayConfigure, policyVersion: value.policyVersion as string | null, acceptedPolicyVersion: value.acceptedPolicyVersion as string | null, quota, checkedAt: value.checkedAt, expiresAt: value.expiresAt });
}

export interface BrowserUsAnalysisResult { readonly settings: BrowserUsAnalysisReadiness; readonly receipt: Readonly<{ requestId: string; revision: number; mode: 'active' | 'paused'; policyVersion: string | null; consent: boolean }>; readonly replayed: boolean }
export interface BrowserUsAnalysisSession {
  load(): Promise<BrowserUsAnalysisReadiness>;
  change(mode: 'active' | 'paused', consent: boolean): Promise<BrowserUsAnalysisResult>;
  retry(): Promise<BrowserUsAnalysisResult>;
  hasPending(): boolean;
  dispose(): void;
}

const certainConflicts = new Set(['automation_revision_conflict', 'automation_idempotency_conflict', 'automation_consent_required', 'automation_upgrade_required']);
const certainValidation = new Set(['invalid_request', 'invalid_automation_request']);
const knownErrors = new Set([...certainConflicts, ...certainValidation, 'unauthorized', 'forbidden', 'owner_required', 'management_entitlement_required', 'automation_entitlement_required', 'supplier_permission_required', 'financial_permission_required', 'tenant_mismatch', 'session_changed', 'feature_unavailable', 'edition_unavailable', 'client_upgrade_required', 'configuration_changed', 'rate_limited', 'service_unavailable']);
/** Same-origin cookies only; one immutable settings request remains in RAM
 * across ambiguous replies. A historical receipt is never an editable head. */
export function createBrowserUsAnalysisSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; supportedSchemaVersion: number; fetch?: typeof globalThis.fetch; newId?: () => string; now?: () => number; timeoutMs?: number }): BrowserUsAnalysisSession {
  const { organizationId, expectedUserId, role } = options;
  try { creationUuid(organizationId); } catch { throw new BrowserUsAnalysisError('invalid_request', 422); }
  if (!expectedUserId || expectedUserId !== expectedUserId.trim() || expectedUserId.length > 256 || !expectedUserId.isWellFormed() || Array.from(expectedUserId).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }) || options.supportedSchemaVersion !== 4 || !['owner', 'admin', 'accountant'].includes(role)) throw new BrowserUsAnalysisError('supplier_permission_required', 403, 'unauthorized');
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000) throw new BrowserUsAnalysisError('invalid_request', 422);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), newId = options.newId ?? (() => crypto.randomUUID()), now = options.now ?? (() => Math.floor(Date.now() / 1000)), url = `/api/international/workspaces/${encodeURIComponent(organizationId)}/supplier-analysis-settings`;
  let disposed = false, epoch = 0, readEpoch = 0, latestRead = 0, writing = false, readRequired = true, head: BrowserUsAnalysisReadiness | null = null;
  let pending: Readonly<{ input: BrowserUsAnalysisWrite; body: string }> | null = null;
  const controllers = new Set<AbortController>(), timers = new Set<ReturnType<typeof setTimeout>>(), cancellations = new Set<(reason: BrowserUsAnalysisError) => void>();
  const alive = (started = epoch) => { if (disposed || started !== epoch) throw new BrowserUsAnalysisError('session_changed', 0, 'unauthorized'); };
  function dispose() { if (disposed) return; disposed = true; epoch++; head = null; pending = null; for (const cancel of cancellations) cancel(new BrowserUsAnalysisError('session_changed', 0, 'unauthorized')); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); for (const timer of timers) clearTimeout(timer); timers.clear(); }
  async function response(method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const started = epoch, write = method === 'POST'; alive(started);
    const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (reason: BrowserUsAnalysisError) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsAnalysisError('response_timeout', 0, write ? 'uncertain' : 'rejected')); }, timeout); });
    if (timer) timers.add(timer);
    const cancelled = new Promise<never>((_, reject) => { cancel = reject; cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const res = await wait(fetcher(url, { method, headers: { Accept: 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': expectedUserId, ...(write ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(started);
      if ([401, 402, 403].includes(res.status)) { dispose(); throw new BrowserUsAnalysisError(res.status === 401 ? 'unauthorized' : res.status === 402 ? 'management_entitlement_required' : 'forbidden', res.status, 'unauthorized'); }
      const max = res.ok ? 16_384 : 4096, length = res.headers.get('Content-Length');
      if (res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > max)) throw new BrowserUsAnalysisError('invalid_response', res.status, write ? 'uncertain' : 'rejected');
      const reader = res.body?.getReader(); let bytes: Uint8Array;
      if (reader) { const parts: Uint8Array[] = []; let size = 0; try { for (;;) { const part = await wait(reader.read()); alive(started); if (part.done) break; size += part.value.byteLength; if (size > max) { void reader.cancel(); throw new BrowserUsAnalysisError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); } parts.push(part.value); } bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } } finally { reader.releaseLock(); } }
      else { bytes = new Uint8Array(await wait(res.arrayBuffer())); alive(started); if (bytes.byteLength > max) throw new BrowserUsAnalysisError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new BrowserUsAnalysisError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); } alive(started);
      if (!res.ok) {
        let code = 'service_unavailable'; try { const error = exact(raw, ['error']); if (typeof error.error === 'string' && knownErrors.has(error.error)) code = error.error; } catch { /* Never reflect private service text. */ }
        if (res.status === 404 && code === 'feature_unavailable' || res.status === 409 && code === 'edition_unavailable') { dispose(); throw new BrowserUsAnalysisError(code, res.status, 'unauthorized'); }
        if (write && (res.status === 409 && certainConflicts.has(code) || res.status === 422 && certainValidation.has(code))) { pending = null; readRequired = true; throw new BrowserUsAnalysisError(code, res.status, 'rejected'); }
        throw new BrowserUsAnalysisError(code, res.status, write ? 'uncertain' : 'rejected');
      }
      return raw;
    } catch (reason) { if (reason instanceof BrowserUsAnalysisError) throw reason; alive(started); throw new BrowserUsAnalysisError('service_unavailable', 0, write ? 'uncertain' : 'rejected'); }
    finally { if (timer) { clearTimeout(timer); timers.delete(timer); } controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send(): Promise<BrowserUsAnalysisResult> {
    alive(); if (writing || !pending) throw new BrowserUsAnalysisError(writing ? 'pending_operation' : 'no_pending_operation', 409);
    const original = pending, started = epoch; writing = true; readEpoch++;
    try {
      const raw = await response('POST', original.body); alive(started);
      let result: BrowserUsAnalysisResult;
      try {
        const value = exact(raw, ['settings', 'receipt', 'replayed']), receipt = exact(value.receipt, ['requestId', 'revision', 'mode', 'policyVersion', 'consent']), input = original.input;
        const settings = readBrowserUsAnalysisReadiness(value.settings, organizationId, now());
        if (typeof value.replayed !== 'boolean' || receipt.requestId !== input.requestId || receipt.revision !== input.expectedRevision + 1 || receipt.mode !== input.mode || receipt.policyVersion !== input.policyVersion || receipt.consent !== input.consent || settings.revision < (receipt.revision as number) || role === 'accountant' && settings.mayConfigure) throw new Error('shape');
        result = Object.freeze({ settings, receipt: Object.freeze({ requestId: input.requestId, revision: receipt.revision as number, mode: input.mode, policyVersion: input.policyVersion, consent: input.consent }), replayed: value.replayed });
      } catch { throw new BrowserUsAnalysisError('invalid_response', 503, 'uncertain'); }
      pending = null; return result;
    } finally { writing = false; head = null; readRequired = true; readEpoch++; }
  }
  return {
    async load() { const started = epoch, atRead = readEpoch, sequence = ++latestRead; alive(started); head = null; readRequired = true; const raw = await response('GET'); alive(started); if (atRead !== readEpoch || sequence !== latestRead) throw new BrowserUsAnalysisError('stale_read', 0); const result = readBrowserUsAnalysisReadiness(raw, organizationId, now()); if (role === 'accountant' && result.mayConfigure) throw new BrowserUsAnalysisError('invalid_response', 503); head = result; readRequired = false; return result; },
    async change(mode, consent) {
      alive(); if (pending || writing) throw new BrowserUsAnalysisError('pending_operation', 409); const currentTime = now(); if (!seconds(currentTime) || readRequired || !head || head.expiresAt <= currentTime) throw new BrowserUsAnalysisError('read_required', 409);
      if (!head.mayConfigure || mode === 'active' && role !== 'owner' || mode === 'paused' && !['owner', 'admin'].includes(role)) throw new BrowserUsAnalysisError('owner_required', 403);
      if (!['active', 'paused'].includes(mode) || typeof consent !== 'boolean' || consent !== (mode === 'active') || mode === 'active' && head.policyVersion === null) throw new BrowserUsAnalysisError('invalid_request', 422);
      let requestId: string; try { requestId = creationUuid(newId()); if (requestId[14] !== '4') throw new Error('uuid'); } catch { throw new BrowserUsAnalysisError('invalid_request', 422); }
      const input: BrowserUsAnalysisWrite = Object.freeze({ schemaVersion: 1, requestId, expectedRevision: head.revision, mode, policyVersion: head.policyVersion, consent });
      pending = Object.freeze({ input, body: canonicalErpJson(input) }); readEpoch++; return send();
    },
    retry: send, hasPending: () => !disposed && pending !== null, dispose,
  };
}
