export type DocumentNumberKind = 'quantity' | 'price' | 'discount' | 'deposit';

/** Parse the written value before conversion, without rounding away excess decimals. */
export function documentNumberEntry(raw: string, kind: DocumentNumberKind): { value: number | null; error: string } {
  const quantity = kind === 'quantity', percent = kind === 'discount' || kind === 'deposit';
  const digits = quantity ? 4 : 2;
  const label = quantity ? 'la quantité' : kind === 'price' ? 'le prix unitaire' : kind === 'deposit' ? 'le pourcentage de l’acompte' : 'la remise';
  const text = raw.trim();
  if (!text && kind === 'discount') return { value: 0, error: '' };
  if (text.length > 64) return { value: null, error: `La valeur de ${label} est trop longue. Vérifiez le nombre saisi.` };
  if (!text) return { value: null, error: kind === 'price' ? 'Indiquez le prix unitaire, ou 0 pour une prestation offerte.' : `Indiquez ${label}.` };
  // Spaces and Swiss apostrophes are accepted only in groups of three digits.
  const pattern = new RegExp(`^(?:[0-9]+|[0-9]{1,3}(?:['’ \\u00a0\\u202f][0-9]{3})+)(?:[.,][0-9]{1,${digits}})?$`);
  if (!pattern.test(text)) return { value: null, error: `Vérifiez ${label} : utilisez un nombre positif, avec ${digits} décimales au maximum. La virgule et le point sont acceptés.` };
  const [whole, fraction = ''] = text.replace(/['’ \u00a0\u202f]/g, '').replace(',', '.').split('.');
  const scaled = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'));
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return { value: null, error: `La valeur de ${label} est trop grande. Vérifiez le nombre saisi.` };
  const value = quantity ? Number(scaled) / 10000 : Number(scaled);
  if ((quantity || kind === 'deposit') && value === 0) return { value: null, error: quantity ? 'La quantité doit être supérieure à zéro.' : 'L’acompte doit être compris entre 0,01 et 100 %.' };
  if (percent && value > 10000) return { value: null, error: kind === 'deposit' ? 'L’acompte doit être compris entre 0,01 et 100 %.' : 'La remise doit être comprise entre 0 et 100 %.' };
  return { value, error: '' };
}
