import { describe, expect, it } from 'vitest';
import {
  InvalidOwnerLicenseBindingConfiguration,
  ownerLicenseBindingMatches,
  parseOwnerLicenseBindingHashes,
} from './owner-license-binding';

const WINDOWS = 'a'.repeat(64);
const MACOS = 'b'.repeat(64);

describe('owner license binding allowlist', () => {
  it('preserves the legacy single-binding format', () => {
    expect(parseOwnerLicenseBindingHashes(WINDOWS.toUpperCase())).toEqual([
      WINDOWS,
    ]);
    expect(ownerLicenseBindingMatches(WINDOWS, WINDOWS)).toBe(true);
  });

  it('supports multiple owner installations without weakening exact matching', () => {
    const configured = `${WINDOWS},\n${MACOS}`;
    expect(parseOwnerLicenseBindingHashes(configured)).toEqual([
      WINDOWS,
      MACOS,
    ]);
    expect(ownerLicenseBindingMatches(configured, WINDOWS)).toBe(true);
    expect(ownerLicenseBindingMatches(configured, MACOS)).toBe(true);
    expect(ownerLicenseBindingMatches(configured, 'c'.repeat(64))).toBe(false);
  });

  it('deduplicates entries and rejects the complete malformed configuration', () => {
    expect(parseOwnerLicenseBindingHashes(`${WINDOWS}; ${WINDOWS}`)).toEqual([
      WINDOWS,
    ]);
    expect(() => parseOwnerLicenseBindingHashes(`${WINDOWS},invalid`)).toThrow(
      InvalidOwnerLicenseBindingConfiguration,
    );
    expect(() => parseOwnerLicenseBindingHashes('a'.repeat(2_081))).toThrow(
      InvalidOwnerLicenseBindingConfiguration,
    );
  });
});
