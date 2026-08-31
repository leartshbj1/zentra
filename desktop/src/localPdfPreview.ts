/// <reference types="vite/client" />

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function renderFirstPdfPage(source: string | Uint8Array): Promise<string> {
  const loadingTask = typeof source === 'string'
    ? getDocument({ url: source })
    : getDocument({ data: source });
  const pdfDocument = await loadingTask.promise;
  if (pdfDocument.numPages < 1) throw new Error('Le PDF ne contient aucune page lisible.');
  const page = await pdfDocument.getPage(1);
  const initial = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(1.4, 1800 / Math.max(initial.width, initial.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error("L'aperçu local du PDF n'a pas pu être préparé.");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.94);
  await pdfDocument.loadingTask.destroy();
  return dataUrl;
}
