import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { DecisionInput } from './types';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  identity: null as unknown,
  session: vi.fn(),
  membership: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: (k: string) =>
    ({
      STRIPE_SECRET_KEY: 'sk_live_fixture',
      ZENTRA_OWNER_EMAIL: 'owner@example.ch',
    })[k] || '',
}));
vi.mock('@/app/zentra-auth', () => ({
  getZentraUser: async () => mocks.identity,
}));
vi.mock('@/lib/account', () => ({
  requireBrowserMembership: mocks.membership,
  requireDeviceSession: mocks.session,
}));
vi.mock('@/lib/stripe', () => ({
  requireSameOrigin: (req: Request) => {
    if (req.headers.get('origin') !== new URL(req.url).origin)
      throw Error('origin');
  },
}));
import {
  automationEntitlement,
  decideForActor,
  recordFeedback,
} from './service';
import { automationActor, requireAutomationFounder } from './access';
import {
  saveSettings,
  setGlobalFlags,
  AUTOMATION_CONSENT_VERSION,
} from './config';
import { authorizedResources, nativeResources } from './resources';
import { DecisionFailure } from './types';
let sql: DatabaseSync;
const actor = {
  organizationId: 'org_a',
  userId: 'owner_a',
  role: 'owner',
  founder: true,
};
const payload = {
  requestId: 'request_fixture_0001',
  feature: 'transaction_classification',
  context: { text: 'Achat matériel secret=DO_NOT_LOG' },
};
function prepare(query: string) {
  let args: SQLInputValue[] = [];
  const p = {
    bind: (...v: SQLInputValue[]) => {
      args = v;
      return p;
    },
    run: async () => ({
      meta: { changes: Number(sql.prepare(query).run(...args).changes) },
    }),
    first: async () => sql.prepare(query).get(...args) || null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
  };
  return p;
}
function provider(confidence = 0.95) {
  return {
    decide: vi.fn(async (input: DecisionInput) => ({
      answers: Object.fromEntries(
        Object.entries(input.questions).map(([key, q]) => {
          const keys = Object.keys(q.options),
            choice = keys.includes('material') ? 'material' : keys[0];
          return [
            key,
            {
              choice,
              confidence,
              probabilities: Object.fromEntries(
                keys.map((k) => [k, k === choice ? 1 : 0]),
              ),
            },
          ];
        }),
      ),
      provider: 'fixture',
      model: 'fixture',
      latencyMs: 10,
      usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
    })),
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL(name, folder), 'utf8'));
  sql.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub_a','cus_a','price','active',2000000000,1,1),('sub_b','cus_b','price','active',2000000000,1,1); INSERT INTO organizations VALUES('org_a','A','sub_a','owner_a',1,1),('org_b','B','sub_b','owner_b',1,1)",
  );
  sql.exec(
    "UPDATE subscriptions SET entitlement_valid_until=2000000000 WHERE subscription_id='sub_a'; INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,livemode,updated_at) VALUES('org_a','sub_automation_a','cus_a','active',1,2000000000,1,1)",
  );
  mocks.db = { prepare };
  await setGlobalFlags(
    ['transaction_classification', 'supplier_routing'],
    'founder',
  );
  await saveSettings('org_a', 'owner_a', {
    enabled: true,
    mode: 'suggest',
    flags: ['transaction_classification', 'supplier_routing'],
    thresholds: { medium: 0.65, high: 0.9 },
    consentVersion: AUTOMATION_CONSENT_VERSION,
  });
});
afterEach(() => sql.close());
it('stores minimal audit and returns a proposal requiring confirmation', async () => {
  const result = await decideForActor(actor, payload, provider());
  expect(result).toMatchObject({
    status: 'suggestion',
    requiresConfirmation: true,
    choices: { category: 'material' },
  });
  const row = sql.prepare('SELECT * FROM automation_decisions').get();
  expect(JSON.stringify(row)).not.toContain('DO_NOT_LOG');
  expect(JSON.stringify(row)).not.toContain('Achat');
  expect(row?.confidence).toBe(0.95);
});
it('is idempotent and rejects replay with changed context', async () => {
  const p = provider();
  const a = await decideForActor(actor, payload, p),
    b = await decideForActor(actor, payload, p);
  expect(a).toEqual(b);
  expect(p.decide).toHaveBeenCalledTimes(1);
  await expect(
    decideForActor(actor, { ...payload, context: { text: 'Différent' } }, p),
  ).rejects.toMatchObject({ status: 409 });
});
it('hides uncertain choices in initial and replay responses', async () => {
  const p = provider(0.2);
  for (let i = 0; i < 2; i++) {
    const r = await decideForActor(actor, payload, p);
    expect(r).toMatchObject({ status: 'manual', choices: {} });
    expect(JSON.stringify(r)).not.toContain('observedChoices');
  }
});
it('shadow never exposes prediction before real user decision', async () => {
  sql.exec("UPDATE automation_settings SET mode='shadow'");
  const r = await decideForActor(actor, payload, provider());
  expect(r).toMatchObject({ status: 'shadow' });
  expect(r).not.toHaveProperty('choices');
  expect(r).not.toHaveProperty('confidence');
});
it('falls back on outage while retaining audit error code', async () => {
  const r = await decideForActor(actor, payload, {
    decide: async () => {
      throw new DecisionFailure('timeout');
    },
  });
  expect(r.status).toBe('manual');
  expect(
    sql.prepare('SELECT error_code FROM automation_decisions').get()
      ?.error_code,
  ).toBe('timeout');
});
it('requires consent and payment even if client asks for a feature', async () => {
  const p = provider();
  sql.exec('UPDATE automation_subscriptions SET paid_until=0');
  await expect(decideForActor(actor, payload, p)).rejects.toMatchObject({
    status: 402,
  });
  sql.exec('UPDATE automation_subscriptions SET paid_until=2000000000');
  sql.exec('UPDATE automation_settings SET consent_version=NULL');
  expect((await decideForActor(actor, payload, p)).status).toBe('disabled');
  expect(p.decide).not.toHaveBeenCalled();
});
it('uses identical paid company access for founders, ordinary browsers and devices', async () => {
  const identities = [
    actor,
    { ...actor, founder: false },
    { ...actor, founder: false, device: true },
  ];
  for (const identity of identities)
    expect(await automationEntitlement(identity)).toBe(true);
  sql.exec('DELETE FROM automation_subscriptions');
  for (const identity of identities)
    expect(await automationEntitlement(identity)).toBe(false);
});
it('computes corrected versus accepted feedback itself and prevents double votes', async () => {
  const r = await decideForActor(actor, payload, provider());
  const choices = { category: 'rent' };
  expect(
    await recordFeedback(actor, {
      id: 'id' in r ? r.id : '',
      feedback: 'accepted',
      choices,
    }),
  ).toMatchObject({ feedback: 'modified' });
  await expect(
    recordFeedback(actor, {
      id: 'id' in r ? r.id : '',
      feedback: 'accepted',
      choices,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('rejects cross-tenant feedback and fabricated categories', async () => {
  const r = await decideForActor(actor, payload, provider());
  await expect(
    recordFeedback(
      { ...actor, organizationId: 'org_b' },
      {
        id: 'id' in r ? r.id : '',
        feedback: 'accepted',
        choices: { category: 'material' },
      },
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    recordFeedback(actor, {
      id: 'id' in r ? r.id : '',
      feedback: 'accepted',
      choices: { category: 'invented' },
    }),
  ).rejects.toMatchObject({ status: 400 });
});
it('requires membership and refuses cross-company device identity', async () => {
  mocks.session.mockResolvedValue({
    organizationId: 'org_a',
    userId: 'owner_a',
    role: 'owner',
  });
  await expect(
    automationActor(
      new Request('https://zentraapp.ch/api/automation', {
        headers: { Authorization: 'Bearer fixture' },
      }),
      'org_b',
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it('founder access requires verified identity, not a posted email', async () => {
  mocks.identity = {
    provider: 'supabase',
    emailConfirmed: true,
    email: 'collaborator@example.ch',
    userId: 'staff',
  };
  await expect(
    requireAutomationFounder(
      new Request('https://zentraapp.ch/api/automation/admin', {
        method: 'POST',
        headers: { Origin: 'https://zentraapp.ch' },
        body: JSON.stringify({ email: 'owner@example.ch' }),
      }),
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it('resource lookup never leaks other companies or unfinished snapshots', async () => {
  sql.exec(
    "INSERT INTO business_sync_transfers(transfer_id,organization_id,installation_id,generation,kind,base_revision,revision,state,manifest_json,manifest_sha256,created_by,created_at) VALUES('t_b','org_b','device','g','bootstrap',0,1,'committed','{}','hash','owner','now'),('t_a','org_a','device','g','bootstrap',0,1,'uploading','{}','hash','owner','now'); INSERT INTO business_sync_spaces VALUES('org_b','g','t_b','ready',1,'owner_b','now'),('org_a','g','t_a','ready',1,'owner_a','now'); INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json) VALUES('t_b','org_b','suppliers','[\"private\"]','{\"id\":\"private\",\"name\":\"Other company supplier\"}'),('t_a','org_a','suppliers','[\"draft\"]','{\"id\":\"draft\",\"name\":\"Unvalidated\"}')",
  );
  expect(await authorizedResources('org_a')).toEqual({
    suppliers: [],
    projects: [],
    expenseCategories: [],
  });
  expect((await authorizedResources('org_b')).suppliers[0].id).toBe('private');
});
it('rejects a native projection bound to another company before contacting the provider', async () => {
  const p = provider();
  await expect(
    decideForActor(
      { ...actor, device: true },
      {
        ...payload,
        feature: 'supplier_routing',
        nativeResources: {
          organizationId: 'org_b',
          suppliers: [{ id: 'private', label: 'Private' }],
          projects: [],
          expenseCategories: [],
        },
      },
      p,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(p.decide).not.toHaveBeenCalled();
});
it('does not accept a browser supplied resource projection', async () => {
  const p = provider();
  await expect(
    decideForActor(
      actor,
      {
        ...payload,
        feature: 'supplier_routing',
        nativeResources: {
          organizationId: 'org_a',
          suppliers: [{ id: 'fake', label: 'Fake' }],
          projects: [],
          expenseCategories: [],
        },
      },
      p,
    ),
  ).rejects.toThrow();
  expect(p.decide).not.toHaveBeenCalled();
});
it('rejects duplicate native IDs and oversized labels', () => {
  const base = {
    organizationId: 'org_a',
    suppliers: [],
    projects: [],
    expenseCategories: [],
  };
  expect(() =>
    nativeResources(
      {
        ...base,
        suppliers: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      },
      'org_a',
    ),
  ).toThrow();
  expect(() =>
    nativeResources(
      { ...base, projects: [{ id: 'a', label: 'x'.repeat(161) }] },
      'org_a',
    ),
  ).toThrow();
});
it('releases stale processing responses to manual fallback without making another provider call', async () => {
  const p = provider();
  const result = await decideForActor(actor, payload, p);
  sql
    .prepare(
      "UPDATE automation_decisions SET state='processing',created_at=1 WHERE id=?",
    )
    .run('id' in result ? result.id : '');
  expect(await decideForActor(actor, payload, p)).toMatchObject({
    status: 'manual',
  });
  expect(p.decide).toHaveBeenCalledTimes(1);
});
