import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_PLAN,
  planById,
  planByLicense,
  validLicensePrice,
  ZENTRA_PLANS,
} from './plans';

describe('Zentra commercial plans', () => {
  it('offers exactly Solo 49/1, Start 59/3 and Pro 89/10, owner included', () => {
    expect(
      ZENTRA_PLANS.map(({ id, priceChfCents, seats }) => [
        id,
        priceChfCents,
        seats,
      ]),
    ).toEqual([
      ['solo', 4900, 1],
      ['start', 5900, 3],
      ['pro', 8900, 10],
    ]);
    expect(planById('legacy')).toBeUndefined();
    expect(planById('enterprise')).toBeUndefined();
  });
  it.each(ZENTRA_PLANS)(
    'binds $name to its exact signed amount and native verifier',
    (plan) => {
      expect(validLicensePrice(plan.licensePlan, plan.priceChfCents)).toBe(
        true,
      );
      for (const amount of [
        0,
        1,
        5000,
        plan.priceChfCents - 1,
        String(plan.priceChfCents),
      ]) {
        expect(validLicensePrice(plan.licensePlan, amount)).toBe(false);
      }
      const rust = readFileSync(
        new URL('../desktop/src-tauri/src/license.rs', import.meta.url),
        'utf8',
      );
      expect(rust).toContain(
        `("${plan.licensePlan}", ${plan.priceChfCents.toLocaleString('en-US').replace(',', '_')})`,
      );
    },
  );
  it('retains previously issued licenses without offering the former plan for purchase', () => {
    expect(planByLicense('elyko-monthly-50-chf')).toEqual(LEGACY_PLAN);
    expect(validLicensePrice('zentra-monthly-50-chf', 5000)).toBe(true);
    expect(validLicensePrice('zentra-monthly-50-chf', 4900)).toBe(false);
    expect(validLicensePrice('unlimited', 0)).toBe(false);
  });
});
