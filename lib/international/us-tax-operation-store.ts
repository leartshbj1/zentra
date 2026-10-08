import { sha256Hex } from '../account-security';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError, canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { parseInstant } from './localization';
import { validateErpReceipt } from './runtime-store';
import type { ErpCommit, ErpReceipt } from './runtime-types';
import type { ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { ValidatedStripeTaxCalculation } from './stripe-tax-calculation';
import { requireErpClientSchema, type ErpSchemaVersion } from './erp-schema-capability';

export interface StoredUsTaxOperation {
  readonly status: 'reserved' | 'calculated' | 'committed';
  readonly organizationId: string;
  readonly operationId: string;
  readonly actorUserId: string;
  readonly erpIdempotencyKey: string;
  readonly commandHash: string;
  readonly reservedAt: string;
  readonly retryUntil: string;
  /** Untrusted decoded storage value. Call validateResolvedStripeTaxRequest
   * with the fresh server clock before resuming a pending provider request. */
  readonly resolved: unknown;
  readonly calculation: Readonly<{ proofBody: string; proofSha256: string; assessment: unknown }> | null;
  readonly receipt: ErpReceipt | null;
}
export interface UsTaxOperationStore {
  read(actor: FinancialAuthority, erpIdempotencyKey: string, commandHash: string): Promise<StoredUsTaxOperation | null>;
  reserve(actor: FinancialAuthority, resolved: ResolvedStripeTaxRequest): Promise<StoredUsTaxOperation>;
  record(actor: FinancialAuthority, resolved: ResolvedStripeTaxRequest, calculated: ValidatedStripeTaxCalculation): Promise<StoredUsTaxOperation>;
  commit(operationId: string, input: ErpCommit): Promise<ErpReceipt>;
}
function invalid(): never { throw new ErpError('invalid_stored_tax_operation', 503); }
function error(input: unknown): ErpError {
  if (input instanceof ErpError) return input;
  if (input instanceof SupabaseServerError) {
    const mapping: Record<string, [string, number]> = {
      PX001: ['tax_configuration_changed', 409], PX002: ['tax_operation_conflict', 409], PX003: ['tax_binding_unavailable', 409], PX004: ['invalid_tax_operation', 422],
      PX005: ['invalid_stored_tax_operation', 503], PX006: ['tax_operation_expired', 409], PX007: ['financial_permission_required', 403],
      PU001: ['revision_conflict', 409], PU002: ['idempotency_conflict', 409], PU003: ['immutable_record', 409], PU004: ['invalid_state', 422], PU005: ['workspace_unavailable', 409], PU006: ['configuration_changed', 409], PU007: ['event_too_large', 413],
      PU008: ['client_upgrade_required', 409],
    };
    if (mapping[input.code]) return new ErpError(...mapping[input.code]);
  }
  return new ErpError('service_unavailable', 503);
}
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function actorSnapshot(input: FinancialAuthority): FinancialAuthority {
  const value = object(snapshotPrivateJson(input), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (typeof value.organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.organizationId) || typeof value.userId !== 'string' || !value.userId || value.userId.length > 256 || Array.from(value.userId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return invalid();
  if (value.managementEntitled !== true || !['owner', 'admin', 'accountant'].includes(value.role as string)) throw new ErpError('financial_permission_required', 403);
  try { parseInstant(value.timestamp as string); } catch { return invalid(); }
  return value as unknown as FinancialAuthority;
}
const operationFields = ['status', 'organizationId', 'operationId', 'actorUserId', 'erpIdempotencyKey', 'commandHash', 'reservedAt', 'retryUntil', 'resolvedBody', 'resolvedSha256', 'paramsBody', 'paramsSha256', 'providerKey', 'proofBody', 'proofSha256', 'assessment', 'receipt'];
async function operation(input: unknown, actor: FinancialAuthority, erpKey: string, commandHash: string): Promise<StoredUsTaxOperation> {
  // Snapshot all fields, including nested assessment, before any hash await.
  const value = object(snapshotPrivateJson(input), operationFields);
  if (!['reserved', 'calculated', 'committed'].includes(value.status as string) || value.organizationId !== actor.organizationId || value.actorUserId !== actor.userId || value.erpIdempotencyKey !== erpKey || value.commandHash !== commandHash || typeof value.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.operationId)) return invalid();
  for (const key of ['resolvedBody', 'paramsBody']) if (typeof value[key] !== 'string' || (value[key] as string).length > 524_288) return invalid();
  for (const key of ['resolvedSha256', 'paramsSha256']) if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key] as string)) return invalid();
  if (typeof value.providerKey !== 'string' || !/^ztax_test_[0-9a-f]{64}$/.test(value.providerKey)) return invalid();
  let payload: Record<string, unknown>, params: unknown;
  try { payload = snapshotPrivateJson(JSON.parse(value.resolvedBody as string)) as Record<string, unknown>; params = snapshotPrivateJson(JSON.parse(value.paramsBody as string)); } catch { return invalid(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || canonicalErpJson(payload) !== value.resolvedBody || canonicalErpJson(params) !== value.paramsBody || payload.paramsSha256 !== value.paramsSha256 || canonicalErpJson(payload.params) !== value.paramsBody || payload.organizationId !== actor.organizationId || payload.actorUserId !== actor.userId || payload.operationId !== value.operationId || payload.erpIdempotencyKey !== erpKey || payload.commandHash !== commandHash) return invalid();
  const binding = payload.binding as Record<string, unknown>;
  if (!binding || binding.mode !== 'test' || binding.scope !== 'erp_invoice_tax' || binding.organizationId !== actor.organizationId || typeof binding.accountId !== 'string' || !/^acct_[A-Za-z0-9]+$/.test(binding.accountId)) return invalid();
  const expectedKey = 'ztax_test_' + await sha256Hex(canonicalErpJson(['zentra:us:stripe-tax:calculation:v1', actor.organizationId, value.operationId, binding.accountId, 'test', value.resolvedSha256]));
  if (value.providerKey !== expectedKey || await sha256Hex(value.resolvedBody as string) !== value.resolvedSha256 || await sha256Hex(value.paramsBody as string) !== value.paramsSha256) return invalid();
  let reservedAt: Date, retryUntil: Date;
  if (typeof value.reservedAt !== 'string' || typeof value.retryUntil !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value.reservedAt) || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value.retryUntil)) return invalid();
  try { reservedAt = parseInstant(value.reservedAt); retryUntil = parseInstant(value.retryUntil); } catch { return invalid(); }
  if (retryUntil.getTime() - reservedAt.getTime() !== 23 * 3_600_000) return invalid();
  const calculated = value.status !== 'reserved';
  if (calculated) {
    if (typeof value.proofBody !== 'string' || value.proofBody.length > 524_288 || typeof value.proofSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.proofSha256) || !value.assessment || typeof value.assessment !== 'object' || Array.isArray(value.assessment)) return invalid();
  } else if (value.proofBody !== null || value.proofSha256 !== null || value.assessment !== null || value.receipt !== null) return invalid();
  const receipt = value.status === 'committed' ? validateErpReceipt(value.receipt, actor.organizationId) : null;
  if (receipt && (receipt.action !== 'issue_invoice' || receipt.idempotencyKey !== erpKey || receipt.commandHash !== commandHash || receipt.entityId !== payload.invoiceId || receipt.revision !== Number(payload.expectedErpRevision) + 1)) return invalid();
  if (value.status !== 'committed' && value.receipt !== null) return invalid();
  return Object.freeze({
    status: value.status as StoredUsTaxOperation['status'], organizationId: actor.organizationId, operationId: value.operationId, actorUserId: actor.userId, erpIdempotencyKey: erpKey, commandHash,
    reservedAt: value.reservedAt as string, retryUntil: value.retryUntil as string,
    resolved: snapshotPrivateJson({ ...payload, paramsBody: value.paramsBody, resolvedBody: value.resolvedBody, resolvedSha256: value.resolvedSha256, idempotencyKey: value.providerKey }),
    calculation: calculated ? Object.freeze({ proofBody: value.proofBody as string, proofSha256: value.proofSha256 as string, assessment: value.assessment }) : null, receipt,
  });
}
/** Private server-only transport; it never admits a user from a submitted role,
 * enables a tax profile, retries RPC mutations or returns private DTOs to HTTP.
 * The caller must perform fresh Auth/D1 admission around every awaited phase. */
export function createSupabaseUsTaxOperationStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{supportedSchemaVersion?:ErpSchemaVersion}> = {}): UsTaxOperationStore {
  // Capture a server factory's capability once. Never derive it from the
  // candidate header, request body, browser locale or a later mutable option.
  const supportedSchemaVersion = options.supportedSchemaVersion === undefined ? 1 : options.supportedSchemaVersion;
  requireErpClientSchema(supportedSchemaVersion,supportedSchemaVersion);
  return {
    async read(inputActor, erpIdempotencyKey, commandHash) {
      const actor = actorSnapshot(inputActor);
      try { const value = await client.rpc<unknown>('zentra_read_us_tax_operation', { p_organization: actor.organizationId, p_erp_idempotency_key: erpIdempotencyKey, p_command_hash: commandHash, p_actor: actor }); return value === null ? null : await operation(value, actor, erpIdempotencyKey, commandHash); } catch (e) { throw error(e); }
    },
    async reserve(inputActor, resolved) {
      const actor = actorSnapshot(inputActor);
      resolved = snapshotPrivateJson(resolved) as ResolvedStripeTaxRequest;
      if (resolved.organizationId !== actor.organizationId || resolved.actorUserId !== actor.userId) throw new ErpError('tenant_mismatch', 403);
      try {
        const value = await client.rpc<unknown>('zentra_reserve_us_tax_operation', { p_organization: actor.organizationId, p_actor: actor, p_operation_id: resolved.operationId, p_resolved_body: resolved.resolvedBody, p_resolved_sha256: resolved.resolvedSha256, p_params_body: resolved.paramsBody, p_params_sha256: resolved.paramsSha256, p_provider_idempotency_key: resolved.idempotencyKey });
        const stored = await operation(value, actor, resolved.erpIdempotencyKey, resolved.commandHash);
        if (stored.operationId !== resolved.operationId || canonicalErpJson(stored.resolved) !== canonicalErpJson(resolved)) return invalid(); return stored;
      } catch (e) { throw error(e); }
    },
    async record(inputActor, resolved, calculated) {
      const actor = actorSnapshot(inputActor);
      resolved = snapshotPrivateJson(resolved) as ResolvedStripeTaxRequest;
      calculated = snapshotPrivateJson(calculated) as ValidatedStripeTaxCalculation;
      if (resolved.organizationId !== actor.organizationId || resolved.actorUserId !== actor.userId) throw new ErpError('tenant_mismatch', 403);
      try {
        const value = await client.rpc<unknown>('zentra_record_us_tax_calculation', { p_organization: actor.organizationId, p_operation_id: resolved.operationId, p_actor: actor, p_proof_body: calculated.proofBody, p_proof_sha256: calculated.proofSha256, p_assessment: calculated.assessment });
        const stored = await operation(value, actor, resolved.erpIdempotencyKey, resolved.commandHash);
        if (stored.operationId !== resolved.operationId || canonicalErpJson(stored.resolved) !== canonicalErpJson(resolved) || !stored.calculation || stored.calculation.proofBody !== calculated.proofBody || stored.calculation.proofSha256 !== calculated.proofSha256 || canonicalErpJson(stored.calculation.assessment) !== canonicalErpJson(calculated.assessment)) return invalid(); return stored;
      } catch (e) { throw error(e); }
    },
    async commit(operationId, input) {
      input = snapshotPrivateJson(input) as ErpCommit;
      const actor = actorSnapshot(input.actor);
      const expectedReceipt = validateErpReceipt(input.receipt, input.organizationId);
      if (actor.organizationId !== input.organizationId || expectedReceipt.action !== 'issue_invoice') throw new ErpError('invalid_tax_operation', 422);
      requireErpClientSchema(input.header.schemaVersion,supportedSchemaVersion);
      try {
        const value = await client.rpc<unknown>('zentra_commit_us_tax_invoice_test_v2', { p_organization: input.organizationId, p_operation_id: operationId, p_expected_revision: input.expectedRevision, p_header: input.header, p_changes: input.changes, p_ledger_audit: input.ledgerAudit, p_receipt: expectedReceipt, p_actor: actor, p_supported_schema_version: supportedSchemaVersion });
        const receipt = validateErpReceipt(value, input.organizationId); if (canonicalErpJson(receipt) !== canonicalErpJson(expectedReceipt)) return invalid(); return receipt;
      } catch (e) { throw error(e); }
    },
  };
}
