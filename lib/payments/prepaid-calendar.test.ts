import { describe, expect, it } from 'vitest';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import {
  PREPAID_CATALOG_VERSION,
  prepaidCatalog,
  prepaidProduct,
} from './prepaid-catalog';
import { ZENTRA_PLANS } from '@/lib/plans';
import { SUPPORT_PLANS } from '@/lib/support/plans';
import { COMPLETE_PLANS } from '@/lib/complete/plans';
import { AUTOMATION_PRICE_CENTS } from '@/lib/automation/types';

const seconds = (iso: string) => Date.parse(iso) / 1000;
const iso = (time: number) => new Date(time * 1000).toISOString();

describe('prepaid monthly UTC calendar', () => {
  it.each([
    [
      '2025-01-31T11:23:45Z',
      '2025-02-28T11:23:45.000Z',
      '2025-03-31T11:23:45.000Z',
    ],
    [
      '2024-01-31T11:23:45Z',
      '2024-02-29T11:23:45.000Z',
      '2024-03-31T11:23:45.000Z',
    ],
    [
      '2025-01-30T11:23:45Z',
      '2025-02-28T11:23:45.000Z',
      '2025-03-30T11:23:45.000Z',
    ],
    [
      '2025-01-29T11:23:45Z',
      '2025-02-28T11:23:45.000Z',
      '2025-03-29T11:23:45.000Z',
    ],
    [
      '2025-01-28T11:23:45Z',
      '2025-02-28T11:23:45.000Z',
      '2025-03-28T11:23:45.000Z',
    ],
  ])(
    'preserves the original day after February for %s',
    (anchor, february, march) => {
      const period = prepaidMonthlyPeriod(seconds(anchor), 1);
      expect(iso(period.startSeconds)).toBe(february);
      expect(iso(period.endSeconds)).toBe(march);
    },
  );

  it('uses the original leap-day anchor in subsequent years', () => {
    const anchor = seconds('2024-02-29T00:00:01Z');
    const common = prepaidMonthlyPeriod(anchor, 12);
    const leap = prepaidMonthlyPeriod(anchor, 48);
    expect(iso(common.startSeconds)).toBe('2025-02-28T00:00:01.000Z');
    expect(iso(common.endSeconds)).toBe('2025-03-29T00:00:01.000Z');
    expect(iso(leap.startSeconds)).toBe('2028-02-29T00:00:01.000Z');
  });

  it('handles Gregorian century exceptions without a guessed leap-year cycle', () => {
    const anchor = seconds('2099-01-31T12:00:00Z');
    expect(iso(prepaidMonthlyPeriod(anchor, 13).startSeconds)).toBe(
      '2100-02-28T12:00:00.000Z',
    );
    expect(
      iso(
        prepaidMonthlyPeriod(seconds('1999-01-31T12:00:00Z'), 13).startSeconds,
      ),
    ).toBe('2000-02-29T12:00:00.000Z');
  });

  it('clamps 31 to 30 and recovers 31, including December rollover', () => {
    const anchor = seconds('2026-08-31T23:59:59Z');
    expect(iso(prepaidMonthlyPeriod(anchor, 1).startSeconds)).toBe(
      '2026-09-30T23:59:59.000Z',
    );
    expect(iso(prepaidMonthlyPeriod(anchor, 2).startSeconds)).toBe(
      '2026-10-31T23:59:59.000Z',
    );
    expect(iso(prepaidMonthlyPeriod(anchor, 4).endSeconds)).toBe(
      '2027-01-31T23:59:59.000Z',
    );
  });

  it('uses UTC instants across daylight-saving changes and preserves seconds', () => {
    const anchor = seconds('2026-03-29T01:30:07Z');
    const period = prepaidMonthlyPeriod(anchor, 1);
    expect(iso(period.startSeconds)).toBe('2026-04-29T01:30:07.000Z');
    expect(iso(period.endSeconds)).toBe('2026-05-29T01:30:07.000Z');
  });

  it('calculates late periods directly with no iterative month drift', () => {
    const anchor = seconds('2026-01-31T09:10:11Z');
    const late = prepaidMonthlyPeriod(anchor, 1201);
    expect(iso(late.startSeconds)).toBe('2126-02-28T09:10:11.000Z');
    expect(iso(late.endSeconds)).toBe('2126-03-31T09:10:11.000Z');
  });

  it('returns contiguous positive periods, each immutable and anchored', () => {
    const anchor = seconds('2026-01-31T09:10:11Z');
    for (let ordinal = 0; ordinal < 120; ordinal++) {
      const period = prepaidMonthlyPeriod(anchor, ordinal);
      expect(period).toMatchObject({ anchorStartSeconds: anchor, ordinal });
      expect(period.endSeconds).toBe(
        prepaidMonthlyPeriod(anchor, ordinal + 1).startSeconds,
      );
      expect(period.endSeconds).toBeGreaterThan(period.startSeconds);
      expect(Number.isSafeInteger(period.startSeconds)).toBe(true);
      expect(Number.isSafeInteger(period.endSeconds)).toBe(true);
      expect(Object.isFrozen(period)).toBe(true);
    }
    expect(prepaidMonthlyPeriod(anchor, 0).startSeconds).toBe(anchor);
  });

  it('accepts the Unix epoch without Date.UTC year shortcuts', () => {
    expect(prepaidMonthlyPeriod(0, 0)).toEqual({
      anchorStartSeconds: 0,
      ordinal: 0,
      startSeconds: 0,
      endSeconds: 2678400,
    });
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects unsupported anchor %s', (anchor) => {
    expect(() => prepaidMonthlyPeriod(anchor, 0)).toThrow(RangeError);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects unsupported ordinal %s', (ordinal) => {
    expect(() =>
      prepaidMonthlyPeriod(seconds('2026-01-01T00:00:00Z'), ordinal),
    ).toThrow(RangeError);
  });

  it('rejects a valid timestamp whose full next month cannot be represented', () => {
    expect(() => prepaidMonthlyPeriod(8640000000000, 0)).toThrow(RangeError);
  });
});

describe('server prepaid catalogue', () => {
  it('includes only the ten approved public monthly plans, no legacy or free trial', () => {
    expect(prepaidCatalog()).toHaveLength(10);
    expect(new Set(prepaidCatalog().map((p) => p.productKey)).size).toBe(10);
    expect(
      prepaidCatalog().map((p) => [p.productKey, p.priceChfMinor]),
    ).toEqual([
      ['gestion:solo', 4900],
      ['gestion:start', 5900],
      ['gestion:pro', 8900],
      ['support:starter', 2900],
      ['support:team', 4900],
      ['support:business', 9900],
      ['automation', 1500],
      ['complet:solo', 7900],
      ['complet:team', 9900],
      ['complet:pro', 16900],
    ]);
    for (const p of prepaidCatalog()) {
      expect(p).toMatchObject({
        catalogVersion: PREPAID_CATALOG_VERSION,
        scope: 'organization',
        currency: 'CHF',
        billingPeriod: 'P1M',
      });
    }
  });

  it.each(ZENTRA_PLANS)(
    'derives Gestion $id with the owner included in its seat total',
    (plan) => {
      expect(prepaidProduct(`gestion:${plan.id}`)).toMatchObject({
        productKind: 'gestion',
        planId: plan.id,
        priceChfMinor: plan.priceChfCents,
        includedProducts: ['gestion'],
        support: null,
        automation: false,
        gestion: {
          planId: plan.id,
          licensePlan: plan.licensePlan,
          licensePriceChfMinor: plan.priceChfCents,
          seats: plan.seats,
          ownerIncluded: true,
        },
      });
    },
  );

  it.each(SUPPORT_PLANS)(
    'derives Support $id without creating Gestion or Automation rights',
    (plan) => {
      expect(prepaidProduct(`support:${plan.id}`)).toMatchObject({
        productKind: 'support',
        priceChfMinor: plan.priceChfCents,
        includedProducts: ['support'],
        gestion: null,
        automation: false,
        support: { planId: plan.id, analyses: plan.analyses },
      });
    },
  );

  it('derives standalone Automation without seats or a Support quota', () => {
    expect(prepaidProduct('automation')).toMatchObject({
      priceChfMinor: AUTOMATION_PRICE_CENTS,
      includedProducts: ['automation'],
      gestion: null,
      support: null,
      automation: true,
    });
  });

  it.each(COMPLETE_PLANS)(
    'projects pack $id into precise component rights and Gestion licence price',
    (plan) => {
      const gestion = ZENTRA_PLANS.find((p) => p.id === plan.gestion)!;
      const support = SUPPORT_PLANS.find((p) => p.id === plan.support)!;
      const p = prepaidProduct(`complet:${plan.id}`)!;
      expect(p).toMatchObject({
        productKind: 'complete',
        priceChfMinor: plan.priceChfCents,
        includedProducts: ['gestion', 'support', 'automation'],
        automation: true,
        gestion: {
          planId: gestion.id,
          licensePlan: gestion.licensePlan,
          licensePriceChfMinor: gestion.priceChfCents,
          seats: gestion.seats,
          ownerIncluded: true,
        },
        support: { planId: support.id, analyses: support.analyses },
      });
      expect(p.gestion!.licensePriceChfMinor).not.toBe(p.priceChfMinor);
    },
  );

  it.each([
    null,
    undefined,
    '',
    'solo',
    'gestion:legacy',
    'trial',
    'complet:start',
    '__proto__',
    {},
    [],
  ])('does not accept unknown or legacy key %s', (key) => {
    expect(prepaidProduct(key)).toBeUndefined();
  });

  it('freezes the catalogue, products, included products and nested rights against request mutation', () => {
    expect(Object.isFrozen(prepaidCatalog())).toBe(true);
    for (const p of prepaidCatalog()) {
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.includedProducts)).toBe(true);
      if (p.gestion) expect(Object.isFrozen(p.gestion)).toBe(true);
      if (p.support) expect(Object.isFrozen(p.support)).toBe(true);
    }
    const p = prepaidProduct('complet:pro')!;
    expect(() => Reflect.set(p, 'priceChfMinor', 1)).not.toThrow();
    expect(Reflect.set(p, 'priceChfMinor', 1)).toBe(false);
    expect(Reflect.set(p.gestion!, 'seats', 1000)).toBe(false);
    expect(p.priceChfMinor).toBe(16900);
    expect(p.gestion!.seats).toBe(10);
  });
});
