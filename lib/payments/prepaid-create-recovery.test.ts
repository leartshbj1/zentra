import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LEGAL_VERSION } from '@/lib/legal';
import { prepaidCatalog } from './prepaid-catalog';
import { prepareInitialPrepaidPurchase } from './prepaid-purchase-preparation';
import {
  runInitialPrepaidCheckout,
  type PreparedInitialPrepaidPurchase,
} from './prepaid-initial-checkout';
import {
  recoverPrepaidCreate,
  type PrepaidCreateRecoveryConfiguration,
} from './prepaid-create-recovery';
import {
  D1PostFinanceMutationLedger,
  D1PostFinanceWebhookInbox,
} from './postfinance-store';
import { D1PrepaidProvisioning } from './prepaid-provisioning';
import { D1PrepaidTokens } from './prepaid-token';
import { PostFinanceCheckoutClient } from './postfinance-client';
import { runPrepaidRenewal } from './prepaid-renewal';

vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Inject D1');
  },
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));
let sql: DatabaseSync, clock: number, prepared: PreparedInitialPrepaidPurchase;
let configuration: PrepaidCreateRecoveryConfiguration,
  transaction: Record<string, unknown>;
type FixtureFetch = (url: string, init: RequestInit) => Promise<Response>;
let fetchFixture: ReturnType<typeof vi.fn<FixtureFetch>>,
  realNetwork: ReturnType<typeof vi.spyOn>;
let search: (attempt: number, offset: number) => Record<string, unknown>;
let mutateRead: (tx: Record<string, unknown>, attempt: number) => void;
let beforeBatch: (() => void) | undefined,
  interruptStatement: string | undefined;
let reads: number, searches: number, queries: string[];
const user = {
  userId: 'recovery-owner',
  email: 'owner@example.test',
  emailConfirmed: true,
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const count = (name: string) =>
  Number(sql.prepare(`SELECT COUNT(*) n FROM ${name}`).get()!.n);
function d1() {
  return {
    prepare(query: string) {
      queries.push(query);
      let values: SQLInputValue[] = [];
      const stmt = {
        bind(...v: SQLInputValue[]) {
          values = v;
          return stmt;
        },
        execute() {
          if (interruptStatement && query.includes(interruptStatement)) {
            interruptStatement = undefined;
            throw Error('Fixture storage failure');
          }
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async run() {
          return stmt.execute();
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
      };
      return stmt;
    },
    async batch(statements: { execute(): unknown }[]) {
      const f = beforeBatch;
      beforeBatch = undefined;
      f?.();
      sql.exec('BEGIN');
      try {
        const result = statements.map((s) => s.execute());
        sql.exec('COMMIT');
        return result;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
function config(): PrepaidCreateRecoveryConfiguration {
  return {
    enabled: true,
    createRecoveryEnabled: true,
    settlementEvidenceVerified: true,
    connectorConfigurations: { postfinance_pay: 92 },
    connection: {
      enabled: true,
      merchantApproved: true,
      prepaidFeatureEnabled: true,
      chargeFlowEnabled: true,
      postfinancePayTokenEnabled: true,
      prepaidEnvironment: 'TEST',
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      applicationUserId: '512',
      authenticationKeyBase64: Buffer.alloc(32, 0x5a).toString('base64'),
      returnOrigin: 'https://zentra.example.test',
      prepaidProducts: Object.fromEntries(
        prepaidCatalog().map((p) => [
          p.productKey,
          {
            currency: 'CHF',
            billingPeriod: 'P1M',
            priceChfMinor: p.priceChfMinor,
            reference: p.catalogVersion,
            name: p.name,
            methodConfigurations: { postfinance_pay: 91 },
          },
        ]),
      ),
    },
  };
}
const deps = () => ({
  database: d1,
  now: () => clock,
  fetch: fetchFixture as typeof fetch,
});
const recover = () =>
  recoverPrepaidCreate(
    configuration,
    { periodId: prepared.period.periodId },
    deps(),
  );
function ledger() {
  return sql
    .prepare(
      "SELECT * FROM postfinance_mutations WHERE state IN('claimed','uncertain','completed')",
    )
    .all();
}
function rights() {
  return [
    'organizations',
    'subscriptions',
    'organization_members',
    'support_workspaces',
    'support_gestion_links',
    'support_subscriptions',
    'automation_subscriptions',
    'complete_subscriptions',
    'prepaid_settlement_proofs',
    'device_sessions',
    'license_activations',
  ].map((name) => [
    name,
    sql.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(),
  ]);
}
async function setup(environment: 'TEST' | 'PRODUCTION' = 'TEST') {
  clock = Date.parse('2026-10-06T10:11:12Z') / 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  for (const f of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + f, import.meta.url), 'utf8'),
    );
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
    VALUES('trial','local','local','incomplete',0,?)`)
    .run(clock);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run('company-a', 'Fictional company', 'trial', user.userId, clock, clock);
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('member-a','company-a',?,?,'owner',?)`)
    .run(user.userId, user.email, clock);
  realNetwork = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No real network');
  });
  configuration = config();
  configuration.connection.prepaidEnvironment = environment;
  queries = [];
  beforeBatch = undefined;
  interruptStatement = undefined;
  reads = 0;
  searches = 0;
  mutateRead = () => {};
  search = (_attempt, offset) => ({
    data: [{ id: 55, linkedSpaceId: 405 }],
    offset,
    limit: 10,
    hasMore: false,
  });
  fetchFixture = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    expect(u.origin).toBe('https://checkout.postfinance.ch');
    expect((init.headers as Record<string, string>).Space).toBe('405');
    expect(init.redirect).toBe('error');
    if (
      init.method === 'POST' &&
      u.pathname === '/api/v2.0/payment/transactions'
    ) {
      const body = JSON.parse(init.body as string);
      transaction = {
        ...body,
        id: 55,
        linkedSpaceId: 405,
        state: 'PENDING',
        version: 7,
        environment: environment === 'TEST' ? 'PREVIEW' : 'LIVE',
        authorizationAmount: body.lineItems[0].amountIncludingTax,
        ...(body.token === undefined
          ? {}
          : { token: { id: body.token, linkedSpaceId: 405 } }),
      };
      throw Error('Accepted CREATE, lost HTTP response');
    }
    expect(init.method).toBe('GET');
    if (u.pathname.endsWith('/transactions/search')) {
      expect(u.searchParams.get('query')).toBe(
        `merchantReference:${prepared.period.periodId}`,
      );
      expect(u.searchParams.get('order')).toBe('id:ASC');
      expect(u.searchParams.get('limit')).toBe('10');
      return Response.json(
        search(++searches, Number(u.searchParams.get('offset'))),
      );
    }
    if (u.pathname.endsWith('/transactions/55')) {
      expect(u.searchParams.get('expand')).toBe(
        'token,paymentConnectorConfiguration.paymentMethodConfiguration.paymentMethod',
      );
      const fresh = structuredClone(transaction);
      mutateRead(fresh, ++reads);
      return Response.json(fresh);
    }
    throw Error('Unexpected recovery transport');
  });
  const p = await prepareInitialPrepaidPurchase(
    configuration,
    {
      user,
      requestId: '11111111-1111-4111-8111-111111111111',
      productKey: 'gestion:start',
      organizationId: 'company-a',
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion: LEGAL_VERSION,
    },
    deps(),
  );
  if (p.state !== 'prepared') throw Error('Expected real preparation');
  prepared = p;
  expect(
    (await runInitialPrepaidCheckout(configuration, prepared, deps())).state,
  ).toBe('uncertain');
  expect(count('prepaid_transactions')).toBe(0);
  expect(ledger()[0].state).toBe('uncertain');
  fetchFixture.mockClear();
  queries = [];
}
beforeEach(() => setup());
afterEach(() => {
  expect(realNetwork).not.toHaveBeenCalled();
  realNetwork.mockRestore();
  sql.close();
  vi.useRealTimers();
});

describe('GET-only accepted-but-lost CREATE recovery with atomic migrated SQLite', () => {
  it('accepts an independently constructed official GET object, including server-added line fields, without assuming the CREATE body is echoed', async () => {
    transaction = {
      id: 55,
      linkedSpaceId: 405,
      state: 'PENDING',
      version: 7,
      environment: 'PREVIEW',
      environmentSelectionStrategy: 'FORCE_TEST_ENVIRONMENT',
      currency: 'CHF',
      authorizationAmount: prepared.period.priceChfMinor / 100,
      customerId: prepared.expectation.customerReference,
      customerEmailAddress: 'owner@example.test',
      merchantReference: prepared.period.periodId,
      invoiceMerchantReference: prepared.period.periodId,
      metaData: {
        zentra_period_id: prepared.period.periodId,
        zentra_plan_version: prepared.period.catalogVersion,
      },
      lineItems: [
        {
          quantity: 1,
          name: prepared.period.catalog.name,
          amountIncludingTax: prepared.period.priceChfMinor / 100,
          type: 'PRODUCT',
          uniqueId: prepared.period.periodId,
          sku: prepared.period.catalogVersion,
          shippingRequired: false,
          amountExcludingTax: prepared.period.priceChfMinor / 100,
        },
      ],
      allowedPaymentMethodConfigurations: [91],
      customersPresence: 'VIRTUAL_PRESENT',
      completionBehavior: 'COMPLETE_IMMEDIATELY',
      autoConfirmationEnabled: false,
      successUrl: `https://zentra.example.test/compte?paiement=confirmation&achat=${prepared.intent.intentId}`,
      failedUrl: `https://zentra.example.test/pricing?paiement=annule&achat=${prepared.intent.intentId}`,
      tokenizationMode: 'FORCE_CREATION',
      paymentConnectorConfiguration: null,
      authorizationEnvironment: null,
    };
    expect((await recover()).state).toBe('bound');
    expect(fetchFixture.mock.calls.every((c) => c[1].method === 'GET')).toBe(
      true,
    );
  });
  it('missing optional-to-SDK but required-to-this-verifier facts never become a recovered binding', async () => {
    for (const field of [
      'currency',
      'customerId',
      'merchantReference',
      'invoiceMerchantReference',
      'environment',
      'environmentSelectionStrategy',
      'authorizationAmount',
      'lineItems',
      'metaData',
      'allowedPaymentMethodConfigurations',
      'successUrl',
      'autoConfirmationEnabled',
    ]) {
      mutateRead = (tx) => {
        delete tx[field];
      };
      await expect(recover()).rejects.toThrow();
      expect(count('prepaid_transactions')).toBe(0);
      expect(count('prepaid_create_recoveries')).toBe(0);
      expect(ledger()[0].state).toBe('uncertain');
    }
    expect(fetchFixture.mock.calls.every((c) => c[1].method === 'GET')).toBe(
      true,
    );
  });
  it('binds initial ID, reference, CREATE ledger and immutable trace together without rights, then replays with zero HTTP', async () => {
    const before = rights();
    expect(await recover()).toEqual({
      state: 'bound',
      periodId: prepared.period.periodId,
      transactionId: 55,
      reconciliationOnly: false,
    });
    expect(fetchFixture.mock.calls).toHaveLength(4);
    expect(rights()).toEqual(before);
    expect(ledger()[0].state).toBe('completed');
    expect(ledger()[0].claim_token).toBeNull();
    expect(count('prepaid_create_recoveries')).toBe(1);
    expect(count('prepaid_transactions')).toBe(1);
    expect(
      sql.prepare('SELECT provider_reference FROM purchase_intents').get()!
        .provider_reference,
    ).toBe('55');
    fetchFixture.mockClear();
    expect((await recover()).state).toBe('bound');
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(() =>
      sql
        .prepare('UPDATE prepaid_create_recoveries SET observed_version=8')
        .run(),
    ).toThrow('history');
    expect(() =>
      sql.prepare('DELETE FROM prepaid_create_recoveries').run(),
    ).toThrow('history');
  });
  it('recovers a still claimed operation after a crashed owner; it never steals or retries the POST', async () => {
    sql.prepare("UPDATE postfinance_mutations SET state='claimed'").run();
    expect((await recover()).state).toBe('bound');
    expect(fetchFixture.mock.calls.every((c) => c[1].method === 'GET')).toBe(
      true,
    );
  });
  it('default OFF returns before DB/HTTP; a recovery switch cannot bypass settlement/configuration gates', async () => {
    const db = vi.fn(() => {
      throw Error('No DB');
    });
    expect(
      await recoverPrepaidCreate(
        { ...configuration, createRecoveryEnabled: false },
        { periodId: 'bad' },
        { database: db },
      ),
    ).toEqual({ state: 'disabled' });
    expect(db).not.toHaveBeenCalled();
    configuration.connection.prepaidEnvironment = 'PRODUCTION';
    configuration = { ...configuration, settlementEvidenceVerified: false };
    await expect(recover()).rejects.toThrow('configuration');
    expect(fetchFixture).not.toHaveBeenCalled();
  });
  it.each([0, 2])(
    'never repeats CREATE after a complete search of %i candidates',
    async (n) => {
      search = (_, offset) => ({
        data: Array.from({ length: n }, (_, i) => ({
          id: 55 + i,
          linkedSpaceId: 405,
        })),
        offset,
        limit: 10,
        hasMore: false,
      });
      const before = ledger();
      expect(await recover()).toEqual({
        state: 'pending',
        reason: n ? 'ambiguous' : 'absent',
      });
      expect(ledger()).toEqual(before);
      expect(count('prepaid_transactions')).toBe(0);
      expect(fetchFixture.mock.calls).toHaveLength(1);
    },
  );
  it('exhausts a later page before rejecting duplicates instead of choosing the first valid candidate', async () => {
    search = (_, offset) => ({
      data: [{ id: offset ? 56 : 55, linkedSpaceId: 405 }],
      offset,
      limit: 1,
      hasMore: offset === 0,
    });
    expect(await recover()).toEqual({ state: 'pending', reason: 'ambiguous' });
    expect(searches).toBe(2);
    expect(reads).toBe(0);
  });
  it.each(['missing-envelope', 'bound', 'duplicate', 'foreign-space'])(
    'incomplete or contradictory search %s stays unbound',
    async (kind) => {
      search = (_, offset) =>
        kind === 'missing-envelope'
          ? { data: [] }
          : kind === 'duplicate'
            ? {
                data: [
                  { id: 55, linkedSpaceId: 405 },
                  { id: 55, linkedSpaceId: 405 },
                ],
                offset,
                limit: 10,
                hasMore: false,
              }
            : kind === 'foreign-space'
              ? {
                  data: [{ id: 55, linkedSpaceId: 999 }],
                  offset,
                  limit: 10,
                  hasMore: false,
                }
              : {
                  data: [{ id: 55 + offset, linkedSpaceId: 405 }],
                  offset,
                  limit: 1,
                  hasMore: true,
                };
      expect(await recover()).toEqual({
        state: 'pending',
        reason: 'unavailable',
      });
      expect(count('prepaid_create_recoveries')).toBe(0);
      expect(ledger()[0].state).toBe('uncertain');
      expect(fetchFixture.mock.calls.every((c) => c[1].method === 'GET')).toBe(
        true,
      );
    },
  );
  it('requires two stable reads and an unchanged second complete candidate set', async () => {
    mutateRead = (tx, n) => {
      if (n === 2) tx.version = 8;
    };
    expect(await recover()).toEqual({ state: 'pending', reason: 'unstable' });
    mutateRead = () => {};
    searches = 0;
    search = (n, offset) => ({
      data: n === 1 ? [{ id: 55, linkedSpaceId: 405 }] : [],
      offset,
      limit: 10,
      hasMore: false,
    });
    expect(await recover()).toEqual({ state: 'pending', reason: 'unstable' });
    expect(count('prepaid_transactions')).toBe(0);
  });
  it.each([
    'customer',
    'reference-case',
    'line-price',
    'environment',
    'connector',
    'configuration',
    'email',
  ])('refuses provider or frozen configuration drift: %s', async (kind) => {
    if (kind === 'configuration')
      configuration.connection.prepaidProducts!['gestion:start']
        .priceChfMinor++;
    else
      mutateRead = (tx) => {
        if (kind === 'customer') tx.customerId = 'another-owner';
        if (kind === 'email') tx.customerEmailAddress = 'other@example.test';
        if (kind === 'reference-case')
          tx.merchantReference = String(tx.merchantReference).toUpperCase();
        if (kind === 'environment') tx.environment = 'LIVE';
        if (kind === 'connector')
          tx.paymentConnectorConfiguration = {
            id: 999,
            paymentMethodConfiguration: { id: 91 },
          };
        if (kind === 'line-price')
          (tx.lineItems as Record<string, unknown>[])[0].amountIncludingTax = 1;
      };
    await expect(recover()).rejects.toThrow();
    expect(ledger()[0].state).toBe('uncertain');
    expect(count('prepaid_transactions')).toBe(0);
  });
  it('uses hex scope hash distinct from the Base64url request digest and rejects a wrong claimed body', async () => {
    const row = ledger()[0];
    expect(row.scope_hash).toBe(
      hash(
        `https://checkout.postfinance.ch|405|POST|/payment/transactions|${prepared.period.periodId}_create`,
      ),
    );
    expect(String(row.scope_hash)).toHaveLength(64);
    expect(String(row.fingerprint)).toHaveLength(43);
    sql
      .prepare('UPDATE postfinance_mutations SET fingerprint=?')
      .run('A'.repeat(43));
    await expect(recover()).rejects.toThrow('binding');
    expect(fetchFixture).not.toHaveBeenCalled();
  });
  it('binds an accepted terminal transaction after cancellation/expiry only for reconciliation', async () => {
    clock = prepared.period.endsAt + 1;
    vi.setSystemTime(clock * 1000);
    sql.prepare('UPDATE prepaid_contracts SET cancelled_at=?').run(clock);
    transaction.state = 'FULFILL';
    transaction.version = 9;
    transaction.authorizationEnvironment = 'TEST';
    const before = rights();
    expect(await recover()).toMatchObject({
      state: 'bound',
      reconciliationOnly: true,
    });
    expect(rights()).toEqual(before);
    const ledgerClient = new D1PostFinanceMutationLedger(d1(), () => clock, {
      ...prepared.contract,
      periodId: prepared.period.periodId,
      operation: 'confirm',
      transactionId: 55,
    });
    await expect(
      ledgerClient.claim(
        `https://checkout.postfinance.ch|405|POST|/payment/transactions/55/confirm|${prepared.period.periodId}_confirm`,
        'A'.repeat(43),
      ),
    ).rejects.toThrow('unavailable');
  });
  it('SQL final guard rolls back earlier writes when the ledger CAS misses due to a concurrent accepted response', async () => {
    beforeBatch = () =>
      sql
        .prepare(
          "UPDATE postfinance_mutations SET state='completed',claim_token=NULL,response_json=?",
        )
        .run(JSON.stringify({ ...transaction, id: 56 }));
    await expect(recover()).rejects.toThrow('recovery');
    expect(count('prepaid_transactions')).toBe(0);
    expect(count('prepaid_create_recoveries')).toBe(0);
    expect(
      sql.prepare('SELECT provider_reference FROM purchase_intents').get()!
        .provider_reference,
    ).toBeNull();
    expect(JSON.parse(String(ledger()[0].response_json)).id).toBe(56);
  });
  it('a storage interruption before the final proof rolls back all binding and journal changes', async () => {
    const before = ledger();
    interruptStatement = 'INSERT INTO prepaid_create_recoveries';
    await expect(recover()).rejects.toThrow('storage failure');
    expect(ledger()).toEqual(before);
    expect(count('prepaid_transactions')).toBe(0);
    expect(
      sql.prepare('SELECT provider_reference FROM purchase_intents').get()!
        .provider_reference,
    ).toBeNull();
  });
  it('current owner revocation during GET cannot create even a partial binding', async () => {
    beforeBatch = () =>
      sql.prepare('UPDATE organization_members SET revoked_at=?').run(clock);
    await expect(recover()).rejects.toThrow('recovery_binding');
    expect(count('prepaid_transactions')).toBe(0);
    expect(ledger()[0].state).toBe('uncertain');
  });
  it('concurrent recovery of the same immutable observation creates one receipt and never repeats a financial operation', async () => {
    const results = await Promise.all([recover(), recover()]);
    expect(results.every((r) => r.state === 'bound')).toBe(true);
    expect(count('prepaid_create_recoveries')).toBe(1);
    expect(count('prepaid_transactions')).toBe(1);
    expect(fetchFixture.mock.calls.every((c) => c[1].method === 'GET')).toBe(
      true,
    );
  });
  it('does not close an uncertain confirm or ChargeFlow journal alongside CREATE', async () => {
    const other = new D1PostFinanceMutationLedger(d1(), () => clock);
    for (const path of ['confirm', 'charge-flow/apply']) {
      const scope = `https://checkout.postfinance.ch|405|POST|/payment/transactions/55/${path}|separate-operation`;
      expect(await other.claim(scope, 'A'.repeat(43))).toEqual({
        kind: 'claimed',
      });
      await other.markUncertain(scope);
    }
    await recover();
    expect(ledger().filter((row) => row.state === 'uncertain')).toHaveLength(2);
    expect(count('prepaid_create_recoveries')).toBe(1);
  });
  it('a reference bound by another concurrent response cannot be overwritten and all new writes roll back', async () => {
    beforeBatch = () =>
      sql.prepare("UPDATE purchase_intents SET provider_reference='56'").run();
    await expect(recover()).rejects.toThrow('recovery_binding');
    expect(count('prepaid_transactions')).toBe(0);
    expect(count('prepaid_create_recoveries')).toBe(0);
    expect(ledger()[0].state).toBe('uncertain');
    expect(
      sql.prepare('SELECT provider_reference FROM purchase_intents').get()!
        .provider_reference,
    ).toBe('56');
  });
  it('recovers the lost CREATE of a genuine renewed period while preserving the initial reference, token and paid rights', async () => {
    sql.close();
    realNetwork.mockRestore();
    await setup('PRODUCTION');
    await recover();
    const connector = {
      id: 92,
      linkedSpaceId: 405,
      state: 'ACTIVE',
      paymentMethodConfiguration: {
        id: 91,
        linkedSpaceId: 405,
        state: 'ACTIVE',
        paymentMethod: { id: 99 },
      },
    };
    transaction = {
      ...transaction,
      state: 'FULFILL',
      authorizationEnvironment: 'PRODUCTION',
      totalSettledAmount: prepared.period.priceChfMinor / 100,
      refundedAmount: 0,
      token: { id: 101, linkedSpaceId: 405 },
      paymentConnectorConfiguration: connector,
    };
    const initial = structuredClone(transaction);
    const inbox = new D1PostFinanceWebhookInbox(
      d1(),
      {
        apiOrigin: prepared.contract.apiOrigin,
        spaceId: 405,
        listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
      },
      () => clock,
    );
    await inbox.acceptOnce(`${prepared.contract.apiOrigin}|405|10|1`, {
      eventId: 1,
      entityId: 55,
      spaceId: 405,
      webhookListenerId: 10,
      listenerEntityId: 20,
      listenerEntityTechnicalName: 'Transaction',
      timestamp: new Date(clock * 1000).toISOString(),
    });
    const work = (await inbox.claimNext())!;
    await new D1PrepaidProvisioning(d1(), () => clock).provision(
      {
        periodId: prepared.period.periodId,
        transactionId: 55,
        invoiceId: 81,
        apiOrigin: prepared.contract.apiOrigin,
        spaceId: 405,
        environment: 'PRODUCTION',
        ownerId: user.userId,
        organizationId: 'company-a',
        workspaceId: null,
        startsAt: prepared.period.startsAt,
        endsAt: prepared.period.endsAt,
        currency: 'CHF',
        priceChfMinor: prepared.period.priceChfMinor,
        catalogVersion: prepared.period.catalogVersion,
        evidenceFingerprint: 'a'.repeat(64),
      },
      work,
    );
    const createTransport = fetchFixture;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/transactions/55')) return Response.json(initial);
      if (path.endsWith('/tokens/101'))
        return Response.json({
          id: 101,
          linkedSpaceId: 405,
          version: 0,
          state: 'ACTIVE',
          customerId: prepared.expectation.customerReference,
        });
      if (path.endsWith('/tokens/101/active-version'))
        return Response.json({
          id: 102,
          linkedSpaceId: 405,
          version: 0,
          state: 'ACTIVE',
          environment: 'PRODUCTION',
          token: { id: 101 },
          paymentConnectorConfiguration: connector,
          paymentMethod: { id: 99 },
        });
      return createTransport(url, init);
    });
    const tokens = new D1PrepaidTokens(d1(), () => clock),
      expected = await tokens.initialContext(
        prepared.contract.contractId,
        'postfinance_pay',
      );
    expect(expected).not.toBeNull();
    await tokens.bindInitial(
      new PostFinanceCheckoutClient(configuration.connection, {
        fetch: transport as typeof fetch,
        now: () => clock * 1000,
      }),
      expected!,
      work,
    );
    clock = prepared.period.endsAt;
    vi.setSystemTime(clock * 1000);
    expect(
      (
        await runPrepaidRenewal(
          configuration,
          { contractId: prepared.contract.contractId, ordinal: 1 },
          { database: d1, now: () => clock, fetch: transport as typeof fetch },
        )
      ).state,
    ).toBe('uncertain');
    const renewed = sql
      .prepare('SELECT period_id FROM prepaid_periods WHERE ordinal=1')
      .get()!.period_id as string;
    expect(count('prepaid_transactions')).toBe(1);
    expect(
      sql.prepare('SELECT * FROM prepaid_renewal_requests').get()!
        .apply_scope_hash,
    ).toBeNull();
    prepared = {
      ...prepared,
      period: { ...prepared.period, periodId: renewed },
    };
    reads = 0;
    searches = 0;
    fetchFixture.mockClear();
    // A second provider transaction represents the new period, not the initial ID.
    transaction.id = 56;
    search = (_, offset) => ({
      data: [{ id: 56, linkedSpaceId: 405 }],
      offset,
      limit: 10,
      hasMore: false,
    });
    const recoveryTransport = vi.fn(async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith('/transactions/56')) {
        expect(init.method).toBe('GET');
        return Response.json(transaction);
      }
      return fetchFixture(url, init);
    });
    const before = rights(),
      tokenRows = sql.prepare('SELECT * FROM prepaid_tokens').all();
    expect(
      await recoverPrepaidCreate(
        configuration,
        { periodId: renewed },
        {
          database: d1,
          now: () => clock,
          fetch: recoveryTransport as typeof fetch,
        },
      ),
    ).toEqual({
      state: 'bound',
      periodId: renewed,
      transactionId: 56,
      reconciliationOnly: false,
    });
    expect(rights()).toEqual(before);
    expect(sql.prepare('SELECT * FROM prepaid_tokens').all()).toEqual(
      tokenRows,
    );
    expect(
      sql.prepare('SELECT provider_reference FROM purchase_intents').get()!
        .provider_reference,
    ).toBe('55');
    expect(
      sql
        .prepare('SELECT apply_scope_hash FROM prepaid_renewal_requests')
        .get()!.apply_scope_hash,
    ).toBeNull();
    expect(
      recoveryTransport.mock.calls.every((c) => c[1].method === 'GET'),
    ).toBe(true);
    expect(count('prepaid_create_recoveries')).toBe(2);
  });
});
