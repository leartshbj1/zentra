import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  db: null as unknown,
  stripeKey: 'rk_live_discovery_fixture',
  organizations: '["discovery-company"]',
}));
const compiled = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  return new WebAssembly.Module(
    readFileSync(
      createRequire(import.meta.url).resolve(
        'sql.js/dist/sql-wasm-browser.wasm',
      ),
    ),
  );
});
vi.mock('sql.js/dist/sql-wasm-browser.wasm', () => ({ default: compiled }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY'
      ? runtime.stripeKey
      : key === 'ACTION_ENGINE_PUBLICATION_ORGANIZATIONS'
        ? runtime.organizations
        : '',
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: () => {
    throw Error('External PG forbidden in private discovery QA');
  },
}));

import { hashOpaqueToken } from '@/lib/account-security';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { QUOTE_PREPARATION_CONSENT_VERSION } from './production-admission';
import { discoverDeviceSupportQuoteWork } from './device-work-discovery';
import { makeQuoteConfirmationFixture } from './confirmation-records.fixture';
import { createD1QuoteLedger } from './ledger';
import { createD1QuotePublicationEvidence } from './quote-publication-evidence';

// Actual cumulative D1 schema + real device authentication, seats, commercial
// and delegation SQL. Only the D1 transport/runtime is a local SQLite adapter.
// No route, provider, external auth/PG/Storage, or native executable is involved.
const ORG = 'discovery-company';
const USER = 'discovery-owner';
const INSTALL = '00000000-0000-4000-8000-000000009001';
const token = `zds_${'Q'.repeat(43)}`;
const now = Math.floor(Date.parse('2026-10-11T12:01:00Z') / 1000);
let db: DatabaseSync;
let canonical: ReturnType<typeof makeQuoteConfirmationFixture> | undefined;
let hooks: (() => void | Promise<void>)[];
let fault: 'lost' | 'rollback' | null;
let transform: ((rows: unknown[]) => unknown[]) | null;
let queries: string[];
let statementsSeen: Statement[];
type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => Statement;
};

function adapter() {
  return {
    prepare(query: string) {
      const statement = {
        sql: query,
        values: [] as SQLInputValue[],
        bind(...values: SQLInputValue[]) {
          statement.values = [...values];
          return statement;
        },
        async first() {
          queries.push(query);
          return db.prepare(query).get(...statement.values) ?? null;
        },
        async run() {
          queries.push(query);
          return { meta: db.prepare(query).run(...statement.values) };
        },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      const hook = hooks.shift(),
        failure = fault,
        mutate = transform;
      fault = null;
      transform = null;
      if (hook) await hook();
      db.exec('BEGIN');
      let committed = false;
      try {
        const rows = statements.map((statement) => {
          queries.push(statement.sql);
          statementsSeen.push({ ...statement, values: [...statement.values] });
          return {
            success: true,
            results: db.prepare(statement.sql).all(...statement.values),
            meta: { changes: 0 },
          };
        });
        if (failure === 'rollback') throw Error('Private simulated rollback');
        db.exec('COMMIT');
        committed = true;
        if (failure === 'lost') throw Error('Private lost transport result');
        return mutate ? mutate(rows) : rows;
      } catch (error) {
        if (!committed) db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function request(value = token) {
  return new Request('https://zentra.invalid/private-discovery', {
    headers: {
      Authorization: `Bearer ${value}`,
      Origin: 'tauri://localhost',
    },
  });
}

async function seedAuthority(org = ORG, user = USER, installation = INSTALL) {
  const subscription = `sub_${org}`;
  db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,
    entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
    VALUES(?,?,'price_discovery','zentra-start-monthly-59-chf','zentra-start-monthly-59-chf',3,'active',?,?,1,?)`).run(
    subscription,
    `cus_${org}`,
    now + 3600,
    now + 3600,
    now,
  );
  db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(
    org,
    'Synthetic company',
    subscription,
    user,
    now,
    now,
  );
  db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES(?,?,?,?,'owner',1)`).run(
    `member-${org}`,
    org,
    user,
    `${user}@example.test`,
  );
  db.prepare(`INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at)
    VALUES(?,?,?,?,?)`).run(
    `license-${org}`,
    subscription,
    installation,
    now,
    now,
  );
  db.prepare(`INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    'discovery-session',
    await hashOpaqueToken('device-session', token),
    org,
    user,
    installation,
    now - 60,
    now,
    now + 3600,
  );
  db.prepare(`INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id)
    VALUES(?,'team','team',?,?,?)`).run(
    subscription,
    now - 60,
    now + 3600,
    `in_${org}`,
  );
  db.prepare(`INSERT INTO automation_settings(organization_id,enabled,mode,flags,medium_threshold,high_threshold,consent_version,updated_at)
    VALUES(?,1,'suggest','["email_classification"]',0.65,0.95,?,?)`).run(
    org,
    AUTOMATION_CONSENT_VERSION,
    now,
  );
  db.prepare('INSERT INTO automation_platform VALUES(?,?,?,?)').run(
    'features',
    '["email_classification"]',
    user,
    now,
  );
  db.prepare(`INSERT INTO action_engine_quote_settings(organization_id,enabled,consent_version,granted_by,granted_at,updated_at)
    VALUES(?,1,?,?,?,?)`).run(
    org,
    QUOTE_PREPARATION_CONSENT_VERSION,
    user,
    now,
    now,
  );
  seedSupport(org, user);
  runtime.organizations = JSON.stringify([org]);
}

function seedSupport(org: string, user: string) {
  db.prepare(`INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at)
    VALUES(?,?,'Synthetic Support','automatic',1,1)`).run(
    `workspace-${org}`,
    user,
  );
  db.prepare(`INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at)
    VALUES(?,?,'infomaniak','Synthetic','','','','','{}','{}',2)`).run(
    `connection-${org}`,
    `workspace-${org}`,
  );
  db.prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at)
    VALUES(?,?,?,3)`).run(`workspace-${org}`, org, user);
}

function ticket(id: string, createdAt = 100, org = ORG) {
  const envelope = {
    externalId: id,
    subject: 'Demande de devis',
    body: '3 radiateurs',
    senderEmail: 'client@example.test',
    senderName: 'Client fictif',
    closed: false,
  };
  db.prepare(`INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,decision_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'routed',?,?,?)`).run(
    id,
    `workspace-${org}`,
    `connection-${org}`,
    id,
    envelope.subject,
    envelope.body,
    JSON.stringify(envelope),
    `hash-${id}`,
    JSON.stringify({ category: 'quote', confidence: 0.99 }),
    createdAt,
    createdAt,
  );
}

function plan(sourceId: string, org = ORG) {
  return {
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: org,
    sourceId,
    sourceRevision: 'source-v1',
    contextRevision: 'context-v1',
    status: 'needs_review',
    reasons: ['missing_article'],
    customer: null,
    title: 'Quote',
    currency: 'CHF',
    lines: [],
    netCents: 0,
    confidence: null,
    requiresHumanValidation: true,
  };
}

function proposal(sourceId: string, org = ORG) {
  db.prepare(
    'INSERT INTO action_engine_quote_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    `proposal-${sourceId}`,
    org,
    sourceId,
    'prepare_quote_draft',
    'a'.repeat(64),
    'source-v1',
    'context-v1',
    JSON.stringify(plan(sourceId, org)),
    USER,
    now - 100,
  );
}

function intake(
  sourceId: string,
  state: 'active' | 'expired' | 'started' | 'uncertain' | 'finished',
) {
  const input = {
    organizationId: ORG,
    sourceId,
    kind: 'prepare_quote_draft',
    engineVersion: 'action-engine-quote-v1',
    sourceRevision: 'source-v1',
    contextRevision: 'context-v1',
    contextHash: 'b'.repeat(64),
  };
  db.prepare(`INSERT INTO action_engine_quote_intake(id,organization_id,source_id,action_kind,engine_version,
    source_revision,context_revision,context_hash,input_hash,input_json,state,owner_user_id,owner_token,lease_until,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'preparing',?,?,?,?,?)`).run(
    `intake-${sourceId}`,
    ORG,
    sourceId,
    input.kind,
    input.engineVersion,
    input.sourceRevision,
    input.contextRevision,
    input.contextHash,
    'c'.repeat(64),
    JSON.stringify(input),
    USER,
    '00000000-0000-4000-8000-000000000333',
    state === 'expired' ? now - 10 : now + 10,
    now - 100,
    now - 100,
  );
  if (state === 'started' || state === 'uncertain') {
    db.prepare(
      "UPDATE action_engine_quote_intake SET state='started',started_at=?,updated_at=? WHERE source_id=?",
    ).run(now - 50, now - 50, sourceId);
    if (state === 'uncertain')
      db.prepare(
        "UPDATE action_engine_quote_intake SET state='uncertain',updated_at=? WHERE source_id=?",
      ).run(now - 40, sourceId);
  }
  if (state === 'finished')
    db.prepare(
      `UPDATE action_engine_quote_intake SET state='finished',finished_at=?,updated_at=?,result_json=?,result_fingerprint=? WHERE source_id=?`,
    ).run(
      now - 50,
      now - 50,
      JSON.stringify(plan(sourceId)),
      'd'.repeat(64),
      sourceId,
    );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now * 1000));
  runtime.stripeKey = 'rk_live_discovery_fixture';
  hooks = [];
  fault = null;
  transform = null;
  queries = [];
  statementsSeen = [];
  db = new DatabaseSync(':memory:');
  db.function('unixepoch', () => Math.floor(Date.now() / 1000));
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'),
    );
  runtime.db = adapter();
  await seedAuthority();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (canonical) canonical.close();
  else db.close();
  canonical = undefined;
});

describe('private durable quote discovery, real device/D1 authority and SQL', () => {
  it('returns only frozen source IDs, without writes, catalogue, mail or plans', async () => {
    ticket('source-a');
    expect(await discoverDeviceSupportQuoteWork(request())).toEqual({
      sourceIds: ['source-a'],
      nextCursor: null,
    });
    const result = await discoverDeviceSupportQuoteWork(request());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sourceIds)).toBe(true);
    expect(
      queries.filter((sql) => !/^(?:SELECT|WITH)\b/.test(sql.trimStart())),
    ).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(
      /client@example|radiateurs|owner|fingerprint|proposal|zds_/,
    );
    expect(
      db.prepare('SELECT count(*) n FROM action_engine_quote_intake').get()?.n,
    ).toBe(0);
    expect(
      db.prepare('SELECT count(*) n FROM action_engine_atomic_assertions').get()
        ?.n,
    ).toBe(0);
  });

  it('uses stable binary keyset pages at equal timestamps and restarts full rounds', async () => {
    for (const id of ['source-c', 'source-A', 'source-b', 'source-d'])
      ticket(id);
    const first = await discoverDeviceSupportQuoteWork(request(), { limit: 2 });
    expect(first.sourceIds).toEqual(['source-A', 'source-b']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const next = await discoverDeviceSupportQuoteWork(request(), {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(next).toEqual({
      sourceIds: ['source-c', 'source-d'],
      nextCursor: null,
    });
    expect(
      (await discoverDeviceSupportQuoteWork(request(), { limit: 2 })).sourceIds,
    ).toEqual(first.sourceIds);
  });

  it('does not miss late classification or lease expiry on the next full round', async () => {
    ticket('source-a');
    ticket('source-b');
    intake('source-b', 'active');
    db.prepare(
      "UPDATE support_tickets SET state='pending',decision_json=NULL WHERE id='source-a'",
    ).run();
    expect((await discoverDeviceSupportQuoteWork(request())).sourceIds).toEqual(
      [],
    );
    db.prepare(
      "UPDATE support_tickets SET state='review',decision_json=? WHERE id='source-a'",
    ).run(JSON.stringify({ category: 'quote' }));
    vi.setSystemTime(new Date((now + 11) * 1000));
    expect((await discoverDeviceSupportQuoteWork(request())).sourceIds).toEqual(
      ['source-a', 'source-b'],
    );
  });

  it('recovers finished intake without a saved proposal but never redispatches started/uncertain', async () => {
    for (const [id, state] of [
      ['a-active', 'active'],
      ['b-expired', 'expired'],
      ['c-started', 'started'],
      ['d-uncertain', 'uncertain'],
      ['e-finished', 'finished'],
    ] as const) {
      ticket(id);
      intake(id, state);
    }
    expect((await discoverDeviceSupportQuoteWork(request())).sourceIds).toEqual(
      ['b-expired', 'e-finished'],
    );
    vi.setSystemTime(new Date((now + 60) * 1000));
    expect((await discoverDeviceSupportQuoteWork(request())).sourceIds).toEqual(
      ['a-active', 'b-expired', 'e-finished'],
    );
  });

  it.each(['pending', 'processing', 'error', 'quiet'])(
    'does not discover unclassified or unstable Support state %s',
    async (state) => {
      ticket('source-a');
      db.prepare('UPDATE support_tickets SET state=?').run(state);
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual([]);
    },
  );

  it.each(['review', 'ready', 'routed'])(
    'discovers classified stable Support state %s',
    async (state) => {
      ticket('source-a');
      db.prepare('UPDATE support_tickets SET state=?').run(state);
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual(['source-a']);
    },
  );

  it.each([
    ['decision_json', '{'],
    ['decision_json', 'null'],
    ['decision_json', '{"category":"invoice"}'],
    ['source_json', '{'],
    ['source_json', '{"closed":true}'],
    ['source_json', '{"closed":false,"incomplete":true}'],
    ['source_json', '{"closed":false,"mail":{"bodyIncomplete":true}}'],
    ['source_json', '{"closed":false,"senderIdentityAmbiguous":true}'],
  ])(
    'excludes unsafe new work %s=%s without a JSON SQL error',
    async (column, value) => {
      ticket('source-a');
      db.prepare(`UPDATE support_tickets SET ${column}=?`).run(value);
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual([]);
    },
  );

  it.each([
    "UPDATE automation_settings SET mode='shadow'",
    'UPDATE automation_settings SET enabled=0',
    "UPDATE automation_settings SET consent_version='obsolete'",
    "UPDATE automation_settings SET flags='[]'",
    "UPDATE automation_platform SET value='[]'",
    'UPDATE action_engine_quote_settings SET enabled=0,revision=revision+1',
    "UPDATE action_engine_quote_settings SET consent_version='obsolete',revision=revision+1",
    "UPDATE support_workspaces SET mode='paused'",
    'UPDATE support_connections SET active=0',
  ])(
    'keeps historical proposals discoverable but excludes new work: %s',
    async (mutation) => {
      ticket('new-source');
      ticket('old-source');
      proposal('old-source');
      db.exec(mutation);
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual(['old-source']);
    },
  );

  it('keeps historical proposals after source editing/closure/reclassification and the allowlist rollback', async () => {
    ticket('new-source');
    ticket('old-source');
    proposal('old-source');
    db.prepare(
      "UPDATE support_tickets SET state='error',source_json='broken',decision_json=NULL,revision=revision+1 WHERE id='old-source'",
    ).run();
    runtime.organizations = '[]';
    expect((await discoverDeviceSupportQuoteWork(request())).sourceIds).toEqual(
      ['old-source'],
    );
  });

  it.each([
    'UPDATE support_gestion_links SET enabled=0',
    "UPDATE organization_members SET revoked_at=unixepoch() WHERE user_id='discovery-owner'",
    "UPDATE support_workspaces SET owner_id='unrelated-owner'",
    'UPDATE device_sessions SET revoked_at=unixepoch()',
    'UPDATE license_activations SET revoked_at=unixepoch()',
    "UPDATE subscriptions SET status='canceled'",
    "INSERT INTO complete_refunds VALUES('in_discovery-company','cus_discovery-company',1,unixepoch())",
  ])(
    'fails closed, including historical proposals, on revocation before the batch: %s',
    async (mutation) => {
      ticket('old-source');
      proposal('old-source');
      hooks.push(() => db.exec(mutation));
      await expect(
        discoverDeviceSupportQuoteWork(request()),
      ).rejects.toMatchObject({ code: 'forbidden' });
    },
  );

  it('does not disclose a foreign tenant even with a linked ticket/proposal', async () => {
    db.prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,
      entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
      VALUES('sub_foreign','cus_foreign','price_foreign','zentra-start-monthly-59-chf',
      'zentra-start-monthly-59-chf',3,'active',?,?,1,?)`).run(
      now + 3600,
      now + 3600,
      now,
    );
    db.prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)').run(
      'foreign-org',
      'Foreign',
      'sub_foreign',
      'foreign-user',
      now,
      now,
    );
    db.prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
      VALUES('foreign-member','foreign-org','foreign-user','foreign@example.test','owner',1)`).run();
    seedSupport('foreign-org', 'foreign-user');
    ticket('foreign-source', 10, 'foreign-org');
    proposal('foreign-source', 'foreign-org');
    ticket('local-source');
    expect((await discoverDeviceSupportQuoteWork(request())).sourceIds).toEqual(
      ['local-source'],
    );
  });

  it('revocation or consent pause during the first result wait prevents release of fresh work', async () => {
    ticket('source-a');
    hooks.push(
      () => {},
      () =>
        db.exec(
          'UPDATE action_engine_quote_settings SET enabled=0,revision=revision+1',
        ),
    );
    await expect(
      discoverDeviceSupportQuoteWork(request()),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it.each([
    "UPDATE support_tickets SET source_json=json_set(source_json,'$.closed',json('true'))",
    "UPDATE support_tickets SET state='processing'",
    'UPDATE support_tickets SET decision_json=\'{"category":"invoice"}\'',
    "UPDATE support_workspaces SET mode='paused'",
    'UPDATE support_connections SET active=0',
  ])('rechecks selected new work after awaits: %s', async (mutation) => {
    ticket('source-a');
    hooks.push(
      () => {},
      () => db.exec(mutation),
    );
    await expect(
      discoverDeviceSupportQuoteWork(request()),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not release workspace-A IDs after replacement by a still-authorized workspace-B delegation', async () => {
    ticket('source-a');
    proposal('source-a');
    hooks.push(
      () => {},
      () => {
        db.prepare('DELETE FROM support_gestion_links').run();
        db.prepare(
          "INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES('workspace-b','other-support-owner','B','automatic',1,1)",
        ).run();
        db.prepare(
          "INSERT INTO support_members(id,workspace_id,email,role,created_at) VALUES('member-b','workspace-b',?,'admin',1)",
        ).run(`${USER}@example.test`);
        db.prepare(
          "INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES('workspace-b',?,?,4)",
        ).run(ORG, USER);
      },
    );
    await expect(
      discoverDeviceSupportQuoteWork(request()),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('postflight also checks delegation for historical-only pages', async () => {
    ticket('source-a');
    proposal('source-a');
    hooks.push(
      () => {},
      () => db.exec('UPDATE support_gestion_links SET enabled=0'),
    );
    await expect(
      discoverDeviceSupportQuoteWork(request()),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each(['lost', 'rollback'] as const)(
    'never treats %s transport failure as an empty page',
    async (value) => {
      ticket('source-a');
      fault = value;
      await expect(
        discoverDeviceSupportQuoteWork(request()),
      ).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual(['source-a']);
    },
  );

  it('missing ledger/evidence schema is unavailable, not no work', async () => {
    db.exec(
      'ALTER TABLE action_engine_quote_publication_evidence RENAME TO unavailable_evidence',
    );
    ticket('source-a');
    await expect(
      discoverDeviceSupportQuoteWork(request()),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('rejects closed-selector accessors without executing their getter or auth SQL', async () => {
    const getter = vi.fn(() => 20);
    const value = Object.defineProperty({}, 'limit', {
      enumerable: true,
      get: getter,
    });
    await expect(
      discoverDeviceSupportQuoteWork(request(), value),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(getter).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { cursor: '' },
    { cursor: 'x=' },
    { sourceId: 'injected' },
    { actor: USER },
  ])('rejects malformed/broad selectors %j before auth', async (value) => {
    await expect(
      discoverDeviceSupportQuoteWork(request(), value),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(queries).toEqual([]);
  });

  it('binds cursors to the current tenant, user and installation instead of trusting client scope', async () => {
    ticket('source-a');
    ticket('source-b');
    const first = await discoverDeviceSupportQuoteWork(request(), { limit: 1 });
    const data = JSON.parse(
      atob(first.nextCursor!.replaceAll('-', '+').replaceAll('_', '/')),
    );
    for (const at of [1, 2, 3]) {
      const changed = [...data];
      changed[at] = 'other-identity';
      const cursor = btoa(JSON.stringify(changed))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
      await expect(
        discoverDeviceSupportQuoteWork(request(), { cursor }),
      ).rejects.toMatchObject({ code: 'invalid_record' });
    }
  });

  it('round-trips a maximum-length Unicode authenticated identity with a bounded UTF-8 cursor', async () => {
    const user = '界'.repeat(160),
      installation = '設'.repeat(160);
    db.prepare('UPDATE device_sessions SET user_id=?,installation_id=?').run(
      user,
      installation,
    );
    db.prepare('UPDATE license_activations SET installation_id=?').run(
      installation,
    );
    db.prepare('UPDATE organization_members SET user_id=?').run(user);
    db.prepare(
      'UPDATE action_engine_quote_settings SET granted_by=?,revision=revision+1',
    ).run(user);
    db.prepare('UPDATE support_workspaces SET owner_id=?').run(user);
    db.prepare('UPDATE support_gestion_links SET connected_by=?').run(user);
    ticket('source-a');
    ticket('source-b');
    const first = await discoverDeviceSupportQuoteWork(request(), { limit: 1 });
    expect(first.nextCursor!.length).toBeLessThanOrEqual(4096);
    expect(
      (
        await discoverDeviceSupportQuoteWork(request(), {
          limit: 1,
          cursor: first.nextCursor,
        })
      ).sourceIds,
    ).toEqual(['source-b']);
  });

  it.each(['wA', '____', btoa('[1, "not canonical"]')])(
    'rejects malformed UTF-8 or noncanonical cursor %s',
    async (cursor) => {
      await expect(
        discoverDeviceSupportQuoteWork(request(), { cursor }),
      ).rejects.toMatchObject({ code: 'invalid_record' });
    },
  );

  it('uses the actual new keyset index within production SQL/binding budgets', async () => {
    ticket('source-a');
    await discoverDeviceSupportQuoteWork(request());
    const statement = statementsSeen.find((s) =>
      s.sql.startsWith('WITH permission'),
    )!;
    expect(statement.values.length).toBeLessThanOrEqual(64);
    expect(statement.sql.length).toBeLessThanOrEqual(16000);
    const details = db
      .prepare('EXPLAIN QUERY PLAN ' + statement.sql)
      .all(...statement.values)
      .map((row) => String(row.detail));
    expect(
      details.some((detail) =>
        detail.includes('support_ticket_work_discovery'),
      ),
    ).toBe(true);
    expect(
      details.some(
        (detail) =>
          detail.includes('support_ticket_work_discovery') &&
          detail.includes('created_at>?'),
      ),
    ).toBe(true);
    expect(details.some((detail) => /^SCAN t(?:$| )/.test(detail))).toBe(false);
  });

  it('detaches request headers before authentication waits', async () => {
    ticket('source-a');
    const input = request();
    const pending = discoverDeviceSupportQuoteWork(input);
    input.headers.set('Authorization', `Bearer zds_${'R'.repeat(43)}`);
    expect((await pending).sourceIds).toEqual(['source-a']);
  });

  it('does not execute getters in malformed D1 rows or leak rejected database text', async () => {
    ticket('source-a');
    const getter = vi.fn(() => {
      throw Error('private database text');
    });
    transform = (raw) => {
      const rows = raw as { results: unknown[] }[];
      Object.defineProperty(rows[1].results[0], 'source_id', {
        enumerable: true,
        get: getter,
      });
      return rows;
    };
    await expect(
      discoverDeviceSupportQuoteWork(request()),
    ).rejects.toMatchObject({
      code: 'invalid_record',
      message: 'invalid_record',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('captures result IDs before the next async guard can mutate the returned transport objects', async () => {
    ticket('source-a');
    transform = (raw) => {
      const row = (raw as { results: Record<string, unknown>[] }[])[1]
        .results[0];
      hooks.push(() => {
        row.source_id = 'forged-after-capture';
      });
      return raw;
    };
    expect((await discoverDeviceSupportQuoteWork(request())).sourceIds).toEqual(
      ['source-a'],
    );
  });
});

const nativeSchemaSuite = process.env.ZENTRA_NATIVE_SOURCE_ROOT
  ? describe
  : describe.skip;
nativeSchemaSuite(
  'canonical completion filtering, actual A6 SQLite/WASM evidence and D1 journal',
  () => {
    async function canonicalSetup(us = false) {
      db.close();
      canonical = makeQuoteConfirmationFixture();
      db = canonical.sql;
      db.function('unixepoch', () => Math.floor(Date.now() / 1000));
      runtime.db = adapter();
      if (us) canonical.seedUsIntent();
      await seedAuthority(
        canonical.actor.organizationId,
        canonical.actor.userId,
        canonical.identity.installationId,
      );
      ticket(canonical.identity.sourceId, 100, canonical.actor.organizationId);
      canonical.seed();
      const fences = canonical.historical();
      const controls = {
        nowSeconds: () => canonical!.native.reservation.createdAt + 20,
        newUuid: canonical.nextId,
      };
      return {
        ...canonical,
        ledger: createD1QuoteLedger(canonical.db, fences.ledgerFence, controls),
        evidence: createD1QuotePublicationEvidence(
          canonical.db,
          fences.evidenceFence,
          controls,
        ),
      };
    }

    it('only hides a truly confirmed canonical receipt, not reservation or publication alone', async () => {
      const q = await canonicalSetup();
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual([q.identity.sourceId]);
      q.seedPublication(q.native.publication);
      await q.evidence.append(q.actor, await q.native.verify());
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual([q.identity.sourceId]);
      await q.ledger.confirmExecution(
        q.actor,
        q.identity.proposalId,
        q.identity.installationId,
        q.identity.reservationId,
        q.native.receipt,
      );
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual([]);
    });

    it('keeps legacy receipt/event rows discoverable when no canonical evidence exists', async () => {
      const q = await canonicalSetup();
      db.prepare(
        'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
      ).run(
        JSON.stringify(q.native.receipt),
        q.native.reservation.createdAt + 20,
        q.identity.reservationId,
      );
      db.prepare(
        'INSERT INTO action_engine_quote_events VALUES(?,?,?,?,?,?,?)',
      ).run(
        q.nextId(),
        q.actor.organizationId,
        q.identity.proposalId,
        q.native.proposal.fingerprint,
        'receipt_confirmed',
        q.actor.userId,
        q.native.reservation.createdAt + 20,
      );
      expect(
        (await discoverDeviceSupportQuoteWork(request())).sourceIds,
      ).toEqual([q.identity.sourceId]);
    });

    it('refuses US intentions even when the historical proposal and commercial grant exist', async () => {
      await canonicalSetup(true);
      await expect(
        discoverDeviceSupportQuoteWork(request()),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  },
);
