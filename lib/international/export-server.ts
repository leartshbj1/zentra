import { AccountPublicError, sha256Hex } from '../account-security';
import { ErpError, canonicalErpJson } from './erp-contract';
import { validDate } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { erpClientSchemaVersion, requireErpClientSchema } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import { validateStoredErp } from './runtime-validation';
import type { ErpServerDependencies } from './runtime-server';
import type { CompanyLanguage } from './types';
import { buildUsExportSnapshot, validateUsExportSnapshot, ExportError, type ExportSelector, type ExportSnapshot } from './export-snapshot';
import { validatePublicSellerSnapshot } from './invoicing';

export type ExportFormat = 'json' | 'html' | 'pdf' | 'csv';
export interface ExportFonts { readonly regular: Uint8Array; readonly bold: Uint8Array }
export type ExportStage = 'parameters' | 'admission' | 'configuration' | 'source' | 'snapshot' | 'fonts' | 'render' | 'hash' | 'postflight';
export interface ExportServerDependencies extends Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'store' | 'seller' | 'rateLimit'> {
  /** Fixed server font data only. No URL, filename or font comes from the request. */
  fonts: (this: void) => Promise<ExportFonts> | ExportFonts;
  /** Private seams for interleaving tests. Defaults are the actual renderers/hash. */
  render?: (this: void, snapshot: ExportSnapshot, format: Exclude<ExportFormat, 'json'>, fonts?: ExportFonts) => Promise<string | Uint8Array> | string | Uint8Array;
  hash?: (this: void, bytes: Uint8Array) => Promise<string>;
  /** Fresh server ceiling, not a client grant. Absent seams keep the captured store ceiling. */
  freshSupportedSchemaVersion?: (this: void, clientCapability: 1 | 2) => Promise<1 | 2> | 1 | 2;
  diagnostic?: (this: void, event: Readonly<{ operation: 'documents' | 'reports'; stage: ExportStage; code: string; status: number }>) => void;
}
export const MAX_EXPORT_BYTES = 12 * 1024 * 1024;
const maximumFontBytes = 2 * 1024 * 1024;
const formats = ['json', 'html', 'pdf', 'csv'] as const;
const languages = ['fr', 'de', 'it', 'en'] as const;
const documentKinds = ['estimate', 'invoice', 'vendor_bill'] as const;
const reportKinds = ['trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger'] as const;
const securityHeaders = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const htmlPolicy = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'";
const civilDate = (value: string) => !value.startsWith('0000-') && validDate(value);
function invalid(): never { throw new ErpError('invalid_request', 422); }
function unavailable(): never { throw new ErpError('service_unavailable', 503); }
function schemaVersion(value: unknown): 1 | 2 { if (value !== 1 && value !== 2) return unavailable(); return value; }
interface ExportSchemaAdmission { client: 1 | 2; captured: 1 | 2; source: 1 | 2 }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return invalid();
  try { return snapshotPrivateJson(value) as string; } catch { return invalid(); }
}
function path(organizationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) return invalid();
}
function admission(value: ErpReadAdmission): ErpReadAdmission {
  const captured = snapshotPrivateJson(value) as ErpReadAdmission;
  if (!captured || Reflect.ownKeys(captured).length !== 2 || !Object.hasOwn(captured, 'mode') || !Object.hasOwn(captured, 'actor') || !['browser', 'device'].includes(captured.mode) || !captured.actor || Reflect.ownKeys(captured.actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(key => Object.hasOwn(captured.actor, key)) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(captured.actor.role)) return unavailable();
  if (typeof captured.actor.organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(captured.actor.organizationId) || typeof captured.actor.managementEntitled !== 'boolean' || typeof captured.actor.userId !== 'string' || !captured.actor.userId.trim() || captured.actor.userId !== captured.actor.userId.trim() || captured.actor.userId.length > 256 || Array.from(captured.actor.userId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return unavailable();
  return captured;
}
function parameters(request: Request, kind: string, id?: string): { selector: ExportSelector; format: ExportFormat; language?: CompanyLanguage } {
  if (request.method !== 'GET') throw new ErpError('method_not_allowed', 405);
  if (request.url.length > 4096) return invalid();
  const params = new URL(request.url).searchParams;
  const allowed = id !== undefined ? ['format', 'language'] : ['format', 'language', ...(kind === 'trial_balance' || kind === 'balance_sheet' ? ['asOf'] : kind === 'general_ledger' ? ['start', 'end', 'accountId'] : ['start', 'end'])];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) return invalid();
  const format = params.get('format') ?? 'json', language = params.get('language') ?? undefined;
  if (!formats.includes(format as ExportFormat) || language !== undefined && !languages.includes(language as CompanyLanguage)) return invalid();
  let selector: ExportSelector;
  if (id !== undefined) {
    if (!documentKinds.includes(kind as typeof documentKinds[number])) return invalid();
    selector = { kind: 'document', documentType: kind as typeof documentKinds[number], id: text(id, 160) };
  } else {
    if (!reportKinds.includes(kind as typeof reportKinds[number])) return invalid();
    if (kind === 'trial_balance' || kind === 'balance_sheet') {
      const asOf = params.get('asOf'); if (!asOf || !civilDate(asOf)) return invalid();
      selector = { kind: 'report', reportType: kind, asOf };
    } else {
      const start = params.get('start'), end = params.get('end');
      if (!start || !end || !civilDate(start) || !civilDate(end) || start > end) return invalid();
      selector = kind === 'general_ledger' ? { kind: 'report', reportType: kind, start, end, accountId: text(params.get('accountId'), 160) } : { kind: 'report', reportType: kind as 'profit_loss' | 'cash_flow', start, end };
    }
  }
  return { selector: Object.freeze(selector), format: format as ExportFormat, ...(language === undefined ? {} : { language: language as CompanyLanguage }) };
}
/** Intrinsic typed-array operations ignore own constructor/length/buffer
 * accessors and reject proxy/shared-memory buffers; no caller code is invoked. */
function copyBytes(input: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array) || Object.getPrototypeOf(input) !== Uint8Array.prototype) return unavailable();
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const length = Object.getOwnPropertyDescriptor(prototype, 'length')!.get!.call(input) as number;
  const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!.call(input) as unknown;
  if (!Number.isSafeInteger(length) || length < 1 || !buffer || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return unavailable();
  if (length > maximum) throw new ErpError('export_too_large', 413);
  const copy = new Uint8Array(length); Uint8Array.prototype.set.call(copy, input); return copy;
}
function fontData(input: ExportFonts): ExportFonts {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2) return unavailable();
  const copy = (name: 'regular' | 'bold') => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return unavailable();
    try { return copyBytes(descriptor.value, maximumFontBytes); } catch { return unavailable(); }
  };
  return { regular: copy('regular'), bold: copy('bold') };
}
function responseBytes(output: unknown, format: ExportFormat): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (format === 'pdf') {
    bytes = copyBytes(output, MAX_EXPORT_BYTES);
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' || !new TextDecoder().decode(bytes.subarray(-2048)).includes('%%EOF')) return unavailable();
  } else {
    if (typeof output !== 'string') return unavailable();
    if (output.length > MAX_EXPORT_BYTES) throw new ErpError('export_too_large', 413);
    bytes = new TextEncoder().encode(output);
  }
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new ErpError('export_too_large', 413);
  return bytes;
}
function filename(snapshot: ExportSnapshot, format: ExportFormat): string {
  const kind = snapshot.selector.kind === 'document' ? snapshot.selector.documentType : snapshot.selector.reportType;
  const stem = (snapshot.number || kind).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || 'export';
  return `${kind}-${stem}-r${snapshot.erpRevision}-${snapshot.language}.${format}`;
}
const publicErrors: Record<string, number> = { invalid_request: 422, method_not_allowed: 405, feature_unavailable: 404, unauthorized: 401, session_changed: 401, tenant_mismatch: 403, forbidden: 403, management_entitlement_required: 402, edition_unavailable: 409, country_configuration_required: 409, client_upgrade_required: 409, workspace_unavailable: 409, invalid_export_selector: 422, export_source_not_found: 404, seller_configuration_required: 409, export_unavailable: 409, invalid_export_snapshot: 503, export_too_large: 413, unsupported_export_glyph: 422, invalid_export_font: 503 };
function failure(error: unknown, dependencies: ExportServerDependencies, operation: 'documents' | 'reports', stage: ExportStage): Response {
  let code = 'service_unavailable', status = 503;
  try {
    const data = (name: string): unknown => { if (!error || typeof error !== 'object') return undefined; const descriptor = Object.getOwnPropertyDescriptor(error, name); return descriptor && 'value' in descriptor ? descriptor.value : undefined; };
    const errorStatus = data('status'), errorCode = data('code');
    if (error instanceof AccountPublicError) { status = typeof errorStatus === 'number' && [401, 402, 403, 429].includes(errorStatus) ? errorStatus : 503; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : code; }
    else if ((error instanceof ErpError || error instanceof ExportError) && typeof errorCode === 'string' && typeof errorStatus === 'number' && Object.hasOwn(publicErrors, errorCode) && publicErrors[errorCode] === errorStatus) { code = errorCode; status = errorStatus; }
  } catch { /* A malformed privileged exception is always generic. */ }
  try { dependencies.diagnostic?.({ operation, stage, code, status }); } catch { /* Optional diagnostics never affect admission or disclosure. */ }
  return Response.json({ error: code }, { status, headers: { ...securityHeaders, ...(status === 405 ? { Allow: 'GET' } : {}) } });
}
/** Pure read/export gateway. No receipt, counter, ledger, archive or storage mutation exists. */
export function createUsExportHandlers(dependencies: ExportServerDependencies) {
  async function postflight(request: Request, organizationId: string, trusted: ErpReadAdmission, schema?: ExportSchemaAdmission): Promise<void> {
    let ceiling: unknown = schema?.captured, ceilingFailure = false;
    if (schema && dependencies.freshSupportedSchemaVersion) {
      try { ceiling = await dependencies.freshSupportedSchemaVersion(schema.client); } catch { ceilingFailure = true; }
    }
    // Even a malformed/failed capability read cannot skip the final authority
    // check after the private render/hash waits.
    const fresh = admission(await dependencies.authority(request, organizationId));
    confirmErpExpectedUser(request, fresh);
    confirmErpReadAdmission(trusted, fresh);
    if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
    if (schema) {
      if (ceilingFailure) return unavailable();
      requireErpClientSchema(schema.source, schemaVersion(ceiling));
    }
  }
  async function exportResponse(request: Request, organizationId: string, kind: string, id?: string): Promise<Response> {
    let trusted: ErpReadAdmission | undefined;
    let schema: ExportSchemaAdmission | undefined;
    let stage: ExportStage = 'parameters';
    const operation = id === undefined ? 'reports' : 'documents';
    try {
      path(organizationId); const input = parameters(request, kind, id), capability = erpClientSchemaVersion(request);
      if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      stage = 'admission';
      const initial = admission(await dependencies.authority(request, organizationId));
      confirmErpExpectedUser(request, initial);
      if (initial.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (!initial.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402);
      trusted = initial;
      await dependencies.rateLimit(request, trusted.actor, 'read');
      stage = 'configuration';
      const configuration = validateCompanyConfiguration(snapshotPrivateJson(await dependencies.configuration(trusted.actor)));
      if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
      const store = await dependencies.store(capability);
      const captured = schemaVersion(store.supportedSchemaVersion ?? 1);
      requireErpClientSchema(captured, capability);
      stage = 'source';
      const read = await store.read(organizationId);
      if (!read) throw new ErpError('workspace_unavailable', 409);
      const state = validateStoredErp(snapshotPrivateJson(read), organizationId);
      requireErpClientSchema(state.schemaVersion, capability);
      requireErpClientSchema(state.schemaVersion, captured);
      schema = { client: capability, captured, source: state.schemaVersion };
      stage = 'snapshot';
      const sellerInput = input.selector.kind === 'document' && input.selector.documentType === 'invoice' ? null : dependencies.seller ? snapshotPrivateJson(await dependencies.seller(trusted.actor)) : null;
      const seller = sellerInput === null ? null : validatePublicSellerSnapshot(sellerInput, organizationId);
      const snapshot = validateUsExportSnapshot(buildUsExportSnapshot(state, seller, input.selector, input.language));
      if (snapshot.organizationId !== organizationId || snapshot.erpRevision !== state.revision || snapshot.ledgerRevision !== state.ledger.revision) return unavailable();
      stage = 'fonts';
      const fonts = input.format === 'pdf' ? fontData(await dependencies.fonts()) : undefined;
      stage = 'render';
      let output: string | Uint8Array;
      if (input.format === 'json') output = JSON.stringify(snapshot);
      else if (dependencies.render) output = await dependencies.render(snapshot, input.format, fonts);
      else {
        const renderer = await import('./export-renderer');
        output = input.format === 'pdf' ? await renderer.renderUsExportPdf(snapshot, fonts!) : input.format === 'html' ? renderer.renderUsExportHtml(snapshot) : renderer.renderUsExportCsv(snapshot);
      }
      const bytes = responseBytes(output, input.format);
      stage = 'hash';
      const contentHash = await (dependencies.hash ?? sha256Hex)(copyBytes(bytes, MAX_EXPORT_BYTES));
      if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) return unavailable();
      const selectorHash = await sha256Hex(canonicalErpJson(snapshot.selector));
      stage = 'postflight';
      await postflight(request, organizationId, trusted, schema);
      const headers = new Headers(securityHeaders);
      headers.set('Content-Type', { json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8' }[input.format]);
      headers.set('Content-Length', String(bytes.byteLength));
      headers.set('Content-Disposition', `${input.format === 'pdf' || input.format === 'csv' ? 'attachment' : 'inline'}; filename="${filename(snapshot, input.format)}"`);
      headers.set('X-Zentra-Content-SHA256', contentHash);
      headers.set('X-Zentra-Organization-Id', organizationId);
      headers.set('X-Zentra-Currency', 'USD');
      headers.set('X-Zentra-Export-Language', snapshot.language);
      headers.set('X-Zentra-Export-Format', input.format);
      headers.set('X-Zentra-Export-Selector-SHA256', selectorHash);
      headers.set('X-Zentra-Erp-Revision', String(snapshot.erpRevision));
      headers.set('X-Zentra-Ledger-Revision', String(snapshot.ledgerRevision));
      if (snapshot.recordRevision !== null) headers.set('X-Zentra-Record-Revision', String(snapshot.recordRevision));
      if (input.format === 'html') headers.set('Content-Security-Policy', htmlPolicy);
      return new Response(bytes, { headers });
    } catch (error) {
      // Even malformed privileged output must not publish a late response under
      // the prior session. Only stable public errors can cross this boundary.
      if (trusted && stage !== 'postflight') { try { await postflight(request, organizationId, trusted, schema); } catch (rejected) { return failure(rejected, dependencies, operation, 'postflight'); } }
      return failure(error, dependencies, operation, stage);
    }
  }
  return {
    documents: (request: Request, organizationId: string, kind: string, documentId: string) => exportResponse(request, organizationId, kind, documentId),
    reports: (request: Request, organizationId: string, kind: string) => exportResponse(request, organizationId, kind),
  };
}
