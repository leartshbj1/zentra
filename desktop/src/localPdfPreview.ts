/// <reference types="vite/client" />

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type LocalPdfPreview = { pages: string[]; pageCount: number };

export async function renderPdfPages(source: string | Uint8Array, maxPages = 3): Promise<LocalPdfPreview> {
  const loadingTask = typeof source === 'string'
    ? getDocument({ url: source })
    : getDocument({ data: source });
  const pdfDocument = await loadingTask.promise;
  if (pdfDocument.numPages < 1) throw new Error('Le PDF ne contient aucune page lisible.');
  const pageCount = pdfDocument.numPages;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= Math.min(pdfDocument.numPages, Math.max(1, maxPages)); pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const initial = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1.4, 1800 / Math.max(initial.width, initial.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error("L'aperçu local du PDF n'a pas pu être préparé.");
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    pages.push(canvas.toDataURL('image/jpeg', 0.94));
  }
  await pdfDocument.loadingTask.destroy();
  return { pages, pageCount };
}

export async function prepareImageForAnalysis(source: string, maxDimension = 2000): Promise<string> {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("L’image n’a pas pu être préparée pour l’analyse locale.");
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels.data[index + channel];
      pixels.data[index + channel] = Math.max(0, Math.min(255, (value - 128) * 1.12 + 128));
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.94);
}
