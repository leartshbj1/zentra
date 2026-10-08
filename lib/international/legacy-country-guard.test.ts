import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '@/lib/account-security';
import {
  LEGACY_COUNTRY_GUARD_CODE,
  LegacyCountryTransportError,
  requireLegacyCountryTransport,
  type LegacyCountryGuardDatabase,
} from './legacy-country-guard';

function database(row: { blocked: number } | null, error?: Error) {
  const first = vi.fn(async () => {
    if (error) throw error;
    return row;
  });
  const bind = vi.fn((..._values: string[]) => ({ first }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  return { db: { prepare } as unknown as LegacyCountryGuardDatabase, first, bind, prepare };
}

describe('legacy transport country preflight', () => {
  it('preserves legacy behavior for the exact organization without a US intention', async () => {
    const fixture = database(null);
    await expect(requireLegacyCountryTransport('company-ch', fixture.db)).resolves.toBeUndefined();
    expect(fixture.bind).toHaveBeenCalledWith('company-ch');
    expect(fixture.prepare.mock.calls[0][0]).toMatch(/organization_id=\? AND country_code='US'/);
  });

  it('refuses every durable US state without reading private configuration or rights', async () => {
    const fixture = database({ blocked: 1 });
    const failure = await requireLegacyCountryTransport('company-us', fixture.db).catch(error => error);
    expect(failure).toBeInstanceOf(LegacyCountryTransportError);
    expect(failure).toBeInstanceOf(AccountPublicError);
    expect(failure).toMatchObject({ status: 409, code: LEGACY_COUNTRY_GUARD_CODE });
    const query = fixture.prepare.mock.calls[0][0];
    expect(query).toContain('SELECT 1 AS blocked');
    expect(query).not.toMatch(/\bstate\b|configuration|receipt|subscription|\*/i);
    expect(fixture.bind).toHaveBeenCalledWith('company-us');
  });

  it('fails closed when the attestation query or migration is unavailable', async () => {
    const error = new Error('database unavailable');
    const fixture = database(null, error);
    await expect(requireLegacyCountryTransport('company-ch', fixture.db)).rejects.toBe(error);
    expect(fixture.first).toHaveBeenCalledOnce();
  });

  it('rechecks a previously accepted identity after a durable admission appears', async () => {
    const fixture = database(null);
    await expect(requireLegacyCountryTransport('company-changing', fixture.db)).resolves.toBeUndefined();
    fixture.first.mockResolvedValue({ blocked: 1 });
    await expect(requireLegacyCountryTransport('company-changing', fixture.db)).rejects.toBeInstanceOf(LegacyCountryTransportError);
    expect(fixture.first).toHaveBeenCalledTimes(2);
    expect(fixture.bind.mock.calls).toEqual([['company-changing'], ['company-changing']]);
  });

  it('does not reuse a country decision between organizations', async () => {
    const fixture = database({ blocked: 1 });
    await expect(requireLegacyCountryTransport('company-us', fixture.db)).rejects.toBeInstanceOf(LegacyCountryTransportError);
    fixture.first.mockResolvedValue(null);
    await expect(requireLegacyCountryTransport('company-ch', fixture.db)).resolves.toBeUndefined();
    expect(fixture.bind.mock.calls).toEqual([['company-us'], ['company-ch']]);
  });
});
