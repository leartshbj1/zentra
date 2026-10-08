import {
  validateUsSellerProfileReceipt, validateUsSellerProfileState, validateUsSellerProfileWrite,
  type UsSellerProfile, type UsSellerProfileReceipt, type UsSellerProfileState, type UsSellerProfileWrite,
} from './seller-profile';

export type BrowserSellerOutcome = 'rejected' | 'uncertain' | 'unauthorized';
export class BrowserSellerError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: BrowserSellerOutcome) {
    super(code); this.name = 'BrowserSellerError';
  }
}
export interface BrowserSellerSessionOptions {
  organizationId: string;
  /** A stale-account fence, not authentication or a role grant. */
  expectedUserId: string;
  fetch?: typeof globalThis.fetch;
  newId?: () => string;
}
export interface BrowserSellerSession {
  load(): Promise<UsSellerProfileState>;
  submit(profile: UsSellerProfile, expectedRevision: number): Promise<UsSellerProfileReceipt>;
  retry(): Promise<UsSellerProfileReceipt>;
  hasPending(): boolean;
  dispose(): void;
}

const conflicts = new Set(['revision_conflict', 'request_id_conflict']);
const safeErrors = new Set(['unauthorized', 'session_changed', 'forbidden', 'owner_required', 'management_entitlement_required', 'financial_permission_required', 'tenant_mismatch', 'feature_unavailable', 'edition_unavailable', 'country_configuration_required', 'configuration_changed', 'service_unavailable', 'invalid_request', 'revision_conflict', 'request_id_conflict', 'workspace_unavailable']);
const timeoutMs = 30_000;
const validationId = '10000000-0000-4000-8000-000000000001';

function errorCode(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return 'service_unavailable';
  const keys = Reflect.ownKeys(input), descriptor = Object.getOwnPropertyDescriptor(input, 'error');
  if (keys.length !== 1 || keys[0] !== 'error' || !descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !safeErrors.has(descriptor.value)) return 'service_unavailable';
  return descriptor.value;
}

/** One cookie-only, workspace/user-bound transport. Pending requests remain only
 * in this instance's RAM. A page close loses that retry envelope: reread server
 * state and inspect its recorded result before creating a replacement operation.
 * Neither a successful read nor a receipt proves the user's current owner role.
 */
export function createBrowserSellerSession(options: BrowserSellerSessionOptions): BrowserSellerSession {
  const { organizationId, expectedUserId } = options;
  if (typeof organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)
    || typeof expectedUserId !== 'string' || !expectedUserId.trim() || expectedUserId !== expectedUserId.trim() || expectedUserId.length > 256
    || Array.from(expectedUserId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new BrowserSellerError('invalid_request', 422, 'rejected');
  }
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const url = `/api/international/workspaces/${encodeURIComponent(organizationId)}/seller`;
  const controllers = new Set<AbortController>();
  let disposed = false, writing = false, readRequired = true, epoch = 0, accessEpoch = 0, latestRead = 0;
  let pending: Readonly<{ body: string; write: UsSellerProfileWrite }> | null = null;
  const alive = () => { if (disposed) throw new BrowserSellerError('session_disposed', 0, 'unauthorized'); };
  const headers = () => ({ Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId });

  async function response(init: RequestInit, write: boolean): Promise<{ body: unknown; status: number }> {
    alive(); const controller = new AbortController(); controllers.add(controller);
    let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new BrowserSellerError('response_timeout', 0, write ? 'uncertain' : 'rejected')); controller.abort(); }, timeoutMs);
    });
    try {
      const result = await Promise.race([fetcher(url, { ...init, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal }), deadline]);
      alive();
      const denied = result.status === 401 ? 'unauthorized' : result.status === 402 ? 'management_entitlement_required' : result.status === 403 ? 'forbidden' : null;
      if (denied) {
        // Status alone is sufficient. A stalled/private error body must never
        // postpone revocation, including for the sibling UI channel.
        epoch++; accessEpoch++; readRequired = true; controller.abort();
        throw new BrowserSellerError(denied, result.status, 'unauthorized');
      }
      let body: unknown;
      try { body = await Promise.race([result.json(), deadline]); }
      catch {
        if (timedOut) throw new BrowserSellerError('response_timeout', 0, write ? 'uncertain' : 'rejected');
        throw new BrowserSellerError('invalid_response', result.status, write ? 'uncertain' : 'rejected');
      }
      alive();
      if (!result.ok) {
        const code = errorCode(body);
        if (write && result.status === 409 && conflicts.has(code)) {
          pending = null; readRequired = true; throw new BrowserSellerError(code, 409, 'rejected');
        }
        throw new BrowserSellerError(code, result.status, write ? 'uncertain' : 'rejected');
      }
      return { body, status: result.status };
    } catch (error) {
      alive();
      if (error instanceof BrowserSellerError && error.outcome === 'unauthorized') throw error;
      if (timedOut) throw new BrowserSellerError('response_timeout', 0, write ? 'uncertain' : 'rejected');
      if (error instanceof BrowserSellerError) throw error;
      throw new BrowserSellerError('response_unavailable', 0, write ? 'uncertain' : 'rejected');
    } finally { if (timer !== undefined) clearTimeout(timer); controllers.delete(controller); }
  }

  async function send(): Promise<UsSellerProfileReceipt> {
    alive();
    if (writing) throw new BrowserSellerError('pending_operation', 409, 'rejected');
    if (!pending) throw new BrowserSellerError('no_pending_operation', 409, 'rejected');
    const original = pending, startedAccess = accessEpoch; writing = true; epoch++;
    try {
      const result = await response({ method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: original.body }, true);
      alive();
      // A parallel denied read invalidates this previously authorized response.
      // The write may already be committed: retain its exact recovery envelope.
      if (accessEpoch !== startedAccess) throw new BrowserSellerError('session_changed', 0, 'unauthorized');
      let receipt: UsSellerProfileReceipt;
      try { receipt = validateUsSellerProfileReceipt(result.body, organizationId, expectedUserId, original.write); }
      catch { throw new BrowserSellerError('invalid_response', result.status, 'uncertain'); }
      pending = null; return receipt;
    } finally { epoch++; readRequired = true; writing = false; }
  }

  return {
    async load() {
      alive(); const started = epoch, read = ++latestRead;
      const result = await response({ method: 'GET', headers: headers() }, false); alive();
      if (epoch !== started || read !== latestRead) throw new BrowserSellerError('stale_read', 0, 'rejected');
      let state: UsSellerProfileState;
      try { state = validateUsSellerProfileState(result.body, organizationId); }
      catch { throw new BrowserSellerError('invalid_response', result.status, 'rejected'); }
      readRequired = false; return state;
    },
    async submit(profile, expectedRevision) {
      alive();
      if (pending || writing) throw new BrowserSellerError('pending_operation', 409, 'rejected');
      if (readRequired) throw new BrowserSellerError('read_required', 409, 'rejected');
      let write: UsSellerProfileWrite, body: string;
      try {
        validateUsSellerProfileWrite({ profile, expectedRevision, requestId: validationId });
        write = validateUsSellerProfileWrite({ profile, expectedRevision, requestId: newId() });
        body = JSON.stringify(write); write = validateUsSellerProfileWrite(JSON.parse(body));
      } catch { throw new BrowserSellerError('invalid_request', 422, 'rejected'); }
      if (new TextEncoder().encode(body).byteLength > 4096) throw new BrowserSellerError('request_too_large', 413, 'rejected');
      pending = Object.freeze({ body, write }); return send();
    },
    retry: send,
    hasPending: () => !disposed && pending !== null,
    dispose() { disposed = true; pending = null; epoch++; for (const controller of controllers) controller.abort(); controllers.clear(); },
  };
}
