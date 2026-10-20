// Lit la QR-facture d'un PDF ou d'une photo, entièrement sur l'appareil.
// Le PDF est rendu en image (dernières pages d'abord : la section paiement
// est en bas de la dernière page), puis le code QR est décodé.

import { decodeQrCodes, type QrImage } from './qrDecoder';
import { parseSwissQrBill, type QrBill, type QrBillProblem } from './swissQrBill';

export type QrBillReadResult =
  | Readonly<{ ok: true; bill: QrBill }>
  | Readonly<{ ok: false; reason: 'no_qr' | 'unreadable' | 'too_large' | 'unsupported_file' | QrBillProblem }>;

const MAX_BYTES = 20 * 1024 * 1024;

/** Premier code SPC valide parmi les textes décodés ; sinon le problème le plus parlant. */
export function firstQrBill(texts: readonly string[]): QrBillReadResult {
  let problem: QrBillReadResult | null = null;
  for (const text of texts) {
    const parsed = parseSwissQrBill(text);
    if (parsed.ok) return parsed;
    if (!problem || problem.ok === false && problem.reason === 'not_swiss_qr') problem = { ok: false, reason: parsed.problem };
  }
  return problem ?? { ok: false, reason: 'no_qr' };
}

function canvasImage(canvas: HTMLCanvasElement): QrImage | null {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data: data.data, width: canvas.width, height: canvas.height };
}

async function pdfImages(bytes: Uint8Array, visit: (image: QrImage) => boolean): Promise<void> {
  const { getDocument } = await import('./pdfRuntime');
  const task = getDocument({ data: bytes });
  try {
    const pdf = await task.promise;
    const pages = Array.from({ length: Math.min(pdf.numPages, 6) }, (_, index) => pdf.numPages - index);
    for (const number of pages) {
      const page = await pdf.getPage(number);
      const initial = page.getViewport({ scale: 1 });
      // Environ 200 dpi sur une page A4 : 4 pixels et plus par module pour les grandes versions.
      const scale = Math.min(4, 1700 / Math.max(1, Math.min(initial.width, initial.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      try {
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        if (!context) continue;
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const image = canvasImage(canvas);
        if (image && visit(image)) return;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function photoImage(file: Blob): Promise<QrImage | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvasImage(canvas);
  } finally {
    bitmap.close();
  }
}

/** Lit un fichier choisi par l'utilisateur (PDF, PNG, JPEG ou WebP). */
export async function readQrBillFile(file: File): Promise<QrBillReadResult> {
  if (!file.size || file.size > MAX_BYTES) return { ok: false, reason: 'too_large' };
  const texts: string[] = [];
  try {
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await pdfImages(bytes, (image) => {
        texts.push(...decodeQrCodes(image));
        return firstQrBill(texts).ok;
      });
    } else if (/\.(png|jpe?g|webp)$/i.test(file.name) || /^image\//.test(file.type)) {
      const image = await photoImage(file);
      if (image) texts.push(...decodeQrCodes(image));
    } else {
      return { ok: false, reason: 'unsupported_file' };
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  return firstQrBill(texts);
}

/** Lit des octets reçus par mail (pièce jointe), même logique que pour un fichier. */
export async function readQrBillBytes(bytes: Uint8Array, name: string): Promise<QrBillReadResult> {
  const type = /\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  return readQrBillFile(new File([bytes as BlobPart], name, { type }));
}

export function qrBillReadMessage(reason: Exclude<QrBillReadResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'no_qr': return 'Aucune QR-facture trouvée. Vérifiez que la section paiement est visible et nette.';
    case 'too_large': return 'Choisissez un PDF ou une photo de moins de 20 Mo.';
    case 'unsupported_file': return 'Choisissez un PDF ou une photo PNG, JPEG ou WebP.';
    case 'unreadable': return 'Le document n’a pas pu être ouvert. Essayez une autre copie.';
    case 'not_swiss_qr': return 'Ce code QR n’est pas une QR-facture suisse.';
    case 'invalid_iban': return 'L’IBAN de la QR-facture n’est pas valide. Vérifiez-le auprès du fournisseur.';
    case 'invalid_reference':
    case 'reference_iban_mismatch': return 'La référence de paiement de la QR-facture n’est pas valide. Vérifiez-la auprès du fournisseur.';
    case 'invalid_amount': return 'Le montant de la QR-facture n’est pas valide.';
    case 'invalid_currency': return 'La QR-facture n’est ni en CHF ni en EUR.';
    default: return 'La QR-facture est incomplète. Saisissez la facture à la main.';
  }
}
