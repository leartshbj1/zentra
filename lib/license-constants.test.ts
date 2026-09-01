import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_LICENSE_PLANS,
  LICENSE_KEY_ID,
  LICENSE_PLAN,
  LICENSE_PRICE_CHF_CENTS,
  LICENSE_PUBLIC_KEY_B64URL,
  LICENSE_TOKEN_VERSION,
  isSupportedLicensePlan,
} from './license-constants';

describe('Zentra license key contract', () => {
  it('keeps the server verifier aligned with the Windows application', () => {
    const desktopKey = readFileSync(
      new URL(
        '../desktop/src-tauri/license-public-key.b64url',
        import.meta.url,
      ),
      'utf8',
    ).trim();
    expect(LICENSE_PUBLIC_KEY_B64URL).toBe(desktopKey);
  });

  it('keeps the complete signed-license contract aligned with Rust', () => {
    const rust = readFileSync(
      new URL('../desktop/src-tauri/src/license.rs', import.meta.url),
      'utf8',
    );
    expect(rust).toContain(`pub const LICENSE_PLAN: &str = "${LICENSE_PLAN}";`);
    for (const legacyPlan of LEGACY_LICENSE_PLANS) {
      expect(rust).toContain(`"${legacyPlan}"`);
    }
    expect(rust).toContain(
      `pub const LICENSE_PRICE_CHF_CENTS: i64 = ${LICENSE_PRICE_CHF_CENTS.toLocaleString('en-US').replaceAll(',', '_')};`,
    );
    expect(rust).toContain(
      `const TOKEN_VERSION: u8 = ${LICENSE_TOKEN_VERSION};`,
    );
    expect(rust).toContain(`const LICENSE_KEY_ID: &str = "${LICENSE_KEY_ID}";`);
  });

  it('accepts only the current plan and the explicit migration alias', () => {
    expect(isSupportedLicensePlan(LICENSE_PLAN)).toBe(true);
    for (const legacyPlan of LEGACY_LICENSE_PLANS) {
      expect(isSupportedLicensePlan(legacyPlan)).toBe(true);
    }
    expect(isSupportedLicensePlan('another-product')).toBe(false);
    expect(isSupportedLicensePlan(null)).toBe(false);
  });
});
