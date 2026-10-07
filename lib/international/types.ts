export type Currency = 'CHF' | 'USD';
export type CountryCode = 'CH' | 'US';
export type CompanyLanguage = 'fr' | 'de' | 'it' | 'en';
export type AccountingBasis = 'cash' | 'accrual';

/** JSON-safe exact amount. Never convert minorUnits to a floating-point number. */
export interface Money {
  readonly currency: Currency;
  readonly minorUnits: string;
}

interface AddressFields {
  readonly line1: string;
  readonly line2?: string;
  readonly postalCode: string;
  readonly city: string;
  readonly subdivision: string;
}
export type SwissAddress = AddressFields & { readonly country: 'CH' };
export type USAddress = AddressFields & { readonly country: 'US' };
export type CompanyAddress = SwissAddress | USAddress;

export interface TaxConfiguration {
  readonly status: 'unconfigured' | 'configured';
}

interface CompanyConfigurationFields {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly language: CompanyLanguage;
  readonly timeZone: string;
  readonly accountingBasis: AccountingBasis;
  readonly invoiceNumberPrefix: string;
  readonly taxConfiguration: TaxConfiguration;
}

/** Jurisdiction belongs to the organization, independently of interface language. */
export type CompanyConfiguration = CompanyConfigurationFields & (
  | { readonly country: 'CH'; readonly currency: 'CHF'; readonly address: SwissAddress; readonly ein?: never }
  | { readonly country: 'US'; readonly currency: 'USD'; readonly address: USAddress; readonly ein?: string }
);

export interface LegacyCompanyResolution {
  readonly organizationId: string;
  readonly country: 'unknown';
  readonly requiresAdministrativeReview: true;
  readonly preserveLegacyBehavior: true;
}

export type CountryCurrency = { CH: 'CHF'; US: 'USD' };
export interface CountryConfiguration<C extends CountryCode = CountryCode> {
  readonly country: C;
  readonly currency: CountryCurrency[C];
  readonly minorUnitDigits: 2;
  readonly locales: Readonly<Record<CompanyLanguage, string>>;
  readonly timeZones: readonly string[];
  readonly addressSubdivisions: readonly string[];
}
