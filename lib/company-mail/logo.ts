import { AccountPublicError } from '@/lib/account-security';

export type MailLogo = {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
};

/** The native composer produces a resized PNG, never a remote URL or arbitrary
 * HTML. Bound both the encoded file and IHDR dimensions before provider upload.
 * This checks the transport envelope, not the full PNG decoder or its CRCs. */
export function mailLogo(value: unknown): MailLogo | undefined {
  if (value === undefined || value === null) return undefined;
  const invalid = () =>
    new AccountPublicError(
      'Le logo de l’e-mail est incomplet. Réimportez-le dans les paramètres de l’entreprise.',
    );
  const prefix = 'data:image/png;base64,';
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    value.length > 350000
  )
    throw invalid();
  const encoded = value.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded))
    throw invalid();
  const padding = encoded.indexOf('=');
  if (
    padding !== -1 &&
    (padding < encoded.length - 2 || /[^=]/.test(encoded.slice(padding)))
  )
    throw invalid();
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (
    bytes.length < 45 ||
    bytes.length > 256 * 1024 ||
    [137, 80, 78, 71, 13, 10, 26, 10].some((n, i) => bytes[i] !== n)
  )
    throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(8) !== 13 ||
    new TextDecoder().decode(bytes.subarray(12, 16)) !== 'IHDR'
  )
    throw invalid();
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 360 || height > 120) throw invalid();
  let offset = 8,
    hasData = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw invalid();
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    if (type === 'IHDR' && offset !== 8) throw invalid();
    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) throw invalid();
      ended = true;
    }
    offset = end;
  }
  if (!hasData || !ended || offset !== bytes.length) throw invalid();
  return { bytes, width, height };
}
