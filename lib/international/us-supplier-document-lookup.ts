import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { creationUuid } from './workspace-creation';
import { validateUsSupplierDocumentRecord, type UsSupplierDocumentRecord } from './us-supplier-document-contract';

/** Private fixed RPC. Fresh H1/Auth and R2 bytes remain HTTP responsibilities. */
export async function findUsSupplierDocumentByHash(client: Pick<SupabaseServerClient, 'rpc'>, actor: FinancialAuthority, contentSha256: string): Promise<UsSupplierDocumentRecord | null> {
  try {
    const a = snapshotPrivateJson(actor) as FinancialAuthority;
    if (!a || typeof a !== 'object' || Object.keys(a).length !== 5 || !['organizationId','userId','role','managementEntitled','timestamp'].every(k => Object.hasOwn(a, k))) throw new ErpError('invalid_supplier_document_record', 503);
    creationUuid(a.organizationId);
    if (!a.managementEntitled || !['owner','admin','accountant'].includes(a.role)) throw new ErpError('supplier_permission_required', 403);
    if (typeof a.userId !== 'string' || !a.userId.trim() || a.userId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(a.userId)) throw new ErpError('invalid_supplier_document_record', 503);
    parseInstant(a.timestamp);
    if (typeof contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(contentSha256)) throw new ErpError('invalid_supplier_document', 422);
    const result = await client.rpc<unknown>('zentra_find_us_supplier_document_by_sha256', { p_organization: a.organizationId, p_actor: a, p_supported_schema_version: 4, p_content_sha256: contentSha256 });
    if (result === null) return null;
    let document: UsSupplierDocumentRecord;
    try { document = validateUsSupplierDocumentRecord(result, a.organizationId); }
    catch { throw new ErpError('invalid_supplier_document_record', 503); }
    if (document.contentSha256 !== contentSha256 || document.documentText !== null && document.textSha256 !== await sha256Hex(document.documentText)) throw new ErpError('invalid_supplier_document_record', 503);
    return document;
  } catch (error) {
    if (error instanceof ErpError) throw error;
    if (error instanceof SupabaseServerError) {
      const codes: Record<string, [string,number]> = { PD001:['invalid_supplier_document',422], PS005:['supplier_permission_required',403], PS006:['supplier_upgrade_required',409], PU005:['workspace_unavailable',409], PU006:['configuration_changed',409], PU008:['client_upgrade_required',409] };
      if (Object.hasOwn(codes, error.code)) throw new ErpError(...codes[error.code]);
    }
    throw new ErpError('service_unavailable', 503);
  }
}
