import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { ZentraUser } from '@/app/zentra-auth';
import type { Workspace } from '@/lib/support/types';
import type { AutomationActor } from '@/lib/automation/access';

const fixture = vi.hoisted(() => ({
  database: null as unknown,
  stripeCalls: vi.fn(),
  stripeKey: 'sk_live_fixture',
}));
vi.mock('@/lib/runtime', () => ({
  database: () => fixture.database,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY'
      ? fixture.stripeKey
      : key === 'PUBLIC_SITE_URL'
        ? 'https://zentra.example.test'
        : '',
  stripeConfiguration: () => ({
    secretKey: fixture.stripeKey,
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      fixture.stripeCalls('constructor');
      throw new Error('A prepaid product must never call Stripe.');
    }
    static createFetchHttpClient() {
      fixture.stripeCalls('http');
      throw new Error(
        'A prepaid product must never create a Stripe HTTP client.',
      );
    }
  },
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));

import { D1PrepaidPeriods, type PrepaidContractInput } from './prepaid-periods';
import { prepaidCompanyAccess } from './prepaid-access';
import { teamSeats, requireMemberSeat } from '@/lib/team-seats';
import {
  completeAccess,
  completeSupportSubscription,
} from '@/lib/complete/access';
import {
  billingState,
  requireSupportSubscription,
  reserveAnalysis,
  finishAnalysis,
  createSupportPortal,
} from '@/lib/support/billing';
import {
  automationEntitlement,
  requireAutomationEntitlement,
} from '@/lib/automation/entitlement';
import {
  automationBillingState,
  automationPortal,
  createAutomationCheckout,
  refreshAutomationPayment,
} from '@/lib/automation/billing';
import { subscriptionJourney } from '@/lib/complete/journey';
import { completePortal } from '@/lib/complete/stripe';
import { createPortalSession } from '@/lib/stripe';
import { completeCheckout } from '@/lib/complete/checkout';
import { completePlan } from '@/lib/complete/plans';
import { quotePlanChange } from '@/lib/complete/change';
import { assertNoPrepaidAccountPurchase } from './prepaid-checkout-guard';

let db: DatabaseSync, clock: number;
let network: ReturnType<typeof vi.spyOn>;
const anchor = Date.parse('2026-10-06T10:11:12Z') / 1000;
const owner = 'owner-fixture';
const contractId = 'pfp_11111111-1111-4111-8111-111111111111';
const optionId = 'pfp_22222222-2222-4222-8222-222222222222';
const actor: AutomationActor = {
  organizationId: 'company-fixture',
  userId: owner,
  role: 'owner',
  founder: false,
};
const user: ZentraUser = {
  userId: owner,
  displayName: 'Propriétaire fictif',
  fullName: 'Propriétaire fictif',
  email: 'owner@example.test',
  provider: 'supabase',
  emailConfirmed: true,
};
const workspace: Workspace = {
  id: 'support-fixture',
  owner_id: owner,
  name: 'Entreprise fictive',
  triage_context: '',
  mode: 'review',
  threshold: 85,
  baseline_seconds: 60,
  ai_secret: null,
  created_at: anchor,
  updated_at: anchor,
};
function setNow(time: number) {
  clock = time;
  vi.setSystemTime(new Date(time * 1000));
}
function d1() {
  const database = {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async first() {
          return db.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { success: true, results: db.prepare(query).all(...values) };
        },
        async run() {
          return { success: true, meta: db.prepare(query).run(...values) };
        },
      };
      return statement;
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return database as unknown as D1Database;
}
function store() {
  return new D1PrepaidPeriods(d1(), () => clock);
}
function member(id: string, role = 'member', offset = 1) {
  db.prepare(
    `INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,'company-fixture',?,?,?,?)`,
  ).run(`member-${id}`, id, `${id}@example.test`, role, clock + offset);
}
async function recordPayment(
  productKey = 'complet:team',
  id = contractId,
  environment: 'TEST' | 'PRODUCTION' = 'PRODUCTION',
) {
  const input: PrepaidContractInput = {
    contractId: id,
    ownerId: owner,
    organizationId: 'company-fixture',
    workspaceId: productKey.startsWith('complet:') ? workspace.id : null,
    apiOrigin: 'https://checkout.postfinance.ch',
    spaceId: 405,
    environment,
    productKey,
  };
  await store().createContract(input);
  const period = await store().reservePeriod(id, 0);
  const transactionId = id === contractId ? 71 : 72;
  await store().bindTransaction(period.periodId, transactionId);
  await store().recordReconciledSettlement({
    periodId: period.periodId,
    transactionId,
    invoiceId: transactionId + 10,
    apiOrigin: input.apiOrigin,
    spaceId: input.spaceId,
    environment,
    ownerId: owner,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    currency: 'CHF',
    priceChfMinor: period.priceChfMinor,
    catalogVersion: period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  });
  return period;
}
function productProjection(id = contractId) {
  // Intentionally untrustworthy old caches: ten seats, expired Gestion, a
  // different pack/quota and large later dates. Only the proof is authoritative.
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_name,price_id,status,current_period_end,entitlement_plan_id,seat_limit,entitlement_valid_until,last_paid_invoice_id,livemode,updated_at)
    VALUES(?,?,'Ancien nom','stale-price','active',0,'zentra-pro-monthly-89-chf',10,0,'cached-invoice',1,?)`).run(
    id,
    id,
    clock,
  );
  db.prepare(
    `INSERT INTO organizations VALUES('company-fixture','Entreprise fictive',?,?,?,?)`,
  ).run(id, owner, clock, clock);
  member(owner, 'owner', 0);
  db.prepare(
    `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?, ?,?)`,
  ).run(workspace.id, owner, workspace.name, clock, clock);
  db.prepare(
    `INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,'company-fixture',1,0,?,?)`,
  ).run(workspace.id, owner, clock);
  db.prepare(
    `INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id) VALUES(?,'pro','pro',?,?, 'cached-bundle')`,
  ).run(id, clock, clock + 999999);
  db.prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
    VALUES(?,?,?,'business','business','active',?,?,'cached-support',0,1,?)`).run(
    workspace.id,
    id,
    id,
    clock,
    clock + 999999,
    clock,
  );
  db.prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
    VALUES('company-fixture',?,?,'active',?,?,'cached-automation',0,1,?)`).run(
    id,
    id,
    clock,
    clock + 999999,
    clock,
  );
}
async function company(environment: 'TEST' | 'PRODUCTION' = 'PRODUCTION') {
  const period = await recordPayment('complet:team', contractId, environment);
  productProjection();
  return period;
}

beforeEach(() => {
  vi.useFakeTimers();
  setNow(anchor);
  fixture.stripeKey = 'sk_live_fixture';
  fixture.stripeCalls.mockClear();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    db.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  }
  fixture.database = d1();
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error(
      'No merchant/network call is permitted by this local integration test.',
    );
  });
});
afterEach(() => {
  const stripeCalls = fixture.stripeCalls.mock.calls.length;
  const networkCalls = network.mock.calls.length;
  network.mockRestore();
  db.close();
  vi.useRealTimers();
  expect(stripeCalls).toBe(0);
  expect(networkCalls).toBe(0);
});

describe('prepaid production proof propagates into all product consumers (no merchant calls)', () => {
  it('unlocks the exact Complet Team seats, quota, Automation and shared subscription overview without trusting stale caches', async () => {
    const period = await company();
    member('colleague-a');
    member('colleague-b', 'accountant', 2);
    expect(await teamSeats(actor.organizationId)).toMatchObject({
      subscriptionActive: true,
      priceChfCents: 9900,
      limit: 3,
      used: 3,
      available: 0,
    });
    await expect(
      requireMemberSeat(actor.organizationId, owner),
    ).resolves.toBeUndefined();
    await expect(
      requireMemberSeat(actor.organizationId, 'colleague-a'),
    ).resolves.toBeUndefined();
    await expect(
      requireMemberSeat(actor.organizationId, 'not-a-member'),
    ).rejects.toMatchObject({ status: 403 });
    const bundle = await completeAccess(actor.organizationId);
    expect(bundle).toMatchObject({
      provider: 'postfinance',
      subscription_id: contractId,
      paid_plan_id: 'team',
      paid_from: period.startsAt,
      paid_until: period.endsAt,
    });
    expect(await completeSupportSubscription(workspace.id)).toEqual(bundle);
    expect(await billingState(workspace)).toMatchObject({
      active: true,
      ownerAccess: false,
      ready: true,
      plan: 'team',
      limit: 5000,
      used: 0,
      periodEnd: period.endsAt,
    });
    await expect(
      requireSupportSubscription(workspace),
    ).resolves.toBeUndefined();
    expect(await automationEntitlement(actor)).toBe(true);
    await expect(requireAutomationEntitlement(actor)).resolves.toMatchObject({
      userId: owner,
      role: 'owner',
    });
    expect(await automationBillingState(actor.organizationId)).toMatchObject({
      hasSubscription: true,
      priceChfCents: 0,
      periodEnd: period.endsAt,
    });
    const journey = await subscriptionJourney(actor);
    expect(journey).toMatchObject({
      monthlyChfCents: 9900,
      renewalAt: period.endsAt,
      seats: { limit: 3 },
      support: { active: true, limit: 5000, used: 0, remaining: 5000 },
      canChange: false,
      portalAvailable: false,
    });
    expect(journey.products.map((p) => [p.id, p.active, p.until])).toEqual([
      ['gestion', true, period.endsAt],
      ['support', true, period.endsAt],
      ['automation', true, period.endsAt],
    ]);
    expect(
      (await prepaidCompanyAccess(actor.organizationId))?.catalog.gestion
        ?.licensePriceChfMinor,
    ).toBe(5900);
  });

  it('uses the prepaid proof even when no Stripe merchant key is configured', async () => {
    const period = await company();
    fixture.stripeKey = '';
    expect((await teamSeats(actor.organizationId)).subscriptionActive).toBe(
      true,
    );
    expect((await completeAccess(actor.organizationId))?.paid_until).toBe(
      period.endsAt,
    );
    expect(await billingState(workspace)).toMatchObject({
      active: true,
      limit: 5000,
      ready: true,
    });
    await expect(
      requireSupportSubscription(workspace),
    ).resolves.toBeUndefined();
    expect(await automationEntitlement(actor)).toBe(true);
  });

  it('keeps consumption in one frozen paid period across repeated overview reads and enforces the exact quota', async () => {
    const period = await company();
    const lease = await reserveAnalysis(
      workspace,
      'ticket-first',
      'lease-first',
    );
    expect(lease).toBe('lease-first');
    await finishAnalysis(lease, true);
    for (let read = 0; read < 3; read++) {
      expect(await billingState(workspace)).toMatchObject({
        used: 1,
        limit: 5000,
        periodEnd: period.endsAt,
      });
      expect((await subscriptionJourney(actor)).support?.used).toBe(1);
    }
    db.prepare(`WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<4999)
      INSERT INTO support_analysis_usage(id,workspace_id,period_start,ticket_id,state,expires_at,created_at)
      SELECT 'seed-'||n,?,?,'seed-ticket-'||n,'charged',0,? FROM x`).run(
      workspace.id,
      period.startsAt,
      clock,
    );
    expect(await billingState(workspace)).toMatchObject({
      used: 5000,
      limit: 5000,
    });
    await expect(
      reserveAnalysis(workspace, 'ticket-over', 'lease-over'),
    ).rejects.toMatchObject({ status: 402 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM support_analysis_usage').get()?.n,
    ).toBe(5000);
  });

  it('preserves the paid period after cancellation and shows cancellation consistently across products', async () => {
    const period = await company();
    setNow(anchor + 5);
    await store().cancelRenewal(contractId);
    expect((await teamSeats(actor.organizationId)).subscriptionActive).toBe(
      true,
    );
    expect(await billingState(workspace)).toMatchObject({
      active: true,
      cancelAtPeriodEnd: true,
      periodEnd: period.endsAt,
    });
    expect(await automationBillingState(actor.organizationId)).toMatchObject({
      hasSubscription: true,
      cancelAtPeriodEnd: true,
    });
    expect(await subscriptionJourney(actor)).toMatchObject({
      status: 'cancelling',
      renewalAt: period.endsAt,
    });
  });

  it.each([
    'refund',
    'expired',
    'TEST',
    'owner-revoked',
    'wrong-company-binding',
  ])(
    'denies all products despite generous old caches when proof/scope is invalid: %s',
    async (mode) => {
      const period = await company(mode === 'TEST' ? 'TEST' : 'PRODUCTION');
      if (mode === 'refund')
        await store().revokeReconciledPeriod(period.periodId, 'b'.repeat(64));
      if (mode === 'expired') setNow(period.endsAt);
      if (mode === 'owner-revoked')
        db.prepare(
          'UPDATE organization_members SET revoked_at=? WHERE user_id=?',
        ).run(clock, owner);
      if (mode === 'wrong-company-binding') {
        db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_plan_id,seat_limit,entitlement_valid_until,livemode,updated_at)
        VALUES('pfp_BAD','pfp_BAD','bad','active',0,'zentra-pro-monthly-89-chf',10,0,1,?)`).run(
          clock,
        );
        db.prepare(`UPDATE organizations SET subscription_id='pfp_BAD'`).run();
      }
      expect((await teamSeats(actor.organizationId)).subscriptionActive).toBe(
        false,
      );
      await expect(
        requireMemberSeat(actor.organizationId, owner),
      ).rejects.toMatchObject({ status: 403 });
      expect(await completeAccess(actor.organizationId)).toBeNull();
      expect(await billingState(workspace)).toMatchObject({
        active: false,
        ownerAccess: false,
        limit: 0,
      });
      await expect(requireSupportSubscription(workspace)).rejects.toMatchObject(
        { status: 402 },
      );
      await expect(
        reserveAnalysis(workspace, 'denied-ticket', 'denied-lease'),
      ).rejects.toMatchObject({ status: 402 });
      expect(await automationEntitlement(actor)).toBe(false);
      await expect(requireAutomationEntitlement(actor)).rejects.toHaveProperty(
        'status',
      );
      expect(
        (await subscriptionJourney(actor)).products.every((p) => !p.active),
      ).toBe(true);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM support_analysis_usage').get()?.n,
      ).toBe(0);
    },
  );

  it('denies Automation when only the option is paid and no Gestion period is active', async () => {
    await recordPayment('automation', optionId);
    productProjection(optionId);
    expect((await teamSeats(actor.organizationId)).subscriptionActive).toBe(
      false,
    );
    expect(await completeAccess(actor.organizationId)).toBeNull();
    expect(await automationEntitlement(actor)).toBe(false);
    await expect(requireAutomationEntitlement(actor)).rejects.toMatchObject({
      status: 402,
    });
  });

  it('does not display a pack Automation grant when a contradictory paid option needs reconciliation', async () => {
    await company();
    await recordPayment('automation', optionId);
    expect(await automationEntitlement(actor)).toBe(false);
    expect(await automationBillingState(actor.organizationId)).toMatchObject({
      ready: false, status: 'verification_required', periodEnd: null,
    });
    expect((await subscriptionJourney(actor)).products.find(p => p.id === 'automation')?.active).toBe(false);
  });

  it('rejects every Stripe portal for a prepaid local identity before creating a Stripe client or making any network call', async () => {
    await company();
    await expect(
      createPortalSession(contractId, 'https://zentra.example.test/compte'),
    ).rejects.toHaveProperty('status');
    await expect(
      completePortal(contractId, 'https://zentra.example.test/compte'),
    ).rejects.toHaveProperty('status');
    await expect(createSupportPortal(workspace, user)).rejects.toHaveProperty(
      'status',
    );
    await expect(
      automationPortal(
        actor.organizationId,
        user,
        'https://zentra.example.test',
      ),
    ).rejects.toHaveProperty('status');
  });

  it.each([false, true])(
    'refuses a new Stripe pack, upgrade or Automation checkout on an existing PFP account, expired=%s',
    async (expired) => {
      const period = await company();
      fixture.stripeKey = ''; // Refusal must precede any merchant configuration.
      if (expired) setNow(period.endsAt);
      await expect(assertNoPrepaidAccountPurchase(owner)).rejects.toMatchObject(
        { status: 409 },
      );
      await expect(
        assertNoPrepaidAccountPurchase('different-account'),
      ).resolves.toBeUndefined();
      await expect(
        completeCheckout(
          user,
          completePlan('pro')!,
          'https://zentra.example.test',
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        quotePlanChange(owner, actor.organizationId, 'pro'),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        createAutomationCheckout(
          actor.organizationId,
          user,
          {},
          'https://zentra.example.test',
        ),
      ).rejects.toMatchObject({ status: expired ? 403 : 409 });
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM complete_checkouts').get()?.n,
      ).toBe(0);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM automation_checkouts').get()?.n,
      ).toBe(0);
    },
  );

  it('does not fall back to an obsolete Stripe checkout while refreshing an active PFP Automation account', async () => {
    const period = await company();
    db.prepare(`INSERT INTO automation_checkouts(organization_id,attempt_id,session_id,user_id,expires_at,created_at)
      VALUES('company-fixture','obsolete-attempt','cs_obsolete',?,?,?)`).run(
      owner,
      clock + 1000,
      clock,
    );
    const state = await refreshAutomationPayment(actor.organizationId, user);
    expect(state).toMatchObject({
      hasSubscription: true,
      periodEnd: period.endsAt,
      priceChfCents: 0,
    });
    expect(
      db.prepare('SELECT session_id FROM automation_checkouts').get()
        ?.session_id,
    ).toBe('cs_obsolete');
  });

  it('reserves a PRODUCTION purchase before any projection or merchant result, preventing a competing provider checkout', async () => {
    await store().createContract({
      contractId,
      ownerId: owner,
      organizationId: actor.organizationId,
      workspaceId: null,
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      environment: 'PRODUCTION',
      productKey: 'gestion:start',
    });
    await expect(assertNoPrepaidAccountPurchase(owner)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM prepaid_settlement_proofs').get()
        ?.n,
    ).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()?.n).toBe(
      0,
    );
  });

  it('does not expose a paid pack to a different-owner Support workspace through a stale link', async () => {
    await company();
    db.prepare(
      `UPDATE support_workspaces SET owner_id='foreign-owner' WHERE id=?`,
    ).run(workspace.id);
    const foreign = { ...workspace, owner_id: 'foreign-owner' };
    expect(await completeSupportSubscription(workspace.id)).toBeNull();
    expect(await billingState(foreign)).toMatchObject({
      active: false,
      limit: 0,
    });
    await expect(requireSupportSubscription(foreign)).rejects.toMatchObject({
      status: 402,
    });
  });
});
