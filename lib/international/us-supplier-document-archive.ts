import { readBytesBodyWithinLimit } from '../request-body';
import { sha256Hex } from './canonical-hash';
import { ErpError } from './erp-contract';
import type { UsSupplierDocumentRecord } from './us-supplier-document-contract';
import { creationUuid } from './workspace-creation';

export interface UsSupplierDocumentArchive {
  get(key: string): Promise<{ readonly size: number; readonly body: ReadableStream<Uint8Array<ArrayBuffer>> } | null>;
  put(key: string, bytes: Uint8Array, options: { onlyIf: Headers; sha256: string; httpMetadata: { contentType: string } }): Promise<unknown>;
}
/** No caller-supplied key. No public URL or cleanup/delete port. */
function key(document: UsSupplierDocumentRecord): string {
  creationUuid(document.organizationId); creationUuid(document.id);
  if (!/^[0-9a-f]{64}$/.test(document.contentSha256)) throw new ErpError('invalid_supplier_document_record', 503);
  return `international/us/supplier-originals/${document.organizationId}/${document.id}/${document.contentSha256}`;
}
export async function readUsSupplierOriginal(archive: UsSupplierDocumentArchive, document: UsSupplierDocumentRecord, revalidate: () => Promise<unknown>): Promise<Uint8Array> {
  await revalidate();
  const object = await archive.get(key(document));
  try { await revalidate(); } catch (error) { void object?.body.cancel().catch(() => undefined); throw error; }
  if (!object || object.size !== document.sizeBytes) { void object?.body.cancel().catch(() => undefined); throw new ErpError('supplier_document_archive_unavailable', 503); }
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await readBytesBodyWithinLimit({ body: object.body, headers: new Headers() }, document.sizeBytes); }
  catch { await revalidate(); throw new ErpError('supplier_document_archive_unavailable', 503); }
  const hash = await sha256Hex(bytes);
  await revalidate();
  if (bytes.byteLength !== document.sizeBytes || hash !== document.contentSha256) throw new ErpError('supplier_document_archive_unavailable', 503);
  return bytes;
}
export async function retainUsSupplierOriginal(archive: UsSupplierDocumentArchive, document: UsSupplierDocumentRecord, bytes: Uint8Array, revalidate: () => Promise<unknown>): Promise<void> {
  if (bytes.byteLength !== document.sizeBytes || await sha256Hex(bytes) !== document.contentSha256) throw new ErpError('supplier_document_conflict', 409);
  await revalidate();
  if (!document.stored) {
    try {
      await archive.put(key(document), bytes, { onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: document.contentSha256, httpMetadata: { contentType: 'application/octet-stream' } });
    } catch {
      // PUT may have committed before the response was lost. Only a fresh,
      // byte-verified read can recover it; never overwrite another object.
      await revalidate();
    }
  }
  await readUsSupplierOriginal(archive, document, revalidate);
}
