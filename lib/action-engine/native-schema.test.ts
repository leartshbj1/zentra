/** Cross-workspace SQL contract tests. These execute the actual native migration,
 * not Rust: native compilation/execution is reported independently. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = process.env.ZENTRA_NATIVE_SOURCE_ROOT;
const suite = root ? describe : describe.skip;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
let db: DatabaseSync;
const org = 'synthetic-company',
  source = 'synthetic-source',
  proposal = 'synthetic-proposal';
const reservation = 'efc98ca7-0913-4a53-85c6-d3d38737d9db';
const quote = '02c11008-6c2d-49b3-8d0f-50cfb6b218eb';
const installation = '788659d9-f20e-4eae-9c0f-146057b0bfb0';
const customer = '960e994b-bbf2-4538-b58c-588112da7849';
type FixtureIdentity = {
  source: string;
  proposal: string;
  reservation: string;
  quote: string;
};
const originalIdentity: FixtureIdentity = {
  source,
  proposal,
  reservation,
  quote,
};
const distinctIdentity: FixtureIdentity = {
  source: 'new-source',
  proposal: 'new-proposal',
  reservation: '2b3492b3-45f3-402f-b09c-64d88e151102',
  quote: 'fd99c03e-119e-42c8-8ff5-1db0c49f15e9',
};
function values(identity: FixtureIdentity = originalIdentity): SQLInputValue[] {
  const plan = JSON.stringify({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: org,
    contextRevision: 'synthetic-context',
    sourceId: identity.source,
    status: 'ready',
    reasons: [],
    requiresHumanValidation: true,
  });
  const fingerprint = hash(plan);
  const receipt = JSON.stringify({
    organizationId: org,
    proposalId: identity.proposal,
    fingerprint,
    customerId: customer,
    quoteId: identity.quote,
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  });
  const requestHash = hash(
    JSON.stringify([
      org,
      identity.source,
      identity.proposal,
      identity.reservation,
      identity.quote,
      fingerprint,
    ]),
  );
  return [
    org,
    identity.source,
    'prepare_quote_draft',
    identity.proposal,
    identity.reservation,
    fingerprint,
    requestHash,
    'b'.repeat(64),
    'synthetic-context',
    'synthetic-user',
    installation,
    customer,
    identity.quote,
    plan,
    receipt,
    hash(receipt),
    '2026-10-11T00:00:00Z',
  ];
}
const insert = (verb = 'INSERT') =>
  `${verb} INTO action_engine_quote_receipts VALUES(${Array(17).fill('?').join(',')})`;
function seed() {
  db.prepare(insert()).run(...values());
}
function seedOutbox(verb = 'INSERT') {
  const fingerprint = values()[5];
  const receiptSha256 = values()[15];
  if (typeof fingerprint !== 'string' || typeof receiptSha256 !== 'string')
    throw new Error('Invalid synthetic fixture');
  const payload = JSON.stringify({
    organizationId: org,
    proposalId: proposal,
    reservationId: reservation,
    fingerprint,
    customerId: customer,
    quoteId: quote,
    receiptSha256,
  });
  db.prepare(
    `${verb} INTO company_local_action_engine_quote_outbox VALUES(?,?,?,?,?,?,'pending',0,?,?)`,
  ).run(
    org,
    proposal,
    quote,
    fingerprint,
    payload,
    hash(payload),
    '2026-10-11T00:00:00Z',
    '2026-10-11T00:00:00Z',
  );
}
suite('actual native schema62 additive receipt/outbox SQL', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE existing_business(id TEXT PRIMARY KEY,value TEXT);INSERT INTO existing_business VALUES('keep','unchanged');PRAGMA user_version=61;",
    );
    db.exec(
      readFileSync(
        join(root!, 'desktop/src-tauri/src/action_engine_quote_schema.sql'),
        'utf8',
      ),
    );
  });
  afterEach(() => db.close());
  it('applies additively and leaves existing business data intact', () => {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(62);
    expect(
      db.prepare("SELECT value FROM existing_business WHERE id='keep'").get()
        ?.value,
    ).toBe('unchanged');
    db.exec(
      readFileSync(
        join(root!, 'desktop/src-tauri/src/action_engine_quote_schema.sql'),
        'utf8',
      ),
    );
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(0);
  });
  it('allows a shared receipt and a private outbox in the same atomic transaction', () => {
    db.exec('BEGIN IMMEDIATE');
    seed();
    seedOutbox();
    db.exec('COMMIT');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(1);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM company_local_action_engine_quote_outbox',
        )
        .get()?.n,
    ).toBe(1);
  });
  for (const verb of [
    'INSERT',
    'INSERT OR REPLACE',
    'REPLACE',
    'INSERT OR IGNORE',
  ])
    it(`blocks replay/replacement at SQL boundary with ${verb}`, () => {
      seed();
      expect(() => db.prepare(insert(verb)).run(...values())).toThrow(
        'action_engine_quote_receipt_conflict',
      );
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts')
          .get()?.n,
      ).toBe(1);
    });
  it('accepts a coherent fixture when all independent identities are distinct', () => {
    seed();
    db.prepare(insert()).run(...values(distinctIdentity));
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(2);
  });
  for (const field of ['source', 'proposal', 'reservation', 'quote'] as const)
    it(`holds independent unique identity ${field}`, () => {
      seed();
      const before = db
        .prepare('SELECT * FROM action_engine_quote_receipts')
        .all();
      const changed = { ...distinctIdentity, [field]: originalIdentity[field] };
      expect(() => db.prepare(insert()).run(...values(changed))).toThrow(
        'action_engine_quote_receipt_conflict',
      );
      expect(
        db.prepare('SELECT * FROM action_engine_quote_receipts').all(),
      ).toEqual(before);
    });
  for (const statement of [
    "UPDATE action_engine_quote_receipts SET created_at='later'",
    'DELETE FROM action_engine_quote_receipts',
  ])
    it(`keeps shared evidence append-only: ${statement}`, () => {
      seed();
      expect(() => db.exec(statement)).toThrow(
        'action_engine_quote_receipt_immutable',
      );
    });
  it('rolls back the receipt when its mandatory outbox insert fails', () => {
    db.exec('BEGIN IMMEDIATE');
    seed();
    expect(() =>
      db
        .prepare(
          "INSERT INTO company_local_action_engine_quote_outbox VALUES('bad','bad','bad','bad','{}','bad','pending',0,'now','now')",
        )
        .run(),
    ).toThrow();
    db.exec('ROLLBACK');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(0);
  });
  it('allows private purge while retaining shared receipt evidence', () => {
    seed();
    seedOutbox();
    db.exec('DELETE FROM company_local_action_engine_quote_outbox');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(1);
  });
  it('does not allow a private outbox without its shared receipt', () => {
    expect(() => seedOutbox()).toThrow('action_engine_quote_outbox_receipt');
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM company_local_action_engine_quote_outbox',
        )
        .get()?.n,
    ).toBe(0);
  });
  for (const verb of [
    'INSERT',
    'INSERT OR REPLACE',
    'REPLACE',
    'INSERT OR IGNORE',
  ])
    it(`blocks private outbox replacement with ${verb}`, () => {
      seed();
      seedOutbox();
      const before = db
        .prepare('SELECT * FROM company_local_action_engine_quote_outbox')
        .all();
      expect(() => seedOutbox(verb)).toThrow(
        'action_engine_quote_outbox_conflict',
      );
      expect(
        db
          .prepare('SELECT * FROM company_local_action_engine_quote_outbox')
          .all(),
      ).toEqual(before);
    });
  it('prevents an outbox attempt counter from decreasing independently of its state', () => {
    seed();
    seedOutbox();
    db.exec(
      'UPDATE company_local_action_engine_quote_outbox SET attempt_count=2',
    );
    expect(() =>
      db.exec(
        'UPDATE company_local_action_engine_quote_outbox SET attempt_count=1',
      ),
    ).toThrow('action_engine_quote_outbox_immutable');
    expect(
      db
        .prepare(
          'SELECT attempt_count FROM company_local_action_engine_quote_outbox',
        )
        .get()?.attempt_count,
    ).toBe(2);
  });
  it('prevents an outbox timestamp from decreasing independently of its payload', () => {
    seed();
    seedOutbox();
    db.exec(
      "UPDATE company_local_action_engine_quote_outbox SET updated_at='2026-10-11T00:00:01Z'",
    );
    expect(() =>
      db.exec(
        "UPDATE company_local_action_engine_quote_outbox SET updated_at='2026-10-11T00:00:00Z'",
      ),
    ).toThrow('action_engine_quote_outbox_immutable');
    expect(
      db
        .prepare(
          'SELECT updated_at FROM company_local_action_engine_quote_outbox',
        )
        .get()?.updated_at,
    ).toBe('2026-10-11T00:00:01Z');
  });
  it('allows acknowledgement but prevents confirmed-state reversal or payload replacement', () => {
    seed();
    seedOutbox();
    db.exec(
      "UPDATE company_local_action_engine_quote_outbox SET state='confirmed',attempt_count=1",
    );
    expect(() =>
      db.exec(
        "UPDATE company_local_action_engine_quote_outbox SET state='pending'",
      ),
    ).toThrow('action_engine_quote_outbox_immutable');
    expect(() =>
      db.exec(
        "UPDATE company_local_action_engine_quote_outbox SET payload_json='{}'",
      ),
    ).toThrow('action_engine_quote_outbox_immutable');
  });
});
