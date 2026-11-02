import { describe, expect, it } from 'vitest';
import { formatRate, parseRate, suggestedRateDate } from './currencies';


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



  it('suggests the first day of the oldest waiting month', () => {
    expect(suggestedRateDate([{ currency: 'EUR', entries: 3, firstDate: '2026-09-17', lastDate: '2026-10-02' }], '2026-10-20')).toBe('2026-09-01');
    expect(suggestedRateDate([], '2026-10-20')).toBe('2026-10-01');
  });
});
