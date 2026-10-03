/** Match the existing positive half-up ratio, using exact integer arithmetic
 * only when its intermediate product is unsafe but its result is representable.
 * Fractional, negative, non-finite and already-unsafe operands keep their prior
 * Number behavior; this helper cannot recover integers lost during decoding. */
export function roundedIntegerProductRatio(left: number, right: number, denominator: number): number {
  const numerator = left * right;
  const half = denominator / 2;
  const rounded = Math.floor((numerator + half) / denominator);
  if (
    Number.isSafeInteger(numerator + half) ||
    !Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 ||
    !Number.isSafeInteger(denominator) || denominator <= 0 || denominator % 2 !== 0
  ) return rounded;
  const exact = (BigInt(left) * BigInt(right) + BigInt(half)) / BigInt(denominator);
  return exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : rounded;
}
