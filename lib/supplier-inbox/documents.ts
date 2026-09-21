import { getDocumentProxy, extractText } from 'unpdf';

export const MAX_INVOICE_BYTES = 6 * 1024 * 1024;
export type PreparedMailDocument = { bytes: Uint8Array; media: string | null; text: string };
export function invoiceMedia(
  bytes: Uint8Array,
): 'application/pdf' | 'image/png' | 'image/jpeg' | null {
  if (bytes.length < 8 || bytes.length > MAX_INVOICE_BYTES) return null;
  if (new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-')
    return 'application/pdf';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  return null;
}
export async function invoiceText(
  bytes: Uint8Array,
  mediaType: string,
): Promise<string> {
  if (mediaType !== 'application/pdf') return '';
  const pdf = await getDocumentProxy(bytes.slice(), {
    maxImageSize: 1_000_000,
    useSystemFonts: false,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (pdf.numPages > 12) return '';
    const result = await Promise.race([
      extractText(pdf, { mergePages: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void pdf.loadingTask.destroy();
          reject(new Error('invoice_text_timeout'));
        }, 8000);
      }),
    ]);
    return result.text.length <= 18000 ? result.text : '';
  } finally {
    if (timer) clearTimeout(timer);
    await pdf.loadingTask.destroy();
  }
}
