import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LEGAL_VERSION } from '@/lib/legal';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { prepaidCatalog } from './prepaid-catalog';
import {
  prepareInitialPrepaidPurchase,
  type PrepaidPurchaseConfiguration,
} from './prepaid-purchase-preparation';
import {
  runInitialPrepaidCheckout,
  type PreparedInitialPrepaidPurchase,
} from './prepaid-initial-checkout';

// D1 stores, purchase authorization, periods, financial fences and migrations
// are real. Only the runtime binding and provider HTTP transport are replaced.
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Inject migrated fixture D1.');
  },
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));

let sql: DatabaseSync, clock: number;
let prepared: PreparedInitialPrepaidPurchase;
let configuration: PrepaidPurchaseConfiguration;
let transport: ReturnType<typeof vi.fn>;
let actualNetwork: ReturnType<typeof vi.spyOn>;
let transaction: Record<string, unknown> | null;
let mutateRead: (value: Record<string, unknown>) => void;
let stopBeforeSql: ((query: string, values: SQLInputValue[]) => void) | null;
let stopAfterTransport: 'create' | 'confirm' | 'page' | 'read' | null;
let beforeProvider: ((path: string, method: string) => void) | null;
const user = {
  userId: 'fixture-owner',
  email: 'owner@example.test',
  emailConfirmed: true,
};
const anchor = Date.parse('2026-10-06T10:11:12Z') / 1000;
const count = (table: string) =>
  Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const row = (table: string) => sql.prepare(`SELECT * FROM ${table}`).get();
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;
const mutableClone = <T>(value: T) => structuredClone(value) as Mutable<T>;
function d1() {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        execute() {
          stopBeforeSql?.(query, values);
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async run() {
          return statement.execute();
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
    async batch(statements: { execute(): unknown }[]) {
      sql.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.execute());
        sql.exec('COMMIT');
        return result;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
function config(): PrepaidPurchaseConfiguration {
  return {
    enabled: true,
    settlementEvidenceVerified: true,
    connectorConfigurations: { postfinance_pay: 92, twint: 94 },
    connection: {
      enabled: true,
      merchantApproved: true,
      prepaidFeatureEnabled: true,
      chargeFlowEnabled: true,
      postfinancePayTokenEnabled: true,
      twintUserOnFileEnabled: true,
      prepaidEnvironment: 'PRODUCTION',
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      applicationUserId: '512',
      authenticationKeyBase64: Buffer.alloc(32, 0x5a).toString('base64'),
      returnOrigin: 'https://zentra.example.test',
      prepaidProducts: Object.fromEntries(
        prepaidCatalog().map((product) => [
          product.productKey,
          {
            currency: 'CHF',
            billingPeriod: 'P1M',
            priceChfMinor: product.priceChfMinor,
            reference: product.catalogVersion,
            name: product.name,
            methodConfigurations: { postfinance_pay: 91, twint: 93 },
          },
        ]),
      ),
    },
  };
}
async function prepare(
  productKey = 'gestion:start',
  environment: 'TEST' | 'PRODUCTION' = 'PRODUCTION',
) {
  configuration = config();
  configuration.connection.prepaidEnvironment = environment;
  const result = await prepareInitialPrepaidPurchase(
    configuration,
    {
      user,
      requestId: '11111111-1111-4111-8111-111111111111',
      productKey,
      organizationId: productKey.startsWith('support:')
        ? undefined
        : 'company-a',
      workspaceId:
        productKey.startsWith('complet:') || productKey.startsWith('support:')
          ? 'workspace-a'
          : undefined,
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion: productKey.startsWith('complet:')
        ? COMPLETE_TERMS_VERSION
        : productKey.startsWith('support:')
          ? SUPPORT_LEGAL_VERSION
          : LEGAL_VERSION,
    },
    { database: d1, now: () => clock },
  );
  if (result.state !== 'prepared')
    throw Error('Fixture preparation must be enabled.');
  prepared = result;
}
const dependencies = () => ({
  database: d1,
  now: () => clock,
  fetch: transport as typeof fetch,
});
const run = () =>
  runInitialPrepaidCheckout(configuration, prepared, dependencies());
function httpCalls(method?: string) {
  return transport.mock.calls
    .map((args) => {
      const [url, options] = args as [string, RequestInit];
      return {
        path: new URL(url).pathname,
        method: options.method,
        body:
          options.body === undefined
            ? null
            : JSON.parse(options.body as string),
      };
    })
    .filter((call) => !method || call.method === method);
}
function projections() {
  return [
    'subscriptions',
    'organizations',
    'organization_members',
    'support_workspaces',
    'support_gestion_links',
    'support_subscriptions',
    'automation_subscriptions',
    'complete_subscriptions',
    'license_activations',
    'device_sessions',
  ].map((table) => [
    table,
    sql.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
  ]);
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = anchor;
  vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
    VALUES('local-trial','local','fixture','canceled',0,?)`)
    .run(clock);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run('company-a', 'Company', 'local-trial', user.userId, clock, clock);
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('owner-a','company-a',?,?,'owner',?)`)
    .run(user.userId, user.email, clock);
  sql
    .prepare(
      'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
    .run('workspace-a', user.userId, 'Workspace', clock, clock);
  transaction = null;
  mutateRead = () => {};
  stopBeforeSql = null;
  stopAfterTransport = null;
  beforeProvider = null;
  actualNetwork = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('Real HTTP forbidden.');
  });
  transport = vi.fn(async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname,
      method = options.method ?? 'GET';
    expect(new URL(url).origin).toBe('https://checkout.postfinance.ch');
    expect((options.headers as Record<string, string>).Space).toBe('405');
    expect(options.redirect).toBe('error');
    beforeProvider?.(path, method);
    if (method === 'POST' && path === '/api/v2.0/payment/transactions') {
      const payload = JSON.parse(options.body as string);
      expect(payload.token).toBeUndefined();
      transaction = {
        ...payload,
        id: 55,
        linkedSpaceId: 405,
        state: 'PENDING',
        version: 7,
        environment:
          configuration.connection.prepaidEnvironment === 'PRODUCTION'
            ? 'LIVE'
            : 'PREVIEW',
        authorizationAmount: payload.lineItems[0].amountIncludingTax,
      };
      if (stopAfterTransport === 'create')
        throw Error('Fixture lost create response after provider accepted.');
      return json(transaction);
    }
    if (method === 'GET' && path === '/api/v2.0/payment/transactions/55') {
      if (stopAfterTransport === 'read')
        throw Error('Fixture GET temporarily unavailable.');
      const fresh = structuredClone(transaction!);
      mutateRead(fresh);
      return json(fresh);
    }
    if (
      method === 'POST' &&
      path === '/api/v2.0/payment/transactions/55/confirm'
    ) {
      expect(JSON.parse(options.body as string)).toEqual({ version: 7 });
      transaction!.state = 'CONFIRMED';
      transaction!.version = 8;
      if (stopAfterTransport === 'confirm')
        throw Error('Fixture lost confirm response after provider accepted.');
      return json(transaction);
    }
    if (
      method === 'GET' &&
      path === '/api/v2.0/payment/transactions/55/payment-page-url'
    ) {
      if (stopAfterTransport === 'page')
        throw Error('Fixture lost safe page GET.');
      return json('https://checkout.postfinance.ch/payment/fixture-55');
    }
    throw Error('Unexpected fixture provider request: ' + method + ' ' + path);
  });
  await prepare();
});
afterEach(() => {
  expect(actualNetwork).not.toHaveBeenCalled();
  actualNetwork.mockRestore();
  for (const table of [
    'prepaid_settlement_proofs',
    'prepaid_period_revocations',
    'prepaid_provider_reversals',
    'license_activations',
    'device_sessions',
  ])
    expect(count(table)).toBe(0);
  expect(
    httpCalls().some((call) =>
      /charge-flow|subscriptions|tokens/.test(call.path),
    ),
  ).toBe(false);
  sql.close();
  vi.useRealTimers();
});

describe('authentically scoped initial prepaid purchase with real durable D1 stores', () => {
  it('creates, binds, fresh-reads, freezes version, confirms and opens a payment page without projecting rights', async () => {
    const before = projections();
    const result = await run();
    expect(result).toEqual({
      state: 'payment-page',
      intentId: prepared.intent.intentId,
      periodId: prepared.period.periodId,
      transactionId: 55,
      url: 'https://checkout.postfinance.ch/payment/fixture-55',
    });
    expect(httpCalls().map((call) => [call.method, call.path])).toEqual([
      ['POST', '/api/v2.0/payment/transactions'],
      ['GET', '/api/v2.0/payment/transactions/55'],
      ['POST', '/api/v2.0/payment/transactions/55/confirm'],
      ['GET', '/api/v2.0/payment/transactions/55'],
      ['GET', '/api/v2.0/payment/transactions/55/payment-page-url'],
    ]);
    expect(row('prepaid_transactions')?.transaction_id).toBe(55);
    expect(row('purchase_intents')?.provider_reference).toBe('55');
    expect(row('purchase_intents')?.state).toBe('dispatched');
    expect(count('postfinance_mutations')).toBe(4);
    expect(projections()).toEqual(before);
    const create = httpCalls('POST')[0].body;
    expect(create.lineItems[0].amountIncludingTax).toBe(
      prepared.period.priceChfMinor / 100,
    );
    expect(create.merchantReference).toBe(prepared.period.periodId);
    expect(create.metaData).toEqual({
      zentra_period_id: prepared.period.periodId,
      zentra_plan_version: prepared.period.catalogVersion,
    });
  });
  it.each(['complet:team', 'support:team'])(
    'uses the server catalogue and proper targets for %s',
    async (product) => {
      sql.close();
      sql = new DatabaseSync(':memory:');
      sql.exec('PRAGMA foreign_keys=ON');
      sql.function('unixepoch', () => clock);
      for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
        .filter((file) => file.endsWith('.sql'))
        .sort())
        sql.exec(
          readFileSync(
            new URL(`../../drizzle/${file}`, import.meta.url),
            'utf8',
          ),
        );
      sql
        .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
      VALUES('local-trial','local','fixture','canceled',0,?)`)
        .run(clock);
      sql
        .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
        .run('company-a', 'Company', 'local-trial', user.userId, clock, clock);
      sql
        .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
      VALUES('owner-a','company-a',?,?,'owner',?)`)
        .run(user.userId, user.email, clock);
      sql
        .prepare(
          'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
        )
        .run('workspace-a', user.userId, 'Workspace', clock, clock);
      await prepare(product);
      expect((await run()).state).toBe('payment-page');
      expect(httpCalls('POST')[0].body.lineItems[0].amountIncludingTax).toBe(
        prepared.period.priceChfMinor / 100,
      );
      expect(prepared.contract.workspaceId).toBe('workspace-a');
      expect(prepared.contract.organizationId).toBe(
        product.startsWith('support:') ? null : 'company-a',
      );
    },
  );
  it('disabled configuration touches no D1 or HTTP', async () => {
    const result = await runInitialPrepaidCheckout(
      { ...configuration, enabled: false },
      prepared,
      {
        database: () => {
          throw Error('Database must not be read.');
        },
        fetch: transport as typeof fetch,
      },
    );
    expect(result).toEqual({ state: 'disabled' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    'owner',
    'organization',
    'workspace',
    'contract',
    'price',
    'return',
    'token',
    'method',
    'environment',
    'config',
  ])('refuses changed %s binding before any provider call', async (mode) => {
    const changed = mutableClone(prepared),
      cfg = mutableClone(configuration);
    if (mode === 'owner') changed.intent.ownerId = 'another';
    if (mode === 'organization') changed.contract.organizationId = 'another';
    if (mode === 'workspace') changed.contract.workspaceId = 'workspace-a';
    if (mode === 'contract')
      changed.contract.contractId = 'pfp_22222222-2222-4222-8222-222222222222';
    if (mode === 'price') changed.intent.parameters.priceChfMinor = 1;
    if (mode === 'return')
      changed.createInput.urls.successUrl =
        'https://zentra.example.test/foreign';
    if (mode === 'token') Object.assign(changed.createInput, { tokenId: 77 });
    if (mode === 'method')
      cfg.connection.prepaidProducts![
        'gestion:start'
      ].methodConfigurations.postfinance_pay = 1;
    if (mode === 'environment') cfg.connection.prepaidEnvironment = 'TEST';
    if (mode === 'config') cfg.settlementEvidenceVerified = false;
    await expect(
      runInitialPrepaidCheckout(cfg, changed, dependencies()),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(count('postfinance_mutations')).toBe(0);
  });
  it('revalidates an owner removed after preparation before sending anything', async () => {
    sql
      .prepare(
        "UPDATE organization_members SET revoked_at=? WHERE membership_id='owner-a'",
      )
      .run(clock);
    await expect(run()).rejects.toMatchObject({ code: 'binding' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('cancellation before dispatch produces no HTTP or financial reservation', async () => {
    sql.prepare('UPDATE prepaid_contracts SET cancelled_at=?').run(clock);
    await expect(run()).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(count('postfinance_mutations')).toBe(0);
  });
  it.each([
    'currency',
    'reference',
    'metadata',
    'payer',
    'email',
    'amount',
    'extra-line',
    'allowed-method',
    'selected-method',
    'connector',
    'environment',
    'auth-environment',
    'strategy',
    'presence',
    'auto-confirm',
    'version',
    'return',
    'state',
  ])(
    'refuses a fresh provider %s mismatch before confirmation',
    async (mode) => {
      mutateRead = (tx) => {
        if (mode === 'currency') tx.currency = 'EUR';
        if (mode === 'reference') tx.invoiceMerchantReference = 'foreign';
        if (mode === 'metadata')
          tx.metaData = {
            zentra_period_id: prepared.period.periodId,
            zentra_plan_version: 'foreign',
          };
        if (mode === 'payer') tx.customerId = 'foreign';
        if (mode === 'email') tx.customerEmailAddress = 'foreign@example.test';
        if (mode === 'amount') tx.authorizationAmount = 48;
        if (mode === 'extra-line') (tx.lineItems as unknown[]).push({});
        if (mode === 'allowed-method')
          tx.allowedPaymentMethodConfigurations = [91, 93];
        if (mode === 'selected-method')
          tx.paymentConnectorConfiguration = {
            id: 92,
            paymentMethodConfiguration: { id: 93 },
          };
        if (mode === 'connector')
          tx.paymentConnectorConfiguration = {
            id: 99,
            paymentMethodConfiguration: { id: 91 },
          };
        if (mode === 'environment') tx.environment = 'PREVIEW';
        if (mode === 'auth-environment') tx.authorizationEnvironment = 'TEST';
        if (mode === 'strategy')
          tx.environmentSelectionStrategy = 'USE_CONFIGURATION';
        if (mode === 'presence') tx.customersPresence = 'NOT_PRESENT';
        if (mode === 'auto-confirm') tx.autoConfirmationEnabled = true;
        if (mode === 'version') tx.version = -1;
        if (mode === 'return')
          tx.successUrl = 'https://zentra.example.test/foreign';
        if (mode === 'state') tx.state = 'CONFIRMED';
      };
      await expect(run()).rejects.toMatchObject({ code: 'provider-binding' });
      expect(httpCalls('POST')).toHaveLength(1);
      expect(count('prepaid_transactions')).toBe(1);
      expect(count('postfinance_mutations')).toBe(1);
      expect(row('purchase_intents')?.state).toBe('uncertain');
    },
  );
  it('accepts absent PENDING connector/auth environment and validates correctly present values', async () => {
    mutateRead = (tx) => {
      tx.paymentConnectorConfiguration = {
        id: 92,
        paymentMethodConfiguration: { id: 91 },
      };
      tx.authorizationEnvironment = 'PRODUCTION';
    };
    expect((await run()).state).toBe('payment-page');
  });
  it.each([
    'payer',
    'currency',
    'amount',
    'reference',
    'metadata',
    'method',
    'connector',
    'state',
  ])(
    'does not open a page when the freshly confirmed %s no longer matches its immutable order',
    async (mode) => {
      mutateRead = (tx) => {
        if (tx.state !== 'CONFIRMED') return;
        if (mode === 'payer') tx.customerId = 'another-payer';
        if (mode === 'currency') tx.currency = 'EUR';
        if (mode === 'amount')
          (tx.lineItems as Record<string, unknown>[])[0].amountIncludingTax = 1;
        if (mode === 'reference') tx.merchantReference = 'another-period';
        if (mode === 'metadata')
          tx.metaData = {
            zentra_period_id: 'another-period',
            zentra_plan_version: prepared.period.catalogVersion,
          };
        if (mode === 'method') tx.allowedPaymentMethodConfigurations = [93];
        if (mode === 'connector')
          tx.paymentConnectorConfiguration = {
            id: 99,
            paymentMethodConfiguration: { id: 91 },
          };
        if (mode === 'state') tx.state = 'PENDING';
      };
      await expect(run()).rejects.toMatchObject({ code: 'provider-binding' });
      expect(httpCalls('POST')).toHaveLength(2);
      expect(
        httpCalls().filter((call) => call.path.endsWith('payment-page-url')),
      ).toHaveLength(0);
      expect(row('purchase_intents')?.state).toBe('uncertain');
    },
  );
  it.each(['id', 'linkedSpaceId'])(
    'does not open a page after the confirmed fresh read changes its %s scope',
    async (field) => {
      mutateRead = (tx) => {
        if (tx.state === 'CONFIRMED') tx[field] = 999;
      };
      expect((await run()).state).toBe('uncertain');
      expect(httpCalls('POST')).toHaveLength(2);
      expect(
        httpCalls().filter((call) => call.path.endsWith('payment-page-url')),
      ).toHaveLength(0);
      expect(row('purchase_intents')?.state).toBe('uncertain');
    },
  );
  it('can resume a failed confirmed GET without confirming again or granting access', async () => {
    let unavailable = true;
    beforeProvider = (path, method) => {
      if (
        method === 'GET' &&
        path === '/api/v2.0/payment/transactions/55' &&
        transaction?.state === 'CONFIRMED' &&
        unavailable
      )
        throw Error('Fixture confirmed GET unavailable.');
    };
    expect((await run()).state).toBe('uncertain');
    expect(httpCalls('POST')).toHaveLength(2);
    expect(
      httpCalls().filter((call) => call.path.endsWith('payment-page-url')),
    ).toHaveLength(0);
    unavailable = false;
    expect((await run()).state).toBe('payment-page');
    expect(httpCalls('POST')).toHaveLength(2);
  });
  it('clones configuration before asynchronous dispatch so caller mutation cannot change price/method', async () => {
    const pending = run();
    configuration.connection.prepaidProducts!['gestion:start'].priceChfMinor =
      1;
    configuration.connection.prepaidProducts![
      'gestion:start'
    ].methodConfigurations.postfinance_pay = 99;
    expect((await pending).state).toBe('payment-page');
    expect(
      httpCalls('POST')[0].body.allowedPaymentMethodConfigurations,
    ).toEqual([91]);
    expect(httpCalls('POST')[0].body.lineItems[0].amountIncludingTax).toBe(
      prepared.period.priceChfMinor / 100,
    );
  });
  it('lost create response remains uncertain forever without recreating an order', async () => {
    stopAfterTransport = 'create';
    expect((await run()).state).toBe('uncertain');
    stopAfterTransport = null;
    expect((await run()).state).toBe('uncertain');
    expect(httpCalls('POST')).toHaveLength(1);
    expect(count('prepaid_transactions')).toBe(0);
    expect(row('postfinance_mutations')?.state).toBe('uncertain');
  });
  it('recovers a completed create whose ID binding was interrupted without another POST', async () => {
    stopBeforeSql = (query) => {
      if (query.startsWith('INSERT INTO prepaid_transactions')) {
        stopBeforeSql = null;
        throw Error('Fixture durable binding interrupted.');
      }
    };
    expect((await run()).state).toBe('uncertain');
    expect(count('prepaid_transactions')).toBe(0);
    expect((await run()).state).toBe('payment-page');
    expect(httpCalls('POST')).toHaveLength(2);
    expect(
      httpCalls('POST').filter((call) => call.path.endsWith('/transactions')),
    ).toHaveLength(1);
  });
  it('a lost confirm response never repeats confirm even after provider becomes CONFIRMED', async () => {
    stopAfterTransport = 'confirm';
    expect((await run()).state).toBe('uncertain');
    stopAfterTransport = null;
    transaction!.version = 11;
    expect((await run()).state).toBe('uncertain');
    expect(httpCalls('POST')).toHaveLength(2);
    const versionScope = `https://checkout.postfinance.ch|405|LOCAL|initial-confirm-version|${prepared.period.periodId}_55`;
    expect(
      JSON.parse(
        String(
          sql
            .prepare(
              'SELECT response_json FROM postfinance_mutations WHERE scope_hash=?',
            )
            .get(digest(versionScope))?.response_json,
        ),
      ),
    ).toEqual({ version: 7 });
    expect(
      httpCalls().filter((call) => call.path.endsWith('payment-page-url')),
    ).toHaveLength(0);
  });
  it('safe page GET retry uses a completed confirm and its frozen version rather than a newer version', async () => {
    stopAfterTransport = 'page';
    expect((await run()).state).toBe('uncertain');
    stopAfterTransport = null;
    transaction!.version = 11;
    expect((await run()).state).toBe('payment-page');
    expect(httpCalls('POST')).toHaveLength(2);
    expect(
      httpCalls().filter((call) => call.path.endsWith('payment-page-url')),
    ).toHaveLength(2);
    expect(httpCalls('POST')[1].body).toEqual({ version: 7 });
  });
  it('GET before version snapshot can safely retry, without repeating completed create', async () => {
    stopAfterTransport = 'read';
    expect((await run()).state).toBe('uncertain');
    stopAfterTransport = null;
    expect((await run()).state).toBe('payment-page');
    expect(httpCalls('POST')).toHaveLength(2);
  });
  it('a lost local confirmation-version snapshot remains blocked instead of replacing the version', async () => {
    stopBeforeSql = (query, values) => {
      if (
        query.includes("SET state='completed'") &&
        values[0] === '{"version":7}'
      ) {
        stopBeforeSql = null;
        throw Error('Fixture lost local snapshot persistence.');
      }
    };
    expect((await run()).state).toBe('uncertain');
    transaction!.version = 11;
    expect((await run()).state).toBe('uncertain');
    expect(httpCalls('POST')).toHaveLength(1);
    expect(count('postfinance_mutations')).toBe(2);
  });
  it('completed checkout replays the same URL after cancellation/expiry without HTTP', async () => {
    const result = await run(),
      calls = transport.mock.calls.length;
    sql.prepare('UPDATE prepaid_contracts SET cancelled_at=?').run(clock);
    clock = prepared.period.endsAt + 1;
    vi.setSystemTime(clock * 1000);
    expect(await run()).toEqual(result);
    expect(transport).toHaveBeenCalledTimes(calls);
  });
  it('concurrent callers share one create/confirm order and losers can resume the completed URL', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => run()));
    expect(results.some((result) => result.state === 'payment-page')).toBe(
      true,
    );
    expect(
      results.every((result) =>
        ['payment-page', 'uncertain'].includes(result.state),
      ),
    ).toBe(true);
    expect(httpCalls('POST')).toHaveLength(2);
    const calls = transport.mock.calls.length;
    expect((await run()).state).toBe('payment-page');
    expect(transport).toHaveBeenCalledTimes(calls);
  });
  it('cancellation between pending read and confirm is fenced, preserving the created transaction', async () => {
    mutateRead = () => {
      sql.prepare('UPDATE prepaid_contracts SET cancelled_at=?').run(clock);
    };
    expect((await run()).state).toBe('uncertain');
    expect(httpCalls('POST')).toHaveLength(1);
    expect(count('prepaid_transactions')).toBe(1);
  });
});
