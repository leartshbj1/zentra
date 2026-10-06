import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { D1PrepaidPeriods, type PrepaidPeriod } from './prepaid-periods';
import {
  D1PostFinanceWebhookInbox,
  type WebhookWork,
} from './postfinance-store';
import {
  D1PrepaidReconciliationStore,
  type ReconciliationTarget,
} from './prepaid-reconciliation-store';
import { prepaidCompanyAccess } from './prepaid-access';
import { vi } from 'vitest';
const fixture = vi.hoisted(() => ({ database: null as unknown }));
vi.mock('@/lib/runtime', () => ({ database: () => fixture.database }));

let sql: DatabaseSync, time: number;
const origin = 'https://checkout.postfinance.ch';
const identity = {
  contractId: 'pfp_11111111-1111-4111-8111-111111111111',
  ownerId: 'owner-reconcile',
  organizationId: 'company-reconcile',
  workspaceId: null,
  apiOrigin: origin,
  spaceId: 405,
  environment: 'PRODUCTION' as const,
  productKey: 'gestion:start',
};
const expectation = {
  customerReference: 'pfpayer_synthetic',
  planReference: 'zentra-prepaid-chf-monthly-v1',
  paymentMethodConfigurationId: 91,
  connectorConfigurationId: 92,
};
let period: PrepaidPeriod;
function d1() {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
        async run() {
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
      };
      return statement;
    },
  } as unknown as Pick<D1Database, 'prepare'>;
}
const periods = () => new D1PrepaidPeriods(d1(), () => time);
const store = () => new D1PrepaidReconciliationStore(d1(), () => time);
const inbox = () =>
  new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin: origin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => time,
  );
async function work(eventId = 1): Promise<WebhookWork> {
  const event = {
    eventId,
    entityId: 71,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(time * 1000).toISOString(),
  };
  await inbox().acceptOnce(`${origin}|405|10|${eventId}`, event);
  return (await inbox().claimNext())!;
}
function proof() {
  return {
    periodId: period.periodId,
    transactionId: 71,
    invoiceId: 81,
    apiOrigin: origin,
    spaceId: 405,
    environment: identity.environment,
    ownerId: identity.ownerId,
    organizationId: identity.organizationId,
    workspaceId: null,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    currency: 'CHF' as const,
    priceChfMinor: period.priceChfMinor,
    catalogVersion: period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  };
}
beforeEach(async () => {
  time = Math.floor(Date.now() / 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'),
    );
  fixture.database = d1();
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at)
    VALUES(?,?,'prepaid-local','incomplete',0,1,?)`)
    .run(identity.contractId, identity.contractId, time);
  await periods().createContract(identity);
  period = await periods().reservePeriod(identity.contractId, 0);
  await store().freezeExpectation(period.periodId, expectation);
  await periods().bindTransaction(period.periodId, 71);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(
      identity.organizationId,
      'PME fictive',
      identity.contractId,
      identity.ownerId,
      time,
      time,
    );
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('owner-membership',?,?,?,'owner',?)`)
    .run(identity.organizationId, identity.ownerId, 'owner@example.test', time);
});
afterEach(() => sql.close());

describe('durable reconciliation expectations, leases and refund ordering', () => {
  it('freezes the actual method and payer once, even between independent workers', async () => {
    await Promise.all(
      Array.from({ length: 16 }, () =>
        store().freezeExpectation(period.periodId, expectation),
      ),
    );
    const target = await store().target(origin, 405, 71);
    expect(target).toMatchObject({
      ...expectation,
      transactionId: 71,
      period: { periodId: period.periodId },
    });
    await expect(
      store().freezeExpectation(period.periodId, {
        ...expectation,
        paymentMethodConfigurationId: 999,
      }),
    ).rejects.toThrow('conflict');
    expect(
      sql
        .prepare('SELECT COUNT(*) AS n FROM prepaid_payment_expectations')
        .get()?.n,
    ).toBe(1);
    expect(() =>
      sql.exec(
        "UPDATE prepaid_payment_expectations SET customer_reference='another'",
      ),
    ).toThrow('immutable');
    expect(() => sql.exec('DELETE FROM prepaid_payment_expectations')).toThrow(
      'immutable',
    );
  });
  it.each([
    [origin, 406, 71],
    ['https://app-wallee.com', 405, 71],
    [origin, 405, 72],
  ] as const)(
    'does not resolve a payment from a different provider scope (%s %s %s)',
    async (api, space, id) => {
      expect(await store().target(api, space, id)).toBeNull();
    },
  );
  it('requires an immutable expectation before loading a bound transaction', async () => {
    const other = {
      ...identity,
      contractId: 'pfp_22222222-2222-4222-8222-222222222222',
    };
    await periods().createContract(other);
    const p = await periods().reservePeriod(other.contractId, 0);
    await periods().bindTransaction(p.periodId, 72);
    expect(await store().target(origin, 405, 72)).toBeNull();
    await expect(
      store().freezeExpectation(p.periodId, {
        ...expectation,
        planReference: 'unapproved-version',
      }),
    ).rejects.toThrow('conflict');
  });
  it('preserves a verified refund received before any paid event without creating a paid fact', async () => {
    const target = (await store().target(origin, 405, 71))!;
    const paidWork = await work(1),
      refundWork = await work(2);
    await store().recordReversal(target, 'b'.repeat(64), refundWork);
    await expect(store().recordPaid(proof(), paidWork)).rejects.toThrow(
      'conflict',
    );
    expect(await periods().paidCoverage(identity)).toBeNull();
    expect(await prepaidCompanyAccess(identity.organizationId)).toBeNull();
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM prepaid_settlement_proofs').get()
        ?.n,
    ).toBe(0);
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM prepaid_provider_reversals').get()
        ?.n,
    ).toBe(1);
    expect(await inbox().completeWork(refundWork)).toBe(true);
  });
  it('removes TypeScript and D1 seat rights together after a paid period is reversed', async () => {
    const paidWork = await work(1);
    expect(await store().recordPaid(proof(), paidWork)).toBe(true);
    expect(await prepaidCompanyAccess(identity.organizationId)).not.toBeNull();
    expect(
      sql
        .prepare('SELECT COUNT(*) AS n FROM prepaid_current_company_rights')
        .get()?.n,
    ).toBe(1);
    await store().recordReversal(
      (await store().target(origin, 405, 71))!,
      'c'.repeat(64),
      await work(2),
    );
    expect(await prepaidCompanyAccess(identity.organizationId)).toBeNull();
    expect(
      sql
        .prepare('SELECT COUNT(*) AS n FROM prepaid_current_company_rights')
        .get()?.n,
    ).toBe(0);
    expect(await store().recordPaid(proof(), paidWork)).toBe(false);
    expect(() => sql.exec('DELETE FROM prepaid_provider_reversals')).toThrow(
      'immutable',
    );
    expect(() =>
      sql.exec('UPDATE prepaid_provider_reversals SET reversed_at=1'),
    ).toThrow('immutable');
  });
  it('does not let an expired or stolen webhook lease insert a settlement', async () => {
    const old = await work();
    time = old.leaseUntil;
    await expect(store().recordPaid(proof(), old)).rejects.toThrow('conflict');
    const newWork = (await inbox().claimNext())!;
    expect(newWork.lease).not.toBe(old.lease);
    await expect(store().recordPaid(proof(), old)).rejects.toThrow('conflict');
    expect(await store().recordPaid(proof(), newWork)).toBe(true);
    expect(await inbox().completeWork(old)).toBe(false);
    expect(await inbox().completeWork(newWork)).toBe(true);
  });
  it('does not let an expired or wrong-space lease insert a refund tombstone', async () => {
    const owned = await work();
    const target = (await store().target(origin, 405, 71))!;
    await expect(
      store().recordReversal(
        { ...target, spaceId: 406 },
        'b'.repeat(64),
        owned,
      ),
    ).rejects.toThrow('invalid');
    time = owned.leaseUntil;
    await expect(
      store().recordReversal(target, 'b'.repeat(64), owned),
    ).rejects.toThrow('conflict');
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM prepaid_provider_reversals').get()
        ?.n,
    ).toBe(0);
  });
  it('replays a refund without restoring access or rewriting its original evidence', async () => {
    const owned = await work();
    const target = (await store().target(origin, 405, 71))!;
    await store().recordReversal(target, 'b'.repeat(64), owned);
    await store().recordReversal(target, 'c'.repeat(64), owned);
    expect(
      sql
        .prepare('SELECT evidence_fingerprint FROM prepaid_provider_reversals')
        .get()?.evidence_fingerprint,
    ).toBe('b'.repeat(64));
    expect(await store().isReversed(period.periodId)).toBe(true);
  });
  it.each<[string, (target: ReconciliationTarget) => ReconciliationTarget]>([
    ['owner', (target) => ({ ...target, ownerId: 'another-owner' })],
    ['company', (target) => ({ ...target, organizationId: 'another-company' })],
    [
      'workspace',
      (target) => ({ ...target, workspaceId: 'another-workspace' }),
    ],
    ['environment', (target) => ({ ...target, environment: 'TEST' })],
    ['transaction', (target) => ({ ...target, transactionId: 72 })],
    ['payer', (target) => ({ ...target, customerReference: 'another-payer' })],
    [
      'plan reference',
      (target) => ({ ...target, planReference: 'another-version' }),
    ],
    ['method', (target) => ({ ...target, paymentMethodConfigurationId: 99 })],
    ['connector', (target) => ({ ...target, connectorConfigurationId: 99 })],
    [
      'contract',
      (target) => ({
        ...target,
        period: {
          ...target.period,
          contractId: 'pfp_22222222-2222-4222-8222-222222222222',
        },
      }),
    ],
    [
      'ordinal',
      (target) => ({ ...target, period: { ...target.period, ordinal: 1 } }),
    ],
    [
      'start',
      (target) => ({
        ...target,
        period: { ...target.period, startsAt: target.period.startsAt + 1 },
      }),
    ],
    [
      'end',
      (target) => ({
        ...target,
        period: { ...target.period, endsAt: target.period.endsAt + 1 },
      }),
    ],
    [
      'price',
      (target) => ({
        ...target,
        period: {
          ...target.period,
          priceChfMinor: target.period.priceChfMinor + 1,
        },
      }),
    ],
    [
      'catalogue version',
      (target) => ({
        ...target,
        period: { ...target.period, catalogVersion: 'another-version' },
      }),
    ],
    [
      'catalogue snapshot',
      (target) => ({
        ...target,
        period: {
          ...target.period,
          catalog: {
            ...target.period.catalog,
            gestion: { ...target.period.catalog.gestion!, seats: 99 },
          },
        },
      }),
    ],
  ])(
    'rejects a %s mismatch when replaying an already recorded reversal',
    async (_label, changed) => {
      const owned = await work(),
        target = (await store().target(origin, 405, 71))!;
      await store().recordReversal(target, 'b'.repeat(64), owned);
      await expect(
        store().recordReversal(changed(target), 'c'.repeat(64), owned),
      ).rejects.toThrow('conflict');
      expect(
        sql
          .prepare(
            'SELECT evidence_fingerprint FROM prepaid_provider_reversals',
          )
          .get()?.evidence_fingerprint,
      ).toBe('b'.repeat(64));
      expect(await store().isReversed(period.periodId)).toBe(true);
      expect(
        await store().recordReversal(target, 'd'.repeat(64), owned),
      ).toBeUndefined();
    },
  );
});
