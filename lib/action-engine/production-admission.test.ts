import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  db: null as unknown,
  stripeKey: 'rk_live_authority_fixture',
}));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY' ? runtime.stripeKey : '',
}));

import { hashOpaqueToken } from '@/lib/account-security';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { completePlan } from '@/lib/complete/plans';
import {
  createDeviceQuoteAuthority,
  QUOTE_PREPARATION_CONSENT_VERSION,
  type DeviceQuoteAuthority,
} from './production-admission';

let db: DatabaseSync;
const org = 'authority-company';
const user = 'authority-owner';
const subscription = 'sub_authority';
const installation = 'af74cf33-62e4-4184-9c32-df1c6299feb1';
const sessionId = 'authority-session';
const token = `zds_${'A'.repeat(43)}`;
const differentToken = `zds_${'B'.repeat(43)}`;

function requestFor(value = token, origin?: string) {
  return new Request('https://zentra.example.test/private-action', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${value}`,
      ...(origin === undefined ? {} : { Origin: origin }),
    },
  });
}

function paidPlan(value: 'solo' | 'team' | 'pro') {
  const plan = completePlan(value)!;
  db.prepare(
    'UPDATE complete_subscriptions SET plan_id=?,paid_plan_id=? WHERE subscription_id=?',
  ).run(value, value, subscription);
  db.prepare(
    'UPDATE subscriptions SET entitlement_plan_id=?,seat_limit=? WHERE subscription_id=?',
  ).run(plan.licensePlan, plan.seats, subscription);
}

function changeQuoteSettings(fragment: string, ...bindings: SQLInputValue[]) {
  db.prepare(
    `UPDATE action_engine_quote_settings SET ${fragment},revision=revision+1 WHERE organization_id=?`,
  ).run(...bindings, org);
}

async function deniedProgression(authority: DeviceQuoteAuthority) {
  await expect(authority.preflight()).rejects.toMatchObject({ status: 403 });
}

function predicateAllowed(
  authority: DeviceQuoteAuthority,
  purpose: 'read' | 'progression',
) {
  const gate = authority.predicate(purpose);
  return db
    .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`)
    .get(...gate.bindings)?.allowed;
}

beforeEach(async () => {
  runtime.stripeKey = 'rk_live_authority_fixture';
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  // Actual versioned schema + actual requireDeviceSession, without a network
  // service, provider mock or an in-memory substitute for SQL authorization.
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  runtime.db = {
    prepare: (query: string) => {
      let bindings: SQLInputValue[] = [];
      const statement = {
        bind: (...values: SQLInputValue[]) => {
          bindings = values;
          return statement;
        },
        first: async () => db.prepare(query).get(...bindings) ?? null,
        all: async () => ({ results: db.prepare(query).all(...bindings) }),
        run: async () => ({ meta: db.prepare(query).run(...bindings) }),
      };
      return statement;
    },
  };
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,
      entitlement_plan_id,seat_limit,status,current_period_end,
      entitlement_valid_until,livemode,updated_at)
    VALUES(?, 'cus_authority','price_authority','zentra-start-monthly-59-chf',
      'zentra-start-monthly-59-chf',3,'active',?,?,1,?)`,
  ).run(subscription, now + 3600, now + 3600, now);
  db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(
    org,
    'Fixture company',
    subscription,
    user,
    now,
    now,
  );
  for (const [id, role, joinedAt] of [
    [user, 'owner', 1],
    ['authority-member', 'member', 2],
    ['authority-reader', 'read_only', 3],
  ] as const)
    db.prepare(
      'INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,?)',
    ).run('membership-' + id, org, id, id + '@example.test', role, joinedAt);
  db.prepare(
    'INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES(?,?,?,?,?)',
  ).run('authority-license', subscription, installation, now, now);
  db.prepare(
    'INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    sessionId,
    await hashOpaqueToken('device-session', token),
    org,
    user,
    installation,
    now,
    now,
    now + 3600,
  );
  db.prepare(
    'INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id) VALUES(?,?,?,?,?,?)',
  ).run(subscription, 'team', 'team', now - 60, now + 3600, 'in_authority');
  db.prepare(
    `INSERT INTO automation_settings(organization_id,enabled,mode,flags,medium_threshold,high_threshold,consent_version,updated_at)
     VALUES(?,1,'suggest','["email_classification"]',0.65,0.95,?,?)`,
  ).run(org, AUTOMATION_CONSENT_VERSION, now);
  db.prepare('INSERT INTO automation_platform VALUES(?,?,?,?)').run(
    'features',
    '["email_classification"]',
    user,
    now,
  );
  db.prepare(
    'INSERT INTO action_engine_quote_settings(organization_id,enabled,consent_version,granted_by,granted_at,updated_at) VALUES(?,1,?,?,?,?)',
  ).run(org, QUOTE_PREPARATION_CONSENT_VERSION, user, now, now);
});

afterEach(() => db.close());

it.each(['solo', 'team', 'pro'] as const)(
  'admits the paid Complete %s catalogue without exposing credentials',
  async (plan) => {
    paidPlan(plan);
    const authority = await createDeviceQuoteAuthority(requestFor());
    expect(authority.actor).toEqual({ organizationId: org, userId: user });
    expect(authority.installationId).toBe(installation);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.actor)).toBe(true);
    expect(predicateAllowed(authority, 'read')).toBe(1);
    expect(predicateAllowed(authority, 'progression')).toBe(1);
    await expect(authority.authorizeRead()).resolves.toBeUndefined();
    await expect(authority.preflight()).resolves.toMatchObject({
      organizationId: org,
      userId: user,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
      automationActive: true,
      mayPrepareQuote: true,
    });
    expect(JSON.stringify(authority)).not.toContain(token);
    expect(JSON.stringify(authority.predicate('progression'))).not.toContain(
      token,
    );
  },
);

it('captures request headers before auth awaits and accepts native origins', async () => {
  const request = requestFor(token, 'tauri://localhost');
  const pending = createDeviceQuoteAuthority(request);
  request.headers.set('Authorization', `Bearer ${differentToken}`);
  const authority = await pending;
  await expect(authority.preflight()).resolves.toMatchObject({ userId: user });
});

it('rejects browser cookies, foreign origins and an unrelated bearer', async () => {
  await expect(
    createDeviceQuoteAuthority(new Request('https://zentra.example.test')),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    createDeviceQuoteAuthority(
      requestFor(token, 'https://attacker.example.test'),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    createDeviceQuoteAuthority(requestFor(differentToken)),
  ).rejects.toMatchObject({ status: 401 });
});

it.each([
  'UPDATE device_sessions SET revoked_at=unixepoch()',
  'UPDATE device_sessions SET expires_at=unixepoch()-1',
  "UPDATE device_sessions SET token_hash='different-hash'",
  "UPDATE device_sessions SET installation_id='other-installation'",
  "UPDATE device_sessions SET user_id='authority-member'",
  'UPDATE license_activations SET revoked_at=unixepoch()',
  "UPDATE organization_members SET revoked_at=unixepoch() WHERE role='owner'",
  "UPDATE organization_members SET role='read_only' WHERE user_id='authority-owner'",
  "INSERT INTO account_session_policy VALUES('authority-owner',0,unixepoch())",
  "INSERT INTO account_session_policy VALUES('authority-owner',unixepoch(),NULL)",
  "UPDATE subscriptions SET status='canceled'",
  'UPDATE subscriptions SET entitlement_valid_until=unixepoch()',
  'UPDATE subscriptions SET livemode=0',
  "UPDATE subscriptions SET entitlement_plan_id='zentra-pro-monthly-89-chf'",
  'UPDATE subscriptions SET seat_limit=NULL',
  'UPDATE subscriptions SET seat_limit=10',
  'UPDATE complete_subscriptions SET paid_from=unixepoch()+60',
  'UPDATE complete_subscriptions SET paid_until=unixepoch()',
  'UPDATE complete_subscriptions SET last_paid_invoice_id=NULL',
  "UPDATE complete_subscriptions SET paid_plan_id='unknown-plan'",
  "INSERT INTO complete_refunds VALUES('in_authority','cus_authority',1,unixepoch())",
])('rechecks authority after authentication: %s', async (mutation) => {
  const authority = await createDeviceQuoteAuthority(requestFor());
  const read = authority.predicate('read');
  const progress = authority.predicate('progression');
  db.exec(mutation);
  // Predicates themselves do not cache rights or require a second HTTP request.
  for (const gate of [read, progress])
    expect(
      db
        .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END allowed`)
        .get(...gate.bindings)?.allowed,
    ).toBe(0);
  await expect(authority.authorizeRead()).rejects.toMatchObject({
    status: 403,
  });
  await deniedProgression(authority);
});

it.each([
  'enabled=0',
  "mode='shadow'",
  "mode='unknown'",
  'consent_version=NULL',
  "consent_version='obsolete-version'",
  "flags='[]'",
  "flags='not json'",
  "flags='{}'",
  'flags=\'[true,1,{"email_classification":true}]\'',
  'medium_threshold=0.2',
  'high_threshold=1.1',
  'medium_threshold=0.95,high_threshold=0.65',
])(
  'allows historical recovery, never progression when Automation %s',
  async (change) => {
    const authority = await createDeviceQuoteAuthority(requestFor());
    db.exec('UPDATE automation_settings SET ' + change);
    await expect(authority.authorizeRead()).resolves.toBeUndefined();
    expect(predicateAllowed(authority, 'progression')).toBe(0);
    await deniedProgression(authority);
  },
);

it.each(['[]', 'not json', '{}', '["supplier_routing"]'])(
  'requires the global classification flag (%s)',
  async (flags) => {
    const authority = await createDeviceQuoteAuthority(requestFor());
    db.prepare('UPDATE automation_platform SET value=?').run(flags);
    await expect(authority.authorizeRead()).resolves.toBeUndefined();
    await deniedProgression(authority);
  },
);

it('has no default draft/customer opt-in and its default row stays disabled', async () => {
  const authority = await createDeviceQuoteAuthority(requestFor());
  db.exec('DELETE FROM action_engine_quote_settings');
  await expect(authority.authorizeRead()).resolves.toBeUndefined();
  await deniedProgression(authority);
  db.prepare(
    'INSERT INTO action_engine_quote_settings(organization_id,updated_at) VALUES(?,unixepoch())',
  ).run(org);
  expect(
    db
      .prepare(
        'SELECT enabled,revision,consent_version FROM action_engine_quote_settings',
      )
      .get(),
  ).toMatchObject({ enabled: 0, revision: 1, consent_version: null });
  await deniedProgression(authority);
});

it.each([
  ['enabled=0'],
  ["consent_version='automation-2026-09-20'"],
  ["granted_by='authority-member'"],
  ["granted_by='missing-user'"],
  ['granted_at=unixepoch()+60'],
])(
  'requires the specific current draft/customer consent: %s',
  async (change) => {
    const authority = await createDeviceQuoteAuthority(requestFor());
    changeQuoteSettings(change);
    await expect(authority.authorizeRead()).resolves.toBeUndefined();
    await deniedProgression(authority);
  },
);

it('revokes an active member action when its consenting admin loses that role', async () => {
  db.prepare('UPDATE device_sessions SET user_id=?').run('authority-member');
  const authority = await createDeviceQuoteAuthority(requestFor());
  await expect(authority.preflight()).resolves.toMatchObject({
    userId: 'authority-member',
  });
  db.prepare(
    "UPDATE organization_members SET role='member' WHERE user_id=?",
  ).run(user);
  await expect(authority.authorizeRead()).resolves.toBeUndefined();
  await deniedProgression(authority);
});

it('counts all active people before filtering the member, including read-only seats', async () => {
  db.prepare('UPDATE device_sessions SET user_id=?').run('authority-member');
  db.prepare(
    "UPDATE organization_members SET joined_at=0 WHERE user_id='authority-reader'",
  ).run();
  const authority = await createDeviceQuoteAuthority(requestFor());
  expect(predicateAllowed(authority, 'progression')).toBe(1);
  paidPlan('solo');
  expect(predicateAllowed(authority, 'read')).toBe(0);
  await deniedProgression(authority);
});

it('rechecks read-only seat ranking after a plan downgrade', async () => {
  paidPlan('pro');
  db.prepare(
    'INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,?)',
  ).run(
    'late-membership',
    org,
    'late-member',
    'late@example.test',
    'member',
    4,
  );
  db.exec(
    "UPDATE organization_members SET joined_at=0 WHERE user_id='authority-reader'",
  );
  db.exec("UPDATE device_sessions SET user_id='late-member'");
  const authority = await createDeviceQuoteAuthority(requestFor());
  await expect(authority.preflight()).resolves.toMatchObject({
    userId: 'late-member',
  });
  paidPlan('team');
  expect(predicateAllowed(authority, 'read')).toBe(0);
  await deniedProgression(authority);
});

it('retains a paid cancellation/past-due period and ignores refunds from other scopes', async () => {
  db.exec("UPDATE subscriptions SET status='past_due',cancel_at_period_end=1");
  db.exec(
    "INSERT INTO complete_refunds VALUES('in_authority','other-customer',1,unixepoch())",
  );
  const authority = await createDeviceQuoteAuthority(requestFor());
  await expect(authority.preflight()).resolves.toMatchObject({
    mayPrepareQuote: true,
  });
});

it('does not use a transition to extend an expired paid Complete period', async () => {
  const authority = await createDeviceQuoteAuthority(requestFor());
  db.prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at)
    VALUES(?,'change',?,?,'pro',unixepoch()+3600,'scheduled','{}',unixepoch(),unixepoch())`).run(
    org,
    user,
    subscription,
  );
  db.exec('UPDATE complete_subscriptions SET paid_until=unixepoch()-1');
  await deniedProgression(authority);
});

it.each(['trial_', 'manual_', 'pfp_'])(
  'does not transfer a captured session to an unsupported %s subscription',
  async (prefix) => {
    const authority = await createDeviceQuoteAuthority(requestFor());
    // The organization/activation references cascade. The captured device's
    // subscription and current paid Complete join must still match exactly.
    db.prepare('UPDATE subscriptions SET subscription_id=?').run(
      prefix + 'authority',
    );
    await deniedProgression(authority);
    await expect(authority.authorizeRead()).rejects.toMatchObject({
      status: 403,
    });
  },
);

it('refuses trial-prefixed rights even with a current Complete-shaped paid cache', async () => {
  const changed = 'trial_authority';
  db.prepare('UPDATE subscriptions SET subscription_id=?').run(changed);
  db.prepare('UPDATE complete_subscriptions SET subscription_id=?').run(
    changed,
  );
  const authority = await createDeviceQuoteAuthority(requestFor());
  await deniedProgression(authority);
  await expect(authority.authorizeRead()).rejects.toMatchObject({
    status: 403,
  });
});

it.each(['manual_', 'pfp_'])(
  'does not repair an unsupported %s authentication branch using paid caches',
  async (prefix) => {
    const changed = prefix + 'authority';
    db.prepare('UPDATE subscriptions SET subscription_id=?').run(changed);
    db.prepare('UPDATE complete_subscriptions SET subscription_id=?').run(
      changed,
    );
    await expect(
      createDeviceQuoteAuthority(requestFor()),
    ).rejects.toMatchObject({ status: 402 });
  },
);

it('binds the company and subscription selected during device authentication', async () => {
  const authority = await createDeviceQuoteAuthority(requestFor());
  db.prepare(
    'INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES(?,?,?,?,?,?)',
  ).run('sub_other', 'cus_other', 'price_other', 'active', 1, 1);
  db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(
    'other-company',
    'Other',
    'sub_other',
    user,
    1,
    1,
  );
  db.prepare('UPDATE device_sessions SET organization_id=?').run(
    'other-company',
  );
  await deniedProgression(authority);
  await expect(authority.authorizeRead()).rejects.toMatchObject({
    status: 403,
  });
});

it.each(['', 'invalid-key', 'rk_test_authority_fixture'])(
  'rechecks a changed or unusable runtime key (%s)',
  async (key) => {
    const authority = await createDeviceQuoteAuthority(requestFor());
    runtime.stripeKey = key;
    expect(predicateAllowed(authority, 'progression')).toBe(0);
    await deniedProgression(authority);
  },
);

it('uses a separate test-mode paid period without ever mixing live and test', async () => {
  runtime.stripeKey = 'rk_test_authority_fixture';
  db.exec('UPDATE subscriptions SET livemode=0');
  const authority = await createDeviceQuoteAuthority(requestFor());
  await expect(authority.preflight()).resolves.toMatchObject({
    mayPrepareQuote: true,
  });
  runtime.stripeKey = 'rk_live_authority_fixture';
  await deniedProgression(authority);
});

it('checks a previously compiled predicate inside the same transaction as a guarded write', async () => {
  const authority = await createDeviceQuoteAuthority(requestFor());
  const gate = authority.predicate('progression');
  db.exec('CREATE TABLE qa_guard(allowed INTEGER NOT NULL CHECK(allowed=1))');
  db.exec('CREATE TABLE qa_business_draft(id TEXT PRIMARY KEY)');
  function guardedWrite() {
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO qa_guard SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END`,
      ).run(...gate.bindings);
      db.exec("INSERT INTO qa_business_draft VALUES('guarded-draft')");
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.exec("UPDATE automation_settings SET mode='shadow'");
  expect(guardedWrite).toThrow();
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM qa_business_draft').get()?.n,
  ).toBe(0);
  db.exec("UPDATE automation_settings SET mode='suggest'");
  expect(guardedWrite).not.toThrow();
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM qa_business_draft').get()?.n,
  ).toBe(1);
});

it('enforces explicit revisions when modifying the opt-in', () => {
  expect(() =>
    db.exec('UPDATE action_engine_quote_settings SET enabled=0'),
  ).toThrow();
  changeQuoteSettings('enabled=0');
  expect(
    db
      .prepare('SELECT revision,enabled FROM action_engine_quote_settings')
      .get(),
  ).toMatchObject({ revision: 2, enabled: 0 });
});

it('does not accept a forged operation name as historical access', async () => {
  const authority = await createDeviceQuoteAuthority(requestFor());
  expect(() => authority.predicate('confirm' as 'read')).toThrow();
});
