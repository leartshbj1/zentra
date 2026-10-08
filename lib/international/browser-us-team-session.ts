import type { AccountRole } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { creationUuid } from './workspace-creation';
import type { UsTeamAcceptRequest, UsTeamAcceptResponse, UsTeamMutationResponse, UsTeamProjection, UsTeamRequest, UsTeamResolution } from './us-team-contract';
import { validateUsTeamAcceptRequest, validateUsTeamAcceptResponse, validateUsTeamMutationResponse, validateUsTeamProjection, validateUsTeamRequest, validateUsTeamResolution, validateUsTeamResolveRequest, usTeamCanManageRole } from './us-team-validation';

export class BrowserUsTeamError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized' = 'rejected') { super(code); this.name = 'BrowserUsTeamError'; }
}
export type BrowserUsTeamDraft =
  | { action: 'create_invitation'; email: string; role: Exclude<AccountRole, 'owner'> }
  | { action: 'regenerate_invitation' | 'revoke_invitation'; invitationId: string }
  | { action: 'revoke_member'; membershipId: string };
export interface BrowserUsTeamSession { load(): Promise<UsTeamProjection>; change(draft: BrowserUsTeamDraft): Promise<UsTeamMutationResponse>; retry(): Promise<UsTeamMutationResponse>; hasPending(): boolean; dispose(): void }
export interface BrowserUsTeamInvitationSession { resolve(): Promise<UsTeamResolution>; accept(firstName: string, lastName: string): Promise<UsTeamAcceptResponse>; retry(): Promise<UsTeamAcceptResponse>; hasPending(): boolean; dispose(): void }
interface TeamTransportOptions { expectedUserId: string; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number; now?: () => number }
const certainConflicts = new Set(['team_revision_conflict', 'team_idempotency_conflict', 'team_seat_limit_reached', 'team_owner_protected', 'team_member_protected', 'team_invitation_unavailable', 'invitation_unavailable']);
const certainValidation = new Set(['invalid_request', 'invalid_team_request', 'invalid_invitation']);
const knownErrors = new Set([...certainConflicts, ...certainValidation, 'unauthorized', 'forbidden', 'subscription_required', 'management_entitlement_required', 'team_management_required', 'team_permission_required', 'email_confirmation_required', 'invitation_recipient_mismatch', 'tenant_mismatch', 'session_changed', 'feature_unavailable', 'edition_unavailable', 'team_unavailable', 'client_upgrade_required', 'configuration_changed', 'rate_limited', 'service_unavailable']);
function failure(code = 'invalid_response', status = 503, outcome: BrowserUsTeamError['outcome'] = 'rejected'): never { throw new BrowserUsTeamError(code, status, outcome); }
function ownError(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return 'service_unavailable';
  const descriptor = Object.getOwnPropertyDescriptor(input, 'error');
  return Reflect.ownKeys(input).length === 1 && descriptor?.enumerable && 'value' in descriptor && typeof descriptor.value === 'string' && knownErrors.has(descriptor.value) ? descriptor.value : 'service_unavailable';
}
function createTransport(options: TeamTransportOptions, onAuthorityDenied: () => void = () => {}) {
  const user = options.expectedUserId, timeout = options.timeoutMs ?? 30_000;
  if (!user || user !== user.trim() || user.length > 256 || !user.isWellFormed() || Array.from(user).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }) || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000) return failure('invalid_request', 422);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let disposed = false, epoch = 0;
  const controllers = new Set<AbortController>(), timers = new Set<ReturnType<typeof setTimeout>>(), cancellations = new Set<(error: BrowserUsTeamError) => void>();
  const alive = (stamp = epoch) => { if (disposed || stamp !== epoch) return failure('session_changed', 0, 'unauthorized'); };
  function dispose() { if (disposed) return; disposed = true; epoch++; for (const cancel of cancellations) cancel(new BrowserUsTeamError('session_changed', 0, 'unauthorized')); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); for (const timer of timers) clearTimeout(timer); timers.clear(); }
  async function request(path: string, method: 'GET' | 'POST', body?: string, mutation = false): Promise<unknown> {
    const stamp = epoch; alive(stamp); const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (error: BrowserUsTeamError) => void = () => {}, deniedStatus = 0;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsTeamError('response_timeout', 0, mutation ? 'uncertain' : 'rejected')); }, timeout); }); if (timer) timers.add(timer);
    const cancelled = new Promise<never>((_, reject) => { cancel = reject; cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const response = await wait(fetcher(path, { method, headers: { Accept: 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(stamp);
      if ([401, 402, 403].includes(response.status)) { deniedStatus = response.status; onAuthorityDenied(); }
      const max = response.ok ? 2_621_440 : 4096, length = response.headers.get('Content-Length');
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > max)) return failure('invalid_response', response.status, mutation ? 'uncertain' : 'rejected');
      const reader = response.body?.getReader(); let bytes: Uint8Array;
      if (reader) { const parts: Uint8Array[] = []; let size = 0; try { for (;;) { const part = await wait(reader.read()); alive(stamp); if (part.done) break; size += part.value.byteLength; if (size > max) { void reader.cancel(); return failure('invalid_response', response.status, mutation ? 'uncertain' : 'rejected'); } parts.push(part.value); } bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } } finally { reader.releaseLock(); } }
      else { bytes = new Uint8Array(await wait(response.arrayBuffer())); alive(stamp); if (bytes.byteLength > max) return failure('invalid_response', response.status, mutation ? 'uncertain' : 'rejected'); }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return failure('invalid_response', response.status, mutation ? 'uncertain' : 'rejected'); } alive(stamp);
      if (deniedStatus) { const safe = ownError(raw), allowed = deniedStatus === 401 ? ['unauthorized', 'session_changed'] : deniedStatus === 402 ? ['subscription_required'] : ['forbidden', 'tenant_mismatch', 'team_management_required', 'invitation_recipient_mismatch', 'email_confirmation_required']; dispose(); return failure(allowed.includes(safe) ? safe : deniedStatus === 401 ? 'unauthorized' : deniedStatus === 402 ? 'subscription_required' : 'forbidden', deniedStatus, 'unauthorized'); }
      if (!response.ok) { const code = ownError(raw); if (response.status === 404 && ['feature_unavailable', 'team_unavailable'].includes(code) || response.status === 409 && code === 'edition_unavailable') { dispose(); return failure(code, response.status, 'unauthorized'); } return failure(code, response.status, mutation && !(response.status === 409 && certainConflicts.has(code) || response.status === 422 && certainValidation.has(code)) ? 'uncertain' : 'rejected'); }
      return raw;
    } catch (reason) { if (deniedStatus) { dispose(); if (reason instanceof BrowserUsTeamError && reason.outcome === 'unauthorized') throw reason; return failure(deniedStatus === 401 ? 'unauthorized' : deniedStatus === 402 ? 'subscription_required' : 'forbidden', deniedStatus, 'unauthorized'); } if (reason instanceof BrowserUsTeamError) throw reason; alive(stamp); return failure('service_unavailable', 0, mutation ? 'uncertain' : 'rejected'); }
    finally { if (timer) { clearTimeout(timer); timers.delete(timer); } controllers.delete(controller); cancellations.delete(cancel); }
  }
  return { alive, dispose, request, id() { try { const value = creationUuid((options.newId ?? (() => crypto.randomUUID()))()); if (value[14] !== '4') return failure('invalid_request', 422); return value; } catch { return failure('invalid_request', 422); } }, now: options.now ?? (() => Math.floor(Date.now() / 1000)) };
}

/** Remove the fragment before validation or any request. Only a US invitation
 * token is returned, in RAM; no query, storage, logging or auto-accept path. */
export function captureUsTeamInvitationFragment(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState' | 'state'>): string | null {
  const fragment = location.hash;
  if (fragment) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  const match = /^#token=(zui_[A-Za-z0-9_-]{43})$/.exec(fragment);
  if (!match) return null;
  try { return validateUsTeamResolveRequest({ schemaVersion: 1, token: match[1] }).token; } catch { return null; }
}

/** Team revision is independent of ERP. An old receipt is never its editable
 * head; every confirmed write requires a new GET before another mutation. */
export function createBrowserUsTeamSession(options: TeamTransportOptions & { organizationId: string; role: AccountRole }): BrowserUsTeamSession {
  try { creationUuid(options.organizationId); } catch { return failure('invalid_request', 422); }
  let pending: Readonly<{ input: UsTeamRequest; body: string; regenerationSource?: Readonly<{ email: string; role: AccountRole }> }> | null = null, head: UsTeamProjection | null = null, writing = false, readRequired = true, readEpoch = 0, sequence = 0;
  const transport = createTransport(options, () => { pending = null; head = null; readRequired = true; }), path = `/api/international/workspaces/${options.organizationId}/team`;
  function dispose() { pending = null; head = null; readRequired = true; transport.dispose(); }
  async function send() {
    transport.alive(); if (writing || !pending) return failure(writing ? 'pending_operation' : 'no_pending_operation', 409);
    const original = pending; writing = true; readEpoch++;
    try {
      const raw = await transport.request(path, 'POST', original.body, true); transport.alive();
      let result: UsTeamMutationResponse;
      try { result = validateUsTeamMutationResponse(raw, options.organizationId); const receipt = result.receipt, input = original.input; if (receipt.requestId !== input.requestId || receipt.action !== input.action || receipt.revision !== input.expectedTeamRevision + 1 || result.team.revision < receipt.revision || input.action === 'revoke_member' && receipt.entityId !== input.membershipId || input.action === 'revoke_invitation' && receipt.entityId !== input.invitationId) throw new Error('correlation');
        if (input.action === 'regenerate_invitation') {
          // Regeneration creates a new server ID. The original invitation is
          // revoked; a later projection may already omit its replacement.
          const source = original.regenerationSource;
          if (!source || receipt.entityId === input.invitationId) throw new Error('correlation');
          if (result.team.revision === receipt.revision) { const replacement = result.team.invitations.find(row => row.invitationId === receipt.entityId); if (!replacement || replacement.email !== source.email || replacement.role !== source.role) throw new Error('correlation'); }
        }
      } catch { return failure('invalid_response', 503, 'uncertain'); }
      if (result.team.role !== options.role) { dispose(); return failure('forbidden', 403, 'unauthorized'); }
      pending = null; return result;
    } catch (reason) { if (reason instanceof BrowserUsTeamError && reason.outcome !== 'uncertain') { pending = null; if (reason.outcome === 'unauthorized') dispose(); } throw reason; }
    finally { writing = false; head = null; readRequired = true; readEpoch++; }
  }
  return {
    async load() { const at = readEpoch, current = ++sequence; transport.alive(); head = null; readRequired = true; try { const raw = await transport.request(path, 'GET'); transport.alive(); if (current !== sequence || at !== readEpoch) return failure('stale_read', 0); let value: UsTeamProjection; try { value = validateUsTeamProjection(raw, options.organizationId); } catch { return failure(); } if (value.role !== options.role) { dispose(); return failure('forbidden', 403, 'unauthorized'); } head = value; readRequired = false; return value; } catch (reason) { if (reason instanceof BrowserUsTeamError && reason.outcome === 'unauthorized') dispose(); throw reason; } },
    async change(draft) { transport.alive(); if (pending || writing) return failure('pending_operation', 409); if (readRequired || !head) return failure('read_required', 409); if (!['owner', 'admin'].includes(options.role)) return failure('team_permission_required', 403);
      let input: UsTeamRequest; try { input = validateUsTeamRequest({ ...draft, schemaVersion: 1, requestId: transport.id(), expectedTeamRevision: head.revision }); } catch { return failure('invalid_team_request', 422); }
      if (input.action === 'create_invitation' && !usTeamCanManageRole(options.role, input.role)) return failure('team_permission_required', 403);
      if (input.action !== 'create_invitation') { const target = input.action === 'revoke_member' ? head.members.find(row => row.membershipId === input.membershipId) : head.invitations.find(row => row.invitationId === input.invitationId); if (!target || !usTeamCanManageRole(options.role, target.role) || input.action === 'revoke_member' && 'userId' in target && target.userId === options.expectedUserId) return failure('team_permission_required', 403); }
      const source = input.action === 'regenerate_invitation' ? head.invitations.find(row => row.invitationId === input.invitationId) : undefined;
      pending = Object.freeze({ input, body: canonicalErpJson(input), ...(source ? { regenerationSource: Object.freeze({ email: source.email, role: source.role }) } : {}) }); readEpoch++; return send(); },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}

/** No company is selected by the client. The confirmed recipient resolves the
 * private token, then explicitly supplies their name and accepts that space. */
export function createBrowserUsTeamInvitationSession(options: TeamTransportOptions & { token: string }): BrowserUsTeamInvitationSession {
  let token: string; try { token = validateUsTeamResolveRequest({ schemaVersion: 1, token: options.token }).token; } catch { return failure('invalid_invitation', 422); }
  let resolution: UsTeamResolution | null = null, pending: Readonly<{ input: UsTeamAcceptRequest; body: string; organizationId: string }> | null = null, writing = false, readEpoch = 0, sequence = 0;
  const transport = createTransport({ expectedUserId: options.expectedUserId, fetch: options.fetch, newId: options.newId, timeoutMs: options.timeoutMs, now: options.now }, () => { token = ''; resolution = null; pending = null; });
  function dispose() { token = ''; resolution = null; pending = null; transport.dispose(); }
  async function send() { transport.alive(); if (writing || !pending) return failure(writing ? 'pending_operation' : 'no_pending_operation', 409); const original = pending; writing = true; readEpoch++;
    try { const raw = await transport.request('/api/international/team-invitations/accept', 'POST', original.body, true); transport.alive(); let result: UsTeamAcceptResponse; try { result = validateUsTeamAcceptResponse(raw, original.organizationId); if (result.receipt.requestId !== original.input.requestId || result.receipt.action !== 'accept_invitation' || result.receipt.revision !== original.input.expectedTeamRevision + 1) throw new Error('correlation'); } catch { return failure('invalid_response', 503, 'uncertain'); } pending = null; token = ''; resolution = null; return result; }
    catch (reason) { if (reason instanceof BrowserUsTeamError && reason.outcome !== 'uncertain') { pending = null; if (reason.outcome === 'unauthorized') dispose(); } throw reason; }
    finally { writing = false; readEpoch++; }
  }
  return {
    async resolve() { transport.alive(); const at = readEpoch, current = ++sequence; resolution = null; try { const raw = await transport.request('/api/international/team-invitations/resolve', 'POST', canonicalErpJson({ schemaVersion: 1, token })); transport.alive(); if (current !== sequence || at !== readEpoch) return failure('stale_read', 0); let value: UsTeamResolution; try { value = validateUsTeamResolution(raw); } catch { return failure(); } if (value.expiresAt <= transport.now()) return failure('invitation_expired', 409); resolution = value; return value; } catch (reason) { if (reason instanceof BrowserUsTeamError && reason.outcome === 'unauthorized') dispose(); throw reason; } },
    async accept(firstName, lastName) { transport.alive(); if (pending || writing) return failure('pending_operation', 409); if (!resolution || resolution.expiresAt <= transport.now()) return failure('read_required', 409); let input: UsTeamAcceptRequest; try { input = validateUsTeamAcceptRequest({ schemaVersion: 1, requestId: transport.id(), expectedTeamRevision: resolution.teamRevision, token, firstName, lastName }); } catch { return failure('invalid_team_request', 422); } pending = Object.freeze({ input, body: canonicalErpJson(input), organizationId: resolution.organizationId }); readEpoch++; return send(); },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}
