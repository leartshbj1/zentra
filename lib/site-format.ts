/**
 * Formatters used by client components that are also rendered on the server.
 *
 * Node and Chromium do not always use the same ICU separator for fr-CH
 * (apostrophe versus narrow no-break space). Keeping the Swiss display rule
 * explicit prevents a hydration mismatch while preserving a readable amount.
 */
export function formatChfCents(valueCents: number) {
  if (!Number.isSafeInteger(valueCents)) return 'Montant à contrôler';
  const sign = valueCents < 0 ? '−' : '';
  const absolute = Math.abs(valueCents);
  const whole = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '’');
  const decimals = (absolute % 100).toString().padStart(2, '0');
  return `${sign}${whole}.${decimals}\u00a0CHF`;
}

export function formatPercentFromBasisPoints(valueBasisPoints: number) {
  if (!Number.isSafeInteger(valueBasisPoints)) return 'Taux à contrôler';
  const fixed = (valueBasisPoints / 100).toFixed(2);
  return `${fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1').replace('.', ',')} %`;
}
