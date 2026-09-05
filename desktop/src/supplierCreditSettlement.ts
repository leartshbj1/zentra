/** A document date or a creation timestamp is not a settlement date. */
export function creditSettlementDateError(
  date: string | null | undefined,
  minimumDate: string,
  maximumDate?: string,
): string {
  const parsed = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00Z`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    return 'Renseignez une date de compensation valide.';
  if (date! < minimumDate)
    return 'La date ne peut pas précéder l’avoir, la facture ou l’imputation à extourner.';
  if (maximumDate && date! > maximumDate)
    return 'La compensation doit avoir effectivement eu lieu : choisissez une date au plus tard aujourd’hui.';
  return '';
}
