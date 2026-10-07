import type { Currency, Money } from './types';

const zero = BigInt(0);
const one = BigInt(1);
const two = BigInt(2);
const hundred = BigInt(100);
const integerPattern = /^-?[0-9]+$/;
const decimalPattern = /^-?[0-9]+(?:\.[0-9]+)?$/;

function integer(input: unknown, label: string): bigint {
  if (typeof input !== 'string' || input.length > 1000 || !integerPattern.test(input)) throw new TypeError('Invalid integer string: ' + label);
  return BigInt(input);
}

function currencyCode(input: unknown): Currency {
  if (input !== 'CHF' && input !== 'USD') throw new TypeError('Unsupported money currency');
  return input;
}

function checked(value: Money): Money {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || !Object.hasOwn(value, 'currency') || !Object.hasOwn(value, 'minorUnits') || Reflect.ownKeys(value).some(key => key !== 'currency' && key !== 'minorUnits')) {
    throw new TypeError('Invalid money object');
  }
  return money(value.currency, value.minorUnits);
}

function matching(a: Money, b: Money): readonly [Money, Money] {
  const first = checked(a);
  const second = checked(b);
  if (first.currency !== second.currency) throw new TypeError('Cannot combine different currencies');
  return [first, second];
}

function absolute(value: bigint): bigint { return value < zero ? -value : value; }

/** Integer division with ties away from zero, including negative ratios. */
function roundedDivision(numerator: bigint, denominator: bigint): bigint {
  if (denominator === zero) throw new RangeError('Money denominator must not be zero');
  const magnitude = absolute(numerator);
  const divisor = absolute(denominator);
  const quotient = magnitude / divisor;
  const increment = (magnitude % divisor) * two >= divisor ? one : zero;
  const result = quotient + increment;
  return (numerator < zero) !== (denominator < zero) ? -result : result;
}

export function money(currency: Currency, minorUnits: string): Money {
  return Object.freeze({ currency: currencyCode(currency), minorUnits: integer(minorUnits, 'minorUnits').toString() });
}

/** Decimal major units, without grouping/exponents; rounds to cents half away from zero. */
export function decimalToMoney(currency: Currency, decimal: string): Money {
  currencyCode(currency);
  if (typeof decimal !== 'string' || decimal.length > 1000 || !decimalPattern.test(decimal)) throw new TypeError('Invalid decimal money string');
  const negative = decimal.startsWith('-');
  const [whole, fraction = ''] = (negative ? decimal.slice(1) : decimal).split('.');
  const cents = BigInt(whole) * hundred + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  const rounded = cents + (fraction.length > 2 && fraction[2] >= '5' ? one : zero);
  return money(currency, (negative ? -rounded : rounded).toString());
}

export function addMoney(a: Money, b: Money): Money {
  const [first, second] = matching(a, b);
  return money(first.currency, (BigInt(first.minorUnits) + BigInt(second.minorUnits)).toString());
}

export function subtractMoney(a: Money, b: Money): Money {
  const [first, second] = matching(a, b);
  return money(first.currency, (BigInt(first.minorUnits) - BigInt(second.minorUnits)).toString());
}

export function multiplyMoney(value: Money, numerator: string, denominator: string): Money {
  const amount = checked(value);
  const result = roundedDivision(BigInt(amount.minorUnits) * integer(numerator, 'numerator'), integer(denominator, 'denominator'));
  return money(amount.currency, result.toString());
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  const [first, second] = matching(a, b);
  const firstUnits = BigInt(first.minorUnits);
  const secondUnits = BigInt(second.minorUnits);
  return firstUnits < secondUnits ? -1 : firstUnits > secondUnits ? 1 : 0;
}

/** Intl places the currency/sign/grouping; the exact integer and fraction never pass through Number. */
export function formatMoney(value: Money, locale: string): string {
  if (typeof locale !== 'string' || !locale || locale !== locale.trim()) throw new TypeError('Money locale must be explicit');
  const amount = checked(value);
  const units = BigInt(amount.minorUnits);
  const magnitude = absolute(units);
  const whole = magnitude / hundred;
  const fraction = (magnitude % hundred).toString().padStart(2, '0');
  const negativeBelowOne = units < zero && whole === zero;
  const formattedWhole = units < zero ? -(negativeBelowOne ? one : whole) : whole;
  const digits = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 });
  // The remainder is exactly two ASCII digits before mapping to locale glyphs.
  const fractionText = fraction.split('').map(digit => digits.format(BigInt(digit))).join('');
  return new Intl.NumberFormat(locale, { style: 'currency', currency: amount.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .formatToParts(formattedWhole)
    .map(part => part.type === 'fraction' ? fractionText : part.type === 'integer' && negativeBelowOne ? digits.format(zero) : part.value)
    .join('');
}
