import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  reconcilePostFinanceJobs,
  type PostFinanceReconciliationConfiguration,
} from './postfinance-reconciliation';
import { D1PostFinanceWebhookInbox } from './postfinance-store';
import {
  D1PrepaidPeriods,
  type PrepaidPeriod,
  type PrepaidContractInput,
} from './prepaid-periods';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import { prepaidCompanyAccess } from './prepaid-access';

const runtime = vi.hoisted(() => ({ database: null as unknown }));
vi.mock('@/lib/runtime', () => ({ database: () => runtime.database }));

type Json = Record<string, unknown>;
type RequestRecord = { url: URL; init: RequestInit };
let sql: DatabaseSync;
let time: number;
let period: PrepaidPeriod;
let requests: RequestRecord[];
let prepared: string[];
let transactions: Map<number, Json>;
let invoices: Map<number, Json>;
let refunds: Map<number, Json>;
let override:
  | ((
      url: URL,
      init: RequestInit,
    ) => Response | undefined | Promise<Response | undefined>)
  | undefined;
let unexpectedNetwork: ReturnType<typeof vi.spyOn>;
const origin = 'https://checkout.postfinance.ch';
const identity: PrepaidContractInput = {
  contractId: 'pfp_11111111-1111-4111-8111-111111111111',
  ownerId: 'owner-worker',
  organizationId: 'company-worker',
  workspaceId: null,
  apiOrigin: origin,
  spaceId: 405,
  environment: 'PRODUCTION',
  productKey: 'gestion:start',
};
const customerReference = 'pfpayer_synthetic';
const authenticationKey = Buffer.alloc(32, 7).toString('base64');
const listeners = [
  {
    id: 10,
    entityId: 20,
    technicalName: 'Transaction',
    kind: 'transaction' as const,
  },
  {
    id: 11,
    entityId: 21,
    technicalName: 'TransactionInvoice',
    kind: 'invoice' as const,
  },
  { id: 12, entityId: 22, technicalName: 'Refund', kind: 'refund' as const },
];

function configuration(
  extra: Partial<PostFinanceReconciliationConfiguration> = {},
): PostFinanceReconciliationConfiguration {
  return {
    enabled: true,
    apiOrigin: origin,
    spaceId: 405,
    listeners,
    settlementEvidenceVerified: true,
    connection: {
      enabled: true,
      apiOrigin: origin,
      spaceId: 405,
      applicationUserId: '512',
      authenticationKeyBase64: authenticationKey,
    },
    ...extra,
  };
}
function d1() {
  return {
    prepare(query: string) {
      prepared.push(query);
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
const records = () => new D1PrepaidReconciliationStore(d1(), () => time);
const inbox = () =>
  new D1PostFinanceWebhookInbox(
    d1(),
    { apiOrigin: origin, spaceId: 405, listeners },
    () => time,
  );
const count = (table: string) =>
  Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const workRow = () =>
  sql
    .prepare(
      'SELECT state,attempts,due_at,last_error_code FROM postfinance_webhook_inbox ORDER BY created_at,scope_hash',
    )
    .get();
function advance(seconds: number) {
  time += seconds;
  vi.setSystemTime(time * 1000);
}
function nextRetry() {
  const due = Number(
    sql
      .prepare(
        "SELECT MIN(due_at) AS due FROM postfinance_webhook_inbox WHERE state='pending'",
      )
      .get()?.due,
  );
  expect(due).toBeGreaterThan(time);
  advance(due - time);
}

async function createBoundContract(
  input = identity,
  transactionId = 71,
  invoiceId = 81,
  payer = customerReference,
) {
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at)
    VALUES(?,?,'prepaid-local','incomplete',0,1,?)`)
    .run(input.contractId, input.contractId, time);
  await periods().createContract(input);
  const current = await periods().reservePeriod(input.contractId, 0);
  // Frozen expected planReference is the real catalogue version, not a made-up Price ID.
  await records().freezeExpectation(current.periodId, {
    customerReference: payer,
    planReference: current.catalogVersion,
    paymentMethodConfigurationId: 91,
    connectorConfigurationId: 92,
  });
  await periods().bindTransaction(current.periodId, transactionId);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(
      input.organizationId!,
      'Entreprise fixture',
      input.contractId,
      input.ownerId,
      time,
      time,
    );
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES(?,?,?,?,'owner',?)`)
    .run(
      `owner-${input.organizationId}`,
      input.organizationId!,
      input.ownerId,
      'owner@example.test',
      time,
    );
  const line = {
    type: 'PRODUCT',
    quantity: 1,
    uniqueId: current.periodId,
    sku: current.catalogVersion,
    amountIncludingTax: current.priceChfMinor / 100,
  };
  transactions.set(transactionId, {
    id: transactionId,
    linkedSpaceId: 405,
    version: 7,
    state: 'FULFILL',
    environment: 'LIVE',
    authorizationEnvironment: input.environment,
    currency: 'CHF',
    customerId: payer,
    merchantReference: current.periodId,
    invoiceMerchantReference: current.periodId,
    metaData: {
      zentra_period_id: current.periodId,
      zentra_plan_version: current.catalogVersion,
    },
    authorizationAmount: current.priceChfMinor / 100,
    completedAmount: current.priceChfMinor / 100,
    totalSettledAmount: current.priceChfMinor / 100,
    refundedAmount: 0,
    lineItems: [line],
    paymentConnectorConfiguration: {
      id: 92,
      linkedSpaceId: 405,
      paymentMethodConfiguration: { id: 91 },
    },
  });
  invoices.set(invoiceId, {
    id: invoiceId,
    linkedSpaceId: 405,
    linkedTransaction: transactionId,
    state: 'PAID',
    environment: 'LIVE',
    merchantReference: current.periodId,
    amount: current.priceChfMinor / 100,
    outstandingAmount: 0,
    lineItems: [structuredClone(line)],
  });
  return current;
}
function refund(id = 51, transactionId = 71): Json {
  return {
    id,
    linkedSpaceId: 405,
    transaction: { id: transactionId, linkedSpaceId: 405 },
    state: 'SUCCESSFUL',
    type: 'CUSTOMER_INITIATED_AUTOMATIC',
    environment: 'LIVE',
    amount: 10,
    totalSettledAmount: 10,
  };
}
async function enqueue(
  kind: 'transaction' | 'invoice' | 'refund' = 'transaction',
  eventId = 1,
  entityId = 71,
  state = 'FULFILL',
  timestamp = new Date(time * 1000).toISOString(),
) {
  const listener = listeners.find((value) => value.kind === kind)!;
  const event = {
    eventId,
    entityId,
    spaceId: 405,
    webhookListenerId: listener.id,
    listenerEntityId: listener.entityId,
    listenerEntityTechnicalName: listener.technicalName,
    state,
    timestamp,
  };
  return inbox().acceptOnce(`${origin}|405|${listener.id}|${eventId}`, event);
}
const transport: typeof fetch = async (input, init = {}) => {
  const url = new URL(
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input,
  );
  requests.push({ url, init });
  if (init.method !== 'GET')
    throw Error('Financial HTTP mutation is forbidden by the fixture.');
  const changed = await override?.(url, init);
  if (changed) return changed;
  const transactionPath = /^\/api\/v2\.0\/payment\/transactions\/(\d+)$/.exec(
    url.pathname,
  );
  const invoicePath =
    /^\/api\/v2\.0\/payment\/transactions\/invoices\/(\d+)$/.exec(url.pathname);
  const refundPath = /^\/api\/v2\.0\/payment\/refunds\/(\d+)$/.exec(
    url.pathname,
  );
  if (transactionPath || invoicePath || refundPath) {
    const source = transactionPath
      ? transactions
      : invoicePath
        ? invoices
        : refunds;
    const match = transactionPath ?? invoicePath ?? refundPath!;
    const value = source.get(Number(match[1]));
    return value
      ? Response.json(value)
      : new Response('not found', { status: 404 });
  }
  if (
    url.pathname === '/api/v2.0/payment/transactions/invoices/search' ||
    url.pathname === '/api/v2.0/payment/refunds/search'
  ) {
    const isInvoice = url.pathname.includes('/invoices/');
    const query = url.searchParams.get('query')!;
    const match = (
      isInvoice ? /^linkedTransaction:(\d+)$/ : /^transaction\.id:(\d+)$/
    ).exec(query);
    if (!match || url.searchParams.get('order') !== 'id:ASC')
      throw Error('Unexpected provider search.');
    const filtered = [...(isInvoice ? invoices : refunds).values()].filter(
      (value) =>
        isInvoice
          ? value.linkedTransaction === Number(match[1])
          : (value.transaction as Json).id === Number(match[1]),
    );
    filtered.sort((a, b) => Number(a.id) - Number(b.id));
    const offset = Number(url.searchParams.get('offset')),
      limit = Number(url.searchParams.get('limit'));
    return Response.json({
      data: filtered.slice(offset, offset + limit),
      offset,
      limit,
      hasMore: filtered.length > offset + limit,
    });
  }
  throw Error(`Unimplemented fixture path ${url.pathname}`);
};
const run = (config = configuration(), maximumJobs = 1) =>
  reconcilePostFinanceJobs(
    config,
    { database: d1, fetch: transport, now: () => time * 1000 },
    maximumJobs,
  );
async function noRights() {
  expect(await periods().paidCoverage(identity)).toBeNull();
  expect(await prepaidCompanyAccess(identity.organizationId!)).toBeNull();
  expect(count('prepaid_current_company_rights')).toBe(0);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  time = Date.parse('2026-10-06T10:11:12Z') / 1000;
  vi.setSystemTime(time * 1000);
  requests = [];
  prepared = [];
  transactions = new Map();
  invoices = new Map();
  refunds = new Map();
  override = undefined;
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => time);
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((value) => value.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'),
    );
  runtime.database = d1();
  period = await createBoundContract();
  unexpectedNetwork = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(Error('Real network is forbidden.'));
});
afterEach(() => {
  expect(unexpectedNetwork).not.toHaveBeenCalled();
  unexpectedNetwork.mockRestore();
  for (const { url, init } of requests) {
    expect(url.origin).toBe(origin);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Space).toBe('405');
    const [head, payload, signature] =
      headers.Authorization.slice(7).split('.');
    expect(
      JSON.parse(Buffer.from(payload, 'base64url').toString()),
    ).toMatchObject({
      sub: '512',
      requestPath: url.pathname + url.search,
      requestMethod: 'GET',
    });
    expect(signature).toBe(
      createHmac('sha256', Buffer.from(authenticationKey, 'base64'))
        .update(`${head}.${payload}`)
        .digest('base64url'),
    );
  }
  sql.close();
  vi.useRealTimers();
});

describe('PostFinance reconciliation worker with real migrated SQLite stores and provider-read client', () => {
  it('disabled configuration performs zero database or HTTP work even with an invalid active configuration', async () => {
    const database = vi.fn(() => {
      throw Error('Database must not be acquired.');
    });
    const http = vi.fn(async () => {
      throw Error('HTTP must not be invoked.');
    });
    const before = prepared.length;
    expect(
      await reconcilePostFinanceJobs(
        configuration({ enabled: false, listeners: [], spaceId: 0 }),
        { database, fetch: http },
      ),
    ).toEqual({
      state: 'disabled',
      claimed: 0,
      completed: 0,
      waiting: 0,
      lost: 0,
    });
    expect(database).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(prepared).toHaveLength(before);
  });

  it.each(['transaction', 'invoice'] as const)(
    'settles the %s event using distinct invoice/transaction IDs and the frozen catalogue',
    async (kind) => {
      await enqueue(kind, 1, kind === 'invoice' ? 81 : 71);
      expect(await run()).toEqual({
        state: 'processed',
        claimed: 1,
        completed: 1,
        waiting: 0,
        lost: 0,
      });
      expect(
        sql
          .prepare(`SELECT t.transaction_id,s.invoice_id,p.price_chf_minor,p.catalog_version
      FROM prepaid_settlement_proofs s JOIN prepaid_transactions t ON t.period_id=s.period_id
      JOIN prepaid_periods p ON p.period_id=s.period_id`)
          .get(),
      ).toMatchObject({
        transaction_id: 71,
        invoice_id: 81,
        price_chf_minor: period.priceChfMinor,
        catalog_version: period.catalogVersion,
      });
      expect(await periods().paidCoverage(identity)).toMatchObject({
        periodId: period.periodId,
        startsAt: period.startsAt,
        endsAt: period.endsAt,
      });
      expect(
        await prepaidCompanyAccess(identity.organizationId!),
      ).toMatchObject({
        contractId: identity.contractId,
        periodId: period.periodId,
      });
      expect(count('prepaid_current_company_rights')).toBe(1);
      expect(workRow()).toMatchObject({ state: 'completed', attempts: 1 });
      expect(
        requests.some(
          (value) =>
            value.url.pathname === '/api/v2.0/payment/transactions/invoices/71',
        ),
      ).toBe(false);
    },
  );

  it('a refund event resolves its transaction to the correct period and removes only that company’s paid rights', async () => {
    const otherIdentity = {
      ...identity,
      contractId: 'pfp_22222222-2222-4222-8222-222222222222',
      ownerId: 'other-owner',
      organizationId: 'other-company',
    };
    const other = await createBoundContract(
      otherIdentity,
      72,
      82,
      'other_payer',
    );
    await enqueue('transaction', 1, 71);
    await enqueue('transaction', 2, 72);
    expect(await run(configuration(), 2)).toMatchObject({
      claimed: 2,
      completed: 2,
    });
    refunds.set(51, refund());
    await enqueue('refund', 3, 51, 'SUCCESSFUL');
    expect(await run()).toMatchObject({ claimed: 1, completed: 1, waiting: 0 });
    expect(
      sql.prepare('SELECT period_id FROM prepaid_provider_reversals').get()
        ?.period_id,
    ).toBe(period.periodId);
    expect(await prepaidCompanyAccess(identity.organizationId!)).toBeNull();
    expect(
      await prepaidCompanyAccess(otherIdentity.organizationId!),
    ).toMatchObject({ periodId: other.periodId });
    expect(count('prepaid_settlement_proofs')).toBe(2);
    expect(count('prepaid_current_company_rights')).toBe(1);
    expect(
      requests.some(
        (value) => value.url.pathname === '/api/v2.0/payment/refunds/51',
      ),
    ).toBe(true);
  });

  it('a known successful refund revokes paid rights during an invoice API outage without querying invoices', async () => {
    await enqueue();
    expect(await run()).toMatchObject({ completed: 1 });
    expect(await prepaidCompanyAccess(identity.organizationId!)).not.toBeNull();
    requests = [];
    refunds.set(51, refund());
    override = (url) => {
      if (url.pathname.includes('/invoices'))
        return new Response('invoice API unavailable', { status: 503 });
    };
    await enqueue('refund', 2, 51, 'SUCCESSFUL');
    expect(await run()).toMatchObject({ claimed: 1, completed: 1, waiting: 0 });
    expect(
      requests.some((value) => value.url.pathname.includes('/invoices')),
    ).toBe(false);
    expect(count('prepaid_provider_reversals')).toBe(1);
    expect(count('prepaid_settlement_proofs')).toBe(1);
    await noRights();
  });

  it('a negative refund decision still requires a stable final transaction version before writing its tombstone', async () => {
    refunds.set(51, refund());
    await enqueue('refund', 1, 51, 'SUCCESSFUL');
    let reads = 0;
    override = (url) => {
      if (url.pathname === '/api/v2.0/payment/transactions/71' && ++reads === 2)
        return Response.json({ ...transactions.get(71)!, version: 8 });
    };
    expect(await run()).toMatchObject({ claimed: 1, completed: 0, waiting: 1 });
    expect(count('prepaid_provider_reversals')).toBe(0);
    expect(count('prepaid_settlement_proofs')).toBe(0);
    override = undefined;
    transactions.get(71)!.version = 8;
    nextRetry();
    expect(await run()).toMatchObject({ completed: 1 });
    expect(count('prepaid_provider_reversals')).toBe(1);
    await noRights();
  });

  it.each([
    'pending',
    'TEST',
    'connector-unverified',
    'wrong-method',
    'unsettled',
    'invoice-unpaid',
    'zero-version',
  ] as const)(
    'does not grant paid rights for %s, regardless of a paid-looking webhook state',
    async (kind) => {
      const transaction = transactions.get(71)!;
      if (kind === 'pending') transaction.state = 'PENDING';
      if (kind === 'TEST') transaction.authorizationEnvironment = 'TEST';
      if (kind === 'wrong-method')
        (
          transaction.paymentConnectorConfiguration as Json
        ).paymentMethodConfiguration = { id: 999 };
      if (kind === 'unsettled') transaction.totalSettledAmount = 0;
      if (kind === 'invoice-unpaid') invoices.get(81)!.state = 'NOT_APPLICABLE';
      if (kind === 'zero-version') transaction.version = 0;
      await enqueue();
      expect(
        await run(
          configuration({
            settlementEvidenceVerified: kind !== 'connector-unverified',
          }),
        ),
      ).toMatchObject({ claimed: 1, completed: 0, waiting: 1 });
      expect(count('prepaid_settlement_proofs')).toBe(0);
      await noRights();
      expect(workRow()).toMatchObject({ state: 'pending', attempts: 1 });
    },
  );

  it('a locally bound TEST contract cannot become a production paid fact', async () => {
    const testIdentity = {
      ...identity,
      contractId: 'pfp_33333333-3333-4333-8333-333333333333',
      ownerId: 'test-owner',
      organizationId: 'test-company',
      environment: 'TEST' as const,
    };
    await createBoundContract(testIdentity, 72, 82, 'test_payer');
    transactions.get(72)!.authorizationEnvironment = 'PRODUCTION';
    await enqueue('transaction', 1, 72);
    expect(await run()).toMatchObject({ completed: 0, waiting: 1 });
    expect(count('prepaid_settlement_proofs')).toBe(0);
    expect(await prepaidCompanyAccess(testIdentity.organizationId!)).toBeNull();
  });

  it.each([
    'transaction-space',
    'invoice-search-space',
    'invoice-search-link',
    'refund-search-space',
    'incomplete-search',
    'ambiguous-invoices',
    'cross-type-event',
  ] as const)(
    'fails closed for %s rather than following an unrelated provider identity',
    async (kind) => {
      if (kind === 'transaction-space')
        transactions.get(71)!.linkedSpaceId = 406;
      if (kind === 'ambiguous-invoices')
        invoices.set(82, { ...invoices.get(81)!, id: 82 });
      override = (url) => {
        if (url.pathname === '/api/v2.0/payment/transactions/invoices/search') {
          if (kind === 'invoice-search-space')
            return Response.json({
              data: [{ ...invoices.get(81)!, linkedSpaceId: 406 }],
              offset: 0,
              limit: 10,
              hasMore: false,
            });
          if (kind === 'invoice-search-link')
            return Response.json({
              data: [{ ...invoices.get(81)!, linkedTransaction: 72 }],
              offset: 0,
              limit: 10,
              hasMore: false,
            });
          if (kind === 'incomplete-search')
            return Response.json({
              data: [],
              offset: 0,
              limit: 10,
              hasMore: true,
            });
        }
        if (
          kind === 'refund-search-space' &&
          url.pathname === '/api/v2.0/payment/refunds/search'
        )
          return Response.json({
            data: [refund(51, 71), { ...refund(52, 71), linkedSpaceId: 406 }],
            offset: 0,
            limit: 10,
            hasMore: false,
          });
      };
      await enqueue(
        kind === 'cross-type-event' ? 'invoice' : 'transaction',
        1,
        71,
      );
      expect(await run()).toMatchObject({
        claimed: 1,
        completed: 0,
        waiting: 1,
      });
      expect(count('prepaid_settlement_proofs')).toBe(0);
      await noRights();
    },
  );

  it('duplicate delivery, distinct paid events and competing worker replicas produce one durable paid fact', async () => {
    expect(await enqueue()).toBe(true);
    expect(await enqueue()).toBe(false);
    const results = await Promise.all([run(), run()]);
    expect(results.reduce((n, result) => n + result.claimed, 0)).toBe(1);
    expect(results.reduce((n, result) => n + result.completed, 0)).toBe(1);
    const initial = sql
      .prepare(
        'SELECT evidence_fingerprint,reconciled_at FROM prepaid_settlement_proofs',
      )
      .get();
    await enqueue('invoice', 2, 81);
    expect(await run()).toMatchObject({ claimed: 1, completed: 1 });
    expect(count('prepaid_settlement_proofs')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT evidence_fingerprint,reconciled_at FROM prepaid_settlement_proofs',
        )
        .get(),
    ).toEqual(initial);
    const httpCount = requests.length;
    expect(await run()).toMatchObject({ claimed: 0 });
    expect(requests).toHaveLength(httpCount);
  });

  it('an interrupted provider read requeues work and the due retry settles without financial POSTs', async () => {
    await enqueue();
    override = (url) => {
      if (url.pathname === '/api/v2.0/payment/transactions/invoices/81')
        throw Error('fixture interrupted read');
      return undefined;
    };
    expect(await run()).toMatchObject({ claimed: 1, waiting: 1, completed: 0 });
    expect(workRow()).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error_code: 'provider_unavailable',
    });
    expect(count('prepaid_settlement_proofs')).toBe(0);
    const before = requests.length;
    expect(await run()).toMatchObject({ claimed: 0 });
    expect(requests).toHaveLength(before);
    override = undefined;
    nextRetry();
    expect(await run()).toMatchObject({ claimed: 1, completed: 1, waiting: 0 });
    expect(workRow()).toMatchObject({ state: 'completed', attempts: 2 });
    expect(count('prepaid_settlement_proofs')).toBe(1);
  });

  it('a database interruption after the paid fact preserves that fact and safely retries acknowledgement', async () => {
    await enqueue();
    let interrupted = false;
    const unreliable = () => {
      const actual = d1();
      return {
        prepare(query: string) {
          const statement = actual.prepare(query);
          if (query.includes("SET state='completed'")) {
            const original = statement.run.bind(statement);
            Object.assign(statement, {
              run: async () => {
                if (!interrupted) {
                  interrupted = true;
                  throw Error('fixture acknowledgement interrupted');
                }
                return original();
              },
            });
          }
          return statement;
        },
      };
    };
    expect(
      await reconcilePostFinanceJobs(configuration(), {
        database: unreliable,
        fetch: transport,
        now: () => time * 1000,
      }),
    ).toMatchObject({ claimed: 1, completed: 0, waiting: 1 });
    expect(count('prepaid_settlement_proofs')).toBe(1);
    const proof = sql.prepare('SELECT * FROM prepaid_settlement_proofs').get();
    nextRetry();
    expect(await run()).toMatchObject({ claimed: 1, completed: 1, waiting: 0 });
    expect(
      sql.prepare('SELECT * FROM prepaid_settlement_proofs').get(),
    ).toEqual(proof);
    expect(count('prepaid_settlement_proofs')).toBe(1);
    expect(workRow()).toMatchObject({ state: 'completed', attempts: 2 });
  });

  it('an expired worker lease cannot grant and a later worker recovers the abandoned GET-only job', async () => {
    await enqueue();
    let interrupted = false;
    override = () => {
      if (!interrupted) {
        interrupted = true;
        advance(301);
      }
      return undefined;
    };
    expect(await run()).toMatchObject({ claimed: 1, completed: 0, lost: 1 });
    expect(count('prepaid_settlement_proofs')).toBe(0);
    expect(workRow()).toMatchObject({ state: 'processing', attempts: 1 });
    override = undefined;
    expect(await run()).toMatchObject({ claimed: 1, completed: 1, lost: 0 });
    expect(workRow()).toMatchObject({ state: 'completed', attempts: 2 });
  });

  it('a transaction version changed during invoice/refund reads cannot grant until a stable retry', async () => {
    await enqueue();
    let reads = 0;
    override = (url) => {
      if (url.pathname === '/api/v2.0/payment/transactions/71' && ++reads === 2)
        return Response.json({ ...transactions.get(71)!, version: 8 });
    };
    expect(await run()).toMatchObject({ claimed: 1, completed: 0, waiting: 1 });
    expect(workRow()).toMatchObject({ last_error_code: 'settlement_pending' });
    expect(count('prepaid_settlement_proofs')).toBe(0);
    await noRights();
    override = undefined;
    transactions.get(71)!.version = 8;
    nextRetry();
    expect(await run()).toMatchObject({ completed: 1 });
  });

  it('a refund received before the first grant fences a delayed stale paid event forever', async () => {
    refunds.set(51, refund());
    await enqueue('refund', 1, 51, 'SUCCESSFUL');
    expect(await run()).toMatchObject({ claimed: 1, completed: 1 });
    expect(count('prepaid_settlement_proofs')).toBe(0);
    expect(count('prepaid_provider_reversals')).toBe(1);
    const reversal = sql
      .prepare('SELECT * FROM prepaid_provider_reversals')
      .get();
    // Even stale provider reads which temporarily omit the refund cannot restore access.
    refunds.clear();
    await enqueue(
      'transaction',
      2,
      71,
      'FULFILL',
      new Date((time - 60) * 1000).toISOString(),
    );
    expect(await run()).toMatchObject({ claimed: 1, completed: 0, waiting: 1 });
    expect(count('prepaid_settlement_proofs')).toBe(0);
    expect(
      sql.prepare('SELECT * FROM prepaid_provider_reversals').get(),
    ).toEqual(reversal);
    await noRights();
    nextRetry();
    expect(await run()).toMatchObject({ completed: 0, waiting: 1 });
    await noRights();
  });
});
