import { countrySubdivisions, validateAddress } from './addresses';
import type { CompanyConfiguration, CompanyLanguage, CountryCode, CountryConfiguration, LegacyCompanyResolution } from './types';

const registry = Object.freeze({
  CH: Object.freeze({
    country: 'CH', currency: 'CHF', minorUnitDigits: 2,
    locales: Object.freeze({ fr: 'fr-CH', de: 'de-CH', it: 'it-CH', en: 'en-CH' }),
    timeZones: Object.freeze(['Europe/Zurich']),
    addressSubdivisions: countrySubdivisions.CH,
  } satisfies CountryConfiguration<'CH'>),
  US: Object.freeze({
    country: 'US', currency: 'USD', minorUnitDigits: 2,
    locales: Object.freeze({ fr: 'en-US', de: 'en-US', it: 'en-US', en: 'en-US' }),
    timeZones: Object.freeze([
      'America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
      'America/Indiana/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
      'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Vevay',
      'America/Chicago', 'America/Indiana/Tell_City', 'America/Indiana/Knox', 'America/Menominee',
      'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah',
      'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles',
      'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Metlakatla',
      'America/Yakutat', 'America/Nome', 'America/Adak', 'Pacific/Honolulu',
    ]),
    addressSubdivisions: countrySubdivisions.US,
  } satisfies CountryConfiguration<'US'>),
});

export function countryConfiguration<C extends CountryCode>(code: C): CountryConfiguration<C> {
  if (code !== 'CH' && code !== 'US') throw new TypeError('Unsupported company country');
  return registry[code] as CountryConfiguration<C>;
}

function plainObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError(label + ' must be a plain object');
  }
  return input as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.includes(key))) {
    throw new TypeError('Unknown ' + label + ' field');
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function text(input: unknown, label: string, maximum: number): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > maximum || input !== input.trim() || hasControlCharacter(input)) {
    throw new TypeError('Invalid ' + label);
  }
  return input;
}

function organizationId(input: unknown): string {
  const value = text(input, 'organizationId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new TypeError('Invalid organizationId');
  return value;
}

export function validateCompanyConfiguration(input: unknown): CompanyConfiguration {
  const fields = plainObject(input, 'Company configuration');
  exactKeys(fields, ['schemaVersion', 'organizationId', 'country', 'currency', 'language', 'timeZone', 'address', 'ein', 'accountingBasis', 'invoiceNumberPrefix', 'taxConfiguration'], 'company configuration');
  if (['schemaVersion', 'organizationId', 'country', 'currency', 'language', 'timeZone', 'address', 'accountingBasis', 'invoiceNumberPrefix', 'taxConfiguration'].some(key => !Object.hasOwn(fields, key))) {
    throw new TypeError('Missing required company configuration field');
  }
  if (fields.schemaVersion !== 1) throw new TypeError('Unsupported company configuration schemaVersion');
  if (fields.country !== 'CH' && fields.country !== 'US') throw new TypeError('Company country must be explicit');
  const profile = countryConfiguration(fields.country);
  if (fields.currency !== profile.currency) throw new TypeError('Company currency must match country');
  if (!['fr', 'de', 'it', 'en'].includes(fields.language as string) || typeof fields.language !== 'string') {
    throw new TypeError('Unsupported company language');
  }
  const timeZone = text(fields.timeZone, 'timeZone', 80);
  if (!profile.timeZones.includes(timeZone)) throw new TypeError('Time zone is not allowed for company country');
  // Also fail on a runtime whose IANA database cannot render the selected zone.
  new Intl.DateTimeFormat('en-US', { timeZone });
  const address = validateAddress(fields.address, fields.country);
  if (fields.accountingBasis !== 'cash' && fields.accountingBasis !== 'accrual') throw new TypeError('Accounting basis must be explicitly chosen');
  const invoiceNumberPrefix = text(fields.invoiceNumberPrefix, 'invoiceNumberPrefix', 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(invoiceNumberPrefix)) throw new TypeError('Invalid invoiceNumberPrefix');
  const tax = plainObject(fields.taxConfiguration, 'Tax configuration');
  exactKeys(tax, ['status'], 'tax configuration');
  if (!Object.hasOwn(tax, 'status')) throw new TypeError('Missing tax configuration status');
  if (tax.status !== 'unconfigured' && tax.status !== 'configured') throw new TypeError('Invalid tax configuration status');
  let ein: string | undefined;
  if (Object.hasOwn(fields, 'ein')) {
    if (fields.country !== 'US') throw new TypeError('EIN is only supported for US companies');
    ein = text(fields.ein, 'ein', 10);
    if (!/^[0-9]{2}-[0-9]{7}$/.test(ein)) throw new TypeError('EIN must use NN-NNNNNNN syntax');
  }
  const configuration = {
    schemaVersion: 1 as const,
    organizationId: organizationId(fields.organizationId),
    country: fields.country,
    currency: profile.currency,
    language: fields.language as CompanyLanguage,
    timeZone,
    address,
    ...(ein === undefined ? {} : { ein }),
    accountingBasis: fields.accountingBasis,
    invoiceNumberPrefix,
    taxConfiguration: Object.freeze({ status: tax.status }),
  };
  return Object.freeze(configuration) as CompanyConfiguration;
}

/** Missing configuration is not evidence of jurisdiction. Does not modify legacy data. */
export function resolveLegacyCompany(id: string): LegacyCompanyResolution {
  return Object.freeze({ organizationId: organizationId(id), country: 'unknown', requiresAdministrativeReview: true, preserveLegacyBehavior: true });
}
