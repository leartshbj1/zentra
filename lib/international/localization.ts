import { countryConfiguration, validateCompanyConfiguration } from './country-config';
import type { CompanyConfiguration } from './types';

export function localeForCompany(company: CompanyConfiguration): string {
  const checked = validateCompanyConfiguration(company);
  return countryConfiguration(checked.country).locales[checked.language];
}

function dateOnly(value: string): Date {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) throw new TypeError('Date must use YYYY-MM-DD');
  const result = new Date(value + 'T12:00:00.000Z');
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new TypeError('Invalid calendar date');
  return result;
}

function explicitLocale(locale: string): string {
  if (typeof locale !== 'string' || !locale || locale !== locale.trim()) throw new TypeError('Date locale must be explicit');
  return Intl.getCanonicalLocales(locale)[0];
}

/** A civil date is not an instant: the system/company time zone cannot move its day. */
export function formatDateOnly(value: string, locale: string): string {
  return new Intl.DateTimeFormat(explicitLocale(locale), { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(dateOnly(value));
}

/** Parse an unambiguous instant without interpreting the device's local time zone. */
export function parseInstant(value: string): Date {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) {
    throw new TypeError('Timestamp requires an ISO date, time and explicit offset');
  }
  dateOnly(value.slice(0, 10));
  const time = value.slice(11, 19).split(':');
  if (time[0] > '23' || time[1] > '59' || time[2] > '59') throw new TypeError('Invalid timestamp clock time');
  const offset = /([+-])([0-9]{2}):([0-9]{2})$/.exec(value);
  if (offset && (offset[2] > '23' || offset[3] > '59')) throw new TypeError('Invalid timestamp offset');
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('Invalid timestamp');
  return instant;
}

/** Instants require an explicit offset; output uses an explicitly permitted IANA zone. */
export function formatTimestamp(value: string, locale: string, timeZone: string): string {
  const instant = parseInstant(value);
  if (![...countryConfiguration('CH').timeZones, ...countryConfiguration('US').timeZones].includes(timeZone)) {
    throw new TypeError('Unsupported timestamp time zone');
  }
  return new Intl.DateTimeFormat(explicitLocale(locale), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone }).format(instant);
}
