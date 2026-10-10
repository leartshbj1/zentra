import { canonicalErpJson } from './erp-contract';
import {
  US_FINANCIAL_PILOT_EXPORT_HEADERS as h,
  US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES,
  validateUsFinancialPilotExportSelector,
  type UsFinancialPilotExportSelector,
} from './us-financial-pilot-export-contract';

const maximumBytes = US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES;
const media = { pdf: 'application/pdf', csv: 'text/csv' } as const;
export class BrowserUsFinancialPilotExportError extends Error {
  constructor(readonly code: string, readonly status: number, readonly unauthorized = false) {
    super(code); this.name = 'BrowserUsFinancialPilotExportError';
  }
}
export interface BrowserUsFinancialPilotExportResult {
  readonly blob: Blob;
  readonly filename: string;
  readonly revision: number;
  readonly ledgerRevision: number;
}
export interface BrowserUsFinancialPilotExportSession {
  file(selector: UsFinancialPilotExportSelector): Promise<BrowserUsFinancialPilotExportResult>;
  download(result: BrowserUsFinancialPilotExportResult): void;
  dispose(): void;
}
const publicErrors = new Set([
  'invalid_financial_pilot_export_selector', 'invalid_financial_pilot_export_snapshot',
  'financial_pilot_export_too_large', 'financial_pilot_export_unavailable',
  'financial_snapshot_changed', 'financial_pilot_export_source_not_found',
  'financial_pilot_export_cash_flow_unavailable', 'unsupported_financial_pilot_export_glyph',
  'invalid_financial_pilot_export_font', 'export_unavailable',
  'rate_limited', 'feature_unavailable', 'financial_configuration_changed', 'financial_source_changed',
  'financial_export_timeout', 'financial_export_unavailable',
]);
const failure = (code: string, status = 503): never => { throw new BrowserUsFinancialPilotExportError(code, status); };
const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
function revisionHeader(value: string | null): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) return failure('invalid_export_response');
  return Number(value);
}
export function browserUsFinancialPilotExportUrl(organizationId: string, raw: UsFinancialPilotExportSelector): string {
  const selector = validateUsFinancialPilotExportSelector(raw);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) return failure('invalid_export_request', 422);
  const query = new URLSearchParams({ revision: String(selector.revision), language: selector.language, format: selector.format });
  let suffix: string;
  if (selector.kind === 'invoice') suffix = `invoices/${encodeURIComponent(selector.invoiceId)}`;
  else {
    suffix = `reports/${selector.reportType}`;
    if ('asOf' in selector) query.set('asOf', selector.asOf);
    if ('from' in selector) { query.set('from', selector.from); query.set('to', selector.to); }
    if ('accountId' in selector) query.set('accountId', selector.accountId);
  }
  return `/api/international/workspaces/${encodeURIComponent(organizationId)}/financial-pilot/exports/${suffix}?${query}`;
}

/** User-initiated reads only. No bearer token, persistence, retry, provider
 * input or payment-session side effect. The deadline includes streamed bytes
 * and hashing, not merely the initial fetch. */
export function createBrowserUsFinancialPilotExportSession(options: {
  organizationId: string; expectedUserId: string; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}): BrowserUsFinancialPilotExportSession {
  const { organizationId, expectedUserId } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)
    || !expectedUserId || expectedUserId !== expectedUserId.trim() || expectedUserId.length > 256 || /\p{Cc}/u.test(expectedUserId)) return failure('invalid_export_request', 422);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), timeoutMs = options.timeoutMs ?? 30_000;
  if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return failure('invalid_export_request', 422);
  const controllers = new Set<AbortController>(), cancellations = new Set<(error: BrowserUsFinancialPilotExportError) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>(), urls = new Set<string>(), owned = new WeakSet<BrowserUsFinancialPilotExportResult>();
  let disposed = false, epoch = 0;
  const alive = (at: number) => { if (disposed || at !== epoch) throw new BrowserUsFinancialPilotExportError('session_changed', 0, true); };
  function dispose(): void {
    if (disposed) return; disposed = true; epoch++;
    for (const cancel of cancellations) cancel(new BrowserUsFinancialPilotExportError('session_changed', 0, true));
    cancellations.clear();
    for (const controller of controllers) controller.abort(); controllers.clear();
    for (const timer of timers) clearTimeout(timer); timers.clear();
    for (const url of urls) URL.revokeObjectURL(url); urls.clear();
  }
  async function file(raw: UsFinancialPilotExportSelector): Promise<BrowserUsFinancialPilotExportResult> {
    const at = epoch; alive(at);
    // The validator snapshots the selector before any asynchronous operation.
    const selector = validateUsFinancialPilotExportSelector(raw), url = browserUsFinancialPilotExportUrl(organizationId, selector);
    const selectorBytes = new TextEncoder().encode(canonicalErpJson(selector));
    const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new BrowserUsFinancialPilotExportError('export_timeout', 0)); }, timeoutMs);
    });
    if (timer !== undefined) timers.add(timer);
    let cancel: (error: BrowserUsFinancialPilotExportError) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; cancellations.add(cancel); });
    const wait = <T>(task: Promise<T>): Promise<T> => Promise.race([task, deadline, cancelled]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    async function read(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
      if (!response.body) return failure('invalid_export_response');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const chunk = await wait(reader.read()); alive(at);
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > limit - length) return failure('invalid_export_response');
        chunks.push(new Uint8Array(chunk.value)); length += chunk.value.byteLength;
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    }
    try {
      const selectorHash = hex(await wait(crypto.subtle.digest('SHA-256', selectorBytes))); alive(at);
      const response = await wait(fetcher(url, {
        method: 'GET', headers: { Accept: media[selector.format], [h.scope]: '1', 'X-Zentra-Expected-User': expectedUserId },
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      })); alive(at);
      if ([401, 402, 403].includes(response.status)) { dispose(); throw new BrowserUsFinancialPilotExportError('unauthorized', response.status, true); }
      if (!response.ok) {
        const bytes = await read(response, 4096); let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return failure('export_unavailable', response.status); }
        const code = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'error' in value && typeof value.error === 'string' && publicErrors.has(value.error) ? value.error : 'export_unavailable';
        return failure(code, response.status);
      }
      const lengthRaw = response.headers.get('Content-Length');
      if (!lengthRaw || !/^[1-9][0-9]*$/.test(lengthRaw) || !Number.isSafeInteger(Number(lengthRaw)) || Number(lengthRaw) > maximumBytes) return failure('invalid_export_response');
      const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (contentType !== media[selector.format] || response.headers.get(h.scope) !== '1'
        || response.headers.get(h.organization) !== organizationId || response.headers.get(h.currency) !== 'USD'
        || response.headers.get(h.language) !== selector.language || response.headers.get(h.format) !== selector.format
        || response.headers.get(h.selectorHash) !== selectorHash || response.headers.get('X-Content-Type-Options')?.toLowerCase() !== 'nosniff'
        || !response.headers.get('Cache-Control')?.toLowerCase().split(',').some(token => token.trim() === 'no-store')) return failure('invalid_export_response');
      const revision = revisionHeader(response.headers.get(h.revision)), ledgerRevision = revisionHeader(response.headers.get(h.ledgerRevision));
      if (revision !== selector.revision) return failure('financial_snapshot_changed', 409);
      if (ledgerRevision > revision) return failure('invalid_export_response');
      const hash = response.headers.get(h.contentHash), disposition = response.headers.get('Content-Disposition');
      const filename = disposition?.match(/^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,179})"$/)?.[1];
      if (!hash || !/^[0-9a-f]{64}$/.test(hash) || !filename || filename.includes('..') || !filename.endsWith(`.${selector.format}`)) return failure('invalid_export_response');
      const bytes = await read(response, Math.min(Number(lengthRaw), maximumBytes)); alive(at);
      if (bytes.length !== Number(lengthRaw)) return failure('invalid_export_response');
      if (selector.format === 'pdf' ? new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' : bytes[0] !== 239 || bytes[1] !== 187 || bytes[2] !== 191) return failure('invalid_export_response');
      if (selector.format === 'csv') new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const actualHash = hex(await wait(crypto.subtle.digest('SHA-256', bytes))); alive(at);
      if (actualHash !== hash) return failure('invalid_export_response');
      const result = Object.freeze({ blob: new Blob([bytes], { type: media[selector.format] }), filename, revision, ledgerRevision });
      owned.add(result); return result;
    } catch (error) {
      if (error instanceof BrowserUsFinancialPilotExportError) throw error;
      alive(at); return failure('export_unavailable', 0);
    } finally {
      if (reader) void reader.cancel().catch(() => {});
      if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); }
      controllers.delete(controller); cancellations.delete(cancel);
    }
  }
  return {
    file,
    download(result) {
      alive(epoch);
      if (!owned.has(result)) return failure('invalid_export_response');
      const url = URL.createObjectURL(result.blob); urls.add(url);
      try { const link = document.createElement('a'); link.href = url; link.download = result.filename; link.rel = 'noopener'; link.click(); }
      catch { URL.revokeObjectURL(url); urls.delete(url); return failure('export_unavailable', 0); }
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); timers.delete(timer); }, 1000); timers.add(timer);
    },
    dispose,
  };
}
