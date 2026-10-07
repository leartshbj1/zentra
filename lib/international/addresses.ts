import type { CompanyAddress, CountryCode } from './types';

export const countrySubdivisions = Object.freeze({
  CH: Object.freeze(['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH']),
  US: Object.freeze(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']),
});

const addressFields = ['country', 'line1', 'line2', 'postalCode', 'city', 'subdivision'];

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function addressText(input: Record<string, unknown>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim() || hasControlCharacter(value)) {
    throw new TypeError('Invalid address field: ' + key);
  }
  return value;
}

export function validateAddress(input: unknown, expectedCountry: CountryCode): CompanyAddress {
  if (expectedCountry !== 'CH' && expectedCountry !== 'US') throw new TypeError('Unsupported address country');
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError('Address must be a plain object');
  }
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !addressFields.includes(key))) {
    throw new TypeError('Unknown address field');
  }
  const fields = input as Record<string, unknown>;
  if (['country', 'line1', 'postalCode', 'city', 'subdivision'].some(key => !Object.hasOwn(fields, key))) {
    throw new TypeError('Missing required address field');
  }
  if (fields.country !== expectedCountry) throw new TypeError('Address country must match company country');
  const line1 = addressText(fields, 'line1', 200);
  const city = addressText(fields, 'city', 120);
  const subdivision = addressText(fields, 'subdivision', 2);
  const postalCode = addressText(fields, 'postalCode', 10);
  if (!countrySubdivisions[expectedCountry].includes(subdivision)) throw new TypeError('Invalid address subdivision');
  const postalPattern = expectedCountry === 'CH' ? /^[1-9][0-9]{3}$/ : /^[0-9]{5}(?:-[0-9]{4})?$/;
  if (!postalPattern.test(postalCode)) throw new TypeError('Invalid postal code for address country');
  const line2 = Object.hasOwn(fields, 'line2') ? addressText(fields, 'line2', 200) : undefined;
  return Object.freeze({ country: expectedCountry, line1, ...(line2 === undefined ? {} : { line2 }), postalCode, city, subdivision });
}

/** Preserves names and user-entered text; formats only the address structure. */
export function formatAddress(address: CompanyAddress): readonly string[] {
  const checked = validateAddress(address, address.country);
  const locality = checked.country === 'CH'
    ? checked.postalCode + ' ' + checked.city
    : checked.city + ', ' + checked.subdivision + ' ' + checked.postalCode;
  return Object.freeze([checked.line1, ...(checked.line2 ? [checked.line2] : []), locality, checked.country]);
}
