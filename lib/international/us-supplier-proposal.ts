import { ErpError, canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { creationUuid } from './workspace-creation';
import { parseInstant } from './localization';
import { validDate } from './accounting/ledger';
import { validateErpReceipt } from './erp-receipt';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import type { ErpRequest } from './runtime-types';
import type { UsSupplierApprovalRequest, UsSupplierProposal, UsSupplierRecording, UsSupplierReview, UsSupplierSource } from './us-supplier-contract';

function fail(code = 'invalid_supplier_proposal', status = 422): never { throw new ErpError(code, status); }
function exact(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail();
  const value = input as Record<string, unknown>;
  if (Reflect.ownKeys(value).some(field => typeof field !== 'string' || ![...required, ...optional].includes(field)) || required.some(field => !Object.hasOwn(value, field))) return fail();
  return value;
}
function text(input: unknown, maximum: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || Array.from(input).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return input;
}
function uuid(input: unknown): string { try { return creationUuid(input); } catch { return fail(); } }
function instant(input: unknown): string {
  if (typeof input !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input)) return fail();
  try { parseInstant(input); } catch { return fail(); } return input;
}
function date(input: unknown): string { if (typeof input !== 'string' || input.startsWith('0000-') || !validDate(input)) return fail(); return input; }
function minor(input: unknown): string { if (typeof input !== 'string' || !/^(?:0|[1-9][0-9]{0,35})$/.test(input)) return fail(); return input; }
function copied(input: unknown): unknown { try { return snapshotPrivateJson(input); } catch { return fail(); } }
function source(input: unknown): UsSupplierSource {
  const v = exact(input, ['kind', 'sha256', 'fileName', 'mediaType', 'workspaceId', 'connectionId', 'messageId', 'receivedAt', 'documentText']);
  if (typeof v.kind !== 'string' || !['document_import', 'support_mail'].includes(v.kind) || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256) || typeof v.mediaType !== 'string' || !['text/plain', 'application/pdf'].includes(v.mediaType)) return fail();
  if (typeof v.documentText !== 'string' || !v.documentText.trim() || new TextEncoder().encode(v.documentText).byteLength > 16_384) return fail();
  if (v.kind === 'document_import' ? [v.workspaceId, v.connectionId, v.messageId].some(id => id !== null) : [v.workspaceId, v.connectionId, v.messageId].some(id => typeof id !== 'string' || !id.trim() || id.length > 256 || Array.from(id).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) return fail();
  return { kind: v.kind as UsSupplierSource['kind'], sha256: v.sha256, fileName: text(v.fileName, 160), mediaType: v.mediaType as UsSupplierSource['mediaType'], workspaceId: v.workspaceId as string | null, connectionId: v.connectionId as string | null, messageId: v.messageId as string | null, receivedAt: instant(v.receivedAt), documentText: v.documentText };
}
export function validateUsSupplierReview(input: unknown): UsSupplierReview {
  const v = exact(copied(input), ['vendorId', 'reference', 'date', 'accountingDate', 'dueDate', 'periodId', 'netMinor', 'printedTaxMinor']);
  const reviewed = { vendorId: text(v.vendorId, 160), reference: text(v.reference, 500), date: date(v.date), accountingDate: date(v.accountingDate), dueDate: date(v.dueDate), periodId: text(v.periodId, 160), netMinor: minor(v.netMinor), printedTaxMinor: minor(v.printedTaxMinor) };
  const total = BigInt(reviewed.netMinor) + BigInt(reviewed.printedTaxMinor);
  if (reviewed.dueDate < reviewed.date || total <= BigInt(0) || total.toString().length > 36) return fail();
  return snapshotPrivateJson(reviewed) as UsSupplierReview;
}
export function validateUsSupplierApprovalRequest(input: unknown): UsSupplierApprovalRequest {
  const v = exact(copied(input), ['schemaVersion', 'idempotencyKey', 'proposalId', 'expectedProposalRevision', 'expectedErpRevision', 'confirmed', 'taxReviewed', 'review']);
  if (v.schemaVersion !== 1 || v.expectedProposalRevision !== 0 || !Number.isSafeInteger(v.expectedErpRevision) || (v.expectedErpRevision as number) < 1 || (v.expectedErpRevision as number) >= Number.MAX_SAFE_INTEGER || v.confirmed !== true || v.taxReviewed !== true) return fail('supplier_review_required');
  return snapshotPrivateJson({ schemaVersion: 1, idempotencyKey: uuid(v.idempotencyKey), proposalId: uuid(v.proposalId), expectedProposalRevision: 0, expectedErpRevision: v.expectedErpRevision, confirmed: true, taxReviewed: true, review: validateUsSupplierReview(v.review) }) as UsSupplierApprovalRequest;
}
export function validateUsSupplierRecording(input: unknown, organizationId: string): UsSupplierRecording {
  const org = uuid(organizationId), v = exact(copied(input), ['idempotencyKey', 'requestHash', 'by', 'at', 'review', 'erpReceipt']);
  if (typeof v.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.requestHash)) return fail();
  const idempotencyKey = uuid(v.idempotencyKey), erpReceipt = validateErpReceipt(v.erpReceipt, org);
  if (erpReceipt.action !== 'record_vendor_bill' || erpReceipt.idempotencyKey !== `us-mail-approve:${idempotencyKey}` || !/^us-mail-bill:[a-f0-9-]{36}$/.test(erpReceipt.entityId)) return fail();
  uuid(erpReceipt.entityId.slice('us-mail-bill:'.length));
  return snapshotPrivateJson({ idempotencyKey, requestHash: v.requestHash, by: text(v.by, 256), at: instant(v.at), review: validateUsSupplierReview(v.review), erpReceipt }) as UsSupplierRecording;
}
export function validateUsSupplierProposal(input: unknown, organizationId: string): UsSupplierProposal {
  const org = uuid(organizationId), v = exact(copied(input), ['schemaVersion', 'organizationId', 'id', 'revision', 'source', 'extraction', 'createdBy', 'createdAt', 'state'], ['recording']);
  if (v.schemaVersion !== 1 || v.organizationId !== org || v.state !== 'review' && v.state !== 'recorded' || v.revision !== (v.state === 'review' ? 0 : 1) || Object.hasOwn(v, 'recording') !== (v.state === 'recorded')) return fail();
  const id = uuid(v.id), createdAt = instant(v.createdAt), recording = v.state === 'recorded' ? validateUsSupplierRecording(v.recording, org) : null;
  const extraction = validateUsSupplierExtraction(v.extraction);
  if (canonicalErpJson(extraction) !== canonicalErpJson(v.extraction)) return fail();
  if (recording && (parseInstant(recording.at).getTime() < parseInstant(createdAt).getTime() || recording.erpReceipt.entityId !== `us-mail-bill:${id}`)) return fail();
  return snapshotPrivateJson({ schemaVersion: 1, organizationId: org, id, revision: v.revision, source: source(v.source), extraction, createdBy: text(v.createdBy, 256), createdAt, state: v.state, ...(recording ? { recording } : {}) }) as UsSupplierProposal;
}
/** Explicit reviewed values use the existing manual financial command. Source
 * and proposed/extracted values remain intact in the sidecar audit. */
export function supplierErpRequest(proposal: UsSupplierProposal, input: UsSupplierApprovalRequest): ErpRequest {
  const captured = copied(proposal) as UsSupplierProposal;
  const p = validateUsSupplierProposal(captured, captured?.organizationId), request = validateUsSupplierApprovalRequest(input);
  if (p.id !== request.proposalId) return fail();
  if (p.extraction.fields.currency !== null && p.extraction.fields.currency !== 'USD') return fail('supplier_currency_unsupported');
  const { printedTaxMinor, ...review } = request.review;
  return snapshotPrivateJson({ idempotencyKey: `us-mail-approve:${request.idempotencyKey}`, expectedRevision: request.expectedErpRevision, command: { type: 'record_vendor_bill', ...review, id: `us-mail-bill:${p.id}`, purchaseTaxMinor: printedTaxMinor, expenseAccountId: 'purchases', sourceReference: `mail:${p.id}:${p.source.sha256}` } }) as ErpRequest;
}
