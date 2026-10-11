/** Actual additive native SQL, executed by Node SQLite. This proves constraints
 * and transaction semantics only, not Rust or authenticated A7 interoperability. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = process.env.ZENTRA_NATIVE_SOURCE_ROOT;
const suite = root ? describe : describe.skip;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const org = 'synthetic-company',
  source = 'synthetic-source',
  proposal = 'synthetic-proposal';
const user = 'synthetic-user',
  now = '2026-10-11T00:00:00Z';
const uuid = (n: string) => '00000000-0000-4000-8000-' + n.padStart(12, '0');
const reservation = uuid('1'),
  installation = uuid('2'),
  customer = uuid('3'),
  quote = uuid('4'),
  snapshot = uuid('5');
const plan = JSON.stringify({
  schemaVersion: 1,
  engineVersion: 'action-engine-quote-v1',
  kind: 'prepare_quote_draft',
  organizationId: org,
  contextRevision: 'synthetic-context',
  sourceId: source,
  status: 'ready',
  reasons: [],
  requiresHumanValidation: true,
});
const fingerprint = hash(plan);
const receipt = JSON.stringify({
  organizationId: org,
  proposalId: proposal,
  fingerprint,
  customerId: customer,
  quoteId: quote,
  quoteNumber: null,
  status: 'draft',
  requiresHumanValidation: true,
});
const receiptSha = hash(receipt);
const payload = JSON.stringify({
  organizationId: org,
  proposalId: proposal,
  reservationId: reservation,
  fingerprint,
  customerId: customer,
  quoteId: quote,
  receiptSha256: receiptSha,
});
const manifest = {
  format: 'zentra-cloud-backup',
  version: 1,
  app_version: '1.90.15',
  sha256: 'c'.repeat(64),
  size_bytes: 100,
  chunks: [{ sha256: 'd'.repeat(64), size_bytes: 100 }],
};
const manifestJson = JSON.stringify(manifest);
const confirmations = 'company_local_action_engine_quote_confirmations';
const publications = 'company_local_action_engine_quote_publications';
const outbox = 'company_local_action_engine_quote_outbox';
let db: DatabaseSync;
let migration: string;
function facts(
  overrides: Record<string, SQLInputValue> = {},
): Record<string, SQLInputValue> {
  return {
    organization_id: org,
    source_id: source,
    action_kind: 'prepare_quote_draft',
    proposal_id: proposal,
    reservation_id: reservation,
    fingerprint,
    actor_user_id: user,
    installation_id: installation,
    customer_id: customer,
    quote_id: quote,
    receipt_sha256: receiptSha,
    snapshot_id: snapshot,
    confirmed_at: now,
    ...overrides,
  };
}
function insert(
  table: string,
  row: Record<string, SQLInputValue>,
  verb = 'INSERT',
) {
  db.prepare(
    verb +
      ' INTO ' +
      table +
      ' (' +
      Object.keys(row).join(',') +
      ') VALUES(' +
      Object.keys(row)
        .map(() => '?')
        .join(',') +
      ')',
  ).run(...Object.values(row));
}
function candidate(id = snapshot) {
  const row = facts({ snapshot_id: id });
  delete row.confirmed_at;
  return {
    ...row,
    base_revision: 4,
    archive_sha256: manifest.sha256,
    manifest_sha256: hash(manifestJson),
    manifest_json: manifestJson,
    size_bytes: 100,
    local_clock: 12,
    created_at: now,
    published_revision: null,
    published_at: null,
  };
}
function state() {
  return db.prepare('SELECT state FROM ' + outbox).get()?.state;
}
function ack() {
  insert(confirmations, facts());
  db.prepare('UPDATE ' + outbox + " SET state='confirmed',updated_at=?").run(
    now,
  );
}
suite('actual native canonical-confirmation housekeeping SQL', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE business(id TEXT PRIMARY KEY,value TEXT); INSERT INTO business VALUES('keep','unchanged');",
    );
    for (const name of [
      'action_engine_quote_schema.sql',
      'action_engine_quote_publication_schema.sql',
    ]) {
      db.exec(readFileSync(join(root!, 'desktop/src-tauri/src', name), 'utf8'));
    }
    migration = readFileSync(
      join(
        root!,
        'desktop/src-tauri/src/action_engine_quote_confirmation_schema.sql',
      ),
      'utf8',
    );
    db.exec(migration);
    db.prepare(
      'INSERT INTO action_engine_quote_receipts VALUES(' +
        Array(17).fill('?').join(',') +
        ')',
    ).run(
      org,
      source,
      'prepare_quote_draft',
      proposal,
      reservation,
      fingerprint,
      'a'.repeat(64),
      'b'.repeat(64),
      'synthetic-context',
      user,
      installation,
      customer,
      quote,
      plan,
      receipt,
      receiptSha,
      now,
    );
    db.prepare(
      'INSERT INTO ' + outbox + " VALUES(?,?,?,?,?,?,'pending',0,?,?)",
    ).run(org, proposal, quote, fingerprint, payload, hash(payload), now, now);
    insert(publications, candidate());
  });
  afterEach(() => db.close());

  it('is additive, repeatable and preserves shared schema62/business facts', () => {
    db.exec(migration);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(62);
    expect(
      db.prepare("SELECT value FROM business WHERE id='keep'").get()?.value,
    ).toBe('unchanged');
    expect(
      db
        .prepare(
          'SELECT version FROM company_local_action_engine_publication_schema',
        )
        .get()?.version,
    ).toBe(1);
    expect(state()).toBe('pending');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('records a candidate even if its transport ACK was lost, without confirming by insertion alone', () => {
    insert(confirmations, facts());
    expect(state()).toBe('pending');
    expect(
      db.prepare('SELECT published_revision FROM ' + publications).get()
        ?.published_revision,
    ).toBeNull();
    expect(
      db.prepare('SELECT snapshot_id FROM ' + confirmations).get()?.snapshot_id,
    ).toBe(snapshot);
  });
  it('records confirmation and outbox terminal state together in one transaction', () => {
    db.exec('BEGIN IMMEDIATE');
    ack();
    db.exec('COMMIT');
    expect(state()).toBe('confirmed');
    expect(db.prepare('SELECT count(*) n FROM ' + confirmations).get()?.n).toBe(
      1,
    );
    expect(
      db.prepare('SELECT receipt_json FROM action_engine_quote_receipts').get()
        ?.receipt_json,
    ).toBe(receipt);
  });
  it('rolls back both confirmation and terminal state when the caller fails', () => {
    db.exec('BEGIN IMMEDIATE');
    ack();
    db.exec('ROLLBACK');
    expect(state()).toBe('pending');
    expect(db.prepare('SELECT count(*) n FROM ' + confirmations).get()?.n).toBe(
      0,
    );
  });
  it('permits confirmation of an uncertain local outbox under the same exact facts', () => {
    db.exec('UPDATE ' + outbox + " SET state='uncertain'");
    ack();
    expect(state()).toBe('confirmed');
  });
  it('never lets a transport ACK create canonical confirmation', () => {
    db.prepare(
      'UPDATE ' + publications + ' SET published_revision=5,published_at=?',
    ).run(now);
    expect(state()).toBe('pending');
    expect(db.prepare('SELECT count(*) n FROM ' + confirmations).get()?.n).toBe(
      0,
    );
  });
  const changed: Record<string, SQLInputValue> = {
    organization_id: 'other-company',
    source_id: 'other-source',
    action_kind: 'send_quote',
    proposal_id: 'other-proposal',
    reservation_id: uuid('99'),
    fingerprint: 'f'.repeat(64),
    actor_user_id: 'other-user',
    installation_id: uuid('98'),
    customer_id: uuid('97'),
    quote_id: uuid('96'),
    receipt_sha256: 'e'.repeat(64),
    snapshot_id: uuid('95'),
    confirmed_at: '2026-10-10T00:00:00Z',
  };
  for (const [column, value] of Object.entries(changed)) {
    it('rejects mismatched confirmation ' + column, () => {
      expect(() => insert(confirmations, facts({ [column]: value }))).toThrow();
      expect(state()).toBe('pending');
      expect(
        db.prepare('SELECT count(*) n FROM ' + confirmations).get()?.n,
      ).toBe(0);
    });
    it('refuses mutation of confirmed field ' + column, () => {
      ack();
      expect(() =>
        db
          .prepare('UPDATE ' + confirmations + ' SET ' + column + '=?')
          .run(value),
      ).toThrow();
      expect(db.prepare('SELECT * FROM ' + confirmations).get()).toEqual(
        facts(),
      );
    });
  }
  it.each(['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE'])(
    'rejects duplicate %s before replacement or suppression',
    (verb) => {
      ack();
      expect(() => insert(confirmations, facts(), verb)).toThrow();
      expect(
        db.prepare('SELECT count(*) n FROM ' + confirmations).get()?.n,
      ).toBe(1);
    },
  );
  it('does not replace the original snapshot with a newer otherwise-valid candidate', () => {
    insert(publications, candidate(uuid('6')));
    ack();
    expect(() =>
      insert(
        confirmations,
        facts({ snapshot_id: uuid('6') }),
        'INSERT OR REPLACE',
      ),
    ).toThrow();
    expect(
      db.prepare('SELECT snapshot_id FROM ' + confirmations).get()?.snapshot_id,
    ).toBe(snapshot);
  });
  it('requires a real local candidate and outbox, not a shared receipt alone', () => {
    db.exec('DELETE FROM ' + publications + '; DELETE FROM ' + outbox);
    expect(() => insert(confirmations, facts())).toThrow();
    expect(
      db.prepare('SELECT count(*) n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(1);
  });
  it('rejects a marker inserted after an unproven confirmed state', () => {
    db.exec('UPDATE ' + outbox + " SET state='confirmed'");
    expect(() => insert(confirmations, facts())).toThrow();
  });
  it('requires confirmation after the latest local attempt time', () => {
    db.prepare('UPDATE ' + outbox + ' SET updated_at=?').run(
      '2026-10-11T00:01:00Z',
    );
    expect(() => insert(confirmations, facts())).toThrow();
  });
  it('keeps FK parents until the confirmation child has been stripped', () => {
    ack();
    expect(() => db.exec('DELETE FROM ' + publications)).toThrow();
    expect(() => db.exec('DELETE FROM ' + outbox)).toThrow();
    db.exec(
      'DELETE FROM ' +
        confirmations +
        '; DELETE FROM ' +
        publications +
        '; DELETE FROM ' +
        outbox,
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      db.prepare('SELECT count(*) n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(1);
  });
  it('restores acknowledged private rows by pending outbox, candidate, marker then exact terminal transition', () => {
    ack();
    const marker = db
      .prepare('SELECT * FROM ' + confirmations)
      .get()! as Record<string, SQLInputValue>;
    const link = db.prepare('SELECT * FROM ' + publications).get()! as Record<
      string,
      SQLInputValue
    >;
    const local = db.prepare('SELECT * FROM ' + outbox).get()! as Record<
      string,
      SQLInputValue
    >;
    db.exec(
      'BEGIN IMMEDIATE; DELETE FROM ' +
        confirmations +
        '; DELETE FROM ' +
        publications +
        '; DELETE FROM ' +
        outbox,
    );
    insert(outbox, { ...local, state: 'pending' });
    insert(publications, link);
    insert(confirmations, marker);
    db.exec('UPDATE ' + outbox + " SET state='confirmed'; COMMIT");
    expect(state()).toBe('confirmed');
    expect(db.prepare('SELECT * FROM ' + confirmations).get()).toEqual(marker);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
