import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const env = vi.hoisted(() => ({
  db: null as unknown,
  fetcher: vi.fn<typeof fetch>(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => env.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY' ? 'sk_live_fixture' : '',
}));
import {
  automationEntitlement,
  requireAutomationEntitlement,
} from './entitlement';
import {
  requireAutomationExecution,
  supportAutomationState,
  automationFetch,
  supportAutomationFetch,
} from './execution';
import { jevRequest } from './transport';
import { AUTOMATION_CONSENT_VERSION } from './config';
let db: DatabaseSync;
const actor = {
  organizationId: 'org_a',
  userId: 'owner',
  role: 'owner',
  founder: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const n of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + n, import.meta.url), 'utf8'),
    );
  env.db = {
    prepare: (query: string) => {
      let args: SQLInputValue[] = [];
      const p = {
        bind: (...v: SQLInputValue[]) => {
          args = v;
          return p;
        },
        first: async () => db.prepare(query).get(...args) || null,
        all: async () => ({ results: db.prepare(query).all(...args) }),
        run: async () => ({ meta: db.prepare(query).run(...args) }),
      };
      return p;
    },
  };
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('base_a','cus','price','active',2000000000,2000000000,1,1),('base_b','cus','price','active',2000000000,2000000000,1,1);
    INSERT INTO organizations VALUES('org_a','A','base_a','owner',1,1),('org_b','B','base_b','owner',1,1);
    INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('a','org_a','owner','owner@example.test','owner',1),('b','org_b','owner','owner@example.test','owner',1),('c','org_a','colleague','colleague@example.test','member',1);
    INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('org_a','addon_a','cus','active',1,2000000000,1,1);
    INSERT INTO automation_platform VALUES('features','["email_classification","supplier_routing"]','admin',1);
    INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES('support_a','owner','Support A','automatic',1,1),('support_b','owner_b','Support B','automatic',1,1);
    INSERT INTO support_members(id,workspace_id,email,role,created_at) VALUES('support-admin-b','support_b','owner@example.test','admin',1);
    INSERT INTO support_gestion_links VALUES('support_a','org_a',1,0,'owner',1),('support_b','org_b',1,0,'owner',1);`);
  for (const org of ['org_a', 'org_b'])
    db.prepare(
      'INSERT INTO automation_settings(organization_id,enabled,mode,flags,medium_threshold,high_threshold,consent_version,updated_at) VALUES(?,1,\'suggest\',\'["email_classification","supplier_routing"]\',0.65,0.95,?,1)',
    ).run(org, AUTOMATION_CONSENT_VERSION);
});
afterEach(() => db.close());
it('shares a single option with authorised colleagues but never another space owned by the same account', async () => {
  await expect(
    requireAutomationEntitlement({ ...actor, userId: 'colleague' }),
  ).resolves.toMatchObject({ role: 'member' });
  expect(await supportAutomationState('support_a')).toMatchObject({
    active: true,
    enabled: true,
  });
  expect(await supportAutomationState('support_b')).toMatchObject({
    active: false,
    enabled: false,
  });
  await expect(
    requireAutomationEntitlement({ ...actor, organizationId: 'org_b' }),
  ).rejects.toMatchObject({ status: 402 });
});
it.each([
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
  'trialing',
])(
  'blocks %s without deleting settings or granting an implicit trial',
  async (status) => {
    db.prepare('UPDATE automation_subscriptions SET status=?').run(status);
    expect(await automationEntitlement(actor)).toBe(false);
    await expect(
      automationFetch(
        actor,
        'email_classification',
        env.fetcher,
      )('https://fixture.test'),
    ).rejects.toMatchObject({ status: 402 });
    expect(env.fetcher).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM automation_settings').get()?.n,
    ).toBe(2);
  },
);
it('keeps a paid cancellation-at-period-end until expiry, but never extends failed renewal or grace', async () => {
  db.exec(
    "UPDATE automation_subscriptions SET cancel_at_period_end=1,status='past_due'",
  );
  expect(await automationEntitlement(actor)).toBe(true);
  db.exec('UPDATE automation_subscriptions SET paid_until=1');
  expect(await automationEntitlement(actor)).toBe(false);
});
it.each(['paid_from=2000000000', 'livemode=0', 'paid_until=1'])(
  'rejects future, test or expired payment (%s)',
  async (change) => {
    db.exec('UPDATE automation_subscriptions SET ' + change);
    expect(await automationEntitlement(actor)).toBe(false);
  },
);
it('a revoked or read-only collaborator cannot use a forged owner role', async () => {
  db.exec(
    "UPDATE organization_members SET role='read_only' WHERE user_id='colleague'",
  );
  await expect(
    requireAutomationEntitlement({ ...actor, userId: 'colleague' }),
  ).rejects.toMatchObject({ status: 403 });
  db.exec("UPDATE organization_members SET revoked_at=1 WHERE user_id='owner'");
  expect(await supportAutomationState('support_a')).toMatchObject({
    enabled: false,
  });
});
it.each(['enabled=0', 'consent_version=NULL', "flags='[]'"])(
  'stops disabled workspace execution even if the subscription is paid (%s)',
  async (change) => {
    db.exec('UPDATE automation_settings SET ' + change);
    await expect(
      requireAutomationExecution(actor, 'email_classification'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await supportAutomationState('support_a')).toMatchObject({
      active: true,
      enabled: false,
    });
  },
);
it('requires the global feature flag in addition to the paid option', async () => {
  db.exec("UPDATE automation_platform SET value='[]' WHERE id='features'");
  await expect(
    requireAutomationExecution(actor, 'email_classification'),
  ).rejects.toMatchObject({ status: 409 });
});
it('rechecks cancellation before a provider retry and sends no second paid call', async () => {
  env.fetcher.mockImplementation(async () => new Response('', { status: 503 }));
  await expect(
    jevRequest('synthetic', '{}', {
      fetcher: automationFetch(actor, 'email_classification', env.fetcher),
      retry: true,
      sleep: async () => {
        db.exec("UPDATE automation_subscriptions SET status='canceled'");
      },
    }),
  ).rejects.toMatchObject({ status: 402 });
  expect(env.fetcher).toHaveBeenCalledTimes(1);
});
it('stops workers when their saved Support delegation is disabled', async () => {
  db.exec('UPDATE support_gestion_links SET enabled=0');
  await expect(
    supportAutomationFetch(
      'support_a',
      'supplier_routing',
      env.fetcher,
    )('https://fixture.test'),
  ).rejects.toMatchObject({ status: 402 });
  expect(env.fetcher).not.toHaveBeenCalled();
});
it('reactivation restores saved settings for the same workspace only', async () => {
  db.exec("UPDATE automation_subscriptions SET status='unpaid'");
  expect((await supportAutomationState('support_a')).enabled).toBe(false);
  db.exec("UPDATE automation_subscriptions SET status='active'");
  expect((await supportAutomationState('support_a')).enabled).toBe(true);
  expect((await supportAutomationState('support_b')).enabled).toBe(false);
});
