import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { DecisionFailure } from '../automation/types';
import { LedgerError, type FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion, type ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import { executeErp } from './runtime';
import type { ErpServerDependencies } from './runtime-server';
import type { ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { creationUuid } from './workspace-creation';
import { validateUsSupplierExtraction, type UsSupplierExtraction } from './us-supplier-extraction';
import { supplierErpRequest, validateUsSupplierApprovalRequest, validateUsSupplierProposal, validateUsSupplierRecording } from './us-supplier-proposal';
import type { UsSupplierApproveResponse, UsSupplierPrepareResponse, UsSupplierProposal, UsSupplierReadResponse, UsSupplierStore } from './us-supplier-contract';

export type UsSupplierServerDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'store' | 'freshSupportedSchemaVersion'> & {
  supplierStore(capability: ErpSchemaVersion): Promise<UsSupplierStore> | UsSupplierStore;
  /** Independent, fresh US workspace Automation rights. A Gestion grant is insufficient. */
  automationAccess(actor: FinancialAuthority): Promise<void>;
  /** Trusted, consent- and quota-metered analysis ONLY. No runtime provider is
   * installed until that admission exists. An extracted value never approves a bill. */
  analyzer(actor: FinancialAuthority): Promise<null | ((text: string, revalidate: () => Promise<FinancialAuthority>) => Promise<UsSupplierExtraction>)>;
  newId(): string;
  rateLimit?: ErpServerDependencies['rateLimit'];
  diagnostic?: ErpServerDependencies['diagnostic'];
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const errors: Readonly<Record<string, number>> = {
  invalid_request: 422, invalid_supplier_proposal: 422, supplier_review_required: 422,
  supplier_revision_conflict: 409, supplier_idempotency_conflict: 409, supplier_erp_revision_conflict: 409,
  supplier_permission_required: 403, supplier_upgrade_required: 409, supplier_limit_reached: 409,
  supplier_not_found: 404, invalid_supplier_record: 503, supplier_analysis_unavailable: 503,
  supplier_analysis_failed: 503, supplier_source_conflict: 409,
  supplier_currency_unsupported: 422,
  tenant_mismatch: 403, session_changed: 401, unauthorized: 401, forbidden: 403,
  management_entitlement_required: 402, automation_entitlement_required: 402,
  financial_permission_required: 403, edition_unavailable: 409, configuration_changed: 409,
  client_upgrade_required: 409, feature_unavailable: 404, rate_limited: 429, service_unavailable: 503,
  revision_conflict: 409, idempotency_conflict: 409, accounting_period_not_open: 409,
  vendor_required: 422, vendor_bill_already_recorded: 409, invalid_vendor_bill: 422,
  invalid_date: 422, invalid_amount: 422, purchase_account_required: 422,
};
function financial(actor: FinancialAuthority): void {
  if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(actor.role)) throw new ErpError('financial_permission_required', 403);
}
function ceiling(value: unknown): void { if (value !== 4) throw new ErpError('supplier_upgrade_required', 409); }
function exact(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== names.length || names.some(name => !Object.hasOwn(input, name))) throw new ErpError('invalid_supplier_proposal');
  return input as Record<string, unknown>;
}
function book(input: ErpState | null, organizationId: string): ErpState {
  if (!input || input.schemaVersion !== 4) throw new ErpError('supplier_upgrade_required', 409);
  if (input.configuration.organizationId !== organizationId || input.ledger.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (input.configuration.country !== 'US' || input.configuration.currency !== 'USD' || input.ledger.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ErpError('invalid_supplier_record', 503);
  return input;
}
function privateProposal(input: unknown, organizationId: string): UsSupplierProposal {
  try { return validateUsSupplierProposal(input, organizationId); } catch { throw new ErpError('invalid_supplier_record', 503); }
}
function controls(value: string, multiline = false): boolean {
  return Array.from(value).some(c => { const n = c.charCodeAt(0); return n === 127 || n < 32 && !(multiline && [9, 10, 13].includes(n)); });
}
function prepare(input: unknown): Readonly<{ fileName: string; documentText: string }> {
  const v = exact(input, ['schemaVersion', 'action', 'consent', 'fileName', 'documentText']);
  if (v.schemaVersion !== 1 || v.action !== 'prepare' || v.consent !== true || typeof v.fileName !== 'string' || !v.fileName.trim() || v.fileName.length > 160 || controls(v.fileName) || typeof v.documentText !== 'string' || !v.documentText.trim() || new TextEncoder().encode(v.documentText).byteLength > 16_384 || controls(v.documentText, true)) throw new ErpError('invalid_supplier_proposal');
  return Object.freeze({ fileName: v.fileName, documentText: v.documentText });
}

/** Bounded source proposal -> explicit reviewed values -> the EXISTING ERP
 * financial command. Approval plus journal/delta/audit is one transaction.
 * No financial effects at extraction, no OCR, no automatic tax determination. */
export function createUsSupplierHandlers(dependencies: UsSupplierServerDependencies) {
  function failure(error: unknown, operation: 'read' | 'write'): Response {
    let code = 'service_unavailable', status = 503;
    if (error instanceof ErpError && errors[error.code] === error.status) { code = error.code; status = error.status; }
    else if (error instanceof AccountPublicError && [401, 402, 403, 429].includes(error.status)) {
      status = error.status; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden';
    } else if (error instanceof RequestBodyError) { code = 'invalid_supplier_proposal'; status = error.status; }
    else if (error instanceof DecisionFailure) { code = 'supplier_analysis_failed'; }
    else if (error instanceof LedgerError && errors[error.message.toLowerCase()] !== undefined) { code = error.message.toLowerCase(); status = errors[code]; }
    try { dependencies.diagnostic?.({ operation, code, status }); } catch { /* Only non-sensitive codes are observable. */ }
    return json({ error: code }, status);
  }
  async function handle(request: Request, organizationId: string, operation: 'read' | 'write'): Promise<Response> {
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
      await dependencies.automationAccess(fresh.actor);
      if (!available || !await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      if (pending !== undefined) throw pending;
      return Object.freeze({ ...fresh.actor });
    }
    try {
      try { creationUuid(organizationId); } catch { throw new ErpError('invalid_request'); }
      if (new URL(request.url).search) throw new ErpError('invalid_request');
      if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      const admission = await dependencies.authority(request, organizationId);
      if (!['browser', 'device'].includes(admission.mode)) throw new ErpError('unauthorized', 401);
      confirmErpExpectedUser(request, admission);
      if (admission.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      financial(admission.actor);
      trusted = { mode: admission.mode, actor: Object.freeze({ ...admission.actor }) };
      if (operation === 'write' && trusted.mode === 'browser') requireAccountSameOrigin(request);
      await dependencies.automationAccess(trusted.actor);
      await dependencies.rateLimit?.(request, trusted.actor, operation);
      configuration = snapshotPrivateJson(await dependencies.configuration(trusted.actor)) as CompanyConfiguration;
      if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
      capability = erpClientSchemaVersion(request); ceiling(capability);
      const erpStore = await dependencies.store(capability), supplierStore = await dependencies.supplierStore(capability);
      ceiling(erpStore.supportedSchemaVersion); ceiling(supplierStore.supportedSchemaVersion);
      const state = book(await erpStore.read(organizationId), organizationId);
      if (operation === 'read') {
        const source = await supplierStore.list(trusted.actor);
        if (!Array.isArray(source) || source.length > 50) throw new ErpError('invalid_supplier_record', 503);
        const proposals = source.map(value => privateProposal(value, organizationId));
        if (new Set(proposals.map(value => value.id)).size !== proposals.length || new Set(proposals.map(value => value.source.sha256)).size !== proposals.length) throw new ErpError('invalid_supplier_record', 503);
        if (book(await erpStore.read(organizationId), organizationId).revision !== state.revision) throw new ErpError('supplier_erp_revision_conflict', 409);
        const body: UsSupplierReadResponse = { schemaVersion: 1, organizationId, erpRevision: state.revision, proposals };
        const encoded = JSON.stringify(body);
        if (new TextEncoder().encode(encoded).byteLength > 2_621_440) throw new ErpError('invalid_supplier_record', 503);
        await revalidate();
        return new Response(encoded, { headers: { ...headers, 'Content-Type': 'application/json' } });
      }
      const rawInput = await readJsonObjectWithinLimit(request, 131_072);
      let input: Record<string, unknown>;
      try { input = snapshotPrivateJson(rawInput) as Record<string, unknown>; } catch { throw new ErpError('invalid_supplier_proposal'); }
      if (input.action === 'prepare') {
        const source = prepare(input), sourceHash = await sha256Hex(source.documentText);
        const previous = await supplierStore.findSource(trusted.actor, sourceHash);
        if (previous) {
          const proposal = privateProposal(previous, organizationId);
          if (proposal.source.sha256 !== sourceHash || proposal.source.documentText !== source.documentText || proposal.source.mediaType !== 'text/plain') throw new ErpError('supplier_source_conflict', 409);
          await revalidate(); return json({ proposal, replayed: true } satisfies UsSupplierPrepareResponse);
        }
        const analyzer = await dependencies.analyzer(trusted.actor);
        if (!analyzer) throw new ErpError('supplier_analysis_unavailable', 503);
        await revalidate();
        const extraction = validateUsSupplierExtraction(await analyzer(source.documentText, revalidate));
        const actor = await revalidate();
        const proposal = validateUsSupplierProposal({ schemaVersion: 1, organizationId, id: dependencies.newId(), revision: 0, state: 'review',
          source: { kind: 'document_import', sha256: sourceHash, fileName: source.fileName, mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp, documentText: source.documentText },
          extraction, createdBy: actor.userId, createdAt: actor.timestamp }, organizationId);
        const saved = privateProposal(await supplierStore.create(actor, proposal), organizationId);
        if (saved.source.sha256 !== sourceHash || saved.source.documentText !== source.documentText || saved.source.mediaType !== 'text/plain') throw new ErpError('invalid_supplier_record', 503);
        if (saved.id === proposal.id && canonicalErpJson(saved) !== canonicalErpJson(proposal)) throw new ErpError('invalid_supplier_record', 503);
        await revalidate(); return json({ proposal: saved, replayed: saved.id !== proposal.id } satisfies UsSupplierPrepareResponse);
      }
      const envelope = exact(input, ['schemaVersion', 'action', 'request']);
      if (envelope.schemaVersion !== 1 || envelope.action !== 'approve') throw new ErpError('invalid_supplier_proposal');
      const approval = validateUsSupplierApprovalRequest(envelope.request);
      const current = await supplierStore.read(trusted.actor, approval.proposalId);
      if (!current) throw new ErpError('supplier_not_found', 404);
      const proposal = privateProposal(current, organizationId);
      if (proposal.id !== approval.proposalId) throw new ErpError('invalid_supplier_record', 503);
      const requestHash = await sha256Hex(canonicalErpJson([organizationId, trusted.actor.userId, approval]));
      const erpRequest = supplierErpRequest(proposal, approval);
      const erpHash = await sha256Hex(canonicalErpJson([organizationId, trusted.actor.userId, erpRequest]));
      function recording(value: unknown) {
        let recorded;
        try { recorded = validateUsSupplierRecording(value, organizationId); } catch { throw new ErpError('invalid_supplier_record', 503); }
        if (recorded.idempotencyKey !== approval.idempotencyKey || recorded.requestHash !== requestHash || recorded.by !== trusted!.actor.userId || canonicalErpJson(recorded.review) !== canonicalErpJson(approval.review)) throw new ErpError('supplier_idempotency_conflict', 409);
        if (recorded.erpReceipt.entityId !== `us-mail-bill:${proposal.id}` || recorded.erpReceipt.commandHash !== erpHash || recorded.erpReceipt.revision !== approval.expectedErpRevision + 1) throw new ErpError('invalid_supplier_record', 503);
        return recorded;
      }
      if (proposal.state === 'recorded') {
        const result = recording(proposal.recording);
        await revalidate(); return json({ recording: result, replayed: true } satisfies UsSupplierApproveResponse);
      }
      if (state.revision !== approval.expectedErpRevision) throw new ErpError('supplier_erp_revision_conflict', 409);
      let outcome: ReturnType<typeof recording> | undefined;
      const atomic: ErpStore = { supportedSchemaVersion: 4,
        read: organization => erpStore.read(organization),
        // A naked ERP receipt cannot replace the corresponding proposal approval.
        receipt: async () => null,
        async commit(erp) {
          const actor = await revalidate();
          const identity = (value: FinancialAuthority) => [value.organizationId, value.userId, value.role, value.managementEntitled];
          if (canonicalErpJson(identity(actor)) !== canonicalErpJson(identity(erp.actor))) throw new ErpError('supplier_permission_required', 403);
          // ERP finalized the human approval stamp immediately before this port.
          // Recheck current permission, retain that server-generated transaction
          // stamp; a later clock tick cannot mutate the journal or invalidate it.
          outcome = recording(await supplierStore.approve({ actor: erp.actor, request: approval, requestHash, erp }));
          return outcome.erpReceipt;
        },
      };
      await executeErp({ store: atomic, actor: trusted.actor, configuration, revalidate, taxProvider: async () => null }, erpRequest);
      if (!outcome) throw new ErpError('invalid_supplier_record', 503);
      await revalidate(); return json({ recording: outcome, replayed: false } satisfies UsSupplierApproveResponse);
    } catch (error) {
      // Any slow source/provider/storage failure is superseded by fresh revoked
      // identity or rights. Do not expose the stale tenant's error or document.
      if (trusted) { try { await revalidate(); } catch (freshError) { return failure(freshError, operation); } }
      return failure(error, operation);
    }
  }
  return { GET: (request: Request, organizationId: string) => handle(request, organizationId, 'read'), POST: (request: Request, organizationId: string) => handle(request, organizationId, 'write') };
}
