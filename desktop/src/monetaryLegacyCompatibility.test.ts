import { expect, it } from 'vitest';
import { roundBasisPoints } from './utils';
import { timeEntryNetCents, summarizeTimeBilling } from './timeBilling';
import type { TimeEntry } from './types';

// Frozen pre-change Number contracts for fallback inputs, not a native oracle.
// These deliberate invalid/historical cases must not enter exact BigInt division
// (which truncates toward zero rather than preserving Math.floor for negatives).
function legacyPercentage(value: number, basisPoints: number): number {
  if (!value) return 0;
  const normalized = Math.max(0, Math.min(10_000, Math.trunc(basisPoints)));
  const rounded = Math.floor((Math.abs(value) * normalized + 5_000) / 10_000);
  return value < 0 ? -rounded : rounded;
}
function legacyNet(entry: TimeEntry): number {
  return Math.floor((entry.minutes * (entry.billingRateCents ?? 0) + 30) / 60);
}
function legacySummary(entries: TimeEntry[], vatBp: number) {
  const dates = entries.map(entry => entry.date).filter(Boolean).sort();
  let minutes = 0, netCents = 0, vatCents = 0;
  for (const entry of entries) {
    const net = legacyNet(entry);
    minutes += entry.minutes;
    netCents += net;
    vatCents += Math.floor((net * vatBp + 5_000) / 10_000);
  }
  return { minutes, netCents, vatCents, totalCents: netCents + vatCents, dateFrom: dates[0] ?? '', dateTo: dates.at(-1) ?? '' };
}

it('keeps the frozen percentage behavior for fractional, non-finite and already-unsafe inputs', () => {
  const values = [0, -0, 1, -1, 12345, -12345, 1.25, -1.25, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 3];
  const basis = [0, 50, 50.9, -50, -Infinity, Infinity, NaN, 10000, 10001, 260.25, 810, 9999];
  for (const value of values) for (const bp of basis) expect(Object.is(roundBasisPoints(value, bp), legacyPercentage(value, bp))).toBe(true);
});

it('keeps invalid or historical fractional time inputs and unsafe outputs on the old Number path', () => {
  const values = [0, -0, 1, -1, 1.25, -1.25, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 3];
  for (const minutes of values) for (const rate of values) {
    if (Number.isSafeInteger(minutes) && minutes >= 0 && Number.isSafeInteger(rate) && rate >= 0) continue;
    const entry = { minutes, billingRateCents: rate, date: '2026-10-03' } as TimeEntry;
    expect(Object.is(timeEntryNetCents(entry), legacyNet(entry))).toBe(true);
  }
  for (const bp of [NaN, Infinity, -Infinity, -50, 50.9]) {
    const entry = { minutes: 61, billingRateCents: 10001, date: '2026-10-03' } as TimeEntry;
    expect(summarizeTimeBilling([entry], bp)).toEqual(legacySummary([entry], bp));
  }
  for (const [minutes, rate] of [[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 1_000_000]]) {
    const entry = { minutes, billingRateCents: rate, date: '2026-10-03' } as TimeEntry;
    expect(Object.is(timeEntryNetCents(entry), legacyNet(entry))).toBe(true);
  }
});

it('does not claim to recover distinct integers already lost during Number JSON decoding', () => {
  const first = JSON.parse('9007199254740992') as number, second = JSON.parse('9007199254740993') as number;
  expect(first).toBe(second);
  expect(Number.isSafeInteger(first)).toBe(false);
  expect(Object.is(roundBasisPoints(first, 810), legacyPercentage(first, 810))).toBe(true);
});

it('preserves floor rounding for invalid negative time and signed zero for percentages', () => {
  const entry = { minutes: -1, billingRateCents: 31, date: '2026-10-03' } as TimeEntry;
  expect(timeEntryNetCents(entry)).toBe(-1);
  const largeNegative = { ...entry, minutes: -Number.MAX_SAFE_INTEGER, billingRateCents: 10001 };
  expect(Object.is(timeEntryNetCents(largeNegative), legacyNet(largeNegative))).toBe(true);
  expect(Object.is(roundBasisPoints(-1, 50), -0)).toBe(true);
  expect(Object.is(roundBasisPoints(-0, 50), 0)).toBe(true);
});

it('retains zero-rate fallback for absent or null historical rates and empty summaries', () => {
  for (const rate of [undefined, null]) {
    const entry = { minutes: 61, billingRateCents: rate, date: '2026-10-03' } as unknown as TimeEntry;
    expect(timeEntryNetCents(entry)).toBe(0);
    expect(summarizeTimeBilling([entry], 810)).toEqual(legacySummary([entry], 810));
  }
  expect(summarizeTimeBilling([], 810)).toEqual(legacySummary([], 810));
});
