import { createHash } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  db: null as unknown,
  stripeKey: 'rk_live_activity_fixture',
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
    key === 'STRIPE_SECRET_KEY' ? runtime.stripeKey : '',
}));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: () => {
    throw Error('No external PostgreSQL in private activity QA');
  },
}));

import { hashOpaqueToken } from '@/lib/account-security';
import { makeQuoteConfirmationFixture } from './confirmation-records.fixture';
import { createD1QuoteLedger } from './ledger';
import { createD1QuotePublicationEvidence } from './quote-publication-evidence';
import { readDeviceConfirmedQuoteActivity } from './confirmed-quote-activity';

// Actual cumulative SQLite migrations, actual device admission/delegation SQL,
// canonical verifier/evidence/ledger for the principal creation fixture. The D1
// transport and clock are local adapters; pagination extras are coherent stored
// SQL fixtures, not additional native executions or independently verified ZIPs.
// No route, provider, PG/Storage, notification or native executable is involved.
const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
const NOW = 1791720060;
const TOKEN = `zds_${'A'.repeat(43)}`;
let f: ReturnType<typeof makeQuoteConfirmationFixture>;
let hooks: Array<() => void | Promise<void>>;
let fault: 'lost' | null;
let transform: ((results: unknown[]) => unknown[]) | null;
let queries: string[];
type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => Statement;
};

function adapter(sql: typeof f.sql) {
  return {
    prepare(query: string) {
      const s = {
        sql: query,
        values: [] as SQLInputValue[],
        bind(...values: SQLInputValue[]) {
          s.values = [...values];
          return s;
        },
        async first() {
          queries.push(query);
          return sql.prepare(query).get(...s.values) ?? null;
        },
        async run() {
          queries.push(query);
          return { meta: sql.prepare(query).run(...s.values) };
        },
      };
      return s;
    },
    async batch(statements: Statement[]) {
      const hook = hooks.shift(),
        failure = fault,
        mutate = transform;
      fault = null;
      transform = null;
      if (hook) await hook();
      sql.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const results = statements.map((s) => {
          queries.push(s.sql);
          return {
            success: true,
            results: sql.prepare(s.sql).all(...s.values),
            meta: { changes: 0 },
          };
        });
        sql.exec('COMMIT');
        committed = true;
        if (failure === 'lost')
          throw Error('Private lost SQL result with token-like secret');
        return mutate ? mutate(results) : results;
      } catch (error) {
        if (!committed) sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
function request(token = TOKEN) {
  return new Request('https://zentra.invalid/private-confirmed-activity', {
    headers: { Authorization: `Bearer ${token}`, Origin: 'tauri://localhost' },
  });
}
async function seedAuthority() {
  const { organizationId: org, userId: user } = f.actor;
  const subscription = `sub_${org}`;
  f.sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
    VALUES(?,?,'price_activity','zentra-start-monthly-59-chf','zentra-start-monthly-59-chf',3,'active',?,?,1,?)`)
    .run(subscription, `cus_${org}`, NOW + 3600, NOW + 3600, NOW);
  f.sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(org, 'Synthetic company', subscription, user, NOW, NOW);
  f.sql
    .prepare(
      `INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,'owner',1)`,
    )
    .run('activity-owner', org, user, 'owner@example.test');
  f.sql
    .prepare(
      `INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES(?,?,?,?,?)`,
    )
    .run('activity-license', subscription, f.identity.installationId, NOW, NOW);
  f.sql
    .prepare(
      `INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(
      'activity-session',
      await hashOpaqueToken('device-session', TOKEN),
      org,
      user,
      f.identity.installationId,
      NOW - 60,
      NOW,
      NOW + 3600,
    );
  f.sql
    .prepare(
      `INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id) VALUES(?,'team','team',?,?,?)`,
    )
    .run(subscription, NOW - 60, NOW + 3600, 'in_activity');
  seedSupport('workspace', org, user);
  ticket(f.native.source.id);
}
function seedSupport(
  workspace: string,
  org = f.actor.organizationId,
  user = f.actor.userId,
  linked = true,
) {
  const owner = workspace === 'workspace' ? user : `qa-owner-${workspace}`;
  f.sql
    .prepare(
      `INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES(?,?,'Synthetic Support','review',1,1)`,
    )
    .run(workspace, owner);
  if (owner !== user) {
    const member = f.sql
      .prepare(
        'SELECT email FROM organization_members WHERE organization_id=? AND user_id=?',
      )
      .get(org, user)!;
    f.sql
      .prepare("INSERT INTO support_members VALUES(?,?,?,'admin',1)")
      .run(`support-member-${workspace}`, workspace, member.email as string);
  }
  f.sql
    .prepare(
      `INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,'api','Synthetic','','','','','{}','{}',2)`,
    )
    .run(`connection-${workspace}`, workspace);
  if (linked)
    f.sql
      .prepare(
        `INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,3)`,
      )
      .run(workspace, org, user);
}
function ticket(id: string, workspace = 'workspace') {
  f.sql
    .prepare(`INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,decision_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'private mail body','{}',?,'routed','{}',1,1)`)
    .run(
      id,
      workspace,
      `connection-${workspace}`,
      id,
      'Private subject not returned',
      `private-source-${id}`,
    );
}
async function confirmPrincipal() {
  f.seed();
  f.seedPublication(f.native.publication);
  await createD1QuotePublicationEvidence(
    f.db,
    f.historical().evidenceFence,
  ).append(f.actor, await f.native.verify());
  await createD1QuoteLedger(f.db, f.historical().ledgerFence).confirmExecution(
    f.actor,
    f.identity.proposalId,
    f.identity.installationId,
    f.identity.reservationId,
    f.native.receipt,
  );
}
function storedExtra(
  index: number,
  org = f.actor.organizationId,
  workspace = 'workspace',
) {
  const id = `extra-${String(index).padStart(3, '0')}`;
  const quoteId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const reservationId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const plan = { ...f.native.proposal.plan, organizationId: org, sourceId: id };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(plan))
    .digest('hex');
  const receipt = {
    ...f.native.receipt,
    organizationId: org,
    proposalId: id,
    fingerprint,
    quoteId,
  };
  const creation = f.native.reservation.createdAt;
  ticket(id, workspace);
  f.sql
    .prepare(
      'INSERT INTO action_engine_quote_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      org,
      id,
      plan.kind,
      fingerprint,
      plan.sourceRevision,
      plan.contextRevision,
      JSON.stringify(plan),
      f.actor.userId,
      creation - 1,
    );
  f.sql
    .prepare(
      `INSERT INTO action_engine_quote_reservations(id,organization_id,proposal_id,fingerprint,user_id,installation_id,customer_id,quote_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      reservationId,
      org,
      id,
      fingerprint,
      f.actor.userId,
      f.identity.installationId,
      receipt.customerId,
      quoteId,
      creation,
    );
  const b = f.native.binding,
    h = b.planningPublication;
  f.sql
    .prepare(
      'INSERT INTO action_engine_quote_reservation_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      reservationId,
      org,
      id,
      fingerprint,
      b.resourcesSha256,
      b.sourceCanonicalSha256,
      h.snapshotId,
      h.revision,
      h.baseRevision,
      h.archiveSha256,
      h.manifestSha256,
      creation,
    );
  const eventId = `activity-${String(index).padStart(3, '0')}`;
  const e = f.sql
    .prepare('SELECT * FROM action_engine_quote_publication_evidence LIMIT 1')
    .get()!;
  f.sql
    .prepare(
      `INSERT INTO action_engine_quote_publication_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      org,
      id,
      id,
      reservationId,
      fingerprint,
      f.actor.userId,
      f.identity.installationId,
      receipt.customerId,
      quoteId,
      e.publication_attempt_id as string,
      e.snapshot_id as string,
      e.base_revision as number,
      e.revision as number,
      e.archive_sha256 as string,
      e.manifest_sha256 as string,
      e.sqlite_sha256 as string,
      createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
      e.canonical_facts_sha256 as string,
      'quote-canonical-v1',
      JSON.stringify(receipt),
      NOW,
    );
  f.sql
    .prepare(
      'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
    )
    .run(JSON.stringify(receipt), NOW, reservationId);
  f.sql
    .prepare('INSERT INTO action_engine_quote_events VALUES(?,?,?,?,?,?,?)')
    .run(
      eventId,
      org,
      id,
      fingerprint,
      'receipt_confirmed',
      f.actor.userId,
      NOW,
    );
  return { id, eventId, quoteId, reservationId };
}
function mutation(query: string) {
  return () => {
    f.sql.exec(query);
  };
}
function rewrite(table: string, query: string) {
  const triggers = f.sql
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
    )
    .all(table);
  for (const t of triggers)
    f.sql.exec(`DROP TRIGGER "${String(t.name).replaceAll('"', '""')}"`);
  f.sql.exec(query);
}
function alterRows(change: (row: Record<string, unknown>) => unknown) {
  transform = (results) =>
    results.map((result, index) => {
      const current = result as { results: Record<string, unknown>[] };
      return index === 1
        ? { ...current, results: current.results.map(change) }
        : result;
    });
}

beforeEach(async () => {
  if (!process.env.ZENTRA_NATIVE_SOURCE_ROOT) return;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW * 1000));
  hooks = [];
  fault = null;
  transform = null;
  queries = [];
  runtime.stripeKey = 'rk_live_activity_fixture';
  f = makeQuoteConfirmationFixture();
  f.sql.function('unixepoch', () => Math.floor(Date.now() / 1000));
  runtime.db = adapter(f.sql);
  await seedAuthority();
});
afterEach(() => {
  f?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

suite(
  'private canonical confirmed quote activity, cumulative real SQLite',
  () => {
    it('projects a real verifier/evidence/ledger confirmation with only closed historical metadata', async () => {
      await confirmPrincipal();
      const result = await readDeviceConfirmedQuoteActivity(request());
      const event = f.sql
        .prepare(
          "SELECT id FROM action_engine_quote_events WHERE event_type='receipt_confirmed'",
        )
        .get()!;
      expect(result).toEqual({
        organizationId: f.actor.organizationId,
        items: [
          {
            activityId: event.id,
            proposalId: f.identity.proposalId,
            quoteId: f.native.receipt.quoteId,
            confirmedAt: NOW,
            kind: 'quote_draft_created',
            requiresHumanValidation: true,
          },
        ],
        nextCursor: null,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.items[0])).toBe(true);
      const raw = JSON.stringify(result);
      for (const value of [
        'reservationId',
        'fingerprint',
        'sourceId',
        'senderEmail',
        'actor',
        'installation',
        'private mail',
        TOKEN,
        'unitPriceCents',
        'status',
      ])
        expect(raw).not.toContain(value);
      expect(
        queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q)),
      ).toEqual([]);
    });
    it('does not promote a reserved execution or transport publication into success', async () => {
      f.seed();
      f.seedPublication(f.native.publication);
      expect((await readDeviceConfirmedQuoteActivity(request())).items).toEqual(
        [],
      );
    });
    it('does not promote a legacy receipt and event without canonical evidence', async () => {
      f.seed();
      f.sql
        .prepare(
          'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=?',
        )
        .run(JSON.stringify(f.native.receipt), NOW);
      f.sql
        .prepare('INSERT INTO action_engine_quote_events VALUES(?,?,?,?,?,?,?)')
        .run(
          'legacy-event',
          f.actor.organizationId,
          f.identity.proposalId,
          f.native.proposal.fingerprint,
          'receipt_confirmed',
          f.actor.userId,
          NOW,
        );
      expect((await readDeviceConfirmedQuoteActivity(request())).items).toEqual(
        [],
      );
    });
    it('does not expose evidence before the durable ledger confirmation and its event', async () => {
      f.seed();
      f.seedPublication(f.native.publication);
      await createD1QuotePublicationEvidence(
        f.db,
        f.historical().evidenceFence,
      ).append(f.actor, await f.native.verify());
      expect((await readDeviceConfirmedQuoteActivity(request())).items).toEqual(
        [],
      );
    });
    it('keeps historical activity after source edits, connector closure, pause and a later publication', async () => {
      await confirmPrincipal();
      const before = await readDeviceConfirmedQuoteActivity(request());
      f.sql.exec(
        "UPDATE support_tickets SET body='changed',source_json='{\"closed\":true}',revision=revision+1; UPDATE support_connections SET active=0; UPDATE support_workspaces SET mode='paused'",
      );
      const snapshotId = f.nextId();
      f.seedPublication({
        ...f.native.publication,
        id: f.nextId(),
        snapshotId,
        baseRevision: 5,
        result: { committed: true, revision: 6, snapshotId },
        createdAt: NOW + 1,
        settledAt: NOW + 2,
      });
      expect(await readDeviceConfirmedQuoteActivity(request())).toEqual(before);
    });
    it('allows a different currently authorized company member and installation without transferring ownership', async () => {
      await confirmPrincipal();
      const installation = '00000000-0000-4000-8000-000000008002';
      f.sql
        .prepare(
          "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('activity-reader',?,'reader','reader@example.test','admin',2)",
        )
        .run(f.actor.organizationId);
      f.sql
        .prepare(
          "INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES('reader-license',?,?,?,?)",
        )
        .run(`sub_${f.actor.organizationId}`, installation, NOW, NOW);
      f.sql
        .prepare(
          "UPDATE device_sessions SET user_id='reader',installation_id=?",
        )
        .run(installation);
      expect(
        (await readDeviceConfirmedQuoteActivity(request())).items,
      ).toHaveLength(1);
      expect(
        f.sql
          .prepare(
            'SELECT user_id,installation_id FROM action_engine_quote_reservations',
          )
          .get(),
      ).toMatchObject({
        user_id: f.actor.userId,
        installation_id: f.identity.installationId,
      });
    });
    it('does not require write opt-in or a coordination allowlist to read established history', async () => {
      await confirmPrincipal();
      // Neither action_settings nor automation settings/allowlist was seeded.
      expect(
        (await readDeviceConfirmedQuoteActivity(request())).items,
      ).toHaveLength(1);
    });
    it('paginates more than 25 creations in stable binary order, including equal timestamps', async () => {
      await confirmPrincipal();
      for (let at = 1; at <= 29; at++) storedExtra(at);
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const result = await readDeviceConfirmedQuoteActivity(request(), {
          limit: 7,
          cursor,
        });
        ids.push(...result.items.map((item) => item.activityId));
        cursor = result.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(5);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
      expect(ids).toEqual([...ids].sort());
      expect(
        (await readDeviceConfirmedQuoteActivity(request(), { limit: 50 }))
          .items,
      ).toHaveLength(30);
    });
    it('returns null cursor at an exact page boundary and admits empty history', async () => {
      expect(
        await readDeviceConfirmedQuoteActivity(request(), { limit: 1 }),
      ).toEqual({
        organizationId: f.actor.organizationId,
        items: [],
        nextCursor: null,
      });
      await confirmPrincipal();
      expect(
        (await readDeviceConfirmedQuoteActivity(request(), { limit: 1 }))
          .nextCursor,
      ).toBeNull();
    });
    it('binds a canonical cursor to the current organization, user and installation', async () => {
      await confirmPrincipal();
      storedExtra(1);
      const first = await readDeviceConfirmedQuoteActivity(request(), {
        limit: 1,
      });
      const decoded = JSON.parse(
        Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
      ) as unknown[];
      for (const at of [1, 2, 3]) {
        const changed = [...decoded];
        changed[at] = 'other-identity';
        await expect(
          readDeviceConfirmedQuoteActivity(request(), {
            cursor: Buffer.from(JSON.stringify(changed)).toString('base64url'),
          }),
        ).rejects.toMatchObject({ code: 'invalid_record' });
      }
      await expect(
        readDeviceConfirmedQuoteActivity(request(), {
          cursor: first.nextCursor! + '=',
        }),
      ).rejects.toMatchObject({ code: 'invalid_record' });
    });
    it.each([0, 51, 1.5, '2', NaN])(
      'rejects invalid limit %s before database access',
      async (limit) => {
        await expect(
          readDeviceConfirmedQuoteActivity(request(), { limit }),
        ).rejects.toMatchObject({ code: 'invalid_record' });
        expect(queries).toEqual([]);
      },
    );
    it('rejects unknown fields and accessors without reading them', async () => {
      await expect(
        readDeviceConfirmedQuoteActivity(request(), {
          organizationId: 'other',
        }),
      ).rejects.toMatchObject({ code: 'invalid_record' });
      const get = vi.fn(() => 1);
      await expect(
        readDeviceConfirmedQuoteActivity(
          request(),
          Object.defineProperty({}, 'limit', { enumerable: true, get }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_record' });
      expect(get).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    });
    it.each([
      'UPDATE organization_members SET revoked_at=1791720060',
      'UPDATE device_sessions SET revoked_at=1791720060',
      'UPDATE subscriptions SET entitlement_valid_until=1',
      'UPDATE license_activations SET revoked_at=1791720060',
      'UPDATE support_gestion_links SET enabled=0',
    ])('refuses a fresh revoked read capability: %s', async (query) => {
      await confirmPrincipal();
      hooks.push(mutation(query));
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
    it('refuses an actual US creation intention rather than returning empty or historic success', async () => {
      f.close();
      f = makeQuoteConfirmationFixture();
      f.sql.function('unixepoch', () => NOW);
      runtime.db = adapter(f.sql);
      // Actual 0085 refuses creating an intention for an existing organization.
      // Create the valid intention first, then seed QA legacy commercial rows.
      f.seedUsIntent();
      await seedAuthority();
      // A7 itself refuses producing canonical evidence for this US intention;
      // retain only the historic proposal/reservation and require denial, not []
      // from this reader under otherwise admissible QA commercial/session rows.
      f.seed();
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
    it('refuses authority removal after the first successful page and after a rejected read', async () => {
      await confirmPrincipal();
      hooks.push(
        () => {},
        mutation('UPDATE support_gestion_links SET enabled=0'),
      );
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({ code: 'forbidden' });
      f.sql.exec('UPDATE support_gestion_links SET enabled=1');
      hooks.push(
        () => {},
        mutation('UPDATE support_gestion_links SET enabled=0'),
      );
      fault = 'lost';
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
    it('rechecks the exact workspace after retargeting rather than accepting another delegated link', async () => {
      await confirmPrincipal();
      seedSupport(
        'other-workspace',
        f.actor.organizationId,
        f.actor.userId,
        false,
      );
      hooks.push(
        () => {},
        mutation(
          "UPDATE support_gestion_links SET workspace_id='other-workspace' WHERE workspace_id='workspace'",
        ),
      );
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({ code: 'conflict' });
    });
    it('never returns a row whose source belongs to a different company', async () => {
      await confirmPrincipal();
      f.sql
        .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
      VALUES('sub_other','cus_other','price_activity','zentra-start-monthly-59-chf','zentra-start-monthly-59-chf',3,'active',?,?,1,?)`)
        .run(NOW + 3600, NOW + 3600, NOW);
      f.sql
        .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
        .run('other-company', 'Other', 'sub_other', f.actor.userId, NOW, NOW);
      f.sql.exec(
        "UPDATE support_gestion_links SET organization_id='other-company'",
      );
      seedSupport('still-authorized');
      expect((await readDeviceConfirmedQuoteActivity(request())).items).toEqual(
        [],
      );
    });
    it('does not return deleted historical sources whose workspace access can no longer be established', async () => {
      await confirmPrincipal();
      f.sql.exec('DELETE FROM support_tickets');
      expect((await readDeviceConfirmedQuoteActivity(request())).items).toEqual(
        [],
      );
      expect(
        f.sql
          .prepare(
            "SELECT count(*) n FROM action_engine_quote_events WHERE event_type='receipt_confirmed'",
          )
          .get()?.n,
      ).toBe(1);
    });
    it('keeps the historical creation fact after the actual local quote has been edited or issued', async () => {
      await confirmPrincipal();
      const before = await readDeviceConfirmedQuoteActivity(request());
      f.native.sql.exec(
        "UPDATE quotes SET title='Edited document',status='sent',number='Q-42'",
      );
      expect(await readDeviceConfirmedQuoteActivity(request())).toEqual(before);
      expect(before.items[0]).not.toHaveProperty('status');
    });
    it('does not disclose SQL, tokens or silently fall back when a proof table is unavailable', async () => {
      await confirmPrincipal();
      f.sql.exec(
        'ALTER TABLE action_engine_quote_publication_evidence RENAME TO missing_evidence',
      );
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({
        code: 'service_unavailable',
        message: 'service_unavailable',
      });
    });
    it('masks a lost read result and permits an explicit identical retry without writing activity', async () => {
      await confirmPrincipal();
      fault = 'lost';
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({
        code: 'service_unavailable',
        message: 'service_unavailable',
      });
      expect(
        (await readDeviceConfirmedQuoteActivity(request())).items,
      ).toHaveLength(1);
      expect(
        f.sql
          .prepare(
            "SELECT count(*) AS n FROM action_engine_quote_events WHERE event_type='receipt_confirmed'",
          )
          .get()?.n,
      ).toBe(1);
    });
    it.each([
      [
        'event actor',
        'action_engine_quote_events',
        "UPDATE action_engine_quote_events SET actor_user_id='wrong' WHERE event_type='receipt_confirmed'",
      ],
      [
        'receipt',
        'action_engine_quote_reservations',
        "UPDATE action_engine_quote_reservations SET receipt_json=json_set(receipt_json,'$.extra','forged')",
      ],
      [
        'proof actor',
        'action_engine_quote_publication_evidence',
        "UPDATE action_engine_quote_publication_evidence SET user_id='wrong'",
      ],
      [
        'publication actor',
        'action_engine_publication_attempts',
        "UPDATE action_engine_publication_attempts SET user_id='wrong' WHERE base_revision=4",
      ],
      [
        'planning witness',
        'action_engine_publication_attempts',
        "UPDATE action_engine_publication_attempts SET archive_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE base_revision=3",
      ],
    ])(
      'never turns externally corrupted %s into canonical activity',
      async (_name, table, query) => {
        await confirmPrincipal();
        // Disposable QA database only: explicit trigger removal models corruption,
        // rather than pretending a normal supported DML operation can mutate history.
        rewrite(table, query);
        expect(
          (await readDeviceConfirmedQuoteActivity(request())).items,
        ).toEqual([]);
      },
    );
    it('rejects hostile or malformed database rows and never invokes getters', async () => {
      await confirmPrincipal();
      const get = vi.fn(() => f.native.receipt.quoteId);
      alterRows((row) =>
        Object.defineProperty({ ...row }, 'quote_id', {
          enumerable: true,
          get,
        }),
      );
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({ code: 'invalid_record' });
      expect(get).not.toHaveBeenCalled();
      alterRows((row) => ({ ...row, quote_id: 'not-a-uuid' }));
      await expect(
        readDeviceConfirmedQuoteActivity(request()),
      ).rejects.toMatchObject({ code: 'invalid_record' });
    });
    it('captures caller options before authentication awaits and reopens the same durable activity', async () => {
      await confirmPrincipal();
      storedExtra(1);
      const options = { limit: 1, cursor: null };
      const pending = readDeviceConfirmedQuoteActivity(request(), options);
      options.limit = 50;
      expect((await pending).items).toHaveLength(1);
      const first = await readDeviceConfirmedQuoteActivity(request());
      const reopened = f.connect();
      reopened.function('unixepoch', () => NOW);
      runtime.db = adapter(reopened);
      expect(await readDeviceConfirmedQuoteActivity(request())).toEqual(first);
    });
  },
);
