import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const fixture = vi.hoisted(() => ({ database: null as unknown }));
vi.mock('@/lib/runtime', () => ({
  database: () => fixture.database,
  runtimeValue: (key: string) => key === 'STRIPE_SECRET_KEY' ? 'sk_live_fixture' : '',
}));
import { transitionAccess, transitionLicense } from './bridge';
import { automationEntitlement } from '@/lib/automation/entitlement';

let db: DatabaseSync;
const now = () => Math.floor(Date.now() / 1000);
const actor = { organizationId: 'org_customer', userId: 'customer', role: 'owner', founder: false };

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const migrations = new URL('../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  fixture.database = {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) { values = args; return statement; },
        async first() { return db.prepare(query).get(...values) ?? null; },
        async all() { return { success: true, results: db.prepare(query).all(...values) }; },
      };
      return statement;
    },
  };
  const end = now() + 14 * 86400;
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,entitlement_plan_id,seat_limit,last_paid_invoice_id,livemode,updated_at)
    VALUES('sub_gestion','cus_gestion','price_gestion','active',?,?,'zentra-start-monthly-59-chf',3,'in_gestion',1,?)`).run(end, end, now());
  db.prepare(`INSERT INTO organizations VALUES('org_customer','PME fictive','sub_gestion','customer',?,?)`).run(now(), now());
  db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('member_customer','org_customer','customer','customer@example.test','owner',?)`).run(now());
  db.prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
    VALUES('org_customer','sub_automation','cus_automation','active',?,?,'in_automation',1,1,?)`).run(now() - 86400, end + 86400, now());
  const source = {
    sources: [
      { id: 'sub_gestion', customer: 'cus_gestion', kind: 'gestion', until: end, invoice: 'in_gestion', price: 'price_gestion', start: now() - 86400, metadata: {}, automaticTax: false },
      { id: 'sub_automation', customer: 'cus_automation', kind: 'automation', until: end + 86400, invoice: 'in_automation', price: 'price_automation', start: now() - 86400, metadata: {}, automaticTax: false },
    ],
    primary: 'sub_gestion', oldSubscription: 'sub_gestion', gestionPlan: 'zentra-start-monthly-59-chf', seats: 3,
    supportPlan: null, supportFrom: 0, automation: true, effectiveAt: end + 86400, plan: 'pro', priceId: 'price_pack', live: true,
  };
  db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at)
    VALUES('org_customer','change_customer','customer','sub_gestion','pro',?,'scheduled',?,?,?)`).run(end + 86400, JSON.stringify(source), now(), now());
});
afterEach(() => db.close());

function refund(invoice = 'in_automation', customer = 'cus_automation', live = 1) {
  db.prepare('INSERT INTO automation_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,?,?)').run(invoice, customer, live, now());
}

it('preserves the bounded paid transition for an ordinary company', async () => {
  expect((await transitionAccess(actor.organizationId))?.automation).toBe(true);
  expect(await automationEntitlement(actor)).toBe(true);
});

it('a verified current add-on refund removes only Automation from the transition', async () => {
  const before = await transitionLicense('sub_gestion', actor.userId);
  refund();
  expect(await automationEntitlement(actor)).toBe(false);
  expect(await transitionAccess(actor.organizationId)).toMatchObject({ automation: false, seats: 3 });
  expect(await transitionLicense('sub_gestion', actor.userId)).toEqual(before);
});

it('the same current refund removes Automation outside a transition too', async () => {
  db.exec('DELETE FROM complete_plan_changes');
  refund();
  expect(await automationEntitlement(actor)).toBe(false);
});

it('keeps separately paid Support and Gestion when only the Automation add-on is refunded', async () => {
  const end = now() + 14 * 86400;
  db.prepare(`INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at)
    VALUES('support_customer','customer','Support fictif',?,?)`).run(now(), now());
  db.prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
    VALUES('support_customer','sub_support','cus_support','team','team','active',?,?,'in_support',1,1,?)`).run(now() - 86400, end, now());
  const row = db.prepare('SELECT source_json FROM complete_plan_changes').get()!;
  const source = JSON.parse(String(row.source_json));
  source.supportPlan = 'team';
  source.supportFrom = now() - 86400;
  source.sources.push({ id: 'sub_support', customer: 'cus_support', kind: 'support', until: end, invoice: 'in_support', price: 'price_support', start: now() - 86400, metadata: {}, automaticTax: false });
  db.prepare('UPDATE complete_plan_changes SET source_json=?').run(JSON.stringify(source));
  refund();
  expect(await transitionAccess(actor.organizationId)).toMatchObject({ automation: false, supportPlan: 'team', seats: 3 });
  expect(await transitionLicense('sub_gestion', actor.userId)).not.toBeNull();
});

it.each([
  ['in_previous', 'cus_automation', 1],
  ['in_automation', 'cus_another_customer', 1],
  ['in_automation', 'cus_automation', 0],
] as const)('does not apply an unrelated refund (%s, %s, mode %s)', async (invoice, customer, live) => {
  refund(invoice, customer, live);
  expect(await automationEntitlement(actor)).toBe(true);
});

it('does not carry a transition to another organization or an unrelated user', async () => {
  expect(await transitionAccess('org_another')).toBeNull();
  expect(await transitionLicense('sub_gestion', 'outsider')).toBeNull();
});

it('an expired transition and expired paid add-on grant no Automation', async () => {
  db.prepare('UPDATE complete_plan_changes SET effective_at=?').run(now() - 1);
  db.prepare('UPDATE automation_subscriptions SET paid_until=?').run(now() - 1);
  expect(await transitionAccess(actor.organizationId)).toBeNull();
  expect(await automationEntitlement(actor)).toBe(false);
});

it('a separately verified Complete invoice can still fund Automation after an obsolete add-on refund', async () => {
  const end = now() + 14 * 86400;
  db.prepare(`INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id)
    VALUES('sub_gestion','team','team',?,?,'in_gestion')`).run(now() - 86400, end);
  refund();
  expect((await transitionAccess(actor.organizationId))?.automation).toBe(true);
  expect(await automationEntitlement(actor)).toBe(true);
});

it('never restores refunded Complete rights from an old transition', async () => {
  db.prepare(`INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id)
    VALUES('sub_gestion','team','team',?,?,'in_gestion')`).run(now() - 86400, now() + 14 * 86400);
  db.prepare(`INSERT INTO complete_refunds(invoice_id,customer_id,livemode,verified_at)
    VALUES('in_gestion','cus_gestion',1,?)`).run(now());
  // The verified Complete refund revokes the base entitlement at persistence.
  db.exec('UPDATE subscriptions SET entitlement_valid_until=0');
  refund();
  expect(await transitionAccess(actor.organizationId)).toBeNull();
  expect(await automationEntitlement(actor)).toBe(false);
});
