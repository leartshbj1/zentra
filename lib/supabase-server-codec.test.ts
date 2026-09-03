import { describe, expect, it } from 'vitest';
import {
  base64UrlHashToPostgresBytea,
  booleanToD1Integer,
  d1BooleanToBoolean,
  epochSecondsToIso,
  isoToEpochSeconds,
  postgresByteaToBase64UrlHash,
} from './supabase-server-codec';

describe('Supabase server codecs', () => {
  it('round-trips Unix seconds through timestamptz', () => {
    expect(epochSecondsToIso(1_788_400_000)).toBe('2026-09-03T01:46:40.000Z');
    expect(isoToEpochSeconds('2026-09-03T03:46:40+02:00')).toBe(1_788_400_000);
    expect(epochSecondsToIso(null)).toBeNull();
    expect(isoToEpochSeconds(null)).toBeNull();
  });

  it('rejects timestamps whose timezone or unit is ambiguous', () => {
    expect(() => epochSecondsToIso(1_788_400_000.5)).toThrow();
    expect(() => isoToEpochSeconds('2026-09-03T10:40:00')).toThrow();
  });

  it('converts D1 booleans without accepting arbitrary integers', () => {
    expect(d1BooleanToBoolean(1)).toBe(true);
    expect(d1BooleanToBoolean(0)).toBe(false);
    expect(booleanToD1Integer(true)).toBe(1);
    expect(booleanToD1Integer(false)).toBe(0);
    expect(() => d1BooleanToBoolean(2 as 0)).toThrow();
  });

  it('round-trips canonical SHA-256 hashes through PostgreSQL bytea', () => {
    const hash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const bytea = base64UrlHashToPostgresBytea(hash);
    expect(bytea).toBe(`\\x${'00'.repeat(32)}`);
    expect(postgresByteaToBase64UrlHash(bytea)).toBe(hash);
  });

  it('rejects non-SHA-256 and non-canonical hashes', () => {
    expect(() => base64UrlHashToPostgresBytea('short')).toThrow();
    expect(() => base64UrlHashToPostgresBytea(`${'A'.repeat(42)}B`)).toThrow();
    expect(() => postgresByteaToBase64UrlHash('\\x01')).toThrow();
  });
});
