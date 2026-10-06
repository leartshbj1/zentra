import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { D1PrepaidProvisioning } from '@/lib/payments/prepaid-provisioning';

const runtime = vi.hoisted(() => ({ db: null as unknown, stripe: vi.fn() }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      runtime.stripe();
      throw Error('No merchant transport in a local provisioning test.');
    }
    static createFetchHttpClient() {
      runtime.stripe();
      throw Error('No Stripe HTTP.');
    }
  },
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
import {
  D1PrepaidObservations,
  D1PostFinanceSettlementQueue,
} from './prepaid-observation-store';
import {
  assertSettlementWork,
  settlementWorkFence,
  isObservationWork,
  assertObservationTarget,
} from './prepaid-settlement-work';
import {
  prepareInitialPrepaidPurchase,
  type PrepaidPurchaseConfiguration,
} from '@/lib/payments/prepaid-purchase-preparation';
import { D1PurchaseIntents } from '@/lib/payments/purchase-intents';
import { D1PrepaidPeriods } from '@/lib/payments/prepaid-periods';
import {
  D1PrepaidReconciliationStore,
  type SettlementRecord,
} from '@/lib/payments/prepaid-reconciliation-store';
import {
  D1PostFinanceWebhookInbox,
  type WebhookWork,
} from '@/lib/payments/postfinance-store';
import { prepaidCatalog, prepaidProduct } from '@/lib/payments/prepaid-catalog';
import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { AUTOMATION_TERMS_VERSION } from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';

type Prepared = Extract<
  Awaited<ReturnType<typeof prepareInitialPrepaidPurchase>>,
  { state: 'prepared' }
>;
let db: DatabaseSync,
  clock: number,
  queries: string[],
  beforeBatch: (() => void) | undefined;
let interrupt: string | null, network: ReturnType<typeof vi.spyOn>;
const anchor = Date.parse('2026-10-06T10:11:12Z') / 1000;
const owner = 'owner-provisioning';
const organization = 'company-provisioning';
const workspaceId = 'workspace-provisioning';
const previousSubscriptionId = 'trial_original_provisioning';
const apiOrigin = 'https://checkout.postfinance.ch';
const user = {
  userId: owner,
  email: 'owner@example.test',
  emailConfirmed: true,
};
function setTime(value: number) {
  clock = value;
  vi.setSystemTime(value * 1000);
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
            throw Error('Injected atomic-batch interruption.');
          }
          return { success: true, meta: db.prepare(query).run(...values) };
        },
        async run() {
          return statement.execute();
        },
        async first() {
          return db.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { success: true, results: db.prepare(query).all(...values) };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      const pending = beforeBatch;
      beforeBatch = undefined;
      pending?.();
      db.exec('BEGIN');
      try {
        const results = statements.map((item) => item.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
const count = (table: string) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
function configuration(
  environment: 'PRODUCTION' | 'TEST' = 'PRODUCTION',
): PrepaidPurchaseConfiguration {
  return {
    enabled: true,
    settlementEvidenceVerified: true,
    connectorConfigurations: { postfinance_pay: 92 },
    connection: {
      enabled: true,
      merchantApproved: true,
      prepaidFeatureEnabled: true,
      chargeFlowEnabled: true,
      postfinancePayTokenEnabled: true,
      prepaidEnvironment: environment,
      apiOrigin,
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
            methodConfigurations: { postfinance_pay: 91 },
          },
        ]),
      ),
    },
  };
}
async function prepare(
  productKey = 'complet:team',
  environment: 'PRODUCTION' | 'TEST' = 'PRODUCTION',
) {
  const product = prepaidProduct(productKey)!;
  const prepared = await prepareInitialPrepaidPurchase(
    configuration(environment),
    {
      user,
      requestId: '11111111-1111-4111-8111-111111111111',
      productKey,
      organizationId:
        product.productKind === 'support' ? undefined : organization,
      workspaceId: product.support ? workspaceId : undefined,
      method: 'postfinance_pay',
      acceptTerms: true,
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
    },
    { database: () => d1(), now: () => clock },
  );
  if (prepared.state !== 'prepared')
    throw Error('Missing prepared fictional purchase.');
  return prepared;
}
async function claimed(
  prepared: Prepared,
): Promise<{ proof: SettlementRecord; work: WebhookWork }> {
  const intents = new D1PurchaseIntents(d1(), () => clock);
  await intents.markDispatched(prepared.intent);
  await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
    prepared.period.periodId,
    71,
  );
  await intents.bindProviderReference(prepared.intent, '71');
  const inbox = new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => clock,
  );
  await inbox.acceptOnce(`${apiOrigin}|405|10|1`, {
    eventId: 1,
    entityId: 71,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(clock * 1000).toISOString(),
  });
  const work = await inbox.claimNext();
  if (!work) throw Error('Missing private worker lease.');
  return {
    work,
    proof: {
      periodId: prepared.period.periodId,
      transactionId: 71,
      invoiceId: 81,
      apiOrigin,
      spaceId: 405,
      environment: prepared.contract.environment,
      ownerId: owner,
      organizationId: prepared.contract.organizationId,
      workspaceId: prepared.contract.workspaceId,
      startsAt: prepared.period.startsAt,
      endsAt: prepared.period.endsAt,
      currency: 'CHF',
      priceChfMinor: prepared.period.priceChfMinor,
      catalogVersion: prepared.period.catalogVersion,
      evidenceFingerprint: 'a'.repeat(64),
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setTime(anchor);
  queries = [];
  beforeBatch = undefined;
  interrupt = null;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.function('unixepoch', () => clock);
  const migrations = new URL('../../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  runtime.db = d1();
  runtime.stripe.mockClear();
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,entitlement_plan_id,seat_limit,status,
    current_period_end,entitlement_valid_until,livemode,updated_at)
    VALUES(?,?,'trial-price','zentra-start-monthly-59-chf','zentra-start-monthly-59-chf',3,'active',?,?,1,?)`).run(
    previousSubscriptionId,
    previousSubscriptionId,
    clock + 86400,
    clock + 86400,
    clock,
  );
  db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(
    organization,
    'PME préservée',
    previousSubscriptionId,
    owner,
    clock,
    clock,
  );
  for (const [index, member] of [
    owner,
    'collaborator-one',
    'collaborator-two',
  ].entries())
    db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
      VALUES(?,?,?,?,?,?,?)`).run(
      `member-${index}`,
      organization,
      member,
      `${member}@example.test`,
      member,
      index ? 'member' : 'owner',
      clock + index,
    );
  db.prepare(
    'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?)',
  ).run(
    owner,
    'synthetic-email-hash',
    organization,
    previousSubscriptionId,
    clock - 86400,
    clock + 86400,
  );
  db.prepare(
    'INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES(?,?,?,?,?)',
  ).run(
    'original-license',
    previousSubscriptionId,
    'original-installation',
    clock - 100,
    clock - 50,
  );
  db.prepare(`INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    'original-session',
    'original-session-hash',
    organization,
    owner,
    'original-installation',
    clock - 100,
    clock - 50,
    clock + 86400,
  );
  db.prepare(
    'INSERT INTO business_sync_spaces(organization_id,generation,bootstrap_transfer_id,state,head_revision,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    organization,
    'original-generation',
    'original-transfer',
    'ready',
    17,
    owner,
    new Date(clock * 1000).toISOString(),
  );
  db.prepare(
    'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
  ).run(workspaceId, owner, 'Support préservé', clock, clock);
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No outgoing HTTP.');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  expect(runtime.stripe).not.toHaveBeenCalled();
  network.mockRestore();
  db.close();
  vi.useRealTimers();
});

const observationScope = {
  apiOrigin,
  spaceId: 405,
  environment: 'PRODUCTION' as const,
};
const observations = () => new D1PrepaidObservations(d1(), () => clock);
const queue = (
  listeners: { id: number; entityId: number; technicalName?: string }[] = [],
) =>
  new D1PostFinanceSettlementQueue(
    d1(),
    {
      apiOrigin,
      spaceId: 405,
      listeners,
      observations: { enabled: true, environment: 'PRODUCTION' },
    },
    () => clock,
  );
async function observed(productKey = 'complet:team') {
  const prepared = await prepare(productKey),
    intents = new D1PurchaseIntents(d1(), () => clock);
  await intents.markDispatched(prepared.intent);
  await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
    prepared.period.periodId,
    71,
  );
  await intents.bindProviderReference(prepared.intent, '71');
  expect(await observations().admitBoundTransactions(observationScope)).toEqual(
    { admitted: 1 },
  );
  const work = await queue().claimNext();
  if (!work || !isObservationWork(work))
    throw Error('Observation not claimed.');
  return { prepared, work };
}
describe('durable observation queue and shared settlement fences', () => {
  it.each(['gestion:start', 'support:starter', 'automation', 'complet:team'])(
    'admits exact %s without an event, grant or merchant',
    async (product) => {
      const { prepared, work } = await observed(product);
      expect(work.binding.periodId).toBe(prepared.period.periodId);
      expect('event' in work).toBe(false);
      const target = await new D1PrepaidReconciliationStore(
        d1(),
        () => clock,
      ).target(apiOrigin, 405, 71);
      expect(target).not.toBeNull();
      await assertObservationTarget(work, target!);
      const context = { ...work.binding };
      expect(
        (await assertSettlementWork(d1(), work, context, clock)).sourceJson,
      ).toBe(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(work.binding).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          ),
        ),
      );
      expect(count('prepaid_settlement_proofs')).toBe(0);
      expect(count('prepaid_purchase_projections')).toBe(0);
      expect(
        await observations().admitBoundTransactions(observationScope),
      ).toEqual({ admitted: 0 });
      expect(await queue().completeWork(work)).toBe(true);
      expect(await queue().completeWork(work)).toBe(false);
      expect(await queue().claimNext()).toBeNull();
    },
  );
  it('chooses the older due observation before a newer webhook with maximum one job', async () => {
    const { work } = await observed('gestion:start');
    await queue().failWork(work, 'settlement_pending');
    setTime(clock + 60);
    const inbox = new D1PostFinanceWebhookInbox(
      d1(),
      { apiOrigin, spaceId: 405, listeners: [{ id: 10, entityId: 20 }] },
      () => clock,
    );
    await inbox.acceptOnce(`${apiOrigin}|405|10|2`, {
      eventId: 2,
      entityId: 71,
      spaceId: 405,
      webhookListenerId: 10,
      listenerEntityId: 20,
      timestamp: new Date(clock * 1000).toISOString(),
    });
    expect(
      isObservationWork((await queue([{ id: 10, entityId: 20 }]).claimNext())!),
    ).toBe(true);
    const next = await queue([{ id: 10, entityId: 20 }]).claimNext();
    expect(next && !isObservationWork(next) && next.event.eventId).toBe(2);
  });
  it('keeps legacy webhook-only configuration and lease behavior', async () => {
    const prepared = await prepare('gestion:start'),
      { work } = await claimed(prepared);
    const q = new D1PostFinanceSettlementQueue(
      d1(),
      {
        apiOrigin,
        spaceId: 405,
        listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
      },
      () => clock,
    );
    await assertSettlementWork(
      d1(),
      work,
      {
        ...prepared.contract,
        periodId: prepared.period.periodId,
        transactionId: 71,
      },
      clock,
    );
    expect(await q.renewWork(work)).toBe(true);
    expect(await q.completeWork(work)).toBe(true);
    expect(await q.claimNext()).toBeNull();
  });
  it('claims one exact job under concurrent workers', async () => {
    const { work } = await observed('gestion:start');
    await queue().failWork(work, 'settlement_pending');
    setTime(clock + 60);
    const claimed = await Promise.all(
      Array.from({ length: 8 }, () => queue().claimNext()),
    );
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(
      db.prepare('SELECT attempts FROM postfinance_observation_jobs').get()
        ?.attempts,
    ).toBe(2);
  });
  it('does not renew, finish, fail or write with an expired/stolen lease', async () => {
    const { work } = await observed('gestion:start');
    setTime(clock + 301);
    const replacement = await queue().claimNext();
    expect(replacement).not.toBeNull();
    expect(await queue().renewWork(work)).toBe(false);
    expect(await queue().completeWork(work)).toBe(false);
    expect(await queue().failWork(work, 'provider_unavailable')).toBe(false);
    await expect(
      assertSettlementWork(d1(), work, work.binding, clock),
    ).rejects.toThrow();
    expect(await queue().completeWork(replacement!)).toBe(true);
  });
  it('preserves eight failed attempts and never silently requeues', async () => {
    let { work } = await observed('gestion:start');
    for (let n = 1; n <= 8; n++) {
      expect(work.attempts).toBe(n);
      expect(await queue().failWork(work, 'settlement_pending')).toBe(true);
      setTime(clock + 4000);
      if (n < 8) {
        const w = await queue().claimNext();
        if (!w || !isObservationWork(w)) throw Error('Missing retry');
        work = w;
      }
    }
    expect(
      db
        .prepare('SELECT state,attempts FROM postfinance_observation_jobs')
        .get(),
    ).toEqual({ state: 'failed', attempts: 8 });
    expect(await queue().claimNext()).toBeNull();
    expect(
      await observations().admitBoundTransactions(observationScope),
    ).toEqual({ admitted: 0 });
    expect(() =>
      db.exec("UPDATE postfinance_observation_jobs SET state='pending'"),
    ).toThrow('immutable');
  });
  it('records a crashed eighth attempt as failed without stealing any financial claim', async () => {
    let { work } = await observed('gestion:start');
    for (let n = 1; n < 8; n++) {
      await queue().failWork(work, 'provider_unavailable');
      setTime(clock + 4000);
      work = (await queue().claimNext()) as typeof work;
    }
    setTime(clock + 301);
    expect(await queue().claimNext()).toBeNull();
    expect(
      db
        .prepare('SELECT state,attempts FROM postfinance_observation_jobs')
        .get(),
    ).toEqual({ state: 'failed', attempts: 8 });
    expect(count('postfinance_mutations')).toBe(0);
  });
  it.each(['owner', 'deleted', 'link'])(
    'refuses new admissions after %s changes',
    async (kind) => {
      const prepared = await prepare();
      await new D1PurchaseIntents(d1(), () => clock).markDispatched(
        prepared.intent,
      );
      await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
        prepared.period.periodId,
        71,
      );
      await new D1PurchaseIntents(d1(), () => clock).bindProviderReference(
        prepared.intent,
        '71',
      );
      expect(
        db
          .prepare(
            'SELECT current_owner FROM prepaid_observation_sources WHERE period_id=?',
          )
          .get(prepared.period.periodId)?.current_owner,
      ).toBe(1);
      if (kind === 'owner')
        db.prepare(
          'UPDATE organization_members SET revoked_at=? WHERE user_id=?',
        ).run(clock, owner);
      if (kind === 'deleted')
        db.prepare(
          'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,0,?)',
        ).run(owner, clock);
      if (kind === 'link')
        db.prepare('UPDATE support_workspaces SET owner_id=? WHERE id=?').run(
          'foreign',
          workspaceId,
        );
      expect(
        await observations().admitBoundTransactions(observationScope),
      ).toEqual({ admitted: 0 });
      expect(count('postfinance_observation_jobs')).toBe(0);
    },
  );
  it('fences positive facts after owner revocation but allows an exact negative fact', async () => {
    const { work } = await observed('gestion:start');
    db.prepare(
      'UPDATE organization_members SET revoked_at=? WHERE user_id=?',
    ).run(clock, owner);
    await expect(
      assertSettlementWork(d1(), work, work.binding, clock),
    ).rejects.toThrow();
    await expect(
      assertSettlementWork(d1(), work, work.binding, clock, 'negative'),
    ).resolves.toHaveProperty('sourceJson');
  });
  it('does not admit a transaction whose initial provider reference differs', async () => {
    const p = await prepare('gestion:start'),
      intents = new D1PurchaseIntents(d1(), () => clock);
    await intents.markDispatched(p.intent);
    await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
      p.period.periodId,
      71,
    );
    await intents.bindProviderReference(p.intent, '72');
    expect(
      await observations().admitBoundTransactions(observationScope),
    ).toEqual({ admitted: 0 });
    await expect(
      observations().prepareCreateRecoveryAdmission({
        periodId: p.period.periodId,
        transactionId: 71,
        recoveryEvidenceFingerprint: 'b'.repeat(64),
      }),
    ).rejects.toThrow('binding');
  });
  it('stops a positive observation after the company changes its subscription, preserving negative evidence', async () => {
    const { work } = await observed('gestion:start');
    db.prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('trial_other','trial_other','trial','incomplete',0,1,?)",
    ).run(clock);
    db.prepare(
      "UPDATE organizations SET subscription_id='trial_other' WHERE organization_id=?",
    ).run(organization);
    await expect(
      assertSettlementWork(d1(), work, work.binding, clock),
    ).rejects.toThrow();
    await expect(
      assertSettlementWork(d1(), work, work.binding, clock, 'negative'),
    ).resolves.toHaveProperty('sourceJson');
  });
  it.each(['support:starter', 'automation'])(
    'keeps closed %s observable when the same owner replaces Gestion',
    async (product) => {
      if (product.startsWith('support'))
        db.prepare(
          'INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,1,0,?,?)',
        ).run(workspaceId, organization, owner, clock);
      const { prepared, work } = await observed(product);
      await new D1PrepaidProvisioning(d1(), () => clock).provision(
        {
          periodId: prepared.period.periodId,
          transactionId: 71,
          invoiceId: 81,
          apiOrigin,
          spaceId: 405,
          environment: 'PRODUCTION',
          ownerId: owner,
          organizationId: prepared.contract.organizationId,
          workspaceId: prepared.contract.workspaceId,
          startsAt: prepared.period.startsAt,
          endsAt: prepared.period.endsAt,
          currency: 'CHF',
          priceChfMinor: prepared.period.priceChfMinor,
          catalogVersion: prepared.period.catalogVersion,
          evidenceFingerprint: 'a'.repeat(64),
        },
        work,
      );
      db.prepare(
        "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub_next_gestion','cus_next_gestion','price_next','active',?,1,?)",
      ).run(clock + 86400, clock);
      db.prepare(
        "UPDATE organizations SET subscription_id='sub_next_gestion' WHERE organization_id=?",
      ).run(organization);
      await expect(
        assertSettlementWork(d1(), work, work.binding, clock),
      ).resolves.toHaveProperty('sourceJson');
      db.prepare(
        'UPDATE organization_members SET revoked_at=? WHERE user_id=?',
      ).run(clock, owner);
      await expect(
        assertSettlementWork(d1(), work, work.binding, clock),
      ).rejects.toThrow();
      await expect(
        assertSettlementWork(d1(), work, work.binding, clock, 'negative'),
      ).resolves.toHaveProperty('sourceJson');
    },
  );
  it.each([
    'space',
    'environment',
    'owner',
    'period',
    'transaction',
    'catalog',
  ])('rejects altered context %s', async (kind) => {
    const { work } = await observed('gestion:start'),
      c = { ...work.binding };
    if (kind === 'space') c.spaceId++;
    if (kind === 'environment') c.environment = 'TEST';
    if (kind === 'owner') c.ownerId = 'foreign';
    if (kind === 'period') c.periodId = 'pfperiod_' + 'b'.repeat(64);
    if (kind === 'transaction') c.transactionId++;
    if (kind === 'catalog') c.priceChfMinor++;
    await expect(settlementWorkFence(work, c, clock)).rejects.toThrow();
  });
  it('separates TEST observations from production workers and never defaults an environment', async () => {
    const p = await prepare('gestion:start', 'TEST');
    await new D1PurchaseIntents(d1(), () => clock).markDispatched(p.intent);
    await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
      p.period.periodId,
      71,
    );
    await new D1PurchaseIntents(d1(), () => clock).bindProviderReference(
      p.intent,
      '71',
    );
    expect(
      await observations().admitBoundTransactions({
        ...observationScope,
        environment: 'TEST',
      }),
    ).toEqual({ admitted: 1 });
    expect(await queue().claimNext()).toBeNull();
    const q = new D1PostFinanceSettlementQueue(
      d1(),
      {
        apiOrigin,
        spaceId: 405,
        listeners: [],
        observations: { enabled: true, environment: 'TEST' },
      },
      () => clock,
    );
    expect(isObservationWork((await q.claimNext())!)).toBe(true);
    expect(
      () =>
        new D1PostFinanceSettlementQueue(d1(), {
          apiOrigin,
          spaceId: 405,
          listeners: [],
        }),
    ).toThrow();
  });
  it('rolls recovery binding back when admission cannot prove its receipt', async () => {
    const p = await prepare('gestion:start');
    await new D1PurchaseIntents(d1(), () => clock).markDispatched(p.intent);
    const admission = await observations().prepareCreateRecoveryAdmission({
      periodId: p.period.periodId,
      transactionId: 71,
      recoveryEvidenceFingerprint: 'b'.repeat(64),
    });
    await expect(
      d1().batch([
        d1()
          .prepare('INSERT INTO prepaid_transactions VALUES(?,?,?,?,?)')
          .bind(p.period.periodId, apiOrigin, 405, 71, clock),
        ...admission,
      ]),
    ).rejects.toThrow('observation_binding');
    expect(count('prepaid_transactions')).toBe(0);
    expect(count('postfinance_observation_jobs')).toBe(0);
  });
  it('keeps immutable observation identity and history', async () => {
    await observed('gestion:start');
    expect(() =>
      db.exec('UPDATE postfinance_observation_jobs SET transaction_id=72'),
    ).toThrow('immutable');
    expect(() => db.exec('DELETE FROM postfinance_observation_jobs')).toThrow(
      'immutable',
    );
  });
});
