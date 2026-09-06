import { createWorker, PSM } from 'tesseract.js';
import { payrollAiImageBlobFromDataUrl } from './payrollAiImageSource';
import { payrollOcrRows } from './payrollOcrRows';

export async function readPayslipImages(
  images: string[],
  assetBase: string,
  onProgress: (label: string, percent: number | null) => void,
): Promise<{ text: string; corroboratingText: string }> {
  if (!images.length) return { text: '', corroboratingText: '' };
  const worker = await createWorker('fra+eng', 1, {
    workerPath: new URL('ocr/worker.min.js', assetBase).href,
    corePath: new URL('ocr/', assetBase).href,
    langPath: new URL('ocr/', assetBase).href,
    gzip: false,
    logger: (event) => onProgress('Lecture du document', Math.round(event.progress * 100)),
  });
  try {
    const pages: string[] = [];
    const confirmations: string[] = [];
    for (const source of images) {
      // Decode locally: no fetch(data:) and no document sent to any server.
      const image = payrollAiImageBlobFromDataUrl(source);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      const result = await worker.recognize(image, {}, { text: true, tsv: true });
      pages.push(payrollOcrRows(result.data.tsv ?? '', result.data.text));
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      const confirmation = await worker.recognize(image, {}, { text: true, tsv: true });
      confirmations.push(payrollOcrRows(confirmation.data.tsv ?? '', confirmation.data.text));
    }
    return { text: pages.join('\n\n'), corroboratingText: confirmations.join('\n\n') };
  } finally {
    await worker.terminate();
  }
}
