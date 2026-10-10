import type { FinancialAuthority } from './accounting/ledger';
import type { UsSupplierProposal } from './us-supplier-contract';
import { ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { creationUuid } from './workspace-creation';
import { parseInstant } from './localization';

export const US_SUPPLIER_DOCUMENT_MAX_BYTES = 6 * 1024 * 1024;
export const US_SUPPLIER_DOCUMENT_MAX_TEXT_BYTES = 16_384;
export type UsSupplierDocumentMedia = 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain';
/** Private server descriptor. Keys and literal source text never enter the list DTO. */
export interface UsSupplierDocumentRecord {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly id: string;
  readonly contentSha256: string;
  readonly sizeBytes: number;
  readonly mediaType: UsSupplierDocumentMedia;
  readonly fileName: string;
  readonly documentText: string | null;
  readonly textSha256: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly stored: boolean;
  readonly proposalId: string | null;
}
export type UsSupplierDocumentDescriptor = Omit<UsSupplierDocumentRecord, 'stored' | 'proposalId'>;
export type UsSupplierDocument = Omit<UsSupplierDocumentRecord, 'documentText' | 'textSha256'> & { readonly readable: boolean };
export interface UsSupplierDocumentStore {
  list(actor: FinancialAuthority): Promise<readonly UsSupplierDocumentRecord[]>;
  read(actor: FinancialAuthority, id: string): Promise<UsSupplierDocumentRecord | null>;
  /** Same id/material retry preserves the first creation timestamp/author.
   * Another id for the same binary digest preserves the entire first descriptor,
   * including its text extraction, filename and author; no replacement. */
  reserve(actor: FinancialAuthority, descriptor: UsSupplierDocumentDescriptor): Promise<UsSupplierDocumentRecord>;
  /** Called only after the private archive was reread and its bytes checked. */
  complete(actor: FinancialAuthority, id: string, contentSha256: string, sizeBytes: number): Promise<UsSupplierDocumentRecord>;
  /** Correlates existing immutable text source; conflicting original is refused. */
  link(actor: FinancialAuthority, id: string, proposal: UsSupplierProposal): Promise<UsSupplierDocumentRecord>;
}

const descriptorFields = ['schemaVersion', 'organizationId', 'id', 'contentSha256', 'sizeBytes', 'mediaType', 'fileName', 'documentText', 'textSha256', 'createdBy', 'createdAt'] as const;
const recordFields = [...descriptorFields, 'stored', 'proposalId'];
const fail = (): never => { throw new ErpError('invalid_supplier_document', 422); };
function text(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum
    && !Array.from(value).some(character => { const code = character.charCodeAt(0); return code === 127 || code < 32 && !(multiline && [9, 10, 13].includes(code)); });
}
function parsed(input: unknown, organizationId: string, record: boolean): UsSupplierDocumentDescriptor | UsSupplierDocumentRecord {
  let value: Record<string, unknown>;
  try { value = snapshotPrivateJson(input) as Record<string, unknown>; creationUuid(organizationId); } catch { return fail(); }
  const fields = record ? recordFields : descriptorFields;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return fail();
  try { creationUuid(value.id); if (record && value.proposalId !== null) creationUuid(value.proposalId); } catch { return fail(); }
  if (value.schemaVersion !== 1 || value.organizationId !== organizationId || typeof value.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentSha256)
    || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 1 || Number(value.sizeBytes) > US_SUPPLIER_DOCUMENT_MAX_BYTES
    || !['application/pdf', 'image/png', 'image/jpeg', 'text/plain'].includes(String(value.mediaType))
    || !text(value.fileName, 160) || !text(value.createdBy, 256)
    || typeof value.createdAt !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.createdAt)) return fail();
  try { parseInstant(value.createdAt); } catch { return fail(); }
  if (value.documentText === null ? value.textSha256 !== null : !text(value.documentText, US_SUPPLIER_DOCUMENT_MAX_TEXT_BYTES, true)
    || new TextEncoder().encode(value.documentText as string).byteLength > US_SUPPLIER_DOCUMENT_MAX_TEXT_BYTES || typeof value.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.textSha256)) return fail();
  if (record && (typeof value.stored !== 'boolean' || value.proposalId !== null && (!value.stored || value.documentText === null))) return fail();
  return value as unknown as UsSupplierDocumentDescriptor | UsSupplierDocumentRecord;
}
/** Structural, detached validators. Store/SQL independently recompute the text
 * digest; these functions are not evidence of R2 bytes or financial authority. */
export function validateUsSupplierDocumentDescriptor(input: unknown, organizationId: string): UsSupplierDocumentDescriptor {
  return parsed(input, organizationId, false) as UsSupplierDocumentDescriptor;
}
export function validateUsSupplierDocumentRecord(input: unknown, organizationId: string): UsSupplierDocumentRecord {
  return parsed(input, organizationId, true) as UsSupplierDocumentRecord;
}
export function documentSummary(input: UsSupplierDocumentRecord): UsSupplierDocument {
  let captured: UsSupplierDocumentRecord;
  try { captured = snapshotPrivateJson(input) as UsSupplierDocumentRecord; } catch { return fail(); }
  const record = validateUsSupplierDocumentRecord(captured, captured.organizationId);
  const { documentText, textSha256: _textSha256, ...summary } = record;
  return Object.freeze({ ...summary, readable: documentText !== null });
}
