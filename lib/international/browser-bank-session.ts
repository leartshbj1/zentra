import type { AccountRole } from '../account-security';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { validateUsBankRecord, validateUsBankRequest } from './us-bank-reconciliation';
import type { UsBankCommand, UsBankReadResponse, UsBankReceipt, UsBankRequest, UsBankWriteResponse } from './us-bank-contract';

export class BrowserBankError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized' = 'rejected') { super(code); this.name = 'BrowserBankError'; }
}
export interface BrowserBankSession {
  load(): Promise<UsBankReadResponse>;
  submit(command: UsBankCommand, reconciliationId: string, expectedErpRevision: number, expectedReconciliationRevision: number | null): Promise<UsBankWriteResponse>;
  retry(): Promise<UsBankWriteResponse>;
  hasPending(): boolean;
  dispose(): void;
}
const certainConflicts = new Set(['bank_revision_conflict', 'bank_erp_revision_conflict', 'bank_idempotency_conflict', 'idempotency_conflict', 'bank_statement_overlap', 'bank_statement_duplicate', 'bank_entry_already_matched', 'bank_limit_reached', 'bank_statement_limit_reached', 'bank_statement_closed', 'reconciliation_voided', 'reconciliation_closed', 'statement_not_voidable', 'reconciliation_ledger_changed', 'reconciliation_incomplete', 'reconciliation_already_matched']);
const knownErrors = new Set([...certainConflicts, 'unauthorized', 'forbidden', 'financial_permission_required', 'bank_permission_required', 'management_entitlement_required', 'tenant_mismatch', 'session_changed', 'feature_unavailable', 'edition_unavailable', 'client_upgrade_required', 'bank_upgrade_required', 'configuration_changed', 'rate_limited', 'invalid_request', 'invalid_bank_request', 'invalid_bank_statement', 'reconciliation_amount_mismatch', 'reconciliation_not_found', 'service_unavailable']);
const maximumBytes = 2_621_440;
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('shape');
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('shape');
  const out: Record<string, unknown> = {};
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(input, key); if (!d?.enumerable || !('value' in d)) throw new Error('shape'); out[key] = d.value; }
  return out;
}
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function readBrowserBankResponse(input: unknown, organizationId: string): UsBankReadResponse {
  const value = exact(input, ['schemaVersion', 'organizationId', 'erpRevision', 'ledgerRevision', 'records']);
  if (value.schemaVersion !== 1 || value.organizationId !== organizationId || !revision(value.erpRevision) || value.erpRevision < 1 || !revision(value.ledgerRevision) || value.ledgerRevision > value.erpRevision || !Array.isArray(value.records) || value.records.length > 100) throw new Error('shape');
  const records = value.records.map(record => validateUsBankRecord(record, organizationId));
  if (new Set(records.map(record => record.reconciliation.statement.id)).size !== records.length) throw new Error('shape');
  return Object.freeze({ schemaVersion: 1, organizationId, erpRevision: value.erpRevision, ledgerRevision: value.ledgerRevision, records: Object.freeze(records) });
}
function receiptResponse(input: unknown, organizationId: string, userId: string, request: UsBankRequest, commandHash: string): UsBankWriteResponse {
  const result = exact(input, ['receipt', 'replayed']), r = exact(result.receipt, ['schemaVersion', 'organizationId', 'idempotencyKey', 'commandHash', 'actorId', 'reconciliationId', 'action', 'revision', 'erpRevision']);
  if (typeof result.replayed !== 'boolean' || r.schemaVersion !== 1 || r.organizationId !== organizationId || r.actorId !== userId || r.idempotencyKey !== request.idempotencyKey || r.commandHash !== commandHash || r.reconciliationId !== request.reconciliationId || r.action !== request.command.type || r.erpRevision !== request.expectedErpRevision || r.revision !== (request.expectedReconciliationRevision === null ? 0 : request.expectedReconciliationRevision + 1)) throw new Error('shape');
  return Object.freeze({ receipt: Object.freeze(r) as unknown as UsBankReceipt, replayed: result.replayed });
}
/** Cookie-only, captured user/workspace/capability. No grant, banking secrets or
 * local financial store. A lost reply preserves exactly one request in RAM.
 * Receipts (including historical replays) never replace the current read head. */
export function createBrowserBankSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; supportedSchemaVersion: number; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserBankSession {
  const { organizationId, expectedUserId } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || !expectedUserId || expectedUserId !== expectedUserId.trim() || expectedUserId.length > 256 || Array.from(expectedUserId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159) || options.supportedSchemaVersion !== 4 || !['owner', 'admin', 'accountant'].includes(options.role)) throw new BrowserBankError('financial_permission_required', 403, 'unauthorized');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), newId = options.newId ?? (() => crypto.randomUUID()), url = `/api/international/workspaces/${encodeURIComponent(organizationId)}/bank-reconciliations`;
  const controllers = new Set<AbortController>(), timers = new Set<ReturnType<typeof setTimeout>>(), cancellations = new Set<(reason: BrowserBankError) => void>();
  let disposed = false, epoch = 0, readEpoch = 0, latestRead = 0, writing = false, readRequired = true;
  let pending: Readonly<{ request: UsBankRequest; body: string; hash: string }> | null = null;
  const alive = (started = epoch) => { if (disposed || started !== epoch) throw new BrowserBankError('session_changed', 0, 'unauthorized'); };
  function dispose() { if (disposed) return; disposed = true; epoch++; pending = null; for (const cancel of cancellations) cancel(new BrowserBankError('session_changed', 0, 'unauthorized')); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); for (const timer of timers) clearTimeout(timer); timers.clear(); }
  async function response(method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const started = epoch; alive(started); const write = method === 'POST', controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (reason: BrowserBankError) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserBankError('response_timeout', 0, write ? 'uncertain' : 'rejected')); }, options.timeoutMs ?? 30_000); });
    if (timer) timers.add(timer);
    const cancelled = new Promise<never>((_, reject) => { cancel = reject; cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const res = await wait(fetcher(url, { method, headers: { Accept: 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': expectedUserId, ...(write ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(started);
      if ([401, 402, 403].includes(res.status)) { dispose(); throw new BrowserBankError(res.status === 402 ? 'management_entitlement_required' : res.status === 403 ? 'forbidden' : 'unauthorized', res.status, 'unauthorized'); }
      const maximum = res.ok ? maximumBytes : 4096, length = res.headers.get('Content-Length');
      if (res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new BrowserBankError('invalid_response', res.status, write ? 'uncertain' : 'rejected');
      const reader = res.body?.getReader(); let bytes: Uint8Array;
      if (reader) { const parts: Uint8Array[] = []; let size = 0; try { for (;;) { const part = await wait(reader.read()); alive(started); if (part.done) break; size += part.value.byteLength; if (size > maximum) { void reader.cancel(); throw new BrowserBankError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); } parts.push(part.value); } bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } } finally { reader.releaseLock(); } }
      else { bytes = new Uint8Array(await wait(res.arrayBuffer())); alive(started); if (bytes.byteLength > maximum) throw new BrowserBankError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); }
      let input: unknown; try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new BrowserBankError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); }
      alive(started);
      if (!res.ok) { let code = 'service_unavailable'; try { const error = exact(input, ['error']); if (typeof error.error === 'string' && knownErrors.has(error.error)) code = error.error; } catch { /* No private error body is exposed. */ }
        if (write && res.status === 409 && certainConflicts.has(code)) { pending = null; readRequired = true; throw new BrowserBankError(code, res.status, 'rejected'); }
        throw new BrowserBankError(code, res.status, write ? 'uncertain' : 'rejected'); }
      return input;
    } catch (error) { if (error instanceof BrowserBankError) throw error; alive(started); throw new BrowserBankError('service_unavailable', 0, write ? 'uncertain' : 'rejected'); }
    finally { if (timer) { clearTimeout(timer); timers.delete(timer); } controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send(): Promise<UsBankWriteResponse> {
    alive(); if (writing || !pending) throw new BrowserBankError(writing ? 'pending_operation' : 'no_pending_operation', 409);
    const original = pending, started = epoch; writing = true; readEpoch++;
    try { const raw = await response('POST', original.body); alive(started); let result: UsBankWriteResponse; try { result = receiptResponse(raw, organizationId, expectedUserId, original.request, original.hash); } catch { throw new BrowserBankError('invalid_response', 503, 'uncertain'); } pending = null; return result; }
    finally { writing = false; readRequired = true; readEpoch++; }
  }
  return {
    async load() { const started = epoch, startedRead = readEpoch, latest = ++latestRead; alive(started); const raw = await response('GET'); alive(started); if (startedRead !== readEpoch || latest !== latestRead) throw new BrowserBankError('stale_read', 0); let result: UsBankReadResponse; try { result = readBrowserBankResponse(raw, organizationId); } catch { throw new BrowserBankError('invalid_response', 503); } readRequired = false; return result; },
    async submit(command, reconciliationId, expectedErpRevision, expectedReconciliationRevision) { alive(); if (pending || writing) throw new BrowserBankError('pending_operation', 409); if (readRequired) throw new BrowserBankError('read_required', 409); let request: UsBankRequest; try { request = validateUsBankRequest({ schemaVersion: 1, idempotencyKey: newId(), reconciliationId, expectedErpRevision, expectedReconciliationRevision, command }, organizationId); } catch { throw new BrowserBankError('invalid_request', 422); }
      const started = epoch, hash = await sha256Hex(canonicalErpJson([organizationId, expectedUserId, request])); alive(started); if (pending || writing) throw new BrowserBankError('pending_operation', 409); pending = Object.freeze({ request, hash, body: canonicalErpJson(request) }); readEpoch++; return send(); },
    retry: send, hasPending: () => !disposed && pending !== null, dispose,
  };
}
