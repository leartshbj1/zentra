import { describe, it, expect } from 'vitest';
import {
  applyBillingPreset,
  financeTotalsAvailable,
  financePeriod,
  vatSetupPresets,
} from './financeClarity';
import { initialOnboardingSettings } from './onboardingDraft';
import type { IncomeStatementReport } from './types';
describe('Finance configuration without implicit tax changes', () => {
  it.each(['short', 'standard', 'extended'] as const)(
    'only changes commercial terms: %s',
    (id) => {
      const initial = structuredClone(initialOnboardingSettings);
      initial.organization.vatRegistered = true;
      initial.organization.vatNumber = 'CHE-123.456.789 TVA';
      initial.billing.iban = 'CH9300762011623852957';
      initial.billing.nextInvoiceNumber = 321;
      initial.billing.paymentTermsDays = 17;
      initial.billing.quoteValidityDays = 19;
      const before = structuredClone(initial),
        result = applyBillingPreset(initial, id);
      expect(initial).toEqual(before);
      expect({
        ...result,
        billing: {
          ...result.billing,
          paymentTermsDays: 17,
          quoteValidityDays: 19,
        },
      }).toEqual(before);
      expect([14, 30, 60]).toContain(result.billing.paymentTermsDays);
    },
  );
  it('does not invent a TDFN rate or a tax authorization', () => {
    for (const preset of vatSetupPresets) {
      expect(preset).not.toHaveProperty('tdfnRateBp');
      expect(preset).not.toHaveProperty('afcAuthorizationConfirmed');
    }
    expect(vatSetupPresets.find((p) => p.id === 'tdfn')).toMatchObject({
      method: 'simple_tax_rate',
      grossOrNet: 'gross',
    });
  });
  it('refuses an unknown commercial preset', () =>
    expect(() =>
      applyBillingPreset(initialOnboardingSettings, 'unknown' as never),
    ).toThrow());
});
describe('Readable financial totals', () => {
  const report = {
    currency: {
      baseCurrency: 'CHF',
      singleCurrency: true,
      exchangeRatesApplied: false,
    },
    revenueCents: 500,
    expenseCents: 900,
    profitCents: -400,
  } as IncomeStatementReport;
  it('permits a loss and a genuine zero', () => {
    expect(financeTotalsAvailable(report)).toBe(true);
    expect(financeTotalsAvailable({ ...report, profitCents: 0 })).toBe(true);
  });
  it('hides missing reports and unconverted currencies', () => {
    expect(financeTotalsAvailable(null)).toBe(false);
    expect(
      financeTotalsAvailable({
        ...report,
        currency: { ...report.currency, singleCurrency: false },
      }),
    ).toBe(false);
    expect(
      financeTotalsAvailable({
        ...report,
        currency: {
          ...report.currency,
          singleCurrency: false,
          exchangeRatesApplied: true,
        },
      }),
    ).toBe(true);
  });
  it('refuses unsafe or nonnumeric totals', () => {
    for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5])
      expect(financeTotalsAvailable({ ...report, profitCents: value })).toBe(
        false,
      );
  });
});
describe('Calendar shortcuts', () => {
  it('handles a leap year and quarter boundaries', () => {
    expect(financePeriod('month', '2028-02-10')).toEqual({
      dateFrom: '2028-02-01',
      dateTo: '2028-02-29',
    });
    expect(financePeriod('quarter', '2026-12-10')).toEqual({
      dateFrom: '2026-10-01',
      dateTo: '2026-12-31',
    });
    expect(financePeriod('year', '2026-09-10')).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
    });
  });
  it('clears both dates when merged with the current period', () =>
    expect({
      ...financePeriod('month', '2026-09-10'),
      ...financePeriod('all', '2026-09-10'),
    }).toEqual({ dateFrom: undefined, dateTo: undefined }));
});
