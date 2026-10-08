import type { AccountRole } from '../account-security';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { creationUuid } from './workspace-creation';
import { supplierErpRequest, validateUsSupplierApprovalRequest, validateUsSupplierProposal, validateUsSupplierRecording } from './us-supplier-proposal';
import type { UsSupplierApprovalRequest, UsSupplierProposal, UsSupplierRecording, UsSupplierReview } from './us-supplier-contract';

export class BrowserUsSupplierError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized' = 'rejected') { super(code); this.name = 'BrowserUsSupplierError'; }
}
export interface BrowserUsSupplierRead { readonly schemaVersion: 1; readonly organizationId: string; readonly erpRevision: number; readonly proposals: readonly UsSupplierProposal[] }
export interface BrowserUsSupplierPrepare { readonly fileName: string; readonly documentText: string; readonly consent: true }
export type BrowserUsSupplierResult = Readonly<{ action: 'prepare'; proposal: UsSupplierProposal; replayed: boolean }> | Readonly<{ action: 'approve'; recording: UsSupplierRecording; replayed: boolean }>;
export interface BrowserUsSupplierSession {
  load(): Promise<BrowserUsSupplierRead>;
  prepare(input: BrowserUsSupplierPrepare): Promise<BrowserUsSupplierResult>;
  approve(proposal: UsSupplierProposal, review: UsSupplierReview, expectedErpRevision: number): Promise<BrowserUsSupplierResult>;
  retry(): Promise<BrowserUsSupplierResult>;
  hasPending(): boolean;
  pendingAction(): 'prepare' | 'approve' | null;
  dispose(): void;
}
const certainConflicts = new Set(['supplier_revision_conflict', 'supplier_erp_revision_conflict', 'supplier_idempotency_conflict', 'revision_conflict', 'idempotency_conflict', 'accounting_period_not_open', 'vendor_bill_already_recorded', 'supplier_limit_reached']);
const certainValidation = new Set(['invalid_request', 'invalid_supplier_proposal', 'supplier_review_required', 'supplier_currency_unsupported', 'supplier_source_unreadable', 'vendor_required', 'invalid_vendor_bill', 'invalid_date', 'invalid_amount', 'purchase_account_required']);
// These are definitive no-new-dispatch outcomes of the durable analysis port.
// They do not discard an uncertain financial approval or revoke company access.
const certainAnalysis = new Set(['automation_consent_required','automation_quota_exceeded','automation_grant_expired','automation_limit_reached','automation_busy','automation_dispatch_uncertain']);
const knownErrors = new Set([...certainConflicts, ...certainValidation, ...certainAnalysis, 'unauthorized', 'forbidden', 'management_entitlement_required', 'automation_entitlement_required', 'supplier_permission_required', 'automation_permission_required', 'financial_permission_required', 'tenant_mismatch', 'session_changed', 'feature_unavailable', 'edition_unavailable', 'client_upgrade_required', 'supplier_upgrade_required', 'automation_upgrade_required', 'configuration_changed', 'rate_limited', 'supplier_analysis_unavailable', 'supplier_analysis_failed', 'supplier_source_conflict', 'supplier_not_found', 'service_unavailable']);
const maximumBytes = 2_621_440;
const control = (value: string, allowLines = false, c1 = false) => Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 && !(allowLines && [9, 10, 13].includes(code)) || code === 127 || c1 && code >= 128 && code <= 159; });
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('shape');
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('shape');
  const result: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('shape'); result[key] = descriptor.value; }
  return result;
}
const positiveRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) < Number.MAX_SAFE_INTEGER;
export function readBrowserUsSupplierResponse(input: unknown, organizationId: string): BrowserUsSupplierRead {
  const value = exact(input, ['schemaVersion', 'organizationId', 'erpRevision', 'proposals']);
  if (value.schemaVersion !== 1 || value.organizationId !== organizationId || !positiveRevision(value.erpRevision) || !Array.isArray(value.proposals) || value.proposals.length > 50) throw new Error('shape');
  const proposals = value.proposals.map(proposal => validateUsSupplierProposal(proposal, organizationId));
  if (new Set(proposals.map(proposal => proposal.id)).size !== proposals.length || new Set(proposals.map(proposal => proposal.source.sha256)).size !== proposals.length || proposals.some(proposal => proposal.recording && proposal.recording.erpReceipt.revision > (value.erpRevision as number))) throw new Error('shape');
  return Object.freeze({ schemaVersion: 1, organizationId, erpRevision: value.erpRevision, proposals: Object.freeze(proposals) });
}
function prepareInput(input: BrowserUsSupplierPrepare): Readonly<{ schemaVersion: 1; action: 'prepare'; consent: true; fileName: string; documentText: string }> {
  let value: Record<string, unknown>; try { value = exact(input, ['fileName', 'documentText', 'consent']); } catch { throw new BrowserUsSupplierError('invalid_request', 422); }
  if (value.consent !== true || typeof value.fileName !== 'string' || !value.fileName.trim() || value.fileName.length > 160 || control(value.fileName) || typeof value.documentText !== 'string' || !value.documentText.trim() || !value.documentText.isWellFormed() || control(value.documentText, true) || new TextEncoder().encode(value.documentText).byteLength > 16_384) throw new BrowserUsSupplierError('invalid_request', 422);
  return Object.freeze({ schemaVersion: 1, action: 'prepare', consent: true, fileName: value.fileName, documentText: value.documentText });
}
type Pending = Readonly<{ action: 'prepare'; input: ReturnType<typeof prepareInput>; sourceHash: string; body: string }> | Readonly<{ action: 'approve'; request: UsSupplierApprovalRequest; requestHash: string; erpHash: string; body: string }>;

/** Cookie-only, one immutable request in RAM. A receipt never becomes a current
 * head; a fresh GET is required before another operation. No provider key,
 * source identity, actor or authority is accepted from the form. */
export function createBrowserUsSupplierSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; supportedSchemaVersion: number; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsSupplierSession {
  const { organizationId, expectedUserId } = options;
  try { creationUuid(organizationId); } catch { throw new BrowserUsSupplierError('invalid_request', 422); }
  if (!expectedUserId || expectedUserId !== expectedUserId.trim() || expectedUserId.length > 256 || control(expectedUserId, false, true) || options.supportedSchemaVersion !== 4 || !['owner', 'admin', 'accountant'].includes(options.role)) throw new BrowserUsSupplierError('supplier_permission_required', 403, 'unauthorized');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), newId = options.newId ?? (() => crypto.randomUUID()), url = `/api/international/workspaces/${encodeURIComponent(organizationId)}/supplier-proposals`;
  const controllers = new Set<AbortController>(), timers = new Set<ReturnType<typeof setTimeout>>(), cancellations = new Set<(reason: BrowserUsSupplierError) => void>();
  let disposed = false, epoch = 0, readEpoch = 0, latestRead = 0, writing = false, reserving = false, readRequired = true;
  let pending: Pending | null = null;
  const alive = (started = epoch) => { if (disposed || started !== epoch) throw new BrowserUsSupplierError('session_changed', 0, 'unauthorized'); };
  function dispose() { if (disposed) return; disposed = true; epoch++; pending = null; for (const cancel of cancellations) cancel(new BrowserUsSupplierError('session_changed', 0, 'unauthorized')); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); for (const timer of timers) clearTimeout(timer); timers.clear(); }
  async function response(method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const started = epoch; alive(started); const write = method === 'POST', controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (reason: BrowserUsSupplierError) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsSupplierError('response_timeout', 0, write ? 'uncertain' : 'rejected')); }, options.timeoutMs ?? 30_000); });
    if (timer) timers.add(timer);
    const cancelled = new Promise<never>((_, reject) => { cancel = reject; cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      const res = await wait(fetcher(url, { method, headers: { Accept: 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': expectedUserId, ...(write ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(started);
      if ([401, 402, 403].includes(res.status)) { dispose(); throw new BrowserUsSupplierError(res.status === 402 ? 'management_entitlement_required' : res.status === 403 ? 'forbidden' : 'unauthorized', res.status, 'unauthorized'); }
      const maximum = res.ok ? maximumBytes : 4096, length = res.headers.get('Content-Length');
      if (res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new BrowserUsSupplierError('invalid_response', res.status, write ? 'uncertain' : 'rejected');
      const reader = res.body?.getReader(); let bytes: Uint8Array;
      if (reader) { const parts: Uint8Array[] = []; let size = 0; try { for (;;) { const part = await wait(reader.read()); alive(started); if (part.done) break; size += part.value.byteLength; if (size > maximum) { void reader.cancel(); throw new BrowserUsSupplierError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); } parts.push(part.value); } bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } } finally { reader.releaseLock(); } }
      else { bytes = new Uint8Array(await wait(res.arrayBuffer())); alive(started); if (bytes.byteLength > maximum) throw new BrowserUsSupplierError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); }
      let input: unknown; try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new BrowserUsSupplierError('invalid_response', res.status, write ? 'uncertain' : 'rejected'); }
      alive(started);
      if (!res.ok) { let code = 'service_unavailable'; try { const error = exact(input, ['error']); if (typeof error.error === 'string' && knownErrors.has(error.error)) code = error.error; } catch { /* Private or unknown error text never reaches the UI. */ }
        if (res.status === 404 && code === 'feature_unavailable' || res.status === 409 && code === 'edition_unavailable') { dispose(); throw new BrowserUsSupplierError(code, res.status, 'unauthorized'); }
        if (write && pending?.action === 'approve' && (res.status === 409 && certainConflicts.has(code) || res.status === 422 && certainValidation.has(code))) { pending = null; readRequired = true; throw new BrowserUsSupplierError(code, res.status, 'rejected'); }
        if (write && pending?.action === 'prepare' && res.status===409 && certainAnalysis.has(code)) {pending=null;readRequired=true;throw new BrowserUsSupplierError(code,res.status,'rejected');}
        if(write && pending?.action==='prepare' && res.status===422 && code==='supplier_source_unreadable'){pending=null;readRequired=true;throw new BrowserUsSupplierError(code,res.status,'rejected');}
        throw new BrowserUsSupplierError(code, res.status, write ? 'uncertain' : 'rejected'); }
      return input;
    } catch (error) { if (error instanceof BrowserUsSupplierError) throw error; alive(started); throw new BrowserUsSupplierError('service_unavailable', 0, write ? 'uncertain' : 'rejected'); }
    finally { if (timer) { clearTimeout(timer); timers.delete(timer); } controllers.delete(controller); cancellations.delete(cancel); }
  }
  async function send(): Promise<BrowserUsSupplierResult> {
    alive(); if (writing || !pending) throw new BrowserUsSupplierError(writing ? 'pending_operation' : 'no_pending_operation', 409);
    const original = pending, started = epoch; writing = true; readEpoch++;
    try {
      const raw = await response('POST', original.body); alive(started); let result: BrowserUsSupplierResult;
      try {
        if (original.action === 'prepare') { const value = exact(raw, ['proposal', 'replayed']), proposal = validateUsSupplierProposal(value.proposal, organizationId);
          if (typeof value.replayed !== 'boolean' || proposal.source.sha256 !== original.sourceHash || proposal.source.documentText !== original.input.documentText || !value.replayed && (proposal.source.kind !== 'document_import' || proposal.source.mediaType !== 'text/plain' || proposal.source.fileName !== original.input.fileName)) throw new Error('shape');
          result = Object.freeze({ action: 'prepare', proposal, replayed: value.replayed });
        } else { const value = exact(raw, ['recording', 'replayed']), recording = validateUsSupplierRecording(value.recording, organizationId), request = original.request;
          if (typeof value.replayed !== 'boolean' || recording.by !== expectedUserId || recording.idempotencyKey !== request.idempotencyKey || recording.requestHash !== original.requestHash || canonicalErpJson(recording.review) !== canonicalErpJson(request.review) || recording.erpReceipt.entityId !== `us-mail-bill:${request.proposalId}` || recording.erpReceipt.commandHash !== original.erpHash || recording.erpReceipt.revision !== request.expectedErpRevision + 1) throw new Error('shape');
          result = Object.freeze({ action: 'approve', recording, replayed: value.replayed });
        }
      } catch { throw new BrowserUsSupplierError('invalid_response', 503, 'uncertain'); }
      pending = null; return result;
    } finally { writing = false; readRequired = true; readEpoch++; }
  }
  function canStart() { alive(); if (pending || writing || reserving) throw new BrowserUsSupplierError('pending_operation', 409); if (readRequired) throw new BrowserUsSupplierError('read_required', 409); }
  return {
    async load() { const started = epoch, startedRead = readEpoch, latest = ++latestRead; alive(started); const raw = await response('GET'); alive(started); if (startedRead !== readEpoch || latest !== latestRead) throw new BrowserUsSupplierError('stale_read', 0); let result: BrowserUsSupplierRead; try { result = readBrowserUsSupplierResponse(raw, organizationId); } catch { throw new BrowserUsSupplierError('invalid_response', 503); } readRequired = false; return result; },
    async prepare(input) { canStart(); const prepared = prepareInput(input), started = epoch; reserving = true; try { const sourceHash = await sha256Hex(prepared.documentText); alive(started); pending = Object.freeze({ action: 'prepare', input: prepared, sourceHash, body: canonicalErpJson(prepared) }); readEpoch++; return await send(); } finally { reserving = false; } },
    async approve(proposal, review, expectedErpRevision) {
      canStart(); reserving = true; const started = epoch;
      try { let request: UsSupplierApprovalRequest, erpBody;
        try { const parsed = validateUsSupplierProposal(proposal, organizationId); if (parsed.state !== 'review') throw new Error('recorded'); request = validateUsSupplierApprovalRequest({ schemaVersion: 1, idempotencyKey: newId(), proposalId: parsed.id, expectedProposalRevision: 0, expectedErpRevision, confirmed: true, taxReviewed: true, review }); erpBody = supplierErpRequest(parsed, request); } catch { throw new BrowserUsSupplierError('invalid_request', 422); }
        const [requestHash, erpHash] = await Promise.all([sha256Hex(canonicalErpJson([organizationId, expectedUserId, request])), sha256Hex(canonicalErpJson([organizationId, expectedUserId, erpBody]))]); alive(started);
        pending = Object.freeze({ action: 'approve', request, requestHash, erpHash, body: canonicalErpJson({ schemaVersion: 1, action: 'approve', request }) }); readEpoch++; return await send();
      } finally { reserving = false; }
    },
    retry: send, hasPending: () => !disposed && pending !== null, pendingAction: () => !disposed ? pending?.action ?? null : null, dispose,
  };
}
