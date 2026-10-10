import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import {
  validateUsSupportRoutingMutationResult, validateUsSupportRoutingRequest,
  validateUsSupportTicketMutationResult, validateUsSupportTicketRequest,
  validateUsSupportTicketsHead, validateUsSupportTicketsProjection,
  type UsSupportRoutingMutationResult, type UsSupportRoutingRequest, type UsSupportTicket,
  type UsSupportTicketMutationResult, type UsSupportTicketRequest, type UsSupportTicketsHead,
  type UsSupportTicketsProjection,
} from './us-support-ticket-contract';

export class BrowserUsSupportTicketsError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly denied = false) { super(code); this.name = 'BrowserUsSupportTicketsError'; }
}
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'schemaVersion' | 'requestId'> : never;
type ExistingTicketRequest = Exclude<UsSupportTicketRequest, { action: 'create' }>;
export type BrowserUsSupportTicketDraft = WithoutRequestId<ExistingTicketRequest>;
export type BrowserUsSupportRoutingDraft = Omit<UsSupportRoutingRequest, 'schemaVersion' | 'requestId'>;
/** A detached set of pages all observed at the same two heads. */
export type BrowserUsSupportTicketsRead = Omit<UsSupportTicketsProjection, 'offset'> & { readonly offset: 0 };
export type BrowserUsSupportTicketsMutation =
  | { readonly kind: 'ticket'; readonly value: UsSupportTicketMutationResult }
  | { readonly kind: 'routing'; readonly value: UsSupportRoutingMutationResult };
export interface BrowserUsSupportTicketsSession {
  load(): Promise<BrowserUsSupportTicketsRead>;
  more(current: BrowserUsSupportTicketsRead): Promise<BrowserUsSupportTicketsRead>;
  synchronize(current: BrowserUsSupportTicketsRead): Promise<{ status: 'unchanged' | 'changed' | 'deferred'; read: BrowserUsSupportTicketsRead }>;
  mutate(input: BrowserUsSupportTicketDraft): Promise<BrowserUsSupportTicketsMutation>;
  saveRouting(input: BrowserUsSupportRoutingDraft): Promise<BrowserUsSupportTicketsMutation>;
  retry(): Promise<BrowserUsSupportTicketsMutation>;
  hasPending(): boolean;
  dispose(): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeErrors = new Set(['invalid_ticket_request', 'invalid_routing_request', 'ticket_not_found', 'triage_not_found', 'ticket_source_conflict', 'ticket_source_not_completed', 'ticket_job_required', 'ticket_required', 'ticket_revision_conflict', 'ticket_idempotency_conflict', 'ticket_assignee_unavailable', 'ticket_capacity_exceeded', 'ticket_audit_capacity_exceeded', 'ticket_command_capacity_exceeded', 'routing_revision_conflict', 'support_workspace_required', 'configuration_changed', 'client_upgrade_required', 'feature_unavailable', 'rate_limited', 'service_unavailable', 'invalid_ticket_record', 'invalid_support_record', 'invalid_support_context', 'invalid_mailbox_context']);
const fail = (code = 'invalid_response', status = 503, denied = false): never => { throw new BrowserUsSupportTicketsError(code, status, denied); };

export function usSupportTicketCanEdit(role: AccountRole) { return role === 'owner' || role === 'admin'; }
export function usSupportTicketCanSetStatus(read: BrowserUsSupportTicketsRead, ticket: UsSupportTicket): boolean {
  return usSupportTicketCanEdit(read.role) || read.role === 'member' && ticket.assigneeActive && read.assignees.some(a => a.userId === read.userId && a.membershipId === ticket.assigneeMembershipId);
}

/** Reads never acknowledge a mutation. Every uncertain command stays byte-for-
 * byte in RAM until its own validated durable receipt or an access purge. */
export function createBrowserUsSupportTicketsSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; workspaceId: string; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsSupportTicketsSession {
  const { organizationId, expectedUserId, role, workspaceId } = options, timeout = options.timeoutMs ?? 15_000;
  if (![organizationId, expectedUserId, workspaceId].every(v => uuid.test(v)) || !ACCOUNT_ROLES.includes(role) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('access_lost', 403, true);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), path = `/api/international/workspaces/${organizationId}/support-tickets`;
  let disposed = false, epoch = 0, mutation = 0, sequence = 0, writing = false;
  let read: BrowserUsSupportTicketsRead | null = null;
  let pending: Readonly<({ kind: 'ticket'; request: ExistingTicketRequest; body: string } | { kind: 'routing'; request: UsSupportRoutingRequest; body: string }) & { attempts: number }> | null = null;
  const reads = new WeakSet<object>(), controllers = new Set<AbortController>(), cancellations = new Set<() => void>();
  const alive = (stamp = epoch) => { if (disposed || stamp !== epoch) return fail('session_changed', 401, true); };
  function dispose() { if (disposed) return; disposed = true; epoch++; read = null; pending = null; for (const cancel of cancellations) cancel(); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  function scope(value: { organizationId: string; userId: string; role: AccountRole; workspaceId: string }) {
    if (value.organizationId !== organizationId || value.userId !== expectedUserId || value.role !== role || value.workspaceId !== workspaceId) { dispose(); return fail('session_changed', 401, true); }
  }
  function checked<T>(validator: (raw: unknown) => T, raw: unknown): T { try { return validator(raw); } catch { return fail(); } }
  async function request(suffix: string, method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const stamp = epoch; alive(stamp); const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsSupportTicketsError('service_unavailable')); }, timeout); });
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsSupportTicketsError('session_changed', 401, true)); cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const response = await wait(fetcher(path + suffix, { method, ...(body === undefined ? {} : { body }), headers: { Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId, [ERP_SCHEMA_HEADER]: '4', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(stamp);
      if ([401, 402, 403].includes(response.status)) { void response.body?.cancel().catch(() => {}); dispose(); return fail('access_lost', response.status, true); }
      const max = response.ok ? suffix === '/head' ? 4096 : 2_097_152 : 4096, length = response.headers.get('Content-Length');
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
        const value = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && Object.hasOwn(raw, 'error') ? raw as { error: unknown } : null;
        const code = typeof value?.error === 'string' && safeErrors.has(value.error) ? value.error : 'service_unavailable';
        if (response.status === 404 && code === 'feature_unavailable' || response.status === 409 && ['edition_unavailable', 'client_schema_required', 'client_upgrade_required'].includes(code)) { dispose(); return fail(code, response.status, true); }
        return fail(code, response.status);
      }
      return raw;
    } catch (reason) { if (reason instanceof BrowserUsSupportTicketsError) throw reason; alive(stamp); return fail('service_unavailable'); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function page(offset: number) {
    const value = checked(validateUsSupportTicketsProjection, await request(offset ? `?offset=${offset}` : '', 'GET')); scope(value);
    if (value.offset !== offset) return fail(); return value;
  }
  function known(current: BrowserUsSupportTicketsRead) { alive(); if (!reads.has(current) || current !== read) return fail('stale_read', 409); }
  function fence(stamp: number, changed: number, turn: number) { alive(stamp); if (changed !== mutation || turn !== sequence || writing) return fail('stale_read', 409); }
  function regress(value: { revision: number; teamRevision: number }, previous: { revision: number; teamRevision: number }) { if (value.revision < previous.revision || value.teamRevision < previous.teamRevision) return fail(); }
  function accept(value: BrowserUsSupportTicketsRead) { reads.add(value); read = value; return value; }
  function append(base: BrowserUsSupportTicketsRead, next: UsSupportTicketsProjection): BrowserUsSupportTicketsRead {
    if (next.head.revision !== base.head.revision || next.head.teamRevision !== base.head.teamRevision) return fail('stale_read', 409);
    const ids = new Set(base.tickets.map(t => t.id)); if (next.tickets.some(t => ids.has(t.id))) return fail();
    return Object.freeze({ ...base, nextOffset: next.nextOffset, tickets: Object.freeze([...base.tickets, ...next.tickets]) });
  }
  async function reload(count: number, stamp: number, changed: number, turn: number, minimum?: UsSupportTicketsHead): Promise<BrowserUsSupportTicketsRead> {
    const first = await page(0); fence(stamp, changed, turn); if (minimum) regress(first.head, minimum); if (read) regress(first.head, read.head);
    let candidate: BrowserUsSupportTicketsRead = Object.freeze({ ...first, offset: 0 });
    // Only reload pages the person has already opened. The endpoint caps offsets
    // at500 and each page at25; no unbounded background list traversal.
    for (let pages = 1; candidate.nextOffset !== null && candidate.tickets.length < count && pages < 21; pages++) {
      const next = await page(candidate.nextOffset); fence(stamp, changed, turn); candidate = append(candidate, next);
    }
    return candidate;
  }
  async function send(): Promise<BrowserUsSupportTicketsMutation> {
    alive(); if (writing || !pending) return fail('pending_operation', 409);
    writing = true; mutation++; sequence++; const original = Object.freeze({ ...pending, attempts: pending.attempts + 1 }), stamp = epoch; pending = original;
    try {
      const raw = await request(original.kind === 'routing' ? '/routing' : '', 'POST', original.body); alive(stamp);
      const value = original.kind === 'ticket' ? checked(validateUsSupportTicketMutationResult, raw) : checked(validateUsSupportRoutingMutationResult, raw);
      const receipt = value.receipt;
      if (receipt.organizationId !== organizationId || receipt.workspaceId !== workspaceId || receipt.actorUserId !== expectedUserId) { dispose(); return fail('session_changed', 401, true); }
      const action = original.kind === 'routing' ? 'save_routing' : original.request.action;
      const entity = original.kind === 'routing' ? workspaceId : original.request.ticketId;
      const revision = original.request.expectedRevision + 1;
      if (receipt.requestId !== original.request.requestId || receipt.action !== action || receipt.entityId !== entity || receipt.revision !== revision) return fail();
      if (original.kind === 'ticket') {
        const ticket = (value as UsSupportTicketMutationResult).ticket;
        if (ticket.organizationId !== organizationId || ticket.workspaceId !== workspaceId) return fail();
      }
      pending = null;
      return original.kind === 'ticket' ? { kind: 'ticket', value: value as UsSupportTicketMutationResult } : { kind: 'routing', value: value as UsSupportRoutingMutationResult };
    } catch (reason) {
      // These first-attempt responses follow receipt lookup and an atomic CAS,
      // or strict request rejection before writes. A prior ambiguous attempt
      // might still commit late, so a later409/422 cannot discard its envelope.
      if (original.attempts === 1 && pending === original && reason instanceof BrowserUsSupportTicketsError && (reason.status === 409 && ['ticket_revision_conflict', 'routing_revision_conflict', 'ticket_assignee_unavailable', 'ticket_capacity_exceeded', 'ticket_audit_capacity_exceeded', 'ticket_command_capacity_exceeded'].includes(reason.code) || reason.status === 422 && ['invalid_ticket_request', 'invalid_routing_request'].includes(reason.code))) pending = null;
      throw reason;
    } finally { writing = false; }
  }
  return {
    async load() { const stamp = epoch, changed = mutation, turn = ++sequence; alive(stamp); return accept(await reload(read?.tickets.length ?? 25, stamp, changed, turn)); },
    async more(current) { known(current); if (current.nextOffset === null) return current; const stamp = epoch, changed = mutation, turn = ++sequence; const next = await page(current.nextOffset); fence(stamp, changed, turn); return accept(append(current, next)); },
    async synchronize(current) {
      known(current); const stamp = epoch, changed = mutation, turn = ++sequence;
      const head = checked(validateUsSupportTicketsHead, await request('/head', 'GET')); scope(head); alive(stamp); regress(head, current.head);
      if (writing || changed !== mutation || turn !== sequence) return { status: 'deferred', read: current };
      if (head.revision === current.head.revision && head.teamRevision === current.head.teamRevision) return { status: 'unchanged', read: current };
      const candidate = await reload(current.tickets.length, stamp, changed, turn, head); fence(stamp, changed, turn);
      return { status: 'changed', read: accept(candidate) };
    },
    async mutate(input) {
      alive(); if (pending || writing) return fail('pending_operation', 409); if (!read) return fail('read_required', 409);
      let command: UsSupportTicketRequest; try { const draft = snapshotPrivateJson(input); if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.hasOwn(draft, 'schemaVersion') || Object.hasOwn(draft, 'requestId')) return fail('invalid_ticket_request', 422); command = validateUsSupportTicketRequest({ ...draft, schemaVersion: 1, requestId: (options.newId ?? (() => crypto.randomUUID()))() }); } catch { return fail('invalid_ticket_request', 422); }
      if (command.action === 'create') return fail('invalid_ticket_request', 422);
      const ticket = read.tickets.find(t => t.id === command.ticketId);
      if (command.action === 'set_status' ? !ticket || !usSupportTicketCanSetStatus(read, ticket) : !usSupportTicketCanEdit(role)) return fail('access_lost', 403, true);
      if (!ticket || command.expectedRevision !== ticket.revision) return fail('ticket_revision_conflict', 409);
      pending = Object.freeze({ kind: 'ticket', request: command, body: JSON.stringify(command), attempts: 0 }); return send();
    },
    async saveRouting(input) {
      alive(); if (pending || writing) return fail('pending_operation', 409); if (!read) return fail('read_required', 409); if (!usSupportTicketCanEdit(role)) return fail('access_lost', 403, true);
      let command: UsSupportRoutingRequest; try { const draft = snapshotPrivateJson(input); if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.hasOwn(draft, 'schemaVersion') || Object.hasOwn(draft, 'requestId')) return fail('invalid_ticket_request', 422); command = validateUsSupportRoutingRequest({ ...draft, schemaVersion: 1, requestId: (options.newId ?? (() => crypto.randomUUID()))() }); } catch { return fail('invalid_ticket_request', 422); }
      if (command.expectedRevision !== read.routing.revision) return fail('routing_revision_conflict', 409);
      pending = Object.freeze({ kind: 'routing', request: command, body: JSON.stringify(command), attempts: 0 }); return send();
    },
    retry: send, hasPending: () => pending !== null, dispose,
  };
}
