import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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
  database: () => {
    throw Error('Unexpected production runtime access in private SQLite QA');
  },
}));
import { makeCanonicalQuoteFixture } from './canonical-quote.fixture';
import {
  verifyCanonicalQuotePublication,
  type VerifiedCanonicalQuote,
} from './canonical-quote';
import { createD1QuoteLedger } from './ledger';
import {
  createD1QuotePublicationEvidence,
  quotePublicationEvidencePredicate,
  type QuotePublicationEvidenceFence,
} from './quote-publication-evidence';
import {
  captureQuoteReservationBinding,
  historicalQuotePublicationPredicate,
} from './reservation-binding';
import { createHistoricalQuoteFences } from './historical-quote-fences';
import type { QuoteLedgerFence, QuoteReservationBinding } from './ledger-types';
import type { PublicationAttempt } from './publication-ledger-types';
import type { ActionActor } from './types';

// The entire real D1 migration chain and real Node SQLite transactions run here.
// QA authority/source/catalogue tables test atomic fencing, not production rights.
// The native rows are synthetic, on the actual native SQL schema. The real sealed
// verifier runs through SQLite WASM; no object cast substitutes for its capability.
const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => Statement;
};
type Fault = 'rollback' | 'lost' | 'malformed' | 'accessor';
function adapter(sql: DatabaseSync) {
  let fault: Fault | null = null,
    hook: (() => void | Promise<void>) | null = null,
    getterCalls = 0;
  const batches: string[][] = [];
  const database = {
    prepare(query: string) {
      const statement: Statement = {
        sql: query,
        values: [],
        bind(...values) {
          statement.values = [...values];
          return statement;
        },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      const currentFault = fault,
        currentHook = hook;
      fault = null;
      hook = null;
      if (currentHook) await currentHook();
      batches.push(statements.map((s) => s.sql));
      sql.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const results = statements.map((s) => {
          const query = sql.prepare(s.sql);
          if (query.columns().length)
            return {
              success: true,
              results: query.all(...s.values),
              meta: { changes: 0 },
            };
          return {
            success: true,
            results: [],
            meta: { changes: Number(query.run(...s.values).changes) },
          };
        });
        if (currentFault === 'rollback')
          throw Error('Synthetic before-commit fault');
        sql.exec('COMMIT');
        committed = true;
        if (currentFault === 'lost')
          throw Error('Synthetic lost acknowledgement');
        const rows = results[results.length - 2].results;
        if (currentFault === 'malformed' && rows.length)
          rows[0] = { ...rows[0], validator_version: 'forged' };
        if (currentFault === 'accessor')
          Object.defineProperty(results[results.length - 2], 'results', {
            get() {
              getterCalls++;
              throw Error('Private getter');
            },
          });
        return results;
      } catch (error) {
        if (!committed) sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    database: database as unknown as Pick<D1Database, 'prepare' | 'batch'>,
    batches,
    failNext(value: Fault) {
      fault = value;
    },
    beforeNext(value: () => void | Promise<void>) {
      hook = value;
    },
    getterCalls: () => getterCalls,
  };
}

function fixture() {
  const native = makeCanonicalQuoteFixture();
  const directory = mkdtempSync(join(tmpdir(), 'zentra-quote-evidence-')),
    path = join(directory, 'd1.sqlite');
  const connections: DatabaseSync[] = [];
  const connect = () => {
    const sql = new DatabaseSync(path);
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
    connections.push(sql);
    return sql;
  };
  const sql = connect();
  const migrations = readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  sql.exec('BEGIN IMMEDIATE');
  for (const name of migrations)
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  sql.exec('COMMIT');
  sql.exec(`CREATE TABLE qa_quote_proof_rights(organization_id TEXT PRIMARY KEY,allowed INTEGER NOT NULL,source_current INTEGER NOT NULL,catalogue_current INTEGER NOT NULL);
    INSERT INTO qa_quote_proof_rights VALUES('synthetic-company',1,1,1),('other-company',1,1,1);
    CREATE TABLE qa_quote_support_access(source_id TEXT PRIMARY KEY,allowed INTEGER NOT NULL);
    INSERT INTO qa_quote_support_access VALUES('synthetic-source',1);`);
  let sequence = 10000,
    clock = native.reservation.createdAt + 20;
  const actor: ActionActor = {
    organizationId: native.reservation.organizationId,
    userId: native.reservation.userId,
  };
  const rights = (organizationId: string) => ({
    sql: 'EXISTS(SELECT 1 FROM qa_quote_proof_rights WHERE organization_id=? AND allowed=1)',
    bindings: [organizationId],
  });
  const evidenceFence: QuotePublicationEvidenceFence = async (request) =>
    rights(request.actor.organizationId);
  const ledgerFence: QuoteLedgerFence = async (request) => {
    const p = rights(request.actor.organizationId);
    if (request.operation === 'reserve')
      return {
        sql: `${p.sql} AND EXISTS(SELECT 1 FROM qa_quote_proof_rights WHERE organization_id=? AND source_current=1 AND catalogue_current=1)`,
        bindings: [...p.bindings, request.actor.organizationId],
      };
    if (request.operation === 'confirm') {
      const e = quotePublicationEvidencePredicate({
        organizationId: request.actor.organizationId,
        proposalId: request.proposal.id,
        reservationId: request.reservation.id,
        fingerprint: request.proposal.fingerprint,
        userId: request.actor.userId,
        installationId: request.reservation.installationId,
        customerId: request.reservation.customerId,
        quoteId: request.reservation.quoteId,
        receipt: request.receipt,
      });
      return {
        sql: `${p.sql} AND (${e.sql})`,
        bindings: [...p.bindings, ...e.bindings],
      };
    }
    return p;
  };
  function create(
    connection = sql,
    binding: QuoteReservationBinding | null = native.binding,
  ) {
    const transport = adapter(connection),
      options = { nowSeconds: () => clock, newUuid: () => uuid(++sequence) };
    return {
      ...transport,
      evidence: createD1QuotePublicationEvidence(
        transport.database,
        evidenceFence,
        options,
      ),
      ledger: createD1QuoteLedger(transport.database, ledgerFence, {
        ...options,
        ...(binding ? { reservationBinding: binding } : {}),
      }),
    };
  }
  function historical(connection = sql) {
    // Only the composition/fence SQL is real here. Authority/delegation facts
    // intentionally come from private QA predicates, never a production grant.
    const fences = createHistoricalQuoteFences(
      {
        actor,
        installationId: native.reservation.installationId,
        predicate: () => rights(actor.organizationId),
        preflight: async () => {
          throw Error('Not used by historical composition');
        },
        preflightCas: async () => {
          throw Error('Not used by historical composition');
        },
        authorizeRead: async () => {},
      },
      {
        sourceId: native.source.id,
        workspaceId: 'qa-workspace',
        predicate: () => ({
          sql: 'EXISTS(SELECT 1 FROM qa_quote_support_access WHERE source_id=? AND allowed=1)',
          bindings: [native.source.id],
        }),
      },
    );
    const transport = adapter(connection),
      options = { nowSeconds: () => clock, newUuid: () => uuid(++sequence) };
    return {
      ...transport,
      ledger: createD1QuoteLedger(
        transport.database,
        fences.ledgerFence,
        options,
      ),
      evidence: createD1QuotePublicationEvidence(
        transport.database,
        fences.evidenceFence,
        options,
      ),
    };
  }
  function publication(p: PublicationAttempt) {
    sql
      .prepare(
        `INSERT INTO action_engine_publication_attempts(id,organization_id,snapshot_id,installation_id,user_id,base_revision,archive_sha256,manifest_sha256,size_bytes,state,result_json,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?,NULL)`,
      )
      .run(
        p.id,
        p.organizationId,
        p.snapshotId,
        p.installationId,
        p.userId,
        p.baseRevision,
        p.archiveSha256,
        p.manifestSha256,
        p.sizeBytes,
        p.createdAt,
      );
    if (p.state !== 'pending')
      sql
        .prepare(
          'UPDATE action_engine_publication_attempts SET state=?,result_json=?,settled_at=? WHERE id=?',
        )
        .run(p.state, JSON.stringify(p.result), p.settledAt, p.id);
  }
  function planningPublication() {
    const p = native.binding.planningPublication;
    publication({
      id: uuid(++sequence),
      organizationId: p.organizationId,
      snapshotId: p.snapshotId,
      installationId: native.reservation.installationId,
      userId: actor.userId,
      baseRevision: p.baseRevision,
      archiveSha256: p.archiveSha256,
      manifestSha256: p.manifestSha256,
      sizeBytes: 1000,
      createdAt: native.reservation.createdAt - 10,
      settledAt: native.reservation.createdAt - 5,
      state: 'committed',
      result: {
        committed: true,
        revision: p.revision,
        snapshotId: p.snapshotId,
      },
    });
  }
  function seed(withBinding = true, proofPublication = native.publication) {
    planningPublication();
    const p = native.proposal,
      r = native.reservation,
      b = native.binding,
      h = b.planningPublication;
    sql.exec('BEGIN IMMEDIATE');
    try {
      sql
        .prepare(
          'INSERT INTO action_engine_quote_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          p.id,
          p.organizationId,
          p.plan.sourceId,
          p.plan.kind,
          p.fingerprint,
          p.plan.sourceRevision,
          p.plan.contextRevision,
          JSON.stringify(p.plan),
          actor.userId,
          r.createdAt - 1,
        );
      sql
        .prepare(
          'INSERT INTO action_engine_quote_reservations(id,organization_id,proposal_id,fingerprint,user_id,installation_id,customer_id,quote_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          r.id,
          r.organizationId,
          r.proposalId,
          r.fingerprint,
          r.userId,
          r.installationId,
          r.customerId,
          r.quoteId,
          r.createdAt,
        );
      if (withBinding)
        sql
          .prepare(
            'INSERT INTO action_engine_quote_reservation_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            r.id,
            r.organizationId,
            r.proposalId,
            r.fingerprint,
            b.resourcesSha256,
            b.sourceCanonicalSha256,
            h.snapshotId,
            h.revision,
            h.baseRevision,
            h.archiveSha256,
            h.manifestSha256,
            r.createdAt,
          );
      sql
        .prepare('INSERT INTO action_engine_quote_events VALUES(?,?,?,?,?,?,?)')
        .run(
          uuid(++sequence),
          p.organizationId,
          p.id,
          p.fingerprint,
          'execution_reserved',
          actor.userId,
          r.createdAt,
        );
      sql.exec('COMMIT');
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
    publication(proofPublication);
  }
  function insertEvidence(v: VerifiedCanonicalQuote) {
    sql
      .prepare(
        'INSERT INTO action_engine_quote_publication_evidence VALUES(' +
          Array(21).fill('?').join(',') +
          ')',
      )
      .run(
        v.organizationId,
        native.source.id,
        v.proposalId,
        v.reservationId,
        v.fingerprint,
        v.userId,
        v.installationId,
        v.customerId,
        v.quoteId,
        v.publicationAttemptId,
        v.snapshotId,
        v.baseRevision,
        v.revision,
        v.archiveSha256,
        v.manifestSha256,
        v.sqliteSha256,
        v.receiptSha256,
        v.canonicalFactsSha256,
        v.validatorVersion,
        JSON.stringify(v.receipt),
        clock,
      );
  }
  function count(
    table:
      | 'action_engine_quote_reservation_bindings'
      | 'action_engine_quote_reservations'
      | 'action_engine_quote_publication_evidence'
      | 'action_engine_atomic_assertions',
  ) {
    return Number(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  }
  return {
    native,
    actor,
    sql,
    migrations,
    connect,
    create,
    historical,
    publication,
    planningPublication,
    seed,
    insertEvidence,
    count,
    clock(value: number) {
      clock = value;
    },
    close(connection: DatabaseSync) {
      connection.close();
      connections.splice(connections.indexOf(connection), 1);
    },
    cleanup() {
      native.close();
      for (const connection of connections) connection.close();
      const target = resolve(directory),
        parent = resolve(tmpdir());
      if (
        !target.startsWith(parent + sep) ||
        !target.includes('zentra-quote-evidence-')
      )
        throw Error('Unsafe QA path');
      rmSync(target, { recursive: true, force: true });
    },
  };
}
let f: ReturnType<typeof fixture> | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
});
const current = () => {
  f = fixture();
  return f;
};

suite('quote reservation binding, real cumulative D1 SQL', () => {
  it('two connections racing a NEW reservation commit one identity and one binding', async () => {
    const f = current();
    f.planningPublication();
    const a = f.create(),
      b = f.create(f.connect());
    const saved = await a.ledger.saveProposal(
      f.actor,
      f.native.proposal.plan,
      f.native.proposal.fingerprint,
      {
        ...f.actor,
        revision: 'qa-v1',
        automationActive: true,
        mayPrepareQuote: true,
      },
    );
    const results = await Promise.all([
      a.ledger.reserveExecution(
        f.actor,
        saved.id,
        f.native.reservation.installationId,
      ),
      b.ledger.reserveExecution(
        f.actor,
        saved.id,
        f.native.reservation.installationId,
      ),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].state).toBe('reserved');
    expect(f.count('action_engine_quote_reservations')).toBe(1);
    expect(f.count('action_engine_quote_reservation_bindings')).toBe(1);
    expect(
      f.sql
        .prepare(
          "SELECT count(*) n FROM action_engine_quote_events WHERE event_type='execution_reserved'",
        )
        .get()?.n,
    ).toBe(1);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
  });
  it('captures private binding before awaits and inserts it with the new reservation/audit', async () => {
    const f = current();
    f.planningPublication();
    const binding = {
        ...f.native.binding,
        planningPublication: { ...f.native.binding.planningPublication },
      },
      client = f.create(f.sql, binding);
    binding.resourcesSha256 = '0'.repeat(64);
    binding.planningPublication.revision = 999;
    const saved = await client.ledger.saveProposal(
      f.actor,
      f.native.proposal.plan,
      f.native.proposal.fingerprint,
      {
        ...f.actor,
        revision: 'qa-v1',
        automationActive: true,
        mayPrepareQuote: true,
      },
    );
    const result = await client.ledger.reserveExecution(
      f.actor,
      saved.id,
      f.native.reservation.installationId,
    );
    expect(result.state).toBe('reserved');
    const row = f.sql
      .prepare('SELECT * FROM action_engine_quote_reservation_bindings')
      .get();
    expect(row?.resources_sha256).toBe(f.native.binding.resourcesSha256);
    expect(row?.planning_revision).toBe(4);
    const batch = client.batches.find((batch) =>
      batch.some((s) =>
        s.includes('INSERT INTO action_engine_quote_reservations'),
      ),
    )!;
    expect(
      batch.findIndex((s) =>
        s.includes('INSERT INTO action_engine_quote_reservation_bindings'),
      ),
    ).toBeLessThan(
      batch.findIndex((s) =>
        s.includes('INSERT INTO action_engine_quote_events'),
      ),
    );
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
    expect(f.migrations).toContain(
      '0104_action_engine_quote_evidence_preconfirmation.sql',
    );
  });
  it('replays the exact bound reservation across two connections without another binding/audit', async () => {
    const f = current();
    f.seed();
    const a = f.create(),
      b = f.create(f.connect());
    const values = await Promise.all([
      a.ledger.reserveExecution(
        f.actor,
        f.native.proposal.id,
        f.native.reservation.installationId,
      ),
      b.ledger.reserveExecution(
        f.actor,
        f.native.proposal.id,
        f.native.reservation.installationId,
      ),
    ]);
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toEqual({
      state: 'reserved',
      reservation: f.native.reservation,
    });
    expect(f.count('action_engine_quote_reservation_bindings')).toBe(1);
    expect(
      f.sql
        .prepare(
          "SELECT count(*) n FROM action_engine_quote_events WHERE event_type='execution_reserved'",
        )
        .get()?.n,
    ).toBe(1);
  });
  it('refuses a changed binding and never retrofits an old unbound reservation', async () => {
    const f = current();
    f.seed(false);
    await expect(
      f
        .create()
        .ledger.reserveExecution(
          f.actor,
          f.native.proposal.id,
          f.native.reservation.installationId,
        ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.count('action_engine_quote_reservation_bindings')).toBe(0);
    expect(
      (
        await f
          .create(f.sql, null)
          .ledger.reserveExecution(
            f.actor,
            f.native.proposal.id,
            f.native.reservation.installationId,
          )
      ).state,
    ).toBe('reserved');
    const b = f.native.binding,
      p = b.planningPublication,
      r = f.native.reservation;
    expect(() =>
      f.sql
        .prepare(
          'INSERT INTO action_engine_quote_reservation_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          r.id,
          r.organizationId,
          r.proposalId,
          r.fingerprint,
          b.resourcesSha256,
          b.sourceCanonicalSha256,
          p.snapshotId,
          p.revision,
          p.baseRevision,
          p.archiveSha256,
          p.manifestSha256,
          r.createdAt,
        ),
    ).toThrow('action_engine_quote_binding_invalid');
  });
  it('rejects mismatch and accessor options without invoking them', async () => {
    const f = current();
    f.seed();
    await expect(
      f
        .create(f.sql, {
          ...f.native.binding,
          sourceCanonicalSha256: '0'.repeat(64),
        })
        .ledger.reserveExecution(
          f.actor,
          f.native.proposal.id,
          f.native.reservation.installationId,
        ),
    ).rejects.toMatchObject({ code: 'conflict' });
    let calls = 0;
    const options = Object.defineProperty({}, 'reservationBinding', {
      enumerable: true,
      get() {
        calls++;
        return f.native.binding;
      },
    });
    expect(() =>
      createD1QuoteLedger(
        f.create().database,
        async () => ({ sql: '1', bindings: [] }),
        options,
      ),
    ).toThrow('invalid_record');
    expect(calls).toBe(0);
    const bad = Object.defineProperty(
      { ...f.native.binding },
      'resourcesSha256',
      {
        enumerable: true,
        get() {
          calls++;
          return 'a'.repeat(64);
        },
      },
    );
    expect(() => captureQuoteReservationBinding(bad)).toThrow('invalid_record');
    expect(calls).toBe(0);
  });
  it('rolls back the new reservation when the planning publication is not committed', async () => {
    const f = current(),
      client = f.create();
    const p = await client.ledger.saveProposal(
      f.actor,
      f.native.proposal.plan,
      f.native.proposal.fingerprint,
      {
        ...f.actor,
        revision: 'qa-v1',
        automationActive: true,
        mayPrepareQuote: true,
      },
    );
    await expect(
      client.ledger.reserveExecution(
        f.actor,
        p.id,
        f.native.reservation.installationId,
      ),
    ).rejects.toThrow();
    expect(f.count('action_engine_quote_reservations')).toBe(0);
    expect(f.count('action_engine_quote_reservation_bindings')).toBe(0);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
  });
});

suite('sealed canonical creation evidence, real SQLite journal', () => {
  it('first proof refuses a receipt concurrently committed before its insertion batch', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      other = f.connect(),
      verified = await f.native.verify();
    client.beforeNext(() => {
      other
        .prepare(
          'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
        )
        .run(
          JSON.stringify(f.native.receipt),
          f.native.reservation.createdAt + 1,
          f.native.reservation.id,
        );
    });
    await expect(
      client.evidence.append(f.actor, verified),
    ).rejects.toMatchObject({
      code: 'invalid_record',
    });
    expect(f.count('action_engine_quote_publication_evidence')).toBe(0);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
    expect(
      JSON.parse(
        f.sql
          .prepare('SELECT receipt_json FROM action_engine_quote_reservations')
          .get()?.receipt_json as string,
      ),
    ).toEqual(f.native.receipt);
  });
  it('additive SQL trigger independently refuses a direct first-proof INSERT after a receipt', async () => {
    const f = current();
    f.seed();
    const verified = await f.native.verify();
    f.sql
      .prepare(
        'UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=? WHERE id=?',
      )
      .run(
        JSON.stringify(f.native.receipt),
        f.native.reservation.createdAt + 1,
        f.native.reservation.id,
      );
    expect(() => f.insertEvidence(verified)).toThrow(
      'action_engine_quote_evidence_after_receipt',
    );
    expect(f.count('action_engine_quote_publication_evidence')).toBe(0);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
  });
  it('exact existing proof replays after genuine confirmation without another INSERT or changed history', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      verified = await f.native.verify(),
      saved = await client.evidence.append(f.actor, verified);
    expect(
      await client.ledger.confirmExecution(
        f.actor,
        verified.proposalId,
        verified.installationId,
        verified.reservationId,
        verified.receipt,
      ),
    ).toEqual(verified.receipt);
    const before = f.sql
      .prepare('SELECT * FROM action_engine_quote_publication_evidence')
      .get();
    const reopened = f.create(f.connect());
    expect(await reopened.evidence.append(f.actor, verified)).toEqual(saved);
    expect(
      await reopened.evidence.read(f.actor, verified.reservationId),
    ).toEqual(saved);
    expect(
      f.sql
        .prepare('SELECT * FROM action_engine_quote_publication_evidence')
        .get(),
    ).toEqual(before);
    expect(f.count('action_engine_quote_publication_evidence')).toBe(1);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
    expect(
      f.sql
        .prepare(
          "SELECT count(*) n FROM action_engine_quote_events WHERE event_type='receipt_confirmed'",
        )
        .get()?.n,
    ).toBe(1);
  });
  it('writes and reads a real verified quote, never a copied DTO, with metadata only', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      verified = await f.native.verify();
    const saved = await client.evidence.append(f.actor, verified);
    expect(saved).toEqual({
      ...verified,
      sourceId: f.native.source.id,
      createdAt: f.native.reservation.createdAt + 20,
    });
    expect(await client.evidence.read(f.actor, verified.reservationId)).toEqual(
      saved,
    );
    await expect(
      client.evidence.append(f.actor, { ...verified }),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    const json = JSON.stringify(
      f.sql
        .prepare('SELECT * FROM action_engine_quote_publication_evidence')
        .get(),
    );
    expect(json).not.toContain(f.native.source.senderEmail);
    expect(json).not.toContain(f.native.source.body);
    expect(json).not.toContain(f.native.proposal.plan.title);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
  });
  it('same proof is idempotent across connections and clean reopen after a lost acknowledgement', async () => {
    const f = current();
    f.seed();
    const a = f.create(),
      second = f.connect(),
      b = f.create(second),
      v = await f.native.verify();
    a.failNext('lost');
    await expect(a.evidence.append(f.actor, v)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    const replay = await b.evidence.append(f.actor, v);
    expect(f.count('action_engine_quote_publication_evidence')).toBe(1);
    f.close(second);
    const reopened = f.create(f.connect());
    expect(await reopened.evidence.read(f.actor, v.reservationId)).toEqual(
      replay,
    );
    expect(await reopened.evidence.append(f.actor, v)).toEqual(replay);
  });
  it('rollback before commit leaves no evidence and explicit retry succeeds once', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      v = await f.native.verify();
    client.failNext('rollback');
    await expect(client.evidence.append(f.actor, v)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(f.count('action_engine_quote_publication_evidence')).toBe(0);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
    await client.evidence.append(f.actor, v);
    expect(f.count('action_engine_quote_publication_evidence')).toBe(1);
  });
  it('revocation on another connection between fence preparation and batch forbids append atomically', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      other = f.connect(),
      v = await f.native.verify();
    client.beforeNext(() => {
      other
        .prepare(
          'UPDATE qa_quote_proof_rights SET allowed=0 WHERE organization_id=?',
        )
        .run(f.actor.organizationId);
    });
    await expect(client.evidence.append(f.actor, v)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.count('action_engine_quote_publication_evidence')).toBe(0);
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
    await expect(
      client.evidence.read(f.actor, v.reservationId),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('scopes absence by tenant and refuses a foreign actor before awaiting a fence', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      v = await f.native.verify();
    await client.evidence.append(f.actor, v);
    expect(
      await client.evidence.read(
        { organizationId: 'other-company', userId: 'other-user' },
        v.reservationId,
      ),
    ).toBeNull();
    const before = client.batches.length;
    await expect(
      client.evidence.append(
        { organizationId: 'other-company', userId: 'other-user' },
        v,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(client.batches.length).toBe(before);
  });
  it('requires the exact persisted binding even for a genuinely sealed verifier result', async () => {
    const f = current();
    f.planningPublication();
    // A valid archive can be verified with its own binding; the reservation was
    // deliberately linked to a different original resource generation in D1.
    const b = { ...f.native.binding, resourcesSha256: '0'.repeat(64) };
    const p = f.native.proposal,
      r = f.native.reservation,
      h = b.planningPublication;
    f.sql
      .prepare(
        'INSERT INTO action_engine_quote_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        p.id,
        p.organizationId,
        p.plan.sourceId,
        p.plan.kind,
        p.fingerprint,
        p.plan.sourceRevision,
        p.plan.contextRevision,
        JSON.stringify(p.plan),
        r.userId,
        r.createdAt,
      );
    f.sql
      .prepare(
        'INSERT INTO action_engine_quote_reservations(id,organization_id,proposal_id,fingerprint,user_id,installation_id,customer_id,quote_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        r.id,
        r.organizationId,
        r.proposalId,
        r.fingerprint,
        r.userId,
        r.installationId,
        r.customerId,
        r.quoteId,
        r.createdAt,
      );
    f.sql
      .prepare(
        'INSERT INTO action_engine_quote_reservation_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        r.id,
        r.organizationId,
        r.proposalId,
        r.fingerprint,
        b.resourcesSha256,
        b.sourceCanonicalSha256,
        h.snapshotId,
        h.revision,
        h.baseRevision,
        h.archiveSha256,
        h.manifestSha256,
        r.createdAt,
      );
    f.publication(f.native.publication);
    await expect(
      f.create().evidence.append(f.actor, await f.native.verify()),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(f.count('action_engine_quote_publication_evidence')).toBe(0);
  });
  it('rejects a different sealed archive for the same reservation without altering the original evidence', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      v = await f.native.verify(),
      saved = await client.evidence.append(f.actor, v);
    const p = {
      ...f.native.publication,
      id: uuid(920),
      snapshotId: uuid(921),
      baseRevision: 5,
      result: { committed: true, revision: 6, snapshotId: uuid(921) },
    };
    f.publication(p);
    const second = await verifyCanonicalQuotePublication({
      ...f.native.input(),
      publication: p,
    });
    await expect(client.evidence.append(f.actor, second)).rejects.toMatchObject(
      { code: 'conflict' },
    );
    expect(await client.evidence.read(f.actor, v.reservationId)).toEqual(saved);
  });
  for (const field of ['userId', 'installationId', 'createdAt'] as const)
    it(`SQL independently corroborates publication ${field}`, async () => {
      const f = current(),
        v = await f.native.verify();
      const patch =
        field === 'userId'
          ? { userId: 'other-user' }
          : field === 'installationId'
            ? { installationId: uuid(950) }
            : { createdAt: f.native.reservation.createdAt - 1 };
      f.seed(true, { ...f.native.publication, ...patch });
      expect(() => f.insertEvidence(v)).toThrow(
        'action_engine_quote_evidence_invalid',
      );
      expect(f.count('action_engine_quote_publication_evidence')).toBe(0);
    });
  it('SQL refuses the old planning publication as a quote creation proof', async () => {
    const f = current();
    f.seed();
    const v = await f.native.verify(),
      p = f.native.binding.planningPublication;
    const oldId = f.sql
      .prepare(
        'SELECT id FROM action_engine_publication_attempts WHERE organization_id=? AND snapshot_id=?',
      )
      .get(p.organizationId, p.snapshotId)?.id;
    expect(typeof oldId).toBe('string');
    expect(() =>
      f.insertEvidence({ ...v, publicationAttemptId: oldId as string, ...p }),
    ).toThrow('action_engine_quote_evidence_invalid');
  });
  it('keeps historical confirmation valid after newer committed and pending publications and stale catalogue/source', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      v = await f.native.verify();
    await expect(
      client.ledger.confirmExecution(
        f.actor,
        v.proposalId,
        v.installationId,
        v.reservationId,
        v.receipt,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await client.evidence.append(f.actor, v);
    f.publication({
      ...f.native.publication,
      id: uuid(930),
      snapshotId: uuid(931),
      baseRevision: 5,
      result: { committed: true, revision: 6, snapshotId: uuid(931) },
    });
    f.publication({
      ...f.native.publication,
      id: uuid(932),
      snapshotId: uuid(933),
      baseRevision: 6,
      state: 'pending',
      result: null,
      settledAt: null,
    });
    f.sql.exec(
      'UPDATE qa_quote_proof_rights SET source_current=0,catalogue_current=0',
    );
    const expected = {
      organizationId: v.organizationId,
      proposalId: v.proposalId,
      reservationId: v.reservationId,
      fingerprint: v.fingerprint,
      userId: v.userId,
      installationId: v.installationId,
      customerId: v.customerId,
      quoteId: v.quoteId,
      receipt: v.receipt,
    };
    const gate = quotePublicationEvidencePredicate(expected);
    expect(
      f.sql.prepare(`SELECT (${gate.sql}) allowed`).get(...gate.bindings)
        ?.allowed,
    ).toBe(1);
    const history = historicalQuotePublicationPredicate(
      f.native.binding.planningPublication,
    );
    expect(
      f.sql.prepare(`SELECT (${history.sql}) allowed`).get(...history.bindings)
        ?.allowed,
    ).toBe(1);
    expect(
      await client.ledger.confirmExecution(
        f.actor,
        v.proposalId,
        v.installationId,
        v.reservationId,
        v.receipt,
      ),
    ).toEqual(v.receipt);
    expect(
      await client.ledger.reserveExecution(
        f.actor,
        v.proposalId,
        v.installationId,
      ),
    ).toEqual({ state: 'confirmed', receipt: v.receipt });
    const forged = quotePublicationEvidencePredicate({
      ...expected,
      quoteId: uuid(999),
      receipt: { ...v.receipt, quoteId: uuid(999) },
    });
    expect(
      f.sql.prepare(`SELECT (${forged.sql}) allowed`).get(...forged.bindings)
        ?.allowed,
    ).toBe(0);
  });
  it('rejects malformed/private accessor database results without exposing their values', async () => {
    const f = current();
    f.seed();
    const client = f.create(),
      v = await f.native.verify();
    await client.evidence.append(f.actor, v);
    client.failNext('malformed');
    await expect(
      client.evidence.read(f.actor, v.reservationId),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    client.failNext('accessor');
    await expect(
      client.evidence.read(f.actor, v.reservationId),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(client.getterCalls()).toBe(0);
  });
  it('uses the real historical fence: proof required, fresh access required, no save/reserve progression', async () => {
    const f = current();
    f.seed();
    const client = f.historical(),
      v = await f.native.verify();
    await expect(
      client.ledger.confirmExecution(
        f.actor,
        v.proposalId,
        v.installationId,
        v.reservationId,
        v.receipt,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await client.evidence.append(f.actor, v);
    await expect(
      client.ledger.reserveExecution(f.actor, v.proposalId, v.installationId),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      client.ledger.saveProposal(
        f.actor,
        f.native.proposal.plan,
        f.native.proposal.fingerprint,
        {
          ...f.actor,
          revision: 'qa-v1',
          automationActive: true,
          mayPrepareQuote: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    f.publication({
      ...f.native.publication,
      id: uuid(960),
      snapshotId: uuid(961),
      baseRevision: 5,
      result: { committed: true, revision: 6, snapshotId: uuid(961) },
    });
    f.sql.exec(
      'UPDATE qa_quote_proof_rights SET source_current=0,catalogue_current=0',
    );
    client.beforeNext(() =>
      f.sql.exec('UPDATE qa_quote_support_access SET allowed=0'),
    );
    await expect(
      client.ledger.confirmExecution(
        f.actor,
        v.proposalId,
        v.installationId,
        v.reservationId,
        v.receipt,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      f.sql
        .prepare('SELECT receipt_json FROM action_engine_quote_reservations')
        .get()?.receipt_json,
    ).toBeNull();
    f.sql.exec('UPDATE qa_quote_support_access SET allowed=1');
    expect(
      await client.ledger.confirmExecution(
        f.actor,
        v.proposalId,
        v.installationId,
        v.reservationId,
        v.receipt,
      ),
    ).toEqual(v.receipt);
    f.sql.exec('UPDATE qa_quote_proof_rights SET allowed=0');
    await expect(
      client.ledger.confirmExecution(
        f.actor,
        v.proposalId,
        v.installationId,
        v.reservationId,
        v.receipt,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.count('action_engine_atomic_assertions')).toBe(0);
  });
  it('SQL guards reject updates/deletes, REPLACE and IGNORE on both immutable records', async () => {
    const f = current();
    f.seed();
    const client = f.create();
    await client.evidence.append(f.actor, await f.native.verify());
    for (const table of [
      'action_engine_quote_reservation_bindings',
      'action_engine_quote_publication_evidence',
    ]) {
      expect(() =>
        f.sql.exec(`UPDATE ${table} SET fingerprint=printf('%064d',0)`),
      ).toThrow('immutable');
      expect(() => f.sql.exec(`DELETE FROM ${table}`)).toThrow('immutable');
      expect(() =>
        f.sql.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),
      ).toThrow('immutable');
      expect(() =>
        f.sql.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}`),
      ).toThrow('immutable');
    }
    expect(f.count('action_engine_quote_publication_evidence')).toBe(1);
    expect(f.count('action_engine_quote_reservation_bindings')).toBe(1);
  });
  it('audit and receipt alone cannot produce a sealed first proof when actual quote rows are absent', async () => {
    const f = current();
    f.seed();
    f.native.sql.exec('DELETE FROM quote_items; DELETE FROM quotes;');
    await expect(f.native.verify()).rejects.toMatchObject({
      code: 'review_required',
    });
    expect(f.count('action_engine_quote_publication_evidence')).toBe(0);
  });
});
