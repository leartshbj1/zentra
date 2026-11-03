import type { Quote } from './types';
import { documentTotals } from './utils';

/**
 * Which open quote a client's mail is about, from what the client wrote: the
 * number first, then the amount, then the date of the offer ("l’offre du
 * 14 octobre", "Angebot vom 14.10."). Only the client's own words are read;
 * one match is used, none or several are left to the person.
 */
const reference = (value: string) => value.toLocaleLowerCase('fr-CH').replace(/\s+/g, '');
// "CHF 3’480.-", "3 480,00 CHF", "Fr. 178.-", "EUR 90".
const AMOUNT = /(?:\b(?:CHF|EUR|Fr\.?|SFr\.?)\s?(\d{1,3}(?:['’ . ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:['’ . ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\.-|,-)?\s?(?:CHF|EUR|€|Fr\.?))(?![\p{L}\p{N}])/iu;
const MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  januar: 1, februar: 2, marz: 3, april: 4, juni: 6, juli: 7, august: 8, oktober: 10, dezember: 12,
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12,
};
const plain = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** The amount written by the client, in cents, or null. */
export function writtenAmountCents(text: string): number | null {
  const match = AMOUNT.exec(text);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? '').replace(/['’  ]/g, '');
  const decimal = /[.,](\d{1,2})$/.exec(raw);
  const whole = (decimal ? raw.slice(0, -decimal[0].length) : raw).replace(/[.,]/g, '');
  if (!/^\d{1,10}$/.test(whole)) return null;
  const cents = Number(whole) * 100 + (decimal ? Number(decimal[1].padEnd(2, '0')) : 0);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** The day the client names ("du 14 octobre", "14.10.2026"), as YYYY-MM-DD, or null. */
export function writtenDate(text: string, receivedAt: number): string | null {
  const received = new Date(receivedAt * 1000);
  const year = (day: number, month: number, written?: string) => {
    if (written) return written.length === 2 ? 2000 + Number(written) : Number(written);
    // Without a year: the latest such day not after the mail.
    const candidate = received.getUTCFullYear();
    return Date.UTC(candidate, month - 1, day) > received.getTime() ? candidate - 1 : candidate;
  };
  const iso = (day: number, month: number, y: number) => day >= 1 && day <= 31 && month >= 1 && month <= 12 && y >= 2000 && y <= 2100
    ? `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  const numeric = /(?<![\p{N}])(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?(?![\p{N}])/u.exec(text);
  if (numeric) return iso(Number(numeric[1]), Number(numeric[2]), year(Number(numeric[1]), Number(numeric[2]), numeric[3]));
  const named = /(?<![\p{L}\p{N}])(\d{1,2})(?:er)?\.?\s+(\p{L}+)(?:\s+(\d{4}))?/u.exec(plain(text));
  const month = named ? MONTHS[named[2]] : undefined;
  return named && month ? iso(Number(named[1]), month, year(Number(named[1]), month, named[3])) : null;
}

/** The single quote named by number, else by amount, else by date; null when none or several fit. */
export function quoteNamedInMail(mail: Readonly<{ quoteReference: string | null; evidence: string; receivedAt: number }>, quotes: readonly Quote[]): Quote | null {
  if (mail.quoteReference) {
    const wanted = reference(mail.quoteReference);
    const numbered = quotes.filter(quote => quote.number && reference(quote.number) === wanted);
    if (numbered.length === 1) return numbered[0];
  }
  const amount = writtenAmountCents(mail.evidence);
  if (amount !== null) {
    // The client may write the total with or without VAT, rounded to the franc.
    const francs = Math.round(amount / 100);
    const priced = quotes.filter(quote => {
      const totals = documentTotals(quote.lines ?? []);
      return [totals.totalCents, totals.netCents].some(cents => Math.round(cents / 100) === francs);
    });
    if (priced.length === 1) return priced[0];
  }
  const date = writtenDate(mail.evidence, mail.receivedAt);
  if (date) {
    const dated = quotes.filter(quote => quote.issueDate === date);
    if (dated.length === 1) return dated[0];
  }
  return null;
}
