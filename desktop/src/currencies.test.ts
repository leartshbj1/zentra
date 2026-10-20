import { describe, expect, it } from 'vitest';
import { formatRate, parseRate, rateOn, suggestedRateDate, toChf, type ExchangeRate } from './currencies';

const rate = (rateDate: string, chfPerUnitMicro: number): ExchangeRate => ({ currency: 'EUR', rateDate, chfPerUnitMicro, source: 'manual', used: false });

describe('currencies', () => {
  it('reads a rate without floating point', () => {
    expect(parseRate('0.9412')).toBe(941_200);
    expect(parseRate(' 0,941234 ')).toBe(941_234);
    expect(parseRate('1')).toBe(1_000_000);
    for (const bad of ['', 'abc', '0', '0.0000001', '-1', '1.2.3', '10000']) expect(parseRate(bad)).toBeNull();
  });

  it('shows at least four decimals', () => {
    expect(formatRate(941_200)).toBe('0.9412');
    expect(formatRate(941_234)).toBe('0.941234');
    expect(formatRate(1_000_000)).toBe('1.0000');
  });

  it('rounds like the native app', () => {
    // Mêmes valeurs que le test natif currencies::tests.
    expect(toChf(108_100, 941_234)).toBe(101_747);
    expect(toChf(100_000, 941_234)).toBe(94_123);
    expect(toChf(8_100, 941_234)).toBe(7_624);
    expect(toChf(108_100, 950_000)).toBe(102_695);
    expect(toChf(1, 500_000)).toBe(1);
    expect(toChf(-1, 500_000)).toBe(-1);
    expect(toChf(1, 499_999)).toBe(0);
  });

  it('applies a rate for 31 days', () => {
    const rates = [rate('2026-09-01', 941_234), rate('2026-10-01', 950_000)];
    expect(rateOn(rates, 'EUR', '2026-09-30')?.chfPerUnitMicro).toBe(941_234);
    expect(rateOn(rates, 'EUR', '2026-10-05')?.chfPerUnitMicro).toBe(950_000);
    expect(rateOn(rates, 'EUR', '2026-11-01')?.chfPerUnitMicro).toBe(950_000);
    expect(rateOn(rates, 'EUR', '2026-11-02')).toBeNull();
    expect(rateOn(rates, 'EUR', '2026-08-31')).toBeNull();
  });

  it('suggests the first day of the oldest waiting month', () => {
    expect(suggestedRateDate([{ currency: 'EUR', entries: 3, firstDate: '2026-09-17', lastDate: '2026-10-02' }], '2026-10-20')).toBe('2026-09-01');
    expect(suggestedRateDate([], '2026-10-20')).toBe('2026-10-01');
  });
});
