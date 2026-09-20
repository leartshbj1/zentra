// Deliberately conservative: identifiers are matched internally, never sent to the provider.
export function sanitizeText(input: unknown, limit = 3000): string {
  if (typeof input !== 'string') return '';
  return (
    input
      .replace(
        /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g,
        '[secret]',
      )
      .replace(
        /\b(?:bearer\s+|(?:sk|pk|rk)_(?:live|test)_|eyJ)[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
        '[secret]',
      )
      .replace(
        /((?:password|passwd|mot de passe|api[_ -]?key|secret|token|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
        '$1[secret]',
      )
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[e-mail]')
      .replace(
        /\b[A-Z]{2}\s?\d{2}(?:\s?[A-Z0-9]){11,30}\b/gi,
        '[compte bancaire]',
      )
      .replace(/\b756[.\s-]?\d{4}[.\s-]?\d{4}[.\s-]?\d{2}\b/g, '[AVS]')
      .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[numéro]')
      .replace(/https?:\/\/[^\s<>]+/gi, '[lien]')
      // eslint-disable-next-line no-control-regex -- Strip non-printing controls before provider transmission.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .slice(0, limit)
      .trim()
  );
}
const DENIED =
  /(?:secret|password|passwd|token|authorization|api.?key|iban|email|address|phone|social|avs|name|document|attachment|file|path)/i;
export function sanitizeState(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 24)) {
    if (DENIED.test(key)) continue;
    if (typeof value === 'string') output[key] = sanitizeText(value);
    else if (typeof value === 'number' && Number.isFinite(value))
      output[key] = value;
    else if (typeof value === 'boolean') output[key] = value;
    else if (Array.isArray(value))
      output[key] = value
        .slice(0, 10)
        .filter((v) => typeof v === 'string')
        .map((v) => sanitizeText(v, 180));
  }
  return output;
}
