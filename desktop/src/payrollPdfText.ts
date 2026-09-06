/// <reference types="vite/client" />

import { getDocument } from './pdfRuntime';
import { normalizePayrollPdfTextItems } from './payrollPdfTextUtils';


export type PayrollPdfTextByPage = {
  pageCount: number;
  pages: string[];
};

/** Extrait la couche texte page par page, entièrement dans le WebView local. */
export async function extractPayrollPdfTextByPage(
  source: Uint8Array,
  maxPages = 12,
): Promise<PayrollPdfTextByPage> {
  const loadingTask = getDocument({ data: source });
  const pdfDocument = await loadingTask.promise;
  try {
    if (pdfDocument.numPages < 1) throw new Error('Le PDF ne contient aucune page lisible.');
    const pages: string[] = [];
    const limit = Math.min(pdfDocument.numPages, Math.max(1, maxPages));
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      pages.push(normalizePayrollPdfTextItems(content.items, {
        width: viewport.width,
        height: viewport.height,
      }));
      page.cleanup();
    }
    return { pageCount: pdfDocument.numPages, pages };
  } finally {
    await loadingTask.destroy();
  }
}
