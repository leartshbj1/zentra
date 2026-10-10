import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { creationUuid } from './workspace-creation';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { validateUsSupplierDocumentDescriptor, validateUsSupplierDocumentRecord, type UsSupplierDocumentRecord, type UsSupplierDocumentStore } from './us-supplier-document-contract';

const fail = (code = 'invalid_supplier_document_record', status = 503): never => { throw new ErpError(code, status); };
const same = (left: unknown, right: unknown) => canonicalErpJson(left) === canonicalErpJson(right);
function uuid(value: unknown): string { try { return creationUuid(value); } catch { return fail('invalid_supplier_document', 422); } }
function actorSnapshot(input: FinancialAuthority): FinancialAuthority {
  const actor = snapshotPrivateJson(input) as FinancialAuthority;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || Object.keys(actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(field => Object.hasOwn(actor, field))) return fail();
  uuid(actor.organizationId);
  if (actor.managementEntitled !== true || !['owner', 'admin', 'accountant'].includes(actor.role)) return fail('supplier_permission_required', 403);
  if (typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 256 || Array.from(actor.userId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || typeof actor.timestamp !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(actor.timestamp)) return fail();
  try { parseInstant(actor.timestamp); } catch { return fail(); }
  return actor;
}
async function record(input: unknown, org: string): Promise<UsSupplierDocumentRecord> {
  let value: UsSupplierDocumentRecord;
  try { value = validateUsSupplierDocumentRecord(input, org); } catch { return fail(); }
  if (value.documentText !== null && value.textSha256 !== await sha256Hex(value.documentText)) return fail();
  return value;
}
function controlled(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes: Record<string, [string, number]> = {
      PD001: ['invalid_supplier_document', 422], PD002: ['supplier_document_conflict', 409], PD003: ['supplier_document_not_found', 404],
      PD004: ['supplier_document_limit_reached', 409], PD005: ['invalid_supplier_document_record', 503],
      PS005: ['supplier_permission_required', 403], PS006: ['supplier_upgrade_required', 409], PS008: ['invalid_supplier_record', 503],
      PU005: ['workspace_unavailable', 409], PU006: ['configuration_changed', 409], PU008: ['client_upgrade_required', 409],
    };
    if (Object.hasOwn(codes, error.code)) return new ErpError(...codes[error.code]);
  }
  return new ErpError('service_unavailable', 503);
}

/** Fixed service RPCs only. Fresh Auth/D1 rights and actual R2 re-read are owned
 * by the HTTP/archive composition. A SQL receipt cannot verify remote bytes. */
export function createSupabaseUsSupplierDocumentStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{ supportedSchemaVersion?: ErpSchemaVersion }> = {}): UsSupplierDocumentStore {
  const capability = options.supportedSchemaVersion ?? 1;
  if (![1, 2, 3, 4].includes(capability)) return fail('invalid_request', 422);
  function parameters(input: FinancialAuthority) {
    const actor = actorSnapshot(input);
    if (capability !== 4) return fail('supplier_upgrade_required', 409);
    return { p_organization: actor.organizationId, p_actor: actor, p_supported_schema_version: capability };
  }
  return {
    async list(actor) {
      try {
        const params = parameters(actor), rows = snapshotPrivateJson(await client.rpc<unknown>('zentra_list_us_supplier_documents', params));
        if (!Array.isArray(rows) || rows.length > 50) return fail();
        const values = await Promise.all(rows.map(row => record(row, params.p_organization)));
        if (new Set(values.map(row => row.id)).size !== values.length || new Set(values.map(row => row.contentSha256)).size !== values.length
          || values.reduce((sum, row) => sum + row.sizeBytes, 0) > 100 * 1024 * 1024
          || new Set(values.filter(row => row.proposalId !== null).map(row => row.proposalId)).size !== values.filter(row => row.proposalId !== null).length) return fail();
        return Object.freeze(values);
      } catch (error) { throw controlled(error); }
    },
    async read(actor, id) {
      try {
        const params = parameters(actor), safeId = uuid(id), value = await client.rpc<unknown>('zentra_read_us_supplier_document', { ...params, p_id: safeId });
        if (value === null) return null;
        const saved = await record(value, params.p_organization); if (saved.id !== safeId) return fail(); return saved;
      } catch (error) { throw controlled(error); }
    },
    async reserve(actor, input) {
      try {
        const params = parameters(actor), descriptor = validateUsSupplierDocumentDescriptor(input, params.p_organization);
        if (descriptor.createdBy !== params.p_actor.userId || descriptor.createdAt !== params.p_actor.timestamp
          || descriptor.documentText !== null && descriptor.textSha256 !== await sha256Hex(descriptor.documentText)) return fail('invalid_supplier_document', 422);
        const saved = await record(await client.rpc<unknown>('zentra_reserve_us_supplier_document', { ...params, p_descriptor: descriptor }), params.p_organization);
        const { stored: _stored, proposalId: _proposal, createdAt: _createdAt, ...body } = saved;
        const { createdAt: _candidateAt, ...material } = descriptor;
        if (saved.id === descriptor.id ? !same(body, material) : saved.contentSha256 !== descriptor.contentSha256 || saved.sizeBytes !== descriptor.sizeBytes || saved.mediaType !== descriptor.mediaType) return fail();
        return saved;
      } catch (error) { throw controlled(error); }
    },
    async complete(actor, id, contentSha256, sizeBytes) {
      try {
        const params = parameters(actor), safeId = uuid(id);
        if (typeof contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(contentSha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 6 * 1024 * 1024) return fail('invalid_supplier_document', 422);
        const saved = await record(await client.rpc<unknown>('zentra_complete_us_supplier_document', { ...params, p_id: safeId, p_content_sha256: contentSha256, p_size_bytes: sizeBytes }), params.p_organization);
        if (saved.id !== safeId || saved.contentSha256 !== contentSha256 || saved.sizeBytes !== sizeBytes || !saved.stored) return fail(); return saved;
      } catch (error) { throw controlled(error); }
    },
    async link(actor, id, input) {
      try {
        const params = parameters(actor), safeId = uuid(id), proposal = validateUsSupplierProposal(input, params.p_organization);
        const saved = await record(await client.rpc<unknown>('zentra_link_us_supplier_document', { ...params, p_id: safeId, p_proposal: proposal }), params.p_organization);
        if (saved.id !== safeId || !saved.stored || saved.proposalId !== proposal.id || saved.documentText !== proposal.source.documentText || saved.textSha256 !== proposal.source.sha256) return fail(); return saved;
      } catch (error) { throw controlled(error); }
    },
  };
}
