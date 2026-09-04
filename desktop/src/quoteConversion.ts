import type { DocumentLine } from './types';
import { buildDepositLines } from './deposit';
import { documentTotals } from './utils';

export const DEFAULT_QUOTE_DEPOSIT_PERCENTAGE = '30';

export type QuoteConversionSelection = {
  depositPercentageBp: number | null;
  error: string | null;
};

/**
 * Lit un pourcentage saisi en français ou avec un point, sans conversion
 * flottante approximative. Deux décimales au maximum correspondent aux points
 * de base stockés par le moteur local.
 */
export function parseDepositPercentageBp(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const decimals = Number((match[2] ?? '').padEnd(2, '0') || '0');
  const basisPoints = whole * 100 + decimals;
  return basisPoints >= 1 && basisPoints <= 10_000 ? basisPoints : null;
}

export function quoteConversionSelection(
  depositEnabled: boolean,
  percentage: string,
): QuoteConversionSelection {
  if (!depositEnabled) return { depositPercentageBp: null, error: null };
  const depositPercentageBp = parseDepositPercentageBp(percentage);
  if (depositPercentageBp === null) {
    return {
      depositPercentageBp: null,
      error: 'Saisissez un pourcentage compris entre 0,01 et 100, avec deux décimales au maximum.',
    };
  }
  return { depositPercentageBp, error: null };
}

export function quoteConversionPreview(
  lines: DocumentLine[],
  depositPercentageBp: number | null,
) {
  const quoteTotalCents = documentTotals(lines).totalCents;
  if (depositPercentageBp === null) {
    return {
      quoteTotalCents,
      invoiceTotalCents: quoteTotalCents,
      remainingCents: 0,
    };
  }
  const invoiceTotalCents = documentTotals(
    buildDepositLines(lines, depositPercentageBp, (line, index) =>
      line.id ? `deposit-${line.id}` : `deposit-${index}`,
    ),
  ).totalCents;
  return {
    quoteTotalCents,
    invoiceTotalCents,
    remainingCents: Math.max(0, quoteTotalCents - invoiceTotalCents),
  };
}
