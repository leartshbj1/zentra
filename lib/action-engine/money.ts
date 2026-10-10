import { ActionEngineError } from './types';

export const MAX_QUANTITY_MILLI = 1_000_000;
export const MAX_UNIT_PRICE_CENTS = 1_000_000_000;
export const MAX_AMOUNT_CENTS = 1_000_000_000_000;

export function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new ActionEngineError('invalid_context');
  return value;
}

/** Non-negative money, exact integer arithmetic, half-up to a cent. No float multiplication. */
export function lineNetCents(
  quantityMilli: number,
  unitPriceCents: number,
): number {
  boundedInteger(quantityMilli, 1, MAX_QUANTITY_MILLI);
  boundedInteger(unitPriceCents, 0, MAX_UNIT_PRICE_CENTS);
  const rounded =
    (BigInt(quantityMilli) * BigInt(unitPriceCents) + BigInt(500)) /
    BigInt(1000);
  if (rounded > BigInt(MAX_AMOUNT_CENTS))
    throw new ActionEngineError('invalid_context');
  return Number(rounded);
}

export function sumNetCents(values: readonly number[]): number {
  let sum = BigInt(0);
  for (const value of values) {
    boundedInteger(value, 0, MAX_AMOUNT_CENTS);
    sum += BigInt(value);
    if (sum > BigInt(MAX_AMOUNT_CENTS))
      throw new ActionEngineError('invalid_context');
  }
  return Number(sum);
}
