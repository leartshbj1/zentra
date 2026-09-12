import { shareMobileExport } from './mobileRuntime';

export type PdfExportReceipt = { path: string; deliveryWarning?: string };

/** File creation has succeeded. Sharing failure must retain the existing file. */
export async function deliverPdfExport<T extends { path: string }>(result: T): Promise<T & PdfExportReceipt> {
  try {
    await shareMobileExport(result.path);
    return result;
  } catch {
    return { ...result, deliveryWarning: 'Le PDF a été créé, mais le partage n’a pas abouti. Utilisez « Partager le PDF » pour réessayer.' };
  }
}
