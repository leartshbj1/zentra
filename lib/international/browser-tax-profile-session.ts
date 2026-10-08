import {
  validateUsTaxProfileReceipt, validateUsTaxProfileState, validateUsTaxProfileWrite,
  type UsTaxFacts, type UsTaxProfileReceipt, type UsTaxProfileState, type UsTaxProfileWrite,
} from './us-tax-profile';

export type BrowserTaxProfileOutcome = 'rejected' | 'uncertain' | 'unauthorized';
export class BrowserTaxProfileError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: BrowserTaxProfileOutcome) {
    super(code); this.name = 'BrowserTaxProfileError';
  }
}
export interface BrowserTaxProfileSessionOptions {
  organizationId: string;
  /** A stale-account fence, never authentication or an owner grant. */
  expectedUserId: string;
  fetch?: typeof globalThis.fetch;
  newId?: () => string;
  /** Synchronous sibling-channel privacy purge, before consuming denied JSON. */
  onAccessDenied?: () => void;
}
export interface BrowserTaxProfileSession {
  load(): Promise<UsTaxProfileState>;
  submit(facts: UsTaxFacts, expectedRevision: number): Promise<UsTaxProfileReceipt>;
  /** Explicit user retry: fresh owner GET, then the original byte-identical PUT. */
  retry(): Promise<UsTaxProfileReceipt>;
  hasPending(): boolean;
  /** Logout/actor/tenant/role or sibling denial: discard all private pending RAM. */
  invalidate(): void;
  dispose(): void;
}

const conflicts = new Set(['revision_conflict', 'request_id_conflict']);
const safeErrors = new Set(['unauthorized', 'session_changed', 'forbidden', 'owner_required', 'management_entitlement_required', 'financial_permission_required', 'tenant_mismatch', 'feature_unavailable', 'edition_unavailable', 'country_configuration_required', 'configuration_changed', 'service_unavailable', 'invalid_request', 'revision_conflict', 'request_id_conflict', 'workspace_unavailable', 'rate_limited']);
const timeoutMs = 30_000;
const validationId = '10000000-0000-4000-8000-000000000001';
function errorCode(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return 'service_unavailable';
  const keys = Reflect.ownKeys(input), descriptor = Object.getOwnPropertyDescriptor(input, 'error');
  if (keys.length !== 1 || keys[0] !== 'error' || !descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !safeErrors.has(descriptor.value)) return 'service_unavailable';
  return descriptor.value;
}

/** Private declarations, not tax-provider verification. This instance is bound
 * permanently to one workspace/user. An owner-only server GET is the fresh role
 * confirmation; caller role props never enter requests. No facts are cached here
 * except an unresolved write's immutable envelope, only in RAM. A transient
 * failure permits exact retry after another owner GET. Any access denial or
 * explicit invalidation destroys that envelope: a possibly committed result
 * then needs server reconciliation, never reconstruction from the current head.
 * Reload/page close also loses it. UI must purge its own facts/drafts on the
 * shared privacy epoch and must not automatically create a replacement key.
 */
export function createBrowserTaxProfileSession(options: BrowserTaxProfileSessionOptions): BrowserTaxProfileSession {
  const { organizationId, expectedUserId } = options;
  if (typeof organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)
    || typeof expectedUserId !== 'string' || !expectedUserId.trim() || expectedUserId !== expectedUserId.trim() || expectedUserId.length > 256
    || Array.from(expectedUserId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new BrowserTaxProfileError('invalid_request', 422, 'rejected');
  }
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const onAccessDenied = options.onAccessDenied;
  const url = `/api/international/workspaces/${encodeURIComponent(organizationId)}/tax-profile`;
  const controllers = new Set<AbortController>();
  let disposed = false, writing = false, readRequired = true, epoch = 0, accessEpoch = 0, latestRead = 0;
  let pending: Readonly<{ body: string; write: UsTaxProfileWrite }> | null = null;
  const alive = () => { if (disposed) throw new BrowserTaxProfileError('session_disposed', 0, 'unauthorized'); };
  const headers = () => ({ Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId });
  function invalidate() {
    pending = null; readRequired = true; epoch++; accessEpoch++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  async function response(init: RequestInit, write: boolean): Promise<{ body: unknown; status: number }> {
    alive(); const startedAccess = accessEpoch, controller = new AbortController(); controllers.add(controller);
    let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = () => new BrowserTaxProfileError(disposed ? 'session_disposed' : 'session_changed', 0, 'unauthorized');
    let rejectAbort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(aborted()); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new BrowserTaxProfileError('response_timeout', 0, write ? 'uncertain' : 'rejected')); controller.abort(); }, timeoutMs);
    });
    const unchangedAccess = () => { alive(); if (startedAccess !== accessEpoch) throw aborted(); };
    try {
      const result = await Promise.race([fetcher(url, { ...init, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal }), deadline, cancellation]);
      unchangedAccess();
      const denied = result.status === 401 ? 'unauthorized' : result.status === 402 ? 'management_entitlement_required' : result.status === 403 ? 'forbidden' : null;
      if (denied) {
        // Status suffices even if the body stalls. Private facts cannot survive
        // this refusal for another account or a subsequently revoked owner.
        invalidate();
        try { onAccessDenied?.(); } catch { /* Privacy is already purged; never echo callback details. */ }
        throw new BrowserTaxProfileError(denied, result.status, 'unauthorized');
      }
      let body: unknown;
      try { body = await Promise.race([result.json(), deadline, cancellation]); }
      catch (error) {
        if (timedOut) throw new BrowserTaxProfileError('response_timeout', 0, write ? 'uncertain' : 'rejected');
        unchangedAccess();
        if (error instanceof BrowserTaxProfileError && error.outcome === 'unauthorized') throw error;
        throw new BrowserTaxProfileError('invalid_response', result.status, write ? 'uncertain' : 'rejected');
      }
      unchangedAccess();
      if (!result.ok) {
        const code = errorCode(body);
        // These two SQL conflicts are precommit checks. Other HTTP failures can
        // be postflight after a durable commit, including a generic 422/503.
        if (write && result.status === 409 && conflicts.has(code)) {
          pending = null; readRequired = true; throw new BrowserTaxProfileError(code, 409, 'rejected');
        }
        throw new BrowserTaxProfileError(code, result.status, write ? 'uncertain' : 'rejected');
      }
      return { body, status: result.status };
    } catch (error) {
      alive();
      if (timedOut) throw new BrowserTaxProfileError('response_timeout', 0, write ? 'uncertain' : 'rejected');
      if (error instanceof BrowserTaxProfileError && error.outcome === 'unauthorized') throw error;
      unchangedAccess();
      if (error instanceof BrowserTaxProfileError) throw error;
      throw new BrowserTaxProfileError('response_unavailable', 0, write ? 'uncertain' : 'rejected');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectAbort); controllers.delete(controller);
    }
  }

  async function send(confirmOwner: boolean): Promise<UsTaxProfileReceipt> {
    alive();
    if (writing) throw new BrowserTaxProfileError('pending_operation', 409, 'rejected');
    if (!pending) throw new BrowserTaxProfileError('no_pending_operation', 409, 'rejected');
    const original = pending, startedAccess = accessEpoch; writing = true; epoch++; readRequired = true;
    const intact = () => {
      alive();
      if (accessEpoch !== startedAccess || pending !== original) throw new BrowserTaxProfileError('session_changed', 0, 'unauthorized');
    };
    try {
      if (confirmOwner) {
        try {
          const fresh = await response({ method: 'GET', headers: headers() }, false); intact();
          // The fresh owner-only endpoint confirms authority, not a new body.
          // A newer head must never replace an older unresolved operation.
          try { validateUsTaxProfileState(fresh.body, organizationId); }
          catch { throw new BrowserTaxProfileError('invalid_response', fresh.status, 'rejected'); }
        } catch (error) {
          if (error instanceof BrowserTaxProfileError) throw error.outcome === 'unauthorized' ? error : new BrowserTaxProfileError(error.code, error.status, 'uncertain');
          throw new BrowserTaxProfileError('response_unavailable', 0, 'uncertain');
        }
      }
      intact();
      const result = await response({ method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: original.body }, true); intact();
      let received: UsTaxProfileReceipt;
      try { received = validateUsTaxProfileReceipt(result.body, organizationId, expectedUserId, original.write); }
      catch { throw new BrowserTaxProfileError('invalid_response', result.status, 'uncertain'); }
      pending = null; return received;
    } finally { epoch++; readRequired = true; writing = false; }
  }

  return {
    async load() {
      alive(); const started = epoch, startedAccess = accessEpoch, read = ++latestRead; readRequired = true;
      const result = await response({ method: 'GET', headers: headers() }, false); alive();
      if (accessEpoch !== startedAccess) throw new BrowserTaxProfileError('session_changed', 0, 'unauthorized');
      if (epoch !== started || read !== latestRead) throw new BrowserTaxProfileError('stale_read', 0, 'rejected');
      let value: UsTaxProfileState;
      try { value = validateUsTaxProfileState(result.body, organizationId); }
      catch { throw new BrowserTaxProfileError('invalid_response', result.status, 'rejected'); }
      readRequired = false; return value;
    },
    async submit(facts, expectedRevision) {
      alive();
      if (pending || writing) throw new BrowserTaxProfileError('pending_operation', 409, 'rejected');
      if (readRequired) throw new BrowserTaxProfileError('read_required', 409, 'rejected');
      const startedAccess = accessEpoch;
      let write: UsTaxProfileWrite, body: string;
      try {
        const copied = validateUsTaxProfileWrite({ facts, expectedRevision, requestId: validationId });
        write = validateUsTaxProfileWrite({ ...copied, requestId: newId() });
        body = JSON.stringify(write); write = validateUsTaxProfileWrite(JSON.parse(body));
      } catch { throw new BrowserTaxProfileError('invalid_request', 422, 'rejected'); }
      alive();
      if (accessEpoch !== startedAccess || readRequired) throw new BrowserTaxProfileError('session_changed', 0, 'unauthorized');
      if (new TextEncoder().encode(body).byteLength > 4096) throw new BrowserTaxProfileError('request_too_large', 413, 'rejected');
      pending = Object.freeze({ body, write }); return send(false);
    },
    retry: () => send(true),
    hasPending: () => !disposed && pending !== null,
    invalidate,
    dispose() { if (disposed) return; disposed = true; invalidate(); },
  };
}
