// PDF.js recommends its translated/polyfilled build for Safari and older
// WebViews. Keep every reader on the same API and worker version.
import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
export type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
