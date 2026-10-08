import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { ErpError, canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { parseInstant } from './localization';
import { creationUuid } from './workspace-creation';
import { validateErpReceipt } from './runtime-store';
import { validateUsSupplierApprovalRequest, validateUsSupplierProposal, validateUsSupplierRecording } from './us-supplier-proposal';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsSupplierProposal, UsSupplierStore } from './us-supplier-contract';

const fail = (code = 'invalid_supplier_record', status = 503): never => { throw new ErpError(code, status); };
const hashPattern = /^[a-f0-9]{64}$/;
const same = (left: unknown, right: unknown) => canonicalErpJson(left) === canonicalErpJson(right);
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)));
}
function uuid(value: unknown): string { try { return creationUuid(value); } catch { return fail('invalid_supplier_proposal', 422); } }
function safeActor(input: FinancialAuthority): FinancialAuthority {
  const actor = snapshotPrivateJson(input) as FinancialAuthority;
  if (!exact(actor, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'])) return fail();
  uuid(actor.organizationId);
  if (typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 256 || Array.from(actor.userId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  if (actor.managementEntitled !== true || !['owner', 'admin', 'accountant'].includes(actor.role)) return fail('supplier_permission_required', 403);
  if (typeof actor.timestamp !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(actor.timestamp)) return fail();
  try { parseInstant(actor.timestamp); } catch { return fail(); }
  return actor;
}
function parsedProposal(value: unknown, org: string): UsSupplierProposal {
  try { return validateUsSupplierProposal(value, org); } catch { return fail(); }
}
async function sha(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalErpJson(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function controlled(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes: Readonly<Record<string, readonly [string, number]>> = {
      PS001: ['supplier_revision_conflict', 409], PS002: ['supplier_idempotency_conflict', 409],
      PS003: ['supplier_erp_revision_conflict', 409], PS004: ['invalid_supplier_proposal', 422],
      PS005: ['supplier_permission_required', 403], PS006: ['supplier_upgrade_required', 409],
      PS007: ['supplier_limit_reached', 409], PS008: ['invalid_supplier_record', 503],
      PU001: ['supplier_erp_revision_conflict', 409], PU002: ['supplier_idempotency_conflict', 409],
      PU003: ['immutable_record', 409], PU004: ['invalid_supplier_proposal', 422],
      PU005: ['workspace_unavailable', 409], PU006: ['configuration_changed', 409],
      PU007: ['event_too_large', 413], PU008: ['supplier_upgrade_required', 409],
    };
    if (Object.hasOwn(codes, error.code)) return new ErpError(...codes[error.code]);
  }
  return new ErpError('service_unavailable', 503);
}

/** Private, fixed RPCs only. The HTTP port owns fresh Auth and per-workspace
 * Support/Automation subscriptions. This adapter never turns a proposal into
 * an entitlement, tax determination, or automatic financial approval. */
export function createSupabaseUsSupplierStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{ supportedSchemaVersion?: ErpSchemaVersion }> = {}): UsSupplierStore {
  const supportedSchemaVersion = options.supportedSchemaVersion ?? 1;
  if (![1, 2, 3, 4].includes(supportedSchemaVersion)) return fail('invalid_request', 422);
  const parameters = (input: FinancialAuthority) => {
    const actor = safeActor(input);
    if (supportedSchemaVersion !== 4) return fail('supplier_upgrade_required', 409);
    return { p_organization: actor.organizationId, p_actor: actor, p_supported_schema_version: supportedSchemaVersion };
  };
  return {
    supportedSchemaVersion,
    async list(actor) {
      try {
        const params = parameters(actor);
        const result = snapshotPrivateJson(await client.rpc<unknown>('zentra_list_us_supplier_proposals', params));
        if (!Array.isArray(result) || result.length > 50 || new TextEncoder().encode(JSON.stringify(result)).byteLength > 2_000_000) return fail();
        const proposals = result.map(value => parsedProposal(value, params.p_organization));
        if (new Set(proposals.map(value => value.id)).size !== proposals.length || new Set(proposals.map(value => value.source.sha256)).size !== proposals.length) return fail();
        return Object.freeze(proposals);
      } catch (error) { throw controlled(error); }
    },
    async read(actor, proposalId) {
      try {
        const params = parameters(actor), id = uuid(proposalId);
        const value = await client.rpc<unknown>('zentra_read_us_supplier_proposal', { ...params, p_id: id });
        if (value === null) return null;
        const proposal = parsedProposal(value, params.p_organization);
        if (proposal.id !== id) return fail();
        return proposal;
      } catch (error) { throw controlled(error); }
    },
    async findSource(actor, sourceSha256) {
      try {
        const params = parameters(actor);
        if (typeof sourceSha256 !== 'string' || !hashPattern.test(sourceSha256)) return fail('invalid_supplier_proposal', 422);
        const value = await client.rpc<unknown>('zentra_find_us_supplier_source', { ...params, p_sha256: sourceSha256 });
        if (value === null) return null;
        const proposal = parsedProposal(value, params.p_organization);
        if (proposal.source.sha256 !== sourceSha256) return fail();
        return proposal;
      } catch (error) { throw controlled(error); }
    },
    async create(actor, input) {
      try {
        const params = parameters(actor), proposal = validateUsSupplierProposal(input, params.p_organization);
        if (proposal.state !== 'review' || proposal.revision !== 0 || proposal.createdBy !== params.p_actor.userId || proposal.createdAt !== params.p_actor.timestamp) return fail('invalid_supplier_proposal', 422);
        const result = parsedProposal(await client.rpc<unknown>('zentra_create_us_supplier_proposal', { ...params, p_proposal: proposal }), params.p_organization);
        // An exact source dedupe may return the already recorded original under
        // another generated ID. Never return a different source as that original.
        if (result.source.sha256 !== proposal.source.sha256 || result.source.documentText !== proposal.source.documentText || result.source.mediaType !== proposal.source.mediaType) return fail();
        return result;
      } catch (error) { throw controlled(error); }
    },
    async approve(input) {
      try {
        input = snapshotPrivateJson(input) as typeof input;
        if (!exact(input, ['actor', 'request', 'requestHash', 'erp'])) return fail('invalid_supplier_proposal', 422);
        const params = parameters(input.actor), request = validateUsSupplierApprovalRequest(input.request), erp = input.erp;
        if (typeof input.requestHash !== 'string' || !hashPattern.test(input.requestHash)
          || !exact(erp, ['organizationId', 'expectedRevision', 'header', 'changes', 'ledgerAudit', 'receipt', 'actor'])
          || erp.organizationId !== params.p_organization || erp.expectedRevision !== request.expectedErpRevision
          || erp.header?.schemaVersion !== 4 || !Array.isArray(erp.changes) || !Array.isArray(erp.ledgerAudit)) return fail('invalid_supplier_proposal', 422);
        const originalActor = safeActor(erp.actor);
        if (originalActor.organizationId !== params.p_organization || originalActor.userId !== params.p_actor.userId) return fail('invalid_supplier_proposal', 422);
        const receipt = validateErpReceipt(erp.receipt, params.p_organization);
        if (receipt.idempotencyKey !== `us-mail-approve:${request.idempotencyKey}` || receipt.entityId !== `us-mail-bill:${request.proposalId}`
          || receipt.action !== 'record_vendor_bill' || receipt.revision !== request.expectedErpRevision + 1) return fail('invalid_supplier_proposal', 422);
        if (input.requestHash !== await sha([params.p_organization, params.p_actor.userId, request])) return fail('supplier_idempotency_conflict', 409);
        const result = await client.rpc<unknown>('zentra_approve_us_supplier_proposal', { ...params, p_request: request, p_request_hash: input.requestHash, p_erp: erp });
        let recording;
        try { recording = validateUsSupplierRecording(result, params.p_organization); } catch { return fail(); }
        // Replay returns its original timestamp; actor, body and ERP receipt
        // identity stay exact. The server cannot substitute a different result.
        if (recording.by !== params.p_actor.userId || recording.at !== originalActor.timestamp || recording.idempotencyKey !== request.idempotencyKey
          || recording.requestHash !== input.requestHash || !same(recording.review, request.review) || !same(recording.erpReceipt, receipt)) return fail();
        return recording;
      } catch (error) { throw controlled(error); }
    },
  };
}
