import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createD1QuoteLedger } from './ledger';
import { quotePlanFingerprint } from './engine';
import type {
  ActionActor,
  ActionAdmission,
  DraftQuoteReceipt,
  QuotePlan,
} from './types';
import type {
  QuoteLedgerFence,
  QuoteExecutionReservation,
} from './ledger-types';

// Exercise the exact workerd/Miniflare supplied by pinned Wrangler, not a JS map.
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
let runtime: {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
};
let db: D1Database;
const actor: ActionActor = {
  organizationId: 'fixture-company',
  userId: 'fixture-owner',
};
const admission: ActionAdmission = {
  ...actor,
  revision: 'rights-v1',
  automationActive: true,
  mayPrepareQuote: true,
};
const fence: QuoteLedgerFence = async (request) => {
  const bindings: (string | number | null)[] = [
    request.actor.organizationId,
    request.actor.userId,
  ];
  let sql =
    'EXISTS(SELECT 1 FROM qa_action_rights WHERE organization_id=? AND user_id=? AND active=1';
  if (request.operation === 'save' || request.operation === 'reserve') {
    sql += ' AND source_revision=? AND context_revision=?';
    bindings.push(
      request.proposal.plan.sourceRevision,
      request.proposal.plan.contextRevision,
    );
  }
  sql += ')';
  if (request.operation === 'confirm') {
    sql +=
      ' AND EXISTS(SELECT 1 FROM qa_verified_publications WHERE organization_id=? AND receipt_json=?)';
    bindings.push(
      request.actor.organizationId,
      JSON.stringify(request.receipt),
    );
  }
  return { sql, bindings };
};
function plan(sourceId: string): QuotePlan {
  return {
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: actor.organizationId,
    contextRevision: 'catalogue-v1',
    sourceId,
    sourceRevision: 'mail-v1',
    status: 'ready',
    reasons: [],
    customer: {
      kind: 'new',
      name: 'Camille Exemple',
      email: 'camille@example.test',
    },
    title: 'Installer des radiateurs',
    currency: 'CHF',
    lines: [
      {
        articleId: 'radiator',
        articleRevision: 'article-v1',
        description: 'Radiateur',
        unit: 'pièce',
        quantityMilli: 3000,
        unitPriceCents: 19900,
        taxRateBp: 810,
        netCents: 59700,
        evidence: 'Installer 3 radiateurs',
      },
    ],
    netCents: 59700,
    confidence: 0.99,
    requiresHumanValidation: true,
  };
}
async function saved(sourceId: string) {
  const value = plan(sourceId);
  return createD1QuoteLedger(db, fence).saveProposal(
    actor,
    value,
    await quotePlanFingerprint(value),
    admission,
  );
}
function receipt(reservation: QuoteExecutionReservation): DraftQuoteReceipt {
  return {
    organizationId: reservation.organizationId,
    proposalId: reservation.proposalId,
    fingerprint: reservation.fingerprint,
    customerId: reservation.customerId,
    quoteId: reservation.quoteId,
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  };
}
beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script:
      'export default { fetch() { return new Response("Local Action Engine QA"); } }',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  db = await runtime.getD1Database('DB');
  const migration = readFileSync(
    new URL(
      '../../drizzle/0099_action_engine_quote_ledger.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const statement of migration
    .split('--> statement-breakpoint')
    .map((value) => value.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
  await db
    .prepare(
      'CREATE TABLE qa_action_rights(organization_id TEXT,user_id TEXT,active INTEGER,source_revision TEXT,context_revision TEXT)',
    )
    .run();
  await db
    .prepare(
      "INSERT INTO qa_action_rights VALUES(?,?,1,'mail-v1','catalogue-v1')",
    )
    .bind(actor.organizationId, actor.userId)
    .run();
  await db
    .prepare(
      'CREATE TABLE qa_verified_publications(organization_id TEXT,receipt_json TEXT)',
    )
    .run();
}, 20000);
afterAll(async () => {
  if (runtime) await runtime.dispose();
});

it('applies the migration in D1 and rolls back a false or NULL fence', async () => {
  for (const denied of ['0', 'NULL']) {
    const value = plan('denied-' + denied),
      ledger = createD1QuoteLedger(db, async () => ({
        sql: denied,
        bindings: [],
      }));
    await expect(
      ledger.saveProposal(
        actor,
        value,
        await quotePlanFingerprint(value),
        admission,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await db
        .prepare(
          'SELECT count(*) n FROM action_engine_quote_proposals WHERE source_id=?',
        )
        .bind(value.sourceId)
        .first(),
    ).toEqual({ n: 0 });
  }
  expect(
    await db
      .prepare('SELECT count(*) n FROM action_engine_atomic_assertions')
      .first(),
  ).toEqual({ n: 0 });
});

it('serializes concurrent saves and two installations using permanent stable IDs', async () => {
  const [first, second] = await Promise.all([
    saved('concurrent'),
    saved('concurrent'),
  ]);
  expect(second).toEqual(first);
  const ledger = createD1QuoteLedger(db, fence);
  const results = await Promise.all([
    ledger.reserveExecution(actor, first.id, 'pc'),
    ledger.reserveExecution(actor, first.id, 'iphone'),
  ]);
  expect(results.filter((result) => result.state === 'reserved')).toHaveLength(
    1,
  );
  expect(results.filter((result) => result.state === 'held')).toHaveLength(1);
  const winner = results.find((result) => result.state === 'reserved');
  if (!winner || winner.state !== 'reserved') throw new Error('No reservation');
  const replay = await createD1QuoteLedger(db, fence, {
    nowSeconds: () => 253402300799,
  }).reserveExecution(actor, first.id, winner.reservation.installationId);
  expect(replay).toEqual(winner);
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM action_engine_quote_events WHERE proposal_id=? AND event_type='execution_reserved'",
      )
      .bind(first.id)
      .first(),
  ).toEqual({ n: 1 });
});

it('does not acknowledge an unproven native claim; confirms once after verified publication', async () => {
  const stored = await saved('confirm'),
    ledger = createD1QuoteLedger(db, fence),
    result = await ledger.reserveExecution(actor, stored.id, 'pc-confirm');
  if (result.state !== 'reserved') throw new Error('No reservation');
  const claim = receipt(result.reservation);
  await expect(
    ledger.confirmExecution(
      actor,
      stored.id,
      'pc-confirm',
      result.reservation.id,
      claim,
    ),
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(
    await db
      .prepare(
        'SELECT receipt_json FROM action_engine_quote_reservations WHERE proposal_id=?',
      )
      .bind(stored.id)
      .first(),
  ).toEqual({ receipt_json: null });
  await db
    .prepare('INSERT INTO qa_verified_publications VALUES(?,?)')
    .bind(actor.organizationId, JSON.stringify(claim))
    .run();
  expect(
    await ledger.confirmExecution(
      actor,
      stored.id,
      'pc-confirm',
      result.reservation.id,
      claim,
    ),
  ).toEqual(claim);
  await db
    .prepare(
      "UPDATE qa_action_rights SET context_revision='catalogue-v2',source_revision='mail-v2'",
    )
    .run();
  expect(
    await ledger.confirmExecution(
      actor,
      stored.id,
      'pc-confirm',
      result.reservation.id,
      claim,
    ),
  ).toEqual(claim);
  expect(
    await ledger.reserveExecution(actor, stored.id, 'another-device'),
  ).toEqual({ state: 'confirmed', receipt: claim });
  expect(
    await db
      .prepare(
        'SELECT count(*) n FROM action_engine_quote_events WHERE proposal_id=?',
      )
      .bind(stored.id)
      .first(),
  ).toEqual({ n: 3 });
  await db
    .prepare(
      "UPDATE qa_action_rights SET context_revision='catalogue-v1',source_revision='mail-v1'",
    )
    .run();
});

it('rolls back the reservation and assertion when the audit write fails', async () => {
  const stored = await saved('rollback');
  await db
    .prepare(
      `CREATE TRIGGER qa_fail_action_audit BEFORE INSERT ON action_engine_quote_events WHEN NEW.proposal_id='${stored.id}' AND NEW.event_type='execution_reserved' BEGIN SELECT RAISE(ABORT,'qa_failure'); END`,
    )
    .run();
  await expect(
    createD1QuoteLedger(db, fence).reserveExecution(
      actor,
      stored.id,
      'pc-rollback',
    ),
  ).rejects.toMatchObject({ code: 'service_unavailable' });
  expect(
    await db
      .prepare(
        'SELECT count(*) n FROM action_engine_quote_reservations WHERE proposal_id=?',
      )
      .bind(stored.id)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await db
      .prepare('SELECT count(*) n FROM action_engine_atomic_assertions')
      .first(),
  ).toEqual({ n: 0 });
  await db.prepare('DROP TRIGGER qa_fail_action_audit').run();
});

it('blocks UPDATE, DELETE and OR REPLACE even without recursive triggers', async () => {
  const stored = await saved('immutable');
  await db.prepare('PRAGMA recursive_triggers=OFF').run();
  await expect(
    db
      .prepare(
        'UPDATE action_engine_quote_proposals SET source_revision=? WHERE id=?',
      )
      .bind('tampered', stored.id)
      .run(),
  ).rejects.toThrow('action_engine_proposal_immutable');
  await expect(
    db
      .prepare('DELETE FROM action_engine_quote_proposals WHERE id=?')
      .bind(stored.id)
      .run(),
  ).rejects.toThrow('action_engine_proposal_immutable');
  await expect(
    db
      .prepare(
        'INSERT OR REPLACE INTO action_engine_quote_proposals SELECT * FROM action_engine_quote_proposals WHERE id=?',
      )
      .bind(stored.id)
      .run(),
  ).rejects.toThrow('action_engine_proposal_immutable');
  expect(
    await createD1QuoteLedger(db, fence).loadProposal(actor, stored.id),
  ).toEqual(stored);
});

it('blocks OR REPLACE through the quote-ID unique key without deleting the original reservation', async () => {
  const first = await saved('replace-quote-first'),
    second = await saved('replace-quote-second');
  const ledger = createD1QuoteLedger(db, fence),
    result = await ledger.reserveExecution(actor, first.id, 'pc-replace');
  if (result.state !== 'reserved') throw new Error('No reservation');
  await db.prepare('PRAGMA recursive_triggers=OFF').run();
  await expect(
    db
      .prepare(`INSERT OR REPLACE INTO action_engine_quote_reservations(id,organization_id,proposal_id,fingerprint,user_id,installation_id,customer_id,quote_id,created_at)
    SELECT ?,organization_id,?,?,user_id,installation_id,customer_id,quote_id,created_at FROM action_engine_quote_reservations WHERE proposal_id=?`)
      .bind(crypto.randomUUID(), second.id, second.fingerprint, first.id)
      .run(),
  ).rejects.toThrow('action_engine_reservation_immutable');
  expect(await ledger.reserveExecution(actor, first.id, 'pc-replace')).toEqual(
    result,
  );
  expect(
    await db
      .prepare(
        'SELECT count(*) n FROM action_engine_quote_reservations WHERE proposal_id=?',
      )
      .bind(second.id)
      .first(),
  ).toEqual({ n: 0 });
});

it('has no implicit rowid identity through which REPLACE could bypass logical-key guards', async () => {
  for (const table of [
    'action_engine_quote_proposals',
    'action_engine_quote_reservations',
    'action_engine_quote_events',
  ]) {
    const definition = await db
      .prepare('SELECT sql FROM sqlite_master WHERE name=?')
      .bind(table)
      .first<{ sql: string }>();
    expect(definition?.sql).toContain('WITHOUT ROWID');
    await expect(
      db.prepare(`SELECT rowid FROM ${table}`).all(),
    ).rejects.toThrow(/no such column/i);
    await expect(
      db.prepare(`INSERT OR REPLACE INTO ${table}(rowid) VALUES(1)`).run(),
    ).rejects.toThrow(/no column named rowid/i);
  }
});
