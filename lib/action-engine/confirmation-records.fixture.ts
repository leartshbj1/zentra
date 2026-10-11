/** Test-only composition: real cumulative D1 SQL, synthetic native rows and
 * explicit QA authority/delegation predicates. No production admission claim. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { makeCanonicalQuoteFixture } from './canonical-quote.fixture';
import { createHistoricalQuoteFences } from './historical-quote-fences';
import type { PublicationAttempt } from './publication-ledger-types';
import type { QuoteConfirmationIdentity } from './confirmation-records';

type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => Statement;
};
export function confirmationSqliteAdapter(sql: DatabaseSync) {
  let before: (() => void | Promise<void>) | null = null;
  let transform: ((rows: unknown[]) => unknown[]) | null = null;
  let fault: 'rollback' | 'lost' | null = null;
  const batches: string[][] = [];
  const db = {
    prepare(query: string) {
      const s: Statement = {
        sql: query,
        values: [],
        bind(...values) {
          s.values = [...values];
          return s;
        },
      };
      return s;
    },
    async batch(statements: Statement[]) {
      const hook = before,
        mutate = transform,
        failure = fault;
      before = null;
      transform = null;
      fault = null;
      if (hook) await hook();
      batches.push(statements.map((s) => s.sql));
      sql.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const results = statements.map((s) => {
          const q = sql.prepare(s.sql);
          return q.columns().length
            ? {
                success: true,
                results: q.all(...s.values),
                meta: { changes: 0 },
              }
            : {
                success: true,
                results: [],
                meta: { changes: Number(q.run(...s.values).changes) },
              };
        });
        if (failure === 'rollback') throw Error('Synthetic rollback');
        sql.exec('COMMIT');
        committed = true;
        if (failure === 'lost') throw Error('Synthetic lost acknowledgement');
        return mutate ? mutate(results) : results;
      } catch (error) {
        if (!committed) sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    db: db as unknown as Pick<D1Database, 'prepare' | 'batch'>,
    batches,
    beforeNext(hook: () => void | Promise<void>) {
      before = hook;
    },
    transformNext(mutate: (rows: unknown[]) => unknown[]) {
      transform = mutate;
    },
    failNext(failure: 'rollback' | 'lost') {
      fault = failure;
    },
  };
}

export function makeQuoteConfirmationFixture() {
  const native = makeCanonicalQuoteFixture(),
    directory = mkdtempSync(join(tmpdir(), 'zentra-confirmation-records-')),
    path = join(directory, 'd1.sqlite');
  const connections: DatabaseSync[] = [];
  function connect() {
    const connection = new DatabaseSync(path);
    connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
    connections.push(connection);
    return connection;
  }
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
  sql.exec(`CREATE TABLE qa_confirmation_authority(organization_id TEXT PRIMARY KEY,allowed INTEGER NOT NULL);
    INSERT INTO qa_confirmation_authority VALUES('synthetic-company',1),('other-company',1);
    CREATE TABLE qa_confirmation_support(source_id TEXT PRIMARY KEY,allowed INTEGER NOT NULL);
    INSERT INTO qa_confirmation_support VALUES('synthetic-source',1);`);
  const actor = Object.freeze({
    organizationId: native.reservation.organizationId,
    userId: native.reservation.userId,
  });
  const identity: QuoteConfirmationIdentity = Object.freeze({
    actor,
    installationId: native.reservation.installationId,
    sourceId: native.source.id,
    proposalId: native.proposal.id,
    reservationId: native.reservation.id,
  });
  let sequence = 6000;
  const nextId = () =>
    `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  function seedPublication(p: PublicationAttempt) {
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
  function seed(withBinding = true) {
    const p = native.proposal,
      r = native.reservation,
      b = native.binding,
      h = b.planningPublication;
    seedPublication({
      id: nextId(),
      organizationId: h.organizationId,
      snapshotId: h.snapshotId,
      installationId: r.installationId,
      userId: r.userId,
      baseRevision: h.baseRevision,
      archiveSha256: h.archiveSha256,
      manifestSha256: h.manifestSha256,
      sizeBytes: 1000,
      state: 'committed',
      result: {
        committed: true,
        revision: h.revision,
        snapshotId: h.snapshotId,
      },
      createdAt: r.createdAt - 10,
      settledAt: r.createdAt - 5,
    });
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
          nextId(),
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
  }
  function historical() {
    return createHistoricalQuoteFences(
      {
        actor,
        installationId: identity.installationId,
        predicate: () => ({
          sql: 'EXISTS(SELECT 1 FROM qa_confirmation_authority WHERE organization_id=? AND allowed=1)',
          bindings: [actor.organizationId],
        }),
        preflight: async () => {
          throw Error('Unexpected preparation authority');
        },
        preflightCas: async () => {
          throw Error('Unexpected preparation authority');
        },
        authorizeRead: async () => {},
      },
      {
        sourceId: identity.sourceId,
        workspaceId: 'qa-workspace',
        predicate: () => ({
          sql: 'EXISTS(SELECT 1 FROM qa_confirmation_support WHERE source_id=? AND allowed=1)',
          bindings: [identity.sourceId],
        }),
      },
    );
  }
  function seedUsIntent(organizationId = actor.organizationId) {
    // Actual 0085 schema/guards. This row is an intention, not an admitted US
    // organization; A7 must refuse it even when the QA entitlement is allowed.
    sql
      .prepare(`INSERT INTO international_workspace_creation_intents(
      creation_id,organization_id,actor_user_id,request_id,country_code,
      confirmation_version,company_name,configuration_fingerprint,
      configuration_json,state,created_at,updated_at)
      VALUES(?,?,?,?,'US',1,'Synthetic US intention',?,?,'reserved',?,?)`)
      .run(
        nextId(),
        organizationId,
        actor.userId,
        nextId(),
        'a'.repeat(64),
        JSON.stringify({
          organizationId,
          country: 'US',
          currency: 'USD',
          taxConfiguration: { status: 'unconfigured' },
        }),
        '2026-10-11T12:00:00.000Z',
        '2026-10-11T12:00:00.000Z',
      );
  }
  const adapter = confirmationSqliteAdapter(sql);
  return {
    native,
    actor,
    identity,
    sql,
    db: adapter.db,
    adapter,
    migrations,
    connect,
    nextId,
    seedPublication,
    seed,
    historical,
    seedUsIntent,
    close(connection?: DatabaseSync) {
      if (connection) {
        connection.close();
        connections.splice(connections.indexOf(connection), 1);
        return;
      }
      native.close();
      for (const value of connections.splice(0)) value.close();
      const target = resolve(directory),
        parent = resolve(tmpdir());
      if (
        !target.startsWith(parent + sep) ||
        !target.includes('zentra-confirmation-records-')
      )
        throw Error('Unsafe QA path');
      rmSync(target, { recursive: true, force: true });
    },
  };
}
