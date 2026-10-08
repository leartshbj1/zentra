import { ErpError, canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { creationUuid } from './workspace-creation';
import { parseInstant } from './localization';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import type { FinancialAuthority } from './accounting/ledger';
import type { UsSupplierSource } from './us-supplier-contract';
import type { UsAutomationGrant, UsAutomationJob, UsAutomationSettings, UsAutomationSettingsRequest, UsAutomationUsage } from './us-automation-contract';

export const automationFail = (code = 'invalid_automation_request', status = 422): never => { throw new ErpError(code, status); };
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 256 && v.trim() === v && !!v && !Array.from(v).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER - 1): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export function automationExact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  let value: unknown; try { value = snapshotPrivateJson(input); } catch { return automationFail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) return automationFail();
  return value as Record<string, unknown>;
}
export function automationUuid(input: unknown): string { try { return creationUuid(input); } catch { return automationFail(); } }
function instant(input: unknown): string {
  if (typeof input !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input)) return automationFail();
  try { parseInstant(input); } catch { return automationFail(); } return input;
}
export function validateUsAutomationActor(input: FinancialAuthority): FinancialAuthority {
  const v = automationExact(input, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  const organizationId = automationUuid(v.organizationId);
  if (!text(v.userId)) return automationFail();
  if (v.managementEntitled !== true || !['owner', 'admin', 'accountant'].includes(String(v.role))) return automationFail('automation_permission_required', 403);
  return Object.freeze({ ...v, organizationId, timestamp: instant(v.timestamp) }) as unknown as FinancialAuthority;
}
export function validateUsAutomationGrant(input: unknown, organizationId: string): UsAutomationGrant {
  const v = automationExact(input, ['schemaVersion', 'organizationId', 'environment', 'bucket', 'periodId', 'periodStart', 'periodEnd', 'limit', 'subscriptionId', 'authorityReference', 'catalogVersion', 'priceId', 'budgetPolicyVersion', 'processingPolicyVersion', 'checkedAt']);
  if (v.schemaVersion !== 1 || v.organizationId !== automationUuid(organizationId) || !['TEST', 'PRODUCTION'].includes(String(v.environment)) || v.bucket !== 'supplier_invoice_extract'
    || typeof v.periodId !== 'string' || !/^[1-9][0-9]{3}-(?:0[1-9]|1[0-2])$/.test(v.periodId) || !integer(v.limit, 1, 1_000_000)
    || !integer(v.periodStart) || !integer(v.periodEnd) || !integer(v.checkedAt)
    || ['subscriptionId', 'authorityReference', 'catalogVersion', 'budgetPolicyVersion', 'processingPolicyVersion'].some(k => !key(v[k])) || typeof v.priceId !== 'string' || !/^price_[A-Za-z0-9_]{1,120}$/.test(v.priceId)) return automationFail();
  const [year, month] = v.periodId.split('-').map(Number), start = Date.UTC(year, month - 1, 1) / 1000, end = Date.UTC(year, month, 1) / 1000;
  if (v.periodStart !== start || v.periodEnd !== end || v.checkedAt < start || v.checkedAt >= end) return automationFail();
  return Object.freeze(v) as unknown as UsAutomationGrant;
}
export function validateUsAutomationSettings(input: unknown, organizationId: string): UsAutomationSettings {
  const v = automationExact(input, ['schemaVersion', 'organizationId', 'revision', 'enabled', 'consent']);
  if (v.schemaVersion !== 1 || v.organizationId !== automationUuid(organizationId) || !integer(v.revision) || typeof v.enabled !== 'boolean' || v.enabled && v.consent === null || v.revision === 0 && (v.enabled || v.consent !== null)) return automationFail();
  if (v.consent !== null) {
    const c = automationExact(v.consent, ['processingPolicyVersion', 'acceptedBy', 'acceptedAt']);
    if (!key(c.processingPolicyVersion) || !text(c.acceptedBy)) return automationFail(); instant(c.acceptedAt);
  }
  return snapshotPrivateJson(v) as unknown as UsAutomationSettings;
}
export function validateUsAutomationSettingsRequest(input: unknown): UsAutomationSettingsRequest {
  let value: Record<string, unknown>; try { value = snapshotPrivateJson(input) as Record<string, unknown>; } catch { return automationFail(); }
  const v = automationExact(value, ['schemaVersion', 'requestId', 'expectedRevision', 'action', 'processingPolicyVersion', 'consent']);
  if (v.schemaVersion !== 1 || !integer(v.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 2) || !['activate', 'pause'].includes(String(v.action)) || v.action === 'activate' && (v.consent !== true || !key(v.processingPolicyVersion)) || v.action === 'pause' && (v.consent !== false || v.processingPolicyVersion !== null && !key(v.processingPolicyVersion))) return automationFail();
  automationUuid(v.requestId); return Object.freeze(v) as unknown as UsAutomationSettingsRequest;
}
export function validateUsAutomationSource(input: unknown, organizationId: string): UsSupplierSource {
  const extraction = validateUsSupplierExtraction({ schemaVersion: 1, kind: 'unknown', confidence: 0, fields: {}, evidence: {}, fieldConfidence: {}, issues: [] });
  const source = validateUsSupplierProposal({ schemaVersion: 1, organizationId, id: '11111111-1111-4111-8111-111111111111', revision: 0, state: 'review', source: input, extraction, createdBy: 'validator', createdAt: '2026-10-08T00:00:00Z' }, organizationId).source;
  // This first vertical admits literal UTF8 text only; PDF bytes/OCR are absent.
  if (source.mediaType !== 'text/plain') return automationFail(); return source;
}
export function validateUsAutomationResult(body: unknown): string {
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 65_536) return automationFail();
  let value: unknown; try { value = JSON.parse(body); } catch { return automationFail(); }
  if (canonicalErpJson(validateUsSupplierExtraction(value)) !== body) return automationFail(); return body;
}
export function validateUsAutomationJob(input: unknown, organizationId: string): UsAutomationJob {
  const v = automationExact(input, ['schemaVersion', 'organizationId', 'id', 'environment', 'bucket', 'source', 'recipeVersion', 'requestId', 'createdBy', 'createdAt', 'grant', 'consentRevision', 'state', 'leaseToken', 'leaseUntil', 'leaseGeneration', 'dispatchId', 'dispatchedAt', 'resultBody', 'resultSha256', 'proposalId']);
  const org = automationUuid(organizationId); automationUuid(v.id); automationUuid(v.requestId); instant(v.createdAt);
  const grant = validateUsAutomationGrant(v.grant, org), source = validateUsAutomationSource(v.source, org);
  if (v.schemaVersion !== 1 || v.organizationId !== org || v.environment !== grant.environment || v.bucket !== grant.bucket || !key(v.recipeVersion) || !text(v.createdBy) || !integer(v.consentRevision, 1) || !integer(v.leaseGeneration, 1) || !['held', 'released', 'dispatched', 'uncertain', 'completed'].includes(String(v.state))) return automationFail();
  if (v.state === 'released') { if (v.leaseToken !== null || v.leaseUntil !== null) return automationFail(); }
  else { automationUuid(v.leaseToken); instant(v.leaseUntil); if (Date.parse(v.leaseUntil as string) <= Date.parse(v.createdAt as string)) return automationFail(); }
  const dispatched = ['dispatched', 'uncertain', 'completed'].includes(String(v.state));
  if (dispatched) { automationUuid(v.dispatchId); instant(v.dispatchedAt); if (Date.parse(v.dispatchedAt as string) < Date.parse(v.createdAt as string)) return automationFail(); }
  else if (v.dispatchId !== null || v.dispatchedAt !== null) return automationFail();
  if (v.state === 'completed') {
    validateUsAutomationResult(v.resultBody); automationUuid(v.proposalId);
    if (typeof v.resultSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.resultSha256)) return automationFail();
  } else if (v.resultBody !== null || v.resultSha256 !== null || v.proposalId !== null) return automationFail();
  return snapshotPrivateJson({ ...v, source, grant }) as unknown as UsAutomationJob;
}
export function validateUsAutomationUsage(input: unknown, grant: UsAutomationGrant): UsAutomationUsage {
  const v = automationExact(input, ['schemaVersion', 'organizationId', 'environment', 'bucket', 'periodId', 'limit', 'held', 'consumed', 'remaining']);
  if (v.schemaVersion !== 1 || v.organizationId !== grant.organizationId || v.environment !== grant.environment || v.bucket !== grant.bucket || v.periodId !== grant.periodId || v.limit !== grant.limit || !integer(v.held, 0, 1_000_000) || !integer(v.consumed, 0, 1_000_000) || !integer(v.remaining, 0, 1_000_000) || v.remaining !== Math.max(0, grant.limit - (v.held as number) - (v.consumed as number))) return automationFail();
  return Object.freeze(v) as unknown as UsAutomationUsage;
}
