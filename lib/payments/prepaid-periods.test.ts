import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  D1PrepaidPeriods,
  type PrepaidContractInput,
  type PrepaidPeriod,
} from './prepaid-periods';

let db: DatabaseSync, clock: number;
const input: PrepaidContractInput = {
  contractId: 'pfp_12c36d11-7232-4fa8-b8a5-b74518740554',
  ownerId: 'user-owner',
  organizationId: 'company-a',
  workspaceId: 'support-a',
  apiOrigin: 'https://checkout.postfinance.ch',
  spaceId: 405,
  environment: 'TEST',
  productKey: 'complet:team',
};
function d1(sql = db) {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async run() {
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
      };
      return statement;
    },
  } as unknown as Pick<D1Database, 'prepare'>;
}
const store = () => new D1PrepaidPeriods(d1(), () => clock);
function settlement(p: PrepaidPeriod, overrides: Record<string, unknown> = {}) {
  return {
    periodId: p.periodId,
    transactionId: 71,
    invoiceId: 81,
    apiOrigin: input.apiOrigin,
    spaceId: input.spaceId,
    environment: input.environment,
    ownerId: input.ownerId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    currency: 'CHF' as const,
    priceChfMinor: p.priceChfMinor,
    catalogVersion: p.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}
async function firstPeriod() {
  await store().createContract(input);
  return store().reservePeriod(input.contractId, 0);
}
async function paidFirst() {
  const p = await firstPeriod();
  await store().bindTransaction(p.periodId, 71);
  await store().recordReconciledSettlement(settlement(p));
  return p;
}
beforeEach(() => {
  clock = Date.parse('2026-01-31T09:17:23Z') / 1000;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
});
afterEach(() => db.close());
describe('Prepaid contracts and immutable local periods (no provider payment)', () => {
  it('freezes one anchor across concurrent workers and later replay', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, () => store().createContract(input)),
    );
    expect(new Set(results.map((r) => r.anchorStart)).size).toBe(1);
    const original = clock;
    clock += 1000;
    expect(await store().createContract(input)).toEqual({
      contractId: input.contractId,
      anchorStart: original,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM prepaid_contracts').get()?.n,
    ).toBe(1);
  });
  it.each([
    'ownerId',
    'organizationId',
    'workspaceId',
    'spaceId',
    'environment',
    'productKey',
  ])('does not silently rebind a contract when %s changes', async (field) => {
    await store().createContract(input);
    const values: Record<string, unknown> = {
      ownerId: 'different-user',
      organizationId: 'different-company',
      workspaceId: 'different-support',
      spaceId: 406,
      environment: 'PRODUCTION',
      productKey: 'complet:pro',
    };
    await expect(
      store().createContract({ ...input, [field]: values[field] }),
    ).rejects.toThrow('conflict');
  });
  it('rejects Stripe identities, unknown catalogue keys and missing product scope', async () => {
    await expect(
      store().createContract({ ...input, contractId: 'sub_123' }),
    ).rejects.toThrow('invalid');
    await expect(
      store().createContract({ ...input, productKey: 'anything' }),
    ).rejects.toThrow('invalid');
    await expect(
      store().createContract({ ...input, organizationId: null }),
    ).rejects.toThrow('invalid');
    await expect(
      store().createContract({
        ...input,
        productKey: 'support:team',
        workspaceId: null,
      }),
    ).rejects.toThrow('invalid');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM prepaid_contracts').get()?.n,
    ).toBe(0);
  });
  it('reserves one immutable period with complete price and component limits', async () => {
    await store().createContract(input);
    const periods = await Promise.all(
      Array.from({ length: 24 }, () =>
        store().reservePeriod(input.contractId, 0),
      ),
    );
    expect(new Set(periods.map((p) => p.periodId)).size).toBe(1);
    expect(periods[0]).toMatchObject({
      priceChfMinor: 9900,
      currency: 'CHF',
      catalog: {
        gestion: { seats: 3, ownerIncluded: true, licensePriceChfMinor: 5900 },
        support: { analyses: 5000 },
        automation: true,
      },
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM prepaid_periods').get()?.n,
    ).toBe(1);
  });
  it('does not treat a reserved period or a provider transaction as payment', async () => {
    const p = await firstPeriod();
    expect(await store().paidCoverage(input)).toBeNull();
    await store().bindTransaction(p.periodId, 71);
    expect(await store().paidCoverage(input)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()?.n).toBe(
      0,
    );
  });
  it('binds a transaction once and prevents using it for a second contract', async () => {
    const p = await firstPeriod();
    await store().bindTransaction(p.periodId, 71);
    await store().bindTransaction(p.periodId, 71);
    await expect(store().bindTransaction(p.periodId, 72)).rejects.toThrow(
      'conflict',
    );
    const second = {
      ...input,
      contractId: 'pfp_22c36d11-7232-4fa8-b8a5-b74518740554',
    };
    await store().createContract(second);
    const q = await store().reservePeriod(second.contractId, 0);
    await expect(store().bindTransaction(q.periodId, 71)).rejects.toThrow(
      'conflict',
    );
  });
  it('prevents starting a renewal early or charging skipped unpaid periods', async () => {
    const p = await firstPeriod();
    await expect(store().reservePeriod(input.contractId, 1)).rejects.toThrow(
      'not_due',
    );
    clock = p.endsAt;
    await expect(store().reservePeriod(input.contractId, 1)).rejects.toThrow(
      'unpaid_previous',
    );
    clock = Date.parse('2026-04-01T00:00:00Z') / 1000;
    await expect(store().reservePeriod(input.contractId, 2)).rejects.toThrow(
      'unpaid_previous',
    );
  });
  it('keeps immutable coverage boundaries and restores the original day after February', async () => {
    const p = await paidFirst();
    clock = p.endsAt;
    const q = await store().reservePeriod(input.contractId, 1);
    expect(new Date(q.startsAt * 1000).toISOString()).toBe(
      '2026-02-28T09:17:23.000Z',
    );
    expect(new Date(q.endsAt * 1000).toISOString()).toBe(
      '2026-03-31T09:17:23.000Z',
    );
    expect(await store().paidCoverage(input)).toBeNull();
    await store().bindTransaction(q.periodId, 72);
    await store().recordReconciledSettlement(
      settlement(q, {
        transactionId: 72,
        invoiceId: 82,
        evidenceFingerprint: 'b'.repeat(64),
      }),
    );
    expect((await store().paidCoverage(input))?.periodId).toBe(q.periodId);
    clock = q.endsAt;
    expect(await store().paidCoverage(input)).toBeNull();
  });
  it('requires the same owner, scopes and environment to read paid coverage', async () => {
    const p = await paidFirst();
    expect((await store().paidCoverage(input))?.periodId).toBe(p.periodId);
    for (const changed of [
      { ownerId: 'stranger' },
      { organizationId: 'wrong-company' },
      { workspaceId: 'wrong-support' },
      { environment: 'PRODUCTION' as const },
    ])
      expect(await store().paidCoverage({ ...input, ...changed })).toBeNull();
    clock = p.startsAt - 1;
    expect(await store().paidCoverage(input)).toBeNull();
  });
  it.each([
    'ownerId',
    'spaceId',
    'environment',
    'organizationId',
    'workspaceId',
    'priceChfMinor',
    'startsAt',
    'catalogVersion',
  ])(
    'rejects wrong %s on settlement and on replay of an existing proof',
    async (field) => {
      const p = await firstPeriod();
      await store().bindTransaction(p.periodId, 71);
      const values: Record<string, unknown> = {
        ownerId: 'wrong',
        spaceId: 406,
        environment: 'PRODUCTION',
        organizationId: 'wrong',
        workspaceId: 'wrong',
        priceChfMinor: 1,
        startsAt: p.startsAt + 1,
        catalogVersion: 'wrong',
      };
      await expect(
        store().recordReconciledSettlement(
          settlement(p, { [field]: values[field] }),
        ),
      ).rejects.toThrow('conflict');
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM prepaid_settlement_proofs').get()
          ?.n,
      ).toBe(0);
      await store().recordReconciledSettlement(settlement(p));
      await expect(
        store().recordReconciledSettlement(
          settlement(p, { [field]: values[field] }),
        ),
      ).rejects.toThrow('conflict');
      expect((await store().paidCoverage(input))?.priceChfMinor).toBe(9900);
    },
  );
  it('does not rewrite a proof or reset its dates on repeated reception', async () => {
    const p = await paidFirst(),
      recordedAt = clock;
    clock += 300;
    await store().recordReconciledSettlement(settlement(p));
    expect(
      db.prepare('SELECT reconciled_at FROM prepaid_settlement_proofs').get()
        ?.reconciled_at,
    ).toBe(recordedAt);
    await expect(
      store().recordReconciledSettlement(settlement(p, { invoiceId: 82 })),
    ).rejects.toThrow('conflict');
    await expect(
      store().recordReconciledSettlement(
        settlement(p, { evidenceFingerprint: 'b'.repeat(64) }),
      ),
    ).rejects.toThrow('conflict');
  });
  it('cancels renewal monotonically and preserves only the paid coverage', async () => {
    const p = await paidFirst(),
      cancelledAt = await store().cancelRenewal(input.contractId);
    clock += 60;
    expect(await store().cancelRenewal(input.contractId)).toBe(cancelledAt);
    expect((await store().paidCoverage(input))?.periodId).toBe(p.periodId);
    expect((await store().reservePeriod(input.contractId, 0)).periodId).toBe(
      p.periodId,
    );
    clock = p.endsAt;
    await expect(store().reservePeriod(input.contractId, 1)).rejects.toThrow(
      'cancelled',
    );
    expect(await store().paidCoverage(input)).toBeNull();
  });
  it('keeps refund revocation through delayed settlement replay and denies renewal', async () => {
    const p = await paidFirst();
    await store().revokeReconciledPeriod(p.periodId, 'b'.repeat(64));
    await store().recordReconciledSettlement(settlement(p));
    expect(await store().paidCoverage(input)).toBeNull();
    clock = p.endsAt;
    await expect(store().reservePeriod(input.contractId, 1)).rejects.toThrow(
      'unpaid_previous',
    );
  });
  it('never creates licence, seat, Support or Automation legacy projections', async () => {
    await paidFirst();
    for (const table of [
      'subscriptions',
      'organizations',
      'license_activations',
      'support_subscriptions',
      'automation_subscriptions',
      'complete_subscriptions',
    ])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  });
  it('freezes the nested catalogue snapshot read from storage', async () => {
    const p = await firstPeriod();
    expect(() => {
      (p.catalog.gestion as { seats: number }).seats = 10;
    }).toThrow();
    expect(() => {
      (p.catalog.support as { analyses: number }).analyses = 999999;
    }).toThrow();
    expect(() => {
      (p.catalog as { automation: boolean }).automation = false;
    }).toThrow();
    expect(
      (await store().reservePeriod(input.contractId, 0)).catalog.gestion?.seats,
    ).toBe(3);
  });
  it('enforces immutable facts and permanent additive revocation in SQLite', async () => {
    const p = await paidFirst();
    await store().revokeReconciledPeriod(p.periodId, 'b'.repeat(64));
    expect(() =>
      db.prepare('UPDATE prepaid_contracts SET owner_id=?').run('stranger'),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('UPDATE prepaid_periods SET price_chf_minor=1').run(),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('UPDATE prepaid_transactions SET transaction_id=99').run(),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('UPDATE prepaid_settlement_proofs SET invoice_id=99').run(),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('UPDATE prepaid_period_revocations SET revoked_at=1').run(),
    ).toThrow('immutable');
    for (const table of [
      'prepaid_contracts',
      'prepaid_periods',
      'prepaid_transactions',
      'prepaid_settlement_proofs',
      'prepaid_period_revocations',
    ])
      expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(
        'immutable',
      );
    await store().cancelRenewal(input.contractId);
    expect(() =>
      db.prepare('UPDATE prepaid_contracts SET cancelled_at=NULL').run(),
    ).toThrow('immutable');
    expect(await store().paidCoverage(input)).toBeNull();
  });
});
