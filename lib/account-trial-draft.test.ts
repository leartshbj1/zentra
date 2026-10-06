import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import {
  startAccountTrial,
  TRIAL_DAYS,
  trialLicenseEntitlement,
} from './account-trial';
import {
  D1StripeGestionPurchase,
  type GestionStripeTransport,
} from './payments/stripe-gestion-purchase';
import {
  D1PurchaseIntents,
  type PurchaseBinding,
} from './payments/purchase-intents';
import { sha256Hex } from './account-security';
import { planById } from './plans';

const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: () => '',
  stripeConfiguration: () => ({}),
}));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
let sql: DatabaseSync, now: number;
let beforeBatch: (() => void) | undefined;
let beforeRun: ((query: string) => void) | undefined;
let sessions: Map<string, Stripe.Checkout.Session>;
let network: ReturnType<typeof vi.spyOn>;
let uncertain: boolean;
const user = {
  userId: 'local-draft-owner',
  email: 'owner@example.test',
  displayName: 'Owner',
  fullName: 'Owner',
  emailConfirmed: true,
  provider: 'supabase',
} as ZentraUser;
const origin = 'https://zentra.example.test';
const configuration = {
  secretKey: 'sk_test_fictional_never_used_for_HTTP',
  webhookSecret: '',
  webhookEndpointId: '',
  webhookUrl: '',
  priceId: '',
  signingKey: Buffer.from(
    '302e020100300506032b657004220420' + '01'.repeat(32),
    'hex',
  ).toString('base64url'),
  priceIds: {
    solo: 'price_solo_fixture',
    start: 'price_start_fixture',
    pro: 'price_pro_fixture',
  },
  siteUrl: origin,
  siteOriginAliases: '',
  testMode: 'accounts_only',
  testAccountUserIds: user.userId,
  ownerAccountUserId: '',
  ownerEmail: '',
};
function d1() {
  return {
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const statement = {
        bind(...values: SQLInputValue[]) {
          args = values;
          return statement;
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          beforeRun?.(query);
          return { success: true, meta: sql.prepare(query).run(...args) };
        },
        query,
        get args() {
          return args;
        },
      };
      return statement;
    },
    async batch(statements: { query: string; args: SQLInputValue[] }[]) {
      const hook = beforeBatch;
      beforeBatch = undefined;
      hook?.();
      sql.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((statement) => ({
          success: true,
          meta: sql.prepare(statement.query).run(...statement.args),
        }));
        sql.exec('COMMIT');
        return out;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
const transport: GestionStripeTransport = {
  async create(row, params) {
    const value = {
      id: 'cs_test_' + row.request_id.replaceAll('-', ''),
      url: 'https://checkout.stripe.com/fictional',
      status: 'open',
      mode: 'subscription',
      livemode: false,
      client_reference_id: params.client_reference_id,
      metadata: { ...params.metadata },
      expires_at: params.expires_at,
    } as Stripe.Checkout.Session;
    sessions.set(value.id, value);
    if (uncertain) throw Error('Fictional lost provider response.');
    return { ...value };
  },
  async retrieve(id) {
    const value = sessions.get(id);
    if (!value) throw Error('No fictional session.');
    return { ...value };
  },
  async list() {
    return { data: [...sessions.values()], has_more: false };
  },
  async expire(id) {
    const value = sessions.get(id)!;
    value.status = 'expired';
    value.url = null;
    return { ...value };
  },
};
const controller = () =>
  new D1StripeGestionPurchase(d1(), configuration, transport, () => now);
const checkout = (abandon = false) =>
  controller().checkout(
    { user, planId: 'start', origin, abandon },
    async () => null,
  );
const count = (table: string) =>
  Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const draft = () => sql.prepare('SELECT * FROM gestion_purchase_drafts').get()!;
const request = () =>
  sql
    .prepare(
      'SELECT * FROM gestion_purchase_requests ORDER BY created_at DESC,request_id DESC LIMIT 1',
    )
    .get()!;
function binding(): PurchaseBinding {
  const row = sql
    .prepare('SELECT * FROM purchase_intents WHERE intent_id=?')
    .get(request().intent_id as string)!;
  return {
    intentId: row.intent_id as string,
    fingerprint: row.fingerprint as string,
    ownerId: row.owner_id as string,
    environment: row.environment as 'TEST',
    provider: 'stripe',
    providerScope: row.provider_scope as string,
  };
}
async function abandoned(
  state: 'released' | 'expired' | 'canceled' = 'expired',
) {
  if (state === 'released') {
    beforeRun = (query) => {
      if (query.includes("SET state='dispatched'")) {
        beforeRun = undefined;
        throw Error('Fictional interruption before dispatch.');
      }
    };
    await expect(checkout()).rejects.toThrow('before dispatch');
  } else await checkout();
  if (state === 'canceled')
    await new D1PurchaseIntents(d1(), () => now).finalize(binding(), {
      providerReference: String(request().session_id),
      outcome: 'canceled',
      evidenceFingerprint: 'a'.repeat(64),
    });
  await checkout(true);
  expect(request().closed_at).toBe(now);
  expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
    state,
  );
  return String(draft().organization_id);
}
function historySnapshot() {
  return [
    'gestion_purchase_drafts',
    'gestion_purchase_requests',
    'purchase_intents',
    'purchase_intent_footprints',
    'checkout_attempts',
    'legal_acceptances',
  ].map((table) => [
    table,
    sql.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
  ]);
}
async function refused() {
  const before = historySnapshot(),
    orgs = sql.prepare('SELECT * FROM organizations ORDER BY 1').all(),
    subs = sql.prepare('SELECT * FROM subscriptions ORDER BY 1').all();
  await expect(startAccountTrial(user, 'Trial name')).rejects.toMatchObject({
    status: 409,
  });
  expect(historySnapshot()).toEqual(before);
  expect(sql.prepare('SELECT * FROM organizations ORDER BY 1').all()).toEqual(
    orgs,
  );
  expect(sql.prepare('SELECT * FROM subscriptions ORDER BY 1').all()).toEqual(
    subs,
  );
  expect(count('account_trials')).toBe(0);
}
function extraCompany(id: string, owner = user.userId) {
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,seat_limit,updated_at) VALUES(?,?,'local','incomplete',0,NULL,?)",
    )
    .run('draft_' + id, 'draft_' + id, now);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(id, 'Other company', 'draft_' + id, owner, now, now);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?, 'owner',?)",
    )
    .run('owner_' + id, id, owner, owner + '@example.test', now);
}
beforeEach(() => {
  now = Date.parse('2026-10-06T10:11:12Z') / 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => now);
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  beforeBatch = undefined;
  beforeRun = undefined;
  sessions = new Map();
  uncertain = false;
  runtime.db = d1();
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No external API is permitted.');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  sql.close();
  vi.useRealTimers();
});

describe('first trial reuses only a definitively abandoned original Gestion draft', () => {
  it.each(['released', 'expired', 'canceled'] as const)(
    'reuses the company after %s without deleting history/data or extending later retries',
    async (state) => {
      const org = await abandoned(state),
        before = historySnapshot(),
        original = draft().original_subscription_id;
      sql
        .prepare(
          "UPDATE organizations SET name='Existing preserved company' WHERE organization_id=?",
        )
        .run(org);
      sql
        .prepare(
          'INSERT INTO complete_onboarding(organization_id,skipped_json,updated_at) VALUES(?, \'["preserved-local-data"]\',?)',
        )
        .run(org, now);
      const members = sql.prepare('SELECT * FROM organization_members').all();
      const trial = await startAccountTrial(user, 'Different requested name');
      expect(trial.organization_id).toBe(org);
      expect(trial.ends_at - trial.started_at).toBe(TRIAL_DAYS * 86400);
      expect(count('organizations')).toBe(1);
      expect(count('subscriptions')).toBe(2);
      expect(
        sql
          .prepare('SELECT * FROM subscriptions WHERE subscription_id=?')
          .get(original as string)?.price_id,
      ).toBe('draft-no-paid-price');
      expect(
        sql.prepare('SELECT name,subscription_id FROM organizations').get(),
      ).toEqual({
        name: 'Existing preserved company',
        subscription_id: trial.subscription_id,
      });
      expect(sql.prepare('SELECT * FROM organization_members').all()).toEqual(
        members,
      );
      expect(historySnapshot()).toEqual(before);
      expect(
        sql.prepare('SELECT skipped_json FROM complete_onboarding').get()
          ?.skipped_json,
      ).toBe('["preserved-local-data"]');
      expect(
        await trialLicenseEntitlement(trial.subscription_id, user.userId),
      ).toMatchObject({
        customer_name: 'Existing preserved company',
        seat_limit: 1,
        entitlement_valid_until: trial.ends_at,
      });
      now += 3600;
      vi.setSystemTime(now * 1000);
      expect(await startAccountTrial(user, 'Retry')).toEqual(trial);
      expect(count('account_trials')).toBe(1);
    },
  );
  it('keeps the ordinary no-company trial path and name validation', async () => {
    await expect(startAccountTrial(user, '   ')).rejects.toThrow('nom');
    await expect(startAccountTrial(user, 'x'.repeat(121))).rejects.toThrow(
      '120',
    );
    const trial = await startAccountTrial(user, 'Brand new company');
    expect(trial.organization_id).toMatch(/^org_trial_/);
    expect(count('organizations')).toBe(1);
    expect(count('account_trials')).toBe(1);
  });
  it('preserves Complete upgrade/provisioning and its quota/three seats on the same company', async () => {
    const org = await abandoned();
    const before = historySnapshot();
    const trial = await startAccountTrial(user, 'Complete trial', true);
    expect(trial.organization_id).toBe(org);
    expect(historySnapshot()).toEqual(before);
    expect(
      sql
        .prepare(
          'SELECT seat_limit,plan_id FROM subscriptions WHERE subscription_id=?',
        )
        .get(trial.subscription_id),
    ).toEqual({ seat_limit: 3, plan_id: planById('start')!.licensePlan });
    expect(count('complete_trials')).toBe(1);
    expect(count('support_gestion_links')).toBe(1);
    expect(
      sql.prepare('SELECT organization_id FROM support_gestion_links').get()
        ?.organization_id,
    ).toBe(org);
    expect((await startAccountTrial(user, 'Retry', true)).ends_at).toBe(
      trial.ends_at,
    );
  });
  it.each([
    'open',
    'uncertain',
    'terminal-not-closed',
    'new-request',
    'no-request',
  ] as const)(
    'refuses %s Checkout state with no trial or mutations',
    async (mode) => {
      if (mode === 'uncertain') {
        uncertain = true;
        await expect(checkout()).rejects.toThrow('lost');
      } else if (mode === 'no-request') {
        // The real controller creates the draft first. A failed request insert
        // leaves no definitive canceled request and is never trial permission.
        beforeRun = (query) => {
          if (query.includes('INSERT INTO gestion_purchase_requests')) {
            beforeRun = undefined;
            throw Error('Fictional before request.');
          }
        };
        await expect(checkout()).rejects.toThrow('before request');
      } else {
        await checkout();
        if (mode === 'terminal-not-closed')
          await new D1PurchaseIntents(d1(), () => now).finalize(binding(), {
            providerReference: String(request().session_id),
            outcome: 'expired',
            evidenceFingerprint: 'a'.repeat(64),
          });
        if (mode === 'new-request') {
          await checkout(true);
          now++;
          vi.setSystemTime(now * 1000);
          await checkout();
        }
      }
      await refused();
    },
  );
  it.each([
    'owner-revoked',
    'owner-role',
    'owner-changed',
    'second-company',
    'other-membership',
    'subscription-changed',
    'paid-receipt',
    'entitlement-cache',
    'unknown-checkout',
    'founder-grant',
  ] as const)('refuses %s after definitive cancellation', async (mode) => {
    const org = await abandoned();
    if (mode === 'owner-revoked')
      sql.prepare('UPDATE organization_members SET revoked_at=?').run(now);
    if (mode === 'owner-role')
      sql.prepare("UPDATE organization_members SET role='admin'").run();
    if (mode === 'owner-changed')
      sql
        .prepare("UPDATE organizations SET created_by_user_id='other-owner'")
        .run();
    if (mode === 'second-company') extraCompany('second');
    if (mode === 'other-membership') {
      extraCompany('foreign', 'other-owner');
      sql
        .prepare(
          "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('outside','foreign',?,?,'member',?)",
        )
        .run(user.userId, user.email, now);
    }
    if (mode === 'subscription-changed') {
      sql
        .prepare(
          "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES('draft_replacement','local','local','incomplete',0,?)",
        )
        .run(now);
      sql
        .prepare(
          "UPDATE organizations SET subscription_id='draft_replacement' WHERE organization_id=?",
        )
        .run(org);
    }
    if (mode === 'paid-receipt')
      sql
        .prepare(
          "UPDATE subscriptions SET last_paid_invoice_id='in_paid_fixture' WHERE subscription_id=?",
        )
        .run(draft().original_subscription_id as string);
    if (mode === 'entitlement-cache')
      sql
        .prepare(
          'UPDATE subscriptions SET entitlement_valid_until=? WHERE subscription_id=?',
        )
        .run(now + 3600, draft().original_subscription_id as string);
    if (mode === 'unknown-checkout')
      sql
        .prepare(
          "INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at,account_user_id) VALUES(?,'cs_test_unknown',?,?,?)",
        )
        .run('b'.repeat(43), now, now + 3600, user.userId);
    if (mode === 'founder-grant')
      sql
        .prepare(
          "INSERT INTO founder_access_grants(email,grant_id,user_id,organization_id,valid_until,revision,created_at,updated_at,last_operation_id) VALUES(?,'local-grant',?,?,?,1,?,?,'local-operation')",
        )
        .run(user.email, user.userId, org, now + 3600, now, now);
    await refused();
  });
  it('retains the email fingerprint uniqueness across another historical trial', async () => {
    await abandoned();
    sql
      .prepare(
        'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        'past-other-user',
        await sha256Hex(user.email.trim().toLowerCase()),
        'past-other-org',
        'past-other-trial',
        now - 30 * 86400,
        now - 16 * 86400,
      );
    const before = historySnapshot();
    await expect(startAccountTrial(user, 'Retry')).rejects.toMatchObject({
      status: 409,
    });
    expect(count('account_trials')).toBe(1);
    expect(historySnapshot()).toEqual(before);
    expect(count('subscriptions')).toBe(1);
  });
  it.each(['reserved', 'dispatched', 'uncertain'] as const)(
    'refuses a separate %s Automation claim after the Gestion request has closed',
    async (state) => {
      const org = await abandoned(),
        store = new D1PurchaseIntents(d1(), () => now);
      let intent = await store.reserve({
        ownerId: user.userId,
        environment: 'TEST',
        provider: 'stripe',
        providerScope: String(request().provider_scope),
        product: 'automation',
        organizationId: org,
        workspaceId: null,
        planId: null,
        parameters: { localFixture: 'unpaid-automation' },
        terms: {
          version: String(request().legal_version),
          consentVersion: null,
          origin,
        },
      });
      if (state !== 'reserved') intent = await store.markDispatched(intent);
      if (state === 'uncertain') intent = await store.markUncertain(intent);
      expect(intent.state).toBe(state);
      expect(
        sql
          .prepare(
            'SELECT COUNT(*) AS n FROM purchase_intent_footprints WHERE intent_id=? AND released_at IS NULL',
          )
          .get(intent.intentId)?.n,
      ).toBe(1);
      await refused();
    },
  );
  it('refuses a separately projected subscription receipt linked to the canceled Checkout', async () => {
    await abandoned();
    sql
      .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,last_paid_invoice_id,checkout_session_id,updated_at)
      VALUES('sub_paid_late','cus_fixture','price_fixture','active',?,?,'in_paid_late',?,?)`)
      .run(now + 3600, now + 3600, request().session_id as string, now);
    await refused();
  });
  it('returns an already ended historical trial without allocating another free period', async () => {
    const org = await abandoned(),
      original = String(draft().original_subscription_id);
    sql
      .prepare(
        'INSERT INTO account_trials(user_id,email_hash,organization_id,subscription_id,started_at,ends_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        user.userId,
        await sha256Hex(user.email),
        org,
        'trial_historical',
        now - 30 * 86400,
        now - 16 * 86400,
      );
    const trial = await startAccountTrial(user, 'No restart');
    expect(trial.subscription_id).toBe('trial_historical');
    expect(trial.ends_at).toBeLessThan(now);
    expect(
      await trialLicenseEntitlement(trial.subscription_id, user.userId),
    ).toBeNull();
    expect(count('account_trials')).toBe(1);
    expect(count('subscriptions')).toBe(1);
    expect(
      sql.prepare('SELECT subscription_id FROM organizations').get()
        ?.subscription_id,
    ).toBe(original);
  });
  it('rolls back the full batch if ownership changes between its INSERT and UPDATE statements', async () => {
    const org = await abandoned(),
      original = String(draft().original_subscription_id),
      before = historySnapshot();
    const members = sql.prepare('SELECT * FROM organization_members').all();
    sql.exec(`CREATE TRIGGER trial_test_revoke_owner AFTER INSERT ON subscriptions WHEN NEW.price_id='free_trial'
      BEGIN UPDATE organization_members SET revoked_at=unixepoch() WHERE organization_id IN(SELECT organization_id FROM account_trials WHERE subscription_id=NEW.subscription_id); END;`);
    await expect(startAccountTrial(user, 'Interrupted batch')).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    expect(count('account_trials')).toBe(0);
    expect(count('subscriptions')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT subscription_id FROM organizations WHERE organization_id=?',
        )
        .get(org)?.subscription_id,
    ).toBe(original);
    expect(sql.prepare('SELECT * FROM organization_members').all()).toEqual(
      members,
    );
    expect(historySnapshot()).toEqual(before);
  });
  it('eight simultaneous trial starts preserve one company, one trial and one original period', async () => {
    const org = await abandoned();
    const trials = await Promise.all(
      Array.from({ length: 8 }, () => startAccountTrial(user, 'Concurrent')),
    );
    expect(new Set(trials.map((trial) => trial.organization_id))).toEqual(
      new Set([org]),
    );
    expect(new Set(trials.map((trial) => trial.subscription_id)).size).toBe(1);
    expect(new Set(trials.map((trial) => trial.ends_at)).size).toBe(1);
    expect(count('account_trials')).toBe(1);
    expect(count('organizations')).toBe(1);
    expect(count('subscriptions')).toBe(2);
  });
  it.each([
    'new-request',
    'owner-revoked',
    'paid-receipt',
    'new-membership',
  ] as const)(
    'revalidates %s committed after candidate read and before the atomic trial batch',
    async (mode) => {
      const org = await abandoned(),
        original = String(draft().original_subscription_id);
      beforeBatch = () => {
        if (mode === 'owner-revoked')
          sql
            .prepare(
              'UPDATE organization_members SET revoked_at=? WHERE organization_id=?',
            )
            .run(now, org);
        if (mode === 'paid-receipt')
          sql
            .prepare(
              "UPDATE subscriptions SET last_paid_invoice_id='in_raced_fixture' WHERE subscription_id=?",
            )
            .run(original);
        if (mode === 'new-membership') {
          extraCompany('race-foreign', 'other-owner');
          sql
            .prepare(
              "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('race-membership','race-foreign',?,?,'member',?)",
            )
            .run(user.userId, user.email, now);
        }
        if (mode === 'new-request') {
          const previous = request();
          sql
            .prepare(`INSERT INTO gestion_purchase_requests(request_id,owner_id,organization_id,previous_subscription_id,environment,provider_scope,plan_id,account_email,account_name,origin,legal_version,claim_hash,sealed_claim,parameters_json,created_at,expires_at)
          VALUES('gpr_new_race',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(
              user.userId,
              org,
              original,
              previous.environment as string,
              previous.provider_scope as string,
              'start',
              user.email,
              user.displayName,
              origin,
              previous.legal_version as string,
              'c'.repeat(43),
              'fictional-sealed',
              '{}',
              now + 1,
              now + 3601,
            );
        }
      };
      await expect(startAccountTrial(user, 'Raced')).rejects.toMatchObject({
        status: 409,
      });
      expect(count('account_trials')).toBe(0);
      expect(count('subscriptions')).toBe(mode === 'new-membership' ? 2 : 1);
      expect(
        sql
          .prepare(
            'SELECT subscription_id FROM organizations WHERE organization_id=?',
          )
          .get(org)?.subscription_id,
      ).toBe(original);
      if (mode === 'new-request')
        expect(count('gestion_purchase_requests')).toBe(2);
      if (mode === 'owner-revoked')
        expect(
          sql.prepare('SELECT revoked_at FROM organization_members').get()
            ?.revoked_at,
        ).toBe(now);
      if (mode === 'paid-receipt')
        expect(
          sql.prepare('SELECT last_paid_invoice_id FROM subscriptions').get()
            ?.last_paid_invoice_id,
        ).toBe('in_raced_fixture');
    },
  );
});
