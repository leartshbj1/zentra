import { countryConfiguration } from './country-config';
import { ErpError } from './erp-contract';
import { parseInstant } from './localization';

export interface UsTaxInvoiceLocalCandidate { readonly instant: string; readonly offset: string; }
function invalid(): never { throw new ErpError('invalid_tax_date', 422); }
function formatter(timeZone: string): Intl.DateTimeFormat {
  if (!countryConfiguration('US').timeZones.includes(timeZone)) return invalid();
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}
function wallTime(format: Intl.DateTimeFormat, date: Date): string {
  const parts = format.formatToParts(date), part = (kind: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === kind)?.value;
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
/** An empty result is a DST gap; two results require the person's offset choice.
 * Enumeration is bounded and never consults the device's time zone. */
export function usTaxInvoiceLocalCandidates(localDateTime: string, timeZone: string): readonly UsTaxInvoiceLocalCandidate[] {
  const format = formatter(timeZone);
  if (typeof localDateTime !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(localDateTime)) return invalid();
  let civil: number;
  try { civil = parseInstant(localDateTime + 'Z').getTime(); } catch { return invalid(); }
  const result: UsTaxInvoiceLocalCandidate[] = [];
  // The supported current US zones use whole-minute offsets. Check the entire
  // permitted ISO offset range rather than guessing a transition's direction.
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes++) {
    const date = new Date(civil - minutes * 60_000);
    if (wallTime(format, date) !== localDateTime) continue;
    const absolute = Math.abs(minutes), offset = `${minutes < 0 ? '-' : '+'}${Math.floor(absolute / 60).toString().padStart(2, '0')}:${(absolute % 60).toString().padStart(2, '0')}`;
    result.push(Object.freeze({ instant: date.toISOString(), offset }));
  }
  result.sort((a, b) => a.instant.localeCompare(b.instant));
  return Object.freeze(result);
}
/** Validates an already explicit instant against the admitted workspace zone
 * and invoice date. The immutable preparation retains its normalized value. */
export function validateUsTaxInvoiceTime(input: Readonly<{ taxDateInstant: string; invoiceDate: string; timeZone: string; now: string }>): string {
  const format = formatter(input.timeZone);
  let taxDate: Date, now: Date;
  try { taxDate = parseInstant(input.taxDateInstant); now = parseInstant(input.now); } catch { return invalid(); }
  if (taxDate.getTime() < 0 || taxDate.getTime() % 1000 !== 0 || Math.abs(taxDate.getTime() - now.getTime()) > 31 * 86_400_000 || wallTime(format, taxDate).slice(0, 10) !== input.invoiceDate) return invalid();
  return taxDate.toISOString();
}
