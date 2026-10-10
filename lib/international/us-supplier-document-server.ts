import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { DecisionFailure } from '../automation/types';
import { readBytesBodyWithinLimit, readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion, type ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import type { CompanyConfiguration } from './types';
import { creationUuid } from './workspace-creation';
import type { UsSupplierServerDependencies } from './us-supplier-server';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { readUsSupplierOriginal, retainUsSupplierOriginal, type UsSupplierDocumentArchive } from './us-supplier-document-archive';
import { supplierDocumentMedia, supplierDocumentText } from './us-supplier-document-bytes';
import { documentSummary, US_SUPPLIER_DOCUMENT_MAX_BYTES, validateUsSupplierDocumentDescriptor, validateUsSupplierDocumentRecord, type UsSupplierDocumentRecord, type UsSupplierDocumentStore } from './us-supplier-document-contract';

export type UsSupplierDocumentServerDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'store' | 'freshSupportedSchemaVersion' | 'rateLimit' | 'diagnostic'> & {
  documentStore(capability: ErpSchemaVersion): UsSupplierDocumentStore | Promise<UsSupplierDocumentStore>;
  archive(): UsSupplierDocumentArchive | Promise<UsSupplierDocumentArchive>;
  automationAccess: UsSupplierServerDependencies['automationAccess'];
  prepareAnalysis: NonNullable<UsSupplierServerDependencies['prepareAnalysis']>;
  extractText?: typeof supplierDocumentText;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const errors: Readonly<Record<string, number>> = {
  invalid_request: 422, invalid_supplier_document: 422, invalid_supplier_document_record: 503,
  supplier_document_conflict: 409, supplier_document_not_found: 404, supplier_document_limit_reached: 409,
  supplier_document_archive_unavailable: 503, supplier_source_unreadable: 422,
  supplier_upgrade_required: 409, supplier_permission_required: 403, supplier_source_conflict: 409,
  supplier_analysis_unavailable: 503, supplier_analysis_failed: 503, invalid_supplier_record: 503,
  automation_revision_conflict: 409, automation_idempotency_conflict: 409, automation_consent_required: 409,
  automation_busy: 409, automation_dispatch_uncertain: 409, automation_quota_exceeded: 409,
  automation_grant_expired: 409, automation_limit_reached: 409, automation_permission_required: 403,
  automation_upgrade_required: 409, invalid_automation_request: 422, invalid_automation_record: 503,
  tenant_mismatch: 403, session_changed: 401, unauthorized: 401, forbidden: 403,
  management_entitlement_required: 402, automation_entitlement_required: 402,
  financial_permission_required: 403, edition_unavailable: 409, configuration_changed: 409,
  client_upgrade_required: 409, feature_unavailable: 404, rate_limited: 429, service_unavailable: 503,
};
function financial(actor: FinancialAuthority): void {
  if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(actor.role)) throw new ErpError('financial_permission_required', 403);
}
function ceiling(value: unknown): void { if (value !== 4) throw new ErpError('supplier_upgrade_required', 409); }
function filename(request: Request): string {
  try {
    const value = decodeURIComponent(request.headers.get('X-Zentra-File-Name') ?? '');
    const unsafe = Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '/' || character === '\\');
    if (!value.trim() || value.length > 160 || unsafe || ['.', '..'].includes(value)) throw new Error('name');
    return value;
  } catch { throw new ErpError('invalid_supplier_document'); }
}
function sameBytes(a: UsSupplierDocumentRecord, b: UsSupplierDocumentRecord): boolean {
  return a.id === b.id && a.organizationId === b.organizationId && a.contentSha256 === b.contentSha256 && a.sizeBytes === b.sizeBytes && a.mediaType === b.mediaType && a.fileName === b.fileName && a.textSha256 === b.textSha256 && a.documentText === b.documentText && a.createdBy === b.createdBy && a.createdAt === b.createdAt;
}

/** Private originals are Gestion records. Reading/uploading never consumes an
 * analysis, grants Automation, approves a bill or edits a posted journal. */
export function createUsSupplierDocumentHandlers(dependencies: UsSupplierDocumentServerDependencies) {
  function failure(error: unknown, operation: 'read' | 'write'): Response {
    let code = 'service_unavailable', status = 503;
    if (error instanceof ErpError && errors[error.code] !== undefined) { code = error.code; status = errors[code]; }
    else if (error instanceof AccountPublicError && [401, 402, 403, 429].includes(error.status)) {
      status = error.status; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden';
    } else if (error instanceof RequestBodyError) { code = 'invalid_supplier_document'; status = error.status; }
    else if (error instanceof DecisionFailure) { code = 'supplier_analysis_failed'; }
    try { dependencies.diagnostic?.({ operation, code, status }); } catch { /* No file name, text, key or provider secret in logs. */ }
    return json({ error: code }, status);
  }
  async function handle(request: Request, organizationId: string, action: 'list' | 'upload' | 'content' | 'analyze', id?: string): Promise<Response> {
    const operation = action === 'list' || action === 'content' ? 'read' : 'write';
    let trusted: ErpReadAdmission | undefined, configuration: CompanyConfiguration | undefined, capability: ErpSchemaVersion | undefined;
    async function revalidate(): Promise<FinancialAuthority> {
      if (!trusted) throw new ErpError('unauthorized', 401);
      let pending: unknown;
      try {
        const current = await dependencies.configuration(trusted.actor);
        if (configuration && canonicalErpJson(configuration) !== canonicalErpJson(current)) throw new ErpError('configuration_changed', 409);
        if (capability !== undefined) ceiling(dependencies.freshSupportedSchemaVersion ? await dependencies.freshSupportedSchemaVersion(capability) : (await dependencies.store(capability)).supportedSchemaVersion);
      } catch (error) { pending = error; }
      let available = false;
      try { available = await dependencies.enabled(); } catch (error) { pending ??= error; }
      const fresh = await dependencies.authority(request, organizationId);
      confirmErpExpectedUser(request, fresh); confirmErpReadAdmission(trusted, fresh); financial(fresh.actor);
      if (action === 'analyze') await dependencies.automationAccess(fresh.actor);
      if (!available || !await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      if (pending !== undefined) throw pending;
      return Object.freeze({ ...fresh.actor });
    }
    function record(input: unknown): UsSupplierDocumentRecord {
      try { return validateUsSupplierDocumentRecord(input, organizationId); } catch { throw new ErpError('invalid_supplier_document_record', 503); }
    }
    try {
      try { creationUuid(organizationId); if (id !== undefined) creationUuid(id); } catch { throw new ErpError('invalid_request'); }
      if (new URL(request.url).search) throw new ErpError('invalid_request');
      if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      const admission = await dependencies.authority(request, organizationId);
      if (!['browser', 'device'].includes(admission.mode)) throw new ErpError('unauthorized', 401);
      confirmErpExpectedUser(request, admission);
      if (admission.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      financial(admission.actor);
      trusted = { mode: admission.mode, actor: Object.freeze({ ...admission.actor }) };
      if (operation === 'write' && trusted.mode === 'browser') requireAccountSameOrigin(request);
      if (action === 'analyze') await dependencies.automationAccess(trusted.actor);
      await dependencies.rateLimit?.(request, trusted.actor, operation);
      configuration = snapshotPrivateJson(await dependencies.configuration(trusted.actor)) as CompanyConfiguration;
      if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
      capability = erpClientSchemaVersion(request); ceiling(capability);
      const erpStore = await dependencies.store(capability); ceiling(erpStore.supportedSchemaVersion);
      const state = await erpStore.read(organizationId);
      if (!state || state.schemaVersion !== 4) throw new ErpError('supplier_upgrade_required', 409);
      if (state.configuration.organizationId !== organizationId || state.ledger.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (canonicalErpJson(state.configuration) !== canonicalErpJson(configuration) || state.ledger.currency !== 'USD') throw new ErpError('configuration_changed', 409);
      const store = await dependencies.documentStore(capability), actor = await revalidate();
      if (action === 'list') {
        const result = await store.list(actor);
        if (!Array.isArray(result) || result.length > 50) throw new ErpError('invalid_supplier_document_record', 503);
        const documents = result.map(value => documentSummary(record(value)));
        if (new Set(documents.map(value => value.id)).size !== documents.length || new Set(documents.map(value => value.contentSha256)).size !== documents.length) throw new ErpError('invalid_supplier_document_record', 503);
        await revalidate(); return json({ documents });
      }
      if (action === 'upload') {
        const fileName = filename(request), bytes = await readBytesBodyWithinLimit(request, US_SUPPLIER_DOCUMENT_MAX_BYTES);
        const mediaType = supplierDocumentMedia(bytes, request.headers.get('Content-Type'));
        const contentSha256 = await sha256Hex(bytes);
        const existing = await store.read(await revalidate(), id!);
        if (existing) {
          const saved = record(existing);
          if (saved.id !== id || saved.contentSha256 !== contentSha256 || saved.sizeBytes !== bytes.byteLength || saved.mediaType !== mediaType || saved.fileName !== fileName) throw new ErpError('supplier_document_conflict', 409);
        }
        // Exact retries retain the first extraction, even after a parser upgrade.
        const documentText = existing ? record(existing).documentText : await (dependencies.extractText ?? supplierDocumentText)(bytes.slice(), mediaType);
        const textSha256 = documentText === null ? null : await sha256Hex(documentText);
        const fresh = await revalidate();
        const descriptor = validateUsSupplierDocumentDescriptor({ schemaVersion: 1, organizationId, id, contentSha256, sizeBytes: bytes.byteLength, mediaType, fileName, documentText, textSha256, createdBy: fresh.userId, createdAt: fresh.timestamp }, organizationId);
        const reserved = record(await store.reserve(fresh, descriptor));
        if (reserved.contentSha256 !== contentSha256 || reserved.sizeBytes !== bytes.byteLength || reserved.mediaType !== mediaType) throw new ErpError('invalid_supplier_document_record', 503);
        await revalidate();
        const archive = await dependencies.archive();
        await retainUsSupplierOriginal(archive, reserved, bytes, revalidate);
        const completed = record(await store.complete(await revalidate(), reserved.id, contentSha256, bytes.byteLength));
        if (!sameBytes(reserved, completed) || !completed.stored || completed.proposalId !== reserved.proposalId) throw new ErpError('invalid_supplier_document_record', 503);
        await revalidate(); return json({ document: documentSummary(completed), replayed: Boolean(existing) || reserved.id !== id || reserved.stored });
      }
      const current = await store.read(actor, id!);
      if (!current) throw new ErpError('supplier_document_not_found', 404);
      const document = record(current);
      if (document.id !== id) throw new ErpError('invalid_supplier_document_record', 503);
      if (!document.stored) throw new ErpError('supplier_document_archive_unavailable', 503);
      const archive = await dependencies.archive();
      const bytes = await readUsSupplierOriginal(archive, document, revalidate);
      if (action === 'content') {
        await revalidate();
        return new Response(Uint8Array.from(bytes), { headers: { ...headers, 'Content-Type': document.mediaType, 'Content-Length': String(bytes.byteLength), 'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(document.fileName).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`, 'Content-Security-Policy': "sandbox; default-src 'none'" } });
      }
      const input = await readJsonObjectWithinLimit(request, 1024);
      if (Object.keys(input).sort().join(',') !== 'action,consent,schemaVersion' || input.schemaVersion !== 1 || input.action !== 'analyze' || input.consent !== true) throw new ErpError('invalid_supplier_document');
      if (document.documentText === null || document.textSha256 === null) throw new ErpError('supplier_source_unreadable', 422);
      // An original hash is never substituted for the existing text-analysis
      // hash. Original provenance remains a distinct private immutable link.
      const result = await dependencies.prepareAnalysis({ actor: await revalidate(), revalidate, source: { kind: 'document_import', sha256: document.textSha256, fileName: document.fileName, mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: document.createdAt, documentText: document.documentText } });
      let proposal;
      try { proposal = validateUsSupplierProposal(result.proposal, organizationId); } catch { throw new ErpError('invalid_supplier_record', 503); }
      if (typeof result.replayed !== 'boolean' || proposal.source.mediaType !== 'text/plain' || proposal.source.documentText !== document.documentText || proposal.source.sha256 !== document.textSha256) throw new ErpError('invalid_supplier_record', 503);
      const linked = record(await store.link(await revalidate(), document.id, proposal));
      if (!sameBytes(document, linked) || !linked.stored || linked.proposalId !== proposal.id) throw new ErpError('invalid_supplier_document_record', 503);
      await revalidate(); return json({ document: documentSummary(linked), proposal, replayed: result.replayed });
    } catch (error) {
      if (trusted) { try { await revalidate(); } catch (freshError) { return failure(freshError, operation); } }
      return failure(error, operation);
    }
  }
  return {
    GET: (request: Request, organizationId: string) => handle(request, organizationId, 'list'),
    PUT: (request: Request, organizationId: string, id: string) => handle(request, organizationId, 'upload', id),
    CONTENT: (request: Request, organizationId: string, id: string) => handle(request, organizationId, 'content', id),
    ANALYZE: (request: Request, organizationId: string, id: string) => handle(request, organizationId, 'analyze', id),
  };
}
