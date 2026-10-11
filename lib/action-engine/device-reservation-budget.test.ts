import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY' ? 'rk_live_budget_fixture' : '',
}));

import { hashOpaqueToken } from '@/lib/account-security';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { completePlan } from '@/lib/complete/plans';
import {
  createDeviceQuoteAuthority,
  QUOTE_PREPARATION_CONSENT_VERSION,
} from './production-admission';
import {
  readSupportQuoteSource,
  combineQuotePredicates,
} from './support-source';
import { createPublishedQuoteFences } from './published-fences';
import {
  captureQuotePlan,
  validatePlanningContext,
  validatePlanAgainstContext,
} from './validation';
import { quotePlanFingerprint } from './fingerprint';
import type { QuoteLedgerPredicate } from './ledger-types';

// Only the runtime database/Stripe-key perimeter is substituted. Admission,
// requireDeviceSession, Support delegation/CAS, publication and migrations are
// real. Seeded paid rights are synthetic; this proves local SQL composition,
// not a live payment, PG publication, native write or an HTTP/IPC activation.
const org = 'reservation-budget-company';
const user = 'reservation-budget-owner';
const subscription = 'sub_reservation_budget';
const installation = 'a0000000-0000-4000-8000-000000000001';
const token = `zds_${'A'.repeat(43)}`;
const snapshotId = 'b0000000-0000-4000-8000-000000000001';
const attemptId = 'c0000000-0000-4000-8000-000000000001';
const proposalId = 'd0000000-0000-4000-8000-000000000001';
const reservationId = 'e0000000-0000-4000-8000-000000000001';
const quoteId = 'f0000000-0000-4000-8000-000000000001';
let sql: DatabaseSync;

beforeEach(async () => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  runtime.db = {
    prepare(query: string) {
      let bindings: SQLInputValue[] = [];
      const statement = {
        bind(...values: SQLInputValue[]) {
          bindings = values;
          return statement;
        },
        first: async () => sql.prepare(query).get(...bindings) ?? null,
        all: async () => ({ results: sql.prepare(query).all(...bindings) }),
        run: async () => ({ meta: sql.prepare(query).run(...bindings) }),
      };
      return statement;
    },
  };
  const now = Math.floor(Date.now() / 1000);
  const paid = completePlan('team')!;
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,plan_id,
    entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,livemode,updated_at)
    VALUES(?,'cus_budget','price_budget',?,?,?,'active',?,?,1,?)`)
    .run(
      subscription,
      paid.licensePlan,
      paid.licensePlan,
      paid.seats,
      now + 3600,
      now + 3600,
      now,
    );
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(org, 'Synthetic budget company', subscription, user, now, now);
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('budget-membership',?,?,?,'owner',1)`)
    .run(org, user, 'owner@example.test');
  sql
    .prepare(`INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at)
    VALUES('budget-license',?,?,?,?)`)
    .run(subscription, installation, now, now);
  sql
    .prepare(`INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at)
    VALUES('budget-session',?,?,?,?,?,?,?)`)
    .run(
      await hashOpaqueToken('device-session', token),
      org,
      user,
      installation,
      now,
      now,
      now + 3600,
    );
  sql
    .prepare(`INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id)
    VALUES(?,'team','team',?,?,'in_budget')`)
    .run(subscription, now - 60, now + 3600);
  sql
    .prepare(`INSERT INTO automation_settings(organization_id,enabled,mode,flags,medium_threshold,high_threshold,consent_version,updated_at)
    VALUES(?,1,'suggest','["email_classification"]',0.65,0.95,?,?)`)
    .run(org, AUTOMATION_CONSENT_VERSION, now);
  sql
    .prepare('INSERT INTO automation_platform VALUES(?,?,?,?)')
    .run('features', '["email_classification"]', user, now);
  sql
    .prepare(`INSERT INTO action_engine_quote_settings(organization_id,enabled,consent_version,granted_by,granted_at,updated_at)
    VALUES(?,1,?,?,?,?)`)
    .run(org, QUOTE_PREPARATION_CONSENT_VERSION, user, now, now);
  sql
    .prepare(`INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at)
    VALUES('budget-workspace',?,'Support budget',1,1)`)
    .run(user);
  sql.exec(`INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at)
    VALUES('budget-connection','budget-workspace','infomaniak','fixture','','','','','{}','{}',2)`);
  sql
    .prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at)
    VALUES('budget-workspace',?,?,3)`)
    .run(org, user);
});

afterEach(() => {
  sql.close();
  runtime.db = null;
});

function publication(next = false, commit = true) {
  const id = next ? 'c0000000-0000-4000-8000-000000000002' : attemptId;
  const snapshot = next ? 'b0000000-0000-4000-8000-000000000002' : snapshotId;
  const base = next ? 1 : 0;
  sql
    .prepare(`INSERT INTO action_engine_publication_attempts
    (id,organization_id,snapshot_id,installation_id,user_id,base_revision,archive_sha256,manifest_sha256,size_bytes,state,created_at)
    VALUES(?,?,?,?,?,?,?, ?,100,'pending',1)`)
    .run(
      id,
      org,
      snapshot,
      installation,
      user,
      base,
      'a'.repeat(64),
      'b'.repeat(64),
    );
  if (commit)
    sql
      .prepare(`UPDATE action_engine_publication_attempts
      SET state='committed',result_json=?,settled_at=2 WHERE id=?`)
      .run(
        JSON.stringify({
          committed: true,
          revision: base + 1,
          snapshotId: snapshot,
        }),
        id,
      );
}

async function compose(sourceSize = 256000) {
  const envelope = {
    externalId: 'budget-mail',
    subject: 'Devis',
    body: '3 radiateurs',
    senderEmail: 'client@example.test',
    senderName: 'Client Exemple',
    closed: false,
    padding: '',
  };
  envelope.padding = 'x'.repeat(sourceSize - JSON.stringify(envelope).length);
  const sourceJson = JSON.stringify(envelope);
  expect(sourceJson.length).toBe(sourceSize);
  sql
    .prepare(`INSERT INTO support_tickets
    (id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,created_at,updated_at)
    VALUES('budget-source','budget-workspace','budget-connection','budget-mail','Devis','3 radiateurs',?,'budget-fingerprint',4,4)`)
    .run(sourceJson);
  const authority = await createDeviceQuoteAuthority(
    new Request('https://zentra.example.test/private-action', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'tauri://localhost',
      },
    }),
  );
  const cas = await authority.preflightCas();
  const source = await readSupportQuoteSource(authority.actor, 'budget-source');
  const context = validatePlanningContext({
    organizationId: org,
    revision: 'budget-context',
    currency: 'CHF',
    source: source.source,
    customers: [],
    articles: [
      {
        id: 'radiator',
        revision: 'article-v1',
        organizationId: org,
        name: 'radiateurs',
        description: 'radiateurs',
        sku: '',
        unit: 'piece',
        currency: 'CHF',
        unitPriceCents: 100,
        taxRateBp: 810,
        archived: false,
      },
    ],
  });
  const fences = await createPublishedQuoteFences(authority, cas, {
    context,
    sourceCapability: source,
    admission: cas.admission,
    publication: {
      organizationId: org,
      snapshotId,
      baseRevision: 0,
      revision: 1,
      archiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      firstChunkSha256: 'c'.repeat(64),
      sidecarSha256: 'd'.repeat(64),
      resourcesHash: 'e'.repeat(64),
    },
  });
  const plan = captureQuotePlan({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: org,
    contextRevision: context.revision,
    sourceId: source.source.id,
    sourceRevision: source.revision,
    status: 'ready',
    reasons: [],
    customer: {
      kind: 'new',
      name: 'Client Exemple',
      email: 'client@example.test',
    },
    title: 'Devis',
    currency: 'CHF',
    lines: [
      {
        articleId: 'radiator',
        articleRevision: 'article-v1',
        description: 'radiateurs',
        unit: 'piece',
        quantityMilli: 3000,
        unitPriceCents: 100,
        taxRateBp: 810,
        netCents: 300,
        evidence: '3 radiateurs',
      },
    ],
    netCents: 300,
    confidence: 1,
    requiresHumanValidation: true,
  });
  validatePlanAgainstContext(plan, context);
  const fingerprint = await quotePlanFingerprint(plan);
  publication();
  // Coherent rows under the actual immutable/ready guards. The test does not
  // replace ledger lifecycle coverage; its target is the last scalar/atomic gate.
  sql
    .prepare(`INSERT INTO action_engine_quote_proposals
    (id,organization_id,source_id,action_kind,fingerprint,source_revision,context_revision,plan_json,created_by,created_at)
    VALUES(?,?,?,'prepare_quote_draft',?,?,?,?,?,3)`)
    .run(
      proposalId,
      org,
      source.source.id,
      fingerprint,
      source.revision,
      context.revision,
      JSON.stringify(plan),
      user,
    );
  sql
    .prepare(`INSERT INTO action_engine_quote_reservations
    (id,organization_id,proposal_id,fingerprint,user_id,installation_id,customer_id,quote_id,created_at)
    VALUES(?,?,?,?,?,?,'budget-customer',?,3)`)
    .run(
      reservationId,
      org,
      proposalId,
      fingerprint,
      user,
      installation,
      quoteId,
    );
  // Same six-bound final owner/absence guard as reserveDeviceSupportQuote;
  // no shortened authority or substitute source/publication predicate.
  const finalReservation = {
    sql: `EXISTS(SELECT 1 FROM action_engine_quote_reservations r
      WHERE r.organization_id=? AND r.id=? AND r.proposal_id=? AND r.fingerprint=?
        AND r.user_id=? AND r.installation_id=?
        AND r.receipt_json IS NULL AND NOT EXISTS(
          SELECT 1 FROM action_engine_quote_publication_evidence e
          WHERE e.organization_id=r.organization_id AND e.reservation_id=r.id))`,
    bindings: [org, reservationId, proposalId, fingerprint, user, installation],
  };
  const progression = fences.progression();
  // The country guard is now owned by the shared published fences. Match the
  // actual A8 composition rather than adding the same binding a second time.
  const gate = combineQuotePredicates(progression, finalReservation);
  return {
    gate,
    cas,
    source,
    fingerprint,
    finalReservation,
    progression,
  };
}

function allowed(gate: QuoteLedgerPredicate) {
  return sql
    .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END AS allowed`)
    .get(...gate.bindings)?.allowed;
}

function guardedMutation(gate: QuoteLedgerPredicate) {
  sql.exec('SAVEPOINT budget_write');
  try {
    // The assertion adds one actual bound parameter: 63 + 1 = 64.
    sql
      .prepare(`INSERT INTO action_engine_atomic_assertions(operation_id,allowed)
      SELECT ?,CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END`)
      .run('budget-operation', ...gate.bindings);
    sql.exec(
      "INSERT INTO qa_budget_write VALUES('allowed'); DELETE FROM action_engine_atomic_assertions WHERE operation_id='budget-operation'",
    );
    sql.exec('RELEASE budget_write');
  } catch (error) {
    sql.exec('ROLLBACK TO budget_write; RELEASE budget_write');
    throw error;
  }
}

it.each([1000, 256000])(
  'executes the real final predicate at %i source characters within 64 bindings and 16000 SQL characters',
  async (size) => {
    const { gate, cas, source } = await compose(size);
    expect(cas.predicate().bindings).toHaveLength(30);
    expect(source.predicate('progression').bindings).toHaveLength(
      size === 256000 ? 17 : 14,
    );
    expect(gate.bindings).toHaveLength(size === 256000 ? 63 : 60);
    expect(gate.bindings.length + 1).toBeLessThanOrEqual(64);
    expect(gate.sql.length).toBeLessThanOrEqual(16000);
    expect(
      gate.bindings
        .filter((v) => typeof v === 'string')
        .every((v) => v.length <= 65536),
    ).toBe(true);
    expect(gate.sql.match(/\?/g)).toHaveLength(gate.bindings.length);
    expect(allowed(gate)).toBe(1);
    sql.exec('CREATE TABLE qa_budget_write(id TEXT)');
    expect(() => guardedMutation(gate)).not.toThrow();
    expect(
      sql.prepare('SELECT count(*) AS n FROM qa_budget_write').get()?.n,
    ).toBe(1);
    expect(
      sql
        .prepare('SELECT count(*) AS n FROM action_engine_atomic_assertions')
        .get()?.n,
    ).toBe(0);
    if (size === 256000)
      expect(() =>
        combineQuotePredicates(gate, { sql: '?=?', bindings: [1, 1] }),
      ).toThrow('invalid_context');
  },
);

it.each([
  'source',
  'consent',
  'admission-generation',
  'pending-publication',
  'newer-publication',
  'receipt',
  'different-owner',
] as const)(
  'the maximum-size final predicate atomically refuses %s without leaving a write/assertion',
  async (change) => {
    const { gate, fingerprint, finalReservation, progression } =
      await compose();
    expect(allowed(gate)).toBe(1);
    sql.exec('CREATE TABLE qa_budget_write(id TEXT)');
    if (change === 'source')
      sql.exec(
        "UPDATE support_tickets SET source_json=json_set(source_json,'$.closed',json('true')) WHERE id='budget-source'",
      );
    else if (change === 'consent')
      sql.exec(
        'UPDATE action_engine_quote_settings SET enabled=0,revision=revision+1',
      );
    else if (change === 'admission-generation')
      sql.exec('UPDATE action_engine_quote_settings SET revision=revision+1');
    else if (change === 'pending-publication') publication(true, false);
    else if (change === 'newer-publication') publication(true);
    else if (change === 'receipt')
      sql
        .prepare(
          `UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=4 WHERE id=?`,
        )
        .run(
          JSON.stringify({
            organizationId: org,
            proposalId,
            fingerprint,
            customerId: 'budget-customer',
            quoteId,
            quoteNumber: null,
            status: 'draft',
            requiresHumanValidation: true,
          }),
          reservationId,
        );
    else {
      // Test the final guard's owner correlation without corrupting immutable rows.
      const foreign = {
        ...finalReservation,
        bindings: [
          ...finalReservation.bindings.slice(0, 5),
          'a0000000-0000-4000-8000-000000000002',
        ],
      };
      const wrongOwner = combineQuotePredicates(progression, foreign);
      expect(wrongOwner.bindings).toHaveLength(63);
      expect(allowed(wrongOwner)).toBe(0);
      expect(() => guardedMutation(wrongOwner)).toThrow(/CHECK/);
      expect(
        sql.prepare('SELECT count(*) AS n FROM qa_budget_write').get()?.n,
      ).toBe(0);
      expect(
        sql
          .prepare('SELECT count(*) AS n FROM action_engine_atomic_assertions')
          .get()?.n,
      ).toBe(0);
      return;
    }
    expect(allowed(gate)).toBe(0);
    expect(() => guardedMutation(gate)).toThrow(/CHECK/);
    expect(
      sql.prepare('SELECT count(*) AS n FROM qa_budget_write').get()?.n,
    ).toBe(0);
    expect(
      sql
        .prepare('SELECT count(*) AS n FROM action_engine_atomic_assertions')
        .get()?.n,
    ).toBe(0);
  },
);
