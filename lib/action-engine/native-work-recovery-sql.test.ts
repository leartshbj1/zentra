/** Executes the recovery selection and pending guard extracted from actual Rust
 * sources against the actual native schema on Node SQLite. This does not execute
 * Rust, reproduce reader/auth checks, or prove writer/publication atomicity. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = process.env.ZENTRA_NATIVE_SOURCE_ROOT;
const suite = root ? describe : describe.skip;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const org = 'synthetic-recovery-company';
const actor = 'synthetic-recovery-user';
const uuid = (value: number) =>
  '00000000-0000-4000-8000-' + value.toString().padStart(12, '0');
const installation = uuid(1);
const now = '2026-10-11T00:00:00Z';
const outbox = 'company_local_action_engine_quote_outbox';
const columns = [
  'organization_id',
  'proposal_id',
  'fingerprint',
  'state',
  'source_id',
  'reservation_id',
  'actor_user_id',
  'installation_id',
];
let db: DatabaseSync;
let nativeSource: string;
let quoteSource: string;
let schema: string;
let recoverySql: string;
let pendingSql: string;
let sequence: number;

function extractRawSql(source: string, name: string) {
  const declarations = [
    ...source.matchAll(
      new RegExp(
        '\\bconst\\s+' + name + '\\s*:\\s*&str\\s*=\\s*r#"([\\s\\S]*?)"#\\s*;',
        'g',
      ),
    ),
  ];
  if (declarations.length !== 1)
    throw new Error('Expected one actual Rust ' + name + ' raw string');
  return declarations[0][1];
}

type Seed = {
  proposal: string;
  organization?: string;
  actorUser?: string;
  installationId?: string;
  state?: 'pending' | 'uncertain' | 'confirmed';
  createdAt?: string;
  withReceipt?: boolean;
  withOutbox?: boolean;
};

// These are schema-admitted synthetic rows, not a substitute for the complete
// native plan validator or a receipt produced by the native quote writer.
function seed({
  proposal,
  organization = org,
  actorUser = actor,
  installationId = installation,
  state = 'pending',
  createdAt = now,
  withReceipt = true,
  withOutbox = true,
}: Seed) {
  const id = ++sequence;
  const source = 'synthetic-source-' + id;
  const reservation = uuid(100 + id);
  const customer = uuid(200 + id);
  const quote = uuid(300 + id);
  const plan = JSON.stringify({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: organization,
    contextRevision: 'synthetic-context',
    sourceId: source,
    status: 'ready',
    reasons: [],
    requiresHumanValidation: true,
  });
  const fingerprint = hash(plan);
  const receipt = JSON.stringify({
    organizationId: organization,
    proposalId: proposal,
    fingerprint,
    customerId: customer,
    quoteId: quote,
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  });
  const receiptSha = hash(receipt);
  if (withReceipt) {
    db.prepare(
      'INSERT INTO action_engine_quote_receipts VALUES(' +
        Array(17).fill('?').join(',') +
        ')',
    ).run(
      organization,
      source,
      'prepare_quote_draft',
      proposal,
      reservation,
      fingerprint,
      hash(JSON.stringify([organization, source, proposal, reservation])),
      'b'.repeat(64),
      'synthetic-context',
      actorUser,
      installationId,
      customer,
      quote,
      plan,
      receipt,
      receiptSha,
      createdAt,
    );
  }
  if (withOutbox) {
    const payload = JSON.stringify({
      organizationId: organization,
      proposalId: proposal,
      reservationId: reservation,
      fingerprint,
      customerId: customer,
      quoteId: quote,
      receiptSha256: receiptSha,
    });
    db.prepare('INSERT INTO ' + outbox + ' VALUES(?,?,?,?,?,?,?,0,?,?)').run(
      organization,
      proposal,
      quote,
      fingerprint,
      payload,
      hash(payload),
      state,
      createdAt,
      createdAt,
    );
  }
  return { source, reservation, fingerprint };
}

// Bind the caller's visible page size plus one. Return every SQL row, including
// lookahead; deliberately do not implement Rust validation, truncation or auth.
function rows(pageSize: number, organization = org) {
  return db.prepare(recoverySql).all(organization, pageSize + 1);
}
function pendingValue(organization = org) {
  return db.prepare(pendingSql).get(organization)?.recovery_pending;
}
function proposals(result: ReturnType<typeof rows>) {
  return result.map((row) => row.proposal_id);
}
function confirm(proposal: string) {
  db.prepare(
    'UPDATE ' +
      outbox +
      " SET state='confirmed' WHERE organization_id=? AND proposal_id=?",
  ).run(org, proposal);
}

suite('actual native recovery-work SQL selection', () => {
  beforeAll(() => {
    nativeSource = readFileSync(
      join(root!, 'desktop/src-tauri/src/action_engine_quote_publication.rs'),
      'utf8',
    );
    quoteSource = readFileSync(
      join(root!, 'desktop/src-tauri/src/action_engine_quote.rs'),
      'utf8',
    );
    schema = readFileSync(
      join(root!, 'desktop/src-tauri/src/action_engine_quote_schema.sql'),
      'utf8',
    );
    recoverySql = extractRawSql(nativeSource, 'RECOVERY_WORK_SQL');
    pendingSql = extractRawSql(quoteSource, 'RECOVERY_PENDING_SQL');
  });
  beforeEach(() => {
    sequence = 0;
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(schema);
  });
  afterEach(() => db.close());

  it('extracts the real query with the eight positional columns and exactly two binds', () => {
    expect(
      db
        .prepare(recoverySql)
        .columns()
        .map((column) => column.name),
    ).toEqual(columns);
    expect(() => db.prepare(recoverySql).all(org, 1, 'extra-bind')).toThrow();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(62);
    console.info(
      'Native recovery SQL provenance (Node SQLite only):',
      JSON.stringify({
        nativeSourceRoot: root,
        rustSourceSha256: hash(nativeSource),
        quoteRustSourceSha256: hash(quoteSource),
        schemaSha256: hash(schema),
        recoverySqlSha256: hash(recoverySql),
        recoveryPendingSqlSha256: hash(pendingSql),
        columns,
        bindings: ['organizationId', 'visiblePageSize + 1'],
        pendingGuardColumns: ['recovery_pending'],
        pendingGuardBindings: ['organizationId'],
      }),
    );
  });

  it('returns no work for a drained organization', () => {
    expect(rows(20)).toEqual([]);
  });

  it('isolates both selection and receipt join by organization for the same proposal', () => {
    const own = seed({ proposal: 'same-proposal' });
    const foreign = seed({
      proposal: 'same-proposal',
      organization: 'synthetic-foreign-company',
      actorUser: 'foreign-user',
    });
    expect(rows(20)).toEqual([
      {
        organization_id: org,
        proposal_id: 'same-proposal',
        fingerprint: own.fingerprint,
        state: 'pending',
        source_id: own.source,
        reservation_id: own.reservation,
        actor_user_id: actor,
        installation_id: installation,
      },
    ]);
    expect(rows(20, 'synthetic-foreign-company')[0]?.source_id).toBe(
      foreign.source,
    );
    expect(rows(20, 'synthetic-absent-company')).toEqual([]);
  });

  it('includes pending and uncertain work while excluding confirmed rows before the limit', () => {
    seed({ proposal: '00-confirmed', state: 'confirmed' });
    seed({ proposal: '01-pending' });
    seed({ proposal: '02-uncertain', state: 'uncertain' });
    seed({ proposal: '03-confirmed', state: 'confirmed' });
    expect(rows(1).map((row) => [row.proposal_id, row.state])).toEqual([
      ['01-pending', 'pending'],
      ['02-uncertain', 'uncertain'],
    ]);
  });

  it('orders proposals with SQLite binary collation regardless of insertion or timestamp', () => {
    const inserted = ['a_1', 'B', 'a:1', 'a-1', 'A', 'a', 'a.1', 'a@1'];
    inserted.forEach((proposal, index) =>
      seed({ proposal, createdAt: `2026-10-${20 - index}T00:00:00Z` }),
    );
    expect(proposals(rows(20))).toEqual([
      'A',
      'B',
      'a',
      'a-1',
      'a.1',
      'a:1',
      'a@1',
      'a_1',
    ]);
  });

  it('returns only available work when fewer than or exactly the visible page size remain', () => {
    seed({ proposal: '01' });
    seed({ proposal: '02' });
    expect(proposals(rows(3))).toEqual(['01', '02']);
    expect(proposals(rows(2))).toEqual(['01', '02']);
  });

  it('returns exactly one lookahead row rather than truncating to the visible page', () => {
    for (let id = 55; id >= 1; id--)
      seed({ proposal: id.toString().padStart(2, '0') });
    expect(proposals(rows(2))).toEqual(['01', '02', '03']);
    expect(proposals(rows(1))).toEqual(['01', '02']);
    const maximumPage = proposals(rows(50));
    expect(maximumPage).toHaveLength(51);
    expect(maximumPage[0]).toBe('01');
    expect(maximumPage[50]).toBe('51');
  });

  it('drains from the first nonconfirmed proposal without an offset or skipping lookahead', () => {
    for (const proposal of ['01', '02', '03', '04', '05']) seed({ proposal });
    expect(proposals(rows(2))).toEqual(['01', '02', '03']);
    confirm('01');
    confirm('02');
    expect(proposals(rows(2))).toEqual(['03', '04', '05']);
    confirm('03');
    confirm('04');
    expect(proposals(rows(2))).toEqual(['05']);
    confirm('05');
    expect(rows(2)).toEqual([]);
    expect(
      db.prepare('SELECT count(*) n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(5);
  });

  it('does not infer recovery work from a receipt with no local outbox', () => {
    seed({ proposal: 'receipt-only', withOutbox: false });
    expect(rows(20)).toEqual([]);
  });

  it('surfaces an orphan in lookahead with null receipt facts instead of hiding it', () => {
    seed({ proposal: '00-valid' });
    expect(() => seed({ proposal: '01-orphan', withReceipt: false })).toThrow(
      'action_engine_quote_outbox_receipt',
    );
    // Deliberate damaged-store fixture: normal insertion rejects this orphan.
    // Relax only the real FK/receipt trigger, never replace the real table/query.
    db.exec(
      'PRAGMA foreign_keys=OFF; DROP TRIGGER action_engine_quote_outbox_receipt;',
    );
    seed({ proposal: '01-orphan', withReceipt: false });
    const result = rows(1);
    expect(proposals(result)).toEqual(['00-valid', '01-orphan']);
    expect(result[1]).toMatchObject({
      organization_id: org,
      state: 'pending',
      source_id: null,
      reservation_id: null,
      actor_user_id: null,
      installation_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1);
  });

  it('surfaces a foreign actor in lookahead so the native reader can refuse it', () => {
    seed({ proposal: '00-valid' });
    seed({ proposal: '01-foreign-actor', actorUser: 'other-synthetic-user' });
    const result = rows(1);
    expect(proposals(result)).toEqual(['00-valid', '01-foreign-actor']);
    expect(result[1]?.actor_user_id).toBe('other-synthetic-user');
  });

  it('surfaces a foreign installation in lookahead rather than implying an empty tail', () => {
    seed({ proposal: '00-valid' });
    seed({ proposal: '01-foreign-installation', installationId: uuid(999) });
    const result = rows(1);
    expect(proposals(result)).toEqual(['00-valid', '01-foreign-installation']);
    expect(result[1]?.installation_id).toBe(uuid(999));
  });

  it('surfaces an unexpected damaged-store state instead of filtering to pending and uncertain', () => {
    seed({ proposal: '00-valid' });
    seed({ proposal: '01-invalid-state' });
    // A corrupt legacy/database image can violate checks. Rust must see and
    // reject this row; this test proves only that the SQL does not conceal it.
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare(
      'UPDATE ' + outbox + " SET state='unexpected' WHERE proposal_id=?",
    ).run('01-invalid-state');
    db.exec('PRAGMA ignore_check_constraints=OFF');
    const result = rows(1);
    expect(proposals(result)).toEqual(['00-valid', '01-invalid-state']);
    expect(result[1]?.state).toBe('unexpected');
  });

  // These cases exercise only the real SQL predicate. They do not establish
  // that the Rust writer calls it after replay or inside an IMMEDIATE transaction.
  it('extracts the real one-bind guard and returns integer zero for an empty outbox', () => {
    expect(
      db
        .prepare(pendingSql)
        .columns()
        .map((column) => column.name),
    ).toEqual(['recovery_pending']);
    expect(() => db.prepare(pendingSql).get(org, 'extra-bind')).toThrow();
    expect(db.prepare(pendingSql).get(org)).toEqual({ recovery_pending: 0 });
  });

  it.each(['pending', 'uncertain'] as const)(
    'keeps the guard true for a %s outbox of the organization',
    (state) => {
      seed({ proposal: 'guard-' + state, state });
      expect(pendingValue()).toBe(1);
    },
  );

  it('keeps the guard false when all local outboxes are confirmed or only receipts remain', () => {
    seed({ proposal: 'confirmed-01', state: 'confirmed' });
    seed({ proposal: 'confirmed-02', state: 'confirmed' });
    seed({ proposal: 'receipt-only', withOutbox: false });
    expect(pendingValue()).toBe(0);
  });

  it('keeps foreign-organization pending and uncertain outboxes outside the guard', () => {
    seed({ proposal: 'shared-proposal', state: 'confirmed' });
    seed({
      proposal: 'shared-proposal',
      organization: 'synthetic-foreign-company',
    });
    seed({
      proposal: 'foreign-uncertain',
      organization: 'synthetic-foreign-company',
      state: 'uncertain',
    });
    expect(pendingValue()).toBe(0);
    expect(pendingValue('synthetic-foreign-company')).toBe(1);
  });

  it('keeps an orphan outbox inside the guard without relying on a receipt join', () => {
    db.exec(
      'PRAGMA foreign_keys=OFF; DROP TRIGGER action_engine_quote_outbox_receipt;',
    );
    seed({ proposal: 'guard-orphan', withReceipt: false });
    expect(pendingValue()).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1);
  });

  it('keeps an unexpected damaged-store state inside the guard', () => {
    seed({ proposal: 'guard-invalid-state' });
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare(
      'UPDATE ' + outbox + " SET state='unexpected' WHERE proposal_id=?",
    ).run('guard-invalid-state');
    db.exec('PRAGMA ignore_check_constraints=OFF');
    expect(pendingValue()).toBe(1);
  });

  it('keeps an outbox from another actor of the organization inside the guard', () => {
    seed({
      proposal: 'guard-foreign-actor',
      actorUser: 'other-synthetic-user',
    });
    expect(pendingValue()).toBe(1);
  });

  it('keeps an outbox from another installation of the organization inside the guard', () => {
    seed({ proposal: 'guard-foreign-installation', installationId: uuid(999) });
    expect(pendingValue()).toBe(1);
  });
});
