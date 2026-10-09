import type { AccountRole } from '../account-security';
import { BrowserErpError, type BrowserErpResult } from './browser-erp-session';
import { canonicalErpJson } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { ERP_SCHEMA_HEADER, type ErpSchemaVersion } from './erp-schema-capability';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { ErpCommand, ErpRequest } from './runtime-types';
import { validateUsTaxReadiness, type UsTaxReadiness } from './us-tax-readiness';

export interface BrowserUsTaxCode { readonly id: string; readonly name: string; readonly description: string }
export interface BrowserUsTaxInvoiceChoices {
  readonly classifications: readonly Readonly<{ lineId: string; taxCode: string; confirmedService: true }>[];
  readonly taxDateInstant: string;
  readonly addressSource: 'billing' | 'shipping';
}
type InvoiceCommand = Extract<ErpCommand, { type: 'issue_invoice' }>;
export interface BrowserUsTaxInvoiceSession {
  lookup(this: void, code: string): Promise<BrowserUsTaxCode>;
  catalogue(this: void, cursor?: string): Promise<Readonly<{ taxCodes: readonly BrowserUsTaxCode[]; hasMore: boolean; nextCursor: string | null }>>;
  readiness(this: void): Promise<UsTaxReadiness>;
  submit(this: void, command: InvoiceCommand, expectedRevision: number, choices: BrowserUsTaxInvoiceChoices): Promise<BrowserErpResult>;
  retry(this: void): Promise<BrowserErpResult>;
  hasPending(this: void): boolean;
  dispose(this: void): void;
}
const codePattern = /^txcd_[0-9]{8}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const conflicts = new Set(['revision_conflict', 'estimate_revision_conflict', 'idempotency_conflict', 'tax_preparation_conflict']);
const known = new Set([...conflicts, 'invalid_request', 'invalid_tax_preparation', 'invalid_tax_date', 'unsupported_tax_request', 'tax_classification_changed', 'tax_configuration_changed', 'tax_binding_changed', 'binding_unavailable', 'tax_binding_unavailable', 'tax_operation_expired', 'tax_preparation_required', 'tax_preparation_changed', 'tax_preparation_expired', 'configuration_changed', 'feature_unavailable', 'edition_unavailable', 'client_upgrade_required', 'rate_limited', 'service_unavailable', 'seller_configuration_required', 'tax_details_required', 'country_configuration_required', 'accounting_period_not_open', 'invoice_already_issued', 'estimate_acceptance_required', 'catalogue_unavailable']);
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = snapshotPrivateJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('shape');
  return value as Record<string, unknown>;
}
export function validateBrowserUsTaxInvoiceChoices(input: unknown): BrowserUsTaxInvoiceChoices {
  try {
    const value = exact(input, ['classifications', 'taxDateInstant', 'addressSource']);
    if (!Array.isArray(value.classifications) || !value.classifications.length || value.classifications.length > 100 || typeof value.taxDateInstant !== 'string' || !/T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.000)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value.taxDateInstant) || !['billing', 'shipping'].includes(value.addressSource as string)) throw new Error('choices');
    parseInstant(value.taxDateInstant);
    const ids = new Set<string>();
    const classifications = value.classifications.map(inputLine => {
      const line = exact(inputLine, ['lineId', 'taxCode', 'confirmedService']);
      if (typeof line.lineId !== 'string' || !line.lineId.trim() || line.lineId.length > 160 || ids.has(line.lineId) || typeof line.taxCode !== 'string' || !codePattern.test(line.taxCode) || line.confirmedService !== true) throw new Error('line');
      ids.add(line.lineId); return Object.freeze({ lineId: line.lineId, taxCode: line.taxCode, confirmedService: true as const });
    });
    return Object.freeze({ classifications: Object.freeze(classifications), taxDateInstant: value.taxDateInstant, addressSource: value.addressSource as 'billing' | 'shipping' });
  } catch { throw new BrowserErpError('invalid_request', 422, 'rejected'); }
}

/** Cookie-only, explicit user operations. The two POST bodies are immutable RAM
 * snapshots; recovery tries the original ERP receipt before any preparation.
 * Readiness and catalogue reads never replace pending choices or mint a key. */
export function createBrowserUsTaxInvoiceSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; supportedSchemaVersion: ErpSchemaVersion; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsTaxInvoiceSession {
  const { organizationId, expectedUserId, role, supportedSchemaVersion } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || !expectedUserId || expectedUserId !== expectedUserId.trim() || Array.from(expectedUserId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || expectedUserId.length > 256 || ![1, 2, 3, 4].includes(supportedSchemaVersion)) throw new BrowserErpError('invalid_request', 422, 'rejected');
  if (!['owner', 'admin', 'accountant'].includes(role)) throw new BrowserErpError('financial_permission_required', 403, 'unauthorized');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new BrowserErpError('invalid_request', 422, 'rejected');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), newId = options.newId ?? (() => crypto.randomUUID());
  const base = `/api/international/workspaces/${encodeURIComponent(organizationId)}`;
  let disposed = false, writing = false, attemptedIssue = false;
  let pending: Readonly<{ request: ErpRequest; prepareBody: string; issueBody: string }> | null = null;
  const controllers = new Set<AbortController>(), cancelers = new Set<(error: BrowserErpError) => void>();
  const alive = () => { if (disposed) throw new BrowserErpError('session_changed', 0, 'unauthorized'); };
  function dispose() { disposed = true; pending = null; for (const controller of controllers) controller.abort(); controllers.clear(); for (const cancel of cancelers) cancel(new BrowserErpError('session_changed', 0, 'unauthorized')); cancelers.clear(); }
  async function response(path: string, body?: string): Promise<unknown> {
    alive(); const write = body !== undefined, outcome = write ? 'uncertain' : 'rejected';
    const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (error: BrowserErpError) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserErpError('response_timeout', 0, outcome)); }, timeoutMs); });
    const cancelled = new Promise<never>((_, reject) => { cancel = reject; cancelers.add(cancel); });
    const wait = <T>(task: Promise<T>) => Promise.race([task, deadline, cancelled]);
    try {
      const res = await wait(fetcher(base + path, { method: write ? 'POST' : 'GET', headers: { Accept: 'application/json', [ERP_SCHEMA_HEADER]: String(supportedSchemaVersion), 'X-Zentra-Expected-User': expectedUserId, ...(write ? { 'Content-Type': 'application/json' } : {}) }, ...(write ? { body } : {}), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive();
      if ([401, 402, 403].includes(res.status)) { dispose(); throw new BrowserErpError(res.status === 401 ? 'unauthorized' : res.status === 402 ? 'management_entitlement_required' : 'forbidden', res.status, 'unauthorized'); }
      const maximum = res.ok ? path.startsWith('/tax-catalogue') ? 524_288 : 32_768 : 4096, length = res.headers.get('Content-Length');
      if (res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new BrowserErpError('invalid_response', res.status, outcome);
      const reader = res.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
      if (reader) try { for (;;) { const part = await wait(reader.read()); alive(); if (part.done) break; size += part.value.byteLength; if (size > maximum) { void reader.cancel(); throw new BrowserErpError('invalid_response', res.status, outcome); } parts.push(part.value); } } finally { reader.releaseLock(); }
      else { const bytes = new Uint8Array(await wait(res.arrayBuffer())); alive(); size = bytes.byteLength; if (size > maximum) throw new BrowserErpError('invalid_response', res.status, outcome); parts.push(bytes); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new BrowserErpError('invalid_response', res.status, outcome); } alive();
      if (!res.ok) {
        let code = 'service_unavailable'; try { const error = exact(raw, ['error']); if (typeof error.error === 'string' && known.has(error.error)) code = error.error; } catch { /* No private server text. */ }
        if (code === 'feature_unavailable' || code === 'edition_unavailable' || code === 'client_upgrade_required') { dispose(); throw new BrowserErpError(code, res.status, 'unauthorized'); }
        if (write && !attemptedIssue && path === '/tax-invoice-preparation' && res.status === 422 && ['invalid_request', 'invalid_tax_preparation', 'invalid_tax_date', 'unsupported_tax_request'].includes(code)) { pending = null; throw new BrowserErpError(code, res.status, 'rejected'); }
        throw new BrowserErpError(code, res.status, outcome);
      }
      return raw;
    } catch (error) { if (error instanceof BrowserErpError) throw error; alive(); throw new BrowserErpError('response_unavailable', 0, outcome); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancelers.delete(cancel); }
  }
  async function send(recovery = false): Promise<BrowserErpResult> {
    alive(); if (writing || !pending) throw new BrowserErpError(writing ? 'pending_operation' : 'no_pending_operation', 409, 'rejected');
    writing = true; const original = pending;
    try {
      async function prepare() {
        const rawPreparation = await response('/tax-invoice-preparation', original.prepareBody); alive();
        try { const prepared = exact(rawPreparation, ['schemaVersion', 'organizationId', 'status', 'idempotencyKey', 'replayed']); if (prepared.schemaVersion !== 1 || prepared.organizationId !== organizationId || prepared.status !== 'prepared_test' || prepared.idempotencyKey !== original.request.idempotencyKey || typeof prepared.replayed !== 'boolean') throw new Error('preparation'); }
        catch { throw new BrowserErpError('invalid_response', 200, 'uncertain'); }
      }
      let raw: unknown;
      async function issueOriginal() { attemptedIssue = true; return response('/erp', original.issueBody); }
      if (recovery) {
        try { raw = await issueOriginal(); }
        catch (error) { if (!(error instanceof BrowserErpError) || error.code !== 'tax_preparation_required') throw error; await prepare(); raw = await issueOriginal(); }
      } else { await prepare(); raw = await issueOriginal(); }
      alive();
      let result: BrowserErpResult;
      try {
        const value = exact(raw, ['receipt', 'replayed']), receipt = exact(value.receipt, ['idempotencyKey', 'commandHash', 'revision', 'entityId', 'action']);
        if (typeof value.replayed !== 'boolean' || receipt.idempotencyKey !== original.request.idempotencyKey || receipt.action !== 'issue_invoice' || original.request.command.type !== 'issue_invoice' || receipt.entityId !== original.request.command.id || receipt.revision !== original.request.expectedRevision + 1 || typeof receipt.commandHash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.commandHash)) throw new Error('receipt');
        result = Object.freeze({ receipt: Object.freeze({ idempotencyKey: receipt.idempotencyKey as string, commandHash: receipt.commandHash, revision: receipt.revision as number, entityId: receipt.entityId as string, action: 'issue_invoice' as const }), replayed: value.replayed });
      } catch { throw new BrowserErpError('invalid_response', 200, 'uncertain'); }
      pending = null; return result;
    } finally { writing = false; }
  }
  return {
    async catalogue(cursor) {
      alive(); if (cursor !== undefined && !codePattern.test(cursor)) throw new BrowserErpError('invalid_request', 422, 'rejected');
      const raw = await response(`/tax-catalogue${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      try { const value = exact(raw, ['schemaVersion', 'organizationId', 'taxCodes', 'hasMore', 'nextCursor']); if (value.schemaVersion !== 1 || value.organizationId !== organizationId || !Array.isArray(value.taxCodes) || value.taxCodes.length > 100 || typeof value.hasMore !== 'boolean' || value.hasMore !== (value.nextCursor !== null) || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !codePattern.test(value.nextCursor))) throw new Error('page'); const ids = new Set<string>(); const taxCodes = value.taxCodes.map(input => { const row = exact(input, ['id', 'name', 'description']); if (typeof row.id !== 'string' || !codePattern.test(row.id) || ids.has(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 2000 || typeof row.description !== 'string' || row.description.length > 16000) throw new Error('code'); ids.add(row.id); return Object.freeze({ id: row.id, name: row.name, description: row.description }); }); if (value.hasMore && value.nextCursor === cursor) throw new Error('cursor'); return Object.freeze({ taxCodes: Object.freeze(taxCodes), hasMore: value.hasMore, nextCursor: value.nextCursor as string | null }); }
      catch { throw new BrowserErpError('invalid_response', 200, 'rejected'); }
    },
    async lookup(code) {
      alive(); if (!codePattern.test(code)) throw new BrowserErpError('invalid_request', 422, 'rejected');
      const raw = await response(`/tax-catalogue?code=${encodeURIComponent(code)}`);
      try { const value = exact(raw, ['schemaVersion', 'organizationId', 'taxCode']), row = exact(value.taxCode, ['id', 'name', 'description']); if (value.schemaVersion !== 1 || value.organizationId !== organizationId || row.id !== code || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 2000 || typeof row.description !== 'string' || row.description.length > 16000) throw new Error('catalogue'); return Object.freeze({ id: code, name: row.name, description: row.description }); }
      catch { throw new BrowserErpError('invalid_response', 200, 'rejected'); }
    },
    async readiness() { const raw = await response('/tax-readiness'); try { const value = validateUsTaxReadiness(raw); if (value.organizationId !== organizationId || value.effectiveSchemaVersion > supportedSchemaVersion || value.checkedAt > Math.floor(Date.now() / 1000)) throw new Error('readiness'); return value; } catch { throw new BrowserErpError('invalid_response', 200, 'rejected'); } },
    async submit(command, expectedRevision, inputChoices) {
      alive(); if (writing || pending) throw new BrowserErpError('pending_operation', 409, 'rejected');
      let request: ErpRequest, prepareBody: string, issueBody: string;
      try { const key = newId(); if (!uuid.test(key)) throw new Error('key'); request = validateErpRequest({ idempotencyKey: key, expectedRevision, command: snapshotPrivateJson(command) }, organizationId); if (request.command.type !== 'issue_invoice') throw new Error('command'); const choices = validateBrowserUsTaxInvoiceChoices(inputChoices); issueBody = canonicalErpJson(request); request = snapshotPrivateJson(request) as ErpRequest; prepareBody = canonicalErpJson({ request, choices }); if (new TextEncoder().encode(prepareBody).byteLength > 65_536) throw new Error('size'); }
      catch { throw new BrowserErpError('invalid_request', 422, 'rejected'); }
      pending = Object.freeze({ request, prepareBody, issueBody }); attemptedIssue = false; return send();
    },
    retry: () => send(true), hasPending: () => !disposed && pending !== null, dispose,
  };
}
