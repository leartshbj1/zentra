import { AccountPublicError, requireAccountSameOrigin, roleCanWriteInvoices, sha256Hex } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion, type ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import type { CompanyConfiguration } from './types';
import type { CompanyLanguage } from './types';
import type { UsExportFonts } from './export-renderer';
import { ExportError } from './export-snapshot';
import { buildUsSalesOrderExportSnapshot, renderUsSalesOrderCsv, renderUsSalesOrderHtml, renderUsSalesOrderPdf, type UsSalesOrderExportSnapshot } from './us-sales-order-export';
import {
  validateUsSalesOrderHead, validateUsSalesOrderPage, validateUsSalesOrderReceipt, validateUsSalesOrderRecord, validateUsSalesOrderRequest, validateUsSalesOrderSource,
  type UsSalesOrderReceipt, type UsSalesOrderRequest, type UsSalesOrderStore,
} from './us-sales-order-contract';

/** HTTP admission is independent from both the accounting and Automation
 * engines. History/cancellation remain available when new orders are paused. */
type UsSalesOrderAdmissionDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'store' | 'freshSupportedSchemaVersion'> & {
  newOrdersEnabled(this: void): Promise<boolean> | boolean;
  rateLimit?: ErpServerDependencies['rateLimit'];
  diagnostic?: ErpServerDependencies['diagnostic'];
};
export type UsSalesOrderServerDependencies = UsSalesOrderAdmissionDependencies & {
  salesOrderStore(this: void, capability: ErpSchemaVersion): UsSalesOrderStore | Promise<UsSalesOrderStore>;
  fonts?(this: void): Promise<UsExportFonts>;
  render?(this: void, snapshot: UsSalesOrderExportSnapshot, format: 'html' | 'csv' | 'pdf', fonts?: UsExportFonts): Promise<string | Uint8Array>;
  hash?(this: void, bytes: Uint8Array): Promise<string>;
};
const securityHeaders = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const admissionErrors: Readonly<Record<string, number>> = {
  invalid_request: 422, method_not_allowed: 405, unauthorized: 401, session_changed: 401,
  tenant_mismatch: 403, forbidden: 403, management_entitlement_required: 402,
  sales_order_permission_required: 403, sales_order_upgrade_required: 409,
  feature_unavailable: 404, sales_orders_paused: 409, edition_unavailable: 409,
  configuration_changed: 409, country_configuration_required: 409, client_upgrade_required: 409, rate_limited: 429,
  service_unavailable: 503,
};
function unavailable(): never { throw new ErpError('service_unavailable', 503); }
function invalid(): never { throw new ErpError('invalid_request', 422); }
function schemaFour(value: unknown): void { if (value !== 4) throw new ErpError('sales_order_upgrade_required', 409); }
function admission(input: ErpReadAdmission, request: Request, organizationId: string, write: boolean): ErpReadAdmission {
  const value = snapshotPrivateJson(input) as ErpReadAdmission;
  if (!value || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, 'mode') || !Object.hasOwn(value, 'actor') || !['browser', 'device'].includes(value.mode) || !value.actor || Reflect.ownKeys(value.actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(key => Object.hasOwn(value.actor, key)) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(value.actor.role)) return unavailable();
  if (typeof value.actor.organizationId !== 'string' || typeof value.actor.userId !== 'string' || !value.actor.userId.trim() || value.actor.userId !== value.actor.userId.trim() || value.actor.userId.length > 256 || Array.from(value.actor.userId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || typeof value.actor.managementEntitled !== 'boolean' || typeof value.actor.timestamp !== 'string' || !Number.isFinite(Date.parse(value.actor.timestamp))) return unavailable();
  confirmErpExpectedUser(request, value);
  if ((value.mode === 'device') !== request.headers.has('Authorization')) throw new ErpError('unauthorized', 401);
  if (value.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (!value.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402);
  if (write && !roleCanWriteInvoices(value.actor.role)) throw new ErpError('sales_order_permission_required', 403);
  return value;
}
function scopedConfiguration(input: unknown, organizationId: string): CompanyConfiguration {
  let value: CompanyConfiguration;
  try { value = validateCompanyConfiguration(snapshotPrivateJson(input)); } catch { return unavailable(); }
  if (value.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (value.country !== 'US' || value.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
  return value;
}
function safeError(error: unknown, extra: Readonly<Record<string, number>> = {}) {
  const own = (name: string): unknown => { if (!error || typeof error !== 'object') return undefined; const descriptor = Object.getOwnPropertyDescriptor(error, name); return descriptor && 'value' in descriptor ? descriptor.value : undefined; };
  const code = own('code'), status = own('status');
  if (error instanceof AccountPublicError && typeof status === 'number' && [401, 402, 403, 429].includes(status)) return { code: status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden', status };
  if (error instanceof RequestBodyError && typeof status === 'number' && [400, 413, 415].includes(status)) return { code: 'invalid_request', status };
  if ((error instanceof ErpError || error instanceof ExportError) && typeof code === 'string' && typeof status === 'number' && (admissionErrors[code] === status || extra[code] === status)) return { code, status };
  // Existing Auth/device admission can return a more specific role/seat code.
  // Preserve its denial status without exposing an unreviewed private code.
  if (error instanceof ErpError && typeof status === 'number' && [401, 402, 403].includes(status)) return { code: status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : 'forbidden', status };
  return { code: 'service_unavailable', status: 503 };
}
function parameters(request: Request, organizationId: string, method: 'GET' | 'POST'): URL {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(organizationId) || request.url.length > 4096) return invalid();
  if (request.method !== method) throw new ErpError('method_not_allowed', 405);
  return new URL(request.url);
}

/** All fallible configuration/capability/gate reads precede the final live Auth
 * read, so their errors cannot mask a concurrent revocation. No private I/O is
 * permitted between a successful current() and the following store operation. */
async function createAdmissionScope(dependencies: UsSalesOrderAdmissionDependencies, request: Request, organizationId: string, write: boolean) {
  if (await dependencies.enabled() !== true) throw new ErpError('feature_unavailable', 404);
  const trusted = admission(await dependencies.authority(request, organizationId), request, organizationId, write);
  if (write && trusted.mode === 'browser') requireAccountSameOrigin(request);
  const capability = erpClientSchemaVersion(request); schemaFour(capability);
  let configuration: CompanyConfiguration | undefined, requireNewOrders = false;
  async function current(): Promise<FinancialAuthority> {
    // These are independent reads. Settle all of them before Auth, including
    // failures, to reduce latency without sharing a stale admission across I/O.
    const checks = await Promise.allSettled([
      (async () => { if (configuration && canonicalErpJson(scopedConfiguration(await dependencies.configuration(trusted.actor), organizationId)) !== canonicalErpJson(configuration)) throw new ErpError('configuration_changed', 409); })(),
      (async () => schemaFour(dependencies.freshSupportedSchemaVersion ? await dependencies.freshSupportedSchemaVersion(capability) : (await dependencies.store(capability)).supportedSchemaVersion))(),
      (async () => dependencies.enabled())(),
      (async () => { if (requireNewOrders && await dependencies.newOrdersEnabled() !== true) throw new ErpError('sales_orders_paused', 409); })(),
    ]);
    const pending = checks.find(result => result.status === 'rejected'), available = checks[2].status === 'fulfilled' ? checks[2].value : undefined;
    const fresh = admission(await dependencies.authority(request, organizationId), request, organizationId, write);
    confirmErpReadAdmission(trusted, fresh);
    if (available === false) throw new ErpError('feature_unavailable', 404);
    if (pending?.status === 'rejected') throw pending.reason;
    if (available !== true) return unavailable();
    return fresh.actor;
  }
  async function checked<T>(operation: (actor: FinancialAuthority) => T | Promise<T>, capture?: (value: T) => T): Promise<T> {
    const actor = await current(), read = await operation(actor), value = capture ? capture(read) : read;
    await current(); return value;
  }
  return { current, checked, capability: capability as ErpSchemaVersion, configuration: () => configuration!,
    initialize: async () => {
      await checked(actor => dependencies.rateLimit?.(request, actor, write ? 'write' : 'read'));
      configuration = scopedConfiguration(await checked(actor => dependencies.configuration(actor), value => snapshotPrivateJson(value) as CompanyConfiguration), organizationId);
      await current();
    },
    requireNewOrders: () => { requireNewOrders = true; },
    authority: trusted,
  };
}

const salesOrderErrors: Readonly<Record<string, number>> = {
  invalid_sales_order_request: 422, invalid_sales_order_record: 503,
  sales_order_not_found: 404, sales_order_revision_conflict: 409,
  sales_order_head_conflict: 409, sales_order_erp_revision_conflict: 409,
  sales_order_idempotency_conflict: 409, sales_order_source_conflict: 409,
  sales_order_already_exists: 409, sales_order_already_confirmed: 409,
  sales_order_cancelled: 409, sales_order_invoiced: 409,
  sales_order_source_required: 422, sales_order_confirmation_required: 409,
  sales_order_invalid_transition: 409, sales_order_clock_reversed: 409,
  sales_order_source_too_large: 422, estimate_acceptance_required: 409,
  sales_order_source_unavailable: 409, sales_order_source_locked: 409,
  sales_order_state_conflict: 409, sales_order_already_invoiced: 409,
  sales_order_sequence_exhausted: 409,
  seller_configuration_required: 409, workspace_unavailable: 409,
  invalid_export_snapshot: 503, invalid_export_font: 503, unsupported_export_glyph: 422,
  export_too_large: 413,
};
function orderId(input: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)) return invalid();
  return input;
}
function beforeSequence(url: URL): number | null {
  for (const key of url.searchParams.keys()) if (key !== 'beforeSequence' || url.searchParams.getAll(key).length !== 1) return invalid();
  const value = url.searchParams.get('beforeSequence');
  if (value === null) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= Number.MAX_SAFE_INTEGER - 1) return invalid();
  return Number(value);
}
function exactReceipt(value: unknown, request: UsSalesOrderRequest, organizationId: string, actorId: string, commandHash: string, replay: boolean): UsSalesOrderReceipt {
  const receipt = validateUsSalesOrderReceipt(value, organizationId);
  if (receipt.actorId !== actorId || receipt.commandHash !== commandHash) throw new ErpError(replay ? 'sales_order_idempotency_conflict' : 'invalid_sales_order_record', replay ? 409 : 503);
  if (receipt.idempotencyKey !== request.idempotencyKey || receipt.orderId !== request.orderId || receipt.action !== request.command.type || receipt.erpRevision !== request.expectedErpRevision || receipt.headRevision !== request.expectedHeadRevision + 1 || receipt.revision !== (request.expectedOrderRevision ?? 0) + 1) throw new ErpError('invalid_sales_order_record', 503);
  return receipt;
}
function boundedJson(value: unknown): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > 2_621_440) throw new ErpError('invalid_sales_order_record', 503);
  return new Response(body, { headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
}
const exportLimit = 12 * 1024 * 1024;
type SalesOrderExportFormat = 'json' | 'html' | 'csv' | 'pdf';
function copyBytes(input: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array) || Object.getPrototypeOf(input) !== Uint8Array.prototype) return unavailable();
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const length = Object.getOwnPropertyDescriptor(prototype, 'length')!.get!.call(input) as number;
  const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!.call(input) as unknown;
  if (!Number.isSafeInteger(length) || length < 1 || !buffer || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return unavailable();
  if (length > maximum) throw new ErpError('export_too_large', 413);
  const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, input); return bytes;
}
function capturedFonts(input: UsExportFonts): UsExportFonts {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2) return unavailable();
  const font = (key: 'regular' | 'bold') => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return unavailable();
    return copyBytes(descriptor.value, 2 * 1024 * 1024);
  };
  return { regular: font('regular'), bold: font('bold') };
}
function exportBytes(input: unknown, format: string): Uint8Array<ArrayBuffer> {
  if (format === 'pdf') {
    const bytes = copyBytes(input, exportLimit);
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' || !new TextDecoder().decode(bytes.subarray(-2048)).includes('%%EOF')) return unavailable();
    return bytes;
  }
  if (typeof input !== 'string') return unavailable();
  if (input.length > exportLimit) throw new ErpError('export_too_large', 413);
  const bytes = new TextEncoder().encode(input);
  if (bytes.byteLength > exportLimit) throw new ErpError('export_too_large', 413);
  return bytes;
}

/** References/CAS only cross the write boundary. The private SQL store reads
 * the real accepted estimate, seller and ERP head; the browser supplies none
 * of their snapshots, monetary values, authors or numbering. */
export function createUsSalesOrderHandlers(dependencies: UsSalesOrderServerDependencies) {
  async function run(request: Request, organizationId: string, operation: 'list' | 'detail' | 'write' | 'export', id?: string): Promise<Response> {
    let scope: Awaited<ReturnType<typeof createAdmissionScope>> | undefined, writeAttempted = false;
    const access = operation === 'write' ? 'write' : 'read';
    try {
      const url = parameters(request, organizationId, operation === 'write' ? 'POST' : 'GET');
      const headOnly = operation === 'list' && url.searchParams.has('head');
      if (headOnly && (url.searchParams.size !== 1 || url.searchParams.get('head') !== '1')) return invalid();
      const sourceOnly = operation === 'list' && url.searchParams.has('estimateId'), estimateId = sourceOnly ? url.searchParams.get('estimateId') : null;
      if (sourceOnly && (url.searchParams.size !== 1 || estimateId === null || !estimateId.trim() || estimateId !== estimateId.trim() || estimateId.length > 160 || Array.from(estimateId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return invalid();
      const cursor = operation === 'list' && !headOnly && !sourceOnly ? beforeSequence(url) : null;
      if (operation !== 'list' && operation !== 'export' && url.search) return invalid();
      const selected = operation === 'detail' || operation === 'export' ? orderId(id ?? '') : null;
      let exportFormat: SalesOrderExportFormat = 'json', exportLanguage: CompanyLanguage | undefined, exportRevision: number | undefined;
      if (operation === 'export') {
        for (const key of url.searchParams.keys()) if (!['format', 'language', 'revision'].includes(key) || url.searchParams.getAll(key).length !== 1) return invalid();
        const format = url.searchParams.get('format') ?? 'json', language = url.searchParams.get('language'), revision = url.searchParams.get('revision');
        if (!['json', 'html', 'csv', 'pdf'].includes(format) || language !== null && !['fr', 'de', 'it', 'en'].includes(language)) return invalid();
        if (revision === null || !/^[1-9][0-9]{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) >= Number.MAX_SAFE_INTEGER - 1) return invalid();
        exportRevision = Number(revision); exportFormat = format as SalesOrderExportFormat; exportLanguage = language === null ? undefined : language as CompanyLanguage;
      }
      scope = await createAdmissionScope(dependencies, request, organizationId, operation === 'write');
      await scope.initialize();
      const store = await scope.checked(() => dependencies.salesOrderStore(scope!.capability));
      if (operation === 'list') {
        if (headOnly) return boundedJson(await scope.checked(actor => store.head(actor), value => validateUsSalesOrderHead(value, organizationId)));
        if (sourceOnly) {
          const source = await scope.checked(actor => store.source(actor, estimateId!), value => validateUsSalesOrderSource(value, organizationId));
          if (source.estimateId !== estimateId) throw new ErpError('invalid_sales_order_record', 503);
          return boundedJson(source);
        }
        const page = await scope.checked(actor => store.list(actor, cursor), value => validateUsSalesOrderPage(value, organizationId));
        if (cursor !== null && page.orders.some(row => row.sequence >= cursor)) throw new ErpError('invalid_sales_order_record', 503);
        return boundedJson(page);
      }
      if (operation === 'detail' || operation === 'export') {
        const record = await scope.checked(actor => store.read(actor, selected!), value => value === null ? null : validateUsSalesOrderRecord(value, organizationId));
        if (record === null) throw new ErpError('sales_order_not_found', 404);
        if (record.order.id !== selected) throw new ErpError('invalid_sales_order_record', 503);
        if (operation === 'detail') return boundedJson({ schemaVersion: 1, organizationId, record });
        if (record.order.revision !== exportRevision) throw new ErpError('sales_order_revision_conflict', 409);
        const snapshot = buildUsSalesOrderExportSnapshot(record, exportLanguage ?? scope.configuration().language), format = exportFormat;
        const fonts = format === 'pdf' ? await scope.checked(() => dependencies.fonts ? dependencies.fonts() : Promise.reject(new ErpError('service_unavailable', 503)), capturedFonts) : undefined;
        const output = format === 'json' ? canonicalErpJson(snapshot) : await scope.checked(() => dependencies.render ? dependencies.render(snapshot, format, fonts) : format === 'pdf' ? renderUsSalesOrderPdf(snapshot, fonts!) : format === 'html' ? renderUsSalesOrderHtml(snapshot) : renderUsSalesOrderCsv(snapshot), value => typeof value === 'string' ? value : copyBytes(value, exportLimit));
        const bytes = exportBytes(output, format), hash = await scope.checked(() => (dependencies.hash ?? sha256Hex)(copyBytes(bytes, exportLimit)));
        if (!/^[a-f0-9]{64}$/.test(hash)) return unavailable();
        const latest = await scope.checked(actor => store.read(actor, selected!), value => value === null ? null : validateUsSalesOrderRecord(value, organizationId));
        if (canonicalErpJson(latest) !== canonicalErpJson(record)) throw new ErpError('sales_order_revision_conflict', 409);
        const headers = new Headers(securityHeaders);
        headers.set('Content-Type', { json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8', csv: 'text/csv; charset=utf-8', pdf: 'application/pdf' }[exportFormat]);
        headers.set('Content-Length', String(bytes.byteLength));
        headers.set('Content-Disposition', `${exportFormat === 'pdf' || exportFormat === 'csv' ? 'attachment' : 'inline'}; filename="sales-order-${record.order.number}-r${record.order.revision}-${snapshot.language}.${exportFormat}"`);
        headers.set('X-Zentra-Content-SHA256', hash); headers.set('X-Zentra-Organization-Id', organizationId);
        headers.set('X-Zentra-Currency', 'USD'); headers.set('X-Zentra-Export-Language', snapshot.language);
        headers.set('X-Zentra-Export-Format', exportFormat); headers.set('X-Zentra-Record-Revision', String(record.order.revision));
        headers.set('X-Zentra-Record-Id', record.order.id);
        headers.set('X-Zentra-Source-Erp-Revision', String(record.order.sourceErpRevision));
        headers.set('X-Zentra-Source-Estimate-Revision', String(record.order.sourceEstimate.revision));
        if (exportFormat === 'html') headers.set('Content-Security-Policy', "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'");
        return new Response(bytes, { headers });
      }
      const input = validateUsSalesOrderRequest(await scope.checked(() => readJsonObjectWithinLimit(request, 8192), value => snapshotPrivateJson(value) as Record<string, unknown>), organizationId);
      const hash = await scope.checked(actor => sha256Hex(canonicalErpJson([organizationId, actor.userId, input])));
      const previous = await scope.checked(actor => store.receipt(actor, input.idempotencyKey), value => value === null ? null : validateUsSalesOrderReceipt(value, organizationId));
      if (previous !== null) {
        const receipt = exactReceipt(previous, input, organizationId, scope.authority.actor.userId, hash, true);
        return boundedJson({ receipt, replayed: true });
      }
      if (input.command.type !== 'cancel') scope.requireNewOrders();
      const result = await scope.checked(actor => { writeAttempted = true; return store.execute(actor, input, hash); }, value => snapshotPrivateJson(value) as typeof value);
      if (!result || Reflect.ownKeys(result).length !== 2 || !Object.hasOwn(result, 'receipt') || !Object.hasOwn(result, 'replayed') || typeof result.replayed !== 'boolean') throw new ErpError('invalid_sales_order_record', 503);
      const receipt = exactReceipt(result.receipt, input, organizationId, scope.authority.actor.userId, hash, result.replayed);
      return boundedJson({ receipt, replayed: result.replayed });
    } catch (error) {
      let failure = safeError(error, salesOrderErrors);
      if (scope) {
        try { await scope.current(); } catch (late) {
          const current = safeError(late, salesOrderErrors);
          // A loss of current rights takes precedence over stale data/errors.
          if ([401, 402, 403, 404].includes(current.status)) failure = current;
        }
      }
      // Admission/flag changes observed after dispatch do not prove that SQL
      // rolled back. Preserve the caller's exact pending envelope for replay.
      // Current Auth losses above still take precedence and purge private UI.
      let diagnosticCode = failure.code;
      if (writeAttempted && ['configuration_changed', 'sales_orders_paused', 'client_upgrade_required', 'sales_order_upgrade_required', 'feature_unavailable', 'edition_unavailable', 'country_configuration_required', 'invalid_request'].includes(failure.code)) { diagnosticCode = 'post_dispatch_' + failure.code; failure = { code: 'service_unavailable', status: 503 }; }
      try { dependencies.diagnostic?.({ operation: access, ...failure, code: diagnosticCode }); } catch { /* Codes only; diagnostics cannot alter the result. */ }
      return Response.json({ error: failure.code }, { status: failure.status, headers: { ...securityHeaders, ...(failure.status === 405 ? { Allow: operation === 'write' ? 'POST' : 'GET' } : {}) } });
    }
  }
  return {
    GET: (request: Request, organizationId: string) => run(request, organizationId, 'list'),
    DETAIL: (request: Request, organizationId: string, id: string) => run(request, organizationId, 'detail', id),
    EXPORT: (request: Request, organizationId: string, id: string) => run(request, organizationId, 'export', id),
    POST: (request: Request, organizationId: string) => run(request, organizationId, 'write'),
  };
}
