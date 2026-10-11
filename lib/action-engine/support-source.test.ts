import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ActionActor } from './types';
import type { QuoteLedgerPredicate } from './ledger-types';

const state = vi.hoisted(() => ({
  db: null as unknown,
  onRead: null as null | ((row: Record<string, unknown>) => unknown),
}));
vi.mock('@/lib/runtime', () => ({ database: () => state.db }));
import {
  combineQuotePredicates,
  readSupportQuoteSource,
  readSupportQuoteAccess,
} from './support-source';

let db: DatabaseSync;
const actor: ActionActor = { organizationId: 'company-a', userId: 'member-a' };
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'mail-a',
    subject: 'Devis',
    body: '3 radiateurs',
    senderEmail: ' Client@Example.test ',
    senderName: 'Client Exemple',
    closed: false,
    ...overrides,
  };
}
function updateEnvelope(overrides: Record<string, unknown>) {
  db.prepare('UPDATE support_tickets SET source_json=?').run(
    JSON.stringify(envelope(overrides)),
  );
}
function allowed(predicate: QuoteLedgerPredicate) {
  return db
    .prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS allowed`)
    .get(...predicate.bindings)?.allowed;
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  state.onRead = null;
  // Only the existing source/delegation SELECT contract is exercised here.
  // Production device/payment gates are tested separately on all migrations.
  db.exec(`CREATE TABLE support_tickets(id TEXT PRIMARY KEY,workspace_id TEXT,connection_id TEXT,external_id TEXT,subject TEXT,body TEXT,source_json TEXT,fingerprint TEXT,revision INTEGER);
    CREATE TABLE support_connections(id TEXT PRIMARY KEY,workspace_id TEXT,active INTEGER,created_at INTEGER,provider TEXT);
    CREATE TABLE support_gestion_links(workspace_id TEXT PRIMARY KEY,organization_id TEXT,enabled INTEGER,connected_by TEXT,created_at INTEGER);
    CREATE TABLE support_workspaces(id TEXT PRIMARY KEY,owner_id TEXT,mode TEXT);
    CREATE TABLE organization_members(organization_id TEXT,user_id TEXT,revoked_at INTEGER,role TEXT,email TEXT);
    CREATE TABLE support_members(workspace_id TEXT,email TEXT,role TEXT);
    INSERT INTO support_connections VALUES('connection-a','workspace-a',1,2,'infomaniak');
    INSERT INTO support_gestion_links VALUES('workspace-a','company-a',1,'owner-a',3);
    INSERT INTO support_workspaces VALUES('workspace-a','owner-a','automatic');
    INSERT INTO organization_members VALUES('company-a','owner-a',NULL,'owner','owner@example.test');`);
  db.prepare('INSERT INTO support_tickets VALUES(?,?,?,?,?,?,?,?,?)').run(
    'source-a',
    'workspace-a',
    'connection-a',
    'mail-a',
    'Devis',
    '3 radiateurs',
    JSON.stringify(envelope()),
    'fingerprint-a',
    1,
  );
  state.db = {
    prepare: (sql: string) => ({
      bind: (...bindings: SQLInputValue[]) => ({
        first: async () => {
          const row = db.prepare(sql).get(...bindings) as
            | Record<string, unknown>
            | undefined;
          return row ? (state.onRead ? state.onRead(row) : row) : null;
        },
      }),
    }),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

it('reads historical access after source edits/closure and connector disconnection, with fresh delegation fencing', async () => {
  updateEnvelope({ closed: true, incomplete: true, body: 'changed' });
  db.exec(
    "UPDATE support_connections SET active=0; UPDATE support_tickets SET revision=2,body='changed'",
  );
  const cap = await readSupportQuoteAccess(actor, 'source-a');
  expect(cap.sourceId).toBe('source-a');
  expect(allowed(cap.predicate())).toBe(1);
  expect(JSON.stringify(cap)).not.toContain('changed');
  db.exec('UPDATE organization_members SET revoked_at=1');
  expect(allowed(cap.predicate())).toBe(0);
});
it('never admits historical source access from another tenant or a changed source workspace', async () => {
  await expect(
    readSupportQuoteAccess({ ...actor, organizationId: 'other' }, 'source-a'),
  ).rejects.toThrow();
  const cap = await readSupportQuoteAccess(actor, 'source-a');
  db.exec("UPDATE support_tickets SET workspace_id='other'");
  expect(allowed(cap.predicate())).toBe(0);
});

it('a Support pause stops a captured progression gate without blocking historical recovery', async () => {
  const source = await readSupportQuoteSource(actor, 'source-a');
  const access = await readSupportQuoteAccess(actor, 'source-a');
  const progression = source.predicate('progression');
  expect(allowed(progression)).toBe(1);
  db.exec("UPDATE support_workspaces SET mode='paused'");
  expect(allowed(progression)).toBe(0);
  expect(allowed(source.predicate('read'))).toBe(1);
  expect(allowed(access.predicate())).toBe(1);
  db.exec("UPDATE support_workspaces SET mode='review'");
  expect(allowed(progression)).toBe(1);
});

it('keeps the existing action-source-v1 revision and exposes only a detached private capability', async () => {
  const cap = await readSupportQuoteSource(actor, 'source-a');
  const expected = createHash('sha256')
    .update(
      JSON.stringify([
        'action-source-v1',
        'source-a',
        'workspace-a',
        'connection-a',
        'mail-a',
        'Devis',
        '3 radiateurs',
        JSON.stringify(envelope()),
        'fingerprint-a',
        1,
        'owner-a',
        3,
        2,
        'infomaniak',
      ]),
    )
    .digest('hex');
  expect(cap.revision).toBe(expected);
  expect(cap.source).toMatchObject({
    organizationId: 'company-a',
    senderEmail: 'client@example.test',
    senderName: 'Client Exemple',
  });
  expect(Object.keys(cap)).toEqual([
    'source',
    'workspaceId',
    'revision',
    'predicate',
  ]);
  expect(Object.isFrozen(cap)).toBe(true);
  expect(Object.isFrozen(cap.source)).toBe(true);
  expect(allowed(cap.predicate('read'))).toBe(1);
  expect(allowed(cap.predicate('progression'))).toBe(1);
  expect(Object.isFrozen(cap.predicate('progression').bindings)).toBe(true);
  expect(JSON.stringify(cap)).not.toContain('source_json');
});

it('captures actor and all row facts before an awaited digest can mutate their aliases', async () => {
  const mutableActor = { ...actor };
  let returnedRow: Record<string, unknown> | undefined;
  state.onRead = (row) => {
    returnedRow = row;
    mutableActor.organizationId = 'other-company';
    return row;
  };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, bytes) => {
    returnedRow!.subject = 'Changed after capture';
    returnedRow!.source_json = '{}';
    returnedRow!.revision = 99;
    return digest(algorithm, bytes);
  });
  const cap = await readSupportQuoteSource(mutableActor, 'source-a');
  expect(cap.source.organizationId).toBe('company-a');
  expect(cap.source.subject).toBe('Devis');
  expect(allowed(cap.predicate('progression'))).toBe(1);
});

it.each(['accessor', 'symbol', 'hidden', 'prototype'] as const)(
  'rejects a hostile row %s without executing accessors',
  async (kind) => {
    let getterCalls = 0;
    state.onRead = (row) => {
      if (kind === 'accessor')
        Object.defineProperty(row, 'source_json', {
          enumerable: true,
          get() {
            getterCalls++;
            return '{}';
          },
        });
      if (kind === 'symbol')
        Object.defineProperty(row, Symbol('extra'), { value: true });
      if (kind === 'hidden')
        Object.defineProperty(row, 'hidden', { value: true });
      if (kind === 'prototype')
        Object.setPrototypeOf(row, { unexpected: true });
      return row;
    };
    await expect(
      readSupportQuoteSource(actor, 'source-a'),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    expect(getterCalls).toBe(0);
  },
);

it.each([
  'UPDATE support_connections SET active=0',
  "UPDATE support_connections SET workspace_id='foreign-workspace'",
  'UPDATE support_gestion_links SET enabled=0',
  "UPDATE support_gestion_links SET organization_id='foreign-company'",
  'UPDATE organization_members SET revoked_at=1',
  "UPDATE organization_members SET role='member'",
  "UPDATE support_workspaces SET owner_id='someone-else'",
])('refuses a missing current delegation: %s', async (sql) => {
  db.exec(sql);
  await expect(readSupportQuoteSource(actor, 'source-a')).rejects.toMatchObject(
    { code: 'invalid_context' },
  );
});

it('preserves an explicit Support admin delegation with case-insensitive member email', async () => {
  db.exec(
    "UPDATE support_workspaces SET owner_id='someone-else'; UPDATE organization_members SET role='admin'; INSERT INTO support_members VALUES('workspace-a','OWNER@EXAMPLE.TEST','admin')",
  );
  const cap = await readSupportQuoteSource(actor, 'source-a');
  expect(allowed(cap.predicate('read'))).toBe(1);
  expect(allowed(cap.predicate('progression'))).toBe(1);
  db.exec("UPDATE support_members SET role='agent'");
  expect(allowed(cap.predicate('read'))).toBe(0);
  expect(allowed(cap.predicate('progression'))).toBe(0);
});

it.each([
  "UPDATE support_tickets SET id='source-b'",
  "UPDATE support_tickets SET workspace_id='workspace-b'",
  "UPDATE support_tickets SET connection_id='connection-b'",
  "UPDATE support_tickets SET external_id='mail-b'",
  "UPDATE support_tickets SET subject='Changed subject'",
  "UPDATE support_tickets SET body='4 radiateurs'",
  "UPDATE support_tickets SET source_json='{}'",
  "UPDATE support_tickets SET fingerprint='changed-fingerprint'",
  'UPDATE support_tickets SET revision=2',
  "UPDATE support_gestion_links SET connected_by='owner-b'",
  'UPDATE support_gestion_links SET created_at=4',
  'UPDATE support_connections SET created_at=4',
  "UPDATE support_connections SET provider='imap'",
])(
  'fences each exact raw source fact, without requiring its revision writer: %s',
  async (sql) => {
    const cap = await readSupportQuoteSource(actor, 'source-a');
    db.exec(sql);
    expect(allowed(cap.predicate('progression'))).toBe(0);
  },
);

it('refuses changed sender identity even when a corrupt writer leaves fingerprint and revision unchanged', async () => {
  const cap = await readSupportQuoteSource(actor, 'source-a');
  updateEnvelope({ senderEmail: 'another@example.test' });
  expect(allowed(cap.predicate('progression'))).toBe(0);
  expect(allowed(cap.predicate('read'))).toBe(1);
});

it('historical access retains current delegation but does not demand a historical ticket or active old connection', async () => {
  const cap = await readSupportQuoteSource(actor, 'source-a');
  db.exec(
    'DELETE FROM support_tickets; UPDATE support_connections SET active=0',
  );
  expect(allowed(cap.predicate('read'))).toBe(1);
  expect(allowed(cap.predicate('progression'))).toBe(0);
  db.exec('UPDATE support_gestion_links SET enabled=0');
  expect(allowed(cap.predicate('read'))).toBe(0);
});

it('historical access may use a new authorized delegate while progression keeps the original grantor exact', async () => {
  const cap = await readSupportQuoteSource(actor, 'source-a');
  db.exec(
    "INSERT INTO organization_members VALUES('company-a','owner-b',NULL,'admin','other@example.test'); INSERT INTO support_members VALUES('workspace-a','other@example.test','admin'); UPDATE support_gestion_links SET connected_by='owner-b'",
  );
  expect(allowed(cap.predicate('read'))).toBe(1);
  expect(allowed(cap.predicate('progression'))).toBe(0);
});

it.each([
  { closed: true },
  { incomplete: true },
  { mail: { bodyIncomplete: true } },
  { senderIdentityAmbiguous: true },
  { senderEmail: 42 },
])(
  'rejects invalid connector evidence %j with a stable error',
  async (overrides) => {
    updateEnvelope(overrides);
    await expect(
      readSupportQuoteSource(actor, 'source-a'),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  },
);

it('segments a large exact envelope without splitting an emoji across D1 parameters', async () => {
  const empty = JSON.stringify(envelope({ padding: '' }));
  const start = empty.indexOf('"padding":"') + '"padding":"'.length;
  const json = JSON.stringify(
    envelope({
      padding: 'x'.repeat(65535 - start) + '😀' + 'y'.repeat(140000),
    }),
  );
  expect(json.charCodeAt(65535)).toBe(0xd83d);
  expect(json.charCodeAt(65536)).toBe(0xde00);
  db.prepare('UPDATE support_tickets SET source_json=?').run(json);
  const cap = await readSupportQuoteSource(actor, 'source-a'),
    gate = cap.predicate('progression');
  expect(allowed(gate)).toBe(1);
  expect(
    gate.bindings
      .filter((value) => typeof value === 'string')
      .every((value) => value.length <= 65536),
  ).toBe(true);
  expect(gate.bindings.length).toBeLessThanOrEqual(18);
  expect(gate.sql.length).toBeLessThan(3000);
  const changed = json.replace('😀', '😁');
  db.prepare('UPDATE support_tickets SET source_json=?').run(changed);
  expect(allowed(gate)).toBe(0);
});

it('evaluates the source guard and a guarded mutation in the same rollback boundary', async () => {
  const cap = await readSupportQuoteSource(actor, 'source-a'),
    gate = cap.predicate('progression');
  db.exec(
    'CREATE TABLE qa_guard(allowed INTEGER NOT NULL CHECK(allowed=1)); CREATE TABLE qa_mutation(id TEXT)',
  );
  updateEnvelope({ closed: true });
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO qa_guard SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END`,
    ).run(...gate.bindings);
    db.exec("INSERT INTO qa_mutation VALUES('not-authorized')");
    throw Error('Source guard unexpectedly allowed the mutation');
  } catch (error) {
    db.exec('ROLLBACK');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/CHECK/);
  }
  expect(db.prepare('SELECT count(*) AS n FROM qa_mutation').get()?.n).toBe(0);
});

it('rejects forged purpose and cross-tenant source before granting a capability', async () => {
  await expect(
    readSupportQuoteSource(
      { ...actor, organizationId: 'foreign-company' },
      'source-a',
    ),
  ).rejects.toMatchObject({ code: 'invalid_context' });
  const cap = await readSupportQuoteSource(actor, 'source-a');
  expect(() => cap.predicate('confirm' as 'read')).toThrow('invalid_context');
});

it('enforces aggregate repository limits instead of accepting individually valid predicates', () => {
  const one = { sql: '1', bindings: Array<number>(32).fill(1) };
  expect(combineQuotePredicates(one, one).bindings).toHaveLength(64);
  expect(() =>
    combineQuotePredicates(one, one, { sql: '1', bindings: [1] }),
  ).toThrow('invalid_context');
  expect(() =>
    combineQuotePredicates(
      { sql: '1'.repeat(8000), bindings: [] },
      { sql: '1'.repeat(8000), bindings: [] },
    ),
  ).toThrow('invalid_context');
  expect(() =>
    combineQuotePredicates({ sql: '1', bindings: ['x'.repeat(65537)] }),
  ).toThrow('invalid_context');
  expect(() => combineQuotePredicates()).toThrow('invalid_context');
});

it('captures combined operands without executing getters or retaining mutable binding aliases', () => {
  let calls = 0;
  const malicious = Object.defineProperty({ bindings: [] }, 'sql', {
    enumerable: true,
    get() {
      calls++;
      return '1';
    },
  });
  expect(() =>
    combineQuotePredicates(malicious as unknown as QuoteLedgerPredicate),
  ).toThrow('invalid_context');
  expect(calls).toBe(0);
  const bindings = [1],
    combined = combineQuotePredicates({ sql: '?=1', bindings });
  bindings[0] = 0;
  expect(combined.bindings).toEqual([1]);
  expect(Object.isFrozen(combined.bindings)).toBe(true);
});
