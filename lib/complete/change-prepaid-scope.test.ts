import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
const state = vi.hoisted(() => ({
  db: null as unknown,
  subscriptions: vi.fn(),
  update: vi.fn(),
  createSchedule: vi.fn(),
  getSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  prices: vi.fn(),
  product: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY' ? 'sk_live_fixture' : '',
}));
vi.mock('@/lib/automation/billing', () => ({
  automationStripe: () => ({
    subscriptions: { retrieve: state.subscriptions, update: state.update },
    subscriptionSchedules: {
      create: state.createSchedule,
      retrieve: state.getSchedule,
      update: state.updateSchedule,
    },
    prices: { list: state.prices },
    products: { retrieve: state.product },
  }),
  fullyRefundedAutomationInvoice: vi.fn(),
}));
import { completePlan } from './plans';
import {
  quotePlanChange,
  changePlan,
  resumePlanChange,
  pendingPlanChange,
} from './change';
import { assertNoPrepaidAccountPurchase } from '@/lib/payments/prepaid-checkout-guard';
import { D1PrepaidPeriods } from '@/lib/payments/prepaid-periods';
import {
  D1PurchaseIntents,
  type PurchaseInput,
} from '@/lib/payments/purchase-intents';
let db: DatabaseSync, clock: number, subscription: Stripe.Subscription;
const owner = 'synthetic-owner',
  company = 'company-b',
  workspace = 'workspace-b';
function companyFixture(id: string, who = owner, paid = false) {
  const sub = 'sub_' + id;
  db.prepare(
    `INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,last_paid_invoice_id,entitlement_plan_id,seat_limit) VALUES(?,?,?,'active',?,1,?,?,?,?,3)`,
  ).run(
    sub,
    'cus_' + id,
    'price_' + id,
    clock + 30 * 86400,
    clock,
    paid ? clock + 30 * 86400 : 0,
    paid ? 'in_' + id : null,
    'chf_69_monthly',
  );
  db.prepare(
    `INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,'Fictional SME',?,?,?,?)`,
  ).run(id, sub, who, clock, clock);
  db.prepare(
    `INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,'owner@example.test','owner',?)`,
  ).run('member_' + id, id, who, clock);
}
function adapter() {
  function prepare(query: string) {
    let values: SQLInputValue[] = [];
    const p = {
      bind(...v: SQLInputValue[]) {
        values = v;
        return p;
      },
      async first() {
        return db.prepare(query).get(...values) ?? null;
      },
      async all() {
        return { results: db.prepare(query).all(...values) };
      },
      async run() {
        return { success: true, meta: db.prepare(query).run(...values) };
      },
    };
    return p;
  }
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = [];
        for (const s of statements) r.push(await s.run());
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
async function prepaid(
  org: string,
  ws: string | null = null,
  productKey = 'gestion:start',
) {
  return new D1PrepaidPeriods(adapter(), () => clock).createContract({
    contractId: 'pfp_' + crypto.randomUUID(),
    ownerId: owner,
    organizationId: org,
    workspaceId: ws,
    apiOrigin: 'https://checkout.postfinance.ch',
    spaceId: 405,
    environment: 'PRODUCTION',
    productKey,
  });
}
async function staged() {
  const q = await quotePlanChange(owner, company, 'pro');
  db.prepare(
    `INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,'scope-operation',?,?,'pro',?,'preparing',?,?,?)`,
  ).run(
    company,
    owner,
    subscription.id,
    q.effectiveAt,
    JSON.stringify(q.snapshot),
    clock,
    clock,
  );
  return (await pendingPlanChange(company))!;
}
function noPost() {
  expect(state.update).not.toHaveBeenCalled();
  expect(state.createSchedule).not.toHaveBeenCalled();
  expect(state.updateSchedule).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  clock = Math.floor(Date.now() / 1000);
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  state.db = adapter();
  companyFixture(company, owner, true);
  companyFixture('company-a');
  db.prepare(
    `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,'Fictional Support',?,?)`,
  ).run(workspace, owner, clock, clock);
  db.prepare(
    `INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,?)`,
  ).run(workspace, company, owner, clock);
  subscription = {
    id: 'sub_' + company,
    customer: 'cus_' + company,
    status: 'active',
    livemode: true,
    metadata: {},
    automatic_tax: { enabled: true },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: clock - 60,
          current_period_end: clock + 30 * 86400,
          price: {
            id: 'price_' + company,
            currency: 'chf',
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
  state.subscriptions.mockImplementation(async () => subscription);
  const plan = completePlan('pro')!;
  state.prices.mockResolvedValue({
    data: [
      {
        id: 'price_bundle_pro',
        active: true,
        livemode: true,
        product: plan.productId,
        lookup_key: plan.lookupKey,
        currency: 'chf',
        unit_amount: plan.priceChfCents,
        recurring: {
          interval: 'month',
          interval_count: 1,
          usage_type: 'licensed',
        },
        tax_behavior: 'inclusive',
        metadata: { service: 'zentra-complet', bundle_plan: 'pro' },
      },
    ],
  });
  state.product.mockResolvedValue({
    id: plan.productId,
    active: true,
    tax_code: 'txcd_fixture',
  });
  let schedule: {
    id: string;
    subscription: string;
    created: number;
    status: string;
    metadata: Record<string, string>;
    phases: Stripe.SubscriptionScheduleUpdateParams.Phase[];
  } | null = null;
  state.createSchedule.mockImplementation(async () => {
    schedule ??= {
      id: 'sub_sched_scoped',
      subscription: subscription.id,
      created: clock,
      status: 'active',
      metadata: {},
      phases: [],
    };
    subscription.schedule = schedule.id;
    return schedule;
  });
  state.getSchedule.mockImplementation(async () => schedule);
  state.updateSchedule.mockImplementation(async (_id, params) => {
    schedule = { ...schedule!, ...params };
    return schedule;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('External network is forbidden in financial tests');
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});
describe('company-scoped pack changes preserve cross-provider isolation', () => {
  it('allows Stripe company B with a linked Support target while an unrelated company A has a pending PF contract', async () => {
    await prepaid('company-a');
    await expect(assertNoPrepaidAccountPurchase(owner)).rejects.toMatchObject({
      status: 409,
    });
    const q = await quotePlanChange(owner, company, 'pro');
    expect(q.snapshot.workspaceId).toBe(workspace);
    expect(q.snapshot.workspaceLinked).toBe(true);
    noPost();
    await expect(
      changePlan(owner, company, 'pro', q.fingerprint),
    ).resolves.toMatchObject({ state: 'scheduled' });
    expect(state.createSchedule).toHaveBeenCalledTimes(1);
    expect(state.updateSchedule).toHaveBeenCalledTimes(1);
    expect((await pendingPlanChange(company))?.state).toBe('scheduled');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(['company', 'workspace'] as const)(
    'refuses a pending PF contract on the same %s before touching Stripe',
    async (scope) => {
      await prepaid(
        scope === 'company' ? company : 'company-a',
        scope === 'workspace' ? workspace : null,
        scope === 'workspace' ? 'support:team' : 'gestion:start',
      );
      await expect(
        quotePlanChange(owner, company, 'pro'),
      ).rejects.toMatchObject({ status: 409 });
      expect(state.subscriptions).not.toHaveBeenCalled();
      noPost();
    },
  );
  it('keeps the legacy global fence when the Support workspace is not yet linked', async () => {
    db.prepare('DELETE FROM support_gestion_links').run();
    await prepaid('company-a');
    await expect(quotePlanChange(owner, company, 'pro')).rejects.toMatchObject({
      status: 409,
    });
    noPost();
  });
  it('refuses an uncertain common purchase on the same company, even with no projected PF subscription', async () => {
    const input: PurchaseInput = {
      ownerId: owner,
      environment: 'PRODUCTION',
      provider: 'postfinance',
      providerScope: 'https://checkout.postfinance.ch|405',
      product: 'automation',
      organizationId: company,
      workspaceId: null,
      planId: null,
      parameters: { requestKey: 'synthetic' },
      terms: {
        version: 'synthetic',
        consentVersion: null,
        origin: 'https://zentra.example.test',
      },
    };
    const store = new D1PurchaseIntents(adapter(), () => clock),
      intent = await store.reserve(input),
      binding = intent;
    await store.markDispatched(binding);
    await store.markUncertain(binding);
    await expect(quotePlanChange(owner, company, 'pro')).rejects.toMatchObject({
      status: 409,
    });
    noPost();
  });
  it.each([
    'owner',
    'deleted',
    'company-link',
    'workspace-link',
    'customer',
    'base',
    'pf-contract',
    'refund',
    'invoice',
    'paid-until',
    'mode',
    'effective-at',
    'created-at',
    'plan',
  ] as const)(
    'refuses %s drift occurring during the final subscription GET before a POST',
    async (drift) => {
      const row = await staged();
      let changed = false;
      state.subscriptions.mockImplementation(async () => {
        if (!changed) {
          changed = true;
          if (drift === 'owner')
            db.prepare(
              'UPDATE organization_members SET revoked_at=? WHERE organization_id=?',
            ).run(clock, company);
          if (drift === 'deleted')
            db.prepare(
              'INSERT INTO account_session_policy(user_id,deleted_at) VALUES(?,?)',
            ).run(owner, clock);
          if (drift === 'company-link')
            db.prepare(
              'UPDATE support_gestion_links SET organization_id=? WHERE workspace_id=?',
            ).run('company-a', workspace);
          if (drift === 'workspace-link') {
            db.prepare(
              `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('foreign-workspace','foreign-owner','Other',?,?)`,
            ).run(clock, clock);
            db.prepare(
              "UPDATE support_gestion_links SET workspace_id='foreign-workspace' WHERE organization_id=?",
            ).run(company);
          }
          if (drift === 'customer')
            db.prepare(
              "UPDATE subscriptions SET customer_id='cus_changed' WHERE subscription_id=?",
            ).run(subscription.id);
          if (drift === 'base') {
            db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,last_paid_invoice_id,entitlement_plan_id,seat_limit)
              SELECT 'sub_replaced',customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,last_paid_invoice_id,entitlement_plan_id,seat_limit FROM subscriptions WHERE subscription_id=?`).run(
              subscription.id,
            );
            db.prepare(
              "UPDATE organizations SET subscription_id='sub_replaced' WHERE organization_id=?",
            ).run(company);
          }
          if (drift === 'pf-contract') await prepaid(company);
          if (drift === 'refund') {
            db.prepare(
              'INSERT INTO complete_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,1,?)',
            ).run('in_' + company, 'cus_' + company, clock);
            db.prepare(
              'UPDATE subscriptions SET entitlement_valid_until=0 WHERE subscription_id=?',
            ).run(subscription.id);
          }
          if (drift === 'invoice')
            db.prepare(
              "UPDATE subscriptions SET last_paid_invoice_id='in_other' WHERE subscription_id=?",
            ).run(subscription.id);
          if (drift === 'paid-until')
            db.prepare(
              'UPDATE subscriptions SET entitlement_valid_until=entitlement_valid_until+1 WHERE subscription_id=?',
            ).run(subscription.id);
          if (drift === 'mode')
            db.prepare(
              'UPDATE subscriptions SET livemode=0 WHERE subscription_id=?',
            ).run(subscription.id);
          if (drift === 'effective-at')
            db.prepare(
              'UPDATE complete_plan_changes SET effective_at=effective_at+1 WHERE organization_id=?',
            ).run(company);
          if (drift === 'created-at')
            db.prepare(
              'UPDATE complete_plan_changes SET created_at=created_at+1 WHERE organization_id=?',
            ).run(company);
          if (drift === 'plan')
            db.prepare(
              "UPDATE subscriptions SET entitlement_plan_id='other-plan' WHERE subscription_id=?",
            ).run(subscription.id);
        }
        return subscription;
      });
      await expect(resumePlanChange(row)).rejects.toMatchObject({
        status: drift === 'owner' || drift === 'deleted' ? 403 : 409,
      });
      noPost();
    },
  );
  it('refuses another current plan-change operation without posting or overwriting it', async () => {
    const row = await staged();
    db.prepare(
      "UPDATE complete_plan_changes SET operation_id='other-operation' WHERE organization_id=?",
    ).run(company);
    await expect(resumePlanChange(row)).rejects.toMatchObject({ status: 409 });
    noPost();
    await expect(
      changePlan(owner, company, 'solo', 'unused'),
    ).rejects.toMatchObject({ status: 409 });
    noPost();
  });
  it('refuses a disappeared workspace captured by a new quote without selecting or creating a replacement', async () => {
    const row = await staged();
    db.prepare('DELETE FROM support_gestion_links WHERE workspace_id=?').run(
      workspace,
    );
    db.prepare('DELETE FROM support_workspaces WHERE id=?').run(workspace);
    await expect(resumePlanChange(row)).rejects.toMatchObject({ status: 409 });
    noPost();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM support_workspaces').get()!.n,
    ).toBe(0);
  });
  it('keeps a legacy persisted snapshot conservative rather than selecting a new provider scope', async () => {
    const row = await staged(),
      snapshot = JSON.parse(row.source_json);
    delete snapshot.workspaceId;
    delete snapshot.workspaceLinked;
    db.prepare(
      'UPDATE complete_plan_changes SET source_json=? WHERE organization_id=?',
    ).run(JSON.stringify(snapshot), company);
    const legacy = (await pendingPlanChange(company))!;
    await prepaid('company-a');
    await expect(resumePlanChange(legacy)).rejects.toMatchObject({
      status: 409,
    });
    noPost();
  });
  it('atomically refuses a competing standalone Support purchase during a provider GET while the legitimate pack change continues', async () => {
    db.prepare('DELETE FROM support_gestion_links').run();
    const row = await staged();
    let changed = false;
    state.subscriptions.mockImplementation(async () => {
      if (!changed) {
        changed = true;
        const store = new D1PurchaseIntents(adapter(), () => clock);
        await expect(
          store.reserve({
            ownerId: owner,
            environment: 'PRODUCTION',
            provider: 'stripe',
            providerScope: 'acct_synthetic',
            product: 'support',
            organizationId: null,
            workspaceId: workspace,
            planId: 'team',
            parameters: { requestKey: 'new-standalone-support' },
            terms: {
              version: 'synthetic',
              consentVersion: null,
              origin: 'https://zentra.example.test',
            },
          }),
        ).rejects.toMatchObject({ code: 'conflict' });
      }
      return subscription;
    });
    await expect(resumePlanChange(row)).resolves.toMatchObject({
      state: 'scheduled',
    });
    expect(state.createSchedule).toHaveBeenCalledTimes(1);
    expect(state.updateSchedule).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM purchase_intents WHERE product='support'",
        )
        .get()!.n,
    ).toBe(0);
  });
  it('rechecks ownership after the schedule GET immediately before updating its phases', async () => {
    const row = await staged(),
      get = state.getSchedule.getMockImplementation()!;
    state.getSchedule.mockImplementation(async (...args: unknown[]) => {
      const result = await get(...args);
      db.prepare(
        'UPDATE organization_members SET revoked_at=? WHERE organization_id=?',
      ).run(clock, company);
      return result;
    });
    await expect(resumePlanChange(row)).rejects.toMatchObject({ status: 403 });
    expect(state.createSchedule).toHaveBeenCalledTimes(1);
    expect(state.updateSchedule).not.toHaveBeenCalled();
  });
  it.each(['deleted', 'revoked'] as const)(
    'does not repair or create a local Support link on a scheduled operation after the owner is %s',
    async (reason) => {
      const row = await staged();
      await resumePlanChange(row);
      const scheduled = (await pendingPlanChange(company))!;
      db.prepare('DELETE FROM support_gestion_links WHERE workspace_id=?').run(
        workspace,
      );
      db.prepare('DELETE FROM support_workspaces WHERE id=?').run(workspace);
      if (reason === 'deleted')
        db.prepare(
          'INSERT INTO account_session_policy(user_id,deleted_at) VALUES(?,?)',
        ).run(owner, clock);
      else
        db.prepare(
          'UPDATE organization_members SET revoked_at=? WHERE organization_id=?',
        ).run(clock, company);
      state.createSchedule.mockClear();
      state.updateSchedule.mockClear();
      state.update.mockClear();
      await expect(resumePlanChange(scheduled)).rejects.toMatchObject({
        status: 403,
      });
      noPost();
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM support_workspaces').get()!.n,
      ).toBe(0);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM support_gestion_links').get()!.n,
      ).toBe(0);
    },
  );
  it.each(['support', 'automation'] as const)(
    'refuses a newly paid %s source after its pending payment has already closed during a provider GET',
    async (kind) => {
      const row = await staged();
      let changed = false;
      state.subscriptions.mockImplementation(async () => {
        if (!changed) {
          changed = true;
          if (kind === 'support')
            db.prepare(
              `INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,livemode,updated_at) VALUES(?,'sub_new_support','cus_new_support','team','team','active',?,?,'in_new_support',1,?)`,
            ).run(workspace, clock - 60, clock + 31 * 86400, clock);
          else
            db.prepare(
              `INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,livemode,updated_at) VALUES(?,'sub_new_automation','cus_new_automation','active',?,?,'in_new_automation',1,?)`,
            ).run(company, clock - 60, clock + 31 * 86400, clock);
        }
        return subscription;
      });
      await expect(resumePlanChange(row)).rejects.toMatchObject({
        status: 409,
      });
      noPost();
    },
  );
  it.each(['support', 'automation'] as const)(
    'refuses a %s refund received during its provider GET before canceling any renewal',
    async (kind) => {
      const id = 'sub_addon_' + kind,
        invoice = 'in_addon_' + kind,
        customer = 'cus_addon_' + kind,
        until = clock + 31 * 86400;
      if (kind === 'support')
        db.prepare(
          `INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,livemode,updated_at) VALUES(?,?,?,'team','team','active',?,?,?,1,?)`,
        ).run(workspace, id, customer, clock - 60, until, invoice, clock);
      else
        db.prepare(
          `INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,livemode,updated_at) VALUES(?,?,?,'active',?,?,?,1,?)`,
        ).run(company, id, customer, clock - 60, until, invoice, clock);
      const addon = {
        ...subscription,
        id,
        customer,
        items: {
          data: [
            {
              ...subscription.items.data[0],
              current_period_end: until,
              price: {
                ...subscription.items.data[0].price,
                id: 'price_addon_' + kind,
              },
            },
          ],
        },
      } as Stripe.Subscription;
      state.subscriptions.mockImplementation(async (subId: string) =>
        subId === id ? addon : subscription,
      );
      const row = await staged();
      let changed = false;
      state.subscriptions.mockImplementation(async (subId: string) => {
        if (subId === id && !changed) {
          changed = true;
          db.prepare(
            `INSERT INTO ${kind === 'support' ? 'support_refunds' : 'automation_refunds'}(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,1,?)`,
          ).run(invoice, customer, clock);
        }
        return subId === id ? addon : subscription;
      });
      await expect(resumePlanChange(row)).rejects.toMatchObject({
        status: 409,
      });
      noPost();
    },
  );
  it('rechecks target authority on lost-response replay before issuing the same idempotent schedule create', async () => {
    const row = await staged(),
      create = state.createSchedule.getMockImplementation()!;
    state.createSchedule.mockImplementationOnce(async (...args: unknown[]) => {
      await create(...args);
      throw new Error('synthetic lost response');
    });
    await expect(resumePlanChange(row)).rejects.toThrow(
      'synthetic lost response',
    );
    expect(state.createSchedule).toHaveBeenCalledTimes(1);
    db.prepare(
      'UPDATE support_gestion_links SET organization_id=? WHERE workspace_id=?',
    ).run('company-a', workspace);
    await expect(
      resumePlanChange((await pendingPlanChange(company))!),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.createSchedule).toHaveBeenCalledTimes(1);
    expect(state.updateSchedule).not.toHaveBeenCalled();
    db.prepare(
      'UPDATE support_gestion_links SET organization_id=? WHERE workspace_id=?',
    ).run(company, workspace);
    await expect(
      resumePlanChange((await pendingPlanChange(company))!),
    ).resolves.toMatchObject({ state: 'scheduled' });
    expect(state.createSchedule).toHaveBeenCalledTimes(2);
    expect(state.createSchedule.mock.calls[0][1]).toEqual(
      state.createSchedule.mock.calls[1][1],
    );
    expect(state.updateSchedule).toHaveBeenCalledTimes(1);
  });
});
