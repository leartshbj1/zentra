import { describe, expect, it } from 'vitest';
import { commercialDiscount, commercialLineNet, commercialPrice, commercialQuantity } from './browser-us-financial-pilot-commercial-input';

describe('commercial browser decimal input', () => {
  it('retains cents above the safe integer range and exact fractional quantities', () => {
    expect(commercialPrice('9007199254740993.01')).toBe('900719925474099301');
    expect(commercialQuantity('0.000001')).toEqual({ quantityUnits: '1', quantityScale: 6 });
    expect(commercialLineNet('0.5', '0.01', '0')).toBe('1');
    expect(commercialLineNet('3', '12.35', '10.25')).toBe('3325');
  });
  it('rejects ambiguous amounts, excessive precision and invalid quantities', () => {
    for (const value of ['1e3', '1,00', '-1', '+1', '01', ' 1', '1.001', '1.']) expect(() => commercialPrice(value)).toThrow();
    for (const value of ['0', '0.000000', '0.0000001']) expect(() => commercialQuantity(value)).toThrow();
    expect(() => commercialDiscount('100.01')).toThrow();
    expect(commercialDiscount('100.00')).toBe(10000);
  });
});
