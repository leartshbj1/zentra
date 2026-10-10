import { describe, expect, it } from 'vitest';
import { lineNetCents, sumNetCents, MAX_AMOUNT_CENTS } from './money';

describe('Action Engine exact money (non-negative draft lines)', () => {
  it.each([
    [3000, 12345, 37035],
    [500, 1, 1],
    [499, 1, 0],
    [1001, 999, 1000],
    [125, 199, 25],
    [1000000, 1000000000, 1000000000000],
    [1, 0, 0],
  ])('rounds %i milli × %i cents to %i cents', (quantity, price, expected) => {
    expect(lineNetCents(quantity, price)).toBe(expected);
  });
  it.each([
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    0.5,
    1000001,
    Number.MAX_SAFE_INTEGER,
  ])('refuses invalid quantity %s', (value) => {
    expect(() => lineNetCents(value, 100)).toThrow('invalid_context');
  });
  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    1000000001,
    Number.MAX_SAFE_INTEGER,
  ])('refuses invalid price %s', (value) => {
    expect(() => lineNetCents(1000, value)).toThrow('invalid_context');
  });
  it('bounds total, without saturation or silent loss of precision', () => {
    expect(sumNetCents([MAX_AMOUNT_CENTS - 1, 1])).toBe(MAX_AMOUNT_CENTS);
    expect(sumNetCents([])).toBe(0);
    expect(() => sumNetCents([MAX_AMOUNT_CENTS, 1])).toThrow('invalid_context');
    expect(() => sumNetCents([1.5])).toThrow('invalid_context');
  });
  it('matches rational half-up for a deterministic range of fractional quantities', () => {
    for (let quantity = 1; quantity <= 1000000; quantity += 997) {
      const price = (quantity * 7919) % 1000000001;
      expect(lineNetCents(quantity, price)).toBe(
        Number((BigInt(quantity) * BigInt(price) + BigInt(500)) / BigInt(1000)),
      );
    }
  });
});
