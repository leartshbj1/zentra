const PAYROLL_AI_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

// Les aperçus sont compressés en JPEG avant d'atteindre le Worker. La limite
// évite qu'une URL data malformée monopolise la mémoire pendant le décodage.
export const PAYROLL_AI_MAX_ENCODED_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Transforme une image déjà locale en Blob sans passer par fetch().
 *
 * Dans l'application Tauri, les pages PDF arrivent sous forme d'URL data et
 * connect-src n'autorise volontairement pas le schéma data:. Les confier sous
 * forme de chaîne à Transformers.js déclencherait donc un fetch bloqué par la
 * CSP. Un Blob reste entièrement local et est accepté directement par
 * RawImage/load_image.
 */
export function payrollAiImageBlobFromDataUrl(source: string): Blob {
  const separator = source.indexOf(',');
  if (separator <= 5 || !source.startsWith('data:')) {
    throw new Error("L’image d’analyse doit provenir du document local préparé par Zentra.");
  }

  const metadata = source.slice(5, separator).toLowerCase();
  const parts = metadata.split(';');
  const mimeType = parts[0];
  if (!PAYROLL_AI_IMAGE_MIME_TYPES.has(mimeType) || !parts.slice(1).includes('base64')) {
    throw new Error("Le format de l’image locale n’est pas pris en charge par l’analyse.");
  }

  const encoded = source.slice(separator + 1);
  if (!encoded || encoded.length > Math.ceil(PAYROLL_AI_MAX_ENCODED_IMAGE_BYTES * 4 / 3) + 4) {
    throw new Error("L’image locale est vide ou trop volumineuse pour l’analyse.");
  }

  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("L’image locale est illisible; régénérez son aperçu puis réessayez.");
  }
  if (!binary.length || binary.length > PAYROLL_AI_MAX_ENCODED_IMAGE_BYTES) {
    throw new Error("L’image locale est vide ou trop volumineuse pour l’analyse.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType });
}
