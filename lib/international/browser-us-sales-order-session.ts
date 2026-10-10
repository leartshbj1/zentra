import type { AccountRole } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { creationUuid } from './workspace-creation';
import { validateUsSalesOrderSource, type UsSalesOrderSource, validateUsSalesOrderPage, validateUsSalesOrderReceipt, validateUsSalesOrderRecord, validateUsSalesOrderRequest, type UsSalesOrderCommand, type UsSalesOrderPage, type UsSalesOrderRecord, type UsSalesOrderRequest, type UsSalesOrderResult } from './us-sales-order-contract';

export class BrowserUsSalesOrderError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized' = 'rejected') { super(code); this.name = 'BrowserUsSalesOrderError'; }
}
export interface BrowserUsSalesOrderSession {
  load(beforeSequence?: number | null): Promise<UsSalesOrderPage>;
  changed(): Promise<boolean>;
  source(estimateId:string):Promise<UsSalesOrderSource>;
  read(id: string): Promise<UsSalesOrderRecord>;
  change(orderId: string, expectedOrderRevision: number | null, command: UsSalesOrderCommand): Promise<UsSalesOrderResult>;
  retry(): Promise<UsSalesOrderResult>;
  download(id: string, revision: number, language: string, format: 'pdf' | 'html' | 'csv' | 'json'): Promise<Blob>;
  hasPending(): boolean;
  dispose(): void;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const certain = new Set(['sales_order_erp_revision_conflict','sales_order_source_unavailable','sales_order_revision_conflict','sales_order_head_conflict','revision_conflict','sales_order_source_conflict','sales_order_already_exists','invoice_already_issued','sales_order_already_invoiced','sales_order_state_conflict','sales_order_idempotency_conflict','invalid_sales_order_request','invalid_request','estimate_not_found','estimate_not_accepted','seller_configuration_required']);
const known = new Set([...certain,'sales_orders_paused','configuration_changed','sales_order_not_found','sales_order_upgrade_required','client_upgrade_required','sales_order_source_too_large','sales_order_sequence_exhausted','rate_limited','service_unavailable','feature_unavailable','edition_unavailable','sales_order_not_confirmed','sales_order_source_locked']);
const fail = (code: string, status = 0, outcome: BrowserUsSalesOrderError['outcome'] = 'rejected'): never => { throw new BrowserUsSalesOrderError(code, status, outcome); };

/** Cookie-only, schema4 transport. A lost mutation retains its exact envelope
 * in RAM; reload cannot infer failure or manufacture a replacement operation. */
export function createBrowserUsSalesOrderSession(options: { organizationId: string; expectedUserId: string; role: AccountRole; fetch?: typeof fetch; newId?: () => string; timeoutMs?: number }): BrowserUsSalesOrderSession {
  try { creationUuid(options.organizationId); } catch { return fail('invalid_request'); }
  if (!options.expectedUserId || options.expectedUserId !== options.expectedUserId.trim() || options.expectedUserId.length > 256 || Array.from(options.expectedUserId).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)) return fail('invalid_request');
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('invalid_request');
  const path = `/api/international/workspaces/${options.organizationId}/sales-orders`, fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let disposed = false, writing = false, generation = 0, latestRead = 0, head: UsSalesOrderPage | null = null;
  let pending: Readonly<{ input: UsSalesOrderRequest; body: string }> | null = null;
  const cancellations = new Set<() => void>(), controllers = new Set<AbortController>();
  const alive = () => { if (disposed) return fail('session_changed', 0, 'unauthorized'); };
  function dispose() { disposed = true; generation++; pending = null; head = null; for (const cancel of cancellations) cancel(); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); }
  async function request(suffix: string, body?: string, contentType = 'application/json'): Promise<{bytes:Uint8Array<ArrayBuffer>;headers:Headers}> {
    alive(); const controller = new AbortController(); controllers.add(controller);
    const mutation = body !== undefined, outcome = mutation ? 'uncertain' : 'rejected';
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrowserUsSalesOrderError('response_timeout', 0, outcome)); }, timeout); });
    const cancellation = new Promise<never>((_, reject) => { cancel = () => reject(new BrowserUsSalesOrderError('session_changed', 0, 'unauthorized')); cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancellation]);
    try {
      const response = await wait(fetcher(path + suffix, { method: mutation ? 'POST' : 'GET', headers: { Accept: contentType, [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': options.expectedUserId, ...(mutation ? { 'Content-Type': 'application/json' } : {}) }, ...(mutation ? { body } : {}), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive();
      if ([401,402,403].includes(response.status)) { dispose(); return fail(response.status === 401 ? 'unauthorized' : response.status === 402 ? 'management_entitlement_required' : 'forbidden', response.status, 'unauthorized'); }
      const maximum = response.ok ? contentType === 'application/json' ? 2 * 1024 * 1024 : 16 * 1024 * 1024 : 4096;
      const length = response.headers.get('Content-Length'), mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (mime !== (response.ok ? contentType : 'application/json') || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) return fail('invalid_response', response.status, outcome);
      const reader = response.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
      if (reader) { try { for (;;) { const part = await wait(reader.read()); alive(); if (part.done) break; size += part.value.byteLength; if (size > maximum) { void reader.cancel(); return fail('invalid_response', response.status, outcome); } parts.push(part.value); } } finally { reader.releaseLock(); } }
      else { const bytes = new Uint8Array(await wait(response.arrayBuffer())); alive(); size = bytes.length; if (size > maximum) return fail('invalid_response', response.status, outcome); parts.push(bytes); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      if (!response.ok) { let code = 'service_unavailable'; try { const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (exact(raw, ['error']) && typeof raw.error === 'string' && known.has(raw.error)) code = raw.error; } catch { /* Never expose debug/provider bodies. */ }
        if (response.status === 404 && code === 'feature_unavailable' || response.status === 409 && code === 'edition_unavailable') { dispose(); return fail(code, response.status, 'unauthorized'); }
        return fail(code, response.status, mutation && !([409,422].includes(response.status) && certain.has(code)) ? 'uncertain' : 'rejected'); }
      return {bytes,headers:response.headers};
    } catch (error) { if (error instanceof BrowserUsSalesOrderError) throw error; alive(); return fail('service_unavailable', 0, outcome); }
    finally { if (timer) clearTimeout(timer); cancellations.delete(cancel); controllers.delete(controller); }
  }
  async function json(suffix: string, body?: string): Promise<unknown> { const {bytes} = await request(suffix, body); alive(); try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('invalid_response', 503, body === undefined ? 'rejected' : 'uncertain'); } }
  async function send(): Promise<UsSalesOrderResult> {
    alive(); if (writing || !pending) return fail(writing ? 'pending_operation' : 'no_pending_operation');
    const original = pending; writing = true; generation++;
    try {
      const raw = await json('', original.body); alive();
      let result: UsSalesOrderResult;
      try { if (!exact(raw, ['receipt','replayed']) || typeof raw.replayed !== 'boolean') throw new Error(); const receipt = validateUsSalesOrderReceipt(raw.receipt, options.organizationId), input = original.input;
        if (receipt.actorId !== options.expectedUserId || receipt.idempotencyKey !== input.idempotencyKey || receipt.orderId !== input.orderId || receipt.action !== input.command.type || receipt.revision !== (input.expectedOrderRevision ?? 0) + 1 || receipt.headRevision !== input.expectedHeadRevision + 1 || receipt.erpRevision !== input.expectedErpRevision) throw new Error();
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalErpJson([options.organizationId, options.expectedUserId, input]))); alive();
        if (receipt.commandHash !== Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('')) throw new Error(); result = { receipt, replayed: raw.replayed };
      } catch (error) { alive(); if (error instanceof BrowserUsSalesOrderError) throw error; return fail('invalid_response',503,'uncertain'); }
      pending = null; return result;
    } catch (error) { if (error instanceof BrowserUsSalesOrderError && error.outcome !== 'uncertain') pending = null; throw error; }
    finally { writing = false; head = null; generation++; }
  }
  return {
    async load(beforeSequence = null) { alive(); const stamp = generation, read = ++latestRead; if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) return fail('invalid_request');
      const raw = await json(beforeSequence === null ? '' : `?beforeSequence=${beforeSequence}`); alive(); if (stamp !== generation || read !== latestRead || writing) return fail('stale_read');
      let value: UsSalesOrderPage; try { value = validateUsSalesOrderPage(raw, options.organizationId); } catch { return fail('invalid_response'); }
      if (beforeSequence !== null && value.orders.some(o => o.sequence >= beforeSequence)) return fail('invalid_response'); head = value; return value; },
    async changed() { alive(); const raw = await json('?head=1'); alive(); if (!exact(raw, ['schemaVersion','organizationId','headRevision','erpRevision']) || raw.schemaVersion !== 1 || raw.organizationId !== options.organizationId || typeof raw.headRevision !== 'number' || !Number.isSafeInteger(raw.headRevision) || raw.headRevision < 0 || typeof raw.erpRevision !== 'number' || !Number.isSafeInteger(raw.erpRevision) || raw.erpRevision < 1) return fail('invalid_response'); return !head || raw.headRevision !== head.headRevision || raw.erpRevision !== head.erpRevision; },
    async source(estimateId){alive();if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(estimateId))return fail('invalid_request');const raw=await json(`?estimateId=${encodeURIComponent(estimateId)}`);alive();try{const result=validateUsSalesOrderSource(raw,options.organizationId);if(result.estimateId!==estimateId)throw new Error();return result;}catch{return fail('invalid_response');}},
    async read(id) { alive(); try { creationUuid(id); } catch { return fail('invalid_request'); } const raw = await json(`/${id}`); alive(); if (!exact(raw, ['schemaVersion','organizationId','record']) || raw.schemaVersion !== 1 || raw.organizationId !== options.organizationId) return fail('invalid_response'); try { const record = validateUsSalesOrderRecord(raw.record, options.organizationId); if (record.order.id !== id) throw new Error(); return record; } catch { return fail('invalid_response'); } },
    async change(orderId, expectedOrderRevision, command) { alive(); if (options.role === 'read_only') return fail('forbidden',403); if (pending || writing) return fail('pending_operation'); if (!head) return fail('read_required');
      let input: UsSalesOrderRequest; try { input = validateUsSalesOrderRequest({ schemaVersion:1, idempotencyKey: creationUuid((options.newId ?? (() => crypto.randomUUID()))()), orderId, expectedErpRevision: head.erpRevision, expectedHeadRevision: head.headRevision, expectedOrderRevision, command }, options.organizationId); } catch { return fail('invalid_sales_order_request',422); }
      pending = Object.freeze({ input, body: canonicalErpJson(input) }); generation++; return send(); },
    retry: send,
    async download(id, revision, language, format) { alive(); try { creationUuid(id); } catch { return fail('invalid_request'); } if (!Number.isSafeInteger(revision) || revision < 1 || !['fr','en','de','it'].includes(language) || !['pdf','html','csv','json'].includes(format)) return fail('invalid_request'); const mime = {pdf:'application/pdf',html:'text/html',csv:'text/csv',json:'application/json'}[format]; const {bytes,headers} = await request(`/${id}/export?format=${format}&language=${language}&revision=${revision}`,undefined,mime); alive(); if(headers.get('X-Zentra-Organization-Id')!==options.organizationId||headers.get('X-Zentra-Record-Id')!==id||headers.get('X-Zentra-Currency')!=='USD'||headers.get('X-Zentra-Export-Language')!==language||headers.get('X-Zentra-Export-Format')!==format||headers.get('X-Zentra-Record-Revision')!==String(revision)||headers.get('Content-Length')!==String(bytes.length))return fail('invalid_response'); const digest=await crypto.subtle.digest('SHA-256',bytes);alive();if(headers.get('X-Zentra-Content-SHA256')!==Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''))return fail('invalid_response');return new Blob([bytes], {type:mime}); },
    hasPending: () => pending !== null, dispose,
  };
}
