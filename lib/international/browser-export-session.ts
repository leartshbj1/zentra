import type { SiteLanguage } from '../site-language';
import { ERP_SCHEMA_HEADER, type ErpSchemaVersion } from './erp-schema-capability';
import { canonicalErpJson } from './erp-contract';
import { validateUsExportSelector, validateUsExportSnapshot, type ExportSelector, type ExportSnapshot } from './export-snapshot';

export type BrowserExportFormat = 'json' | 'pdf' | 'html' | 'csv';
export class BrowserExportError extends Error {
  constructor(readonly code: string, readonly status: number, readonly unauthorized = false) { super(code); this.name = 'BrowserExportError'; }
}
export interface BrowserExportResult { readonly blob: Blob; readonly filename: string; readonly erpRevision: number; readonly ledgerRevision: number }
export interface BrowserExportSession {
  load(selector: ExportSelector, language: SiteLanguage, minimumRevision: number): Promise<ExportSnapshot>;
  file(selector: ExportSelector, language: SiteLanguage, minimumRevision: number, format: Exclude<BrowserExportFormat, 'json'>, exactRevision?: number): Promise<BrowserExportResult>;
  download(result: BrowserExportResult): void;
  dispose(): void;
}
const media = { json: 'application/json', pdf: 'application/pdf', html: 'text/html', csv: 'text/csv' } as const;
const known = new Set(['invalid_export_selector', 'export_source_not_found', 'seller_configuration_required', 'export_unavailable', 'export_too_large', 'unsupported_export_glyph', 'client_upgrade_required', 'configuration_changed', 'rate_limited']);
export function browserExportUrl(organizationId: string, rawSelector: ExportSelector, language: SiteLanguage, format: BrowserExportFormat): string {
  const selector = validateUsExportSelector(rawSelector);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || !['fr', 'de', 'it', 'en'].includes(language) || !Object.hasOwn(media, format)) throw new BrowserExportError('invalid_export_selector', 422);
  const query = new URLSearchParams({ format, language });
  let path: string;
  if (selector.kind === 'document') path = `documents/${selector.documentType}/${encodeURIComponent(selector.id)}`;
  else {
    path = `reports/${selector.reportType}`;
    if ('asOf' in selector) query.set('asOf', selector.asOf);
    else { query.set('start', selector.start); query.set('end', selector.end); if ('accountId' in selector) query.set('accountId', selector.accountId); }
  }
  return `/api/international/workspaces/${encodeURIComponent(organizationId)}/exports/${path}?${query}`;
}
const revision = (raw: string | null): number => {
  if (raw === null || !/^(?:0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new BrowserExportError('invalid_export_response', 503);
  return Number(raw);
};
/** No storage, bearer token, caller-supplied amounts or roles. Private reads are
 * bounded, abortable and invalidated before a late body can become a download. */
export function createBrowserExportSession(options: { organizationId: string; expectedUserId: string; supportedSchemaVersion?: ErpSchemaVersion; fetch?: typeof globalThis.fetch; timeoutMs?: number }): BrowserExportSession {
  const { organizationId, expectedUserId } = options, capability = options.supportedSchemaVersion ?? 1;
  browserExportUrl(organizationId, { kind: 'report', reportType: 'trial_balance', asOf: '2026-01-01' }, 'en', 'json');
  if (!expectedUserId || expectedUserId.trim() !== expectedUserId || expectedUserId.length > 256 || Array.from(expectedUserId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || ![1, 2, 3].includes(capability)) throw new BrowserExportError('invalid_export_selector', 422);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), controllers = new Set<AbortController>(), urls = new Set<string>(), timers = new Set<ReturnType<typeof setTimeout>>(), cancellations = new Set<(reason: BrowserExportError) => void>(), ownedResults = new WeakSet<BrowserExportResult>();
  let disposed = false, epoch = 0;
  const alive = (started: number) => { if (disposed || started !== epoch) throw new BrowserExportError('session_changed', 0, true); };
  function dispose() { disposed = true; epoch++; for (const cancel of cancellations) cancel(new BrowserExportError('session_changed', 0, true)); cancellations.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); for (const timer of timers) clearTimeout(timer); timers.clear(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
  async function read(selector: ExportSelector, language: SiteLanguage, minimumRevision: number, format: BrowserExportFormat, exactRevision?: number) {
    const started = epoch; alive(started);
    if (!Number.isSafeInteger(minimumRevision) || minimumRevision < 1 || (exactRevision !== undefined && (!Number.isSafeInteger(exactRevision) || exactRevision < minimumRevision))) throw new BrowserExportError('invalid_export_selector', 422);
    const controller = new AbortController(); controllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new BrowserExportError('export_timeout', 0)); }, options.timeoutMs ?? 30_000); });
    if (timeout !== undefined) timers.add(timeout);
    let cancel: (reason: BrowserExportError) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; cancellations.add(cancel); });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, deadline, cancelled]);
    try {
      if (selector.kind === 'document' && selector.documentType === 'project' && capability < 3) throw new BrowserExportError('client_upgrade_required',409);
      const response = await wait(fetcher(browserExportUrl(organizationId, selector, language, format), { method: 'GET', headers: { Accept: media[format], 'X-Zentra-Expected-User': expectedUserId, ...(capability > 1 ? { [ERP_SCHEMA_HEADER]: String(capability) } : {}) }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive(started);
      if ([401, 402, 403].includes(response.status)) { dispose(); throw new BrowserExportError('unauthorized', response.status, true); }
      if (!response.ok) {
        const value: unknown = await wait(response.json()); alive(started);
        const code = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'error' in value && typeof value.error === 'string' && known.has(value.error) ? value.error : 'export_unavailable';
        throw new BrowserExportError(code, response.status);
      }
      const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (contentType !== media[format] || response.headers.get('X-Zentra-Organization-Id') !== organizationId || response.headers.get('X-Zentra-Currency') !== 'USD' || response.headers.get('X-Zentra-Export-Language') !== language || response.headers.get('X-Zentra-Export-Format') !== format) throw new BrowserExportError('invalid_export_response', 503);
      const erpRevision = revision(response.headers.get('X-Zentra-Erp-Revision')), ledgerRevision = revision(response.headers.get('X-Zentra-Ledger-Revision'));
      if (erpRevision < minimumRevision || ledgerRevision > erpRevision || (exactRevision !== undefined && exactRevision !== erpRevision)) throw new BrowserExportError('export_revision_changed', 409);
      const recordHeader = response.headers.get('X-Zentra-Record-Revision'), recordRevision = recordHeader === null ? null : revision(recordHeader);
      if (recordRevision !== null && (recordRevision < 1 || recordRevision > erpRevision)) throw new BrowserExportError('invalid_export_response', 503);
      const hash = response.headers.get('X-Zentra-Content-SHA256');
      if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new BrowserExportError('invalid_export_response', 503);
      const bytes = await wait(response.arrayBuffer()); alive(started);
      if (bytes.byteLength === 0 || bytes.byteLength > 12 * 1024 * 1024) throw new BrowserExportError('invalid_export_response', 503);
      const actualHash = Array.from(new Uint8Array(await wait(crypto.subtle.digest('SHA-256', bytes))), byte => byte.toString(16).padStart(2, '0')).join(''); alive(started);
      if (actualHash !== hash) throw new BrowserExportError('invalid_export_response', 503);
      const expectedSelectorHash = Array.from(new Uint8Array(await wait(crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalErpJson(validateUsExportSelector(selector)))))), byte => byte.toString(16).padStart(2, '0')).join(''); alive(started);
      if (response.headers.get('X-Zentra-Export-Selector-SHA256') !== expectedSelectorHash) throw new BrowserExportError('invalid_export_response', 503);
      const extension = format === 'html' ? 'html' : format, disposition = response.headers.get('Content-Disposition');
      const match = disposition?.match(/^(?:attachment|inline); filename="([A-Za-z0-9._-]{1,220})"$/);
      if (!match || !match[1].endsWith(`.${extension}`) || (format === 'pdf' && new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-')) throw new BrowserExportError('invalid_export_response', 503);
      return { bytes, filename: match[1], erpRevision, ledgerRevision, recordRevision };
    } catch (error) { if (error instanceof BrowserExportError) throw error; alive(started); throw new BrowserExportError('export_unavailable', 0); }
    finally { if (timeout !== undefined) { clearTimeout(timeout); timers.delete(timeout); } controllers.delete(controller); cancellations.delete(cancel); }
  }
  return {
    async load(selector, language, minimumRevision) {
      const started = epoch, result = await read(selector, language, minimumRevision, 'json'); alive(started);
      let value: ExportSnapshot;
      try { value = validateUsExportSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes))); } catch { throw new BrowserExportError('invalid_export_response', 503); }
      if (value.organizationId !== organizationId || value.language !== language || value.erpRevision !== result.erpRevision || value.ledgerRevision !== result.ledgerRevision || value.recordRevision !== result.recordRevision || JSON.stringify(value.selector) !== JSON.stringify(validateUsExportSelector(selector))) throw new BrowserExportError('invalid_export_response', 503);
      return value;
    },
    async file(selector, language, minimumRevision, format, exactRevision) { const started = epoch, value = await read(selector, language, minimumRevision, format, exactRevision); alive(started); const result = Object.freeze({ blob: new Blob([value.bytes], { type: media[format] }), filename: value.filename, erpRevision: value.erpRevision, ledgerRevision: value.ledgerRevision }); ownedResults.add(result); return result; },
    download(result) {
      alive(epoch);
      if (!ownedResults.has(result)) throw new BrowserExportError('invalid_export_response', 503);
      const url = URL.createObjectURL(result.blob); urls.add(url);
      const link = document.createElement('a'); link.href = url; link.download = result.filename; link.rel = 'noopener'; link.click();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); timers.delete(timer); }, 1000); timers.add(timer);
    },
    dispose,
  };
}
