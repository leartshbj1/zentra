import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createD1QuoteLedger } from './ledger';
import { quotePlanFingerprint } from './engine';
import {
  QuoteLedgerError,
  type QuoteExecutionReservation,
  type QuoteLedgerFence,
  type QuoteLedgerFenceRequest,
  type QuoteProposalLedger,
} from './ledger-types';
import {
  ActionEngineError,
  type ActionActor,
  type ActionAdmission,
  type DraftQuoteReceipt,
  type QuotePlan,
  type StoredQuoteProposal,
} from './types';

// This is a real SQLite/D1-shaped adapter, not an in-memory business ledger.
// The QA policy tables below prove transactional fencing only. They are not a
// production implementation of Gestion/Automation entitlement or publication.
const actor: ActionActor = { organizationId: 'org-a', userId: 'user-a' };
const otherActor: ActionActor = { organizationId: 'org-b', userId: 'user-b' };
const installationA = 'installation-a';
const installationB = 'installation-b';

function admission(): ActionAdmission {
  return {
    ...actor,
    revision: 'authority-v1',
    automationActive: true,
    mayPrepareQuote: true,
  };
}

function plan(): QuotePlan {
  return {
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: actor.organizationId,
    contextRevision: 'context-v1',
    sourceId: 'ticket-a',
    sourceRevision: 'source-v1',
    status: 'ready',
    reasons: [],
    customer: {
      kind: 'existing',
      id: 'customer-a',
      revision: 'customer-v1',
      name: 'Camille Exemple',
    },
    title: 'Devis radiateurs',
    currency: 'CHF',
    lines: [
      {
        articleId: 'radiator-a',
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

type BatchFault = 'rollback' | 'lost-response';
type LocalResult = {
  success: true;
  results: Record<string, unknown>[];
  meta: { changes: number; last_row_id: number };
};
type LocalStatement = {
  sql: string;
  values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => LocalStatement;
  first: <T = Record<string, unknown>>(column?: string) => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
  run: () => Promise<LocalResult>;
};

function sqliteAdapter(sql: DatabaseSync) {
  let nextBatchFault: BatchFault | null = null;
  const batches: string[][] = [];
  const executed: { sql: string; values: SQLInputValue[] }[] = [];
  function execute(statement: LocalStatement): LocalResult {
    executed.push({ sql: statement.sql, values: [...statement.values] });
    const native = sql.prepare(statement.sql);
    // The repository's result-bearing statements are SELECTs; writes use run.
    if (/^\s*SELECT\b/i.test(statement.sql))
      return {
        success: true,
        results: native.all(...statement.values),
        meta: { changes: 0, last_row_id: 0 },
      };
    const result = native.run(...statement.values);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
  function prepare(query: string): LocalStatement {
    const statement: LocalStatement = {
      sql: query,
      values: [],
      bind(...values) {
        statement.values = [...values];
        return statement;
      },
      async first<T>(column?: string) {
        const row = sql.prepare(query).get(...statement.values);
        return (
          row === undefined ? null : column === undefined ? row : row[column]
        ) as T | null;
      },
      async all<T>() {
        return {
          results: sql.prepare(query).all(...statement.values) as T[],
        };
      },
      async run() {
        return execute(statement);
      },
    };
    return statement;
  }
  const adapter = {
    prepare,
    async batch(statements: LocalStatement[]) {
      const fault = nextBatchFault;
      nextBatchFault = null;
      batches.push(statements.map((statement) => statement.sql));
      sql.exec('BEGIN');
      let committed = false;
      try {
        const results = [];
        // A native SQLite transaction contains no artificial JS yield between
        // statements. The fence barriers run before BEGIN, like D1 admission.
        for (const statement of statements) results.push(execute(statement));
        if (fault === 'rollback') throw Error('Synthetic batch rollback');
        sql.exec('COMMIT');
        committed = true;
        if (fault === 'lost-response')
          throw Error('Synthetic response lost after COMMIT');
        return results;
      } catch (error) {
        if (!committed) sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    database: adapter as unknown as Pick<D1Database, 'prepare' | 'batch'>,
    batches,
    executed,
    failNextBatch(fault: BatchFault) {
      nextBatchFault = fault;
    },
  };
}

function rendezvous(expected: number) {
  let arrivals = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolveWaiting) => {
    release = resolveWaiting;
  });
  return async () => {
    arrivals++;
    if (arrivals === expected) release();
    await waiting;
  };
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'zentra-action-ledger-'));
  const file = join(directory, 'ledger.sqlite');
  const connections: DatabaseSync[] = [];
  const fenceCalls: QuoteLedgerFenceRequest[] = [];
  let clock = 1_800_000_000;
  let sequence = 0;
  let onFence: ((request: QuoteLedgerFenceRequest) => Promise<void>) | null =
    null;

  function connect() {
    const sql = new DatabaseSync(file);
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
    connections.push(sql);
    return sql;
  }

  const sql = connect();
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );

  sql.exec(`
    INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until)
    VALUES('subscription-a','payer-a','price','active',2000000000,1,1,2000000000),
          ('subscription-b','payer-b','price','active',2000000000,1,1,2000000000);
    INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
    VALUES('org-a','Synthetic A','subscription-a','user-a',1,1),
          ('org-b','Synthetic B','subscription-b','user-b',1,1);
    CREATE TABLE qa_action_authority(
      organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
      active INTEGER NOT NULL, revision TEXT NOT NULL,
      PRIMARY KEY(organization_id,user_id));
    CREATE TABLE qa_action_sources(
      organization_id TEXT NOT NULL, source_id TEXT NOT NULL,
      revision TEXT NOT NULL, PRIMARY KEY(organization_id,source_id));
    CREATE TABLE qa_action_contexts(
      organization_id TEXT PRIMARY KEY, revision TEXT NOT NULL);
    CREATE TABLE qa_action_publications(
      organization_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, reservation_id TEXT NOT NULL,
      installation_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      quote_id TEXT NOT NULL, quote_number TEXT,
      status TEXT NOT NULL, requires_human_validation INTEGER NOT NULL,
      committed INTEGER NOT NULL, PRIMARY KEY(organization_id,quote_id));
    INSERT INTO qa_action_authority VALUES('org-a','user-a',1,'authority-v1'),('org-b','user-b',1,'authority-v1');
    INSERT INTO qa_action_sources VALUES('org-a','ticket-a','source-v1'),('org-b','ticket-b','source-v1');
    INSERT INTO qa_action_contexts VALUES('org-a','context-v1'),('org-b','context-v1');
  `);

  const fence: QuoteLedgerFence = async (request) => {
    fenceCalls.push(request);
    let predicate = `EXISTS(SELECT 1 FROM qa_action_authority
      WHERE organization_id=? AND user_id=? AND active=1)`;
    const values: (string | number | null)[] = [
      request.actor.organizationId,
      request.actor.userId,
    ];
    if (request.operation === 'save' || request.operation === 'reserve') {
      const p = request.proposal.plan;
      predicate += ` AND EXISTS(SELECT 1 FROM qa_action_sources
        WHERE organization_id=? AND source_id=? AND revision=?)
        AND EXISTS(SELECT 1 FROM qa_action_contexts
        WHERE organization_id=? AND revision=?)`;
      values.push(
        p.organizationId,
        p.sourceId,
        p.sourceRevision,
        p.organizationId,
        p.contextRevision,
      );
      if (request.operation === 'save') {
        predicate += ` AND EXISTS(SELECT 1 FROM qa_action_authority
          WHERE organization_id=? AND user_id=? AND revision=?)`;
        values.push(
          request.actor.organizationId,
          request.actor.userId,
          request.admission.revision,
        );
      }
    }
    if (request.operation === 'confirm') {
      const r = request.receipt;
      predicate += ` AND EXISTS(SELECT 1 FROM qa_action_publications
        WHERE organization_id=? AND proposal_id=? AND fingerprint=?
        AND reservation_id=? AND installation_id=? AND customer_id=?
        AND quote_id=? AND quote_number IS ? AND status=?
        AND requires_human_validation=1 AND committed=1)`;
      values.push(
        r.organizationId,
        r.proposalId,
        r.fingerprint,
        request.reservation.id,
        request.reservation.installationId,
        r.customerId,
        r.quoteId,
        r.quoteNumber,
        r.status,
      );
    }
    if (onFence) await onFence(request);
    return { sql: predicate, bindings: values };
  };

  function ledger(
    connection: DatabaseSync = sql,
    selectedFence: QuoteLedgerFence = fence,
  ) {
    const adapter = sqliteAdapter(connection);
    const repository = createD1QuoteLedger(adapter.database, selectedFence, {
      nowSeconds: () => clock,
      newUuid: () =>
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
    return { ...adapter, repository };
  }

  function publish(
    reservation: QuoteExecutionReservation,
    receipt: DraftQuoteReceipt,
    committed = 1,
  ) {
    sql
      .prepare(
        `INSERT INTO qa_action_publications VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        receipt.organizationId,
        receipt.proposalId,
        receipt.fingerprint,
        reservation.id,
        reservation.installationId,
        receipt.customerId,
        receipt.quoteId,
        receipt.quoteNumber,
        receipt.status,
        1,
        committed,
      );
  }

  return {
    sql,
    fence,
    fenceCalls,
    connect,
    ledger,
    publish,
    setClock(value: number) {
      clock = value;
    },
    setFenceHook(hook: typeof onFence) {
      onFence = hook;
    },
    close(connection: DatabaseSync) {
      connection.close();
      connections.splice(connections.indexOf(connection), 1);
    },
    cleanup() {
      for (const connection of connections) connection.close();
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep))
        throw Error('Unexpected fixture cleanup path');
      rmSync(target, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof createFixture>;
let fixture: Fixture;
beforeEach(() => {
  fixture = createFixture();
});
afterEach(() => {
  try {
    // A successful read is also guarded. Denials and rollback leave no fence
    // rows, while a committed batch deletes its temporary assertion itself.
    const readable = fixture.connect();
    expect(
      readable
        .prepare('SELECT count(*) AS n FROM action_engine_atomic_assertions')
        .get()?.n,
    ).toBe(0);
  } finally {
    fixture?.cleanup();
  }
});

async function save(repository: QuoteProposalLedger, p = plan()) {
  return repository.saveProposal(
    actor,
    p,
    await quotePlanFingerprint(p),
    admission(),
  );
}

async function reserve(
  repository: QuoteProposalLedger,
  proposal: StoredQuoteProposal,
  installationId = installationA,
) {
  const result = await repository.reserveExecution(
    actor,
    proposal.id,
    installationId,
  );
  expect(result.state).toBe('reserved');
  if (result.state !== 'reserved') throw Error('Expected reservation fixture');
  return result.reservation;
}

function receipt(
  proposal: StoredQuoteProposal,
  reservation: QuoteExecutionReservation,
): DraftQuoteReceipt {
  return {
    organizationId: actor.organizationId,
    proposalId: proposal.id,
    fingerprint: proposal.fingerprint,
    customerId: reservation.customerId,
    quoteId: reservation.quoteId,
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  };
}

async function confirm(
  repository: QuoteProposalLedger,
  proposal: StoredQuoteProposal,
  reservation: QuoteExecutionReservation,
  value = receipt(proposal, reservation),
) {
  return repository.confirmExecution(
    actor,
    proposal.id,
    reservation.installationId,
    reservation.id,
    value,
  );
}

async function ledgerError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(QuoteLedgerError);
  await expect(promise).rejects.toMatchObject({ code });
}

function ledgerCounts() {
  const reader = fixture.connect();
  const count = (table: string) =>
    Number(reader.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  return {
    proposals: count('action_engine_quote_proposals'),
    reservations: count('action_engine_quote_reservations'),
    events: count('action_engine_quote_events'),
    assertions: count('action_engine_atomic_assertions'),
  };
}

describe('D1 quote proposals on real SQLite', () => {
  it('saves once and returns the identical immutable proposition on replay', async () => {
    const { repository } = fixture.ledger();
    const first = await save(repository);
    const replay = await save(repository);
    expect(replay).toEqual(first);
    expect(await repository.findProposal(actor, 'ticket-a')).toEqual(first);
    expect(await repository.loadProposal(actor, first.id)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.plan.lines[0])).toBe(true);
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 0,
      events: 1,
      assertions: 0,
    });
  });

  it('concurrent identical saves on two connections share one durable ID', async () => {
    const a = fixture.ledger();
    const b = fixture.ledger(fixture.connect());
    const meet = rendezvous(2);
    fixture.setFenceHook(async (request) => {
      if (request.operation === 'save') await meet();
    });
    const [first, second] = await Promise.all([
      save(a.repository),
      save(b.repository),
    ]);
    expect(second).toEqual(first);
    expect(await a.repository.findProposal(actor, 'ticket-a')).toEqual(first);
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 0,
      events: 1,
      assertions: 0,
    });
  });

  it('a new factory after clean close and reopen returns the same proposal', async () => {
    const firstConnection = fixture.sql;
    const first = await save(fixture.ledger(firstConnection).repository);
    fixture.close(firstConnection);
    const reopened = fixture.ledger(fixture.connect()).repository;
    expect(await reopened.loadProposal(actor, first.id)).toEqual(first);
    expect(await save(reopened)).toEqual(first);
  });

  it('does not overwrite the same source with a different valid fingerprint', async () => {
    const { repository } = fixture.ledger();
    const first = await save(repository);
    await ledgerError(
      save(repository, { ...plan(), title: 'Autre titre' }),
      'conflict',
    );
    expect(await repository.loadProposal(actor, first.id)).toEqual(first);
  });

  it('does not make a second proposal when the same source revision advances', async () => {
    const { repository } = fixture.ledger();
    const first = await save(repository);
    fixture.sql.exec(
      "UPDATE qa_action_sources SET revision='source-v2' WHERE organization_id='org-a'",
    );
    await ledgerError(
      save(repository, { ...plan(), sourceRevision: 'source-v2' }),
      'conflict',
    );
    expect(await repository.loadProposal(actor, first.id)).toEqual(first);
  });

  it('rejects a hash that does not describe the supplied closed plan', async () => {
    const { repository } = fixture.ledger();
    await ledgerError(
      repository.saveProposal(actor, plan(), '0'.repeat(64), admission()),
      'invalid_record',
    );
    expect(await repository.findProposal(actor, 'ticket-a')).toBeNull();
  });

  it('persists needs_review but never reserves its execution', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository, {
      ...plan(),
      status: 'needs_review',
      reasons: ['low_confidence'],
      confidence: 0.7,
    });
    const attempted = repository.reserveExecution(
      actor,
      stored.id,
      installationA,
    );
    await expect(attempted).rejects.toBeInstanceOf(ActionEngineError);
    await expect(attempted).rejects.toMatchObject({ code: 'review_required' });
    expect(() =>
      fixture.sql
        .prepare(`INSERT INTO action_engine_quote_reservations
      (id,organization_id,proposal_id,fingerprint,user_id,installation_id,customer_id,quote_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          actor.organizationId,
          stored.id,
          stored.fingerprint,
          actor.userId,
          installationA,
          'customer-a',
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          1_800_000_000,
        ),
    ).toThrow('action_engine_reservation_not_ready');
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 0,
      events: 1,
      assertions: 0,
    });
  });

  it('tenant-scopes reads and rejects a cross-tenant save or reservation', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    expect(await repository.loadProposal(otherActor, stored.id)).toBeNull();
    expect(await repository.findProposal(otherActor, 'ticket-a')).toBeNull();
    await ledgerError(
      repository.saveProposal(otherActor, plan(), stored.fingerprint, {
        ...admission(),
        ...otherActor,
      }),
      'invalid_record',
    );
    await ledgerError(
      repository.reserveExecution(otherActor, stored.id, installationB),
      'invalid_record',
    );
  });

  it('denied reads throw forbidden rather than masquerading as absent records', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    fixture.sql.exec(
      "UPDATE qa_action_authority SET active=0 WHERE organization_id='org-a'",
    );
    await ledgerError(repository.findProposal(actor, 'ticket-a'), 'forbidden');
    await ledgerError(repository.findProposal(actor, 'missing'), 'forbidden');
    await ledgerError(repository.loadProposal(actor, stored.id), 'forbidden');
  });

  it.each(['authority', 'source', 'context'])(
    'rechecks the %s SQL guard in the same transaction as save',
    async (changed) => {
      const { repository } = fixture.ledger();
      fixture.setFenceHook(async (request) => {
        if (request.operation !== 'save') return;
        if (changed === 'authority')
          fixture.sql.exec(
            "UPDATE qa_action_authority SET active=0 WHERE organization_id='org-a'",
          );
        if (changed === 'source')
          fixture.sql.exec(
            "UPDATE qa_action_sources SET revision='source-v2' WHERE organization_id='org-a'",
          );
        if (changed === 'context')
          fixture.sql.exec(
            "UPDATE qa_action_contexts SET revision='context-v2' WHERE organization_id='org-a'",
          );
      });
      await ledgerError(save(repository), 'forbidden');
      fixture.sql.exec(
        "UPDATE qa_action_authority SET active=1 WHERE organization_id='org-a'",
      );
      expect(await repository.findProposal(actor, 'ticket-a')).toBeNull();
      expect(ledgerCounts()).toEqual({
        proposals: 0,
        reservations: 0,
        events: 0,
        assertions: 0,
      });
    },
  );

  it('requires the exact current admission revision for a new save', async () => {
    const { repository } = fixture.ledger();
    fixture.sql.exec(
      "UPDATE qa_action_authority SET revision='authority-v2' WHERE organization_id='org-a'",
    );
    await ledgerError(save(repository), 'forbidden');
    expect(await repository.findProposal(actor, 'ticket-a')).toBeNull();
  });
});

describe('D1 permanent installation-bound execution reservation', () => {
  it('allocates stable customer and quote IDs and replays them on the same installation', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository, {
      ...plan(),
      customer: {
        kind: 'new',
        name: 'Camille Exemple',
        email: 'client@example.ch',
      },
    });
    const first = await reserve(repository, stored);
    const second = await reserve(repository, stored);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      organizationId: actor.organizationId,
      proposalId: stored.id,
      fingerprint: stored.fingerprint,
      userId: actor.userId,
      installationId: installationA,
      receipt: null,
      createdAt: 1_800_000_000,
    });
    expect(first.customerId).not.toBe(first.quoteId);
    expect(first.id).not.toBe(first.quoteId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 1,
      events: 2,
      assertions: 0,
    });
  });

  it('retains an existing client ID rather than inventing another customer', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    expect((await reserve(repository, stored)).customerId).toBe('customer-a');
  });

  it('a generated quote-ID collision rolls back without stealing another proposal reservation', async () => {
    const { repository } = fixture.ledger();
    const first = await save(repository);
    const firstReservation = await reserve(repository, first);
    fixture.sql
      .prepare('INSERT INTO qa_action_sources VALUES(?,?,?)')
      .run(actor.organizationId, 'ticket-another', 'source-v1');
    const second = await save(repository, {
      ...plan(),
      sourceId: 'ticket-another',
    });
    const adapter = sqliteAdapter(fixture.sql);
    let calls = 0;
    const collisionLedger = createD1QuoteLedger(
      adapter.database,
      fixture.fence,
      {
        nowSeconds: () => 1_800_000_000,
        newUuid: () => {
          calls++;
          // The first two IDs belong to read assertions, then reservation and
          // quote allocation. Assert the actual INSERT bindings below so this
          // fixture cannot silently test a different kind of collision.
          return calls === 4
            ? firstReservation.quoteId
            : `88888888-8888-4888-8888-${String(calls).padStart(12, '0')}`;
        },
      },
    );
    await ledgerError(
      collisionLedger.reserveExecution(actor, second.id, installationA),
      'service_unavailable',
    );
    const insert = adapter.executed.find((statement) =>
      statement.sql.includes('INSERT INTO action_engine_quote_reservations'),
    );
    expect(insert?.values[7]).toBe(firstReservation.quoteId);
    expect(insert?.values[0]).not.toBe(firstReservation.id);
    expect(ledgerCounts()).toEqual({
      proposals: 2,
      reservations: 1,
      events: 3,
      assertions: 0,
    });
    expect(await reserve(repository, first)).toEqual(firstReservation);
    const secondReservation = await reserve(repository, second);
    expect(secondReservation.quoteId).not.toBe(firstReservation.quoteId);
    expect(secondReservation.customerId).toBe(firstReservation.customerId);
  });

  it('a second installation stays held after arbitrary elapsed time', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const first = await reserve(repository, stored);
    fixture.setClock(1_900_000_000);
    const held = await repository.reserveExecution(
      actor,
      stored.id,
      installationB,
    );
    expect(held).toEqual({ state: 'held', proposalId: stored.id });
    expect(await reserve(repository, stored)).toEqual(first);
  });

  it.each(['source', 'context'])(
    'same-device reserved recovery refuses a stale %s before native execution, but a historical publication can confirm',
    async (changed) => {
      const { repository } = fixture.ledger();
      const stored = await save(repository);
      const reservation = await reserve(repository, stored);
      if (changed === 'source')
        fixture.sql.exec(
          "UPDATE qa_action_sources SET revision='source-v2' WHERE organization_id='org-a'",
        );
      else
        fixture.sql.exec(
          "UPDATE qa_action_contexts SET revision='context-v2' WHERE organization_id='org-a'",
        );
      await ledgerError(
        repository.reserveExecution(actor, stored.id, installationA),
        'forbidden',
      );
      expect(await repository.loadProposal(actor, stored.id)).toEqual(stored);
      expect(ledgerCounts()).toEqual({
        proposals: 1,
        reservations: 1,
        events: 2,
        assertions: 0,
      });
      const value = receipt(stored, reservation);
      fixture.publish(reservation, value);
      expect(await confirm(repository, stored, reservation, value)).toEqual(
        value,
      );
      expect(
        await repository.reserveExecution(actor, stored.id, installationA),
      ).toEqual({
        state: 'confirmed',
        receipt: value,
      });
    },
  );

  it('two concurrent installations allocate only the winning reservation', async () => {
    const a = fixture.ledger();
    const b = fixture.ledger(fixture.connect());
    const stored = await save(a.repository);
    const meet = rendezvous(2);
    fixture.setFenceHook(async (request) => {
      if (request.operation === 'reserve') await meet();
    });
    const results = await Promise.all([
      a.repository.reserveExecution(actor, stored.id, installationA),
      b.repository.reserveExecution(actor, stored.id, installationB),
    ]);
    expect(results.map((r) => r.state).sort()).toEqual(['held', 'reserved']);
    const won = results.find((r) => r.state === 'reserved');
    if (!won || won.state !== 'reserved')
      throw Error('Missing winning reservation');
    fixture.setFenceHook(null);
    expect(
      await reserve(a.repository, stored, won.reservation.installationId),
    ).toEqual(won.reservation);
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 1,
      events: 2,
      assertions: 0,
    });
  });

  it.each(['authority', 'source', 'context'])(
    'does not reserve when %s changes during the admission await',
    async (changed) => {
      const { repository } = fixture.ledger();
      const stored = await save(repository);
      fixture.setFenceHook(async (request) => {
        if (request.operation !== 'reserve') return;
        if (changed === 'authority')
          fixture.sql.exec(
            "UPDATE qa_action_authority SET active=0 WHERE organization_id='org-a'",
          );
        if (changed === 'source')
          fixture.sql.exec(
            "UPDATE qa_action_sources SET revision='source-v2' WHERE organization_id='org-a'",
          );
        if (changed === 'context')
          fixture.sql.exec(
            "UPDATE qa_action_contexts SET revision='context-v2' WHERE organization_id='org-a'",
          );
      });
      await ledgerError(
        repository.reserveExecution(actor, stored.id, installationA),
        'forbidden',
      );
      expect(ledgerCounts()).toEqual({
        proposals: 1,
        reservations: 0,
        events: 1,
        assertions: 0,
      });
    },
  );

  it('survives clean reopen with the permanent reservation unchanged', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const first = await reserve(repository, stored);
    fixture.close(fixture.sql);
    const reopened = fixture.ledger(fixture.connect()).repository;
    expect(await reserve(reopened, stored)).toEqual(first);
    expect(
      await reopened.reserveExecution(actor, stored.id, installationB),
    ).toEqual({
      state: 'held',
      proposalId: stored.id,
    });
  });
});

describe('D1 publication-corroborated historical receipts', () => {
  it('requires a matching committed publication before confirming a receipt', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    await ledgerError(
      confirm(repository, stored, reservation, value),
      'forbidden',
    );
    fixture.publish(reservation, value, 0);
    await ledgerError(
      confirm(repository, stored, reservation, value),
      'forbidden',
    );
    fixture.sql.exec('UPDATE qa_action_publications SET committed=1');
    expect(await confirm(repository, stored, reservation, value)).toEqual(
      value,
    );
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 1,
      events: 3,
      assertions: 0,
    });
  });

  it.each([
    'customer_id',
    'quote_id',
    'fingerprint',
    'installation_id',
    'reservation_id',
  ])(
    'refuses a committed QA publication with a mismatched %s',
    async (column) => {
      const { repository } = fixture.ledger();
      const stored = await save(repository);
      const reservation = await reserve(repository, stored);
      const value = receipt(stored, reservation);
      fixture.publish(reservation, value);
      fixture.sql
        .prepare(`UPDATE qa_action_publications SET ${column}=?`)
        .run('different');
      await ledgerError(
        confirm(repository, stored, reservation, value),
        'forbidden',
      );
    },
  );

  it.each([
    { customerId: 'another-customer' },
    { quoteId: 'another-quote' },
    { fingerprint: '0'.repeat(64) },
    { organizationId: 'org-b' },
    { proposalId: 'another-proposal' },
    { quoteNumber: 'DV-2026-0001' },
  ])(
    'rejects a forged receipt identity %j without consuming the reservation',
    async (patch) => {
      const { repository } = fixture.ledger();
      const stored = await save(repository);
      const reservation = await reserve(repository, stored);
      const value = receipt(stored, reservation);
      fixture.publish(reservation, value);
      await ledgerError(
        confirm(repository, stored, reservation, {
          ...value,
          ...patch,
        } as DraftQuoteReceipt),
        'invalid_record',
      );
      expect(await reserve(repository, stored)).toEqual(reservation);
    },
  );

  it('rejects confirmation by another installation or reservation token', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    await ledgerError(
      repository.confirmExecution(
        actor,
        stored.id,
        installationB,
        reservation.id,
        value,
      ),
      'forbidden',
    );
    await ledgerError(
      repository.confirmExecution(
        actor,
        stored.id,
        installationA,
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        value,
      ),
      'forbidden',
    );
    expect(await confirm(repository, stored, reservation, value)).toEqual(
      value,
    );
  });

  it('confirmation is idempotent and keeps its draft/null-number receipt after later issue', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    expect(await confirm(repository, stored, reservation, value)).toEqual(
      value,
    );
    expect(await confirm(repository, stored, reservation, value)).toEqual(
      value,
    );
    fixture.sql.exec(
      "UPDATE qa_action_publications SET status='issued',quote_number='DV-2026-0001'",
    );
    const recovered = await repository.reserveExecution(
      actor,
      stored.id,
      installationA,
    );
    expect(recovered).toEqual({ state: 'confirmed', receipt: value });
    expect(value).toMatchObject({ quoteNumber: null, status: 'draft' });
  });

  it('recovers historical receipt with stale source/catalogue but refuses revoked authority', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    await confirm(repository, stored, reservation, value);
    fixture.sql.exec(
      "UPDATE qa_action_sources SET revision='source-v99'; UPDATE qa_action_contexts SET revision='context-v99'",
    );
    expect(
      await repository.reserveExecution(actor, stored.id, installationA),
    ).toEqual({
      state: 'confirmed',
      receipt: value,
    });
    fixture.sql.exec(
      "UPDATE qa_action_authority SET active=0 WHERE organization_id='org-a'",
    );
    await ledgerError(
      repository.reserveExecution(actor, stored.id, installationA),
      'forbidden',
    );
    await ledgerError(
      confirm(repository, stored, reservation, value),
      'forbidden',
    );
  });

  it('can first confirm a historical publication after catalogue/source advance', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    fixture.sql.exec(
      "UPDATE qa_action_sources SET revision='source-v2'; UPDATE qa_action_contexts SET revision='context-v2'",
    );
    expect(await confirm(repository, stored, reservation, value)).toEqual(
      value,
    );
  });

  it('keeps the exact confirmed receipt through clean close and a new SQLite instance', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    await confirm(repository, stored, reservation, value);
    const originalJson = fixture.sql
      .prepare(
        'SELECT receipt_json FROM action_engine_quote_reservations WHERE id=?',
      )
      .get(reservation.id)?.receipt_json;
    fixture.close(fixture.sql);
    const reopenedConnection = fixture.connect();
    const reopened = fixture.ledger(reopenedConnection).repository;
    expect(
      await reopened.reserveExecution(actor, stored.id, installationA),
    ).toEqual({
      state: 'confirmed',
      receipt: value,
    });
    expect(await confirm(reopened, stored, reservation, value)).toEqual(value);
    expect(
      reopenedConnection
        .prepare(
          'SELECT receipt_json FROM action_engine_quote_reservations WHERE id=?',
        )
        .get(reservation.id)?.receipt_json,
    ).toBe(originalJson);
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 1,
      events: 3,
      assertions: 0,
    });
  });

  it('checks current authority after the confirmation fence await', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    fixture.setFenceHook(async (request) => {
      if (request.operation === 'confirm')
        fixture.sql.exec(
          "UPDATE qa_action_authority SET active=0 WHERE organization_id='org-a'",
        );
    });
    await ledgerError(
      confirm(repository, stored, reservation, value),
      'forbidden',
    );
  });
});

describe('D1 lost response versus rolled back transaction', () => {
  it.each(['save', 'reserve', 'confirm'] as const)(
    'recovers the original durable %s on explicit retry after COMMIT response loss',
    async (operation) => {
      const connection = fixture.ledger();
      let stored: StoredQuoteProposal | null = null;
      let reservation: QuoteExecutionReservation | null = null;
      let value: DraftQuoteReceipt | null = null;
      if (operation !== 'save') stored = await save(connection.repository);
      if (operation === 'confirm') {
        reservation = await reserve(connection.repository, stored!);
        value = receipt(stored!, reservation);
        fixture.publish(reservation, value);
      }
      fixture.setFenceHook(async (request) => {
        if (request.operation === operation) {
          fixture.setFenceHook(null);
          connection.failNextBatch('lost-response');
        }
      });
      if (operation === 'save') {
        await ledgerError(save(connection.repository), 'service_unavailable');
        const result = await connection.repository.findProposal(
          actor,
          'ticket-a',
        );
        expect(result).not.toBeNull();
        expect(await save(connection.repository)).toEqual(result);
        expect(ledgerCounts()).toEqual({
          proposals: 1,
          reservations: 0,
          events: 1,
          assertions: 0,
        });
      } else if (operation === 'reserve') {
        await ledgerError(
          connection.repository.reserveExecution(
            actor,
            stored!.id,
            installationA,
          ),
          'service_unavailable',
        );
        const result = await reserve(connection.repository, stored!);
        expect(await reserve(connection.repository, stored!)).toEqual(result);
        expect(ledgerCounts()).toEqual({
          proposals: 1,
          reservations: 1,
          events: 2,
          assertions: 0,
        });
      } else {
        await ledgerError(
          confirm(connection.repository, stored!, reservation!, value!),
          'service_unavailable',
        );
        expect(
          await confirm(connection.repository, stored!, reservation!, value!),
        ).toEqual(value);
        expect(
          await confirm(connection.repository, stored!, reservation!, value!),
        ).toEqual(value);
        expect(ledgerCounts()).toEqual({
          proposals: 1,
          reservations: 1,
          events: 3,
          assertions: 0,
        });
      }
    },
  );

  it.each(['save', 'reserve', 'confirm'] as const)(
    'does not invent a durable result when %s actually rolls back',
    async (operation) => {
      const connection = fixture.ledger();
      let stored: StoredQuoteProposal | null = null;
      let reservation: QuoteExecutionReservation | null = null;
      let value: DraftQuoteReceipt | null = null;
      if (operation !== 'save') stored = await save(connection.repository);
      if (operation === 'confirm') {
        reservation = await reserve(connection.repository, stored!);
        value = receipt(stored!, reservation);
        fixture.publish(reservation, value);
      }
      fixture.setFenceHook(async (request) => {
        if (request.operation === operation) {
          fixture.setFenceHook(null);
          connection.failNextBatch('rollback');
        }
      });
      const attempted =
        operation === 'save'
          ? save(connection.repository)
          : operation === 'reserve'
            ? connection.repository.reserveExecution(
                actor,
                stored!.id,
                installationA,
              )
            : confirm(connection.repository, stored!, reservation!, value!);
      await ledgerError(attempted, 'service_unavailable');
      if (operation === 'save') {
        expect(
          await connection.repository.findProposal(actor, 'ticket-a'),
        ).toBeNull();
        expect(ledgerCounts()).toEqual({
          proposals: 0,
          reservations: 0,
          events: 0,
          assertions: 0,
        });
        expect((await save(connection.repository)).plan).toEqual(plan());
      } else if (operation === 'reserve') {
        expect(ledgerCounts()).toEqual({
          proposals: 1,
          reservations: 0,
          events: 1,
          assertions: 0,
        });
        expect(
          (await reserve(connection.repository, stored!)).receipt,
        ).toBeNull();
      } else {
        expect(await reserve(connection.repository, stored!)).toEqual(
          reservation,
        );
        expect(ledgerCounts()).toEqual({
          proposals: 1,
          reservations: 1,
          events: 2,
          assertions: 0,
        });
        expect(
          await confirm(connection.repository, stored!, reservation!, value!),
        ).toEqual(value);
      }
    },
  );
});

describe('D1 closed captures, permanent SQL identities and audit', () => {
  it('requires a private fence at construction', () => {
    const adapter = sqliteAdapter(fixture.sql);
    expect(() =>
      createD1QuoteLedger(
        adapter.database,
        undefined as unknown as QuoteLedgerFence,
      ),
    ).toThrow('forbidden');
    expect(ledgerCounts()).toEqual({
      proposals: 0,
      reservations: 0,
      events: 0,
      assertions: 0,
    });
  });

  it('a false scalar CHECK predicate fails closed instead of silently skipping writes', async () => {
    const { repository, batches } = fixture.ledger(fixture.sql, async () => ({
      sql: '0',
      bindings: [],
    }));
    await ledgerError(save(repository), 'forbidden');
    expect(batches).toHaveLength(1);
    expect(batches[0][0]).toContain('action_engine_atomic_assertions');
    expect(batches[0].at(-1)).toContain(
      'DELETE FROM action_engine_atomic_assertions',
    );
    expect(ledgerCounts()).toEqual({
      proposals: 0,
      reservations: 0,
      events: 0,
      assertions: 0,
    });
  });

  it('uses a CHECK assertion and its cleanup around every successful database batch', async () => {
    const { repository, batches } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    await confirm(repository, stored, reservation, value);
    expect(batches.length).toBeGreaterThan(3);
    for (const statements of batches) {
      expect(statements[0]).toContain(
        'INSERT INTO action_engine_atomic_assertions',
      );
      expect(statements.at(-1)).toContain(
        'DELETE FROM action_engine_atomic_assertions',
      );
    }
    expect(fixture.fenceCalls.map((call) => call.operation)).toEqual(
      expect.arrayContaining(['save', 'read', 'reserve', 'confirm']),
    );
  });

  it('maps private fence failure to a stable error without exposing its message', async () => {
    const { repository } = fixture.ledger(fixture.sql, async () => {
      throw Error('Synthetic private SQL, identity and source body');
    });
    const attempted = save(repository);
    await ledgerError(attempted, 'service_unavailable');
    await expect(attempted).rejects.toMatchObject({
      message: 'service_unavailable',
    });
    expect(ledgerCounts().proposals).toBe(0);
  });

  it('does not invoke accessors on the private fence result', async () => {
    let getterCalls = 0;
    const malformed = Object.defineProperty({ bindings: [] }, 'sql', {
      enumerable: true,
      get() {
        getterCalls++;
        return '1';
      },
    });
    const { repository } = fixture.ledger(
      fixture.sql,
      async () => malformed as unknown as Awaited<ReturnType<QuoteLedgerFence>>,
    );
    await ledgerError(save(repository), 'invalid_record');
    expect(getterCalls).toBe(0);
    expect(ledgerCounts().proposals).toBe(0);
  });

  it.each(['symbol', 'hidden', 'semicolon', 'binding-getter'])(
    'rejects a malformed private fence result with %s',
    async (kind) => {
      const malformed: { sql: string; bindings: unknown[] } = {
        sql: '1',
        bindings: [],
      };
      let getterCalls = 0;
      if (kind === 'symbol')
        Object.defineProperty(malformed, Symbol('hidden'), { value: true });
      if (kind === 'hidden')
        Object.defineProperty(malformed, 'extra', { value: true });
      if (kind === 'semicolon') malformed.sql = '1; SELECT 1';
      if (kind === 'binding-getter') {
        malformed.sql = '?';
        malformed.bindings.length = 1;
        Object.defineProperty(malformed.bindings, '0', {
          enumerable: true,
          get() {
            getterCalls++;
            return 1;
          },
        });
      }
      const { repository } = fixture.ledger(
        fixture.sql,
        async () =>
          malformed as unknown as Awaited<ReturnType<QuoteLedgerFence>>,
      );
      await ledgerError(save(repository), 'invalid_record');
      expect(getterCalls).toBe(0);
      expect(ledgerCounts().proposals).toBe(0);
    },
  );

  it('captures save actor, admission and the nested plan before an awaited fence', async () => {
    const { repository } = fixture.ledger();
    const mutableActor = { ...actor };
    const mutableAdmission = { ...admission() };
    const mutablePlan = structuredClone(plan());
    const expected = structuredClone(mutablePlan);
    const fingerprint = await quotePlanFingerprint(mutablePlan);
    fixture.setFenceHook(async (request) => {
      if (request.operation !== 'save') return;
      Object.assign(mutableActor, otherActor);
      Object.assign(mutableAdmission, {
        revision: 'changed',
        automationActive: false,
      });
      Object.assign(mutablePlan.lines[0], {
        unitPriceCents: 1,
        description: 'Changed after capture',
      });
      Object.assign(mutablePlan, { organizationId: 'org-b', title: 'Changed' });
    });
    const stored = await repository.saveProposal(
      mutableActor,
      mutablePlan,
      fingerprint,
      mutableAdmission,
    );
    expect(stored.organizationId).toBe(actor.organizationId);
    expect(stored.plan).toEqual(expected);
    expect(stored.fingerprint).toBe(fingerprint);
  });

  it('captures the entire receipt before its first awaited repository read', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const original = receipt(stored, reservation);
    const mutable = { ...original };
    fixture.publish(reservation, original);
    fixture.setFenceHook(async (request) => {
      if (request.operation === 'read') {
        mutable.quoteId = 'foreign-quote';
        mutable.customerId = 'foreign-customer';
      }
    });
    expect(await confirm(repository, stored, reservation, mutable)).toEqual(
      original,
    );
  });

  it('rejects a receipt accessor without executing it or confirming anything', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    let getterCalls = 0;
    const malicious = Object.defineProperty(
      { ...receipt(stored, reservation) },
      'quoteId',
      {
        enumerable: true,
        get() {
          getterCalls++;
          return reservation.quoteId;
        },
      },
    );
    await ledgerError(
      confirm(repository, stored, reservation, malicious),
      'invalid_record',
    );
    expect(getterCalls).toBe(0);
    expect(ledgerCounts().events).toBe(2);
  });

  it('records exactly one immutable audit event for each durable transition', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    await save(repository);
    const reservation = await reserve(repository, stored);
    await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    await confirm(repository, stored, reservation, value);
    await confirm(repository, stored, reservation, value);
    const events = fixture.sql
      .prepare(
        'SELECT organization_id,proposal_id,fingerprint,event_type,actor_user_id,created_at FROM action_engine_quote_events ORDER BY event_type',
      )
      .all();
    expect(events).toEqual(
      ['execution_reserved', 'proposal_saved', 'receipt_confirmed'].map(
        (eventType) => ({
          organization_id: actor.organizationId,
          proposal_id: stored.id,
          fingerprint: stored.fingerprint,
          event_type: eventType,
          actor_user_id: actor.userId,
          created_at: 1_800_000_000,
        }),
      ),
    );
    expect(ledgerCounts()).toEqual({
      proposals: 1,
      reservations: 1,
      events: 3,
      assertions: 0,
    });
  });

  it('SQL rejects UPDATE, DELETE and REPLACE of immutable proposal, reservation and audit identities', async () => {
    const { repository } = fixture.ledger();
    const stored = await save(repository);
    const reservation = await reserve(repository, stored);
    const value = receipt(stored, reservation);
    fixture.publish(reservation, value);
    await confirm(repository, stored, reservation, value);
    fixture.sql.exec('PRAGMA recursive_triggers=OFF');
    const snapshot = () => ({
      proposals: fixture.sql
        .prepare('SELECT * FROM action_engine_quote_proposals ORDER BY id')
        .all(),
      reservations: fixture.sql
        .prepare('SELECT * FROM action_engine_quote_reservations ORDER BY id')
        .all(),
      events: fixture.sql
        .prepare('SELECT * FROM action_engine_quote_events ORDER BY id')
        .all(),
    });
    const before = snapshot();
    const statements = [
      "UPDATE action_engine_quote_proposals SET source_revision='source-v2'",
      'DELETE FROM action_engine_quote_proposals',
      'INSERT OR REPLACE INTO action_engine_quote_proposals SELECT * FROM action_engine_quote_proposals',
      "UPDATE action_engine_quote_reservations SET installation_id='installation-b'",
      "UPDATE action_engine_quote_reservations SET quote_id='ffffffff-ffff-4fff-8fff-ffffffffffff'",
      'UPDATE action_engine_quote_reservations SET receipt_json=NULL,confirmed_at=NULL',
      'UPDATE action_engine_quote_reservations SET confirmed_at=confirmed_at+1',
      'DELETE FROM action_engine_quote_reservations',
      'INSERT OR REPLACE INTO action_engine_quote_reservations SELECT * FROM action_engine_quote_reservations',
      "UPDATE action_engine_quote_events SET actor_user_id='user-b'",
      'DELETE FROM action_engine_quote_events',
      'INSERT OR REPLACE INTO action_engine_quote_events SELECT * FROM action_engine_quote_events',
    ];
    for (const statement of statements) {
      expect(() => fixture.sql.exec(statement)).toThrow(
        /action_engine_.*immutable/,
      );
      expect(snapshot()).toEqual(before);
    }
    expect(
      await repository.reserveExecution(actor, stored.id, installationA),
    ).toEqual({
      state: 'confirmed',
      receipt: value,
    });
  });

  it('corroborates a stored plan hash on reads instead of trusting coherent SQL columns', async () => {
    const { repository } = fixture.ledger();
    const p = plan();
    const fingerprint = await quotePlanFingerprint(p);
    const forgedPlan = {
      ...p,
      sourceId: 'ticket-corrupt',
      title: 'Forged title',
    };
    fixture.sql
      .prepare(`INSERT INTO action_engine_quote_proposals
      (id,organization_id,source_id,action_kind,fingerprint,source_revision,context_revision,plan_json,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        actor.organizationId,
        forgedPlan.sourceId,
        forgedPlan.kind,
        fingerprint,
        forgedPlan.sourceRevision,
        forgedPlan.contextRevision,
        JSON.stringify(forgedPlan),
        actor.userId,
        1_800_000_000,
      );
    await ledgerError(
      repository.findProposal(actor, forgedPlan.sourceId),
      'invalid_record',
    );
    expect(ledgerCounts().reservations).toBe(0);
  });
});
