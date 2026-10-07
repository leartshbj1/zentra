import { describe, expect, it } from 'vitest';
import { formatAddress, validateAddress } from './addresses';
import { countryConfiguration, resolveLegacyCompany, validateCompanyConfiguration } from './country-config';
import { formatDateOnly, formatTimestamp, localeForCompany } from './localization';
import { addMoney, compareMoney, decimalToMoney, formatMoney, money, multiplyMoney, subtractMoney } from './money';
import type { CompanyConfiguration, Currency, Money } from './types';

const us = {
  schemaVersion: 1, organizationId: 'org-us-1', country: 'US', currency: 'USD', language: 'en',
  timeZone: 'America/New_York', accountingBasis: 'cash', invoiceNumberPrefix: 'INV',
  address: { country: 'US', line1: '18 Main Street', line2: 'Suite 4', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201-1234' },
  ein: '12-3456789', taxConfiguration: { status: 'unconfigured' },
};
const ch = {
  schemaVersion: 1, organizationId: 'org-ch-1', country: 'CH', currency: 'CHF', language: 'fr',
  timeZone: 'Europe/Zurich', accountingBasis: 'accrual', invoiceNumberPrefix: 'FAC',
  address: { country: 'CH', line1: 'Rue du Lac 18', city: 'Genève', subdivision: 'GE', postalCode: '1201' },
  taxConfiguration: { status: 'unconfigured' },
};

describe('exact monetary arithmetic', () => {
  it('normalizes integer serialization and preserves values above safe integer range', () => {
    expect(money('USD', '-000')).toEqual({ currency: 'USD', minorUnits: '0' });
    expect(money('CHF', '000123')).toEqual({ currency: 'CHF', minorUnits: '123' });
    expect(decimalToMoney('USD', '9007199254740993.01').minorUnits).toBe('900719925474099301');
    expect(addMoney(money('USD', '900719925474099301'), money('USD', '1')).minorUnits).toBe('900719925474099302');
  });

  it.each([
    ['0', '0'], ['12', '1200'], ['12.3', '1230'], ['12.34', '1234'],
    ['1.004999', '100'], ['1.005', '101'], ['-1.005', '-101'],
    ['0.005', '1'], ['-0.005', '-1'], ['-0.004999', '0'], ['999.995', '100000'],
  ])('rounds decimal %s to %s cents half away from zero', (decimal, cents) => {
    expect(decimalToMoney('CHF', decimal).minorUnits).toBe(cents);
  });

  it.each(['', ' 1.00', '1.00 ', '1,00', '1,000.00', '1e3', '+1', '.50', '1.', '--1', 'NaN', 'Infinity'])('refuses ambiguous decimal input %s', value => {
    expect(() => decimalToMoney('USD', value)).toThrow();
  });

  it.each(['', '1.0', '+1', '1e2', ' 1', '1 ', '--1'])('refuses noninteger minor units %s', value => {
    expect(() => money('CHF', value)).toThrow();
  });

  it('does not accept numbers or unsupported currencies at a runtime boundary', () => {
    expect(() => money('EUR' as Currency, '1')).toThrow();
    expect(() => money('CHF', 1 as unknown as string)).toThrow();
    expect(() => decimalToMoney('USD', 0.1 as unknown as string)).toThrow();
    expect(() => addMoney({ currency: 'USD', minorUnits: '1', rate: 2 } as Money, money('USD', '1'))).toThrow();
    expect(() => money('CHF', '9'.repeat(1001))).toThrow();
  });

  it('keeps quotation tax and a reversing credit exact', () => {
    const net = decimalToMoney('CHF', '2880.00');
    const tax = multiplyMoney(net, '81', '1000');
    expect(tax.minorUnits).toBe('23328');
    const gross = addMoney(net, tax);
    expect(gross.minorUnits).toBe('311328');
    expect(subtractMoney(gross, tax)).toEqual(net);
    expect(addMoney(gross, multiplyMoney(gross, '-1', '1')).minorUnits).toBe('0');
  });

  it.each([
    ['1', '1', '2', '1'], ['-1', '1', '2', '-1'], ['1', '1', '-2', '-1'],
    ['-1', '-1', '-2', '-1'], ['1', '1', '3', '0'], ['-1', '1', '3', '0'],
    ['5', '1', '2', '3'], ['-5', '1', '2', '-3'], ['3', '2', '3', '2'],
    ['900719925474099301', '10', '1', '9007199254740993010'],
  ])('multiplies %s cents by %s/%s to %s', (amount, numerator, denominator, expected) => {
    expect(multiplyMoney(money('USD', amount), numerator, denominator).minorUnits).toBe(expected);
  });

  it('rejects zero denominators and decimal factors', () => {
    expect(() => multiplyMoney(money('USD', '1'), '1', '0')).toThrow();
    expect(() => multiplyMoney(money('USD', '1'), '1', '-000')).toThrow();
    expect(() => multiplyMoney(money('USD', '1'), '0.5', '1')).toThrow();
  });

  it('refuses every arithmetic/comparison attempt to mix currencies', () => {
    const first = money('CHF', '100');
    const second = money('USD', '100');
    expect(() => addMoney(first, second)).toThrow();
    expect(() => subtractMoney(first, second)).toThrow();
    expect(() => compareMoney(first, second)).toThrow();
    expect(compareMoney(money('USD', '-1'), money('USD', '0'))).toBe(-1);
    expect(compareMoney(money('USD', '001'), money('USD', '1'))).toBe(0);
    expect(compareMoney(money('USD', '900719925474099302'), money('USD', '900719925474099301'))).toBe(1);
  });

  it('formats exact large values and signs below one whole unit', () => {
    expect(formatMoney(money('USD', '900719925474099301'), 'en-US')).toBe('$9,007,199,254,740,993.01');
    expect(formatMoney(money('USD', '-1'), 'en-US')).toBe('-$0.01');
    expect(formatMoney(money('USD', '0'), 'en-US')).toBe('$0.00');
    expect(formatMoney(money('CHF', '311328'), 'de-CH')).toMatch(/3['’]113\.28/);
    expect(formatMoney(money('USD', '-109'), 'de-CH')).toContain('-');
    expect(formatMoney(money('USD', '1'), 'ar-EG')).toContain('٠٫٠١');
  });

  it('does not mutate caller amounts', () => {
    const original = { currency: 'CHF' as const, minorUnits: '00012' };
    expect(addMoney(original, money('CHF', '1')).minorUnits).toBe('13');
    expect(original.minorUnits).toBe('00012');
    expect(Object.isFrozen(money('CHF', '12'))).toBe(true);
  });

  it('rejects a missing display locale and inherited monetary fields', () => {
    expect(() => formatMoney(money('USD', '1'), undefined as unknown as string)).toThrow();
    expect(() => formatMoney(money('USD', '1'), '')).toThrow();
    expect(() => addMoney(Object.create(money('USD', '1')) as Money, money('USD', '1'))).toThrow();
  });
});

describe('explicit company configuration', () => {
  it('accepts CH and US with the same versioned contract and preserves literal content', () => {
    const swiss = validateCompanyConfiguration(ch);
    const american = validateCompanyConfiguration(us);
    expect(swiss.country).toBe('CH');
    expect(swiss.address.city).toBe('Genève');
    expect(american.currency).toBe('USD');
    expect(american.ein).toBe('12-3456789');
    expect(JSON.parse(JSON.stringify(american))).toEqual(us);
    expect(Object.isFrozen(american)).toBe(true);
    expect(Object.isFrozen(american.address)).toBe(true);
    expect(Object.isFrozen(american.taxConfiguration)).toBe(true);
    expect(us.taxConfiguration.status).toBe('unconfigured');
  });

  it('permits an omitted EIN without inventing one', () => {
    const { ein: _ein, ...withoutEin } = us;
    expect(validateCompanyConfiguration(withoutEin)).not.toHaveProperty('ein');
    expect(() => validateCompanyConfiguration({ ...us, ein: undefined })).toThrow();
    expect(() => validateCompanyConfiguration({ ...us, ein: '123456789' })).toThrow();
    expect(() => validateCompanyConfiguration({ ...ch, ein: '12-3456789' })).toThrow();
  });

  it.each([
    { schemaVersion: 2 }, { schemaVersion: '1' }, { country: 'CA' }, { country: undefined },
    { currency: 'CHF' }, { language: 'es' }, { organizationId: '' }, { organizationId: 'org us' },
    { accountingBasis: undefined }, { accountingBasis: 'automatic' }, { invoiceNumberPrefix: '../INV' },
    { timeZone: 'Europe/Zurich' }, { timeZone: 'EST' }, { timeZone: 'Etc/UTC' },
  ])('refuses inconsistent or missing fields %j', override => {
    expect(() => validateCompanyConfiguration({ ...us, ...override })).toThrow();
  });

  it('refuses unknown fields at every configuration level', () => {
    expect(() => validateCompanyConfiguration({ ...us, secret: 'not-allowed' })).toThrow();
    expect(() => validateCompanyConfiguration({ ...us, address: { ...us.address, latitude: '0' } })).toThrow();
    expect(() => validateCompanyConfiguration({ ...us, taxConfiguration: { status: 'configured', rate: '8.1' } })).toThrow();
    expect(() => validateCompanyConfiguration({ ...us, [Symbol('hidden')]: 'x' })).toThrow();
    expect(() => validateCompanyConfiguration([])).toThrow();
    expect(() => validateCompanyConfiguration(null)).toThrow();
    expect(() => validateCompanyConfiguration(new Date())).toThrow();
    expect(() => validateCompanyConfiguration(Object.create(us))).toThrow();
  });

  it('distinguishes configuration status from an implemented or certified tax engine', () => {
    expect(validateCompanyConfiguration({ ...us, taxConfiguration: { status: 'configured' } }).taxConfiguration).toEqual({ status: 'configured' });
    expect(() => validateCompanyConfiguration({ ...us, taxConfiguration: { status: 'verified' } })).toThrow();
    expect(() => validateCompanyConfiguration({ ...us, taxConfiguration: {} })).toThrow();
  });

  it('refuses country and address mismatches and invalid country-specific subdivisions/postcodes', () => {
    expect(() => validateCompanyConfiguration({ ...us, address: ch.address })).toThrow();
    expect(() => validateAddress({ ...us.address, subdivision: 'GE' }, 'US')).toThrow();
    expect(() => validateAddress({ ...ch.address, subdivision: 'NY' }, 'CH')).toThrow();
    expect(() => validateAddress({ ...us.address, postalCode: '1201' }, 'US')).toThrow();
    expect(() => validateAddress({ ...ch.address, postalCode: '11201' }, 'CH')).toThrow();
    expect(() => validateAddress({ ...ch.address, postalCode: '0000' }, 'CH')).toThrow();
    expect(() => validateAddress({ ...us.address, city: ' Brooklyn' }, 'US')).toThrow();
  });

  it('formats address structure without translating user content', () => {
    expect(formatAddress(validateAddress(ch.address, 'CH'))).toEqual(['Rue du Lac 18', '1201 Genève', 'CH']);
    expect(formatAddress(validateAddress(us.address, 'US'))).toEqual(['18 Main Street', 'Suite 4', 'Brooklyn, NY 11201-1234', 'US']);
    expect(validateAddress({ ...us.address, postalCode: '00501' }, 'US').postalCode).toBe('00501');
  });

  it('keeps the central country registry deeply frozen and rejects unsupported countries', () => {
    const profile = countryConfiguration('US');
    expect(profile.currency).toBe('USD');
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.locales)).toBe(true);
    expect(Object.isFrozen(profile.timeZones)).toBe(true);
    expect(Object.isFrozen(profile.addressSubdivisions)).toBe(true);
    expect(() => countryConfiguration('CA' as 'US')).toThrow();
    for (const zone of profile.timeZones) expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
  });

  it('leaves legacy jurisdiction unknown and never changes legacy behavior or input data', () => {
    expect(resolveLegacyCompany('legacy-org')).toEqual({ organizationId: 'legacy-org', country: 'unknown', requiresAdministrativeReview: true, preserveLegacyBehavior: true });
    expect(Object.isFrozen(resolveLegacyCompany('legacy-org'))).toBe(true);
    expect(() => resolveLegacyCompany('')).toThrow();
  });
});

describe('localization is independent of jurisdiction and dates', () => {
  it('maps CH display regions by language and all US display regions to en-US', () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const swiss = validateCompanyConfiguration({ ...ch, language });
      const american = validateCompanyConfiguration({ ...us, language });
      expect(localeForCompany(swiss)).toBe(language + '-CH');
      expect(localeForCompany(american)).toBe('en-US');
      expect(american.country).toBe('US');
      expect(american.currency).toBe('USD');
      expect(american.address.line1).toBe('18 Main Street');
    }
  });

  it('renders civil dates on their own day and validates leap years', () => {
    expect(formatDateOnly('2026-01-01', 'en-US')).toBe('01/01/2026');
    expect(formatDateOnly('2024-02-29', 'de-CH')).toBe('29.02.2024');
    expect(formatDateOnly('2000-02-29', 'en-US')).toBe('02/29/2000');
    for (const value of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '0000-01-01', '2026-01-01T00:00:00Z']) {
      expect(() => formatDateOnly(value, 'en-US')).toThrow();
    }
  });

  it('shifts timestamp output by its explicit zone but never the corresponding civil date', () => {
    expect(formatTimestamp('2026-01-01T00:30:00Z', 'en-US', 'America/Los_Angeles')).toContain('12/31/2025');
    expect(formatTimestamp('2026-01-01T01:30:00+01:00', 'en-US', 'America/Los_Angeles')).toBe(formatTimestamp('2026-01-01T00:30:00Z', 'en-US', 'America/Los_Angeles'));
    expect(formatDateOnly('2026-01-01', 'en-US')).toBe('01/01/2026');
  });

  it('renders real DST transitions using IANA rules rather than fixed offsets', () => {
    expect(formatTimestamp('2026-03-08T06:59:59Z', 'en-US', 'America/New_York')).toContain('01:59:59');
    expect(formatTimestamp('2026-03-08T07:00:00Z', 'en-US', 'America/New_York')).toContain('03:00:00');
    expect(formatTimestamp('2026-03-29T00:59:59Z', 'de-CH', 'Europe/Zurich')).toContain('01:59:59');
    expect(formatTimestamp('2026-03-29T01:00:00Z', 'de-CH', 'Europe/Zurich')).toContain('03:00:00');
  });

  it.each(['2026-01-01', '2026-01-01T00:00:00', '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00'])('rejects ambiguous or invalid timestamp %s', value => {
    expect(() => formatTimestamp(value, 'en-US', 'America/New_York')).toThrow();
  });

  it('refuses implicit or unsupported time zones even with a valid timestamp', () => {
    expect(() => formatTimestamp('2026-01-01T00:00:00Z', 'en-US', 'EST')).toThrow();
    expect(() => formatTimestamp('2026-01-01T00:00:00Z', 'en-US', 'Europe/London')).toThrow();
    expect(() => localeForCompany({ ...us, currency: 'CHF' } as unknown as CompanyConfiguration)).toThrow();
    expect(() => formatDateOnly('2026-01-01', undefined as unknown as string)).toThrow();
    expect(() => formatTimestamp('2026-01-01T00:00:00Z', '', 'America/New_York')).toThrow();
  });
});
