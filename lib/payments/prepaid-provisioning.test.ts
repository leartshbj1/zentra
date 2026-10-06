import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Workspace } from '@/lib/support/types';

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
import { D1PrepaidProvisioning } from './prepaid-provisioning';
import {
  prepareInitialPrepaidPurchase,
  type PrepaidPurchaseConfiguration,
} from './prepaid-purchase-preparation';
import { D1PurchaseIntents } from './purchase-intents';
import { D1PrepaidPeriods } from './prepaid-periods';
import {
  D1PrepaidReconciliationStore,
  type SettlementRecord,
} from './prepaid-reconciliation-store';
import {
  D1PostFinanceWebhookInbox,
  type WebhookWork,
} from './postfinance-store';
import { prepaidCatalog, prepaidProduct } from './prepaid-catalog';
import {
  prepaidAutomationAccess,
  prepaidCompanyAccess,
  prepaidSupportAccess,
} from './prepaid-access';
import { teamSeats, requireMemberSeat } from '@/lib/team-seats';
import {
  completeAccess,
  completeSupportSubscription,
} from '@/lib/complete/access';
import { requireAutomationEntitlement } from '@/lib/automation/entitlement';
import {
  billingState,
  reserveAnalysis,
  finishAnalysis,
} from '@/lib/support/billing';
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
const provisioner = () => new D1PrepaidProvisioning(d1(), () => clock);
const count = (table: string) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const rows = (table: string) =>
  db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
const workspace = (): Workspace =>
  db
    .prepare('SELECT * FROM support_workspaces WHERE id=?')
    .get(workspaceId) as Workspace;
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
function preservedSnapshot() {
  return [
    'business_sync_spaces',
    'organization_members',
    'device_sessions',
  ].map((table) => [table, rows(table)]);
}
function assertNoHandoff() {
  expect(count('prepaid_settlement_proofs')).toBe(0);
  expect(count('prepaid_purchase_projections')).toBe(0);
  expect(
    db
      .prepare(
        'SELECT subscription_id FROM organizations WHERE organization_id=?',
      )
      .get(organization)?.subscription_id,
  ).toBe(previousSubscriptionId);
  expect(db.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
    'dispatched',
  );
  expect(
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM purchase_intent_footprints WHERE released_at IS NULL',
      )
      .get()?.n,
  ).toBeGreaterThan(0);
  expect(count('support_subscriptions')).toBe(0);
  expect(count('automation_subscriptions')).toBe(0);
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
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
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

describe('atomic first prepaid settlement and original-company handoff', () => {
  it('opens Complet together, preserving company data, collaborators, trial and device identities', async () => {
    const prepared = await prepare(),
      { proof, work } = await claimed(prepared),
      preserved = preservedSnapshot();
    const oldSubscription = db
      .prepare('SELECT * FROM subscriptions WHERE subscription_id=?')
      .get(previousSubscriptionId);
    const result = await provisioner().provision(proof, work);
    expect(result).toMatchObject({
      state: 'projected',
      contractId: prepared.contract.contractId,
      productKind: 'complete',
    });
    expect(preservedSnapshot()).toEqual(preserved);
    expect(
      db
        .prepare('SELECT * FROM subscriptions WHERE subscription_id=?')
        .get(previousSubscriptionId),
    ).toEqual(oldSubscription);
    expect(rows('account_trials')[0]).toMatchObject({
      subscription_id: previousSubscriptionId,
      converted_subscription_id: prepared.contract.contractId,
    });
    expect(rows('license_activations')[0]).toMatchObject({
      license_id: 'original-license',
      subscription_id: prepared.contract.contractId,
      installation_id: 'original-installation',
      activated_at: anchor - 100,
      last_issued_at: anchor - 50,
    });
    expect(await teamSeats(organization)).toMatchObject({
      priceChfCents: 9900,
      limit: 3,
      used: 3,
      subscriptionActive: true,
    });
    for (const member of [owner, 'collaborator-one', 'collaborator-two'])
      await requireMemberSeat(organization, member);
    const access = await prepaidCompanyAccess(organization);
    expect(access?.catalog.gestion).toMatchObject({
      licensePriceChfMinor: 5900,
      seats: 3,
    });
    expect((await completeAccess(organization))?.subscription_id).toBe(
      prepared.contract.contractId,
    );
    expect(
      (await completeSupportSubscription(workspaceId))?.subscription_id,
    ).toBe(prepared.contract.contractId);
    expect((await billingState(workspace())).limit).toBe(5000);
    await requireAutomationEntitlement({
      organizationId: organization,
      userId: 'collaborator-one',
      role: 'member',
      founder: false,
    });
    expect(rows('purchase_intents')[0]).toMatchObject({
      state: 'settled',
      evidence_fingerprint: proof.evidenceFingerprint,
    });
    expect(
      rows('purchase_intent_footprints').every(
        (row) => row.released_at === anchor,
      ),
    ).toBe(true);
    expect(rows('prepaid_purchase_projections')[0]).toMatchObject({
      closed_at: anchor,
      scope_hash: work.scopeHash,
      lease: work.lease,
    });
  });
  it('Gestion alone never creates Support linkage or Automation rights', async () => {
    const prepared = await prepare('gestion:start'),
      { proof, work } = await claimed(prepared);
    await provisioner().provision(proof, work);
    expect((await prepaidCompanyAccess(organization))?.productKind).toBe(
      'gestion',
    );
    expect(await prepaidSupportAccess(workspaceId)).toBeNull();
    expect(await prepaidAutomationAccess(organization)).toBeNull();
    expect(count('support_gestion_links')).toBe(0);
  });
  it.each(['amount', 'owner', 'company', 'Space'])(
    'never admits a settlement whose immutable %s differs from the prepared purchase',
    async (field) => {
      const prepared = await prepare(),
        { proof, work } = await claimed(prepared);
      const changed = { ...proof };
      if (field === 'amount') changed.priceChfMinor++;
      if (field === 'owner') changed.ownerId = 'other-owner';
      if (field === 'company') changed.organizationId = 'other-company';
      if (field === 'Space') changed.spaceId++;
      await expect(provisioner().provision(changed, work)).rejects.toThrow();
      assertNoHandoff();
    },
  );
  it('Support standalone waits for closure, then keeps its quota on every replay', async () => {
    const prepared = await prepare('support:team'),
      { proof, work } = await claimed(prepared);
    await new D1PrepaidPeriods(d1(), () => clock).recordReconciledSettlement(
      proof,
      work,
    );
    expect(await prepaidSupportAccess(workspaceId)).toBeNull();
    await provisioner().provision(proof, work);
    expect(
      (await prepaidSupportAccess(workspaceId))?.catalog.support?.analyses,
    ).toBe(5000);
    expect(
      db.prepare('SELECT subscription_id FROM organizations').get()
        ?.subscription_id,
    ).toBe(previousSubscriptionId);
    const reservation = await reserveAnalysis(
      workspace(),
      'fictional-ticket',
      'fictional-analysis-lease',
    );
    await finishAnalysis(reservation, true);
    const usage = rows('support_analysis_usage');
    for (let index = 0; index < 3; index++)
      expect((await provisioner().provision(proof, work)).state).toBe(
        'replayed',
      );
    expect(rows('support_analysis_usage')).toEqual(usage);
    expect((await billingState(workspace())).used).toBe(1);
  });
  it('Automation standalone projects a reserved-prefix cache and still requires active Gestion', async () => {
    const prepared = await prepare('automation'),
      { proof, work } = await claimed(prepared);
    await provisioner().provision(proof, work);
    expect((await prepaidAutomationAccess(organization))?.contractId).toBe(
      prepared.contract.contractId,
    );
    await requireAutomationEntitlement({
      organizationId: organization,
      userId: owner,
      role: 'owner',
      founder: false,
    });
    db.prepare(
      'UPDATE subscriptions SET entitlement_valid_until=0 WHERE subscription_id=?',
    ).run(previousSubscriptionId);
    await expect(
      requireAutomationEntitlement({
        organizationId: organization,
        userId: owner,
        role: 'owner',
        founder: false,
      }),
    ).rejects.toMatchObject({ status: 402 });
  });
  it.each([
    'owner-revoked',
    'company-moved',
    'workspace-owner-changed',
    'link-conflict',
    'refund-first',
    'lease-expired',
    'period-expired',
    'TEST',
  ])(
    'refuses %s with no partial proof, subscription or footprint release',
    async (mode) => {
      const prepared = await prepare(
          'complet:team',
          mode === 'TEST' ? 'TEST' : 'PRODUCTION',
        ),
        { proof, work } = await claimed(prepared);
      if (mode === 'owner-revoked')
        db.prepare(
          'UPDATE organization_members SET revoked_at=? WHERE user_id=?',
        ).run(clock, owner);
      if (mode === 'company-moved') {
        db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
        VALUES('trial_replacement','replacement','local','canceled',0,?)`).run(
          clock,
        );
        db.prepare(
          'UPDATE organizations SET subscription_id=? WHERE organization_id=?',
        ).run('trial_replacement', organization);
      }
      if (mode === 'workspace-owner-changed')
        db.prepare('UPDATE support_workspaces SET owner_id=? WHERE id=?').run(
          'other-owner',
          workspaceId,
        );
      if (mode === 'link-conflict') {
        db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
        VALUES('trial_other','other','local','canceled',0,?)`).run(clock);
        db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(
          'company-other',
          'Autre',
          'trial_other',
          owner,
          clock,
          clock,
        );
        db.prepare(
          'INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,?)',
        ).run(workspaceId, 'company-other', owner, clock);
      }
      if (mode === 'refund-first')
        await new D1PrepaidReconciliationStore(
          d1(),
          () => clock,
        ).recordReversal(
          (await new D1PrepaidReconciliationStore(d1(), () => clock).target(
            apiOrigin,
            405,
            71,
          ))!,
          'b'.repeat(64),
          work,
        );
      if (mode === 'lease-expired') setTime(work.leaseUntil);
      if (mode === 'period-expired') setTime(prepared.period.endsAt);
      await expect(provisioner().provision(proof, work)).rejects.toThrow();
      expect(count('prepaid_settlement_proofs')).toBe(0);
      expect(count('prepaid_purchase_projections')).toBe(0);
      expect(
        db.prepare('SELECT state FROM purchase_intents').get()?.state,
      ).toBe('dispatched');
      expect(
        rows('purchase_intent_footprints').every(
          (row) => row.released_at === null,
        ),
      ).toBe(true);
      expect(await prepaidCompanyAccess(organization)).toBeNull();
      expect(await prepaidSupportAccess(workspaceId)).toBeNull();
    },
  );
  it.each(['owner-revoked', 'refund-first'])(
    'the atomic batch fence catches a late %s after the initial reads',
    async (mode) => {
      const prepared = await prepare(),
        { proof, work } = await claimed(prepared);
      beforeBatch = () =>
        mode === 'owner-revoked'
          ? db
              .prepare(
                'UPDATE organization_members SET revoked_at=? WHERE user_id=?',
              )
              .run(clock, owner)
          : db
              .prepare(
                'INSERT INTO prepaid_provider_reversals(period_id,evidence_fingerprint,reversed_at) VALUES(?,?,?)',
              )
              .run(proof.periodId, 'b'.repeat(64), clock);
      await expect(provisioner().provision(proof, work)).rejects.toMatchObject({
        code: 'unavailable',
      });
      assertNoHandoff();
      if (mode === 'refund-first')
        expect(count('prepaid_provider_reversals')).toBe(1);
    },
  );
  it('an interrupted final closure rolls back the proof, caches, links, trial conversion and released slots', async () => {
    const prepared = await prepare(),
      { proof, work } = await claimed(prepared),
      preserved = preservedSnapshot();
    interrupt = 'UPDATE prepaid_purchase_projections SET closed_at';
    await expect(provisioner().provision(proof, work)).rejects.toMatchObject({
      code: 'unavailable',
    });
    assertNoHandoff();
    expect(preservedSnapshot()).toEqual(preserved);
    expect(count('support_gestion_links')).toBe(0);
    expect(rows('license_activations')[0]?.subscription_id).toBe(
      previousSubscriptionId,
    );
    expect(rows('account_trials')[0]?.converted_subscription_id).toBeNull();
    await provisioner().provision(proof, work);
    expect((await prepaidCompanyAccess(organization))?.contractId).toBe(
      prepared.contract.contractId,
    );
  });
  it('an eventual canceled renewal does not discard the first period that was actually paid', async () => {
    const prepared = await prepare(),
      { proof, work } = await claimed(prepared);
    await new D1PrepaidPeriods(d1(), () => clock).cancelRenewal(
      prepared.contract.contractId,
    );
    await provisioner().provision(proof, work);
    expect(await prepaidCompanyAccess(organization)).toMatchObject({
      cancelAtPeriodEnd: true,
      paidUntil: prepared.period.endsAt,
    });
  });
  it('a provider-confirmed canceled first purchase cannot be turned into a paid handoff later', async () => {
    const prepared = await prepare(),
      { proof, work } = await claimed(prepared);
    await new D1PurchaseIntents(d1(), () => clock).finalize(prepared.intent, {
      providerReference: '71',
      outcome: 'canceled',
      evidenceFingerprint: 'c'.repeat(64),
    });
    await expect(provisioner().provision(proof, work)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(count('prepaid_settlement_proofs')).toBe(0);
    expect(count('prepaid_purchase_projections')).toBe(0);
    expect(rows('purchase_intents')[0]?.state).toBe('canceled');
    expect(
      db.prepare('SELECT subscription_id FROM organizations').get()
        ?.subscription_id,
    ).toBe(previousSubscriptionId);
  });
  it('concurrent workers cannot duplicate handoffs; negative evidence prevents any later re-grant', async () => {
    const prepared = await prepare(),
      { proof, work } = await claimed(prepared);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => provisioner().provision(proof, work)),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(count('prepaid_purchase_projections')).toBe(1);
    expect(count('prepaid_settlement_proofs')).toBe(1);
    await new D1PrepaidReconciliationStore(d1(), () => clock).recordReversal(
      (await new D1PrepaidReconciliationStore(d1(), () => clock).target(
        apiOrigin,
        405,
        71,
      ))!,
      'b'.repeat(64),
      work,
    );
    const before = queries.length;
    expect((await provisioner().provision(proof, work)).state).toBe('replayed');
    expect(
      queries.slice(before).every((query) => query.startsWith('SELECT')),
    ).toBe(true);
    expect(await prepaidCompanyAccess(organization)).toBeNull();
    expect(await prepaidSupportAccess(workspaceId)).toBeNull();
    expect(await prepaidAutomationAccess(organization)).toBeNull();
    expect(rows('account_trials')[0]?.converted_subscription_id).toBe(
      prepared.contract.contractId,
    );
  });
  it('closed handoff rejects a different invoice ID without changing stored rights', async () => {
    const prepared = await prepare(),
      { proof, work } = await claimed(prepared);
    await provisioner().provision(proof, work);
    const projectionsBefore = rows('prepaid_purchase_projections');
    const proofsBefore = rows('prepaid_settlement_proofs');
    queries = [];
    await expect(
      provisioner().provision(
        { ...proof, invoiceId: proof.invoiceId + 1 },
        work,
      ),
    ).rejects.toThrow('state');
    expect(queries.every((query) => query.startsWith('SELECT'))).toBe(true);
    expect(rows('prepaid_purchase_projections')).toEqual(projectionsBefore);
    expect(rows('prepaid_settlement_proofs')).toEqual(proofsBefore);
  });
});
