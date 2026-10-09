import { sha256Hex } from '../account-security';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { requireErpClientSchema, type ErpSchemaVersion } from './erp-schema-capability';
import type { Estimate } from './invoicing';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { ErpRequest } from './runtime-types';
import { prepareStripeTaxResolvedRequest, type StripeTaxServiceClassification } from './stripe-tax-resolved-request';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import { validateUsTaxMerchantContext, validateUsTaxMerchantCredential, validateUsTaxMerchantReceipt, type UsTaxMerchantCredential } from './us-tax-merchant-store';

export type UsTaxInvoicePreparationContext = Omit<UsTaxFinancialContext, 'actor' | 'recordedAt'>;
export type UsTaxPreparationClassification = Pick<StripeTaxServiceClassification, 'lineId' | 'taxCode' | 'kind' | 'taxBehavior'>;
export interface UsTaxInvoicePreparationCreate {
  readonly request: ErpRequest;
  readonly context: UsTaxFinancialContext;
  readonly merchant: UsTaxMerchantCredential;
  readonly estimate: Estimate;
  readonly classifications: readonly UsTaxPreparationClassification[];
  readonly taxDateInstant: string;
  readonly addressSource: 'billing' | 'shipping';
}
export interface UsTaxInvoicePreparation {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly request: ErpRequest;
  readonly commandHash: string;
  readonly context: UsTaxInvoicePreparationContext;
  readonly merchant: UsTaxMerchantCredential;
  readonly estimate: Estimate;
  readonly estimateSha256: string;
  readonly classifications: readonly StripeTaxServiceClassification[];
  readonly taxDateInstant: string;
  readonly addressSource: 'billing' | 'shipping';
  readonly preparationSha256: string;
  readonly preparedAt: string;
}
export interface UsTaxInvoicePreparationStore {
  read(actor: FinancialAuthority, request: ErpRequest): Promise<UsTaxInvoicePreparation | null>;
  create(actor: FinancialAuthority, input: UsTaxInvoicePreparationCreate): Promise<UsTaxInvoicePreparation>;
}
const bodyFields = ['schemaVersion', 'organizationId', 'actorUserId', 'request', 'commandHash', 'context', 'merchant', 'estimate', 'estimateSha256', 'classifications', 'taxDateInstant', 'addressSource'];
const contextFields = ['organizationId', 'countryRevision', 'configuration', 'sellerRevision', 'seller', 'taxFactsRevision', 'taxFacts', 'binding'];
const uuid = '00000000-0000-4000-8000-000000000000';
function invalid(): never { throw new ErpError('invalid_stored_tax_preparation', 503); }
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function actorSnapshot(input: FinancialAuthority): FinancialAuthority {
  const value = object(snapshotPrivateJson(input), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (typeof value.organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.organizationId) || typeof value.userId !== 'string' || !value.userId.trim() || value.userId.length > 256 || Array.from(value.userId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return invalid();
  if (value.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(value.role as string)) throw new ErpError('financial_permission_required', 403);
  try { parseInstant(value.timestamp as string); } catch { return invalid(); }
  return value as unknown as FinancialAuthority;
}
function invoiceRequest(input: unknown, organizationId: string): ErpRequest {
  const request = validateErpRequest(snapshotPrivateJson(input), organizationId);
  if (request.command.type !== 'issue_invoice' || request.command.dueDate < request.command.date) throw new ErpError('invalid_request', 422);
  if (canonicalErpJson(request) !== canonicalErpJson(input)) return invalid();
  return request;
}
async function commandHash(actor: FinancialAuthority, request: ErpRequest): Promise<string> { return sha256Hex(canonicalErpJson([actor.organizationId, actor.userId, request])); }
async function classificationEvidence(actor: FinancialAuthority, hash: string, value: UsTaxPreparationClassification): Promise<string> {
  return 'ztaxprep_' + await sha256Hex(canonicalErpJson(['zentra:us:tax:preparation:classification:v1', actor.organizationId, actor.userId, hash, value.lineId, value.taxCode]));
}
function contextSnapshot(input: unknown, actor: FinancialAuthority, merchant: UsTaxMerchantCredential): UsTaxInvoicePreparationContext {
  const value = object(snapshotPrivateJson(input), contextFields) as unknown as UsTaxInvoicePreparationContext;
  validateUsTaxMerchantContext({ organizationId: value.organizationId, countryRevision: value.countryRevision, configuration: value.configuration, sellerRevision: value.sellerRevision, seller: value.seller, taxFactsRevision: value.taxFactsRevision, taxFacts: value.taxFacts, bindingRevision: value.binding?.revision }, actor.organizationId);
  validateUsTaxMerchantReceipt({ schemaVersion: 1, organizationId: actor.organizationId, requestId: uuid, actorUserId: actor.userId, countryRevision: value.countryRevision, configurationChanged: false, credential: merchant.credential, configurationFingerprint: merchant.configurationFingerprint, binding: value.binding }, actor.organizationId, uuid, actor.userId);
  if (value.configuration.taxConfiguration.status !== 'configured' || value.binding.evidenceKind !== 'provider_observation') return invalid();
  return value;
}
function body(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(bodyFields.map(key => [key, input[key]])); }
async function validateBody(input: Record<string, unknown>, actor: FinancialAuthority, request: ErpRequest, now: string): Promise<void> {
  if (input.schemaVersion !== 1 || input.organizationId !== actor.organizationId || input.actorUserId !== actor.userId || canonicalErpJson(input.request) !== canonicalErpJson(request) || input.commandHash !== await commandHash(actor, request)) return invalid();
  const merchant = validateUsTaxMerchantCredential(input.merchant), context = contextSnapshot(input.context, actor, merchant);
  if (typeof input.estimateSha256 !== 'string' || input.estimateSha256 !== await sha256Hex(canonicalErpJson(input.estimate))) return invalid();
  const estimate = input.estimate as Estimate;
  if (request.command.type !== 'issue_invoice' || estimate.id !== request.command.estimateId || estimate.revision !== request.command.expectedEstimateRevision || !Array.isArray(input.classifications)) return invalid();
  for (const item of input.classifications) {
    const value = object(item, ['lineId', 'taxCode', 'kind', 'taxBehavior', 'revision', 'evidenceReference']);
    if (value.revision !== 1 || value.evidenceReference !== await classificationEvidence(actor, input.commandHash as string, value as unknown as UsTaxPreparationClassification)) return invalid();
  }
  try {
    const resolved = await prepareStripeTaxResolvedRequest({ organizationId: actor.organizationId, operationId: uuid, invoiceId: request.command.id, actorUserId: actor.userId, erpIdempotencyKey: request.idempotencyKey, commandHash: input.commandHash as string, expectedErpRevision: request.expectedRevision, countryRevision: context.countryRevision, sellerRevision: context.sellerRevision, taxFactsRevision: context.taxFactsRevision, configuration: context.configuration, estimate, taxFacts: context.taxFacts, binding: context.binding, classifications: input.classifications as unknown as StripeTaxServiceClassification[], invoiceDate: request.command.date, taxDateInstant: input.taxDateInstant as string, taxDatePolicy: 'caller_supplied_invoice_instant', now, addressSource: input.addressSource as 'billing' | 'shipping' });
    if (canonicalErpJson(resolved.classifications) !== canonicalErpJson(input.classifications)) return invalid();
  } catch { return invalid(); }
}
/** Historical validation uses stored creation time, never today's binding validity.
 * A readable preparation remains private evidence, not current issuance authority. */
export async function validateUsTaxInvoicePreparation(input: unknown, inputActor: FinancialAuthority, inputRequest: ErpRequest): Promise<UsTaxInvoicePreparation> {
  const actor = actorSnapshot(inputActor), value = object(snapshotPrivateJson(input), [...bodyFields, 'preparationSha256', 'preparedAt']), request = invoiceRequest(inputRequest, actor.organizationId);
  if (typeof value.preparedAt !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value.preparedAt)) return invalid();
  try { parseInstant(value.preparedAt); } catch { return invalid(); }
  await validateBody(value, actor, request, value.preparedAt);
  if (value.preparationSha256 !== await sha256Hex(canonicalErpJson(body(value)))) return invalid();
  return value as unknown as UsTaxInvoicePreparation;
}
export function usTaxPreparationStoreError(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const codes: Record<string, [string, number]> = { PF001: ['tax_preparation_changed', 409], PF002: ['idempotency_conflict', 409], PF003: ['tax_preparation_required', 409], PF004: ['invalid_tax_preparation', 422], PF005: ['financial_permission_required', 403], PF006: ['tax_preparation_expired', 409], PF007: ['invalid_stored_tax_preparation', 503], PU008: ['client_upgrade_required', 409], PU001: ['revision_conflict', 409], PX001: ['tax_configuration_changed', 409], PX006: ['binding_unavailable', 409] };
    if (codes[error.code]) return new ErpError(...codes[error.code]);
  }
  return new ErpError('service_unavailable', 503);
}
/** Caller supplies fresh real Auth/D1, catalogue confirmation and merchant
 * admission around awaits. No provider calls, implicit choices or write retry. */
export function createSupabaseUsTaxInvoicePreparationStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{ supportedSchemaVersion?: ErpSchemaVersion }> = {}): UsTaxInvoicePreparationStore {
  const capability = options.supportedSchemaVersion ?? 1; requireErpClientSchema(capability, capability);
  return Object.freeze({
    async read(inputActor: FinancialAuthority, inputRequest: ErpRequest) {
      const actor = actorSnapshot(inputActor), request = invoiceRequest(inputRequest, actor.organizationId), hash = await commandHash(actor, request);
      try { const raw = await client.rpc('zentra_read_us_tax_invoice_preparation', { p_organization: actor.organizationId, p_actor: actor, p_erp_idempotency_key: request.idempotencyKey, p_command_hash: hash, p_supported_schema_version: capability }); return raw === null ? null : await validateUsTaxInvoicePreparation(raw, actor, request); } catch (e) { throw usTaxPreparationStoreError(e); }
    },
    async create(inputActor: FinancialAuthority, input: UsTaxInvoicePreparationCreate) {
      const actor = actorSnapshot(inputActor), value = object(snapshotPrivateJson(input), ['request', 'context', 'merchant', 'estimate', 'classifications', 'taxDateInstant', 'addressSource']);
      const request = invoiceRequest(value.request, actor.organizationId), full = object(value.context, [...contextFields, 'actor', 'recordedAt']);
      const contextActor = actorSnapshot(full.actor as FinancialAuthority);
      if (contextActor.organizationId !== actor.organizationId || contextActor.userId !== actor.userId || contextActor.role !== actor.role || typeof full.recordedAt !== 'string') return invalid();
      try { parseInstant(full.recordedAt); } catch { return invalid(); }
      const context = Object.fromEntries(contextFields.map(key => [key, full[key]])), hash = await commandHash(actor, request);
      if (!Array.isArray(value.classifications) || value.classifications.length < 1 || value.classifications.length > 100) return invalid();
      const classifications: StripeTaxServiceClassification[] = [];
      for (const item of value.classifications) {
        const classification = object(item, ['lineId', 'taxCode', 'kind', 'taxBehavior']) as unknown as UsTaxPreparationClassification;
        classifications.push({ ...classification, revision: 1, evidenceReference: await classificationEvidence(actor, hash, classification) });
      }
      const payload = { schemaVersion: 1, organizationId: actor.organizationId, actorUserId: actor.userId, request, commandHash: hash, context, merchant: value.merchant, estimate: value.estimate, estimateSha256: await sha256Hex(canonicalErpJson(value.estimate)), classifications, taxDateInstant: value.taxDateInstant, addressSource: value.addressSource };
      await validateBody(payload, actor, request, full.recordedAt as string);
      const canonical = canonicalErpJson(payload), sha256 = await sha256Hex(canonical);
      try {
        const result = await validateUsTaxInvoicePreparation(await client.rpc('zentra_create_us_tax_invoice_preparation', { p_organization: actor.organizationId, p_actor: actor, p_preparation_body: canonical, p_preparation_sha256: sha256, p_supported_schema_version: capability }), actor, request);
        if (result.preparationSha256 !== sha256) return invalid(); return result;
      } catch (e) { throw usTaxPreparationStoreError(e); }
    },
  });
}
