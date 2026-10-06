import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  prepareInitialPrepaidPurchase,
  type PrepaidPurchaseConfiguration,
} from './prepaid-purchase-preparation';
import { D1PurchaseIntents } from './purchase-intents';
import { prepaidCatalog, prepaidProduct } from './prepaid-catalog';
import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { AUTOMATION_TERMS_VERSION } from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';

// Only the Cloudflare runtime import is replaced. Authorization, catalogue,
// reservations, database triggers, periods and expectations are the real modules.
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Use the explicitly injected migrated database.');
  },
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));

type Input = Parameters<typeof prepareInitialPrepaidPurchase>[1];
type Prepared = Extract<
  Awaited<ReturnType<typeof prepareInitialPrepaidPurchase>>,
  { state: 'prepared' }
>;
type MutableConfiguration = {
  -readonly [K in keyof PrepaidPurchaseConfiguration]: PrepaidPurchaseConfiguration[K];
};
let sql: DatabaseSync, clock: number;
let queries: string[];
let databaseCalls: number;
let interrupt: string | null;
let beforeBatch: (() => void) | undefined;
let network: ReturnType<typeof vi.spyOn>;
const anchor = Date.parse('2026-10-06T10:11:12Z') / 1000;
const user = {
  userId: 'private-owner-fixture',
  email: 'owner@example.test',
  emailConfirmed: true,
};
const authenticationKey = Buffer.alloc(32, 0x5a).toString('base64');
const initialRequest: Input = {
  user,
  requestId: '11111111-1111-4111-8111-111111111111',
  productKey: 'gestion:start',
  organizationId: 'company-a',
  method: 'postfinance_pay',
  acceptTerms: true,
  legalVersion: LEGAL_VERSION,
};

function configuration(): MutableConfiguration {
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
      authenticationKeyBase64: authenticationKey,
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
function d1() {
  return {
    prepare(query: string) {
      queries.push(query);
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        execute() {
          if (interrupt && query.includes(interrupt)) {
            interrupt = null;
            throw Error('Fixture interrupted durable preparation.');
          }
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
      const pending = beforeBatch;
      beforeBatch = undefined;
      pending?.();
      // SQLite executes every batch synchronously inside one real transaction,
      // so concurrent callers cannot observe a partial footprint admission.
      sql.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
const count = (table: string) =>
  Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const row = (table: string) => sql.prepare(`SELECT * FROM ${table}`).get();
function projectionSnapshot() {
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
function assertNoRights() {
  for (const table of [
    'prepaid_transactions',
    'prepaid_settlement_proofs',
    'prepaid_period_revocations',
    'prepaid_provider_reversals',
    'prepaid_current_company_rights',
    'license_activations',
    'device_sessions',
    'postfinance_mutations',
    'postfinance_webhook_inbox',
  ])
    expect(count(table)).toBe(0);
}
async function run(input: Input = initialRequest, config = configuration()) {
  const before = projectionSnapshot();
  try {
    return await prepareInitialPrepaidPurchase(config, input, {
      database: () => {
        databaseCalls++;
        return d1();
      },
      now: () => clock,
    });
  } finally {
    expect(projectionSnapshot()).toEqual(before);
    assertNoRights();
  }
}
async function prepared(
  input: Input = initialRequest,
  config = configuration(),
): Promise<Prepared> {
  const result = await run(input, config);
  if (result.state !== 'prepared')
    throw Error('Expected a prepared local intent.');
  return result;
}
function request(productKey: string): Input {
  const product = prepaidProduct(productKey)!;
  return {
    ...initialRequest,
    productKey,
    organizationId: product.productKind === 'support' ? undefined : 'company-a',
    workspaceId: product.support ? 'workspace-a' : undefined,
    legalVersion:
      product.productKind === 'gestion'
        ? LEGAL_VERSION
        : product.productKind === 'support'
          ? SUPPORT_LEGAL_VERSION
          : product.productKind === 'complete'
            ? COMPLETE_TERMS_VERSION
            : AUTOMATION_TERMS_VERSION,
    ...(product.productKind === 'automation'
      ? { consentVersion: AUTOMATION_CONSENT_VERSION }
      : {}),
  };
}

beforeEach(() => {
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
  for (const suffix of ['a', 'b']) {
    sql
      .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
      VALUES(?,?,'fixture-local','canceled',0,?)`)
      .run(`trial-${suffix}`, `local-${suffix}`, clock);
    sql
      .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
      .run(
        `company-${suffix}`,
        `Company ${suffix}`,
        `trial-${suffix}`,
        user.userId,
        clock,
        clock,
      );
    sql
      .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
      VALUES(?,?,?,?,'owner',?)`)
      .run(
        `owner-${suffix}`,
        `company-${suffix}`,
        user.userId,
        user.email,
        clock,
      );
  }
  sql
    .prepare(
      'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
    .run('workspace-a', user.userId, 'Owned workspace', clock, clock);
  queries = [];
  databaseCalls = 0;
  interrupt = null;
  beforeBatch = undefined;
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No provider HTTP is authorized.');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  sql.close();
  vi.useRealTimers();
});

describe('durable initial prepaid preparation without financial calls or entitlements', () => {
  it('disabled configuration touches neither database nor HTTP, even with invalid request/configuration', async () => {
    const config = configuration();
    config.enabled = false;
    config.connection = { enabled: false };
    expect(
      await run(
        {
          ...initialRequest,
          requestId: '',
          user: { ...user, emailConfirmed: false },
        },
        config,
      ),
    ).toEqual({ state: 'disabled' });
    expect(databaseCalls).toBe(0);
    expect(queries).toEqual([]);
    expect(count('purchase_intents')).toBe(0);
  });
  it.each([
    'enabled',
    'merchantApproved',
    'prepaidFeatureEnabled',
    'chargeFlowEnabled',
    'postfinancePayTokenEnabled',
  ] as const)(
    'requires the server-owned %s flag before reading the database',
    async (flag) => {
      const config = configuration();
      config.connection[flag] = false;
      await expect(run(initialRequest, config)).rejects.toThrow();
      expect(databaseCalls).toBe(0);
      expect(queries).toEqual([]);
    },
  );
  it('requires verified production settlement semantics and explicit TWINT user-on-file approval', async () => {
    const config = configuration();
    config.settlementEvidenceVerified = false;
    await expect(run(initialRequest, config)).rejects.toThrow();
    config.settlementEvidenceVerified = true;
    config.connection.twintUserOnFileEnabled = false;
    await expect(
      run({ ...initialRequest, method: 'twint' }, config),
    ).rejects.toMatchObject({ code: 'configuration' });
    expect(databaseCalls).toBe(0);
  });
  it.each([
    { spaceId: 0 },
    { applicationUserId: '0' },
    { authenticationKeyBase64: 'not-a-key' },
    { returnOrigin: 'http://zentra.example.test' },
    { returnOrigin: 'https://zentra.example.test/path' },
    { returnOrigin: 'https://owner:password@zentra.example.test' },
    { prepaidEnvironment: undefined },
  ])(
    'rejects malformed server configuration %j before creating any row',
    async (changed) => {
      const config = configuration();
      Object.assign(config.connection, changed);
      await expect(run(initialRequest, config)).rejects.toThrow();
      expect(databaseCalls).toBe(0);
      expect(count('purchase_intents')).toBe(0);
    },
  );
  it.each(['', 'not-a-request', '11111111-1111-4111-8111-11111111111Z'])(
    'rejects request ID %j',
    async (requestId) => {
      await expect(run({ ...initialRequest, requestId })).rejects.toMatchObject(
        { code: 'request' },
      );
      expect(databaseCalls).toBe(0);
    },
  );
  it.each([
    { emailConfirmed: false },
    { email: 'bad' },
    { userId: '' },
    { userId: 'owner\nforged' },
  ])('requires a verified server identity %j', async (changed) => {
    await expect(
      run({ ...initialRequest, user: { ...user, ...changed } }),
    ).rejects.toMatchObject({ code: 'authentication' });
    expect(count('purchase_intents')).toBe(0);
  });
  it.each(['admin', 'accountant', 'member'])(
    'does not turn %s membership into ownership',
    async (role) => {
      sql
        .prepare('UPDATE organization_members SET role=? WHERE membership_id=?')
        .run(role, 'owner-a');
      await expect(run()).rejects.toMatchObject({ code: 'ownership' });
      expect(count('purchase_intents')).toBe(0);
    },
  );
  it.each([
    'creator',
    'revoked',
    'foreign-workspace',
    'missing-target',
    'workspace-on-Gestion',
  ])('rejects mismatched %s context', async (mode) => {
    let input = { ...initialRequest };
    if (mode === 'creator')
      sql
        .prepare(
          "UPDATE organizations SET created_by_user_id='another' WHERE organization_id='company-a'",
        )
        .run();
    if (mode === 'revoked')
      sql
        .prepare(
          "UPDATE organization_members SET revoked_at=? WHERE membership_id='owner-a'",
        )
        .run(clock);
    if (mode === 'foreign-workspace') {
      input = request('complet:team');
      sql
        .prepare(
          "UPDATE support_workspaces SET owner_id='another' WHERE id='workspace-a'",
        )
        .run();
    }
    if (mode === 'missing-target') input.organizationId = 'missing';
    if (mode === 'workspace-on-Gestion') input.workspaceId = 'workspace-a';
    await expect(run(input)).rejects.toThrow();
    expect(count('purchase_intents')).toBe(0);
  });
  it.each(['gestion:start', 'support:starter', 'complet:team', 'automation'])(
    'captures current legal acceptance for %s only',
    async (productKey) => {
      const input = request(productKey);
      await expect(run({ ...input, acceptTerms: false })).rejects.toMatchObject(
        { code: 'terms' },
      );
      await expect(
        run({ ...input, legalVersion: 'old-version' }),
      ).rejects.toMatchObject({ code: 'terms' });
      if (productKey === 'automation')
        await expect(
          run({ ...input, consentVersion: 'old-consent' }),
        ).rejects.toMatchObject({ code: 'terms' });
      expect(count('purchase_intents')).toBe(0);
      const result = await prepared(input);
      expect(result.intent.terms).toEqual({
        version: input.legalVersion,
        consentVersion:
          productKey === 'automation' ? AUTOMATION_CONSENT_VERSION : null,
        origin: 'https://zentra.example.test',
        acceptedAt: anchor,
      });
    },
  );
  it.each([
    { currency: 'EUR' },
    { billingPeriod: 'P1Y' },
    { priceChfMinor: 1 },
    { priceChfMinor: 5900.01 },
    { reference: 'another-plan' },
    { name: 'Another product' },
    { methodConfigurations: { postfinance_pay: 0 } },
  ])(
    'rejects provider product configuration that differs from the frozen catalogue %j',
    async (changed) => {
      const config = configuration();
      Object.assign(
        config.connection.prepaidProducts!['gestion:start'],
        changed,
      );
      await expect(run(initialRequest, config)).rejects.toMatchObject({
        code: 'configuration',
      });
      expect(count('purchase_intents')).toBe(0);
    },
  );
  it('requires an exact positive connector configuration independently of the method configuration', async () => {
    const config = configuration();
    config.connectorConfigurations.postfinance_pay = 0;
    await expect(run(initialRequest, config)).rejects.toMatchObject({
      code: 'configuration',
    });
    expect(count('prepaid_contracts')).toBe(0);
  });
  it('freezes price/catalogue/configuration and derives opaque payer/business keys without copying secrets', async () => {
    const result = await prepared();
    const product = prepaidProduct('gestion:start')!;
    expect(result.intent).toMatchObject({
      ownerId: user.userId,
      provider: 'postfinance',
      providerScope: 'https://checkout.postfinance.ch|405',
      product: 'gestion',
      state: 'reserved',
      environment: 'PRODUCTION',
      organizationId: 'company-a',
      workspaceId: null,
      parameters: {
        requestId: initialRequest.requestId,
        productKey: product.productKey,
        priceChfMinor: 5900,
        catalogVersion: product.catalogVersion,
        method: 'postfinance_pay',
        methodConfigurationId: 91,
        connectorConfigurationId: 92,
      },
    });
    expect(result.contract.contractId).toBe(
      'pfp_' + result.intent.intentId.slice('purchase_'.length),
    );
    expect(result.intent.parameters.previousSubscriptionId).toBe('trial-a');
    expect(result.target).toEqual({
      intentId: result.intent.intentId,
      contractId: result.contract.contractId,
      ownerId: user.userId,
      organizationId: 'company-a',
      workspaceId: null,
      previousSubscriptionId: 'trial-a',
    });
    expect(row('prepaid_purchase_targets')).toMatchObject({
      intent_id: result.intent.intentId,
      contract_id: result.contract.contractId,
      organization_id: 'company-a',
      previous_subscription_id: 'trial-a',
    });
    expect(result.period).toMatchObject({
      contractId: result.contract.contractId,
      ordinal: 0,
      priceChfMinor: 5900,
      currency: 'CHF',
      catalogVersion: product.catalogVersion,
    });
    expect(result.expectation).toEqual({
      customerReference:
        'pfpayer_' + createHash('sha256').update(user.userId).digest('hex'),
      planReference: product.catalogVersion,
      paymentMethodConfigurationId: 91,
      connectorConfigurationId: 92,
    });
    expect(result.createInput.customerReference).not.toContain(user.userId);
    expect(result.businessKeys).toEqual({
      create: result.period.periodId + '_create',
      confirm: result.period.periodId + '_confirm',
      chargeflow: result.period.periodId + '_chargeflow',
    });
    expect(JSON.stringify(result)).not.toContain(authenticationKey);
    expect(JSON.stringify(result.intent.parameters)).not.toMatch(
      /authentication|applicationUserId|secret|password/,
    );
    expect(row('prepaid_payment_expectations')).toMatchObject({
      period_id: result.period.periodId,
      customer_reference: result.expectation.customerReference,
      plan_reference: product.catalogVersion,
      payment_method_configuration_id: 91,
      connector_configuration_id: 92,
    });
  });
  it('captures Complete organization and workspace before payment without creating a link or paid legacy projection', async () => {
    const result = await prepared(request('complet:team'));
    expect(result.contract).toMatchObject({
      organizationId: 'company-a',
      workspaceId: 'workspace-a',
      productKey: 'complet:team',
    });
    expect(result.period.priceChfMinor).toBe(9900);
    expect(count('purchase_intent_footprints')).toBe(4);
    expect(count('support_gestion_links')).toBe(0);
    expect(count('complete_subscriptions')).toBe(0);
    await expect(
      run({ ...request('complet:team'), organizationId: 'company-b' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(count('purchase_intents')).toBe(1);
  });
  it('derives linked Support context and refuses to retarget the existing link', async () => {
    sql
      .prepare(
        'INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,?)',
      )
      .run('workspace-a', 'company-a', user.userId, clock);
    const result = await prepared(request('support:starter'));
    expect(result.contract).toMatchObject({
      organizationId: 'company-a',
      workspaceId: 'workspace-a',
    });
    expect(count('purchase_intent_footprints')).toBe(2);
    await expect(
      run({ ...request('support:starter'), organizationId: 'company-b' }),
    ).rejects.toMatchObject({ code: 'link' });
  });
  it('keeps TEST and PRODUCTION reservations distinct without granting either before settlement', async () => {
    const testConfig = configuration();
    testConfig.connection.prepaidEnvironment = 'TEST';
    testConfig.settlementEvidenceVerified = false;
    const test = await prepared(initialRequest, testConfig);
    const production = await prepared();
    expect(test.intent.environment).toBe('TEST');
    expect(test.contract.environment).toBe('TEST');
    expect(production.intent.environment).toBe('PRODUCTION');
    expect(production.contract.environment).toBe('PRODUCTION');
    expect(test.intent.intentId).not.toBe(production.intent.intentId);
    expect(count('purchase_intents')).toBe(2);
    expect(count('prepaid_contracts')).toBe(2);
    assertNoRights();
  });
  it('concurrent identical requests share one durable intent, contract, period and expectation', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => prepared()),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    for (const table of [
      'purchase_intents',
      'purchase_intent_footprints',
      'prepaid_contracts',
      'prepaid_periods',
      'prepaid_payment_expectations',
    ])
      expect(count(table)).toBe(1);
    clock += 60;
    vi.setSystemTime(clock * 1000);
    expect(await prepared()).toEqual(results[0]);
    expect(row('purchase_intents')).toMatchObject({
      created_at: anchor,
      accepted_at: anchor,
      expires_at: anchor + 3600,
    });
  });
  it.each([
    'request',
    'method',
    'plan',
    'method-configuration',
    'connector',
    'return-origin',
    'merchant-origin',
    'email',
  ])(
    'changed %s context cannot reuse the occupied purchase footprint',
    async (changed) => {
      await prepared();
      const input = { ...initialRequest },
        config = configuration();
      if (changed === 'request')
        input.requestId = '22222222-2222-4222-8222-222222222222';
      if (changed === 'method') input.method = 'twint';
      if (changed === 'plan') input.productKey = 'gestion:pro';
      if (changed === 'method-configuration')
        config.connection.prepaidProducts![
          'gestion:start'
        ].methodConfigurations.postfinance_pay = 100;
      if (changed === 'connector')
        config.connectorConfigurations.postfinance_pay = 100;
      if (changed === 'return-origin')
        config.connection.returnOrigin = 'https://another.example.test';
      if (changed === 'merchant-origin')
        config.connection.apiOrigin = 'https://app-wallee.com';
      if (changed === 'email')
        input.user = { ...user, email: 'changed@example.test' };
      await expect(run(input, config)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(count('purchase_intents')).toBe(1);
      expect(count('prepaid_contracts')).toBe(1);
      expect(count('prepaid_periods')).toBe(1);
    },
  );
  it.each([
    'INSERT INTO prepaid_contracts',
    'INSERT INTO prepaid_periods',
    'INSERT INTO prepaid_payment_expectations',
    'INSERT INTO prepaid_purchase_targets',
  ])(
    'interrupted %s resumes the original intent without duplicating reservations',
    async (stage) => {
      interrupt = stage;
      await expect(run()).rejects.toThrow(
        'Fixture interrupted durable preparation.',
      );
      const original = row('purchase_intents')!;
      const result = await prepared();
      expect(result.intent.intentId).toBe(original.intent_id);
      expect(result.intent.fingerprint).toBe(original.fingerprint);
      for (const table of [
        'purchase_intents',
        'purchase_intent_footprints',
        'prepaid_contracts',
        'prepaid_periods',
        'prepaid_payment_expectations',
      ])
        expect(count(table)).toBe(1);
    },
  );
  it('resumes dispatched/uncertain preparation within the reservation without dispatching any new operation', async () => {
    const first = await prepared();
    const intents = new D1PurchaseIntents(d1(), () => clock);
    await intents.markDispatched(first.intent);
    await intents.markUncertain(first.intent);
    const second = await prepared();
    expect(second.intent.state).toBe('uncertain');
    expect(second.businessKeys).toEqual(first.businessKeys);
    expect(second.period).toEqual(first.period);
    expect(count('purchase_intents')).toBe(1);
    expect(count('prepaid_contracts')).toBe(1);
  });
  it('a changed company subscription cannot silently replace the frozen first-purchase target', async () => {
    const first = await prepared();
    sql
      .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
      VALUES('trial-replacement','replacement-owner','fixture-local','canceled',0,?)`)
      .run(clock);
    sql
      .prepare(
        "UPDATE organizations SET subscription_id='trial-replacement' WHERE organization_id='company-a'",
      )
      .run();
    await expect(
      prepareInitialPrepaidPurchase(configuration(), initialRequest, {
        database: () => d1(),
        now: () => clock,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(row('prepaid_purchase_targets')).toMatchObject({
      contract_id: first.contract.contractId,
      previous_subscription_id: 'trial-a',
    });
    expect(count('purchase_intents')).toBe(1);
  });
  it('does not automatically release an uncertain expired reservation', async () => {
    const first = await prepared();
    const intents = new D1PurchaseIntents(d1(), () => clock);
    await intents.markDispatched(first.intent);
    await intents.markUncertain(first.intent);
    clock = first.intent.expiresAt;
    vi.setSystemTime(clock * 1000);
    await expect(run()).rejects.toMatchObject({ code: 'state' });
    expect((await intents.read(first.intent)).state).toBe('uncertain');
    expect(
      sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()
        ?.released_at,
    ).toBeNull();
  });
  it('does not resurrect an explicitly released intent under the same request fingerprint', async () => {
    const first = await prepared();
    const intents = new D1PurchaseIntents(d1(), () => clock);
    await intents.releaseUndispatched(first.intent);
    await expect(run()).rejects.toMatchObject({ code: 'state' });
    expect((await intents.read(first.intent)).state).toBe('released');
    expect(count('purchase_intents')).toBe(1);
    expect(count('prepaid_contracts')).toBe(1);
  });
  it('independent owned companies may reserve their separate Gestion footprints', async () => {
    const first = await prepared();
    const second = await prepared({
      ...initialRequest,
      requestId: '22222222-2222-4222-8222-222222222222',
      organizationId: 'company-b',
    });
    expect(first.contract.organizationId).toBe('company-a');
    expect(second.contract.organizationId).toBe('company-b');
    expect(first.contract.contractId).not.toBe(second.contract.contractId);
    expect(count('purchase_intents')).toBe(2);
  });
  it('existing active Stripe occupancy rejects preparation rather than creating a second provider contract', async () => {
    sql
      .prepare(`UPDATE subscriptions SET subscription_id='sub_existing',status='active',livemode=1,
      entitlement_valid_until=? WHERE subscription_id='trial-a'`)
      .run(clock + 86400);
    await expect(run()).rejects.toMatchObject({ code: 'conflict' });
    expect(count('purchase_intents')).toBe(0);
    expect(count('prepaid_contracts')).toBe(0);
  });
  it.each(['owner-revocation', 'Complete-link-change'])(
    'atomic footprints recheck a %s after authorization',
    async (mode) => {
      beforeBatch = () => {
        // An independent committed change wins the race before the reservation's
        // own SQLite transaction. It must survive that rejected batch rollback.
        if (mode === 'owner-revocation')
          sql
            .prepare(
              "UPDATE organization_members SET revoked_at=? WHERE membership_id='owner-a'",
            )
            .run(clock);
        else
          sql
            .prepare(
              'INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,?)',
            )
            .run('workspace-a', 'company-b', user.userId, clock);
      };
      await expect(
        prepareInitialPrepaidPurchase(
          configuration(),
          mode === 'Complete-link-change'
            ? request('complet:team')
            : initialRequest,
          { database: () => d1(), now: () => clock },
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(count('purchase_intents')).toBe(0);
      expect(count('purchase_intent_footprints')).toBe(0);
      expect(count('prepaid_contracts')).toBe(0);
      assertNoRights();
      if (mode === 'owner-revocation')
        expect(
          sql
            .prepare(
              "SELECT revoked_at FROM organization_members WHERE membership_id='owner-a'",
            )
            .get()?.revoked_at,
        ).toBe(clock);
      else
        expect(
          sql
            .prepare(
              "SELECT organization_id FROM support_gestion_links WHERE workspace_id='workspace-a'",
            )
            .get()?.organization_id,
        ).toBe('company-b');
    },
  );
});
