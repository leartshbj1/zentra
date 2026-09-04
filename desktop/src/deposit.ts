import type { DocumentLine } from './types';
import { documentLineTotals } from './utils';

export function validDepositPercentageBp(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10_000;
}

function depositLabel(percentageBp: number, description: string): string {
  const percentage = (percentageBp / 100).toLocaleString('fr-CH', {
    maximumFractionDigits: 2,
  });
  return `Acompte ${percentage} % — ${description.replace(/^Acompte\s+[\d.,]+\s*%\s*[—-]\s*/i, '')}`;
}

/**
 * Transforme les lignes de référence en lignes financières d'acompte. Les
 * liens catalogue sont volontairement retirés : une facture d'acompte ne doit
 * jamais provoquer une sortie de stock avant la livraison réelle.
 */
export function buildDepositLines(
  baseLines: DocumentLine[],
  percentageBp: number,
  idFactory: (line: DocumentLine, index: number) => string = (line) =>
    line.id || crypto.randomUUID(),
): DocumentLine[] {
  if (!validDepositPercentageBp(percentageBp)) {
    throw new RangeError('Le pourcentage d’acompte doit être compris entre 0,01 et 100 %.');
  }
  return baseLines.map((line, index) => {
    const netCents = documentLineTotals(line).netCents;
    return {
      id: idFactory(line, index),
      catalogItemId: null,
      description: depositLabel(percentageBp, line.description),
      quantity: 1,
      unit: 'acompte',
      unitPriceCents: Math.round((netCents * percentageBp) / 10_000),
      discountBp: 0,
      vatRateBp: line.vatRateBp,
    };
  });
}

/** Reconstitue au centime près la meilleure base possible d'un acompte sauvé. */
export function restoreDepositBaseLines(
  lines: DocumentLine[],
  percentageBp: number,
): DocumentLine[] {
  if (!validDepositPercentageBp(percentageBp)) return lines.map((line) => ({ ...line }));
  return lines.map((line) => ({
    ...line,
    description: line.description.replace(/^Acompte\s+[\d.,]+\s*%\s*[—-]\s*/i, ''),
    unit: line.unit === 'acompte' ? 'forfait' : line.unit,
    unitPriceCents: Math.round((line.unitPriceCents * 10_000) / percentageBp),
  }));
}
