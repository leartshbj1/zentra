import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { decryptSecret } from '../support/crypto';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import type { ErpServerDependencies } from './runtime-server';
import type { CompanyConfiguration } from './types';
import { creationUuid } from './workspace-creation';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsMailboxError, sameUsMailboxContext, usMailboxEncryptionContext, validateUsMailboxContext, validateUsMailboxState, type UsMailboxConnection, type UsMailboxContext, type UsMailboxStore } from './us-support-mailbox-contract';
import { UsMailboxImportError, hashUsMailboxImportRequest, hashUsMailboxImportSource, validateUsMailboxImportRequest, validateUsMailboxImportResult, validateUsMailboxImportSource, type UsMailboxImportRequest, type UsMailboxImportResult, type UsMailboxImportSource, type UsMailboxImportStore } from './us-support-mailbox-import-contract';
import { readUsSupplierOriginal, retainUsSupplierOriginal, type UsSupplierDocumentArchive } from './us-supplier-document-archive';
import { supplierDocumentMedia, supplierDocumentText } from './us-supplier-document-bytes';
import { documentSummary, validateUsSupplierDocumentDescriptor, validateUsSupplierDocumentRecord, type UsSupplierDocumentRecord, type UsSupplierDocumentStore } from './us-supplier-document-contract';

export interface UsMailboxImportDependencies {
  enabled(this: void): Promise<boolean>; now(this: void): number;
  member(this: void, request: Request, org: string): Promise<UsMailboxContext>;
  configuration: ErpServerDependencies['configuration']; store: ErpServerDependencies['store'];
  freshSupportedSchemaVersion: NonNullable<ErpServerDependencies['freshSupportedSchemaVersion']>;
  mailboxStore(this: void): Promise<UsMailboxStore>; importStore(this: void): Promise<UsMailboxImportStore>;
  documentStore(this: void): Promise<UsSupplierDocumentStore>; archive(this: void): Promise<UsSupplierDocumentArchive>;
  findDocument(this: void, actor: FinancialAuthority, hash: string): Promise<UsSupplierDocumentRecord | null>;
  encryptionKey(this: void): Promise<string>;
  attachment(this: void, connection: UsMailboxConnection, token: string, request: UsMailboxImportRequest, check: () => Promise<unknown>): Promise<{ source: UsMailboxImportSource; bytes: Uint8Array }>;
  extractText?: typeof supplierDocumentText;
  newId?(this: void): string; rateLimit?(this: void, request: Request, key: string): Promise<void>;
  diagnostic?(this: void, event: Readonly<{ operation: 'import'; code: string; status: number }>): void;
}
const headers = { 'Cache-Control':'no-store, max-age=0', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
const codes: Readonly<Record<string, number>> = {
  unauthorized:401,session_changed:401,subscription_required:402,management_entitlement_required:402,
  forbidden:403,email_confirmation_required:403,support_management_required:403,supplier_permission_required:403,tenant_mismatch:403,feature_unavailable:404,
  invalid_mailbox_import_request:422,invalid_mailbox_request:422,invalid_supplier_document:422,invalid_request:422,mailbox_credentials_rejected:422,mailbox_attachment_unavailable:422,
  configuration_changed:409,mailbox_revision_conflict:409,mailbox_connection_required:409,support_workspace_required:409,
  mailbox_import_idempotency_conflict:409,mailbox_source_conflict:409,mailbox_import_limit_reached:409,supplier_document_conflict:409,
  mailbox_import_source_conflict:409,mailbox_import_connection_changed:409,mailbox_import_capacity_exceeded:409,mailbox_import_not_reserved:409,client_schema_required:409,
  supplier_upgrade_required:409,client_upgrade_required:409,edition_unavailable:409,country_configuration_required:409,workspace_unavailable:409,
  supplier_document_limit_reached:409,rate_limited:429,service_unavailable:503,mailbox_provider_unavailable:503,
  invalid_mailbox_context:503,invalid_mailbox_record:503,invalid_support_context:503,invalid_support_record:503,
  invalid_mailbox_import_record:503,invalid_supplier_document_record:503,supplier_document_archive_unavailable:503,
};
function failure(error: unknown) {
  if ((error instanceof UsMailboxError || error instanceof UsMailboxImportError || error instanceof UsSupportWorkspaceError || error instanceof ErpError) && codes[error.code] === error.status) return { code:error.code, status:error.status };
  if (error instanceof AccountPublicError && [401,402,403,429].includes(error.status)) return { code:error.status === 401 ? 'unauthorized' : error.status === 402 ? 'subscription_required' : error.status === 429 ? 'rate_limited' : 'forbidden', status:error.status };
  if (error instanceof RequestBodyError) return { code:'invalid_mailbox_import_request', status:422 };
  return { code:'service_unavailable', status:503 };
}
function denied(code: string, status = 503): never { throw new UsMailboxImportError(code,status); }
function role(context: UsMailboxContext) { if (!['owner','admin'].includes(context.authority.role)) denied('support_management_required',403); }
function expected(request: Request, context: UsMailboxContext) {
  const user = request.headers.get('X-Zentra-Expected-User');
  if (user !== null && user !== context.authority.userId) denied('session_changed',401);
  if ((context.authority.credential.kind === 'device') !== request.headers.has('Authorization')) denied('unauthorized',401);
  if (erpClientSchemaVersion(request) !== 4 || context.authority.credential.kind === 'device' && context.authority.credential.supportedSchemaVersion !== 4) denied('client_upgrade_required',409);
}
function material(record: UsSupplierDocumentRecord, source: UsMailboxImportSource) {
  if (record.contentSha256 !== source.contentSha256 || record.sizeBytes !== source.sizeBytes || record.mediaType !== source.mediaType) denied('invalid_mailbox_import_record');
}
/** A recoverable saga, not a cross-store transaction. No analysis, provider
 * acknowledgement, supplier creation, posting or outbound mail is dispatched. */
export function createUsMailboxImportHandler(dependencies: UsMailboxImportDependencies) {
  return async (request: Request, org: string): Promise<Response> => {
    let admitted: UsMailboxContext | undefined, configuration: CompanyConfiguration | undefined, attempted = false;
    const now = () => { const n = dependencies.now(); if (!Number.isSafeInteger(n) || n <= 0) return denied('service_unavailable'); return n; };
    const actor = (context: UsMailboxContext): FinancialAuthority => Object.freeze({ organizationId:org, userId:context.authority.userId, role:context.authority.role, managementEntitled:true, timestamp:new Date(now()*1000).toISOString() });
    async function current(): Promise<UsMailboxContext> {
      if (!admitted) return denied('unauthorized',401);
      // Read potentially failing dependencies before fresh Auth, so a logout or
      // revoked entitlement wins even when a storage call also fails.
      let pending: unknown, available = false;
      try {
        if (configuration) {
          const latest = snapshotPrivateJson(await dependencies.configuration(actor(admitted)));
          if (canonicalErpJson(latest) !== canonicalErpJson(configuration)) denied('configuration_changed',409);
        }
        if (await dependencies.freshSupportedSchemaVersion(4) !== 4) denied('supplier_upgrade_required',409);
      } catch (error) { pending = error; }
      try { available = await dependencies.enabled(); } catch (error) { pending ??= error; }
      const fresh = validateUsMailboxContext(await dependencies.member(request,org),org,now());
      expected(request,fresh); sameUsMailboxContext(admitted,fresh); role(fresh);
      if (!available || !await dependencies.enabled()) denied('feature_unavailable',404);
      if (pending !== undefined) throw pending;
      return fresh;
    }
    try {
      try { creationUuid(org); } catch { denied('invalid_mailbox_import_request',422); }
      if (request.method !== 'POST' || new URL(request.url).search) denied('invalid_mailbox_import_request',422);
      if (!await dependencies.enabled()) denied('feature_unavailable',404);
      admitted = validateUsMailboxContext(await dependencies.member(request,org),org,now()); expected(request,admitted); role(admitted);
      if (admitted.authority.credential.kind === 'browser') requireAccountSameOrigin(request);
      await dependencies.rateLimit?.(request,org+':'+admitted.authority.userId);
      const input = validateUsMailboxImportRequest(await readJsonObjectWithinLimit(request,8192));
      const requestHash = await hashUsMailboxImportRequest(org,admitted.authority.userId,input);
      configuration = snapshotPrivateJson(await dependencies.configuration(actor(admitted))) as CompanyConfiguration;
      if (configuration.organizationId !== org) denied('tenant_mismatch',403);
      if (configuration.country !== 'US' || configuration.currency !== 'USD') denied('edition_unavailable',409);
      await current();
      const erp = await dependencies.store(4); await current();
      if (erp.supportedSchemaVersion !== 4) denied('supplier_upgrade_required',409);
      const book = await erp.read(org); await current();
      if (!book || book.schemaVersion !== 4) denied('supplier_upgrade_required',409);
      if (book.configuration.organizationId !== org || book.ledger.organizationId !== org) denied('tenant_mismatch',403);
      if (book.ledger.currency !== 'USD' || canonicalErpJson(book.configuration) !== canonicalErpJson(configuration)) denied('configuration_changed',409);
      const imports = await dependencies.importStore(); await current();
      const documents = await dependencies.documentStore(); await current();
      const archive = await dependencies.archive(); await current();
      const validate = async (value: unknown): Promise<UsMailboxImportResult> => {
        const result = validateUsMailboxImportResult(value,org), r = result.reservation;
        if (r.workspaceId !== admitted!.workspaceId || r.actorUserId !== admitted!.authority.userId || r.requestId !== input.requestId || r.requestHash !== requestHash
          || canonicalErpJson(r.request) !== canonicalErpJson(input) || r.claim.sourceHash !== await hashUsMailboxImportSource(org,r.workspaceId,r.claim.source)) denied('invalid_mailbox_import_record');
        return result;
      };
      let result = await imports.find(await current(),input.requestId,requestHash); await current();
      const wasExisting = result !== null;
      if (result) result = await validate(result);
      const record = (raw: unknown) => { try { return validateUsSupplierDocumentRecord(raw,org); } catch { return denied('invalid_supplier_document_record'); } };
      const respond = async (saved: UsSupplierDocumentRecord, completed: UsMailboxImportResult) => {
        const receipt = completed.completion;
        if (!saved.stored || !receipt || receipt.documentId !== saved.id) return denied('invalid_mailbox_import_record');
        material(saved,completed.reservation.claim.source);
        const fresh = await current();
        return Response.json({ schemaVersion:1,organizationId:org,userId:fresh.authority.userId,role:fresh.authority.role,workspaceId:fresh.workspaceId,
          requestId:input.requestId,requestHash,document:documentSummary(saved),replayed:wasExisting || completed.replayed },{headers});
      };
      if (result?.completion) {
        const raw = await documents.read(actor(await current()),result.completion.documentId); await current();
        if (!raw) return denied('invalid_mailbox_import_record');
        const saved = record(raw); material(saved,result.reservation.claim.source);
        if (!saved.stored) return denied('invalid_mailbox_import_record');
        await readUsSupplierOriginal(archive,saved,current); return respond(saved,result);
      }
      // Recover immutable bytes before requesting today's connection or key.
      // Missing unconfirmed object can resume; a corrupt/stored object cannot.
      async function recover(reservation: UsMailboxImportResult): Promise<Response | null> {
        const claim = reservation.reservation.claim;
        let raw = await documents.read(actor(await current()),claim.suggestedDocumentId); await current();
        if (!raw) { raw = await dependencies.findDocument(actor(await current()),claim.source.contentSha256); await current(); }
        if (!raw) return null;
        const saved = record(raw); material(saved,claim.source);
        let missing = false;
        const readArchive: UsSupplierDocumentArchive = {
          get: async key => { const value = await archive.get(key); missing = value === null; return value; },
          put: (key,bytes,options) => archive.put(key,bytes,options),
        };
        try { await readUsSupplierOriginal(readArchive,saved,current); }
        catch (error) { if (missing && !saved.stored && error instanceof ErpError && error.code === 'supplier_document_archive_unavailable') return null; throw error; }
        attempted = true;
        const stored = saved.stored ? saved : record(await documents.complete(actor(await current()),saved.id,saved.contentSha256,saved.sizeBytes)); await current();
        if (!stored.stored || stored.id !== saved.id) denied('invalid_supplier_document_record');
        material(stored,claim.source);
        const completed = await validate(await imports.complete(await current(),{requestId:input.requestId,requestHash,document:stored},current)); await current();
        return respond(stored,completed);
      }
      if (result) { const recovered = await recover(result); if (recovered) return recovered; }
      const mailbox = await dependencies.mailboxStore(); await current();
      async function connected(): Promise<UsMailboxContext> {
        const fresh = await current(), state = validateUsMailboxState(await mailbox.read(fresh),org); await current();
        if (state.workspaceId !== fresh.workspaceId || state.revision !== input.expectedMailboxRevision || state.currentConnection?.id !== input.connectionId) denied('mailbox_revision_conflict',409);
        if (!state.currentConnection?.credentialsCiphertext) denied('mailbox_connection_required',409);
        return fresh;
      }
      const head = validateUsMailboxState(await mailbox.read(await connected()),org); await connected();
      const connection = head.currentConnection!;
      const key = await dependencies.encryptionKey(); await connected();
      const token = await decryptSecret(key,connection.credentialsCiphertext!,usMailboxEncryptionContext(admitted,connection.id,connection.revision)); await connected();
      if (await sha256Hex(token) !== connection.tokenSha256) denied('invalid_mailbox_record');
      const attachment = await dependencies.attachment(connection,token,input,connected); await connected();
      const source = validateUsMailboxImportSource(attachment.source), bytes = attachment.bytes.slice();
      if (source.provider !== connection.provider || source.mailboxId !== connection.mailboxId || source.folderId !== connection.folderId || source.uid !== input.uid || source.attachmentId !== input.attachmentId || source.messageVersion !== input.expectedMessageVersion
        || bytes.length !== source.sizeBytes || await sha256Hex(bytes) !== source.contentSha256 || supplierDocumentMedia(bytes,source.mediaType) !== source.mediaType) denied('invalid_mailbox_import_record');
      if (result && canonicalErpJson(result.reservation.claim.source) !== canonicalErpJson(source)) denied('mailbox_source_conflict',409);
      if (!result) {
        const context = await connected(); attempted = true;
        result = await validate(await imports.claim(context,{request:input,source,suggestedDocumentId:(dependencies.newId ?? (() => crypto.randomUUID()))()},connected)); await connected();
      }
      if (canonicalErpJson(result.reservation.claim.source) !== canonicalErpJson(source)) denied('mailbox_source_conflict',409);
      const recovered = await recover(result); if (recovered) return recovered;
      const claim = result.reservation.claim;
      let raw = await documents.read(actor(await connected()),claim.suggestedDocumentId); await connected();
      if (!raw) { raw = await dependencies.findDocument(actor(await connected()),source.contentSha256); await connected(); }
      let saved: UsSupplierDocumentRecord;
      if (raw) { saved = record(raw); material(saved,source); }
      else {
        const documentText = await (dependencies.extractText ?? supplierDocumentText)(bytes.slice(),source.mediaType); await connected();
        const textSha256 = documentText === null ? null : await sha256Hex(documentText), fresh = actor(await connected());
        const descriptor = validateUsSupplierDocumentDescriptor({schemaVersion:1,organizationId:org,id:claim.suggestedDocumentId,contentSha256:source.contentSha256,sizeBytes:source.sizeBytes,mediaType:source.mediaType,
          fileName:source.documentName,documentText,textSha256,createdBy:fresh.userId,createdAt:fresh.timestamp},org);
        attempted = true; saved = record(await documents.reserve(fresh,descriptor)); await connected(); material(saved,source);
      }
      await retainUsSupplierOriginal(archive,saved,bytes,connected); await connected();
      attempted = true;
      const stored = record(await documents.complete(actor(await connected()),saved.id,saved.contentSha256,saved.sizeBytes)); await current(); material(stored,source);
      if (!stored.stored || stored.id !== saved.id) denied('invalid_supplier_document_record');
      const completed = await validate(await imports.complete(await current(),{requestId:input.requestId,requestHash,document:stored},current)); await current();
      return respond(stored,completed);
    } catch (error) {
      let result = failure(error);
      if (attempted && result.status === 422) result = {code:'service_unavailable',status:503};
      if (admitted) { try { await current(); } catch (late) { const denial = failure(late); if ([401,402,403,404].includes(denial.status)) result = denial; } }
      try { dependencies.diagnostic?.({operation:'import',...result}); } catch { /* IDs, metadata, secrets and text never enter diagnostics. */ }
      return Response.json({error:result.code},{status:result.status,headers});
    }
  };
}
