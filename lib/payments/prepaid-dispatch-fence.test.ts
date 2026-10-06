import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import { D1PrepaidPeriods, type PrepaidPeriod } from './prepaid-periods';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import { PostFinanceCheckoutClient } from './postfinance-client';
import {
  D1PostFinanceMutationLedger,
  type PrepaidMutationFence,
} from './postfinance-store';

let sql: DatabaseSync, clock: number, period: PrepaidPeriod;
let network: ReturnType<typeof vi.spyOn>;
const origin = 'https://checkout.postfinance.ch';
const identity = {
  contractId: 'pfp_11111111-1111-4111-8111-111111111111',
  ownerId: 'owner-dispatch',
  organizationId: 'company-dispatch',
  workspaceId: 'support-dispatch',
  apiOrigin: origin,
  spaceId: 405,
  environment: 'PRODUCTION' as const,
  productKey: 'complet:team',
};
const fingerprint = 'a'.repeat(43);
function database() {
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
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
      };
      return statement;
    },
  } as unknown as Pick<D1Database, 'prepare'>;
}
const periods = () => new D1PrepaidPeriods(database(), () => clock);
const expectations = () =>
  new D1PrepaidReconciliationStore(database(), () => clock);
const count = () =>
  sql.prepare('SELECT COUNT(*) AS n FROM postfinance_mutations').get()?.n;
function fence(
  operation: PrepaidMutationFence['operation'] = 'create',
  transactionId?: number,
): PrepaidMutationFence {
  return {
    ...identity,
    periodId: period.periodId,
    operation,
    ...(transactionId === undefined ? {} : { transactionId }),
  };
}
function scope(value = fence()) {
  const path =
    value.operation === 'create'
      ? '/payment/transactions'
      : `/payment/transactions/${value.transactionId}/${value.operation === 'confirm' ? 'confirm' : 'charge-flow/apply'}`;
  return `${value.apiOrigin}|${value.spaceId}|POST|${path}|${value.periodId}_${value.operation}`;
}
function ledger(value: PrepaidMutationFence = fence()) {
  return new D1PostFinanceMutationLedger(database(), () => clock, value);
}
async function freeze(p = period) {
  await expectations().freezeExpectation(p.periodId, {
    customerReference: 'fictional-payer',
    planReference: p.catalogVersion,
    paymentMethodConfigurationId: 91,
    connectorConfigurationId: 92,
  });
}
async function recordPaid(p = period, transactionId = 71) {
  await periods().bindTransaction(p.periodId, transactionId);
  await periods().recordReconciledSettlement({
    ...identity,
    periodId: p.periodId,
    transactionId,
    invoiceId: transactionId + 10,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    currency: 'CHF',
    priceChfMinor: p.priceChfMinor,
    catalogVersion: p.catalogVersion,
    evidenceFingerprint: 'b'.repeat(64),
  });
}
beforeEach(async () => {
  clock = Date.parse('2026-01-31T09:17:23Z') / 1000;
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at)
    VALUES(?,?,'fictional','incomplete',0,1,?)`)
    .run(identity.contractId, identity.contractId, clock);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(
      identity.organizationId,
      'Fictional local PME',
      identity.contractId,
      identity.ownerId,
      clock,
      clock,
    );
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('fixture-owner',?,?,?,'owner',?)`)
    .run(
      identity.organizationId,
      identity.ownerId,
      'owner@example.test',
      clock,
    );
  sql
    .prepare(
      `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,'Fictional support',?,?)`,
    )
    .run(identity.workspaceId, identity.ownerId, clock, clock);
  await periods().createContract(identity);
  period = await periods().reservePeriod(identity.contractId, 0);
  await freeze();
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('No merchant call is allowed');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  sql.close();
});

describe('atomic prepaid financial dispatch fence on actual migration SQL', () => {
  it('refuses cancellation before claim without inserting a ledger row or reaching a provider transport', async () => {
    await periods().cancelRenewal(identity.contractId);
    const transport = vi.fn(async () => Response.json({ id: 71 }));
    const client = new PostFinanceCheckoutClient(
      {
        enabled: true,
        apiOrigin: origin,
        spaceId: 405,
        applicationUserId: '512',
        authenticationKeyBase64: Buffer.alloc(32, 7).toString('base64'),
        returnOrigin: 'https://zentraapp.ch',
        merchantApproved: true,
        chargeFlowEnabled: true,
        postfinancePayTokenEnabled: true,
        prepaidFeatureEnabled: true,
        prepaidEnvironment: 'PRODUCTION',
        prepaidProducts: {
          'complet:team': {
            currency: 'CHF',
            billingPeriod: 'P1M',
            priceChfMinor: 9900,
            reference: period.catalogVersion,
            name: 'Fictional team',
            methodConfigurations: { postfinance_pay: 91 },
          },
        },
      },
      { ledger: ledger(), fetch: transport },
    );
    await expect(
      client.createPrepaidTransaction(
        {
          productKey: 'complet:team',
          periodId: period.periodId,
          customerReference: 'fictional-payer',
          emailAddress: 'owner@example.test',
          urls: {
            successUrl: 'https://zentraapp.ch/compte',
            failureUrl: 'https://zentraapp.ch/compte',
          },
        },
        'postfinance_pay',
        `${period.periodId}_create`,
      ),
    ).rejects.toThrow('dispatch is unavailable');
    expect(transport).not.toHaveBeenCalled();
    expect(count()).toBe(0);
  });
  it('requires the current [start,end) period and its frozen payment expectation', async () => {
    clock = period.startsAt - 1;
    await expect(ledger().claim(scope(), fingerprint)).rejects.toThrow(
      'dispatch is unavailable',
    );
    clock = period.endsAt;
    await expect(ledger().claim(scope(), fingerprint)).rejects.toThrow(
      'dispatch is unavailable',
    );
    clock = period.startsAt;
    const another = {
      ...identity,
      contractId: 'pfp_22222222-2222-4222-8222-222222222222',
    };
    await periods().createContract(another);
    const unprepared = await periods().reservePeriod(another.contractId, 0);
    const value = {
      ...fence(),
      contractId: another.contractId,
      periodId: unprepared.periodId,
    };
    await expect(
      ledger(value).claim(scope(value), fingerprint),
    ).rejects.toThrow('dispatch is unavailable');
    expect(count()).toBe(0);
    expect(await ledger().claim(scope(), fingerprint)).toEqual({
      kind: 'claimed',
    });
  });
  it('rechecks the preceding paid fact after reservation so a subsequent refund blocks renewal', async () => {
    const previous = period;
    await recordPaid(previous);
    clock = previous.endsAt;
    period = await periods().reservePeriod(identity.contractId, 1);
    await freeze();
    await periods().revokeReconciledPeriod(previous.periodId, 'c'.repeat(64));
    await expect(ledger().claim(scope(), fingerprint)).rejects.toThrow(
      'dispatch is unavailable',
    );
    expect(count()).toBe(0);
  });
  it('refuses a prepared renewal with an unpaid preceding period rather than relying on its reservation', async () => {
    const dates = prepaidMonthlyPeriod(period.startsAt, 1);
    clock = dates.startSeconds;
    period = {
      ...period,
      periodId: `pfperiod_${createHash('sha256').update(`${identity.contractId}|1`).digest('hex')}`,
      ordinal: 1,
      startsAt: dates.startSeconds,
      endsAt: dates.endSeconds,
    };
    // Deliberately prepared incomplete local state: the real SQL fence, not
    // the reservation helper, must reject dispatch without a preceding proof.
    sql
      .prepare(`INSERT INTO prepaid_periods(period_id,contract_id,ordinal,starts_at,ends_at,currency,price_chf_minor,catalog_version,catalog_json,created_at)
      VALUES(?,?,?,?,?,'CHF',?,?,?,?)`)
      .run(
        period.periodId,
        identity.contractId,
        1,
        period.startsAt,
        period.endsAt,
        period.priceChfMinor,
        period.catalogVersion,
        JSON.stringify(period.catalog),
        clock,
      );
    await freeze();
    await expect(ledger().claim(scope(), fingerprint)).rejects.toThrow(
      'dispatch is unavailable',
    );
    expect(count()).toBe(0);
  });
  it('admits a current renewal with the actual adjacent paid period, then refuses a revoked current period', async () => {
    const previous = period;
    await recordPaid(previous);
    clock = previous.endsAt;
    period = await periods().reservePeriod(identity.contractId, 1);
    await freeze();
    expect(await ledger().claim(scope(), fingerprint)).toEqual({
      kind: 'claimed',
    });
    await periods().bindTransaction(period.periodId, 72);
    sql
      .prepare('INSERT INTO prepaid_provider_reversals VALUES(?,?,?)')
      .run(period.periodId, 'd'.repeat(64), clock);
    const value = fence('chargeflow', 72);
    await expect(
      ledger(value).claim(scope(value), fingerprint),
    ).rejects.toThrow('dispatch is unavailable');
    expect(count()).toBe(1);
  });
  it.each(['claim-first', 'cancel-first'] as const)(
    'serializes %s ordering at the atomic ledger INSERT',
    async (order) => {
      const store = ledger();
      let result: unknown;
      if (order === 'claim-first') {
        result = await store.claim(scope(), fingerprint);
        await periods().cancelRenewal(identity.contractId);
        expect(result).toEqual({ kind: 'claimed' });
        expect(count()).toBe(1);
        await store.complete(scope(), '{"id":71}');
        expect(await ledger().claim(scope(), fingerprint)).toEqual({
          kind: 'completed',
          json: '{"id":71}',
        });
      } else {
        await periods().cancelRenewal(identity.contractId);
        await expect(store.claim(scope(), fingerprint)).rejects.toThrow(
          'dispatch is unavailable',
        );
        expect(count()).toBe(0);
      }
    },
  );
  it('executes the cancellation check in the INSERT even when cancellation arrives while claim is awaiting its hash', async () => {
    const pending = ledger().claim(scope(), fingerprint);
    sql
      .prepare(
        'UPDATE prepaid_contracts SET cancelled_at=? WHERE contract_id=?',
      )
      .run(clock, identity.contractId);
    await expect(pending).rejects.toThrow('dispatch is unavailable');
    expect(count()).toBe(0);
  });
  it('has only one financial winner across concurrent independent instances', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, () => ledger().claim(scope(), fingerprint)),
    );
    expect(results.filter((x) => x.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((x) => x.kind === 'uncertain')).toHaveLength(15);
    expect(count()).toBe(1);
  });
  it.each([
    'owner',
    'contract',
    'organization',
    'workspace',
    'origin',
    'space',
    'environment',
  ] as const)(
    'rejects %s context mismatches, including a completed result belonging to someone else',
    async (field) => {
      const own = ledger();
      await own.claim(scope(), fingerprint);
      await own.complete(scope(), '{"id":71}');
      const changes = {
        owner: { ownerId: 'foreign-owner' },
        contract: { contractId: 'pfp_22222222-2222-4222-8222-222222222222' },
        organization: { organizationId: 'foreign-company' },
        workspace: { workspaceId: 'foreign-support' },
        origin: { apiOrigin: 'https://app-wallee.com' },
        space: { spaceId: 406 },
        environment: { environment: 'TEST' as const },
      };
      const value = { ...fence(), ...changes[field] };
      await expect(
        ledger(value).claim(scope(value), fingerprint),
      ).rejects.toThrow('dispatch is unavailable');
      expect(count()).toBe(1);
    },
  );
  it.each(['path', 'key', 'method', 'transaction'] as const)(
    'rejects a changed %s rather than reserving another operation',
    async (change) => {
      const original = scope();
      const altered = {
        path: original.replace('/payment/transactions', '/subscriptions'),
        key: original + '2',
        method: original.replace('|POST|', '|GET|'),
        transaction: original.replace(
          '/payment/transactions',
          '/payment/transactions/71/confirm',
        ),
      }[change];
      await expect(ledger().claim(altered, fingerprint)).rejects.toThrow(
        'scope mismatch',
      );
      expect(count()).toBe(0);
    },
  );
  it.each(['confirm', 'chargeflow'] as const)(
    'binds the %s dispatch to its exact transaction and forbids already paid periods',
    async (operation) => {
      await periods().bindTransaction(period.periodId, 71);
      const wrong = fence(operation, 72);
      await expect(
        ledger(wrong).claim(scope(wrong), fingerprint),
      ).rejects.toThrow('dispatch is unavailable');
      const value = fence(operation, 71);
      expect(await ledger(value).claim(scope(value), fingerprint)).toEqual({
        kind: 'claimed',
      });
      await recordPaid();
      const other = fence(
        operation === 'confirm' ? 'chargeflow' : 'confirm',
        71,
      );
      await expect(
        ledger(other).claim(scope(other), fingerprint),
      ).rejects.toThrow('dispatch is unavailable');
      expect(count()).toBe(1);
    },
  );
  it('preserves uncertain operations forever, without a new financial claim after clock or cancellation changes', async () => {
    const own = ledger();
    await own.claim(scope(), fingerprint);
    await own.markUncertain(scope());
    clock = period.endsAt + 86400 * 365;
    await periods().cancelRenewal(identity.contractId);
    expect(await ledger().claim(scope(), fingerprint)).toEqual({
      kind: 'uncertain',
    });
    expect(await ledger().claim(scope(), 'b'.repeat(43))).toEqual({
      kind: 'conflict',
    });
    expect(count()).toBe(1);
  });
  it('replays completed creation after transaction binding, cancellation and expiry without modifying its recorded response', async () => {
    const own = ledger();
    await own.claim(scope(), fingerprint);
    await own.complete(scope(), '{"id":71}');
    await periods().bindTransaction(period.periodId, 71);
    await periods().cancelRenewal(identity.contractId);
    clock = period.endsAt;
    expect(await ledger().claim(scope(), fingerprint)).toEqual({
      kind: 'completed',
      json: '{"id":71}',
    });
    expect(await ledger().claim(scope(), 'b'.repeat(43))).toEqual({
      kind: 'conflict',
    });
    expect(
      sql.prepare('SELECT response_json FROM postfinance_mutations').get()
        ?.response_json,
    ).toBe('{"id":71}');
  });
  it('clones the server fence and rejects an owner whose actual membership was revoked', async () => {
    const mutable = { ...fence() };
    const owned = ledger(mutable);
    mutable.ownerId = 'foreign-owner';
    expect(await owned.claim(scope(), fingerprint)).toEqual({
      kind: 'claimed',
    });
    await owned.complete(scope(), '{"id":71}');
    sql
      .prepare('UPDATE organization_members SET revoked_at=? WHERE user_id=?')
      .run(clock, identity.ownerId);
    await expect(ledger().claim(scope(), fingerprint)).rejects.toThrow(
      'dispatch is unavailable',
    );
  });
  it('keeps unfenced historical calls unchanged', async () => {
    const key = `${origin}|405|POST|/subscriptions|legacy-fixture`;
    const own = new D1PostFinanceMutationLedger(database(), () => clock);
    expect(await own.claim(key, fingerprint)).toEqual({ kind: 'claimed' });
    await own.complete(key, '{"subscription":{"id":99}}');
    expect(
      await new D1PostFinanceMutationLedger(database(), () => clock).claim(
        key,
        fingerprint,
      ),
    ).toEqual({ kind: 'completed', json: '{"subscription":{"id":99}}' });
  });
});
