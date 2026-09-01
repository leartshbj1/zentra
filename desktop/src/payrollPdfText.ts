/// <reference types="vite/client" />

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { normalizePayrollPdfTextItems } from './payrollPdfTextUtils';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
      pages.push(normalizePayrollPdfTextItems(content.items));
      page.cleanup();
    }
    return { pageCount: pdfDocument.numPages, pages };
  } finally {
    await loadingTask.destroy();
  }
}
