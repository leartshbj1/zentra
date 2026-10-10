import { extractText, getResolvedPDFJS } from 'unpdf';
import { ErpError } from './erp-contract';
import { US_SUPPLIER_DOCUMENT_MAX_BYTES, US_SUPPLIER_DOCUMENT_MAX_TEXT_BYTES, type UsSupplierDocumentMedia } from './us-supplier-document-contract';

const encoder = new TextEncoder();
function literalText(text: string): string | null {
  const hasControl = Array.from(text).some(character => { const code = character.charCodeAt(0); return code === 127 || code < 32 && code !== 9 && code !== 10 && code !== 13; });
  if (!text.trim() || encoder.encode(text).byteLength > US_SUPPLIER_DOCUMENT_MAX_TEXT_BYTES || hasControl) return null;
  return text;
}
export function supplierDocumentMedia(bytes: Uint8Array, claimed: string | null): UsSupplierDocumentMedia {
  if (!bytes.length || bytes.length > US_SUPPLIER_DOCUMENT_MAX_BYTES) throw new ErpError('invalid_supplier_document');
  const media = claimed?.split(';')[0]?.trim().toLowerCase();
  const pdf = bytes.length >= 8 && [37, 80, 68, 70, 45].every((v, i) => bytes[i] === v);
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  const jpeg = bytes.length >= 8 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (media === 'application/pdf' && pdf || media === 'image/png' && png || media === 'image/jpeg' && jpeg) return media as UsSupplierDocumentMedia;
  if (media === 'text/plain' && !pdf && !png && !jpeg) {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ErpError('invalid_supplier_document'); }
    if (!literalText(text)) throw new ErpError('invalid_supplier_document');
    return 'text/plain';
  }
  throw new ErpError('invalid_supplier_document');
}

/** Literal extraction only. No OCR, network resource, truncation or inference.
 * A scanned/encrypted/large PDF is retained as unreadable for human review. */
export async function supplierDocumentText(bytes: Uint8Array, media: UsSupplierDocumentMedia): Promise<string | null> {
  if (media === 'text/plain') return literalText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (media !== 'application/pdf') return null;
  let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
  let loading: ReturnType<Awaited<ReturnType<typeof getResolvedPDFJS>>['getDocument']> | undefined;
  let destroyed = false;
  const destroy = () => {
    if (!loading || destroyed) return;
    destroyed = true;
    // Cancellation must not hold the HTTP response open if a hostile PDF's
    // task itself refuses to settle. PDF.js owns the cancellation promise.
    void loading.destroy().catch(() => undefined);
  };
  const work = (async () => {
    const { getDocument } = await getResolvedPDFJS();
    if (timedOut) return null;
    loading = getDocument({ data: bytes.slice(), maxImageSize: 1_000_000, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, disableAutoFetch: true, disableStream: true });
    try {
      const pdf = await loading.promise;
      if (timedOut || pdf.numPages > 12) return null;
      const result = await extractText(pdf, { mergePages: true });
      return timedOut ? null : literalText(result.text);
    } finally { destroy(); }
  })();
  try {
    return await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => { timedOut = true; destroy(); resolve(null); }, 8000); })]);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}
