import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  PUBLICATION_MAX_ARCHIVE_BYTES,
  capturePublicationAttempt,
  capturePublicationIdentity,
  capturePublicationResult,
  createPublicationLedger,
  publicationPredicate,
} from './publication-ledger';
import {
  PublicationLedgerError,
  type PublicationAttempt,
  type PublicationExpectation,
  type PublicationIdentity,
  type PublicationResult,
} from './publication-ledger-types';

// Real SQLite transactions and the complete D1 migration chain. The QA rights
// table below proves composition/rollback only, not production admission or PG.
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function identity(
  overrides: Partial<PublicationIdentity> = {},
): PublicationIdentity {
  return {
    organizationId: 'org-a',
    snapshotId: uuid(1),
    installationId: uuid(2),
    userId: 'user-a',
    baseRevision: 0,
    archiveSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    sizeBytes: 4096,
    ...overrides,
  };
}
const committed = (attempt: PublicationAttempt): PublicationResult => ({
  committed: true,
  revision: attempt.baseRevision + 1,
  snapshotId: attempt.snapshotId,
});

describe('publication witness composition and SQL integrity', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    f.cleanup();
  });
  const witness = (sql: DatabaseSync, expected: PublicationExpectation) => {
    const predicate = publicationPredicate(expected);
    return sql
      .prepare(`SELECT (${predicate.sql}) AS allowed`)
      .get(...predicate.bindings)?.allowed;
  };
  const insertAttempt = (
    sql: DatabaseSync,
    value: PublicationAttempt,
    mode: 'INSERT' | 'INSERT OR IGNORE' | 'INSERT OR REPLACE' = 'INSERT',
  ) => {
    sql
      .prepare(`${mode} INTO action_engine_publication_attempts
      (id,organization_id,snapshot_id,installation_id,user_id,base_revision,archive_sha256,manifest_sha256,size_bytes,state,result_json,created_at,settled_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        value.id,
        value.organizationId,
        value.snapshotId,
        value.installationId,
        value.userId,
        value.baseRevision,
        value.archiveSha256,
        value.manifestSha256,
        value.sizeBytes,
        value.state,
        value.result === null ? null : JSON.stringify(value.result),
        value.createdAt,
        value.settledAt,
      );
  };

  it('pending or cancelled outcomes never constitute a publication witness', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    expect(witness(f.sql, expectation(attempt))).toBe(0);
    await ledger.settle(attempt, {
      committed: false,
      revision: 0,
      snapshotId: null,
    });
    expect(witness(f.sql, expectation(attempt))).toBe(0);
  });

  it('requires the exact six expected fields, no organization pending and no newer committed revision', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    await ledger.settle(attempt, committed(attempt));
    const expected = expectation(attempt);
    expect(ledger.publicationPredicate(expected)).toEqual(
      publicationPredicate(expected),
    );
    expect(witness(f.sql, expected)).toBe(1);
    expect(witness(f.sql, { ...expected, archiveSha256: 'c'.repeat(64) })).toBe(
      0,
    );
    expect(
      witness(f.sql, { ...expected, manifestSha256: 'c'.repeat(64) }),
    ).toBe(0);
    expect(witness(f.sql, { ...expected, organizationId: 'org-b' })).toBe(0);
    expect(witness(f.sql, { ...expected, snapshotId: uuid(70) })).toBe(0);
    expect(witness(f.sql, { ...expected, revision: 2, baseRevision: 1 })).toBe(
      0,
    );
    const pending = (
      await ledger.begin(identity({ snapshotId: uuid(13), baseRevision: 1 }))
    ).attempt;
    expect(witness(f.sql, expected)).toBe(0);
    await ledger.settle(pending, {
      committed: false,
      revision: 1,
      snapshotId: attempt.snapshotId,
    });
    expect(witness(f.sql, expected)).toBe(1);
    const newer = (
      await ledger.begin(identity({ snapshotId: uuid(14), baseRevision: 1 }))
    ).attempt;
    await ledger.settle(newer, committed(newer));
    expect(witness(f.sql, expected)).toBe(0);
    expect(witness(f.sql, expectation(newer))).toBe(1);
  });

  it('an unrelated organization pending/commit does not alter this witness', async () => {
    const { ledger } = f.create();
    const a = (await ledger.begin(identity())).attempt;
    await ledger.settle(a, committed(a));
    const b = (
      await ledger.begin(
        identity({
          organizationId: 'org-b',
          userId: 'user-b',
          snapshotId: uuid(15),
          baseRevision: 5,
        }),
      )
    ).attempt;
    expect(witness(f.sql, expectation(a))).toBe(1);
    await ledger.settle(b, committed(b));
    expect(witness(f.sql, expectation(a))).toBe(1);
  });

  it('a fresh permission predicate and publication witness fence confirmation in the same transaction', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    await ledger.settle(attempt, committed(attempt));
    const expected = expectation(attempt),
      predicate = publicationPredicate(expected);
    const transport = adapter(f.sql),
      prepare = transport.database.prepare.bind(transport.database);
    const confirm = (confirmationId: string) =>
      transport.database.batch([
        prepare(`INSERT INTO action_engine_atomic_assertions(operation_id,allowed)
        SELECT ?,COALESCE((EXISTS(SELECT 1 FROM qa_publication_rights WHERE organization_id=? AND allowed=1)
        AND (${predicate.sql})),0)`).bind(
          confirmationId,
          expected.organizationId,
          ...predicate.bindings,
        ),
        prepare('INSERT INTO qa_publication_confirmations VALUES(?,?,?)').bind(
          confirmationId,
          expected.organizationId,
          expected.snapshotId,
        ),
        prepare(
          'DELETE FROM action_engine_atomic_assertions WHERE operation_id=?',
        ).bind(confirmationId),
      ]);
    expect(
      f.sql
        .prepare(
          "SELECT allowed FROM qa_publication_rights WHERE organization_id='org-a'",
        )
        .get()?.allowed,
    ).toBe(1);
    transport.beforeNext(async () => {
      f.sql.exec(
        "UPDATE qa_publication_rights SET allowed=0 WHERE organization_id='org-a'",
      );
    });
    await expect(confirm('denied-after-observe')).rejects.toThrow();
    expect(f.counts()).toMatchObject({ assertions: 0, confirmations: 0 });
    f.sql.exec(
      "UPDATE qa_publication_rights SET allowed=1 WHERE organization_id='org-a'",
    );
    await confirm('admitted');
    expect(f.counts()).toMatchObject({ assertions: 0, confirmations: 1 });
    const pending = (
      await ledger.begin(identity({ snapshotId: uuid(16), baseRevision: 1 }))
    ).attempt;
    await expect(confirm('pending-publication')).rejects.toThrow();
    expect(f.counts().confirmations).toBe(1);
    await ledger.settle(pending, {
      committed: false,
      revision: 1,
      snapshotId: attempt.snapshotId,
    });
    transport.failNext('rollback');
    await expect(confirm('rolled-back-confirmation')).rejects.toThrow();
    expect(f.counts()).toMatchObject({ assertions: 0, confirmations: 1 });
  });

  it('failed begin transaction does not strand the organization or close an existing witness', async () => {
    const transport = f.create();
    const { attempt } = await transport.ledger.begin(identity());
    await transport.ledger.settle(attempt, committed(attempt));
    transport.failNext('rollback');
    await expect(
      transport.ledger.begin(
        identity({ snapshotId: uuid(17), baseRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(witness(f.sql, expectation(attempt))).toBe(1);
    expect(f.counts()).toMatchObject({ attempts: 1, events: 2 });
  });

  it.each(['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE'] as const)(
    '%s cannot bypass snapshot/id/pending collisions or rewrite audit',
    async (mode) => {
      const { ledger } = f.create();
      const { attempt } = await ledger.begin(identity());
      for (const changed of [
        attempt,
        { ...attempt, id: uuid(300) },
        { ...attempt, id: uuid(301), snapshotId: uuid(302) },
      ])
        expect(() => insertAttempt(f.sql, changed, mode)).toThrow();
      expect(f.counts()).toMatchObject({ attempts: 1, events: 1 });
      const settled = await ledger.settle(attempt, committed(attempt));
      expect(() =>
        insertAttempt(f.sql, { ...attempt, snapshotId: uuid(303) }, mode),
      ).toThrow();
      expect(() =>
        insertAttempt(f.sql, { ...attempt, id: uuid(304) }, mode),
      ).toThrow();
      expect((await ledger.begin(identity())).attempt).toEqual(settled);
      expect(f.counts().events).toBe(2);
    },
  );

  it('direct SQL cannot fabricate terminal insertion, mutate identity, erase or amend a terminal history', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    expect(() =>
      insertAttempt(f.sql, {
        ...attempt,
        id: uuid(310),
        snapshotId: uuid(311),
        organizationId: 'org-b',
        state: 'committed',
        result: { committed: true, revision: 1, snapshotId: uuid(311) },
        settledAt: attempt.createdAt,
      }),
    ).toThrow();
    expect(() =>
      f.sql
        .prepare(
          'UPDATE action_engine_publication_attempts SET archive_sha256=? WHERE id=?',
        )
        .run('d'.repeat(64), attempt.id),
    ).toThrow();
    expect(() =>
      f.sql
        .prepare('DELETE FROM action_engine_publication_attempts WHERE id=?')
        .run(attempt.id),
    ).toThrow();
    await ledger.settle(attempt, committed(attempt));
    expect(() =>
      f.sql
        .prepare(
          'UPDATE action_engine_publication_attempts SET settled_at=settled_at WHERE id=?',
        )
        .run(attempt.id),
    ).toThrow();
    expect(() =>
      f.sql
        .prepare(
          "UPDATE action_engine_publication_attempts SET state='pending',result_json=NULL,settled_at=NULL WHERE id=?",
        )
        .run(attempt.id),
    ).toThrow();
    expect(f.counts()).toMatchObject({ attempts: 1, events: 2 });
  });

  it.each([
    '{"committed":true,"revision":1,"snapshotId":"00000000-0000-4000-8000-000000000001","extra":1}',
    '{"committed":true,"revision":1,"revision":1,"snapshotId":"00000000-0000-4000-8000-000000000001"}',
    '{"committed":true,"revision":1,"snapshotId":null}',
    '{"committed":false,"revision":1,"snapshotId":"00000000-0000-4000-8000-000000000001"}',
    '{"committed":1,"revision":1,"snapshotId":"00000000-0000-4000-8000-000000000001"}',
    '{"committed":true,"revision":"1","snapshotId":"00000000-0000-4000-8000-000000000001"}',
  ])(
    'SQL independently rejects malformed/coherent-looking terminal JSON %s',
    async (result) => {
      const { ledger } = f.create();
      const { attempt } = await ledger.begin(identity());
      expect(() =>
        f.sql
          .prepare(
            "UPDATE action_engine_publication_attempts SET state='committed',result_json=?,settled_at=? WHERE id=?",
          )
          .run(result, attempt.createdAt, attempt.id),
      ).toThrow();
      expect((await ledger.begin(identity())).attempt.state).toBe('pending');
      expect(f.counts().events).toBe(1);
    },
  );

  it.each(['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE'] as const)(
    '%s cannot overwrite or silently suppress audit',
    async (mode) => {
      const { ledger } = f.create();
      const { attempt } = await ledger.begin(identity());
      const insert = f.sql.prepare(
        `${mode} INTO action_engine_publication_events VALUES(?,?,?,?)`,
      );
      expect(() =>
        insert.run(
          attempt.id,
          attempt.organizationId,
          'pending',
          attempt.createdAt,
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          attempt.id,
          attempt.organizationId,
          'committed',
          attempt.createdAt,
        ),
      ).toThrow();
      expect(() =>
        f.sql
          .prepare(
            'UPDATE action_engine_publication_events SET created_at=created_at',
          )
          .run(),
      ).toThrow();
      expect(() =>
        f.sql.prepare('DELETE FROM action_engine_publication_events').run(),
      ).toThrow();
      expect(f.counts().events).toBe(1);
    },
  );

  it('transport writes do not alter proposals, reservations, provider intake or business settings', async () => {
    const tables = [
      'action_engine_quote_proposals',
      'action_engine_quote_reservations',
      'action_engine_quote_events',
      'action_engine_quote_intake',
      'action_engine_quote_intake_events',
      'action_engine_quote_settings',
    ];
    const counts = () =>
      tables.map(
        (table) => f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
      );
    const before = counts(),
      { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    await ledger.settle(attempt, committed(attempt));
    expect(counts()).toEqual(before);
    expect(
      f.sql
        .prepare('PRAGMA table_info(action_engine_publication_events)')
        .all()
        .map((row) => row.name),
    ).toEqual(['attempt_id', 'organization_id', 'event_type', 'created_at']);
  });
});

describe('closed private publication captures', () => {
  it.each([
    { organizationId: '' },
    { organizationId: 'org\u0000a' },
    { organizationId: 'é' },
    { userId: 'x'.repeat(161) },
    { snapshotId: '00000000-0000-5000-8000-000000000001' },
    { installationId: 'installation-a' },
    { baseRevision: -1 },
    { baseRevision: Number.MAX_SAFE_INTEGER },
    { baseRevision: 0.5 },
    { archiveSha256: 'A'.repeat(64) },
    { manifestSha256: 'g'.repeat(64) },
    { sizeBytes: 0 },
    { sizeBytes: PUBLICATION_MAX_ARCHIVE_BYTES + 1 },
    { sizeBytes: 1.25 },
  ])('rejects out-of-contract identity %j', (change) => {
    expect(() => capturePublicationIdentity(identity(change))).toThrow(
      PublicationLedgerError,
    );
  });

  it('accepts the exact single-archive and safe revision bounds', () => {
    expect(PUBLICATION_MAX_ARCHIVE_BYTES).toBe(536870912);
    const captured = capturePublicationIdentity(
      identity({
        sizeBytes: PUBLICATION_MAX_ARCHIVE_BYTES,
        baseRevision: Number.MAX_SAFE_INTEGER - 1,
      }),
    );
    expect(
      capturePublicationResult(
        {
          committed: true,
          revision: Number.MAX_SAFE_INTEGER,
          snapshotId: captured.snapshotId,
        },
        captured,
      ).revision,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['getter', 'symbol', 'hidden', 'extra', 'prototype'] as const)(
    'rejects %s identity fields without invoking user code',
    (kind) => {
      let calls = 0;
      const value = { ...identity() };
      if (kind === 'getter')
        Object.defineProperty(value, 'archiveSha256', {
          enumerable: true,
          get() {
            calls++;
            throw Error('secret');
          },
        });
      if (kind === 'symbol')
        Object.defineProperty(value, Symbol('secret'), {
          value: 1,
          enumerable: true,
        });
      if (kind === 'hidden')
        Object.defineProperty(value, 'secret', { value: 1 });
      if (kind === 'extra') Object.assign(value, { secret: 1 });
      if (kind === 'prototype') Object.setPrototypeOf(value, { secret: 1 });
      expect(() => capturePublicationIdentity(value)).toThrow(
        PublicationLedgerError,
      );
      expect(calls).toBe(0);
    },
  );

  it('rejects getters in result, identity expectation and helper source identity without invocation', () => {
    let calls = 0;
    const request = identity(),
      raw = { committed: true, revision: 1, snapshotId: request.snapshotId };
    Object.defineProperty(raw, 'revision', {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    expect(() => capturePublicationResult(raw, request)).toThrow(
      PublicationLedgerError,
    );
    const unsafe = { ...request };
    Object.defineProperty(unsafe, 'baseRevision', {
      enumerable: true,
      get() {
        calls++;
        return 0;
      },
    });
    expect(() =>
      capturePublicationResult(
        { committed: true, revision: 1, snapshotId: request.snapshotId },
        unsafe,
      ),
    ).toThrow(PublicationLedgerError);
    const expected = {
      organizationId: request.organizationId,
      snapshotId: request.snapshotId,
      baseRevision: 0,
      revision: 1,
      archiveSha256: request.archiveSha256,
      manifestSha256: request.manifestSha256,
    };
    Object.defineProperty(expected, 'archiveSha256', {
      enumerable: true,
      get() {
        calls++;
        return 'a'.repeat(64);
      },
    });
    expect(() => publicationPredicate(expected)).toThrow(
      PublicationLedgerError,
    );
    expect(calls).toBe(0);
  });

  it('closed attempt rejects contradictory state/result/timestamp combinations', () => {
    const pending = {
      ...identity(),
      id: uuid(500),
      state: 'pending',
      result: null,
      createdAt: 1,
      settledAt: null,
    } as const;
    expect(capturePublicationAttempt(pending)).toEqual(pending);
    for (const change of [
      { state: 'committed' },
      { settledAt: 1 },
      {
        result: {
          committed: true,
          revision: 1,
          snapshotId: pending.snapshotId,
        },
      },
      { createdAt: 0 },
      { createdAt: 253402300800 },
      {
        state: 'cancelled',
        result: {
          committed: true,
          revision: 1,
          snapshotId: pending.snapshotId,
        },
        settledAt: 1,
      },
    ])
      expect(() =>
        capturePublicationAttempt({ ...pending, ...change }),
      ).toThrow(PublicationLedgerError);
  });

  it('predicate rejects non-successor revision and is immutable/parameterized', () => {
    const request = identity(),
      expected = {
        organizationId: request.organizationId,
        snapshotId: request.snapshotId,
        baseRevision: 0,
        revision: 1,
        archiveSha256: request.archiveSha256,
        manifestSha256: request.manifestSha256,
      };
    expect(() => publicationPredicate({ ...expected, revision: 2 })).toThrow(
      PublicationLedgerError,
    );
    const predicate = publicationPredicate(expected);
    expect(predicate.sql).not.toContain(request.organizationId);
    expect(predicate.sql).not.toContain(request.archiveSha256);
    expect(Object.isFrozen(predicate)).toBe(true);
    expect(Object.isFrozen(predicate.bindings)).toBe(true);
  });

  it('masks rejected DB failures and never invokes arbitrary error getters', async () => {
    let getters = 0;
    const failure = new Error('private-row-body');
    Object.defineProperty(failure, 'message', {
      get() {
        getters++;
        return 'private-row-body';
      },
    });
    const database = {
      prepare: () => ({
        bind() {
          return this;
        },
      }),
      batch: async () => {
        throw failure;
      },
    };
    const ledger = createPublicationLedger(
      database as unknown as Pick<D1Database, 'prepare' | 'batch'>,
      { nextId: () => uuid(501), now: () => 10 },
    );
    await expect(ledger.begin(identity())).rejects.toMatchObject({
      code: 'service_unavailable',
      message: 'service_unavailable',
    });
    expect(getters).toBe(0);
  });
});
const expectation = (attempt: PublicationAttempt): PublicationExpectation => ({
  organizationId: attempt.organizationId,
  snapshotId: attempt.snapshotId,
  revision: attempt.baseRevision + 1,
  baseRevision: attempt.baseRevision,
  archiveSha256: attempt.archiveSha256,
  manifestSha256: attempt.manifestSha256,
});

type Statement = {
  sql: string;
  values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => Statement;
};
type Fault = 'rollback' | 'lost' | 'null' | 'accessor';
function adapter(sql: DatabaseSync) {
  let fault: Fault | null = null;
  let hook: (() => Promise<void>) | null = null;
  let getterCalls = 0;
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
      batches.push(statements.map((statement) => statement.sql));
      sql.exec('BEGIN IMMEDIATE');
      let didCommit = false;
      try {
        const results = statements.map((statement) => {
          const native = sql.prepare(statement.sql);
          if (/^\s*SELECT\b/i.test(statement.sql))
            return {
              success: true,
              results: native.all(...statement.values),
              meta: { changes: 0 },
            };
          const result = native.run(...statement.values);
          return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes) },
          };
        });
        if (currentFault === 'rollback')
          throw Error('Synthetic failure before commit');
        sql.exec('COMMIT');
        didCommit = true;
        if (currentFault === 'lost')
          throw Error('Synthetic lost acknowledgement after commit');
        if (currentFault === 'null') return null;
        if (currentFault === 'accessor') {
          Object.defineProperty(results[results.length - 1], 'results', {
            get() {
              getterCalls++;
              throw Error('private-row-body');
            },
          });
        }
        return results;
      } catch (error) {
        if (!didCommit) sql.exec('ROLLBACK');
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
    beforeNext(value: () => Promise<void>) {
      hook = value;
    },
    getterCalls: () => getterCalls,
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'zentra-publication-ledger-'));
  const file = join(directory, 'publications.sqlite');
  const connections: DatabaseSync[] = [];
  const connect = () => {
    const connection = new DatabaseSync(file);
    connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
    connections.push(connection);
    return connection;
  };
  const sql = connect();
  const migrations = readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // Keep the real chain; one setup transaction avoids thousands of unrelated
  // disk fsyncs per fixture. Test batches below still commit/reopen separately.
  sql.exec('BEGIN IMMEDIATE');
  for (const name of migrations)
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  sql.exec('COMMIT');
  sql.exec(`CREATE TABLE qa_publication_rights(organization_id TEXT PRIMARY KEY,allowed INTEGER NOT NULL);
    CREATE TABLE qa_publication_confirmations(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,snapshot_id TEXT NOT NULL);
    INSERT INTO qa_publication_rights VALUES('org-a',1),('org-b',1);`);
  let sequence = 100,
    clock = 2_000_000_000;
  const create = (
    connection = sql,
    nextId: () => string = () => uuid(++sequence),
  ) => {
    const transport = adapter(connection);
    return {
      ...transport,
      ledger: createPublicationLedger(transport.database, {
        nextId,
        now: () => clock,
      }),
    };
  };
  const count = (table: string) =>
    Number(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  return {
    sql,
    file,
    create,
    connect,
    migrations,
    time(value: number) {
      clock = value;
    },
    counts: () => ({
      attempts: count('action_engine_publication_attempts'),
      events: count('action_engine_publication_events'),
      assertions: count('action_engine_atomic_assertions'),
      confirmations: count('qa_publication_confirmations'),
    }),
    close(connection: DatabaseSync) {
      connection.close();
      connections.splice(connections.indexOf(connection), 1);
    },
    cleanup() {
      for (const connection of connections) connection.close();
      const target = resolve(directory),
        parent = resolve(tmpdir());
      if (
        !target.startsWith(parent + sep) ||
        !target.includes('zentra-publication-ledger-')
      )
        throw Error('Unsafe QA path');
      rmSync(target, { recursive: true, force: true });
    },
  };
}

describe('private publication transport ledger, real SQLite', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    f.cleanup();
  });

  it('reads exact tenant/snapshot history without creating a missing row or taking ownership', async () => {
    const { ledger } = f.create();
    expect(await ledger.read('org-a', uuid(1))).toBeNull();
    expect(f.counts()).toMatchObject({ attempts: 0, events: 0 });
    const { attempt } = await ledger.begin(identity());
    expect(await ledger.read('org-a', uuid(1))).toEqual(attempt);
    expect(await ledger.read('org-b', uuid(1))).toBeNull();
    expect(await ledger.read('org-a', uuid(999))).toBeNull();
    const other = (
      await ledger.begin(
        identity({ organizationId: 'org-b', userId: 'user-b' }),
      )
    ).attempt;
    expect(await ledger.read('org-b', uuid(1))).toEqual(other);
    expect((await ledger.read('org-a', uuid(1)))?.id).toBe(attempt.id);
    const settled = await ledger.settle(attempt, committed(attempt));
    expect(await ledger.read('org-a', uuid(1))).toEqual(settled);
    expect(f.counts()).toMatchObject({ attempts: 2, events: 3 });
  });

  it('recovers a terminal attempt after close/reopen without needing archived transport bytes', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    const settled = await ledger.settle(attempt, committed(attempt));
    f.close(f.sql);
    const reopened = f.connect(),
      replacement = f.create(reopened);
    expect(
      await replacement.ledger.read(attempt.organizationId, attempt.snapshotId),
    ).toEqual(settled);
    expect(
      reopened
        .prepare('SELECT count(*) AS n FROM action_engine_publication_attempts')
        .get()?.n,
    ).toBe(1);
    expect(
      reopened
        .prepare('SELECT count(*) AS n FROM action_engine_publication_events')
        .get()?.n,
    ).toBe(2);
  });

  it.each(['null', 'accessor'] as const)(
    'a malformed %s read response is an error, never a fabricated absence',
    async (fault) => {
      const transport = f.create();
      await transport.ledger.begin(identity());
      transport.failNext(fault);
      await expect(
        transport.ledger.read('org-a', uuid(1)),
      ).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(transport.getterCalls()).toBe(0);
      expect((await transport.ledger.read('org-a', uuid(1)))?.state).toBe(
        'pending',
      );
      expect(f.counts()).toMatchObject({ attempts: 1, events: 1 });
    },
  );

  it('read rejects a malformed or retargeted returned row instead of returning null', async () => {
    const transport = f.create();
    await transport.ledger.begin(identity());
    const batch = transport.database.batch.bind(transport.database);
    const malformed = createPublicationLedger({
      prepare: transport.database.prepare.bind(transport.database),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const results = await batch<T>(statements);
        Object.defineProperty(results[0].results[0], 'private_extra', {
          enumerable: true,
          value: 'not-public',
        });
        return results;
      },
    });
    await expect(malformed.read('org-a', uuid(1))).rejects.toMatchObject({
      code: 'invalid_record',
    });
    const retargeted = createPublicationLedger({
      prepare: transport.database.prepare.bind(transport.database),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const results = await batch<T>(statements);
        Object.defineProperty(results[0].results[0], 'organization_id', {
          enumerable: true,
          value: 'org-b',
        });
        return results;
      },
    });
    await expect(retargeted.read('org-a', uuid(1))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(f.counts()).toMatchObject({ attempts: 1, events: 1 });
  });

  it('read captures and validates both scalar keys before awaiting any DB operation', async () => {
    const transport = f.create();
    await expect(transport.ledger.read('org a', uuid(1))).rejects.toMatchObject(
      { code: 'invalid_record' },
    );
    await expect(
      transport.ledger.read('org-a', 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(transport.batches).toHaveLength(0);
  });

  it('applies the real full migration chain and stores one immutable pending attempt/audit', async () => {
    expect(f.migrations).toContain('0102_action_engine_publication_ledger.sql');
    const { ledger } = f.create();
    const started = await ledger.begin(identity());
    expect(started.state).toBe('owned');
    expect(started.attempt).toMatchObject({
      ...identity(),
      state: 'pending',
      result: null,
      settledAt: null,
      createdAt: 2_000_000_000,
    });
    expect(Object.isFrozen(started)).toBe(true);
    expect(Object.isFrozen(started.attempt)).toBe(true);
    expect(f.counts()).toEqual({
      attempts: 1,
      events: 1,
      assertions: 0,
      confirmations: 0,
    });
    expect(
      f.sql
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='action_engine_publication_attempts'",
        )
        .get()?.sql,
    ).toContain('WITHOUT ROWID');
  });

  it('two actual connections converge on the same identity and permanent attempt ID', async () => {
    const a = f.create(),
      b = f.create(f.connect());
    const [first, second] = await Promise.all([
      a.ledger.begin(identity()),
      b.ledger.begin(identity()),
    ]);
    expect(first).toEqual(second);
    expect(f.counts().attempts).toBe(1);
    expect(f.counts().events).toBe(1);
  });

  it('two installations/candidates cannot acquire the organization at once or after arbitrary elapsed time', async () => {
    const a = f.create(),
      b = f.create(f.connect());
    const [first, second] = await Promise.all([
      a.ledger.begin(identity()),
      b.ledger.begin(
        identity({ snapshotId: uuid(3), installationId: uuid(4) }),
      ),
    ]);
    expect(first.state).toBe('owned');
    expect(second).toEqual({ state: 'held', attempt: first.attempt });
    f.time(253402300799);
    expect(
      await b.ledger.begin(
        identity({ snapshotId: uuid(3), installationId: uuid(4) }),
      ),
    ).toEqual(second);
    expect(f.counts().attempts).toBe(1);
  });

  it.each([
    { userId: 'user-other' },
    { installationId: uuid(3) },
    { baseRevision: 1 },
    { archiveSha256: 'c'.repeat(64) },
    { manifestSha256: 'd'.repeat(64) },
    { sizeBytes: 4097 },
  ])('rejects altered replay identity %j', async (change) => {
    const { ledger } = f.create();
    await ledger.begin(identity());
    await expect(ledger.begin(identity(change))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.counts().attempts).toBe(1);
  });

  it('the same client-selected snapshot UUID remains independent in two organizations', async () => {
    const { ledger } = f.create();
    const first = await ledger.begin(identity());
    const other = identity({ organizationId: 'org-b', userId: 'user-b' });
    const second = await ledger.begin(other);
    expect(first.state).toBe('owned');
    expect(second.state).toBe('owned');
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(await ledger.begin(other)).toEqual(second);
    await ledger.settle(first.attempt, committed(first.attempt));
    await ledger.settle(second.attempt, committed(second.attempt));
    expect(f.counts().attempts).toBe(2);
    expect(f.counts().events).toBe(4);
  });

  it('settles exactly once, recovers the historical result and does not rewrite timestamps/audit', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    f.time(2_000_000_010);
    const settled = await ledger.settle(attempt, committed(attempt));
    expect(settled).toMatchObject({
      state: 'committed',
      settledAt: 2_000_000_010,
      result: committed(attempt),
    });
    f.time(2_000_000_100);
    expect(await ledger.settle(attempt, committed(attempt))).toEqual(settled);
    expect(await ledger.settle(settled, committed(attempt))).toEqual(settled);
    expect(await ledger.begin(identity())).toEqual({
      state: 'settled',
      attempt: settled,
    });
    expect(f.counts().events).toBe(2);
    expect(Object.isFrozen(settled.result)).toBe(true);
  });

  it('returns old settled identity before another pending publication for the same organization', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    const settled = await ledger.settle(attempt, committed(attempt));
    await ledger.begin(identity({ snapshotId: uuid(6), baseRevision: 1 }));
    expect(await ledger.begin(identity())).toEqual({
      state: 'settled',
      attempt: settled,
    });
    expect(f.counts().attempts).toBe(2);
  });

  it('cancellation persists an exact corroborated empty head and then frees the organization', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    const result = { committed: false, revision: 0, snapshotId: null } as const;
    const cancelled = await ledger.settle(attempt, result);
    expect(cancelled.state).toBe('cancelled');
    expect(await ledger.settle(attempt, result)).toEqual(cancelled);
    expect((await ledger.begin(identity({ snapshotId: uuid(7) }))).state).toBe(
      'owned',
    );
    expect(f.counts().events).toBe(3);
  });

  it('allows cancelled safe positive head and rejects a changed historical result', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity({ baseRevision: 5 }));
    const result = {
      committed: false,
      revision: 8,
      snapshotId: uuid(9),
    } as const;
    await ledger.settle(attempt, result);
    await expect(
      ledger.settle(attempt, { ...result, revision: 9 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.counts().events).toBe(2);
  });

  it.each(['begin', 'settle'] as const)(
    'lost %s acknowledgement is explicit and replay recovers the committed write',
    async (operation) => {
      const transport = f.create();
      if (operation === 'begin') {
        transport.failNext('lost');
        await expect(transport.ledger.begin(identity())).rejects.toMatchObject({
          code: 'service_unavailable',
        });
        const recovered = await transport.ledger.begin(identity());
        expect(recovered.state).toBe('owned');
        expect(f.counts()).toMatchObject({ attempts: 1, events: 1 });
      } else {
        const { attempt } = await transport.ledger.begin(identity());
        transport.failNext('lost');
        await expect(
          transport.ledger.settle(attempt, committed(attempt)),
        ).rejects.toMatchObject({ code: 'service_unavailable' });
        const recovered = await transport.ledger.settle(
          attempt,
          committed(attempt),
        );
        expect(recovered.state).toBe('committed');
        expect(f.counts()).toMatchObject({ attempts: 1, events: 2 });
      }
      // No hidden reprobe or retry: each explicit method call submits one batch.
      expect(transport.batches.length).toBe(operation === 'begin' ? 2 : 3);
    },
  );

  it.each(['begin', 'settle'] as const)(
    'a failed %s transaction rolls back the attempt and audit together',
    async (operation) => {
      const transport = f.create();
      const attempt =
        operation === 'settle'
          ? (await transport.ledger.begin(identity())).attempt
          : null;
      const before = f.counts();
      transport.failNext('rollback');
      await expect(
        attempt
          ? transport.ledger.settle(attempt, committed(attempt))
          : transport.ledger.begin(identity()),
      ).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(f.counts()).toEqual(before);
      if (attempt)
        expect((await transport.ledger.begin(identity())).attempt.state).toBe(
          'pending',
        );
    },
  );

  it('cleanly closes all existing connections and reopens the exact terminal receipt without duplication', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    const settled = await ledger.settle(attempt, committed(attempt));
    f.close(f.sql);
    const reopened = f.connect(),
      replacement = f.create(reopened);
    expect(await replacement.ledger.begin(identity())).toEqual({
      state: 'settled',
      attempt: settled,
    });
    expect(
      await replacement.ledger.settle(attempt, committed(attempt)),
    ).toEqual(settled);
    expect(
      reopened
        .prepare('SELECT count(*) AS n FROM action_engine_publication_events')
        .get()?.n,
    ).toBe(2);
  });

  it.each(['null', 'accessor'] as const)(
    'captures malformed %s replies without getter execution and recovers explicitly',
    async (fault) => {
      const transport = f.create();
      transport.failNext(fault);
      await expect(transport.ledger.begin(identity())).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(transport.getterCalls()).toBe(0);
      expect((await transport.ledger.begin(identity())).state).toBe('owned');
      expect(f.counts().attempts).toBe(1);
    },
  );

  it('captures identity and result before an asynchronous transport boundary', async () => {
    const transport = f.create(),
      request = { ...identity() };
    transport.beforeNext(async () => {
      request.archiveSha256 = 'e'.repeat(64);
      request.snapshotId = uuid(80);
    });
    const { attempt } = await transport.ledger.begin(request);
    expect(attempt).toMatchObject(identity());
    const rawAttempt = { ...attempt },
      result = { ...committed(attempt) };
    transport.beforeNext(async () => {
      rawAttempt.userId = 'evil';
      result.revision = 999;
      result.snapshotId = uuid(81);
    });
    expect((await transport.ledger.settle(rawAttempt, result)).result).toEqual(
      committed(attempt),
    );
  });

  it.each([
    'id',
    'organizationId',
    'snapshotId',
    'installationId',
    'userId',
    'baseRevision',
    'archiveSha256',
    'manifestSha256',
    'sizeBytes',
    'createdAt',
  ] as const)(
    'rejects a forged settle identity field %s without changing the original',
    async (key) => {
      const { ledger } = f.create();
      const { attempt } = await ledger.begin(identity());
      const changed = { ...attempt };
      if (key === 'baseRevision') changed.baseRevision++;
      else if (key === 'sizeBytes') changed.sizeBytes++;
      else if (key === 'createdAt') changed.createdAt--;
      else if (key === 'archiveSha256' || key === 'manifestSha256')
        changed[key] = 'c'.repeat(64);
      else if (key === 'id' || key === 'snapshotId' || key === 'installationId')
        changed[key] = uuid(90);
      else changed[key] = 'other';
      await expect(
        ledger.settle(changed, committed(changed)),
      ).rejects.toMatchObject({ code: 'invalid_record' });
      expect((await ledger.begin(identity())).attempt.state).toBe('pending');
      expect(f.counts().events).toBe(1);
    },
  );

  it('rejects forged terminal input against a pending row and falsified historical terminal metadata', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity());
    await expect(
      ledger.settle(
        {
          ...attempt,
          state: 'committed',
          result: committed(attempt),
          settledAt: attempt.createdAt,
        },
        committed(attempt),
      ),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    const terminal = await ledger.settle(attempt, committed(attempt));
    await expect(
      ledger.settle(
        { ...terminal, settledAt: terminal.createdAt + 1 },
        committed(attempt),
      ),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(f.counts().events).toBe(2);
  });

  it.each([
    { committed: true, revision: 2, snapshotId: uuid(1) },
    { committed: true, revision: 1, snapshotId: uuid(2) },
    { committed: false, revision: 1, snapshotId: null },
    { committed: false, revision: 0, snapshotId: uuid(2) },
    { committed: false, revision: 1, snapshotId: uuid(1) },
  ])(
    'rejects structurally unsafe PG result %j, without a false-null cancellation',
    async (result) => {
      const { ledger } = f.create();
      const { attempt } = await ledger.begin(identity());
      await expect(ledger.settle(attempt, result)).rejects.toMatchObject({
        code: 'invalid_record',
      });
      expect((await ledger.begin(identity())).attempt.state).toBe('pending');
      expect(f.counts().events).toBe(1);
    },
  );

  it('cancellation cannot move behind the candidate base', async () => {
    const { ledger } = f.create();
    const { attempt } = await ledger.begin(identity({ baseRevision: 5 }));
    await expect(
      ledger.settle(attempt, {
        committed: false,
        revision: 4,
        snapshotId: uuid(9),
      }),
    ).rejects.toMatchObject({ code: 'invalid_record' });
  });

  it('keeps revision counters disjoint across organizations and rejects duplicate committed organization revisions', async () => {
    const { ledger } = f.create();
    const a = (await ledger.begin(identity())).attempt;
    const b = (
      await ledger.begin(
        identity({
          organizationId: 'org-b',
          userId: 'user-b',
          snapshotId: uuid(10),
        }),
      )
    ).attempt;
    await ledger.settle(a, committed(a));
    await ledger.settle(b, committed(b));
    const duplicate = (await ledger.begin(identity({ snapshotId: uuid(11) })))
      .attempt;
    await expect(
      ledger.settle(duplicate, committed(duplicate)),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      (await ledger.begin(identity({ snapshotId: uuid(11) }))).attempt.state,
    ).toBe('pending');
    expect(f.counts()).toMatchObject({ attempts: 3, events: 5 });
  });

  it('rejects generator collision rather than replacing a historical attempt', async () => {
    const fixed = f.create(f.sql, () => uuid(100));
    const { attempt } = await fixed.ledger.begin(identity());
    await fixed.ledger.settle(attempt, committed(attempt));
    await expect(
      fixed.ledger.begin(identity({ snapshotId: uuid(12), baseRevision: 1 })),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.counts()).toMatchObject({ attempts: 1, events: 2 });
  });
});
